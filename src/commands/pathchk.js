#!/usr/bin/env bun

import { lstat } from "node:fs/promises";
import { localeQuotedDiagnostic, lsEscapedName, shellEscapeLsName } from "../shared/common.js";
import { UsageError, stderr } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const PATHCHK_LONG_OPTIONS = ["portability", "help", "version"];

export function pathchkMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg === "-" || !arg.startsWith("-")) return null;
    if (!arg.startsWith("--")) {
      for (const ch of arg.slice(1)) {
        if (ch !== "p" && ch !== "P") return null;
      }
      continue;
    }
    const option = normalizePathchkLongOption(arg);
    const name = option.slice(2).split("=", 1)[0];
    if (!PATHCHK_LONG_OPTIONS.includes(name) || option.includes("=")) return null;
    if (option === "--help" || option === "--version") return option;
  }
  return null;
}

export async function pathchk(args) {
  const { opts, operands } = parsePathchkOptions(args);
  if (!operands.length) throw new UsageError("missing operand", true);
  let code = 0;
  const portable = opts.p || opts.portability;
  const checkEmptyOrLeadingDash = opts.P || opts.portability;
  for (const path of operands) {
    if (path === "") {
      stderr(`pathchk: ${portable || checkEmptyOrLeadingDash ? "empty file name" : "'': No such file or directory"}\n`);
      code = 1;
      continue;
    }
    if (portable && path.length > 255) {
      stderr(`pathchk: limit 255 exceeded by length ${path.length} of file name '${path}'\n`);
      code = 1;
      continue;
    }
    let componentError = false;
    for (const component of path.split("/")) {
      if (component === "") {
        continue;
      }
      if (component.length > (portable ? 14 : 255)) {
        stderr(portable
          ? `pathchk: limit 14 exceeded by length ${component.length} of file name component ${localeQuotedDiagnostic(component)}\n`
          : `pathchk: ${path}: File name too long\n`);
        code = 1;
        componentError = true;
        break;
      }
      if (checkEmptyOrLeadingDash && component.startsWith("-")) {
        stderr(`pathchk: leading '-' in a component of file name '${path}'\n`);
        code = 1;
        componentError = true;
        break;
      }
      const nonPortable = portable ? component.match(/[^A-Za-z0-9._-]/)?.[0] : null;
      if (nonPortable != null) {
        stderr(`pathchk: non-portable character ${localeQuotedDiagnostic(pathchkDiagnosticCharacter(nonPortable))} in file name ${pathchkDiagnosticName(path)}\n`);
        code = 1;
        componentError = true;
        break;
      }
    }
    if (componentError) continue;
    if (!portable) {
      const prefixError = await pathchkExistingPrefixError(path);
      if (prefixError) {
        stderr(`pathchk: ${path}: ${prefixError}\n`);
        code = 1;
        continue;
      }
    }
  }
  return code;
}

export function pathchkDiagnosticCharacter(ch) {
  return lsEscapedName(ch);
}

export function pathchkDiagnosticName(path) {
  return shellEscapeLsName(path, true);
}

export function parsePathchkOptions(args) {
  const opts = {};
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      operands.push(...args.slice(i));
      break;
    }
    if (arg.startsWith("--")) {
      const normalized = normalizePathchkLongOption(arg);
      const body = normalized.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      if (!PATHCHK_LONG_OPTIONS.includes(name)) throw new UsageError(`unrecognized option '${arg}'`, true);
      if (eq !== -1) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      opts[name] = true;
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "p" || ch === "P") opts[ch] = true;
      else throw new UsageError(`invalid option -- '${ch}'`, true);
    }
  }
  return { opts, operands };
}

export function normalizePathchkLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = PATHCHK_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

export async function pathchkExistingPrefixError(path) {
  const parts = path.split("/");
  let prefix = path.startsWith("/") ? "/" : "";
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === "") continue;
    prefix = prefix === "" || prefix === "/" ? `${prefix}${part}` : `${prefix}/${part}`;
    try {
      const s = await lstat(prefix);
      if (!s.isDirectory()) return "Not a directory";
    } catch (error) {
      if (error.code === "ENOENT") return null;
      return error.message || String(error);
    }
  }
  return null;
}

const singleCall = defineCommand("pathchk", pathchk, pathchkMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
