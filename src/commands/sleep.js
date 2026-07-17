#!/usr/bin/env bun

import { invalidOptionMessage } from "../shared/common.js";
import { InvocationError, UsageError, VERSION, stdout } from "../shared/diagnostics.js";
import { parseDuration } from "../shared/process.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const SLEEP_LONG_OPTIONS = ["help", "version"];

export async function sleep(args) {
  const meta = sleepMetaOption(args);
  if (meta === "--help") {
    showSleepHelp();
    return 0;
  }
  if (meta === "--version") {
    stdout(`${VERSION}\n`);
    return 0;
  }
  validateSleepOptions(args);
  if (!args.length) throw new UsageError("missing operand", true);
  if (args[0] === "--") {
    args = args.slice(1);
    if (!args.length) return 0;
  }
  let total = 0;
  for (const value of args) {
    try {
      total += parseDuration(value);
    } catch (error) {
      if (error instanceof InvocationError) throw new UsageError(error.message, true);
      throw error;
    }
  }
  if (!Number.isFinite(total) || total > 2147483647) await new Promise(() => {});
  await Bun.sleep(total);
  return 0;
}

export function sleepMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (!arg.startsWith("--")) return null;
    const option = normalizeSleepLongOption(arg);
    const name = option.slice(2).split("=", 1)[0];
    if (!SLEEP_LONG_OPTIONS.includes(name) || option.includes("=")) return null;
    return option;
  }
  return null;
}

export function validateSleepOptions(args) {
  let end = false;
  for (const arg of args) {
    if (end) continue;
    if (arg === "--") {
      end = true;
      continue;
    }
    if (arg === "-" || !arg.startsWith("-")) continue;
    if (!arg.startsWith("--")) throw new UsageError(sleepInvalidOptionMessage(arg), true);
    const option = normalizeSleepLongOption(arg);
    const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
    if (!SLEEP_LONG_OPTIONS.includes(name)) throw new UsageError(`unrecognized option '${arg}'`, true);
    if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
  }
}

export function normalizeSleepLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = SLEEP_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

export function showSleepHelp() {
  stdout("Usage: sleep NUMBER[SUFFIX]...\n");
  stdout("  or:  sleep OPTION\n");
  stdout("Pause for NUMBER seconds, where NUMBER is an integer or floating-point.\n");
  stdout("SUFFIX may be 's','m','h', or 'd', for seconds, minutes, hours, days.\n");
  stdout("With multiple arguments, pause for the sum of their values.\n\n");
  stdout("      --help     display this help and exit\n");
  stdout("      --version  output version information and exit\n");
}

export function sleepInvalidOptionMessage(arg) {
  return arg.startsWith("--") ? `unrecognized option '${arg}'` : invalidOptionMessage(arg);
}

const singleCall = defineCommand("sleep", sleep, null);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
