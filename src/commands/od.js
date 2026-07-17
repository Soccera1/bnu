#!/usr/bin/env bun

import { closeSync, openSync, readSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { concatBytes, isWriteError, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, parseGNUSize, parseOptions, readAll, readFdChunkViews, systemErrorMessage } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const OD_LONG_OPTIONS = ["address-radix", "endian", "format", "output-duplicates", "read-bytes", "skip-bytes", "strings", "traditional", "width", "help", "version"];

export function odMetaOption(args) {
  const longValueOptions = new Set(["address-radix", "endian", "format", "read-bytes", "skip-bytes"]);
  const longOptionalValueOptions = new Set(["strings", "width"]);
  const shortValueOptions = new Set(["A", "j", "N", "S", "t"]);
  const shortOptionalValueOptions = new Set(["w"]);
  const shortKnownOptions = new Set(["A", "j", "N", "S", "t", "w", "a", "b", "c", "d", "f", "i", "l", "o", "s", "x", "v"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeOdLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!OD_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      const value = inlineValue ?? (longValueOptions.has(name) ? args[i + 1] : undefined);
      if (name === "endian" && value !== undefined) validateOdEndian(value);
      if (name === "read-bytes" && value !== undefined) parseOdSize(value, "--read-bytes");
      if (name === "skip-bytes" && value !== undefined) parseOdSize(value, "--skip-bytes");
      if (name === "strings" && inlineValue != null) parseOdStringLength(inlineValue, "--strings");
      if (name === "width" && inlineValue != null) parseOdWidth(inlineValue, "--width");
      if (inlineValue == null && longValueOptions.has(name)) i++;
      else if (inlineValue == null && longOptionalValueOptions.has(name)) continue;
      else if (inlineValue != null && !longValueOptions.has(name) && !longOptionalValueOptions.has(name)) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        const value = inlineValue === "" ? args[i + 1] : inlineValue;
        validateOdMetaShortValue(ch, value);
        if (inlineValue === "") i++;
        break;
      }
      if (shortOptionalValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        if (inlineValue !== "") parseOdWidth(inlineValue, "-w");
        break;
      }
    }
  }
  return null;
}

export function validateOdMetaShortValue(ch, value) {
  if (value === undefined) return;
  if (ch === "j") parseOdSize(value, "-j");
  else if (ch === "N") parseOdSize(value, "-N");
  else if (ch === "S") parseOdStringLength(value, "-S");
}

export function readStdinBytesLimit(limit) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(0, limit)));
  let total = 0;
  while (total < limit) {
    const n = readSync(0, buffer, 0, Math.min(buffer.length, limit - total), null);
    if (n === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, n)));
    total += n;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function odCmd(args) {
  args = normalizeOdLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { A: "value", j: "value", N: "value", S: "value", t: "value", w: "optional-value", a: false, b: false, c: false, d: false, f: false, i: false, l: false, o: false, s: false, x: false, v: false }, long: { "address-radix": "value", "skip-bytes": "value", strings: "optional-value", format: "value", "read-bytes": "value", width: "optional-value", "output-duplicates": false, endian: "value", traditional: false, help: false, version: false } });
  const explicitFormats = odFormatsFromArgs(args).filter((format) => format !== "");
  const rawFormats = explicitFormats.length ? explicitFormats : [odFormat(opts)];
  const radix = normalizeOdAddressRadix(opts.A ?? opts["address-radix"] ?? "o");
  validateOdEndian(opts.endian);
  for (const format of rawFormats) validateOdFormat(format);
  const formats = rawFormats.flatMap(odFormatSpecs);
  const oldStyleOffset = odCanUseOldStyleOffset(args);
  const traditional = parseOdTraditionalOperands(operands, opts.traditional, oldStyleOffset);
  const inputFiles = traditional.files.length ? traditional.files : ["-"];
  const chunks = [];
  let failed = false;
  let hasNonRegularInput = false;
  const skip = traditional.skip ?? opts.j ?? opts["skip-bytes"];
  const limit = opts.N ?? opts["read-bytes"];
  const skipOption = opts.j != null ? "-j" : opts["skip-bytes"] != null ? "--skip-bytes" : "-j";
  const limitOption = opts.N != null ? "-N" : "--read-bytes";
  const start = skip == null ? 0 : parseOdSize(skip, skipOption);
  const limitSize = limit == null ? null : parseOdSize(limit, limitOption);
  const readLimit = limitSize == null ? null : start + limitSize;
  if (skip == null && limit == null && traditional.label == null
    && opts.S == null && opts.strings == null && inputFiles.length === 1
    && (opts.v || opts["output-duplicates"])) {
    const lineWidth = resolveOdLineWidth(opts, formats);
    return streamOdFile(inputFiles[0], formats, opts, lineWidth, radix);
  }
  for (const file of inputFiles) {
    try {
      if (file !== "-") {
        const s = await stat(file);
        if (s.isDirectory()) throw Object.assign(new Error("Is a directory"), { code: "EISDIR" });
        if (!s.isFile()) hasNonRegularInput = true;
      }
      chunks.push(readLimit == null ? await readAll(file) : await readAllLimit(file, readLimit));
    } catch (error) {
      stderr(`od: ${odDiagnosticFile(file)}: ${systemErrorMessage(error)}\n`);
      failed = true;
    }
  }
  if (failed && chunks.length === 0) return 1;
  const raw = concatBytes(chunks);
  if (skip != null && start > raw.length && !hasNonRegularInput) {
    stderr("od: cannot skip past end of combined input\n");
    return 1;
  }
  const data = raw.slice(start, limit == null ? undefined : start + limitSize);
  const labelDelta = traditional.label == null ? null : parseGNUSize(traditional.label) - start;
  if (opts.S != null || opts.strings != null) {
    const stringsOption = opts.S != null ? "-S" : "--strings";
    stdout(formatOdStrings(data, parseOdStringLength(opts.S ?? (opts.strings === true ? 3 : opts.strings ?? 3), stringsOption), start, radix, limit != null));
    return failed ? 1 : 0;
  }
  const format = formats[0];
  const lineWidth = resolveOdLineWidth(opts, formats);
  let out = "";
  let previousBodyKey = null;
  let duplicatesSuppressed = false;
  for (let offset = 0; offset < data.length; offset += lineWidth) {
    const chunk = data.slice(offset, offset + lineWidth);
    const address = formatOdAddress(start + offset, radix, labelDelta);
    const bodyLines = odRenderedBodyLines(chunk, formats, opts.endian, lineWidth);
    const bodyKey = bodyLines.join("\n");
    if (!(opts.v || opts["output-duplicates"]) && previousBodyKey === bodyKey) {
      if (!duplicatesSuppressed) out += "*\n";
      duplicatesSuppressed = true;
      continue;
    }
    previousBodyKey = bodyKey;
    duplicatesSuppressed = false;
    out += formatOdChunkOutput(address, bodyLines, formats);
  }
  const finalAddress = formatOdAddress(start + data.length, radix, labelDelta);
  if (finalAddress) out += `${finalAddress}\n`;
  stdout(out);
  return failed ? 1 : 0;
}

export function resolveOdLineWidth(opts, formats) {
  const width = opts.w ?? opts.width;
  const widthOption = opts.w != null ? "-w" : "--width";
  let lineWidth = width === true ? 32 : width == null ? 16 : parseOdWidth(width, widthOption);
  const formatSize = Math.max(...formats.map(odFormatSize));
  if (lineWidth % formatSize !== 0) {
    stderr(`od: warning: invalid width ${lineWidth}; using ${formatSize} instead\n`);
    lineWidth = formatSize;
  }
  return lineWidth;
}

export function formatOdChunkOutput(address, bodyLines, formats) {
  if (formats.length === 1) return `${address} ${bodyLines[0]}\n`;
  const bodyWidth = Math.max(...bodyLines.map((line) => line.length));
  const firstPrefix = address ? `${address} ` : " ";
  const nextPrefix = address ? " ".repeat(address.length + 1) : " ";
  let out = "";
  for (let i = 0; i < bodyLines.length; i++) {
    const line = normalizeOdFormat(formats[i]).showChars ? bodyLines[i].padEnd(bodyWidth) : bodyLines[i];
    out += `${i === 0 ? firstPrefix : nextPrefix}${line}\n`;
  }
  return out;
}

export function streamOdFile(file, formats, opts, lineWidth, radix) {
  let fd;
  let offset = 0;
  let carry = Buffer.alloc(0);
  try {
    fd = file === "-" ? 0 : openSync(file, "r");
    readFdChunkViews(fd, (chunk) => {
      const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let index = 0;
      while (index + lineWidth <= bytes.length) {
        const part = bytes.subarray(index, index + lineWidth);
        const address = formatOdAddress(offset, radix, null);
        stdout(formatOdChunkOutput(address, odRenderedBodyLines(part, formats, opts.endian, lineWidth), formats));
        offset += part.length;
        index += lineWidth;
      }
      carry = Buffer.from(bytes.subarray(index));
    });
    if (carry.length) {
      const address = formatOdAddress(offset, radix, null);
      stdout(formatOdChunkOutput(address, odRenderedBodyLines(carry, formats, opts.endian, lineWidth), formats));
      offset += carry.length;
    }
    const finalAddress = formatOdAddress(offset, radix, null);
    if (finalAddress) stdout(`${finalAddress}\n`);
    return 0;
  } catch (error) {
    if (isWriteError(error)) throw error;
    stderr(`od: ${odDiagnosticFile(file)}: ${systemErrorMessage(error)}\n`);
    return 1;
  } finally {
    if (fd != null && fd !== 0) closeSync(fd);
  }
}

export function odRenderedBodyLines(chunk, formats, endian, lineWidth) {
  if (formats.length === 1) return [formatOdLine(chunk, formats[0], endian, lineWidth)];
  return formats.map((fmt) => formatOdLine(chunk, fmt, endian, lineWidth, true, formats));
}

export function normalizeOdAddressRadix(radix) {
  const text = String(radix);
  if (/^[doxn]/.test(text)) return text[0];
  throw new UsageError(`invalid output address radix '${text[0] ?? "\0"}'; it must be one character from [doxn]`);
}

export function normalizeOdLongOptions(args) {
  return args.map((arg) => normalizeOdLongOption(arg));
}

export function normalizeOdLongOption(arg) {
  if (!arg.startsWith("--") || arg === "--") return arg;
  return normalizeLongOptionByPrefix(arg, OD_LONG_OPTIONS);
}

export function validateOdEndian(endian) {
  if (endian == null || endian === "little" || endian === "big") return;
  const kind = endian === "" ? "ambiguous" : "invalid";
  throw new UsageError(`${kind} argument ${localeQuotedEscapedDiagnostic(endian)} for ${localeQuotedDiagnostic("--endian")}\nValid arguments are:\n  - ${localeQuotedDiagnostic("little")}\n  - ${localeQuotedDiagnostic("big")}`, true);
}

export async function readAllLimit(path, limit) {
  if (limit <= 0) return new Uint8Array();
  if (path === "-") return readStdinBytesLimit(limit);
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.allocUnsafe(limit);
    let offset = 0;
    while (offset < limit) {
      const { bytesRead } = await handle.read(bytes, offset, limit - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export function parseOdSize(value, option) {
  const text = String(value);
  if (text === "") throw new UsageError(`invalid ${option} argument ''`);
  try {
    const size = parseOdByteCount(text.replace(/^\+/, ""));
    return size > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(size);
  } catch (error) {
    if (error instanceof UsageError && error.message === "too large") throw new UsageError(`${option} argument '${text}' too large`);
    if (text.startsWith("-")) throw new UsageError(`invalid ${option} argument '${text}'`);
    throw new UsageError(`invalid suffix in ${option} argument '${text}'`);
  }
}

export function parseOdByteCount(text) {
  const match = String(text).match(/^(\d+)([A-Za-z]*)$/);
  if (!match) throw new UsageError("invalid suffix");
  const scales = {
    "": 1n, b: 512n,
    K: 1024n, k: 1024n, KiB: 1024n, kiB: 1024n,
    M: 1024n ** 2n, m: 1024n ** 2n, MiB: 1024n ** 2n, miB: 1024n ** 2n,
    G: 1024n ** 3n, g: 1024n ** 3n, GiB: 1024n ** 3n, giB: 1024n ** 3n,
    T: 1024n ** 4n, t: 1024n ** 4n, TiB: 1024n ** 4n, tiB: 1024n ** 4n,
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
  };
  const scale = scales[match[2]];
  if (!scale) throw new UsageError("invalid suffix");
  const amount = BigInt(match[1]) * scale;
  if (amount > 9223372036854775807n) throw new UsageError("too large");
  return amount;
}

export function parseOdWidth(value, option) {
  const text = String(value);
  let size;
  try {
    size = parseGNUSize(text.replace(/^\+/, ""));
  } catch {
    if (text.startsWith("-") || !/^\+?\d/.test(text)) throw new UsageError(`invalid ${option} argument '${text}'`);
    throw new UsageError(`invalid suffix in ${option} argument '${text}'`);
  }
  if (size <= 0) throw new UsageError(`invalid ${option} argument '${text}'`);
  return size;
}

export function parseOdStringLength(value, option = "-S") {
  const text = String(value);
  if (text === "") throw new UsageError(`invalid ${option} argument ''`);
  try {
    const parsed = parseOdByteCount(/^\D+$/.test(text) ? `1${text}` : text);
    return parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed);
  } catch (error) {
    if (error instanceof UsageError && error.message === "too large") throw new UsageError(`${option} argument '${text}' too large`);
    if (text.startsWith("-") || /^[A-Za-z]$/.test(text)) throw new UsageError(`invalid ${option} argument '${text}'`);
    throw new UsageError(`invalid suffix in ${option} argument '${text}'`);
  }
}

export function odFormatsFromArgs(args) {
  const formats = [];
  const traditionalFormats = { a: "a", b: "o1", c: "c", d: "u2", f: "fF", i: "dI", l: "dL", o: "o2", s: "d2", x: "x2" };
  for (let i = 0; i < args.length; i++) {
    const arg = normalizeOdLongOption(String(args[i]));
    if (arg === "--") break;
    if (arg === "-t" || arg === "--format") {
      if (i + 1 < args.length) formats.push(String(args[++i]));
    } else if (arg.startsWith("-t") && arg.length > 2) {
      formats.push(arg.slice(2));
    } else if (arg.startsWith("--format=")) {
      formats.push(arg.slice("--format=".length));
    } else if (/^-[^-]/.test(arg)) {
      for (let j = 1; j < arg.length; j++) {
        const ch = arg[j];
        if (traditionalFormats[ch]) formats.push(traditionalFormats[ch]);
        else if (ch === "t") {
          if (j + 1 < arg.length) formats.push(arg.slice(j + 1));
          else if (i + 1 < args.length) formats.push(String(args[++i]));
          break;
        } else if ("AjNSw".includes(ch)) {
          break;
        }
      }
    }
  }
  return formats;
}

export function odFormatSpecs(format) {
  const text = String(format);
  const specs = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const kind = text[i++];
    if (!isOdFormatStart(kind)) throw new UsageError(`invalid character '${kind ?? ""}' in type string ${localeQuotedEscapedDiagnostic(format)}`);
    if (kind === "f") {
      if ("FDLHB".includes(text[i] ?? "")) i++;
      else while (/\d/.test(text[i] ?? "")) i++;
    } else if ("doux".includes(kind)) {
      if ("CSIL".includes(text[i] ?? "")) i++;
      else while (/\d/.test(text[i] ?? "")) i++;
    }
    if (text[i] === "z") i++;
    specs.push(text.slice(start, i));
  }
  return specs;
}

export function isOdFormatStart(ch) {
  return ch != null && "acfdoux".includes(ch);
}

export function odCanUseOldStyleOffset(args) {
  return args.every((arg) => arg === "--" || !String(arg).startsWith("-"));
}

export function parseOdTraditionalOperands(operands, traditional = false, oldStyleOffset = false) {
  const files = [...operands];
  if (!files.length) return { files, skip: null, label: null };
  let label = null;
  const rejectTraditionalExtraFile = () => {
    if (traditional && files.length > 1) {
      throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(files[1])}\nod: compatibility mode supports at most one file`, true);
    }
  };
  if (traditional && files.length >= 2) {
    const parsedLabel = parseOdTraditionalOffset(files.at(-1));
    const parsedSkip = parseOdTraditionalOffset(files.at(-2));
    if (parsedLabel && parsedSkip) {
      files.pop();
      files.pop();
      rejectTraditionalExtraFile();
      return { files, skip: parsedSkip, label: parsedLabel };
    }
  }
  const last = files.at(-1);
  const parsed = parseOdTraditionalOffset(last);
  if (!parsed || (!traditional && (!oldStyleOffset || !String(last).startsWith("+")))) {
    rejectTraditionalExtraFile();
    return { files, skip: null, label };
  }
  files.pop();
  rejectTraditionalExtraFile();
  return { files, skip: parsed, label };
}

export function parseOdTraditionalOffset(value) {
  const text = String(value);
  const match = text.match(/^\+?((?:0x[0-9a-fA-F]+)|(?:\d+))(\.)?([bB])?$/);
  if (!match) {
    if (/^(?:\+?[0-9]{100,}\.?|\+?0x[0-9a-fA-F]{100,})$/.test(text)) throw new UsageError(`${text}: Numerical result out of range`);
    return null;
  }
  const digits = match[1];
  if (digits.replace(/^0x/i, "").length > 60) throw new UsageError(`${text}: Numerical result out of range`);
  const base = /^0x/i.test(digits) ? 16 : match[2] === "." ? 10 : 8;
  if (base === 8 && /[89]/.test(digits)) return null;
  let n = Number.parseInt(digits.replace(/^0x/i, ""), base);
  if (match[3]?.toLowerCase() === "b") n *= 512;
  if (!Number.isSafeInteger(n)) throw new UsageError(`${text}: Numerical result out of range`);
  return String(n);
}

export function odDiagnosticFile(file) {
  return /\s/.test(String(file)) ? `'${String(file).replace(/'/g, "'\\''")}'` : file;
}

export function odFormat(opts) {
  if (opts.a) return "a";
  if (opts.b) return "o1";
  if (opts.c) return "c";
  if (opts.d) return "u2";
  if (opts.f) return "fF";
  if (opts.i) return "dI";
  if (opts.l) return "dL";
  if (opts.o) return "o2";
  if (opts.s) return "d2";
  if (opts.x) return "x2";
  if (opts.t != null && opts.t !== "") return opts.t;
  if (opts.format != null && opts.format !== "") return opts.format;
  return "o2";
}

export function formatOffset(offset, radix) {
  if (radix === "n") return "";
  if (radix === "d") return String(offset).padStart(7, "0");
  if (radix === "x") return offset.toString(16).padStart(6, "0");
  return offset.toString(8).padStart(7, "0");
}

export function formatOdAddress(offset, radix, labelDelta = null) {
  const address = formatOffset(offset, radix);
  if (labelDelta == null) return address;
  const label = formatOffset(offset + (radix === "n" ? 0 : labelDelta), radix === "n" ? "o" : radix);
  return address ? `${address} (${label})` : `(${label})`;
}

export function formatOdLine(chunk, format, endian = "little", lineWidth = null, multiFormat = false, groupFormats = [format]) {
  const normalized = normalizeOdFormat(format);
  const body = formatOdChunk(chunk, normalized.format, endian, multiFormat, groupFormats);
  if (!normalized.showChars) return body;
  const paddedBody = lineWidth == null ? body : body.padEnd(odFullLineBodyWidth(normalized.format, lineWidth, multiFormat, groupFormats));
  return `${paddedBody}  ${formatOdAscii(chunk)}`;
}

export function normalizeOdFormat(format) {
  const text = String(format);
  return { format: text.endsWith("z") ? text.slice(0, -1) : text, showChars: text.endsWith("z") };
}

export function validateOdFormat(format) {
  const text = String(format);
  let i = 0;
  while (i < text.length) {
    const start = i;
    const kind = text[i++];
    if (!isOdFormatStart(kind)) throw new UsageError(`invalid character '${kind ?? ""}' in type string ${localeQuotedEscapedDiagnostic(format)}`);
    if (kind === "f") {
      if ("FDLHB".includes(text[i] ?? "")) i++;
      else while (/\d/.test(text[i] ?? "")) i++;
    } else if ("doux".includes(kind)) {
      if ("CSIL".includes(text[i] ?? "")) i++;
      else while (/\d/.test(text[i] ?? "")) i++;
    }
    if (text[i] === "z") i++;
    validateOdFormatSpec(text.slice(start, i), format);
  }
}

export function validateOdFormatSpec(spec, originalFormat = spec) {
  const text = normalizeOdFormat(spec).format;
  if (text === "a" || text === "c") return;
  if ((text.startsWith("a") || text.startsWith("c")) && text.length > 1) throw new UsageError(`invalid character '${text[1]}' in type string ${localeQuotedEscapedDiagnostic(originalFormat)}`);
  if (text === "f" || text === "fF" || text === "fD" || text === "fL" || text === "fH" || text === "fB" || /^f\d+$/.test(text)) {
    const floatSize = text.match(/^f(\d+)$/);
    if (floatSize && ![2, 4, 8, 16].includes(Number(floatSize[1]))) {
      throw new UsageError(`invalid type string ${localeQuotedEscapedDiagnostic(originalFormat)};\nthis system doesn't provide a ${floatSize[1]}-byte floating point type`);
    }
    odFormatSize(text);
    return;
  }
  const kind = text[0] ?? "";
  if (!"doux".includes(kind)) throw new UsageError(`invalid character '${kind}' in type string ${localeQuotedEscapedDiagnostic(originalFormat)}`);
  const suffix = text.slice(1);
  if (suffix === "" || ["C", "S", "I", "L"].includes(suffix)) return;
  if (/^\d+$/.test(suffix)) {
    const size = Number(suffix);
    if (![1, 2, 4, 8].includes(size)) throw new UsageError(`invalid type string ${localeQuotedEscapedDiagnostic(originalFormat)};\nthis system doesn't provide a ${suffix}-byte integral type`);
    return;
  }
  throw new UsageError(`invalid character '${suffix[0]}' in type string ${localeQuotedEscapedDiagnostic(originalFormat)}`);
}

export function formatOdChunk(chunk, format, endian = "little", multiFormat = false, groupFormats = [format]) {
  format = normalizeOdFormat(format).format;
  const size = odFormatSize(format);
  const parts = [];
  for (let i = 0; i < chunk.length; i += size) {
    const bytes = chunk.slice(i, i + size);
    if (format === "c" || format === "a") {
      parts.push(formatOdChar(bytes[0], format === "a"));
    } else if (format.startsWith("f")) {
      parts.push(formatOdFloat(bytes, format, endian));
    } else {
      const value = [...bytes].reduce((sum, byte, idx) => sum + BigInt(byte) * (1n << BigInt(8 * (endian === "big" ? bytes.length - idx - 1 : idx))), 0n);
      if (format.startsWith("x")) {
        const text = value.toString(16).padStart(size * 2, "0");
        parts.push(multiFormat ? text.padStart(odMultiFormatFieldWidth(format, size, groupFormats)) : text.padStart(odFieldWidth(format, size), "0"));
      }
      else if (format.startsWith("u")) parts.push(value.toString().padStart(multiFormat ? odMultiFormatFieldWidth(format, size, groupFormats) : odFieldWidth(format, size)));
      else if (format.startsWith("d")) parts.push(signExtendBigInt(value, size).toString().padStart(multiFormat ? odMultiFormatFieldWidth(format, size, groupFormats) : odFieldWidth(format, size)));
      else {
        const text = value.toString(8).padStart(odFieldWidth(format, size), "0");
        parts.push(multiFormat ? text.padStart(odMultiFormatFieldWidth(format, size, groupFormats)) : text);
      }
    }
  }
  return parts.join(" ");
}

export function odFullLineBodyWidth(format, lineWidth, multiFormat = false, groupFormats = [format]) {
  const size = odFormatSize(format);
  const fields = Math.floor(lineWidth / size);
  if (fields <= 0) return 0;
  const fieldWidth = format === "a" || format === "c" ? 3 : odMultiFormatFieldWidth(format, size, groupFormats, multiFormat);
  return fields * fieldWidth + Math.max(0, fields - 1);
}

export function formatOdFloat(bytes, format, endian = "little") {
  const size = odFormatSize(format);
  const buffer = new Uint8Array(size);
  buffer.set(bytes.slice(0, size));
  if (size === 16) return odFloat128Placeholder(buffer, endian).padStart(24);
  const view = new DataView(buffer.buffer);
  const littleEndian = endian !== "big";
  const value = format === "fB"
    ? odBfloat16Value(view.getUint16(0, littleEndian))
    : size === 2
      ? odFloat16Value(view.getUint16(0, littleEndian))
      : size === 4
        ? view.getFloat32(0, littleEndian)
        : view.getFloat64(0, littleEndian);
  return formatOdFloatValue(value, size, format);
}

export function odFloat16Value(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 2 ** 10);
  return sign * 2 ** (exponent - 15) * (1 + fraction / 2 ** 10);
}

export function odBfloat16Value(bits) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, bits << 16, false);
  return view.getFloat32(0, false);
}

export function formatOdFloatValue(value, size, format = "") {
  const width = size === 2 || size === 4 ? 15 : 24;
  if (!Number.isFinite(value)) return String(value).padStart(width);
  const text = Number.isInteger(value)
    ? String(value)
    : size === 2
      ? trimOdFloatText(value.toPrecision(8))
      : size === 4
      ? trimOdFloatText(value.toPrecision(format === "fB" ? 8 : 7))
      : trimOdFloatText(value.toPrecision(16));
  return text.padStart(width);
}

export function trimOdFloatText(text) {
  return text.replace(/(\.\d*?[1-9])0+(e[+-]?\d+)$/iu, "$1$2").replace(/\.0+(e[+-]?\d+)$/iu, "$1").replace(/(\.\d*?[1-9])0+$/u, "$1").replace(/\.0+$/u, "");
}

export function odFloat128Placeholder(bytes, endian = "little") {
  const ordered = endian === "big" ? [...bytes] : [...bytes].reverse();
  const value = ordered.reduce((sum, byte) => (sum << 8n) + BigInt(byte), 0n);
  return value.toString();
}

export function formatOdAscii(chunk) {
  let out = ">";
  for (const byte of chunk) out += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".";
  return `${out}<`;
}

export function formatOdStrings(data, minLength, start, radix, allowFinalUnterminated = false) {
  if (!Number.isFinite(minLength) || minLength < 0) throw new UsageError(`invalid suffix in -S argument '${minLength}'`);
  let out = "";
  let runStart = -1;
  for (let i = 0; i <= data.length; i++) {
    const byte = i < data.length ? data[i] : 0;
    const printable = i < data.length && byte >= 32 && byte < 127;
    if (printable) {
      if (runStart === -1) runStart = i;
      continue;
    }
    if (runStart !== -1) {
      const length = i - runStart;
      if (((i < data.length && byte === 0) || (i === data.length && allowFinalUnterminated)) && length >= minLength) {
        const address = formatOffset(start + runStart, radix);
        const text = new TextDecoder().decode(data.slice(runStart, i));
        out += `${address}${address ? " " : ""}${text}\n`;
      }
      runStart = -1;
    } else if (i < data.length && byte === 0 && minLength === 0) {
      const address = formatOffset(start + i, radix);
      out += `${address}${address ? " " : ""}\n`;
    }
  }
  return out;
}

export function odFormatSize(format) {
  format = normalizeOdFormat(format).format;
  if (format === "a" || format === "c") return 1;
  if (format === "fH" || format === "fB") return 2;
  const floatSize = String(format).match(/^f(\d+)$/);
  if (floatSize) {
    const size = Number(floatSize[1]);
    if (![2, 4, 8, 16].includes(size)) throw new UsageError(`this system doesn't provide a ${size}-byte floating point type`);
    return size;
  }
  if (format === "fF") return 4;
  if (format === "fD" || format === "fL" || format === "f") return 8;
  const match = String(format).match(/[doux](\d+|C|S|I|L)?/);
  const value = match?.[1];
  if (value === "C") return 1;
  if (value === "S") return 2;
  if (value === "I") return 4;
  if (value === "L") return 8;
  return Number(value ?? (format === "c" || format === "a" ? 1 : 4));
}

export function odFieldWidth(format, size, multiFormat = false) {
  if (format.startsWith("x")) return multiFormat && size === 1 ? 3 : size * 2;
  if (format.startsWith("o")) return Math.ceil(size * 8 / 3);
  if (format.startsWith("u")) return ({ 1: 3, 2: 5, 4: 10, 8: 20 })[size] ?? String(2n ** BigInt(size * 8) - 1n).length;
  if (format.startsWith("d")) return ({ 1: 4, 2: 6, 4: 11, 8: 20 })[size] ?? String(2n ** BigInt(size * 8 - 1)).length + 1;
  return size;
}

export function odMultiFormatFieldWidth(format, size, groupFormats, multiFormat = true) {
  if (!multiFormat) return odFieldWidth(format, size, multiFormat);
  const normalizedGroup = groupFormats.map((groupFormat) => normalizeOdFormat(groupFormat).format);
  const unitSize = Math.min(...normalizedGroup.map(odFormatSize));
  const unitWidth = Math.max(...normalizedGroup
    .filter((groupFormat) => odFormatSize(groupFormat) === unitSize)
    .map((groupFormat) => groupFormat === "a" || groupFormat === "c" ? 3 : odFieldWidth(groupFormat, unitSize, true)));
  const unitCount = size % unitSize === 0 ? size / unitSize : 1;
  const alignedWidth = unitCount * unitWidth + Math.max(0, unitCount - 1);
  return Math.max(odFieldWidth(format, size, true), alignedWidth);
}

export function formatOdChar(byte, named = false) {
  const asciiNames = ["nul", "soh", "stx", "etx", "eot", "enq", "ack", "bel", "bs", "ht", "nl", "vt", "ff", "cr", "so", "si", "dle", "dc1", "dc2", "dc3", "dc4", "nak", "syn", "etb", "can", "em", "sub", "esc", "fs", "gs", "rs", "us"];
  if (named) {
    const ascii = byte & 0x7f;
    if (ascii < asciiNames.length) return asciiNames[ascii].padStart(3);
    if (ascii === 32) return " sp";
    if (ascii === 127) return "del";
    return String.fromCharCode(ascii).padStart(3);
  }
  const escapes = { 0: "\\0", 7: "\\a", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r" };
  if (escapes[byte]) return escapes[byte].padStart(3);
  if (byte >= 32 && byte < 127) return String.fromCharCode(byte).padStart(3);
  return byte.toString(8).padStart(3, "0");
}

export function signExtendBigInt(value, size) {
  const bits = BigInt(size * 8);
  const sign = 1n << (bits - 1n);
  const mod = 1n << bits;
  return value >= sign ? value - mod : value;
}

const singleCall = defineCommand("od", odCmd, odMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
