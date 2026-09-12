#!/usr/bin/env bun
import { statSync } from "node:fs";
import { basename, join } from "node:path";
import { defineCommand, runAsMain } from "../shared/command.js";
import { parseOptions, normalizeLongOptionsByPrefix, decodeSurrogateEscapedBytes } from "../shared/common.js";
import { TextRegex } from "../shared/text-tools.js";
import { stdout } from "../shared/diagnostics.js";
import { changes, editScript, lines, numberOption, readBytes, renderSide, trouble } from "../shared/diff-tools.js";

const short = Object.fromEntries([..."abBdEilsWtZ"].map(key => [key, false]));
short.w = "value";
short.I = "value-array";
const long = Object.fromEntries(["text", "ignore-space-change", "ignore-blank-lines", "minimal", "ignore-tab-expansion", "ignore-case", "left-column", "suppress-common-lines", "ignore-all-space", "expand-tabs", "ignore-trailing-space", "strip-trailing-cr", "speed-large-files"].map(key => [key, false]));
long.width = "value";
long["ignore-matching-lines"] = "value-array";
export async function sdiff(args) {
  const { opts, operands } = parseOptions(normalizeLongOptionsByPrefix(args, Object.keys(long)), { short, long });
  if (operands.length !== 2) trouble(operands.length < 2 ? "missing operand" : `extra operand '${operands[2]}'`);
  const width = numberOption(opts.w ?? opts.width, "width", 130);
  if (width < 3) trouble("width must be at least 3");
  const cfg = { width, opts: { ...opts, w: !!(opts.W || opts["ignore-all-space"]), "suppress-common-lines": opts.s || opts["suppress-common-lines"], "left-column": opts.l || opts["left-column"], "ignore-trailing-space": opts.Z || opts["ignore-trailing-space"] } };
  let [a, b] = operands;
  if (a !== "-" && statSync(a).isDirectory()) a = join(a, basename(b));
  if (b !== "-" && statSync(b).isDirectory()) b = join(b, basename(a));
  const left = readBytes(a), right = a === "-" && b === "-" ? left : readBytes(b);
  if (!(opts.a || opts.text) && (left.includes(0) || right.includes(0))) {
    if (left.equals(right)) return 0;
    stdout(`Binary files ${a} and ${b} differ\n`);
    return 1;
  }
  const script = editScript(lines(left.toString("latin1")), lines(right.toString("latin1")), cfg.opts);
  const patterns = [opts.I, opts["ignore-matching-lines"]].flat().filter(value => value != null).map(pattern => new TextRegex(pattern,{newline:true}));
  const meaningful = changes(script).filter(edit => ![...edit.removed, ...edit.added].every(line => ((opts.B || opts["ignore-blank-lines"]) && /^\n?$/.test(line)) || patterns.some(pattern => pattern.test(decodeSurrogateEscapedBytes(Buffer.from(line,"latin1"))))));
  for(const pattern of patterns)pattern.close();
  stdout(Buffer.from(renderSide(script, cfg), "latin1"));
  return meaningful.length ? 1 : 0;
}
const meta = args => {
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg === "--help" || arg === "--version") return arg;
  }
  return null;
};
const singleCall = defineCommand("sdiff", sdiff, meta);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
