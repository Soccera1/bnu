#!/usr/bin/env bun

import { decodeSurrogateEscapedBytes, hasSurrogateEscapedBytes, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, nodeErrorMessage, normalizeLongOptionByPrefix, parseOptions, readAll, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, fail, stderr, stdout } from "../shared/diagnostics.js";
import { writeAll } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const PTX_LONG_OPTIONS = ["auto-reference", "break-file", "flag-truncation", "format", "ignore-case", "ignore-file", "macro-name", "only-file", "references", "right-side-refs", "sentence-regexp", "traditional", "typeset-mode", "word-regexp", "width", "gap-size", "help", "version"];

export function ptxMetaOption(args) {
  const longValueOptions = new Set(["break-file", "flag-truncation", "format", "ignore-file", "macro-name", "only-file", "sentence-regexp", "word-regexp", "width", "gap-size"]);
  const shortValueOptions = new Set(["b", "F", "M", "S", "W", "g", "i", "o", "w"]);
  const shortKnownOptions = new Set(["A", "b", "F", "G", "M", "O", "R", "S", "T", "W", "f", "g", "i", "o", "r", "t", "w"]);
  const normalized = normalizePtxLongOptions(args);
  for (let i = 0; i < normalized.length; i++) {
    const arg = normalized[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (!PTX_LONG_OPTIONS.includes(name)) return null;
      if ((arg === "--help" || arg === "--version") && inlineValue == null) return arg;
      if (longValueOptions.has(name)) {
        const value = inlineValue ?? normalized[i + 1];
        if (value !== undefined) validatePtxMetaOptionValue(name, value);
        if (inlineValue == null) i++;
      } else if (inlineValue != null) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        const value = inlineValue === "" ? normalized[i + 1] : inlineValue;
        validatePtxMetaShortValue(ch, value);
        if (inlineValue === "") i++;
        break;
      }
    }
  }
  return null;
}

export function validatePtxMetaOptionValue(name, value) {
  if (name === "format") parsePtxFormat(value);
  if (name === "width") parsePtxPositiveInteger(value, "line width");
  if (name === "gap-size") parsePtxPositiveInteger(value, "gap width");
}

export function validatePtxMetaShortValue(ch, value) {
  if (value === undefined) return;
  if (ch === "w") validatePtxMetaOptionValue("width", value);
  else if (ch === "g") validatePtxMetaOptionValue("gap-size", value);
}

export function normalizePtxLongOptions(args) {
  const out = [];
  const valueOptions = new Set(["break-file", "flag-truncation", "format", "ignore-file", "macro-name", "only-file", "sentence-regexp", "word-regexp", "width", "gap-size"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      out.push(arg, ...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      out.push(arg);
      continue;
    }
    const normalized = normalizeLongOptionByPrefix(arg, PTX_LONG_OPTIONS);
    out.push(normalized);
    const [name, inlineValue] = normalized.slice(2).split(/=(.*)/s, 2);
    if (valueOptions.has(name) && inlineValue == null && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

export async function ptx(args) {
  args = normalizePtxLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { A: false, b: "value", F: "value", G: false, M: "value", O: false, R: false, S: "value", T: false, W: "value", f: false, g: "value", i: "value", o: "value", r: false, t: false, w: "value" }, long: { "auto-reference": false, "break-file": "value", "flag-truncation": "value", format: "value", "ignore-case": false, "ignore-file": "value", "macro-name": "value", "only-file": "value", "right-side-refs": false, "sentence-regexp": "value", "typeset-mode": false, "word-regexp": "value", references: false, traditional: false, width: "value", "gap-size": "value", help: false, version: false } });
  const traditional = opts.G || opts.traditional;
  const output = traditional && operands.length > 1 ? operands[1] : null;
  if (output != null) {
    const status = await writePtxOutput(output, "");
    if (status !== 0) return status;
  }
  if (traditional && operands.length > 2) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[2])}`, true);
  const files = traditional ? [operands[0] ?? "-"] : (operands.length ? operands : ["-"]);
  const ignoreCase = opts.f || opts["ignore-case"];
  let ignoreWords;
  let onlyWords;
  let breakCharacters = null;
  try {
    ignoreWords = await readPtxWordList(opts.i ?? opts["ignore-file"], ignoreCase);
    onlyWords = await readPtxWordList(opts.o ?? opts["only-file"], ignoreCase);
    const breakFile = opts.b ?? opts["break-file"];
    if (breakFile) breakCharacters = decodeSurrogateEscapedBytes(await readAll(breakFile));
  } catch (error) {
    const file = error.file ?? (opts.b ?? opts["break-file"]);
    stderr(`ptx: ${file ? `${textInputDiagnosticName(file)}: ` : ""}${systemErrorMessage(error)}\n`);
    return 1;
  }
  const format = opts.O ? "roff" : opts.T ? "tex" : traditional ? "roff" : opts.format == null ? undefined : parsePtxFormat(opts.format);
  const macroName = opts.M ?? opts["macro-name"] ?? "xx";
  const width = parsePtxPositiveInteger(opts.w ?? opts.width ?? (opts.t || opts["typeset-mode"] || opts.G || opts.traditional ? "100" : "72"), "line width");
  const gap = parsePtxPositiveInteger(opts.g ?? opts["gap-size"] ?? "3", "gap width");
  const truncation = opts.F ?? opts["flag-truncation"] ?? "/";
  let sentenceRegex = null;
  if (opts.S || opts["sentence-regexp"]) {
    const sentence = opts.S ?? opts["sentence-regexp"];
    try {
      sentenceRegex = new RegExp(sentence, "gu");
      if (sentenceRegex.test("")) {
        stderr("ptx: regular expression has length zero\n");
        return 1;
      }
    } catch {}
  }
  let wordRegex;
  try {
    wordRegex = opts.W || opts["word-regexp"]
      ? new RegExp(opts.W ?? opts["word-regexp"], "gu")
      : breakCharacters == null ? /[\p{L}\p{N}_]+/gu : ptxBreakCharacterRegex(breakCharacters);
  } catch {
    return 0;
  }
  const rows = [];
  const texts = [];
  const manualReferences = opts.r || opts.references;
  for (const file of files) {
    let text;
    try {
      text = decodeSurrogateEscapedBytes(await readAll(file));
    } catch (error) {
      stderr(file === "-" ? `ptx: ${nodeErrorMessage(error)}\n` : `ptx: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      return 1;
    }
    if (manualReferences) {
      const prepared = ptxExtractLineReferences(text, wordRegex);
      for (let line = 0; line < prepared.records.length; line++) {
        texts.push({ file, text: prepared.records[line].text, references: [prepared.records[line].reference], lineOffset: line });
      }
    } else {
      for (const record of ptxSplitSentences(text, sentenceRegex)) {
        texts.push({ file, text: record.text, references: [], lineOffset: record.lineOffset });
      }
    }
  }
  for (const { file, text, references, lineOffset } of texts) {
    const tokens = [];
    for (const match of text.matchAll(wordRegex)) {
      const word = match[0];
      const key = ignoreCase ? word.toLowerCase() : word;
      const recordLine = text.slice(0, match.index).split("\n").length;
      const line = recordLine + lineOffset;
      const automaticReference = opts.A || opts["auto-reference"];
      const autoReference = automaticReference ? `${file === "-" ? "" : file}:${line}:` : (references[recordLine - 1] ?? "");
      const referencePadding = automaticReference ? 1 : Math.max(0, 3 - autoReference.length);
      tokens.push({ word, key, indexed: !ignoreWords.has(key) && (!onlyWords.size || onlyWords.has(key)), start: match.index, end: match.index + word.length, source: text, autoReference, referencePadding });
    }
    for (let index = 0; index < tokens.length; index++) {
      if (!tokens[index].indexed) continue;
      rows.push({ tokens, index, key: tokens[index].key, order: index });
    }
  }
  rows.sort((a, b) => comparePtxKeys(a.key, b.key) || a.order - b.order);
  const out = rows.map((row) => renderPtxRow(row, { format, width, gap, macroName, truncation, rightSideRefs: opts.R || opts["right-side-refs"] })).join("");
  if (output != null) return await writePtxOutput(output, out);
  else stdout(out);
  return 0;
}

export async function writePtxOutput(file, text) {
  try {
    await writeAll(file, text);
    return 0;
  } catch (error) {
    return fail("ptx", `${file}: ${systemErrorMessage(error)}`);
  }
}

export function comparePtxKeys(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length;
}

export function renderPtxRow(row, opts) {
  const token = row.tokens[row.index];
  const keyword = token.word;
  const minWidth = opts.gap <= 1 ? 2 : 6;
  const halfWidth = Math.floor(Math.max(opts.width, minWidth) / 2);
  const source = token.source;
  if (source != null && hasSurrogateEscapedBytes(source)) {
    const before = source.slice(0, token.start).replace(/\n$/u, "").trimEnd();
    const after = source.slice(token.end).replace(/\n$/u, "").trimEnd();
    if (before) return ptxApplyAutoReference(`${" ".repeat(Math.max(0, halfWidth - before.length))}${before}${" ".repeat(opts.gap)}${keyword}${after}\n`, token.autoReference, opts, token.referencePadding);
    return ptxApplyAutoReference(`${" ".repeat(halfWidth + opts.gap)}${keyword}${after}\n`, token.autoReference, opts, token.referencePadding);
  }
  const wrap = ptxWrapContext(row, source);
  const before = wrap.before;
  const after = wrap.after;
  const rightStartsWithPunctuation = /^[^\s\p{L}\p{N}_]/u.test(source.slice(token.end));
  const right = after ? `${rightStartsWithPunctuation ? "" : " "}${after}` : "";
  const initialSentenceIndent = before === "" && /^\s/u.test(source) ? 1 : 0;
  if (opts.format === "roff") return ptxApplyAutoReference(`.${opts.macroName ?? "xx"} "${wrap.beforeRef}" "${before}" "${keyword}${right}" "${wrap.afterRef}"\n`, token.autoReference, opts, token.referencePadding);
  if (opts.format === "tex") return ptxApplyAutoReference(`\\xx {${wrap.beforeRef}}{${before}}{${keyword}}{${right}}{${wrap.afterRef}}\n`, token.autoReference, opts, token.referencePadding);
  const fitted = opts.width >= 20 && opts.width < 24 ? renderPtxFittedRow(row, { ...opts, halfWidth, keyword }) : null;
  if (fitted) return ptxApplyAutoReference(fitted, token.autoReference, opts, token.referencePadding);
  if (wrap.beforeRef) {
    const prefixLead = opts.gap;
    const leftText = before
      ? `${" ".repeat(prefixLead)}${wrap.beforeRef}${" ".repeat(Math.max(1, halfWidth - wrap.beforeRef.length - before.length - prefixLead))}${before}`
      : `${" ".repeat(prefixLead)}${wrap.beforeRef}${" ".repeat(Math.max(0, halfWidth - wrap.beforeRef.length - prefixLead))}`;
    return ptxApplyAutoReference(`${leftText}${" ".repeat(opts.gap)}${keyword}${right}\n`, token.autoReference, opts, token.referencePadding);
  }
  if (before) {
    const spaces = Math.max(0, halfWidth - before.length);
    const full = `${" ".repeat(spaces)}${before}${" ".repeat(opts.gap)}${keyword}${right}`;
    if (wrap.afterRef) return ptxApplyAutoReference(`${full}${" ".repeat(Math.max(1, opts.width + opts.gap - full.length - wrap.afterRef.length))}${wrap.afterRef}\n`, token.autoReference, opts, token.referencePadding);
    if (before.length + opts.gap + keyword.length <= halfWidth + 1) return ptxApplyAutoReference(`${full}\n`, token.autoReference, opts, token.referencePadding);
    return ptxApplyAutoReference(`${" ".repeat(halfWidth)}/${" ".repeat(opts.gap)}${keyword}${right}\n`, token.autoReference, opts, token.referencePadding);
  }
  const full = `${" ".repeat(halfWidth + opts.gap + initialSentenceIndent)}${keyword}${right}`;
  if (wrap.afterRef) return ptxApplyAutoReference(`${full}${" ".repeat(Math.max(1, opts.width + opts.gap - full.length - wrap.afterRef.length))}${wrap.afterRef}\n`, token.autoReference, opts, token.referencePadding);
  if (!right || halfWidth >= keyword.length + right.length + 2) return ptxApplyAutoReference(`${full}\n`, token.autoReference, opts, token.referencePadding);
  return ptxApplyAutoReference(`${" ".repeat(halfWidth + opts.gap + initialSentenceIndent)}${keyword}/\n`, token.autoReference, opts, token.referencePadding);
}

export function ptxApplyAutoReference(line, reference, opts = {}, referencePadding = 1) {
  if (!reference) return line;
  const newline = line.endsWith("\n") ? "\n" : "";
  const body = newline ? line.slice(0, -1) : line;
  if (opts.rightSideRefs) {
    const displayReference = reference.endsWith(":") ? reference.slice(0, -1) : reference;
    const leading = body.match(/^ */)?.[0].length ?? 0;
    return `${body.slice(Math.min(leading, opts.gap)).padEnd(opts.width + opts.gap)}${displayReference}${newline}`;
  }
  const leading = body.match(/^ */)?.[0].length ?? 0;
  return `${reference}${body.slice(Math.min(leading, reference.length + referencePadding))}${newline}`;
}

export function ptxExtractLineReferences(text, wordRegex) {
  const references = [];
  const lines = String(text).split(/(?<=\n)/u);
  const records = lines.map((line) => {
    const first = [...line.matchAll(wordRegex)][0];
    if (!first) {
      references.push("");
      return { text: line, reference: "" };
    }
    references.push(first[0]);
    return { text: `${line.slice(0, first.index)}${line.slice(first.index + first[0].length).replace(/^[ \t]*/u, "")}`, reference: first[0] };
  });
  return { records, references };
}

export function ptxSplitSentences(text, sentenceRegex) {
  if (!sentenceRegex) return [{ text, lineOffset: 0 }];
  const records = [];
  let start = 0;
  let lineOffset = 0;
  sentenceRegex.lastIndex = 0;
  for (const match of text.matchAll(sentenceRegex)) {
    const end = match.index + match[0].length;
    if (end <= start) continue;
    records.push({ text: text.slice(start, end), lineOffset });
    lineOffset += (text.slice(start, end).match(/\n/gu) ?? []).length;
    start = end;
  }
  if (start < text.length || records.length === 0) records.push({ text: text.slice(start), lineOffset });
  return records;
}

export function ptxBreakCharacterRegex(characters) {
  const escaped = [...new Set([...String(characters), "\n"])].map((character) => character.replace(/[\\\]\[\-^]/gu, "\\$&")).join("");
  return new RegExp(`[^${escaped}]+`, "gu");
}

export function ptxWrapContext(row, source) {
  const token = row.tokens[row.index];
  let before = ptxContextText(source.slice(0, token.start));
  let after = ptxContextText(source.slice(token.end));
  let beforeRef = "";
  let afterRef = "";
  const hasRecordBreak = source.replace(/\n+$/u, "").includes("\n");
  if (!hasRecordBreak || row.tokens.length < 2) return { before, after, beforeRef, afterRef };
  const first = row.tokens[0].word;
  const last = row.tokens.at(-1).word;
  if (row.index === row.tokens.length - 1) {
    before = ptxRemoveFirstWord(before);
    afterRef = first;
  } else if (row.index === 0) {
    beforeRef = last;
    after = ptxRemoveLastWord(after);
  } else if (row.index === 1 && source.slice(token.end).includes("\n")) {
    beforeRef = last;
    after = ptxRemoveLastWord(after);
  }
  return { before, after, beforeRef, afterRef };
}

export function ptxRemoveFirstWord(text) {
  return String(text).trim().replace(/^\S+\s*/u, "");
}

export function ptxRemoveLastWord(text) {
  return String(text).trim().replace(/\s*\S+$/u, "");
}

export function renderPtxFittedRow(row, opts) {
  const index = row.index;
  const left = ptxFittedLeftContext(row.tokens.slice(0, index).map((token) => token.word), opts.halfWidth, opts.truncation);
  const keyafterWidth = opts.halfWidth - 2 * opts.truncation.length;
  const right = ptxFittedRightContext(row.tokens.slice(index + 1).map((token) => token.word), keyafterWidth - opts.keyword.length, opts.truncation);
  const hasSourceContext = left || right;
  if (!hasSourceContext) return null;
  const markerPadding = left === opts.truncation && opts.truncation.length > 1 ? 1 : 0;
  const leftPad = left ? Math.max(0, opts.halfWidth - left.length + markerPadding) : opts.halfWidth + opts.gap;
  const gap = left ? " ".repeat(opts.gap) : "";
  return `${" ".repeat(leftPad)}${left}${gap}${opts.keyword}${right}\n`;
}

export function ptxFittedLeftContext(words, halfWidth, truncation = "/") {
  if (!words.length) return "";
  if (truncation.length > 1) return truncation;
  const all = words.join(" ");
  if (words.length === 1 && all.length <= halfWidth) return all;
  if (all.length <= halfWidth - Math.max(1, truncation.length + 4)) return all;
  const nearest = words.at(-1);
  if (!nearest) return "";
  const truncated = `${truncation}${nearest}`;
  if (truncated.length <= halfWidth) return truncated;
  return truncation;
}

export function ptxFittedRightContext(words, available, truncation = "/") {
  if (!words.length) return "";
  if (available <= 0) return truncation;
  const out = [];
  let used = 0;
  for (const word of words) {
    const extra = (out.length ? 1 : 1) + word.length;
    if (used + extra > available) break;
    out.push(word);
    used += extra;
  }
  if (!out.length) return truncation;
  return ` ${out.join(" ")}${out.length < words.length ? truncation : ""}`;
}

export function ptxContextText(text) {
  return String(text).trim().replace(/\s+/gu, " ");
}

export function parsePtxPositiveInteger(value, name) {
  const text = String(value);
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n || BigInt(text) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UsageError(`invalid ${name}: ${localeQuotedEscapedDiagnostic(text)}`);
  }
  return Number(text);
}

export function parsePtxFormat(value) {
  const text = String(value);
  const matches = ["roff", "tex"].filter((format) => format.startsWith(text));
  if (matches.length === 1 && text !== "") return matches[0];
  const kind = text === "" || matches.length > 1 ? "ambiguous" : "invalid";
  throw new UsageError(`${kind} argument ${localeQuotedEscapedDiagnostic(text)} for ${localeQuotedDiagnostic("--format")}\nValid arguments are:\n  - ${localeQuotedDiagnostic("roff")}\n  - ${localeQuotedDiagnostic("tex")}`, true);
}

export async function readPtxWordList(file, ignoreCase = false) {
  if (!file) return new Set();
  let bytes;
  try {
    bytes = await readAll(file);
  } catch (error) {
    error.file = file;
    throw error;
  }
  const text = decodeSurrogateEscapedBytes(bytes);
  return new Set((text.match(/[\p{L}\p{N}_]+/gu) ?? []).map((word) => ignoreCase ? word.toLowerCase() : word));
}

const singleCall = defineCommand("ptx", ptx, ptxMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
