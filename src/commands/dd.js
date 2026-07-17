#!/usr/bin/env bun

import { FFIType, linkSymbols, ptr } from "bun:ffi";
import { constants as fsConstants, fstatSync, lstatSync, readSync, statSync, writeSync } from "node:fs";
import { open, truncate } from "node:fs/promises";
import { SEEK_CUR, SEEK_SET, ddBufferIsZero, headTailDiagnosticName, invalidOptionMessage, libc, libcErrno, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, shellEscapeLsName, systemErrorMessage } from "../shared/common.js";
import { UsageError, fail, stderr } from "../shared/diagnostics.js";
import { outputWriteErrorMessage } from "../shared/runtime.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const BLKGETSIZE64 = 0x80081272;

export const DD_EBCDIC_TO_ASCII = Uint8Array.from([
  0x00, 0x01, 0x02, 0x03, 0x9c, 0x09, 0x86, 0x7f, 0x97, 0x8d, 0x8e, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
  0x10, 0x11, 0x12, 0x13, 0x9d, 0x85, 0x08, 0x87, 0x18, 0x19, 0x92, 0x8f, 0x1c, 0x1d, 0x1e, 0x1f,
  0x80, 0x81, 0x82, 0x83, 0x84, 0x0a, 0x17, 0x1b, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x05, 0x06, 0x07,
  0x90, 0x91, 0x16, 0x93, 0x94, 0x95, 0x96, 0x04, 0x98, 0x99, 0x9a, 0x9b, 0x14, 0x15, 0x9e, 0x1a,
  0x20, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xd5, 0x2e, 0x3c, 0x28, 0x2b, 0x7c,
  0x26, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xb0, 0xb1, 0x21, 0x24, 0x2a, 0x29, 0x3b, 0x7e,
  0x2d, 0x2f, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xcb, 0x2c, 0x25, 0x5f, 0x3e, 0x3f,
  0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xc1, 0xc2, 0x60, 0x3a, 0x23, 0x40, 0x27, 0x3d, 0x22,
  0xc3, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x70, 0x71, 0x72, 0x5e, 0xcc, 0xcd, 0xce, 0xcf, 0xd0,
  0xd1, 0xe5, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0xd2, 0xd3, 0xd4, 0x5b, 0xd6, 0xd7,
  0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf, 0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0x5d, 0xe6, 0xe7,
  0x7b, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0xe8, 0xe9, 0xea, 0xeb, 0xec, 0xed,
  0x7d, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50, 0x51, 0x52, 0xee, 0xef, 0xf0, 0xf1, 0xf2, 0xf3,
  0x5c, 0x9f, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
  0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
]);

export async function ddCmd(args) {
  args = args.filter((arg) => arg !== "--");
  for (const arg of args) if (arg.startsWith("-") || !arg.includes("=")) throw new UsageError(invalidOptionMessage(arg), true);
  const { options, parsed } = parseDdOperands(args);
  const hasBs = options.bs != null;
  const bs = parsed.bs ?? parseDdBlockSize(512);
  const ibs = hasBs ? bs : parsed.ibs ?? parseDdBlockSize(512);
  const obs = hasBs ? bs : parsed.obs ?? parseDdBlockSize(512);
  const cbs = parsed.cbs ?? 0;
  const iflags = new Set(String(options.iflag ?? "").split(",").filter(Boolean));
  const oflags = new Set(String(options.oflag ?? "").split(",").filter(Boolean));
  const conv = new Set(String(options.conv ?? "").split(",").filter(Boolean));
  const exclusiveOutput = conv.has("excl");
  const noCreateOutput = conv.has("nocreat");
  if (exclusiveOutput && noCreateOutput) return fail("dd", "cannot combine excl and nocreat");
  if (iflags.has("nolinks")) throw new UsageError(`invalid input flag: ${localeQuotedDiagnostic("nolinks")}`, true);
  if (oflags.has("nolinks")) throw new UsageError(`invalid output flag: ${localeQuotedDiagnostic("nolinks")}`, true);
  if ((iflags.has("nocache") && iflags.has("direct")) || (oflags.has("nocache") && oflags.has("direct"))) {
    return fail("dd", "cannot combine direct and nocache");
  }
  if (iflags.has("nocache") && !options.if && !fstatSync(0).isFile() && !fstatSync(0).isCharacterDevice()) {
    return fail("dd", "failed to discard cache for: 'standard input': Illegal seek");
  }
  if (iflags.has("nofollow") && options.if && lstatSync(options.if).isSymbolicLink()) throw new UsageError(`failed to open '${options.if}': Too many levels of symbolic links`);
  if (iflags.has("directory")) {
    const dirInput = options.if ? statSync(options.if) : fstatSync(0);
    if (!dirInput.isDirectory()) throw new UsageError(`failed to open '${options.if ?? "standard input"}': Not a directory`);
  }
  if (oflags.has("directory")) {
    if (options.of) throw new UsageError(`failed to open '${options.of}': Invalid argument`);
    throw new UsageError("setting flags for 'standard output': Not a directory");
  }
  const skipValue = options.skip ?? options.iseek;
  const seekValue = options.seek ?? options.oseek;
  const skipParsed = skipValue ? (options.skip != null ? parsed.skip : parsed.iseek) : null;
  const seekParsed = seekValue ? (options.seek != null ? parsed.seek : parsed.oseek) : null;
  const countParsed = options.count ? parsed.count : null;
  const skip = skipParsed ? skipParsed.value * (iflags.has("skip_bytes") || skipParsed.bytes ? 1 : ibs) : 0;
  const countValue = countParsed?.value;
  const countBytes = iflags.has("count_bytes") || Boolean(countParsed?.bytes);
  const count = countValue == null ? undefined : countBytes ? countValue : countValue * ibs;
  const seek = seekParsed ? seekParsed.value * (oflags.has("seek_bytes") || seekParsed.bytes ? 1 : obs) : 0;
  const startTime = performance.now();
  let statusRequested = false;
  let latestStats = null;
  let progressDisplayed = false;
  const requestStatus = () => { statusRequested = true; };
  process.on("SIGUSR1", requestStatus);
  const emitRequestedStatus = (stats) => {
    if (!statusRequested) return;
    statusRequested = false;
    if (progressDisplayed) {
      stderr("\n");
      progressDisplayed = false;
    }
    emitDdStatus(stats, options.status, startTime);
  };
  const progressTimer = options.status === "progress"
    ? setInterval(() => {
      if (latestStats) {
        emitDdProgress(latestStats, startTime);
        progressDisplayed = true;
      }
    }, 1000)
    : null;
  let result;
  let failure = null;
  // GNU dd reserves the active input/output block buffer when it must
  // simulate positioning on a non-seekable stream.  Apart from matching its
  // allocation failure behavior, reserving only the relevant direction is
  // important: a large obs must not penalize input skipping, nor a large ibs
  // output seeking.  Plain count=0 operations still allocate no data buffer.
  let positioningBuffer = null;
  const positioningBufferSize = skip > 0 ? Math.max(1, ibs) : seek > 0 ? Math.max(1, obs) : 0;
  const allocationLimitText = process.env.BNU_DD_ALLOCATION_LIMIT;
  const allocationLimit = /^\d+$/.test(allocationLimitText ?? "") ? Number(allocationLimitText) : null;
  if (allocationLimit != null && positioningBufferSize > allocationLimit) {
    process.off("SIGUSR1", requestStatus);
    if (progressTimer) clearInterval(progressTimer);
    return fail("dd", "memory exhausted");
  }
  try {
    if (positioningBufferSize > 0) positioningBuffer = Buffer.alloc(positioningBufferSize);
  } catch {
    process.off("SIGUSR1", requestStatus);
    if (progressTimer) clearInterval(progressTimer);
    return fail("dd", "memory exhausted");
  }
  try {
    result = await streamDdCopy({ input: options.if, output: options.of, skip, count, countValue, countBytes, seek, ibs, obs, cbs, syncBlock: hasBs ? bs : ibs, reblock: !hasBs, conv, iflags, oflags, exclusiveOutput, noCreateOutput, onStats: (stats) => {
      latestStats = stats;
      emitRequestedStatus(stats);
    } });
  } catch (error) {
    if (!options.of && error?.code === "EPIPE") return 0;
    if (!error?.ddStats) throw error;
    result = error.ddStats;
    failure = error;
  } finally {
    // Keep the positioning allocation live for the complete operation.
    void positioningBuffer?.byteLength;
    process.off("SIGUSR1", requestStatus);
    if (progressTimer) clearInterval(progressTimer);
  }
  if (failure) stderr(`dd: ${failure.ddMessage ?? outputWriteErrorMessage(failure)}\n`);
  if (result.skipPastInput && options.status !== "none") stderr(`dd: 'standard input': cannot skip to specified offset\n`);
  if (progressDisplayed) stderr("\n");
  emitDdStatus(result, options.status, startTime);
  return failure ? 1 : 0;
}

export function parseDdOperands(args) {
  const options = {};
  const parsed = {};
  const blockSizeOperands = new Set(["ibs", "obs", "bs", "cbs"]);
  const byteCountOperands = new Set(["skip", "iseek", "seek", "oseek", "count"]);
  const known = new Set(["if", "of", ...blockSizeOperands, ...byteCountOperands, "conv", "iflag", "oflag", "status"]);
  for (const arg of args) {
    const idx = arg.indexOf("=");
    const name = arg.slice(0, idx);
    const value = arg.slice(idx + 1);
    if (!known.has(name)) throw new UsageError(`unrecognized operand ${ddNumberDiagnostic(arg)}`, true);
    if (blockSizeOperands.has(name)) parsed[name] = parseDdBlockSize(value);
    else if (byteCountOperands.has(name)) parsed[name] = parseDdByteCount(value);
    else if (name === "conv") validateDdListOption(value, "conversion", DD_CONVERSIONS);
    else if (name === "iflag") validateDdListOption(value, "input flag", DD_INPUT_FLAGS);
    else if (name === "oflag") validateDdListOption(value, "output flag", DD_OUTPUT_FLAGS);
    else if (name === "status" && !["none", "noxfer", "progress"].includes(value)) throw new UsageError(`invalid status level: ${localeQuotedEscapedDiagnostic(value)}`, true);
    options[name] = value;
  }
  return { options, parsed };
}

export const DD_CONVERSIONS = new Set(["ascii", "ebcdic", "ibm", "block", "unblock", "lcase", "ucase", "sparse", "swab", "sync", "excl", "nocreat", "notrunc", "noerror", "fdatasync", "fsync"]);

export const DD_INPUT_FLAGS = new Set(["append", "direct", "directory", "dsync", "sync", "fullblock", "nonblock", "noatime", "noctty", "nofollow", "count_bytes", "skip_bytes", "nocache", "nolinks"]);

export const DD_OUTPUT_FLAGS = new Set(["append", "direct", "directory", "dsync", "sync", "nonblock", "noatime", "noctty", "nofollow", "seek_bytes", "nocache", "nolinks"]);

export let ddIoApi;

export function ddInterposedIoApi() {
  if (ddIoApi) return ddIoApi;
  const definitions = {
    fstat: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    ftruncate: { args: [FFIType.i32, FFIType.i64], returns: FFIType.i32 },
    posix_fadvise: { args: [FFIType.i32, FFIType.i64, FFIType.i64, FFIType.i32], returns: FFIType.i32 },
  };
  const symbols = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const address = libc.symbols.dlsym(0, ptr(Buffer.from(`${name}\0`)));
    symbols[name] = { ptr: address, ...definition };
  }
  ddIoApi = linkSymbols(symbols).symbols;
  return ddIoApi;
}

export function ddErrnoMessage(errno) {
  return ({
    1: "Operation not permitted",
    5: "Input/output error",
    9: "Bad file descriptor",
    22: "Invalid argument",
    29: "Illegal seek",
    95: "Operation not supported",
  })[errno] ?? `error ${errno}`;
}

export function validateDdListOption(value, label, valid) {
  if (value == null || value === "") return;
  for (const item of String(value).split(",")) {
    if (!valid.has(item)) throw new UsageError(`invalid ${label}: ${localeQuotedEscapedDiagnostic(item)}`, true);
  }
}

export function parseDdBlockSize(value) {
  const parsed = parseDdByteCount(value);
  if (parsed.value === 0) throw new UsageError(`invalid number: ${ddNumberDiagnostic(value)}`);
  return parsed.value;
}

export function emitDdStatus(result, status, startTime) {
  if (status === "none") return;
  if (status === "progress") stderr(`${result.bytes} byte copied\n`);
  stderr(`${result.inFull}+${result.inPartial} records in\n${result.outFull}+${result.outPartial} records out\n`);
  if (result.truncated) stderr(`${result.truncated} truncated record${result.truncated === 1 ? "" : "s"}\n`);
  if (status !== "noxfer") stderr(formatDdTransferStats(result.bytes, (performance.now() - startTime) / 1000));
}

export function emitDdProgress(result, startTime) {
  const seconds = (performance.now() - startTime) / 1000;
  stderr(`\r${formatDdTransferStats(result.bytes, seconds).trimEnd()}`);
}

export function formatDdTransferStats(bytes, seconds) {
  const unit = bytes === 1 ? "byte" : "bytes";
  if (bytes < 1000) return `${bytes} ${unit} copied\n`;
  const elapsed = Math.max(seconds, 0.000001);
  const rate = bytes / elapsed;
  return `${bytes} ${unit} (${formatDecimalBytes(bytes)}, ${formatBinaryBytes(bytes)}) copied, ${formatDdSeconds(elapsed)} s, ${formatDecimalBytes(rate)}/s\n`;
}

export function formatDecimalBytes(bytes) {
  const units = ["B", "kB", "MB", "GB", "TB"];
  return formatScaledBytes(bytes, 1000, units);
}

export function formatBinaryBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  return formatScaledBytes(bytes, 1024, units);
}

export function formatScaledBytes(value, base, units) {
  let scaled = value;
  let unit = units[0];
  for (let i = 1; i < units.length && Math.abs(scaled) >= base; i++) {
    scaled /= base;
    unit = units[i];
  }
  const digits = scaled >= 100 || unit === "B" ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")} ${unit}`;
}

export function formatDdSeconds(seconds) {
  if (seconds >= 1) return seconds.toFixed(2).replace(/\.?0+$/, "");
  return seconds.toPrecision(3);
}

export function parseDdByteCount(value) {
  const text = String(value);
  if (!text) throw new UsageError(`invalid number: ${ddNumberDiagnostic(value)}`);
  if (/^0[xX]/.test(text)) stderr(`dd: warning: ${localeQuotedDiagnostic("0x")} is a zero multiplier; use ${localeQuotedDiagnostic("00x")} if that is intended\n`);
  let total = 1n;
  let sawByteSuffix = false;
  for (const part of text.split(/[xX]/)) {
    if (!part) throw new UsageError(`invalid number: ${ddNumberDiagnostic(value)}`);
    const match = part.match(/^(\d+)([A-Za-z]*)$/);
    if (!match) throw new UsageError(`invalid number: ${ddNumberDiagnostic(value)}`);
    const scale = {
      "": 1n, c: 1n, C: 1n, w: 2n, W: 2n, b: 512n, B: 1n,
      k: 1024n, K: 1024n, KiB: 1024n, kiB: 1024n,
      m: 1024n ** 2n, M: 1024n ** 2n, MiB: 1024n ** 2n, miB: 1024n ** 2n,
      g: 1024n ** 3n, G: 1024n ** 3n, GiB: 1024n ** 3n, giB: 1024n ** 3n,
      t: 1024n ** 4n, T: 1024n ** 4n, TiB: 1024n ** 4n, tiB: 1024n ** 4n,
      P: 1024n ** 5n, PiB: 1024n ** 5n,
      E: 1024n ** 6n, EiB: 1024n ** 6n,
      Z: 1024n ** 7n, ZiB: 1024n ** 7n,
      Y: 1024n ** 8n, YiB: 1024n ** 8n,
      R: 1024n ** 9n, RiB: 1024n ** 9n,
      Q: 1024n ** 10n, QiB: 1024n ** 10n,
      KB: 1000n, kB: 1000n, MB: 1000n ** 2n, mB: 1000n ** 2n,
      GB: 1000n ** 3n, gB: 1000n ** 3n, TB: 1000n ** 4n, tB: 1000n ** 4n,
      PB: 1000n ** 5n, EB: 1000n ** 6n, ZB: 1000n ** 7n, YB: 1000n ** 8n,
      RB: 1000n ** 9n, QB: 1000n ** 10n,
    }[match[2]];
    if (!scale) throw new UsageError(`invalid number: ${ddNumberDiagnostic(value)}`);
    total *= BigInt(match[1]) * scale;
    if (total > 9223372036854775807n) throw new UsageError(`invalid number: ${ddNumberDiagnostic(value)}: Value too large for defined data type`);
    if (match[2] === "B") sawByteSuffix = true;
  }
  return { value: total > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(total), bytes: sawByteSuffix };
}

export function ddNumberDiagnostic(value) {
  return shellEscapeLsName(String(value), true);
}

export async function streamDdCopy({ input, output, skip, count, countValue, countBytes, seek, ibs, obs, cbs, syncBlock, reblock, conv, iflags, oflags, exclusiveOutput = false, noCreateOutput = false, onStats = null }) {
  const inputHandle = input ? await open(input, "r").catch((error) => {
    throw new UsageError(`failed to open '${input}': ${systemErrorMessage(error)}`);
  }) : null;
  let outputHandle = null;
  const sparse = conv.has("sparse");
  const append = oflags.has("append");
  const notrunc = conv.has("notrunc");
  let outputPosition = output && (seek || sparse) && !append ? seek : null;
  let bytes = 0;
  let inFull = 0;
  let inPartial = 0;
  let outFull = 0;
  let outPartial = 0;
  let truncated = 0;
  let skipPastInput = false;
  let inputBytesRead = 0;
  let reachedInputEof = false;
  const outputState = reblock ? { obs, buffer: Buffer.alloc(0) } : null;
  const blockState = conv.has("block") ? { cbs: cbs || ibs, record: [], truncated: 0, truncating: false } : null;
  const unblockState = (conv.has("unblock") || conv.has("ascii")) ? { cbs: cbs || ibs, record: [] } : null;
  const swabState = conv.has("swab") ? { pending: null } : null;
  const currentStats = () => ({ bytes, inFull, inPartial, outFull, outPartial, truncated, skipPastInput });
  const attachDdStats = (error, countPartial = false, message = null) => {
    if (countPartial) outPartial++;
    error.ddStats = currentStats();
    if (message) error.ddMessage = message;
    return error;
  };
  const writeChunk = async (chunk) => {
    if (!chunk.length) return;
    try {
      if (outputHandle) {
        const result = await writeDdOutput(outputHandle, chunk, outputPosition, obs, outputState, sparse);
        outFull += result.full;
        outPartial += result.partial;
        if (outputPosition != null) outputPosition += result.bytesWritten;
      } else {
        const result = writeDdOutputSync(1, chunk, obs, outputState, sparse && append);
        outFull += result.full;
        outPartial += result.partial;
      }
      bytes += chunk.length;
    } catch (error) {
      throw attachDdStats(error, Boolean(chunk.length));
    }
  };
  try {
    let skipped;
    try {
      skipped = inputHandle ? await discardFromHandle(inputHandle, skip) : discardStdinBytes(skip);
    } catch (error) {
      const message = error?.ddSeek
        ? `${headTailDiagnosticName(input ?? "standard input")}: cannot skip: ${error.ddSystemMessage}`
        : ddInputReadErrorMessage(input, error);
      throw attachDdStats(error, false, message);
    }
    skipPastInput = skipped < skip;
    if (output) {
      if (oflags.has("nofollow")) {
        try {
          if (lstatSync(output).isSymbolicLink()) throw new UsageError(`failed to open '${output}': Too many levels of symbolic links`);
        } catch (error) {
          if (error instanceof UsageError) throw error;
          if (error?.code !== "ENOENT") throw new UsageError(`failed to open '${output}': ${systemErrorMessage(error)}`);
        }
      }
      if (noCreateOutput) {
        try {
          statSync(output);
        } catch (error) {
          throw new UsageError(`failed to open '${output}': ${systemErrorMessage(error)}`);
        }
      }
      if (exclusiveOutput) {
        try {
          statSync(output);
          throw new UsageError(`failed to open '${output}': File exists`);
        } catch (error) {
          if (error instanceof UsageError) throw error;
          if (error?.code !== "ENOENT") throw new UsageError(`failed to open '${output}': ${systemErrorMessage(error)}`);
        }
      }
      const flag = ddOutputOpenFlag({ append, notrunc, seek, oflags });
      outputHandle = await open(output, flag).catch((error) => {
        if (error?.code === "ENOENT" && seek) return open(output, ddOutputOpenFlag({ append: false, notrunc: false, seek: false, oflags, createForSeek: true }));
        throw new UsageError(`failed to open '${output}': ${systemErrorMessage(error)}`);
      });
      outputPosition = append || (!seek && !sparse) ? null : seek;
      if (seek && !append && !notrunc) {
        const io = ddInterposedIoApi();
        if (io.ftruncate(outputHandle.fd, seek) !== 0) {
          const truncateErrno = libcErrno();
          const statBuffer = Buffer.alloc(256);
          if (io.fstat(outputHandle.fd, ptr(statBuffer)) !== 0) {
            throw new UsageError(`cannot fstat '${output}': ${ddErrnoMessage(libcErrno())}`);
          }
          const outputStats = fstatSync(outputHandle.fd);
          if (outputStats.isFile() || outputStats.isDirectory()) {
            throw new UsageError(`failed to truncate to ${seek} bytes in output file '${output}': ${ddErrnoMessage(truncateErrno)}`);
          }
        }
      }
    } else if (seek) {
      try {
        ddSeekFd(1, seek);
      } catch (error) {
        throw attachDdStats(error, false, `'standard output': cannot seek: ${error.ddSystemMessage ?? systemErrorMessage(error)}`);
      }
    }
    let remaining = count;
    let remainingRecords = countBytes ? undefined : countValue;
    const maxChunk = Math.max(1, Math.min(1024 * 1024, count ?? ibs));
    while ((remaining == null || remaining > 0) && (remainingRecords == null || remainingRecords > 0)) {
      const wanted = countBytes
        ? Math.min(maxChunk, remaining)
        : Math.min(Math.max(1, ibs), remaining ?? ibs);
      let chunk;
      try {
        chunk = iflags.has("fullblock")
          ? inputHandle ? await readDdFullChunkFromHandle(inputHandle, wanted) : readDdFullChunkFromStdin(wanted)
          : inputHandle ? await readDdChunkFromHandle(inputHandle, wanted) : readDdChunkFromStdin(wanted);
      } catch (error) {
        throw attachDdStats(error, false, ddInputReadErrorMessage(input, error));
      }
      if (chunk.length === 0) {
        reachedInputEof = true;
        break;
      }
      inputBytesRead += chunk.length;
      if (chunk.length < wanted) reachedInputEof = true;
      if (chunk.length === ibs) inFull++;
      else inPartial++;
      if (remaining != null) remaining -= chunk.length;
      if (remainingRecords != null) remainingRecords--;
      if (conv.has("sync") && chunk.length % syncBlock !== 0) {
        const padded = Buffer.alloc(Math.ceil(chunk.length / syncBlock) * syncBlock);
        Buffer.from(chunk).copy(padded);
        chunk = padded;
      }
      if (conv.has("ascii")) chunk = ddTranslateBytes(chunk, DD_EBCDIC_TO_ASCII);
      if (conv.has("lcase") || conv.has("ucase")) chunk = ddConvertCase(chunk, conv.has("ucase"));
      if (swabState) chunk = ddSwabChunk(chunk, swabState);
      if (blockState) chunk = ddBlockConvertChunk(chunk, blockState);
      if (unblockState) chunk = ddUnblockConvertChunk(chunk, unblockState);
      await writeChunk(chunk);
      onStats?.(currentStats());
    }
    if (blockState) {
      const chunk = ddBlockFlush(blockState);
      await writeChunk(chunk);
      truncated = blockState.truncated;
    }
    if (unblockState) {
      const chunk = ddUnblockFlush(unblockState);
      await writeChunk(chunk);
    }
    if (swabState?.pending != null) {
      const chunk = Buffer.from([swabState.pending]);
      await writeChunk(chunk);
    }
    const io = iflags.has("nocache") || oflags.has("nocache") || oflags.has("direct") ? ddInterposedIoApi() : null;
    if (inputHandle && iflags.has("nocache")) {
      // A zero length means "through EOF".  Do that only when the copy
      // actually reached EOF (or count=0 explicitly requested a whole-file
      // cache drop); a count-limited copy must not evict the untouched tail.
      const adviceLength = reachedInputEof || countValue === 0 ? 0 : inputBytesRead;
      const adviceError = io.posix_fadvise(inputHandle.fd, skip, adviceLength, 4);
      if (adviceError !== 0) throw attachDdStats(new Error(), false, `failed to discard cache for: ${input}: ${ddErrnoMessage(adviceError)}`);
    }
    if (outputHandle && (oflags.has("nocache") || oflags.has("direct"))) {
      const adviceError = io.posix_fadvise(outputHandle.fd, 0, 0, 4);
      if (adviceError !== 0) throw attachDdStats(new Error(), false, `failed to discard cache for: ${output}: ${ddErrnoMessage(adviceError)}`);
    }
  } finally {
    if (outputState?.buffer.length) {
      try {
        if (outputHandle) {
          const result = await writeDdOutput(outputHandle, outputState.buffer, outputPosition, obs, null, sparse);
          if (outputPosition != null) outputPosition += result.bytesWritten;
        } else {
          writeDdOutputSync(1, outputState.buffer, obs, null, sparse && append);
        }
        outPartial++;
        outputState.buffer = Buffer.alloc(0);
      } catch (error) {
        throw attachDdStats(error, true);
      }
    }
    if (outputHandle && (conv.has("fdatasync") || conv.has("fsync"))) {
      try {
        if (conv.has("fdatasync")) await outputHandle.datasync();
        else await outputHandle.sync();
      } catch (error) {
        const statsError = attachDdStats(error, false, `fsync failed for '${output}': ${systemErrorMessage(error)}`);
        if (inputHandle) await inputHandle.close().catch(() => {});
        await outputHandle.close().catch(() => {});
        throw statsError;
      }
    }
    if (inputHandle) await inputHandle.close();
    if (outputHandle) await outputHandle.close();
  }
  if (output && sparse && !append && !notrunc) await truncate(output, outputPosition ?? seek);
  return { bytes, inFull, inPartial, outFull, outPartial, truncated, skipPastInput };
}

export function ddOutputOpenFlag({ append, notrunc, seek, oflags, createForSeek = false }) {
  const synchronous = oflags.has("sync") || oflags.has("dsync");
  if (!synchronous) return append && notrunc ? "a" : !seek && !notrunc ? "w" : "r+";
  let flags;
  if (append && notrunc) flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND;
  else if (!seek && !notrunc) flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC;
  else flags = fsConstants.O_RDWR;
  if (createForSeek) flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC;
  return flags | (oflags.has("sync") ? fsConstants.O_SYNC : fsConstants.O_DSYNC);
}

export function ddInputReadErrorMessage(input, error) {
  return `error reading '${input ?? "standard input"}': ${systemErrorMessage(error)}`;
}

export function ddTranslateBytes(chunk, table) {
  const out = Buffer.allocUnsafe(chunk.length);
  for (let i = 0; i < chunk.length; i++) out[i] = table[chunk[i]];
  return out;
}

export async function writeDdOutput(handle, chunk, position, obs, reblockState, sparse = false) {
  if (!reblockState) {
    if (sparse && position != null && ddBufferIsZero(chunk)) {
      return { bytesWritten: chunk.length, full: chunk.length === obs ? 1 : 0, partial: chunk.length === obs ? 0 : chunk.length ? 1 : 0 };
    }
    const result = await handle.write(chunk, 0, chunk.length, position);
    return { bytesWritten: result.bytesWritten, full: chunk.length === obs ? 1 : 0, partial: chunk.length === obs ? 0 : chunk.length ? 1 : 0 };
  }
  let bytesWritten = 0;
  let full = 0;
  let offset = 0;
  let pos = position;
  let data = reblockState.buffer.length ? Buffer.concat([reblockState.buffer, chunk]) : chunk;
  while (offset < data.length) {
    const part = data.subarray(offset, offset + obs);
    if (part.length < obs) break;
    if (sparse && pos != null && ddBufferIsZero(part)) {
      bytesWritten += part.length;
      pos += part.length;
    } else {
      const result = await handle.write(part, 0, part.length, pos);
      bytesWritten += result.bytesWritten;
      if (pos != null) pos += result.bytesWritten;
    }
    full++;
    offset += part.length;
  }
  reblockState.buffer = data.subarray(offset);
  return { bytesWritten, full, partial: 0 };
}

export function writeDdOutputSync(fd, chunk, obs, reblockState, skipSparse = false) {
  if (!reblockState) {
    if (!(skipSparse && ddBufferIsZero(chunk))) writeSync(fd, chunk);
    return { full: chunk.length === obs ? 1 : 0, partial: chunk.length === obs ? 0 : chunk.length ? 1 : 0 };
  }
  let full = 0;
  let data = reblockState.buffer.length ? Buffer.concat([reblockState.buffer, chunk]) : chunk;
  let offset = 0;
  while (offset < data.length) {
    const part = data.subarray(offset, offset + obs);
    if (part.length < obs) break;
    if (!(skipSparse && ddBufferIsZero(part))) writeSync(fd, part);
    full++;
    offset += part.length;
  }
  reblockState.buffer = data.subarray(offset);
  return { full, partial: 0 };
}

export function ddConvertCase(chunk, upper) {
  const out = Buffer.from(chunk);
  for (let i = 0; i < out.length; i++) {
    const byte = out[i];
    if (upper && byte >= 0x61 && byte <= 0x7a) out[i] = byte - 0x20;
    else if (upper && byte === 0xe9) out[i] = 0xc9;
    else if (!upper && byte >= 0x41 && byte <= 0x5a) out[i] = byte + 0x20;
    else if (!upper && byte === 0xc9) out[i] = 0xe9;
  }
  return out;
}

export function ddSwabChunk(chunk, state) {
  const out = [];
  let i = 0;
  if (state.pending != null) {
    if (chunk.length === 0) return Buffer.alloc(0);
    out.push(chunk[0], state.pending);
    state.pending = null;
    i = 1;
  }
  for (; i + 1 < chunk.length; i += 2) out.push(chunk[i + 1], chunk[i]);
  if (i < chunk.length) state.pending = chunk[i];
  return Buffer.from(out);
}

export function ddBlockConvertChunk(chunk, state) {
  const out = [];
  for (const byte of chunk) {
    if (byte === 0x0a) {
      ddBlockEmitRecord(state, out);
      continue;
    }
    const mapped = byte === 0 ? 0x20 : byte;
    if (state.record.length < state.cbs) {
      state.record.push(mapped);
    } else if (!state.truncating) {
      state.truncated++;
      state.truncating = true;
    }
  }
  return Buffer.from(out);
}

export function ddBlockFlush(state) {
  if (!state.record.length && !state.truncating) return Buffer.alloc(0);
  const out = [];
  ddBlockEmitRecord(state, out);
  return Buffer.from(out);
}

export function ddBlockEmitRecord(state, out) {
  for (let i = 0; i < state.cbs; i++) out.push(state.record[i] ?? 0x20);
  state.record = [];
  state.truncating = false;
}

export function ddUnblockConvertChunk(chunk, state) {
  const out = [];
  for (const byte of chunk) {
    state.record.push(byte);
    if (state.record.length === state.cbs) ddUnblockEmitRecord(state, out);
  }
  return Buffer.from(out);
}

export function ddUnblockFlush(state) {
  if (!state.record.length) return Buffer.alloc(0);
  const out = [];
  ddUnblockEmitRecord(state, out);
  return Buffer.from(out);
}

export function ddUnblockEmitRecord(state, out) {
  let end = state.record.length;
  while (end > 0 && (state.record[end - 1] === 0x20 || state.record[end - 1] === 0x00)) end--;
  for (let i = 0; i < end; i++) out.push(state.record[i]);
  out.push(0x0a);
  state.record = [];
}

export async function readDdChunkFromHandle(handle, size) {
  const buffer = Buffer.allocUnsafe(size);
  const { bytesRead } = await handle.read(buffer, 0, size, null);
  return buffer.subarray(0, bytesRead);
}

export function readDdChunkFromStdin(size) {
  const buffer = Buffer.allocUnsafe(size);
  const bytesRead = readSync(0, buffer, 0, size, null);
  return buffer.subarray(0, bytesRead);
}

export async function readDdFullChunkFromHandle(handle, size) {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export function readDdFullChunkFromStdin(size) {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(0, buffer, offset, size - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export function discardStdinBytes(bytes) {
  const sought = ddTrySeekFd(0, bytes);
  if (sought != null) return sought;
  const buffer = Buffer.allocUnsafe(Math.min(8192, Math.max(1, bytes)));
  let remaining = bytes;
  while (remaining > 0) {
    const n = readSync(0, buffer, 0, Math.min(buffer.length, remaining), null);
    if (n === 0) break;
    remaining -= n;
  }
  return bytes - remaining;
}

export async function discardFromHandle(handle, bytes) {
  const sought = ddTrySeekFd(handle.fd, bytes);
  if (sought != null) return sought;
  const buffer = Buffer.alloc(Math.min(8192, Math.max(1, bytes)));
  let remaining = bytes;
  while (remaining > 0) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
    if (bytesRead === 0) break;
    remaining -= bytesRead;
  }
  return bytes - remaining;
}

export function ddTrySeekFd(fd, bytes) {
  if (bytes === 0) return 0;
  const current = libc.symbols.lseek(fd, 0n, SEEK_CUR);
  if (current < 0n) {
    if (libcErrno() === 29) return null;
    throw ddSeekError(libcErrno());
  }
  const target = current + BigInt(bytes);
  ddValidateDeviceSeek(fd, target);
  try {
    const info = fstatSync(fd);
    if (info.isFile() && target > BigInt(info.size)) {
      const available = BigInt(info.size) > current ? BigInt(info.size) - current : 0n;
      if (libc.symbols.lseek(fd, BigInt(info.size), SEEK_SET) < 0n) throw ddSeekError(libcErrno());
      return Number(available);
    }
  } catch (error) {
    if (error?.ddSeek) throw error;
  }
  if (libc.symbols.lseek(fd, BigInt(bytes), SEEK_CUR) < 0n) throw ddSeekError(libcErrno());
  return bytes;
}

export function ddSeekFd(fd, offset) {
  const target = BigInt(offset);
  ddValidateDeviceSeek(fd, target);
  if (libc.symbols.lseek(fd, target, SEEK_SET) < 0n) throw ddSeekError(libcErrno());
}

export function ddValidateDeviceSeek(fd, target) {
  let block = false;
  try {
    block = fstatSync(fd).isBlockDevice();
  } catch {}
  if (!block) return;
  const size = Buffer.alloc(8);
  if (libc.symbols.ioctl(fd, BLKGETSIZE64, ptr(size)) !== 0 || target > size.readBigUInt64LE(0)) throw ddSeekError(22);
}

export function ddSeekError(errno) {
  const error = new Error(ddErrnoMessage(errno));
  error.ddSeek = true;
  error.ddSystemMessage = ddErrnoMessage(errno);
  return error;
}

const singleCall = defineCommand("dd", ddCmd, (args) => { for (const arg of args) { if (arg === "--") return null; if (arg === "--help" || arg === "--version") return arg; } return null; });
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
