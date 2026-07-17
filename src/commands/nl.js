#!/usr/bin/env bun

import { decodeSurrogateEscapedBytes, localeQuotedEscapedDiagnostic, parseOptions, readAll, readStdinRecords, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { InvocationError, UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { tacRegexPattern } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const NL_LONG_OPTIONS = ["body-numbering", "section-delimiter", "footer-numbering", "header-numbering", "line-increment", "join-blank-lines", "no-renumber", "number-separator", "number-width", "number-format", "starting-line-number", "help", "version"];

export function nlMetaOption(args) {
  const longValueOptions = new Set(["body-numbering", "section-delimiter", "footer-numbering", "header-numbering", "line-increment", "join-blank-lines", "number-format", "number-separator", "starting-line-number", "number-width"]);
  const longNoValueOptions = new Set(["no-renumber"]);
  const diagnostics = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      let option;
      try {
        option = normalizeNlLongOption(arg);
      } catch (error) {
        if (error instanceof UsageError) {
          diagnostics.push(`nl: ${error.message}\n`);
          continue;
        }
        throw error;
      }
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!NL_LONG_OPTIONS.includes(name)) {
        diagnostics.push(`nl: unrecognized option '${arg}'\n`);
        continue;
      }
      if (name === "help" || name === "version") {
        if (inlineValue == null) {
          for (const line of diagnostics) stderr(line);
          return `--${name}`;
        }
        diagnostics.push(`nl: option '--${name}' doesn't allow an argument\n`);
        continue;
      }
      if (longValueOptions.has(name)) {
        const value = inlineValue ?? args[i + 1];
        if (value !== undefined) validateNlMetaOptionValue(name, value, diagnostics);
      }
      if (inlineValue == null && longValueOptions.has(name)) {
        i++;
        continue;
      }
      if (inlineValue != null) {
        if (longNoValueOptions.has(name)) diagnostics.push(`nl: option '--${name}' doesn't allow an argument\n`);
        else if (!longValueOptions.has(name)) return null;
      }
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    const valueOption = arg.slice(1).match(/[bdfhilnsvw]/);
    if (valueOption) {
      const ch = valueOption[0];
      const inlineValue = arg.slice(arg.indexOf(ch) + 1);
      const value = inlineValue === "" ? args[i + 1] : inlineValue;
      validateNlMetaShortValue(ch, value, diagnostics);
      if (inlineValue === "") i++;
      continue;
    }
    for (const ch of arg.slice(1)) {
      if (ch !== "p") {
        diagnostics.push(`nl: invalid option -- '${ch}'\n`);
        break;
      }
    }
  }
  return null;
}

export function validateNlMetaOptionValue(name, value, diagnostics) {
  if ((name === "body-numbering" || name === "header-numbering" || name === "footer-numbering") && !nlNumberingStyleValid(value)) {
    diagnostics.push(`nl: invalid ${name.split("-", 1)[0]} numbering style: ${localeQuotedEscapedDiagnostic(value)}\n`);
  } else if (name === "number-format" && !nlNumberFormatValid(value)) {
    diagnostics.push(`nl: invalid line numbering format: ${localeQuotedEscapedDiagnostic(value)}\n`);
  } else if (name === "line-increment") parseNlBigInt(value, "invalid line number increment");
  else if (name === "starting-line-number") parseNlBigInt(value, "invalid starting line number");
  else if (name === "join-blank-lines") parseNlJoinBlank(value);
  else if (name === "number-width") parseNlWidth(value);
}

export function validateNlMetaShortValue(ch, value, diagnostics) {
  if (value === undefined) return;
  const names = { b: "body-numbering", f: "footer-numbering", h: "header-numbering", i: "line-increment", l: "join-blank-lines", n: "number-format", v: "starting-line-number", w: "number-width" };
  const name = names[ch];
  if (name) validateNlMetaOptionValue(name, value, diagnostics);
}

export function normalizeNlLongOptions(args, reportAmbiguous = true) {
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
    out.push(normalizeNlLongOption(arg, reportAmbiguous));
  }
  return out;
}

export function normalizeNlLongOption(arg, reportAmbiguous = true) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  const matches = NL_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length === 1) return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
  if (matches.length > 1 && reportAmbiguous) {
    throw new UsageError(`option '${arg}' is ambiguous; possibilities: ${matches.map((option) => `'--${option}'`).join(" ")}`, true);
  }
  return arg;
}

export async function nlCmd(args) {
  args = normalizeNlLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { b: "value", d: "value", f: "value", h: "value", i: "value", l: "value", n: "value", p: false, s: "value", v: "value", w: "value" }, long: { "body-numbering": "value", "section-delimiter": "value", "footer-numbering": "value", "header-numbering": "value", "line-increment": "value", "join-blank-lines": "value", "number-format": "value", "no-renumber": false, "number-separator": "value", "starting-line-number": "value", "number-width": "value", help: false, version: false } });
  const files = operands.length ? operands : ["-"];
  const body = opts.b ?? opts["body-numbering"] ?? "t";
  const header = opts.h ?? opts["header-numbering"] ?? "n";
  const footer = opts.f ?? opts["footer-numbering"] ?? "n";
  const format = opts.n ?? opts["number-format"] ?? "rn";
  validateNlNumberingStyle(body, "body");
  validateNlNumberingStyle(header, "header");
  validateNlNumberingStyle(footer, "footer");
  const bodyPattern = nlNumberingPattern(body);
  const headerPattern = nlNumberingPattern(header);
  const footerPattern = nlNumberingPattern(footer);
  validateNlNumberFormat(format);
  const width = parseNlWidth(opts.w ?? opts["number-width"] ?? "6");
  const sep = opts.s ?? opts["number-separator"] ?? "\t";
  const increment = parseNlBigInt(opts.i ?? opts["line-increment"] ?? "1", "invalid line number increment");
  const joinBlank = parseNlJoinBlank(opts.l ?? opts["join-blank-lines"] ?? 1);
  const start = parseNlBigInt(opts.v ?? opts["starting-line-number"] ?? "1", "invalid starting line number");
  const delimiter = normalizeNlDelimiter(opts.d ?? opts["section-delimiter"] ?? "\\:");
  let number = start;
  let blankRun = 0;
  let out = "";
  let status = 0;
  let currentSection = "body";
  const renderLine = (raw) => {
    const line = raw.replace(/\n$/, "");
    const section = nlSection(line, delimiter);
    if (section) {
      if (!(opts.p || opts["no-renumber"])) number = start;
      currentSection = section;
      blankRun = 0;
      return "\n";
    }
    const blank = raw === "\n";
    blankRun = blank ? blankRun + 1 : 0;
    const style = currentSection === "header" ? header : currentSection === "footer" ? footer : body;
    const pattern = currentSection === "header" ? headerPattern : currentSection === "footer" ? footerPattern : bodyPattern;
    const shouldNumber = shouldNumberNl(line, style, blank, blankRun, joinBlank, pattern);
    if (shouldNumber) {
      if (number > NlMax || number < NlMin) throw new InvocationError("line number overflow", 1, false);
      const rendered = `${formatNlNumber(number, width, format)}${sep}${raw}`;
      number += increment;
      return rendered;
    }
    return `${" ".repeat(width + sep.length)}${raw}`;
  };
  if (files.length === 1 && files[0] === "-") {
    readStdinRecords("\n", (line) => stdout(renderLine(`${line}\n`)));
    return 0;
  }
  for (const file of files) {
    let data;
    try {
      data = decodeSurrogateEscapedBytes(await readAll(file));
    } catch (error) {
      stderr(`nl: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      status = 1;
      continue;
    }
    const records = splitNlRecords(data);
    for (const raw of records) {
      out += renderLine(raw);
    }
  }
  stdout(out);
  return status;
}

export const NlMax = 9223372036854775807n;

export const NlMin = -9223372036854775808n;

export function validateNlNumberingStyle(style, section) {
  if (nlNumberingStyleValid(style)) return;
  throw new UsageError(`invalid ${section} numbering style: ${localeQuotedEscapedDiagnostic(style)}`, true);
}

export function nlNumberingStyleValid(style) {
  return style === "a" || style === "t" || style === "n" || String(style).startsWith("p");
}

export function validateNlNumberFormat(format) {
  if (nlNumberFormatValid(format)) return;
  throw new UsageError(`invalid line numbering format: ${localeQuotedEscapedDiagnostic(format)}`, true);
}

export function nlNumberFormatValid(format) {
  return format === "ln" || format === "rn" || format === "rz";
}

export function nlNumberingPattern(style) {
  if (!String(style).startsWith("p")) return null;
  try {
    return new RegExp(tacRegexPattern(String(style).slice(1)));
  } catch {
    throw new UsageError("Invalid regular expression");
  }
}

export function parseNlJoinBlank(value) {
  const text = String(value);
  if (/^-\d+$/.test(text)) throw new UsageError(`invalid line number of blank lines: ${localeQuotedEscapedDiagnostic(text)}: Numerical result out of range`);
  if (!/^\+?\d+$/.test(text)) throw new UsageError(`invalid line number of blank lines: ${localeQuotedEscapedDiagnostic(text)}`);
  const n = BigInt(text);
  if (n > NlMax) throw new UsageError(`invalid line number of blank lines: ${localeQuotedEscapedDiagnostic(text)}: Value too large for defined data type`);
  return Number(n);
}

export function parseNlBigInt(value, message) {
  const text = String(value);
  if (!/^[+-]?\d+$/.test(text)) throw new UsageError(`${message}: ${localeQuotedEscapedDiagnostic(text)}`);
  const n = BigInt(text);
  if (n > NlMax || n < NlMin) throw new UsageError(`${message}: ${localeQuotedEscapedDiagnostic(text)}: Value too large for defined data type`);
  return n;
}

export function parseNlWidth(value) {
  const text = String(value);
  if (!/^[+-]?\d+$/.test(text)) throw new UsageError(`invalid line number field width: ${localeQuotedEscapedDiagnostic(text)}`);
  const width = BigInt(text);
  if (width <= 0n) throw new UsageError(`invalid line number field width: ${localeQuotedEscapedDiagnostic(text)}: Numerical result out of range`);
  if (width > 2147483647n) throw new UsageError(`invalid line number field width: ${localeQuotedEscapedDiagnostic(text)}: Value too large for defined data type`);
  return Number(width);
}

export function normalizeNlDelimiter(value) {
  if (value === "") return "";
  return value.length === 1 ? `${value}:` : value;
}

export function nlSection(line, delimiter) {
  if (!delimiter) return null;
  if (nlDelimiterEquals(line, `${delimiter}${delimiter}${delimiter}`)) return "header";
  if (nlDelimiterEquals(line, `${delimiter}${delimiter}`)) return "body";
  if (nlDelimiterEquals(line, delimiter)) return "footer";
  return null;
}

export function nlDelimiterEquals(line, marker) {
  if (line.length !== marker.length) return false;
  for (let i = 0; i < marker.length; i++) {
    if (line[i] === marker[i]) continue;
    const markerCode = marker.charCodeAt(i);
    const lineCode = line.charCodeAt(i);
    if (markerCode === 0xfffd && lineCode >= 0xdc80 && lineCode <= 0xdcff) continue;
    return false;
  }
  return true;
}

export function splitNlRecords(data) {
  if (data === "") return [];
  const records = data.split(/(?<=\n)/).filter((raw) => raw !== "");
  const last = records[records.length - 1];
  if (last && !last.endsWith("\n")) records[records.length - 1] = `${last}\n`;
  return records;
}

export function shouldNumberNl(line, style, blank, blankRun, joinBlank, pattern = null) {
  if (style === "n") return false;
  if (style === "a") return !blank || blankRun % joinBlank === 0;
  if (style === "t") return !blank;
  if (style.startsWith("p")) return pattern.test(line);
  return !blank;
}

export function formatNlNumber(number, width, format) {
  const text = String(number);
  if (format === "ln") return text.padEnd(width);
  if (format === "rz") return text.padStart(width, "0");
  return text.padStart(width);
}

const singleCall = defineCommand("nl", nlCmd, nlMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
