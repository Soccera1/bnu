#!/usr/bin/env bun

import { writeSync } from "node:fs";
import { invalidOptionMessage, libc, localeQuotedEscapedDiagnostic } from "../shared/common.js";
import { InvocationError, stderr, stdout } from "../shared/diagnostics.js";
import { commandSpawnErrorMessage, isKnownUnexecutableCommand, normalizeInvocationLongOptionByPrefix } from "../shared/process.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export function niceMetaOption(args) {
  const longOptions = ["adjustment", "help", "version"];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    const normalized = arg.startsWith("--") ? normalizeInvocationLongOptionByPrefix(arg, longOptions) : arg;
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new InvocationError(`option '--${name}' doesn't allow an argument`);
      return normalized;
    }
    if (arg === "-n" || arg === "--adjustment") {
      i++;
      continue;
    }
    if (/^-n.+/.test(arg) || /^--adjustment=/.test(arg) || /^-[+-]?\d+$/.test(arg)) continue;
    if (arg.startsWith("-")) throw new InvocationError(invalidOptionMessage(arg));
    return null;
  }
  return null;
}

export async function niceCmd(args) {
  const parsed = parseNiceArgs(args);
  if (parsed.error) {
    stderr(`nice: ${parsed.error}\n`);
    if (parsed.showHelp) stderr("Try 'nice --help' for more information.\n");
    return 125;
  }
  if (!parsed.command.length) {
    if (parsed.adjusted) {
      stderr("nice: a command must be given with an adjustment\nTry 'nice --help' for more information.\n");
      return 125;
    }
    stdout(`${currentNiceValue()}\n`);
    return 0;
  }
  const nextNice = adjustedNiceValue(parsed.adjustment);
  if (libc.symbols.setpriority(0, 0, nextNice) !== 0) {
    if (!writeNiceWarning()) return 125;
  }
  try {
    if (await isKnownUnexecutableCommand(parsed.command[0])) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
    const proc = Bun.spawn(parsed.command, { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await proc.exited;
  } catch (error) {
    stderr(`nice: '${parsed.command[0]}': ${commandSpawnErrorMessage(error)}\n`);
    return error.code === "ENOENT" ? 127 : 126;
  }
}

export function parseNiceArgs(args) {
  let adjusted = false;
  let adjustment = 10;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return { command: args.slice(i + 1), adjusted, adjustment };
    if (arg === "-n" || arg === "--adjustment") {
      if (i + 1 >= args.length) {
        return {
          error: arg.startsWith("--") ? `option '${arg}' requires an argument` : `option requires an argument -- '${arg.slice(1)}'`,
          showHelp: true,
          command: [],
          adjusted,
        };
      }
      const value = args[++i];
      if (!isNiceAdjustment(value)) return { error: `invalid adjustment ${localeQuotedEscapedDiagnostic(value ?? "")}`, command: [], adjusted };
      adjusted = true;
      adjustment = Number(value);
      continue;
    }
    if (arg.startsWith("--adjustment=")) {
      const value = arg.slice("--adjustment=".length);
      if (!isNiceAdjustment(value)) return { error: `invalid adjustment ${localeQuotedEscapedDiagnostic(value)}`, command: [], adjusted };
      adjusted = true;
      adjustment = Number(value);
      continue;
    }
    if (/^-n/.test(arg) && arg !== "-n") {
      const value = arg.slice(2);
      if (!isNiceAdjustment(value)) return { error: `invalid adjustment ${localeQuotedEscapedDiagnostic(value)}`, command: [], adjusted };
      adjusted = true;
      adjustment = Number(value);
      continue;
    }
    if (/^-[+-]?\d+$/.test(arg)) {
      adjusted = true;
      adjustment = Number(arg.slice(1));
      continue;
    }
    if (arg.startsWith("-")) return { error: invalidOptionMessage(arg), showHelp: true, command: [], adjusted };
    return { command: args.slice(i), adjusted, adjustment };
  }
  return { command: [], adjusted, adjustment };
}

export function isNiceAdjustment(value) {
  return /^[+-]?\d+$/.test(String(value));
}

export function currentNiceValue() {
  return libc.symbols.getpriority(0, 0);
}

export function adjustedNiceValue(adjustment) {
  const current = currentNiceValue();
  const boundedAdjustment = Math.max(-39, Math.min(39, adjustment));
  return Math.max(-20, Math.min(19, current + boundedAdjustment));
}

export function writeNiceWarning() {
  try {
    writeSync(2, "nice: cannot set niceness: Permission denied\n");
    return true;
  } catch {
    return false;
  }
}

const singleCall = defineCommand("nice", niceCmd, niceMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
