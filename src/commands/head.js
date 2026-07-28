#!/usr/bin/env bun

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { stat } from "node:fs/promises";
import { SEEK_CUR, headTailDiagnosticName, isWriteError, libc, localeQuotedEscapedDiagnostic, nodeErrorMessage, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions, readAll, systemErrorMessage } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { headTailHeaderMode, headTailShouldPrintHeader, isTailStreamingDevice, normalizeHeadTailArgs, parseByteCount, splitDelimitedByteRecords, tailFirstBytes } from "../shared/head-tail.js";
import { outputWriteErrorMessage } from "../shared/runtime.js";
import { fdIsSeekable } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const HEAD_LONG_OPTIONS = ["bytes", "lines", "quiet", "silent", "verbose", "zero-terminated", "help", "version"];

export function headMetaOption(args) {
  const longValueOptions = new Set(["bytes", "lines"]);
  const shortValueOptions = new Set(["c", "n"]);
  const shortKnownOptions = new Set(["c", "n", "q", "v", "z"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeHeadLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!HEAD_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (longValueOptions.has(name)) {
        const value = inlineValue ?? args[i + 1];
        if (value !== undefined) {
          if (name === "bytes") parseCount(value, 10, "bytes");
          if (name === "lines") parseCount(value, 10, "lines");
        }
        if (inlineValue == null) i++;
      }
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    if (/^-\d/.test(arg)) continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        const value = inlineValue === "" ? args[i + 1] : inlineValue;
        if (value !== undefined) parseCount(value, 10, ch === "c" ? "bytes" : "lines");
        if (inlineValue === "") i++;
        break;
      }
    }
  }
  return null;
}

export function parseCount(value, defaultValue, kind = "lines") {
  if (value == null) return defaultValue;
  const countText = String(value).replace(/^[+-]/, "");
  let n;
  try {
    n = parseByteCount(countText);
  } catch {
    throw new UsageError(`invalid number of ${kind}: ${localeQuotedEscapedDiagnostic(countText)}`);
  }
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`invalid number of ${kind}: ${localeQuotedEscapedDiagnostic(countText)}`);
  return Math.trunc(n);
}

export async function head(args) {
  args = normalizeHeadTailArgs(normalizeHeadLongOptions(args), "head");
  args = args.filter((arg) => arg !== "---presume-input-pipe");
  const headerMode = headTailHeaderMode(args);
  const { opts, operands } = parseOptions(args, { short: { n: "value", c: "value", q: false, v: false, z: false }, long: { lines: "value", bytes: "value", quiet: false, silent: false, verbose: false, "zero-terminated": false, help: false, version: false } });
  const files = operands.length ? operands : ["-"];
  const bytesMode = opts.c ?? opts.bytes;
  const count = parseCount(bytesMode ?? opts.n ?? opts.lines, 10, bytesMode != null ? "bytes" : "lines");
  const delimiter = opts.z || opts["zero-terminated"] ? "\0" : "\n";
  let failed = false;
  let renderedAnyFile = false;
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const raw = String(bytesMode ?? opts.n ?? opts.lines ?? "");
      const header = headTailShouldPrintHeader(headerMode, files.length) ? `${renderedAnyFile ? "\n" : ""}==> ${file} <==\n` : "";
      if (file === "-" && files.length === 1 && headerMode !== "verbose") {
        if (bytesMode != null) {
          headWrite(raw.startsWith("-") ? readHeadFdExceptLastBytes(0, count) : readHeadStdinBytes(count));
        } else {
          headWrite(raw.startsWith("-") ? readHeadFdExceptLastRecords(0, count, delimiter) : readHeadStdinRecords(count, delimiter));
        }
        continue;
      }
      if (raw.startsWith("-") && file !== "-" && !(await stat(file).catch(() => null))?.isDirectory()) {
        if (header) headWrite(header);
        let fd;
        try {
          fd = openSync(file, "r");
          if (bytesMode != null) readHeadFdExceptLastBytes(fd, count);
          else readHeadFdExceptLastRecords(fd, count, delimiter);
          renderedAnyFile = true;
        } catch (error) {
          if (isWriteError(error)) throw error;
          stderr(`head: cannot open ${headTailDiagnosticName(file)} for reading: ${systemErrorMessage(error)}\n`);
          failed = true;
        } finally {
          if (fd != null) closeSync(fd);
        }
        continue;
      }
      if (bytesMode != null && !raw.startsWith("-") && file !== "-" && await isTailStreamingDevice(file)) {
        if (header) headWrite(header);
        try {
          await tailFirstBytes(file, count);
          renderedAnyFile = true;
        } catch (error) {
          stderr(`head: cannot open ${headTailDiagnosticName(file)} for reading: ${systemErrorMessage(error)}\n`);
          failed = true;
        }
        continue;
      }
      let data;
      try {
        data = await readAll(file);
      } catch (error) {
        if (error?.code === "EISDIR") {
          if (header) headWrite(header);
          renderedAnyFile = true;
          stderr(`head: error reading ${headTailDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
        } else {
          stderr(file === "-" ? `head: ${nodeErrorMessage(error)}\n` : `head: cannot open ${headTailDiagnosticName(file)} for reading: ${systemErrorMessage(error)}\n`);
        }
        failed = true;
        continue;
      }
      if (header) headWrite(header);
      renderedAnyFile = true;
      if (bytesMode != null) {
        headWrite(raw.startsWith("-") ? data.slice(0, Math.max(0, data.length - count)) : data.slice(0, count));
      } else {
        const lines = splitDelimitedByteRecords(data, delimiter);
        headWrite(Buffer.concat(raw.startsWith("-") ? lines.slice(0, Math.max(0, lines.length - count)) : lines.slice(0, count)));
      }
    }
  } catch (error) {
    if (!isWriteError(error)) throw error;
    stderr(`head: error writing 'standard output': ${outputWriteErrorMessage(error)}\n`);
    return 1;
  }
  return failed ? 1 : 0;
}

export function headWrite(data) {
  stdout(data);
}

export function normalizeHeadLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, HEAD_LONG_OPTIONS);
}

export function normalizeHeadLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, HEAD_LONG_OPTIONS);
}

export function readHeadStdinBytes(count) {
  if (count > 2 ** 32) return readRemainingStdinSync();
  const out = Buffer.alloc(count);
  let offset = 0;
  while (offset < count) {
    const n = readSync(0, out, offset, count - offset, null);
    if (n === 0) break;
    offset += n;
  }
  return out.subarray(0, offset);
}

export function readHeadStdinRecords(count, delimiter) {
  if (count === 0) return "";
  const chunks = [];
  let seen = 0;
  const byte = Buffer.alloc(1);
  const delim = delimiter.charCodeAt(0);
  while (seen < count) {
    const n = readSync(0, byte, 0, 1, null);
    if (n === 0) break;
    chunks.push(byte[0]);
    if (byte[0] === delim) seen++;
  }
  return Buffer.from(chunks);
}

export function readHeadFdExceptLastBytes(fd, count) {
  if (fstatSync(fd).isFile() && fdIsSeekable(fd)) {
    const data = readRemainingFdSync(fd);
    const keep = Math.max(0, data.length - count);
    headWrite(data.subarray(0, keep));
    rewindFd(fd, data.length - keep);
    return "";
  }
  const buffer = Buffer.alloc(8192);
  let tail = Buffer.alloc(0);
  while (true) {
    const n = readSync(fd, buffer, 0, buffer.length, null);
    if (n === 0) break;
    const chunk = Buffer.from(buffer.subarray(0, n));
    if (count === 0) {
      headWrite(chunk);
      continue;
    }
    const combined = Buffer.concat([tail, chunk]);
    const emit = Math.max(0, combined.length - count);
    if (emit) headWrite(combined.subarray(0, emit));
    tail = combined.subarray(emit);
  }
  return "";
}

export function readHeadFdExceptLastRecords(fd, count, delimiter) {
  if (fstatSync(fd).isFile() && fdIsSeekable(fd)) {
    const data = readRemainingFdSync(fd);
    const keep = headPrefixLengthExceptLastRecords(data, count, delimiter.charCodeAt(0));
    headWrite(data.subarray(0, keep));
    rewindFd(fd, data.length - keep);
    return "";
  }
  const delim = delimiter.charCodeAt(0);
  const byte = Buffer.alloc(1);
  let current = [];
  const records = [];
  while (true) {
    const n = readSync(fd, byte, 0, 1, null);
    if (n === 0) break;
    current.push(byte[0]);
    if (byte[0] === delim) {
      records.push(Buffer.from(current));
      current = [];
      while (records.length > count) headWrite(records.shift());
    }
  }
  if (current.length) {
    records.push(Buffer.from(current));
    while (records.length > count) headWrite(records.shift());
  }
  return "";
}

export function readRemainingStdinSync() {
  return readRemainingFdSync(0);
}

export function readRemainingFdSync(fd) {
  const chunks = [];
  const buffer = Buffer.alloc(8192);
  while (true) {
    const n = readSync(fd, buffer, 0, buffer.length, null);
    if (n === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

export function headPrefixLengthExceptLastRecords(data, count, delimiter) {
  if (count === 0) return data.length;
  let seen = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    if (data[i] === delimiter) {
      seen++;
      if (seen > count) return i + 1;
    }
  }
  return 0;
}

export function rewindFd(fd, bytes) {
  if (bytes > 0) libc.symbols.lseek(fd, -BigInt(bytes), SEEK_CUR);
}

const singleCall = defineCommand("head", head, headMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
