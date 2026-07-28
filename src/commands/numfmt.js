#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { decodeSurrogateEscapedBytes, enc, gb18030Units, inRanges, isGb18030Locale, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, lsEscapedName, normalizeLongOptionByPrefix, parseOptions, readAll, readStdinByteRecords, systemErrorMessage } from "../shared/common.js";
import { InvocationError, UsageError, fail, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const NUMFMT_LONG_OPTIONS = ["debug", "delimiter", "from", "from-unit", "field", "format", "grouping", "header", "invalid", "padding", "round", "suffix", "to", "to-unit", "unit-separator", "zero-terminated", "help", "version"];

export function numfmtMetaOption(args) {
  const longValueOptions = new Set(["delimiter", "from", "from-unit", "field", "format", "invalid", "padding", "round", "suffix", "to", "to-unit", "unit-separator"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeNumfmtLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!NUMFMT_LONG_OPTIONS.includes(name) && name !== "devdebug") return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      const value = inlineValue ?? (longValueOptions.has(name) ? args[i + 1] : undefined);
      if (value !== undefined) validateNumfmtMetaOptionValue(name, value);
      if (inlineValue == null && longValueOptions.has(name)) i++;
      else if (inlineValue != null && !longValueOptions.has(name)) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!["d", "z"].includes(ch)) return null;
      if (ch === "d") {
        const inlineValue = arg.slice(j + 1);
        validateNumfmtMetaOptionValue("delimiter", inlineValue === "" ? args[i + 1] : inlineValue);
        if (inlineValue === "") i++;
        break;
      }
    }
  }
  return null;
}

export function parseHumanNumberParts(value, mode = "auto", suffix = "", unitSeparator = "") {
  let text = String(value);
  if (suffix && text.endsWith(suffix)) text = text.slice(0, -suffix.length);
  text = text.trimEnd();
  if (unitSeparator) {
    const unitMatch = text.match(/([kKMGTPEZYRQ]i?B?)$/);
    if (unitMatch) {
      const beforeUnit = text.slice(0, -unitMatch[1].length);
      if (beforeUnit.endsWith(unitSeparator) && !beforeUnit.slice(0, -unitSeparator.length).endsWith(unitSeparator)) text = beforeUnit.slice(0, -unitSeparator.length) + unitMatch[1];
    }
  }
  const match = text.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))([kKMGTPEZYRQ]?)(i?B?)$/);
  if (!match) throw new UsageError(numfmtNumberError(text, { fromMode: mode }));
  if (mode === "iec-i" && match[2] && !match[3].startsWith("i")) throw new UsageError(`missing 'i' suffix in input: ${localeQuotedDiagnostic(text)} (e.g Ki/Mi/Gi)`);
  if (match[3] && !match[2]) throw new UsageError(numfmtNumberError(text, { fromMode: mode }));
  if (match[3].includes("B")) throw new UsageError(`invalid suffix in input ${localeQuotedDiagnostic(numfmtDiagnosticValue(text))}: ${localeQuotedDiagnostic(numfmtDiagnosticValue(numfmtInvalidHumanSuffixPart(match[3], mode)))}`);
  if ((mode === "si" || mode === "iec") && match[3].startsWith("i")) throw new UsageError(`invalid suffix in input ${localeQuotedDiagnostic(numfmtDiagnosticValue(text))}: ${localeQuotedDiagnostic(numfmtDiagnosticValue(match[3]))}`);
  if (mode === "si" && match[2] && !["K", "k"].includes(match[2]) && match[2] !== match[2].toUpperCase()) throw new UsageError(numfmtNumberError(text, { fromMode: mode }));
  const base = mode === "iec" || mode === "iec-i" || match[3]?.toLowerCase().startsWith("i") ? 1024 : 1000;
  const exp = match[2] ? "KMGTPEZYRQ".indexOf(match[2].toUpperCase()) + 1 : 0;
  const decimals = match[1].includes(".") ? match[1].split(".")[1].length : 0;
  return { value: Number(match[1]) * (exp ? base ** exp : 1), decimals: exp ? 0 : decimals };
}

export function numfmtInvalidHumanSuffixPart(suffix, mode) {
  if (suffix === "iB" && (mode === "auto" || mode === "iec-i")) return "B";
  return suffix;
}

export async function numfmtCmd(args) {
  args = normalizeNumfmtArgs(args);
  if (countNumfmtFieldOptions(args) > 1) throw new UsageError("multiple field specifications");
  const parsedOptions = parseOptions(args, {
    short: { d: "value", z: false },
    long: {
      from: "value", to: "value", field: "value", header: "optional-value", invalid: "value", padding: "value", suffix: "value", delimiter: "value", "zero-terminated": false,
      "from-unit": "value", "to-unit": "value", round: "value", grouping: false, format: "value", "unit-separator": "value", "unit-sep": "value", debug: false, devdebug: false, help: false, version: false,
    },
  });
  const { opts, operands } = parsedOptions;
  validateNumfmtOptions(opts);
  if (operands.length) {
    if (opts.header != null && opts.debug) stderr("numfmt: --header ignored with command-line input\n");
    const rawResult = formatRawNumfmtOperands(opts, operands);
    if (rawResult != null) return rawResult;
    const sep = opts.z || opts["zero-terminated"] ? "\0" : "\n";
    const result = formatNumfmtRecords(numfmtCommandLineRecords(opts, operands), opts, sep, true);
    stdout(result.text + (result.error ? "" : sep));
    if (result.error) throw new InvocationError(result.error, 2, false);
    return result.status;
  }
  const sep = opts.z || opts["zero-terminated"] ? "\0" : "\n";
  if (opts.header == null) {
    let status = 0;
    let abortError = null;
    try {
      readStdinByteRecords(sep === "\0" ? 0 : 10, (bytes, hasSep) => {
        if (abortError) return;
        const record = decodeSurrogateEscapedBytes(bytes);
        const result = formatNumfmtRecords([record], opts, sep, true);
        stdout(result.text + (hasSep && !result.error ? sep : ""));
        if (result.error) abortError = result.error;
        status = Math.max(status, result.status);
      });
    } catch (error) {
      return fail("numfmt", `error reading input: ${systemErrorMessage(error)}`);
    }
    if (abortError) throw new InvocationError(abortError, 2, false);
    return status;
  }
  let input;
  try {
    input = decodeSurrogateEscapedBytes(await readAll("-"));
  } catch (error) {
    return fail("numfmt", `error reading input: ${systemErrorMessage(error)}`);
  }
  const terminated = input.endsWith(sep);
  const records = terminated ? input.slice(0, -sep.length).split(sep) : input === "" ? [] : input.split(sep);
  const header = opts.header === true ? 1 : Number(opts.header ?? 0);
  const result = formatNumfmtRecords(records, opts, sep, terminated, header);
  stdout(result.text + (records.length && terminated && !result.error ? sep : ""));
  if (result.error) throw new InvocationError(result.error, 2, false);
  return result.status;
}

export function numfmtCommandLineRecords(opts, operands) {
  if ((opts.d ?? opts.delimiter) != null) return operands;
  return operands.map((operand) => String(operand).replace(/[\t\n\r\f\v]+/g, " "));
}

export function formatRawNumfmtOperands(opts, operands) {
  const delimiter = opts.d ?? opts.delimiter;
  if (delimiter == null || delimiter === "" || isAsciiString(delimiter)) return null;
  const raw = rawNumfmtArgsFromProc();
  if (!raw) return null;
  const parsed = parseRawNumfmtArgs(raw);
  if (!parsed?.delimiter || parsed.operands.length !== operands.length) return null;
  const sep = opts.z || opts["zero-terminated"] ? Uint8Array.of(0) : Uint8Array.of(10);
  const output = [];
  let status = 0;
  let abortError = null;
  for (const record of parsed.operands) {
    const result = formatRawNumfmtRecord(record, parsed.delimiter, opts);
    output.push(result.bytes);
    if (!result.ok) {
      const invalid = opts.invalid ?? "abort";
      if (invalid === "fail" || invalid === "warn") {
        status = invalid === "warn" ? 0 : 2;
        stderr(`numfmt: ${result.error}\n`);
      } else if (invalid === "abort") {
        abortError = result.error;
        break;
      }
    }
  }
  stdout(joinBytesWithSeparator(output, sep, abortError == null ? sep : null));
  if (abortError) throw new InvocationError(abortError, 2, false);
  return status;
}

export function isAsciiString(value) {
  return /^[\x00-\x7f]*$/.test(String(value));
}

export function rawNumfmtArgsFromProc() {
  try {
    const parts = splitBytesOnByte(readFileSync("/proc/self/cmdline"), 0);
    if (parts.at(-1)?.length === 0) parts.pop();
    let commandIndex = -1;
    for (let i = 0; i < parts.length; i++) {
      if (new TextDecoder().decode(parts[i]) === "numfmt") commandIndex = i;
    }
    return commandIndex === -1 ? null : parts.slice(commandIndex + 1);
  } catch {
    return null;
  }
}

export function parseRawNumfmtArgs(args) {
  const operands = [];
  let delimiter = null;
  const valueOptions = new Set(["--debug", "--delimiter", "--field", "--format", "--from", "--from-unit", "--header", "--invalid", "--padding", "--round", "--suffix", "--to", "--to-unit", "--unit-separator", "--unit-sep"]);
  for (let i = 0; i < args.length; i++) {
    const text = new TextDecoder().decode(args[i]);
    if (text === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (text === "-d" || text === "--delimiter") {
      delimiter = args[++i];
      continue;
    }
    if (text.startsWith("-d") && text.length > 2) {
      delimiter = args[i].slice(2);
      continue;
    }
    if (text.startsWith("--delimiter=")) {
      delimiter = args[i].slice("--delimiter=".length);
      continue;
    }
    if (text.startsWith("--") && text.includes("=")) continue;
    if (valueOptions.has(text)) {
      i++;
      continue;
    }
    if (text.startsWith("-") && text !== "-") continue;
    operands.push(args[i]);
  }
  return { delimiter, operands };
}

export function formatRawNumfmtRecord(record, delimiter, opts) {
  const fields = splitBytesByNeedle(record, delimiter);
  const selected = readNumfmtFieldRanges(opts.field ?? "1");
  const outputFields = [];
  let ok = true;
  let error;
  for (let i = 0; i < fields.length; i++) {
    if (!inRanges(i + 1, selected)) {
      outputFields.push(fields[i]);
      continue;
    }
    const text = new TextDecoder().decode(fields[i]);
    const result = formatNumfmtValue(text, opts);
    ok &&= result.ok;
    if (!result.ok && error == null) error = result.error;
    outputFields.push(result.ok ? enc.encode(result.text) : fields[i]);
    if (!result.ok && (opts.invalid ?? "abort") === "abort") break;
  }
  return { ok, error, bytes: joinBytesWithSeparator(outputFields, delimiter) };
}

export function splitBytesOnByte(bytes, delimiter) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== delimiter) continue;
    parts.push(bytes.slice(start, i));
    start = i + 1;
  }
  parts.push(bytes.slice(start));
  return parts;
}

export function splitBytesByNeedle(bytes, needle) {
  if (!needle.length) return [bytes];
  const parts = [];
  let start = 0;
  for (let i = 0; i <= bytes.length - needle.length; i++) {
    let matches = true;
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    parts.push(bytes.slice(start, i));
    i += needle.length - 1;
    start = i + 1;
  }
  parts.push(bytes.slice(start));
  return parts;
}

export function joinBytesWithSeparator(parts, separator, trailing = null) {
  const extra = trailing?.length ?? 0;
  const total = parts.reduce((sum, part) => sum + part.length, 0) + separator.length * Math.max(0, parts.length - 1) + extra;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      out.set(separator, offset);
      offset += separator.length;
    }
    out.set(parts[i], offset);
    offset += parts[i].length;
  }
  if (trailing) out.set(trailing, offset);
  return out;
}

export function formatNumfmtRecords(records, opts, sep, terminated, header = 0) {
  let status = 0;
  let abortError = null;
  const out = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (index < header) {
      out.push(record);
      continue;
    }
    const result = formatNumfmtRecord(record, opts);
    const invalid = opts.invalid ?? "abort";
    if (!result.ok && (invalid === "fail" || invalid === "warn")) {
      status = 2;
      stderr(`numfmt: ${result.error}\n`);
    }
    if (!result.ok && invalid === "abort") {
      abortError = result.error;
      out.push(result.text);
      break;
    }
    out.push(result.text);
  }
  const text = out.join(sep);
  if (status && opts.invalid === "fail" && opts.debug) stderr("numfmt: failed to convert some of the input numbers\n");
  if (opts.invalid === "warn") status = 0;
  return { status, text, error: abortError };
}

export function countNumfmtFieldOptions(args) {
  let count = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "--field") {
      count++;
      i++;
    } else if (arg.startsWith("--field=")) {
      count++;
    }
  }
  return count;
}

export function normalizeNumfmtArgs(args) {
  return args.map((arg) => arg === "---debug" || arg === "--devdebug" ? "--devdebug" : normalizeNumfmtLongOption(arg));
}

export function normalizeNumfmtLongOption(arg) {
  if (!arg.startsWith("--") || arg === "--") return arg;
  return normalizeLongOptionByPrefix(arg, NUMFMT_LONG_OPTIONS);
}

export function validateNumfmtOptions(opts) {
  opts.from = parseNumfmtEnumOption(opts.from, "--from", ["none", "auto", "si", "iec", "iec-i"]);
  opts.to = parseNumfmtEnumOption(opts.to, "--to", ["none", "si", "iec", "iec-i"]);
  if (opts.grouping && opts.to) throw new UsageError("grouping cannot be combined with --to");
  const format = opts.format == null ? null : parseNumfmtFormat(opts.format);
  if ((opts.grouping || format?.grouping) && opts.to) throw new UsageError("grouping cannot be combined with --to");
  if (opts.grouping && opts.format) throw new UsageError("--grouping cannot be combined with --format");
  if (opts.grouping && opts.debug) stderr("numfmt: grouping has no effect in this locale\n");
  if (format?.grouping && opts.debug) stderr("numfmt: grouping has no effect in this locale\n");
  if (opts.debug && !opts.from && !opts.to && !opts["from-unit"] && !opts["to-unit"] && !opts.format && !opts.padding && !opts.suffix && !opts.header) stderr("numfmt: no conversion option specified\n");
  opts.invalid = parseNumfmtEnumOption(opts.invalid, "--invalid", ["abort", "fail", "warn", "ignore"]);
  opts.round = parseNumfmtEnumOption(opts.round, "--round", ["up", "down", "from-zero", "towards-zero", "nearest"]);
  if (opts.padding != null && (!/^[+-]?\d+$/.test(String(opts.padding)) || Number(opts.padding) === 0)) throw new UsageError(`invalid padding value ${localeQuotedDiagnostic(opts.padding)}`);
  const rawDelimiter = rawNumfmtDelimiter();
  if (opts.delimiter != null && opts.delimiter !== "" && !isSingleNumfmtDelimiter(opts.delimiter, rawDelimiter)) throw new UsageError("the delimiter must be a single character");
  if (opts.d != null && opts.d !== "" && !isSingleNumfmtDelimiter(opts.d, rawDelimiter)) throw new UsageError("the delimiter must be a single character");
  if (opts.header != null && opts.header !== true && (!/^\+?\d+$/.test(String(opts.header)) || Number(opts.header) < 1)) throw new UsageError(`invalid header value ${localeQuotedDiagnostic(opts.header)}`);
  if (opts.field != null) validateNumfmtFieldSpec(String(opts.field));
  if (opts["from-unit"] != null) parseNumfmtUnit(opts["from-unit"]);
  if (opts["to-unit"] != null) parseNumfmtUnit(opts["to-unit"]);
  if (opts.format != null) parseNumfmtFormat(opts.format);
}

export function validateNumfmtMetaOptionValue(name, value) {
  if (value === undefined) return;
  if (name === "from") validateNumfmtScaleOption(value, "--from", ["none", "auto", "si", "iec", "iec-i"]);
  else if (name === "to") validateNumfmtScaleOption(value, "--to", ["none", "si", "iec", "iec-i"]);
  else if (name === "invalid") validateNumfmtScaleOption(value, "--invalid", ["abort", "fail", "warn", "ignore"]);
  else if (name === "round") validateNumfmtScaleOption(value, "--round", ["up", "down", "from-zero", "towards-zero", "nearest"]);
  else if (name === "field") validateNumfmtFieldSpec(String(value));
  else if (name === "padding" && (!/^[+-]?\d+$/.test(String(value)) || Number(value) === 0)) throw new UsageError(`invalid padding value ${localeQuotedDiagnostic(value)}`);
  else if (name === "delimiter" && value !== "" && !isSingleNumfmtDelimiter(value, rawNumfmtDelimiter())) throw new UsageError("the delimiter must be a single character");
  else if (name === "from-unit" || name === "to-unit") parseNumfmtUnit(value);
}

export function validateNumfmtScaleOption(value, option, valid) {
  parseNumfmtEnumOption(value, option, valid);
}

export function parseNumfmtEnumOption(value, option, valid) {
  if (value == null) return undefined;
  const text = String(value);
  if (valid.includes(text)) return text;
  const matches = valid.filter((arg) => arg.startsWith(text));
  if (matches.length === 1 && text !== "") return matches[0];
  const kind = text === "" || matches.length > 1 ? "ambiguous" : "invalid";
  throw new UsageError(numfmtScaleOptionMessage(kind, value, option, valid), true);
}

export function numfmtScaleOptionMessage(kind, value, option, valid) {
  return `${kind} argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic(option)}\nValid arguments are:\n${valid.map((arg) => `  - ${localeQuotedDiagnostic(arg)}`).join("\n")}`;
}

export function isSingleNumfmtDelimiter(value, rawDelimiter = null) {
  const text = String(value);
  if (rawDelimiter != null && isGb18030Locale()) return gb18030Units(rawDelimiter).length === 1;
  if (text.includes("\ufffd") && rawDelimiter != null) return rawDelimiter.length === 1;
  const singleByteLocale = /^(C|POSIX)$/.test(process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "");
  if (singleByteLocale) return enc.encode(text).length === 1;
  if ([...text].length === 1) return true;
  return text.includes("\ufffd");
}

export function rawNumfmtDelimiter() {
  const raw = rawNumfmtArgsFromProc();
  if (!raw) return null;
  return parseRawNumfmtArgs(raw).delimiter;
}

export function validateNumfmtFieldSpec(spec) {
  if (String(spec).startsWith("--")) throw new UsageError("invalid field range", true);
  for (const part of numfmtFieldSpecParts(spec)) {
    if (part === "-") continue;
    const invalid = part.search(/[^0-9-]/);
    if (invalid !== -1) throw new UsageError(`invalid field value ${localeQuotedDiagnostic(part.slice(invalid))}`, true);
    if (/^-?[A-Za-z]/.test(part)) throw new UsageError(`invalid field value ${localeQuotedDiagnostic(part.replace(/^-/, ""))}`, true);
  }
  readNumfmtFieldRanges(spec);
}

export function numfmtFieldSpecParts(spec) {
  const parts = String(spec).split(/[,\s]/);
  if (parts.some((part) => part === "")) throw new UsageError("fields are numbered from 1", true);
  return parts;
}

export function readNumfmtFieldRanges(spec) {
  const ranges = [];
  for (const part of numfmtFieldSpecParts(spec)) {
    if (part === "-") {
      ranges.push([1, Infinity]);
      continue;
    }
    const match = part.match(/^(\d*)-?(\d*)$/);
    if (!match || (!match[1] && !match[2])) throw new UsageError("invalid field range", true);
    const start = match[1] ? parseNumfmtFieldNumber(match[1]) : 1;
    const end = match[2] ? parseNumfmtFieldNumber(match[2]) : (part.includes("-") ? Infinity : start);
    if (start > end) throw new UsageError("invalid decreasing range", true);
    if (start <= 0 || end <= 0) throw new UsageError("fields are numbered from 1", true);
    ranges.push([start, end]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of ranges) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export function parseNumfmtFieldNumber(text) {
  if (text.length >= 20) throw new UsageError(`field number '${text}' is too large`, true);
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : Infinity;
}

export function parseNumfmtUnit(value) {
  const text = String(value);
  if (/^\+?\d+$/.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  const match = text.match(/^(\+?\d+)?([KMGTPEZYRQ])i?$/);
  if (match) {
    const prefix = match[1] == null ? 1 : Number(match[1]);
    if (Number.isSafeInteger(prefix) && prefix > 0) return prefix * (text.endsWith("i") ? 1024 : 1000) ** ("KMGTPEZYRQ".indexOf(match[2]) + 1);
  }
  throw new UsageError(`invalid unit size: ${localeQuotedEscapedDiagnostic(text)}`);
}

export function formatNumfmtRecord(record, opts) {
  if (record.includes("\0")) record = record.slice(0, record.indexOf("\0"));
  const delimiter = opts.d ?? opts.delimiter;
  const wholeRecord = delimiter === "";
  const leading = delimiter == null ? record.match(/^\s*/)?.[0] ?? "" : "";
  const trailing = delimiter == null ? record.match(/\s*$/)?.[0] ?? "" : "";
  const body = delimiter == null ? record.slice(leading.length, record.length - trailing.length) : record;
  const fields = wholeRecord ? [record] : delimiter == null ? (body === "" ? [""] : body.split(/[ \t\n\r\f\v]+/)) : record.split(delimiter);
  const defaultSeparators = body.match(/[ \t\n\r\f\v]+/g) ?? [];
  const separators = wholeRecord ? [] : delimiter == null ? (opts.z || opts["zero-terminated"] ? defaultSeparators.map(() => " ") : defaultSeparators) : Array.from({ length: Math.max(0, fields.length - 1) }, () => delimiter);
  const selected = readNumfmtFieldRanges(opts.field ?? "1");
  let ok = true;
  let error;
  for (let i = 0; i < fields.length; i++) {
    if (!inRanges(i + 1, selected)) continue;
    const result = formatNumfmtValue(fields[i], opts);
    ok &&= result.ok;
    if (!result.ok && error == null) error = result.error;
    if (!result.ok && (opts.invalid ?? "abort") === "abort") {
      const prefixFields = fields.slice(0, i);
      const prefix = prefixFields.length ? joinFields(prefixFields, separators.slice(0, Math.max(0, i - 1))) + (separators[i - 1] ?? "") : "";
      return { ok: false, error, text: `${leading}${prefix}` };
    }
    fields[i] = result.ok && delimiter == null && (leading || i > 0) ? applyPadding(result.text, fields[i].length) : result.text;
  }
  return { ok, error, text: `${leading}${joinFields(fields, separators)}${trailing}` };
}

export function joinFields(fields, separators) {
  let out = fields[0] ?? "";
  for (let i = 1; i < fields.length; i++) out += (separators[i - 1] ?? " ") + fields[i];
  return out;
}

export function formatNumfmtValue(value, opts) {
  try {
    const suffix = opts.suffix ?? "";
    const fromUnit = opts["from-unit"] == null ? 1 : parseNumfmtUnit(opts["from-unit"]);
    const toUnit = opts["to-unit"] == null ? 1 : parseNumfmtUnit(opts["to-unit"]);
    const unitSeparator = opts["unit-separator"] ?? opts["unit-sep"] ?? " ";
    const parsed = opts.from ? parseHumanNumberParts(value, opts.from, suffix, unitSeparator) : parsePlainNumfmtNumber(value, suffix);
    if (opts.from && opts["from-unit"] != null) parsed.decimals = countNumfmtInputDecimals(value, suffix);
    const n = (typeof parsed === "number" ? parsed : parsed.value) * fromUnit;
    if (!Number.isFinite(n)) throw new Error("invalid number");
    const format = parseNumfmtFormat(opts.format ?? "%f");
    let text = opts.to === "si" || opts.to === "iec" || opts.to === "iec-i"
      ? humanNumber(n / toUnit, opts.to, opts.round ?? "human-default", opts["unit-separator"] ?? opts["unit-sep"] ?? "", format.explicitPrecision ? format.precision : null)
      : formatPlainNumfmtNumber(n / toUnit, opts.round ?? "from-zero", format.explicitPrecision ? format.precision : (typeof parsed === "object" ? parsed.decimals : 0));
    if (opts.suffix) text += opts.suffix;
    text = applyNumfmtFormat(text, format);
    if (opts.padding && (opts.format == null || format.zero)) text = applyPadding(text, Number(opts.padding));
    return { ok: true, text };
  } catch (error) {
    return { ok: false, text: value, error: error.message };
  }
}

export function parsePlainNumfmtNumber(value, suffix = "") {
  let text = String(value);
  if (suffix && text.endsWith(suffix)) text = text.slice(0, -suffix.length);
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) throw new Error(numfmtNumberError(text, { fromMode: null }));
  const decimals = text.includes(".") ? text.split(".")[1].length : 0;
  return { value: Number(text), decimals };
}

export function countNumfmtInputDecimals(value, suffix = "") {
  let text = String(value);
  if (suffix && text.endsWith(suffix)) text = text.slice(0, -suffix.length);
  const match = text.match(/^[+-]?\d+\.(\d+)/);
  return match ? match[1].length : 0;
}

export function numfmtNumberError(text, { fromMode = null } = {}) {
  const value = String(text);
  const display = numfmtDiagnosticValue(value);
  if (/^[+-]?\d+\.(?:\D|$)/.test(value)) return `invalid number: ${localeQuotedDiagnostic(display)}`;
  const separatedSuffix = value.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)) ([kKMGTPEZYRQ](?:iB?|B)?)[ \t]+(.+)$/);
  if (fromMode && separatedSuffix) return `invalid suffix in input ${localeQuotedDiagnostic(display)}: ${localeQuotedDiagnostic(numfmtDiagnosticValue(separatedSuffix[3]))}`;
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)[A-Za-z]/.test(value)) {
    const suffix = value.match(/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(.*)$/)?.[1] ?? "";
    if (!fromMode && /^[KMGTPEZYRQ]i?B?$/i.test(suffix)) return `rejecting suffix in input: ${localeQuotedDiagnostic(display)} (consider using --from)`;
    return suffix.length > 1 && /^[KMGTPEZYRQ]i?/.test(suffix)
      ? `invalid suffix in input ${localeQuotedDiagnostic(display)}: ${localeQuotedDiagnostic(numfmtDiagnosticValue(suffix.replace(/^[KMGTPEZYRQ]i?/i, "")))}`
      : `invalid suffix in input: ${localeQuotedDiagnostic(display)}`;
  }
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s+/.test(value) || /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\S/.test(value) || value.includes("..")) return `invalid suffix in input: ${localeQuotedDiagnostic(display)}`;
  return `invalid number: ${localeQuotedDiagnostic(display)}`;
}

export function numfmtDiagnosticValue(value) {
  return [...String(value)].map((ch) => {
    if (/[\udc80-\udcff]/.test(ch)) return `\\${(ch.charCodeAt(0) - 0xdc00).toString(8).padStart(3, "0")}`;
    return lsEscapedName(ch, { escapeDouble: false });
  }).join("");
}

export function formatPlainNumfmtNumber(value, round = "nearest", precision = 0) {
  const rounded = roundNumber(value, precision, round);
  return precision > 0 ? rounded.toFixed(precision) : String(rounded);
}

export function applyPadding(text, width) {
  if (!Number.isInteger(width) || width === 0 || text.length >= Math.abs(width)) return text;
  return width > 0 ? text.padStart(width) : text.padEnd(Math.abs(width));
}

export function humanNumber(n, mode, round = "up", unitSeparator = "", forcedPrecision = null) {
  const base = mode === "si" ? 1000 : 1024;
  const units = mode === "iec-i" ? ["", "Ki", "Mi", "Gi", "Ti", "Pi", "Ei", "Zi", "Yi", "Ri", "Qi"] : mode === "si" ? ["", "k", "M", "G", "T", "P", "E", "Z", "Y", "R", "Q"] : ["", "K", "M", "G", "T", "P", "E", "Z", "Y", "R", "Q"];
  let value = n;
  let idx = 0;
  while (Math.abs(value) >= base && idx < units.length - 1) {
    value /= base;
    idx++;
  }
  if (!idx) {
    const rounded = roundNumber(value, 0, round);
    if (Math.abs(rounded) < base) return forcedPrecision == null ? String(rounded) : rounded.toFixed(forcedPrecision);
    value = rounded / base;
    idx++;
  }
  let decimals = forcedPrecision ?? (Math.abs(value) >= 10 ? 0 : 1);
  let rounded = roundNumber(value, decimals, round);
  if (Math.abs(rounded) >= base && idx < units.length - 1) {
    value = rounded / base;
    idx++;
    decimals = forcedPrecision ?? (Math.abs(value) >= 10 ? 0 : 1);
    rounded = roundNumber(value, decimals, round);
  } else if (forcedPrecision == null && Math.abs(rounded) >= 10 && decimals !== 0) {
    decimals = 0;
    rounded = roundNumber(value, decimals, round);
  }
  return `${rounded.toFixed(decimals)}${unitSeparator}${units[idx]}`;
}

export function roundNumber(value, precision, round) {
  const scale = 10 ** precision;
  const scaled = value * scale;
  let rounded;
  if (round === "human-default" || round === "from-zero") rounded = scaled < 0 ? Math.floor(scaled) : Math.ceil(scaled);
  else if (round === "up") rounded = Math.ceil(scaled);
  else if (round === "down") rounded = Math.floor(scaled);
  else if (round === "towards-zero") rounded = scaled < 0 ? Math.ceil(scaled) : Math.floor(scaled);
  else rounded = Math.sign(scaled) * Math.floor(Math.abs(scaled) + 0.5);
  return rounded / scale;
}

export function parseNumfmtFormat(format) {
  const text = String(format);
  let directives = 0;
  let match;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "%") continue;
    if (text[i + 1] === "%") {
      i++;
      continue;
    }
    directives++;
    match = text.slice(i).match(/^%([0 ']*)?(-)?([+ ]?\d+)?(?:\.(\d+))?f/);
    if (match?.[2] && /^[+ ]/.test(match[3] ?? "")) match = null;
    if (!match) {
      if (text.slice(i) === "%") throw new UsageError(`format ${localeQuotedEscapedDiagnostic(text)} ends in %`);
      const badPrecision = text.slice(i).match(/^%\.([-+ ]\d+)f/);
      if (badPrecision) throw new UsageError(`invalid precision in format ${localeQuotedEscapedDiagnostic(text)}`);
      throw new UsageError(`invalid format ${localeQuotedEscapedDiagnostic(text)}, directive must be %[0]['][-][N][.][N]f`);
    }
    i += match[0].length - 1;
  }
  if (directives === 0) throw new UsageError(text.endsWith("%") ? `format ${localeQuotedEscapedDiagnostic(text)} ends in %` : `format ${localeQuotedEscapedDiagnostic(text)} has no % directive`);
  if (directives > 1) throw new UsageError(`format ${localeQuotedEscapedDiagnostic(text)} has too many % directives`);
  const parsed = text.match(/^(.*)%([0 ']*)?(-)?([+ ]?\d+)?(?:\.(\d+))?f(.*)$/);
  return {
    raw: text,
    prefix: parsed?.[1]?.replace(/%%\s$/, "%%").replaceAll("%%", "%%") ?? "",
    suffix: parsed?.[6]?.replaceAll("%%", "%%") ?? "",
    left: Boolean(parsed?.[3]),
    zero: parsed?.[2]?.includes("0") ?? false,
    grouping: parsed?.[2]?.includes("'") ?? false,
    width: parsed?.[4] == null ? null : Number(parsed[4]),
    precision: parsed?.[5] == null ? 0 : Number(parsed[5]),
    explicitPrecision: parsed?.[5] != null,
  };
}

export function applyNumfmtFormat(text, format) {
  if (format.raw === "%f") return text;
  let body = text;
  if (format.width != null && body.length < format.width) {
    const pad = format.zero ? "0" : " ";
    if (format.zero && !format.left && body.startsWith("-")) body = `-${body.slice(1).padStart(format.width - 1, pad)}`;
    else body = format.left ? body.padEnd(format.width, pad) : body.padStart(format.width, pad);
  }
  return `${format.prefix}${body}${format.suffix}`;
}

const singleCall = defineCommand("numfmt", numfmtCmd, numfmtMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
