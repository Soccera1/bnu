#!/usr/bin/env bun
import { defineCommand, runAsMain } from "../shared/command.js";
import { normalizeLongOptionsByPrefix, parseOptions, parseGNUSize } from "../shared/common.js";
import { stdout, stderr } from "../shared/diagnostics.js";
import { readBytes, trouble } from "../shared/diff-tools.js";

const long = { "print-bytes": false, "ignore-initial": "value", verbose: false, bytes: "value", quiet: false, silent: false, help: false, version: false };
export function cmpMetaOption(args) { return args.includes("--help") ? "--help" : args.includes("--version") ? "--version" : null; }
export async function cmp(args) {
  const { opts: o, operands } = parseOptions(normalizeLongOptionsByPrefix(args, Object.keys(long)), { short: { b: false, i: "value", l: false, n: "value", s: false }, long });
  if (!operands.length) trouble("missing operand");
  if (operands.length > 4) trouble(`extra operand '${operands[4]}'`);
  const silent = o.s || o.quiet || o.silent, verbose = o.l || o.verbose, print = o.b || o["print-bytes"];
  if (silent && (verbose || print)) trouble("options -l and -s are incompatible");
  const skip = String(o.i ?? o["ignore-initial"] ?? "0").split(":");
  if (skip.length > 2) trouble("invalid --ignore-initial value");
  const size = (s) => { if (!/^\d/.test(String(s))) trouble(`invalid byte count '${s}'`); return parseGNUSize(String(s)); };
  const skipA = size(operands[2] ?? skip[0]), skipB = size(operands[3] ?? skip[1] ?? skip[0]);
  const limit = o.n == null && o.bytes == null ? Infinity : size(o.n ?? o.bytes);
  const first = operands[0], second = operands[1] ?? "-";
  let a, b;
  try { a = readBytes(first); b = first === "-" && second === "-" ? a : readBytes(second); }
  catch (error) { if (!silent) stderr(`cmp: ${error.message}\n`); return 2; }
  a = a.subarray(skipA, skipA + limit); b = b.subarray(skipB, skipB + limit);
  const count = Math.min(a.length, b.length), digits = String(count).length;
  let line = 1, different = false;
  for (let i = 0; i < count; i++) {
    if (a[i] !== b[i]) {
      different = true;
      if (silent) return 1;
      if (!verbose) { stdout(`${first} ${second} differ: char ${i + 1}, line ${line}${print ? ` is ${String(a[i].toString(8)).padStart(3)} ${byteName(a[i])} ${String(b[i].toString(8)).padStart(3)} ${byteName(b[i])}` : ""}\n`); return 1; }
      stdout(`${String(i + 1).padStart(digits)} ${a[i].toString(8).padStart(3)}${print ? ` ${byteName(a[i]).padEnd(4)}` : ""} ${b[i].toString(8).padStart(3)}${print ? ` ${byteName(b[i])}` : ""}\n`);
    }
    if (a[i] === 10) line++;
  }
  if (a.length !== b.length) {
    if (!silent) stderr(`cmp: EOF on ${JSON.stringify(a.length < b.length ? first : second)}${count ? ` after byte ${count}${verbose ? "" : `, in line ${line}`}` : " which is empty"}\n`);
    return 1;
  }
  return different ? 1 : 0;
}
function byteName(byte) { if (byte >= 128) return `M-${byteName(byte - 128)}`; if (byte < 32) return `^${String.fromCharCode(byte + 64)}`; return byte === 127 ? "^?" : String.fromCharCode(byte); }
const singleCall = defineCommand("cmp", cmp, cmpMetaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
