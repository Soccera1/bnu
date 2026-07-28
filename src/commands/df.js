#!/usr/bin/env bun

import { ptr } from "bun:ffi";
import { readFileSync } from "node:fs";
import { realpath, stat, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { bufferPathJoin, cstrPath, decodeUtf8SurrogateEscaped, invalidOptionMessage, isBytePath, libc, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, parseOptions, pathDisplayName, shellEscapeLsName, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { applyBlockSizeSpecialMode, defaultGNUBlockSize, gnuBlockSizeErrorMessage, humanSizeWithUnits, optionValues, parseGNUBlockSize, parseGNUBlockSizeEnvInfo, rawOperandPlan, validateBlockSizeMetaOption } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const DF_LONG_OPTIONS = ["all", "human-readable", "si", "inodes", "local", "block-size", "total", "output", "type", "exclude-type", "print-type", "sync", "no-sync", "portability", "help", "version"];

export function dfMetaOption(args) {
  const longFlagOptions = new Set(["all", "human-readable", "si", "inodes", "local", "total", "print-type", "sync", "no-sync", "portability"]);
  const longValueOptions = new Set(["block-size", "output", "type", "exclude-type"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeDfLongOption(arg);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      return normalized;
    }
    if (longFlagOptions.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      continue;
    }
    if (longValueOptions.has(name)) {
      const value = inlineValue ?? args[i + 1];
      if (name === "block-size" && value !== undefined) validateBlockSizeMetaOption("--block-size", value);
      if (name === "output" && inlineValue !== undefined) dfOutputFields([inlineValue]);
      if (inlineValue === undefined) i++;
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      i = scanDfShortMetaOption(args, i);
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(invalidOptionMessage(arg), true);
  }
  return null;
}

export function scanDfShortMetaOption(args, index) {
  const arg = args[index];
  for (let j = 1; j < arg.length; j++) {
    const ch = arg[j];
    if ("ahHiklPT".includes(ch)) continue;
    if (ch === "B") {
      const inlineValue = arg.slice(j + 1);
      const value = inlineValue === "" ? args[index + 1] : inlineValue;
      if (value !== undefined) validateBlockSizeMetaOption("-B", value);
      return inlineValue === "" ? index + 1 : index;
    }
    if (ch === "t" || ch === "x") return arg.slice(j + 1) ? index : index + 1;
    throw new UsageError(`invalid option -- '${ch}'`, true);
  }
  return index;
}

export function dfBlockSizeValue(opts) {
  return opts.B ?? opts["block-size"] ?? dfBlockSizeEnvValue();
}

export function dfBlockSizeEnvValue() {
  return process.env.DF_BLOCK_SIZE ?? process.env.BLOCK_SIZE ?? process.env.BLOCKSIZE;
}

export function humanSize(bytes, base = 1024) {
  const units = ["B", "K", "M", "G", "T"];
  return humanSizeWithUnits(bytes, base, units);
}

export async function dfCmd(args) {
  args = normalizeBlockSizeShort(args);
  args = normalizeDfLongOptions(args);
  args = normalizeDfOutputAlias(args);
  const outputValues = dfRepeatedOutputValues(args);
  const { opts, operands } = parseOptions(args, { short: { a: false, h: false, H: false, i: false, k: false, l: false, P: false, T: false, t: "value", x: "value", B: "value" }, long: { all: false, "human-readable": false, si: false, inodes: false, local: false, "block-size": "value", total: false, output: "optional-value", type: "value", "exclude-type": "value", "print-type": false, sync: false, "no-sync": false, portability: false, help: false, version: false } });
  const rawOperands = rawOperandPlan("df", args, operands, {
    valueOptions: ["--block-size", "--type", "--exclude-type"],
    shortValueOptions: ["B", "t", "x"],
  });
  if (dfShouldSync(args)) libc.symbols.sync();
  // With file operands, df reports the file systems containing those files.
  // Without operands GNU df walks the mount table instead; treating that case
  // as `df .` loses every other mounted filesystem.
  const mountTableRequired = !operands.length
    || opts.a || opts.all || opts.l || opts.local
    || opts.t !== undefined || opts.type !== undefined
    || opts.x !== undefined || opts["exclude-type"] !== undefined;
  const mountTable = mountTableRequired ? await dfMountTable(opts.a || opts.all) : null;
  if (mountTableRequired && mountTable == null) return 1;
  const targets = operands.length ? (rawOperands ?? operands) : mountTable.map((mount) => mount.mount);
  applyBlockSizeSpecialMode(opts, dfBlockSizeValue(opts));
  const human = opts.h || opts["human-readable"] || opts.H || opts.si;
  if (opts.output !== undefined && (opts.i || opts.inodes || opts.P || opts.portability || opts.T || opts["print-type"])) {
    const conflict = opts.i || opts.inodes ? "-i" : opts.P || opts.portability ? "-P" : "-T";
    throw new UsageError(`options ${conflict} and --output are mutually exclusive`, true);
  }
  const outputFields = opts.output !== undefined ? dfOutputFields(outputValues.length ? outputValues : [opts.output]) : null;
  const blockSizeInfo = dfBlockSizeInfo(opts);
  const blockSize = human ? 1 : blockSizeInfo.size;
  const inodeMode = opts.i || opts.inodes;
  const printType = opts.T || opts["print-type"];
  const includeTypes = dfTypeSet(optionValues(opts.t).concat(optionValues(opts.type)));
  const excludeTypes = dfTypeSet(optionValues(opts.x).concat(optionValues(opts["exclude-type"])));
  const rows = [];
  let failed = false;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const mountInfo = operands.length ? await dfMountInfo(target) : mountTable[index];
    if (mountInfo.overMounted) {
      stderr(`df: cannot access ${shellEscapeLsName(pathDisplayName(target), true)}: over-mounted by another device\n`);
      failed = true;
      continue;
    }
    // Filter from mount metadata before calling statfs.  Some namespace and
    // kernel API mounts are intentionally inaccessible to an unprivileged
    // caller; GNU df omits them in its default listing rather than turning a
    // successful bare `df` into a failure.
    if (includeTypes.size && !includeTypes.has(mountInfo.fstype)) continue;
    if (excludeTypes.has(mountInfo.fstype)) continue;
    if (!operands.length && !opts.a && !opts.all && dfIsPseudoFileSystem(mountInfo)) continue;
    if (opts.l || opts.local) {
      if (!dfIsLocalFileSystem(mountInfo)) continue;
    }
    let fs;
    try {
      // Bun's statfs wrapper can satisfy this from runtime state without an
      // observable statfs(2).  GNU df gathers each row with statfs, and in
      // particular --sync promises that sync(2) precedes that query.
      // Keep the native probe so the ordering and kernel-facing semantics are
      // preserved, while retaining Bun's portable result decoding below.
      const nativeStatfs = Buffer.alloc(120);
      libc.symbols.statfs(cstrPath(target), ptr(nativeStatfs));
      fs = await statfs(target);
    } catch (error) {
      stderr(`df: ${textInputDiagnosticName(target)}: ${systemErrorMessage(error)}\n`);
      failed = true;
      continue;
    }
    const sizeTotal = Number(fs.blocks) * Number(fs.bsize);
    const sizeAvail = Number(fs.bavail) * Number(fs.bsize);
    const sizeUsed = sizeTotal - sizeAvail;
    const inodeTotal = Number(fs.files);
    const inodeAvail = Number(fs.ffree);
    const inodeUsed = inodeTotal - inodeAvail;
    rows.push({
      source: mountInfo.source,
      name: mountInfo.source,
      total: inodeMode ? inodeTotal : sizeTotal,
      used: inodeMode ? inodeUsed : sizeUsed,
      avail: inodeMode ? inodeAvail : sizeAvail,
      sizeTotal,
      sizeUsed,
      sizeAvail,
      inodeTotal,
      inodeUsed,
      inodeAvail,
      mount: mountInfo.mount,
      file: target,
      fstype: mountInfo.fstype,
    });
  }
  if (!rows.length && !failed) {
    stderr("df: no file systems processed\n");
    return 1;
  }
  if (opts.total) {
    if (rows.length) {
      rows.push({
        source: "total",
        name: "total",
        total: rows.reduce((sum, row) => sum + row.total, 0),
        used: rows.reduce((sum, row) => sum + row.used, 0),
        avail: rows.reduce((sum, row) => sum + row.avail, 0),
        sizeTotal: rows.reduce((sum, row) => sum + row.sizeTotal, 0),
        sizeUsed: rows.reduce((sum, row) => sum + row.sizeUsed, 0),
        sizeAvail: rows.reduce((sum, row) => sum + row.sizeAvail, 0),
        inodeTotal: rows.reduce((sum, row) => sum + row.inodeTotal, 0),
        inodeUsed: rows.reduce((sum, row) => sum + row.inodeUsed, 0),
        inodeAvail: rows.reduce((sum, row) => sum + row.inodeAvail, 0),
        mount: outputFields && !outputFields.includes("source") ? "total" : "-",
        file: "-",
        fstype: "-",
      });
    } else if (!failed) {
      stderr("df: no file systems processed\n");
      failed = true;
    }
  }
  if (!rows.length && failed) return 1;
  const show = (value) => human ? humanSize(value, (opts.H || opts.si) ? 1000 : 1024) : String(Math.ceil(value / (inodeMode ? 1 : blockSize)));
  if (outputFields) {
    const headers = outputFields.map((field) => dfFieldHeader(field, blockSizeInfo.label, human));
    const values = rows.map((row) => outputFields.map((field) => dfFieldValue(field, row, show)));
    const widths = headers.map((header, index) => Math.max(dfOutputFieldMinWidth(outputFields[index]), header.length, ...values.map((row) => row[index].length)));
    stdout(`${dfFormatOutputRow(headers, widths, outputFields)}\n`);
    for (const row of values) stdout(`${dfFormatOutputRow(row, widths, outputFields)}\n`);
    return failed ? 1 : 0;
  }
  stdout(inodeMode
    ? `Filesystem     ${printType ? "Type        " : ""}   Inodes    IUsed    IFree IUse% Mounted on\n`
    : dfDefaultHeader({ blockSizeLabel: blockSizeInfo.label, human, portability: opts.P || opts.portability, printType }));
  for (const row of rows) {
    const pct = row.total ? Math.ceil((row.used / row.total) * 100) : 0;
    const name = dfSanitizeDisplayField(row.name);
    const mount = dfSanitizeDisplayField(row.mount);
    stdout(`${name.padEnd(14)} ${printType ? `${row.fstype.padEnd(5)} ` : ""}${show(row.total).padStart(9)} ${show(row.used).padStart(8)} ${show(row.avail).padStart(9)} ${String(pct).padStart(3)}% ${mount}\n`);
  }
  return failed ? 1 : 0;
}

export function dfSanitizeDisplayField(value) {
  return String(value).replace(/[\x00-\x1f\x7f]/g, "?");
}

export function dfShouldSync(args) {
  // GNU option processing is order-sensitive here: --no-sync can override
  // an earlier --sync, and vice versa.
  let enabled = false;
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--sync") enabled = true;
    else if (arg === "--no-sync") enabled = false;
  }
  return enabled;
}

export function dfTypeSet(values) {
  return new Set(values.flatMap((value) => String(value).split(",")));
}

export function normalizeDfLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeDfLongOption(arg));
  }
  return out;
}

export function normalizeDfLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, DF_LONG_OPTIONS);
}

export function dfBlockSizeInfo(opts) {
  if (opts.k) return { size: 1024, label: "1K-blocks" };
  const shortOption = opts.B !== undefined;
  const explicit = opts.B !== undefined || opts["block-size"] !== undefined;
  const value = explicit ? shortOption ? opts.B : opts["block-size"] : dfBlockSizeEnvValue();
  const defaultSize = defaultGNUBlockSize();
  if (value == null) return { size: defaultSize, label: dfDefaultBlockSizeLabel(defaultSize) };
  try {
    if (!explicit) {
      const parsed = parseGNUBlockSizeEnvInfo(value, defaultSize);
      if (parsed.fallback === "default") return { size: parsed.size, label: dfDefaultBlockSizeLabel(parsed.size) };
      if (parsed.fallback === "numeric") return { size: parsed.size, label: `${parsed.size}B-blocks` };
      return { size: parsed.size, label: `${dfBlockSizeLabel(value, parsed.size)}-blocks` };
    }
    const size = parseGNUBlockSize(value);
    return { size, label: `${dfBlockSizeLabel(value, size)}-blocks` };
  } catch {
    throw new UsageError(gnuBlockSizeErrorMessage(shortOption ? "-B" : "--block-size", value));
  }
}

export function dfDefaultBlockSizeLabel(size) {
  return size === 1024 ? "1K-blocks" : `${dfBlockSizeLabel(String(size), size)}-blocks`;
}

export function dfBlockSizeLabel(value, size) {
  const text = String(value).replace(/^'/, "");
  if (text === "1" || size === 1 && /^\+?1$/.test(text)) return "1B";
  if (/^\+?\d+$/.test(text)) {
    const n = Number(text);
    if (n === 1000) return "1kB";
    if (n === 1_000_000) return "1MB";
    if (n === 1_000_000_000) return "1GB";
    return `${n}B`;
  }
  const scaled = text.match(/^\+?(\d+)([A-Za-z]+)$/);
  if (scaled) {
    const n = Number(scaled[1]);
    const suffix = scaled[2];
    const binary = { KiB: "K", MiB: "M", GiB: "G", TiB: "T", PiB: "P", EiB: "E", ZiB: "Z", YiB: "Y" };
    const decimal = { KB: "kB", kB: "kB", MB: "MB", mB: "MB", GB: "GB", gB: "GB", TB: "TB", tB: "TB", PB: "PB", EB: "EB", ZB: "ZB", YB: "YB" };
    if (binary[suffix]) return `${n}${binary[suffix]}`;
    if (decimal[suffix]) return `${n}${decimal[suffix]}`;
  }
  return text.replace(/^\+/, "");
}

export async function dfMountInfo(target) {
  const targetPath = await dfRealPath(target);
  const entries = [];
  let best = null;
  let bestLength = -1;
  let text = "";
  try {
    text = dfReadMountInfoSync();
  } catch {}
  for (const line of text.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf(" - ");
    if (separator === -1) continue;
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    const mount = dfDecodeMountInfoField(before[4] ?? "");
    const entry = { mount, fstype: dfDecodeMountInfoField(after[0] ?? "-"), source: dfDecodeMountInfoField(after[1] ?? "-") };
    entries.push(entry);
    if (!dfPathIsOnMount(targetPath, mount) || mount.length < bestLength) continue;
    best = entry;
    bestLength = mount.length;
  }
  const targetInfo = await stat(target).catch(() => null);
  if (targetInfo?.isBlockDevice()) {
    const deviceMount = entries.findLast((entry) => entry.source === targetPath);
    if (deviceMount) {
      const visibleMount = entries.findLast((entry) => entry.mount === deviceMount.mount);
      if (visibleMount !== deviceMount) return { ...deviceMount, overMounted: true };
      return deviceMount;
    }
  }
  return best ?? { mount: targetPath, fstype: "-", source: "-" };
}

export async function dfRealPath(target) {
  if (!isBytePath(target)) return await realpath(target).catch(() => resolve(target));
  try {
    return pathDisplayName(await realpath(target, { encoding: "buffer" }));
  } catch {
    const raw = Buffer.from(target);
    if (raw[0] === 0x2f) return pathDisplayName(raw);
    return pathDisplayName(bufferPathJoin(Buffer.from(process.cwd()), raw));
  }
}

export async function dfMountTable(preserveDuplicates = false) {
  let text;
  try {
    text = dfReadMountInfoSync();
  } catch {
    return null;
  }
  const mounts = new Map();
  const allMounts = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf(" - ");
    if (separator === -1) continue;
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    const mount = dfDecodeMountInfoField(before[4] ?? "");
    if (!mount) continue;
    // A mount namespace can stack mounts at the same mountpoint.  The final
    // entry is the one visible to processes in the namespace.
    const entry = {
      mount,
      fstype: dfDecodeMountInfoField(after[0] ?? "-"),
      source: dfDecodeMountInfoField(after[1] ?? "-"),
    };
    allMounts.push(entry);
    mounts.set(mount, entry);
  }
  return preserveDuplicates ? allMounts : [...mounts.values()];
}

export function dfReadMountInfoSync() {
  if (process.env.BNU_DF_MOUNTINFO_ERROR === "1") {
    const error = new Error("No such file or directory");
    error.code = "ENOENT";
    throw error;
  }
  const path = process.env.BNU_DF_MOUNTINFO_FILE || "/proc/self/mountinfo";
  return readFileSync(path).toString("latin1");
}

export function dfIsPseudoFileSystem(mount) {
  // This is the same practical distinction made by GNU df's default output:
  // kernel API and namespace mounts are only shown with --all.
  return new Set([
    "autofs", "binfmt_misc", "bpf", "cgroup", "cgroup2", "configfs", "debugfs", "devpts",
    "fusectl", "hugetlbfs", "mqueue", "proc", "pstore",
    "fuse.portal", "rootfs", "rpc_pipefs", "securityfs", "sysfs", "tracefs",
  ]).has(mount.fstype);
}

export function dfIsLocalFileSystem(mount) {
  return !new Set(["9p", "afs", "cifs", "coda", "fuse.sshfs", "ncp", "nfs", "nfs4", "smbfs"]).has(mount.fstype);
}

export function dfDecodeMountInfoField(field) {
  const input = Buffer.from(String(field), "latin1");
  const output = [];
  for (let index = 0; index < input.length; index++) {
    if (input[index] === 0x5c && index + 3 < input.length
      && input[index + 1] >= 0x30 && input[index + 1] <= 0x37
      && input[index + 2] >= 0x30 && input[index + 2] <= 0x37
      && input[index + 3] >= 0x30 && input[index + 3] <= 0x37) {
      output.push(Number.parseInt(input.subarray(index + 1, index + 4).toString("ascii"), 8));
      index += 3;
    } else {
      output.push(input[index]);
    }
  }
  return decodeUtf8SurrogateEscaped(Buffer.from(output));
}

export function dfPathIsOnMount(path, mount) {
  if (mount === "/") return path.startsWith("/");
  return path === mount || path.startsWith(`${mount.replace(/\/+$/, "")}/`);
}

export function normalizeBlockSizeShort(args) {
  return args.flatMap((arg) => /^-B.+/.test(arg) ? ["-B", arg.slice(2)] : [arg]);
}

export function normalizeDfOutputAlias(args) {
  return args.map((arg) => normalizeDfOutputOption(arg) ?? arg);
}

export function normalizeDfOutputOption(arg) {
  if (!arg.startsWith("--")) return null;
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name || !"output".startsWith(name)) return null;
  return eq === -1 ? "--output" : `--output=${body.slice(eq + 1)}`;
}

export const DF_DEFAULT_OUTPUT_FIELDS = ["source", "fstype", "itotal", "iused", "iavail", "ipcent", "size", "used", "avail", "pcent", "file", "target"];

export function dfRepeatedOutputValues(args) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--output") {
      values.push(true);
    } else if (arg.startsWith("--output=")) {
      values.push(arg.slice("--output=".length));
    }
  }
  return values;
}

export function dfOutputFields(values) {
  const fields = values.some((value) => value === true)
    ? DF_DEFAULT_OUTPUT_FIELDS
    : values.flatMap((value) => String(value).split(","));
  const seen = new Set();
  for (const field of fields) {
    if (!DF_DEFAULT_OUTPUT_FIELDS.includes(field)) throw new UsageError(`option --output: field ${localeQuotedEscapedDiagnostic(field)} unknown`, true);
    if (seen.has(field)) throw new UsageError(`option --output: field ${localeQuotedEscapedDiagnostic(field)} used more than once`, true);
    seen.add(field);
  }
  return fields;
}

export function dfDefaultHeader({ blockSizeLabel, human, portability, printType }) {
  if (human) return `Filesystem     ${printType ? "Type " : ""} Size  Used Avail Use% Mounted on\n`;
  if (portability) return `Filesystem     ${printType ? "Type " : ""}1024-blocks      Used Available Capacity Mounted on\n`;
  return `Filesystem     ${printType ? "Type " : ""}${blockSizeLabel.padStart(9)}     Used Available Use% Mounted on\n`;
}

export function dfFieldHeader(field, blockSizeLabel, human) {
  return ({
    source: "Filesystem",
    fstype: "Type",
    itotal: "Inodes",
    iused: "IUsed",
    iavail: "IFree",
    ipcent: "IUse%",
    size: human ? "Size" : blockSizeLabel,
    used: "Used",
    avail: "Avail",
    pcent: "Use%",
    file: "File",
    target: "Mounted on",
  })[field];
}

export function dfFieldValue(field, row, show) {
  const pcent = row.sizeTotal ? `${Math.ceil((row.sizeUsed / row.sizeTotal) * 100)}%` : "0%";
  const ipcent = row.inodeTotal ? `${Math.ceil((row.inodeUsed / row.inodeTotal) * 100)}%` : "0%";
  return ({
    source: row.source,
    fstype: row.fstype,
    itotal: String(row.inodeTotal),
    iused: String(row.inodeUsed),
    iavail: String(row.inodeAvail),
    ipcent,
    size: show(row.sizeTotal),
    used: show(row.sizeUsed),
    avail: show(row.sizeAvail),
    pcent,
    file: row.file,
    target: row.mount,
  })[field];
}

export function dfOutputFieldMinWidth(field) {
  return field === "source" ? 14 : 0;
}

export function dfFormatOutputRow(values, widths, fields) {
  const leftAligned = new Set(["source", "fstype", "file", "target"]);
  return values.map((value, index) => {
    if (leftAligned.has(fields[index])) return index === values.length - 1 ? value : value.padEnd(widths[index]);
    return value.padStart(widths[index]);
  }).join(" ");
}

const singleCall = defineCommand("df", dfCmd, dfMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
