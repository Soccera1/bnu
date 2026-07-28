#!/usr/bin/env bun

import { userInfo } from "node:os";
import { helpVersionOnlyMetaOption, localeQuotedEscapedDiagnostic, normalizeHelpVersionOnlyLongOptions, parseOptions, userNameForUid } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function whoamiCmd(args) {
  args = normalizeHelpVersionOnlyLongOptions(args);
  const { operands } = parseOptions(args, { long: { help: false, version: false } });
  if (operands.length) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[0])}`, true);
  const info = userInfo();
  stdout(`${await userNameForUid(process.getuid?.() ?? info.uid) ?? info.username}\n`);
  return 0;
}

const singleCall = defineCommand("whoami", whoamiCmd, helpVersionOnlyMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
