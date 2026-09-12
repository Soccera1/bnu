#!/usr/bin/env bun
import { defineCommand, runAsMain } from "../shared/command.js";
import { normalizeLongOptionsByPrefix, parseOptions } from "../shared/common.js";
import { stdout } from "../shared/diagnostics.js";
import { changes, editScript, lines, normalRange, printLine, readBytes, trouble } from "../shared/diff-tools.js";

const long = { "show-all": false, "ed": false, "show-overlap": false, "overlap-only": false, "easy-only": false, "merge": false, "text": false, "label": "value-array", "strip-trailing-cr": false, "help": false, "version": false };
export function diff3MetaOption(args) { return args.includes("--help") ? "--help" : args.includes("--version") ? "--version" : null; }
export async function diff3(args) {
  const { opts: o, operands } = parseOptions(normalizeLongOptionsByPrefix(args, Object.keys(long)), { short: { A: false, e: false, E: false, x: false, X: false, "3": false, m: false, a: false, L: "value-array" }, long });
  if (operands.length !== 3) trouble(operands.length < 3 ? "missing operand" : `extra operand '${operands[3]}'`);
  if (operands.filter((p) => p === "-").length > 1) trouble("standard input may only be used once");
  const files = operands.map((p) => readBytes(p));
  if (!(o.a || o.text) && files.some((file) => file.includes(0))) trouble("Binary files differ");
  const [mine, base, theirs] = files.map((file) => lines(file.toString("latin1")));
  const left = changes(editScript(base, mine, o)), right = changes(editScript(base, theirs, o));
  const regions = mergeRegions(left, right);
  const labels = [o.L, o.label].flatMap((value) => value == null ? [] : Array.isArray(value) ? value : [value]);
  if (labels.length > 3) trouble("too many file label options");
  for (let i = labels.length; i < 3; i++) labels.push(operands[i]);
  let cursor = 0, output = "", conflict = false, leftDelta = 0, rightDelta = 0;
  const ed = [];
  const merge = o.m || o.merge;
  const edMode = o.e || o.ed || o.E || o.A || o["show-all"] || o.x || o.X || o["overlap-only"] || o["show-overlap"] || o["3"] || o["easy-only"];
  const showAll = o.A || o["show-all"] || (merge && !edMode);
  for (const region of regions) {
    const ancestor = base.slice(region.start, region.end);
    const ours = applyRegion(base, region.start, region.end, region.left), other = applyRegion(base, region.start, region.end, region.right);
    const same = ours.join("") === other.join("");
    const lChanged = ours.join("") !== ancestor.join(""), rChanged = other.join("") !== ancestor.join("");
    const overlapping = lChanged && rChanged && !same;
    const onlyOverlap = o.x || o.X || o["overlap-only"] || o["show-overlap"], onlyEasy = o["3"] || o["easy-only"];
    let replacement = ours;
    if (!lChanged || same) replacement = other;
    else if (rChanged && (!onlyEasy)) {
      conflict = true;
      if (o.e || o.ed || o.x || o["overlap-only"]) replacement = other;
      else {
        const mark = (content) => content.join("") + (content.length && !content.at(-1).endsWith("\n") ? "\n" : "");
        replacement = lines(`<<<<<<< ${labels[0]}\n${mark(ours)}${o.E || o.X || o["show-overlap"] ? "" : `||||||| ${labels[1]}\n${mark(ancestor)}`}=======\n${mark(other)}>>>>>>> ${labels[2]}\n`);
      }
    }
    if (same && lChanged && showAll) {
      conflict = true;
      const text = (content) => content.join("") + (content.length && !content.at(-1).endsWith("\n") ? "\n" : "");
      replacement = lines(`<<<<<<< ${labels[1]}\n${text(ancestor)}=======\n${text(other)}>>>>>>> ${labels[2]}\n`);
    }
    if ((onlyOverlap && !overlapping) || (onlyEasy && overlapping)) replacement = ours;
    if (merge) { output += mine.slice(cursor, region.start + leftDelta).join("") + replacement.join(""); cursor = region.start + leftDelta + ours.length; }
    else if (edMode) {
      if (replacement.join("") !== ours.join("")) {
        if (replacement.some((line) => line === ".\n")) trouble("ed output with a literal dot is not supported; use --merge");
        ed.push(`${normalRange(region.start + leftDelta, ours.length)}${!ours.length ? "a" : replacement.length ? "c" : "d"}\n${replacement.length ? replacement.join("") + (replacement.at(-1).endsWith("\n") ? "" : "\n") + ".\n" : ""}`);
      }
    } else {
      const odd = same ? "2" : !lChanged ? "3" : !rChanged ? "1" : "";
      output += `====${odd}\n`;
      const sections = [
        { n: 1, at: region.start + leftDelta, content: ours },
        { n: 2, at: region.start, content: ancestor },
        { n: 3, at: region.start + rightDelta, content: other },
      ];
      if (odd === "2") sections.splice(0, 3, sections[0], sections[2], sections[1]);
      for (let n = 0; n < sections.length; n++) {
        const section = sections[n];
        output += `${section.n}:${normalRange(section.at, section.content.length)}${section.content.length ? "c" : "a"}\n`;
        if (!odd || section.n === Number(odd) || n === sections.length - 1 || sections[n + 1].n === Number(odd)) output += section.content.map((line) => printLine("  ", line)).join("");
      }
    }
    leftDelta += ours.length - ancestor.length; rightDelta += other.length - ancestor.length;
  }
  if (merge) output += mine.slice(cursor).join("");
  else if (edMode) output = ed.reverse().join("");
  stdout(Buffer.from(output, "latin1"));
  return conflict && (merge || edMode) ? 1 : 0;
}
function mergeRegions(left, right) {
  const edits = [...left.map((edit) => ({ edit, side: "left" })), ...right.map((edit) => ({ edit, side: "right" }))].sort((a, b) => a.edit.a - b.edit.a);
  const regions = [];
  for (const { edit, side } of edits) {
    const end = edit.a + edit.removed.length;
    let region = regions.at(-1);
    if (!region || edit.a > region.end || edit.a === region.end && edit.removed.length > 0 && region.end > region.start) {
      region = { start: edit.a, end, left: [], right: [] }; regions.push(region);
    }
    region.end = Math.max(region.end, end); region[side].push(edit);
  }
  return regions;
}
function applyRegion(base, start, end, edits) {
  const out = []; let cursor = start;
  for (const edit of edits) { out.push(...base.slice(cursor, edit.a), ...edit.added); cursor = edit.a + edit.removed.length; }
  out.push(...base.slice(cursor, end)); return out;
}
const singleCall = defineCommand("diff3", diff3, diff3MetaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
