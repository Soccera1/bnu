#!/usr/bin/env bun
import { chmodSync, statSync, realpathSync, renameSync, unlinkSync, writeFileSync, appendFileSync, openSync, closeSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeSurrogateEscapedBytes, parseOptions, systemErrorMessage } from "../shared/common.js";
import { InvocationError, encodeSurrogateEscapedString, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";
import { textMeta, textRead, textRecords } from "../shared/text-tools.js";
import { parseSed, sedReplacement } from "../shared/sed-program.js";

function unbufferedSedRecords(files, delimiter, report) {
  function* records() {
    for (const file of files) {
      let fd;
      try {
        fd = file === "-" ? 0 : openSync(file,"r");
        const byte = Buffer.alloc(1), bytes = [];
        while (readSync(fd,byte,0,1,null)) {
          if (byte[0] === delimiter.charCodeAt(0)) { yield {text:decodeSurrogateEscapedBytes(Buffer.from(bytes)),terminated:true,file}; bytes.length = 0; }
          else bytes.push(byte[0]);
        }
        if (bytes.length) yield {text:decodeSurrogateEscapedBytes(Buffer.from(bytes)),terminated:false,file};
      } catch (error) { report(file,error); }
      finally { if (fd != null && file !== "-") closeSync(fd); }
    }
  }
  const iterator = records(), cache = new Map(); let next = 0, ended = false;
  return {
    get(index) {
      while (!ended && next <= index) { const value = iterator.next(); if (value.done) ended = true; else cache.set(next++,value.value); }
      return cache.get(index);
    },
    discard(index) { for (const key of cache.keys()) if (key < index) cache.delete(key); },
    close() { iterator.return(); },
  };
}

export async function sed(args) {
  // Preserve ordering between -e and -f, which changes the program.
  const sources = [], normalized = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { normalized.push(...args.slice(i)); break; }
    const m = arg.match(/^(?:-([ef])(.*)|--(expression|file)(?:=(.*))?)$/s);
    if (m) {
      const kind = m[1] ?? (m[3] === "file" ? "f" : "e");
      const value = m[1] ? m[2] || args[++i] : m[4] ?? args[++i];
      if (value == null) throw new InvocationError(`option '${arg}' requires an argument`,1,true);
      sources.push(kind === "f" ? await textRead(value) : value);
    } else if (/^-[^-]*[ef]/.test(arg)) {
      const match = arg.match(/^-([^ef]*)([ef])(.*)$/s);
      if (match[1]) normalized.push("-" + match[1]);
      const value = match[3] || args[++i];
      if (value == null) throw new InvocationError(`option '-${match[2]}' requires an argument`,1,true);
      sources.push(match[2] === "f" ? await textRead(value) : value);
    } else normalized.push(arg);
  }
  const { opts, operands } = parseOptions(normalized, { short:{ n:false,E:false,r:false,s:false,z:false,u:false,i:"optional-value",l:"value" }, long:{ quiet:false,silent:false,"regexp-extended":false,separate:false,"null-data":false,unbuffered:false,"in-place":"optional-value","line-length":"value",posix:false,sandbox:false,"follow-symlinks":false,help:false,version:false } });
  if (!sources.length) { if (!operands.length) throw new InvocationError("missing script",1,true); sources.push(operands.shift()); }
  const script = sources.join("\n"), quiet = opts.n || opts.quiet || opts.silent || script.startsWith("#n"), delimiter = opts.z || opts["null-data"] ? "\0" : "\n";
  const inPlace = opts.i ?? opts["in-place"], separate = inPlace != null || opts.s || opts.separate;
  const unbuffered = (opts.u || opts.unbuffered) && inPlace == null;
  const listWidth = opts.l ?? opts["line-length"] ?? 70;
  if (!/^\d+$/.test(String(listWidth))) throw new InvocationError(`invalid line length '${listWidth}'`,1,false);
  if (inPlace != null && !operands.length) throw new InvocationError("no input files",1,false);
  const program = parseSed(script, !!(opts.E || opts.r || opts["regexp-extended"]));
  if (opts.sandbox && program.commands.some((cmd) => "rRwW".includes(cmd.op) || cmd.file)) throw new InvocationError("e/r/w commands disabled in sandbox mode",1,false);
  const inputGroups = [], outputFiles = new Set(program.commands.filter((c) => "wW".includes(c.op) || c.op === "s" && c.file).map((c) => c.file));
  for (const file of outputFiles) writeFileSync(file, "");
  let errors = false;
  const files = operands.length ? operands : ["-"];
  for (let file of unbuffered ? [] : files) {
    try {
      if (inPlace != null && opts["follow-symlinks"]) file = realpathSync(file);
      if (inPlace != null && (file === "-" || !statSync(file).isFile())) throw new InvocationError(`couldn't edit ${file}: not a regular file`,1,false);
      inputGroups.push({ file, records: textRecords(await textRead(file), delimiter).map((record) => ({ ...record, file })) });
    } catch (error) { errors = true; stderr(`sed: ${file}: ${systemErrorMessage(error)}\n`); }
  }
  let status = 0, quit = false, hold = "", holdTerminated = true;
  const report = (file,error) => { errors = true; stderr(`sed: ${file}: ${systemErrorMessage(error)}\n`); };
  const groups = unbuffered ? (separate ? files.map((file) => ({file,records:unbufferedSedRecords([file],delimiter,report)})) : [{file:null,records:unbufferedSedRecords(files,delimiter,report)}]) : separate ? inputGroups : [{ file: null, records: inputGroups.flatMap((group) => group.records) }];
  try {
    for (const group of groups) {
      if (quit) break;
      for (const cmd of program.commands) { cmd.active = cmd.first?.number === 0 && !!cmd.second; cmd.rangeEnd = 0; }
      if (separate) { hold = ""; holdTerminated = true; }
      const output = []; let pendingNewline = false;
      const recordAt = (index) => unbuffered ? group.records.get(index) : group.records[index];
      const emit = (value, terminated = true) => {
        const chunk = (pendingNewline ? delimiter : "") + value + (terminated ? delimiter : "");
        if (inPlace != null) output.push(chunk); else stdout(chunk);
        pendingNewline = !terminated;
      };
      let i = 0;
      while (!quit && recordAt(i)) {
        let record = recordAt(i), pattern = record.text, terminated = record.terminated, deleted = false, substituted = false, appended = [];
        const addressMatches = (address) => address.last ? !recordAt(i+1) : address.regex ? program.getRegex(address.regex).test(pattern) : address.step != null ? i + 1 >= address.number && (i + 1 - address.number) % address.step === 0 : i + 1 === address.number;
        const selected = (cmd) => {
          let applies = !cmd.first, rangeFinished = false;
          if (cmd.first && !cmd.second) applies = addressMatches(cmd.first);
          else if (cmd.second) {
            const already = cmd.active;
            if (!cmd.active && addressMatches(cmd.first)) {
              cmd.active = true;
              if (cmd.second.relative != null) cmd.rangeEnd = i + 1 + cmd.second.relative;
              if (cmd.second.multiple != null) cmd.rangeEnd = i + 1 + cmd.second.multiple - (i + 1) % cmd.second.multiple;
            }
            applies = cmd.active;
            if (cmd.active && (cmd.second.number != null ? i + 1 >= cmd.second.number : cmd.rangeEnd ? i + 1 >= cmd.rangeEnd : (already || !cmd.second.regex) && addressMatches(cmd.second))) { cmd.active = false; rangeFinished = true; }
          }
          cmd.rangeFinished = rangeFinished;
          return cmd.invert ? !applies : applies;
        };
        for (let pc = 0; pc < program.commands.length; pc++) {
          const cmd = program.commands[pc];
          if (!selected(cmd)) { if (cmd.op === "{") pc = cmd.end; continue; }
          switch (cmd.op) {
            case "{": case "}": case ":": break;
            case "p": emit(pattern, terminated); break;
            case "P": emit(pattern.split(delimiter,1)[0], pattern.includes(delimiter) || terminated); break;
            case "=": emit(String(i + 1)); break;
            case "F": emit(record.file); break;
            case "z": pattern = ""; break;
            case "d": deleted = true; pc = program.commands.length; break;
            case "D": { const end = pattern.indexOf(delimiter); if (end < 0) { deleted = true; pc = program.commands.length; } else { pattern = pattern.slice(end + 1); pc = -1; } break; }
            case "h": hold = pattern; holdTerminated = terminated; break;
            case "H": hold += delimiter + pattern; holdTerminated = terminated; break;
            case "g": pattern = hold; terminated = holdTerminated; break;
            case "G": pattern += delimiter + hold; terminated = holdTerminated; break;
            case "x": [pattern,hold] = [hold,pattern]; [terminated,holdTerminated] = [holdTerminated,terminated]; break;
            case "a": appended.push(cmd.text + delimiter); break;
            case "i": emit(cmd.text); break;
            case "c": if (!cmd.second || cmd.rangeFinished || !recordAt(i+1)) emit(cmd.text); deleted = true; pc = program.commands.length; break;
            case "q": case "Q": status = cmd.number ?? 0; quit = true; deleted = cmd.op === "Q"; pc = program.commands.length; break;
            case "n":
              if (!quiet) emit(pattern, terminated);
              for (const text of appended) emit(text.endsWith(delimiter) ? text.slice(0,-1) : text, text.endsWith(delimiter)); appended = [];
              if (!recordAt(++i)) { deleted = true; pc = program.commands.length; }
              else { record = recordAt(i); pattern = record.text; terminated = record.terminated; substituted = false; }
              break;
            case "N":
              if (!recordAt(i+1)) { pc = program.commands.length; break; }
              record = recordAt(++i); pattern += delimiter + record.text; terminated = record.terminated; substituted = false; break;
            case "b": pc = cmd.target - 1; break;
            case "t": case "T": { const branch = cmd.op === "t" ? substituted : !substituted; substituted = false; if (branch) pc = cmd.target - 1; break; }
            case "y": pattern = [...pattern].map((ch) => { const n = cmd.from.indexOf(ch); return n < 0 ? ch : cmd.to[n]; }).join(""); break;
            case "s": {
              const regex = program.getRegex(cmd.regex); let start = 0, copied = 0, count = 0, result = "", changed = false, previousEnd = -1;
              while (start <= pattern.length) {
                const match = regex.exec(pattern, start); if (!match) break;
                const end = match.index + match[0].length;
                if (!match[0] && match.index === previousEnd) { start = match.index + 1; continue; }
                count++;
                if (count >= cmd.nth && (cmd.global || count === cmd.nth)) { result += pattern.slice(copied,match.index) + sedReplacement(cmd.replacement,match); copied = end; changed = true; }
                previousEnd = end; start = match.index + Math.max(1,match[0].length);
                if (count >= cmd.nth && !cmd.global) break;
              }
              if (changed) { pattern = result + pattern.slice(copied); substituted = true; if (cmd.print) emit(pattern,terminated); if (cmd.file) appendFileSync(cmd.file, encodeSurrogateEscapedString(pattern + (terminated ? delimiter : ""))); }
              break;
            }
            case "w": case "W": appendFileSync(cmd.file,encodeSurrogateEscapedString((cmd.op === "W" ? pattern.split(delimiter,1)[0] : pattern) + (terminated ? delimiter : ""))); break;
            case "r": case "R": try {
              if (cmd.op === "r") appended.push(await textRead(cmd.file));
              else { cmd.readLines ??= textRecords(await textRead(cmd.file),delimiter); const line = cmd.readLines.shift(); if (line) appended.push(line.text + (line.terminated ? delimiter : "")); }
            } catch {} break;
            case "l": {
              const escaped = pattern.replace(/[\\\x00-\x1f\x7f-\xff]/g, (ch) => ({"\\":"\\\\","\n":"\\n","\t":"\\t","\r":"\\r","\b":"\\b","\f":"\\f","\v":"\\v"})[ch] ?? "\\" + ch.charCodeAt(0).toString(8).padStart(3,"0"));
              const width = cmd.number ?? Number(listWidth), text = escaped + "$";
              if (width > 0) { let start = 0; const chunk = Math.max(1,width-1); while (text.length-start > width) { emit(text.slice(start,start+chunk)+"\\"); start += chunk; } emit(text.slice(start)); }
              else emit(text);
              break;
            }
          }
        }
        if (!deleted && !quiet) emit(pattern,terminated);
        for (const text of appended) if (text) emit(text.endsWith(delimiter) ? text.slice(0,-1) : text,text.endsWith(delimiter));
        i++;
        if (unbuffered) group.records.discard(i);
      }
      if (inPlace != null) {
        const temporary = join(dirname(group.file), `.bnu-sed-${process.pid}-${Math.random().toString(16).slice(2)}`);
        try {
          writeFileSync(temporary, encodeSurrogateEscapedString(output.join("")), { flag:"wx" }); chmodSync(temporary,statSync(group.file).mode & 0o7777);
          if (inPlace !== true && inPlace !== "") renameSync(group.file,String(inPlace).includes("*") ? String(inPlace).replaceAll("*",group.file) : group.file + inPlace);
          renameSync(temporary,group.file);
        } finally { try { unlinkSync(temporary); } catch {} }
      }
    }
  } finally { for (const regex of program.regexes) regex.close(); if (unbuffered) for (const group of groups) group.records.close(); }
  return errors ? 2 : status;
}
const singleCall = defineCommand("sed",sed,(args) => textMeta(args,{valueShort:"efl",valueLong:["expression","file","line-length"]}));
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
