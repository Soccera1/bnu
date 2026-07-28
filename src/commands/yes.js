#!/usr/bin/env bun

import { writeSync } from "node:fs";
import { parentIgnoresSigpipe } from "../shared/common.js";
import { UsageError, VERSION, stderr, stdout } from "../shared/diagnostics.js";
import { outputWriteErrorMessage } from "../shared/runtime.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const YES_LONG_OPTIONS = ["help", "version"];

export async function yes(args) {
  const meta = yesMetaOption(args);
  if (meta === "--help") {
    showYesHelp();
    return 0;
  }
  if (meta === "--version") {
    stdout(`${VERSION}\n`);
    return 0;
  }
  validateYesOptions(args);
  if (args[0] === "--") args = args.slice(1);
  const text = `${args.length ? args.join(" ") : "y"}\n`;
  const chunk = text.repeat(1024);
  while (true) {
    try {
      writeSync(1, chunk);
    } catch (error) {
      if (error?.code === "EPIPE") {
        if (parentIgnoresSigpipe()) stderr("yes: standard output: Broken pipe\n");
        return parentIgnoresSigpipe() ? 1 : 0;
      }
      stderr(`yes: standard output: ${outputWriteErrorMessage(error)}\n`);
      return 1;
    }
  }
}

export function yesMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (!arg.startsWith("--")) return null;
    const option = normalizeYesLongOption(arg);
    const name = option.slice(2).split("=", 1)[0];
    if (!YES_LONG_OPTIONS.includes(name) || option.includes("=")) return null;
    return option;
  }
  return null;
}

export function validateYesOptions(args) {
  for (const arg of args) {
    if (arg === "--") return;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (!arg.startsWith("--")) throw new UsageError(`invalid option -- '${arg.slice(1, 2)}'`, true);
    const option = normalizeYesLongOption(arg);
    const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
    if (!YES_LONG_OPTIONS.includes(name)) throw new UsageError(`unrecognized option '${arg}'`, true);
    if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
  }
}

export function normalizeYesLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = YES_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

export function showYesHelp() {
  stdout("Usage: yes [STRING]...\n");
  stdout("  or:  yes OPTION\n");
  stdout("Repeatedly output a line with all specified STRING(s), or 'y'.\n\n");
  stdout("      --help     display this help and exit\n");
  stdout("      --version  output version information and exit\n");
}

const singleCall = defineCommand("yes", yes, null);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
