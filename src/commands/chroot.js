#!/usr/bin/env bun

import { ptr } from "bun:ffi";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { cstrPath, invalidOptionMessage, libc, localeQuotedDiagnostic, orderedGroupIds, pathDisplayName, readGroup, readPasswd, shellEscapeLsName, supplementaryGroupsForUser, systemErrorMessage } from "../shared/common.js";
import { InvocationError, fail, stderr } from "../shared/diagnostics.js";
import { commandSpawnErrorMessage, execCommand, isDirectCommandInvocation, isKnownUnexecutableCommand, normalizeInvocationLongOptionByPrefix } from "../shared/process.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const CHROOT_LONG_OPTIONS = ["groups", "userspec", "skip-chdir", "help", "version"];

export function chrootMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeInvocationLongOptionByPrefix(arg, CHROOT_LONG_OPTIONS);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new InvocationError(`option '--${name}' doesn't allow an argument`);
      return normalized;
    }
    if (name === "skip-chdir") {
      if (inlineValue !== undefined) throw new InvocationError("option '--skip-chdir' doesn't allow an argument");
      continue;
    }
    if (name === "userspec" || name === "groups") {
      if (inlineValue !== undefined) continue;
      i++;
      continue;
    }
    if (arg.startsWith("-")) throw new InvocationError(invalidOptionMessage(arg));
    return null;
  }
  return null;
}

export async function chrootCmd(args) {
  const { opts, operands } = parseChrootArgs(normalizeChrootArgs(args));
  if (!operands.length) throw new InvocationError("missing operand");
  const [root, ...requestedCommand] = operands;
  if (opts["skip-chdir"] && !(await chrootTargetIsOldRoot(root))) {
    throw new InvocationError("option --skip-chdir only permitted if NEWROOT is old '/'");
  }
  const outsideCredentials = await resolveChrootCredentials(opts).catch(() => null);
  if (libc.symbols.chroot(cstrPath(root)) !== 0) {
    const rootError = await chrootRootError(root) ?? ((process.getuid?.() ?? 1) !== 0 ? "Operation not permitted" : "Operation not permitted");
    return fail("chroot", `cannot change root directory to ${shellEscapeLsName(pathDisplayName(root), true)}: ${rootError}`, 125);
  }
  if (!opts["skip-chdir"]) {
    try {
      process.chdir("/");
    } catch (error) {
      return fail("chroot", `cannot chdir to root directory: ${systemErrorMessage(error)}`, 125);
    }
  }
  let credentials;
  try {
    credentials = await resolveChrootCredentials(opts, outsideCredentials);
  } catch (error) {
    return fail("chroot", error.message || String(error), 125);
  }
  const credentialError = applyChrootCredentials(credentials);
  if (credentialError) return fail("chroot", credentialError, 125);
  const command = requestedCommand.length ? requestedCommand : [process.env.SHELL || "/bin/sh", "-i"];
  if (!isDirectCommandInvocation()) {
    try {
      if (await isKnownUnexecutableCommand(command[0])) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
      const proc = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return await proc.exited;
    } catch (error) {
      const status = error?.code === "ENOENT" || String(error?.message ?? "").includes("not found") ? 127 : 126;
      stderr(`chroot: failed to run command '${command[0]}': ${commandSpawnErrorMessage(error)}\n`);
      return status;
    }
  }
  const execError = execCommand(command);
  const status = execError.errno === 2 ? 127 : 126;
  stderr(`chroot: failed to run command '${command[0]}': ${execError.message}\n`);
  return status;
}

export async function resolveChrootCredentials(opts, fallback = null) {
  const userspec = opts.userspec;
  const groupsSpec = opts.groups;
  if (userspec == null && groupsSpec == null) return { uid: null, gid: null, groups: null };
  let uid = null;
  let gid = null;
  let username = null;
  let usedFallbackUser = false;
  if (userspec != null) {
    const separator = userspec.indexOf(":");
    const userToken = separator < 0 ? userspec : userspec.slice(0, separator);
    const groupToken = separator < 0 || separator === userspec.length - 1 ? null : userspec.slice(separator + 1);
    if (userToken !== "") {
      let user = await chrootUserToken(userToken).catch(() => null);
      if (!user && fallback?.user) {
        user = fallback.user;
        usedFallbackUser = true;
      }
      if (!user) throw new InvocationError(`invalid user ${localeQuotedDiagnostic(userToken)}`);
      uid = user.uid;
      username = user.name;
      if (groupToken == null) gid = user.gid;
    }
    if (groupToken != null && groupToken !== "") {
      gid = await chrootGroupToken(groupToken).catch(() => null) ?? fallback?.gid ?? null;
      if (gid == null) throw new InvocationError(`invalid group ${localeQuotedDiagnostic(groupToken)}`);
    }
    if (uid != null && gid == null && username == null) throw new InvocationError(`no group specified for unknown uid: ${uid}`);
  }
  let groups = null;
  if (groupsSpec != null) groups = await chrootSupplementaryGroups(groupsSpec, fallback?.groups);
  else if (uid != null && username != null) {
    groups = usedFallbackUser && fallback?.groups != null
      ? fallback.groups
      : orderedGroupIds(gid, await supplementaryGroupsForUser(username));
  }
  return { uid, gid, groups, user: uid == null ? null : { uid, gid, name: username } };
}

export async function chrootUserToken(token) {
  const passwd = await readPasswd();
  if (!token.startsWith("+") && passwd.has(token)) return { ...passwd.get(token), name: token };
  const numeric = token.startsWith("+") ? token.slice(1) : token;
  if (!/^\d+$/.test(numeric)) return null;
  const uid = Number(numeric);
  if (!Number.isSafeInteger(uid) || uid < 0 || uid > 0xffffffff) return null;
  if (!token.startsWith("+")) {
    for (const [name, row] of passwd) if (row.uid === uid) return { ...row, name };
  }
  return { uid, gid: null, name: null };
}

export async function chrootGroupToken(token) {
  const groups = await readGroup();
  if (!token.startsWith("+") && groups.has(token)) return groups.get(token);
  const numeric = token.startsWith("+") ? token.slice(1) : token;
  if (!/^\d+$/.test(numeric)) return null;
  const gid = Number(numeric);
  return Number.isSafeInteger(gid) && gid >= 0 && gid <= 0xffffffff ? gid : null;
}

export async function chrootSupplementaryGroups(spec, fallback = null) {
  if (spec === "") return [];
  const tokens = spec.split(",").map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) throw new InvocationError(`invalid group list ${localeQuotedDiagnostic(spec)}`);
  const groups = [];
  for (const token of tokens) {
    const gid = await chrootGroupToken(token).catch(() => null);
    if (gid == null) {
      if (fallback != null) return fallback;
      throw new InvocationError(`invalid group ${localeQuotedDiagnostic(token)}`);
    }
    groups.push(gid);
  }
  return groups;
}

export function applyChrootCredentials(credentials) {
  if (credentials.groups != null || credentials.uid != null) {
    const groups = credentials.groups ?? [];
    const buffer = Buffer.alloc(groups.length * 4);
    groups.forEach((gid, index) => buffer.writeUInt32LE(gid >>> 0, index * 4));
    if (libc.symbols.setgroups(groups.length, groups.length ? ptr(buffer) : null) !== 0) return "failed to set supplemental groups";
  }
  if (credentials.gid != null && libc.symbols.setgid(credentials.gid) !== 0) return "failed to set group-ID";
  if (credentials.uid != null && libc.symbols.setuid(credentials.uid) !== 0) return "failed to set user-ID";
  return null;
}

export async function chrootRootError(root) {
  try {
    const info = await stat(root);
    return info.isDirectory() ? null : "Not a directory";
  } catch (error) {
    return systemErrorMessage(error);
  }
}

export async function chrootTargetIsOldRoot(root) {
  try {
    return await realpath(root) === "/";
  } catch {
    return resolve(root) === "/";
  }
}

export function normalizeChrootArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      out.push(...args.slice(i));
      break;
    }
    if (arg.startsWith("--")) {
      const normalized = normalizeInvocationLongOptionByPrefix(arg, CHROOT_LONG_OPTIONS);
      out.push(normalized);
      if ((normalized === "--groups" || normalized === "--userspec") && i + 1 < args.length) out.push(args[++i]);
      continue;
    }
    out.push(arg);
  }
  return out;
}

export function parseChrootArgs(args) {
  const opts = {};
  const operands = [];
  const requireValue = (index, option) => {
    if (index + 1 < args.length) return args[index + 1];
    throw new InvocationError(`option '${option}' requires an argument`);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--skip-chdir") {
      opts["skip-chdir"] = true;
      continue;
    }
    if (arg === "--userspec" || arg === "--groups") {
      opts[arg.slice(2)] = requireValue(i, arg);
      i++;
      continue;
    }
    if (arg.startsWith("--userspec=")) {
      opts.userspec = arg.slice("--userspec=".length);
      continue;
    }
    if (arg.startsWith("--groups=")) {
      opts.groups = arg.slice("--groups=".length);
      continue;
    }
    if (arg.startsWith("-")) throw new InvocationError(invalidOptionMessage(arg));
    operands.push(arg, ...args.slice(i + 1));
    break;
  }
  return { opts, operands };
}

const singleCall = defineCommand("chroot", chrootCmd, chrootMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
