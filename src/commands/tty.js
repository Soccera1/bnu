#!/usr/bin/env bun

import { localeQuotedEscapedDiagnostic, parseOptions } from "../shared/common.js";
import { UsageError, fail, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const TTY_LONG_OPTIONS = ["silent", "quiet", "help", "version"];

export function ttyMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (!arg.startsWith("--")) {
      for (const ch of arg.slice(1)) {
        if (ch !== "s") return null;
      }
      continue;
    }
    const option = normalizeTtyLongOption(arg);
    if (option.includes("=") || !TTY_LONG_OPTIONS.includes(option.slice(2))) return null;
    if (option === "--help" || option === "--version") return option;
  }
  return null;
}

export async function ttyCmd(args) {
  args = normalizeTtyLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { s: false }, long: { silent: false, quiet: false, help: false, version: false } });
  if (operands.length) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[0])}`, true);
  const isTty = Boolean(process.stdin.isTTY);
  if (!(opts.s || opts.silent || opts.quiet)) {
    try {
      stdout(isTty ? "/dev/tty\n" : "not a tty\n");
    } catch (error) {
      return fail("tty", error.message || String(error), 3);
    }
  }
  return isTty ? 0 : 1;
}

export function normalizeTtyLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeTtyLongOption(arg));
  }
  return out;
}

export function normalizeTtyLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = TTY_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

const singleCall = defineCommand("tty", ttyCmd, ttyMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
