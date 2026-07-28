#!/usr/bin/env bun

import { lstat, open } from "node:fs/promises";
import { libc, pathDisplayName, shellEscapeLsName, systemErrorMessage } from "../shared/common.js";
import { UsageError, fail, stderr } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const SYNC_LONG_OPTIONS = ["data", "file-system", "help", "version"];

export function syncMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (!arg.startsWith("--")) continue;
    const option = normalizeSyncLongOption(arg);
    const name = option.slice(2).split("=", 1)[0];
    if (!SYNC_LONG_OPTIONS.includes(name) || option.includes("=")) return null;
    if (option === "--help" || option === "--version") return option;
  }
  return null;
}

export async function syncCmd(args) {
  const { opts, operands } = parseSyncArgs(args);
  const data = opts.d || opts.data;
  const fileSystem = opts.f || opts["file-system"];
  if (data && fileSystem) return fail("sync", "cannot specify both --data and --file-system", 1);
  if (data && !operands.length) return fail("sync", "--data needs at least one argument", 1);
  if (operands.length) {
    let status = 0;
    for (const file of operands) {
      const ok = await syncOneFile(file, data, fileSystem);
      if (!ok) status = 1;
    }
    return status;
  }
  libc.symbols.sync();
  return 0;
}

export function parseSyncArgs(args) {
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
      const normalized = normalizeSyncLongOption(arg);
      const [name, inlineValue] = normalized.slice(2).split(/=(.*)/s, 2);
      if (!SYNC_LONG_OPTIONS.includes(name)) throw new UsageError(`unrecognized option '${arg}'`, true);
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      opts[name] = true;
      continue;
    }
    for (const ch of arg.slice(1)) {
      if (ch === "d" || ch === "f") opts[ch] = true;
      else throw new UsageError(`invalid option -- '${ch}'`, true);
    }
  }
  return { opts, operands };
}

export function normalizeSyncLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = SYNC_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

export async function syncOneFile(file, data = false, fileSystem = false) {
  const name = shellEscapeLsName(pathDisplayName(file), true);
  const s = await lstat(file).catch((error) => error);
  if (s instanceof Error) {
    stderr(`sync: error opening ${name}: ${systemErrorMessage(s)}\n`);
    return false;
  }
  if (s.isFIFO()) return true;
  let handle;
  try {
    handle = await open(file, "r");
  } catch (readError) {
    if (s.isSymbolicLink() && readError?.code === "ENOENT") {
      stderr(`sync: error opening ${name}: ${systemErrorMessage(readError)}\n`);
      return false;
    }
    try {
      handle = await open(file, "a");
    } catch {
      stderr(`sync: error opening ${name}: ${systemErrorMessage(readError)}\n`);
      return false;
    }
  }
  try {
    if (data && !fileSystem) await handle.datasync();
    else await handle.sync();
    return true;
  } catch (error) {
    stderr(`sync: error syncing ${name}: ${systemErrorMessage(error)}\n`);
    return false;
  } finally {
    await handle.close();
  }
}

const singleCall = defineCommand("sync", syncCmd, syncMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
