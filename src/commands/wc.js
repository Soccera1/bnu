#!/usr/bin/env bun

import { closeSync, openSync, readSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createFdRecordReader, displayWidth, isWriteError, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, nodeErrorMessage, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions, pathDisplayName, readAll, shellEscapeLsName, splitFiles0ByteNames, systemErrorMessage, wcFileNameIsDash, wcFileNameIsEmpty, wcFiles0SourceIsNonRegular } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const UINTMAX_MAX = 18446744073709551615n;

export const WC_LONG_OPTIONS = ["bytes", "chars", "lines", "max-line-length", "words", "files0-from", "total", "debug", "help", "version"];

export function wcMetaOption(args) {
  const longValueOptions = new Set(["files0-from", "total"]);
  const shortKnownOptions = new Set(["c", "m", "l", "L", "w"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeWcLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!WC_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (name === "total" && inlineValue != null) validateWcTotalMode(inlineValue);
      if (inlineValue == null && longValueOptions.has(name)) i++;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) if (!shortKnownOptions.has(arg[j])) return null;
  }
  return null;
}

export async function wc(args) {
  args = normalizeWcLongOptions(args);
  const parsed = parseOptions(args, {
    short: { c: false, m: false, l: false, L: false, w: false },
    long: { bytes: false, chars: false, lines: false, "max-line-length": false, words: false, "files0-from": "value", total: "value", debug: false, help: false, version: false },
  });
  const flags = parsed.opts;
  const showAll = !(flags.c || flags.m || flags.l || flags.L || flags.w || flags.bytes || flags.chars || flags.lines || flags["max-line-length"] || flags.words);
  const totalMode = flags.total ?? "auto";
  validateWcTotalMode(totalMode);
  let files = parsed.operands.length ? parsed.operands : ["-"];
  let files0From = null;
  let files0EntryCount = null;
  if (flags["files0-from"] !== undefined) {
    if (parsed.operands.length) throw new UsageError(`extra operand '${parsed.operands[0]}'\nfile operands cannot be combined with --files0-from`, true);
    files0From = flags["files0-from"];
    if (wcFiles0SourceIsNonRegular(files0From)) {
      return wcStreamFiles0(files0From, flags, showAll, totalMode);
    }
    let nameBytes;
    try {
      nameBytes = await readAll(files0From);
    } catch (error) {
      stderr(error?.code === "EISDIR"
        ? `wc: ${wcFiles0DiagnosticName(files0From)}: read error: ${systemErrorMessage(error)}\n`
        : `wc: cannot open ${wcFiles0OpenName(files0From)} for reading: ${systemErrorMessage(error)}\n`);
      return 1;
    }
    files = splitFiles0ByteNames(nameBytes);
    files0EntryCount = files.length;
    if (files0From === "-" && files.some(wcFileNameIsDash)) {
      stderr("wc: when reading file names from standard input, no file name of '-' allowed\n");
      return 1;
    }
  }
  const rows = [];
  const total = { lines: 0, words: 0, bytes: 0n, chars: 0, maxLineLength: 0 };
  const bytesOnly = (flags.c || flags.bytes) && !(flags.m || flags.chars || flags.l || flags.lines || flags.L || flags["max-line-length"] || flags.w || flags.words);
  let failed = false;
  let totalByteOverflow = false;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (files0From != null && wcFileNameIsEmpty(file)) {
      stderr(`wc: ${wcFiles0DiagnosticName(files0From)}:${index + 1}: invalid zero-length file name\n`);
      failed = true;
      continue;
    }
    let bytes;
    try {
      if (bytesOnly && file === "-") {
        const size = wcCountFdBytes(0);
        const name = parsed.operands.length === 0 && flags["files0-from"] === undefined ? "" : file;
        const row = { lines: 0, words: 0, bytes: size, chars: 0, maxLineLength: 0, name };
        if (wcByteTotalWouldOverflow(total.bytes, row.bytes)) totalByteOverflow = true;
        total.bytes = addWcByteTotal(total.bytes, row.bytes);
        rows.push(row);
        continue;
      }
      if (bytesOnly && file !== "-") {
        const info = await stat(file, { bigint: true });
        if (info.isDirectory()) throw Object.assign(new Error("Is a directory"), { code: "EISDIR" });
        const size = info.size;
        bytes = null;
        const row = { lines: 0, words: 0, bytes: size, chars: 0, maxLineLength: 0, name: file, specialFile: wcStatIsSpecial(info) };
        if (wcByteTotalWouldOverflow(total.bytes, row.bytes)) totalByteOverflow = true;
        total.bytes = addWcByteTotal(total.bytes, row.bytes);
        rows.push(row);
        continue;
      }
      bytes = await readAll(file);
    } catch (error) {
      if (error?.code === "EISDIR") {
        stderr(`wc: ${wcDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
        rows.push({ lines: 0, words: 0, bytes: 0, chars: 0, maxLineLength: 0, name: file, directoryError: true });
      } else {
        stderr(file === "-" ? `wc: ${nodeErrorMessage(error)}\n` : `wc: ${wcDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      }
      failed = true;
      continue;
    }
    const row = wcRow(bytes, file === "-" && parsed.operands.length === 0 && flags["files0-from"] === undefined ? "" : file);
    if (file !== "-") {
      const info = await stat(file).catch(() => null);
      if (info && wcStatIsSpecial(info)) row.specialFile = true;
    }
    total.lines += row.lines;
    total.words += row.words;
    if (wcByteTotalWouldOverflow(total.bytes, row.bytes)) totalByteOverflow = true;
    total.bytes = addWcByteTotal(total.bytes, row.bytes);
    total.chars += row.chars;
    total.maxLineLength = Math.max(total.maxLineLength, row.maxLineLength);
    rows.push(row);
  }
  const totalInputCount = files0EntryCount ?? files.length;
  const includeTotal = totalMode === "always" || totalMode === "only" || (totalMode === "auto" && totalInputCount > 1);
  if (includeTotal && totalByteOverflow) failed = true;
  const outputRows = totalMode === "only" ? [] : [...rows];
  if (includeTotal) outputRows.push({ ...total, name: totalMode === "only" ? "" : "total" });
  const selectedValues = (row) => {
    const values = [];
    if (showAll || flags.l || flags.lines) values.push(row.lines);
    if (showAll || flags.w || flags.words) values.push(row.words);
    if (flags.m || flags.chars) values.push(row.chars);
    if (showAll || flags.c || flags.bytes) values.push(row.bytes);
    if (flags.L || flags["max-line-length"]) values.push(row.maxLineLength);
    return values;
  };
  const widthValues = (row) => showAll ? selectedValues(row) : [row.lines, row.words, row.chars, row.bytes, row.maxLineLength];
  const hasNamedOutput = outputRows.some((row) => row.name);
  const widthRows = [...outputRows];
  if (hasNamedOutput && totalInputCount > 1 && totalMode === "never") widthRows.push(total);
  const minCountWidth = showAll && outputRows.some((row) => row.directoryError || row.specialFile) ? 7 : 1;
  const countWidth = hasNamedOutput
    ? Math.max(minCountWidth, ...widthRows.flatMap(widthValues).map((n) => String(n).length))
    : 7;
  for (const row of outputRows) {
    const cols = selectedValues(row);
    const unpadded = totalMode === "only" || (!row.name && cols.length === 1) || (files0From != null && cols.length === 1);
    stdout(`${cols.map((n) => unpadded ? String(n) : String(n).padStart(countWidth)).join(" ")}${row.name ? ` ${wcDisplayName(row.name)}` : ""}\n`);
  }
  return failed ? 1 : 0;
}

export function wcCountFdBytes(fd) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0n;
  while (true) {
    const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    if (bytesRead === 0) return total;
    total += BigInt(bytesRead);
  }
}

export async function wcStreamFiles0(source, flags, showAll, totalMode) {
  let fd = 0;
  let closeFd = false;
  try {
    if (source !== "-") {
      fd = openSync(source, "r");
      closeFd = true;
    }
  } catch (error) {
    stderr(`wc: cannot open ${wcFiles0OpenName(source)} for reading: ${systemErrorMessage(error)}\n`);
    return 1;
  }
  const reader = createFdRecordReader(fd, 0);
  const total = { lines: 0, words: 0, bytes: 0n, chars: 0, maxLineLength: 0 };
  const bytesOnly = (flags.c || flags.bytes) && !(flags.m || flags.chars || flags.l || flags.lines || flags.L || flags["max-line-length"] || flags.w || flags.words);
  const selectedValues = (row) => {
    const values = [];
    if (showAll || flags.l || flags.lines) values.push(row.lines);
    if (showAll || flags.w || flags.words) values.push(row.words);
    if (flags.m || flags.chars) values.push(row.chars);
    if (showAll || flags.c || flags.bytes) values.push(row.bytes);
    if (flags.L || flags["max-line-length"]) values.push(row.maxLineLength);
    return values;
  };
  let failed = false;
  let totalByteOverflow = false;
  let entryCount = 0;
  try {
    while (true) {
      const file = reader.next();
      if (file == null) break;
      entryCount++;
      if (wcFileNameIsEmpty(file)) {
        stderr(`wc: ${wcFiles0DiagnosticName(source)}:${entryCount}: invalid zero-length file name\n`);
        failed = true;
        continue;
      }
      if (source === "-" && wcFileNameIsDash(file)) {
        stderr("wc: when reading file names from standard input, no file name of '-' allowed\n");
        failed = true;
        continue;
      }
      let row;
      try {
        if (bytesOnly) {
          const info = await stat(file, { bigint: true });
          if (info.isDirectory()) throw Object.assign(new Error("Is a directory"), { code: "EISDIR" });
          row = { lines: 0, words: 0, bytes: info.size, chars: 0, maxLineLength: 0, name: file, specialFile: wcStatIsSpecial(info) };
        } else {
          const bytes = await readAll(file);
          row = wcRow(bytes, file);
          const info = await stat(file).catch(() => null);
          if (info && wcStatIsSpecial(info)) row.specialFile = true;
        }
      } catch (error) {
        if (error?.code === "EISDIR") {
          stderr(`wc: ${wcDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
          row = { lines: 0, words: 0, bytes: 0, chars: 0, maxLineLength: 0, name: file, directoryError: true };
        } else {
          stderr(`wc: ${wcDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
          failed = true;
          continue;
        }
        failed = true;
      }
      total.lines += row.lines;
      total.words += row.words;
      if (wcByteTotalWouldOverflow(total.bytes, row.bytes)) totalByteOverflow = true;
      total.bytes = addWcByteTotal(total.bytes, row.bytes);
      total.chars += row.chars;
      total.maxLineLength = Math.max(total.maxLineLength, row.maxLineLength);
      if (totalMode !== "only") {
        const cols = selectedValues(row);
        stdout(`${cols.map(String).join(" ")} ${wcDisplayName(row.name)}\n`);
      }
    }
  } catch (error) {
    if (isWriteError(error)) throw error;
    stderr(`wc: ${wcFiles0DiagnosticName(source)}: read error: ${systemErrorMessage(error)}\n`);
    failed = true;
  } finally {
    if (closeFd) closeSync(fd);
  }
  const includeTotal = totalMode === "always" || totalMode === "only" || (totalMode === "auto" && entryCount > 1);
  if (includeTotal) {
    if (totalByteOverflow) failed = true;
    const cols = selectedValues(total);
    stdout(`${cols.map(String).join(" ")}${totalMode === "only" ? "" : " total"}\n`);
  }
  return failed ? 1 : 0;
}

export function validateWcTotalMode(totalMode) {
  if (["auto", "always", "only", "never"].includes(totalMode)) return;
  throw new UsageError(`${totalMode === "" ? "ambiguous" : "invalid"} argument ${localeQuotedEscapedDiagnostic(totalMode)} for ${localeQuotedDiagnostic("--total")}\nValid arguments are:\n  - ${localeQuotedDiagnostic("auto")}\n  - ${localeQuotedDiagnostic("always")}\n  - ${localeQuotedDiagnostic("only")}\n  - ${localeQuotedDiagnostic("never")}`, true);
}

export function wcDisplayName(name) {
  const text = pathDisplayName(name);
  if (!text.includes("\n")) return text;
  const parts = text.split("\n");
  const trailingNewline = parts.at(-1) === "";
  if (trailingNewline) parts.pop();
  return parts.map((part) => `'${part.replaceAll("'", "'\\''")}'`).join("$'\\n'") + (trailingNewline ? "$'\\n'" : "");
}

export function wcDiagnosticName(name) {
  return shellEscapeLsName(pathDisplayName(name));
}

export function wcFiles0OpenName(name) {
  return name === "-" ? "-" : shellEscapeLsName(pathDisplayName(name), true);
}

export function wcFiles0DiagnosticName(name) {
  return name === "-" ? "-" : shellEscapeLsName(pathDisplayName(name));
}

export function wcStatIsSpecial(info) {
  return info.isCharacterDevice() || info.isBlockDevice() || info.isFIFO() || info.isSocket();
}

export function addWcByteTotal(total, bytes) {
  const next = total + BigInt(bytes);
  return next > UINTMAX_MAX ? UINTMAX_MAX : next;
}

export function wcByteTotalWouldOverflow(total, bytes) {
  return total + BigInt(bytes) > UINTMAX_MAX;
}

export function normalizeWcLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, WC_LONG_OPTIONS);
}

export function normalizeWcLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, WC_LONG_OPTIONS);
}

export function wcRow(bytes, name) {
  const text = new TextDecoder().decode(bytes);
  return {
    lines: (text.match(/\n/g) || []).length,
    words: countWcWords(bytes, text),
    bytes: bytes.byteLength,
    chars: [...text].length,
    maxLineLength: maxLineLength(text),
    name,
  };
}

export function countWcWords(bytes, text) {
  if (text.includes("\uFFFD")) return countWcWordsBytes(bytes);
  let count = 0;
  let inWord = false;
  for (const ch of text) {
    if (isWcWordSeparator(ch)) {
      inWord = false;
    } else if (!inWord) {
      count++;
      inWord = true;
    }
  }
  return count;
}

export function countWcWordsBytes(bytes) {
  let count = 0;
  let inWord = false;
  for (const byte of bytes) {
    if (isWcByteSeparator(byte)) {
      inWord = false;
    } else if (!inWord) {
      count++;
      inWord = true;
    }
  }
  return count;
}

export function isWcWordSeparator(ch) {
  return /\s/u.test(ch) || ch === "\u2060";
}

export function isWcByteSeparator(byte) {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d) || byte === 0xa0 || byte === 0x9a;
}

export function maxLineLength(text) {
  let max = 0;
  let column = 0;
  for (const ch of text) {
    if (ch === "\n" || ch === "\r" || ch === "\f") {
      max = Math.max(max, column);
      column = 0;
    } else if (ch === "\t") {
      column += 8 - (column % 8);
    } else {
      column += displayWidth(ch);
    }
  }
  return Math.max(max, column);
}

const singleCall = defineCommand("wc", wc, wcMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
