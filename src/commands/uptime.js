#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { localeQuotedEscapedDiagnostic, parseOptions, pathDisplayName, shellEscapeLsName, systemErrorMessage } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { filterWhoUsers, parseUtmpRecords, whoBootRecord } from "../shared/system.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const UPTIME_LONG_OPTIONS = ["help", "version"];

export function uptimeMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (arg.startsWith("--")) {
      const option = normalizeUptimeLongOption(arg);
      const name = option.slice(2).split("=", 1)[0];
      if (!UPTIME_LONG_OPTIONS.includes(name) || option.includes("=")) return null;
      if (option === "--help" || option === "--version") return option;
      continue;
    }
    return null;
  }
  return null;
}

export async function uptimeCmd(args) {
  args = normalizeUptimeLongOptions(args);
  const { operands } = parseOptions(args, { long: { help: false, version: false } });
  if (operands.length > 1) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[1])}`, true);
  let records = [];
  let readStatus = 0;
  const file = operands[0] ?? "/var/run/utmp";
  try {
    records = await readUtmpRecordsStrict(file);
  } catch (error) {
    stderr(`uptime: ${shellEscapeLsName(pathDisplayName(file), true)}: ${systemErrorMessage(error)}\n`);
    readStatus = 1;
  }
  const users = await filterWhoUsers(records, operands.length === 0);
  const bootTime = uptimeBootTime(records, operands.length === 0);
  const nowSeconds = Math.trunc(Date.now() / 1000);
  let status = readStatus;
  let uptimeText;
  if (bootTime == null || bootTime <= 0 || bootTime > nowSeconds) {
    stderr("uptime: couldn't get boot time\n");
    status = 1;
  } else {
    uptimeText = formatUptimeDefault(nowSeconds - bootTime);
  }
  const loads = loadavg().map((value) => value.toFixed(2));
  const now = new Date();
  stdout(` ${formatUptimeClock(now)} ${uptimeText ?? "up ???? days ??:??"},  ${users.length} user${users.length === 1 ? "" : "s"},  load average: ${loads.join(", ")}\n`);
  return status;
}

export function normalizeUptimeLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeUptimeLongOption(arg));
  }
  return out;
}

export function normalizeUptimeLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = UPTIME_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

export function formatUptimeClock(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

export async function readUtmpRecordsStrict(file) {
  const bytes = await readFile(file);
  return parseUtmpRecords(bytes);
}

export function uptimeBootTime(records, allowFallback) {
  const boot = whoBootRecord(records);
  if (boot?.time) return boot.time;
  if (allowFallback) {
    try {
      const match = readFileSync("/proc/stat", "utf8").match(/^btime\s+(\d+)/m);
      if (match) return Number(match[1]);
    } catch {}
  }
  return null;
}

export function formatUptimeDefault(seconds) {
  const days = Math.trunc(seconds / 86400);
  const hours = Math.trunc((seconds % 86400) / 3600);
  const minutes = Math.trunc((seconds % 3600) / 60);
  if (days) return `up ${days} day${days === 1 ? "" : "s"}, ${String(hours).padStart(2)}:${String(minutes).padStart(2, "0")}`;
  return `up ${String(hours).padStart(2)}:${String(minutes).padStart(2, "0")}`;
}

const singleCall = defineCommand("uptime", uptimeCmd, uptimeMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
