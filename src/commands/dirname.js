#!/usr/bin/env bun

import { isBytePath } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { rawOperandPlan } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const DIRNAME_LONG_OPTIONS = ["zero", "help", "version"];

export function dirnameMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (!arg.startsWith("-") || arg === "-") {
      if (process.env.POSIXLY_CORRECT) return null;
      continue;
    }
    if (!arg.startsWith("--")) {
      for (const ch of arg.slice(1)) {
        if (ch !== "z") return null;
      }
      continue;
    }
    const option = normalizeDirnameLongOption(arg);
    const name = option.slice(2).split("=", 1)[0];
    if (!DIRNAME_LONG_OPTIONS.includes(name) || option.includes("=")) return null;
    if (option === "--help" || option === "--version") return option;
  }
  return null;
}

export async function dirname(args) {
  const { opts, operands } = parseDirnameOptions(args);
  if (!operands.length) throw new UsageError("missing operand", true);
  const sep = opts.z || opts.zero ? "\0" : "\n";
  const rawOperands = rawOperandPlan("dirname", args, operands);
  const output = (rawOperands ?? operands).map((name) => isBytePath(name) ? gnuDirnameBytes(name) : gnuDirname(name));
  stdout(output.some(isBytePath)
    ? Buffer.concat(output.flatMap((value) => [isBytePath(value) ? Buffer.from(value) : Buffer.from(value), Buffer.from(sep)]))
    : `${output.join(sep)}${sep}`);
  return 0;
}

export function gnuDirnameBytes(name) {
  const bytes = Buffer.from(name);
  if (!bytes.length) return Buffer.from(".");
  if (bytes.every((byte) => byte === 0x2f)) return Buffer.from("/");
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x2f) end--;
  const slash = bytes.lastIndexOf(0x2f, end - 1);
  if (slash === -1) return Buffer.from(".");
  let dirEnd = slash;
  while (dirEnd > 0 && bytes[dirEnd - 1] === 0x2f) dirEnd--;
  return dirEnd === 0 ? Buffer.from("/") : bytes.subarray(0, dirEnd);
}

export function parseDirnameOptions(args) {
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
      const option = normalizeDirnameLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!DIRNAME_LONG_OPTIONS.includes(name)) throw new UsageError(`unrecognized option '${arg}'`, true);
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      opts[name] = true;
      continue;
    }
    for (const ch of arg.slice(1)) {
      if (ch === "z") opts.z = true;
      else throw new UsageError(`invalid option -- '${ch}'`, true);
    }
  }
  return { opts, operands };
}

export function normalizeDirnameLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = DIRNAME_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

export function gnuDirname(name) {
  let text = String(name);
  if (text === "") return ".";
  if (/^\/+$/.test(text)) return "/";
  text = text.replace(/\/+$/g, "");
  const idx = text.lastIndexOf("/");
  if (idx === -1) return ".";
  let dir = text.slice(0, idx);
  if (dir === "") return "/";
  if (/^\/+$/.test(dir)) return "/";
  return dir.replace(/\/+$/g, "");
}

const singleCall = defineCommand("dirname", dirname, dirnameMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
