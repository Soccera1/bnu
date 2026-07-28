#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { hostname as osHostname, release as osRelease, type as osType, version as osVersion } from "node:os";
import { localeQuotedEscapedDiagnostic, machineName, parseOptions } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const UNAME_LONG_OPTIONS = ["all", "kernel-name", "nodename", "kernel-release", "kernel-version", "machine", "processor", "hardware-platform", "operating-system", "help", "version"];

export function unameMetaOption(args) {
  const shortKnownOptions = new Set(["a", "s", "n", "r", "v", "m", "p", "i", "o"]);
  for (const arg of args) {
    if (arg === "--") return null;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (!arg.startsWith("--")) {
      for (const ch of arg.slice(1)) {
        if (!shortKnownOptions.has(ch)) return null;
      }
      continue;
    }
    if (arg.includes("=")) return null;
    const option = normalizeUnameLongOption(arg);
    if (option === "--help" || option === "--version") return option;
    if (option === arg && !UNAME_LONG_OPTIONS.includes(arg.slice(2))) return null;
  }
  return null;
}

export async function unameCmd(args) {
  args = normalizeUnameLongOptions(args);
  const { opts, operands } = parseOptions(args, {
    short: { a: false, s: false, n: false, r: false, v: false, m: false, p: false, i: false, o: false },
    long: { all: false, "kernel-name": false, nodename: false, "kernel-release": false, "kernel-version": false, machine: false, processor: false, "hardware-platform": false, "operating-system": false, help: false, version: false },
  });
  if (operands.length) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[0])}`, true);
  const all = opts.a || opts.all;
  const fields = [];
  const selected = all || opts.s || opts["kernel-name"] || opts.n || opts.nodename || opts.r || opts["kernel-release"] || opts.v || opts["kernel-version"] || opts.m || opts.machine || opts.p || opts.processor || opts.i || opts["hardware-platform"] || opts.o || opts["operating-system"];
  if (!selected || all || opts.s || opts["kernel-name"]) fields.push(osType());
  if (all || opts.n || opts.nodename) fields.push(osHostname());
  if (all || opts.r || opts["kernel-release"]) fields.push(osRelease());
  if (all || opts.v || opts["kernel-version"]) fields.push(osVersion());
  if (all || opts.m || opts.machine) fields.push(machineName());
  if (all || opts.p || opts.processor) fields.push(unameProcessorName());
  if (all || opts.i || opts["hardware-platform"]) fields.push(unameHardwarePlatform());
  if (all || opts.o || opts["operating-system"]) fields.push(process.platform === "linux" ? "GNU/Linux" : process.platform);
  stdout(`${fields.join(" ")}\n`);
  return 0;
}

export function normalizeUnameLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeUnameLongOption(arg));
  }
  return out;
}

export function normalizeUnameLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const matches = UNAME_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length === 0) return arg;
  if (matches.length > 1) {
    throw new UsageError(`option '--${eq === -1 ? name : body}' is ambiguous; possibilities: ${matches.map((option) => `'--${option}'`).join(" ")}`, true);
  }
  return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
}

export function unameProcessorName() {
  if (process.platform === "linux") {
    const value = procCpuInfoField("model name") ?? procCpuInfoField("Processor");
    if (value) return value;
  }
  return process.arch === "x64" ? "x86_64" : machineName();
}

export function unameHardwarePlatform() {
  if (process.platform === "linux") {
    const value = procCpuInfoField("vendor_id") ?? procCpuInfoField("Hardware");
    if (value) return value;
  }
  return machineName();
}

export function procCpuInfoField(field) {
  try {
    const text = readFileSync("/proc/cpuinfo", "utf8");
    const prefix = `${field.toLowerCase()}\t`;
    for (const line of text.split("\n")) {
      const [name, value] = line.split(":", 2);
      if (name?.trim().toLowerCase() === field.toLowerCase() || name?.toLowerCase().startsWith(prefix)) {
        const trimmed = value?.trim();
        if (trimmed) return trimmed;
      }
    }
  } catch {}
  return null;
}

const singleCall = defineCommand("uname", unameCmd, unameMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
