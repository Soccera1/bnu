import { readSync } from "node:fs";
import { open } from "node:fs/promises";
import { localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, pathDisplayName, shellEscapeLsName } from "./common.js";
import { UsageError, stdout } from "./diagnostics.js";

export const BASE_ENCODING_LONG_OPTIONS = ["decode", "ignore-garbage", "wrap", "help", "version"];

export function baseEncodingMetaOption(args) {
  return baseLikeMetaOption(args, BASE_ENCODING_LONG_OPTIONS, normalizeBaseEncodingLongOption);
}

export function baseLikeMetaOption(args, longOptions, normalizeLongOption) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!longOptions.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (name === "wrap") {
        const value = inlineValue ?? args[i + 1];
        if (value !== undefined) parseWrap(value);
        if (inlineValue == null) i++;
      }
      else if (inlineValue != null && name !== "wrap") return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!["d", "i", "w"].includes(ch)) return null;
      if (ch === "w") {
        const inlineValue = arg.slice(j + 1);
        const value = inlineValue === "" ? args[i + 1] : inlineValue;
        if (value !== undefined) parseWrap(value);
        if (inlineValue === "") i++;
        break;
      }
    }
  }
  return null;
}

export function baseEncodingDiagnosticName(file) {
  return shellEscapeLsName(pathDisplayName(file));
}

export function ensureSingleInputOperand(operands) {
  if (operands.length > 1) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[1])}`, true);
}

export function parseWrap(value) {
  const text = String(value);
  if (!/^\+?\d+$/.test(text)) throw new UsageError(`invalid wrap size: ${localeQuotedEscapedDiagnostic(text)}`);
  const parsed = BigInt(text);
  if (parsed > 9223372036854775807n) return 0;
  const wrap = parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed);
  return wrap;
}

export function formatEncodedOutput(encoded, wrap) {
  if (encoded === "") return "";
  if (wrap === 0) return encoded;
  if (wrap >= encoded.length) return `${encoded}\n`;
  return `${encoded.match(new RegExp(`.{1,${wrap}}`, "g"))?.join("\n") ?? ""}\n`;
}

export function normalizeBaseEncodingLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, BASE_ENCODING_LONG_OPTIONS);
}

export function normalizeBaseEncodingLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, BASE_ENCODING_LONG_OPTIONS);
}

export function decodeBase64(text, ignoreGarbage = false, url = false) {
  let cleaned = text.replace(/\s+/g, "");
  const alphabet = url ? "A-Za-z0-9_\\-=" : "A-Za-z0-9+/=";
  if (ignoreGarbage) cleaned = cleaned.replace(new RegExp(`[^${alphabet}]`, "g"), "");
  else {
    const invalid = cleaned.search(new RegExp(`[^${alphabet}]`));
    if (invalid !== -1) {
      const prefix = decodeBase64Clean(cleaned.slice(0, invalid), url).bytes;
      if (prefix.length) stdout(prefix);
      throw new UsageError("invalid input");
    }
  }
  const decoded = decodeBase64Clean(cleaned, url);
  if (!decoded.valid) {
    if (decoded.bytes.length) stdout(decoded.bytes);
    throw new UsageError("invalid input");
  }
  return decoded.bytes;
}

export function base64Alphabet(text, url = false) {
  return url ? text.replaceAll("-", "+").replaceAll("_", "/") : text;
}

export function decodeBase64Clean(text, url = false) {
  const chunks = [];
  let valid = true;
  let i = 0;
  while (i < text.length) {
    let start = i;
    while (i < text.length && text[i] !== "=") i++;
    let base = text.slice(start, i);
    let pads = "";
    while (i < text.length && text[i] === "=") pads += text[i++];
    if (base.length === 0 && pads.length > 0) {
      valid = false;
      break;
    }
    if (base.length === 0) continue;
    const segment = decodeBase64Segment(base, pads, url);
    if (segment.bytes.length) chunks.push(segment.bytes);
    if (!segment.valid) {
      valid = false;
      break;
    }
  }
  return { bytes: Buffer.concat(chunks), valid };
}

export function decodeBase64Segment(base, pads, url = false) {
  const needPads = (4 - (base.length % 4)) % 4;
  const bytes = base.length % 4 === 1
    ? Buffer.from(base64Alphabet(base.slice(0, base.length - 1), url), "base64")
    : Buffer.from(base64Alphabet(base + "=".repeat(needPads), url), "base64");
  let valid = base.length % 4 !== 1;
  if (pads.length) {
    valid &&= pads.length <= 2;
    valid &&= (base.length + pads.length) % 4 === 0;
    if (pads.length === 1) valid &&= base.length % 4 === 3 && (base64DigitValue(base.at(-1), url) & 0b11) === 0;
    else if (pads.length === 2) valid &&= base.length % 4 === 2 && (base64DigitValue(base.at(-1), url) & 0b1111) === 0;
    else valid = false;
  } else if (base.length % 4 === 2) {
    valid &&= (base64DigitValue(base.at(-1), url) & 0b1111) === 0;
  } else if (base.length % 4 === 3) {
    valid &&= (base64DigitValue(base.at(-1), url) & 0b11) === 0;
  }
  return { bytes, valid };
}

export function base64DigitValue(ch, url = false) {
  const alphabet = url ? "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  return alphabet.indexOf(ch);
}

export async function forEachInputChunk(file, callback) {
  const buffer = Buffer.allocUnsafe(256 * 1024);
  if (file === "-") {
    while (true) {
      const n = readSync(0, buffer, 0, buffer.length, null);
      if (n === 0) break;
      callback(buffer.subarray(0, n));
    }
    return;
  }
  const handle = await open(file, "r");
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      callback(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

export async function sumForFile(file, sysv = false) {
  let length = 0;
  let sum = 0;
  await forEachInputChunk(file, (chunk) => {
    length += chunk.length;
    for (const byte of chunk) {
      if (sysv) sum = (sum + byte) % 0x100000000;
      else sum = ((sum >> 1) + ((sum & 1) << 15) + byte) & 0xffff;
    }
  });
  if (sysv) {
    sum = (sum & 0xffff) + Math.floor(sum / 0x10000);
    sum = (sum & 0xffff) + Math.floor(sum / 0x10000);
  }
  return { sum, blocks: Math.ceil(length / (sysv ? 512 : 1024)) };
}

export function base32Encode(data) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  while (out.length % 8) out += "=";
  return out;
}

export function base32Decode(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const decoded = decodeBase32Clean(text, alphabet);
  if (!decoded.valid) {
    if (decoded.bytes.length) stdout(decoded.bytes);
    throw new UsageError("invalid input");
  }
  return decoded.bytes;
}

export function decodeBase32Clean(text, alphabet) {
  const chunks = [];
  let valid = true;
  let i = 0;
  while (i < text.length) {
    let start = i;
    while (i < text.length && text[i] !== "=") i++;
    const base = text.slice(start, i);
    let pads = "";
    while (i < text.length && text[i] === "=") pads += text[i++];
    if (base.length === 0 && pads.length > 0) {
      valid = false;
      break;
    }
    if (base.length === 0) continue;
    const segment = decodeBase32Segment(base, pads, alphabet);
    if (segment.bytes.length) chunks.push(segment.bytes);
    if (!segment.valid) {
      valid = false;
      break;
    }
  }
  return { bytes: Buffer.concat(chunks), valid };
}

export function decodeBase32Segment(base, pads, alphabet) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of base) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) {
      return { bytes: Uint8Array.from(out), valid: false };
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const padByRemainder = new Map([[0, 0], [2, 6], [4, 4], [5, 3], [7, 1]]);
  const expectedPads = padByRemainder.get(base.length % 8);
  let valid = expectedPads !== undefined;
  if (pads.length) valid &&= pads.length === expectedPads && (base.length + pads.length) % 8 === 0;
  valid &&= bits === 0 || (value & ((1 << bits) - 1)) === 0;
  return { bytes: Uint8Array.from(out), valid };
}
