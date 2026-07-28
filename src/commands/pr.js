#!/usr/bin/env bun

import { closeSync, openSync, readSync } from "node:fs";
import { stat } from "node:fs/promises";
import { decodeSurrogateEscapedBytes, isWriteError, localeQuotedEscapedDiagnostic, nodeErrorMessage, normalizeLongOptionByPrefix, parseOptions, readAll, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { prInputIsNonRegular } from "../shared/text.js";
import { strftime } from "../shared/time.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const PR_LONG_OPTIONS = ["across", "columns", "date-format", "double-space", "expand-tabs", "first-line-number", "form-feed", "header", "indent", "join-lines", "length", "merge", "no-file-warnings", "number-lines", "omit-header", "omit-pagination", "output-tabs", "page-width", "pages", "sep-string", "separator", "show-control-chars", "show-nonprinting", "width", "help", "version"];

export function prMetaOption(args) {
  const longValueOptions = new Set(["columns", "date-format", "first-line-number", "header", "indent", "length", "page-width", "pages", "width"]);
  const longOptionalValueOptions = new Set(["expand-tabs", "number-lines", "output-tabs", "sep-string", "separator"]);
  const shortValueOptions = new Set(["D", "h", "l", "N", "o", "w", "W"]);
  const shortOptionalValueOptions = new Set(["e", "i", "n", "s", "S"]);
  const shortKnownOptions = new Set(["a", "b", "c", "d", "e", "f", "F", "h", "i", "J", "l", "m", "n", "N", "o", "r", "s", "S", "t", "T", "v", "w", "W", "D"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeLongOptionByPrefix(arg, PR_LONG_OPTIONS);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!PR_LONG_OPTIONS.includes(name)) return null;
      if (name === "help" || name === "version") {
        if (inlineValue != null) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
        return option;
      }
      const value = inlineValue ?? (longValueOptions.has(name) ? args[i + 1] : undefined);
      if (value !== undefined) validatePrMetaOptionValue(name, value);
      if (inlineValue == null && longValueOptions.has(name)) i++;
      else if (inlineValue == null && longOptionalValueOptions.has(name)) continue;
      else if (inlineValue != null && !longValueOptions.has(name) && !longOptionalValueOptions.has(name)) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    if (/^-\d+$/.test(arg)) continue;
    if (/^-\d/.test(arg)) return null;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        const value = inlineValue === "" ? args[i + 1] : inlineValue;
        validatePrMetaShortValue(ch, value);
        if (inlineValue === "") i++;
        break;
      }
      if (shortOptionalValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        if (inlineValue !== "") validatePrMetaShortValue(ch, inlineValue);
        break;
      }
    }
  }
  return null;
}

export function validatePrMetaOptionValue(name, value) {
  if (name === "columns") parsePrColumnCount(value);
  else if (name === "first-line-number") parsePrLineNumber(value);
  else if (name === "indent") parsePrNonnegativeInteger(value, "-o MARGIN", "line offset");
  else if (name === "page-width") parsePrPositiveInteger(value, "-W PAGE_WIDTH", "characters");
  else if (name === "width") parsePrPositiveInteger(value, "-w PAGE_WIDTH", "characters");
  else if (name === "length") parsePrPositiveInteger(value, "-l PAGE_LENGTH", "lines");
  else if (name === "pages") validatePrPages(value);
  else if (name === "expand-tabs") validatePrOptionalNumberSpec(value, "-e");
  else if (name === "number-lines") validatePrOptionalNumberSpec(value, "-n");
  else if (name === "output-tabs") validatePrOptionalNumberSpec(value, "-i");
}

export function validatePrMetaShortValue(ch, value) {
  if (value === undefined) return;
  if (ch === "l") validatePrMetaOptionValue("length", value);
  else if (ch === "o") validatePrMetaOptionValue("indent", value);
  else if (ch === "w") validatePrMetaOptionValue("width", value);
  else if (ch === "W") validatePrMetaOptionValue("page-width", value);
  else if (ch === "e") validatePrMetaOptionValue("expand-tabs", value);
  else if (ch === "n") validatePrMetaOptionValue("number-lines", value);
  else if (ch === "i") validatePrMetaOptionValue("output-tabs", value);
}

export function validatePrOptionalNumberSpec(value, option) {
  const text = String(value);
  if (text === "") throw new UsageError(`'${option}': Invalid argument: ${localeQuotedEscapedDiagnostic(text)}`, true);
  const numberText = /^\d/.test(text) ? text : text.slice(1);
  if (numberText === "") return;
  let tooLarge = false;
  let valid = /^\d+$/.test(numberText);
  if (valid) {
    const n = BigInt(numberText);
    valid = n > 0n;
    tooLarge = n > BigInt(Number.MAX_SAFE_INTEGER);
  }
  if (!valid || tooLarge) {
    const suffix = tooLarge ? ": Value too large for defined data type" : "";
    throw new UsageError(`'${option}' extra characters or invalid number in the argument: ${localeQuotedEscapedDiagnostic(numberText)}${suffix}`, true);
  }
}

export async function prCmd(args) {
  args = normalizePrColumnArgs(args);
  const { opts, operands } = parseOptions(args, { short: { a: false, b: false, c: false, d: false, e: "optional-value", f: false, F: false, h: "value", i: "optional-value", J: false, l: "value", m: false, n: "optional-value", N: "value", o: "value", r: false, s: "optional-value", S: "optional-value", t: false, T: false, v: false, w: "value", W: "value", D: "value" }, long: { across: false, columns: "value", "date-format": "value", "double-space": false, "expand-tabs": "optional-value", "first-line-number": "value", "form-feed": false, header: "value", indent: "value", "join-lines": false, length: "value", merge: false, "no-file-warnings": false, "number-lines": "optional-value", "omit-header": false, "omit-pagination": false, "output-tabs": "optional-value", "page-width": "value", pages: "value", "sep-string": "optional-value", separator: "optional-value", "show-control-chars": false, "show-nonprinting": false, width: "value" } });
  validatePrPages(opts.pages);
  const files = operands.length ? operands : ["-"];
  const numberSpec = opts.n ?? opts["number-lines"];
  const numberLines = numberSpec !== undefined;
  const firstLineNumberSpecified = opts.N !== undefined || opts["first-line-number"] !== undefined;
  const { separator, width } = parsePrNumberSpec(numberSpec);
  let lineNumber = parsePrLineNumber(opts.N ?? opts["first-line-number"] ?? 1);
  const indent = parsePrNonnegativeInteger(opts.o ?? opts.indent ?? 0, "-o MARGIN", "line offset");
  const columns = parsePrColumnCount(opts.columns);
  const pageWidthText = opts.W ?? opts["page-width"] ?? opts.w ?? opts.width;
  const pageWidthLabel = opts.W !== undefined || opts["page-width"] !== undefined ? "-W PAGE_WIDTH" : "-w PAGE_WIDTH";
  const pageWidth = pageWidthText == null ? 72 : parsePrPositiveInteger(pageWidthText, pageWidthLabel, "characters");
  const pageLengthText = opts.l ?? opts.length;
  const pageLength = pageLengthText == null ? 66 : parsePrPositiveInteger(pageLengthText, "-l PAGE_LENGTH", "lines");
  const pageRange = parsePrPageRange(opts.pages);
  const explicitPageWidth = pageWidthText != null;
  const oldSeparatorSpecified = opts.s !== undefined || opts.separator !== undefined;
  const newSeparatorSpecified = opts.S !== undefined || opts["sep-string"] !== undefined;
  const columnSeparatorSpecified = oldSeparatorSpecified || newSeparatorSpecified;
  const columnSeparator = newSeparatorSpecified
    ? (opts.S === true || opts["sep-string"] === true ? "" : String(opts.S ?? opts["sep-string"]))
    : (opts.s === true || opts.separator === true ? (opts.w ?? opts.width ? "" : "\t") : (typeof (opts.s ?? opts.separator) === "string" ? String(opts.s ?? opts.separator) : " "));
  const omitHeader = opts.t || opts.T || opts["omit-header"] || opts["omit-pagination"] || pageLength <= 10;
  const expandTabs = opts.e !== undefined || opts["expand-tabs"] !== undefined;
  const tabSpec = parsePrTabSpec(opts.e ?? opts["expand-tabs"]);
  const tabSize = tabSpec.size;
  const outputTabs = opts.i !== undefined || opts["output-tabs"] !== undefined;
  const outputTabSize = parsePrTabSize(opts.i ?? opts["output-tabs"]);
  const formFeed = opts.f || opts.F || opts["form-feed"];
  if (opts.m || opts.merge) {
    const texts = [];
    let failed = false;
    for (const file of files) {
      let text;
      try {
        text = decodeSurrogateEscapedBytes(await readAll(file));
      } catch (error) {
        if (!(opts.r || opts["no-file-warnings"])) stderr(prReadError(file, error));
        failed = true;
        continue;
      }
      if (expandTabs) text = expandPrTabs(text, tabSize);
      if (hasPrNonprintingRendering(opts)) text = renderPrNonprinting(text, opts);
      texts.push(text);
    }
    let pageHeader = null;
    if (!omitHeader) {
      const headerName = opts.h ?? opts.header ?? "";
      const headerDate = opts.D || opts["date-format"]
        ? await prHeaderDate(files[0] ?? "-", opts)
        : strftime(new Date(), "%Y-%m-%d %H:%M");
      pageHeader = (page) => formatPrPageHeader(formatPrHeader(headerDate, headerName, pageWidth, page), indent);
    }
    const mergeJoinLines = opts.J || opts["join-lines"];
    const mergeColumnSeparator = mergeJoinLines && !columnSeparatorSpecified ? "\t" : columnSeparator;
    let rendered = renderPrMerge(texts, { columnCount: files.length, columnSeparator: mergeColumnSeparator, defaultColumnSeparator: !columnSeparatorSpecified, explicitPageWidth, formFeed, indent, joinLines: mergeJoinLines, numberLines, numberSkippedLines: !firstLineNumberSpecified, pageHeader, pageLength, pageRange, padColumns: !oldSeparatorSpecified, pageWidth, preserveMergeTabs: oldSeparatorSpecified && !newSeparatorSpecified && columnSeparator === "\t", separator, stripFormFeeds: opts.T || opts["omit-pagination"], width, nextNumber: () => lineNumber++ });
    if (outputTabs) rendered = tabifyPrOutput(rendered, outputTabSize);
    stdout(rendered);
    return failed ? 1 : 0;
  }
  let out = "";
  let failed = false;
  for (const file of files) {
    let text;
    const paginatedBody = pageLength != null && !omitHeader;
    if (files.length === 1 && prInputIsNonRegular(file) && columns === 1 && paginatedBody && opts.pages == null && !expandTabs && !outputTabs && !hasPrNonprintingRendering(opts) && !(opts.J || opts["join-lines"]) && !oldSeparatorSpecified && !newSeparatorSpecified) {
      const headerName = opts.h ?? opts.header ?? "";
      const headerDate = await prHeaderDate(file, opts);
      const pageHeader = (page) => formatPrPageHeader(formatPrHeader(headerDate, headerName, pageWidth, page), indent);
      let fd = 0;
      try {
        if (file !== "-") fd = openSync(file, "r");
        streamPrPaginatedSingleColumnFd(fd, { doubleSpace: opts.d || opts["double-space"], explicitPageWidth: effectivePrExplicitPageWidth(explicitPageWidth, false, columns, pageWidth, opts), formFeed, indent, numberLines, numberSkippedLines: !firstLineNumberSpecified, pageHeader, pageLength, pageRange, pageWidth, separator, width, nextNumber: () => lineNumber++ });
        return 0;
      } catch (error) {
        if (isWriteError(error)) throw error;
        if (!(opts.r || opts["no-file-warnings"])) stderr(prReadError(file, error));
        return 1;
      } finally {
        if (file !== "-" && fd !== 0) closeSync(fd);
      }
    }
    try {
      text = decodeSurrogateEscapedBytes(await readAll(file));
    } catch (error) {
      if (!(opts.r || opts["no-file-warnings"])) stderr(prReadError(file, error));
      failed = true;
      continue;
    }
    if (text.length === 0) continue;
    if (hasPrNonprintingRendering(opts)) text = renderPrNonprinting(text, opts);
    if (expandTabs && columns === 1) text = tabSpec.char === "\t" ? expandPrTabs(text, tabSize) : expandPrInputTabs(text, tabSpec.char, tabSize);
    else if (expandTabs && tabSpec.char !== "\t") text = translatePrInputTabs(text, tabSpec.char);
    let pageHeader = null;
    if (!omitHeader) {
      const headerName = opts.h ?? opts.header ?? (file === "-" ? "" : file);
      const headerDate = await prHeaderDate(file, opts);
      pageHeader = (page) => formatPrPageHeader(formatPrHeader(headerDate, headerName, pageWidth, page), indent);
      if (!paginatedBody) out += pageHeader(1);
    }
    const joinLines = opts.J || opts["join-lines"] || (oldSeparatorSpecified && !(opts.w ?? opts.width));
    const effectiveExplicitPageWidth = effectivePrExplicitPageWidth(explicitPageWidth, joinLines, columns, pageWidth, opts);
    const bodyColumnSeparator = joinLines && columns > 1 && !columnSeparatorSpecified ? "\t" : columnSeparator;
    let rendered = renderPrBody(text, { across: opts.a || opts.across, columns, columnSeparator: bodyColumnSeparator, columnSeparatorSpecified, doubleSpace: opts.d || opts["double-space"], expandTabs, explicitPageWidth: effectiveExplicitPageWidth, formFeed, indent, joinLines, numberLines, numberSkippedLines: !firstLineNumberSpecified, pageHeader, pageLength: omitHeader && pageLengthText == null ? undefined : pageLength, pageRange, pageWidth, padExplicitSeparatorColumns: newSeparatorSpecified, separator, stripFormFeeds: opts.T || opts["omit-pagination"], tabSize, width, nextNumber: () => lineNumber++ });
    if (rendered === "" && opts.pages != null && pageRange.first > 1) stderr(`pr: starting page number ${pageRange.first} exceeds page count 1\n`);
    if (outputTabs) rendered = tabifyPrOutput(rendered, outputTabSize);
    out += rendered;
    if (formFeed && !omitHeader && !paginatedBody) out += "\f";
    if (rendered !== "" && !out.endsWith("\n") && !out.endsWith("\f")) out += "\n";
  }
  stdout(out);
  return failed ? 1 : 0;
}

export function prReadError(file, error) {
  return file === "-" ? `pr: ${nodeErrorMessage(error)}\n` : `pr: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`;
}

export function hasPrNonprintingRendering(opts) {
  return Boolean(opts.c || opts["show-control-chars"] || opts.v || opts["show-nonprinting"]);
}

export function renderPrNonprinting(text, opts) {
  const octal = opts.v || opts["show-nonprinting"];
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === "\n" || ch === "\t" || ch === "\f") out += ch;
    else if (code >= 0xdc80 && code <= 0xdcff) out += `\\${(code - 0xdc00).toString(8).padStart(3, "0")}`;
    else if (octal && (code < 32 || code === 127)) out += `\\${code.toString(8).padStart(3, "0")}`;
    else if (code < 32) out += `^${String.fromCharCode(code + 64)}`;
    else if (code === 127) out += "^?";
    else out += ch;
  }
  return out;
}

export function normalizePrColumnArgs(args) {
  const normalized = [];
  const valueOptions = new Set(["-w", "-W", "-l", "-h", "-N", "-o", "-D", "--width", "--page-width", "--length", "--header", "--first-line-number", "--indent", "--date-format", "--pages", "--columns"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    normalized.push(arg);
    if (valueOptions.has(arg)) {
      if (i + 1 < args.length) normalized.push(args[++i]);
      continue;
    }
    const compactColumnMatch = String(arg).match(/^-(t|T)(\d+)$/);
    if (compactColumnMatch) {
      normalized.pop();
      normalized.push(`-${compactColumnMatch[1]}`, `--columns=${compactColumnMatch[2]}`);
      continue;
    }
    const compactObsoleteMatch = String(arg).match(/^-([1-9]\d*)(\D.+|[^\d])$/);
    if (compactObsoleteMatch) {
      const [, columnText, rest] = compactObsoleteMatch;
      const columns = Number(columnText);
      if (!Number.isSafeInteger(columns)) throw new UsageError(`invalid number of columns: ${localeQuotedEscapedDiagnostic(columnText)}: Value too large for defined data type`);
      if (columns < 1) throw new UsageError(`invalid number of columns: ${localeQuotedEscapedDiagnostic(columnText)}: Numerical result out of range`);
      normalized.pop();
      normalized.push(`--columns=${columnText}`, `-${rest}`);
      continue;
    }
    const match = String(arg).match(/^-(\d+)$/);
    if (!match) {
      const pageMatch = String(arg).match(/^\+(.+)$/);
      if (pageMatch) normalized[normalized.length - 1] = `--pages=${pageMatch[1]}`;
      continue;
    }
    const columnText = match[1];
    const columns = Number(columnText);
    if (!Number.isSafeInteger(columns)) throw new UsageError(`invalid number of columns: ${localeQuotedEscapedDiagnostic(columnText)}: Value too large for defined data type`);
    if (columns < 1) throw new UsageError(`invalid number of columns: ${localeQuotedEscapedDiagnostic(columnText)}: Numerical result out of range`);
    normalized[normalized.length - 1] = `--columns=${columnText}`;
  }
  return normalized;
}

export function parsePrPositiveInteger(value, label, unit) {
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new UsageError(`'${label}' invalid number of ${unit}: ${localeQuotedEscapedDiagnostic(text)}`);
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new UsageError(`'${label}' invalid number of ${unit}: ${localeQuotedEscapedDiagnostic(text)}: Value too large for defined data type`);
  if (n < 1) throw new UsageError(`'${label}' invalid number of ${unit}: ${localeQuotedEscapedDiagnostic(text)}: Numerical result out of range`);
  return n;
}

export function parsePrNonnegativeInteger(value, label, unit) {
  const text = String(value);
  if (!/^[+-]?\d+$/.test(text)) throw new UsageError(`'${label}' invalid ${unit}: ${localeQuotedEscapedDiagnostic(text)}`);
  const n = BigInt(text);
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new UsageError(`'${label}' invalid ${unit}: ${localeQuotedEscapedDiagnostic(text)}: Value too large for defined data type`);
  return Number(n);
}

export function parsePrLineNumber(value) {
  const text = String(value);
  if (!/^[+-]?\d+$/.test(text)) throw new UsageError(`'-N NUMBER' invalid starting line number: ${localeQuotedEscapedDiagnostic(text)}`);
  const n = BigInt(text);
  if (n < -2147483648n || n > 2147483647n) throw new UsageError(`'-N NUMBER' invalid starting line number: ${localeQuotedEscapedDiagnostic(text)}: Value too large for defined data type`);
  return Number(n);
}

export function parsePrColumnCount(value) {
  if (value == null) return 1;
  const text = String(value);
  if (!/^[+-]?\d+$/.test(text)) throw new UsageError(`invalid number of columns: ${localeQuotedEscapedDiagnostic(text)}`);
  const columns = BigInt(text.replace(/^\+/, ""));
  if (columns < 1n) throw new UsageError(`invalid number of columns: ${localeQuotedEscapedDiagnostic(text)}: Numerical result out of range`);
  if (columns > BigInt(Number.MAX_SAFE_INTEGER)) throw new UsageError(`invalid number of columns: ${localeQuotedEscapedDiagnostic(text)}: Value too large for defined data type`);
  return Number(columns);
}

export function validatePrPages(pages) {
  if (pages == null) return;
  const text = String(pages);
  if (/^\d+[A-Za-z]+$/.test(text) && text.length > 30) throw new UsageError(`invalid suffix in --pages argument '${text}'`);
  if (/^\d+$/.test(text) && text.length > 30) throw new UsageError(`--pages argument '${text}' too large`);
  if (/^[A-Za-z]+$/.test(text)) throw new UsageError(`invalid --pages argument '${text}'`);
  if (/^\d+[A-Za-z]/.test(text) || (/^\d/.test(text) && /[\x00-\x1f\x7f]/.test(text))) throw new UsageError(`invalid page range ${localeQuotedEscapedDiagnostic(text)}`);
  if (!/^\d+([:-]\d+)?$/.test(text)) throw new UsageError(`invalid --pages argument '${text}'`);
}

export function parsePrPageRange(pages) {
  if (pages == null) return { first: 1, last: Infinity };
  const [firstText, lastText] = String(pages).split(/[:-]/, 2);
  return { first: Number(firstText), last: lastText === undefined ? Infinity : Number(lastText) };
}

export function parsePrTabSize(spec) {
  if (spec === undefined || spec === true || spec === "") return 8;
  const text = String(spec);
  const match = text.match(/(\d+)$/);
  const size = Number(match?.[1] ?? 8);
  return Number.isSafeInteger(size) && size > 0 ? size : 8;
}

export function parsePrTabSpec(spec) {
  const size = parsePrTabSize(spec);
  if (spec === undefined || spec === true || spec === "") return { char: "\t", size };
  const text = String(spec);
  const match = text.match(/^(.*?)(\d+)$/s);
  const marker = match ? match[1] : text;
  return { char: marker ? marker[0] : "\t", size };
}

export function translatePrInputTabs(text, marker) {
  return text.replaceAll(marker, "\t");
}

export function expandPrInputTabs(text, marker, markerTabSize) {
  let out = "";
  let column = 0;
  for (const ch of text) {
    if (ch === marker || ch === "\t") {
      const size = ch === marker ? markerTabSize : 8;
      const spaces = size - (column % size);
      out += " ".repeat(spaces);
      column += spaces;
    } else if (ch === "\b") {
      if (column > 0) {
        out += ch;
        column--;
      }
    } else {
      out += ch;
      if (ch === "\n" || ch === "\f") column = 0;
      else column++;
    }
  }
  return out;
}

export function expandPrTabs(text, tabSize) {
  let out = "";
  let column = 0;
  for (const ch of text) {
    if (ch === "\t") {
      const spaces = tabSize - (column % tabSize);
      out += " ".repeat(spaces);
      column += spaces;
    } else if (ch === "\b") {
      if (column > 0) {
        out += ch;
        column--;
      }
    } else {
      out += ch;
      if (ch === "\n" || ch === "\f") column = 0;
      else column++;
    }
  }
  return out;
}

export function tabifyPrOutput(text, tabSize) {
  let out = "";
  let column = 0;
  let pendingSpaces = 0;
  const flushSpaces = (nextColumn = column + pendingSpaces) => {
    while (pendingSpaces > 0) {
      const toStop = tabSize - (column % tabSize);
      if (pendingSpaces >= toStop && toStop > 1) {
        out += "\t";
        column += toStop;
        pendingSpaces -= toStop;
      } else {
        out += " ";
        column++;
        pendingSpaces--;
      }
    }
    column = nextColumn;
  };
  for (const ch of text) {
    if (ch === " ") {
      pendingSpaces++;
      continue;
    }
    flushSpaces();
    out += ch;
    if (ch === "\t") column += tabSize - (column % tabSize);
    else if (ch === "\b") column = Math.max(0, column - 1);
    else if (ch === "\n" || ch === "\f") column = 0;
    else column++;
  }
  flushSpaces();
  return out;
}

export async function prHeaderDate(file, opts) {
  const format = opts.D ?? opts["date-format"];
  if (!format) {
    const date = file === "-" ? new Date() : (await stat(file)).mtime;
    return strftime(date, "%Y-%m-%d %H:%M");
  }
  const date = file === "-" ? new Date() : (await stat(file)).mtime;
  return format.startsWith("+") ? `+${strftime(date, format.slice(1))}` : strftime(date, format);
}

export function formatPrHeader(dateText, name, pageWidth = 72, page = 1) {
  const pageText = `Page ${page}`;
  if (pageWidth < dateText.length + String(name).length + pageText.length + 2) return `${dateText} ${name} ${pageText}`;
  const nameColumn = dateText.length + Math.floor((pageWidth - pageText.length - dateText.length - String(name).length) / 2);
  return `${dateText.padEnd(nameColumn)}${String(name).padEnd(Math.max(1, pageWidth - pageText.length - nameColumn))}${pageText}`;
}

export function formatPrPageHeader(headerLine, indent = 0) {
  const margin = " ".repeat(indent);
  return indent > 0 ? `${margin}\n\n${margin}${headerLine}\n\n\n` : `\n\n${headerLine}\n\n\n`;
}

export function parsePrNumberSpec(spec) {
  if (spec === undefined || spec === true) return { separator: "\t", width: 5 };
  const text = String(spec);
  const match = text.match(/^(.*?)(\d+)?$/s);
  return { separator: match?.[1] || "\t", width: Number(match?.[2] || 5) };
}

export function renderPrBody(text, opts) {
  if (opts.columns > 1 && text.includes("\f") && !(opts.pageLength != null && opts.pageHeader)) return renderPrColumnGroups(text, opts);
  if (opts.pageLength != null && opts.pageHeader) return opts.columns > 1 ? renderPrPaginatedColumns(text, opts) : renderPrPaginatedSingleColumn(text, opts);
  const margin = " ".repeat(opts.indent);
  const lines = text.split(/(?<=\n)/).filter(Boolean).map((raw) => {
    let line = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (opts.stripFormFeeds) {
      if (/^\f+$/u.test(line)) return null;
      line = line.replace(/\f+/gu, "\n");
    }
    return opts.explicitPageWidth ? line.slice(0, opts.pageWidth) : line;
  }).filter((line) => line != null);
  const rendered = opts.columns > 1 ? renderPrColumns(lines, opts) : renderPrSingleColumn(lines, opts);
  return opts.doubleSpace ? rendered.replaceAll("\n", "\n\n") : rendered;
}

export function effectivePrExplicitPageWidth(explicitPageWidth, joinLines, columns, pageWidth, opts) {
  const modernPageWidth = opts.W !== undefined || opts["page-width"] !== undefined;
  return explicitPageWidth && !joinLines && (columns > 1 || pageWidth < 72 || modernPageWidth);
}

export function renderPrColumnGroups(text, opts) {
  const tokens = tokenizePrPages(text, opts);
  const groups = [[]];
  for (const token of tokens) {
    if (token.type === "formFeed") groups.push([]);
    else groups[groups.length - 1].push(token.line);
  }
  let out = "";
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].length > 0) out += renderPrColumns(groups[i], opts);
    if (!opts.stripFormFeeds && i < groups.length - 1) out += "\f";
  }
  return opts.doubleSpace ? out.replaceAll("\n", "\n\n") : out;
}

export function renderPrSingleColumn(lines, opts) {
  const margin = " ".repeat(opts.indent);
  return lines.map((line) => {
    if (/^\f+$/u.test(line)) return opts.stripFormFeeds ? "" : line;
    const number = opts.numberLines ? `${formatPrLineNumber(opts.nextNumber(), opts.width)}${opts.separator}` : "";
    if (!opts.stripFormFeeds && line.includes("\f")) {
      const rendered = line.replace(/([^\f])(\f+)/gu, "$1\n$2");
      return `${margin}${number}${rendered}${line.endsWith("\f") ? "" : "\n"}`;
    }
    if (opts.stripFormFeeds && line.endsWith("\n")) return `${margin}${number}${line}`;
    return `${margin}${number}${line}\n`;
  }).join("");
}

export function renderPrPaginatedSingleColumn(text, opts) {
  let out = "";
  const state = createPrPaginatedSingleColumnState(opts, (text) => { out += text; });
  for (const token of tokenizePrPages(text, opts)) state.accept(token);
  state.finish();
  return out;
}

export function streamPrPaginatedSingleColumnFd(fd, opts) {
  const state = createPrPaginatedSingleColumnState(opts, stdout);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  if (!opts.explicitPageWidth) {
    let lineHasText = false;
    let skipNextNewline = false;
    while (true) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      const bytes = buffer.subarray(0, n);
      let start = 0;
      for (let index = 0; index < bytes.length; index++) {
        const byte = bytes[index];
        if (byte !== 0x0a && byte !== 0x0c) continue;
        if (index > start) {
          state.writeLineChunk(bytes.subarray(start, index));
          lineHasText = true;
          skipNextNewline = false;
        }
        if (byte === 0x0a) {
          if (skipNextNewline) skipNextNewline = false;
          else state.endLine();
          lineHasText = false;
        } else {
          if (lineHasText) state.endLine();
          lineHasText = false;
          state.accept({ type: "formFeed" });
          skipNextNewline = true;
        }
        start = index + 1;
      }
      if (start < bytes.length) {
        state.writeLineChunk(bytes.subarray(start));
        lineHasText = true;
        skipNextNewline = false;
      }
    }
    if (lineHasText) state.endLine();
    state.finish();
    return;
  }
  let pending = "";
  let skipNextNewline = false;
  const pushLine = (line) => state.accept({ type: "line", line: opts.explicitPageWidth ? line.slice(0, opts.pageWidth) : line });
  const processText = (text, final = false) => {
    let line = pending;
    pending = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n") {
        if (skipNextNewline) {
          skipNextNewline = false;
          continue;
        }
        pushLine(line);
        line = "";
      } else if (ch === "\f") {
        if (line.length > 0) pushLine(line);
        line = "";
        state.accept({ type: "formFeed" });
        skipNextNewline = true;
      } else {
        skipNextNewline = false;
        line += ch;
      }
    }
    if (final) {
      if (line.length > 0) pushLine(line);
    } else {
      pending = line;
    }
  };
  while (true) {
    const n = readSync(fd, buffer, 0, buffer.length, null);
    if (n === 0) break;
    processText(decodeSurrogateEscapedBytes(buffer.subarray(0, n)));
  }
  processText("", true);
  state.finish();
}

export function createPrPaginatedSingleColumnState(opts, emit) {
  const bodyRows = Math.max(1, opts.pageLength - 10);
  const margin = " ".repeat(opts.indent);
  let page = 1;
  let row = 0;
  let pageStarted = false;
  let lineOpen = false;
  const inRange = () => page >= opts.pageRange.first && page <= opts.pageRange.last;
  const startPage = () => {
    if (!pageStarted && inRange()) emit(opts.pageHeader(page));
    pageStarted = true;
  };
  const endPage = () => {
    const renderedRows = opts.doubleSpace ? row * 2 : row;
    if (pageStarted && inRange()) emit(opts.formFeed ? "\f" : "\n".repeat(Math.max(1, opts.pageLength - 5 - renderedRows)));
    page++;
    row = 0;
    pageStarted = false;
  };
  const startLine = () => {
    if (lineOpen || page > opts.pageRange.last) return;
    if (row >= bodyRows) endPage();
    startPage();
    let number = "";
    if (opts.numberLines && (inRange() || opts.numberSkippedLines)) number = `${formatPrLineNumber(opts.nextNumber(), opts.width)}${opts.separator}`;
    if (inRange()) emit(`${margin}${number}`);
    lineOpen = true;
  };
  const writeLineChunk = (text) => {
    if (!text.length) return;
    startLine();
    if (lineOpen && inRange()) emit(text);
  };
  const endLine = () => {
    startLine();
    if (!lineOpen) return;
    if (inRange()) emit(opts.doubleSpace ? "\n\n" : "\n");
    row++;
    lineOpen = false;
  };
  return {
    writeLineChunk,
    endLine,
    accept(token) {
      if (page > opts.pageRange.last) return;
      if (token.type === "formFeed") {
        if (lineOpen) endLine();
        startPage();
        if (opts.formFeed && inRange() && row === 0) emit("\n");
        if (row === 0 && opts.formFeed) row = 1;
        endPage();
        return;
      }
      writeLineChunk(token.line);
      endLine();
    },
    finish() {
      if (lineOpen) endLine();
      if (pageStarted) endPage();
    },
  };
}

export function renderPrPaginatedColumns(text, opts) {
  const bodyRows = Math.max(1, opts.pageLength - 10);
  const pageCapacity = Math.max(1, bodyRows * opts.columns);
  const tokens = tokenizePrPages(text, opts);
  const separatorWidth = opts.columnSeparatorSpecified ? opts.columnSeparator.length * (opts.columns - 1) : 0;
  const columnWidth = Math.max(1, Math.floor((opts.pageWidth - separatorWidth) / opts.columns));
  const clipWidth = opts.joinLines ? Infinity : Math.max(1, columnWidth - (!opts.columnSeparatorSpecified && (!opts.explicitPageWidth || opts.columns === 2) ? 1 : 0));
  const margin = " ".repeat(opts.indent);
  let out = "";
  let page = 1;
  let entries = [];
  const inRange = () => page >= opts.pageRange.first && page <= opts.pageRange.last;
  const makeEntry = (line) => {
    const number = opts.numberLines && (inRange() || opts.numberSkippedLines) ? opts.nextNumber() : null;
    return { line, number };
  };
  const emitPage = (forceBlankBody = false) => {
    if (inRange()) {
      out += opts.pageHeader(page);
      if (forceBlankBody) out += "\n";
      else out += renderPrColumnPage(entries, { ...opts, bodyRows, clipWidth, columnWidth, margin });
      const renderedRows = forceBlankBody ? 1 : prColumnPageRowCount(entries.length, opts.columns, bodyRows, opts.across);
      out += opts.formFeed ? "\f" : "\n".repeat(Math.max(1, opts.pageLength - 5 - renderedRows));
    }
    page++;
    entries = [];
  };
  for (const token of tokens) {
    if (page > opts.pageRange.last) break;
    if (token.type === "formFeed") {
      emitPage(opts.formFeed && entries.length === 0);
      continue;
    }
    if (entries.length >= pageCapacity) emitPage();
    entries.push(makeEntry(token.line));
  }
  if (entries.length > 0) emitPage();
  return opts.doubleSpace ? out.replaceAll("\n", "\n\n") : out;
}

export function renderPrColumnPage(entries, opts) {
  const rows = prColumnPageRowCount(entries.length, opts.columns, opts.bodyRows, opts.across);
  const out = [];
  for (let row = 0; row < rows; row++) {
    const parts = [];
    for (let column = 0; column < opts.columns; column++) {
      const index = opts.across ? row * opts.columns + column : prDownColumnIndex(entries.length, opts.columns, rows, row, column);
      const entry = entries[index];
      if (entry === undefined) continue;
      const entryClipWidth = opts.numberLines && column > 0 && !opts.columnSeparatorSpecified ? Math.max(1, opts.clipWidth - 1) : opts.clipWidth;
      const implicitSeparatorWidth = opts.columnSeparator.length;
      const explicitImplicitSeparatorWidth = !opts.columnSeparatorSpecified && opts.columns === 2 ? 0 : implicitSeparatorWidth;
      const clipStartColumn = opts.margin.length + (opts.explicitPageWidth || opts.columnSeparatorSpecified ? column * (opts.columnWidth + explicitImplicitSeparatorWidth) : Math.floor((opts.pageWidth * column) / opts.columns));
      let clipped = formatPrColumnEntry(entry, column, { ...opts, compactColumnNumbers: true, paginated: true, clipStartColumn }, entryClipWidth);
      if (opts.numberLines && opts.expandTabs && !opts.columnSeparatorSpecified && column < opts.columns - 1) clipped = `${clipped} \t`;
      parts.push(opts.joinLines || column === opts.columns - 1 || (opts.numberLines && opts.expandTabs && !opts.columnSeparatorSpecified)
        ? clipped
        : opts.columnSeparatorSpecified && opts.padExplicitSeparatorColumns
          ? padPrColumnEnd(clipped.replace(/\s+$/u, ""), column, { columnWidth: opts.columnWidth, clipWidth: opts.columnWidth, formFeed: opts.formFeed, startOffset: opts.margin.length, separatorWidth: opts.columnSeparator.length, allowUnitTabs: true, disallowSingleColumnTab: true })
          : opts.columnSeparatorSpecified
            ? clipped
          : (opts.numberLines ? padPrColumnEnd(clipped.replace(/\s+$/u, ""), column, { ...opts, padExtra: 1 }) : padPrDefaultColumnEnd(clipped.replace(/\s+$/u, ""), column, { ...opts, allowUnitTabs: opts.columns === 2 || opts.margin.length > 0, startOffset: opts.margin.length })));
    }
    let separator = !opts.columnSeparatorSpecified && !opts.joinLines && (!opts.explicitPageWidth || opts.columns === 2) ? "" : opts.columnSeparator;
    if (opts.numberLines && opts.expandTabs && !opts.columnSeparatorSpecified) separator = "";
    if (opts.numberLines && opts.expandTabs && opts.columnSeparatorSpecified) separator += "\t  ";
    if (parts.length) {
      let line = parts.join(separator);
      if (!opts.columnSeparatorSpecified && opts.joinLines && !opts.across) line = formatPrStoredJoinLine(parts, opts);
      else if (!opts.columnSeparatorSpecified && opts.joinLines) line = tabifyPrSpacesAtGnuOutput(line, opts.margin.length);
      else if (!opts.columnSeparatorSpecified && opts.explicitPageWidth) line = tabifyPrSpacesAt(line, opts.margin.length);
      const preserveAcrossPadding = opts.across && row < rows - 1 && parts.slice(1).every((part) => !/\S/u.test(part));
      out.push(`${opts.margin}${preserveAcrossPadding ? line : line.replace(/\s+$/u, "")}\n`);
    }
  }
  return out.join("");
}

export function prColumnPageRowCount(entryCount, columns, bodyRows, across) {
  if (entryCount <= 0) return 0;
  if (across) return Math.ceil(entryCount / columns);
  if (entryCount >= bodyRows * columns) return bodyRows;
  return Math.ceil(entryCount / columns);
}

export function prDownColumnIndex(entryCount, columns, rows, row, column) {
  const full = Math.floor(entryCount / columns);
  const extra = entryCount % columns;
  const height = full + (column < extra ? 1 : 0);
  if (row >= height) return -1;
  let offset = 0;
  for (let c = 0; c < column; c++) offset += full + (c < extra ? 1 : 0);
  return offset + row;
}

export function tokenizePrPages(text, opts) {
  const tokens = [];
  let line = "";
  let skipNextNewline = false;
  const pushLine = () => {
    tokens.push({ type: "line", line: opts.explicitPageWidth ? line.slice(0, opts.pageWidth) : line });
    line = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      if (skipNextNewline) {
        skipNextNewline = false;
        continue;
      }
      pushLine();
    } else if (ch === "\f") {
      if (line.length > 0) pushLine();
      tokens.push({ type: "formFeed" });
      skipNextNewline = true;
    } else {
      skipNextNewline = false;
      line += ch;
    }
  }
  if (line.length > 0) pushLine();
  return tokens;
}

export function padPrColumnEnd(text, column, opts) {
  const start = (opts.startOffset ?? 0) + column * opts.columnWidth + column * (opts.separatorWidth ?? 1);
  const width = column === 0 ? opts.columnWidth : opts.clipWidth;
  const target = start + width + (opts.padExtra ?? 0);
  let out = text;
  let display = prColumnAfter(text, start);
  while (display < target) {
    const toStop = 8 - (display % 8);
    const remaining = target - display;
    if ((toStop > 1 || !opts.formFeed || (opts.allowUnitTabs && !(opts.disallowSingleColumnTab && remaining === 1))) && display + toStop <= target) {
      out += "\t";
      display += toStop;
    } else {
      out += " ";
      display++;
    }
  }
  return out;
}

export function renderPrMerge(texts, opts) {
  const files = texts.map((text) => {
    if (opts.stripFormFeeds) text = text.replaceAll("\f", "");
    return text.split(/(?<=\n)/).filter(Boolean).map((raw) => raw.endsWith("\n") ? raw.slice(0, -1) : raw);
  });
  if (opts.pageLength != null && opts.pageHeader) return renderPrPaginatedMerge(files, opts);
  const rowCount = Math.max(0, ...files.map((lines) => lines.length));
  const columnCount = opts.columnCount ?? files.length;
  const columnSeparator = opts.defaultColumnSeparator && opts.padColumns && !opts.joinLines ? "" : opts.columnSeparator;
  const separatorWidth = columnSeparator.length * Math.max(0, columnCount - 1);
  const columnWidth = columnCount ? Math.max(1, Math.floor((opts.pageWidth - separatorWidth) / columnCount)) : opts.pageWidth;
  const out = [];
  for (let row = 0; row < rowCount; row++) {
    const parts = [];
    let column = opts.indent;
    for (let index = 0; index < files.length; index++) {
      if (index > 0) column += columnSeparator.length;
      let value = files[index][row] ?? "";
      if (!opts.joinLines && index > 0 && !opts.preserveMergeTabs) value = tabifyPrSpacesAt(expandPrTabs(value, 8), column, true);
      if (!opts.joinLines && opts.padColumns && index < files.length - 1) value = padPrMergeEnd(value, columnWidth);
      parts.push(value);
      column = prColumnAfter(value, column);
    }
    const body = opts.joinLines ? formatPrMergeJoinLine(parts, opts.columnSeparator) : parts.join(columnSeparator);
    out.push(`${" ".repeat(opts.indent)}${opts.joinLines ? body : body.slice(0, opts.pageWidth)}\n`);
  }
  return out.join("");
}

export function renderPrPaginatedMerge(files, opts) {
  const bodyRows = Math.max(1, opts.pageLength - 10);
  const pages = files.map((lines) => paginatePrMergeLines(lines, bodyRows));
  const pageCount = Math.max(0, ...pages.map((filePages) => filePages.length));
  const columnCount = opts.columnCount ?? files.length;
  const separatorWidth = opts.columnSeparator.length * Math.max(0, columnCount - 1);
  const numberWidth = opts.numberLines ? opts.width + opts.separator.length : 0;
  const columnWidth = columnCount ? Math.max(1, Math.floor((opts.pageWidth - numberWidth - separatorWidth) / columnCount)) : opts.pageWidth;
  let out = "";
  for (let page = 1; page <= pageCount; page++) {
    const pageRows = pages.map((filePages) => filePages[page - 1] ?? []);
    const hasFirstFileRows = (pageRows[0] ?? []).some((line) => line !== null);
    const visible = page >= opts.pageRange.first && page <= opts.pageRange.last;
    if (!visible && opts.numberLines && opts.numberSkippedLines && hasFirstFileRows) {
      for (let row = 0; row < bodyRows; row++) if ((pageRows[0] ?? [])[row] != null) opts.nextNumber();
      continue;
    }
    if (!visible) continue;
    out += opts.pageHeader(page);
    let emittedRows = 0;
    for (let row = 0; row < bodyRows; row++) {
      const values = pageRows.map((rows) => rows[row]);
      if (!values.some((value) => value != null)) continue;
      const number = opts.numberLines ? `${formatPrLineNumber(opts.nextNumber(), opts.width)}${opts.separator}` : "";
      if (opts.joinLines) {
        const pageEndMissingRight = values[values.length - 1] == null
          && !pageRows.some((rows) => rows.slice(row + 1).some((line) => line != null));
        const bodyValues = pageEndMissingRight && page < pageCount && (!opts.numberLines || values[0] != null) ? values.slice(0, values.reduce((last, value, index) => value == null ? last : index, -1) + 1) : values;
        const body = formatPrMergeJoinLine(bodyValues, opts.columnSeparator, opts.indent + prDisplayWidth(number));
        out += `${" ".repeat(opts.indent)}${number}${body}\n`;
        emittedRows++;
        continue;
      }
      const clippedParts = values.map((value, index) => {
        const startColumn = opts.indent + numberWidth + index * (columnWidth + opts.columnSeparator.length);
        const text = tabifyPrSpacesAt(prMergeCellText(value), startColumn, true);
        return index === values.length - 1
          ? (opts.numberLines ? clipPrLastMergeColumn(text, columnWidth, startColumn, !opts.padColumns) : clipPrDisplay(text, columnWidth, startColumn).replace(/\s+$/u, ""))
          : clipPrDisplay(text, columnWidth, startColumn);
      });
      const lastNonNull = values.reduce((last, value, index) => value == null ? last : index, -1);
      const pageEndMissingRight = (!opts.padColumns || page === pageCount || values.some((value) => value?.beforeFormFeed || value?.sourceHadFormFeed))
        && values[values.length - 1] == null
        && !pageRows.some((rows) => rows.slice(row + 1).some((line) => line != null));
      if (pageEndMissingRight && lastNonNull >= 0 && lastNonNull < values.length - 1) {
        const startColumn = opts.indent + numberWidth + lastNonNull * (columnWidth + opts.columnSeparator.length);
        const text = tabifyPrSpacesAt(prMergeCellText(values[lastNonNull]), startColumn, true);
        clippedParts[lastNonNull] = opts.explicitPageWidth
          ? clipPrDisplay(text, columnWidth, startColumn)
          : clipPrLastMergeColumn(text, columnWidth, startColumn, true);
        const remainingText = text.slice(clippedParts[lastNonNull].length);
        if (opts.explicitPageWidth && /^\S/u.test(remainingText)) clippedParts[lastNonNull] = clippedParts[lastNonNull].replace(/\s+$/u, "");
        else if (opts.explicitPageWidth && remainingText.startsWith(" ")) clippedParts[lastNonNull] += " ";
        if (!opts.explicitPageWidth && !values[lastNonNull]?.sourceHadFormFeed && !(opts.numberLines && values.some((value) => value?.beforeFormFeed || value?.sourceHadFormFeed)) && !/\s$/u.test(clippedParts[lastNonNull]) && /\S/u.test(text.slice(clippedParts[lastNonNull].length))) {
          clippedParts[lastNonNull] += " ";
        }
      }
      const unpadPageEnd = pageEndMissingRight
        && (values.some((value) => value?.beforeFormFeed) || prDisplayWidth(clippedParts[lastNonNull].replace(/\s+$/u, "")) >= columnWidth - 1);
      const parts = clippedParts.map((clipped, index) => {
        if (index >= values.length - 1 || (unpadPageEnd && index === lastNonNull)) return clipped;
        return padPrColumnEnd(clipped.replace(/\s+$/u, ""), index, { columnWidth, clipWidth: columnWidth, formFeed: opts.formFeed, startOffset: opts.indent + numberWidth, separatorWidth: opts.columnSeparator.length, allowUnitTabs: true, disallowSingleColumnTab: opts.padColumns && (files.length > 2 || opts.numberLines) });
      });
      const body = (unpadPageEnd ? parts.slice(0, lastNonNull + 1) : parts).join(opts.columnSeparator);
      out += `${" ".repeat(opts.indent)}${number}${body}\n`;
      emittedRows++;
    }
    out += opts.formFeed ? `${emittedRows === 0 ? "\n" : ""}\f` : "\n".repeat(Math.max(1, opts.pageLength - 5 - emittedRows));
  }
  return out;
}

export function prMergeCellText(value) {
  if (value == null) return "";
  return typeof value === "object" ? value.line : String(value);
}

export function formatPrMergeJoinLine(values, separator, startColumn = 0) {
  const parts = [];
  let column = startColumn;
  for (let index = 0; index < values.length; index++) {
    let text = tabifyPrSpacesAt(prMergeCellText(values[index]), column, true);
    if (index === values.length - 1) text = text.replace(/[ \t]+$/u, "");
    parts.push(text);
    column = prColumnAfter(text, column);
    if (index < values.length - 1) column += separator.length;
  }
  return parts.join(separator);
}

export function clipPrLastMergeColumn(text, width, startColumn = 0, preserveSourceContinuation = false) {
  const clipped = clipPrDisplay(text, width, startColumn);
  if (!/\s$/u.test(clipped)) return clipped;
  const lookahead = preserveSourceContinuation ? clipPrDisplay(text, width + 1, startColumn) : clipped;
  if (lookahead.length > clipped.length && /\S/u.test(lookahead.slice(clipped.length))) return clipped;
  return clipped.replace(/\s+$/u, "");
}

export function paginatePrMergeLines(lines, bodyRows) {
  const pages = [];
  let page = [];
  let justFlushed = false;
  for (const line of lines) {
    const parts = String(line).split("\f");
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      let flushedFullPage = false;
      if (part !== "" || !String(line).includes("\f")) {
        page.push({ line: part, beforeFormFeed: false, sourceHadFormFeed: String(line).includes("\f") });
        if (page.length >= bodyRows) {
          pages.push(page);
          page = [];
          justFlushed = true;
          flushedFullPage = true;
        }
      }
      if (i < parts.length - 1) {
        if (page.length > 0) page[page.length - 1].beforeFormFeed = true;
        if (justFlushed) justFlushed = false;
        else pages.push(page);
        page = [];
      }
      if (part !== "" && !flushedFullPage) justFlushed = false;
    }
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

export function renderPrColumns(lines, opts) {
  const pageRows = opts.pageLength ?? Math.ceil(lines.length / opts.columns);
  const pageCapacity = Math.max(1, pageRows * opts.columns);
  const separatorWidth = opts.columnSeparator.length * (opts.columns - 1);
  const columnWidth = Math.max(1, Math.floor((opts.pageWidth - separatorWidth) / opts.columns));
  const clipWidth = opts.joinLines ? Infinity : columnWidth;
  const out = [];
  for (let pageStart = 0, page = 1; pageStart < lines.length; pageStart += pageCapacity, page++) {
    if (page < opts.pageRange.first || page > opts.pageRange.last) continue;
    const pageLines = lines.slice(pageStart, pageStart + pageCapacity).map((line) => ({ line, number: opts.numberLines ? opts.nextNumber() : null }));
    const rows = opts.pageLength ?? Math.ceil(pageLines.length / opts.columns);
    for (let row = 0; row < rows; row++) {
      const parts = [];
      for (let column = 0; column < opts.columns; column++) {
        const index = opts.across ? row * opts.columns + column : prDownColumnIndex(pageLines.length, opts.columns, rows, row, column);
        const entry = pageLines[index];
        if (entry === undefined) continue;
        let clipped = formatPrColumnEntry(entry, column, { ...opts, compactColumnNumbers: true }, clipWidth);
        if (opts.numberLines && opts.expandTabs && !opts.columnSeparatorSpecified && column < opts.columns - 1) clipped = `${clipped} \t`;
        parts.push(column === opts.columns - 1 || (opts.columnSeparatorSpecified && !opts.padExplicitSeparatorColumns) || (opts.numberLines && opts.expandTabs && !opts.columnSeparatorSpecified)
          ? clipped
          : opts.columnSeparatorSpecified
            ? padPrColumnEnd(clipped.replace(/\s+$/u, ""), column, { columnWidth, clipWidth: columnWidth, formFeed: opts.formFeed, startOffset: opts.indent, separatorWidth: opts.columnSeparator.length, allowUnitTabs: true, disallowSingleColumnTab: true })
            : padPrDefaultColumnEnd(clipped.replace(/\s+$/u, ""), column, { ...opts, columnWidth, allowUnitTabs: opts.allowUnitTabs || opts.numberLines, finalNumberBoundaryTab: opts.numberLines && !opts.columnSeparatorSpecified, padExtra: opts.numberLines && !opts.columnSeparatorSpecified ? 4 : opts.padExtra }));
      }
      let separator = !opts.columnSeparatorSpecified && !opts.explicitPageWidth ? "" : opts.columnSeparator;
      if (opts.numberLines && opts.expandTabs && !opts.columnSeparatorSpecified) separator = "";
      if (opts.numberLines && opts.expandTabs && opts.columnSeparatorSpecified) separator += "\t  ";
      if (parts.length) out.push(`${" ".repeat(opts.indent)}${parts.join(separator).replace(/\s+$/u, "")}\n`);
    }
  }
  return out.join("");
}

export function padPrDefaultColumnEnd(text, column, opts) {
  const implicitSeparatorWidth = opts.columnSeparatorSpecified ? 0 : opts.columnSeparator.length;
  const implicitSeparatorTrim = opts.explicitPageWidth && !opts.columnSeparatorSpecified ? 1 : 0;
  const startOffset = opts.startOffset ?? 0;
  const target = opts.explicitPageWidth
    ? startOffset + (column + 1) * opts.columnWidth + column * implicitSeparatorWidth
    : startOffset + Math.floor((opts.pageWidth * (column + 1)) / opts.columns) - implicitSeparatorTrim + (opts.padExtra ?? 0);
  const start = startOffset + (opts.explicitPageWidth ? column * (opts.columnWidth + implicitSeparatorWidth) : Math.floor((opts.pageWidth * column) / opts.columns));
  let out = text;
  let display = prColumnAfter(text, start);
  while (display < target) {
    const toStop = 8 - (display % 8);
    if (opts.finalNumberBoundaryTab && display % 8 === 0 && target - display === 8) {
      out += "    \t";
      display += 8;
      continue;
    }
    if ((toStop > 1 || opts.allowUnitTabs) && display + toStop <= target) {
      out += "\t";
      display += toStop;
    } else {
      out += " ";
      display++;
    }
  }
  return out;
}

export function formatPrColumnEntry(entry, column, opts, columnWidth) {
  let text = entry.line;
  if (!opts.numberLines) {
    if (column > 0 && !opts.columnSeparatorSpecified) text = text.replaceAll("\t", "\t    ");
    if (opts.paginated && !opts.joinLines) text = tabifyPrSpacesAt(text, opts.clipStartColumn ?? 0, !opts.explicitPageWidth || opts.columnSeparatorSpecified);
    return opts.paginated ? finishPrColumnClip(text, columnWidth, opts) : text.slice(0, columnWidth);
  }
  let clipWidth = columnWidth;
  let prefix;
  if (opts.expandTabs && opts.indent > 0 && !opts.columnSeparatorSpecified) {
    return formatPrIndentedTabbedColumn(entry, column, opts, columnWidth);
  }
  if (opts.expandTabs && column > 0 && !opts.columnSeparatorSpecified) {
    const number = String(entry.number);
    prefix = opts.separator === "\t" ? `${number}${" ".repeat(Math.max(1, opts.width - number.length - 1))}` : `${number}${opts.separator}`;
    clipWidth = Math.max(1, columnWidth - 4);
  } else if (opts.expandTabs && column > 0 && opts.columnSeparatorSpecified) {
    const number = String(entry.number);
    prefix = `${number}${opts.separator}`;
    clipWidth = Math.max(1, columnWidth - 2);
  } else {
    if (opts.compactColumnNumbers && column > 0 && !opts.columnSeparatorSpecified) {
      const number = String(entry.number);
      prefix = opts.separator === "\t" ? `${number}${" ".repeat(Math.max(1, opts.width - number.length - 1))}` : `${number}${opts.separator}`;
    } else {
      prefix = `${formatPrLineNumber(entry.number, opts.width)}${opts.separator}`;
    }
  }
  text = `${prefix}${text}`;
  if (opts.numberLines && opts.expandTabs && column > 0 && !opts.columnSeparatorSpecified) text = text.replace(/\t+/g, "\t    ");
  else if (opts.numberLines && opts.expandTabs && column > 0 && opts.columnSeparatorSpecified) text = text.replace(/\t+/g, "\t      ");
  if (opts.paginated && opts.columnSeparatorSpecified && !opts.joinLines) text = tabifyPrSpacesAt(text, opts.clipStartColumn ?? 0, true);
  return finishPrColumnClip(text, clipWidth, opts);
}

export function finishPrColumnClip(text, width, opts) {
  const startColumn = opts.clipStartColumn ?? 0;
  const clipped = clipPrDisplay(text, width, startColumn);
  if (!opts.columnSeparatorSpecified || !/\s$/u.test(clipped)) return clipped;
  const lookahead = clipPrDisplay(text, width + 1, startColumn);
  if (lookahead.length > clipped.length && /\S/u.test(lookahead.slice(clipped.length))) return clipped.replace(/\s+$/u, " ");
  return clipped;
}

export function formatPrIndentedTabbedColumn(entry, column, opts, columnWidth) {
  const number = String(entry.number);
  const numberPrefix = column === 0
    ? `${formatPrLineNumber(entry.number, opts.width)}   `
    : `${" ".repeat(Math.max(1, opts.width - number.length - 1))}${number}   `;
  const body = formatPrIndentedTabbedBody(entry.line, column, opts.tabSize);
  const clipWidth = Math.max(1, columnWidth + (column === 0 ? 3 : -1));
  return clipPrDisplay(`${numberPrefix}${body}`, clipWidth);
}

export function formatPrIndentedTabbedBody(text, column, tabSize) {
  const fields = text.split("\t");
  if (fields.length >= 4 && fields[2] === "") {
    const [first, second] = fields;
    const rest = fields.slice(3).join("\t");
    if (tabSize === 5) return column === 0 ? `${first}\t  ${second}\t\t ${rest}` : `${first}    ${second}\t     ${rest}`;
    return column === 0 ? `${first}\t   ${second}\t   ${rest}` : `${first}     ${second}\t       ${rest}`;
  }
  if (tabSize === 5) {
    if (column === 0) return text.replace(/\t\t/g, "\t\t ").replace(/\t(?!\t)/g, "\t  ");
    return text.replace(/\t+/g, "    ");
  }
  if (column === 0) return text.replace(/\t+/g, "\t   ");
  return text.replace(/\t+/g, "     ");
}

export function clipPrDisplay(text, width, startColumn = 0) {
  let out = "";
  let column = startColumn;
  const limit = startColumn + width;
  for (const ch of text) {
    const nextColumn = ch === "\t" ? column + (8 - (column % 8)) : ch === "\b" ? Math.max(0, column - 1) : column + 1;
    if (nextColumn > limit) break;
    out += ch;
    column = nextColumn;
  }
  return out;
}

export function tabifyPrSpacesAt(text, startColumn = 0, allowUnitTabs = false) {
  let out = "";
  let column = startColumn;
  for (let index = 0; index < text.length;) {
    const ch = text[index];
    if (ch !== " ") {
      out += ch;
      column = ch === "\t" ? column + (8 - (column % 8)) : ch === "\b" ? Math.max(0, column - 1) : column + 1;
      index++;
      continue;
    }
    let end = index;
    while (end < text.length && text[end] === " ") end++;
    let remaining = end - index;
    while (remaining > 0) {
      const toStop = 8 - (column % 8);
      if ((toStop > 1 || (allowUnitTabs && remaining > 1)) && remaining >= toStop) {
        out += "\t";
        column += toStop;
        remaining -= toStop;
      } else {
        out += " ";
        column++;
        remaining--;
      }
    }
    index = end;
  }
  return out;
}

export function tabifyPrSpacesAtGnuOutput(text, startColumn = 0) {
  let out = "";
  let column = startColumn;
  for (let index = 0; index < text.length;) {
    const ch = text[index];
    if (ch !== " ") {
      out += ch;
      column = ch === "\b" ? Math.max(0, column - 1) : column + 1;
      index++;
      continue;
    }
    let end = index;
    while (end < text.length && text[end] === " ") end++;
    let goal = column + end - index;
    while (goal - column > 1) {
      const next = column + (8 - (column % 8));
      if (next > goal) break;
      out += "\t";
      column = next;
    }
    while (column < goal) {
      out += " ";
      column++;
    }
    index = end;
  }
  return out;
}

export function formatPrStoredJoinLine(parts, opts) {
  let out = "";
  let outputPosition = opts.margin.length;
  let spacesNotPrinted = 0;
  let separatorsNotPrinted = 0;
  const separator = opts.columnSeparator;
  const separatorLength = separator.length;

  const printWhiteSpace = () => {
    let current = outputPosition;
    const goal = current + spacesNotPrinted;
    while (goal - current > 1) {
      const next = current + (8 - (current % 8));
      if (next > goal) break;
      out += "\t";
      current = next;
    }
    while (current < goal) {
      out += " ";
      current++;
    }
    outputPosition = goal;
    spacesNotPrinted = 0;
  };

  const printChar = (ch) => {
    if (ch === " ") {
      spacesNotPrinted++;
      return;
    }
    if (spacesNotPrinted > 0) printWhiteSpace();
    out += ch;
    if (ch === "\b") outputPosition = Math.max(0, outputPosition - 1);
    else if (isPrPrintable(ch)) outputPosition++;
  };

  const printSeparator = () => {
    if (separatorsNotPrinted <= 0) {
      if (spacesNotPrinted > 0) printWhiteSpace();
      return;
    }
    for (; separatorsNotPrinted > 0; separatorsNotPrinted--) {
      for (const ch of separator) {
        if (ch === " ") {
          spacesNotPrinted++;
          continue;
        }
        if (spacesNotPrinted > 0) printWhiteSpace();
        out += ch;
        outputPosition++;
      }
      if (spacesNotPrinted > 0) printWhiteSpace();
    }
  };

  parts.forEach((part, column) => {
    const startPosition = column === 0 ? opts.margin.length + separatorLength : opts.margin.length;
    if (separatorLength < startPosition) spacesNotPrinted = startPosition - separatorLength - outputPosition;
    printSeparator();
    for (const ch of part) printChar(ch);
    if (spacesNotPrinted === 0) {
      outputPosition = startPosition + prStoredEndPosition(part, opts.tabSize);
      if (startPosition - separatorLength === opts.margin.length) outputPosition -= separatorLength;
    }
    separatorsNotPrinted++;
  });

  return out;
}

export function prStoredEndPosition(text, tabSize = 8) {
  let position = 0;
  for (const ch of text) {
    if (ch === "\t") position += tabSize - (position % tabSize);
    else if (ch === "\b") position = Math.max(0, position - 1);
    else if (isPrPrintable(ch) || ch === " ") position++;
  }
  return position;
}

export function isPrPrintable(ch) {
  const code = ch.codePointAt(0);
  return code >= 0x20 && code !== 0x7f;
}

export function padPrMergeEnd(text, width) {
  let out = text;
  let displayWidth = prDisplayWidth(text);
  while (displayWidth + (8 - (displayWidth % 8)) <= width) {
    const spaces = 8 - (displayWidth % 8);
    out += "\t";
    displayWidth += spaces;
  }
  if (displayWidth < width) out += " ".repeat(width - displayWidth);
  return out;
}

export function prDisplayWidth(text) {
  let column = 0;
  for (const ch of text) {
    if (ch === "\t") column += 8 - (column % 8);
    else if (ch === "\b") column = Math.max(0, column - 1);
    else column++;
  }
  return column;
}

export function prColumnAfter(text, startColumn = 0) {
  let column = startColumn;
  for (const ch of text) {
    if (ch === "\t") column += 8 - (column % 8);
    else if (ch === "\b") column = Math.max(0, column - 1);
    else column++;
  }
  return column;
}

export function formatPrLineNumber(value, width) {
  const text = String(value);
  const clipped = text.length > width ? text.slice(-width) : text;
  return clipped.padStart(width);
}

const singleCall = defineCommand("pr", prCmd, prMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
