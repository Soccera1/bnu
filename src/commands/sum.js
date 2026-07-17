#!/usr/bin/env bun

import { sumForFile } from "../shared/checksum.js";
import { systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const SUM_LONG_OPTIONS = ["sysv", "help", "version"];

export function sumMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (arg.startsWith("--")) {
      const option = normalizeSumLongOption(arg);
      const name = option.slice(2).split("=", 1)[0];
      if (!SUM_LONG_OPTIONS.includes(name) || option.includes("=")) return null;
      if (option === "--help" || option === "--version") return option;
      continue;
    }
    for (let j = 1; j < arg.length; j++) if (arg[j] !== "r" && arg[j] !== "s") return null;
  }
  return null;
}

export async function sum(args) {
  args = normalizeSumLongOptions(args);
  const { operands, sysv } = parseSumArgs(args);
  const implicitStdin = operands.length === 0;
  const files = implicitStdin ? ["-"] : operands;
  let failed = false;
  for (const file of files) {
    let result;
    try {
      result = await sumForFile(file, sysv);
    } catch (error) {
      stderr(`sum: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      failed = true;
      continue;
    }
    const { sum, blocks } = result;
    const label = implicitStdin ? "" : ` ${file}`;
    if (sysv) {
      stdout(`${sum} ${blocks}${label}\n`);
    } else {
      stdout(`${String(sum).padStart(5, "0")} ${String(blocks).padStart(5)}${label}\n`);
    }
  }
  return failed ? 1 : 0;
}

export function parseSumArgs(args) {
  const operands = [];
  let sysv = false;
  let end = false;
  for (const arg of args) {
    if (end || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      if (process.env.POSIXLY_CORRECT) end = true;
      continue;
    }
    if (arg === "--") {
      end = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (!SUM_LONG_OPTIONS.includes(name)) throw new UsageError(`unrecognized option '${arg}'`, true);
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      if (name === "sysv") sysv = true;
      continue;
    }
    for (const ch of arg.slice(1)) {
      if (ch === "s") sysv = true;
      else if (ch === "r") sysv = false;
      else throw new UsageError(`invalid option -- '${ch}'`, true);
    }
  }
  return { operands, sysv };
}

export function normalizeSumLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeSumLongOption(arg));
  }
  return out;
}

export function normalizeSumLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = SUM_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

const singleCall = defineCommand("sum", sum, sumMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
