#!/usr/bin/env bun

import { invalidOptionMessage, isWriteError, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, lsEscapedName, normalizeLongOptionByPrefix, parentIgnoresSigpipe } from "../shared/common.js";
import { UsageError, stderr, writeAllSync } from "../shared/diagnostics.js";
import { outputWriteErrorMessage } from "../shared/runtime.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const SEQ_LONG_OPTIONS = ["equal-width", "format", "separator", "help", "version"];

export function seqMetaOption(args) {
  const longValueOptions = new Set(["format", "separator"]);
  const shortValueOptions = new Set(["f", "s"]);
  const shortKnownOptions = new Set(["f", "s", "w"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeSeqLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!SEQ_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (inlineValue == null && longValueOptions.has(name)) i++;
      continue;
    }
    if (/^-(?:[0-9.]|nan$)/i.test(arg) || !arg.startsWith("-")) return null;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        if (arg.slice(j + 1) === "") i++;
        break;
      }
    }
  }
  return null;
}

export async function seq(args) {
  const { opts, operands } = parseSeqOptions(args);
  if (operands.length < 1) throw new UsageError("missing operand", true);
  if (operands.length > 3) throw new UsageError(`extra operand ${seqDiagnosticQuote(operands[3])}`, true);
  const [firstText, incText, lastText] = operands.length === 1 ? ["1", "1", operands[0]] : operands.length === 2 ? [operands[0], "1", operands[1]] : operands;
  const format = opts.f ?? opts.format;
  if (format != null) validateSeqFormat(format);
  if (format == null && seqCanUseBigInt(firstText, incText, lastText)) return seqBigInt(firstText, incText, lastText, opts);
  const [first, inc, last] = [parseSeqNumber(firstText), parseSeqNumber(incText), parseSeqNumber(lastText)];
  const firstOrIncInvalid = [[firstText, first], [incText, inc]].find(([, value]) => Number.isNaN(value));
  if (firstOrIncInvalid) {
    const [text] = firstOrIncInvalid;
    const invalidText = String(text);
    throw new UsageError(/^[+-]?nan$/i.test(invalidText.trim()) ? `invalid ${localeQuotedDiagnostic("not-a-number")} argument: ${seqDiagnosticQuote(text)}` : `invalid floating point argument: ${seqDiagnosticQuote(text)}`, true);
  }
  if (Object.is(inc, 0) || Object.is(inc, -0)) throw new UsageError(`invalid Zero increment value: ${seqDiagnosticQuote(incText)}`, true);
  if (Number.isNaN(last)) {
    const invalidText = String(lastText);
    throw new UsageError(/^[+-]?nan$/i.test(invalidText.trim()) ? `invalid ${localeQuotedDiagnostic("not-a-number")} argument: ${seqDiagnosticQuote(lastText)}` : `invalid floating point argument: ${seqDiagnosticQuote(lastText)}`, true);
  }
  const sep = opts.s ?? opts.separator ?? "\n";
  const tolerance = Math.abs(inc) * 1e-12;
  const defaultPrecision = opts.f || opts.format ? null : seqFixedPrecision([firstText, incText]);
  const finiteWidthValues = Number.isFinite(first) && Number.isFinite(inc) && Number.isFinite(last) ? seqFiniteValues(first, inc, last, tolerance) : [];
  const width = opts.w || opts.equal_width ? seqEqualWidth(finiteWidthValues.length ? finiteWidthValues : [first, last].filter(Number.isFinite), defaultPrecision) : 0;
  let wrote = false;
  try {
    for (let step = 0;; step++) {
      const raw = first + inc * step;
      if (Number.isNaN(raw)) break;
      if (inc > 0 ? raw > last + tolerance : raw < last - tolerance) break;
      const n = Math.abs(raw) < tolerance ? 0 : raw;
      let s = defaultPrecision == null ? formatSeqDefaultNumber(n) : n.toFixed(defaultPrecision);
      if (step === 0 && /^-0(?:\.0*)?(?:e[+-]?\d+)?$/i.test(String(firstText).trim()) && n === 0) s = defaultPrecision == null ? "-0" : `-${s}`;
      if (width) s = padSeqEqualWidth(s, width);
      if (format != null) s = formatSeqValue(format, n);
      if (wrote) seqWrite(sep);
      seqWrite(s);
      wrote = true;
    }
    if (wrote) seqWrite("\n");
  } catch (error) {
    if (isWriteError(error)) {
      if (error?.code === "EPIPE") {
        if (parentIgnoresSigpipe()) stderr(`seq: write error: ${outputWriteErrorMessage(error)}\n`);
        return parentIgnoresSigpipe() ? 1 : 0;
      }
      stderr(`seq: write error: ${outputWriteErrorMessage(error)}\n`);
      return 1;
    }
    throw error;
  }
  return 0;
}

export function seqWrite(data) {
  writeAllSync(1, String(data));
}

export function seqFiniteValues(first, inc, last, tolerance) {
  const values = [];
  for (let step = 0;; step++) {
    const n = first + inc * step;
    if (inc > 0 ? n > last + tolerance : n < last - tolerance) break;
    values.push(Math.abs(n) < tolerance ? 0 : n);
    if (values.length > 100000) break;
  }
  return values;
}

export function parseSeqNumber(value) {
  const text = seqNumberText(value);
  if (text == null) return Number.NaN;
  if (/^[+-]?inf(?:inity)?$/i.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  const hex = text.match(/^([+-])?0x([0-9a-f]+)(?:\.([0-9a-f]*))?p([+-]?\d+)$/i);
  if (hex) {
    const sign = hex[1] === "-" ? -1 : 1;
    const integer = Number.parseInt(hex[2], 16);
    const fraction = [...(hex[3] ?? "")].reduce((sum, ch, index) => sum + Number.parseInt(ch, 16) / 16 ** (index + 1), 0);
    return sign * (integer + fraction) * 2 ** Number(hex[4]);
  }
  return Number(text);
}

export function seqNumberText(value) {
  const text = String(value).trimStart();
  return /\s$/.test(text) ? null : text;
}

export function seqDiagnosticQuote(value) {
  return localeQuotedDiagnostic([...String(value)].map((ch) => {
    if (/[\udc80-\udcff]/.test(ch)) return `\\${(ch.charCodeAt(0) - 0xdc00).toString(8).padStart(3, "0")}`;
    return lsEscapedName(ch, { escapeDouble: false });
  }).join(""));
}

export function parseSeqOptions(args) {
  const opts = {};
  const operands = [];
  let parseOptions = true;
  const requireValue = (index, option) => {
    if (index + 1 < args.length) return args[index + 1];
    if (option.startsWith("--")) throw new UsageError(`option '${option}' requires an argument`, true);
    throw new UsageError(`option requires an argument -- '${option.slice(1)}'`, true);
  };
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (!parseOptions) {
      operands.push(arg);
    } else if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith("--")) {
      arg = normalizeSeqLongOption(arg);
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (!SEQ_LONG_OPTIONS.includes(name)) throw new UsageError(invalidOptionMessage(arg), true);
      if (name === "help" || name === "version" || name === "equal-width") {
        if (inlineValue != null) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
        if (name === "equal-width") opts.equal_width = true;
      } else if (name === "separator") {
        if (inlineValue != null) opts.separator = inlineValue;
        else {
          opts.separator = requireValue(i, arg);
          i++;
        }
      } else if (name === "format") {
        if (inlineValue != null) opts.format = inlineValue;
        else {
          opts.format = requireValue(i, arg);
          i++;
        }
      }
    } else if (arg === "-w") {
      opts.w = true;
    } else if (arg === "-s") {
      opts.s = requireValue(i, arg);
      i++;
    } else if (arg.startsWith("-s") && arg.length > 2) {
      opts.s = arg.slice(2);
    } else if (arg === "-f") {
      opts.f = requireValue(i, arg);
      i++;
    } else if (/^-[0-9.]/.test(arg) || !arg.startsWith("-")) {
      operands.push(arg);
      parseOptions = false;
    } else {
      throw new UsageError(invalidOptionMessage(arg), true);
    }
  }
  return { opts, operands };
}

export function normalizeSeqLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, SEQ_LONG_OPTIONS);
}

export function seqFixedPrecision(values) {
  let precision = 0;
  for (const value of values) {
    precision = Math.max(precision, seqDecimalPrecision(value));
  }
  return precision || null;
}

export function seqCanUseBigInt(firstText, incText, lastText) {
  return [firstText, incText].every(seqIntegerText) && (seqIntegerText(lastText) || seqInfinityText(lastText) != null);
}

export function seqBigInt(firstText, incText, lastText, opts) {
  const first = BigInt(String(firstText).trim());
  const inc = BigInt(String(incText).trim());
  const infinity = seqInfinityText(lastText);
  const last = infinity == null ? BigInt(String(lastText).trim()) : infinity;
  if (inc === 0n) throw new UsageError(`invalid Zero increment value: ${localeQuotedDiagnostic(incText)}`, true);
  const sep = opts.s ?? opts.separator ?? "\n";
  const finite = typeof last === "bigint";
  const width = opts.w || opts.equal_width
    ? finite
      ? Math.max(first.toString().length, last.toString().length)
      : first.toString().length
    : 0;
  let wrote = false;
  try {
    for (let value = first; seqBigIntContinues(value, inc, last); value += inc) {
      if (wrote) seqWrite(sep);
      seqWrite(width ? padSeqEqualWidth(value.toString(), width) : value.toString());
      wrote = true;
    }
    if (wrote) seqWrite("\n");
  } catch (error) {
    if (isWriteError(error)) {
      if (error?.code === "EPIPE") {
        if (parentIgnoresSigpipe()) stderr(`seq: write error: ${outputWriteErrorMessage(error)}\n`);
        return parentIgnoresSigpipe() ? 1 : 0;
      }
      stderr(`seq: write error: ${outputWriteErrorMessage(error)}\n`);
      return 1;
    }
    throw error;
  }
  return 0;
}

export function seqIntegerText(value) {
  const text = seqNumberText(value);
  if (text == null) return false;
  return /^[+-]?\d+$/.test(text) && !/^-0+$/.test(text);
}

export function seqInfinityText(value) {
  const text = seqNumberText(value);
  if (text == null) return null;
  if (/^\+?inf(?:inity)?$/i.test(text)) return Infinity;
  if (/^-inf(?:inity)?$/i.test(text)) return -Infinity;
  return null;
}

export function seqBigIntContinues(value, inc, last) {
  if (last === Infinity) return inc > 0n;
  if (last === -Infinity) return inc < 0n;
  return inc > 0n ? value <= last : value >= last;
}

export function seqDecimalPrecision(value) {
  const text = (seqNumberText(value) ?? String(value).trim()).replace(/^["']|["']$/g, "");
  const match = text.match(/^[+-]?(?:(\d*)\.(\d*)|(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) return 0;
  const decimals = (match[2] ?? "").length;
  const exponent = Number(match[4] ?? 0);
  return Math.max(0, decimals - exponent);
}

export function seqEqualWidth(values, precision) {
  return Math.max(...values.map((value) => {
    const rendered = precision == null ? formatSeqDefaultNumber(value) : value.toFixed(precision);
    return rendered.length;
  }));
}

export function formatSeqDefaultNumber(value) {
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  return Number.isInteger(value) ? String(value) : String(value);
}

export function padSeqEqualWidth(text, width) {
  if (text.startsWith("-")) return `-${text.slice(1).padStart(Math.max(0, width - 1), "0")}`;
  return text.padStart(width, "0");
}

export function validateSeqFormat(format) {
  const text = String(format);
  let directives = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "%") continue;
    if (text[i + 1] === "%") {
      i++;
      continue;
    }
    const rest = text.slice(i);
    const match = rest.match(/^%[-+ 0#]*(?:\d+)?(?:\.\d+)?[aAeEfFgG]/);
    if (!match) {
      if (directives > 0) throw new UsageError(`format ${localeQuotedEscapedDiagnostic(text)} has too many % directives`);
      if (rest === "%") throw new UsageError(`format ${localeQuotedEscapedDiagnostic(text)} ends in %`);
      const unknown = rest.match(/^%[-+ 0#]*(?:\d+)?(?:\.\d+)?(.?)/s)?.[1];
      if (unknown) throw new UsageError(`format ${localeQuotedEscapedDiagnostic(text)} has unknown %${unknown} directive`);
      throw new UsageError(`format ${localeQuotedEscapedDiagnostic(text)} has no % directive`);
    }
    directives++;
    i += match[0].length - 1;
  }
  if (directives === 0) throw new UsageError(`format ${localeQuotedEscapedDiagnostic(text)} has no % directive`);
  if (directives > 1) throw new UsageError(`format ${localeQuotedEscapedDiagnostic(text)} has too many % directives`);
}

export function formatSeqValue(format, value) {
  return String(format).replace(/%%|%([-+ 0#]*)(\d+)?(?:\.(\d+))?([aAeEfFgG])/g, (match, flags = "", width, precision, type) => {
    if (match === "%%") return "%";
    validateSeqFormatOutputSize(width);
    validateSeqFormatOutputSize(precision);
    const prec = precision == null ? 6 : Number(precision);
    let rendered;
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) rendered = formatSeqDefaultNumber(numericValue);
    else if (type === "g" || type === "G") rendered = formatSeqGeneral(numericValue, prec, flags.includes("#"));
    else if (type === "e" || type === "E") rendered = formatSeqExponential(numericValue, prec);
    else if (type === "a" || type === "A") rendered = formatSeqHexFloat(numericValue, precision == null ? null : prec, flags.includes("#"));
    else rendered = numericValue.toFixed(prec);
    if (type === "G" || type === "E" || type === "A") rendered = rendered.toUpperCase();
    if (Number(value) >= 0 && flags.includes("+")) rendered = `+${rendered}`;
    else if (Number(value) >= 0 && flags.includes(" ")) rendered = ` ${rendered}`;
    if (width) rendered = padSeqFormat(rendered, width, flags, type);
    return rendered;
  });
}

export function validateSeqFormatOutputSize(value) {
  if (value != null && BigInt(value) > 2147483647n) throw new UsageError("write error: Value too large for defined data type");
}

export function formatSeqExponential(value, precision) {
  return value.toExponential(precision).replace(/e([+-]?)(\d+)$/i, (_, sign, exp) => `e${sign || "+"}${exp.padStart(2, "0")}`);
}

export function formatSeqHexFloat(value, precision, alternate = false) {
  if (Object.is(value, 0) || Object.is(value, -0)) {
    const fraction = precision == null ? (alternate ? "." : "") : `.${"0".repeat(precision)}`;
    return `0x0${fraction}p+0`;
  }
  const abs = Math.abs(value);
  let exponent = Math.floor(Math.log2(abs)) - 3;
  let significand = abs / 2 ** exponent;
  if (significand >= 16) {
    significand /= 2;
    exponent++;
  }
  let head;
  let fraction = "";
  if (precision == null) {
    let scaled = Math.round(significand * 16 ** 13);
    if (scaled >= 16 * 16 ** 13) {
      scaled = 8 * 16 ** 13;
      exponent++;
    }
    head = Math.trunc(scaled / 16 ** 13).toString(16);
    fraction = (scaled % 16 ** 13).toString(16).padStart(13, "0").replace(/0+$/g, "");
  } else {
    let scaled = Math.round(significand * 16 ** precision);
    if (scaled >= 16 * 16 ** precision) {
      scaled = 8 * 16 ** precision;
      exponent++;
    }
    head = Math.trunc(scaled / 16 ** precision).toString(16);
    fraction = (scaled % 16 ** precision).toString(16).padStart(precision, "0");
  }
  const dot = fraction || alternate || precision != null ? "." : "";
  const sign = value < 0 ? "-" : "";
  return `${sign}0x${head}${dot}${fraction}p${exponent >= 0 ? "+" : ""}${exponent}`;
}

export function formatSeqGeneral(value, precision, alternate = false) {
  let rendered = value.toPrecision(precision);
  rendered = rendered.replace(/e([+-]?)(\d+)$/i, (_, sign, exp) => `e${sign || "+"}${exp.padStart(2, "0")}`);
  if (!alternate) {
    rendered = rendered.replace(/(\.\d*?[1-9])0+(e[+-]\d+)$/i, "$1$2");
    rendered = rendered.replace(/\.0+(e[+-]\d+)$/i, "$1");
    rendered = rendered.replace(/(\.\d*?[1-9])0+$/i, "$1");
    rendered = rendered.replace(/\.0+$/i, "");
  }
  return rendered;
}

export function padSeqFormat(value, width, flags = "", type = "") {
  const n = Number(width);
  if (!Number.isInteger(n) || value.length >= n) return value;
  if (flags.includes("-")) return value.padEnd(n, " ");
  const fill = flags.includes("0") && !/^[+-]?inf$/i.test(value) ? "0" : " ";
  if (fill === "0" && /[aA]/.test(type)) return padSeqHexFormat(value, n);
  if (fill === "0" && /^[+-]/.test(value)) return value[0] + value.slice(1).padStart(n - 1, "0");
  return value.padStart(n, fill);
}

export function padSeqHexFormat(value, width) {
  const match = String(value).match(/^([+ -]?)(0[xX])(.*)$/);
  if (!match) return value.padStart(width, "0");
  const [, sign, prefix, rest] = match;
  const zeros = Math.max(0, width - sign.length - prefix.length - rest.length);
  return `${sign}${prefix}${"0".repeat(zeros)}${rest}`;
}

const singleCall = defineCommand("seq", seq, seqMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
