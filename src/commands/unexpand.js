#!/usr/bin/env bun

import { closeSync, openSync } from "node:fs";
import { concatBytes, enc, isWriteError, nodeErrorMessage, parseOptions, readFdChunkViews, systemErrorMessage } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { UNEXPAND_LONG_OPTIONS, combinedTabSpec, nextTabColumn, normalizeTabArgs, normalizeTabCommandLongOptions, parseTabStops, tabCommandMetaOption } from "../shared/tabs.js";
import { nextUtf8Token, tabFoldDiagnosticName } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function unexpand(args) {
  const obsoleteTabs = args.some((arg) => /^-\d[\d,\s]*$/.test(arg));
  args = normalizeTabArgs(normalizeTabCommandLongOptions(args, UNEXPAND_LONG_OPTIONS));
  const { opts, operands } = parseOptions(args, { short: { t: "value", a: false }, long: { tabs: "value", all: false, "first-only": false, help: false, version: false } });
  let stops;
  try {
    stops = parseTabStops(combinedTabSpec(opts.tabs ?? opts.tab, opts.t), "unexpand");
  } catch (error) {
    if (obsoleteTabs && error instanceof UsageError && error.message.startsWith("tab stop is too large")) throw new UsageError("tab stop value is too large");
    throw error;
  }
  const hasExplicitTabs = opts.t != null || opts.tab != null || opts.tabs != null;
  const convertAll = Boolean(opts.a || opts.all || (hasExplicitTabs && !opts["first-only"] && !obsoleteTabs));
  const files = operands.length ? operands : ["-"];
  let failed = false;
  for (const file of files) {
    let fd;
    try {
      fd = file === "-" ? 0 : openSync(file, "r");
      streamUnexpandFd(fd, stops, convertAll);
    } catch (error) {
      if (isWriteError(error)) throw error;
      stderr(file === "-" ? `unexpand: ${nodeErrorMessage(error)}\n` : `unexpand: ${tabFoldDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      failed = true;
    } finally {
      if (fd != null && fd !== 0) closeSync(fd);
    }
  }
  return failed ? 1 : 0;
}

export function streamUnexpandFd(fd, stops, convertAll) {
  const newline = Uint8Array.of(0x0a);
  let column = 0;
  let fieldStarted = false;
  let blankStartColumn = 0;
  let blanks = [];
  let carry = Buffer.alloc(0);
  const output = [];
  const flushOutput = () => {
    for (const piece of output) stdout(piece);
    output.length = 0;
  };
  const emit = (piece) => {
    if (piece.length) output.push(piece);
    if (output.length >= 256) flushOutput();
  };
  const flushBlanks = (atEnd) => {
    if (!blanks.length) return;
    const canConvert = convertAll || !fieldStarted;
    emit(canConvert
      ? renderUnexpandedBlankTokens(blankStartColumn, column, blanks, stops, atEnd, blanks.some((token) => isAsciiByteToken(token, 0x09)), !fieldStarted)
      : concatBytes(blanks.map((token) => token.bytes)));
    blanks = [];
  };
  const addBlank = (token) => {
    if (!blanks.length) blankStartColumn = column;
    blanks.push({ ...token, bytes: Buffer.from(token.bytes) });
    column = tokenEndColumn(token, column, stops);
  };
  readFdChunkViews(fd, (chunk) => {
    const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    carry = Buffer.alloc(0);
    let runStart = -1;
    const endRun = (end) => {
      if (runStart !== -1) emit(bytes.subarray(runStart, end));
      runStart = -1;
    };
    let index = 0;
    while (index < bytes.length) {
      const byte = bytes[index];
      if (byte < 0x80) {
        if (byte === 0x0a) {
          endRun(index);
          flushBlanks(true);
          emit(newline);
          column = 0;
          fieldStarted = false;
        } else if (byte === 0x20 || byte === 0x09) {
          endRun(index);
          addBlank({ bytes: bytes.subarray(index, index + 1), char: String.fromCharCode(byte), width: byte === 0x09 ? 0 : 1 });
        } else {
          if (runStart === -1) {
            flushBlanks(false);
            runStart = index;
          }
          column = byte === 0x08 ? Math.max(0, column - 1) : column + 1;
          fieldStarted = true;
        }
        index++;
        continue;
      }
      const length = byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1;
      if (length > 1 && index + length > bytes.length) {
        endRun(index);
        carry = Buffer.from(bytes.subarray(index));
        break;
      }
      endRun(index);
      const token = nextUtf8Token(bytes, index);
      if (isUnexpandBlank(token)) addBlank(token);
      else {
        flushBlanks(false);
        emit(token.bytes);
        column = tokenEndColumn(token, column, stops);
        fieldStarted = true;
      }
      index = token.next;
    }
    endRun(bytes.length);
    flushOutput();
  });
  if (carry.length) {
    flushBlanks(false);
    emit(carry);
    fieldStarted = true;
  }
  flushBlanks(true);
  flushOutput();
}

export function isUnexpandBlank(token) {
  return isAsciiByteToken(token, 0x20) || isAsciiByteToken(token, 0x09) || (token.char != null && /\p{Zs}/u.test(token.char));
}

export function isAsciiByteToken(token, byte) {
  return token.bytes.length === 1 && token.bytes[0] === byte;
}

export function tokenEndColumn(token, column, stops) {
  if (isAsciiByteToken(token, 0x09)) return nextTabColumn(column, stops);
  if (isAsciiByteToken(token, 0x08)) return Math.max(0, column - 1);
  return column + token.width;
}

export function renderUnexpandedBlankTokens(startColumn, endColumn, run, stops, atEnd, containsTab, atFieldStart = false) {
  const original = concatBytes(run.map((token) => token.bytes));
  const originalWidth = endColumn - startColumn;
  const rendered = containsTab
    ? renderUnexpandedBlankTokenTabs(startColumn, run, stops, atEnd, atFieldStart)
    : renderUnexpandedSpaces(startColumn, endColumn, stops, atEnd, originalWidth, false, atFieldStart);
  if (!rendered.includes("\t") && run.some((token) => token.char != null && !isAsciiByteToken(token, 0x20))) return original;
  return enc.encode(rendered);
}

export function renderUnexpandedBlankTokenTabs(startColumn, run, stops, atEnd, atFieldStart = false) {
  const lastTab = run.findLastIndex((token) => isAsciiByteToken(token, 0x09));
  const prefix = run.slice(0, lastTab + 1);
  const suffix = run.slice(lastTab + 1);
  const prefixEnd = blankTokenRunEndColumn(startColumn, prefix, stops);
  const suffixEnd = blankTokenRunEndColumn(prefixEnd, suffix, stops);
  return renderUnexpandedSpaces(startColumn, prefixEnd, stops, true, prefixEnd - startColumn, true, atFieldStart)
    + renderUnexpandedSpaces(prefixEnd, suffixEnd, stops, atEnd, suffixEnd - prefixEnd, false, atFieldStart);
}

export function blankTokenRunEndColumn(startColumn, run, stops) {
  let column = startColumn;
  for (const token of run) column = tokenEndColumn(token, column, stops);
  return column;
}

export function renderUnexpandedSpaces(startColumn, endColumn, stops, atEnd, originalLength, fromTabs = false, atFieldStart = false) {
  let column = startColumn;
  let out = "";
  while (column < endColumn) {
    const next = nextTabColumn(column, stops);
    const remaining = endColumn - column;
    const width = next - column;
    const hasExplicitStop = stops.interval || stops.length === 1 || stops.some((stop) => stop > column && stop <= endColumn) || (fromTabs && width === 1);
    const finalSingleBeforeText = !atEnd && width === remaining && width === 1 && originalLength <= 1 && (!atFieldStart || stops[0] !== 1);
    const finalSingleAtEnd = atEnd && !fromTabs && width === remaining && width === 1 && originalLength <= 1;
    if (hasExplicitStop && width <= remaining && !finalSingleBeforeText && !finalSingleAtEnd) {
      out += "\t";
      column = next;
    } else {
      out += " ";
      column++;
    }
  }
  return out;
}

const singleCall = defineCommand("unexpand", unexpand, (args) => tabCommandMetaOption("unexpand", args));
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
