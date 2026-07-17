#!/usr/bin/env bun

import { unlink as fsUnlink } from "node:fs/promises";
import { helpVersionOnlyMetaOption, localeQuotedEscapedDiagnostic, normalizeHelpVersionOnlyLongOptions, parseOptions, systemErrorMessage } from "../shared/common.js";
import { UsageError, fail } from "../shared/diagnostics.js";
import { linkQuotedName } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function unlinkCmd(args) {
  args = normalizeHelpVersionOnlyLongOptions(args);
  const { operands } = parseOptions(args, { long: { help: false, version: false } });
  if (!operands.length) throw new UsageError("missing operand", true);
  if (operands.length > 1) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[1])}`, true);
  try {
    await fsUnlink(operands[0]);
  } catch (error) {
    return fail("unlink", `cannot unlink ${linkQuotedName(operands[0])}: ${systemErrorMessage(error)}`);
  }
  return 0;
}

const singleCall = defineCommand("unlink", unlinkCmd, helpVersionOnlyMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
