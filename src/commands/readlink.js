#!/usr/bin/env bun

import { readlink } from "node:fs/promises";
import { normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { canonicalPath, readlinkErrorMessage, readlinkQuotedName } from "../shared/paths.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const READLINK_LONG_OPTIONS = ["canonicalize", "canonicalize-existing", "canonicalize-missing", "no-newline", "quiet", "silent", "verbose", "zero", "help", "version"];

export function readlinkMetaOption(args) {
  const shortKnownOptions = new Set(["f", "e", "m", "n", "q", "s", "v", "z"]);
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeReadlinkLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!READLINK_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (inlineValue != null) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) if (!shortKnownOptions.has(arg[j])) return null;
  }
  return null;
}

export async function readlinkCmd(args) {
  args = normalizeReadlinkLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { f: false, e: false, m: false, n: false, q: false, s: false, v: false, z: false }, long: { canonicalize: false, "canonicalize-existing": false, "canonicalize-missing": false, "no-newline": false, quiet: false, silent: false, verbose: false, zero: false, help: false, version: false } });
  if (!operands.length) throw new UsageError("missing operand", true);
  const sep = opts.n || opts["no-newline"] ? (operands.length > 1 ? (opts.z || opts.zero ? "\0" : "\n") : "") : (opts.z || opts.zero ? "\0" : "\n");
  const diagnostics = readlinkDiagnosticMode(args);
  let status = 0;
  for (const file of operands) {
    let out;
    try {
      if (opts.f || opts.e || opts.m || opts.canonicalize || opts["canonicalize-existing"] || opts["canonicalize-missing"]) {
        out = await canonicalPath(file, opts);
      } else {
        out = await readlink(file);
      }
      stdout(out + sep);
    } catch (error) {
      if (diagnostics === "verbose") stderr(`readlink: ${readlinkQuotedName(file)}: ${readlinkErrorMessage(error)}\n`);
      status = 1;
    }
  }
  return status;
}

export function normalizeReadlinkLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, READLINK_LONG_OPTIONS);
}

export function normalizeReadlinkLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, READLINK_LONG_OPTIONS);
}

export function readlinkDiagnosticMode(args) {
  if (process.env.POSIXLY_CORRECT) return "verbose";
  let mode = "quiet";
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "-q" || arg === "-s" || arg === "--quiet" || arg === "--silent") mode = "quiet";
    else if (arg === "-v" || arg === "--verbose") mode = "verbose";
    else if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === "q" || ch === "s") mode = "quiet";
        else if (ch === "v") mode = "verbose";
      }
    }
  }
  return mode;
}

const singleCall = defineCommand("readlink", readlinkCmd, readlinkMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
