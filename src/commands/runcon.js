#!/usr/bin/env bun

import { CString, ptr } from "bun:ffi";
import { cstr, cstrPath, invalidOptionMessage, libc, processSecurityContext, selinuxAllocatedString, selinuxApi, selinuxRuntimeEnabled } from "../shared/common.js";
import { InvocationError, fail, stderr, stdout } from "../shared/diagnostics.js";
import { commandSpawnErrorMessage, isKnownUnexecutableCommand, normalizeInvocationLongOptionByPrefix } from "../shared/process.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const RUNCON_LONG_OPTIONS = ["compute", "user", "role", "type", "range", "help", "version"];

export function runconMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeInvocationLongOptionByPrefix(arg, RUNCON_LONG_OPTIONS);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new InvocationError(`option '--${name}' doesn't allow an argument`);
      return normalized;
    }
    if (arg === "-c" || name === "compute") {
      if (inlineValue !== undefined) throw new InvocationError("option '--compute' doesn't allow an argument");
      continue;
    }
    if (["-u", "-r", "-t", "-l"].includes(arg)) {
      i++;
      continue;
    }
    if (["user", "role", "type", "range"].includes(name)) {
      if (inlineValue === undefined) i++;
      continue;
    }
    if (/^-[urtl].+/.test(arg)) continue;
    if (arg.startsWith("-")) throw new InvocationError(invalidOptionMessage(arg));
    return null;
  }
  return null;
}

export async function runconCmd(args) {
  const { opts, operands } = parseRunconArgs(normalizeRunconArgs(args));
  if (!operands.length) {
    const current = selinuxRuntimeEnabled() ? processSecurityContext() : null;
    if (current == null) return fail("runcon", "failed to get current context", 125);
    stdout(`${current}\n`);
    return 0;
  }
  const modifiesCurrent = opts.compute || opts.user != null || opts.role != null || opts.type != null || opts.range != null;
  let command = operands;
  let requestedContext = null;
  if (!modifiesCurrent) {
    requestedContext = operands[0];
    command = operands.slice(1);
  }
  if (!command.length) throw new InvocationError("no command specified");
  if (!selinuxRuntimeEnabled()) return fail("runcon", "runcon may be used only on a SELinux kernel", 125);
  const api = selinuxApi();
  if (!api) return fail("runcon", "runcon may be used only on a SELinux kernel", 125);
  let context;
  if (requestedContext != null) {
    context = runconModifyContext(api, requestedContext, {});
    if (context == null) return fail("runcon", `failed to create security context: '${requestedContext}'`, 125);
  } else {
    const current = processSecurityContext();
    if (current == null) return fail("runcon", "failed to get current context", 125);
    let base = current;
    if (opts.compute) {
      const fileContext = selinuxFileSecurityContext(api, command[0]);
      if (fileContext == null) return fail("runcon", `failed to get security context of '${command[0]}'`, 125);
      base = selinuxComputedProcessContext(api, current, fileContext);
      if (base == null) return fail("runcon", "failed to compute a new context", 125);
    }
    context = runconModifyContext(api, base, opts);
    if (context == null) return fail("runcon", `failed to create security context: '${base}'`, 125);
  }
  if (api.symbols.security_check_context(cstr(context)) !== 0) return fail("runcon", `invalid context: '${context}'`, 125);
  if (!setExecSecurityContext(api, context)) return fail("runcon", `unable to set security context '${context}'`, 125);
  const executable = opts.compute && !command[0].includes("/") ? `./${command[0]}` : command[0];
  try {
    if (await isKnownUnexecutableCommand(executable)) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    const proc = Bun.spawn([executable, ...command.slice(1)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await proc.exited;
  } catch (error) {
    stderr(`runcon: '${command[0]}': ${commandSpawnErrorMessage(error)}\n`);
    return error?.code === "ENOENT" ? 127 : 126;
  } finally {
    clearExecSecurityContext(api);
  }
}

export function selinuxFileSecurityContext(api, path) {
  return selinuxAllocatedString(api, (output) => api.symbols.getfilecon(cstrPath(path), output));
}

export function selinuxComputedProcessContext(api, current, fileContext) {
  const processClass = api.symbols.string_to_security_class(cstr("process"));
  if (!processClass) return null;
  return selinuxAllocatedString(api, (output) => api.symbols.security_compute_create(cstr(current), cstr(fileContext), processClass, output));
}

export function runconModifyContext(api, base, opts) {
  const context = api.symbols.context_new(cstr(base));
  if (!context) return null;
  try {
    for (const [name, setter] of [
      ["user", api.symbols.context_user_set],
      ["type", api.symbols.context_type_set],
      ["range", api.symbols.context_range_set],
      ["role", api.symbols.context_role_set],
    ]) {
      if (opts[name] != null && setter(context, cstr(opts[name])) !== 0) return null;
    }
    const value = api.symbols.context_str(context);
    return value ? new CString(value).toString() : null;
  } finally {
    api.symbols.context_free(context);
  }
}

export function setExecSecurityContext(api, context) {
  try {
    if (api.symbols.setexeccon(cstr(context)) === 0) return true;
  } catch {}
  return lsmSetExecSecurityContext(context);
}

export function clearExecSecurityContext(api) {
  try {
    if (api.symbols.setexeccon(null) === 0) return true;
  } catch {}
  return lsmSetExecSecurityContext(null);
}

export function lsmSetExecSecurityContext(context) {
  const encoded = context == null ? Buffer.alloc(0) : Buffer.from(`${context}\0`);
  const record = Buffer.alloc(32 + encoded.length);
  record.writeBigUInt64LE(101n, 0);
  record.writeBigUInt64LE(BigInt(record.length), 16);
  record.writeBigUInt64LE(BigInt(encoded.length), 24);
  encoded.copy(record, 32);
  return Number(libc.symbols.syscall(460, 101, ptr(record), record.length, 0)) === 0;
}

export function normalizeRunconArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      out.push(...args.slice(i));
      break;
    }
    if (arg.startsWith("--")) {
      const normalized = normalizeInvocationLongOptionByPrefix(arg, RUNCON_LONG_OPTIONS);
      out.push(normalized);
      if (["--user", "--role", "--type", "--range"].includes(normalized) && i + 1 < args.length) out.push(args[++i]);
      continue;
    }
    out.push(arg);
    if (["-u", "-r", "-t", "-l"].includes(arg) && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

export function parseRunconArgs(args) {
  const opts = {};
  const operands = [];
  const requireValue = (index, option) => {
    if (index + 1 < args.length) return args[index + 1];
    if (option.startsWith("--")) throw new InvocationError(`option '${option}' requires an argument`);
    throw new InvocationError(`option requires an argument -- '${option.slice(1)}'`);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-c" || arg === "--compute") {
      opts.compute = true;
      continue;
    }
    if (arg === "-u" || arg === "--user" || arg === "-r" || arg === "--role" || arg === "-t" || arg === "--type" || arg === "-l" || arg === "--range") {
      const name = runconOptionName(arg);
      if (opts[name] != null) throw new InvocationError(`multiple ${runconMultipleName(name)}`);
      opts[name] = requireValue(i, arg);
      i++;
      continue;
    }
    const inline = arg.match(/^--(user|role|type|range)=(.*)$/);
    if (inline) {
      if (opts[inline[1]] != null) throw new InvocationError(`multiple ${runconMultipleName(inline[1])}`);
      opts[inline[1]] = inline[2];
      continue;
    }
    const shortInline = arg.match(/^-(u|r|t|l)(.+)$/);
    if (shortInline) {
      const name = runconOptionName(`-${shortInline[1]}`);
      if (opts[name] != null) throw new InvocationError(`multiple ${runconMultipleName(name)}`);
      opts[name] = shortInline[2];
      continue;
    }
    if (arg.startsWith("-")) throw new InvocationError(invalidOptionMessage(arg));
    operands.push(...args.slice(i));
    break;
  }
  return { opts, operands };
}

export function runconOptionName(option) {
  return ({ "-u": "user", "--user": "user", "-r": "role", "--role": "role", "-t": "type", "--type": "type", "-l": "range", "--range": "range" })[option];
}

export function runconMultipleName(name) {
  return ({ user: "users", role: "roles", type: "types", range: "levelranges" })[name];
}

const singleCall = defineCommand("runcon", runconCmd, runconMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
