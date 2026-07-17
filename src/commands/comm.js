#!/usr/bin/env bun

import { closeSync, fstatSync, openSync } from "node:fs";
import { createFdRecordReader, isWriteError, localeQuotedEscapedDiagnostic, parseOptions, readAll, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const COMM_LONG_OPTIONS = ["check-order", "nocheck-order", "output-delimiter", "total", "zero-terminated", "help", "version"];

export function commMetaOption(args) {
  const outputDelimiters = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeCommLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!COMM_LONG_OPTIONS.includes(name)) return null;
      if (option === "--help" || option === "--version") return option;
      if (name === "output-delimiter") {
        const value = inlineValue ?? args[i + 1];
        if (value !== undefined) {
          outputDelimiters.push(value);
          if (new Set(outputDelimiters).size > 1) throw new UsageError("multiple output delimiters specified");
        }
        if (inlineValue == null) i++;
      } else if (inlineValue != null) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) if (!"123z".includes(arg[j])) return null;
  }
  return null;
}

export function normalizeCommLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeCommLongOption(arg));
  }
  return out;
}

export function normalizeCommLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const matches = COMM_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length !== 1) return arg;
  return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
}

export async function comm(args) {
  args = normalizeCommLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { 1: false, 2: false, 3: false, z: false }, long: { "output-delimiter": "value", total: false, "zero-terminated": false, "check-order": false, "nocheck-order": false, help: false, version: false } });
  const delim = commOutputDelimiter(args);
  if (operands.length < 2) throw new UsageError(operands.length === 1 ? `missing operand after '${operands[0]}'` : "missing operand", true);
  if (operands.length > 2) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[2])}`, true);
  const sepByte = opts.z || opts["zero-terminated"] ? 0 : 0x0a;
  const sep = Buffer.from([sepByte]);
  const delimBytes = delim === "\0" ? Buffer.from([0]) : Buffer.from(delim);
  if (operands[0] !== "-" && operands[1] !== "-" && !opts.total) {
    const streamed = streamCommNonRegularFiles(operands, opts, sep, delimBytes);
    if (streamed != null) return streamed;
  }
  let left;
  let right;
  let sharedStdinError = false;
  if (operands[0] === "-" && operands[1] === "-") {
    const records = splitCommByteRecords(await readAll("-"), sepByte);
    left = records.filter((_, index) => index % 2 === 0);
    right = records.filter((_, index) => index % 2 === 1);
    sharedStdinError = true;
  } else {
    let leftBytes;
    let rightBytes;
    try {
      leftBytes = await readAll(operands[0]);
      rightBytes = await readAll(operands[1]);
    } catch (error) {
      const file = leftBytes == null ? operands[0] : operands[1];
      stderr(`comm: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      return 1;
    }
    left = splitCommByteRecords(leftBytes, sepByte);
    right = splitCommByteRecords(rightBytes, sepByte);
  }
  let i = 0, j = 0;
  const out = [];
  const counts = [0, 0, 0];
  const order = { bad: [false, false], messages: [] };
  while (i < left.length || j < right.length) {
    const leftBad = commNoteDisorder(left, i, 0, opts, order);
    if (opts["check-order"] && leftBad) break;
    const rightBad = commNoteDisorder(right, j, 1, opts, order);
    if (opts["check-order"] && rightBad) break;
    if (j >= right.length || (i < left.length && compareByteRecords(left[i], right[j]) < 0)) {
      counts[0]++;
      if (!opts[1]) pushCommRecord(out, left[i], sep);
      i++;
    } else if (i >= left.length || compareByteRecords(right[j], left[i]) < 0) {
      counts[1]++;
      if (!opts[2]) pushCommRecord(out, right[j], sep, commPrefixBytes(2, opts, delimBytes));
      j++;
    } else {
      counts[2]++;
      if (!opts[3]) pushCommRecord(out, left[i], sep, commPrefixBytes(3, opts, delimBytes));
      i++; j++;
    }
  }
  if (opts.total) {
    out.push(Buffer.from(String(counts[0])), delimBytes, Buffer.from(String(counts[1])), delimBytes, Buffer.from(String(counts[2])), delimBytes, Buffer.from("total"), sep);
  }
  stdout(Buffer.concat(out));
  if (sharedStdinError) {
    stderr("comm: -\n");
    return 1;
  }
  if (opts["nocheck-order"] || order.messages.length === 0) return 0;
  const fullyPairable = left.length === right.length && left.every((line, index) => byteRecordsEqual(line, right[index]));
  if (!opts["check-order"] && fullyPairable) return 0;
  for (const message of order.messages) stderr(`comm: ${message}\n`);
  if (!opts["check-order"]) stderr("comm: input is not in sorted order\n");
  return 1;
}

export function streamCommNonRegularFiles(files, opts, sep, delimBytes) {
  const fds = [];
  try {
    for (const file of files) fds.push(openSync(file, "r"));
    if (fds.some((fd) => fstatSync(fd).isFile())) return null;
    const readers = fds.map((fd) => createFdRecordReader(fd, sep[0]));
    const previous = [null, null];
    const order = { bad: [false, false], messages: [] };
    let stoppedForOrder = false;
    const next = (side) => {
      const record = readers[side].next();
      if (record != null && previous[side] != null && !opts["nocheck-order"] && !order.bad[side] && compareByteRecords(previous[side], record) > 0) {
        order.bad[side] = true;
        order.messages.push(`file ${side + 1} is not in sorted order`);
        if (opts["check-order"]) stoppedForOrder = true;
      }
      previous[side] = record;
      return record;
    };
    let left = next(0);
    let right = next(1);
    while (!stoppedForOrder && (left != null || right != null)) {
      if (right == null || (left != null && compareByteRecords(left, right) < 0)) {
        if (!opts[1]) writeCommRecord(left, sep);
        left = next(0);
      } else if (left == null || compareByteRecords(right, left) < 0) {
        if (!opts[2]) writeCommRecord(right, sep, commPrefixBytes(2, opts, delimBytes));
        right = next(1);
      } else {
        if (!opts[3]) writeCommRecord(left, sep, commPrefixBytes(3, opts, delimBytes));
        left = next(0);
        right = next(1);
      }
    }
    if (opts["nocheck-order"] || order.messages.length === 0) return 0;
    for (const message of order.messages) stderr(`comm: ${message}\n`);
    if (!opts["check-order"]) stderr("comm: input is not in sorted order\n");
    return 1;
  } catch (error) {
    if (isWriteError(error)) throw error;
    const side = fds.length < 2 ? fds.length : 0;
    stderr(`comm: ${textInputDiagnosticName(files[side])}: ${systemErrorMessage(error)}\n`);
    return 1;
  } finally {
    for (const fd of fds) closeSync(fd);
  }
}

export function writeCommRecord(record, sep, prefix = null) {
  if (prefix) stdout(prefix);
  stdout(record);
  stdout(sep);
}

export function splitCommByteRecords(bytes, sepByte) {
  if (bytes.length === 0) return [];
  const end = bytes[bytes.length - 1] === sepByte ? bytes.length - 1 : bytes.length;
  const records = [];
  let start = 0;
  for (let i = 0; i < end; i++) {
    if (bytes[i] === sepByte) {
      records.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  records.push(bytes.subarray(start, end));
  return records;
}

export function compareByteRecords(left, right) {
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

export function byteRecordsEqual(left, right) {
  return left.length === right.length && compareByteRecords(left, right) === 0;
}

export function commPrefixBytes(col, opts, delimBytes) {
  const chunks = [];
  if (!opts[1] && col > 1) chunks.push(delimBytes);
  if (!opts[2] && col > 2) chunks.push(delimBytes);
  return chunks.length === 0 ? null : Buffer.concat(chunks);
}

export function pushCommRecord(out, record, sep, prefix = null) {
  if (prefix) out.push(prefix);
  out.push(record, sep);
}

export function commOutputDelimiter(args) {
  const values = [];
  let end = false;
  let valueFor = false;
  for (const arg of args) {
    if (end) continue;
    if (valueFor) {
      values.push(arg);
      valueFor = false;
      continue;
    }
    if (arg === "--") {
      end = true;
    } else if (arg === "--output-delimiter") {
      valueFor = true;
    } else if (arg.startsWith("--output-delimiter=")) {
      values.push(arg.slice("--output-delimiter=".length));
    }
  }
  if (new Set(values).size > 1) throw new UsageError("multiple output delimiters specified");
  if (values.length === 0) return "\t";
  return values[0] === "" ? "\0" : values[0];
}

export function commNoteDisorder(records, index, side, opts, order) {
  if (opts["nocheck-order"] || index <= 0 || index >= records.length || order.bad[side] || compareByteRecords(records[index - 1], records[index]) <= 0) return false;
  order.bad[side] = true;
  order.messages.push(`file ${side + 1} is not in sorted order`);
  return true;
}

const singleCall = defineCommand("comm", comm, commMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
