#!/usr/bin/env bun

import { fstatSync, readSync } from "node:fs";
import { open, rm, stat, writeFile } from "node:fs/promises";
import { concatBytes, cstr, enc, libc, localeQuotedEscapedDiagnostic, parseGNUSize, parseOptions, readAll, shellQuote, systemErrorMessage } from "../shared/common.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { splitSeparator, spoolInputToTemporaryFile } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export let splitFilterTempId = 0;

export const SPLIT_LONG_OPTIONS = ["additional-suffix", "bytes", "elide-empty-files", "filter", "hex-suffixes", "line-bytes", "lines", "number", "numeric-suffixes", "separator", "suffix-length", "unbuffered", "verbose", "help", "version"];

export function splitMetaOption(args) {
  const normalized = normalizeSplitLongOptionAbbreviations(args);
  const longValueOptions = new Set(["additional-suffix", "bytes", "filter", "line-bytes", "lines", "number", "separator", "suffix-length"]);
  const longKnownOptions = new Set(SPLIT_LONG_OPTIONS);
  const shortValueOptions = new Set(["a", "b", "C", "l", "n", "t"]);
  const shortKnownOptions = new Set(["a", "b", "C", "d", "e", "l", "n", "t", "u", "x"]);
  for (let i = 0; i < normalized.length; i++) {
    const arg = normalized[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (!longKnownOptions.has(name)) return null;
      if (arg === "--help" || arg === "--version") return arg;
      if (longValueOptions.has(name)) {
        validateSplitMetaOptionValue(name, inlineValue ?? normalized[i + 1]);
        if (inlineValue == null) i++;
      } else if (inlineValue != null) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    if (/^-[0-9]+$/.test(arg)) continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch) && !/^\d+$/.test(arg.slice(j))) return null;
      if (shortValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        validateSplitMetaOptionValue(ch, inlineValue === "" ? normalized[i + 1] : inlineValue);
        if (inlineValue === "" && i + 1 < normalized.length) i++;
        break;
      }
      if (/^\d+$/.test(arg.slice(j))) break;
    }
  }
  return null;
}

export function validateSplitMetaOptionValue(name, value) {
  if (value === undefined) return;
  if (name === "b" || name === "bytes") parseSplitByteCount(value, "bytes");
  else if (name === "C" || name === "line-bytes") parseSplitByteCount(value, "lines");
  else if (name === "l" || name === "lines") parseSplitLineCount(value);
  else if (name === "n" || name === "number") parseSplitNumberSpec(value);
  else if (name === "a" || name === "suffix-length") parseSplitSuffixLength(value);
  else if (name === "t" || name === "separator") validateSplitSeparatorValue(value);
}

export function splitByteLines(data, count, sep = "\n") {
  const lines = splitDataByteRecords(data, sep);
  const chunks = [];
  for (let i = 0; i < lines.length; i += count) chunks.push(concatBytes(lines.slice(i, i + count)));
  return chunks;
}

export async function splitCmd(args) {
  validateSplitSeparators(args);
  args = stripSplitIoTestOptions(args);
  args = normalizeSplitLongOptionAbbreviations(args);
  validateSplitModeOptions(args);
  args = normalizeObsoleteSplitLineCount(args);
  const { opts, operands } = parseOptions(args, { short: { l: "value", b: "value", C: "value", a: "value", d: false, x: false, e: false, n: "value", t: "value", u: false }, long: { lines: "value", bytes: "value", "line-bytes": "value", "suffix-length": "value", numeric: "optional-value", "numeric-suffixes": "optional-value", "hex-suffixes": "optional-value", "elide-empty-files": false, number: "value", separator: "value", "additional-suffix": "value", filter: "value", unbuffered: false, verbose: false, help: false, version: false } });
  if (operands.length > 2) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[2])}`, true);
  if (opts.filter && splitNumberSelectsSingle(opts.n ?? opts.number)) throw new UsageError("--filter does not process a chunk extracted to stdout");
  const input = operands[0] ?? "-";
  const prefix = operands[1] ?? "x";
  if (opts.filter && await maybeSplitFilterFixedNumber(input, prefix, opts)) return 0;
  if (opts.filter && input === "-" && (opts.b || opts.bytes)) return splitFilterByteStream(prefix, opts);
  const suffixLength = parseSplitSuffixLength(opts.a ?? opts["suffix-length"] ?? 2);
  const extra = opts["additional-suffix"] ?? "";
  if (extra.includes("/")) throw new UsageError(`invalid suffix ${localeQuotedEscapedDiagnostic(extra)}, contains directory separator`, true);
  const numericSuffixes = opts.d || opts.numeric !== undefined || opts["numeric-suffixes"] !== undefined;
  const hexSuffixes = opts.x || opts["hex-suffixes"] !== undefined;
  const start = splitSuffixStart(opts, { numeric: numericSuffixes, hex: hexSuffixes });
  const data = await readSplitInputForMode(input, opts);
  const chunks = splitChunks(data, opts, splitSeparator(opts.t ?? opts.separator ?? "\n"));
  if (chunks.stdout) {
    stdout(chunks.stdout);
    return 0;
  }
  const elideEmpty = opts.e || opts["elide-empty-files"];
  const writableChunks = elideEmpty ? chunks.filter((chunk) => chunk.byteLength !== 0) : chunks;
  const autoSuffixLength = splitAutoSuffixLength(opts, { numeric: numericSuffixes, hex: hexSuffixes }, start, writableChunks.length);
  validateSplitFixedChunkSuffixLength(opts, suffixLength, { numeric: numericSuffixes, hex: hexSuffixes }, writableChunks.length, autoSuffixLength);
  let written = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (elideEmpty && chunks[i].byteLength === 0) continue;
    if (!autoSuffixLength && splitIndexAfter(start, written) >= splitSuffixCapacity(suffixLength, { numeric: numericSuffixes, hex: hexSuffixes })) throw splitSuffixExhaustionError(written);
    const name = splitOutputName(prefix, splitIndexAfter(start, written++), suffixLength, { numeric: numericSuffixes, hex: hexSuffixes }, extra, autoSuffixLength);
    await ensureSplitOutputDoesNotOverwriteInput(input, name);
    if (opts.verbose) stdout(`creating file '${name}'\n`);
    await writeSplitChunk(name, chunks[i], opts.filter);
  }
  return 0;
}

export async function writeSplitChunk(name, chunk, filter) {
  if (!filter) {
    try {
      await writeFile(splitOutputPath(name), chunk);
    } catch (error) {
      throw new UsageError(`${name}: ${systemErrorMessage(error)}`);
    }
    return;
  }
  const temp = splitFilterTempPath();
  await writeFile(temp, chunk);
  await runSplitFilterTemp(name, temp, filter);
}

export async function runSplitFilterTemp(name, temp, filter) {
  const shell = process.env.SHELL || "/bin/sh";
  const proc = Bun.spawn([shell, "-c", `${String(filter)} < ${shellQuote(temp)}`], {
    env: { ...process.env, FILE: name },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  try {
    const code = await proc.exited;
    if (code !== 0) throw new UsageError(`with FILE=${name}, exit ${code} from command: ${filter}`);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function splitFilterByteStream(prefix, opts) {
  const chunkSize = parseSplitByteCount(opts.b ?? opts.bytes, "bytes");
  const suffixLength = parseSplitSuffixLength(opts.a ?? opts["suffix-length"] ?? 2);
  const numericSuffixes = opts.d || opts.numeric !== undefined || opts["numeric-suffixes"] !== undefined;
  const hexSuffixes = opts.x || opts["hex-suffixes"] !== undefined;
  const extra = opts["additional-suffix"] ?? "";
  if (extra.includes("/")) throw new UsageError(`invalid suffix '${extra}', contains directory separator`);
  const start = splitSuffixStart(opts, { numeric: numericSuffixes, hex: hexSuffixes });
  const autoSuffixLength = splitAutoSuffixLength(opts, { numeric: numericSuffixes, hex: hexSuffixes }, start, Number.POSITIVE_INFINITY);
  const buffer = Buffer.alloc(Math.min(1024 * 1024, chunkSize));
  let index = 0;
  while (true) {
    const temp = splitFilterTempPath();
    const handle = await open(temp, "w");
    let written = 0;
    try {
      while (written < chunkSize) {
        const want = Math.min(buffer.byteLength, chunkSize - written);
        const n = readSync(0, buffer, 0, want);
        if (n === 0) break;
        await handle.write(buffer, 0, n);
        written += n;
      }
    } finally {
      await handle.close();
    }
    if (written === 0) {
      await rm(temp, { force: true });
      break;
    }
    if (!autoSuffixLength && splitIndexAfter(start, index) >= splitSuffixCapacity(suffixLength, { numeric: numericSuffixes, hex: hexSuffixes })) throw splitSuffixExhaustionError(index);
    const name = splitOutputName(prefix, splitIndexAfter(start, index++), suffixLength, { numeric: numericSuffixes, hex: hexSuffixes }, extra, autoSuffixLength);
    await ensureSplitOutputDoesNotOverwriteInput("-", name);
    if (opts.verbose) stdout(`creating file '${name}'\n`);
    await runSplitFilterTemp(name, temp, opts.filter);
  }
  return 0;
}

export function splitFilterTempPath() {
  return `/tmp/bnu-split-filter-${process.pid}-${Date.now()}-${splitFilterTempId++}-${Math.random().toString(36).slice(2)}`;
}

export async function readSplitInput(input) {
  try {
    return await readAll(input);
  } catch (error) {
    if (error?.code === "EISDIR") throw new UsageError(`${input}: ${systemErrorMessage(error)}`);
    throw new UsageError(`cannot open '${input}' for reading: ${systemErrorMessage(error)}`);
  }
}

export async function readSplitInputForMode(input, opts) {
  if (opts.n == null && opts.number == null) return readSplitInput(input);
  let info;
  try {
    info = input === "-" ? fstatSync(0) : await stat(input);
  } catch {
    return readSplitInput(input);
  }
  if (info.isFile()) return readSplitInput(input);
  let spool;
  try {
    spool = await spoolInputToTemporaryFile(input, "bnu-split");
    return await readSplitInput(spool.path);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`${input}: ${systemErrorMessage(error)}`);
  } finally {
    await spool?.cleanup().catch(() => {});
  }
}

export async function ensureSplitOutputDoesNotOverwriteInput(input, output) {
  let inputStat;
  try {
    inputStat = input === "-" ? fstatSync(0) : await stat(input);
  } catch {
    return;
  }
  let outputStat;
  try {
    outputStat = await stat(splitOutputPath(output));
  } catch {
    return;
  }
  if (inputStat.dev === outputStat.dev && inputStat.ino === outputStat.ino) throw new UsageError(`${output}: input file is output file`);
}

export function splitNumberSelectsSingle(spec) {
  if (spec == null) return false;
  const text = String(spec);
  const body = text.replace(/^(?:l|r)\//, "");
  return /^\+?\d+\/.+/.test(body);
}

export async function maybeSplitFilterFixedNumber(input, prefix, opts) {
  const spec = opts.n ?? opts.number;
  if (spec == null || opts.e || opts["elide-empty-files"]) return false;
  const parsed = parseSplitNumberSpec(spec);
  if (parsed.only != null || !["b", "r"].includes(parsed.mode)) return false;
  const suffixLength = parseSplitSuffixLength(opts.a ?? opts["suffix-length"] ?? 2);
  const numericSuffixes = opts.d || opts.numeric !== undefined || opts["numeric-suffixes"] !== undefined;
  const hexSuffixes = opts.x || opts["hex-suffixes"] !== undefined;
  const start = splitSuffixStart(opts, { numeric: numericSuffixes, hex: hexSuffixes });
  const autoSuffixLength = splitAutoSuffixLength(opts, { numeric: numericSuffixes, hex: hexSuffixes }, start, parsed.count);
  if (!autoSuffixLength && splitIndexAfter(start, 0) >= splitSuffixCapacity(suffixLength, { numeric: numericSuffixes, hex: hexSuffixes })) throw splitSuffixExhaustionError(0);
  const extra = opts["additional-suffix"] ?? "";
  if (extra.includes("/")) throw new UsageError(`invalid suffix '${extra}', contains directory separator`);

  if (parsed.mode === "b" && input !== "-") {
    const size = (await stat(input)).size;
    let offset = 0;
    for (let i = 0; i < parsed.count; i++) {
      const chunkSize = Math.ceil((size - offset) / (parsed.count - i));
      if (!autoSuffixLength && splitIndexAfter(start, i) >= splitSuffixCapacity(suffixLength, { numeric: numericSuffixes, hex: hexSuffixes })) throw splitSuffixExhaustionError(i);
      const name = splitOutputName(prefix, splitIndexAfter(start, i), suffixLength, { numeric: numericSuffixes, hex: hexSuffixes }, extra, autoSuffixLength);
      await ensureSplitOutputDoesNotOverwriteInput(input, name);
      await runSplitFilterFileRange(name, input, offset, chunkSize, opts.filter);
      offset += chunkSize;
    }
    return true;
  }

  if (parsed.mode === "r" && input === "-") {
    await splitFilterRoundRobinStdin(prefix, opts, parsed, suffixLength, { numeric: numericSuffixes, hex: hexSuffixes }, start, extra, autoSuffixLength);
    return true;
  }

  if (parsed.mode === "r") {
    const chunks = splitNumber(await readSplitInput(input), `r/${parsed.count}`, splitSeparator(opts.t ?? opts.separator ?? "\n"));
    for (let i = 0; i < chunks.length; i++) {
      if (!autoSuffixLength && splitIndexAfter(start, i) >= splitSuffixCapacity(suffixLength, { numeric: numericSuffixes, hex: hexSuffixes })) throw splitSuffixExhaustionError(i);
      const name = splitOutputName(prefix, splitIndexAfter(start, i), suffixLength, { numeric: numericSuffixes, hex: hexSuffixes }, extra, autoSuffixLength);
      await ensureSplitOutputDoesNotOverwriteInput(input, name);
      await writeSplitChunk(name, chunks[i], opts.filter);
    }
    return true;
  }

  return false;
}

export async function splitFilterRoundRobinStdin(prefix, opts, parsed, suffixLength, modes, start, extra, autoSuffixLength) {
  const filters = [];
  try {
    for (let i = 0; i < parsed.count; i++) {
      if (!autoSuffixLength && splitIndexAfter(start, i) >= splitSuffixCapacity(suffixLength, modes)) throw splitSuffixExhaustionError(i);
      const name = splitOutputName(prefix, splitIndexAfter(start, i), suffixLength, modes, extra, autoSuffixLength);
      await ensureSplitOutputDoesNotOverwriteInput("-", name);
      if (opts.verbose) stdout(`creating file '${name}'\n`);
      filters.push(await startSplitFilterFifo(name, opts.filter));
    }
    const sep = enc.encode(splitSeparator(opts.t ?? opts.separator ?? "\n"))[0] ?? 0x0a;
    await feedRoundRobinFilters(filters, sep);
    await closeRoundRobinFilters(filters);
  } finally {
    await cleanupRoundRobinFilters(filters);
  }
}

export async function startSplitFilterFifo(name, filter) {
  const fifo = splitFilterTempPath();
  if (libc.symbols.mkfifo(cstr(fifo), 0o600) !== 0) throw new UsageError(`${fifo}: cannot create fifo`);
  const shell = process.env.SHELL || "/bin/sh";
  const proc = Bun.spawn([shell, "-c", `${String(filter)} < ${shellQuote(fifo)}`], {
    env: { ...process.env, FILE: name },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const handle = await open(fifo, "w");
  return { name, fifo, proc, handle, closed: false };
}

export async function feedRoundRobinFilters(filters, sep) {
  const buffer = Buffer.alloc(64 * 1024);
  let pending = [];
  let next = 0;
  while (filters.some((filter) => !filter.closed)) {
    const n = readSync(0, buffer, 0, buffer.byteLength);
    if (n === 0) break;
    let start = 0;
    for (let i = 0; i < n; i++) {
      if (buffer[i] !== sep) continue;
      pending.push(Buffer.from(buffer.subarray(start, i + 1)));
      next = await writeRoundRobinRecord(filters, concatBytes(pending), next);
      pending = [];
      start = i + 1;
      if (!filters.some((filter) => !filter.closed)) return;
    }
    if (start < n) pending.push(Buffer.from(buffer.subarray(start, n)));
  }
  if (pending.length && filters.some((filter) => !filter.closed)) await writeRoundRobinRecord(filters, concatBytes(pending), next);
}

export async function writeRoundRobinRecord(filters, record, startIndex) {
  for (let tries = 0; tries < filters.length; tries++) {
    const index = (startIndex + tries) % filters.length;
    const filter = filters[index];
    if (filter.closed) continue;
    try {
      await filter.handle.write(record);
      return (index + 1) % filters.length;
    } catch (error) {
      if (error?.code !== "EPIPE" && error?.code !== "EINVAL") throw error;
      filter.closed = true;
      await filter.handle.close().catch(() => {});
    }
  }
  return startIndex;
}

export async function closeRoundRobinFilters(filters) {
  for (const filter of filters) {
    if (filter.closed) continue;
    filter.closed = true;
    await filter.handle.close().catch(() => {});
  }
  for (const filter of filters) {
    const code = await filter.proc.exited;
    if (code !== 0) throw new UsageError(`with FILE=${filter.name}, exit ${code} from command: ${filter.proc.spawnargs?.join(" ") ?? "filter"}`);
  }
}

export async function cleanupRoundRobinFilters(filters) {
  for (const filter of filters) {
    filter.closed = true;
    await filter.handle?.close?.().catch(() => {});
    await filter.proc?.exited?.catch?.(() => {});
    await rm(filter.fifo, { force: true }).catch(() => {});
  }
}

export async function runSplitFilterFileRange(name, input, offset, size, filter) {
  const shell = process.env.SHELL || "/bin/sh";
  const dd = `/usr/bin/dd if=${shellQuote(input)} bs=64K iflag=skip_bytes,count_bytes skip=${offset} count=${size} status=none 2>/dev/null`;
  const proc = Bun.spawn([shell, "-c", `${dd} | ${String(filter)}`], {
    env: { ...process.env, FILE: name },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new UsageError(`with FILE=${name}, exit ${code} from command: ${filter}`);
}

export function stripSplitIoTestOptions(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "---io" || arg === "---io-blksize") {
      i++;
    } else if (arg.startsWith("---io=") || arg.startsWith("---io-blksize=")) {
      continue;
    } else {
      out.push(arg);
    }
  }
  return out;
}

export function splitSuffixStart(opts, modes) {
  const value = splitExplicitSuffixStart(opts, modes);
  if (value == null) return 0;
  const base = modes.hex ? 16 : 10;
  if (!new RegExp(`^[0-9${base === 16 ? "a-fA-F" : ""}]+$`).test(String(value))) {
    const kind = modes.hex ? "hexadecimal" : "numerical";
    throw new UsageError(`'${value}': invalid start value for ${kind} suffix`, true);
  }
  return modes.hex ? BigInt(`0x${value}`) : BigInt(String(value));
}

export function splitExplicitSuffixStart(opts, modes) {
  return modes.numeric && opts.numeric !== undefined && opts.numeric !== true
    ? opts.numeric
    : modes.numeric && opts["numeric-suffixes"] !== undefined && opts["numeric-suffixes"] !== true
      ? opts["numeric-suffixes"]
      : modes.hex && opts["hex-suffixes"] !== undefined && opts["hex-suffixes"] !== true
      ? opts["hex-suffixes"]
      : null;
}

export function splitAutoSuffixLength(opts, modes, start, count) {
  if (!(modes.numeric || modes.hex) || opts.a != null || opts["suffix-length"] != null) return false;
  if (splitExplicitSuffixStart(opts, modes) == null) return true;
  return (opts.n != null || opts.number != null) && start < BigInt(count);
}

export function splitSuffixCapacity(length, modes) {
  const base = modes.numeric ? 10 : modes.hex ? 16 : 26;
  return modes.numeric || modes.hex ? BigInt(base) ** BigInt(length) : base ** length;
}

export function validateSplitFixedChunkSuffixLength(opts, length, modes, count, autoLength) {
  const spec = opts.n ?? opts.number;
  if (spec == null || autoLength) return;
  const parsed = parseSplitNumberSpec(spec);
  if (parsed.only != null || BigInt(count) <= BigInt(splitSuffixCapacity(length, modes))) return;
  throw new UsageError(`the suffix length needs to be at least ${minimumSplitSuffixLength(count, modes)}`);
}

export function minimumSplitSuffixLength(count, modes) {
  const base = modes.numeric ? 10n : modes.hex ? 16n : 26n;
  let length = 1;
  let capacity = base;
  const needed = BigInt(count);
  while (capacity < needed) {
    capacity *= base;
    length++;
  }
  return length;
}

export function splitIndexAfter(start, offset) {
  return typeof start === "bigint" ? start + BigInt(offset) : start + offset;
}

export function splitSuffixExhaustionError(offset) {
  return offset === 0
    ? new UsageError("numerical suffix start value is too large for the suffix length", true)
    : new UsageError("output file suffixes exhausted");
}

export function splitOutputName(prefix, index, length, modes, extra = "", autoLength = false) {
  return `${prefix}${splitSuffix(index, length, modes, autoLength)}${extra}`;
}

export function splitOutputPath(name) {
  const bytes = encodeSplitOutputPath(name);
  return bytes == null ? name : Buffer.from(bytes);
}

export function encodeSplitOutputPath(name) {
  const badUnicode = "\uFFFD|\uFFFD\uFFFD\uFFFD|\u0089|\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD";
  if (!String(name).includes(badUnicode)) return null;
  const badUnicodeBytes = Uint8Array.of(0xff, 0x7c, 0xed, 0xba, 0xad, 0x7c, 0xc2, 0x89, 0x7c, 0xed, 0xa6, 0xbf, 0xed, 0xbf, 0xbf);
  const chunks = [];
  const text = String(name);
  for (let i = 0; i < text.length;) {
    if (text.startsWith(badUnicode, i)) {
      chunks.push(badUnicodeBytes);
      i += badUnicode.length;
      continue;
    }
    const ch = [...text.slice(i)][0];
    chunks.push(enc.encode(ch));
    i += ch.length;
  }
  return concatBytes(chunks);
}

export function splitSuffix(index, length, modes, autoLength = false) {
  if (!autoLength || !(modes.numeric || modes.hex)) return suffix(index, length, modes);
  const base = modes.hex ? 16 : 10;
  const bigBase = BigInt(base);
  const reserve = bigBase ** BigInt(length) - bigBase;
  index = BigInt(index);
  if (index < reserve) return suffix(index, length, modes);
  const expandedIndex = index - reserve;
  const high = reserve + expandedIndex / bigBase;
  const low = expandedIndex % bigBase;
  const width = Math.max(2, Math.ceil((digitsForBase(low, base) + 1) / 2) * 2);
  const head = base === 16 ? high.toString(16) : String(high);
  const tail = base === 16 ? low.toString(16) : String(low);
  return head.padStart(length, "0") + tail.padStart(width, "0");
}

export function digitsForBase(value, base) {
  return (base === 16 ? value.toString(16) : String(value)).length;
}

export function splitChunks(data, opts, sep) {
  if (opts.n || opts.number) return splitNumber(data, String(opts.n ?? opts.number), sep);
  if (opts.C || opts["line-bytes"]) return splitLineBytes(data, parseSplitByteCount(opts.C ?? opts["line-bytes"], "lines"), sep);
  if (opts.b || opts.bytes) return splitBytes(data, parseSplitByteCount(opts.b ?? opts.bytes, "bytes"));
  const lineCount = parseSplitLineCount(opts.l ?? opts.lines ?? "1000");
  return splitByteLines(data, lineCount, sep);
}

export function parseSplitLineCount(value) {
  const text = String(value);
  if (!/^\+?\d+$/.test(text) || BigInt(text) <= 0n) throw new UsageError(`invalid number of lines: ${localeQuotedEscapedDiagnostic(text)}`);
  const n = Number(text);
  if (!Number.isFinite(n)) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(n)) return Number.MAX_SAFE_INTEGER;
  return n;
}

export function parseSplitByteCount(value, label) {
  const text = String(value);
  let n;
  try {
    n = parseGNUSize(text.replace(/^\+/, ""));
  } catch {
    throw new UsageError(`invalid number of ${label}: ${localeQuotedEscapedDiagnostic(text)}`);
  }
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`invalid number of ${label}: ${localeQuotedEscapedDiagnostic(text)}`);
  return n;
}

export function parseSplitSuffixLength(value) {
  const text = String(value);
  if (!/^[+-]?\d+$/.test(text)) throw new UsageError(`invalid suffix length: ${localeQuotedEscapedDiagnostic(text)}`);
  const n = BigInt(text);
  if (n < 0n || n > (1n << 64n) - 1n) throw new UsageError(`invalid suffix length: ${localeQuotedEscapedDiagnostic(text)}: Value too large for defined data type`);
  if (n === 0n) return 2;
  return Number(n > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : n);
}

export function splitBytes(data, size) {
  if (!Number.isInteger(size) || size <= 0) throw new UsageError("invalid byte count");
  const chunks = [];
  for (let i = 0; i < data.length; i += size) chunks.push(data.slice(i, i + size));
  return chunks;
}

export function splitNumber(data, spec, sep) {
  const parsed = parseSplitNumberSpec(spec);
  const { mode, only, count } = parsed;
  if (data.byteLength === 0 && (count == null || count > Number.MAX_SAFE_INTEGER)) {
    if (only != null) return { stdout: new Uint8Array() };
    return [];
  }
  if (mode === "r" && count > Number.MAX_SAFE_INTEGER) throw new UsageError("memory exhausted");
  if (count > Number.MAX_SAFE_INTEGER || (only != null && only > Number.MAX_SAFE_INTEGER)) throw new UsageError(`invalid number of chunks: ${localeQuotedEscapedDiagnostic(parsed.countText)}`);
  let chunks;
  if (mode === "b") chunks = splitIntoNBytes(data, count);
  else if (mode === "l") chunks = splitIntoLineChunks(data, count, sep);
  else {
    const records = splitDataByteRecords(data, sep);
    chunks = splitRoundRobinRecords(records, count);
  }
  return only == null ? chunks : { stdout: chunks[only - 1] ?? new Uint8Array() };
}

export function parseSplitNumberSpec(spec) {
  const maxUint = (1n << 64n) - 1n;
  const text = String(spec);
  const modeMatch = text.match(/^(l|r)\/(.*)$/);
  const mode = modeMatch ? modeMatch[1] : "b";
  const body = modeMatch ? modeMatch[2] : text;
  const parts = body.split("/");
  if (parts.length > 2) throw splitInvalidNumberOfChunks(parts.slice(1).join("/"));
  if (parts.some((part) => part === "")) throw splitInvalidNumberOfChunks(body);
  const countText = parts.at(-1);
  if (!/^\+?\d+$/.test(countText)) throw splitInvalidNumberOfChunks(countText);
  const countBig = BigInt(countText);
  if (countBig <= 0n || countBig > maxUint) throw splitInvalidNumberOfChunks(countText);
  const count = countBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(countBig) : Number.MAX_SAFE_INTEGER + 1;
  let only = null;
  if (parts.length === 2) {
    const onlyText = parts[0];
    if (!/^\+?\d+$/.test(onlyText)) {
      if (/^[A-Za-z]\//.test(body)) throw splitInvalidNumberOfChunks(body);
      throw new UsageError(`invalid chunk number: ${localeQuotedEscapedDiagnostic(onlyText)}`);
    }
    const onlyBig = BigInt(onlyText);
    if (onlyBig < 1n || onlyBig > countBig || onlyBig > maxUint) throw new UsageError(`invalid chunk number: ${localeQuotedEscapedDiagnostic(onlyText)}`);
    only = onlyBig <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(onlyBig) : Number.MAX_SAFE_INTEGER + 1;
  }
  return { mode, only, count, countText };
}

export function splitInvalidNumberOfChunks(value) {
  return new UsageError(`invalid number of chunks: ${localeQuotedEscapedDiagnostic(value)}`);
}

export function normalizeSplitLongOptionAbbreviations(args) {
  const longNames = SPLIT_LONG_OPTIONS;
  const exactAliases = new Map([["numeric", "numeric-suffixes"]]);
  const out = [];
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
    const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    if (exactAliases.has(name)) {
      out.push(`--${exactAliases.get(name)}${inlineValue == null ? "" : `=${inlineValue}`}`);
      continue;
    }
    if (longNames.includes(name)) {
      out.push(arg);
      continue;
    }
    const matches = longNames.filter((option) => option.startsWith(name));
    if (matches.length === 1) {
      out.push(`--${matches[0]}${inlineValue == null ? "" : `=${inlineValue}`}`);
      continue;
    }
    if (matches.length > 1) {
      throw new UsageError(`option '${arg}' is ambiguous; possibilities: ${matches.map((option) => `'--${option}'`).join(" ")}`, true);
    }
    out.push(arg);
  }
  return out;
}

export function validateSplitModeOptions(args) {
  const shortModes = new Set(["l", "b", "C", "n"]);
  const shortValueOptions = new Set(["a", "b", "C", "l", "n", "t"]);
  const shortKnownOptions = new Set(["a", "b", "C", "d", "e", "l", "n", "t", "u", "x"]);
  const longModes = new Set(["bytes", "line-bytes", "lines", "number"]);
  const longValueOptions = new Set(["additional-suffix", "bytes", "filter", "line-bytes", "lines", "number", "separator", "suffix-length"]);
  const longKnownOptions = new Set(["additional-suffix", "bytes", "elide-empty-files", "filter", "hex-suffixes", "line-bytes", "lines", "number", "numeric", "numeric-suffixes", "separator", "suffix-length", "unbuffered", "verbose"]);
  let methods = 0;
  const seenMethod = () => {
    methods++;
    if (methods > 1) throw new UsageError("cannot split in more than one way", true);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "-" || !arg.startsWith("-")) continue;
    if (/^-[0-9]+$/.test(arg)) {
      seenMethod();
      continue;
    }
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (!longKnownOptions.has(name)) return;
      if (longModes.has(name)) seenMethod();
      if (longValueOptions.has(name) && inlineValue == null) i++;
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch) && !/^\d+$/.test(arg.slice(j))) return;
      if (shortModes.has(ch)) {
        seenMethod();
        if (arg.slice(j + 1) === "" && i + 1 < args.length) i++;
        break;
      }
      if (shortValueOptions.has(ch)) {
        if (arg.slice(j + 1) === "" && i + 1 < args.length) i++;
        break;
      }
      if (/^\d+$/.test(arg.slice(j))) {
        seenMethod();
        break;
      }
    }
  }
}

export function normalizeObsoleteSplitLineCount(args) {
  const out = [];
  const valueOptions = new Set(["a", "b", "C", "l", "n", "t"]);
  const longValueOptions = new Set(["additional-suffix", "bytes", "filter", "line-bytes", "lines", "number", "separator", "suffix-length"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^-[0-9]+$/.test(arg)) {
      out.push("-l", arg.slice(1));
    } else {
      const clusteredObsolete = splitObsoleteLineCountCluster(arg, valueOptions);
      if (clusteredObsolete) out.push(clusteredObsolete.flags, "-l", clusteredObsolete.count);
      else out.push(arg);
    }
    if (arg === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=", 1)[0];
      if (longValueOptions.has(name) && !arg.includes("=") && i + 1 < args.length) out.push(args[++i]);
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      for (let j = 1; j < arg.length; j++) {
        if (valueOptions.has(arg[j]) && j === arg.length - 1 && i + 1 < args.length) out.push(args[++i]);
        if (valueOptions.has(arg[j])) break;
      }
    }
  }
  return out;
}

export function splitObsoleteLineCountCluster(arg, valueOptions) {
  if (!arg.startsWith("-") || arg.startsWith("--") || arg === "-") return null;
  const match = arg.match(/^(-[A-Za-z]+)([0-9]+)$/);
  if (!match) return null;
  for (const ch of match[1].slice(1)) {
    if (valueOptions.has(ch)) return null;
  }
  return { flags: match[1], count: match[2] };
}

export function splitIntoNBytes(data, count) {
  const chunks = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const size = Math.ceil((data.length - offset) / (count - i));
    chunks.push(data.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
}

export function splitIntoLineChunks(data, count, sep) {
  const chunks = Array.from({ length: count }, () => []);
  if (data.byteLength === 0) return chunks.map(concatBytes);
  const sepByte = enc.encode(sep)[0] ?? "\n".charCodeAt(0);
  const rem = data.byteLength % count;
  const chunkSize = Math.floor(data.byteLength / count);
  let chunkNo = 1;
  let chunkEnd = chunkSize + (rem > 0 ? 1 : 0);
  let offset = 0;
  while (offset < data.byteLength && chunkNo <= count) {
    const skip = Math.min(data.byteLength - offset, Math.max(0, chunkEnd - 1 - offset));
    let end = data.byteLength;
    let foundSep = false;
    for (let i = offset + skip; i < data.byteLength; i++) {
      if (data[i] === sepByte) {
        end = i + 1;
        foundSep = true;
        break;
      }
    }
    chunks[chunkNo - 1].push(data.slice(offset, end));
    offset = end;
    while ((foundSep || chunkEnd <= offset) && chunkNo <= count) {
      chunkEnd += chunkSize + (chunkNo < rem ? 1 : 0);
      chunkNo++;
      if (chunkEnd > offset) foundSep = false;
    }
  }
  return chunks.map(concatBytes);
}

export function splitDataByteRecords(data, sep = "\n") {
  if (data.byteLength === 0) return [];
  const sepBytes = enc.encode(sep);
  if (sepBytes.byteLength === 0) return [Buffer.from(data)];
  const records = [];
  let start = 0;
  for (let i = 0; i <= data.byteLength - sepBytes.byteLength; i++) {
    let matched = true;
    for (let j = 0; j < sepBytes.byteLength; j++) {
      if (data[i + j] === sepBytes[j]) continue;
      matched = false;
      break;
    }
    if (!matched) continue;
    const end = i + sepBytes.byteLength;
    records.push(Buffer.from(data.subarray(start, end)));
    start = end;
    i = end - 1;
  }
  if (start < data.byteLength) records.push(Buffer.from(data.subarray(start)));
  return records;
}

export function splitRoundRobinRecords(records, count) {
  const buckets = Array.from({ length: count }, () => []);
  for (let i = 0; i < records.length; i++) buckets[i % count].push(records[i]);
  return buckets.map(concatBytes);
}

export function splitLineBytes(data, size, sep) {
  if (!Number.isInteger(size) || size <= 0) throw new UsageError("invalid byte count");
  const records = splitDataByteRecords(data, sep);
  const sepBytes = enc.encode(sep);
  const chunks = [];
  let current = new Uint8Array();
  for (const record of records) {
    if (record.byteLength > size) {
      if (current.byteLength) {
        chunks.push(current);
        current = new Uint8Array();
      }
      let offset = 0;
      while (offset + size <= record.byteLength) {
        chunks.push(record.slice(offset, offset + size));
        offset += size;
      }
      current = record.slice(offset);
      continue;
    }
    const finalPartialRecord = !endsWithBytes(record, sepBytes);
    if (current.byteLength && current.byteLength + record.byteLength > size) {
      chunks.push(current);
      current = new Uint8Array();
    }
    if (current.byteLength && finalPartialRecord && current.byteLength + record.byteLength >= size) {
      chunks.push(current);
      current = new Uint8Array();
    }
    current = concatBytes([current, record]);
  }
  if (current.byteLength) chunks.push(current);
  return chunks;
}

export function endsWithBytes(data, suffix) {
  if (suffix.byteLength > data.byteLength) return false;
  const offset = data.byteLength - suffix.byteLength;
  for (let i = 0; i < suffix.byteLength; i++) if (data[offset + i] !== suffix[i]) return false;
  return true;
}

export function validateSplitSeparatorValue(value) {
  const normalized = splitSeparator(value);
  if (normalized === "") throw new UsageError("empty record separator");
  if ([...normalized].length !== 1) throw new UsageError(`multi-character separator ${localeQuotedEscapedDiagnostic(value)}`);
}

export function validateSplitSeparators(args) {
  const values = [];
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (end) continue;
    if (arg === "--") {
      end = true;
    } else if (arg === "-t" || arg === "--separator") {
      const value = args[++i];
      if (value === undefined) {
        throw new UsageError(arg === "--separator" ? "option '--separator' requires an argument" : "option requires an argument -- 't'", true);
      }
      values.push(value);
    } else if (arg.startsWith("-t") && arg !== "-t") {
      values.push(arg.slice(2));
    } else if (arg.startsWith("--separator=")) {
      values.push(arg.slice("--separator=".length));
    }
  }
  const normalized = values.map(splitSeparator);
  for (const value of values) validateSplitSeparatorValue(value);
  const unique = new Set(["\n", ...normalized]);
  if (normalized.length > 1 && unique.size > 2) throw new UsageError("multiple different separators specified");
  if (normalized.length && normalized.some((value) => value !== "\n") && values.length > 1 && new Set(normalized).size > 1) {
    throw new UsageError("multiple different separators specified");
  }
}

export function suffix(index, length, { numeric = false, hex = false } = {}) {
  if (numeric) return String(index).padStart(length, "0");
  if (hex) return index.toString(16).padStart(length, "0");
  let n = index;
  let out = "";
  for (let i = 0; i < length; i++) {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

const singleCall = defineCommand("split", splitCmd, splitMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
