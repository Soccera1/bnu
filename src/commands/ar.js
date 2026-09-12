#!/usr/bin/env bun
import {readFileSync, statSync, lstatSync, writeFileSync, existsSync, utimesSync} from "node:fs";
import {basename} from "node:path";
import {defineCommand, runAsMain} from "../shared/command.js";
import {UsageError, stdout, stderr} from "../shared/diagnostics.js";
import {metaOption} from "../shared/utility.js";
import {parseAr, encodeAr} from "../shared/object-files.js";

export function ar(args) {
  if (!args.length) throw new UsageError("missing operation", true);
  let flags = "", i = 0;
  while (i < args.length && (i === 0 || args[i].startsWith("-"))) {
    const a = args[i++];
    if (a === "--") break;
    if (a === "--format=gnu") continue;
    if (a.startsWith("--")) throw new UsageError(`unrecognized option '${a}'`, true);
    flags += a.replace(/^-/, "");
  }
  if (/[^dmpqrstxabcDfilNoOPsSTuvUV]/.test(flags))
    throw new UsageError(`invalid operation '${flags}'`, true);
  if (/[PTl]/.test(flags))
    throw new UsageError(
        "thin archives, full paths, and dependency records are not supported", true);
  const operations = [...new Set([...flags].filter(c => "dmpqrtx".includes(c)))];
  if (operations.length > 1)
    throw new UsageError("two different operation options specified", true);
  const op = operations[0] ?? (flags.includes("s") ? "s" : null);
  if (!op) throw new UsageError("no operation specified", true);
  let position;
  if (/[abi]/.test(flags)) position = args[i++];
  if (flags.includes("N")) throw new UsageError("instance selection is not supported", true);
  const file = args[i++];
  if (!file) throw new UsageError("missing archive operand", true);
  const files = args.slice(i), selected = new Set(files.map(path=>basename(path)));
  let entries = [];
  if (existsSync(file))
    entries = parseAr(readFileSync(file)).filter(m => !m.special);
  else if (!["r", "q"].includes(op))
    throw new Error(`${file}: No such file or directory`);
  else if (!flags.includes("c"))
    stderr(`ar: creating ${file}\n`);
  const verbose = flags.includes("v");
  if (["t", "p", "x"].includes(op)) {
    let status = 0;
    for (const m of entries.filter(m => !files.length || selected.has(m.name))) {
      selected.delete(m.name);
      if (op === "t")
        stdout(
            verbose ? `${(m.mode & 0o777).toString(8)} ${m.uid}/${m.gid} ${
                          String(m.data.length).padStart(6)} ${
                          new Date(m.mtime * 1000).toISOString()} ${m.name}\n` :
                      `${m.name}\n`);
      else if (op === "p") {
        if (verbose) stdout(`\n<${m.name}>\n\n`);
        stdout(m.data);
      } else {
        if (!m.name || m.name !== basename(m.name) || m.name === "." || m.name === ".." ||
            m.name.includes("\\") || m.name.includes("\0"))
          throw new Error(`unsafe archive member '${m.name}'`);
        let existing;try {existing=lstatSync(m.name);}catch(error){if(error.code!=="ENOENT")throw error;}
        if(existing && !existing.isFile())throw new Error(`refusing to overwrite non-regular file '${m.name}'`);
        if (flags.includes("u") && existsSync(m.name) && statSync(m.name).mtimeMs >= m.mtime * 1000)
          continue;
        writeFileSync(m.name, m.data, {mode: m.mode & 0o777});
        if(flags.includes("o"))utimesSync(m.name,new Date(),new Date(m.mtime*1000));
        if (verbose) stdout(`x - ${m.name}\n`);
      }
    }
    for (const name of selected) {
      stderr(`ar: ${name}: No such file or directory in archive\n`);
      status = 1;
    }
    return status;
  }
  if (op === "d") entries = entries.filter(m => !selected.has(m.name));
  if (op === "m") {
    const move = entries.filter(m => selected.has(m.name));
    entries = entries.filter(m => !selected.has(m.name));
    const index = position ? entries.findIndex(m => m.name === basename(position)) : entries.length;
    if (index < 0) throw new Error(`no entry ${position} in archive`);
    entries.splice(position && flags.includes("a") ? index + 1 : index, 0, ...move);
  }
  let insertAt;
  if (op === "r" || op === "q")
    for (const path of files) {
      const st = statSync(path);
      if (!st.isFile()) throw new Error(`${path}: not a regular file`);
      const m = {
        name: basename(path),
        data: readFileSync(path),
        mode: st.mode,
        uid: st.uid,
        gid: st.gid,
        mtime: Math.floor(st.mtimeMs / 1000)
      },
            index = op === "r" ? entries.findIndex(e => e.name === m.name) : -1;
      if (index >= 0) {
        if (flags.includes("u") && entries[index].mtime >= m.mtime) continue;
        entries[index] = m;
      } else if (position) {
        if(insertAt==null) {
          const p = entries.findIndex(e => e.name === basename(position));
          if (p < 0) throw new Error(`no entry ${position} in archive`);
          insertAt=flags.includes("a")?p+1:p;
        }
        entries.splice(insertAt++, 0, m);
      } else
        entries.push(m);
      if (verbose) stdout(`${index < 0 ? "a" : "r"} - ${path}\n`);
    }
  writeFileSync(file, encodeAr(entries, !flags.includes("S"), !flags.includes("U")));
  return 0;
}
const singleCall = defineCommand("ar", ar, metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
