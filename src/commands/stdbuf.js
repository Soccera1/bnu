#!/usr/bin/env bun

import { statSync } from "node:fs";
import { invalidOptionMessage, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix } from "../shared/common.js";
import { InvocationError, stderr } from "../shared/diagnostics.js";
import { commandSpawnErrorMessage, isKnownUnexecutableCommand } from "../shared/process.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const STDBUF_LONG_OPTIONS = ["input", "output", "error", "help", "version"];

export function stdbufMetaOption(args) {
  let sawMode = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) {
      normalized = normalizeLongOptionByPrefix(arg, STDBUF_LONG_OPTIONS);
    }
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new InvocationError(`option '--${name}' doesn't allow an argument`);
      return normalized;
    }
    if (["-i", "-o", "-e"].includes(arg)) {
      if (i + 1 < args.length) validateStdbufMode(arg[1], args[i + 1]);
      sawMode = true;
      i++;
      continue;
    }
    if (["--input", "--output", "--error"].includes(normalized)) {
      if (i + 1 < args.length) validateStdbufMode(normalized.slice(2, 3), args[i + 1]);
      sawMode = true;
      i++;
      continue;
    }
    if (/^-[ioe].+/.test(arg)) {
      validateStdbufMode(arg[1], arg.slice(2));
      sawMode = true;
      continue;
    }
    if (/^--(input|output|error)=/.test(normalized)) {
      const [, name, mode] = normalized.match(/^--(input|output|error)=(.*)$/s);
      validateStdbufMode(name[0], mode);
      sawMode = true;
      continue;
    }
    if (arg.startsWith("-")) throw new InvocationError(invalidOptionMessage(arg));
    if (sawMode) return null;
  }
  return null;
}

export async function stdbufCmd(args) {
  const { command, env } = stdbufInvocation(args);
  if (!command.length) throw new InvocationError("missing operand");
  try {
    if (await isKnownUnexecutableCommand(command[0])) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    const proc = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
    return await proc.exited;
  } catch (error) {
    const status = stdbufSpawnStatus(command[0], error);
    stderr(`stdbuf: failed to run command '${command[0]}': ${commandSpawnErrorMessage(error)}\n`);
    return status;
  }
}

export function stdbufSpawnStatus(command, error) {
  if (command === ".") return 126;
  if (error?.code === "EACCES" || error?.code === "EISDIR") return 126;
  if (error?.code === "ENOENT") return 127;
  if (/not found/i.test(error?.message || "")) return 127;
  if (/permission denied|is a directory/i.test(error?.message || "")) return 126;
  return 1;
}

export function stdbufInvocation(args) {
  let i = 0;
  let sawMode = false;
  const modes = {};
  const requireValue = (index, option) => {
    if (index + 1 < args.length) return args[index + 1];
    if (option.startsWith("--")) throw new InvocationError(`option '${option}' requires an argument`);
    throw new InvocationError(`option requires an argument -- '${option.slice(1)}'`);
  };
  const commandEnv = (command) => ({ command, env: stdbufChildEnv(modes) });
  while (i < args.length) {
    let arg = args[i];
    if (arg.startsWith("--") && arg !== "--") arg = normalizeLongOptionByPrefix(arg, STDBUF_LONG_OPTIONS);
    const [longName, inlineValue] = arg.startsWith("--") ? arg.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if ((longName === "help" || longName === "version") && inlineValue !== undefined) {
      throw new InvocationError(`option '--${longName}' doesn't allow an argument`);
    }
    if (arg === "--") {
      if (!sawMode) throw new InvocationError("missing operand");
      return commandEnv(args.slice(i + 1));
    }
    if (/^-[ioe].+/.test(arg)) {
      modes[arg[1]] = validateStdbufMode(arg[1], arg.slice(2));
      sawMode = true;
      i++;
      continue;
    }
    if (["-i", "-o", "-e", "--input", "--output", "--error"].includes(arg)) {
      const stream = arg === "--input" ? "i" : arg === "--output" ? "o" : arg === "--error" ? "e" : arg[1];
      modes[stream] = validateStdbufMode(stream, requireValue(i, arg));
      sawMode = true;
      i += 2;
      continue;
    }
    if (/^--(input|output|error)=/.test(arg)) {
      const [, name, mode] = arg.match(/^--(input|output|error)=(.*)$/s);
      modes[name[0]] = validateStdbufMode(name[0], mode);
      sawMode = true;
      i++;
      continue;
    }
    if (arg.startsWith("-")) throw new InvocationError(invalidOptionMessage(arg));
    if (!sawMode) throw new InvocationError("you must specify a buffering mode option");
    return commandEnv(args.slice(i));
  }
  return commandEnv([]);
}

export function stdbufChildEnv(modes) {
  const env = { ...process.env };
  delete env._STDBUF_I;
  delete env._STDBUF_O;
  delete env._STDBUF_E;
  const library = findStdbufLibrary();
  if (library) env.LD_PRELOAD = env.LD_PRELOAD ? `${library}:${env.LD_PRELOAD}` : library;
  if (modes.i != null) env._STDBUF_I = modes.i;
  if (modes.o != null) env._STDBUF_O = modes.o;
  if (modes.e != null) env._STDBUF_E = modes.e;
  return env;
}

export function findStdbufLibrary() {
  for (const path of ["/usr/libexec/coreutils/libstdbuf.so", "/usr/lib/coreutils/libstdbuf.so"]) {
    try {
      if (statSync(path).isFile()) return path;
    } catch {}
  }
  return null;
}

export function validateStdbufMode(stream, mode) {
  if (mode == null) throw new InvocationError("missing mode");
  if (mode === "") throw new InvocationError(`invalid mode ${localeQuotedEscapedDiagnostic("")}`, 125, false);
  if (mode === "L") {
    if (stream === "i") throw new InvocationError("line buffering standard input is meaningless");
    return "L";
  }
  if (mode === "0") return "0";
  if (mode === "l") throw new InvocationError(`invalid mode ${localeQuotedEscapedDiagnostic("l")}`, 125, false);
  try {
    const size = parseStdbufSize(mode);
    return size.toString();
  } catch (error) {
    if (error instanceof InvocationError) throw error;
    throw new InvocationError(`invalid mode ${localeQuotedEscapedDiagnostic(mode)}`, 125, false);
  }
}

export function parseStdbufSize(mode) {
  const text = /^\D+$/.test(mode) ? `1${mode}` : String(mode);
  const match = text.match(/^(\d+)([A-Za-z]*)$/);
  if (!match) throw new InvocationError(`invalid mode ${localeQuotedEscapedDiagnostic(mode)}`, 125, false);
  const binary = {
    "": 1n,
    K: 1024n, k: 1024n, KiB: 1024n, kiB: 1024n,
    M: 1024n ** 2n, m: 1024n ** 2n, MiB: 1024n ** 2n, miB: 1024n ** 2n,
    G: 1024n ** 3n, g: 1024n ** 3n, GiB: 1024n ** 3n, giB: 1024n ** 3n,
    T: 1024n ** 4n, t: 1024n ** 4n, TiB: 1024n ** 4n, tiB: 1024n ** 4n,
    P: 1024n ** 5n, PiB: 1024n ** 5n,
    E: 1024n ** 6n, EiB: 1024n ** 6n,
    Z: 1024n ** 7n, ZiB: 1024n ** 7n,
    Y: 1024n ** 8n, YiB: 1024n ** 8n,
  };
  const decimal = {
    KB: 1000n, kB: 1000n, MB: 1000n ** 2n, mB: 1000n ** 2n,
    GB: 1000n ** 3n, gB: 1000n ** 3n, TB: 1000n ** 4n, tB: 1000n ** 4n,
    PB: 1000n ** 5n, EB: 1000n ** 6n, ZB: 1000n ** 7n, YB: 1000n ** 8n,
  };
  const scale = binary[match[2]] ?? decimal[match[2]];
  if (!scale) throw new InvocationError(`invalid mode ${localeQuotedEscapedDiagnostic(mode)}`, 125, false);
  const amount = BigInt(match[1]) * scale;
  if (amount > 18446744073709551615n) throw new InvocationError(`invalid mode ${localeQuotedEscapedDiagnostic(mode)}: Value too large for defined data type`, 125, false);
  return amount;
}

const singleCall = defineCommand("stdbuf", stdbufCmd, stdbufMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
