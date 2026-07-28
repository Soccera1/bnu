#!/usr/bin/env bun

import { closeSync, openSync } from "node:fs";
import { concatBytes, enc, gb18030Units, inRanges, isGb18030Locale, isUtf8Continuation, isWriteError, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, nodeErrorMessage, parseOptions, rawCommandArgs, readAll, readFdByteRecords, readFdChunkViews, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { isSingleByteLocale } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const CUT_LONG_OPTIONS = ["bytes", "characters", "complement", "delimiter", "fields", "no-partial", "only-delimited", "output-delimiter", "whitespace-delimited", "zero-terminated", "help", "version"];

export function cutMetaOption(args) {
  const longValueOptions = new Set(["bytes", "characters", "delimiter", "fields", "output-delimiter"]);
  const longOptionalValueOptions = new Set(["whitespace-delimited"]);
  const shortValueOptions = new Set(["b", "c", "d", "f", "F", "O"]);
  const shortKnownOptions = new Set(["b", "c", "d", "f", "F", "n", "O", "s", "w", "z"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeCutLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!CUT_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (name === "whitespace-delimited" && inlineValue != null) normalizeCutWhitespaceDelimitedOption(inlineValue);
      if (name === "delimiter") validateCutMetaOptionValue(name, inlineValue ?? args[i + 1]);
      if (inlineValue == null && longValueOptions.has(name)) i++;
      else if (inlineValue == null && longOptionalValueOptions.has(name)) continue;
      else if (inlineValue != null && !longValueOptions.has(name) && !longOptionalValueOptions.has(name)) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        validateCutMetaOptionValue(ch, inlineValue === "" ? args[i + 1] : inlineValue);
        if (inlineValue === "") i++;
        break;
      }
    }
  }
  return null;
}

export function validateCutMetaOptionValue(name, value) {
  if (value === undefined || name !== "d" && name !== "delimiter") return;
  const delimiter = normalizeCutQuotedValue(value);
  if (delimiter === "") return;
  const rawDelimiter = isGb18030Locale() || shouldUseRawCutDelimiter(delimiter) ? rawCutOptionValue(["d"], ["delimiter"]) : null;
  if (rawDelimiter != null && isGb18030Locale()) {
    if (gb18030Units(rawDelimiter).length !== 1) throw new UsageError("the delimiter must be a single character", true);
    return;
  }
  if (rawDelimiter != null && delimiter.includes("\uFFFD")) {
    if (rawDelimiter.length !== 1) throw new UsageError("the delimiter must be a single character", true);
    return;
  }
  if ([...delimiter].length !== 1 || (isSingleByteLocale() && delimiter !== "\uFFFD" && enc.encode(delimiter).length > 1)) {
    throw new UsageError("the delimiter must be a single character", true);
  }
}

export function readRanges(spec, mode = "bytes") {
  if (String(spec).startsWith("--")) throw new UsageError(mode === "fields" ? "invalid field range" : "invalid byte or character range", true);
  const ranges = [];
  for (const part of spec.split(",")) {
    const match = part.match(/^(\d*)-?(\d*)$/);
    if (part === "-") throw new UsageError("invalid range with no endpoint: -", true);
    if (!match) throw new UsageError(invalidCutRangeMessage(part, mode), true);
    if (!match[1] && !match[2]) {
      throw new UsageError(mode === "fields" ? "fields are numbered from 1" : "byte/character positions are numbered from 1", true);
    }
    const startBig = match[1] ? parseCutRangeEndpoint(match[1], mode) : 1n;
    const endBig = match[2] ? parseCutRangeEndpoint(match[2], mode) : (part.includes("-") ? null : startBig);
    if (endBig != null && startBig > endBig) throw new UsageError("invalid decreasing range", true);
    const start = cutRangeNumber(startBig);
    const end = endBig == null ? Infinity : cutRangeNumber(endBig);
    if (start <= 0 || end <= 0) {
      throw new UsageError(mode === "fields" ? "fields are numbered from 1" : "byte/character positions are numbered from 1", true);
    }
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

export function parseCutRangeEndpoint(text, mode) {
  const value = BigInt(text);
  const max = (1n << 64n) - 1n;
  if (value >= max) {
    const name = mode === "fields" ? "field number" : "byte/character offset";
    throw new UsageError(`${name} ${localeQuotedEscapedDiagnostic(text)} is too large`, true);
  }
  return value;
}

export function cutRangeNumber(value) {
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
}

export function invalidCutRangeMessage(part, mode) {
  const kind = mode === "fields" ? "field value" : "byte/character position";
  const suffix = String(part).match(/^\d+-\d+(.+)$/)?.[1];
  return `invalid ${kind} ${localeQuotedDiagnostic(suffix ?? part)}`;
}

export function selectCharacterRanges(line, ranges, complement = false) {
  const chars = [...line];
  if (complement) return [chars.filter((_, i) => !inRanges(i + 1, ranges)).join("")];
  return ranges.map(([start, end]) => chars.slice(start - 1, end === Infinity ? undefined : end).join("")).filter((part) => part.length);
}

export function selectByteRanges(bytes, ranges, complement = false) {
  if (complement) return [bytes.filter((_, i) => !inRanges(i + 1, ranges))].filter((part) => part.length);
  return ranges.map(([start, end]) => bytes.slice(start - 1, end === Infinity ? undefined : end)).filter((part) => part.length);
}

export function splitByteRecords(bytes, sep) {
  const records = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === sep) {
      records.push({ record: bytes.slice(start, i), hasSep: true });
      start = i + 1;
    }
  }
  if (start < bytes.length) records.push({ record: bytes.slice(start), hasSep: false });
  return records;
}

export async function cut(args) {
  args = normalizeCutLongOptions(args);
  const { opts, operands } = parseOptions(args, {
    short: { b: "value", c: "value", d: "value", f: "value", F: "value", n: false, O: "value", s: false, w: false, z: false },
    long: { bytes: "value", characters: "value", complement: false, delimiter: "value", fields: "value", "no-partial": false, "only-delimited": false, "output-delimiter": "value", "whitespace-delimited": "optional-value", "zero-terminated": false, help: false, version: false },
  });
  const modes = [
    opts.b !== undefined || opts.bytes !== undefined ? "bytes" : "",
    opts.c !== undefined || opts.characters !== undefined ? "characters" : "",
    opts.f !== undefined || opts.F !== undefined || opts.fields !== undefined ? "fields" : "",
  ].filter(Boolean);
  const fieldSpecCount = [opts.f, opts.F, opts.fields].filter((value) => value !== undefined).length;
  if (!modes.length) throw new UsageError("you must specify a list of bytes, characters, or fields", true);
  if (modes.length > 1) throw new UsageError("only one list may be specified", true);
  if (fieldSpecCount > 1) throw new UsageError("only one list may be specified", true);
  const mode = modes[0];
  const spec = opts.b ?? opts.bytes ?? opts.c ?? opts.characters ?? opts.f ?? opts.F ?? opts.fields;
  const ranges = readRanges(spec, mode);
  const complement = Boolean(opts.complement);
  const hasInputDelimiter = opts.d !== undefined || opts.delimiter !== undefined;
  const suppressUndelimited = opts.s || opts["only-delimited"];
  if (hasInputDelimiter && mode !== "fields") throw new UsageError("an input delimiter makes sense\n\tonly when operating on fields", true);
  if (suppressUndelimited && mode !== "fields") throw new UsageError("suppressing non-delimited lines makes sense\n\tonly when operating on fields", true);
  const whitespaceDelimited = opts.w || (opts.F != null && !hasInputDelimiter) || opts["whitespace-delimited"] !== undefined;
  if ((opts.w || opts["whitespace-delimited"] !== undefined) && hasInputDelimiter) throw new UsageError("-d and -w are mutually exclusive", true);
  const trimmedWhitespace = normalizeCutWhitespaceDelimitedOption(opts["whitespace-delimited"]);
  const delimiterOpt = normalizeCutQuotedValue(opts.d ?? opts.delimiter);
  const delimiter = whitespaceDelimited ? null : delimiterOpt === "" ? "\0" : delimiterOpt ?? "\t";
  const singleByteLocale = /^(C|POSIX)$/.test(process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "");
  const gb18030 = isGb18030Locale();
  const rawDelimiter = mode === "fields" && delimiter != null && (gb18030 || shouldUseRawCutDelimiter(delimiter)) ? rawCutOptionValue(["d"], ["delimiter"]) : null;
  const delimiterBytes = delimiter == null ? null : normalizeCutRawDelimiter(rawDelimiter, delimiter);
  const delimiterCharCount = delimiterBytes && gb18030 ? gb18030Units(delimiterBytes).length : [...delimiter ?? ""].length;
  if (mode === "fields" && delimiter != null && (delimiterCharCount !== 1 || (singleByteLocale && delimiter !== "\uFFFD" && enc.encode(delimiter).length > 1))) throw new UsageError("the delimiter must be a single character", true);
  const outputDelimiterOpt = normalizeCutQuotedValue(opts["output-delimiter"] ?? opts.O);
  const hasOutputDelimiter = outputDelimiterOpt !== undefined;
  const outputDelimiter = hasOutputDelimiter ? (outputDelimiterOpt === "" ? "\0" : outputDelimiterOpt) : opts.F != null ? " " : delimiter ?? "\t";
  const rawOutputDelimiter = hasOutputDelimiter && (gb18030 || shouldUseRawCutDelimiter(outputDelimiter)) ? rawCutOptionValue([], ["output-delimiter", "output-delimite", "output-delimit", "output-delimi", "output-delim", "output-deli", "output-del", "output-de", "output-d", "output-", "output", "outpu", "outp", "out", "ou"]) ?? rawCutOptionValue(["O"], []) : null;
  const outputDelimiterBytes = hasOutputDelimiter ? normalizeCutRawDelimiter(rawOutputDelimiter, outputDelimiter) : opts.F != null ? enc.encode(outputDelimiter) : delimiterBytes ?? enc.encode(outputDelimiter);
  const recordSep = opts.z || opts["zero-terminated"] ? "\0" : "\n";
  const implicitStdin = operands.length === 0;
  const files = implicitStdin ? ["-"] : operands;
  const streamOptions = { mode, ranges, complement, recordSep, hasOutputDelimiter, outputDelimiter, outputDelimiterBytes, delimiter, delimiterBytes, whitespaceDelimited, trimmedWhitespace, suppressUndelimited, singleByteLocale, noPartial: Boolean(opts.n || opts["no-partial"]) };
  if (!gb18030 && delimiter !== recordSep && canStreamCutFd(streamOptions)) {
    let failed = false;
    for (const file of files) {
      const fd = file === "-" ? 0 : (() => {
        try {
          return openSync(file, "r");
        } catch (error) {
          stderr(`cut: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
          failed = true;
          return -1;
        }
      })();
      if (fd < 0) continue;
      try {
        streamCutFd(fd, streamOptions);
      } catch (error) {
        if (isWriteError(error)) throw error;
        stderr(file === "-" ? `cut: ${nodeErrorMessage(error)}\n` : `cut: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
        failed = true;
      } finally {
        if (fd !== 0) closeSync(fd);
      }
    }
    return failed ? 1 : 0;
  }
  const out = [];
  let failed = false;
  for (const file of files) {
    let bytes;
    try {
      bytes = await readAll(file);
    } catch (error) {
      stderr(file === "-" ? `cut: ${nodeErrorMessage(error)}\n` : `cut: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      failed = true;
      continue;
    }
    if (!bytes.length) continue;
    if (gb18030 && mode === "characters") {
      for (const raw of splitByteRecords(bytes, recordSep.charCodeAt(0))) {
        if (!raw.record.length && !raw.hasSep) continue;
        const pieces = selectGb18030CharacterRanges(raw.record, ranges, complement);
        out.push(...pieces);
        out.push(enc.encode(recordSep));
      }
      continue;
    }
    if (gb18030 && mode === "bytes" && (opts.n || opts["no-partial"])) {
      for (const raw of splitByteRecords(bytes, recordSep.charCodeAt(0))) {
        if (!raw.record.length && !raw.hasSep) continue;
        const pieces = selectGb18030ByteRangesNoSplit(raw.record, ranges, complement);
        out.push(...pieces);
        out.push(enc.encode(recordSep));
      }
      continue;
    }
    if (!gb18030 && !singleByteLocale && mode === "characters") {
      for (const raw of splitByteRecords(bytes, recordSep.charCodeAt(0))) {
        if (!raw.record.length && !raw.hasSep) continue;
        const pieces = selectUtf8CharacterRanges(raw.record, ranges, complement);
        for (let i = 0; i < pieces.length; i++) {
          if (i && hasOutputDelimiter) out.push(outputDelimiterBytes);
          out.push(pieces[i]);
        }
        out.push(enc.encode(recordSep));
      }
      continue;
    }
    if (!gb18030 && !singleByteLocale && mode === "bytes" && (opts.n || opts["no-partial"])) {
      for (const raw of splitByteRecords(bytes, recordSep.charCodeAt(0))) {
        if (!raw.record.length && !raw.hasSep) continue;
        const pieces = selectUtf8ByteRangesNoSplit(raw.record, ranges, complement);
        for (let i = 0; i < pieces.length; i++) {
          if (i && hasOutputDelimiter) out.push(outputDelimiterBytes);
          out.push(pieces[i]);
        }
        out.push(enc.encode(recordSep));
      }
      continue;
    }
    if (mode === "fields" && delimiter === recordSep) {
      let text = new TextDecoder().decode(bytes);
      const hasDelimiter = text.includes(delimiter);
      if (text.endsWith(delimiter) && text.length > delimiter.length) text = text.slice(0, -delimiter.length);
      if (!hasDelimiter && suppressUndelimited) continue;
      const fields = text === delimiter ? [""] : text.split(delimiter);
      const selected = fields.filter((_, i) => complement ? !inRanges(i + 1, ranges) : inRanges(i + 1, ranges));
      if (suppressUndelimited && !selected.length) continue;
      out.push((selected.length ? selected.join(outputDelimiter) : "") + recordSep);
      continue;
    }
    if ((gb18030 || singleByteLocale) && mode === "fields" && delimiterBytes != null && !whitespaceDelimited) {
      for (const raw of splitByteRecords(bytes, recordSep.charCodeAt(0))) {
        if (!raw.record.length && !raw.hasSep) continue;
        const fields = splitBytesByDelimiter(raw.record, delimiterBytes);
        if (fields.length === 1) {
          if (!suppressUndelimited) out.push(raw.record, enc.encode(recordSep));
          continue;
        }
        const selected = fields.filter((_, i) => complement ? !inRanges(i + 1, ranges) : inRanges(i + 1, ranges));
        out.push(joinByteFields(selected, outputDelimiterBytes), enc.encode(recordSep));
      }
      continue;
    }
    if (singleByteLocale && mode === "characters") {
      for (const raw of splitByteRecords(bytes, recordSep.charCodeAt(0))) {
        if (!raw.record.length && !raw.hasSep) continue;
        const pieces = selectByteRanges(raw.record, ranges, complement);
        for (let i = 0; i < pieces.length; i++) {
          if (i && hasOutputDelimiter) out.push(outputDelimiterBytes);
          out.push(pieces[i]);
        }
        out.push(enc.encode(recordSep));
      }
      continue;
    }
    if (mode === "bytes") {
      for (const raw of splitByteRecords(bytes, recordSep.charCodeAt(0))) {
        if (!raw.record.length && !raw.hasSep) continue;
        const pieces = selectByteRanges(raw.record, ranges, complement);
        for (let i = 0; i < pieces.length; i++) {
          if (i && hasOutputDelimiter) out.push(enc.encode(outputDelimiter));
          out.push(pieces[i]);
        }
        out.push(enc.encode(recordSep));
      }
      continue;
    }

    const records = new TextDecoder().decode(bytes).split(recordSep);
    const hadSep = records.length > 1 && records.at(-1) === "";
    if (hadSep) records.pop();
    for (const line of records) {
      if (mode === "fields") {
        const delimiterSubject = trimmedWhitespace ? line.trim() : line;
        const hasDelimiter = whitespaceDelimited ? CUT_BLANK_RE.test(delimiterSubject) : line.includes(delimiter);
        if (!hasDelimiter) {
          if (!(opts.s || opts["only-delimited"])) out.push(line, recordSep);
          continue;
        }
        const fields = whitespaceDelimited ? splitCutWhitespaceFields(line, trimmedWhitespace) : line.split(delimiter);
        out.push(fields.filter((_, i) => complement ? !inRanges(i + 1, ranges) : inRanges(i + 1, ranges)).join(outputDelimiter), recordSep);
      } else {
        out.push(selectCharacterRanges(line, ranges, complement).join(hasOutputDelimiter ? outputDelimiter : ""), recordSep);
      }
    }
  }
  stdout(out.length && out.every((part) => part instanceof Uint8Array) ? concatBytes(out) : out.join(""));
  return failed ? 1 : 0;
}

export function streamCutFd(fd, options) {
  const sepByte = options.recordSep === "\0" ? 0 : 10;
  if (options.mode === "bytes" || (options.mode === "characters" && (options.singleByteLocale || cutSelectsAllPositions(options)))) {
    streamCutPositionChunks(fd, options, sepByte);
    return;
  }
  if (canStreamCutFieldsBounded(options)) {
    streamCutFieldChunks(fd, options, sepByte);
    return;
  }
  readFdByteRecords(fd, sepByte, (record, hasSep) => {
    if (!record.length && !hasSep) return;
    if (options.mode === "bytes") {
      const pieces = selectByteRanges(record, options.ranges, options.complement);
      const out = [];
      for (let i = 0; i < pieces.length; i++) {
        if (i && options.hasOutputDelimiter) out.push(options.outputDelimiterBytes);
        out.push(pieces[i]);
      }
      out.push(Uint8Array.of(sepByte));
      stdout(concatBytes(out));
      return;
    }
    if (options.singleByteLocale && options.mode === "characters") {
      const pieces = selectByteRanges(record, options.ranges, options.complement);
      const out = [];
      for (let i = 0; i < pieces.length; i++) {
        if (i && options.hasOutputDelimiter) out.push(options.outputDelimiterBytes);
        out.push(pieces[i]);
      }
      out.push(Uint8Array.of(sepByte));
      stdout(concatBytes(out));
      return;
    }
    if (options.singleByteLocale && options.mode === "fields" && options.delimiterBytes != null && !options.whitespaceDelimited) {
      const fields = splitBytesByDelimiter(record, options.delimiterBytes);
      if (fields.length === 1) {
        if (!options.suppressUndelimited) stdout(concatBytes([record, Uint8Array.of(sepByte)]));
        return;
      }
      const selected = fields.filter((_, i) => options.complement ? !inRanges(i + 1, options.ranges) : inRanges(i + 1, options.ranges));
      stdout(concatBytes([joinByteFields(selected, options.outputDelimiterBytes), Uint8Array.of(sepByte)]));
      return;
    }
    const line = new TextDecoder().decode(record);
    if (options.mode === "fields") {
      const delimiterSubject = options.trimmedWhitespace ? line.trim() : line;
      const hasDelimiter = options.whitespaceDelimited ? CUT_BLANK_RE.test(delimiterSubject) : line.includes(options.delimiter);
      if (!hasDelimiter) {
        if (!options.suppressUndelimited) stdout(line + options.recordSep);
        return;
      }
      const fields = options.whitespaceDelimited ? splitCutWhitespaceFields(line, options.trimmedWhitespace) : line.split(options.delimiter);
      stdout(fields.filter((_, i) => options.complement ? !inRanges(i + 1, options.ranges) : inRanges(i + 1, options.ranges)).join(options.outputDelimiter) + options.recordSep);
      return;
    }
    stdout(selectCharacterRanges(line, options.ranges, options.complement).join(options.hasOutputDelimiter ? options.outputDelimiter : "") + options.recordSep);
  });
}

export function canStreamCutFd(options) {
  if (options.mode === "bytes") return !options.noPartial || options.singleByteLocale;
  if (options.mode === "characters") return options.singleByteLocale || cutSelectsAllPositions(options);
  return canStreamCutFieldsBounded(options);
}

export function cutSelectsAllPositions(options) {
  return !options.complement && !options.hasOutputDelimiter && options.ranges.length === 1 && options.ranges[0][0] === 1 && options.ranges[0][1] === Infinity;
}

export function streamCutPositionChunks(fd, options, sepByte) {
  const separator = Uint8Array.of(sepByte);
  let position = 0;
  let rangeIndex = 0;
  let lastWrittenRange = -1;
  let recordHasBytes = false;
  const resetRecord = () => {
    position = 0;
    rangeIndex = 0;
    lastWrittenRange = -1;
    recordHasBytes = false;
  };
  readFdChunkViews(fd, (chunk) => {
    const output = [];
    let runStart = -1;
    const endRun = (end) => {
      if (runStart !== -1) output.push(chunk.subarray(runStart, end));
      runStart = -1;
    };
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (byte === sepByte) {
        endRun(index);
        output.push(separator);
        resetRecord();
        continue;
      }
      recordHasBytes = true;
      position++;
      while (rangeIndex < options.ranges.length && position > options.ranges[rangeIndex][1]) rangeIndex++;
      const selectedRange = rangeIndex < options.ranges.length
        && position >= options.ranges[rangeIndex][0]
        && position <= options.ranges[rangeIndex][1]
        ? rangeIndex
        : -1;
      const selected = options.complement ? selectedRange === -1 : selectedRange !== -1;
      if (!selected) {
        endRun(index);
        continue;
      }
      if (!options.complement && selectedRange !== lastWrittenRange) {
        endRun(index);
        if (lastWrittenRange !== -1 && options.hasOutputDelimiter) output.push(options.outputDelimiterBytes);
        lastWrittenRange = selectedRange;
      }
      if (runStart === -1) runStart = index;
    }
    endRun(chunk.length);
    for (const piece of output) stdout(piece);
  });
  if (recordHasBytes) stdout(separator);
}

export function canStreamCutFieldsBounded(options) {
  if (options.mode !== "fields" || options.whitespaceDelimited || options.delimiterBytes?.length !== 1) return false;
  const fieldOneSelected = options.complement ? !inRanges(1, options.ranges) : inRanges(1, options.ranges);
  return options.suppressUndelimited ? !fieldOneSelected : fieldOneSelected;
}

export function streamCutFieldChunks(fd, options, sepByte) {
  const delimiterByte = options.delimiterBytes[0];
  const separator = Uint8Array.of(sepByte);
  let field = 1;
  let sawDelimiter = false;
  let recordHasBytes = false;
  let selectedFields = 0;
  const fieldSelected = () => options.complement ? !inRanges(field, options.ranges) : inRanges(field, options.ranges);
  let selected = fieldSelected() && !options.suppressUndelimited;
  if (selected) selectedFields = 1;
  const resetRecord = () => {
    field = 1;
    sawDelimiter = false;
    recordHasBytes = false;
    selectedFields = 0;
    selected = fieldSelected() && !options.suppressUndelimited;
    if (selected) selectedFields = 1;
  };
  readFdChunkViews(fd, (chunk) => {
    const output = [];
    let runStart = selected ? 0 : -1;
    const endRun = (end) => {
      if (runStart !== -1 && end > runStart) output.push(chunk.subarray(runStart, end));
      runStart = -1;
    };
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (byte === sepByte) {
        endRun(index);
        if (sawDelimiter || !options.suppressUndelimited) output.push(separator);
        resetRecord();
        continue;
      }
      recordHasBytes = true;
      if (byte !== delimiterByte) {
        if (selected && runStart === -1) runStart = index;
        continue;
      }
      endRun(index);
      sawDelimiter = true;
      field++;
      selected = fieldSelected();
      if (selected) {
        if (selectedFields && options.outputDelimiterBytes.length) output.push(options.outputDelimiterBytes);
        selectedFields++;
        runStart = index + 1;
      }
    }
    endRun(chunk.length);
    for (const piece of output) stdout(piece);
  });
  if (recordHasBytes && (sawDelimiter || !options.suppressUndelimited)) stdout(separator);
}

export function splitCutWhitespaceFields(line, trimmed = false) {
  return (trimmed ? line.trim() : line).split(CUT_BLANK_RUN_RE);
}

export const CUT_BLANK_RE = /[\t \u1680\u2000-\u200a\u202f\u205f\u3000]/u;

export const CUT_BLANK_RUN_RE = /[\t \u1680\u2000-\u200a\u202f\u205f\u3000]+/u;

export function rawCutOptionValue(shortNames, longNames) {
  const rawArgs = rawCommandArgs("cut");
  if (!rawArgs) return null;
  const shortSet = new Set(shortNames);
  const longSet = new Set(longNames);
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.equals(Buffer.from("--"))) break;
    const text = arg.toString();
    if (arg.length === 2 && arg[0] === 0x2d && shortSet.has(String.fromCharCode(arg[1]))) return rawArgs[i + 1] ?? null;
    if (arg.length > 2 && arg[0] === 0x2d && arg[1] !== 0x2d && shortSet.has(String.fromCharCode(arg[1]))) return arg.subarray(2);
    if (text.startsWith("--")) {
      const eq = text.indexOf("=");
      const name = eq === -1 ? text.slice(2) : text.slice(2, eq);
      if (longSet.has(name)) return eq === -1 ? rawArgs[i + 1] ?? null : arg.subarray(Buffer.byteLength(`--${name}=`));
    }
  }
  return null;
}

export function normalizeCutRawDelimiter(rawValue, parsedValue) {
  if (rawValue && rawValue.length === 0 && parsedValue === "\0") return Uint8Array.of(0);
  return rawValue ?? enc.encode(parsedValue);
}

export function shouldUseRawCutDelimiter(value) {
  return value === "\0" || value.includes("\uFFFD");
}

export function normalizeCutLongOptions(args, reportAmbiguous = true) {
  const out = [];
  for (const arg of args) {
    if (arg === "--") {
      out.push(arg);
      continue;
    }
    if (!arg.startsWith("--") || arg === "--") {
      out.push(arg);
      continue;
    }
    out.push(normalizeCutLongOption(arg, reportAmbiguous));
  }
  return out;
}

export function normalizeCutLongOption(arg, reportAmbiguous = true) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  const matches = CUT_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length === 1) return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
  if (matches.length > 1 && reportAmbiguous) {
    throw new UsageError(`option '${arg}' is ambiguous; possibilities: ${matches.map((option) => `'--${option}'`).join(" ")}`, true);
  }
  return arg;
}

export function normalizeCutWhitespaceDelimitedOption(value) {
  if (value == null || value === true || value === "") return false;
  if ("trimmed".startsWith(String(value))) return true;
  throw new UsageError(`invalid argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic("--whitespace-delimited")}\nValid arguments are:\n  - ${localeQuotedDiagnostic("trimmed")}`, true);
}

export function normalizeCutQuotedValue(value) {
  if (typeof value === "string" && value.includes("'")) {
    let out = value;
    if (out.startsWith("'")) out = out.slice(1);
    if (out.endsWith("'")) out = out.slice(0, -1);
    if (out === "\\n") return "\n";
    return out;
  }
  return value;
}

export function selectGb18030CharacterRanges(bytes, ranges, complement = false) {
  const units = gb18030Units(bytes);
  if (complement) return [concatBytes(units.filter((_, i) => !inRanges(i + 1, ranges)))].filter((part) => part.length);
  return ranges.map(([start, end]) => concatBytes(units.slice(start - 1, end === Infinity ? undefined : end))).filter((part) => part.length);
}

export function selectGb18030ByteRangesNoSplit(bytes, ranges, complement = false) {
  const units = gb18030Units(bytes);
  const out = [];
  let pos = 1;
  for (const unit of units) {
    const start = pos;
    const end = pos + unit.length - 1;
    pos = end + 1;
    const include = complement
      ? [...Array(unit.length)].some((_, i) => !inRanges(start + i, ranges))
      : inRanges(end, ranges);
    if (include) out.push(unit);
  }
  return out;
}

export function utf8Units(bytes) {
  const units = [];
  for (let i = 0; i < bytes.length;) {
    const start = i;
    const first = bytes[i++];
    let length = 1;
    if (first >= 0xc2 && first <= 0xdf && isUtf8Continuation(bytes[i])) length = 2;
    else if (first >= 0xe0 && first <= 0xef
      && isUtf8Continuation(bytes[i]) && isUtf8Continuation(bytes[i + 1])
      && !(first === 0xe0 && bytes[i] < 0xa0) && !(first === 0xed && bytes[i] >= 0xa0)) length = 3;
    else if (first >= 0xf0 && first <= 0xf4
      && isUtf8Continuation(bytes[i]) && isUtf8Continuation(bytes[i + 1]) && isUtf8Continuation(bytes[i + 2])
      && !(first === 0xf0 && bytes[i] < 0x90) && !(first === 0xf4 && bytes[i] >= 0x90)) length = 4;
    i = start + length;
    units.push(bytes.slice(start, i));
  }
  return units;
}

export function selectUtf8CharacterRanges(bytes, ranges, complement = false) {
  const units = utf8Units(bytes);
  if (complement) return [concatBytes(units.filter((_, index) => !inRanges(index + 1, ranges)))].filter((part) => part.length);
  return ranges.map(([start, end]) => concatBytes(units.slice(start - 1, end === Infinity ? undefined : end))).filter((part) => part.length);
}

export function selectUtf8ByteRangesNoSplit(bytes, ranges, complement = false) {
  const units = utf8Units(bytes);
  let position = 0;
  if (complement) {
    const selected = [];
    for (const unit of units) {
      position += unit.length;
      if (!inRanges(position, ranges)) selected.push(unit);
    }
    return [concatBytes(selected)].filter((part) => part.length);
  }
  const grouped = ranges.map(() => []);
  for (const unit of units) {
    position += unit.length;
    const rangeIndex = ranges.findIndex(([start, end]) => position >= start && position <= end);
    if (rangeIndex !== -1) grouped[rangeIndex].push(unit);
  }
  return grouped.map(concatBytes).filter((part) => part.length);
}

export function splitBytesByDelimiter(bytes, delimiter) {
  const fields = [];
  let start = 0;
  for (let i = 0; i <= bytes.length - delimiter.length;) {
    if (bytes.subarray(i, i + delimiter.length).every((byte, idx) => byte === delimiter[idx])) {
      fields.push(bytes.slice(start, i));
      i += delimiter.length;
      start = i;
    } else {
      i++;
    }
  }
  fields.push(bytes.slice(start));
  return fields;
}

export function joinByteFields(fields, delimiter) {
  if (!fields.length) return new Uint8Array();
  const parts = [];
  for (let i = 0; i < fields.length; i++) {
    if (i) parts.push(delimiter);
    parts.push(fields[i]);
  }
  return concatBytes(parts);
}

const singleCall = defineCommand("cut", cut, cutMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
