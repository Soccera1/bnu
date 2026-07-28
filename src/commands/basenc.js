#!/usr/bin/env bun

import { base32Decode, base32Encode, baseEncodingDiagnosticName, baseLikeMetaOption, decodeBase64, ensureSingleInputOperand, formatEncodedOutput, parseWrap } from "../shared/checksum.js";
import { nodeErrorMessage, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions, readAll, readFdChunkViews, systemErrorMessage } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const BASENC_LONG_OPTIONS = ["base64", "base64url", "base58", "base32", "base32hex", "base16", "base2msbf", "base2lsbf", "decode", "ignore-garbage", "wrap", "z85", "help", "version"];

export function basencMetaOption(args) {
  return baseLikeMetaOption(args, BASENC_LONG_OPTIONS, normalizeBasencLongOption);
}

export function readStdinChunkViews(accept, size = 64 * 1024) {
  readFdChunkViews(0, accept, size);
}

export function normalizeBasencLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, BASENC_LONG_OPTIONS);
}

export function normalizeBasencLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, BASENC_LONG_OPTIONS);
}

export async function basenc(args) {
  args = normalizeBasencLongOptions(args);
  if (args.includes("--foobar")) throw new UsageError("foobar", true);
  const { opts, operands } = parseOptions(args, { short: { d: false, i: false, w: "value" }, long: { help: false, version: false, decode: false, "ignore-garbage": false, base64: false, base64url: false, base32: false, base32hex: false, base16: false, base2msbf: false, base2m: false, base2lsbf: false, base2l: false, z85: false, base58: false, wrap: "value" } });
  if (opts.help) {
    stdout("Usage: basenc ENCODING [OPTION]... [FILE]\n");
    return 0;
  }
  ensureSingleInputOperand(operands);
  const wrap = parseWrap(opts.w ?? opts.wrap ?? 76);
  const mode = basencSelectedMode(args);
  if (!mode) throw new UsageError("missing encoding type", true);
  const file = operands[0] ?? "-";
  if (!(opts.d || opts.decode) && file === "-" && mode !== "base58") {
    try {
      streamBasencEncode(mode, wrap);
      return 0;
    } catch (error) {
      if (error instanceof UsageError) throw error;
      stderr(`basenc: ${nodeErrorMessage(error)}\n`);
      return 1;
    }
  }
  let data;
  try {
    data = await readAll(file);
  } catch (error) {
    const message = error?.code === "EISDIR" ? "read error: Is a directory" : file === "-" ? nodeErrorMessage(error) : `${baseEncodingDiagnosticName(file)}: ${systemErrorMessage(error)}`;
    stderr(`basenc: ${message}\n`);
    return 1;
  }
  if (opts.d || opts.decode) {
    const rawText = new TextDecoder().decode(data);
    let text = rawText.replace(/\s+/g, "");
    const ignoreGarbage = opts.i || opts["ignore-garbage"];
    if (mode === "base16") stdout(decodeBase16(text, ignoreGarbage));
    else if (mode === "base32") {
      if (ignoreGarbage) text = text.replace(/[^A-Z2-7=]/g, "");
      stdout(base32Decode(text));
    } else if (mode === "base32hex") {
      if (ignoreGarbage) text = text.replace(/[^0-9A-V=]/gi, "");
      stdout(base32Decode(base32HexToBase32(text)));
    } else if (mode === "base2msbf" || mode === "base2lsbf") stdout(decodeBase2(text, ignoreGarbage, mode === "base2lsbf"));
    else if (mode === "z85") stdout(z85Decode(rawText, ignoreGarbage));
    else if (mode === "base58") stdout(base58Decode(rawText, ignoreGarbage));
    else {
      if (mode === "base64url" && !ignoreGarbage && /[+/]/.test(text)) throw new UsageError("invalid input");
      stdout(decodeBase64(text, ignoreGarbage, mode === "base64url"));
    }
    return 0;
  }
  if (mode === "base58" && data.length > 0 && data.every((byte) => byte === 0)) {
    writeRepeatedEncodedByte(49, data.length, wrap);
    return 0;
  }
  let encoded;
  if (mode === "base16") encoded = Buffer.from(data).toString("hex").toUpperCase();
  else if (mode === "base32") encoded = base32Encode(data);
  else if (mode === "base32hex") encoded = base32ToBase32Hex(base32Encode(data));
  else if (mode === "base2msbf") encoded = encodeBase2(data, false);
  else if (mode === "base2lsbf") encoded = encodeBase2(data, true);
  else if (mode === "z85") encoded = z85Encode(data);
  else if (mode === "base58") encoded = base58Encode(data);
  else {
    encoded = Buffer.from(data).toString("base64");
    if (mode === "base64url") encoded = encoded.replaceAll("+", "-").replaceAll("/", "_");
  }
  stdout(formatEncodedOutput(encoded, wrap));
  return 0;
}

export function writeRepeatedEncodedByte(byte, count, wrap) {
  const output = Buffer.allocUnsafe(64 * 1024);
  let used = 0;
  let column = 0;
  const flush = () => {
    if (used) stdout(output.subarray(0, used));
    used = 0;
  };
  for (let index = 0; index < count; index++) {
    if (used >= output.length - 1) flush();
    output[used++] = byte;
    if (wrap && ++column === wrap) {
      output[used++] = 10;
      column = 0;
    }
  }
  if (wrap && column) output[used++] = 10;
  flush();
}

export function streamBasencEncode(mode, wrap) {
  const output = Buffer.allocUnsafe(64 * 1024);
  let outputLength = 0;
  let column = 0;
  const flush = () => {
    if (outputLength) stdout(output.subarray(0, outputLength));
    outputLength = 0;
  };
  const emit = (code) => {
    if (outputLength > output.length - 2) flush();
    output[outputLength++] = code;
    if (wrap && ++column === wrap) {
      output[outputLength++] = 10;
      column = 0;
    }
  };
  const group = [];
  let bits = 0;
  let value = 0;
  let symbols = 0;
  const base32Alphabet = mode === "base32hex" ? "0123456789ABCDEFGHIJKLMNOPQRSTUV" : "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const base64Alphabet = mode === "base64url"
    ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  readStdinChunkViews((chunk) => {
    for (const byte of chunk) {
      if (mode === "base16") {
        const hex = "0123456789ABCDEF";
        emit(hex.charCodeAt(byte >>> 4));
        emit(hex.charCodeAt(byte & 15));
      } else if (mode === "base2msbf" || mode === "base2lsbf") {
        for (let bit = 0; bit < 8; bit++) {
          const shift = mode === "base2lsbf" ? bit : 7 - bit;
          emit(48 + ((byte >>> shift) & 1));
        }
      } else if (mode === "base32" || mode === "base32hex") {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
          emit(base32Alphabet.charCodeAt((value >>> (bits - 5)) & 31));
          bits -= 5;
          symbols++;
        }
      } else if (mode === "z85") {
        group.push(byte);
        if (group.length === 4) {
          let z85Value = ((group[0] * 256 + group[1]) * 256 + group[2]) * 256 + group[3];
          const divisors = [52200625, 614125, 7225, 85, 1];
          for (const divisor of divisors) emit(Z85_ALPHABET.charCodeAt(Math.floor(z85Value / divisor) % 85));
          group.length = 0;
        }
      } else {
        group.push(byte);
        if (group.length === 3) {
          const triple = (group[0] << 16) | (group[1] << 8) | group[2];
          emit(base64Alphabet.charCodeAt((triple >>> 18) & 63));
          emit(base64Alphabet.charCodeAt((triple >>> 12) & 63));
          emit(base64Alphabet.charCodeAt((triple >>> 6) & 63));
          emit(base64Alphabet.charCodeAt(triple & 63));
          group.length = 0;
        }
      }
    }
  }, 8 * 1024);
  if (mode === "base32" || mode === "base32hex") {
    if (bits) {
      emit(base32Alphabet.charCodeAt((value << (5 - bits)) & 31));
      symbols++;
    }
    while (symbols % 8) {
      emit(61);
      symbols++;
    }
  } else if (mode === "z85") {
    if (group.length) {
      flush();
      throw new UsageError("invalid input (length must be multiple of 4 characters)");
    }
  } else if ((mode === "base64" || mode === "base64url") && group.length) {
    const triple = (group[0] << 16) | ((group[1] ?? 0) << 8);
    emit(base64Alphabet.charCodeAt((triple >>> 18) & 63));
    emit(base64Alphabet.charCodeAt((triple >>> 12) & 63));
    if (group.length === 2) {
      emit(base64Alphabet.charCodeAt((triple >>> 6) & 63));
      emit(61);
    } else {
      emit(61);
      emit(61);
    }
  }
  if (wrap && column) output[outputLength++] = 10;
  flush();
}

export function basencSelectedMode(args) {
  const modes = new Set(["base64", "base64url", "base32", "base32hex", "base16", "base2msbf", "base2lsbf", "z85", "base58"]);
  let mode = null;
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2).split("=", 1)[0];
    if (modes.has(name)) mode = name;
  }
  return mode;
}

export function decodeBase16(text, ignoreGarbage = false) {
  let cleaned = text.replace(/\s+/g, "");
  if (ignoreGarbage) cleaned = cleaned.replace(/[^0-9a-fA-F]/g, "");
  const invalid = cleaned.search(/[^0-9a-fA-F]/);
  const usableLength = invalid === -1 ? cleaned.length : invalid;
  const evenLength = usableLength - (usableLength % 2);
  if (invalid !== -1 || usableLength % 2 !== 0) {
    if (evenLength > 0) stdout(Buffer.from(cleaned.slice(0, evenLength), "hex"));
    throw new UsageError("invalid input");
  }
  return Buffer.from(cleaned, "hex");
}

export function base32ToBase32Hex(text) {
  const from = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const to = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
  return [...text].map((ch) => ch === "=" ? ch : to[from.indexOf(ch)]).join("");
}

export function base32HexToBase32(text) {
  const from = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
  const to = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  return [...text].map((ch) => ch === "=" ? ch : to[from.indexOf(ch)] ?? ch).join("");
}

export function encodeBase2(data, leastSignificantFirst = false) {
  let out = "";
  for (const byte of data) {
    for (let bit = 0; bit < 8; bit++) {
      const shift = leastSignificantFirst ? bit : 7 - bit;
      out += (byte >>> shift) & 1 ? "1" : "0";
    }
  }
  return out;
}

export function decodeBase2(text, ignoreGarbage = false, leastSignificantFirst = false) {
  const cleaned = ignoreGarbage ? text.replace(/[^01]/g, "") : text;
  const out = [];
  let value = 0;
  let bits = 0;
  for (const ch of cleaned) {
    if (ch !== "0" && ch !== "1") {
      if (out.length) stdout(Uint8Array.from(out));
      throw new UsageError("invalid input");
    }
    const bit = ch === "1" ? 1 : 0;
    value |= bit << (leastSignificantFirst ? bits : 7 - bits);
    bits++;
    if (bits === 8) {
      out.push(value);
      value = 0;
      bits = 0;
    }
  }
  if (bits !== 0) {
    if (out.length) stdout(Uint8Array.from(out));
    throw new UsageError("invalid input");
  }
  return Uint8Array.from(out);
}

export const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(data) {
  let zeros = 0;
  while (zeros < data.length && data[zeros] === 0) zeros++;
  if (zeros === data.length) return "1".repeat(zeros);
  let n = 0n;
  for (const byte of data) n = (n << 8n) + BigInt(byte);
  let out = "";
  while (n > 0n) {
    const rem = Number(n % 58n);
    out = BASE58_ALPHABET[rem] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(text, ignoreGarbage = false) {
  let cleaned = text.replace(/\n/g, "");
  if (ignoreGarbage) cleaned = [...cleaned].filter((ch) => BASE58_ALPHABET.includes(ch)).join("");
  const invalid = [...cleaned].find((ch) => !BASE58_ALPHABET.includes(ch));
  if (invalid !== undefined) throw new UsageError("invalid input");
  let zeros = 0;
  while (zeros < cleaned.length && cleaned[zeros] === "1") zeros++;
  if (zeros === cleaned.length) return Buffer.alloc(zeros);
  let n = 0n;
  for (const ch of cleaned) n = n * 58n + BigInt(BASE58_ALPHABET.indexOf(ch));
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes)]);
}

export const Z85_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";

export function z85Encode(data) {
  if (data.length % 4 !== 0) throw new UsageError("invalid input (length must be multiple of 4 characters)");
  let out = "";
  for (let i = 0; i < data.length; i += 4) {
    let value = ((data[i] * 256 + data[i + 1]) * 256 + data[i + 2]) * 256 + data[i + 3];
    const chars = Array(5);
    for (let j = 4; j >= 0; j--) {
      chars[j] = Z85_ALPHABET[value % 85];
      value = Math.floor(value / 85);
    }
    out += chars.join("");
  }
  return out;
}

export function z85Decode(text, ignoreGarbage = false) {
  let cleaned = text.replace(/\n/g, "");
  if (ignoreGarbage) cleaned = [...cleaned].filter((ch) => Z85_ALPHABET.includes(ch)).join("");
  const out = [];
  for (let i = 0; i < cleaned.length; i += 5) {
    const chunk = cleaned.slice(i, i + 5);
    if (chunk.length < 5) {
      if (out.length) stdout(Uint8Array.from(out));
      throw new UsageError("invalid input");
    }
    let value = 0;
    for (const ch of chunk) {
      const digit = Z85_ALPHABET.indexOf(ch);
      if (digit === -1) {
        if (out.length) stdout(Uint8Array.from(out));
        throw new UsageError("invalid input");
      }
      value = value * 85 + digit;
    }
    if (value > 0xffffffff) {
      if (out.length) stdout(Uint8Array.from(out));
      throw new UsageError("invalid input");
    }
    out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
  }
  return Uint8Array.from(out);
}

const singleCall = defineCommand("basenc", basenc, basencMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
