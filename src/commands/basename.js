#!/usr/bin/env bun

import { bufferPathBasename, isBytePath, localeQuotedEscapedDiagnostic } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { rawOperandPlan } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const BASENAME_LONG_OPTIONS = ["multiple", "suffix", "zero", "help", "version"];

export function basenameMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg === "-" || !arg.startsWith("-")) return null;
    if (arg.startsWith("--")) {
      const option = normalizeBasenameLongOption(arg);
      const name = option.slice(2).split("=", 1)[0];
      if (!BASENAME_LONG_OPTIONS.includes(name)) return null;
      if (option.includes("=")) {
        if (name === "multiple" || name === "zero" || name === "help" || name === "version") return null;
        continue;
      }
      if (option === "--help" || option === "--version") return option;
      if (name === "suffix") i++;
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "a" || ch === "z") continue;
      if (ch !== "s") return null;
      if (!arg.slice(j + 1)) i++;
      break;
    }
  }
  return null;
}

export async function basename(args) {
  const { opts, operands } = parseBasenameOptions(args);
  if (!operands.length) throw new UsageError("missing operand", true);
  if (!(opts.a || opts.multiple || opts.s || opts.suffix) && operands.length > 2) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[2])}`, true);
  const rawOperands = rawOperandPlan("basename", args, operands, {
    valueOptions: ["--suffix"],
    shortValueOptions: ["s"],
  });
  const effectiveOperands = rawOperands ?? operands;
  const suffix = opts.s ?? opts.suffix ?? (!opts.a && !opts.multiple && operands[1] ? operands[1] : "");
  const names = opts.a || opts.multiple || opts.s || opts.suffix ? effectiveOperands : [effectiveOperands[0]];
  const sep = opts.z || opts.zero ? "\0" : "\n";
  const output = names.map((name) => {
    if (isBytePath(name)) {
      let base = gnuBasenameBytes(name);
      const suffixBytes = Buffer.from(suffix);
      if (suffixBytes.length && !base.equals(suffixBytes) && base.subarray(-suffixBytes.length).equals(suffixBytes)) base = base.subarray(0, base.length - suffixBytes.length);
      return base;
    }
    let base = gnuBasename(name);
    if (suffix && suffix !== base && base.endsWith(suffix)) base = base.slice(0, -suffix.length);
    return base;
  });
  stdout(output.some(isBytePath)
    ? Buffer.concat(output.flatMap((value) => [isBytePath(value) ? Buffer.from(value) : Buffer.from(value), Buffer.from(sep)]))
    : `${output.join(sep)}${sep}`);
  return 0;
}

export function gnuBasenameBytes(name) {
  const bytes = Buffer.from(name);
  if (bytes.length && bytes.every((byte) => byte === 0x2f)) return Buffer.from("/");
  return Buffer.from(bufferPathBasename(bytes));
}

export function parseBasenameOptions(args) {
  const opts = {};
  const operands = [];
  let parsing = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!parsing || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      parsing = false;
      continue;
    }
    if (arg === "--") {
      parsing = false;
      continue;
    }
    if (arg.startsWith("--")) {
      const option = normalizeBasenameLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (name === "multiple") {
        if (inlineValue !== undefined) throw new UsageError("option '--multiple' doesn't allow an argument", true);
        opts.multiple = true;
      }
      else if (name === "zero") {
        if (inlineValue !== undefined) throw new UsageError("option '--zero' doesn't allow an argument", true);
        opts.zero = true;
      }
      else if (name === "help" || name === "version") {
        if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
        opts[name] = true;
      }
      else if (name === "suffix") {
        if (inlineValue != null) opts.suffix = inlineValue;
        else if (i + 1 < args.length) opts.suffix = args[++i];
        else throw new UsageError("option '--suffix' requires an argument", true);
      }
      else throw new UsageError(`unrecognized option '--${name}'`, true);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "a") opts.a = true;
      else if (ch === "z") opts.z = true;
      else if (ch === "s") {
        if (arg.slice(j + 1)) opts.s = arg.slice(j + 1);
        else if (i + 1 < args.length) opts.s = args[++i];
        else throw new UsageError("option requires an argument -- 's'", true);
        break;
      } else {
        throw new UsageError(`invalid option -- '${ch}'`, true);
      }
    }
  }
  return { opts, operands };
}

export function normalizeBasenameLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = BASENAME_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

export function gnuBasename(name) {
  let text = String(name);
  if (/^\/+$/.test(text)) return "/";
  text = text.replace(/\/+$/g, "");
  const idx = text.lastIndexOf("/");
  return idx === -1 ? text : text.slice(idx + 1);
}

const singleCall = defineCommand("basename", basename, basenameMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
