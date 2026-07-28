#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { helpVersionOnlyMetaOption, localeQuotedEscapedDiagnostic, normalizeHelpVersionOnlyLongOptions, parseOptions, readPasswd, userNameForUid } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function logname(args) {
  args = normalizeHelpVersionOnlyLongOptions(args);
  const { operands } = parseOptions(args, { long: { help: false, version: false } });
  if (operands.length) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[0])}`, true);
  const uid = process.getuid?.() ?? userInfo().uid;
  const passwd = await readPasswd();
  const passwdFallback = await uidIsLinuxOverflow(uid) ? null : await userNameForUid(uid);
  for (const name of [process.env.LOGNAME, process.env.USER, userInfo().username, passwdFallback]) {
    if (!name) continue;
    if (passwd.get(name)?.uid === uid) {
      stdout(`${name}\n`);
      return 0;
    }
  }
  stderr("logname: no login name\n");
  return 1;
}

export async function uidIsLinuxOverflow(uid) {
  try {
    return Number((await readFile("/proc/sys/kernel/overflowuid", "utf8")).trim()) === Number(uid);
  } catch {
    return false;
  }
}

const singleCall = defineCommand("logname", logname, helpVersionOnlyMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
