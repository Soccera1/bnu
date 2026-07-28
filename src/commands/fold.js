#!/usr/bin/env bun

import { closeSync, openSync } from "node:fs";
import { concatBytes, displayWidth, enc, isWriteError, localeQuotedEscapedDiagnostic, nodeErrorMessage, parseOptions, readAll, readFdChunkViews, readStdinByteRecords, systemErrorMessage } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { concatOutputParts, decodeValidUtf8, isSingleByteLocale, nextUtf8Token, tabFoldDiagnosticName } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const FOLD_LONG_OPTIONS = ["bytes", "characters", "spaces", "width", "help", "version"];

export function foldMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeFoldLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!FOLD_LONG_OPTIONS.includes(name)) return null;
      if (inlineValue != null) {
        if (name !== "width") return null;
        parseFoldWidth(inlineValue);
      }
      if (option === "--help" || option === "--version") return option;
      if (name === "width" && inlineValue == null) {
        if (i + 1 >= args.length) throw new UsageError("option '--width' requires an argument", true);
        parseFoldWidth(args[i + 1]);
        i++;
      }
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    const obsoleteWidth = arg.match(/^-(\d.*)$/) ?? arg.match(/^-[bcs]+(\d.*)$/);
    if (obsoleteWidth) {
      parseFoldWidth(obsoleteWidth[1]);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "b" || ch === "c" || ch === "s") continue;
      if (ch !== "w") return null;
      if (!arg.slice(j + 1)) {
        if (i + 1 >= args.length) throw new UsageError("option requires an argument -- 'w'", true);
        parseFoldWidth(args[i + 1]);
        i++;
      } else {
        parseFoldWidth(arg.slice(j + 1));
      }
      break;
    }
  }
  return null;
}

export function normalizeFoldLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeFoldLongOption(arg));
  }
  return out;
}

export function normalizeFoldLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const matches = FOLD_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length !== 1) return arg;
  return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
}

export async function fold(args) {
  args = normalizeFoldArgs(normalizeFoldLongOptions(args));
  const { opts, operands } = parseOptions(args, { short: { b: false, c: false, w: "value", s: false }, long: { bytes: false, characters: false, width: "value", spaces: false, help: false, version: false } });
  const widthText = opts.w ?? opts.width ?? "80";
  const width = parseFoldWidth(widthText);
  const files = operands.length ? operands : ["-"];
  const mode = foldMode(args);
  if (!(opts.s || opts.spaces)) {
    let failed = false;
    for (const file of files) {
      let fd;
      try {
        fd = file === "-" ? 0 : openSync(file, "r");
        streamFoldFd(fd, width, mode);
      } catch (error) {
        if (isWriteError(error)) throw error;
        stderr(file === "-" ? `fold: ${nodeErrorMessage(error)}\n` : `fold: ${tabFoldDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
        failed = true;
      } finally {
        if (fd != null && fd !== 0) closeSync(fd);
      }
    }
    return failed ? 1 : 0;
  }
  if (files.length === 1 && files[0] === "-") {
    readStdinByteRecords(10, (record, hasSep) => {
      const bytes = hasSep ? concatBytes([record, Uint8Array.of(10)]) : record;
      stdout(foldBytes(bytes, width, mode, opts));
    });
    return 0;
  }
  const out = [];
  let failed = false;
  for (const file of files) {
    let bytes;
    try {
      bytes = await readAll(file);
    } catch (error) {
      stderr(file === "-" ? `fold: ${nodeErrorMessage(error)}\n` : `fold: ${tabFoldDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      failed = true;
      continue;
    }
    out.push(foldBytes(bytes, width, mode, opts));
  }
  stdout(concatOutputParts(out));
  return failed ? 1 : 0;
}

export function streamFoldFd(fd, width, mode) {
  const newline = Uint8Array.of(0x0a);
  const singleByteLocale = isSingleByteLocale();
  let measure = 0;
  let lineHasToken = false;
  let carry = Buffer.alloc(0);
  const process = (bytes, retainIncomplete) => {
    const output = [];
    const emit = (piece) => {
      if (piece.length) output.push(piece);
      if (output.length >= 256) {
        for (const part of output) stdout(part);
        output.length = 0;
      }
    };
    let runStart = 0;
    let index = 0;
    while (index < bytes.length) {
      const byte = bytes[index];
      if (byte === 0x0a) {
        measure = 0;
        lineHasToken = false;
        index++;
        continue;
      }
      let tokenLength = 1;
      let tokenWidth = byte === 0 ? 0 : 1;
      let tokenNext = index + 1;
      if (!singleByteLocale && byte >= 0xc2 && byte <= 0xf4) {
        const length = byte <= 0xdf ? 2 : byte <= 0xef ? 3 : 4;
        if (retainIncomplete && index + length > bytes.length) break;
        const token = nextUtf8Token(bytes, index);
        tokenLength = token.bytes.length;
        tokenWidth = token.width;
        tokenNext = token.next;
      }
      let next;
      if (mode === "bytes") next = measure + tokenLength;
      else if (mode === "characters") next = measure + 1;
      else if (tokenLength === 1 && byte === 0x08) next = Math.max(0, measure - 1);
      else if (tokenLength === 1 && byte === 0x0d) next = 0;
      else if (tokenLength === 1 && byte === 0x09) next = measure + 8 - (measure % 8);
      else if (tokenLength === 1 && byte === 0x0c) next = measure + 1;
      else next = measure + tokenWidth;
      if (lineHasToken && (next > width || (measure >= width && next !== measure))) {
        emit(bytes.subarray(runStart, index));
        emit(newline);
        runStart = index;
        measure = 0;
        lineHasToken = false;
        if (mode === "bytes") next = tokenLength;
        else if (mode === "characters") next = 1;
        else if (tokenLength === 1 && (byte === 0x08 || byte === 0x0d)) next = 0;
        else if (tokenLength === 1 && byte === 0x09) next = 8;
        else if (tokenLength === 1 && byte === 0x0c) next = 1;
        else next = tokenWidth;
      }
      measure = next;
      lineHasToken = true;
      index = tokenNext;
    }
    emit(bytes.subarray(runStart, index));
    for (const part of output) stdout(part);
    return index < bytes.length ? Buffer.from(bytes.subarray(index)) : Buffer.alloc(0);
  };
  readFdChunkViews(fd, (chunk) => {
    const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    carry = process(bytes, true);
  });
  if (carry.length) process(carry, false);
}

export function foldBytes(bytes, width, mode, opts) {
  const rawMode = isSingleByteLocale() || decodeValidUtf8(bytes) == null;
  const text = rawMode ? Buffer.from(bytes).toString("latin1") : decodeValidUtf8(bytes);
  let out = "";
  for (const raw of text.split(/(?<=\n)/)) {
    out += foldLine(raw.endsWith("\n") ? raw.slice(0, -1) : raw, raw.endsWith("\n"), width, mode, opts);
  }
  return rawMode ? Buffer.from(out, "latin1") : out;
}

export function normalizeFoldArgs(args) {
  const out = [];
  let scanning = true;
  let valueNext = false;
  for (const arg of args) {
    if (!scanning) {
      out.push(arg);
    } else if (valueNext) {
      out.push(arg);
      valueNext = false;
    } else if (arg === "-w" || arg === "--width") {
      out.push(arg);
      valueNext = true;
    } else if (/^-\d/.test(arg)) {
      out.push("-w", arg.slice(1));
    } else if (/^-[bcs]+\d/.test(arg)) {
      const match = arg.match(/^(-[bcs]+)(.*)$/);
      out.push(match[1], "-w", match[2]);
    } else {
      if (arg === "--") scanning = false;
      else if (!arg.startsWith("-")) scanning = false;
      out.push(arg);
    }
  }
  return out;
}

export function foldMode(args) {
  let mode = "columns";
  let scanning = true;
  let valueNext = false;
  for (const arg of args) {
    if (!scanning) continue;
    if (valueNext) {
      valueNext = false;
      continue;
    }
    if (arg === "--") {
      scanning = false;
    } else if (arg === "-w" || arg === "--width") {
      valueNext = true;
    } else if (arg === "--bytes") {
      mode = "bytes";
    } else if (arg === "--characters") {
      mode = "characters";
    } else if (arg.startsWith("--width=")) {
      continue;
    } else if (arg.startsWith("--")) {
      continue;
    } else if (arg.startsWith("-")) {
      for (let i = 1; i < arg.length; i++) {
        const ch = arg[i];
        if (ch === "b") mode = "bytes";
        else if (ch === "c") mode = "characters";
        else if (ch === "w") break;
      }
    } else {
      scanning = false;
    }
  }
  return mode;
}

export function parseFoldWidth(value) {
  const text = String(value);
  if (!/^\+?\d+$/.test(text)) throw new UsageError(`invalid number of columns: ${localeQuotedEscapedDiagnostic(text)}`);
  const width = BigInt(text.replace(/^\+/, ""));
  if (width <= 0n || width >= 18446744073709551610n) throw new UsageError(`invalid number of columns: ${localeQuotedEscapedDiagnostic(text)}: Numerical result out of range`);
  return width > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(width);
}

export function foldLine(line, hasNewline, width, mode, opts) {
  let out = "";
  while (foldMeasure(line, mode) > width) {
    let cut = foldCutIndex(line, width, mode);
    if (cut >= line.length) break;
    if (opts.s || opts.spaces) {
      const prefix = line.slice(0, cut);
      const space = lastFoldBlankIndex(prefix);
      if (space > 0) cut = space + 1;
    }
    out += line.slice(0, cut) + "\n";
    line = line.slice(cut);
  }
  return out + line + (hasNewline ? "\n" : "");
}

export function lastFoldBlankIndex(text) {
  let last = -1;
  for (let i = 0; i < text.length;) {
    const ch = [...text.slice(i)][0];
    if (isFoldBlank(ch)) last = i;
    i += ch.length;
  }
  return last;
}

export function isFoldBlank(ch) {
  return ch === " " || ch === "\t" || (/\p{Zs}/u.test(ch) && ch !== "\u00A0" && ch !== "\u2007");
}

export function foldMeasure(text, mode = "columns") {
  if (mode === "bytes") return enc.encode(text).byteLength;
  if (mode === "characters") return [...text].length;
  let column = 0;
  for (const ch of text) {
    if (ch === "\b") column = Math.max(0, column - 1);
    else if (ch === "\r") column = 0;
    else if (ch === "\t") column += 8 - (column % 8);
    else if (ch === "\f") column++;
    else column += displayWidth(ch);
  }
  return column;
}

export function foldCutIndex(text, width, mode = "columns") {
  if (mode === "characters") return [...text].slice(0, width).join("").length;
  if (mode === "columns") return foldColumnCutIndex(text, width);
  let bytes = 0;
  let index = 0;
  for (const ch of text) {
    const next = bytes + enc.encode(ch).byteLength;
    if (next > width) break;
    bytes = next;
    index += ch.length;
  }
  return index || [...text][0]?.length || 0;
}

export function foldColumnCutIndex(text, width) {
  let column = 0;
  let index = 0;
  for (let i = 0; i < text.length;) {
    const ch = [...text.slice(i)][0];
    let next;
    if (ch === "\b") next = Math.max(0, column - 1);
    else if (ch === "\r") next = 0;
    else if (ch === "\t") next = column + 8 - (column % 8);
    else if (ch === "\f") next = column + 1;
    else next = column + displayWidth(ch);
    if (next > width && index > 0) break;
    column = next;
    index += ch.length;
    i += ch.length;
    while (column >= width && i < text.length) {
      const trailing = [...text.slice(i)][0];
      if (foldColumnWidth(trailing, column) !== column) break;
      index += trailing.length;
      i += trailing.length;
    }
    if (column >= width) break;
  }
  return index || [...text][0]?.length || 0;
}

export function foldColumnWidth(ch, column) {
  if (ch === "\b") return Math.max(0, column - 1);
  if (ch === "\r") return 0;
  if (ch === "\t") return column + 8 - (column % 8);
  if (ch === "\f") return column + 1;
  return column + displayWidth(ch);
}

const singleCall = defineCommand("fold", fold, foldMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
