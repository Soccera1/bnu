#!/usr/bin/env bun

import { closeSync, openSync } from "node:fs";
import { createFdRecordReader, invalidOptionMessage, isWriteError, localeQuotedEscapedDiagnostic, readAll, shellEscapeLsName, statSyncNoThrow, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { splitSeparator } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const JOIN_LONG_OPTIONS = ["check-order", "header", "ignore-case", "nocheck-order", "zero-terminated", "help", "version"];

export function joinMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeJoinLongOption(arg, false);
      const name = option.slice(2).split("=", 1)[0];
      if (!JOIN_LONG_OPTIONS.includes(name) || option.includes("=")) return null;
      if (option === "--help" || option === "--version") return option;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if ("iz".includes(ch)) continue;
      if (!"12aejotv".includes(ch)) return null;
      const inlineValue = arg.slice(j + 1);
      const value = inlineValue === "" ? args[i + 1] : inlineValue;
      validateJoinMetaOptionValue(ch, value);
      if (inlineValue === "" && i + 1 < args.length) i++;
      break;
    }
  }
  return null;
}

export function validateJoinMetaOptionValue(option, value) {
  if (value === undefined) return;
  if ("12j".includes(option)) parseJoinFieldNumber(value);
  else if ("av".includes(option)) parseJoinFileNumber(value);
  else if (option === "o") parseJoinOutputList(value);
  else if (option === "t") parseJoinSeparator(value);
}

export function normalizeJoinLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeJoinLongOption(arg));
  }
  return out;
}

export function normalizeJoinLongOption(arg, reportAmbiguous = true) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const matches = JOIN_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length !== 1) {
    if (matches.length > 1 && reportAmbiguous) throw new UsageError(`option '${arg}' is ambiguous; possibilities: ${matches.map((option) => `'--${option}'`).join(" ")}`, true);
    return arg;
  }
  return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function joinCmd(args) {
  const { opts, operands } = parseJoinOptions(args);
  if (!operands.length) throw new UsageError("missing operand", true);
  if (operands.length === 1) throw new UsageError(`missing operand after '${operands[0]}'`, true);
  if (operands.length > 2) throw new UsageError(`extra operand ${shellEscapeLsName(operands[2], true)}`, true);
  const delim = normalizeJoinDelimiter(opts.t ?? " ");
  const outDelim = delim === " " ? " " : delim;
  const recordSep = opts.z ? "\0" : "\n";
  const f1 = opts.f1 - 1;
  const f2 = opts.f2 - 1;
  const streamed = streamJoinAgainstEmptyInput(operands, opts, delim, outDelim, recordSep, f1, f2);
  if (streamed != null) return streamed;
  let leftBytes;
  let rightBytes;
  try {
    leftBytes = await readAll(operands[0]);
    rightBytes = await readAll(operands[1]);
  } catch (error) {
    const file = leftBytes == null ? operands[0] : operands[1];
    const message = error?.code === "EISDIR" ? `read error: ${systemErrorMessage(error)}` : `${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}`;
    stderr(`join: ${message}\n`);
    return 1;
  }
  let left = parseJoinFile(leftBytes, delim, opts.z);
  let right = parseJoinFile(rightBytes, delim, opts.z);
  let out = "";
  let leftHeader = null;
  let rightHeader = null;
  if (opts.header) {
    leftHeader = left.shift() ?? null;
    rightHeader = right.shift() ?? null;
  }
  opts.autoLeftWidth = Math.max(leftHeader?.length ?? 0, left[0]?.length ?? 0, f1 + 1);
  opts.autoRightWidth = Math.max(rightHeader?.length ?? 0, right[0]?.length ?? 0, f2 + 1);
  if (leftHeader || rightHeader) out += formatJoinOutput(leftHeader, rightHeader, leftHeader?.[f1] ?? rightHeader?.[f2] ?? "", opts, outDelim, recordSep, f1, f2);
  if (opts.checkOrder) {
    const disorder = checkJoinOrder(left, f1, operands[0], opts) ?? checkJoinOrder(right, f2, operands[1], opts);
    if (disorder) {
      if (out) stdout(out);
      stderr(`join: ${disorder.file}:${disorder.lineNo}: is not sorted: ${disorder.raw}\n`);
      return 1;
    }
  }
  const leftDisorder = checkJoinOrder(left, f1, operands[0], opts);
  const rightDisorder = checkJoinOrder(right, f2, operands[1], opts);
  const rightEntries = right.map((row, index) => ({ row, index, key: joinComparisonKey(row, f2, opts), rawKey: row[f2] ?? "" }));
  const rightMap = new Map();
  for (const entry of rightEntries) {
    if (!rightMap.has(entry.key)) rightMap.set(entry.key, []);
    rightMap.get(entry.key).push(entry);
  }
  const leftKeys = new Set(left.map((row) => joinComparisonKey(row, f1, opts)));
  const matchedRightKeys = new Set();
  const emittedUnmatchedRight = new Set();
  const emitRightBefore = (key) => {
    if (!(opts.all.has(2) || opts.v.has(2))) return;
    for (const entry of rightEntries) {
      if (emittedUnmatchedRight.has(entry.index) || leftKeys.has(entry.key) || entry.key >= key) continue;
      out += formatJoinOutput(null, entry.row, entry.rawKey, opts, outDelim, recordSep, f1, f2);
      emittedUnmatchedRight.add(entry.index);
    }
  };
  for (const leftRow of left) {
    const key = joinComparisonKey(leftRow, f1, opts);
    const rawKey = leftRow[f1] ?? "";
    emitRightBefore(key);
    const matches = rightMap.get(key) ?? [];
    if (!matches.length) {
      if (opts.all.has(1) || opts.v.has(1)) out += formatJoinOutput(leftRow, null, rawKey, opts, outDelim, recordSep, f1, f2);
    } else {
      matchedRightKeys.add(key);
      for (const entry of matches) {
        if (!opts.v.size) out += formatJoinOutput(leftRow, entry.row, rawKey, opts, outDelim, recordSep, f1, f2);
      }
    }
  }
  for (const entry of rightEntries) {
    if (matchedRightKeys.has(entry.key) || emittedUnmatchedRight.has(entry.index)) continue;
    if (opts.all.has(2) || opts.v.has(2)) out += formatJoinOutput(null, entry.row, entry.rawKey, opts, outDelim, recordSep, f1, f2);
  }
  if (!opts.checkOrder && !opts.nocheckOrder && out.trim() === "" && leftDisorder && rightDisorder) {
    if (leftDisorder) stderr(`join: ${leftDisorder.file}:${leftDisorder.lineNo}: is not sorted: ${leftDisorder.raw}\n`);
    if (rightDisorder) stderr(`join: ${rightDisorder.file}:${rightDisorder.lineNo}: is not sorted: ${rightDisorder.raw}\n`);
    stderr("join: input is not in sorted order\n");
    return 1;
  }
  stdout(Buffer.from(out, "latin1"));
  return 0;
}

export function streamJoinAgainstEmptyInput(files, opts, delim, outDelim, recordSep, f1, f2) {
  if (opts.header) return null;
  let emptySide = -1;
  for (let side = 0; side < 2; side++) {
    if (files[side] === "/dev/null") {
      emptySide = side;
      break;
    }
    const info = statSyncNoThrow(files[side]);
    if (info?.isFile() && info.size === 0) {
      emptySide = side;
      break;
    }
  }
  if (emptySide === -1) return null;
  const sourceSide = 1 - emptySide;
  const sourceNumber = sourceSide + 1;
  if (!(opts.all.has(sourceNumber) || opts.v.has(sourceNumber))) return null;
  let fd;
  try {
    fd = files[sourceSide] === "-" ? 0 : openSync(files[sourceSide], "r");
    const reader = createFdRecordReader(fd, recordSep.charCodeAt(0));
    const field = sourceSide === 0 ? f1 : f2;
    let previous = null;
    let lineNo = 0;
    while (true) {
      const bytes = reader.next();
      if (bytes == null) break;
      lineNo++;
      const row = parseJoinRecord(bytes, delim, opts.z, lineNo);
      const key = joinComparisonKey(row, field, opts);
      if (!opts.nocheckOrder && previous != null && key < previous) {
        stderr(`join: ${files[sourceSide]}:${lineNo}: is not sorted: ${row.raw}\n`);
        if (opts.checkOrder) return 1;
        stderr("join: input is not in sorted order\n");
        return 1;
      }
      previous = key;
      const left = sourceSide === 0 ? row : null;
      const right = sourceSide === 1 ? row : null;
      stdout(Buffer.from(formatJoinOutput(left, right, row[field] ?? "", opts, outDelim, recordSep, f1, f2), "latin1"));
    }
    return 0;
  } catch (error) {
    if (isWriteError(error)) throw error;
    const message = error?.code === "EISDIR" ? `read error: ${systemErrorMessage(error)}` : `${textInputDiagnosticName(files[sourceSide])}: ${systemErrorMessage(error)}`;
    stderr(`join: ${message}\n`);
    return 1;
  } finally {
    if (fd != null && fd !== 0) closeSync(fd);
  }
}

export function parseJoinRecord(bytes, delim, zero, lineNo) {
  const line = Buffer.from(bytes).toString("latin1");
  const fields = delim === ""
    ? [line]
    : delim === " "
      ? line.replace(/^[ \t\n]+/, "").split(zero ? /[ \t\n]+/ : /[ \t]+/).filter((field) => field !== "")
      : line.split(delim);
  fields.raw = line;
  fields.lineNo = lineNo;
  return fields;
}

export function parseJoinFile(data, delim, zero = false) {
  const recordSep = zero ? "\0" : "\n";
  const text = Buffer.from(data).toString("latin1").replace(new RegExp(`${escapeRegExp(recordSep)}$`), "");
  if (text === "") return [];
  return text.split(recordSep).map((line) => {
    const fields = delim === ""
      ? [line]
      : delim === " "
        ? line.replace(/^[ \t\n]+/, "").split(zero ? /[ \t\n]+/ : /[ \t]+/).filter((field) => field !== "")
        : line.split(delim);
    fields.raw = line;
    return fields;
  }).map((fields, index) => {
    fields.lineNo = index + 1;
    return fields;
  });
}

export function normalizeJoinDelimiter(value) {
  const text = String(value);
  if (text === " ") return " ";
  if (text.includes("\uFFFD")) return text.replaceAll("\uFFFD", "\xA7");
  return Buffer.from(text).toString("latin1");
}

export function checkJoinOrder(rows, field, file, opts = {}) {
  let previous = null;
  for (const row of rows) {
    const key = joinComparisonKey(row, field, opts);
    if (previous != null && key < previous) return { file, lineNo: row.lineNo, raw: row.raw };
    previous = key;
  }
  return null;
}

export function joinComparisonKey(row, field, opts = {}) {
  const key = row?.[field] ?? "";
  return opts.ignoreCase ? key.toLocaleLowerCase() : key;
}

export function parseJoinOptions(args) {
  args = normalizeJoinLongOptions(args);
  const opts = { f1: 1, f2: 1, all: new Set(), v: new Set(), empty: "", output: null, checkOrder: false, header: false, ignoreCase: false };
  const operands = [];
  const requireValue = (index, option) => {
    if (index + 1 < args.length) return args[index + 1];
    throw new UsageError(`option requires an argument -- '${option.slice(1)}'`, true);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith("--") && arg.includes("=")) {
      const name = arg.slice(2).split("=", 1)[0];
      if (JOIN_LONG_OPTIONS.includes(name)) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      throw new UsageError(`unrecognized option '${arg}'`, true);
    } else if (arg === "--check-order") {
      opts.checkOrder = true;
    } else if (arg === "--nocheck-order") {
      opts.checkOrder = false;
      opts.nocheckOrder = true;
    } else if (arg === "--header") {
      opts.header = true;
    } else if (arg === "-i" || arg === "--ignore-case") {
      opts.ignoreCase = true;
    } else if (arg === "-z" || arg === "--zero-terminated") {
      opts.z = true;
    } else if (arg === "-t") {
      opts.t = parseJoinSeparator(requireValue(i, arg));
      i++;
    } else if (arg.startsWith("-t") && arg.length > 2) {
      opts.t = parseJoinSeparator(arg.slice(2));
    } else if (arg === "-1") {
      opts.f1 = parseJoinFieldNumber(requireValue(i, arg));
      i++;
    } else if (arg.startsWith("-1") && arg.length > 2) {
      opts.f1 = parseJoinFieldNumber(arg.slice(2));
    } else if (arg === "-2") {
      opts.f2 = parseJoinFieldNumber(requireValue(i, arg));
      i++;
    } else if (arg.startsWith("-2") && arg.length > 2) {
      opts.f2 = parseJoinFieldNumber(arg.slice(2));
    } else if (arg === "-j") {
      const field = parseJoinFieldNumber(requireValue(i, arg));
      i++;
      opts.f1 = field;
      opts.f2 = field;
    } else if (arg.startsWith("-j") && arg.length > 2) {
      const field = parseJoinFieldNumber(arg.slice(2));
      opts.f1 = field;
      opts.f2 = field;
    } else if (arg === "-a") {
      opts.all.add(parseJoinFileNumber(requireValue(i, arg)));
      i++;
    } else if (/^-a[12]$/.test(arg)) {
      opts.all.add(Number(arg[2]));
    } else if (arg === "-v") {
      opts.v.add(parseJoinFileNumber(requireValue(i, arg)));
      i++;
    } else if (/^-v[12]$/.test(arg)) {
      opts.v.add(Number(arg[2]));
    } else if (arg === "-e") {
      opts.empty = requireValue(i, arg);
      i++;
    } else if (arg.startsWith("-e") && arg.length > 2) {
      opts.empty = arg.slice(2);
    } else if (arg === "-o") {
      const collected = collectJoinOutputList(args, i, requireValue(i, arg));
      opts.output = parseJoinOutputList(collected.value);
      i = collected.index;
    } else if (arg.startsWith("-o") && arg.length > 2) {
      const collected = collectJoinOutputList(args, i, arg.slice(2));
      opts.output = parseJoinOutputList(collected.value);
      i = collected.index;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new UsageError(invalidOptionMessage(arg), true);
    } else {
      operands.push(arg);
    }
  }
  return { opts, operands };
}

export function parseJoinFieldNumber(value) {
  if (!/^\+?\d+$/.test(String(value))) throw new UsageError(`invalid field number: ${localeQuotedEscapedDiagnostic(value)}`);
  const n = BigInt(String(value));
  if (n === 0n) throw new UsageError(`invalid field number: ${localeQuotedEscapedDiagnostic(value)}`);
  return n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n);
}

export function parseJoinFileNumber(value) {
  if (value !== "1" && value !== "2") throw new UsageError(`invalid file number: ${localeQuotedEscapedDiagnostic(value)}`);
  return Number(value);
}

export function collectJoinOutputList(args, index, initial) {
  const parts = [initial];
  if (initial === "auto") return { value: initial, index: index + (args[index] === "-o" ? 1 : 0) };
  let next = index + (args[index] === "-o" ? 2 : 1);
  while (next < args.length && args[next] !== "--" && !args[next].startsWith("-") && args.length - (next + 1) >= 2) {
    parts.push(args[next]);
    next++;
  }
  return { value: parts.join(" "), index: next - 1 };
}

export function parseJoinSeparator(value) {
  const sep = splitSeparator(value);
  if ([...sep].length > 1) throw new UsageError(`multi-character tab ${localeQuotedEscapedDiagnostic(value)}`);
  return sep;
}

export function parseJoinOutputList(value) {
  if (value === "auto") return "auto";
  return String(value).split(/[,\t ]+/).filter(Boolean).map((part) => {
    if (part === "0") return { join: true };
    const fieldMatch = part.match(/^([12])\.(.*)$/s);
    if (fieldMatch) {
      const fieldText = fieldMatch[2];
      if (!/^\d+$/.test(fieldText) || BigInt(fieldText) === 0n) throw new UsageError(`invalid field number: ${localeQuotedEscapedDiagnostic(fieldText)}`);
      return { file: Number(fieldMatch[1]), field: Number(fieldText) - 1 };
    }
    if (/^[12]\./.test(part)) throw new UsageError(`invalid field number: ${localeQuotedEscapedDiagnostic(part.slice(2))}`);
    throw new UsageError(`invalid file number in field spec: ${localeQuotedEscapedDiagnostic(part)}`);
  });
}

export function formatJoinOutput(left, right, key, opts, delim, recordSep, f1, f2) {
  let fields;
  if (opts.output === "auto") {
    const leftWidth = Math.max(opts.autoLeftWidth ?? 0, f1 + 1);
    const rightWidth = Math.max(opts.autoRightWidth ?? 0, f2 + 1);
    fields = [key];
    for (let i = 0; i < leftWidth; i++) if (i !== f1) fields.push(joinField(left, i, opts.empty));
    for (let i = 0; i < rightWidth; i++) if (i !== f2) fields.push(joinField(right, i, opts.empty));
  } else if (opts.output) {
    fields = opts.output.map((spec) => {
      if (spec.join) return key || opts.empty;
      return joinField(spec.file === 1 ? left : right, spec.field, opts.empty);
    });
  } else if (!right) {
    fields = [key, ...(left ?? []).filter((_, i) => i !== f1)];
  } else if (!left) {
    fields = [key, ...(right ?? []).filter((_, i) => i !== f2)];
  } else {
    fields = [key, ...left.filter((_, i) => i !== f1), ...right.filter((_, i) => i !== f2)];
  }
  return `${fields.map((field) => field === "" ? opts.empty : field).join(delim)}${recordSep}`;
}

export function joinField(row, index, empty) {
  return row?.[index] ?? empty;
}

const singleCall = defineCommand("join", joinCmd, joinMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
