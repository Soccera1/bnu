#!/usr/bin/env bun
import { readdirSync, statSync, lstatSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { defineCommand, runAsMain } from "../shared/command.js";
import { parseOptions, globMatch, normalizeLongOptionsByPrefix, decodeSurrogateEscapedBytes } from "../shared/common.js";
import { TextRegex } from "../shared/text-tools.js";
import { stdout, stderr } from "../shared/diagnostics.js";
import { changes, editScript, hunkGroups, lines, normalRange, numberOption, printLine, readBytes, renderSide, renderUnified, trouble } from "../shared/diff-tools.js";

const short = Object.fromEntries([..."abcdeEiNnqrsSywB"].map((key) => [key, false]));
Object.assign(short, { u: false, c: false, U: "value", C: "value", W: "value", x: "value-array", X: "value-array", I: "value-array", L: "value-array", S: "value" });
const long = Object.fromEntries(["normal", "ed", "rcs", "side-by-side", "left-column", "suppress-common-lines", "text", "brief", "report-identical-files", "ignore-case", "ignore-tab-expansion", "ignore-trailing-space", "ignore-space-change", "ignore-all-space", "ignore-blank-lines", "strip-trailing-cr", "recursive", "new-file", "unidirectional-new-file", "minimal", "speed-large-files", "no-dereference", "help", "version"].map((key) => [key, false]));
Object.assign(long, { unified: "optional-value", context: "optional-value", width: "value", label: "value-array", exclude: "value-array", "exclude-from": "value-array", "ignore-matching-lines": "value-array", "starting-file": "value" });
export const DIFF_LONG_OPTIONS = Object.keys(long);
export function diffMetaOption(args) { return args.includes("--help") ? "--help" : args.includes("--version") ? "--version" : null; }
function array(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function enabled(o, a, b) { return o[a] || o[b]; }

export function parseDiffOptions(args) {
  args = args.map((arg) => /^-\d+$/.test(arg) ? `-U${arg.slice(1)}` : /^-[^-]/.test(arg) ? arg.replace(/([uc])(\d+)$/, (_, style, n) => `${style.toUpperCase()}${n}`) : arg);
  const { opts, operands } = parseOptions(normalizeLongOptionsByPrefix(args, DIFF_LONG_OPTIONS), { short, long });
  let format = "normal";
  const formats = [
    [opts.u != null || opts.U != null || opts.unified != null, "unified"],
    [opts.c != null || opts.C != null || opts.context != null, "context"],
    [opts.e || opts.ed, "ed"], [opts.n || opts.rcs, "rcs"], [opts.y || opts["side-by-side"], "side"],
  ].filter(([on]) => on);
  if (formats.length > 1) trouble("conflicting output style options");
  if (formats.length) format = formats[0][1];
  const context = numberOption(opts.U ?? opts.u ?? opts.unified ?? opts.C ?? opts.c ?? opts.context, "context length", 3);
  const width = numberOption(opts.W ?? opts.width, "width", 130);
  if (width < 3) trouble("width must be at least 3");
  const labels = [...array(opts.L), ...array(opts.label)];
  if (labels.length > 2) trouble("too many file label options");
  const excludes = [...array(opts.x), ...array(opts.exclude)];
  for (const file of [...array(opts.X), ...array(opts["exclude-from"])]) excludes.push(...readBytes(file).toString().split("\n").filter(Boolean));
  const ignores = [...array(opts.I), ...array(opts["ignore-matching-lines"])].map((pattern) => new TextRegex(pattern,{newline:true}));
  return { opts, operands, format, context, width, labels, excludes, ignores };
}
export async function diff(args) {
  const cfg = parseDiffOptions(args);
  try {
    if (cfg.operands.length !== 2) trouble(cfg.operands.length < 2 ? "missing operand" : `extra operand '${cfg.operands[2]}'`);
    let [a, b] = cfg.operands;
    let sa = getStat(a, cfg.opts), sb = getStat(b, cfg.opts);
    if (sa?.isDirectory() && !sb?.isDirectory()) { a = join(a, basename(b)); sa = getStat(a, cfg.opts); }
    else if (sb?.isDirectory() && !sa?.isDirectory()) { b = join(b, basename(a)); sb = getStat(b, cfg.opts); }
    return comparePaths(a, b, cfg, false, new Set());
  } finally {for(const pattern of cfg.ignores)pattern.close();}
}
function getStat(path, opts) {
  if (path === "-") return null;
  try { return opts["no-dereference"] ? lstatSync(path) : statSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function comparePaths(a, b, cfg, nested, seen) {
  const o = cfg.opts, sa = getStat(a, o), sb = getStat(b, o);
  const missingA = a !== "-" && !sa, missingB = b !== "-" && !sb;
  if (missingA || missingB) {
    if (!(o.N || o["new-file"] || (o["unidirectional-new-file"] && missingA))) {
      if (nested) { const file = missingA ? b : a; stdout(`Only in ${missingA ? b.slice(0, -basename(b).length - 1) : a.slice(0, -basename(a).length - 1)}: ${basename(file)}\n`); return 1; }
      stderr(`diff: ${missingA ? a : b}: No such file or directory\n`); return 2;
    }
  }
  if (sa?.isDirectory() || sb?.isDirectory()) {
    if ((!sa?.isDirectory() && !missingA) || (!sb?.isDirectory() && !missingB)) { stdout(`File ${a} is a ${sa?.isDirectory() ? "directory" : "regular file"} while file ${b} is a ${sb?.isDirectory() ? "directory" : "regular file"}\n`); return 1; }
    if (nested && !enabled(o, "r", "recursive")) { stdout(`Common subdirectories: ${a} and ${b}\n`); return 0; }
    const identity = `${sa?.dev}:${sa?.ino}/${sb?.dev}:${sb?.ino}`;
    if (seen.has(identity)) { stderr(`diff: recursive directory loop detected: ${a}\n`); return 2; }
    seen.add(identity);
    let code = 0;
    const names = [...new Set([...(sa ? readdirSync(a) : []), ...(sb ? readdirSync(b) : [])])].sort();
    for (const name of names) {
      if (cfg.excludes.some((pattern) => globMatch(pattern, name))) continue;
      if ((o.S || o["starting-file"]) && name < (o.S || o["starting-file"])) continue;
      code = Math.max(code, comparePaths(join(a, name), join(b, name), cfg, true, seen));
    }
    seen.delete(identity);
    return code;
  }
  if (sa?.isSymbolicLink() || sb?.isSymbolicLink()) {
    if (sa?.isSymbolicLink() && sb?.isSymbolicLink() && readlinkSync(a) === readlinkSync(b)) return 0;
    stdout(`Symbolic links ${a} and ${b} differ\n`); return 1;
  }
  if (nested && ((sa && !sa.isFile()) || (sb && !sb.isFile()))) { stdout(`File ${a} is a special file while file ${b} is a special file\n`); return 1; }
  const aa = missingA ? Buffer.alloc(0) : readBytes(a);
  const bb = missingB ? Buffer.alloc(0) : a === "-" && b === "-" ? aa : readBytes(b);
  if (aa.equals(bb)) {
    if (enabled(o, "s", "report-identical-files")) stdout(`Files ${a} and ${b} are identical\n`);
    if (cfg.format === "side" && !o["suppress-common-lines"]) stdout(Buffer.from(renderSide(editScript(lines(aa.toString("latin1")), lines(bb.toString("latin1"))), cfg), "latin1"));
    return 0;
  }
  if (!(o.a || o.text) && (aa.includes(0) || bb.includes(0))) {
    stdout(`${o.q || o.brief ? "Files" : "Binary files"} ${a} and ${b} differ\n`); return 1;
  }
  let script = editScript(lines(aa.toString("latin1")), lines(bb.toString("latin1")), o);
  const edits = changes(script);
  const meaningful = edits.filter((edit) => {
    const content = [...edit.removed, ...edit.added];
    return !content.every((line) => (enabled(o, "B", "ignore-blank-lines") && /^\n?$/.test(line)) || cfg.ignores.some((pattern) => pattern.test(decodeSurrogateEscapedBytes(Buffer.from(line,"latin1")))));
  });
  if (!meaningful.length) {
    if (enabled(o, "s", "report-identical-files")) stdout(`Files ${a} and ${b} are identical\n`);
    if (cfg.format === "side") stdout(Buffer.from(renderSide(script, cfg), "latin1"));
    return 0;
  }
  if (enabled(o, "q", "brief")) { stdout(`Files ${a} and ${b} differ\n`); return 1; }
  const header = (path, s, i) => cfg.labels[i] ?? `${path}\t${timestamp(s?.mtime ?? new Date(0))}`;
  let output;
  // Ignored changes remain context when another change occurs nearby, as GNU
  // diff does, while separately ignored normal-format changes are omitted.
  if (cfg.format === "unified") output = renderUnified(script, header(a, sa, 0), header(b, sb, 1), cfg.context, meaningful);
  else if (cfg.format === "context") output = renderContext(script, header(a, sa, 0), header(b, sb, 1), cfg.context, meaningful);
  else if (cfg.format === "side") output = renderSide(script, cfg);
  else if (cfg.format === "ed") output = renderEd(meaningful);
  else if (cfg.format === "rcs") output = meaningful.map((e) => `${e.removed.length ? `d${e.a + 1} ${e.removed.length}\n` : ""}${e.added.length ? `a${e.a + e.removed.length} ${e.added.length}\n${e.added.join("")}` : ""}`).join("");
  else output = meaningful.map((e) => {
    const type = !e.removed.length ? "a" : !e.added.length ? "d" : "c";
    return `${normalRange(e.a, e.removed.length)}${type}${normalRange(e.b, e.added.length)}\n` + e.removed.map((line) => printLine("< ", line)).join("") + (type === "c" ? "---\n" : "") + e.added.map((line) => printLine("> ", line)).join("");
  }).join("");
  if (nested) stdout(`diff ${cfg.format === "unified" ? "-u " : cfg.format === "context" ? "-c " : ""}${a} ${b}\n`);
  stdout(Buffer.from(output, "latin1"));
  return 1;
}
function timestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const zone = -date.getTimezoneOffset(), sign = zone < 0 ? "-" : "+", tz = Math.abs(zone);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}000000 ${sign}${pad(Math.floor(tz / 60))}${pad(tz % 60)}`;
}
export function renderContext(script, first, second, context, selected) {
  let out = `*** ${first}\n--- ${second}\n`;
  for (const h of hunkGroups(script, context, selected)) {
    const range = (start, count) => count <= 1 ? String(count ? start + 1 : start) : `${start + 1},${start + count}`;
    out += `***************\n*** ${range(h.a, h.na)} ****\n`;
    const ops = h.ops.map((op) => ({ ...op }));
    for (const change of changes(ops)) if (change.removed.length && change.added.length) for (let i = change.index; i < change.end; i++) ops[i].prefix = "! ";
    if (ops.some((op) => op.type === "-")) for (const op of ops) if (op.type !== "+") out += printLine(op.prefix ?? (op.type === " " ? "  " : "- "), op.line);
    out += `--- ${range(h.b, h.nb)} ----\n`;
    if (ops.some((op) => op.type === "+")) for (const op of ops) if (op.type !== "-") out += printLine(op.prefix ?? (op.type === " " ? "  " : "+ "), op.other ?? op.line);
  }
  return out;
}
function renderEd(edits) {
  let output = "";
  for (const e of [...edits].reverse()) {
    const type = !e.removed.length ? "a" : !e.added.length ? "d" : "c";
    output += `${normalRange(e.a, e.removed.length)}${type}\n`;
    if (e.added.length) {
      // A literal dot would terminate ed input; escape it, then substitute.
      output += e.added.map((line) => line === ".\n" ? "..\n" : line.endsWith("\n") ? line : line + "\n").join("") + ".\n";
      e.added.forEach((line, i) => { if (line === ".\n") output += `${e.a + i + 1}s/^\\.\\.$/./\n`; });
    }
  }
  return output;
}
export { renderSide } from "../shared/diff-tools.js";
const singleCall = defineCommand("diff", diff, diffMetaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
