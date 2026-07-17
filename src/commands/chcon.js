#!/usr/bin/env bun

import { access, lstat } from "node:fs/promises";
import { invalidOptionMessage, normalizeLongOptionByPrefix, parseOptions, pathLikeJoin, readdirPathEntries } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { selinuxSecurityContext, setSelinuxSecurityContext } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const CHCON_LONG_OPTIONS = ["dereference", "no-dereference", "no-preserve-root", "preserve-root", "recursive", "reference", "user", "role", "type", "range", "verbose", "help", "version"];

export function chconMetaOption(args) {
  const longValueOptions = new Set(["reference", "user", "role", "type", "range"]);
  const longFlagOptions = new Set(["dereference", "no-dereference", "no-preserve-root", "preserve-root", "recursive", "verbose"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeLongOptionByPrefix(arg, CHCON_LONG_OPTIONS);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      return normalized;
    }
    if (longFlagOptions.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      continue;
    }
    if (longValueOptions.has(name)) {
      if (inlineValue === undefined) i++;
      continue;
    }
    if (["-u", "-r", "-t", "-l"].includes(arg)) {
      i++;
      continue;
    }
    if (/^-[urtl].+/.test(arg)) continue;
    if (/^-[Rhv]+$/.test(arg)) continue;
    if (arg.startsWith("-")) throw new UsageError(invalidOptionMessage(arg), true);
    continue;
  }
  return null;
}

export async function chconCmd(args) {
  const { opts, operands } = parseOptions(normalizeChconArgs(args), {
    short: { R: false, h: false, u: "value", r: "value", t: "value", l: "value", v: false },
    long: { recursive: false, dereference: false, "no-dereference": false, "no-preserve-root": false, "preserve-root": false, reference: "value", user: "value", role: "value", type: "value", range: "value", verbose: false },
  });
  const reference = opts.reference;
  const componentChange = opts.u != null || opts.user != null || opts.r != null || opts.role != null || opts.t != null || opts.type != null || opts.l != null || opts.range != null;
  if (reference !== undefined && componentChange) throw new UsageError("conflicting security context specifiers given", true);
  let context = null;
  if (reference !== undefined) {
    if (!operands.length) throw new UsageError("missing operand", true);
    await access(reference);
    context = selinuxSecurityContext(reference, opts.h || opts["no-dereference"]);
    if (context == null) throw new UsageError(`failed to get security context of '${reference}'`);
    for (const file of operands) await chconAccessPath(file, opts, context);
    return 0;
  }
  const files = componentChange ? operands : operands.slice(1);
  if (files.length < 1) throw new UsageError("missing operand", true);
  if (!componentChange) context = operands[0];
  for (const file of files) await chconAccessPath(file, opts, context);
  return 0;
}

export function normalizeChconArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      out.push(...args.slice(i));
      break;
    }
    if (arg.startsWith("--")) {
      const normalized = normalizeLongOptionByPrefix(arg, CHCON_LONG_OPTIONS);
      out.push(normalized);
      if (["--reference", "--user", "--role", "--type", "--range"].includes(normalized) && i + 1 < args.length) out.push(args[++i]);
      continue;
    }
    out.push(arg);
    if (["-u", "-r", "-t", "-l"].includes(arg) && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

export async function chconAccessPath(path, opts, context = null) {
  const s = await lstat(path);
  if ((opts.R || opts.recursive) && s.isDirectory() && !s.isSymbolicLink()) {
    for (const entry of await readdirPathEntries(path)) await chconAccessPath(pathLikeJoin(path, entry), opts, context);
  }
  const noDereference = opts.h || opts["no-dereference"];
  const current = selinuxSecurityContext(path, noDereference);
  if (opts.v || opts.verbose) stdout(`changing security context of '${path}'\n`);
  if (context == null && current == null) throw new UsageError(`can't apply partial context to unlabeled file '${path}'`);
  const target = context ?? chconUpdatedContext(current, opts);
  if (target !== current) {
    if (!setSelinuxSecurityContext(path, target, noDereference)) throw new UsageError(`failed to change context of '${path}' to '${target}'`);
  }
}

export function chconUpdatedContext(current, opts) {
  const parts = String(current).split(":");
  if (parts.length < 3) return current;
  const range = parts.slice(3).join(":");
  const user = opts.u ?? opts.user ?? parts[0];
  const role = opts.r ?? opts.role ?? parts[1];
  const type = opts.t ?? opts.type ?? parts[2];
  const newRange = opts.l ?? opts.range ?? range;
  return [user, role, type, newRange].filter((part, index) => index < 3 || part !== "").join(":");
}

const singleCall = defineCommand("chcon", chconCmd, chconMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
