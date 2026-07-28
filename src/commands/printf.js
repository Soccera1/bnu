#!/usr/bin/env bun

import { concatBytes, enc, localeQuotedEscapedDiagnostic, pad, shellQuote } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const PRINTF_STOP = "\uE000PRINTF_STOP\uE000";

export const PRINTF_RAW_BYTE_BASE = 0xe100;

export function formatPrintf(format, values, warnings = []) {
  return formatPrintfResult(format, values, warnings).text;
}

export function formatPrintfResult(format, values, warnings = []) {
  let sequentialIndex = 0;
  let highestReferenced = 0;
  let status = 0;
  let fatal = false;
  let text = "";
  const takeArg = (index) => {
    const argIndex = index == null ? sequentialIndex++ : index - 1;
    highestReferenced = Math.max(highestReferenced, argIndex + 1);
    return { value: values[argIndex], missing: argIndex >= values.length };
  };
  for (let i = 0; i < format.length;) {
    if (format[i] === "\\") {
      const escape = parsePrintfEscape(format, i);
      text += escape.text;
      i += escape.length;
      continue;
    }
    if (format[i] !== "%") {
      text += format[i++];
      continue;
    }
    const conv = parsePrintfConversion(format, i);
    if (conv.percent) {
      text += "%";
      i += conv.length;
      continue;
    }
    let { flags, width, precision, type } = conv;
    if (width?.star) {
      const parsed = parsePrintfControlNumber(takeArg(width.index).value, warnings, "field width");
      if (!parsed.ok) status = 1;
      if (parsed.fatal) fatal = true;
      width = parsed.value;
      if (width < 0) {
        flags += "-";
        width = Math.abs(width);
      }
    }
    if (precision?.star) {
      const parsed = parsePrintfControlNumber(takeArg(precision.index).value, warnings, "precision");
      if (!parsed.ok) status = 1;
      if (parsed.fatal) fatal = true;
      precision = parsed.value < 0 ? undefined : parsed.value;
    }
    width = width?.value ?? width;
    precision = precision?.value ?? precision;
    if (width != null) width = Number(width);
    if (precision != null) precision = Number(precision);
    const arg = takeArg(conv.index);
    const value = arg.value ?? "";
    let rendered;
    if (type === "b") rendered = String(value).replace(/\\(U[0-9a-fA-F]{8}|u[0-9a-fA-F]{4}|0[0-7]{0,3}|[0-7]{1,3}|x[0-9a-fA-F]{1,2}|[abcefnrtv\\])/g, (_, e) => decodeEscape(e));
    else if (type === "q") rendered = pad(shellQuote(String(value)), width, flags);
    else if (type === "s") {
      const valueText = precision == null ? String(value) : String(value).slice(0, Number(precision));
      rendered = pad(valueText, width, flags);
    }
    else if (type === "c") rendered = pad(String(value)[0] ?? "\0", width, flags);
    else {
      const beforeWarnings = warnings.length;
      const n = arg.missing ? 0 : parsePrintfNumber(value, warnings, type);
      if (warnings.length !== beforeWarnings) status = 1;
      let out;
      if ("diuoxX".includes(type)) {
        let int = typeof n === "bigint" ? n : BigInt(Math.trunc(n || 0));
        if ("di".includes(type)) {
          const min = -(1n << 63n);
          const max = (1n << 63n) - 1n;
          if (int < min || int > max) {
            warnings.push(`printf: ${localeQuotedEscapedDiagnostic(value)}: Numerical result out of range`);
            status = 1;
            int = int < min ? min : max;
          }
        } else if (int > (1n << 64n) - 1n) {
          warnings.push(`printf: ${localeQuotedEscapedDiagnostic(value)}: Numerical result out of range`);
          status = 1;
          int = (1n << 64n) - 1n;
        }
        const unsigned = "uoxX".includes(type) && int < 0n ? BigInt.asUintN(64, int) : null;
        const sign = unsigned == null && int < 0n ? "-" : flags.includes("+") && "di".includes(type) ? "+" : flags.includes(" ") && "di".includes(type) ? " " : "";
        const magnitude = unsigned ?? (int < 0n ? -int : int);
        const rawDigits = precision === 0 && magnitude === 0n
          ? ""
          : type === "o"
          ? magnitude.toString(8)
          : type === "x"
            ? magnitude.toString(16)
            : type === "X"
              ? magnitude.toString(16).toUpperCase()
              : String(magnitude);
        const digits = applyIntegerPrecision(rawDigits, precision);
        const prefix = flags.includes("#") && type === "o" && !digits.startsWith("0")
          ? "0"
          : flags.includes("#") && type === "x" && magnitude !== 0n
            ? "0x"
            : flags.includes("#") && type === "X" && magnitude !== 0n
              ? "0X"
              : "";
        out = formatPrintfInteger(sign, prefix, digits, width, flags, precision);
        if (precision != null) flags = flags.replace("0", "");
      }
      else out = formatPrintfFloat(n ?? 0, type, precision, flags);
      rendered = "diuoxX".includes(type) ? out : pad(out, width, flags);
    }
    text += rendered;
    i += conv.length;
  }
  return { text: fatal ? "" : text, consumed: Math.max(sequentialIndex, highestReferenced), status, fatal };
}

export function parsePrintfEscape(format, offset) {
  const rest = format.slice(offset + 1);
  const match = rest.match(/^(U[0-9a-fA-F]{8}|u[0-9a-fA-F]{4}|[0-7]{1,3}|x[0-9a-fA-F]{1,2}|[abcefnrtv\\])/);
  if (!match) return { text: format[offset], length: 1 };
  return { text: decodeEscape(match[1]), length: 1 + match[1].length };
}

export function parsePrintfConversion(format, offset) {
  if (format[offset + 1] === "%") return { percent: true, length: 2 };
  if (format[offset + 1] === "(") return { invalid: "%(", length: 2 };
  let i = offset + 1;
  let index;
  const indexMatch = format.slice(i).match(/^(\d+)\$/);
  if (indexMatch) {
    index = Number(indexMatch[1]);
    i += indexMatch[0].length;
  }
  const flagsStart = i;
  while (/[0 +'#-]/.test(format[i] ?? "")) i++;
  const flags = format.slice(flagsStart, i);
  let width;
  if (format[i] === "*") {
    i++;
    const widthIndex = format.slice(i).match(/^(\d+)\$/);
    if (widthIndex) {
      width = { star: true, index: Number(widthIndex[1]) };
      i += widthIndex[0].length;
    } else {
      width = { star: true };
    }
  } else {
    const widthMatch = format.slice(i).match(/^\d+/);
    if (widthMatch) {
      width = { value: widthMatch[0] };
      i += widthMatch[0].length;
    }
  }
  let precision;
  if (format[i] === ".") {
    i++;
    if (format[i] === "*") {
      i++;
      const precisionIndex = format.slice(i).match(/^(\d+)\$/);
      if (precisionIndex) {
        precision = { star: true, index: Number(precisionIndex[1]) };
        i += precisionIndex[0].length;
      } else {
        precision = { star: true };
      }
    } else {
      const precisionMatch = format.slice(i).match(/^\d*/)[0];
      precision = { value: precisionMatch === "" ? "0" : precisionMatch };
      i += precisionMatch.length;
    }
  }
  if (format[i] === "L") i++;
  const type = format[i];
  if (!/[abcdeEfFgiGosuxXAq]/.test(type ?? "")) {
    const dollar = format.slice(offset, i + 1).match(/^%.*?\$/);
    const invalid = dollar?.[0] ?? (format.slice(offset).match(/^%[^A-Za-z%]*[A-Za-z]/)?.[0] ?? "%");
    return { invalid, length: invalid.length };
  }
  return { length: i - offset + 1, index, flags, width, precision, type };
}

export function applyIntegerPrecision(digits, precision) {
  if (precision == null) return digits;
  return digits.padStart(Number(precision), "0");
}

export function formatPrintfInteger(sign, prefix, digits, width, flags = "", precision = undefined) {
  const value = `${sign}${prefix}${digits}`;
  const n = Number(width);
  if (!Number.isInteger(n) || value.length >= n) return value;
  const padding = " ".repeat(n - value.length);
  if (flags.includes("-")) return value + padding;
  if (flags.includes("0") && precision == null) return `${sign}${prefix}${"0".repeat(n - value.length)}${digits}`;
  return padding + value;
}

export function formatPrintfFloat(value, type, precision, flags = "") {
  const p = precision == null ? 6 : Number(precision);
  const uppercase = type === "A" || type === "E" || type === "F" || type === "G";
  if (typeof value === "object" && value?.special === "nan") {
    const out = `${value.negative ? "-" : ""}nan`;
    return uppercase ? out.toUpperCase() : out;
  }
  if (typeof value === "object" && value?.special === "decimal-overflow") {
    return formatPrintfDecimalOverflow(value, type, p);
  }
  if (Number.isNaN(value)) return uppercase ? "NAN" : "nan";
  if (!Number.isFinite(value)) {
    const out = value < 0 ? "-inf" : "inf";
    return uppercase ? out.toUpperCase() : out;
  }
  if (type === "e" || type === "E") {
    const out = value.toExponential(p).replace(/e([+-])(\d)$/i, "e$10$2");
    return type === "E" ? out.toUpperCase() : out;
  }
  if (type === "a" || type === "A") return formatPrintfHexFloat(value, type, precision, flags.includes("#"));
  if (type === "g" || type === "G") {
    const out = value.toPrecision(p).replace(/(\.\d*?)0+(e|$)/i, "$1$2").replace(/\.(e|$)/i, "$1").replace(/e([+-])(\d)$/i, "e$10$2");
    return type === "G" ? out.toUpperCase() : out;
  }
  return value.toFixed(p);
}

export function formatPrintfHexFloat(value, type, precision, alternate = false) {
  const uppercase = type === "A";
  const negative = Object.is(value, -0) || value < 0;
  const abs = Math.abs(value);
  if (abs === 0) {
    const fraction = precision == null ? "" : "0".repeat(Number(precision));
    const point = alternate || fraction ? "." : "";
    return `${negative ? "-" : ""}${uppercase ? "0X" : "0x"}0${point}${fraction}${uppercase ? "P" : "p"}+0`;
  }
  const requested = precision == null ? 13 : Number(precision);
  let exponent = Math.floor(Math.log2(abs)) - 3;
  let scaled = abs / 2 ** exponent;
  while (scaled < 8) {
    scaled *= 2;
    exponent--;
  }
  while (scaled >= 16) {
    scaled /= 2;
    exponent++;
  }
  const rounded = roundedHexFloatDigits(scaled, requested);
  let digits = rounded.digits;
  if (rounded.carry) exponent++;
  let head = digits[0];
  let fraction = digits.slice(1);
  if (precision == null) fraction = fraction.replace(/0+$/, "");
  const point = alternate || fraction ? "." : "";
  let out = `${negative ? "-" : ""}0x${head}${point}${fraction}p${exponent < 0 ? "" : "+"}${exponent}`;
  return uppercase ? out.toUpperCase() : out;
}

export function roundedHexFloatDigits(value, precision) {
  const count = precision + 1;
  const digits = [];
  let rest = value;
  for (let i = 0; i < count + 1; i++) {
    const digit = Math.floor(rest);
    digits.push(Math.max(0, Math.min(15, digit)));
    rest = (rest - digit) * 16;
  }
  if (digits[count] >= 8) {
    let carry = 1;
    for (let i = count - 1; i >= 0 && carry; i--) {
      const next = digits[i] + carry;
      digits[i] = next & 0xf;
      carry = next > 0xf ? 1 : 0;
    }
    if (carry) {
      digits.unshift(1);
      digits.length = count;
      return { digits: digits.map((digit) => digit.toString(16)).join(""), carry: true };
    }
  }
  return { digits: digits.slice(0, count).map((digit) => digit.toString(16)).join(""), carry: false };
}

export function formatPrintfDecimalOverflow(value, type, precision) {
  const significant = type === "e" || type === "E" ? precision + 1 : Math.max(precision, 1);
  const rounded = roundDecimalOverflowDigits(value.digits, value.exponent, significant);
  const expText = `${rounded.exponent < 0 ? "-" : "+"}${String(Math.abs(rounded.exponent)).padStart(2, "0")}`;
  let body;
  if (type === "e" || type === "E") {
    const rest = rounded.digits.slice(1).padEnd(precision, "0");
    body = `${rounded.digits[0]}${precision > 0 ? `.${rest}` : ""}e${expText}`;
  } else {
    const rest = rounded.digits.slice(1).replace(/0+$/, "");
    body = `${rounded.digits[0]}${rest ? `.${rest}` : ""}e${expText}`;
  }
  if (value.negative) body = `-${body}`;
  return type === "E" || type === "G" ? body.toUpperCase() : body;
}

export function roundDecimalOverflowDigits(digits, exponent, significant) {
  let kept = digits.slice(0, significant).padEnd(significant, "0");
  const next = Number(digits[significant] ?? "0");
  if (next >= 5) {
    let carry = 1;
    const chars = [...kept];
    for (let i = chars.length - 1; i >= 0 && carry; i--) {
      const n = Number(chars[i]) + carry;
      chars[i] = String(n % 10);
      carry = n >= 10 ? 1 : 0;
    }
    kept = carry ? `1${chars.join("")}` : chars.join("");
    if (carry) exponent++;
  }
  return { digits: kept.slice(0, significant), exponent };
}

export function parsePrintfControlNumber(value, warnings, kind = "number") {
  if (value === undefined) return { ok: true, value: 0 };
  const text = String(value ?? "");
  const warningCount = warnings.length;
  const n = parsePrintfIntegerNumber(text, warnings);
  const ok = warnings.length === warningCount;
  if (n > 2147483647n || n < -2147483648n) {
    warnings.push(kind === "number" ? `printf: invalid number: ${localeQuotedEscapedDiagnostic(text)}` : `printf: invalid ${kind}: ${localeQuotedEscapedDiagnostic(text)}`);
    return { ok: false, value: 0, fatal: true };
  }
  return { ok, value: Number(n) };
}

export function parsePrintfNumber(value, warnings, type = "") {
  const text = String(value ?? "");
  if (text.startsWith("'") || text.startsWith('"')) {
    const chars = [...text.slice(1)];
    if (chars.length >= 1) {
      if (chars.length > 1) warnings.push(`printf: warning: ${chars[1]}: character(s) following character constant have been ignored`);
      return chars[0] === "\uFFFD" ? 0xe1 : chars[0].codePointAt(0);
    }
    warnings.push(`printf: ${localeQuotedEscapedDiagnostic(text)}: expected a numeric value`);
    return 0;
  }
  if ("diuoxX".includes(type)) return parsePrintfIntegerNumber(text, warnings);
  if (/^[+-]?(?:inf(?:inity)?|nan)$/i.test(text)) return parsePrintfSpecialFloat(text);
  const exactBaseLiteral = text.match(/^[+-]?0[xX][0-9a-fA-F]+$/) || text.match(/^[+-]?0[bB][01]+$/);
  if (exactBaseLiteral) return Number(text);
  const match = text.match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
  if (!match) {
    warnings.push(`printf: ${localeQuotedEscapedDiagnostic(text)}: expected a numeric value`);
    return 0;
  }
  const n = Number(match[0]);
  if (match[0].length !== text.length) warnings.push(`printf: ${localeQuotedEscapedDiagnostic(text)}: value not completely converted`);
  if (!Number.isFinite(n) && "eEgG".includes(type)) return parsePrintfDecimalOverflow(match[0]);
  return n;
}

export function parsePrintfDecimalOverflow(text) {
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  const [mantissaText, exponentText = "0"] = unsigned.split(/[eE]/);
  const point = mantissaText.indexOf(".");
  const fractionalDigits = point === -1 ? 0 : mantissaText.length - point - 1;
  let digits = mantissaText.replace(".", "").replace(/^0+/, "");
  if (digits === "") digits = "0";
  let exponent = Number(exponentText) - fractionalDigits + digits.length - 1;
  if (digits === "0") exponent = 0;
  return { special: "decimal-overflow", negative, digits, exponent };
}

export function parsePrintfIntegerNumber(text, warnings) {
  const signMatch = text.match(/^[+-]?/)?.[0] ?? "";
  const rest = text.slice(signMatch.length);
  let digits;
  let base = 10;
  let consumed = signMatch.length;
  if (/^0[xX]/.test(rest)) {
    base = 16;
    digits = rest.slice(2).match(/^[0-9a-fA-F]*/)?.[0] ?? "";
    consumed += 2 + digits.length;
    if (digits === "") {
      warnings.push(`printf: ${localeQuotedEscapedDiagnostic(text)}: value not completely converted`);
      return 0;
    }
  } else if (/^0[bB]/.test(rest)) {
    base = 2;
    digits = rest.slice(2).match(/^[01]*/)?.[0] ?? "";
    consumed += 2 + digits.length;
    if (digits === "") {
      warnings.push(`printf: ${localeQuotedEscapedDiagnostic(text)}: value not completely converted`);
      return 0;
    }
  } else if (rest.startsWith("0")) {
    base = 8;
    digits = rest.match(/^[0-7]*/)?.[0] ?? "0";
    consumed += digits.length;
  } else {
    digits = rest.match(/^\d*/)?.[0] ?? "";
    consumed += digits.length;
    if (digits === "") {
      warnings.push(`printf: ${localeQuotedEscapedDiagnostic(text)}: expected a numeric value`);
      return 0;
    }
  }
  if (consumed !== text.length) warnings.push(`printf: ${localeQuotedEscapedDiagnostic(text)}: value not completely converted`);
  const magnitude = parseBigIntBase(digits || "0", base);
  return signMatch === "-" ? -magnitude : magnitude;
}

export function parseBigIntBase(digits, base) {
  let value = 0n;
  const bigBase = BigInt(base);
  for (const digit of digits) value = value * bigBase + BigInt(Number.parseInt(digit, base));
  return value;
}

export function parsePrintfSpecialFloat(text) {
  if (/nan/i.test(text)) return { special: "nan", negative: text.startsWith("-") };
  return text.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
}

export function decodeEscape(escape) {
  const simple = { a: "\x07", b: "\b", c: PRINTF_STOP, e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" };
  if (simple[escape] != null) return simple[escape];
  if (escape.startsWith("x")) return printfRawByte(Number.parseInt(escape.slice(1), 16));
  if (escape.startsWith("u") || escape.startsWith("U")) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
  return printfRawByte(Number.parseInt(escape, 8));
}

export function printfRawByte(byte) {
  return String.fromCharCode(PRINTF_RAW_BYTE_BASE + (byte & 0xff));
}

export function encodePrintfOutput(text) {
  const chunks = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    chunks.push(code >= PRINTF_RAW_BYTE_BASE && code <= PRINTF_RAW_BYTE_BASE + 0xff ? Uint8Array.of(code - PRINTF_RAW_BYTE_BASE) : enc.encode(ch));
  }
  return concatBytes(chunks);
}

export function validatePrintfFormat(format) {
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch === "\\") {
      const rest = format.slice(i + 1);
      if (rest.startsWith("x")) {
        const hex = rest.slice(1).match(/^[0-9a-fA-F]*/)[0];
        if (hex.length === 0) return { ok: false, message: "printf: missing hexadecimal number in escape" };
        i += 1 + hex.length;
      } else if (/^[uU]/.test(rest)) {
        const need = rest[0] === "u" ? 4 : 8;
        const hex = rest.slice(1, 1 + need);
        if (hex.length < need || !/^[0-9a-fA-F]+$/.test(hex)) return { ok: false, message: "printf: missing hexadecimal number in escape" };
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return { ok: false, message: `printf: invalid universal character name \\${rest[0]}${hex}` };
        i += 1 + need;
      } else if (/^[0-7]/.test(rest)) {
        i += Math.min(rest.match(/^[0-7]{1,3}/)[0].length, 3);
      } else if (rest) {
        i++;
      }
      continue;
    }
    if (ch !== "%") continue;
    const conv = parsePrintfConversion(format, i);
    if (conv.invalid) return { ok: false, message: `printf: ${conv.invalid}: invalid conversion specification` };
    if (conv.percent) {
      i += conv.length - 1;
      continue;
    }
    const token = format.slice(i, i + conv.length);
    const { flags = "", precision, type } = conv;
    const invalid =
      (flags.includes("'") && !["d", "i", "u", "f", "F", "g", "G"].includes(type)) ||
      (type === "d" && flags.includes("#")) ||
      (["b", "c", "q", "s"].includes(type) && flags.includes("0")) ||
      (type === "c" && precision != null) ||
      (type === "q" && (flags !== "" || conv.width != null || precision != null));
    if (invalid) return { ok: false, message: `printf: ${token}: invalid conversion specification` };
    i += conv.length - 1;
  }
  return { ok: true };
}

export async function printfCmd(args) {
  if (args[0] === "--") args = args.slice(1);
  if (!args.length) throw new UsageError("missing operand", true);
  const [format, ...values] = args;
  const validation = validatePrintfFormat(format);
  if (!validation.ok) {
    stderr(`${validation.message}\n`);
    return 1;
  }
  const streamedStatus = streamLargeSimplePrintf(format, values);
  if (streamedStatus != null) return streamedStatus;
  let out = "";
  let stop = false;
  const warnings = [];
  const append = (text) => {
    const idx = text.indexOf(PRINTF_STOP);
    if (idx === -1) {
      out += text;
      return;
    }
    out += text.slice(0, idx);
    stop = true;
  };
  if (!values.length) append(formatPrintf(format, [], warnings));
  else if (countPrintfConversions(format) === 0) {
    append(formatPrintf(format, [], warnings));
    warnings.push(`printf: warning: ignoring excess arguments, starting with '${values[0]}'`);
  }
  else {
    let status = 0;
    for (let i = 0; i < values.length && !stop;) {
      const before = i;
      const rendered = formatPrintfResult(format, values.slice(i), warnings);
      status ||= rendered.status;
      append(rendered.text);
      i += Math.max(1, rendered.consumed);
      if (i === before) break;
    }
    if (warnings.length) stderr(`${warnings.join("\n")}\n`);
    stdout(encodePrintfOutput(out));
    return status;
  }
  if (warnings.length) stderr(`${warnings.join("\n")}\n`);
  stdout(encodePrintfOutput(out));
  return 0;
}

export function streamLargeSimplePrintf(format, values) {
  if (!format.startsWith("%")) return null;
  const conversion = parsePrintfConversion(format, 0);
  if (conversion.invalid || conversion.percent || conversion.length !== format.length || conversion.index != null) return null;
  if (conversion.width?.star || conversion.precision?.star) return null;
  const width = Number(conversion.width?.value);
  if (!Number.isSafeInteger(width) || width < 1024 * 1024 || conversion.flags?.includes("0")) return null;
  const precision = conversion.precision?.value;
  const coreFormat = `%${conversion.flags ?? ""}${precision == null ? "" : `.${precision}`}${conversion.type}`;
  const warnings = [];
  let status = 0;
  let index = 0;
  const iterations = values.length ? Infinity : 1;
  for (let iteration = 0; iteration < iterations && (values.length === 0 ? iteration === 0 : index < values.length); iteration++) {
    const rendered = formatPrintfResult(coreFormat, values.slice(index), warnings);
    status ||= rendered.status;
    if (rendered.fatal) break;
    const padding = Math.max(0, width - rendered.text.length);
    if (conversion.flags?.includes("-")) {
      stdout(encodePrintfOutput(rendered.text));
      writePrintfPadding(padding, 0x20);
    } else {
      writePrintfPadding(padding, 0x20);
      stdout(encodePrintfOutput(rendered.text));
    }
    if (!values.length) break;
    index += Math.max(1, rendered.consumed);
  }
  if (warnings.length) stderr(`${warnings.join("\n")}\n`);
  return status;
}

export function writePrintfPadding(length, byte) {
  if (length <= 0) return;
  const block = Buffer.alloc(Math.min(64 * 1024, length), byte);
  let remaining = length;
  while (remaining > 0) {
    const count = Math.min(block.length, remaining);
    stdout(count === block.length ? block : block.subarray(0, count));
    remaining -= count;
  }
}

export function countPrintfConversions(format) {
  let count = 0;
  for (let i = 0; i < format.length;) {
    if (format[i] === "\\") {
      i += parsePrintfEscape(format, i).length;
    } else if (format[i] === "%") {
      const conv = parsePrintfConversion(format, i);
      if (!conv.percent && !conv.invalid) count++;
      i += conv.length || 1;
    } else {
      i++;
    }
  }
  return count;
}

const singleCall = defineCommand("printf", printfCmd, (args) => args.length === 1 && (args[0] === "--help" || args[0] === "--version") ? args[0] : null);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
