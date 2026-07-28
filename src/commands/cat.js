#!/usr/bin/env bun

import { closeSync, openSync, readSync } from "node:fs";
import { stat } from "node:fs/promises";
import { SEEK_CUR, fdStat, isWriteError, libc, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions, readAll, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { fail, stderr, stdout } from "../shared/diagnostics.js";
import { concatOutputParts, decodeValidUtf8, isSingleByteLocale } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const F_GETFL = 3;

export const O_APPEND = 0o2000;

export const CAT_LONG_OPTIONS = ["number-nonblank", "number", "squeeze-blank", "show-nonprinting", "show-ends", "show-tabs", "show-all", "help", "version"];

export function catMetaOption(args) {
  const shortKnownOptions = new Set(["n", "b", "s", "e", "t", "u", "v", "E", "T", "A"]);
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeCatLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!CAT_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) if (!shortKnownOptions.has(arg[j])) return null;
  }
  return null;
}

export async function cat(args) {
  args = normalizeCatLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { n: false, b: false, s: false, e: false, t: false, u: false, v: false, E: false, T: false, A: false }, long: { "number": false, "number-nonblank": false, "squeeze-blank": false, "show-ends": false, "show-tabs": false, "show-nonprinting": false, "show-all": false, help: false, version: false } });
  const files = operands.length ? operands : ["-"];
  const selfError = await catSelfOutputError(files);
  if (selfError) return selfError;
  const needsProcessing = opts.n || opts.number || opts.b || opts["number-nonblank"] || opts.s || opts["squeeze-blank"] || hasCatRendering(opts);
  const needsLineState = opts.n || opts.number || opts.b || opts["number-nonblank"] || opts.s || opts["squeeze-blank"];
  if (files.length === 1 && files[0] === "-" && !needsLineState && hasCatRendering(opts)) {
    streamRenderedCatStdin(opts);
    return 0;
  }
  if (!needsProcessing) {
    let failed = false;
    for (const file of files) {
      try {
        streamCatFile(file);
      } catch (error) {
        if (isWriteError(error)) throw error;
        stderr(`cat: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
        failed = true;
      }
    }
    return failed ? 1 : 0;
  }
  let line = 1;
  let previousBlank = false;
  const out = [];
  let failed = false;
  const inputChunks = [];
  for (const file of files) {
    let bytes;
    try {
      // Bun.file('.').arrayBuffer() currently treats a directory as an empty
      // file on some platforms.  cat must instead report the POSIX read
      // failure, just as it does for every other directory operand.
      if (file !== "-" && (await stat(file)).isDirectory()) {
        const error = new Error("Is a directory");
        error.code = "EISDIR";
        throw error;
      }
      bytes = await readAll(file);
    } catch (error) {
      stderr(`cat: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      failed = true;
      continue;
    }
    if (!needsProcessing) {
      out.push(bytes);
      continue;
    }
    inputChunks.push(Buffer.from(bytes));
  }
  if (needsProcessing && inputChunks.length) {
    const bytes = Buffer.concat(inputChunks);
    const decoded = isSingleByteLocale() ? null : decodeValidUtf8(bytes);
    const rawMode = decoded == null;
    const text = rawMode ? Buffer.from(bytes).toString("latin1") : decoded;
    const parts = text.split(/(?<=\n)/);
    for (const part of parts) {
      if (part === "") continue;
      const blank = part === "\n";
      if ((opts.s || opts["squeeze-blank"]) && blank && previousBlank) continue;
      previousBlank = blank;
      const numberNonblank = opts.b || opts["number-nonblank"];
      const numberAll = !numberNonblank && (opts.n || opts.number);
      if ((numberAll || (numberNonblank && !blank))) out.push(`${String(line++).padStart(6)}\t`);
      const rendered = renderCat(part, opts);
      out.push(rawMode ? Buffer.from(rendered, "latin1") : rendered);
    }
  }
  stdout(concatOutputParts(out));
  return failed ? 1 : 0;
}

export function streamCatFile(path) {
  const fd = path === "-" ? 0 : openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      stdout(buffer.subarray(0, n));
    }
  } finally {
    if (fd !== 0) closeSync(fd);
  }
}

export async function catSelfOutputError(files) {
  const out = fdStat(1);
  if (!out) return 0;
  const inStat = fdStat(0);
  const append = (libc.symbols.fcntl(1, F_GETFL) & O_APPEND) !== 0;
  if (append && inStat && sameFileStat(out, inStat) && fdPosition(0) < inStat.size) return fail("cat", "input file is output file");
  for (let i = 0; i < files.length; i++) {
    if (files[i] === "-") continue;
    const s = await stat(files[i]).catch(() => null);
    if (!s || !sameFileStat(out, s)) continue;
    if (append || i > 0) return fail("cat", `${files[i]}: input file is output file`);
  }
  return 0;
}

export function normalizeCatLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, CAT_LONG_OPTIONS);
}

export function normalizeCatLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, CAT_LONG_OPTIONS);
}

export function sameFileStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function fdPosition(fd) {
  const position = libc.symbols.lseek(fd, 0n, SEEK_CUR);
  return position < 0 ? 0 : Number(position);
}

export function streamRenderedCatStdin(opts) {
  const decoder = new TextDecoder();
  const state = { pendingCR: false };
  const buffer = Buffer.alloc(1);
  let out = "";
  while (true) {
    const n = readSync(0, buffer, 0, 1, null);
    if (n === 0) break;
    out += renderCatStreamText(decoder.decode(buffer.subarray(0, n), { stream: true }), opts, state);
    if (out.includes("\n")) {
      stdout(out);
      out = "";
    }
  }
  out += renderCatStreamText(decoder.decode(), opts, state);
  if (state.pendingCR) out += renderCatChar("\r", opts);
  if (out) stdout(out);
}

export function hasCatRendering(opts) {
  return Boolean(opts.A || opts["show-all"] || opts.e || opts.E || opts["show-ends"] || opts.t || opts.T || opts["show-tabs"] || opts.v || opts["show-nonprinting"]);
}

export function renderCatStreamText(text, opts, state) {
  let out = "";
  const showAll = opts.A || opts["show-all"];
  const showEnds = showAll || opts.e || opts.E || opts["show-ends"];
  for (const ch of text) {
    if (state.pendingCR) {
      if (showEnds && ch === "\n") {
        out += "^M$\n";
        state.pendingCR = false;
        continue;
      }
      out += renderCatChar("\r", opts);
      state.pendingCR = false;
    }
    if (ch === "\r") state.pendingCR = true;
    else out += renderCatChar(ch, opts);
  }
  return out;
}

export function renderCat(text, opts) {
  const showAll = opts.A || opts["show-all"];
  const showEnds = showAll || opts.e || opts.E || opts["show-ends"];
  const showTabs = showAll || opts.t || opts.T || opts["show-tabs"];
  const showNonprinting = showAll || opts.e || opts.t || opts.v || opts["show-nonprinting"];
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") out += showEnds ? "$\n" : "\n";
    else if (showEnds && ch === "\r" && text[i + 1] === "\n") out += "^M";
    else out += renderCatChar(ch, opts);
  }
  return out;
}

export function renderCatChar(ch, opts) {
  const showAll = opts.A || opts["show-all"];
  const showTabs = showAll || opts.t || opts.T || opts["show-tabs"];
  const showNonprinting = showAll || opts.e || opts.t || opts.v || opts["show-nonprinting"];
  if (ch === "\n") return (showAll || opts.e || opts.E || opts["show-ends"]) ? "$\n" : "\n";
  if (ch === "\t") return showTabs ? "^I" : "\t";
  return showNonprinting ? renderNonprinting(ch.codePointAt(0)) : ch;
}

export function renderNonprinting(code) {
  if (code < 32) return `^${String.fromCharCode(code + 64)}`;
  if (code === 127) return "^?";
  if (code >= 128 && code < 256) {
    const low = code - 128;
    if (low < 32) return `M-^${String.fromCharCode(low + 64)}`;
    if (low === 127) return "M-^?";
    return `M-${String.fromCharCode(low)}`;
  }
  return String.fromCodePoint(code);
}

const singleCall = defineCommand("cat", cat, catMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
