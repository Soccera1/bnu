#!/usr/bin/env bun

import { link as fsLink } from "node:fs/promises";
import { helpVersionOnlyMetaOption, localeQuotedEscapedDiagnostic, normalizeHelpVersionOnlyLongOptions, parseOptions } from "../shared/common.js";
import { UsageError, fail } from "../shared/diagnostics.js";
import { errnoMessage, linkQuotedName } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function linkCmd(args) {
  args = normalizeHelpVersionOnlyLongOptions(args);
  const { operands } = parseOptions(args, { long: { help: false, version: false } });
  if (!operands.length) throw new UsageError("missing operand", true);
  if (operands.length < 2) throw new UsageError(`missing operand after '${operands[0]}'`, true);
  if (operands.length > 2) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[2])}`, true);
  try {
    await fsLink(operands[0], operands[1]);
  } catch (error) {
    return fail("link", `cannot create link ${linkQuotedName(operands[1])} to ${linkQuotedName(operands[0])}: ${linkErrorMessage(error)}`);
  }
  return 0;
}

export function linkErrorMessage(error) {
  if (error?.code === "EEXIST") return "File exists";
  return errnoMessage(error);
}

const singleCall = defineCommand("link", linkCmd, helpVersionOnlyMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
