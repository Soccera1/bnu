#!/usr/bin/env bun

import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { canonicalPath, readlinkErrorMessage, readlinkQuotedName } from "../shared/paths.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const REALPATH_LONG_OPTIONS = ["canonicalize", "canonicalize-existing", "canonicalize-missing", "logical", "physical", "quiet", "relative-to", "relative-base", "strip", "no-symlinks", "zero", "help", "version"];

export function realpathMetaOption(args) {
  const longValueOptions = new Set(["relative-to", "relative-base"]);
  const shortKnownOptions = new Set(["E", "e", "m", "L", "P", "q", "s", "z"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeRealpathLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!REALPATH_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (inlineValue == null && longValueOptions.has(name)) i++;
      else if (inlineValue != null && !longValueOptions.has(name)) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) if (!shortKnownOptions.has(arg[j])) return null;
  }
  return null;
}

export async function realpathCmd(args) {
  args = normalizeRealpathLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { E: false, e: false, m: false, L: false, P: false, q: false, s: false, z: false }, long: { canonicalize: false, "canonicalize-existing": false, "canonicalize-missing": false, logical: false, physical: false, quiet: false, strip: false, "no-symlinks": false, zero: false, "relative-to": "value", "relative-base": "value", help: false, version: false } });
  if (!operands.length) throw new UsageError("missing operand", true);
  if (opts["relative-to"] === "" || opts["relative-base"] === "") throw new UsageError("'': No such file or directory");
  if (opts.E) opts.e = opts["canonicalize-existing"] = false;
  if (opts.e || opts["canonicalize-existing"]) {
    await requireRealpathRelativeDirectory(opts["relative-to"]);
    await requireRealpathRelativeDirectory(opts["relative-base"]);
  }
  const sep = opts.z || opts.zero ? "\0" : "\n";
  let status = 0;
  for (const file of operands) {
    try {
      if (file === "") throw Object.assign(new Error("No such file or directory"), { code: "ENOENT" });
      stdout(formatRealpathOutput(await canonicalPath(file, opts), opts) + sep);
    } catch (error) {
      if (!(opts.q || opts.quiet)) stderr(`realpath: ${readlinkQuotedName(file)}: ${readlinkErrorMessage(error)}\n`);
      status = 1;
    }
  }
  return status;
}

export async function requireRealpathRelativeDirectory(path) {
  if (!path) return;
  const s = await stat(path).catch((error) => {
    throw new UsageError(`${readlinkQuotedName(path)}: ${readlinkErrorMessage(error)}`);
  });
  if (!s.isDirectory()) throw new UsageError(`${readlinkQuotedName(path)}: Not a directory`);
}

export function normalizeRealpathLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, REALPATH_LONG_OPTIONS);
}

export function normalizeRealpathLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, REALPATH_LONG_OPTIONS);
}

export function formatRealpathOutput(path, opts) {
  const relativeBase = opts["relative-base"];
  const relativeTo = opts["relative-to"] ?? (relativeBase != null ? relativeBase : null);
  if (relativeBase) {
    const base = resolve(relativeBase);
    const target = resolve(relativeTo);
    if (!pathIsUnder(target, base)) return path;
    if (pathIsUnder(path, base)) return relative(target, path) || ".";
    return path;
  }
  if (relativeTo) return relative(resolve(relativeTo), path) || ".";
  return path;
}

export function pathIsUnder(path, base) {
  const rel = relative(base, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const singleCall = defineCommand("realpath", realpathCmd, realpathMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
