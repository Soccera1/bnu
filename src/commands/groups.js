#!/usr/bin/env bun

import { userInfo } from "node:os";
import { groupName, helpVersionOnlyMetaOption, localeQuotedDiagnostic, normalizeHelpVersionOnlyLongOptions, orderedGroupIds, parseOptions, readPasswd, supplementaryGroupsForUser, userNameForUid } from "../shared/common.js";
import { stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function groupsCmd(args) {
  args = normalizeHelpVersionOnlyLongOptions(args);
  const { operands } = parseOptions(args, { long: { help: false, version: false } });
  const info = userInfo();
  const uid = process.getuid?.() ?? info.uid;
  const gid = process.getgid?.() ?? info.gid;
  const currentName = await userNameForUid(uid) ?? info.username;
  if (!operands.length) {
    const groups = orderedGroupIds(gid, process.getgroups?.() ?? [gid]);
    stdout(`${(await Promise.all(groups.map(groupName))).join(" ")}\n`);
    return 0;
  }
  let code = 0;
  const passwd = await readPasswd();
  for (const user of operands) {
    const row = passwd.get(user);
    if (!row) {
      stderr(`groups: ${localeQuotedDiagnostic(user)}: no such user\n`);
      code = 1;
      continue;
    }
    const groups = orderedGroupIds(row.gid, await supplementaryGroupsForUser(user));
    stdout(`${user} : ${(await Promise.all(groups.map(groupName))).join(" ")}\n`);
  }
  return code;
}

const singleCall = defineCommand("groups", groupsCmd, helpVersionOnlyMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
