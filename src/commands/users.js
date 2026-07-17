#!/usr/bin/env bun

import { helpVersionOnlyMetaOption, localeQuotedEscapedDiagnostic, normalizeHelpVersionOnlyLongOptions, parseOptions } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { filterWhoUsers, readUtmpRecords } from "../shared/system.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function users(args) {
  args = normalizeHelpVersionOnlyLongOptions(args);
  const { operands } = parseOptions(args, { long: { help: false, version: false } });
  if (operands.length > 1) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[1])}`, true);
  const records = await readUtmpRecords(operands[0] ?? "/var/run/utmp");
  const users = await filterWhoUsers(records, operands.length === 0);
  const names = users.map((record) => record.user);
  if (names.length) stdout(`${names.join(" ")}\n`);
  return 0;
}

const singleCall = defineCommand("users", users, helpVersionOnlyMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
