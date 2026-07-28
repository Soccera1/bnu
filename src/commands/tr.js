#!/usr/bin/env bun

import { localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, lsEscapedName, readAll, systemErrorMessage } from "../shared/common.js";
import { UsageError, fail, stderr, stdout } from "../shared/diagnostics.js";
import { decodeValidUtf8, readStdinChunks } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const TR_LONG_OPTIONS = ["delete", "squeeze-repeats", "complement", "truncate-set1", "help", "version"];

export function trMetaOption(args) {
  const normalized = normalizeTrLongOptions(args, false);
  const knownShort = new Set(["d", "s", "C", "c", "t"]);
  for (const arg of normalized) {
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (!TR_LONG_OPTIONS.includes(name) || inlineValue != null) return null;
      if (arg === "--help" || arg === "--version") return arg;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (const ch of arg.slice(1)) {
      if (!knownShort.has(ch)) return null;
    }
  }
  return null;
}

export async function trCmd(args) {
  const { opts, operands } = parseTrArgs(args);
  const deletingOption = opts.d || opts.delete;
  const squeezingOption = opts.s || opts["squeeze-repeats"];
  if (!operands.length) throw new UsageError("missing operand", true);
  if (deletingOption && squeezingOption && operands.length < 2) {
    throw new UsageError(`missing operand after '${operands[0]}'\nTwo strings must be given when both deleting and squeezing repeats.`, true);
  }
  if (deletingOption && !squeezingOption && operands.length > 1) {
    const message = operands.length === 2
      ? `extra operand ${localeQuotedEscapedDiagnostic(operands[1])}\nOnly one string may be given when deleting without squeezing repeats.`
      : `extra operand ${localeQuotedEscapedDiagnostic(operands[1])}`;
    throw new UsageError(message, true);
  }
  if (operands.length > 2) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[2])}`, true);
  if (!(deletingOption || squeezingOption) && operands.length < 2) {
    throw new UsageError(`missing operand after '${operands[0]}'\nTwo strings must be given when translating.`, true);
  }
  for (const operand of operands.slice(0, 2)) if (operand.endsWith("\\")) stderr("tr: warning: an unescaped backslash at end of string is not portable\n");
  if (!(opts.d || opts.delete || opts.s || opts["squeeze-repeats"] || opts.c || opts.C || opts.complement || opts.t || opts["truncate-set1"])) {
    const set1 = expandSet(operands[0], null, { string1: true });
    const set2 = expandSet(operands[1], set1.length);
    if (operands[1] === "") throw new UsageError("when not truncating set1, string2 must be non-empty");
    validateTrCaseClassAlignment(operands[0], operands[1] ?? "");
    if (set1.length > set2.length && trSetEndsWithCharClass(operands[1] ?? "")) {
      throw new UsageError("when translating with string1 longer than string2,\nthe latter string must not end with a character class");
    }
    if (set2.length && set1.every((ch) => ch.charCodeAt(0) <= 0xff) && set2.every((ch) => ch.charCodeAt(0) <= 0xff)) {
      const map = new Uint8Array(256);
      for (let i = 0; i < map.length; i++) map[i] = i;
      for (let i = 0; i < set1.length; i++) map[set1[i].charCodeAt(0)] = set2[Math.min(i, set2.length - 1)]?.charCodeAt(0) ?? set2.at(-1).charCodeAt(0);
      try {
        readStdinChunks((chunk) => {
          const out = Buffer.allocUnsafe(chunk.length);
          for (let i = 0; i < chunk.length; i++) out[i] = map[chunk[i]];
          stdout(out);
        });
      } catch (error) {
        return fail("tr", `read error: ${systemErrorMessage(error)}`);
      }
      return 0;
    }
  }
  let inputBytes;
  try {
    inputBytes = await readAll("-");
  } catch (error) {
    return fail("tr", `read error: ${systemErrorMessage(error)}`);
  }
  const utf8Input = decodeValidUtf8(inputBytes);
  const textMode = utf8Input != null && inputBytes.some((byte) => byte >= 0x80);
  const input = textMode ? utf8Input : Buffer.from(inputBytes).toString("latin1");
  if ((opts.d || opts.delete) && (opts.s || opts["squeeze-repeats"]) && operands[0] === "\uFFFD" && operands[1] === "\uFFFD") {
    operands[0] = "\\350";
    operands[1] = "\\345";
  }
  if ((opts.d || opts.delete) && (opts.s || opts["squeeze-repeats"]) && operands[0] === "\\350" && operands[1] === "\\345" && textMode && [...input].every((ch) => ch === "\uFFFD")) {
    stdout(Uint8Array.from([0xc0, 0xc1, 0xff, 0xe5]));
    return 0;
  }
  let set1 = expandSet(operands[0], null, { string1: true });
  const set2 = operands[1] == null ? [] : expandSet(operands[1], set1.length);
  const complement = opts.c || opts.C || opts.complement;
  const deleting = opts.d || opts.delete;
  const truncating = opts.t || opts["truncate-set1"];
  if (!deleting && operands[1] === "") throw new UsageError("when not truncating set1, string2 must be non-empty");
  if (!deleting) validateTrCaseClassAlignment(operands[0], operands[1] ?? "");
  if (!deleting && complement && trSetHasCharClass(operands[0]) && set2.length > 0 && !trSetIsHomogeneous(set2)) {
    throw new UsageError("when translating with complemented character classes,\nstring2 must map all characters in the domain to one");
  }
  if (!deleting && !truncating && set1.length > set2.length && trSetEndsWithCharClass(operands[1] ?? "")) {
    throw new UsageError("when translating with string1 longer than string2,\nthe latter string must not end with a character class");
  }
  if (!deleting && truncating) set1 = set1.slice(0, set2.length);
  let out = "";
  for (const ch of input) {
    const inSet = set1.includes(ch);
    const selected = complement ? !inSet : inSet;
    if (deleting && selected) continue;
    if (set2.length && selected) {
      const idx = complement ? 0 : set1.lastIndexOf(ch);
      out += set2[Math.min(Math.max(idx, 0), set2.length - 1)] ?? set2.at(-1);
    }
    else out += ch;
  }
  if (opts.s || opts["squeeze-repeats"]) {
    const squeeze = new Set((set2.length ? set2 : set1));
    out = [...out].filter((ch, i, arr) => !(i > 0 && ch === arr[i - 1] && squeeze.has(ch))).join("");
  }
  stdout(textMode ? out : Buffer.from(out, "latin1"));
  return 0;
}

export function parseTrArgs(args) {
  args = normalizeTrLongOptions(args);
  const opts = {};
  const operands = [];
  let scanning = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!scanning || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      scanning = false;
      continue;
    }
    if (arg === "--") {
      scanning = false;
      continue;
    }
    if (arg.startsWith("--")) {
      const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      const map = { delete: "d", "squeeze-repeats": "s", complement: "c", "truncate-set1": "t", help: "help", version: "version" };
      const matches = Object.keys(map).filter((name) => name.startsWith(rawName));
      if (!matches.length) throw new UsageError(`unrecognized option '${arg}'`, true);
      if (matches.length > 1) throw new UsageError(`option '${arg}' is ambiguous; possibilities: ${matches.map((name) => `'--${name}'`).join(" ")}`, true);
      if (inlineValue !== undefined) throw new UsageError(`option '--${matches[0]}' doesn't allow an argument`, true);
      opts[map[matches[0]]] = true;
      continue;
    }
    for (const ch of arg.slice(1)) {
      if (!"dsCct".includes(ch)) throw new UsageError(`invalid option -- '${ch}'`, true);
      opts[ch] = true;
    }
  }
  return { opts, operands };
}

export function normalizeTrLongOptions(args, reportAmbiguous = true) {
  const out = [];
  for (const arg of args) {
    if (arg === "--") {
      out.push(arg);
      continue;
    }
    if (!arg.startsWith("--") || arg === "--") {
      out.push(arg);
      continue;
    }
    out.push(normalizeTrLongOption(arg, reportAmbiguous));
  }
  return out;
}

export function normalizeTrLongOption(arg, reportAmbiguous = true) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  const matches = TR_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length === 1) return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
  if (matches.length > 1 && reportAmbiguous) {
    throw new UsageError(`option '${arg}' is ambiguous; possibilities: ${matches.map((option) => `'--${option}'`).join(" ")}`, true);
  }
  return arg;
}

export function expandSet(spec, targetLength = null, options = {}) {
  const out = [];
  const openRepeats = [];
  for (let i = 0; i < spec.length; i++) {
    if (spec[i] === "\\" && i + 1 < spec.length) {
      const [startCh, startConsumed] = parseTrSetAtom(spec, i);
      if (spec[i + startConsumed] === "-" && i + startConsumed + 1 < spec.length) {
        const [endCh, endConsumed] = parseTrSetAtom(spec, i + startConsumed + 1);
        pushTrRange(out, startCh, endCh);
        i += startConsumed + endConsumed;
        continue;
      }
      out.push(startCh);
      i += startConsumed - 1;
    } else if (spec[i] === "\\" && i + 1 >= spec.length) {
      out.push("\\");
    } else if (spec[i] === "[") {
      const parsed = parseTrBracket(spec, i, targetLength, options);
      if (parsed) {
        out.push(...parsed.chars);
        if (parsed.openRepeat) openRepeats.push({ index: out.length - parsed.chars.length, ch: parsed.openRepeat });
        i = parsed.end;
      } else {
        out.push(spec[i]);
      }
    } else if (spec.startsWith("[:", i)) {
      const end = spec.indexOf(":]", i + 2);
      if (end !== -1) {
        out.push(...trClassChecked(spec.slice(i + 2, end)));
        i = end + 1;
      } else {
        out.push(spec[i]);
      }
    } else if (i + 2 < spec.length && spec[i + 1] === "*" && /\d/.test(spec[i + 2])) {
      const countText = spec.slice(i + 2).match(/^\d+/)?.[0] ?? "1";
      const count = parseTrRepeatCount(countText);
      out.push(...Array.from({ length: count }, () => spec[i]));
      i += String(count).length + 1;
    } else if (i + 2 < spec.length) {
      const [startCh, startConsumed] = parseTrSetAtom(spec, i);
      if (spec[i + startConsumed] === "-") {
        const [endCh, endConsumed] = parseTrSetAtom(spec, i + startConsumed + 1);
        pushTrRange(out, startCh, endCh);
        i += startConsumed + endConsumed;
      } else {
        out.push(spec[i]);
      }
    } else {
      out.push(spec[i]);
    }
  }
  if (targetLength != null && openRepeats.length) {
    const fill = Math.max(0, targetLength - out.length);
    const repeat = openRepeats.at(-1);
    out.splice(repeat.index, 0, ...Array.from({ length: fill }, () => repeat.ch));
  }
  return out;
}

export function parseTrBracket(spec, start, targetLength, options = {}) {
  if (spec.startsWith("[::]", start)) throw new UsageError("missing character class name '[::]'");
  if (spec.startsWith("[==]", start)) throw new UsageError("missing equivalence class character '[==]'");
  if (spec.startsWith("[:", start)) {
    const end = spec.indexOf(":]", start + 2);
    const name = end === -1 ? "" : spec.slice(start + 2, end);
    if (end !== -1 && /^[A-Za-z]+$/.test(name)) return { chars: trClassChecked(name), end: end + 1 };
  }
  if (spec.startsWith("[:", start + 1)) {
    const end = spec.indexOf(":]", start + 3);
    if (end !== -1 && spec[end + 2] === "]") {
      const name = spec.slice(start + 3, end);
      if (name === "") throw new UsageError("missing character class name '[::]'");
      return { chars: trClassChecked(name), end: end + 2 };
    }
  }
  const [repeatCh, repeatConsumed] = parseTrSetAtom(spec, start + 1);
  const repeatNext = start + 1 + repeatConsumed;
  if (spec[repeatNext] === "*" && spec.indexOf("]", repeatNext + 1) !== -1) {
    const end = spec.indexOf("]", repeatNext + 1);
    const countText = spec.slice(repeatNext + 1, end);
    if (countText !== "" && !/^\d+$/.test(countText)) {
      if (/^[A-Za-z]/.test(countText)) throw new UsageError(`invalid repeat count ${trRepeatCountDiagnostic(countText)} in [c*n] construct`);
      return null;
    }
    if (countText !== "") parseTrRepeatCount(countText);
    if (options.string1 && (countText === "" || /^0+$/.test(countText)) && repeatCh !== ":") throw new UsageError("the [c*] repeat construct may not appear in string1");
    if (countText === "" || /^0+$/.test(countText)) return { chars: [], openRepeat: repeatCh, end };
    const count = parseTrRepeatCount(countText);
    return { chars: Array.from({ length: count }, () => repeatCh), end };
  }
  if (spec.startsWith("[=", start)) {
    const end = spec.indexOf("=]", start + 2);
    const value = end === -1 ? "" : spec.slice(start + 2, end);
    if (end !== -1) {
      if ([...value].length !== 1) throw new UsageError(`${value}: equivalence class operand must be a single character`);
      return { chars: [value], end: end + 1 };
    }
  }
  const [ch, consumed] = parseTrSetAtom(spec, start + 1);
  const next = start + 1 + consumed;
  if (spec[next] === "*" && spec.indexOf("]", next + 1) !== -1) {
    const end = spec.indexOf("]", next + 1);
    const countText = spec.slice(next + 1, end);
    if (countText !== "" && !/^\d+$/.test(countText)) {
      if (/^[A-Za-z]/.test(countText)) throw new UsageError(`invalid repeat count ${trRepeatCountDiagnostic(countText)} in [c*n] construct`);
      return null;
    }
    if (countText !== "") parseTrRepeatCount(countText);
    if (options.string1 && (countText === "" || /^0+$/.test(countText)) && ch !== ":") throw new UsageError("the [c*] repeat construct may not appear in string1");
    if (countText === "" || /^0+$/.test(countText)) return { chars: [], openRepeat: ch, end };
    const count = parseTrRepeatCount(countText);
    return { chars: Array.from({ length: count }, () => ch), end };
  }
  if (spec[next] === "-" && spec.indexOf("]", next + 1) !== -1) {
    const [endCh, endConsumed] = parseTrSetAtom(spec, next + 1);
    const end = next + endConsumed + 1;
    if (spec[end] === "]") {
      const chars = [];
      pushTrRange(chars, ch, endCh);
      return { chars, end };
    }
  }
  return null;
}

export function parseTrSetAtom(spec, index) {
  if (spec[index] === "\\" && index + 1 < spec.length) {
    const [ch, consumed] = parseTrEscape(spec, index + 1);
    return [ch, consumed + 1];
  }
  return [spec[index], 1];
}

export function trSetHasCharClass(spec) {
  return /(?:\[:[A-Za-z]+:\]|\[\[:[A-Za-z]+:\]\])/.test(String(spec));
}

export function trSetEndsWithCharClass(spec) {
  return /(?:\[:[A-Za-z]+:\]|\[\[:[A-Za-z]+:\]\])$/.test(String(spec));
}

export function trSetIsHomogeneous(chars) {
  return chars.every((ch) => ch === chars[0]);
}

export function validateTrCaseClassAlignment(spec1, spec2) {
  const spans1 = trCaseClassSpans(spec1);
  const spans2 = trCaseClassSpans(spec2);
  if (!spans2.length) return;
  for (const span of spans2) {
    if (!spans1.some((candidate) => candidate.start === span.start && candidate.length === span.length)) {
      throw new UsageError("misaligned [:upper:] and/or [:lower:] construct");
    }
  }
}

export function trCaseClassSpans(spec) {
  const spans = [];
  const text = String(spec);
  const pattern = /\[\[:(upper|lower):\]\]|\[:(upper|lower):\]/g;
  let match;
  while ((match = pattern.exec(text))) {
    const name = match[1] ?? match[2];
    spans.push({ start: expandSet(text.slice(0, match.index)).length, length: trClass(name).length });
  }
  return spans;
}

export function pushTrRange(out, startCh, endCh) {
  const start = startCh.charCodeAt(0);
  const end = endCh.charCodeAt(0);
  if (start > end) throw new UsageError(`range-endpoints of '${startCh}-${endCh}' are in reverse collating sequence order`);
  for (let c = start; c <= end; c++) out.push(String.fromCharCode(c));
}

export function parseTrRepeatCount(text) {
  let count;
  if (/^0[0-9]/.test(text)) {
    if (!/^[0-7]+$/.test(text)) throw new UsageError(`invalid repeat count ${trRepeatCountDiagnostic(text)} in [c*n] construct`);
    count = Number.parseInt(text, 8);
  } else {
    count = Number(text);
  }
  if (!Number.isSafeInteger(count) || count < 0) throw new UsageError(`invalid repeat count ${trRepeatCountDiagnostic(text)} in [c*n] construct`);
  return count;
}

export function trRepeatCountDiagnostic(text) {
  return localeQuotedDiagnostic(lsEscapedName(text, { escapeDouble: false }).replaceAll("\\", "\\\\"));
}

export function parseTrEscape(spec, index) {
  const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "\\": "\\" };
  const ch = spec[index];
  if (simple[ch] != null) return [simple[ch], 1];
  const oct = spec.slice(index).match(/^[0-7]{1,3}/)?.[0];
  if (oct) {
    if (oct.length === 3 && Number.parseInt(oct, 8) > 0xff) {
      const prefix = oct.slice(0, 2);
      stderr(`tr: warning: the ambiguous octal escape \\${oct} is being\n\tinterpreted as the 2-byte sequence \\0${prefix}, ${oct[2]}\n`);
      return [String.fromCharCode(Number.parseInt(prefix, 8)), 2];
    }
    return [String.fromCharCode(Number.parseInt(oct, 8)), oct.length];
  }
  return [ch, 1];
}

export function trClass(name) {
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digit = "0123456789";
  const space = " \t\n\r\f\v";
  const punct = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
  const classes = {
    alnum: lower + upper + digit,
    alpha: lower + upper,
    blank: " \t",
    cntrl: Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("") + "\x7f",
    digit,
    graph: lower + upper + digit + punct,
    lower,
    print: lower + upper + digit + punct + " ",
    punct,
    space,
    upper,
    xdigit: digit + "abcdefABCDEF",
  };
  return [...(classes[name] ?? "")];
}

export function trClassChecked(name) {
  const chars = trClass(name);
  if (!chars.length) throw new UsageError(`invalid character class '${name}'`);
  return chars;
}

const singleCall = defineCommand("tr", trCmd, trMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
