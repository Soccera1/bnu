#!/usr/bin/env bun

import { helpVersionOnlyMetaOption, localeQuotedEscapedDiagnostic, machineName, normalizeHelpVersionOnlyLongOptions, parseOptions } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function arch(args) {
  args = normalizeHelpVersionOnlyLongOptions(args);
  const { operands } = parseOptions(args, { long: { help: false, version: false } });
  if (operands.length) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[0])}`, true);
  stdout(`${machineName()}\n`);
  return 0;
}

const singleCall = defineCommand("arch", arch, helpVersionOnlyMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
