#!/usr/bin/env bun

import { readdir, rmdir } from "node:fs/promises";
import { dirname as pathDirname } from "node:path";
import { pathDisplayName, shellEscapeLsName, statSyncNoThrow } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { errnoMessage, lstatSyncNoThrow } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const RMDIR_LONG_OPTIONS = ["ignore-fail-on-non-empty", "parents", "path", "verbose", "version", "help"];

export function rmdirMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg === "-" || !arg.startsWith("-")) {
      if (process.env.POSIXLY_CORRECT) return null;
      continue;
    }
    if (arg.startsWith("--")) {
      const option = normalizeRmdirLongOption(arg);
      const name = option.slice(2).split("=", 1)[0];
      if (!RMDIR_LONG_OPTIONS.includes(name) || option.includes("=")) return null;
      if (option === "--help" || option === "--version") return option;
      continue;
    }
    for (const ch of arg.slice(1)) {
      if (ch !== "p" && ch !== "v") return null;
    }
  }
  return null;
}

export async function rmdirCmd(args) {
  const { opts, operands } = parseRmdirArgs(args);
  if (!operands.length) throw new UsageError("missing operand", true);
  let failed = false;
  for (const dir of operands) {
    if (!await rmdirPath(dir, opts)) failed = true;
  }
  return failed ? 1 : 0;
}

export function parseRmdirArgs(args) {
  const opts = {};
  const operands = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      if (process.env.POSIXLY_CORRECT) end = true;
      continue;
    }
    if (arg === "--") {
      end = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const option = normalizeRmdirLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!RMDIR_LONG_OPTIONS.includes(name)) throw new UsageError(`unrecognized option '${arg}'`, true);
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      opts[name] = true;
      continue;
    }
    for (const ch of arg.slice(1)) {
      if (ch === "p" || ch === "v") opts[ch] = true;
      else throw new UsageError(`invalid option -- '${ch}'`, true);
    }
  }
  return { opts, operands };
}

export function normalizeRmdirLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  let match = null;
  if (name === "p" || name === "pa" || name === "path") {
    match = "path";
  } else {
    const matches = RMDIR_LONG_OPTIONS.filter((option) => option.startsWith(name));
    if (matches.length === 0) return arg;
    if (matches.length > 1) {
      throw new UsageError(`option '--${name}${eq === -1 ? "" : `=${body.slice(eq + 1)}`}' is ambiguous; possibilities: ${matches.map((option) => `'--${option}'`).join(" ")}`, true);
    }
    match = matches[0];
  }
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

export async function rmdirPath(dir, opts) {
  const removeOne = async (path) => {
    try {
      await rmdir(path);
      if (opts.v || opts.verbose) stdout(`rmdir: removing directory, ${rmdirQuotedName(path)}\n`);
    } catch (error) {
      if (opts["ignore-fail-on-non-empty"] && (error.code === "ENOTEMPTY" || error.code === "EEXIST")) return false;
      if (opts["ignore-fail-on-non-empty"] && (error.code === "EACCES" || error.code === "EPERM") && await directoryHasEntries(path)) return false;
      stderr(rmdirErrorLine(path, error));
      return null;
    }
    return true;
  };
  if (!(opts.p || opts.parents || opts.path)) {
    return await removeOne(dir) !== null;
  }
  let current = dir;
  while (current && current !== "." && current !== "/") {
    const removed = await removeOne(current);
    if (removed === null) return false;
    if (!removed) break;
    const parent = pathDirname(current);
    if (parent === current) break;
    current = parent;
  }
  return true;
}

export async function directoryHasEntries(path) {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

export function rmdirErrorLine(path, error) {
  return `rmdir: failed to remove ${rmdirQuotedName(path)}: ${rmdirErrorMessage(path, error)}\n`;
}

export function rmdirQuotedName(path) {
  return shellEscapeLsName(pathDisplayName(path), true);
}

export function rmdirErrorMessage(path, error) {
  if (error?.code === "ENOTDIR" && path.endsWith("/")) {
    try {
      const bare = path.replace(/\/+$/, "");
      const s = lstatSyncNoThrow(bare);
      if (s?.isSymbolicLink()) {
        const target = statSyncNoThrow(bare);
        if (!target || target.isDirectory()) return "Symbolic link not followed";
      }
    } catch {}
  }
  return errnoMessage(error);
}

const singleCall = defineCommand("rmdir", rmdirCmd, rmdirMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
