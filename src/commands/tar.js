#!/usr/bin/env bun
import { lstatSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { archiveListing, archiveName, collectEntries, extractEntries } from "../shared/archive.js";
import { decodeTar, encodeTar } from "../shared/tar-format.js";
import { globMatch, helpVersionOnlyMetaOption, readAll } from "../shared/common.js";
import { defineCommand, runAsMain } from "../shared/command.js";
import { InvocationError, stderr, stdout } from "../shared/diagnostics.js";

function parseTar(args) {
  args = [...args];
  // Traditional tar option words take their argument values after the word.
  if (args[0] && !args[0].startsWith("-")) {
    const word = args.shift(), values = [];
    for (const char of word) {
      values.push(`-${char}`);
      if ("fCTbX".includes(char)) {
        if (!args.length) throw new InvocationError(`option requires an argument -- '${char}'`, 2);
        values.push(args.shift());
      }
    }
    args.unshift(...values);
  }
  const options = { operands: [], patterns: [], excludes: [], cwd: process.cwd(), file: "-", blockSize: 10240, strip: 0 };
  const aliases = { c: "create", x: "extract", t: "list", r: "append", u: "update", d: "diff", A: "concatenate", f: "file", C: "directory", T: "files-from", X: "exclude-from", b: "blocking-factor", z: "gzip", a: "auto-compress", v: "verbose", h: "dereference", P: "absolute-names", p: "same-permissions", k: "keep-old-files", O: "to-stdout", m: "touch", S: "sparse" };
  const valueOptions = new Set(["file", "directory", "files-from", "exclude", "exclude-from", "strip-components", "format", "blocking-factor"]);
  const switches = new Set(["create", "extract", "get", "list", "append", "update", "diff", "compare", "concatenate", "catenate", "delete", "gzip", "gunzip", "ungzip", "auto-compress", "verbose", "dereference", "absolute-names", "same-permissions", "preserve-permissions", "keep-old-files", "skip-old-files", "overwrite", "to-stdout", "touch", "null", "no-null", "no-recursion", "recursion", "wildcards", "no-wildcards", "numeric-owner", "no-same-owner", "same-owner", "no-same-permissions"]);
  let end = false;
  const addOperand = name => options.operands.push({ path: resolve(options.cwd, name), name: archiveName(name, options["absolute-names"]) });
  const accept = (name, value) => {
    if (["create", "extract", "get", "list", "append", "update", "diff", "compare", "concatenate", "catenate", "delete"].includes(name)) {
      const operation = { get: "extract", compare: "diff", catenate: "concatenate" }[name] ?? name;
      if (options.operation && operation !== options.operation) throw new InvocationError("you may not specify more than one operation", 2);
      options.operation = operation;
    } else if (name === "directory") options.cwd = resolve(options.cwd, value);
    else if (name === "files-from") {
      const content = readFileSync(value === "-" ? 0 : value, "utf8");
      for (const item of content.split(options.null ? "\0" : "\n")) if (item) addOperand(item);
    } else if (name === "exclude") options.excludes.push(value);
    else if (name === "exclude-from") options.excludes.push(...readFileSync(value, "utf8").split("\n").filter(Boolean));
    else if (name === "strip-components" || name === "blocking-factor") {
      if (!/^\d+$/.test(value) || (name === "blocking-factor" && Number(value) < 1)) throw new InvocationError(`invalid ${name}: '${value}'`, 2);
      options[name === "strip-components" ? "strip" : "blockSize"] = Number(value) * (name === "blocking-factor" ? 512 : 1);
    } else if (name === "no-null") options.null = false;
    else if (name === "no-recursion" || name === "recursion") options["no-recursion"] = name === "no-recursion";
    else if (name === "wildcards" || name === "no-wildcards") options.wildcards = name === "wildcards";
    else if (name === "same-owner" || name === "no-same-owner") options["same-owner"] = name === "same-owner";
    else if (["same-permissions", "preserve-permissions", "no-same-permissions"].includes(name)) options["same-permissions"] = name !== "no-same-permissions";
    else options[name] = value ?? true;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (end || arg === "-" || !arg.startsWith("-")) { addOperand(arg); continue; }
    if (arg === "--") { end = true; continue; }
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("="), name = arg.slice(2, equal < 0 ? undefined : equal);
      if (!valueOptions.has(name) && !switches.has(name)) throw new InvocationError(`unrecognized option '--${name}'`, 2);
      let value = equal < 0 ? undefined : arg.slice(equal + 1);
      if (valueOptions.has(name)) {
        value ??= args[++index];
        if (value === undefined) throw new InvocationError(`option '--${name}' requires an argument`, 2);
      } else if (value !== undefined) throw new InvocationError(`option '--${name}' doesn't allow an argument`, 2);
      accept(name, value);
    } else for (let pos = 1; pos < arg.length; pos++) {
      const name = aliases[arg[pos]];
      if (!name || (!switches.has(name) && !valueOptions.has(name))) throw new InvocationError(`invalid option -- '${arg[pos]}'`, 2);
      let value;
      if (valueOptions.has(name)) {
        value = arg.slice(pos + 1) || args[++index];
        if (value === undefined) throw new InvocationError(`option requires an argument -- '${arg[pos]}'`, 2);
        pos = arg.length;
      }
      accept(name, value);
    }
  }
  if (!options.operation) throw new InvocationError("you must specify an operation (-c, -r, -t, -u, -x, -d, -A, --delete)", 2);
  if (options["absolute-names"] && options.operation === "extract") throw new InvocationError("absolute path extraction is not supported", 2);
  if (options.format && !["ustar", "pax", "posix"].includes(options.format)) throw new InvocationError(`unsupported archive format '${options.format}' (supported: ustar, pax, posix)`, 2);
  return options;
}

export async function tarCmd(args) {
  const options = parseTar(args);
  try {
    const archivePath = options.file === "-" ? null : resolve(options.file);
    const compressed = options.gzip || options.gunzip || options.ungzip || (options["auto-compress"] && /\.(?:gz|tgz)$/.test(options.file));
    const exclude = name => options.excludes.some(pattern => globMatch(pattern, name.replace(/\/$/, "")) || globMatch(pattern, basename(name)) || name.split("/").some(part => globMatch(pattern, part)));
    const write = data => options.file === "-" ? stdout(data) : writeFileSync(options.file, data);
    if (["create", "append", "update"].includes(options.operation)) {
      if (!options.operands.length && options.operation === "create") throw new Error("cowardly refusing to create an empty archive");
      let previous = [], prefix = Buffer.alloc(0);
      if (options.operation !== "create") {
        if (compressed) throw new Error("cannot update compressed archives");
        if (options.file === "-") throw new Error("cannot update an archive on standard input/output");
        const existing = readFileSync(options.file);
        if (existing[0] === 31 && existing[1] === 139) throw new Error("cannot update compressed archives");
        const decoded = decodeTar(existing);
        previous = decoded.entries; prefix = existing.subarray(0, decoded.end);
      }
      let archiveIdentity;
      try { const info = statSync(archivePath); archiveIdentity = `${info.dev}:${info.ino}`; } catch {}
      let entries = collectEntries(options.operands, { archivePath, archiveIdentity, dereference: options.dereference, recursive: !options["no-recursion"], exclude });
      if (options.operation === "update") {
        const times = new Map(previous.map(entry => [entry.name, entry.mtime]));
        entries = entries.filter(entry => !times.has(entry.name) || entry.mtime > times.get(entry.name));
      }
      if (options.format === "ustar") entries = entries.map(entry => ({ ...entry, mtime: Math.floor(entry.mtime) }));
      const encoded = encodeTar(entries, { format: options.format, blockSize: options.blockSize });
      const output = Buffer.concat([prefix, encoded]);
      write(compressed ? gzipSync(output) : output);
      if (options.verbose) for (const entry of entries) (options.file === "-" ? stderr : stdout)(`${entry.name}\n`);
      return 0;
    }
    let data = Buffer.from(await readAll(options.file));
    if (data[0] === 31 && data[1] === 139) {
      if (["delete", "concatenate"].includes(options.operation)) throw new Error("cannot update compressed archives");
      data = gunzipSync(data);
    } else if (compressed) data = gunzipSync(data);
    const decoded = decodeTar(data), wanted = options.operands.map(operand => operand.name.replace(/\/$/, ""));
    const found = new Set();
    const selected = decoded.entries.filter(entry => {
      if (exclude(entry.name)) return false;
      if (!wanted.length) return true;
      return wanted.reduce((match, name) => {
        const matches = options.wildcards ? globMatch(name, entry.name) : entry.name.replace(/\/$/, "") === name || entry.name.startsWith(`${name}/`);
        if (matches) found.add(name);
        return match || matches;
      }, false);
    });
    if (options.operation === "list") for (const entry of selected) stdout(`${options.verbose ? archiveListing(entry) : entry.name}\n`);
    else if (options.operation === "extract") {
      const strip = name => name.split("/").filter((part, index) => !(index === 0 && part === ".")).slice(options.strip).join("/");
      const entries = selected.map(entry => ({ ...entry, name: strip(entry.name), linkname: entry.type === "1" ? strip(entry.linkname) : entry.linkname })).filter(entry => entry.name && entry.name !== "/");
      if (options["to-stdout"]) { for (const entry of entries) if (entry.type === "0" || entry.type === "7") stdout(entry.data); }
      else extractEntries(entries, options.cwd, { permissions: options["same-permissions"] || options["preserve-permissions"], owner: options["same-owner"], mtime: !options.touch, keepOld: options["keep-old-files"], skipOld: options["skip-old-files"], onEntry: options.verbose ? entry => stdout(`${entry.name}\n`) : null });
    } else if (options.operation === "diff") {
      let differs = false;
      for (const entry of selected) {
        try {
          const path = resolve(options.cwd, entry.name), info = lstatSync(path);
          const type = info.isDirectory() ? "5" : info.isSymbolicLink() ? "2" : info.isFIFO() ? "6" : info.isFile() ? "0" : "?";
          const hardlink = entry.type === "1" ? lstatSync(resolve(options.cwd, entry.linkname)) : null;
          if ((entry.type !== "1" && type !== entry.type) || (hardlink && (hardlink.ino !== info.ino || hardlink.dev !== info.dev)) ||
              (info.mode & 0o7777) !== entry.mode || info.uid !== entry.uid || info.gid !== entry.gid || Math.floor(info.mtimeMs / 1000) !== Math.floor(entry.mtime) ||
              (entry.type === "0" && !readFileSync(path).equals(entry.data)) || (entry.type === "2" && readlinkSync(path) !== entry.linkname)) { stdout(`${entry.name}: differs\n`); differs = true; }
        } catch (error) { stderr(`tar: ${entry.name}: ${error.message}\n`); differs = true; }
      }
      if (differs) return 1;
    } else if (options.operation === "delete") {
      if (!wanted.length) throw new Error("no archive members specified");
      const removed = new Set(selected);
      write(encodeTar(decoded.entries.filter(entry => !removed.has(entry)), { blockSize: options.blockSize }));
    } else if (options.operation === "concatenate") {
      if (options.file === "-") throw new Error("cannot concatenate to standard input/output");
      const chunks = [data.subarray(0, decoded.end)];
      for (const operand of options.operands) {
        const source = readFileSync(operand.path), archive = decodeTar(source);
        chunks.push(source.subarray(0, archive.end));
      }
      chunks.push(Buffer.alloc(1024)); write(Buffer.concat(chunks));
      return 0;
    }
    for (const name of wanted) if (!found.has(name)) stderr(`tar: ${name}: Not found in archive\n`);
    return wanted.some(name => !found.has(name)) ? 2 : 0;
  } catch (error) {
    stderr(`tar: ${error.message}\n`);
    return 2;
  }
}

const command = defineCommand("tar", tarCmd, helpVersionOnlyMetaOption);
export default command;
if (import.meta.main) await runAsMain(command);
