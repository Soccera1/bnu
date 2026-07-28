#!/usr/bin/env bun

import { access } from "node:fs/promises";
import { libc, parseOptions } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { SIGNAL_NAMES, signalDisplayName, signalNumberFromOperand } from "../shared/process.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function killCmd(args) {
  if (countKillListOptions(args) > 1) throw new UsageError("multiple -l or -t options specified", true);
  args = normalizeKillArgs(args);
  const { opts, operands } = parseOptions(args, { short: { s: "value", n: "value", l: false, L: false, t: false }, long: { signal: "value", list: "optional-value", table: false } });
  const listCount = Number(Boolean(opts.l || opts.list)) + Number(Boolean(opts.L || opts.t || opts.table));
  if (listCount > 1) throw new UsageError("multiple -l or -t options specified", true);
  if (listCount && (opts.s || opts.n || opts.signal)) throw new UsageError("cannot combine signal with -l or -t", true);
  if (opts.L || opts.t || opts.table) return listSignals(true, operands);
  const listSignal = opts.list === true ? operands[0] : opts.list || (opts.l ? operands[0] : null);
  if (opts.l || opts.list) {
    return listSignals(false, listSignal ? [listSignal, ...operands.slice(1)] : operands);
  }
  const explicitSignal = opts.s != null || opts.n != null || opts.signal != null;
  let signal = opts.s ?? opts.n ?? opts.signal ?? "TERM";
  const pids = [];
  for (const arg of operands) {
    if (/^-[A-Za-z]+$/.test(arg) || (!explicitSignal && /^-\d+$/.test(arg))) signal = arg.slice(1);
    else pids.push(Number(arg));
  }
  if (!pids.length || pids.some((pid) => !Number.isInteger(pid))) throw new UsageError("missing or invalid process id");
  const normalized = normalizeKillSignal(signal);
  if (normalized === 0) {
    for (const pid of pids) {
      if (pid > 0) await access(`/proc/${pid}`);
    }
    return 0;
  }
  for (const pid of pids) {
    if (typeof normalized === "number" && normalized > 31) {
      if (libc.symbols.kill(pid, normalized) !== 0) throw new Error(`failed to send signal ${normalized} to ${pid}`);
    } else process.kill(pid, normalized);
  }
  return 0;
}

export function normalizeKillArgs(args) {
  const normalized = [];
  let end = false;
  let sawSignalSelector = false;
  for (const arg of args) {
    if (end) normalized.push(arg);
    else if (arg === "--") {
      normalized.push(arg);
      end = true;
    }
    else if (arg === "-s" || arg === "-n") {
      normalized.push(arg);
      sawSignalSelector = true;
    }
    else if (/^-n.+/.test(arg)) {
      normalized.push("-n", arg.slice(2));
      sawSignalSelector = true;
    }
    else if (/^-s.+/.test(arg)) {
      normalized.push("-s", arg.slice(2));
      sawSignalSelector = true;
    }
    else if (!sawSignalSelector && /^-\d+$/.test(arg)) {
      normalized.push("-s", arg.slice(1));
      sawSignalSelector = true;
    }
    else if (sawSignalSelector && /^-\d+$/.test(arg)) {
      normalized.push("--", arg);
      end = true;
    }
    else if (/^-[A-Z][A-Za-z0-9]*$/.test(arg) && !["-L"].includes(arg)) {
      normalized.push("-s", arg.slice(1));
      sawSignalSelector = true;
    }
    else normalized.push(arg);
  }
  return normalized;
}

export function countKillListOptions(args) {
  let count = 0;
  let end = false;
  for (const arg of args) {
    if (end) continue;
    if (arg === "--") {
      end = true;
      continue;
    }
    if (arg === "-l" || arg === "-t" || arg === "-L" || arg === "--list" || arg === "--table") count++;
  }
  return count;
}

export function normalizeKillSignal(signal) {
  const signum = signalNumberFromOperand(signal);
  if (signum < 0) throw new UsageError(`invalid signal '${signal}'`, true);
  if (signum >= 34 && signum <= 64) return signum;
  return signum === 0 ? 0 : `SIG${SIGNAL_NAMES[signum]}`;
}

export function listSignals(table, operands) {
  const values = operands.length
    ? operands
    : [...SIGNAL_NAMES.keys(), ...Array.from({ length: 31 }, (_, index) => index + 34)].map(String);
  let status = 0;
  for (const value of values) {
    const signum = signalNumberFromOperand(value);
    if (signum < 0) {
      status = 1;
      continue;
    }
    const name = signalDisplayName(signum);
    if (name == null) continue;
    if (table) stdout(`${String(signum).padStart(2)} ${name.padEnd(10)} ${signalDescription(signum)}\n`);
    else if (/^\d+$/.test(String(value))) stdout(`${name}\n`);
    else stdout(`${signum}\n`);
  }
  return status;
}

export function signalDescription(signum) {
  if (signum === 0) return "Exit";
  if (signum >= 34 && signum <= 64) return signalDisplayName(signum);
  return SIGNAL_NAMES[signum];
}

const singleCall = defineCommand("kill", killCmd, (args) => { for (const arg of args) { if (arg === "--") return null; if (arg === "--help" || arg === "--version") return arg; } return null; });
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
