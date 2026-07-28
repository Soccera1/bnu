import { createHash } from "node:crypto";
import { fstatSync } from "node:fs";
import { forEachInputChunk } from "./checksum.js";
import { createFdRecordReader, decodeSurrogateEscapedBytes, hasSurrogateEscapedBytes, isWriteError, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, nodeErrorMessage, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions, pathDisplayName, readAll, systemErrorMessage, textInputDiagnosticName } from "./common.js";
import { UsageError, VERSION, encodeSurrogateEscapedString, stderr, stdout } from "./diagnostics.js";

export const CKSUM_LONG_OPTIONS = ["algorithm", "base64", "check", "length", "raw", "tag", "untagged", "zero", "ignore-missing", "quiet", "status", "strict", "warn", "debug", "binary", "text", "help", "version"];

export const HASH_LONG_OPTIONS = ["check", "binary", "text", "tag", "length", "status", "quiet", "warn", "strict", "ignore-missing", "zero", "help", "version"];

export function hashMetaOption(program, args) {
  const supportsLength = program === "b2sum";
  const longOptions = supportsLength ? HASH_LONG_OPTIONS : HASH_LONG_OPTIONS.filter((option) => option !== "length");
  return checksumMetaOption(args, longOptions, normalizeHashLongOption, supportsLength ? new Set(["length"]) : new Set(), supportsLength ? new Set(["l"]) : new Set(), supportsLength ? new Set(["b", "c", "l", "t", "w", "z"]) : new Set(["b", "c", "t", "w", "z"]));
}

export function checksumMetaOption(args, longOptions, normalizeLongOption, longValueOptions, shortValueOptions, shortKnownOptions) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!longOptions.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (longOptions === CKSUM_LONG_OPTIONS && name === "algorithm" && inlineValue != null) validateCksumAlgorithmOption(inlineValue);
      const value = inlineValue ?? (longValueOptions.has(name) ? args[i + 1] : undefined);
      if (name === "length" && value !== undefined) validateShaDigestLengthSyntax(value);
      if (inlineValue == null && longValueOptions.has(name)) i++;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        const value = inlineValue === "" ? args[i + 1] : inlineValue;
        validateChecksumMetaShortValue(ch, value, longOptions);
        if (inlineValue === "") i++;
        break;
      }
    }
  }
  return null;
}

export function validateChecksumMetaShortValue(ch, value, longOptions) {
  if (value === undefined) return;
  if (ch === "a" && longOptions === CKSUM_LONG_OPTIONS) validateCksumAlgorithmOption(value);
  if (ch === "l") validateShaDigestLengthSyntax(value);
}

export async function fileDigest(file, algorithm) {
  if (algorithm === "sm3") return sm3DigestFile(file);
  const hash = createHash(algorithm);
  await forEachInputChunk(file, (chunk) => hash.update(chunk));
  return hash.digest();
}

export async function sm3DigestFile(file) {
  const state = {
    h: [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e],
    buffer: Buffer.alloc(0),
    length: 0n,
  };
  await forEachInputChunk(file, (chunk) => sm3Update(state, chunk));
  return sm3Final(state);
}

export function sm3Update(state, chunk) {
  state.length += BigInt(chunk.length);
  let data = Buffer.concat([state.buffer, chunk]);
  let offset = 0;
  while (offset + 64 <= data.length) {
    sm3Compress(state.h, data.subarray(offset, offset + 64));
    offset += 64;
  }
  state.buffer = data.subarray(offset);
}

export function sm3Final(state) {
  const bitLength = state.length * 8n;
  const padLength = Number((56n - ((state.length + 1n) % 64n) + 64n) % 64n);
  const padding = Buffer.alloc(1 + padLength + 8);
  padding[0] = 0x80;
  padding.writeBigUInt64BE(bitLength, 1 + padLength);
  sm3Update(state, padding);
  const out = Buffer.alloc(32);
  state.h.forEach((word, index) => out.writeUInt32BE(word >>> 0, index * 4));
  return out;
}

export function sm3Compress(h, block) {
  const w = new Array(68);
  const w1 = new Array(64);
  for (let i = 0; i < 16; i++) w[i] = block.readUInt32BE(i * 4);
  for (let j = 16; j < 68; j++) w[j] = (sm3P1((w[j - 16] ^ w[j - 9] ^ rotl32(w[j - 3], 15)) >>> 0) ^ rotl32(w[j - 13], 7) ^ w[j - 6]) >>> 0;
  for (let j = 0; j < 64; j++) w1[j] = (w[j] ^ w[j + 4]) >>> 0;
  let [a, b, c, d, e, f, g, hh] = h;
  for (let j = 0; j < 64; j++) {
    const t = j < 16 ? 0x79cc4519 : 0x7a879d8a;
    const ss1 = rotl32((rotl32(a, 12) + e + rotl32(t, j % 32)) >>> 0, 7);
    const ss2 = (ss1 ^ rotl32(a, 12)) >>> 0;
    const tt1 = (sm3FF(a, b, c, j) + d + ss2 + w1[j]) >>> 0;
    const tt2 = (sm3GG(e, f, g, j) + hh + ss1 + w[j]) >>> 0;
    d = c;
    c = rotl32(b, 9);
    b = a;
    a = tt1;
    hh = g;
    g = rotl32(f, 19);
    f = e;
    e = sm3P0(tt2);
  }
  for (let i = 0, values = [a, b, c, d, e, f, g, hh]; i < 8; i++) h[i] = (h[i] ^ values[i]) >>> 0;
}

export function rotl32(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

export function sm3P0(x) {
  return (x ^ rotl32(x, 9) ^ rotl32(x, 17)) >>> 0;
}

export function sm3P1(x) {
  return (x ^ rotl32(x, 15) ^ rotl32(x, 23)) >>> 0;
}

export function sm3FF(x, y, z, j) {
  return j < 16 ? (x ^ y ^ z) >>> 0 : ((x & y) | (x & z) | (y & z)) >>> 0;
}

export function sm3GG(x, y, z, j) {
  return j < 16 ? (x ^ y ^ z) >>> 0 : ((x & y) | (~x & z)) >>> 0;
}

export const BLAKE2B_IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];

export const BLAKE2B_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

export const MASK64 = 0xffffffffffffffffn;

export async function blake2bDigestFile(file, outBytes = 64) {
  const state = {
    h: [...BLAKE2B_IV],
    buffer: Buffer.alloc(0),
    length: 0n,
    outBytes,
  };
  state.h[0] ^= 0x01010000n ^ BigInt(outBytes);
  await forEachInputChunk(file, (chunk) => blake2bUpdate(state, chunk));
  return blake2bFinal(state);
}

export function blake2bUpdate(state, chunk) {
  let data = Buffer.concat([state.buffer, chunk]);
  let offset = 0;
  while (offset + 128 < data.length) {
    state.length += 128n;
    blake2bCompress(state.h, data.subarray(offset, offset + 128), state.length, false);
    offset += 128;
  }
  state.buffer = data.subarray(offset);
}

export function blake2bFinal(state) {
  state.length += BigInt(state.buffer.length);
  const block = Buffer.alloc(128);
  state.buffer.copy(block);
  blake2bCompress(state.h, block, state.length, true);
  const out = Buffer.alloc(64);
  state.h.forEach((word, index) => out.writeBigUInt64LE(word, index * 8));
  return out.subarray(0, state.outBytes);
}

export function blake2bCompress(h, block, count, last) {
  const m = Array.from({ length: 16 }, (_, i) => block.readBigUInt64LE(i * 8));
  const v = [...h, ...BLAKE2B_IV];
  v[12] ^= count & MASK64;
  v[13] ^= count >> 64n;
  if (last) v[14] ^= MASK64;
  const mix = (a, b, c, d, x, y) => {
    v[a] = (v[a] + v[b] + x) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 63n);
  };
  for (const s of BLAKE2B_SIGMA) {
    mix(0, 4, 8, 12, m[s[0]], m[s[1]]);
    mix(1, 5, 9, 13, m[s[2]], m[s[3]]);
    mix(2, 6, 10, 14, m[s[4]], m[s[5]]);
    mix(3, 7, 11, 15, m[s[6]], m[s[7]]);
    mix(0, 5, 10, 15, m[s[8]], m[s[9]]);
    mix(1, 6, 11, 12, m[s[10]], m[s[11]]);
    mix(2, 7, 8, 13, m[s[12]], m[s[13]]);
    mix(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] = (h[i] ^ v[i] ^ v[i + 8]) & MASK64;
}

export function rotr64(value, bits) {
  return ((value >> bits) | (value << (64n - bits))) & MASK64;
}

export const CKSUM_ALGORITHMS = ["bsd", "sysv", "crc", "crc32b", "md5", "sha1", "sha224", "sha256", "sha384", "sha512", "sha2", "sha3", "blake2b", "sm3"];

export function validateCksumAlgorithmOption(value) {
  if (CKSUM_ALGORITHMS.includes(value)) return;
  throw new UsageError(`invalid argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic("--algorithm")}\nValid arguments are:\n${CKSUM_ALGORITHMS.map((algorithm) => `  - ${localeQuotedDiagnostic(algorithm)}`).join("\n")}`, true);
}

export function optionAppearsAfter(args, later, earlier) {
  const laterIndex = args.lastIndexOf(later);
  const earlierIndex = args.lastIndexOf(earlier);
  return laterIndex !== -1 && earlierIndex !== -1 && laterIndex > earlierIndex;
}

export function cksumHashAlgorithm(name, opts = {}) {
  const length = opts.l ?? opts.length;
  if (name === "md5") return "md5";
  if (name === "sha1") return "sha1";
  if (["sha224", "sha256", "sha384", "sha512"].includes(name)) return name;
  if (name === "sha2") {
    validateShaDigestLengthSyntax(length);
    if (!["224", "256", "384", "512"].includes(String(length))) throw invalidDigestLengthError("cksum", "SHA2", length, "digest length for 'SHA2' must be 224, 256, 384, or 512");
    return `sha${length}`;
  }
  if (name === "sha3") {
    validateShaDigestLengthSyntax(length);
    if (!["224", "256", "384", "512"].includes(String(length))) throw invalidDigestLengthError("cksum", "SHA3", length, "digest length for 'SHA3' must be 224, 256, 384, or 512");
    return `sha3-${length}`;
  }
  if (name === "blake2b") {
    if (length != null) validateBlake2bLength(opts.program ?? "cksum", length);
    return "blake2b512";
  }
  if (name === "sm3") return "sm3";
  throw new UsageError(`invalid checksum algorithm: ${name}`);
}

export function validateShaDigestLengthSyntax(length) {
  const text = String(length);
  if (/^\d+$/.test(text)) return;
  if (/^-\d+$/.test(text)) throw new UsageError(`invalid length: ${localeQuotedEscapedDiagnostic(length)}: Value too large for defined data type`, false);
  throw new UsageError(`invalid length: ${localeQuotedEscapedDiagnostic(length)}`, false);
}

export function cksumAlgorithmForDigest(name, digestBytes, opts = {}) {
  const length = opts.l ?? opts.length;
  if (name === "sha2") {
    const bits = length ?? String(digestBytes * 8);
    return cksumHashAlgorithm(name, { ...opts, l: bits });
  }
  if (name === "sha3") {
    const bits = length ?? String(digestBytes * 8);
    return cksumHashAlgorithm(name, { ...opts, l: bits });
  }
  return cksumHashAlgorithm(name, opts);
}

export function checksumDiagnosticName(file) {
  return textInputDiagnosticName(file);
}

export function hashCommand(algorithm) {
  return async (args) => {
    if (algorithm !== "blake2b512") rejectHashLengthOption(args);
    args = normalizeHashLongOptions(args);
    if (args.length === 1 && args[0] === "--version") {
      stdout(`${VERSION}\n`);
      return 0;
    }
    const { opts, operands } = parseOptions(args, { short: { c: false, b: false, t: false, l: "value", w: false, z: false }, long: { check: false, binary: false, text: false, tag: false, length: "value", status: false, quiet: false, warn: false, strict: false, "ignore-missing": false, zero: false, help: false, version: false } });
    if (opts.w) opts.warn = true;
    opts.warnAfterStatus = optionAppearsAfter(args, "--warn", "--status") || optionAppearsAfter(args, "-w", "--status");
    const digestBytes = hashDigestBytes(algorithm, opts);
    validateChecksumCheckOnlyOptions(opts);
    if (opts.c || opts.check) {
      if (opts.tag) throw new UsageError("the --tag option is meaningless when verifying checksums");
      return checkHashes(algorithm, operands.length ? operands : ["-"], { ...opts, program: hashProgramName(algorithm) });
    }
    if (opts.tag && (opts.t || opts.text)) throw new UsageError("--tag does not support --text mode");
    const files = operands.length ? operands : ["-"];
    let failed = false;
    for (const file of files) {
      let digest;
      try {
        digest = (digestBytes ? await blake2bDigestFile(file, digestBytes) : await fileDigest(file, algorithm)).toString("hex");
      } catch (error) {
        const program = hashProgramName(algorithm);
        stderr(file === "-" ? `${program}: ${nodeErrorMessage(error)}\n` : `${program}: ${checksumDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
        failed = true;
        continue;
      }
      const sep = opts.z || opts.zero ? "\0" : "\n";
      const displayFile = file === "-" ? "-" : file;
      const renderedFile = opts.z || opts.zero ? displayFile : escapeChecksumFilename(displayFile);
      const escapePrefix = !(opts.z || opts.zero) && shouldEscapeChecksumFilename(displayFile) ? "\\" : "";
      if (opts.tag) stdout(`${escapePrefix}${hashTagName(algorithm, opts)} (${renderedFile}) = ${digest}${sep}`);
      else stdout(`${escapePrefix}${digest}${opts.b || opts.binary ? " *" : "  "}${renderedFile}${sep}`);
    }
    return failed ? 1 : 0;
  };
}

export function rejectHashLengthOption(args) {
  for (const arg of args) {
    if (arg === "--") return;
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=", 1)[0];
      if ("length".startsWith(name)) throw new UsageError(`unrecognized option '${arg}'`, true);
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (const ch of arg.slice(1)) {
      if (ch === "l") throw new UsageError("invalid option -- 'l'", true);
      if (ch === "b" || ch === "c" || ch === "t" || ch === "w" || ch === "z") continue;
      break;
    }
  }
}

export function validateChecksumCheckOnlyOptions(opts) {
  if (opts.c || opts.check) return;
  for (const option of ["ignore-missing", "status", "quiet", "strict", "warn"]) {
    if (opts[option]) throw new UsageError(`the --${option} option is meaningful only when verifying checksums`, true);
  }
}

export function hashDigestBytes(algorithm, opts = {}) {
  if (algorithm !== "blake2b512") return null;
  const length = opts.l ?? opts.length ?? "512";
  validateBlake2bLength("b2sum", length);
  return Number(length) === 0 ? 64 : Number(length) / 8;
}

export function hashProgramName(algorithm) {
  if (algorithm === "md5") return "md5sum";
  if (algorithm === "blake2b512") return "b2sum";
  return `${algorithm}sum`;
}

export function normalizeHashLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, HASH_LONG_OPTIONS);
}

export function normalizeHashLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, HASH_LONG_OPTIONS);
}

export function hashTagName(algorithm, opts = {}) {
  if (algorithm === "md5") return "MD5";
  if (algorithm === "blake2b512") {
    const length = opts.l ?? opts.length;
    return length != null && !["0", "512"].includes(String(length)) ? `BLAKE2b-${length}` : "BLAKE2b";
  }
  return algorithm.toUpperCase();
}

export async function checkHashes(algorithm, files, opts = {}) {
  if (files.length === 1 && files[0] === "-" && !fstatSync(0).isFile()) {
    return checkHashesStream(algorithm, opts);
  }
  let checksumFailures = 0;
  let readFailures = 0;
  let malformed = 0;
  let properLines = 0;
  let verified = 0;
  let emptyLists = 0;
  const checksumName = algorithm.toUpperCase();
  let lastChecksumName = checksumName;
  let checksumLineStyle = null;
  for (const listFile of files) {
    let text;
    try {
      text = decodeSurrogateEscapedBytes(await readAll(listFile));
    } catch (error) {
      readFailures++;
      stderr(`${diagnosticPrefix(opts)}${listFile}: ${fileReadErrorMessage(error)}\n`);
      continue;
    }
    let fileProperLines = 0;
    let lineNo = 0;
    for (const raw of text.split(/\n/)) {
      lineNo++;
      const line = raw.replace(/\r$/, "").replace(/^[ \t]*\\/, "");
      if (!line || line.startsWith("#") || line.startsWith("-----BEGIN ") || line.startsWith("-----END ") || /^Hash: /.test(line)) continue;
      const parsedLine = parseChecksumLine(line, algorithm, checksumLineStyle);
      if (parsedLine?.skip) continue;
      if (!parsedLine) {
        malformed++;
        if (opts.warn && (!opts.status || opts.warnAfterStatus)) stderr(`${diagnosticPrefix(opts)}${listFile}: ${lineNo}: improperly formatted ${lastChecksumName} checksum line\n`);
        continue;
      }
      const parsed = parseExpectedChecksum(parsedLine.token, parsedLine.algorithm, { ...opts, ...(parsedLine.opts ?? {}) });
      if (!parsed) {
        malformed++;
        if (opts.warn && (!opts.status || opts.warnAfterStatus)) stderr(`${diagnosticPrefix(opts)}${listFile}: ${lineNo}: improperly formatted ${checksumDisplayName(parsedLine.algorithm, parsedLine.opts)} checksum line\n`);
        continue;
      }
      if (parsedLine.style && checksumLineStyle == null) checksumLineStyle = parsedLine.style;
      lastChecksumName = checksumDisplayName(parsedLine.algorithm, parsedLine.opts);
      const { expected, hashAlgorithm, blake2bBytes } = parsed;
      const file = checksumPathFromFilename(unescapeChecksumFilename(parsedLine.file));
      properLines++;
      fileProperLines++;
      try {
        const actualDigest = blake2bBytes ? await blake2bDigestFile(file, blake2bBytes) : await fileDigest(file, hashAlgorithm);
        const actual = actualDigest.slice(0, expected.length / 2).toString("hex");
        const ok = actual === expected;
        verified++;
        if (!ok) checksumFailures++;
        if (!(opts.status || (opts.quiet && ok))) stdout(`${checksumDisplayFile(file)}: ${ok ? "OK" : "FAILED"}\n`);
      } catch (error) {
        if (opts["ignore-missing"]) continue;
        readFailures++;
        if (!opts.status) stderr(`${diagnosticPrefix(opts)}${pathDisplayName(file)}: ${fileReadErrorMessage(error)}\n`);
        if (!opts.status) stdout(`${checksumDisplayFile(file)}: FAILED open or read\n`);
      }
    }
    if (fileProperLines === 0) {
      emptyLists++;
      if (!opts.status) stderr(`${diagnosticPrefix(opts)}${listFile}: no properly formatted checksum lines found\n`);
    }
  }
  if (properLines === 0) {
    return 1;
  }
  const showStatusWarnings = !opts.status || opts.warnAfterStatus;
  if (malformed && showStatusWarnings && !opts.quiet) stderr(`${diagnosticPrefix(opts)}WARNING: ${malformed} line${malformed === 1 ? " is" : "s are"} improperly formatted\n`);
  if (readFailures && showStatusWarnings) stderr(`${diagnosticPrefix(opts)}WARNING: ${readFailures} listed file${readFailures === 1 ? "" : "s"} could not be read\n`);
  if (checksumFailures && showStatusWarnings) stderr(`${diagnosticPrefix(opts)}WARNING: ${checksumFailures} computed checksum${checksumFailures === 1 ? "" : "s"} did NOT match\n`);
  if (verified === 0 && readFailures === 0) {
    if (showStatusWarnings) stderr(`${diagnosticPrefix(opts)}${files[0]}: no file was verified\n`);
    return 1;
  }
  return checksumFailures || readFailures || emptyLists || (opts.strict && malformed) ? 1 : 0;
}

export async function checkHashesStream(requestedAlgorithm, opts = {}) {
  const reader = createFdRecordReader(0, 10);
  let checksumFailures = 0;
  let readFailures = 0;
  let malformed = 0;
  let properLines = 0;
  let verified = 0;
  let lineNo = 0;
  let checksumLineStyle = null;
  let lastChecksumName = requestedAlgorithm.toUpperCase();
  while (true) {
    const bytes = reader.next();
    if (bytes == null) break;
    lineNo++;
    const raw = decodeSurrogateEscapedBytes(bytes);
    const line = raw.replace(/\r$/, "").replace(/^[ \t]*\\/, "");
    if (!line || line.startsWith("#") || line.startsWith("-----BEGIN ") || line.startsWith("-----END ") || /^Hash: /.test(line)) continue;
    const parsedLine = parseChecksumLine(line, requestedAlgorithm, checksumLineStyle);
    if (parsedLine?.skip) continue;
    if (!parsedLine) {
      malformed++;
      if (opts.warn && (!opts.status || opts.warnAfterStatus)) stderr(`${diagnosticPrefix(opts)}-: ${lineNo}: improperly formatted ${lastChecksumName} checksum line\n`);
      continue;
    }
    const parsed = parseExpectedChecksum(parsedLine.token, parsedLine.algorithm, { ...opts, ...(parsedLine.opts ?? {}) });
    if (!parsed) {
      malformed++;
      if (opts.warn && (!opts.status || opts.warnAfterStatus)) stderr(`${diagnosticPrefix(opts)}-: ${lineNo}: improperly formatted ${checksumDisplayName(parsedLine.algorithm, parsedLine.opts)} checksum line\n`);
      continue;
    }
    if (parsedLine.style && checksumLineStyle == null) checksumLineStyle = parsedLine.style;
    lastChecksumName = checksumDisplayName(parsedLine.algorithm, parsedLine.opts);
    properLines++;
    const file = checksumPathFromFilename(unescapeChecksumFilename(parsedLine.file));
    const { expected, hashAlgorithm, blake2bBytes } = parsed;
    try {
      const digest = blake2bBytes ? await blake2bDigestFile(file, blake2bBytes) : await fileDigest(file, hashAlgorithm);
      const actual = digest.slice(0, expected.length / 2).toString("hex");
      const ok = actual === expected;
      verified++;
      if (!ok) checksumFailures++;
      if (!(opts.status || (opts.quiet && ok))) stdout(`${checksumDisplayFile(file)}: ${ok ? "OK" : "FAILED"}\n`);
    } catch (error) {
      if (isWriteError(error)) throw error;
      if (opts["ignore-missing"]) continue;
      readFailures++;
      if (!opts.status) stderr(`${diagnosticPrefix(opts)}${pathDisplayName(file)}: ${fileReadErrorMessage(error)}\n`);
      if (!opts.status) stdout(`${checksumDisplayFile(file)}: FAILED open or read\n`);
    }
  }
  if (properLines === 0) {
    if (!opts.status) stderr(`${diagnosticPrefix(opts)}-: no properly formatted checksum lines found\n`);
    return 1;
  }
  const showStatusWarnings = !opts.status || opts.warnAfterStatus;
  if (malformed && showStatusWarnings && !opts.quiet) stderr(`${diagnosticPrefix(opts)}WARNING: ${malformed} line${malformed === 1 ? " is" : "s are"} improperly formatted\n`);
  if (readFailures && showStatusWarnings) stderr(`${diagnosticPrefix(opts)}WARNING: ${readFailures} listed file${readFailures === 1 ? "" : "s"} could not be read\n`);
  if (checksumFailures && showStatusWarnings) stderr(`${diagnosticPrefix(opts)}WARNING: ${checksumFailures} computed checksum${checksumFailures === 1 ? "" : "s"} did NOT match\n`);
  if (verified === 0 && readFailures === 0) {
    if (showStatusWarnings) stderr(`${diagnosticPrefix(opts)}-: no file was verified\n`);
    return 1;
  }
  return checksumFailures || readFailures || (opts.strict && malformed) ? 1 : 0;
}

export function parseChecksumLine(line, requestedAlgorithm, style = null) {
  const tag = line.match(/^([A-Za-z0-9-]+) \((.*)\) = (\S+)$/) ?? line.match(/^([A-Za-z0-9-]+)\((.*)\)= (\S+)$/);
  if (tag) {
    const algorithm = checksumAlgorithmFromTag(tag[1]);
    if (!algorithm) return null;
    if (requestedAlgorithm !== "auto" && !checksumAlgorithmMatches(requestedAlgorithm, algorithm)) return { skip: true };
    return { algorithm: algorithm.name, token: tag[3], file: tag[2], opts: algorithm.opts };
  }
  const token = line.match(/^(\S+)/)?.[1];
  if (!token || line.length <= token.length || line[token.length] !== " ") return null;
  const rest = line.slice(token.length);
  const algorithm = requestedAlgorithm === "auto" ? "auto" : requestedAlgorithm;
  if (style === "bsd-alternate") return { algorithm, token, file: rest.slice(1), style: "bsd-alternate" };
  if (rest.startsWith("  ")) return { algorithm, token, file: rest.slice(2), style: "gnu" };
  if (rest.startsWith(" *")) return { algorithm, token, file: rest.slice(2), style: "gnu" };
  if (style == null && requestedAlgorithm !== "auto") return { algorithm, token, file: rest.slice(1), style: "bsd-alternate" };
  return null;
}

export function shouldEscapeChecksumFilename(file) {
  return String(file).includes("\\") || String(file).includes("\n") || String(file).includes("\r");
}

export function escapeChecksumFilename(file) {
  return String(file).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

export function unescapeChecksumFilename(file) {
  return String(file).replace(/\\([\\nr])/g, (_, ch) => ch === "n" ? "\n" : ch === "r" ? "\r" : "\\");
}

export function checksumPathFromFilename(file) {
  return hasSurrogateEscapedBytes(file) ? Buffer.from(encodeSurrogateEscapedString(file)) : file;
}

export function checksumDisplayFile(file) {
  const text = pathDisplayName(file);
  return /[\\\n\r\t]/.test(text) || hasSurrogateEscapedBytes(text) ? checksumShellQuote(text) : text;
}

export function checksumShellQuote(file) {
  let out = "";
  let plain = "";
  const flush = () => {
    if (!plain) return;
    out += `'${plain.replace(/'/g, "'\\''")}'`;
    plain = "";
  };
  for (const ch of String(file)) {
    const code = ch.charCodeAt(0);
    if (ch === "\n" || ch === "\t" || ch === "\r") {
      flush();
      out += `$'\\${ch === "\n" ? "n" : ch === "\t" ? "t" : "r"}'`;
    } else if (code >= 0xdc80 && code <= 0xdcff) {
      flush();
      out += `$'\\${(code - 0xdc00).toString(8).padStart(3, "0")}'`;
    } else {
      plain += ch;
    }
  }
  flush();
  return out;
}

export function checksumAlgorithmMatches(requested, tagged) {
  if (requested === tagged.name) return true;
  if (requested === "blake2b512" && tagged.name === "blake2b") return true;
  if (requested === "sha2" && /^sha(224|256|384|512)$/.test(tagged.name)) return true;
  return false;
}

export function checksumAlgorithmFromTag(tag) {
  const upper = tag.toUpperCase();
  if (upper === "MD5") return { name: "md5" };
  if (upper === "SHA1") return { name: "sha1" };
  const sha = upper.match(/^SHA(224|256|384|512)$/);
  if (sha) return { name: `sha${sha[1]}` };
  const sha2 = upper.match(/^SHA2-(224|256|384|512)$/);
  if (sha2) return { name: "sha2", opts: { l: sha2[1] } };
  const sha3 = upper.match(/^SHA3-(224|256|384|512)$/);
  if (sha3) return { name: "sha3", opts: { l: sha3[1] } };
  const blake = tag.match(/^BLAKE2b(?:-(\d+))?$/);
  if (blake) return { name: "blake2b", opts: blake[1] ? { l: blake[1], tagged: true } : { tagged: true } };
  if (upper === "SM3") return { name: "sm3", opts: { tagged: true } };
  return null;
}

export function diagnosticPrefix(opts = {}) {
  return opts.program ? `${opts.program}: ` : "";
}

export function checksumDisplayName(algorithm, opts = {}) {
  if (algorithm === "blake2b") return "BLAKE2b";
  if (algorithm === "sha2") return `SHA2-${opts?.l ?? opts?.length ?? ""}`.replace(/-$/, "");
  if (algorithm === "sha3") return `SHA3-${opts?.l ?? opts?.length ?? ""}`.replace(/-$/, "");
  return String(algorithm).toUpperCase();
}

export function invalidDigestLengthError(program, algorithm, length, message) {
  const quotedMessage = message.replaceAll(`'${algorithm}'`, localeQuotedDiagnostic(algorithm));
  const error = new UsageError(`invalid length: ${localeQuotedDiagnostic(length)}\n${program}: ${quotedMessage}`, false);
  return error;
}

export function validateBlake2bLength(program, length) {
  const text = String(length);
  if (!/^\d+$/.test(text)) {
    if (/^-\d+$/.test(text)) throw new UsageError(`invalid length: ${localeQuotedEscapedDiagnostic(length)}: Value too large for defined data type`, false);
    throw new UsageError(`invalid length: ${localeQuotedEscapedDiagnostic(length)}`, false);
  }
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n > 512) throw invalidDigestLengthError(program, "BLAKE2b", length, "maximum digest length for 'BLAKE2b' is 512 bits");
  if (n % 8 !== 0) throw invalidDigestLengthError(program, "BLAKE2b", length, "length is not a multiple of 8");
}

export function parseExpectedChecksum(token, algorithm, opts = {}) {
  if (/^[0-9a-fA-F]+$/.test(token) && token.length % 2 === 0) {
    const digestBytes = token.length / 2;
    if (!validChecksumDigestLength(algorithm, digestBytes, opts)) return null;
    if (algorithm === "blake2b" || algorithm === "blake2b512") return { expected: token.toLowerCase(), hashAlgorithm: "blake2b512", blake2bBytes: digestBytes };
    return { expected: token.toLowerCase(), hashAlgorithm: cksumAlgorithmForDigest(algorithm, digestBytes, opts) };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token) || token.length % 4 !== 0) return null;
  let digest;
  try {
    digest = Buffer.from(token, "base64");
  } catch {
    return null;
  }
  if (digest.length === 0) return null;
  try {
    if (!validChecksumDigestLength(algorithm, digest.length, opts)) return null;
    if (algorithm === "blake2b" || algorithm === "blake2b512") return { expected: digest.toString("hex"), hashAlgorithm: "blake2b512", blake2bBytes: digest.length };
    return { expected: digest.toString("hex"), hashAlgorithm: cksumAlgorithmForDigest(algorithm, digest.length, opts) };
  } catch {
    return null;
  }
}

export function validChecksumDigestLength(algorithm, digestBytes, opts = {}) {
  const fixed = { md5: 16, sha1: 20, sha224: 28, sha256: 32, sha384: 48, sha512: 64, sm3: 32 };
  if (fixed[algorithm] != null) return digestBytes === fixed[algorithm];
  if (algorithm === "sha2" || algorithm === "sha3") return [28, 32, 48, 64].includes(digestBytes);
  if (algorithm === "blake2b" || algorithm === "blake2b512") {
    if (opts.tagged && opts.l == null && opts.length == null) return digestBytes === 64;
    return digestBytes >= 1 && digestBytes <= 64;
  }
  if (algorithm === "auto") return false;
  return true;
}

export function fileReadErrorMessage(error) {
  return systemErrorMessage(error);
}
