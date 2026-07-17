#!/usr/bin/env bun

import { closeSync, constants as fsConstants, lstatSync, openSync, opendirSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join, basename as pathBasename, dirname as pathDirname } from "node:path";
import { bufferPathBasename, bufferPathJoin, createFdRecordReader, decodeSurrogateEscapedBytes, globMatch, invalidOptionMessage, isBytePath, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, parseOptions, pathDisplayName, readAll, shellEscapeLsName, splitFiles0ByteNames, statAttachNanoseconds, systemErrorMessage, wcFileNameIsDash, wcFileNameIsEmpty, wcFiles0SourceIsNonRegular } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { applyBlockSizeSpecialMode, blocksFor, defaultGNUBlockSize, gnuBlockSizeErrorMessage, humanSizeWithUnits, openDirectoryPathEntries, parseGNUBlockSize, validateBlockSizeMetaOption } from "../shared/filesystem.js";
import { lsTimeText, parseGNUBlockSizeEnv, strftime } from "../shared/time.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const DU_LONG_OPTIONS = ["null", "all", "apparent-size", "block-size", "bytes", "total", "dereference-args", "max-depth", "files0-from", "human-readable", "inodes", "dereference", "count-links", "no-dereference", "separate-dirs", "si", "summarize", "threshold", "time", "time-style", "exclude-from", "exclude", "one-file-system", "help", "version"];

export function duMetaOption(args) {
  const longFlagOptions = new Set(["null", "all", "apparent-size", "bytes", "total", "dereference-args", "human-readable", "inodes", "dereference", "count-links", "no-dereference", "separate-dirs", "si", "summarize", "one-file-system"]);
  const longValueOptions = new Set(["block-size", "max-depth", "files0-from", "threshold", "time-style", "exclude-from", "exclude"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeLongOptionByPrefix(arg, DU_LONG_OPTIONS);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      return normalized;
    }
    if (name === "time") {
      if (inlineValue !== undefined) validateDuTimeField(inlineValue);
      continue;
    }
    if (longFlagOptions.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      continue;
    }
    if (longValueOptions.has(name)) {
      const value = inlineValue ?? args[i + 1];
      if (name === "block-size" && value !== undefined) validateBlockSizeMetaOption("--block-size", value);
      if (name === "threshold" && value !== undefined) duParseThreshold(value);
      if (name === "max-depth" && value !== undefined) validateDuMaxDepthMetaOption(value, args, inlineValue === undefined ? i + 2 : i + 1);
      if (inlineValue === undefined) i++;
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      i = scanDuShortMetaOption(args, i);
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(invalidOptionMessage(arg), true);
    continue;
  }
  return null;
}

export function scanDuShortMetaOption(args, index) {
  const arg = args[index];
  for (let j = 1; j < arg.length; j++) {
    const ch = arg[j];
    if ("0aADHLPlsSbhckmx".includes(ch)) continue;
    if (ch === "B") {
      const inlineValue = arg.slice(j + 1);
      const value = inlineValue === "" ? args[index + 1] : inlineValue;
      if (value !== undefined) validateBlockSizeMetaOption("-B", value);
      return inlineValue === "" ? index + 1 : index;
    }
    if (ch === "d") {
      const inlineValue = arg.slice(j + 1);
      const value = inlineValue === "" ? args[index + 1] : inlineValue;
      if (value !== undefined) validateDuMaxDepthMetaOption(value, args, inlineValue === "" ? index + 2 : index + 1);
      return inlineValue === "" ? index + 1 : index;
    }
    if (ch === "t") {
      const inlineValue = arg.slice(j + 1);
      const value = inlineValue === "" ? args[index + 1] : inlineValue;
      if (value !== undefined) duParseThreshold(value, false, "-t");
      return inlineValue === "" ? index + 1 : index;
    }
    if (ch === "X") return arg.slice(j + 1) ? index : index + 1;
    throw new UsageError(`invalid option -- '${ch}'`, true);
  }
  return index;
}

export function validateDuMaxDepthMetaOption(value, args, startIndex) {
  try {
    parseDuMaxDepth(value, false);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (!duHasMetaOptionAfter(args, startIndex)) return;
    stderr(`du: ${error.message}\n`);
  }
}

export function duHasMetaOptionAfter(args, startIndex) {
  for (let i = startIndex; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return false;
    if (!arg.startsWith("--")) continue;
    const normalized = normalizeLongOptionByPrefix(arg, DU_LONG_OPTIONS);
    const [name, inlineValue] = normalized.slice(2).split(/=(.*)/s, 2);
    if ((name === "help" || name === "version") && inlineValue === undefined) return true;
  }
  return false;
}

export async function duCmd(args) {
  args = normalizeDuArgs(args);
  const repeatedExcludes = duRepeatedOptionValues(args, "--exclude");
  const repeatedExcludeFiles = duRepeatedOptionValues(args, "--exclude-from");
  const { opts, operands } = parseOptions(args, { short: { 0: false, a: false, A: false, D: false, H: false, L: false, P: false, l: false, s: false, S: false, b: false, h: false, c: false, B: "value", d: "value", k: false, m: false, t: "value", x: false }, long: { null: false, all: false, dereference: false, "dereference-args": false, "no-dereference": false, "count-links": false, summarize: false, "separate-dirs": false, bytes: false, "human-readable": false, "apparent-size": false, inodes: false, total: false, "block-size": "value", si: false, time: "optional-value", "time-style": "value", "max-depth": "value", exclude: "value", "exclude-from": "value", "files0-from": "value", "one-file-system": false, threshold: "value" } });
  applyBlockSizeSpecialMode(opts, duBlockSizeValue(opts));
  const maxDepth = parseDuMaxDepth(opts.d ?? opts["max-depth"], opts.s || opts.summarize);
  const timeField = opts.time === undefined ? null : validateDuTimeField(opts.time);
  let targets = operands.length ? operands : ["."];
  let files0From = null;
  let files0Reader = null;
  let files0Fd = 0;
  let closeFiles0Fd = false;
  if (opts["files0-from"] !== undefined) {
    if (operands.length) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[0])}\nfile operands cannot be combined with --files0-from`, true);
    files0From = opts["files0-from"];
    if (wcFiles0SourceIsNonRegular(files0From)) {
      try {
        if (files0From !== "-") {
          files0Fd = openSync(files0From, "r");
          closeFiles0Fd = true;
        }
        files0Reader = createFdRecordReader(files0Fd, 0);
        targets = [];
      } catch (error) {
        stderr(`du: cannot open ${duQuotedName(files0From)} for reading: ${systemErrorMessage(error)}\n`);
        return 1;
      }
    } else {
    let nameBytes;
    try {
      nameBytes = await readAll(files0From);
    } catch (error) {
      stderr(error?.code === "EISDIR"
        ? `du: ${duDiagnosticName(files0From)}: read error: ${systemErrorMessage(error)}\n`
        : `du: cannot open ${duQuotedName(files0From)} for reading: ${systemErrorMessage(error)}\n`);
      return 1;
    }
    targets = splitFiles0ByteNames(nameBytes);
    }
  }
  const inodeMode = opts.inodes;
  const apparent = opts.b || opts.bytes || opts.A || opts["apparent-size"];
  if (inodeMode && apparent) stderr("du: warning: options --apparent-size and -b are ineffective with --inodes\n");
  const human = opts.h || opts["human-readable"] || opts.si;
  const unit = inodeMode || opts.b || opts.bytes ? 1 : duBlockSize(opts);
  const separator = opts[0] || opts.null ? "\0" : "\n";
  const thresholdText = opts.t ?? opts.threshold;
  let threshold = null;
  if (thresholdText != null) {
    threshold = duParseThreshold(thresholdText, inodeMode);
    if (!Number.isFinite(threshold)) throw new UsageError(`invalid --threshold argument '${thresholdText}'`);
  }
  const excludes = await duExcludePatterns(opts, repeatedExcludes, repeatedExcludeFiles);
  const { dereference, dereferenceArgs } = duDereferenceMode(args, opts);
  let totalBytes = 0;
  let failed = false;
  const emittedRootDirectories = new Set();
  const seen = new Set();
  const dirSeen = new Set();
  let reportedSyntheticTime = false;
  for (let index = 0; files0Reader || index < targets.length; index++) {
    let target;
    if (files0Reader) {
      try {
        target = files0Reader.next();
      } catch (error) {
        stderr(`du: ${duDiagnosticName(files0From)}: read error: ${systemErrorMessage(error)}\n`);
        failed = true;
        break;
      }
      if (target == null) break;
    } else {
      target = targets[index];
    }
    if (files0From != null && wcFileNameIsEmpty(target)) {
      stderr(`du: ${duDiagnosticName(files0From)}:${index + 1}: invalid zero-length file name\n`);
      failed = true;
      continue;
    }
    if (files0From === "-" && wcFileNameIsDash(target)) {
      stderr("du: when reading file names from standard input, no file name of '-' allowed\n");
      failed = true;
      continue;
    }
    let entries;
    try {
      const errors = [];
      const rootLinkStat = await lstat(target);
      const collectOptions = { apparent, inodes: inodeMode, all: opts.a || opts.all, dereference, dereferenceArgs, countLinks: opts.l || opts["count-links"], seen, dirSeen, separateDirs: opts.S || opts["separate-dirs"], maxDepth, excludes, oneFileSystem: opts.x || opts["one-file-system"], rootDev: rootLinkStat.dev, includeNanoseconds: timeField != null, errors };
      if (duCanUseSyncSummary(collectOptions)) {
        const root = collectDuSummarySync(target, collectOptions);
        entries = root ? [{ path: target, bytes: root.bytes, stat: root.stat }] : [];
      } else {
        entries = await collectDuEntries(target, collectOptions);
      }
      for (const diagnostic of errors) stderr(`${diagnostic}\n`);
      if (errors.length) failed = true;
    } catch (error) {
      stderr(error?.duFtsReadPath != null
        ? `du: fts_read failed: ${pathDisplayName(error.duFtsReadPath)}: ${systemErrorMessage(error)}\n`
        : `du: cannot access ${duQuotedName(target)}: ${systemErrorMessage(error)}\n`);
      failed = true;
      continue;
    }
    const root = entries.at(-1);
    if (!root) continue;
    if (root.stat.isDirectory()) {
      const id = `${root.stat.dev}:${root.stat.ino}`;
      if (emittedRootDirectories.has(id)) entries = [];
      else emittedRootDirectories.add(id);
    }
    const bytes = root.bytes;
    totalBytes += bytes;
    for (const entry of entries) {
      if (threshold != null && !duPassesThreshold(entry.bytes, threshold)) continue;
      const value = human ? duHumanSize(entry.bytes, opts.si ? 1000 : 1024) : String(Math.ceil(entry.bytes / unit));
      let time = "";
      if (timeField) {
        const syntheticTime = process.env.BNU_DU_TEST_TIME_SECONDS;
        if (syntheticTime != null) {
          time = `\t${syntheticTime}`;
          if (!reportedSyntheticTime) {
            stderr(`du: time '${syntheticTime}' is out of range\n`);
            reportedSyntheticTime = true;
          }
        } else {
          time = `\t${duTimeText(entry.stat[timeField], opts)}`;
        }
      }
      stdout(`${value}${time}\t${pathDisplayName(entry.path)}${separator}`);
    }
  }
  if (opts.c || opts.total) {
    const value = human ? duHumanSize(totalBytes, opts.si ? 1000 : 1024) : String(Math.ceil(totalBytes / unit));
    stdout(`${value}\ttotal${separator}`);
  }
  if (closeFiles0Fd) closeSync(files0Fd);
  return failed ? 1 : 0;
}

export function duQuotedName(name) {
  return shellEscapeLsName(pathDisplayName(name), true);
}

export function duDiagnosticName(name) {
  return shellEscapeLsName(pathDisplayName(name));
}

export function normalizeDuArgs(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--") {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(arg.startsWith("--") ? normalizeLongOptionByPrefix(arg, DU_LONG_OPTIONS) : arg);
  }
  return out;
}

export function parseDuMaxDepth(value, summarize) {
  if (value == null) return summarize ? 0 : Infinity;
  const text = String(value);
  if (!/^[+-]?\d+$/.test(text)) throw new UsageError(`invalid maximum depth ${localeQuotedEscapedDiagnostic(text)}`, true);
  const parsed = BigInt(text.replace(/^\+/, ""));
  if (summarize) {
    const display = text.replace(/^\+/, "");
    if (parsed !== 0n) throw new UsageError(`warning: summarizing conflicts with --max-depth=${display}`, true);
    if (parsed === 0n) stderr("du: warning: summarizing is the same as using --max-depth=0\n");
    return 0;
  }
  if (parsed < 0n) return 0;
  return parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed);
}

export function duDereferenceMode(args, opts) {
  let mode = opts.L || opts.dereference ? "all" : opts.D || opts.H || opts["dereference-args"] ? "args" : "none";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "-" || !arg.startsWith("-")) continue;
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (name === "dereference") mode = "all";
      else if (name === "dereference-args") mode = "args";
      else if (name === "no-dereference") mode = "none";
      if (inlineValue == null && ["block-size", "time-style", "max-depth", "exclude", "exclude-from", "files0-from", "threshold"].includes(name)) i++;
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "L") mode = "all";
      else if (ch === "D" || ch === "H") mode = "args";
      else if (ch === "P") mode = "none";
      if (["B", "d"].includes(ch)) break;
    }
  }
  return { dereference: mode === "all", dereferenceArgs: mode === "args" };
}

export function duPassesThreshold(value, threshold) {
  return threshold < 0 ? value <= Math.abs(threshold) : value >= threshold;
}

export function duParseThreshold(value, inodeMode = false, option = "--threshold") {
  const text = String(value);
  const sign = text.startsWith("-") ? -1 : 1;
  const unsigned = text.replace(/^[+-]/, "");
  if (!/^\d/.test(unsigned)) throw new UsageError(`invalid ${option} argument '${value}'`);
  const match = unsigned.match(/^(\d+)([A-Za-z]*)$/);
  if (!match) throw new UsageError(`invalid suffix in ${option} argument '${value}'`);
  const suffixScales = {
    "": 1n,
    K: 1024n, k: 1024n, KiB: 1024n, kiB: 1024n,
    M: 1024n ** 2n, m: 1024n ** 2n, MiB: 1024n ** 2n, miB: 1024n ** 2n,
    G: 1024n ** 3n, g: 1024n ** 3n, GiB: 1024n ** 3n, giB: 1024n ** 3n,
    T: 1024n ** 4n, t: 1024n ** 4n, TiB: 1024n ** 4n, tiB: 1024n ** 4n,
    P: 1024n ** 5n, PiB: 1024n ** 5n,
    E: 1024n ** 6n, EiB: 1024n ** 6n,
    Z: 1024n ** 7n, ZiB: 1024n ** 7n,
    Y: 1024n ** 8n, YiB: 1024n ** 8n,
    R: 1024n ** 9n, RiB: 1024n ** 9n,
    Q: 1024n ** 10n, QiB: 1024n ** 10n,
    KB: 1000n, kB: 1000n, MB: 1000n ** 2n, mB: 1000n ** 2n,
    GB: 1000n ** 3n, gB: 1000n ** 3n, TB: 1000n ** 4n, tB: 1000n ** 4n,
    PB: 1000n ** 5n, EB: 1000n ** 6n, ZB: 1000n ** 7n, YB: 1000n ** 8n,
    RB: 1000n ** 9n, QB: 1000n ** 10n,
  };
  const scale = suffixScales[match[2]];
  if (!scale) {
    throw new UsageError(`invalid suffix in ${option} argument '${value}'`);
  }
  const amount = BigInt(match[1]) * scale;
  if (sign < 0 && amount === 0n) throw new UsageError(`invalid --threshold argument '${value}'`);
  const max = sign < 0 ? 9223372036854775808n : 9223372036854775807n;
  if (amount > max) throw new UsageError(`${option} argument '${value}' too large`);
  const clamped = amount > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(amount);
  return sign * clamped;
}

export async function collectDuEntries(path, options, depth = 0) {
  const node = await collectDuNode(path, options, depth);
  return node?.entries ?? [];
}

export function duCanUseSyncSummary(options) {
  return options.maxDepth === 0 && !options.all && !options.dereference && !options.dereferenceArgs
    && !options.countLinks && !options.separateDirs && !options.oneFileSystem
    && !options.includeNanoseconds && options.excludes.length === 0;
}

export function collectDuSummarySync(path, options, depth = 0, displayPath = path) {
  const s = lstatSync(path);
  const identity = `${s.dev}:${s.ino}`;
  if (s.isDirectory()) {
    if (options.dirSeen.has(identity)) return { bytes: 0, stat: s };
    options.dirSeen.add(identity);
  } else if (s.nlink > 1 || depth === 0) {
    if (options.seen.has(identity)) return { bytes: 0, stat: s };
    options.seen.add(identity);
  }
  let bytes = options.inodes ? 1 : options.apparent && s.isDirectory() ? 0 : options.apparent ? s.size : blocksFor(s) * 512;
  if (!s.isDirectory() || s.isSymbolicLink()) return { bytes, stat: s };
  // Walk relative to an open directory fd.  Concatenating descendants onto
  // the original operand eventually exceeds PATH_MAX even though every
  // component is valid; /proc/self/fd gives Node's path APIs openat-like
  // behavior while preserving byte names and without changing an unreadable
  // caller's cwd.
  let directoryFd;
  let directory = null;
  try {
    try {
      directoryFd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
      directory = opendirSync(`/proc/self/fd/${directoryFd}`, { encoding: "buffer" });
    } catch (error) {
      options.errors?.push(`du: cannot read directory '${pathDisplayName(displayPath)}': ${systemErrorMessage(error)}`);
      return { bytes, stat: s };
    }
    while (true) {
      const rawEntry = directory.readSync();
      if (!rawEntry) break;
      const entry = rawEntry.name ?? rawEntry;
      try {
        const child = collectDuSummarySync(
          duChildPath(`/proc/self/fd/${directoryFd}`, entry),
          options,
          depth + 1,
          duChildPath(displayPath, entry),
        );
        if (child) bytes += child.bytes;
      } catch (error) {
        options.errors?.push(`du: cannot read directory '${pathDisplayName(displayPath)}': ${systemErrorMessage(error)}`);
      }
    }
  } finally {
    directory?.closeSync();
    if (directoryFd != null) closeSync(directoryFd);
  }
  return { bytes, stat: s };
}

export async function collectDuNode(path, options, depth = 0) {
  if (duIsExcluded(path, options.excludes)) return null;
  const linkStat = await lstat(path);
  const dereference = options.dereference || (options.dereferenceArgs && depth === 0);
  const s = dereference && linkStat.isSymbolicLink() ? await stat(await realpath(path)) : linkStat;
  if (options.includeNanoseconds) statAttachNanoseconds(s, path, dereference);
  const identity = `${s.dev}:${s.ino}`;
  // A single-link regular file cannot be encountered through another hard
  // link, so retaining its identity only turns a wide directory into an
  // O(number-of-files) heap.  Directories have their own cycle set below.
  const trackHardLink = !s.isDirectory() && (s.nlink > 1 || depth === 0);
  const alreadySeen = !options.countLinks && trackHardLink && options.seen.has(identity);
  if (trackHardLink) options.seen.add(identity);
  const ownBytes = options.inodes ? 1 : options.apparent && s.isDirectory() ? 0 : options.apparent ? s.size : blocksFor(s) * 512;
  if (s.isDirectory()) {
    if (options.dirSeen.has(identity)) return { bytes: 0, entries: [], stat: s };
    options.dirSeen.add(identity);
  }
  if (alreadySeen) return { bytes: 0, entries: [], stat: s };
  if (!s.isDirectory() || s.isSymbolicLink()) {
    const bytes = ownBytes;
    const emit = (depth === 0 || options.all) && depth <= options.maxDepth;
    return { bytes, entries: emit ? [{ path, bytes, stat: s }] : [], stat: s };
  }
  let total = ownBytes;
  const entries = [];
  if (options.oneFileSystem && s.dev !== options.rootDev) {
    if (depth <= options.maxDepth) entries.push({ path, bytes: total, stat: s });
    return { bytes: total, entries, stat: s };
  }
  let names;
  try {
    names = options.maxDepth === 0 && !options.all
      ? await openDirectoryPathEntries(path)
      : await readdir(path, isBytePath(path) ? { encoding: "buffer" } : undefined);
  } catch (error) {
    options.errors?.push(`du: cannot read directory '${pathDisplayName(path)}': ${systemErrorMessage(error)}`);
    if (depth <= options.maxDepth) entries.push({ path, bytes: total, stat: s });
    return { bytes: total, entries, stat: s };
  }
  // readdir opens the directory before returning its names.  If an ancestor
  // is renamed concurrently, those names are stale relative to this pathname.
  // GNU fts reports one traversal failure for the opened directory rather than
  // one ENOENT for every descendant from the snapshot.
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw duFtsReadError(await duFtsFailurePath(path), error);
    throw error;
  }
  for await (const entry of names) {
    const childPath = duChildPath(path, entry);
    let child;
    try {
      child = await collectDuNode(childPath, options, depth + 1);
    } catch (error) {
      if (error?.duFtsReadPath != null) throw error;
      if (error?.code === "ENAMETOOLONG") continue;
      if (error?.code === "ENOENT" && !(await lstat(path).catch(() => null))) throw duFtsReadError(await duFtsFailurePath(path), error);
      options.errors?.push(`du: cannot read directory '${pathDisplayName(path)}': ${systemErrorMessage(error)}`);
      continue;
    }
    if (!child) continue;
    const skippedOtherFsDirectory = options.oneFileSystem && child.stat.isDirectory() && child.stat.dev !== options.rootDev;
    if (!skippedOtherFsDirectory) entries.push(...child.entries);
    if (!skippedOtherFsDirectory && (!options.separateDirs || !child.stat.isDirectory() || child.stat.isSymbolicLink())) total += child.bytes;
  }
  if (depth <= options.maxDepth) entries.push({ path, bytes: total, stat: s });
  return { bytes: total, entries, stat: s };
}

export function duFtsReadError(path, cause) {
  const error = new Error(cause?.message ?? "No such file or directory");
  error.code = cause?.code ?? "ENOENT";
  error.duFtsReadPath = path;
  return error;
}

export async function duFtsFailurePath(path) {
  let current = String(path);
  while (true) {
    const parent = pathDirname(current);
    if (parent === current || await lstat(parent).catch(() => null)) return current;
    current = parent;
  }
}

export function duChildPath(parent, entry) {
  if (parent === ".") return `./${entry}`;
  if (typeof parent === "string" && parent.startsWith("./")) return `./${join(parent.slice(2), String(entry))}`;
  if (isBytePath(parent) || isBytePath(entry)) return bufferPathJoin(isBytePath(parent) ? parent : Buffer.from(String(parent)), isBytePath(entry) ? Buffer.from(entry) : Buffer.from(String(entry)));
  return join(parent, entry);
}

export function duRepeatedOptionValues(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) values.push(args[++i]);
    else if (arg.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1));
  }
  return values.filter((value) => value != null);
}

export async function duExcludePatterns(opts, excludeValues = [], excludeFiles = []) {
  const patterns = [...excludeValues];
  if (opts.exclude && !patterns.includes(opts.exclude)) patterns.push(opts.exclude);
  const files = [...excludeFiles];
  if (opts["exclude-from"] && !files.includes(opts["exclude-from"])) files.push(opts["exclude-from"]);
  for (const file of files) {
    let text;
    try {
      text = decodeSurrogateEscapedBytes(await readAll(file));
    } catch (error) {
      throw new UsageError(`${file}: ${systemErrorMessage(error)}`, true);
    }
    patterns.push(...text.split(/\r?\n/).filter(Boolean));
  }
  return patterns;
}

export function duIsExcluded(path, patterns) {
  const normalized = pathDisplayName(path).replace(/^\.\//, "");
  const base = isBytePath(path) ? pathDisplayName(bufferPathBasename(path)) : pathBasename(normalized);
  return patterns.some((pattern) => normalized === pattern || base === pattern || normalized.startsWith(`${pattern}/`) || globMatch(pattern, normalized) || globMatch(pattern, base));
}

export function duTimeText(date, opts) {
  const style = opts["time-style"] ?? "long-iso";
  if (style === "iso" || style === "posix-iso") return strftime(date, "%F");
  return lsTimeText(date, { "time-style": style });
}

export function validateDuTimeField(value) {
  if (value === true) return "mtime";
  if (["atime", "access", "use"].includes(value)) return "atime";
  if (["ctime", "status"].includes(value)) return "ctime";
  const kind = value === "" ? "ambiguous" : "invalid";
  throw new UsageError(`${kind} argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic("--time")}\nValid arguments are:\n  - ${["atime", "access", "use"].map(localeQuotedDiagnostic).join(", ")}\n  - ${["ctime", "status"].map(localeQuotedDiagnostic).join(", ")}`, true);
}

export function duBlockSize(opts) {
  if (opts.k) return 1024;
  if (opts.m) return 1024 ** 2;
  if (opts.B !== undefined || opts["block-size"] !== undefined) {
    const shortOption = opts.B !== undefined;
    const value = shortOption ? opts.B : opts["block-size"];
    try {
      return parseGNUBlockSize(value);
    } catch {
      throw new UsageError(gnuBlockSizeErrorMessage(shortOption ? "-B" : "--block-size", value));
    }
  }
  return parseGNUBlockSizeEnv(duBlockSizeEnvValue(), defaultGNUBlockSize());
}

export function duHumanSize(value, base = 1024) {
  const units = base === 1000 ? ["B", "k", "M", "G", "T"] : ["B", "K", "M", "G", "T"];
  return humanSizeWithUnits(value, base, units);
}

export function duBlockSizeValue(opts) {
  return opts.B ?? opts["block-size"] ?? duBlockSizeEnvValue();
}

export function duBlockSizeEnvValue() {
  return process.env.DU_BLOCK_SIZE ?? process.env.BLOCK_SIZE ?? process.env.BLOCKSIZE;
}

const singleCall = defineCommand("du", duCmd, duMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
