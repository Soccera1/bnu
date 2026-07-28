#!/usr/bin/env bun

import { fstatSync, readSync } from "node:fs";
import { concatBytes, enc, nodeErrorMessage, parseOptions, pathDisplayName, readAll, shellEscapeLsName, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { decodeValidUtf8, fdIsSeekable, isSingleByteLocale, spoolInputToTemporaryFile, tacRegexPattern } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const TAC_LONG_OPTIONS = ["before", "regex", "separator", "help", "version"];

export function tacMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeTacLongOption(arg);
      const name = option.slice(2).split("=", 1)[0];
      if (!TAC_LONG_OPTIONS.includes(name)) return null;
      if (option.includes("=")) return null;
      if (option === "--help" || option === "--version") return option;
      if (name === "separator") i++;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "b" || ch === "r") continue;
      if (ch !== "s") return null;
      if (!arg.slice(j + 1)) i++;
      break;
    }
  }
  return null;
}

export function normalizeTacLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeTacLongOption(arg));
  }
  return out;
}

export function normalizeTacLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const matches = TAC_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length !== 1) return arg;
  return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
}

export async function tac(args) {
  const { opts, operands } = parseOptions(normalizeTacLongOptions(args), { short: { b: false, r: false, s: "value" }, long: { before: false, regex: false, separator: "value", help: false, version: false } });
  const sep = opts.s ?? opts.separator ?? "\n";
  const before = opts.b || opts.before;
  const regex = opts.r || opts.regex;
  if (regex && sep === "") throw new UsageError("separator cannot be empty");
  const files = operands.length ? operands : ["-"];
  const out = [];
  let failed = false;
  const cacheStdin = files.filter((file) => file === "-").length > 1 && stdinIsSeekable();
  let stdinBytes = null;
  for (const file of files) {
    let bytes;
    try {
      if (file === "-") {
        if (cacheStdin) {
          stdinBytes ??= await tacReadStdin();
          bytes = stdinBytes;
        } else {
          bytes = await tacReadStdin();
        }
      } else {
        bytes = await readAll(file);
      }
    } catch (error) {
      const message = error?.code === "EISDIR" || (file === "-" && error?.code === "EBADF")
        ? `${tacInputDiagnosticName(file)}: read error: ${systemErrorMessage(error)}`
        : file === "-"
          ? nodeErrorMessage(error)
          : `failed to open ${shellEscapeLsName(pathDisplayName(file), true)} for reading: ${systemErrorMessage(error)}`;
      stderr(`tac: ${message}\n`);
      failed = true;
      continue;
    }
    if (regex) {
      const decoded = isSingleByteLocale() ? null : decodeValidUtf8(bytes);
      const text = decoded ?? Buffer.from(bytes).toString("latin1");
      const result = tacRegexRecords(text, sep, before).join("");
      out.push(decoded == null ? Buffer.from(result, "latin1") : enc.encode(result));
    } else {
      out.push(tacBytes(bytes, sep, before));
    }
  }
  stdout(concatBytes(out));
  return failed ? 1 : 0;
}

export async function tacReadStdin() {
  if (process.env.BNU_STDIN_CLOSED === "1") {
    const error = new Error("Bad file descriptor");
    error.code = "EBADF";
    throw error;
  }
  fstatSync(0);
  if (stdinIsSeekable()) return readAll("-");
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const inMemoryLimit = 1024 * 1024;
  let total = 0;
  while (total <= inMemoryLimit) {
    const n = readSync(0, buffer, 0, buffer.length, null);
    if (n === 0) return concatBytes(chunks);
    chunks.push(Buffer.from(buffer.subarray(0, n)));
    total += n;
  }
  const spool = await spoolInputToTemporaryFile("-", "bnu-tac", chunks);
  try {
    return await readAll(spool.path);
  } finally {
    await spool.cleanup();
  }
}

export function tacInputDiagnosticName(file) {
  return file === "-" ? "'standard input'" : textInputDiagnosticName(file);
}

export function tacBytes(bytes, sep, before = false) {
  return concatBytes(tacByteRecords(bytes, tacSeparatorBytes(sep), before).reverse());
}

export function tacByteRecords(bytes, sep, before = false) {
  if (bytes.byteLength === 0) return [];
  const delimiter = sep.byteLength === 0 ? Uint8Array.of(0) : sep;
  const matches = byteSeparatorMatches(bytes, delimiter);
  const records = [];
  let start = 0;
  for (const match of matches) {
    if (before) {
      records.push(bytes.slice(start, match.start));
      start = match.start;
    } else {
      records.push(bytes.slice(start, match.end));
      start = match.end;
    }
  }
  if (start < bytes.length) records.push(bytes.slice(start));
  return records.filter((record) => record.byteLength !== 0);
}

export function tacSeparatorBytes(sep) {
  const text = String(sep);
  if (text === "\uFFFD") return Uint8Array.of(0xe9);
  if (text === "\uFFFD\uFFFD") return Uint8Array.of(0xe9, 0xea);
  return enc.encode(text);
}

export function byteSeparatorMatches(bytes, sep) {
  const matches = [];
  for (let i = 0; i <= bytes.byteLength - sep.byteLength;) {
    let found = true;
    for (let j = 0; j < sep.byteLength; j++) {
      if (bytes[i + j] !== sep[j]) {
        found = false;
        break;
      }
    }
    if (found) {
      matches.push({ start: i, end: i + sep.byteLength });
      i += sep.byteLength;
    } else {
      i++;
    }
  }
  return matches;
}

export function tacRecords(text, sep, before = false, regex = false) {
  if (text === "") return [];
  const matches = tacSeparatorMatches(text, sep === "" && !regex ? "\0" : sep, regex);
  const records = [];
  let start = 0;
  for (const match of matches) {
    if (before) {
      records.push(text.slice(start, match.start));
      start = match.start;
    } else {
      records.push(text.slice(start, match.end));
      start = match.end;
    }
  }
  if (start < text.length) records.push(text.slice(start));
  return records.filter((record) => record !== "");
}

export function tacSeparatorMatches(text, sep, regex = false) {
  if (!regex) {
    const matches = [];
    let start = 0;
    let index;
    while ((index = text.indexOf(sep, start)) !== -1) {
      matches.push({ start: index, end: index + sep.length });
      start = index + sep.length;
    }
    return matches;
  }
  let pattern;
  try {
    pattern = new RegExp(tacRegexPattern(sep), "gm");
  } catch {
    throw new UsageError("Invalid regular expression");
  }
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

export function tacRegexRecords(text, sep, before = false) {
  if (text === "") return [];
  const source = tacRegexPattern(sep);
  let pattern;
  let endPattern;
  try {
    pattern = new RegExp(source, "gm");
    endPattern = new RegExp(`(?:${source})(?![\\s\\S])`, "m");
  } catch {
    throw new UsageError("Invalid regular expression");
  }
  const ending = tacRegexMatchEndingAt(endPattern, text, text.length);
  if (!ending || ending.start === ending.end) return tacRecords(text, sep, before, true).reverse();
  const fallbackRecords = () => tacRecords(text, sep, before, true).reverse();
  const records = [];
  let cursor = text.length;
  while (cursor > 0) {
    const match = tacRegexMatchEndingAt(endPattern, text, cursor);
    if (!match || match.start === match.end) {
      records.push(text.slice(0, cursor));
      break;
    }
    if (match.start > 0 && !tacRegexMatchEndingAt(endPattern, text, match.start)) {
      if (records.length === 0) return fallbackRecords();
      records.push(text.slice(0, cursor));
      break;
    }
    records.push(text.slice(match.start, cursor));
    cursor = match.start;
  }
  return records.filter((record) => record !== "");
}

export function tacRegexMatchEndingAt(pattern, text, end) {
  pattern.lastIndex = 0;
  const slice = text.slice(0, end);
  const match = pattern.exec(slice);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

export function stdinIsSeekable() {
  return fdIsSeekable(0);
}

const singleCall = defineCommand("tac", tac, tacMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
