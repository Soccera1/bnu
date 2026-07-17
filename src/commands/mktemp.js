#!/usr/bin/env bun

import { mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, join, basename as pathBasename, dirname as pathDirname } from "node:path";
import { isWriteError, localeQuotedEscapedDiagnostic, parseOptions, systemErrorMessage } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const MKTEMP_LONG_OPTIONS = ["directory", "dry-run", "quiet", "suffix", "tmpdir", "help", "version"];

export function mktempMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (!arg.startsWith("-") || arg === "-") {
      if (process.env.POSIXLY_CORRECT) return null;
      continue;
    }
    if (arg.startsWith("--")) {
      const option = normalizeMktempLongOption(arg);
      const name = option.slice(2).split("=", 1)[0];
      if (!MKTEMP_LONG_OPTIONS.includes(name)) return null;
      if (option.includes("=")) {
        if (name === "directory" || name === "dry-run" || name === "quiet" || name === "help" || name === "version") return null;
        continue;
      }
      if (option === "--help" || option === "--version") return option;
      if (name === "suffix") i++;
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "d" || ch === "q" || ch === "t" || ch === "u") continue;
      if (ch !== "p") return null;
      if (!arg.slice(j + 1)) i++;
      break;
    }
  }
  return null;
}

export async function mktempCmd(args) {
  if (process.env.POSIXLY_CORRECT && args.findIndex((arg) => arg !== "--" && !arg.startsWith("-")) !== -1) {
    const firstOperand = args.findIndex((arg) => arg !== "--" && !arg.startsWith("-"));
    if (args.slice(firstOperand + 1).some((arg) => arg.startsWith("-"))) throw new UsageError("too many templates", true);
  }
  args = normalizeMktempLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { d: false, p: "value", q: false, t: false, u: false }, long: { directory: false, quiet: false, tmpdir: "optional-value", suffix: "value", "dry-run": false, help: false, version: false } });
  if (operands.length > 1) throw new UsageError("too many templates", true);
  const template = operands[0] ?? "tmp.XXXXXXXXXX";
  const useTmpdir = opts.t || opts.tmpdir !== undefined || opts.p !== undefined || !operands.length;
  const envTmpdir = process.env.TMPDIR || null;
  const defaultTmpdir = envTmpdir ?? "/tmp";
  const optionTmpdir = opts.tmpdir === true || opts.tmpdir === "" ? defaultTmpdir : opts.tmpdir ?? (opts.p === "" ? defaultTmpdir : opts.p);
  const tmpdir = opts.t ? (envTmpdir ?? optionTmpdir ?? defaultTmpdir) : optionTmpdir;
  if (opts.t && template.includes("/")) throw new UsageError(`invalid template, ${localeQuotedEscapedDiagnostic(template)}, contains directory separator`);
  if (useTmpdir && isAbsolute(template)) throw new UsageError(`invalid template, ${localeQuotedEscapedDiagnostic(template)}; with --tmpdir, it may not be absolute`);
  const dir = useTmpdir ? tmpdir ?? defaultTmpdir : template.includes("/") ? pathDirname(template) : "";
  const name = template.includes("/") ? pathBasename(template) : template;
  if (opts.suffix !== undefined && !name.endsWith("X")) throw new UsageError(`with --suffix, template ${localeQuotedEscapedDiagnostic(template)} must end in X`);
  const wholeXMatch = [...template.matchAll(/X{3,}/g)].at(-1);
  if (opts.suffix === undefined && wholeXMatch) {
    const implicitSuffix = template.slice(wholeXMatch.index + wholeXMatch[0].length);
    const slash = implicitSuffix.indexOf("/");
    if (slash !== -1 && !implicitSuffix.slice(slash + 1).includes("X")) {
      throw new UsageError(`invalid suffix ${localeQuotedEscapedDiagnostic(implicitSuffix)}, contains directory separator`);
    }
  }
  const xMatch = [...name.matchAll(/X{3,}/g)].at(-1);
  const x = xMatch?.[0];
  if (!x || x.length < 3) throw new UsageError(`too few X's in template ${localeQuotedEscapedDiagnostic(template)}`);
  if (opts.suffix === undefined && wholeXMatch && template.slice(wholeXMatch.index + wholeXMatch[0].length).includes("/")) {
    throw new UsageError(`invalid suffix ${localeQuotedEscapedDiagnostic(template.slice(wholeXMatch.index + wholeXMatch[0].length))}, contains directory separator`);
  }
  const suffix = opts.suffix ?? name.slice(xMatch.index + x.length);
  if (suffix.includes("/")) throw new UsageError(`invalid suffix ${localeQuotedEscapedDiagnostic(suffix)}, contains directory separator`);
  const templateDir = template.includes("/") && useTmpdir ? pathDirname(template) : "";
  const parent = mktempJoin(dir, templateDir);
  const namePrefix = name.slice(0, xMatch.index);
  const prefix = mktempPrefix(parent, namePrefix);
  const displayTemplate = `${prefix}${x}${suffix}`;
  const candidateName = () => `${prefix}${mktempRandom(x.length)}${suffix}`;
  if (opts.u || opts["dry-run"]) {
    stdout(`${candidateName()}\n`);
    return 0;
  }
  for (let i = 0; i < 100; i++) {
    const candidate = candidateName();
    try {
      if (opts.d || opts.directory) await mkdir(candidate, { mode: 0o700 });
      else {
        const fh = await open(candidate, "wx", 0o600);
        await fh.close();
      }
      try {
        stdout(`${candidate}\n`);
      } catch (error) {
        if (isWriteError(error)) await rm(candidate, { recursive: true, force: true });
        throw error;
      }
      return 0;
    } catch (error) {
      if (error.code === "ENOENT") {
        if (opts.q || opts.quiet) return 1;
        throw new UsageError(`failed to create file via template ${localeQuotedEscapedDiagnostic(displayTemplate)}: ${systemErrorMessage(error)}`);
      }
      if (error.code !== "EEXIST") {
        if (opts.q || opts.quiet) return 1;
        throw new UsageError(`failed to create file via template ${localeQuotedEscapedDiagnostic(displayTemplate)}: ${systemErrorMessage(error)}`);
      }
    }
  }
  if (opts.q || opts.quiet) return 1;
  throw new UsageError(`failed to create file via template ${localeQuotedEscapedDiagnostic(displayTemplate)}`);
}

export function normalizeMktempLongOptions(args) {
  const out = [];
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    const option = normalizeMktempLongOption(arg);
    out.push(option);
    if (option === "--suffix" && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

export function normalizeMktempLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const matches = MKTEMP_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length === 0) return arg;
  if (matches.length > 1) {
    throw new UsageError(`option '--${name}${eq === -1 ? "" : `=${body.slice(eq + 1)}`}' is ambiguous; possibilities: ${matches.map((option) => `'--${option}'`).join(" ")}`, true);
  }
  return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
}

export function mktempJoin(...parts) {
  const filtered = parts.filter((part) => part !== "");
  if (filtered.length === 0) return "";
  if (filtered[0] === "." && filtered.length > 1) return `./${join(...filtered.slice(1))}`;
  if (filtered[0].startsWith("./") && filtered.length > 1) return `${filtered[0]}/${join(...filtered.slice(1))}`;
  return join(...filtered);
}

export function mktempPrefix(parent, namePrefix) {
  if (!parent) return namePrefix;
  if (namePrefix) return mktempJoin(parent, namePrefix);
  return parent.endsWith("/") ? parent : `${parent}/`;
}

export function mktempRandom(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

const singleCall = defineCommand("mktemp", mktempCmd, mktempMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
