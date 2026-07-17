#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import { concatBytes, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, nodeErrorMessage, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, randomPicker, readAll, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const SHUF_LONG_OPTIONS = ["echo", "head-count", "input-range", "output", "random-source", "repeat", "zero-terminated", "help", "version"];

export function shufMetaOption(args) {
  const longValueOptions = new Set(["head-count", "input-range", "output", "random-source"]);
  const shortValueOptions = new Set(["n", "i", "o"]);
  const shortKnownOptions = new Set(["e", "i", "n", "o", "r", "z"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeShufLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!SHUF_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      const value = inlineValue ?? (longValueOptions.has(name) ? args[i + 1] : undefined);
      if (name === "head-count" && value !== undefined) parseShufCount(value);
      if (name === "input-range" && value !== undefined) parseShufRange(value);
      if (inlineValue == null && longValueOptions.has(name)) i++;
      else if (inlineValue != null && !longValueOptions.has(name)) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        const value = arg.slice(j + 1) || args[i + 1];
        if (ch === "n" && value !== undefined) parseShufCount(value);
        if (ch === "i" && value !== undefined) parseShufRange(value);
        if (arg.slice(j + 1) === "") i++;
        break;
      }
    }
  }
  return null;
}

export async function shuf(args) {
  const { opts, operands } = parseShufOptions(args);
  const sep = opts.z || opts["zero-terminated"] ? "\0" : "\n";
  const count = shufHeadCount(opts);
  const hasInputRange = Object.hasOwn(opts, "i") || Object.hasOwn(opts, "input-range");
  if (hasInputRange && (opts.e || opts.echo)) throw new UsageError("cannot combine -e and -i options", true);
  if (count === 0 && !hasInputRange && !(opts.e || opts.echo)) {
    if (opts.o || opts.output) await writeFile(opts.o ?? opts.output, "");
    return 0;
  }
  let lines;
  let range = null;
  if (hasInputRange) {
    range = parseShufRange(opts.i ?? opts["input-range"]);
    if (operands.length) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[0])}`, true);
    if (range.size <= BigInt(Number.MAX_SAFE_INTEGER) && (count == null || count >= Number(range.size) || opts.r || opts.repeat)) {
      const lo = Number(range.lo);
      const size = Number(range.size);
      lines = Array.from({ length: size }, (_, i) => String(lo + i));
    }
  } else if (opts.e || opts.echo) {
    lines = operands;
  } else {
    if (operands.length > 1) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[1])}`, true);
    const file = operands[0] ?? "-";
    let bytes;
    try {
      bytes = await readAll(file);
    } catch (error) {
      throw new UsageError(error?.code === "EISDIR" ? "read error: Is a directory" : file === "-" ? nodeErrorMessage(error) : `${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}`);
    }
    lines = splitShufByteRecords(bytes, sep === "\0" ? 0 : 0x0a);
  }
  if (count === 0) {
    if (opts.o || opts.output) await writeFile(opts.o ?? opts.output, "");
    return 0;
  }
  if ((opts.r || opts.repeat) && (range?.size === 0n || (range == null && lines.length === 0))) throw new UsageError("no lines to repeat");
  let random;
  try {
    random = await randomPicker(opts["random-source"], { boundedBits: true });
  } catch (error) {
    const source = opts["random-source"];
    const sourceName = source === "" ? "''" : textInputDiagnosticName(source);
    const message = error?.code === "EISDIR" ? `${localeQuotedDiagnostic(source)}: read error: ${systemErrorMessage(error)}` : `${sourceName}: ${systemErrorMessage(error)}`;
    stderr(`shuf: ${message}\n`);
    return 1;
  }
  if (opts.r || opts.repeat) {
    if (count == null) return shufRepeatForever(lines, range, random, sep);
    const selected = range
      ? Array.from({ length: count }, () => shufRangeValue(range, random).toString())
      : Array.from({ length: count }, () => lines[random(lines.length)] ?? "");
    const out = shufJoinRecords(selected, sep);
    if (opts.o || opts.output) await writeFile(opts.o ?? opts.output, out);
    else stdout(out);
    return 0;
  }
  if (range && !lines) {
    lines = shufSampleRange(range, count ?? Number.MAX_SAFE_INTEGER, random);
  } else {
    const limit = Math.min(count ?? lines.length, lines.length);
    for (let i = 0; i < limit; i++) {
      const j = i + random(lines.length - i);
      [lines[i], lines[j]] = [lines[j], lines[i]];
    }
  }
  const selected = lines.slice(0, count ?? lines.length);
  const out = shufJoinRecords(selected, sep);
  if (opts.o || opts.output) await writeFile(opts.o ?? opts.output, out);
  else stdout(out);
  return 0;
}

export function splitShufByteRecords(bytes, sepByte) {
  if (bytes.length === 0) return [];
  const end = bytes[bytes.length - 1] === sepByte ? bytes.length - 1 : bytes.length;
  if (end === 0) return [];
  const records = [];
  let start = 0;
  for (let i = 0; i < end; i++) {
    if (bytes[i] === sepByte) {
      records.push(bytes.slice(start, i));
      start = i + 1;
    }
  }
  records.push(bytes.slice(start, end));
  return records;
}

export function shufJoinRecords(records, sep) {
  if (!records.length) return "";
  if (records[0] instanceof Uint8Array) {
    const sepBytes = sep === "\0" ? Uint8Array.of(0) : Uint8Array.of(0x0a);
    const chunks = [];
    for (const record of records) chunks.push(record, sepBytes);
    return concatBytes(chunks);
  }
  return records.join(sep) + sep;
}

export function parseShufOptions(args) {
  args = normalizeShufLongOptions(args);
  const opts = {};
  const operands = [];
  const seen = { i: false, o: false, randomSource: false };
  let end = false;
  const setValue = (key, value, option) => {
    if (value === undefined) {
      if (option?.startsWith("--")) throw new UsageError(`option '${option}' requires an argument`, true);
      throw new UsageError(`option requires an argument -- '${key}'`, true);
    }
    if (key === "n" || key === "head-count") {
      const previous = opts.n ?? opts["head-count"];
      const next = parseShufCount(value);
      opts.n = previous === undefined ? String(value) : String(Math.min(parseShufCount(previous), next));
      return;
    }
    if (key === "i" || key === "input-range") {
      if (seen.i) throw new UsageError("multiple -i options specified");
      seen.i = true;
      opts.i = value;
      return;
    }
    if (key === "o" || key === "output") {
      if (seen.o) throw new UsageError("multiple output files specified");
      seen.o = true;
      opts.o = value;
      return;
    }
    if (key === "random-source") {
      if (seen.randomSource !== false && seen.randomSource !== value) throw new UsageError("multiple random sources specified");
      seen.randomSource = value;
      opts["random-source"] = value;
    }
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (end || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      end = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      const name = rawName === "rep" ? "repeat" : rawName;
      if (["head-count", "input-range", "output", "random-source"].includes(name)) setValue(name, inlineValue ?? args[++i], `--${rawName}`);
      else if (name === "echo") {
        if (inlineValue !== undefined) throw new UsageError("option '--echo' doesn't allow an argument", true);
        opts.echo = true;
      } else if (name === "repeat") {
        if (inlineValue !== undefined) throw new UsageError("option '--repeat' doesn't allow an argument", true);
        opts.repeat = true;
      } else if (name === "zero-terminated") {
        if (inlineValue !== undefined) throw new UsageError("option '--zero-terminated' doesn't allow an argument", true);
        opts["zero-terminated"] = true;
      } else if (name === "help" || name === "version") {
        if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
        opts[name] = true;
      }
      else throw new UsageError(`unrecognized option '${arg}'`, true);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "e") opts.e = true;
      else if (ch === "r") opts.r = true;
      else if (ch === "z") opts.z = true;
      else if (["n", "i", "o"].includes(ch)) {
        setValue(ch, arg.slice(j + 1) || args[++i], `-${ch}`);
        break;
      } else {
        throw new UsageError(`invalid option -- '${ch}'`, true);
      }
    }
  }
  return { opts, operands };
}

export function normalizeShufLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, SHUF_LONG_OPTIONS);
}

export function normalizeShufLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, SHUF_LONG_OPTIONS);
}

export function shufHeadCount(opts) {
  const value = opts.n ?? opts["head-count"];
  return value === undefined ? null : parseShufCount(value);
}

export function parseShufCount(value) {
  const text = String(value).trimStart();
  if (!/^\+?\d+$/.test(text)) throw new UsageError(`invalid line count: ${localeQuotedEscapedDiagnostic(value)}`);
  const count = BigInt(text);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(count);
}

export function parseShufRange(value) {
  const text = String(value);
  const match = text.match(/^(\+?\d+)-(\+?\d+)$/);
  if (!match) throw new UsageError(`invalid input range: ${localeQuotedEscapedDiagnostic(text)}`);
  const lo = BigInt(match[1]);
  const hi = BigInt(match[2]);
  if (hi + 1n < lo) throw new UsageError(`invalid input range: ${localeQuotedEscapedDiagnostic(text)}`);
  return { lo, hi, size: hi - lo + 1n };
}

export function shufRangeValue(range, random) {
  return range.lo + BigInt(randomBigIntBelow(range.size, random));
}

export function randomBigIntBelow(max, random) {
  if (max <= 0n) return 0n;
  if (max <= BigInt(Number.MAX_SAFE_INTEGER)) return BigInt(random(Number(max)));
  return BigInt(random(0x1_0000_0000)) % max;
}

export function shufSampleRange(range, count, random) {
  const limit = Math.min(count, Number(range.size > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(count) : range.size));
  const selected = new Set();
  while (selected.size < limit) selected.add(shufRangeValue(range, random).toString());
  return [...selected];
}

export function shufRepeatForever(lines, range, random, sep) {
  while (true) {
    const out = [];
    for (let i = 0; i < 1024; i++) out.push(range ? shufRangeValue(range, random).toString() : lines[random(lines.length)] ?? "");
    try {
      stdout(shufJoinRecords(out, sep));
    } catch (error) {
      if (error?.code === "EPIPE") return 0;
      throw error;
    }
  }
}

const singleCall = defineCommand("shuf", shuf, shufMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
