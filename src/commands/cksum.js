#!/usr/bin/env bun

import { forEachInputChunk, sumForFile } from "../shared/checksum.js";
import { nodeErrorMessage, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions, systemErrorMessage } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { CKSUM_LONG_OPTIONS, blake2bDigestFile, checkHashes, checksumDiagnosticName, checksumMetaOption, cksumHashAlgorithm, fileDigest, optionAppearsAfter, validateBlake2bLength, validateChecksumCheckOnlyOptions, validateCksumAlgorithmOption } from "../shared/hash.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export function cksumMetaOption(args) {
  return checksumMetaOption(args, CKSUM_LONG_OPTIONS, normalizeCksumLongOption, new Set(["algorithm", "length"]), new Set(["a", "l"]), new Set(["a", "b", "c", "l", "t", "w", "z"]));
}

export function crc32bUpdate(crc, chunk) {
  for (const byte of chunk) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return crc >>> 0;
}

export const posixCrcTable = Array.from({ length: 256 }, (_, i) => {
  let crc = i << 24;
  for (let k = 0; k < 8; k++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
  return crc >>> 0;
});

export function posixCrcUpdate(crc, chunk) {
  for (const byte of chunk) crc = ((crc << 8) ^ posixCrcTable[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc >>> 0;
}

export function posixCrcFinish(crc, length) {
  while (length > 0) {
    crc = ((crc << 8) ^ posixCrcTable[((crc >>> 24) ^ length) & 0xff]) >>> 0;
    length = Math.floor(length / 256);
  }
  return (~crc) >>> 0;
}

export async function cksumCrc(file, variant) {
  let length = 0;
  let crc = variant === "crc32b" ? 0xffffffff : 0;
  await forEachInputChunk(file, (chunk) => {
    length += chunk.length;
    crc = variant === "crc32b" ? crc32bUpdate(crc, chunk) : posixCrcUpdate(crc, chunk);
  });
  return { length, crc: variant === "crc32b" ? (crc ^ 0xffffffff) >>> 0 : posixCrcFinish(crc, length) };
}

export function uIntBytesBE(value, width) {
  const bytes = new Uint8Array(width);
  let n = Number(value) >>> 0;
  for (let i = width - 1; i >= 0; i--) {
    bytes[i] = n & 0xff;
    n >>>= 8;
  }
  return bytes;
}

export async function cksum(args) {
  args = normalizeCksumLongOptions(args);
  if (args.length === 1 && args[0] === "--help") {
    stdout("Usage: cksum [OPTION]... [FILE]...\n");
    stdout("Print or verify checksums.\nBy default use the 32 bit CRC algorithm.\n\n");
    stdout("Available algorithms:\n  sysv\n  bsd\n  crc\n  crc32b\n  md5\n  sha1\n  sha2\n  sha3\n  blake2b\n  sm3\n");
    return 0;
  }
  const { opts, operands } = parseOptions(args, { short: { a: "value", l: "value", c: false, z: false, b: false, t: false, w: false }, long: { algorithm: "value", length: "value", check: false, base64: false, raw: false, tag: false, untagged: false, zero: false, status: false, quiet: false, warn: false, strict: false, "ignore-missing": false, debug: false, binary: false, text: false, help: false, version: false } });
  if (opts.w) opts.warn = true;
  opts.warnAfterStatus = optionAppearsAfter(args, "--warn", "--status") || optionAppearsAfter(args, "-w", "--status");
  const algorithm = opts.a ?? opts.algorithm ?? "crc";
  validateCksumAlgorithmOption(algorithm);
  validateChecksumCheckOnlyOptions(opts);
  const lengthOption = opts.l ?? opts.length;
  if (lengthOption != null && String(lengthOption) !== "0" && !["blake2b", "sha2", "sha3"].includes(algorithm)) {
    throw new UsageError("--length is only supported with --algorithm blake2b, sha2, or sha3");
  }
  opts.taggedOutput = cksumTaggedOutput(args, algorithm);
  opts.binaryOutput = cksumBinaryOutput(args);
  if (opts.raw && opts.base64) throw new UsageError("--raw and --base64 are mutually exclusive");
  if (opts.raw && operands.length > 1) throw new UsageError("--raw does not support multiple files");
  if ((opts.t || opts.text) && opts.taggedOutput && algorithm !== "crc" && algorithm !== "crc32b" && algorithm !== "bsd" && algorithm !== "sysv") throw new UsageError("--text mode is only supported with --untagged", true);
  if (opts.c || opts.check) {
    if (opts.tag && opts.taggedOutput) throw new UsageError("the --tag option is meaningless when verifying checksums", true);
    const explicitAlgorithm = opts.a != null || opts.algorithm != null;
    if (explicitAlgorithm && ["bsd", "sysv", "crc", "crc32b"].includes(algorithm)) throw new UsageError("--check is not supported with --algorithm={bsd,sysv,crc,crc32b}");
    if (explicitAlgorithm && (opts.l != null || opts.length != null)) cksumHashAlgorithm(algorithm, opts);
    return checkHashes(explicitAlgorithm ? algorithm : "auto", operands.length ? operands : ["-"], { ...opts, program: "cksum" });
  }
  if (algorithm === "bsd" || algorithm === "sysv") return cksumSum(algorithm, operands.length ? operands : ["-"], opts.raw);
  if (algorithm !== "crc" && algorithm !== "crc32b") return cksumDigest(algorithm, opts, operands.length ? operands : ["-"]);
  if (opts.debug) stderr("cksum: using generic checksum implementation\n");
  const implicitStdin = operands.length === 0;
  const files = implicitStdin ? ["-"] : operands;
  let failed = false;
  for (const file of files) {
    let result;
    try {
      result = await cksumCrc(file, algorithm);
    } catch (error) {
      stderr(cksumReadError(file, error));
      failed = true;
      continue;
    }
    const { crc, length } = result;
    if (opts.raw) {
      stdout(uIntBytesBE(crc, 4));
      continue;
    }
    stdout(`${crc} ${length}${implicitStdin ? "" : ` ${file}`}\n`);
  }
  return failed ? 1 : 0;
}

export function cksumTaggedOutput(args, algorithm) {
  let mode = !["crc", "crc32b", "bsd", "sysv"].includes(algorithm);
  for (const arg of args) {
    if (arg === "--tag") mode = true;
    else if (arg === "--untagged") mode = false;
  }
  return mode;
}

export function cksumBinaryOutput(args) {
  let mode = false;
  for (const arg of args) {
    if (arg === "--binary") mode = true;
    else if (arg === "--text") mode = false;
    else if (/^-[^-]/.test(arg)) {
      for (let i = 1; i < arg.length; i++) {
        const ch = arg[i];
        if (ch === "b") mode = true;
        else if (ch === "t") mode = false;
        else if (ch === "a" || ch === "l") break;
      }
    }
  }
  return mode;
}

export async function cksumSum(algorithm, files, raw = false) {
  const sysv = algorithm === "sysv";
  let failed = false;
  for (const file of files) {
    let result;
    try {
      result = await sumForFile(file, sysv);
    } catch (error) {
      stderr(cksumReadError(file, error));
      failed = true;
      continue;
    }
    const { sum, blocks } = result;
    if (raw) {
      stdout(uIntBytesBE(sum, 2));
      continue;
    }
    if (sysv) stdout(`${sum} ${blocks}${file === "-" ? "" : ` ${file}`}\n`);
    else stdout(`${String(sum).padStart(5, "0")} ${String(blocks).padStart(5)}${file === "-" ? "" : ` ${file}`}\n`);
  }
  return failed ? 1 : 0;
}

export function cksumTag(name, opts = {}) {
  const length = opts.l ?? opts.length;
  if (name === "blake2b") return length && String(length) !== "0" ? `BLAKE2b-${length}` : "BLAKE2b";
  if (name === "sha3") return `SHA3-${length}`;
  const algorithm = cksumHashAlgorithm(name, opts);
  return algorithm.toUpperCase();
}

export async function cksumDigest(name, opts, files) {
  const lengthValue = opts.l ?? opts.length;
  const length = lengthValue === "0" ? null : lengthValue ?? (name === "sha2" || name === "sha3" ? "256" : name === "blake2b" ? "512" : null);
  if (name === "blake2b" && length != null) validateBlake2bLength("cksum", length);
  const algorithm = cksumHashAlgorithm(name, { ...opts, l: length });
  const digestBytes = length == null ? null : Number(length) / 8;
  if (length != null && (!Number.isInteger(digestBytes) || digestBytes <= 0)) throw new UsageError(`invalid digest length: ${length}`);
  const sep = opts.z || opts.zero ? "\0" : "\n";
  let failed = false;
  for (const file of files) {
    let full;
    try {
      full = name === "blake2b" ? await blake2bDigestFile(file, digestBytes ?? 64) : await fileDigest(file, algorithm);
    } catch (error) {
      stderr(cksumReadError(file, error));
      failed = true;
      continue;
    }
    const digest = digestBytes == null ? full : full.slice(0, digestBytes);
    if (opts.raw) {
      stdout(digest);
      continue;
    }
    const rendered = opts.base64 ? digest.toString("base64") : digest.toString("hex");
    const nameOut = file === "-" ? "-" : file;
    if (!opts.taggedOutput) stdout(`${rendered}${opts.binaryOutput ? " *" : "  "}${nameOut}${sep}`);
    else stdout(`${cksumTag(name, opts)} (${nameOut}) = ${rendered}${sep}`);
  }
  return failed ? 1 : 0;
}

export function cksumReadError(file, error) {
  return file === "-" ? `cksum: ${nodeErrorMessage(error)}\n` : `cksum: ${checksumDiagnosticName(file)}: ${systemErrorMessage(error)}\n`;
}

export function normalizeCksumLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, CKSUM_LONG_OPTIONS);
}

export function normalizeCksumLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, CKSUM_LONG_OPTIONS);
}

const singleCall = defineCommand("cksum", cksum, cksumMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
