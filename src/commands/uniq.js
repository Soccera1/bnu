#!/usr/bin/env bun

import { closeSync, openSync } from "node:fs";
import { createFdRecordReader, decodeSurrogateEscapedBytes, isWriteError, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, nodeErrorMessage, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions, pathDisplayName, readAll, shellEscapeLsName, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, encodeSurrogateEscapedString, stderr, stdout } from "../shared/diagnostics.js";
import { writeAll } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const UNIQ_LONG_OPTIONS = ["count", "repeated", "all-repeated", "skip-fields", "group", "ignore-case", "skip-chars", "unique", "zero-terminated", "check-chars", "help", "version"];

export function uniqMetaOption(args) {
  const longValueOptions = new Set(["skip-fields", "skip-chars", "check-chars"]);
  const longOptionalValueOptions = new Set(["all-repeated", "group"]);
  const shortValueOptions = new Set(["f", "s", "w"]);
  const shortKnownOptions = new Set(["c", "d", "D", "f", "i", "s", "u", "w", "z"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeUniqLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!UNIQ_LONG_OPTIONS.includes(name)) return null;
      if (name === "all-repeated" && inlineValue != null && !["none", "prepend", "separate"].includes(inlineValue)) return null;
      if (name === "group" && inlineValue != null && !["prepend", "append", "separate", "both"].includes(inlineValue)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (longValueOptions.has(name)) {
        const value = inlineValue ?? args[i + 1];
        if (value !== undefined) validateUniqMetaOptionValue(name, value);
        if (inlineValue == null) i++;
      }
      else if (inlineValue == null && longOptionalValueOptions.has(name)) continue;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    if (/^-\d+$/.test(arg) || /^\+\d+$/.test(arg)) continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        const value = inlineValue === "" ? args[i + 1] : inlineValue;
        if (value !== undefined) validateUniqMetaOptionValue(ch, value);
        if (inlineValue === "") i++;
        break;
      }
    }
  }
  return null;
}

export function validateUniqMetaOptionValue(option, value) {
  if (option === "skip-fields" || option === "f") validateUniqNumericOption(value, "fields to skip");
  else if (option === "skip-chars" || option === "s") validateUniqNumericOption(value, "bytes to skip");
  else if (option === "check-chars" || option === "w") validateUniqNumericOption(value, "bytes to compare");
}

export async function uniq(args) {
  args = normalizeUniqArgs(normalizeUniqLongOptions(args));
  const { opts, operands } = parseOptions(args, {
    short: { c: false, d: false, D: false, f: "value", i: false, s: "value", u: false, w: "value", z: false },
    long: { count: false, repeated: false, "all-repeated": "optional-value", "skip-fields": "value", group: "optional-value", "ignore-case": false, "skip-chars": "value", unique: false, "check-chars": "value", "zero-terminated": false, help: false, version: false },
  });
  const count = opts.c || opts.count;
  const repeated = opts.d || opts.repeated;
  const unique = opts.u || opts.unique;
  const allRepeated = opts.D || opts["all-repeated"];
  const group = opts.group;
  if (allRepeated && count) throw new UsageError("printing all duplicated lines and repeat counts is meaningless", true);
  if (opts["all-repeated"] != null && opts["all-repeated"] !== true) validateUniqMethod("all-repeated", opts["all-repeated"], ["none", "prepend", "separate"]);
  if (opts.group != null && opts.group !== true) validateUniqMethod("group", opts.group, ["prepend", "append", "separate", "both"]);
  if (group && (count || repeated || allRepeated || unique)) throw new UsageError("--group is mutually exclusive with -c/-d/-D/-u", true);
  validateUniqNumericOptions(opts);
  const inputFile = operands[0] ?? "-";
  const outputFile = operands[1];
  if (operands.length > 2) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[2])}`, true);
  if (!outputFile && canStreamUniqFile(opts)) return streamUniqFile(inputFile, opts);
  let inputBytes;
  try {
    inputBytes = await readAll(inputFile);
  } catch (error) {
    const inputName = textInputDiagnosticName(inputFile);
    const message = error?.code === "EISDIR" ? `error reading ${shellEscapeLsName(pathDisplayName(inputFile), true)}: ${systemErrorMessage(error)}` : `${inputName}: ${systemErrorMessage(error)}`;
    stderr(inputFile === "-" ? `uniq: ${nodeErrorMessage(error)}\n` : `uniq: ${message}\n`);
    return 1;
  }
  const text = decodeSurrogateEscapedBytes(inputBytes);
  const sep = opts.z || opts["zero-terminated"] ? "\0" : "\n";
  const lines = text.endsWith(sep) ? text.slice(0, -sep.length).split(sep) : text === "" ? [] : text.split(sep);
  if (repeated && unique) {
    if (outputFile) await writeAll(outputFile, "");
    return 0;
  }
  const rows = [];
  for (const line of lines) {
    const key = uniqKey(line, opts);
    const last = rows.at(-1);
    if (last?.key === key) {
      last.count++;
      last.lines.push(line);
    } else {
      rows.push({ key, line, lines: [line], count: 1 });
    }
  }
  const outLines = [];
  const allRepeatedMethod = opts["all-repeated"] === true || opts.D ? "none" : opts["all-repeated"];
  const groupMethod = opts.group === true ? "separate" : opts.group;
  for (const row of rows) {
    if (opts.group) {
      pushUniqGroup(outLines, row.lines, groupMethod, opts, row.count, ["separate", "prepend", "append", "both"]);
    } else if (allRepeated) {
      if (row.count > 1) pushUniqGroup(outLines, row.lines, allRepeatedMethod, opts, row.count, ["none", "prepend", "separate"]);
    } else if (repeated) {
      if (row.count > 1) outLines.push(formatUniqLine(row.line, row.count, opts));
    } else if (unique) {
      if (row.count === 1) outLines.push(formatUniqLine(row.line, row.count, opts));
    } else {
      outLines.push(formatUniqLine(row.line, row.count, opts));
    }
  }
  const out = outLines.length ? outLines.join(sep) + sep : "";
  if (outputFile) {
    try {
      await writeAll(outputFile, encodeSurrogateEscapedString(out));
    } catch (error) {
      stderr(`uniq: ${textInputDiagnosticName(outputFile)}: ${systemErrorMessage(error)}\n`);
      return 1;
    }
  } else {
    stdout(out);
  }
  return 0;
}

export function canStreamUniqFile(opts) {
  if (canStreamUniq(opts)) return true;
  const allRepeatedMethod = opts["all-repeated"] === true || opts.D ? "none" : opts["all-repeated"];
  return allRepeatedMethod === "none"
    && !(opts.c || opts.count || opts.d || opts.repeated || opts.u || opts.unique || opts.group);
}

export function streamUniqFile(file, opts) {
  const separator = opts.z || opts["zero-terminated"] ? 0 : 10;
  const sep = Uint8Array.of(separator);
  const allRepeated = Boolean(opts.D || opts["all-repeated"]);
  let fd;
  try {
    fd = file === "-" ? 0 : openSync(file, "r");
    const reader = createFdRecordReader(fd, separator);
    let current = null;
    let count = 0;
    while (true) {
      const record = reader.next();
      if (record == null) break;
      const line = decodeSurrogateEscapedBytes(record);
      const key = uniqKey(line, opts);
      if (current?.key === key) {
        count++;
        if (allRepeated) {
          if (count === 2) {
            stdout(current.record);
            stdout(sep);
          }
          stdout(record);
          stdout(sep);
        }
      } else {
        current = { key, record: Buffer.from(record) };
        count = 1;
        if (!allRepeated) {
          stdout(record);
          stdout(sep);
        }
      }
    }
    return 0;
  } catch (error) {
    if (isWriteError(error)) throw error;
    const message = error?.code === "EISDIR" ? `error reading ${shellEscapeLsName(pathDisplayName(file), true)}: ${systemErrorMessage(error)}` : `${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}`;
    stderr(file === "-" ? `uniq: ${nodeErrorMessage(error)}\n` : `uniq: ${message}\n`);
    return 1;
  } finally {
    if (fd != null && fd !== 0) closeSync(fd);
  }
}

export function canStreamUniq(opts) {
  return !(opts.c || opts.count || opts.d || opts.repeated || opts.u || opts.unique || opts.D || opts["all-repeated"] || opts.group);
}

export function normalizeUniqArgs(args) {
  const out = [];
  let scanning = true;
  let valueNext = false;
  for (const arg of args) {
    if (!scanning) {
      out.push(arg);
    } else if (valueNext) {
      out.push(arg);
      valueNext = false;
    } else if (arg === "-f" || arg === "--skip-fields" || arg === "-s" || arg === "--skip-chars" || arg === "-w" || arg === "--check-chars") {
      out.push(arg);
      valueNext = true;
    } else if (/^-\d+$/.test(arg)) {
      out.push("-f", arg.slice(1));
    } else if (/^\+\d+$/.test(arg)) {
      out.push("-s", arg.slice(1));
    } else {
      if (arg === "--") scanning = false;
      else if (!arg.startsWith("-")) scanning = false;
      out.push(arg);
    }
  }
  return out;
}

export function normalizeUniqLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, UNIQ_LONG_OPTIONS);
}

export function normalizeUniqLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, UNIQ_LONG_OPTIONS);
}

export function validateUniqNumericOptions(opts) {
  validateUniqNumericOption(opts.f ?? opts["skip-fields"], "fields to skip");
  validateUniqNumericOption(opts.s ?? opts["skip-chars"], "bytes to skip");
  validateUniqNumericOption(opts.w ?? opts["check-chars"], "bytes to compare");
}

export function validateUniqNumericOption(value, description) {
  if (value == null) return;
  if (/^\+?\d+$/.test(String(value))) return;
  throw new UsageError(`${value}: invalid number of ${description}`);
}

export function validateUniqMethod(option, method, allowed) {
  if (allowed.includes(method)) return;
  const kind = method === "" ? "ambiguous" : "invalid";
  throw new UsageError(`${kind} argument ${localeQuotedEscapedDiagnostic(method)} for ${localeQuotedDiagnostic(`--${option}`)}\nValid arguments are:\n${allowed.map((value) => `  - ${localeQuotedDiagnostic(value)}`).join("\n")}`, true);
}

export function pushUniqGroup(outLines, lines, method, opts, count, allowed) {
  if (!allowed.includes(method)) throw new UsageError(`invalid group method: ${method}`);
  if (method === "prepend" || (method === "both" && outLines.length === 0)) outLines.push("");
  else if (method === "separate" && outLines.length) outLines.push("");
  for (const line of lines) outLines.push(formatUniqLine(line, count, opts));
  if (method === "append" || method === "both") outLines.push("");
}

export function formatUniqLine(line, count, opts) {
  return `${opts.c || opts.count ? String(count).padStart(7) + " " : ""}${line}`;
}

export function uniqKey(line, opts) {
  let key = line;
  const skipFields = Number(opts.f ?? opts["skip-fields"] ?? 0);
  const skipChars = Number(opts.s ?? opts["skip-chars"] ?? 0);
  const width = opts.w ?? opts["check-chars"];
  if (!Number.isInteger(skipFields) || skipFields < 0) throw new UsageError(`invalid field skip: ${opts.f ?? opts["skip-fields"]}`);
  if (!Number.isInteger(skipChars) || skipChars < 0) throw new UsageError(`invalid character skip: ${opts.s ?? opts["skip-chars"]}`);
  let offset = 0;
  for (let field = 0; field < skipFields && offset < key.length; field++) {
    while (offset < key.length && /\s/u.test(key[offset])) offset++;
    while (offset < key.length && !/\s/u.test(key[offset])) offset++;
  }
  key = [...key.slice(offset)].slice(skipChars).join("");
  if (width !== undefined) {
    const max = Number(width);
    if (!Number.isInteger(max) || max < 0) throw new UsageError(`invalid compare width: ${width}`);
    key = [...key].slice(0, max).join("");
  }
  if (opts.i || opts["ignore-case"]) key = key.toLowerCase();
  return key;
}

const singleCall = defineCommand("uniq", uniq, uniqMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
