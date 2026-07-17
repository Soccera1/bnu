#!/usr/bin/env bun

import { userInfo } from "node:os";
import { join } from "node:path";
import { normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions, readAll, readPasswd } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { filterWhoUsers, formatWhoDate, readUtmpRecords, whoUsesPosixDateFormat } from "../shared/system.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const PINKY_LONG_OPTIONS = ["lookup", "help", "version"];

export async function pinky(args) {
  const longOutput = pinkyLongOutputRequested(args);
  args = normalizePinkyLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { b: false, f: false, h: false, i: false, l: false, p: false, q: false, s: false, w: false }, long: { lookup: false, help: false, version: false } });
  const info = userInfo();
  const name = info.username;
  if (longOutput) {
    if (!operands.length) throw new UsageError("no username specified; at least one must be specified when using -l", true);
    const passwd = await readPasswd();
    const users = operands;
    for (const user of users) {
      const row = passwd.get(user);
      const gecosName = row?.gecos?.split(",")[0] || (row ? user : "???");
      stdout(`Login name: ${user.padEnd(28)}In real life:  ${gecosName}\n`);
      if (row && !(opts.b)) stdout(`Directory: ${row.home.padEnd(29)}Shell:  ${row.shell}\n`);
      if (row && !opts.h) await pinkyPrintProfile("Project: ", row.home, ".project");
      if (row && !opts.p) await pinkyPrintProfile("Plan:\n", row.home, ".plan");
      if (row) stdout("\n");
    }
  } else {
    const hideName = opts.w || opts.i || opts.q;
    const hideIdle = opts.q;
    const hideWhere = opts.i || opts.q;
    if (!opts.f) {
      const columns = ["Login"];
      if (!hideName) columns.push("Name");
      columns.push("TTY");
      if (!hideIdle) columns.push("Idle");
      columns.push("When");
      if (!hideWhere) columns.push("Where");
      stdout(pinkyShortHeader(columns));
    }
    const filters = new Set(operands);
    if (!filters.size || filters.has(name)) {
      const record = (await filterWhoUsers(await readUtmpRecords("/var/run/utmp"), false)).find((entry) => entry.user === name);
      stdout(pinkyShortRow({ name, line: record?.line, time: record?.time, showName: !hideName, showIdle: !hideIdle, showWhere: !hideWhere }));
    }
  }
  return 0;
}

export function pinkyLongOutputRequested(args) {
  let longOutput = false;
  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (arg.startsWith("--")) continue;
    for (const option of arg.slice(1)) {
      if (option === "l") longOutput = true;
      else if (option === "s") longOutput = false;
    }
  }
  return longOutput;
}

export async function pinkyPrintProfile(header, home, name) {
  try {
    const content = await readAll(join(home, name));
    stdout(header);
    stdout(content);
  } catch {
    // GNU pinky treats unavailable profile files as absent.
  }
}

export function pinkyMetaOption(args) {
  const shortOptions = new Set(["b", "f", "h", "i", "l", "p", "q", "s", "w"]);
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const normalized = normalizePinkyLongOption(arg);
      const name = normalized.slice(2).split("=", 1)[0];
      if (!PINKY_LONG_OPTIONS.includes(name) || normalized.includes("=")) return null;
      if (normalized === "--help" || normalized === "--version") return normalized;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      for (let i = 1; i < arg.length; i++) if (!shortOptions.has(arg[i])) return null;
    }
  }
  return null;
}

export function normalizePinkyLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, PINKY_LONG_OPTIONS);
}

export function normalizePinkyLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, PINKY_LONG_OPTIONS);
}

export function pinkyShortHeader(columns) {
  return columns.map((column, index) => {
    const widths = { Login: columns.includes("Name") ? 8 : 9, Name: 20, TTY: 8, Idle: 6, When: whoUsesPosixDateFormat() ? 12 : 16, Where: 0 };
    return widths[column] ? column.padEnd(widths[column]) : column;
  }).join(" ") + "\n";
}

export function pinkyShortRow({ name, line, time, showName, showIdle, showWhere }) {
  const parts = [name.padEnd(8)];
  if (showName) parts.push("".padEnd(19));
  parts.push(`?${line ?? "tty"}`.padEnd(9));
  if (showIdle) parts.push("?????".padEnd(6));
  parts.push(time ? formatWhoDate(time) : formatWhoDate(Date.now() / 1000));
  if (showWhere) parts.push("");
  return parts.join(" ").trimEnd() + "\n";
}

const singleCall = defineCommand("pinky", pinky, pinkyMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
