#!/usr/bin/env bun
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { defineCommand, runAsMain } from "../shared/command.js";
import { normalizeLongOptionsByPrefix, parseOptions } from "../shared/common.js";
import { stdout, stderr } from "../shared/diagnostics.js";
import { lines, numberOption, readBytes, trouble, unifiedRange, printLine } from "../shared/diff-tools.js";

const short = Object.fromEntries([..."bcEflNnRstuv"].map((name) => [name, false]));
Object.assign(short, { d: "value", i: "value", o: "value", p: "value", r: "value", z: "value", F: "value", V: "value" });
const long = Object.fromEntries(["backup", "backup-if-mismatch", "no-backup-if-mismatch", "context", "dry-run", "remove-empty-files", "force", "ignore-whitespace", "ignore-white-space", "forward", "normal", "reverse", "quiet", "silent", "batch", "unified", "verbose", "binary", "posix", "help", "version"].map((name) => [name, false]));
Object.assign(long, { directory: "value", input: "value", output: "value", strip: "value", "reject-file": "value", suffix: "value", fuzz: "value", "version-control": "value" });
export const PATCH_LONG_OPTIONS = Object.keys(long);
export function patchMetaOption(args) { return args.includes("--help") ? "--help" : args.includes("--version") || args.includes("-v") ? "--version" : null; }

export async function patch(args) {
  const { opts: o, operands } = parseOptions(normalizeLongOptionsByPrefix(args, PATCH_LONG_OPTIONS), { short, long });
  if (operands.length > 2) trouble(`extra operand '${operands[2]}'`);
  if ((o.i || o.input) && operands[1]) trouble("patch file specified twice");
  const root = resolve(o.d ?? o.directory ?? ".");
  if (!lstatSync(root).isDirectory()) trouble(`${root}: Not a directory`);
  const strip = o.p == null && o.strip == null ? null : numberOption(o.p ?? o.strip, "strip count", 0);
  const fuzz = numberOption(o.F ?? o.fuzz, "fuzz factor", 2);
  const control = o.V ?? o["version-control"] ?? "simple";
  if (!["simple", "never", "numbered", "t", "existing", "nil", "none", "off"].includes(control)) trouble(`invalid backup type '${control}'`);
  const source = o.i ?? o.input ?? operands[1] ?? "-";
  const raw = readBytes(source === "-" ? "-" : resolve(root, source)).toString("latin1");
  const patches = parsePatch(raw);
  if (!patches.length) { if (!raw.trim()) return 0; trouble("Only garbage was found in the patch input."); }
  const formats=[[o.u||o.unified,"unified"],[o.c||o.context,"context"],[o.n||o.normal,"normal"]].filter(([selected])=>selected).map(([,format])=>format);
  if(formats.length>1)trouble("conflicting patch input formats");
  if(formats.length && patches.some(p=>p.format!==formats[0]))trouble(`input is not a ${formats[0]} patch`);
  const reverse = !!(o.R || o.reverse), dry = !!o["dry-run"], quiet = !!(o.s || o.quiet || o.silent);
  const whitespace = !!(o.l || o["ignore-whitespace"] || o["ignore-white-space"]);
  // Resolve every header before any mutation, so a later unsafe path cannot
  // turn an otherwise valid multi-file patch into a partial traversal attack.
  const jobs = patches.map((patch) => {
    const old = reverse ? patch.newName : patch.oldName, next = reverse ? patch.oldName : patch.newName;
    const derived = [old, next].filter((name) => name && name !== "/dev/null").map((name) => safeHeaderPath(root, name, strip));
    const target = operands[0] ? resolve(root, operands[0]) : derived.find((path) => existsSync(path)) ?? derived[0];
    if (!target) trouble("can't find file to patch; specify a file operand");
    assertNoSymlinks(target);
    const output = o.o ?? o.output;
    if (output && output !== "-") assertNoSymlinks(resolve(root, output));
    return { patch, target, old, next, hunks: reverse ? patch.hunks.map(reverseHunk) : patch.hunks };
  });
  let status = 0;
  for (const job of jobs) {
    const { target } = job;
    let {old,next,hunks}=job;
    const display = relative(root, target) || basename(target);
    const existed = existsSync(target);
    if (existed && !lstatSync(target).isFile()) trouble(`${display}: not a regular file`);
    if (!existed && old !== "/dev/null" && !hunks.every((h) => h.oldCount === 0)) { stderr(`patch: ${display}: No such file or directory\n`); status = 1; continue; }
    const original = existed ? readFileSync(target) : Buffer.alloc(0);
    const current = lines(original.toString("latin1"));
    if(!(o.f||o.force) && (o.N||o.forward||o.t||o.batch)) {
      const backward=hunks.map(reverseHunk),previous=canApplyHunks(current,backward,fuzz,whitespace),forward=canApplyHunks(current,hunks,fuzz,whitespace);
      const insertionOnly=hunks.every(h=>!h.ops.some(op=>op.type==="-"));
      const already=previous.applies && (!forward.applies || (insertionOnly && previous.exact));
      if(already) {
        if(o.N||o.forward) { if(!quiet)stdout(`Reversed (or previously applied) patch detected! Skipping patch for ${display}.\n`);status=1;continue; }
        hunks=backward;[old,next]=[next,old];if(!quiet)stdout("Reversed (or previously applied) patch detected! Assuming -R.\n");
      }
    }
    if (old === "/dev/null" && existed) { stderr(`patch: ${display}: file already exists\n`); status = 1; continue; }
    if (!quiet) stdout(`${dry ? "checking" : "patching"} file ${display}\n`);
    let delta = 0, minimum = 0, mismatched = false;
    const rejected = [];
    for (let index = 0; index < hunks.length; index++) {
      const h = hunks[index];
      const expected = h.oldStart + delta;
      const match = locateHunk(current, h, expected, minimum, fuzz, whitespace);
      if (!match) {
        rejected.push(h); status = 1;
        stdout(`Hunk #${index + 1} FAILED at ${h.oldStart + 1 + delta}.\n`);
        continue;
      }
      const offset = match.at - expected;
      const remove = h.oldLines.length - match.front - match.back;
      let originalAt = match.at;
      const newLines = [];
      for (const op of h.ops) {
        if (op.type === " ") newLines.push(current[originalAt++]);
        else if (op.type === "-") originalAt++;
        else newLines.push(op.line);
      }
      const replacement = newLines.slice(match.front, newLines.length - match.back);
      current.splice(match.at + match.front, remove, ...replacement);
      minimum = match.at + h.newLines.length - match.back;
      delta += h.newCount - h.oldCount + offset;
      if (offset || match.front || match.back) {
        mismatched = true;
        if (!quiet) stdout(`Hunk #${index + 1} succeeded at ${match.at + 1}${match.front || match.back ? ` with fuzz ${Math.max(match.front, match.back)}` : ""}${offset ? ` (offset ${offset} line${Math.abs(offset) === 1 ? "" : "s"})` : ""}.\n`);
      }
    }
    const result = Buffer.from(current.join(""), "latin1");
    const output = o.o ?? o.output;
    if (!dry) {
      if (output === "-") stdout(result);
      else {
        const destination = output ? resolve(root, output) : target;
        const backup = existed && control !== "none" && control !== "off" && (o.b || o.backup || ((mismatched || rejected.length) && !o["no-backup-if-mismatch"] && !o.posix));
        if (backup && (!output || destination === target)) {
          const backupPath = backupName(target, o.z ?? o.suffix ?? ".orig", control);
          assertNoSymlinks(backupPath);
          copyFileSync(target, backupPath);
        }
        if (!output && !rejected.length && result.length === 0 && (next === "/dev/null" || o.E || o["remove-empty-files"])) { if (existed) unlinkSync(target); }
        else if (!result.equals(original) || !existed || output) writeAtomic(destination, result, existed ? lstatSync(target).mode & 0o777 : 0o666);
      }
      if (rejected.length) {
        const rejectArg = o.r ?? o["reject-file"];
        if (rejectArg !== "-") {
          const rejectPath = rejectArg ? resolve(root, rejectArg) : `${target}.rej`;
          assertNoSymlinks(rejectPath);
          const rejection = `--- ${job.patch.oldName ?? display}\n+++ ${job.patch.newName ?? display}\n` + rejected.map(renderReject).join("");
          writeAtomic(rejectPath, Buffer.from(rejection, "latin1"), 0o666);
        }
      }
    }
    if (rejected.length) stdout(`${rejected.length} out of ${hunks.length} hunk${hunks.length === 1 ? "" : "s"} FAILED${dry ? "" : ` -- saving rejects to file ${o.r ?? o["reject-file"] ?? display + ".rej"}`}\n`);
  }
  return status;
}
function backupName(path, suffix, control) {
  if (["numbered", "t"].includes(control) || ["existing", "nil"].includes(control) && existsSync(`${path}.~1~`)) {
    let n = 1; while (existsSync(`${path}.~${n}~`)) n++;
    return `${path}.~${n}~`;
  }
  const result = path + suffix;
  if (result === path) trouble("backup suffix must not be empty");
  return result;
}
function safeHeaderPath(root, name, strip) {
  if (name.includes("\0")) trouble("unsafe file name in patch");
  const pieces = name.split("/");
  let stripped = strip == null ? basename(name) : pieces.slice(strip).join("/");
  if (!stripped || isAbsolute(stripped) || stripped.split(/[\\/]/).includes("..") || /^[A-Za-z]:/.test(stripped)) trouble(`unsafe file name '${name}' in patch`);
  const path = resolve(root, stripped);
  if (path === root || !path.startsWith(root + sep)) trouble(`unsafe file name '${name}' in patch`);
  assertNoSymlinks(path);
  return path;
}
function assertNoSymlinks(path) {
  let at = resolve(path);
  while (true) {
    try { if (lstatSync(at).isSymbolicLink()) trouble(`refusing to follow symbolic link '${at}'`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(at); if (parent === at) break; at = parent;
  }
}
function writeAtomic(path, bytes, mode) {
  assertNoSymlinks(path);
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.bnu-patch-${randomUUID()}`);
  try { writeFileSync(temp, bytes, { flag: "wx", mode }); renameSync(temp, path); }
  finally { try { unlinkSync(temp); } catch {} }
}
function headerName(text) {
  if (text.startsWith('"')) {
    const quoted = text.match(/^"(?:[^"\\]|\\.)*"/)?.[0];
    if (!quoted) trouble("malformed quoted patch file name");
    try { return JSON.parse(quoted.replace(/\\([0-7]{1,3})/g, (_, octal) => `\\u${parseInt(octal, 8).toString(16).padStart(4, "0")}`)); } catch { trouble("malformed quoted patch file name"); }
  }
  return text.split("\t")[0].replace(/\s+\d{4}-\d\d-\d\d.*$/, "").replace(/\n$/, "");
}
function range(start, end, isCount = false) {
  start = Number(start);
  const count = isCount ? end == null ? 1 : Number(end) : start === 0 ? 0 : end == null ? 1 : Number(end) - start + 1;
  if (count < 0 || !Number.isSafeInteger(count) || !Number.isSafeInteger(start)) trouble("invalid hunk range");
  return [count ? start - 1 : start, count];
}
function makeHunk(oldStart, oldCount, newStart, newCount, ops) {
  const oldLines = ops.filter((o) => o.type !== "+").map((o) => o.line), newLines = ops.filter((o) => o.type !== "-").map((o) => o.line);
  if (oldLines.length !== oldCount || newLines.length !== newCount) trouble("malformed patch: hunk line counts do not match header");
  let leading = 0, trailing = 0;
  while (leading < ops.length && ops[leading].type === " ") leading++;
  while (trailing < ops.length - leading && ops[ops.length - 1 - trailing].type === " ") trailing++;
  return { oldStart, oldCount, newStart, newCount, oldLines, newLines, leading, trailing, ops };
}
export function parsePatch(text) {
  const input = lines(text), patches = [];
  let i = 0, active = null;
  const ensure = (format) => { if (!active || (active.format!==format && active.hunks.length)) { active = { hunks: [],format }; patches.push(active); } if(active.format!==format)trouble("patch hunk does not match its file header format");return active; };
  const takeLine = (prefix) => {
    if (!input[i]?.startsWith(prefix)) trouble(`malformed patch at line ${i + 1}`);
    let value = input[i++].slice(prefix.length);
    if (input[i]?.startsWith("\\ No newline at end of file")) { value = value.replace(/\n$/, ""); i++; }
    return value;
  };
  while (i < input.length) {
    if (input[i].startsWith("--- ") && input[i + 1]?.startsWith("+++ ")) {
      active = { oldName: headerName(input[i++].slice(4)), newName: headerName(input[i++].slice(4)), hunks: [],format:"unified" }; patches.push(active); continue;
    }
    if (input[i].startsWith("*** ") && !/^\*\*\* \d+(?:,\d+)? \*\*\*\*/.test(input[i]) && input[i + 1]?.startsWith("--- ")) {
      active = { oldName: headerName(input[i++].slice(4)), newName: headerName(input[i++].slice(4)), hunks: [],format:"context" }; patches.push(active); continue;
    }
    let match = input[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (match) {
      i++;
      const [os, oc] = range(match[1], match[2], true), [ns, nc] = range(match[3], match[4], true), ops = [];
      let old = 0, next = 0;
      while (old < oc || next < nc) {
        const type = input[i]?.[0];
        if (![" ", "+", "-"].includes(type)) trouble(`malformed patch at line ${i + 1}`);
        const line = takeLine(type); ops.push({ type, line });
        if (type !== "+") old++; if (type !== "-") next++;
        if (old > oc || next > nc) trouble("malformed patch: hunk exceeds header line counts");
      }
      ensure("unified").hunks.push(makeHunk(os, oc, ns, nc, ops)); continue;
    }
    if (input[i].startsWith("***************")) {
      i++;
      match = input[i++]?.match(/^\*\*\* (\d+)(?:,(\d+))? \*\*\*\*/);
      if (!match) trouble("malformed context patch");
      const [os, oc] = range(match[1], match[2]), old = [], next = [];
      while (i < input.length && !/^--- \d+(?:,\d+)? ----/.test(input[i])) {
        const type = input[i]?.slice(0, 2); if (!["  ", "- ", "! "].includes(type)) trouble("malformed context patch");
        old.push({ type: type[0], line: takeLine(type) });
      }
      match = input[i++]?.match(/^--- (\d+)(?:,(\d+))? ----/);
      if (!match) trouble("malformed context patch");
      const [ns, nc] = range(match[1], match[2]);
      while (i < input.length && next.length < nc && ["  ", "+ ", "! "].includes(input[i].slice(0, 2))) { const type = input[i].slice(0, 2); next.push({ type: type[0], line: takeLine(type) }); }
      if (!old.length) old.push(...next.filter((o) => o.type === " "));
      if (!next.length) next.push(...old.filter((o) => o.type === " "));
      const ops = [], aa = [...old], bb = [...next];
      while (aa.length || bb.length) {
        while (aa[0] && aa[0].type !== " ") ops.push({ type: "-", line: aa.shift().line });
        while (bb[0] && bb[0].type !== " ") ops.push({ type: "+", line: bb.shift().line });
        if (aa[0] || bb[0]) {
          if (aa[0]?.type !== " " || bb[0]?.type !== " " || aa[0].line !== bb[0].line) trouble("malformed context patch: inconsistent context");
          ops.push({ type: " ", line: aa.shift().line }); bb.shift();
        }
      }
      ensure("context").hunks.push(makeHunk(os, oc, ns, nc, ops)); continue;
    }
    match = input[i].match(/^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?\n?$/);
    if (match) {
      i++;
      let [os, oc] = range(match[1], match[2]), [ns, nc] = range(match[4], match[5]);
      if (match[3] === "a") { os = Number(match[1]); oc = 0; }
      if (match[3] === "d") { ns = Number(match[4]); nc = 0; }
      const ops = [];
      for (let n = 0; n < oc; n++) ops.push({ type: "-", line: takeLine("< ") });
      if (match[3] === "c") { if (input[i++] !== "---\n") trouble("malformed normal patch"); }
      for (let n = 0; n < nc; n++) ops.push({ type: "+", line: takeLine("> ") });
      ensure("normal").hunks.push(makeHunk(os, oc, ns, nc, ops)); continue;
    }
    if (input[i].startsWith("@@") || input[i].startsWith("\\ No newline")) trouble(`malformed patch at line ${i + 1}`);
    i++;
  }
  if (patches.some((p) => !p.hunks.length)) trouble("patch contains a file header without any hunks");
  return patches;
}
function reverseHunk(h) { return makeHunk(h.newStart, h.newCount, h.oldStart, h.oldCount, h.ops.map((op) => ({ ...op, type: op.type === "+" ? "-" : op.type === "-" ? "+" : " " }))); }
function canApplyHunks(original,hunks,fuzz,whitespace) {
  const current=[...original];let delta=0,minimum=0,exact=true;
  for(const h of hunks) {
    const expected=h.oldStart+delta,match=locateHunk(current,h,expected,minimum,fuzz,whitespace);
    if(!match)return {applies:false,exact:false};
    if(match.at!==expected || match.front || match.back)exact=false;
    let at=match.at;const replacement=[];
    for(const op of h.ops) {if(op.type===" ")replacement.push(current[at++]);else if(op.type==="-")at++;else replacement.push(op.line);}
    current.splice(match.at+match.front,h.oldLines.length-match.front-match.back,...replacement.slice(match.front,replacement.length-match.back));
    delta+=h.newCount-h.oldCount+match.at-expected;minimum=match.at+h.newLines.length-match.back;
  }
  return {applies:true,exact};
}
function locateHunk(current, h, expected, minimum, fuzz, whitespace) {
  const key = (s) => whitespace ? s.replace(/[ \t]+/g, " ") : s;
  const matches = (at, front, back) => {
    if (at < 0 || at + h.oldLines.length > current.length || at + front < minimum) return false;
    for (let j = front; j < h.oldLines.length - back; j++) if (key(current[at + j]) !== key(h.oldLines[j])) return false;
    return true;
  };
  if (!h.oldLines.length) return expected >= minimum && expected <= current.length ? { at: expected, front: 0, back: 0 } : null;
  for (let f = 0; f <= Math.min(fuzz, Math.max(h.leading, h.trailing)); f++) {
    const front = Math.min(f, h.leading), back = Math.min(f, h.trailing);
    if (front + back >= h.oldLines.length) continue;
    const center = Math.max(0, Math.min(current.length - h.oldLines.length, expected));
    for (let offset = 0; offset <= current.length; offset++) {
      for (const at of offset ? [center + offset, center - offset] : [center]) if (matches(at, front, back)) return { at, front, back };
    }
  }
  return null;
}
function renderReject(h) { return `@@ -${unifiedRange(h.oldStart, h.oldCount)} +${unifiedRange(h.newStart, h.newCount)} @@\n` + h.ops.map((op) => printLine(op.type, op.line)).join(""); }
const singleCall = defineCommand("patch", patch, patchMetaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
