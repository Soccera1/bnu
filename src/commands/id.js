#!/usr/bin/env bun

import { userInfo } from "node:os";
import { groupName, invalidOptionMessage, localeQuotedDiagnostic, normalizeLongOptionByPrefix, orderedGroupIds, parseOptions, processSecurityContext, readGroup, readPasswd, selinuxRuntimeEnabled, supplementaryGroupsForUser, userNameForUid } from "../shared/common.js";
import { UsageError, fail, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const ID_LONG_OPTIONS = ["user", "group", "groups", "name", "real", "zero", "context", "help", "version"];

export function idMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeIdLongOption(arg);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      return normalized;
    }
    if (ID_LONG_OPTIONS.includes(name)) {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      if (name === "context" && !selinuxRuntimeEnabled()) return null;
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      if (arg.includes("Z") && !selinuxRuntimeEnabled()) return null;
      i = scanIdShortMetaOption(args, i);
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(invalidOptionMessage(arg), true);
  }
  return null;
}

export function scanIdShortMetaOption(args, index) {
  const arg = args[index];
  for (let j = 1; j < arg.length; j++) {
    const ch = arg[j];
    if ("ugGnrzZ".includes(ch)) continue;
    throw new UsageError(`invalid option -- '${ch}'`, true);
  }
  return index;
}

export async function idCmd(args) {
  args = normalizeIdLongOptions(args);
  const { opts, operands } = parseOptions(args, {
    short: { u: false, g: false, G: false, n: false, r: false, z: false, Z: false },
    long: { user: false, group: false, groups: false, name: false, real: false, zero: false, context: false, help: false, version: false },
  });
  const justContext = Boolean(opts.Z || opts.context);
  const selinuxEnabled = selinuxRuntimeEnabled();
  if (justContext && !selinuxEnabled) return fail("id", "--context (-Z) works only on an SELinux-enabled kernel", 1);
  if (justContext && operands.length) return fail("id", "cannot print security context when user specified", 1);
  const selected = [opts.u || opts.user, opts.g || opts.group, opts.G || opts.groups, justContext].filter(Boolean).length;
  if (selected > 1) throw new UsageError('cannot print "only" of more than one choice');
  const defaultFormat = selected === 0;
  if (defaultFormat && (opts.n || opts.name || opts.r || opts.real)) throw new UsageError("printing only names or real IDs requires -u, -g, or -G");
  const zero = opts.z || opts.zero;
  if (zero && defaultFormat) throw new UsageError("option --zero not permitted in default format");
  const name = opts.n || opts.name;
  const end = zero ? "\0" : "\n";
  const sep = zero ? "\0" : " ";
  let context = null;
  if (!operands.length && (justContext || (defaultFormat && !process.env.POSIXLY_CORRECT)) && selinuxEnabled) {
    context = processSecurityContext();
    if (justContext && context == null) return fail("id", "can't get process context", 1);
  }
  if (justContext) {
    stdout(`${context}${end}`);
    return 0;
  }
  let failed = false;
  for (const operand of operands.length ? operands : [undefined]) {
    let identity;
    try {
      identity = await identityForUser(operand);
    } catch (error) {
      stderr(`id: ${error.message}\n`);
      failed = true;
      continue;
    }
    if (opts.u || opts.user) stdout(`${name ? identity.name : identity.uid}${end}`);
    else if (opts.g || opts.group) stdout(`${name ? await groupName(identity.gid) : identity.gid}${end}`);
    else if (opts.G || opts.groups) {
      const groupEnd = zero && operands.length > 1 ? "\0\0" : end;
      stdout(`${name ? (await Promise.all(identity.groups.map(groupName))).join(sep) : identity.groups.join(sep)}${groupEnd}`);
    }
    else stdout(`uid=${identity.uid}(${identity.name}) gid=${identity.gid}(${await groupName(identity.gid)}) groups=${identity.groups.map((gid) => `${gid}(${identity.groupNames.get(gid) ?? gid})`).join(",")}${context != null ? ` context=${context}` : ""}\n`);
  }
  return failed ? 1 : 0;
}

export function normalizeIdLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeIdLongOption(arg));
  }
  return out;
}

export function normalizeIdLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, ID_LONG_OPTIONS);
}

export async function identityForUser(user) {
  const info = userInfo();
  const uid = process.getuid?.() ?? info.uid;
  const gid = process.getgid?.() ?? info.gid;
  const currentName = await userNameForUid(uid) ?? info.username;
  const originalUser = user;
  const numericOnly = typeof user === "string" && /^\+\d+$/.test(user);
  if (numericOnly) user = user.slice(1);
  if (user == null) {
    const groups = orderedGroupIds(gid, process.getgroups?.() ?? [gid]);
    return { name: currentName, uid, gid, groups, groupNames: await groupNamesMap() };
  }
  const passwd = await readPasswd();
  let entry = numericOnly ? null : passwd.get(user);
  if (!entry && /^\d+$/.test(user)) {
    for (const [name, row] of passwd) {
      if (row.uid === Number(user)) {
        entry = { ...row, name };
        break;
      }
    }
  } else if (entry) {
    entry = { ...entry, name: user };
  }
  if (!entry) throw new UsageError(`${localeQuotedDiagnostic(originalUser)}: no such user`);
  const memberGroups = await supplementaryGroupsForUser(entry.name);
  return { name: entry.name, uid: entry.uid, gid: entry.gid, groups: orderedGroupIds(entry.gid, memberGroups), groupNames: await groupNamesMap() };
}

export async function groupNamesMap() {
  const groups = await readGroup();
  return new Map([...groups].map(([name, gid]) => [gid, name]));
}

const singleCall = defineCommand("id", idCmd, idMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
