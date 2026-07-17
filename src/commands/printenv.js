#!/usr/bin/env bun

import { writeEnvironment } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const PRINTENV_LONG_OPTIONS = ["null", "help", "version"];

export function printenvMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg === "-" || !arg.startsWith("-")) return null;
    if (arg.startsWith("--")) {
      const option = normalizePrintenvLongOption(arg);
      const name = option.slice(2).split("=", 1)[0];
      if (!PRINTENV_LONG_OPTIONS.includes(name) || option.includes("=")) return null;
      if (option === "--help" || option === "--version") return option;
      continue;
    }
    for (let j = 1; j < arg.length; j++) if (arg[j] !== "0") return null;
  }
  return null;
}

export async function printenv(args) {
  const operands = [];
  let sep = "\n";
  let parsing = true;
  for (const arg of args) {
    if (!parsing) {
      operands.push(arg);
    } else if (arg === "--") {
      parsing = false;
    } else if (arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      parsing = false;
    } else if (arg.startsWith("--")) {
      const option = normalizePrintenvLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (name === "null") {
        if (inlineValue !== undefined) throw new UsageError("option '--null' doesn't allow an argument", true);
        sep = "\0";
      } else if (name === "help" || name === "version") {
        if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      } else {
        throw new UsageError(`unrecognized option '${arg}'`, true);
      }
    } else if (/^-0+$/.test(arg)) {
      sep = "\0";
    } else if (arg.startsWith("-0")) {
      throw new UsageError(`invalid option -- '${arg[2]}'`, true);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`invalid option -- '${arg.slice(1, 2)}'`, true);
    } else {
      operands.push(arg);
    }
  }
  if (!operands.length) {
    writeEnvironment(process.env, sep);
    return 0;
  }
  let code = 0;
  for (const key of operands) {
    if (process.env[key] == null) code = 1;
    else stdout(`${process.env[key]}${sep}`);
  }
  return code;
}

export function normalizePrintenvLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = PRINTENV_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

const singleCall = defineCommand("printenv", printenv, printenvMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
