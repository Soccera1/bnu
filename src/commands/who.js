#!/usr/bin/env bun

import { localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, parseOptions, statSyncNoThrow } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { filterWhoUsers, formatWhoDate, readUtmpRecords, whoBootRecord, whoUsesPosixDateFormat } from "../shared/system.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const WHO_LONG_OPTIONS = ["all", "boot", "dead", "heading", "login", "lookup", "mesg", "message", "count", "process", "runlevel", "short", "time", "users", "writable", "help", "version"];

export async function who(args) {
  args = normalizeWhoLongOptions(args);
  const { opts, operands } = parseOptions(args, {
    short: { a: false, q: false, b: false, d: false, H: false, l: false, m: false, p: false, r: false, s: false, t: false, T: false, u: false, w: false },
    long: { all: false, count: false, boot: false, dead: false, heading: false, login: false, lookup: false, mesg: false, message: false, process: false, runlevel: false, short: false, time: false, users: false, writable: false, help: false, version: false },
  });
  if (operands.length > 2) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[2])}`, true);
  if (opts.m || operands.length === 2) {
    if (opts.q || opts.count) stdout("\n# users=0\n");
    else if (opts.H || opts.heading) stdout(formatWhoHeading(opts));
    return 0;
  }
  if (operands.length === 1 || operands.length === 0) {
    const defaultUtmp = operands.length === 0;
    const records = await readUtmpRecords(operands[0] ?? "/var/run/utmp");
    const users = await filterWhoUsers(records, defaultUtmp);
    if (opts.a || opts.all) {
      if (opts.H || opts.heading) stdout(formatWhoAllHeading());
      for (const record of records) {
        const rendered = record.type === 7 && record.user ? formatWhoRecord(record, { ...opts, T: true, u: true }) : formatWhoSpecialRecord(record, true);
        if (rendered) stdout(rendered);
      }
      const boot = whoBootRecord(records, defaultUtmp);
      if (boot) stdout(`           system boot  ${formatWhoDate(boot.time)}\n`);
    } else if (opts.b || opts.boot) {
      if (opts.H || opts.heading) stdout(formatWhoPidHeading());
      const boot = whoBootRecord(records, defaultUtmp);
      if (boot) stdout(`         system boot  ${formatWhoDate(boot.time)}\n`);
    } else if (opts.d || opts.dead) {
      if (opts.H || opts.heading) stdout(formatWhoIdlePidHeading(true));
      for (const record of records.filter((record) => record.type === 8)) stdout(formatWhoDeadRecord(record));
    } else if (opts.l || opts.login) {
      if (opts.H || opts.heading) stdout(formatWhoIdlePidHeading());
      for (const record of records.filter((record) => record.type === 6)) stdout(formatWhoLoginRecord(record));
    } else if (opts.p || opts.process) {
      if (opts.H || opts.heading) stdout(formatWhoPidHeading());
      for (const record of records.filter((record) => record.type === 5)) stdout(formatWhoProcessRecord(record));
    } else if (opts.r || opts.runlevel) {
      if (opts.H || opts.heading) stdout(formatWhoIdlePidHeading());
      for (const record of records.filter((record) => record.type === 1)) stdout(formatWhoRunlevelRecord(record));
    } else if (opts.t || opts.time) {
      if (opts.H || opts.heading) stdout(formatWhoPidHeading());
      for (const record of records.filter((record) => record.type === 3)) stdout(formatWhoClockChangeRecord(record));
    } else if (opts.q || opts.count) {
      stdout(`${users.map((record) => record.user).join(" ")}\n# users=${users.length}\n`);
    } else {
      if (opts.H || opts.heading) stdout(formatWhoHeading(opts));
      for (const record of users) stdout(formatWhoRecord(record, opts));
    }
    return 0;
  }
}

export function whoMetaOption(args) {
  const shortOptions = new Set(["a", "q", "b", "d", "H", "l", "m", "p", "r", "s", "t", "T", "u", "w"]);
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const normalized = normalizeWhoLongOption(arg);
      const name = normalized.slice(2).split("=", 1)[0];
      if (!WHO_LONG_OPTIONS.includes(name) || normalized.includes("=")) return null;
      if (normalized === "--help" || normalized === "--version") return normalized;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      for (let i = 1; i < arg.length; i++) if (!shortOptions.has(arg[i])) return null;
    }
  }
  return null;
}

export function normalizeWhoLongOptions(args) {
  const out = [];
  for (const arg of args) out.push(arg.startsWith("--") && arg !== "--" ? normalizeWhoLongOption(arg) : arg);
  return out;
}

export function normalizeWhoLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (name && !WHO_LONG_OPTIONS.includes(name) && name !== "mesg" && "message".startsWith(name)) {
    return eq === -1 ? "--message" : `--message=${body.slice(eq + 1)}`;
  }
  return normalizeLongOptionByPrefix(arg, WHO_LONG_OPTIONS);
}

export function formatWhoSpecialRecord(record, all = false) {
  if (record.type === 8) return formatWhoDeadRecord(record, all);
  if (record.type === 1) return formatWhoRunlevelRecord(record, all);
  if (record.type === 3) return formatWhoClockChangeRecord(record, all);
  if (record.type === 6) return formatWhoLoginRecord(record, all);
  if (record.type === 5) return formatWhoProcessRecord(record, all);
  return "";
}

export function formatWhoClockChangeRecord(record, all = false) {
  const nameWidth = all ? 10 : 8;
  return `${"".padEnd(nameWidth)} clock change ${formatWhoDate(record.time)}\n`;
}

export function formatWhoProcessRecord(record, all = false) {
  const nameWidth = all ? 10 : 8;
  const pidWidth = all ? 17 : 10;
  return `${"".padEnd(nameWidth)} ${record.line.padEnd(12)} ${formatWhoDate(record.time)} ${String(record.pid).padStart(pidWidth)} id=${record.id}\n`;
}

export function formatWhoDeadRecord(record, all = false) {
  const nameWidth = all ? 10 : 8;
  return `${"".padEnd(nameWidth)} ${record.line.padEnd(12)} ${formatWhoDate(record.time)} ${String(record.pid).padStart(17)} id=${record.id.padEnd(5)} term=${record.exitTermination} exit=${record.exitStatus}\n`;
}

export function formatWhoLoginRecord(record, all = false) {
  const nameWidth = all ? 10 : 8;
  return `${record.user.padEnd(nameWidth)} ${record.line.padEnd(12)} ${formatWhoDate(record.time)} ${String(record.pid).padStart(17)} id=${record.id}\n`;
}

export function formatWhoRunlevelRecord(record, all = false) {
  const current = String.fromCharCode(record.pid & 0xff);
  const previous = String.fromCharCode((record.pid >> 8) & 0xff);
  const nameWidth = all ? 10 : 8;
  return `${"".padEnd(nameWidth)} run-level ${current}  ${formatWhoDate(record.time)} ${"".padStart(18)}last=${previous === "N" ? "S" : previous}\n`;
}

export function formatWhoRecord(record, opts = {}) {
  const showMessageStatus = opts.T || opts.w || opts.mesg || opts.message || opts.writable;
  const showIdle = opts.u || opts.users;
  const status = showMessageStatus ? ` ${whoMessageStatus(record.line)}` : "";
  const idle = showIdle ? whoIdleText(record.line) : "";
  const pid = showIdle ? String(record.pid).padStart(14) : "";
  const where = record.host ? ` (${record.host})` : "";
  return `${record.user.padEnd(8)}${status} ${record.line.padEnd(12)} ${formatWhoDate(record.time)}${showIdle ? `${idle.padStart(4)}${pid}` : ""}${where}\n`;
}

export function formatWhoHeading(opts = {}) {
  const showMessageStatus = opts.T || opts.w || opts.mesg || opts.message || opts.writable;
  const showIdle = opts.u || opts.users;
  const name = showMessageStatus ? `${"NAME".padEnd(8)}  ` : "NAME".padEnd(8);
  const suffix = showIdle ? ` ${"IDLE".padEnd(13)} PID COMMENT` : " COMMENT";
  return `${name} ${"LINE".padEnd(12)} ${"TIME".padEnd(whoUsesPosixDateFormat() ? 12 : 16)}${suffix}\n`;
}

export function formatWhoPidHeading() {
  return `${"NAME".padEnd(8)} ${"LINE".padEnd(12)} ${"TIME".padEnd(whoUsesPosixDateFormat() ? 12 : 16)}${"".padEnd(7)} PID COMMENT\n`;
}

export function formatWhoIdlePidHeading(exit = false) {
  return `${"NAME".padEnd(8)} ${"LINE".padEnd(12)} ${"TIME".padEnd(whoUsesPosixDateFormat() ? 12 : 16)} ${"IDLE".padEnd(13)} PID COMMENT${exit ? "  EXIT" : ""}\n`;
}

export function formatWhoAllHeading() {
  return `${formatWhoHeading({ T: true, u: true }).trimEnd()}  EXIT\n`;
}

export function whoMessageStatus(line) {
  const mode = statSyncNoThrow(`/dev/${line}`)?.mode;
  if (mode == null) return "?";
  return mode & 0o020 ? "+" : "-";
}

export function whoIdleText(line) {
  const info = statSyncNoThrow(`/dev/${line}`);
  if (!info) return "?";
  const seconds = Math.max(0, Math.floor((Date.now() - info.atimeMs) / 1000));
  if (seconds < 60) return ".";
  if (seconds >= 24 * 60 * 60) return "old";
  return `${String(Math.floor(seconds / 3600)).padStart(2)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}`;
}

const singleCall = defineCommand("who", who, whoMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
