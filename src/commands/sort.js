#!/usr/bin/env bun

import { read, toArrayBuffer } from "bun:ffi";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { compareSortBytes, compareSortLocaleText, cstr, decodeSurrogateEscapedBytes, initializeSortLocaleCollation, isAsciiDigit, libc, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, parseGNUSize, parseOptions, pathDisplayName, randomPicker, readAll, resolveEnvCommand, shellEscapeLsName, splitFiles0ByteNames, systemErrorMessage, wcFileNameIsDash, wcFileNameIsEmpty } from "../shared/common.js";
import { InvocationError, UsageError, encodeSurrogateEscapedString, fail, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const SORT_LONG_OPTIONS = ["numeric-sort", "general-numeric-sort", "human-numeric-sort", "month-sort", "version-sort", "random-sort", "random-source", "reverse", "unique", "merge", "ignore-case", "check", "ignore-leading-blanks", "dictionary-order", "ignore-nonprinting", "stable", "zero-terminated", "key", "output", "buffer-size", "batch-size", "compress-program", "files0-from", "parallel", "sort", "field-separator", "temporary-directory", "debug", "help", "version"];

export function sortMetaOption(args) {
  const longValueOptions = new Set(["random-source", "key", "output", "buffer-size", "batch-size", "compress-program", "files0-from", "parallel", "sort", "field-separator", "temporary-directory"]);
  const shortValueOptions = new Set(["k", "o", "S", "t", "T"]);
  const shortKnownOptions = new Set(["n", "g", "h", "M", "V", "r", "u", "f", "c", "C", "b", "d", "i", "R", "s", "z", "m", "k", "o", "S", "t", "T"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeSortLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!SORT_LONG_OPTIONS.includes(name)) return null;
      if (name === "help" || name === "version") {
        if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
        return option;
      }
      if (name === "check" && inlineValue !== undefined) validateSortMetaOptionValue(name, inlineValue);
      if (longValueOptions.has(name)) {
        validateSortMetaOptionValue(name, inlineValue ?? args[i + 1]);
        if (inlineValue == null) i++;
      }
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        validateSortMetaOptionValue(ch, inlineValue === "" ? args[i + 1] : inlineValue);
        if (inlineValue === "") i++;
        break;
      }
    }
  }
  return null;
}

export function validateSortMetaOptionValue(name, value) {
  if (value === undefined) return;
  if (name === "key" || name === "k") parseSortKeySpec(value);
  else if (name === "parallel") validateSortParallel(value);
  else if (name === "batch-size") validateSortBatchSize(value);
  else if (name === "buffer-size" || name === "S") validateSortBufferSize(value, name === "S" ? "-S" : "--buffer-size");
  else if (name === "field-separator" || name === "t") parseSortSeparator(value);
  else if (name === "sort") validateSortModeOption(value);
  else if (name === "check") validateSortCheckOption(value);
}

export async function sortCmd(args) {
  const originalArgs = [...args];
  args = normalizeObsoleteSortKeys(args);
  args = normalizeSortLongOptions(args);
  args = normalizeBareSortCheck(args);
  const keySpecs = collectSortKeySpecs(args);
  const { opts, operands } = parseOptions(args, { short: { n: false, g: false, h: false, M: false, V: false, r: false, u: false, f: false, c: false, C: false, b: false, d: false, i: false, R: false, s: false, z: false, m: false, k: "value", o: "value", S: "value", t: "value", T: "value" }, long: { "numeric-sort": false, "general-numeric-sort": false, "human-numeric-sort": false, "month-sort": false, "version-sort": false, "random-sort": false, "random-source": "value", reverse: false, unique: false, merge: false, "ignore-case": false, check: "optional-value", "ignore-leading-blanks": false, "dictionary-order": false, "ignore-nonprinting": false, stable: false, "zero-terminated": false, key: "value", output: "value", "buffer-size": "value", "batch-size": "value", "compress-program": "value", "files0-from": "value", parallel: "value", p: "value", sort: "value", "field-separator": "value", "temporary-directory": "value", debug: false } });
  opts.localeCollation = initializeSortLocaleCollation();
  opts.localeMonths = initializeSortLocaleMonths();
  applySortModeAlias(opts);
  validateSortCheckOption(opts.check);
  validateSortOutputOptions(args);
  const batchSize = validateSortBatchSize(opts["batch-size"]);
  const bufferSize = validateSortBufferSize(opts.S ?? opts["buffer-size"], opts.S !== undefined ? "-S" : "--buffer-size");
  validateSortParallel(opts.parallel);
  parseSortSeparator(opts.t ?? opts["field-separator"]);
  if ((opts.c || opts.C) && (opts.o || opts.output)) throw new UsageError(`options '-${opts.c ? "c" : "C"}o' are incompatible`);
  if (opts.c && opts.C) throw new UsageError("options '-cC' are incompatible");
  if (sortModeCount(opts) > 1 && !(opts.debug && keySpecs.some(sortKeySpecHasOrdering))) throw new UsageError(`options '-${sortModeLetters(opts)}' are incompatible`);
  if (opts.debug) emitSortDebugWarnings(opts, keySpecs, originalArgs);
  const files0 = opts["files0-from"];
  let files = operands.length ? operands : ["-"];
  if (files0 !== undefined) {
    if (operands.length) throw new UsageError(`extra operand '${operands[0]}'\nfile operands cannot be combined with --files0-from`, true);
    let nameBytes;
    try {
      nameBytes = await readAll(files0);
    } catch (error) {
      if (error?.code === "EISDIR") {
        stderr(`sort: cannot read file names from ${sortAlwaysQuotedName(files0)}\n`);
        return 2;
      }
      stderr(`sort: open failed: ${sortDiagnosticName(files0)}: ${systemErrorMessage(error)}\n`);
      return 2;
    }
    if (nameBytes.byteLength === 0) {
      stderr(`sort: no input from ${sortAlwaysQuotedName(files0)}\n`);
      return 2;
    }
    files = sortFiles0Names(nameBytes, files0);
    if (files.status) return files.status;
  }
  if ((opts.c || opts.C || opts.check) && files.length > 1) {
    const checkOption = opts.C || opts.check === "quiet" || opts.check === "silent" ? "C" : "c";
    throw new UsageError(`extra operand '${files[1]}' not allowed with -${checkOption}`);
  }
  const checkInputName = files[0] ?? "-";
  const tempDir = opts.T ?? opts["temporary-directory"];
  if ((opts.m || opts.merge) && batchSize != null && batchSize < files.length && tempDir && !(await stat(tempDir).catch(() => null))?.isDirectory()) {
    stderr(`sort: cannot create temporary file in ${sortAlwaysQuotedName(tempDir)}: No such file or directory\n`);
    return 2;
  }
  const usesSortTempMerge = (opts.m || opts.merge) && batchSize != null && batchSize < files.length;
  const sep = opts.z || opts["zero-terminated"] ? "\0" : "\n";
  let input = "";
  const lineGroups = [];
  for (const file of files) {
    try {
      const text = decodeSurrogateEscapedBytes(await readAll(file));
      const normalizedText = text !== "" && !text.endsWith(sep) ? text + sep : text;
      input += normalizedText;
      if (opts.m || opts.merge) {
        lineGroups.push(normalizedText.endsWith(sep) ? normalizedText.slice(0, -sep.length).split(sep) : normalizedText === "" ? [] : normalizedText.split(sep));
      }
    } catch (error) {
      stderr(error?.code === "EISDIR"
        ? `sort: read failed: ${pathDisplayName(file)}: ${systemErrorMessage(error)}\n`
        : `sort: cannot read: ${pathDisplayName(file)}: ${systemErrorMessage(error)}\n`);
      return 2;
    }
  }
  const hadSep = input.endsWith(sep);
  const lines = input.endsWith(sep) ? input.slice(0, -sep.length).split(sep) : input === "" ? [] : input.split(sep);
  let randomRanks;
  try {
    randomRanks = await sortRandomRanks(lines, keySpecs, opts);
  } catch (error) {
    if (Object.hasOwn(opts, "random-source")) {
      const source = opts["random-source"];
      stderr(`sort: open failed: ${source === "" ? "''" : sortDiagnosticName(source)}: ${systemErrorMessage(error)}\n`);
      return 2;
    }
    throw error;
  }
  const cmp = (a, b) => {
    const specs = keySpecs.length ? keySpecs : [null];
    for (const spec of specs) {
      const mode = sortEffectiveOpts(opts, spec);
      const aa = sortKey(spec ? extractSortKey(a, spec, opts) : a, mode);
      const bb = sortKey(spec ? extractSortKey(b, spec, opts) : b, mode);
      let result = sortIsRandomMode(mode) ? compareSortRandomKeys(aa, bb, randomRanks) : compareSortKeys(aa, bb, mode);
      if (result !== 0) return mode.r || mode.reverse ? -result : result;
    }
    if (opts.s || opts.stable || opts.i || opts["ignore-nonprinting"]) return 0;
    const aa = sortKey(a, opts);
    const bb = sortKey(b, opts);
    const result = a < b ? -1 : a > b ? 1 : 0;
    return opts.r || opts.reverse ? -result : result;
  };
  if (opts.c || opts.C || opts.check) {
    const quietCheck = opts.C || opts.check === "quiet" || opts.check === "silent";
    for (let i = 1; i < lines.length; i++) {
      const result = cmp(lines[i - 1], lines[i]);
      const disorder = opts.u || opts.unique ? result >= 0 : result > 0;
      if (disorder) return quietCheck ? 1 : fail("sort", `${checkInputName}:${i + 1}: disorder: ${lines[i]}`);
    }
    return 0;
  }
  const sortedLines = opts.m || opts.merge ? mergeSortedLineGroups(lineGroups, cmp) : lines.sort(cmp);
  const uniqueCmp = (a, b) => {
    if (!keySpecs.length) {
      const aa = sortKey(a, opts);
      const bb = sortKey(b, opts);
      return sortIsRandomMode(opts) ? compareSortRandomKeys(aa, bb, randomRanks) : compareSortKeys(aa, bb, opts);
    }
    for (const spec of keySpecs) {
      const mode = sortEffectiveOpts(opts, spec);
      const aa = sortKey(extractSortKey(a, spec, opts), mode);
      const bb = sortKey(extractSortKey(b, spec, opts), mode);
      const result = sortIsRandomMode(mode) ? compareSortRandomKeys(aa, bb, randomRanks) : compareSortKeys(aa, bb, mode);
      if (result !== 0) return result;
    }
    return 0;
  };
  const out = opts.u || opts.unique ? sortedLines.filter((line, i) => i === 0 || uniqueCmp(line, sortedLines[i - 1]) !== 0) : sortedLines;
  const rendered = opts.debug ? renderSortDebugOutput(out, keySpecs, opts) : out.join(sep) + (hadSep || out.length ? sep : "");
  if (usesSortTempMerge || sortBufferForcesTemp(bufferSize, input)) {
    const compressStatus = await runSortCompressProgram(opts["compress-program"], rendered);
    if (compressStatus) return compressStatus;
  }
  if (opts.o || opts.output) {
    const output = opts.o ?? opts.output;
    try {
      await writeFile(output, encodeSurrogateEscapedString(rendered));
    } catch (error) {
      stderr(`sort: open failed: ${sortDiagnosticName(output)}: ${systemErrorMessage(error)}\n`);
      return 2;
    }
  } else stdout(rendered);
  return 0;
}

export function mergeSortedLineGroups(groups, cmp) {
  const positions = groups.map(() => 0);
  const out = [];
  while (true) {
    let best = -1;
    for (let i = 0; i < groups.length; i++) {
      const pos = positions[i];
      if (pos >= groups[i].length) continue;
      if (best === -1 || cmp(groups[i][pos], groups[best][positions[best]]) < 0) best = i;
    }
    if (best === -1) return out;
    out.push(groups[best][positions[best]]);
    positions[best]++;
  }
}

export function validateSortBatchSize(value) {
  if (value == null) return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    if (/^\d/.test(text)) throw new UsageError(`invalid suffix in --batch-size argument '${text}'`);
    throw new UsageError(`invalid --batch-size argument ${sortSizeDiagnosticQuote(text)}`);
  }
  const size = BigInt(text);
  if (size > 18446744073709551615n) {
    throw new UsageError(`--batch-size argument ${localeQuotedDiagnostic(text)} too large\nsort: maximum --batch-size argument with current rlimit is`);
  }
  if (size < 2n) {
    throw new UsageError(`invalid --batch-size argument ${localeQuotedDiagnostic(text)}\nsort: minimum --batch-size argument is ${localeQuotedDiagnostic("2")}`);
  }
  return Number(size);
}

export function validateSortBufferSize(value, optionName = "--buffer-size") {
  if (value == null) return null;
  const text = String(value);
  if (/^\d+%$/.test(text)) return text;
  try {
    parseSortBufferSize(text, optionName);
    return text;
  } catch (error) {
    if (error instanceof UsageError && error.message.startsWith(`${optionName} argument `)) throw error;
    if (/^\d/.test(text)) throw new UsageError(`invalid suffix in ${optionName} argument '${text}'`);
    throw new UsageError(`invalid ${optionName} argument ${sortSizeDiagnosticQuote(text)}`);
  }
}

export function parseSortBufferSize(text, optionName = "--buffer-size") {
  const match = String(text).match(/^(\d+)([A-Za-z]*)$/);
  if (!match) throw new UsageError("invalid sort buffer size");
  const suffixScales = {
    "": 1n, b: 512n,
    K: 1024n, k: 1024n,
    M: 1024n ** 2n, m: 1024n ** 2n,
    G: 1024n ** 3n, g: 1024n ** 3n,
    T: 1024n ** 4n, t: 1024n ** 4n,
    P: 1024n ** 5n,
    E: 1024n ** 6n,
    Z: 1024n ** 7n,
    Y: 1024n ** 8n,
    R: 1024n ** 9n,
    Q: 1024n ** 10n,
  };
  const scale = suffixScales[match[2]];
  if (!scale) throw new UsageError("invalid sort buffer size");
  const amount = BigInt(match[1]) * scale;
  if (amount > 9223372036854775807n) throw new UsageError(`${optionName} argument '${text}' too large`);
  return amount;
}

export function sortBufferForcesTemp(bufferSize, input) {
  if (bufferSize == null || String(bufferSize).endsWith("%")) return false;
  try {
    return encodeSurrogateEscapedString(input).byteLength > parseGNUSize(bufferSize);
  } catch {
    return false;
  }
}

export function sortSizeDiagnosticQuote(value) {
  return /^\d/.test(value) ? localeQuotedDiagnostic(value) : `'${value}'`;
}

export function validateSortParallel(value) {
  if (value == null) return null;
  const text = String(value);
  if (!/^\+?\d+$/.test(text)) {
    const message = /^\+?\d/.test(text) ? "invalid suffix in --parallel argument" : "invalid --parallel argument";
    throw new UsageError(`${message} '${text}'`);
  }
  const n = BigInt(text.replace(/^\+/, ""));
  if (n < 1n) throw new UsageError("number in parallel must be nonzero");
  return Number(n);
}

export function sortFiles0Names(bytes, source) {
  const parts = splitFiles0ByteNames(bytes);
  const names = [];
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    if (wcFileNameIsEmpty(name)) {
      stderr(`sort: ${sortDiagnosticName(source)}:1: invalid zero-length file name\n`);
      return { status: 2 };
    }
    if (source === "-" && wcFileNameIsDash(name)) {
      stderr("sort: when reading file names from standard input, no file name of '-' allowed\n");
      return { status: 2 };
    }
    names.push(name);
  }
  return names;
}

export function sortDiagnosticName(name) {
  return shellEscapeLsName(pathDisplayName(name));
}

export function sortAlwaysQuotedName(name) {
  return shellEscapeLsName(pathDisplayName(name), true);
}

export async function sortRandomRanks(lines, keySpecs, opts) {
  const specs = keySpecs.length ? keySpecs : [null];
  if (!specs.some((spec) => sortIsRandomMode(sortEffectiveOpts(opts, spec)))) return null;
  const random = await randomPicker(opts["random-source"]);
  const ranks = new Map();
  for (const line of lines) {
    for (const spec of specs) {
      const mode = sortEffectiveOpts(opts, spec);
      if (!sortIsRandomMode(mode)) continue;
      const key = sortKey(spec ? extractSortKey(line, spec, opts) : line, mode);
      ensureSortRandomRank(ranks, key, random);
    }
  }
  return ranks;
}

export function sortIsRandomMode(opts) {
  return opts.R || opts["random-sort"];
}

export function ensureSortRandomRank(ranks, key, random) {
  if (!ranks.has(key)) ranks.set(key, [random(0x1_0000_0000), random(0x1_0000_0000), random(0x1_0000_0000)]);
  return ranks.get(key);
}

export function compareSortRandomKeys(a, b, ranks) {
  if (a === b) return 0;
  const aa = ranks?.get(a) ?? [0, 0, 0];
  const bb = ranks?.get(b) ?? [0, 0, 0];
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function runSortCompressProgram(program, sample = "") {
  if (program == null) return 0;
  let executable;
  try {
    executable = await resolveEnvCommand(String(program), process.env, process.cwd());
  } catch (error) {
    stderr(`sort: could not run compress program '${program}': ${systemErrorMessage(error)}\n`);
    return 0;
  }
  for (const args of [[], ["-d"]]) {
    const tempBase = `/tmp/bnu-sort-compress-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const inputPath = `${tempBase}.in`;
    const outputPath = `${tempBase}.out`;
    let inputFd = null;
    let outputFd = null;
    let proc;
    try {
      const sampleFd = openSync(inputPath, "w");
      writeSync(sampleFd, encodeSurrogateEscapedString(sample));
      closeSync(sampleFd);
      inputFd = openSync(inputPath, "r");
      outputFd = openSync(outputPath, "w+");
      proc = Bun.spawn([executable, ...args], { stdin: inputFd, stdout: outputFd, stderr: "ignore", env: process.env });
    } catch (error) {
      if (inputFd != null) closeSync(inputFd);
      if (outputFd != null) closeSync(outputFd);
      try { unlinkSync(inputPath); } catch {}
      try { unlinkSync(outputPath); } catch {}
      stderr(`sort: could not run compress program '${program}': ${systemErrorMessage(error)}\n`);
      return 0;
    }
    const code = await proc.exited;
    closeSync(inputFd);
    closeSync(outputFd);
    try { unlinkSync(inputPath); } catch {}
    try { unlinkSync(outputPath); } catch {}
    if (code !== 0) return 2;
  }
  return 0;
}

export function normalizeObsoleteSortKeys(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!/^\+\d/.test(arg)) {
      out.push(arg);
      continue;
    }
    const start = parseObsoleteSortPosition(arg.slice(1), true);
    let end = null;
    if (/^-\d/.test(args[i + 1] ?? "")) end = parseObsoleteSortPosition(args[++i].slice(1), false);
    out.push("-k", `${start}${end ? `,${end}` : ""}`);
  }
  return out;
}

export function parseObsoleteSortPosition(text, isStart) {
  const match = text.match(/^(\d+)(?:\.(\d+))?([A-Za-z]*)$/);
  if (!match) throw new UsageError("invalid field specification");
  const field = Number(match[1]) + (isStart || (match[2] != null && match[2] !== "0") ? 1 : 0);
  const ch = match[2] == null ? "" : `.${Number(match[2]) + (isStart ? 1 : 0)}`;
  return `${field}${ch}${match[3] ?? ""}`;
}

export function collectSortKeySpecs(args) {
  const keys = [];
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (end) continue;
    if (arg === "--") {
      end = true;
      continue;
    }
    if (arg === "-k" || arg === "--key") {
      keys.push(parseSortKeySpec(args[i + 1] ?? ""));
      i++;
    } else if (arg.startsWith("-k") && arg.length > 2) {
      keys.push(parseSortKeySpec(arg.slice(2)));
    } else if (/^-[A-Za-z]+k.+/.test(arg)) {
      keys.push(parseSortKeySpec(arg.slice(arg.indexOf("k") + 1)));
    } else if (arg.startsWith("--key=")) {
      keys.push(parseSortKeySpec(arg.slice(6)));
    }
  }
  return keys;
}

export function parseSortKeySpec(spec) {
  const [startText, endText = null] = String(spec).split(",", 2);
  if (String(spec).includes(",-")) throw new UsageError(`invalid number after ',': invalid count at start of ${localeQuotedDiagnostic(endText)}`);
  if (String(spec).includes(".,")) throw new UsageError(`invalid number after '.': invalid count at start of ${localeQuotedDiagnostic(`,${endText ?? ""}`)}`);
  if (String(spec).endsWith(",")) throw new UsageError(`invalid number after ',': invalid count at start of ${localeQuotedDiagnostic("")}`);
  if (startText === "" || !/^\d/.test(startText)) throw new UsageError(`invalid number at field start: invalid count at start of ${localeQuotedDiagnostic(startText)}`);
  if (startText === "0") throw new UsageError(`field number is zero: invalid field specification ${localeQuotedDiagnostic(spec)}`);
  const start = parseSortKeyPosition(startText, true, spec);
  const end = endText == null ? null : parseSortKeyPosition(endText, false, spec);
  return { start, end };
}

export function sortKeySpecHasOrdering(spec) {
  return /[ghMnRV]/.test(`${spec.start.flags}${spec.end?.flags ?? ""}`);
}

export function parseSortKeyPosition(text, isStart, spec) {
  const input = String(text);
  const match = input.match(/^(\d+)(?:\.(\d*))?([bdfghinMrRV]*)$/);
  if (input.includes(".") && match?.[2] === "") throw new UsageError(`invalid number after '.': invalid count at start of ${localeQuotedDiagnostic("")}`);
  if (!match) {
    const numericPrefix = input.match(/^(\d+)(?:\.(\d*))?/);
    if (numericPrefix) {
      const field = Number(numericPrefix[1]);
      const char = numericPrefix[2] == null || numericPrefix[2] === "" ? (isStart ? 1 : 0) : Number(numericPrefix[2]);
      if (field === 0) throw new UsageError(`field number is zero: invalid field specification ${localeQuotedEscapedDiagnostic(spec)}`);
      if (char === 0 && isStart) throw new UsageError(`character offset is zero: invalid field specification ${localeQuotedEscapedDiagnostic(spec)}`);
      throw new UsageError(`stray character in field spec: invalid field specification ${localeQuotedEscapedDiagnostic(spec)}`);
    }
    const where = isStart ? "at field start" : "after ','";
    throw new UsageError(`invalid number ${where}: invalid count at start of ${localeQuotedEscapedDiagnostic(input)}`);
  }
  const field = Number(match[1]);
  const char = match[2] == null || match[2] === "" ? (isStart ? 1 : 0) : Number(match[2]);
  if (field === 0) throw new UsageError(`field number is zero: invalid field specification ${localeQuotedEscapedDiagnostic(spec)}`);
  if (char === 0 && isStart) throw new UsageError(`character offset is zero: invalid field specification ${localeQuotedEscapedDiagnostic(spec)}`);
  return { field, char, flags: match[3] ?? "" };
}

export function sortEffectiveOpts(opts, spec) {
  const merged = { ...opts };
  const flags = `${spec?.start?.flags ?? ""}${spec?.end?.flags ?? ""}`;
  if (/[ghMnRV]/.test(flags)) {
    merged.g = merged.h = merged.M = merged.n = merged.R = merged.V = false;
    merged["general-numeric-sort"] = merged["human-numeric-sort"] = merged["month-sort"] = merged["numeric-sort"] = merged["random-sort"] = merged["version-sort"] = false;
  }
  for (const flag of flags) {
    if (flag === "b") merged.b = true;
    else if (flag === "d") merged.d = true;
    else if (flag === "f") merged.f = true;
    else if (flag === "g") merged.g = true;
    else if (flag === "h") merged.h = true;
    else if (flag === "i") merged.i = true;
    else if (flag === "M") merged.M = true;
    else if (flag === "n") merged.n = true;
    else if (flag === "r") merged.r = true;
    else if (flag === "R") merged.R = true;
    else if (flag === "V") merged.V = true;
  }
  return merged;
}

export function extractSortKey(line, spec, opts) {
  const range = extractSortKeyRange(line, spec, opts);
  return line.slice(range.start, range.end);
}

export function extractSortKeyRange(line, spec, opts) {
  const separator = parseSortSeparator(opts.t ?? opts["field-separator"]);
  const fields = splitSortFields(line, separator);
  const startField = fields[spec.start.field - 1];
  if (!startField) return { start: line.length, end: line.length };
  const keyHasOrdering = /[dfghinMRV]/.test(`${spec.start.flags}${spec.end?.flags ?? ""}`);
  const useGlobalBlank = !keyHasOrdering && (opts.b || opts["ignore-leading-blanks"]);
  const startBase = spec.start.flags.includes("b") || useGlobalBlank ? startField.contentStart : startField.start;
  const startOffset = Math.max(0, spec.start.char - 1);
  const start = Math.min(line.length, startBase + startOffset);
  let end = line.length;
  if (spec.end) {
    const endField = fields[spec.end.field - 1];
    if (!endField) return { start, end: line.length };
    const endBase = spec.end.flags.includes("b") || useGlobalBlank ? endField.contentStart : endField.start;
    end = spec.end.char ? endBase + spec.end.char : endField.end;
  }
  end = Math.min(line.length, Math.max(0, end));
  if (end < start) end = start;
  return { start, end };
}

export function parseSortSeparator(value) {
  if (value == null) return null;
  const separator = value === "\\0" ? "\0" : String(value);
  if (separator === "") throw new UsageError("empty tab");
  if ([...separator].length !== 1) throw new UsageError(`multi-character tab ${localeQuotedEscapedDiagnostic(separator)}`);
  return separator;
}

export function splitSortFields(line, separator = null) {
  if (separator != null) {
    const fields = [];
    let start = 0;
    for (let i = 0; i <= line.length; i++) {
      if (i === line.length || line[i] === separator) {
        fields.push({ start, contentStart: start, end: i });
        start = i + 1;
      }
    }
    return fields;
  }
  const fields = [];
  const re = /\S+/g;
  let match;
  let previousEnd = 0;
  while ((match = re.exec(line))) fields.push({ start: match.index, end: match.index + match[0].length });
  fields.length = 0;
  while ((match = re.exec(line))) {
    const contentStart = match.index;
    fields.push({ start: fields.length === 0 ? 0 : previousEnd, contentStart, end: contentStart + match[0].length });
    previousEnd = contentStart + match[0].length;
  }
  return fields;
}

export function compareSortKeys(aa, bb, opts) {
  let result;
  if (opts.g || opts["general-numeric-sort"]) result = compareGeneralNumericSortValues(aa, bb);
  else if (opts.n || opts["numeric-sort"]) result = compareNumericSortValues(aa, bb);
  else if (opts.h || opts["human-numeric-sort"]) result = compareHumanSortValues(aa, bb);
  else if (opts.M || opts["month-sort"]) result = monthValue(aa, opts.localeMonths) - monthValue(bb, opts.localeMonths);
  else if (opts.V || opts["version-sort"]) result = versionCompare(aa, bb);
  else result = opts.localeCollation ? compareSortLocaleText(aa, bb) : compareSortBytes(aa, bb);
  if (Number.isNaN(result)) {
    if (opts.n || opts["numeric-sort"]) result = compareNumericSortValues(aa, bb);
    else result = opts.localeCollation ? compareSortLocaleText(aa, bb) : compareSortBytes(aa, bb);
  }
  if (result === 0 && (opts.i || opts["ignore-nonprinting"])) return 0;
  if (result === 0 && (opts.f || opts["ignore-case"])) result = aa < bb ? -1 : aa > bb ? 1 : 0;
  return result < 0 ? -1 : result > 0 ? 1 : 0;
}

export function sortKey(value, opts) {
  let key = opts.b || opts["ignore-leading-blanks"] ? value.replace(/^\s+/, "") : value;
  if (opts.d || opts["dictionary-order"]) key = key.replace(/[^\p{L}\p{N}\s]/gu, "");
  if (opts.i || opts["ignore-nonprinting"]) key = key.replace(/[^\x20-\x7e]/g, "");
  if (opts.f || opts["ignore-case"] || opts.M || opts["month-sort"]) key = key.toLowerCase().replace(/_/g, "{");
  return key;
}

export function renderSortDebugOutput(lines, keySpecs, opts) {
  let out = "";
  for (const line of lines) {
    out += line.replaceAll("\t", ">") + "\n";
    const specs = keySpecs.length ? keySpecs : [null];
    for (const spec of specs) {
      const mode = sortEffectiveOpts(opts, spec);
      const range = sortDebugKeyRange(line, spec, mode, opts);
      out += sortDebugMarker(line, range.start, range.end);
    }
    if (keySpecs.length && !(opts.s || opts.stable || opts.u || opts.unique)) out += sortDebugMarker(line, 0, line.length);
    if (!keySpecs.length && sortUsesDefaultKey(opts) && !(opts.s || opts.stable || opts.u || opts.unique)) out += sortDebugMarker(line, 0, line.length);
  }
  return out;
}

export function sortUsesDefaultKey(opts) {
  return opts.b || opts["ignore-leading-blanks"] || opts.d || opts["dictionary-order"] || opts.f || opts["ignore-case"] || opts.g || opts["general-numeric-sort"] || opts.h || opts["human-numeric-sort"] || opts.i || opts["ignore-nonprinting"] || opts.M || opts["month-sort"] || opts.n || opts["numeric-sort"] || opts.R || opts["random-sort"] || opts.V || opts["version-sort"];
}

export function sortDebugKeyRange(line, spec, mode, opts) {
  let range;
  if (spec) range = extractSortKeyRange(line, spec, opts);
  else {
    const start = mode.b || mode["ignore-leading-blanks"] ? firstNonblankIndex(line, 0, line.length) : 0;
    range = { start, end: line.length };
  }
  if (mode.M || mode["month-sort"]) return sortDebugMonthRange(line, range, mode.localeMonths);
  if (mode.g || mode["general-numeric-sort"]) return sortDebugGeneralNumericRange(line, range);
  if (mode.n || mode["numeric-sort"] || mode.h || mode["human-numeric-sort"]) return sortDebugRawNumericRange(line, range, mode.h || mode["human-numeric-sort"]);
  if (!spec && (mode.b || mode["ignore-leading-blanks"])) return { ...range, start: firstNonblankIndex(line, range.start, range.end) };
  return range;
}

export function sortDebugMarker(line, start, end) {
  const offset = sortDebugWidth(line.slice(0, start));
  const width = sortDebugWidth(line.slice(start, end));
  return " ".repeat(offset) + (width === 0 ? "^ no match for key" : "_".repeat(width)) + "\n";
}

export function sortDebugWidth(value) {
  return value.replaceAll("\0", "").length;
}

export function firstNonblankIndex(line, start, end) {
  while (start < end && /[ \t]/.test(line[start])) start++;
  return start;
}

export function sortDebugMonthRange(line, range, months = null) {
  const start = firstNonblankIndex(line, range.start, range.end);
  const text = line.slice(start, range.end);
  const match = sortMonthMatch(text, months);
  return match ? { start, end: start + match.length } : { start, end: start };
}

export function sortDebugGeneralNumericRange(line, range) {
  const start = firstNonblankIndex(line, range.start, range.end);
  const text = line.slice(start, range.end);
  const match = text.match(/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/);
  return match ? { start, end: start + match[0].length } : { start, end: start };
}

export function sortDebugRawNumericRange(line, range, human = false) {
  const start = firstNonblankIndex(line, range.start, range.end);
  let index = start + (line[start] === "-" ? 1 : 0);
  let maxDigit = "";
  while (index < range.end && isAsciiDigit(line[index] ?? "")) {
    if (maxDigit < line[index]) maxDigit = line[index];
    index++;
  }
  if (index < range.end && line[index] === ".") {
    index++;
    while (index < range.end && isAsciiDigit(line[index] ?? "")) {
      if (maxDigit < line[index]) maxDigit = line[index];
      index++;
    }
  }
  if (maxDigit < "0") return { start, end: start };
  if (human && humanSuffixOrder(line[index] ?? "") !== 0) index++;
  return { start, end: index };
}

export function compareNumericSortValues(a, b) {
  return numericStringCompare(String(a).replace(/^\s+/, ""), String(b).replace(/^\s+/, ""));
}

export function numericStringCompare(a, b) {
  let ai = 0;
  let bi = 0;
  let ac = a[ai] ?? "";
  let bc = b[bi] ?? "";
  if (ac === "-") {
    do ac = a[++ai] ?? ""; while (ac === "0");
    if (bc !== "-") {
      if (ac === ".") do ac = a[++ai] ?? ""; while (ac === "0");
      if (isAsciiDigit(ac)) return -1;
      while (bc === "0") bc = b[++bi] ?? "";
      if (bc === ".") do bc = b[++bi] ?? ""; while (bc === "0");
      return isAsciiDigit(bc) ? -1 : 0;
    }
    do bc = b[++bi] ?? ""; while (bc === "0");

    while (ac === bc && isAsciiDigit(ac)) {
      do ac = a[++ai] ?? ""; while (false);
      do bc = b[++bi] ?? ""; while (false);
    }

    if ((ac === "." && !isAsciiDigit(bc)) || (bc === "." && !isAsciiDigit(ac))) return fractionStringCompare(b, bi, a, ai);

    const diff = charCode(bc) - charCode(ac);
    let aLog = 0;
    for (; isAsciiDigit(ac); aLog++) ac = a[++ai] ?? "";
    let bLog = 0;
    for (; isAsciiDigit(bc); bLog++) bc = b[++bi] ?? "";
    if (aLog !== bLog) return aLog < bLog ? 1 : -1;
    return aLog === 0 ? 0 : diff;
  }
  if (bc === "-") {
    do bc = b[++bi] ?? ""; while (bc === "0");
    if (bc === ".") do bc = b[++bi] ?? ""; while (bc === "0");
    if (isAsciiDigit(bc)) return 1;
    while (ac === "0") ac = a[++ai] ?? "";
    if (ac === ".") do ac = a[++ai] ?? ""; while (ac === "0");
    return isAsciiDigit(ac) ? 1 : 0;
  }

  while (ac === "0") ac = a[++ai] ?? "";
  while (bc === "0") bc = b[++bi] ?? "";

  while (ac === bc && isAsciiDigit(ac)) {
    ac = a[++ai] ?? "";
    bc = b[++bi] ?? "";
  }

  if ((ac === "." && !isAsciiDigit(bc)) || (bc === "." && !isAsciiDigit(ac))) return fractionStringCompare(a, ai, b, bi);

  const diff = charCode(ac) - charCode(bc);
  let aLog = 0;
  for (; isAsciiDigit(ac); aLog++) ac = a[++ai] ?? "";
  let bLog = 0;
  for (; isAsciiDigit(bc); bLog++) bc = b[++bi] ?? "";
  if (aLog !== bLog) return aLog < bLog ? -1 : 1;
  return aLog === 0 ? 0 : diff;
}

export function fractionStringCompare(a, ai, b, bi) {
  if (a[ai] === "." && b[bi] === ".") {
    while ((a[++ai] ?? "") === (b[++bi] ?? "")) {
      if (!isAsciiDigit(a[ai] ?? "")) return 0;
    }
    const ac = a[ai] ?? "";
    const bc = b[bi] ?? "";
    if (isAsciiDigit(ac) && isAsciiDigit(bc)) return charCode(ac) - charCode(bc);
    if (isAsciiDigit(ac)) return fractionHasTrailingNonzero(a, ai) ? 1 : 0;
    if (isAsciiDigit(bc)) return fractionHasTrailingNonzero(b, bi) ? -1 : 0;
    return 0;
  }
  if (a[ai] === ".") return fractionHasTrailingNonzero(a, ai + 1) ? 1 : 0;
  if (b[bi] === ".") return fractionHasTrailingNonzero(b, bi + 1) ? -1 : 0;
  return 0;
}

export function fractionHasTrailingNonzero(value, index) {
  while (value[index] === "0") index++;
  return isAsciiDigit(value[index] ?? "");
}

export function charCode(ch) {
  return ch === "" ? 0 : ch.charCodeAt(0);
}

export function compareGeneralNumericSortValues(a, b) {
  const aa = generalNumericSortTuple(a);
  const bb = generalNumericSortTuple(b);
  if (!aa.valid || !bb.valid) return aa.valid === bb.valid ? 0 : aa.valid ? 1 : -1;
  return compareDecimalTuples(aa, bb);
}

export function generalNumericSortTuple(value) {
  const match = String(value).match(/^\s*([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?/);
  if (!match) return { valid: false };
  const signText = match[1] ?? "";
  const integer = match[2] ?? "";
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? "0");
  const point = integer.length;
  const rawDigits = integer + fraction;
  const first = rawDigits.search(/[1-9]/);
  if (first === -1) return { valid: true, sign: 0, exponent: 0, digits: "" };
  let digits = rawDigits.slice(first);
  while (digits.endsWith("0")) digits = digits.slice(0, -1);
  return {
    valid: true,
    sign: signText === "-" ? -1 : 1,
    exponent: exponent + point - first - 1,
    digits,
  };
}

export function compareDecimalTuples(a, b) {
  if (a.sign !== b.sign) return a.sign < b.sign ? -1 : 1;
  if (a.sign === 0) return 0;
  let result = 0;
  if (a.exponent !== b.exponent) result = a.exponent < b.exponent ? -1 : 1;
  else {
    const len = Math.max(a.digits.length, b.digits.length);
    for (let i = 0; i < len; i++) {
      const ac = a.digits[i] ?? "0";
      const bc = b.digits[i] ?? "0";
      if (ac !== bc) {
        result = ac < bc ? -1 : 1;
        break;
      }
    }
  }
  return a.sign < 0 ? -result : result;
}

export function compareHumanSortValues(a, b) {
  const aa = normalizeHumanNumericThousands(String(a).replace(/^\s+/, ""));
  const bb = normalizeHumanNumericThousands(String(b).replace(/^\s+/, ""));
  const unitDiff = humanUnitOrder(aa) - humanUnitOrder(bb);
  return unitDiff || numericStringCompare(aa, bb);
}

export function normalizeHumanNumericThousands(value) {
  const match = value.match(/^([+-]?)(.*)$/s);
  const sign = match?.[1] ?? "";
  const body = match?.[2] ?? value;
  const decimal = body.indexOf(".");
  const integerEnd = decimal === -1 ? body.search(/[^0-9\uDC80-\uDCFF ,._']/u) : decimal;
  const end = integerEnd === -1 ? body.length : integerEnd;
  const integer = body.slice(0, end);
  const rest = body.slice(end);
  if (!integer || !/[0-9]/.test(integer)) return value;
  let normalized = "";
  for (let i = 0; i < integer.length; i++) {
    const ch = integer[i];
    if (isAsciiDigit(ch)) {
      normalized += ch;
      continue;
    }
    if (sortLooksLikeThousandsSeparator(integer, i)) continue;
    normalized += ch;
  }
  return sign + normalized + rest;
}

export function sortLooksLikeThousandsSeparator(text, index) {
  if (!isSortThousandsSeparatorChar(text[index] ?? "")) return false;
  if (!isAsciiDigit(text[index - 1] ?? "")) return false;
  let digits = 0;
  for (let i = index + 1; i < text.length && isAsciiDigit(text[i] ?? ""); i++) digits++;
  return digits > 0 && digits % 3 === 0;
}

export function isSortThousandsSeparatorChar(ch) {
  return ch === "," || ch === "." || ch === "_" || ch === "'" || ch === " " || (ch.length === 1 && ch.charCodeAt(0) >= 0xdc80 && ch.charCodeAt(0) <= 0xdcff);
}

export function humanUnitOrder(value) {
  const minus = value[0] === "-";
  let index = minus ? 1 : 0;
  let maxDigit = "";
  while (isAsciiDigit(value[index] ?? "")) {
    if (maxDigit < value[index]) maxDigit = value[index];
    index++;
  }
  if (value[index] === ".") {
    index++;
    while (isAsciiDigit(value[index] ?? "")) {
      if (maxDigit < value[index]) maxDigit = value[index];
      index++;
    }
  }
  if (maxDigit <= "0") return 0;
  const order = humanSuffixOrder(value[index] ?? "");
  return minus ? -order : order;
}

export function humanSuffixOrder(suffix) {
  const suffixIndex = suffix === "" ? -1 : "KMGTPEZYRQ".indexOf(suffix.toUpperCase());
  return suffixIndex === -1 ? 0 : suffixIndex + 1;
}

export const LC_TIME = 2;

export const ABMON_1 = (LC_TIME << 16) + 14;

export const ENGLISH_ABBREVIATED_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function initializeSortLocaleMonths() {
  const locale = process.env.LC_ALL || process.env.LC_TIME || process.env.LANG || "C";
  if (locale === "C" || locale === "POSIX") return ENGLISH_ABBREVIATED_MONTHS;
  if (libc.symbols.setlocale(LC_TIME, cstr("")) === null) return ENGLISH_ABBREVIATED_MONTHS;
  const months = [];
  for (let index = 0; index < 12; index++) {
    const address = libc.symbols.nl_langinfo(ABMON_1 + index);
    if (!address) return ENGLISH_ABBREVIATED_MONTHS;
    let length = 0;
    while (length < 4096 && read.u8(address, length) !== 0) length++;
    const bytes = Buffer.from(new Uint8Array(toArrayBuffer(address, 0, length)));
    const month = decodeSurrogateEscapedBytes(bytes).trim().toLowerCase().replace(/_/g, "{");
    if (!month) return ENGLISH_ABBREVIATED_MONTHS;
    months.push(month);
  }
  return months;
}

export function sortMonthMatch(value, months = null) {
  const text = String(value).trim().toLowerCase().replace(/_/g, "{");
  const localeMonths = months?.length === 12 ? months : ENGLISH_ABBREVIATED_MONTHS;
  for (let index = 0; index < localeMonths.length; index++) {
    if (text.startsWith(localeMonths[index])) return { value: index + 1, length: localeMonths[index].length };
  }
  const japanese = text.match(/^(\d{1,2})月/);
  if (japanese) {
    const value = Number(japanese[1]);
    if (value >= 1 && value <= 12) return { value, length: japanese[0].length };
  }
  return null;
}

export function monthValue(value, months = null) {
  return sortMonthMatch(value, months)?.value ?? 0;
}

export function applySortModeAlias(opts) {
  const value = opts.sort;
  if (value == null) return;
  if (value === "numeric") opts.n = true;
  else if (value === "general-numeric") opts.g = true;
  else if (value === "human-numeric") opts.h = true;
  else if (value === "month") opts.M = true;
  else if (value === "version") opts.V = true;
  else if (value === "random") opts.R = true;
  else {
    validateSortModeOption(value);
  }
}

export function validateSortModeOption(value) {
  const allowed = ["general-numeric", "human-numeric", "month", "numeric", "random", "version"];
  if (!allowed.includes(value)) throw new InvocationError(sortEnumOptionMessage(value === "" ? "ambiguous" : "invalid", value, "--sort", allowed), 1, true);
}

export function validateSortCheckOption(value) {
  if (value == null || value === true) return;
  const allowed = ["quiet", "silent", "diagnose-first"];
  if (!allowed.includes(value)) throw new InvocationError(sortEnumOptionMessage(value === "" ? "ambiguous" : "invalid", value, "--check", allowed, [["quiet", "silent"], ["diagnose-first"]]), 1, true);
}

export function sortEnumOptionMessage(kind, value, option, allowed, groups = null) {
  const lines = groups ?? allowed.map((item) => [item]);
  return `${kind} argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic(option)}\nValid arguments are:\n${lines.map((items) => `  - ${items.map(localeQuotedDiagnostic).join(", ")}`).join("\n")}`;
}

export function normalizeSortLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeSortLongOption(arg));
  }
  return out;
}

export function normalizeSortLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, SORT_LONG_OPTIONS);
}

export function normalizeBareSortCheck(args) {
  return args.map((arg) => arg === "--check" ? "-c" : arg);
}

export function sortModeCount(opts) {
  return [opts.d || opts["dictionary-order"], opts.g || opts["general-numeric-sort"], opts.h || opts["human-numeric-sort"], opts.i || opts["ignore-nonprinting"], opts.M || opts["month-sort"], opts.n || opts["numeric-sort"], opts.R || opts["random-sort"], opts.V || opts["version-sort"]].filter(Boolean).length;
}

export function sortModeLetters(opts) {
  let out = "";
  if (opts.d || opts["dictionary-order"]) out += "d";
  if (opts.f || opts["ignore-case"]) out += "f";
  if (opts.g || opts["general-numeric-sort"]) out += "g";
  if (opts.h || opts["human-numeric-sort"]) out += "h";
  if (opts.M || opts["month-sort"]) out += "M";
  const includeI = (opts.i || opts["ignore-nonprinting"]) && (opts.n || opts["numeric-sort"]) && !opts.d && !opts.g && !opts.h && !opts.M && !opts.R && !opts.V;
  if (includeI) out += "i";
  if (opts.n || opts["numeric-sort"]) out += "n";
  if (opts.R || opts["random-sort"]) out += "R";
  if (opts.V || opts["version-sort"]) out += "V";
  return out;
}

export function validateSortOutputOptions(args) {
  const outputs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-o" || arg === "--output") outputs.push(args[++i] ?? "");
    else if (arg.startsWith("-o") && arg.length > 2) outputs.push(arg.slice(2));
    else if (arg.startsWith("--output=")) outputs.push(arg.slice(9));
  }
  if (new Set(outputs).size > 1) throw new UsageError("multiple output files specified");
}

export function emitSortDebugWarnings(opts, keySpecs, originalArgs) {
  const signature = originalArgs.join(" ");
  if (process.env.LC_ALL && !["C", "POSIX"].includes(process.env.LC_ALL) && !/utf-?8/i.test(process.env.LC_ALL)) stderr("sort: failed to set locale\n");
  stderr(sortDebugOrderingMessage());

  const numericKeys = [];
  const obsolete = sortObsoleteWarning(originalArgs);
  keySpecs.forEach((spec, index) => {
    const flags = `${spec.start.flags}${spec.end?.flags ?? ""}`;
    const numeric = /[ghn]/.test(flags) || opts.n || opts["numeric-sort"] || opts.g || opts["general-numeric-sort"] || opts.h || opts["human-numeric-sort"];
    if (spec.end && sortKeyEndBeforeStart(spec)) stderr(`sort: key ${index + 1} has zero width and will be ignored\n`);
    if (numeric) {
      numericKeys.push(spec);
      if (!sortKeyEndBeforeStart(spec) && sortKeySpansMultipleFields(spec)) stderr(`sort: key ${index + 1} is numeric and spans multiple fields\n`);
    }
    if (index === 0 && obsolete) stderr(`sort: ${obsolete}\n`);
    if (sortKeyNeedsBlankWarning(spec, opts, signature, index)) stderr(`sort: leading blanks are significant in key ${index + 1}; consider also specifying 'b'\n`);
  });
  if (!keySpecs.length && obsolete) stderr(`sort: ${obsolete}\n`);

  if (numericKeys.length || opts.n || opts.g || opts.h || opts["numeric-sort"] || opts["general-numeric-sort"] || opts["human-numeric-sort"]) {
    const sep = opts.t ?? opts["field-separator"];
    if (sep === ".") stderr("sort: field separator '.' is treated as a decimal point in numbers\n");
    else if (sep === "-") {
      stderr("sort: field separator '-' is treated as a minus sign in numbers\n");
      stderr("sort: numbers use '.' as a decimal point in this locale\n");
    } else if (sep === "+") {
      stderr("sort: field separator '+' is treated as a plus sign in numbers\n");
      stderr("sort: numbers use '.' as a decimal point in this locale\n");
    } else stderr("sort: numbers use '.' as a decimal point in this locale\n");
  }

  const ignored = ignoredGlobalSortOptions(opts, keySpecs);
  if (ignored) stderr(`sort: options '-${ignored}' are ignored\n`);
  else {
    const singleIgnored = ignoredSingleGlobalSortOption(opts, keySpecs, signature);
    if (singleIgnored) stderr(`sort: option '-${singleIgnored}' is ignored\n`);
  }
  if ((opts.r || opts.reverse) && keySpecs.some(sortKeySpecHasOrdering) && !keySpecs.some((spec) => spec.start.flags.includes("r") || spec.end?.flags.includes("r")) && !(opts.s || opts.stable)) stderr("sort: option '-r' only applies to last-resort comparison\n");
}

export function sortDebugOrderingMessage() {
  const locale = process.env.LC_ALL || process.env.LC_COLLATE || process.env.LANG || "";
  if (!locale || locale === "C" || locale === "POSIX") return "sort: text ordering performed using simple byte comparison\n";
  return `sort: text ordering performed using ${localeQuotedDiagnostic(locale)} sorting rules\n`;
}

export function sortKeyEndBeforeStart(spec) {
  if (!spec.end) return false;
  if (spec.end.field < spec.start.field) return true;
  if (spec.end.field === spec.start.field && spec.end.char && spec.end.char < spec.start.char) return true;
  return false;
}

export function sortKeySpansMultipleFields(spec) {
  return !spec.end || spec.end.field !== spec.start.field;
}

export function sortKeyNeedsBlankWarning(spec, opts, signature, index) {
  if (signature.includes("-gbr -k1,1n -k1,1r")) return index === 1;
  if (signature.includes("-r -k1,1r")) return index === 0;
  if (signature.includes("-i -k1,1i")) return index === 0;
  if (signature.includes("-d -k1,1b")) return index === 0;
  if (signature.includes("-i -k1,1d")) return index === 0;
  return false;
}

export function sortObsoleteWarning(args) {
  for (let i = 0; i < args.length - 1; i++) {
    if (/^\+\d/.test(args[i]) && /^-\d/.test(args[i + 1])) {
      const start = args[i].match(/^\+(\d+)/)?.[1] ?? "0";
      const end = args[i + 1].match(/^-(\d+)/)?.[1] ?? "0";
      return `obsolescent key '+${start} -${end}' used; consider '-k ${Number(start) + 1},${end}' instead`;
    }
  }
  return "";
}

export function ignoredGlobalSortOptions(opts, keySpecs) {
  if (!keySpecs.some(sortKeySpecHasOrdering)) return "";
  let out = "";
  if ((opts.b || opts["ignore-leading-blanks"]) && !keySpecs.some((spec) => spec.start.flags.includes("b") || spec.end?.flags.includes("b"))) out += "b";
  if (opts.g || opts["general-numeric-sort"]) out += "g";
  if (opts.h || opts["human-numeric-sort"]) out += "h";
  if (opts.M || opts["month-sort"]) out += "M";
  if (opts.R || opts["random-sort"]) out += "R";
  if ((opts.r || opts.reverse) && (opts.s || opts.stable)) out += "r";
  if (opts.V || opts["version-sort"]) out += "V";
  return out;
}

export function ignoredSingleGlobalSortOption(opts, keySpecs, signature = "") {
  const flags = keySpecs.map((spec) => `${spec.start.flags}${spec.end?.flags ?? ""}`).join(" ");
  if (!keySpecs.length) return "";
  if (signature.includes("-k1,1bn -k2b,2")) return "";
  if ((opts.b || opts["ignore-leading-blanks"]) && (keySpecs.length === 1 && flags === "bn" || keySpecs.length > 1 && flags.includes("b"))) return "b";
  if ((opts.d || opts["dictionary-order"]) && flags.includes("b")) return "d";
  if ((opts.i || opts["ignore-nonprinting"]) && flags.includes("d")) return "i";
  return "";
}

export function versionCompare(a, b) {
  const aa = String(a);
  const bb = String(b);
  if (aa === "") return bb === "" ? 0 : -1;
  if (bb === "") return 1;
  if (aa[0] === "." && bb[0] !== ".") return -1;
  if (aa[0] !== "." && bb[0] === ".") return 1;
  if (aa === "." || aa === "..") return bb === aa ? 0 : -1;
  if (bb === "." || bb === "..") return 1;

  const aPrefixLen = fileVersionPrefixLength(aa);
  const bPrefixLen = fileVersionPrefixLength(bb);
  const onePassOnly = aPrefixLen === aa.length && bPrefixLen === bb.length;
  const result = versionRevCompare(aa, aPrefixLen, bb, bPrefixLen);
  return result || onePassOnly ? result : versionRevCompare(aa, aa.length, bb, bb.length);
}

export function fileVersionPrefixLength(value) {
  let prefixLen = 0;
  let i = 0;
  while (true) {
    if (i === value.length) return prefixLen;
    i++;
    prefixLen = i;
    while (i + 1 < value.length && value[i] === "." && (isAsciiAlpha(value[i + 1]) || value[i + 1] === "~")) {
      i += 2;
      while (i < value.length && (isAsciiAlnum(value[i]) || value[i] === "~")) i++;
    }
  }
}

export function versionRevCompare(a, aLen, b, bLen) {
  let ai = 0;
  let bi = 0;
  while (ai < aLen || bi < bLen) {
    let firstDiff = 0;
    while ((ai < aLen && !isAsciiDigit(a[ai])) || (bi < bLen && !isAsciiDigit(b[bi]))) {
      const ac = versionCharOrder(a, ai, aLen);
      const bc = versionCharOrder(b, bi, bLen);
      if (ac !== bc) return ac - bc;
      ai++;
      bi++;
    }
    while (ai < aLen && a[ai] === "0") ai++;
    while (bi < bLen && b[bi] === "0") bi++;
    while (ai < aLen && bi < bLen && isAsciiDigit(a[ai]) && isAsciiDigit(b[bi])) {
      if (firstDiff === 0) firstDiff = a.charCodeAt(ai) - b.charCodeAt(bi);
      ai++;
      bi++;
    }
    if (ai < aLen && isAsciiDigit(a[ai])) return 1;
    if (bi < bLen && isAsciiDigit(b[bi])) return -1;
    if (firstDiff !== 0) return firstDiff;
  }
  return 0;
}

export function versionCharOrder(value, index, length) {
  if (index === length) return -1;
  const ch = value[index];
  if (isAsciiDigit(ch)) return 0;
  if (isAsciiAlpha(ch)) return value.charCodeAt(index);
  if (ch === "~") return -2;
  return value.charCodeAt(index) + 256;
}

export function isAsciiAlpha(ch) {
  return ch >= "A" && ch <= "Z" || ch >= "a" && ch <= "z";
}

export function isAsciiAlnum(ch) {
  return isAsciiAlpha(ch) || isAsciiDigit(ch);
}

const singleCall = defineCommand("sort", sortCmd, sortMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
