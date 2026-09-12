#!/usr/bin/env bun
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { archiveListing, archiveName, collectEntries, extractEntries } from "../shared/archive.js";
import { cpioHardlinks, decodeCpio, encodeCpio } from "../shared/cpio-format.js";
import { globMatch, helpVersionOnlyMetaOption, parseOptions, readAll } from "../shared/common.js";
import { defineCommand, runAsMain } from "../shared/command.js";
import { stderr, stdout, UsageError } from "../shared/diagnostics.js";

export async function cpioCmd(args) {
  const { opts, operands } = parseOptions(args, {
    short: { o: false, i: false, p: false, t: false, v: false, V: false, d: false, m: false, u: false, a: false, L: false, l: false, c: false, B: false, A: false, f: false, "0": false, H: "value", F: "value", I: "value", O: "value", C: "value", E: "value", D: "value" },
    long: { "create": false, "extract": false, "pass-through": false, list: false, verbose: false, dot: false, "make-directories": false, "preserve-modification-time": false, unconditional: false, "reset-access-time": false, dereference: false, link: false, null: false, format: "value", file: "value", "input": "value", "output": "value", "io-size": "value", "block-size": "value", "pattern-file": "value", directory: "value", quiet: false, append: false, "nonmatching": false, "no-absolute-filenames": false, "absolute-filenames": false, "no-preserve-owner": false, "numeric-uid-gid": false, "to-stdout": false, "only-verify-crc": false },
  });
  const create = opts.o || opts.create, extract = opts.i || opts.extract, pass = opts.p || opts["pass-through"], list = opts.t || opts.list;
  if (Number(Boolean(create)) + Number(Boolean(extract || list)) + Number(Boolean(pass)) !== 1) throw new UsageError("exactly one of -o, -i, -p or -t must be specified", true);
  if ((opts.l || opts.link) && !pass) throw new UsageError("--link requires pass-through mode");
  if ((opts.A || opts.append) && !create) throw new UsageError("--append requires create mode");
  if (opts["absolute-filenames"] && extract && !list) throw new UsageError("absolute path extraction is not supported");
  const verbose = opts.v || opts.verbose, dots = opts.V || opts.dot, quiet = opts.quiet;
  const makeParents = Boolean(opts.d || opts["make-directories"]), preserveTime = Boolean(opts.m || opts["preserve-modification-time"]);
  const unconditional = opts.u || opts.unconditional, directory = resolve(opts.D ?? opts.directory ?? ".");
  const file = opts.F ?? opts.file ?? (create ? opts.O ?? opts.output : opts.I ?? opts.input) ?? "-";
  let format = opts.H ?? opts.format ?? (opts.c ? "odc" : "bin");
  const blockSize = opts.C ?? opts["io-size"] ?? ((opts["block-size"] ?? (opts.B ? 10 : 1)) * 512);
  if (!/^\d+$/.test(String(blockSize)) || Number(blockSize) < 1) throw new UsageError(`invalid block size '${blockSize}'`);
  const onEntry = entry => { if (verbose) stderr(`${entry.name}\n`); else if (dots) stderr("."); };
  const reportBlocks = length => { if (dots) stderr("\n"); if (!quiet) { const blocks = Math.ceil(length / 512); stderr(`${blocks} block${blocks === 1 ? "" : "s"}\n`); } };
  if (create || pass) {
    if (create && operands.length) throw new UsageError("too many arguments", true);
    if (pass && operands.length !== 1) throw new UsageError("pass-through requires one destination directory", true);
    const names = Buffer.from(await readAll("-")).toString("utf8").split(opts["0"] || opts.null ? "\0" : "\n").filter(Boolean);
    const absolute = Boolean(opts["absolute-filenames"] && !opts["no-absolute-filenames"]);
    const entries = collectEntries(names.map(name => ({ path: resolve(directory, name), name: archiveName(name, absolute).replace(/^\.\//, "") || "." })), { recursive: false, hardlinks: false, dereference: opts.L || opts.dereference, archivePath: file === "-" ? null : resolve(file) });
    if (pass) {
      const target = resolve(operands[0]);
      if (makeParents) mkdirSync(target, { recursive: true });
      extractEntries(cpioHardlinks(entries), target, { makeParents, mtime: preserveTime, newer: !unconditional, linkSources: opts.l || opts.link, onEntry });
      reportBlocks(entries.reduce((total, entry) => total + entry.data.length, 0));
    } else {
      let all = entries;
      if (opts.A || opts.append) {
        if (file === "-") throw new UsageError("append requires a named archive file");
        const previous = decodeCpio(readFileSync(file));
        if (!opts.H && !opts.format && !opts.c) format = previous.format;
        // Each source archive has an independent inode namespace.
        all = [...previous.entries.map(entry => ({ ...entry, dev: `archive:${entry.dev}` })), ...entries];
      }
      const data = encodeCpio(all, format, Number(blockSize));
      if (file === "-") stdout(data); else writeFileSync(file, data);
      for (const entry of entries) onEntry(entry);
      reportBlocks(data.length);
    }
    if (opts.a || opts["reset-access-time"]) for (const entry of entries) if (entry.type === "0") utimesSync(entry.path, entry.atime, entry.mtime);
    return 0;
  }
  const data = Buffer.from(await readAll(file)), archive = decodeCpio(data);
  const patterns = [...operands];
  if (opts.E || opts["pattern-file"]) patterns.push(...readFileSync(opts.E ?? opts["pattern-file"], "utf8").split("\n").filter(Boolean));
  const invert = opts.f || opts.nonmatching;
  let entries = archive.entries.filter(entry => {
    const matches = !patterns.length || patterns.some(pattern => globMatch(pattern, entry.name));
    return invert ? !matches : matches;
  });
  if (opts["no-absolute-filenames"]) entries = entries.map(entry => ({ ...entry, name: archiveName(entry.name), linkname: entry.type === "1" ? archiveName(entry.linkname) : entry.linkname }));
  if (list) for (const entry of entries) stdout(`${verbose ? archiveListing(entry) : entry.name}\n`);
  else if (opts["only-verify-crc"]) { /* decodeCpio verifies each CRC before returning. */ }
  else if (opts["to-stdout"]) { for (const entry of entries) if (entry.type === "0") stdout(entry.data); }
  else extractEntries(cpioHardlinks(entries), directory, { makeParents, mtime: preserveTime, newer: !unconditional, onEntry });
  reportBlocks(data.length);
  return 0;
}

const command = defineCommand("cpio", cpioCmd, helpVersionOnlyMetaOption);
export default command;
if (import.meta.main) await runAsMain(command);
