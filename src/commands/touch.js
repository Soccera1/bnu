#!/usr/bin/env bun

import { fstatSync } from "node:fs";
import { futimes, lstat, stat, writeFile } from "node:fs/promises";
import { localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions, pathDisplayName, shellEscapeLsName, statAttachNanoseconds, touchStatDate } from "../shared/common.js";
import { UsageError, stderr } from "../shared/diagnostics.js";
import { TOUCH_NOW, TOUCH_OMIT, rawOperandPlan, touchSetPathTimes } from "../shared/filesystem.js";
import { parseDateInput, parseRelativeDateSpec } from "../shared/time.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const TOUCH_LONG_OPTIONS = ["date", "no-create", "no-dereference", "reference", "time", "help", "version"];

export function touchMetaOption(args) {
  const longValueOptions = new Set(["date", "reference", "time"]);
  const shortValueOptions = new Set(["d", "r", "t"]);
  const shortKnownOptions = new Set(["a", "c", "d", "f", "h", "m", "r", "t"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeTouchLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!TOUCH_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (name === "time" && inlineValue != null) normalizeTouchTime(inlineValue);
      if (inlineValue == null && longValueOptions.has(name)) i++;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        const value = inlineValue === "" ? args[i + 1] : inlineValue;
        if (ch === "t" && value !== undefined) parseTouchTimestamp(value);
        if (inlineValue === "") i++;
        break;
      }
    }
  }
  return null;
}

export async function touch(args) {
  args = normalizeTouchLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { a: false, c: false, d: "value", f: false, h: false, m: false, r: "value", t: "value" }, long: { "time": "value", "no-create": false, "no-dereference": false, date: "value", reference: "value", help: false, version: false } });
  const rawOperands = rawOperandPlan("touch", args, operands, {
    valueOptions: ["--time", "--date", "--reference", "--ref"],
    shortValueOptions: ["d", "r", "t"],
  });
  if (process.env.POSIXLY_CORRECT && opts.t == null && opts.d == null && opts.date == null && opts.r == null && opts.reference == null && operands.length > 1 && isValidTouchTimestamp(operands[0])) {
    opts.t = operands.shift();
    rawOperands?.shift();
  }
  const noDereference = opts.h || opts["no-dereference"];
  const timeMode = normalizeTouchTime(opts.time);
  if (opts.t != null) parseTouchTimestamp(opts.t);
  if (opts.t != null && (opts.d != null || opts.date != null || opts.r != null || opts.reference != null)) {
    throw new UsageError("cannot specify times from more than one source", true);
  }
  const sourceTimes = await touchTimes(opts, noDereference);
  if (!operands.length) throw new UsageError("missing file operand", true);
  const changeAccess = opts.a || !(opts.m || timeMode === "modify");
  const changeModify = opts.m || !(opts.a || timeMode === "access");
  const statFn = noDereference ? lstat : stat;
  let status = 0;
  for (let i = 0; i < operands.length; i++) {
    const file = rawOperands?.[i] ?? operands[i];
    try {
      if (file === "-") {
        const fd = noDereference ? 1 : 0;
        const s = fstatSync(fd);
        try {
          await futimes(fd, changeAccess ? sourceTimes.atime : s.atime, changeModify ? sourceTimes.mtime : s.mtime);
        } catch (error) {
          stderr(`touch: setting times of ${noDereference ? "standard output" : "standard input"}: ${touchErrorMessage(error)}\n`);
          status = 1;
        }
        continue;
      }
      const s = statAttachNanoseconds(await statFn(file), file, !noDereference);
      try {
        await touchSetPathTimes(file, changeAccess ? (sourceTimes.now ? TOUCH_NOW : sourceTimes.atime) : TOUCH_OMIT, changeModify ? (sourceTimes.now ? TOUCH_NOW : sourceTimes.mtime) : TOUCH_OMIT, noDereference);
      } catch (error) {
        stderr(`touch: setting times of ${touchDiagnosticName(file)}: ${touchErrorMessage(error)}\n`);
        status = 1;
      }
    } catch (error) {
      if (file === "-" && noDereference && (opts.c || opts["no-create"])) {
        continue;
      } else if (error.code === "ENOENT" && noDereference && !(opts.c || opts["no-create"])) {
        stderr(`touch: setting times of ${touchDiagnosticName(file)}: ${touchErrorMessage(error)}\n`);
        status = 1;
      } else if (touchShouldReportSettingTimeError(file, opts, error)) {
        stderr(`touch: setting times of ${touchDiagnosticName(file)}: ${touchErrorMessage(error)}\n`);
        status = 1;
      } else if (error.code === "ENOENT" && !(opts.c || opts["no-create"]) && !noDereference) {
        try {
          await writeFile(file, "");
          await touchSetPathTimes(file, sourceTimes.atime, sourceTimes.mtime, false);
        } catch (createError) {
          stderr(`touch: cannot touch ${touchDiagnosticName(file)}: ${touchErrorMessage(createError)}\n`);
          status = 1;
        }
      } else if (error.code === "ENOENT" && (opts.c || opts["no-create"])) {
        continue;
      } else {
        stderr(`touch: cannot touch ${touchDiagnosticName(file)}: ${touchErrorMessage(error)}\n`);
        status = 1;
      }
    }
  }
  return status;
}

export function touchShouldReportSettingTimeError(file, opts, error) {
  const noCreate = opts.c || opts["no-create"];
  const trailingSlash = hasTrailingNonRootSlash(file);
  if (error?.code === "ENOTDIR") return noCreate || trailingSlash;
  if (error?.code === "ENOENT") return trailingSlash && !noCreate;
  return false;
}

export function touchDiagnosticName(file) {
  return shellEscapeLsName(pathDisplayName(file), true);
}

export function hasTrailingNonRootSlash(file) {
  return String(file).endsWith("/") && String(file).replace(/\/+$/g, "") !== "";
}

export function normalizeTouchLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, TOUCH_LONG_OPTIONS);
}

export function normalizeTouchLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, TOUCH_LONG_OPTIONS);
}

export function normalizeTouchTime(value) {
  if (value == null) return null;
  if (value === "") throw new UsageError(`ambiguous argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic("--time")}\nValid arguments are:\n  - ${["atime", "access", "use"].map(localeQuotedDiagnostic).join(", ")}\n  - ${["mtime", "modify"].map(localeQuotedDiagnostic).join(", ")}`, true);
  const accessValues = ["atime", "access", "use"];
  const modifyValues = ["mtime", "modify"];
  if (accessValues.some((candidate) => candidate.startsWith(value))) return "access";
  if (modifyValues.some((candidate) => candidate.startsWith(value))) return "modify";
  throw new UsageError(`invalid argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic("--time")}\nValid arguments are:\n  - ${["atime", "access", "use"].map(localeQuotedDiagnostic).join(", ")}\n  - ${["mtime", "modify"].map(localeQuotedDiagnostic).join(", ")}`, true);
}

export async function touchTimes(opts, noDereference = false) {
  const dateSpec = opts.d ?? opts.date;
  if (opts.r != null || opts.reference != null) {
    const reference = opts.r ?? opts.reference;
    let baseStat;
    try {
      baseStat = statAttachNanoseconds(await (noDereference ? lstat : stat)(reference), reference, !noDereference);
    } catch (error) {
      throw new UsageError(`failed to get attributes of ${touchDiagnosticName(reference)}: ${touchErrorMessage(error)}`);
    }
    const base = touchStatDate(baseStat, "mtime");
    if (dateSpec == null) return { atime: touchStatDate(baseStat, "atime"), mtime: base };
    const date = parseTouchDateRelativeTo(dateSpec, base);
    return { atime: date, mtime: date };
  }
  if (dateSpec) {
    const date = parseDateInput(dateSpec);
    if (Number.isNaN(date.getTime())) throw new UsageError(`invalid date format ${localeQuotedEscapedDiagnostic(dateSpec)}`);
    return { atime: date, mtime: date, now: /^\s*now\s*$/i.test(dateSpec) };
  }
  if (opts.t) {
    const date = parseTouchTimestamp(opts.t);
    return { atime: date, mtime: date };
  }
  const now = new Date();
  return { atime: now, mtime: now, now: true };
}

export function parseTouchDateRelativeTo(spec, base) {
  const relative = parseRelativeDateSpec(spec, base);
  if (relative) return relative;
  const date = parseDateInput(spec);
  if (Number.isNaN(date.getTime())) throw new UsageError(`invalid date '${spec}'`);
  return date;
}

export function parseTouchTimestamp(value) {
  const match = String(value).match(/^(\d{8}|\d{10}|\d{12})(?:\.(\d{2}))?$/);
  if (!match) throw new UsageError(`invalid date format ${localeQuotedEscapedDiagnostic(value)}`);
  const digits = match[1];
  const currentYear = new Date().getFullYear();
  const year = digits.length === 8 ? currentYear : digits.length === 10 ? Number(digits.slice(0, 2)) + (Number(digits.slice(0, 2)) >= 69 ? 1900 : 2000) : Number(digits.slice(0, 4));
  const rest = digits.length === 8 ? digits : digits.length === 10 ? digits.slice(2) : digits.slice(4);
  const month = Number(rest.slice(0, 2));
  const day = Number(rest.slice(2, 4));
  const hour = Number(rest.slice(4, 6));
  const second = Number((match[2] ?? "0").padEnd(2, "0"));
  let minute = Number(rest.slice(6, 8));
  const leapSecond = second === 60;
  const date = new Date(year, month - 1, day, hour, minute, leapSecond ? 59 : second);
  if (leapSecond) date.setSeconds(date.getSeconds() + 1);
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute + (leapSecond ? 1 : 0)) {
    throw new UsageError(`invalid date format ${localeQuotedEscapedDiagnostic(value)}`);
  }
  return date;
}

export function isValidTouchTimestamp(value) {
  try {
    parseTouchTimestamp(value);
    return true;
  } catch {
    return false;
  }
}

export function touchErrorMessage(error) {
  if (error?.code === "ENOENT") return "No such file or directory";
  if (error?.code === "ENOTDIR") return "Not a directory";
  if (error?.code === "EISDIR") return "Is a directory";
  if (error?.code === "ELOOP") return "Too many levels of symbolic links";
  if (error?.code === "EACCES") return "Permission denied";
  if (error?.code === "EPERM") return "Operation not permitted";
  if (error?.code === "EROFS") return "Read-only file system";
  return error?.message || String(error);
}

const singleCall = defineCommand("touch", touch, touchMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
