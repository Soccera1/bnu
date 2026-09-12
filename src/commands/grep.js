#!/usr/bin/env bun
import { lstatSync, statSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { globMatch, parseOptions, systemErrorMessage } from "../shared/common.js";
import { InvocationError, UsageError, encodeSurrogateEscapedString, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";
import { TextRegex, PerlRegex, textMeta, textRead, textRecords } from "../shared/text-tools.js";

export async function grep(args) {
  const aliases = { "extended-regexp":"E", "fixed-strings":"F", "basic-regexp":"G", "perl-regexp":"P", "ignore-case":"i", "no-ignore-case":"no-ignore-case", "word-regexp":"w", "line-regexp":"x", "invert-match":"v", count:"c", "files-with-matches":"l", "files-without-match":"L", "only-matching":"o", quiet:"q", silent:"q", "no-messages":"s", "line-number":"n", "byte-offset":"b", "with-filename":"H", "no-filename":"h", recursive:"r", "dereference-recursive":"R", text:"a", "null-data":"z", null:"Z", regexp:"e", file:"f", "max-count":"m", "after-context":"A", "before-context":"B", context:"C", directories:"d", devices:"D" };
  const long = Object.fromEntries(Object.entries(aliases).map(([name, value]) => [name, "ef".includes(value) ? "value-array" : "mABCdD".includes(value) ? "value" : false]));
  Object.assign(long, { include:"value-array", exclude:"value-array", "exclude-dir":"value-array", "exclude-from":"value-array", label:"value", "binary-files":"value", color:"optional-value", colour:"optional-value", "group-separator":"value", "no-group-separator":false, "line-buffered":false, help:false, version:false });
  const short = Object.fromEntries([..."EFGPIiwxvclLoqsnbrRHhazZUyT"].map((key) => [key, false]));
  for (const key of "ef") short[key] = "value-array";
  for (const key of "mABCdD") short[key] = "value";
  args = args.map((arg) => /^-\d+$/.test(arg) ? `-C${arg.slice(1)}` : arg);
  let parsed;
  try { parsed = parseOptions(args, { short, long }); } catch (e) { if (e instanceof UsageError) throw new InvocationError(e.message, 2, e.showHelp); throw e; }
  const { opts, operands } = parsed;
  for (const [key, alias] of Object.entries(aliases)) if (opts[key] !== undefined) opts[alias] = opts[key];
  if (opts.y) opts.i = true;
  if (opts["no-ignore-case"]) opts.i = false;
  const colorValue = opts.color ?? opts.colour, colorMode = colorValue === true ? "auto" : colorValue ?? "never";
  if (!["always","never","auto"].includes(colorMode)) throw new InvocationError(`invalid color argument '${colorMode}'`,2,false);
  const useColor = colorMode === "always" || colorMode === "auto" && process.stdout.isTTY;
  const colors = {ms:"01;31",mc:"01;31",fn:"35",ln:"32",bn:"32",se:"36"};
  for (const value of (process.env.GREP_COLORS ?? "").split(":")) { const equal = value.indexOf("="); if (equal < 0) colors[value] = true; else colors[value.slice(0,equal)] = value.slice(equal+1); }
  if (typeof colors.mt === "string") { colors.ms = colors.mt; colors.mc = colors.mt; }
  const colored = (text,key) => useColor && colors[key] ? `\x1b[${colors[key]}m${colors.ne ? "" : "\x1b[K"}${text}\x1b[m${colors.ne ? "" : "\x1b[K"}` : text;
  if ([opts.E,opts.F,opts.G,opts.P].filter(Boolean).length > 1) throw new InvocationError("conflicting matchers specified", 2, false);
  const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
  const patterns = array(opts.e).flatMap((pattern) => pattern.split("\n"));
  for (const file of array(opts.f)) {
    try { patterns.push(...textRecords(await textRead(file)).map((r) => r.text)); }
    catch (error) { throw new InvocationError(`${file}: ${systemErrorMessage(error)}`, 2, false); }
  }
  if (opts.e === undefined && opts.f === undefined) {
    if (!operands.length) throw new InvocationError("missing pattern", 2, true);
    patterns.push(...operands.shift().split("\n"));
  }
  const numeric = (name, fallback) => {
    if (opts[name] == null) return fallback;
    if (!/^\d+$/.test(opts[name])) throw new InvocationError(`invalid context length argument '${opts[name]}'`, 2, false);
    return Number(opts[name]);
  };
  const max = numeric("m", Infinity), before = numeric("B", numeric("C", 0)), after = numeric("A", numeric("C", 0));
  for (const [key, allowed] of [["d",["read","recurse","skip"]],["D",["read","skip"]],["binary-files",["binary","text","without-match"]]]) {
    if (opts[key] != null && !allowed.includes(opts[key])) throw new InvocationError(`unknown ${key === "d" ? "directories" : key === "D" ? "devices" : "binary-files"} method`,2,false);
  }
  if (opts.d === "recurse") opts.r = true;
  const regexes = patterns.map((pattern) => {
    if (opts.F) return opts.i ? pattern.toLocaleLowerCase() : pattern;
    if (opts.P) return new PerlRegex(pattern,{ignoreCase:!!opts.i});
    return new TextRegex(pattern, { extended: !!opts.E, ignoreCase: !!opts.i });
  });
  const word = (ch) => ch != null && /[\p{L}\p{N}_]/u.test(ch);
  const matches = (text) => {
    const found = [];
    let offset = 0;
    while (offset <= text.length) {
      let best = null;
      for (const regex of regexes) {
        let pos = offset, match;
        do {
          if (typeof regex === "string") {
            const index = (opts.i ? text.toLocaleLowerCase() : text).indexOf(regex, pos);
            match = index < 0 ? null : Object.assign([text.slice(index, index + regex.length)], { index });
          } else match = regex.exec(text, pos);
          if (!match) break;
          if ((!opts.x || match.index === 0 && match[0].length === text.length) && (!opts.w || !word(text[match.index - 1]) && !word(text[match.index + match[0].length]))) break;
          pos = match.index + 1; match = null;
        } while (pos <= text.length);
        if (match && (!best || match.index < best.index || match.index === best.index && match[0].length > best[0].length)) best = match;
      }
      if (!best) break;
      found.push(best);
      offset = best.index + Math.max(1, best[0].length);
      if (!opts.o && !useColor) break;
    }
    return found;
  };
  let errors = false, selectedAny = false, emitted = false;
  const inputs = operands.length ? operands : opts.r || opts.R ? ["."] : ["-"];
  const files = [], excludes = array(opts.exclude);
  for (const file of array(opts["exclude-from"])) {
    try { excludes.push(...textRecords(await textRead(file)).map((r) => r.text)); }
    catch (error) { throw new InvocationError(`${file}: ${systemErrorMessage(error)}`,2,false); }
  }
  const includes = array(opts.include), excludedDirs = array(opts["exclude-dir"]), ancestors = new Set();
  const visit = (file, explicit = false) => {
    if (file === "-") { files.push(file); return; }
    try {
      const lst = lstatSync(file);
      if (lst.isSymbolicLink() && !explicit && !opts.R) return;
      const st = lst.isSymbolicLink() ? statSync(file) : lst;
      if (st.isDirectory()) {
        if (excludedDirs.some((pattern) => globMatch(pattern, basename(file)))) return;
        if (opts.r || opts.R) {
          const identity = `${st.dev}:${st.ino}`;
          if (ancestors.has(identity)) { if (!opts.s) stderr(`grep: ${file}: warning: recursive directory loop\n`); return; }
          ancestors.add(identity);
          for (const name of readdirSync(file)) visit(join(file, name));
          ancestors.delete(identity);
          return;
        }
        if (opts.d === "skip") return;
      }
      if (!st.isFile() && !st.isDirectory() && opts.D === "skip") return;
      if (excludes.some((pattern) => globMatch(pattern, basename(file)))) return;
      if (includes.length && !includes.some((pattern) => globMatch(pattern, basename(file)))) return;
      files.push(file);
    } catch (error) { errors = true; if (!opts.s) stderr(`grep: ${file}: ${systemErrorMessage(error)}\n`); }
  };
  inputs.forEach((file) => visit(file, true));
  const names = !opts.h && (opts.H || inputs.length > 1 || opts.r || opts.R);
  const delimiter = opts.z ? "\0" : "\n";
  try {
    for (const file of files) {
      let text;
      try { text = await textRead(file); }
      catch (error) { errors = true; if (!opts.s) stderr(`grep: ${file}: ${systemErrorMessage(error)}\n`); continue; }
      const label = file === "-" ? opts.label ?? "(standard input)" : file;
      const binary = !opts.z && text.includes("\0") && !opts.a && opts["binary-files"] !== "text";
      const records = textRecords(text, delimiter);
      const hits = [], chosen = new Set();
      let count = 0, offset = 0;
      for (let i = 0; i < records.length; i++) {
        records[i].offset = offset;
        offset += encodeSurrogateEscapedString(records[i].text).length + (records[i].terminated ? 1 : 0);
        const found = count < max && !(binary && (opts.I || opts["binary-files"] === "without-match")) ? matches(records[i].text) : [];
        const selected = count < max && !(binary && (opts.I || opts["binary-files"] === "without-match")) && (opts.v ? !found.length : !!found.length);
        hits[i] = selected ? found : null;
        if (!selected) continue;
        count++; selectedAny = true;
        if (opts.q) return 0;
        if (opts.l || opts.L) break;
        for (let j = Math.max(0, i - before); j <= Math.min(records.length - 1, i + after); j++) chosen.add(j);
      }
      if (opts.l || opts.L) {
        if (opts.l ? count > 0 : count === 0) stdout(label + (opts.Z ? "\0" : "\n"));
        continue;
      }
      if (opts.c) { stdout((names ? label + (opts.Z ? "\0" : ":") : "") + count + delimiter); continue; }
      if (binary && count) { stderr(`grep: ${label}: binary file matches\n`); continue; }
      let previous = -2;
      for (const i of [...chosen].sort((a,b) => a-b)) {
        if (opts.o && (opts.v || !hits[i])) continue;
        if ((before || after) && emitted && i > previous + 1 && !opts["no-group-separator"]) stdout(colored(opts["group-separator"] ?? "--","se") + delimiter);
        const separator = hits[i] ? ":" : "-";
        const prefix = (byteOffset) => (names ? colored(label,"fn") + (opts.Z ? "\0" : colored(separator,"se")) : "") + (opts.n ? colored(String(i+1),"ln")+colored(separator,"se") : "") + (opts.b ? colored(String(byteOffset),"bn")+colored(separator,"se") : "") + (opts.T && (names || opts.n || opts.b) ? "\t" : "");
        if (opts.o) {
          for (const match of hits[i]) if (match[0]) stdout(prefix(records[i].offset + encodeSurrogateEscapedString(records[i].text.slice(0,match.index)).length) + colored(match[0],"ms") + delimiter);
        } else {
          let content = records[i].text;
          if (useColor && hits[i]?.length) { let offset = 0, rendered = ""; for (const match of hits[i]) { rendered += content.slice(offset,match.index) + colored(match[0],"ms"); offset = match.index+match[0].length; } content = rendered+content.slice(offset); }
          stdout(prefix(records[i].offset) + content + delimiter);
        }
        previous = i; emitted = true;
      }
    }
  } finally { for (const regex of regexes) if (typeof regex !== "string") regex.close(); }
  return errors ? 2 : selectedAny ? 0 : 1;
}
const singleCall = defineCommand("grep", grep, (args) => textMeta(args,{valueShort:"efmABCdD",valueLong:["regexp","file","max-count","after-context","before-context","context","directories","devices","include","exclude","exclude-dir","exclude-from","label","binary-files","group-separator"]}));
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
