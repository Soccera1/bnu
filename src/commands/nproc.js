#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { join } from "node:path";
import { libc, localeQuotedEscapedDiagnostic, parseOptions } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const NPROC_LONG_OPTIONS = ["all", "ignore", "help", "version"];

export function nprocMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-") && arg !== "-") return null;
      continue;
    }
    const option = normalizeNprocLongOption(arg);
    const name = option.slice(2).split("=", 1)[0];
    if (!NPROC_LONG_OPTIONS.includes(name)) return null;
    if (option.includes("=")) {
      if (name === "all" || name === "help" || name === "version") return null;
      if (name === "ignore") parseNprocIgnore(option.slice(option.indexOf("=") + 1));
      continue;
    }
    if (name === "help" || name === "version") return option;
    if (name === "ignore") i++;
  }
  return null;
}

export async function nprocCmd(args) {
  args = normalizeNprocLongOptions(args);
  const { opts, operands } = parseOptions(args, { long: { all: false, ignore: "value", help: false, version: false } });
  if (operands.length) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[0])}`, true);
  const installed = BigInt(cpus().length);
  const available = BigInt(Math.max(1, availableParallelism()));
  const openMp = opts.all ? { threads: null, limit: null } : nprocOpenMpLimits();
  const quotaLimit = opts.all || openMp.threads != null ? null : nprocCgroupQuotaLimit();
  let use;
  if (opts.all) use = installed;
  else if (openMp.threads != null) use = openMp.limit != null && openMp.limit < openMp.threads ? openMp.limit : openMp.threads;
  else {
    use = quotaLimit != null && quotaLimit < available ? quotaLimit : available;
    if (openMp.limit != null && openMp.limit < use) use = openMp.limit;
  }
  const ignore = opts.ignore == null ? 0n : parseNprocIgnore(opts.ignore);
  const result = use > ignore ? use - ignore : 1n;
  stdout(`${result < 1n ? 1n : result}\n`);
  return 0;
}

export function nprocCgroupQuotaLimit() {
  if (!nprocSchedulerUsesQuota()) return null;
  const testRoot = process.env.BNU_NPROC_TEST_ROOT;
  const procCgroup = testRoot ? join(testRoot, "proc/self/cgroup") : "/proc/self/cgroup";
  const cgroupRoot = testRoot ? join(testRoot, "sys/fs/cgroup") : "/sys/fs/cgroup";
  let membership;
  try {
    membership = readFileSync(procCgroup, "utf8");
  } catch {
    return null;
  }
  const unified = membership.split(/\r?\n/).find((line) => line.startsWith("0::"));
  if (!unified) return null;
  const components = unified.slice(3).split("/").filter((part) => part && part !== "." && part !== "..");
  let limit = null;
  for (let length = components.length; length >= 0; length--) {
    let cpuMax;
    try {
      cpuMax = readFileSync(join(cgroupRoot, ...components.slice(0, length), "cpu.max"), "utf8").trim();
    } catch {
      continue;
    }
    const [quotaText, periodText] = cpuMax.split(/\s+/);
    if (quotaText === "max" || !/^\d+$/.test(quotaText) || !/^\d+$/.test(periodText)) continue;
    const quota = BigInt(quotaText);
    const period = BigInt(periodText);
    if (quota <= 0n || period <= 0n) continue;
    const rounded = (2n * quota + period) / (2n * period);
    const candidate = rounded < 1n ? 1n : rounded;
    if (limit == null || candidate < limit) limit = candidate;
    if (limit === 1n) break;
  }
  return limit;
}

export function nprocSchedulerUsesQuota() {
  const testRoot = process.env.BNU_NPROC_TEST_ROOT;
  const schedPath = testRoot ? join(testRoot, "proc/self/sched") : "/proc/self/sched";
  try {
    const sched = readFileSync(schedPath, "utf8");
    const match = sched.match(/^policy\s*:\s*(-?\d+)/m);
    if (match) return ![-1, 1, 2, 6].includes(Number(match[1]));
  } catch {
    // Fall through to libc on systems without Linux procfs.
  }
  const policy = libc.symbols.sched_getscheduler(0);
  return ![-1, 1, 2, 6].includes(policy);
}

export function normalizeNprocLongOptions(args) {
  const out = [];
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    const option = normalizeNprocLongOption(arg);
    out.push(option);
    if (option === "--ignore" && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

export function normalizeNprocLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = NPROC_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

export function parseNprocIgnore(value) {
  const text = String(value).trimStart();
  if (!/^\+?\d+$/.test(text)) throw new UsageError(`invalid number: ${localeQuotedEscapedDiagnostic(value)}`);
  return BigInt(text);
}

export function nprocOpenMpLimits() {
  return {
    threads: openMpPositiveIntegerPrefix(process.env.OMP_NUM_THREADS),
    limit: openMpPositiveIntegerPrefix(process.env.OMP_THREAD_LIMIT),
  };
}

export function openMpPositiveIntegerPrefix(value) {
  const match = String(value ?? "").trim().match(/^(\d+)(?:,|$)/);
  if (!match) return null;
  const parsed = BigInt(match[1]);
  if (parsed <= 0n) return null;
  return parsed > 18446744073709551615n ? 18446744073709551615n : parsed;
}

const singleCall = defineCommand("nproc", nprocCmd, nprocMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
