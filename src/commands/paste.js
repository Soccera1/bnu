#!/usr/bin/env bun

import { closeSync, openSync } from "node:fs";
import { isUtf8Locale, isWriteError, nodeErrorMessage, parseOptions, rawCommandArgs, readAll, readFdChunkViews, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { concatOutputParts } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const PASTE_LONG_OPTIONS = ["delimiters", "serial", "zero-terminated", "help", "version"];

export function pasteMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizePasteLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!PASTE_LONG_OPTIONS.includes(name)) return null;
      if (option === "--help" || option === "--version") return option;
      if (name === "delimiters") {
        if (inlineValue == null) i++;
      } else if (inlineValue != null) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "s" || ch === "z") continue;
      if (ch !== "d") return null;
      if (!arg.slice(j + 1)) i++;
      break;
    }
  }
  return null;
}

export function normalizePasteLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizePasteLongOption(arg));
  }
  return out;
}

export function normalizePasteLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const matches = PASTE_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length !== 1) return arg;
  return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
}

export async function paste(args) {
  const { opts, operands } = parseOptions(normalizePasteLongOptions(args), { short: { d: "value", s: false, z: false }, long: { delimiters: "value", serial: false, "zero-terminated": false, help: false, version: false } });
  const files = operands.length ? operands : ["-"];
  const recordSep = opts.z || opts["zero-terminated"] ? "\0" : "\n";
  const delimiterValue = opts.d ?? opts.delimiters ?? "\t";
  const rawDelimiter = delimiterValue.includes("\uFFFD") ? pasteReplacementDelimiterBytes(delimiterValue, args) : null;
  const delimiters = parsePasteDelimiters(delimiterValue, rawDelimiter);
  const pick = (i) => delimiters[i % delimiters.length] ?? "\t";
  const out = [];
  let failed = false;
  if (!(opts.s || opts.serial) && files.length === 1) {
    const file = files[0];
    let fd;
    try {
      fd = file === "-" ? 0 : openSync(file, "r");
      streamPasteSingleFd(fd, recordSep.charCodeAt(0));
      return 0;
    } catch (error) {
      if (isWriteError(error)) throw error;
      stderr(file === "-" ? `paste: ${nodeErrorMessage(error)}\n` : `paste: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      return 1;
    } finally {
      if (fd != null && fd !== 0) closeSync(fd);
    }
  }
  if (opts.s || opts.serial) {
    const lineSets = [];
    for (const file of files) {
      try {
        lineSets.push(splitPasteByteRecords(await readAll(file), recordSep));
      } catch (error) {
        if (error?.code === "EISDIR") lineSets.push([]);
        stderr(file === "-" ? `paste: ${nodeErrorMessage(error)}\n` : `paste: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
        failed = true;
      }
    }
    for (const lines of lineSets) {
      for (let i = 0; i < lines.length; i++) {
        if (i) out.push(pick(i - 1));
        out.push(lines[i]);
      }
      out.push(recordSep);
    }
  } else {
    const stdinRecords = files.includes("-") ? splitPasteByteRecords(await readAll("-"), recordSep) : [];
    let stdinIndex = 0;
    const lineSets = [];
    let fatalReadError = false;
    for (const file of files) {
      if (file === "-") {
        lineSets.push(null);
        continue;
      }
      try {
        lineSets.push(splitPasteByteRecords(await readAll(file), recordSep));
      } catch (error) {
        stderr(`paste: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
        lineSets.push([]);
        if (error?.code !== "EISDIR") fatalReadError = true;
        failed = true;
      }
    }
    if (fatalReadError) {
      stdout(concatOutputParts(out));
      return 1;
    }
    const maxFileRows = Math.max(0, ...lineSets.filter(Boolean).map((lines) => lines.length));
    for (let row = 0; row < maxFileRows || stdinIndex < stdinRecords.length; row++) {
      for (let col = 0; col < lineSets.length; col++) {
        const lines = lineSets[col];
        const value = lines ? lines[row] ?? "" : stdinRecords[stdinIndex++] ?? "";
        if (col) out.push(pick(col - 1));
        out.push(value);
      }
      out.push(recordSep);
    }
  }
  stdout(concatOutputParts(out));
  return failed ? 1 : 0;
}

export function streamPasteSingleFd(fd, separator) {
  let sawData = false;
  let lastByte = separator;
  readFdChunkViews(fd, (chunk) => {
    if (!chunk.length) return;
    sawData = true;
    lastByte = chunk[chunk.length - 1];
    stdout(chunk);
  });
  if (sawData && lastByte !== separator) stdout(Uint8Array.of(separator));
}

export function splitPasteByteRecords(bytes, sep) {
  const sepByte = sep === "\0" ? 0 : 0x0a;
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

export function pasteReplacementDelimiterBytes(value, args) {
  if (isUtf8Locale()) return Buffer.from(value);
  return rawPasteDelimiterBytes(args) ?? Buffer.from(value);
}

export function parsePasteDelimiters(value, rawBytes = null) {
  if (rawBytes) return parsePasteDelimiterBytes(rawBytes);
  const out = [];
  const chars = [...value];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "\\") {
      if (i + 1 >= chars.length) throw new UsageError(`delimiter list ends with an unescaped backslash: ${value}`, false);
      const ch = chars[++i];
      out.push(({ "0": "", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" })[ch] ?? ch);
    } else {
      out.push(chars[i]);
    }
  }
  return out.length ? out : [""];
}

export function parsePasteDelimiterBytes(bytes) {
  const out = [];
  const gb18030 = /gb18030/i.test(process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "");
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x5c) {
      if (i + 1 >= bytes.length) throw new UsageError(`delimiter list ends with an unescaped backslash: ${new TextDecoder().decode(bytes)}`, false);
      const next = bytes[++i];
      const escaped = ({ 0x30: "", 0x62: "\b", 0x66: "\f", 0x6e: "\n", 0x72: "\r", 0x74: "\t", 0x76: "\v", 0x5c: "\\" })[next];
      if (escaped != null) out.push(escaped);
      else if (gb18030 && next >= 0x80 && i + 1 < bytes.length) out.push(bytes.subarray(i, ++i + 1));
      else out.push(bytes.subarray(i, i + 1));
    } else if (gb18030 && byte >= 0x80 && i + 1 < bytes.length) {
      out.push(bytes.subarray(i, ++i + 1));
    } else {
      out.push(bytes.subarray(i, i + 1));
    }
  }
  return out.length ? out : [""];
}

export function rawPasteDelimiterBytes(args) {
  const rawArgs = rawCommandArgs("paste");
  if (!rawArgs) return null;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.equals(Buffer.from("-d")) || arg.equals(Buffer.from("--delimiters"))) return rawArgs[i + 1] ?? null;
    if (arg.length > 2 && arg[0] === 0x2d && arg[1] === 0x64) return arg.subarray(2);
    const eq = arg.indexOf(0x3d);
    if (arg.length > 2 && arg[0] === 0x2d && arg[1] === 0x2d) {
      const rawName = eq === -1 ? arg.subarray(2) : arg.subarray(2, eq);
      const name = new TextDecoder("ascii").decode(rawName);
      if ("delimiters".startsWith(name)) return eq === -1 ? rawArgs[i + 1] ?? null : arg.subarray(eq + 1);
    }
  }
  return null;
}

const singleCall = defineCommand("paste", paste, pasteMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
