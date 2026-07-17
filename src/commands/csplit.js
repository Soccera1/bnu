#!/usr/bin/env bun

import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { lstat, rm, writeFile } from "node:fs/promises";
import { enc, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, nodeErrorMessage, normalizeLongOptionByPrefix, parseOptions, pathDisplayName, readAll, shellEscapeLsName, systemErrorMessage } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const CSPLIT_LONG_OPTIONS = ["silent", "suffix-format", "suppress-matched", "prefix", "keep-files", "digits", "quiet", "elide-empty-files", "help", "version"];

export function csplitMetaOption(args) {
  const longValueOptions = new Set(["suffix-format", "prefix", "digits"]);
  const longKnownOptions = new Set(CSPLIT_LONG_OPTIONS);
  const shortValueOptions = new Set(["b", "f", "n"]);
  const shortKnownOptions = new Set(["b", "f", "k", "n", "q", "s", "z"]);
  const normalized = normalizeCsplitLongOptionAbbreviations(args);
  for (let i = 0; i < normalized.length; i++) {
    const arg = normalized[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (!longKnownOptions.has(name)) return null;
      if (arg === "--help" || arg === "--version") return arg;
      if (longValueOptions.has(name)) {
        const value = inlineValue ?? normalized[i + 1];
        if (name === "digits" && value !== undefined) parseCsplitDigits(value);
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
        if (ch === "n" && value !== undefined) parseCsplitDigits(value);
        if (inlineValue === "" && i + 1 < normalized.length) i++;
        break;
      }
    }
  }
  return null;
}

export function normalizeCsplitLongOptionAbbreviations(args) {
  const out = [];
  const valueOptions = new Set(["suffix-format", "prefix", "digits"]);
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
    const normalized = normalizeLongOptionByPrefix(arg, CSPLIT_LONG_OPTIONS);
    out.push(normalized);
    const [name, inlineValue] = normalized.slice(2).split(/=(.*)/s, 2);
    if (valueOptions.has(name) && inlineValue == null && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

export async function csplitCmd(args) {
  args = normalizeCsplitLongOptionAbbreviations(args);
  const { opts, operands } = parseOptions(args, { short: { b: "value", f: "value", k: false, n: "value", q: false, s: false, z: false }, long: { "suffix-format": "value", prefix: "value", "keep-files": false, "suppress-matched": false, digits: "value", quiet: false, silent: false, "elide-empty-files": false, help: false, version: false } });
  if (!operands.length) throw new UsageError("missing operand", true);
  if (operands.length < 2) throw new UsageError(`missing operand after '${operands[0]}'`, true);
  const [file, ...patterns] = operands;
  const prefix = opts.f ?? opts.prefix ?? "xx";
  const digits = parseCsplitDigits(opts.n ?? opts.digits ?? 2);
  const suffixFormat = opts.b ?? opts["suffix-format"] ?? `%0${digits}d`;
  const quiet = opts.q || opts.s || opts.quiet || opts.silent;
  const elideEmpty = opts.z || opts["elide-empty-files"];
  const suppressMatched = opts["suppress-matched"];
  const streamingPattern = file === "-" && patterns.length === 1 ? parseCsplitRegexPattern(patterns[0]) : null;
  if (streamingPattern?.skip && streamingPattern.offset >= 0 && !suppressMatched) {
    return csplitStreamForwardSkip(streamingPattern, { prefix, suffixFormat, quiet, elideEmpty, pattern: patterns[0] });
  }
  let input;
  try {
    input = await readAll(file);
  } catch (error) {
    if (error?.code === "EISDIR") {
      const name = `${prefix}${formatCsplitSuffix(suffixFormat, 0)}`;
      if (!elideEmpty) {
        try {
          await writeFile(name, "");
        } catch (writeError) {
          stderr(`csplit: ${name}: ${nodeErrorMessage(writeError)}\n`);
          return 1;
        }
        if (!quiet) stdout("0\n");
        if (!(opts.k || opts["keep-files"])) await cleanupCsplitFiles([name]);
      }
      stderr(`csplit: read error: ${systemErrorMessage(error)}\n`);
    } else {
      stderr(file === "-" ? `csplit: ${nodeErrorMessage(error)}\n` : `csplit: cannot open ${shellEscapeLsName(pathDisplayName(file), true)} for reading: ${systemErrorMessage(error)}\n`);
    }
    return 1;
  }
  const lines = new TextDecoder().decode(input).split(/(?<=\n)/).filter(Boolean);
  const chunks = [];
  const suppressed = new Set();
  let start = 0;
  let lastCut = 0;
  let searchStart = 0;
  for (let patternIndex = 0; patternIndex < patterns.length; patternIndex++) {
    const pattern = patterns[patternIndex];
    if (/^\{(\*|\d+)\}$/.test(pattern)) continue;
    if (/^\d+$/.test(pattern)) {
      const lineNumber = Number(pattern);
      if (lineNumber <= 0) {
        stderr(`csplit: ${pattern}: line number must be greater than zero\n`);
        return 1;
      }
      const cut = lineNumber - 1;
      if (cut < lastCut) {
        stderr(`csplit: line number '${pattern}' is smaller than preceding line number, ${lastCut + 1}\n`);
        return 1;
      }
      if (cut > lines.length || (lines.length === 0 && lineNumber === 1)) {
        if (patterns[patternIndex + 1] === pattern) stderr(`csplit: warning: line number '${pattern}' is the same as preceding line number\n`);
        stderr(`csplit: '${pattern}': line number out of range\n`);
        return 1;
      }
      if (cut === lastCut && chunks.length) stderr(`csplit: warning: line number '${pattern}' is the same as preceding line number\n`);
      if (suppressMatched && cut >= 0 && cut < lines.length) suppressed.add(cut);
      chunks.push([start, cut]);
      start = cut;
      lastCut = cut;
      searchStart = start;
      continue;
    }
    const regexPattern = parseCsplitRegexPattern(pattern);
    if (regexPattern) {
      let repeat = 0;
      const repeatSpec = patterns[patternIndex + 1]?.match(/^\{(\*|\d+)\}$/);
      if (repeatSpec) {
        repeat = repeatSpec[1] === "*" ? Infinity : Number(repeatSpec[1]);
        patternIndex++;
      }
      let applications = 0;
      while (true) {
        const result = applyCsplitRegex(lines, start, searchStart, regexPattern, suppressMatched, suppressed);
        if (!result) {
          if (applications === 0) throw new UsageError(`${localeQuotedEscapedDiagnostic(pattern)}: match not found`);
          break;
        }
        if (!result.skip) chunks.push([start, result.cut]);
        start = result.start;
        lastCut = result.cut;
        searchStart = result.nextSearch;
        applications++;
        if (applications > repeat) break;
      }
      continue;
    }
    stderr(`csplit: ${localeQuotedDiagnostic(pattern)}: invalid pattern\n`);
    return 1;
  }
  chunks.push([start, lines.length]);
  let outputIndex = 0;
  const createdFiles = [];
  for (const [from, to] of chunks) {
    const chunk = lines.slice(from, to).filter((_, i) => !suppressed.has(from + i)).join("");
    if (elideEmpty && chunk === "") continue;
    const name = `${prefix}${formatCsplitSuffix(suffixFormat, outputIndex++)}`;
    try {
      await writeFile(name, chunk);
      createdFiles.push(name);
    } catch (error) {
      stderr(`csplit: ${name}: ${systemErrorMessage(error)}\n`);
      if (!(opts.k || opts["keep-files"])) await cleanupCsplitFiles([...createdFiles, name]);
      return 1;
    }
    if (!quiet) stdout(`${enc.encode(chunk).byteLength}\n`);
  }
  return 0;
}

export function csplitStreamForwardSkip(spec, options) {
  const input = Buffer.allocUnsafe(64 * 1024);
  const decoder = new TextDecoder();
  let carry = "";
  let matched = false;
  let linesToSkip = 0;
  let outputFd = -1;
  let outputBytes = 0;
  const name = `${options.prefix}${formatCsplitSuffix(options.suffixFormat, 0)}`;
  const writeLine = (line) => {
    const bytes = enc.encode(line);
    if (outputFd < 0) outputFd = openSync(name, "w");
    writeSync(outputFd, bytes);
    outputBytes += bytes.length;
  };
  const consume = (line) => {
    if (!matched) {
      if (!spec.regex.test(line.replace(/\n$/, ""))) return;
      matched = true;
      if (spec.offset === 0) writeLine(line);
      else linesToSkip = spec.offset - 1;
      return;
    }
    if (linesToSkip > 0) {
      linesToSkip--;
      return;
    }
    writeLine(line);
  };
  try {
    while (true) {
      const count = readSync(0, input, 0, input.length, null);
      if (count === 0) break;
      carry += decoder.decode(input.subarray(0, count), { stream: true });
      let newline;
      while ((newline = carry.indexOf("\n")) !== -1) {
        consume(carry.slice(0, newline + 1));
        carry = carry.slice(newline + 1);
      }
    }
    carry += decoder.decode();
    if (carry) consume(carry);
  } finally {
    if (outputFd >= 0) closeSync(outputFd);
  }
  if (!matched) throw new UsageError(`${localeQuotedEscapedDiagnostic(options.pattern)}: match not found`);
  if (outputFd < 0 && !options.elideEmpty) closeSync(openSync(name, "w"));
  if (!options.quiet && (outputBytes > 0 || !options.elideEmpty)) stdout(`${outputBytes}\n`);
  return 0;
}

export function parseCsplitDigits(value) {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new UsageError(`invalid number: ${localeQuotedEscapedDiagnostic(text)}`);
  return Number(text);
}

export async function cleanupCsplitFiles(files) {
  for (const file of files) {
    const info = await lstat(file).catch(() => null);
    if (!info || info.isDirectory()) continue;
    await rm(file, { force: true }).catch(() => {});
  }
}

export function applyCsplitRegex(lines, start, searchStart, spec, suppressMatched, suppressed) {
  const { skip, regex, offset } = spec;
  const idx = lines.findIndex((line, i) => i >= searchStart && regex.test(line.replace(/\n$/, "")));
  if (idx === -1) return null;
  const cut = Math.max(0, Math.min(lines.length, idx + offset));
  if (suppressMatched && cut >= 0 && cut < lines.length) suppressed.add(cut);
  if (skip) {
    return { skip, cut, start: suppressMatched ? Math.min(lines.length, cut + 1) : cut, nextSearch: Math.max(cut + 1, idx + 1) };
  }
  return { skip, cut, start: cut, nextSearch: idx + 1 };
}

export function parseCsplitRegexPattern(pattern) {
  const delimiter = pattern[0];
  if (delimiter !== "/" && delimiter !== "%") return null;
  const end = pattern.lastIndexOf(delimiter);
  if (end <= 0) throw new UsageError(`${pattern}: closing delimiter '${delimiter}' missing`);
  const offsetText = pattern.slice(end + 1);
  if (offsetText && !/^[+-]?\d+$/.test(offsetText)) throw new UsageError(`${localeQuotedEscapedDiagnostic(pattern)}: integer expected after delimiter`);
  try {
    return { skip: delimiter === "%", regex: new RegExp(csplitBasicRegex(pattern.slice(1, end))), offset: Number(offsetText || 0) };
  } catch {
    throw new UsageError(`${localeQuotedEscapedDiagnostic(pattern)}: invalid regular expression: Invalid regular expression`);
  }
}

export function csplitBasicRegex(pattern) {
  return pattern.replace(/\\([{}])/g, "$1");
}

export function formatCsplitSuffix(format, index) {
  return format.replace(/%([0 #+-]*)(\d*)(?:\.(\d+))?([dixX])/g, (_, flags, widthText, precisionText, type) => {
    const width = Number(widthText || 0);
    const precision = precisionText === undefined ? null : Number(precisionText);
    const base = type === "d" || type === "i" ? 10 : 16;
    let digits = index.toString(base);
    if (type === "X") digits = digits.toUpperCase();
    if (precision != null) digits = digits.padStart(precision, "0");
    const alternate = flags.includes("#") && base === 16 && index !== 0 ? (type === "X" ? "0X" : "0x") : "";
    let rendered = `${alternate}${digits}`;
    const pad = flags.includes("0") && precision == null ? "0" : " ";
    if (width > rendered.length) rendered = flags.includes("-") ? rendered.padEnd(width, " ") : rendered.padStart(width, pad);
    return rendered;
  });
}

const singleCall = defineCommand("csplit", csplitCmd, csplitMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
