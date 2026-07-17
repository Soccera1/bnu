#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { helpVersionOnlyMetaOption, localeQuotedEscapedDiagnostic, normalizeHelpVersionOnlyLongOptions, parseOptions } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function hostid(args) {
  args = normalizeHelpVersionOnlyLongOptions(args);
  const { operands } = parseOptions(args, { long: { help: false, version: false } });
  if (operands.length) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[0])}`, true);
  stdout(`${(await hostidValue()).toString(16).padStart(8, "0")}\n`);
  return 0;
}

export async function hostidValue() {
  try {
    const bytes = await readFile("/etc/hostid");
    if (bytes.length >= 4) return bytes.readUInt32LE(0);
  } catch {
    // GNU/Linux gethostid returns zero when no host id has been configured.
  }
  return 0;
}

const singleCall = defineCommand("hostid", hostid, helpVersionOnlyMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
