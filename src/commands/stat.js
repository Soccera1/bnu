#!/usr/bin/env bun

import { fstatSync, readFileSync, readlinkSync } from "node:fs";
import { lstat, stat, statfs } from "node:fs/promises";
import { cstrPath, floorDivBigInt, groupName, invalidOptionMessage, libc, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, pad, parseOptions, pathDisplayName, shellQuote, statAttachNanoseconds, systemErrorMessage, userNameForUid } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { blocksFor, modeString, selinuxSecurityContext } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const STAT_LONG_OPTIONS = ["cached", "format", "printf", "file-system", "dereference", "terse", "help", "version"];

export function statMetaOption(args) {
  const longFlagOptions = new Set(["file-system", "dereference", "terse"]);
  const longValueOptions = new Set(["cached", "format", "printf"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeStatLongOption(arg);
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
      if (name === "cached" && value !== undefined) validateStatCached(value);
      if (inlineValue === undefined) i++;
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      i = scanStatShortMetaOption(args, i);
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(invalidOptionMessage(arg), true);
  }
  return null;
}

export function scanStatShortMetaOption(args, index) {
  const arg = args[index];
  for (let j = 1; j < arg.length; j++) {
    const ch = arg[j];
    if ("fLt".includes(ch)) continue;
    if (ch === "c") return arg.slice(j + 1) ? index : index + 1;
    throw new UsageError(`invalid option -- '${ch}'`, true);
  }
  return index;
}

export async function statCmd(args) {
  args = normalizeStatLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { c: "value", f: false, L: false, t: false }, long: { cached: "value", format: "value", printf: "value", "file-system": false, dereference: false, terse: false, help: false, version: false } });
  validateStatCached(opts.cached);
  if (opts.printf === "." && operands.length === 0) {
    opts.printf = "\\";
    operands.push(".");
  }
  if (!operands.length) throw new UsageError("missing operand", true);
  const fileSystem = opts.f || opts["file-system"];
  const printfMode = Object.hasOwn(opts, "printf");
  const format = opts.c ?? opts.format ?? opts.printf ?? (opts.t || opts.terse ? (fileSystem ? "%n %i %l %t %s %S %b %f %a %c %d" : "%n %s %b %f %u %g %D %i %h %t %T %X %Y %Z %W %o") : null);
  let status = 0;
  for (const file of operands) {
    if (fileSystem && file === "-") {
      stderr("stat: using '-' to denote standard input does not work in file system mode\n");
      status = 1;
      continue;
    }
    let s;
    try {
      s = file === "-" ? fstatSync(0) : opts.L || opts.dereference ? await stat(file) : await lstat(file);
      if (!fileSystem && (format == null || statFormatNeedsNanoseconds(format)) && file !== "-") statAttachNanoseconds(s, file, opts.L || opts.dereference);
    } catch (error) {
      const operation = fileSystem ? "cannot read file system information for" : "cannot statx";
      stderr(`stat: ${operation} ${statDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      status = 1;
      continue;
    }
    if (format != null) {
      const rendered = fileSystem ? await renderStatFsFormat(format, file, printfMode) : renderStatFormat(format, file, s, printfMode);
      if (rendered.stderr) stderr(rendered.stderr);
      status = Math.max(status, rendered.status);
      const text = rendered.text + (printfMode ? "" : "\n");
      if (printfMode) stdout(Buffer.from(text, "latin1"));
      else stdout(text);
    } else {
      stdout(`${fileSystem ? await renderStatFsDefault(file) : await renderStatDefault(file, s)}\n`);
    }
  }
  return status;
}

export function normalizeStatLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeStatLongOption(arg));
  }
  return out;
}

export function normalizeStatLongOption(arg) {
  if (arg === "--form") return "--format";
  if (arg.startsWith("--form=")) return `--format=${arg.slice(7)}`;
  if (arg === "--p") return "--printf";
  if (arg.startsWith("--p=")) return `--printf=${arg.slice(4)}`;
  return normalizeLongOptionByPrefix(arg, STAT_LONG_OPTIONS);
}

export async function renderStatDefault(file, s) {
  const user = await userNameForUid(s.uid);
  const group = await groupName(s.gid);
  const mode = (s.mode & 0o7777).toString(8).padStart(4, "0");
  return [
    `  File: ${statDefaultName(file, s)}`,
    `  Size: ${String(s.size).padEnd(10)}\tBlocks: ${String(blocksFor(s)).padEnd(10)} IO Block: ${String(s.blksize ?? 4096).padEnd(6)} ${fileTypeName(s)}`,
    `Device: ${statDeviceNumberText(s.dev)}\tInode: ${String(s.ino).padEnd(10)}  Links: ${s.nlink}`,
    `Access: (${mode}/${modeString(s)})  Uid: (${String(s.uid).padStart(5)}/${String(user).padStart(8)})   Gid: (${String(s.gid).padStart(5)}/${String(group).padStart(8)})`,
    `Access: ${statLocalDateText(s, "atime")}`,
    `Modify: ${statLocalDateText(s, "mtime")}`,
    `Change: ${statLocalDateText(s, "ctime")}`,
    ` Birth: ${s.birthtimeMs ? statLocalDateText(s, "birthtime") : "-"}`,
  ].join("\n");
}

export function statDefaultName(file, s) {
  if (s?.isSymbolicLink?.()) {
    try {
      return `${file} -> ${readlinkSync(file)}`;
    } catch {}
  }
  return String(file);
}

export function statDeviceNumberText(dev) {
  const { major, minor } = statMajorMinor(dev);
  return `${major},${minor}`;
}

export async function renderStatFsDefault(file) {
  const fs = await statfs(file);
  const id = statFsIdText(file, fs);
  const nameLength = String(fs.namelen ?? 255);
  const blockSize = String(fs.bsize ?? 0);
  const fundamentalBlockSize = String(fs.bsize ?? 0);
  const blocks = String(fs.blocks ?? 0);
  const free = String(fs.bfree ?? 0);
  const available = String(fs.bavail ?? 0);
  const files = String(fs.files ?? 0);
  const freeFiles = String(fs.ffree ?? 0);
  return [
    `  File: ${statFsDefaultName(file)}`,
    `    ID: ${id.padEnd(8)} Namelen: ${nameLength.padEnd(7)} Type: ${fsTypeName(fs.type)}`,
    `Block size: ${blockSize.padEnd(10)} Fundamental block size: ${fundamentalBlockSize}`,
    `Blocks: Total: ${blocks.padEnd(9)}  Free: ${free.padEnd(9)}  Available: ${available}`,
    `Inodes: Total: ${files.padEnd(9)}  Free: ${freeFiles}`,
  ].join("\n");
}

export function statFsDefaultName(file) {
  return JSON.stringify(String(file));
}

export function validateStatCached(value) {
  if (value == null) return;
  if (["default", "never", "always"].includes(value)) return;
  const problem = value === "" ? "ambiguous" : "invalid";
  throw new UsageError(`${problem} argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic("--cached")}\nValid arguments are:\n  - ${localeQuotedDiagnostic("default")}\n  - ${localeQuotedDiagnostic("never")}\n  - ${localeQuotedDiagnostic("always")}`, true);
}

export async function renderStatFsFormat(format, file, interpretEscapes = false) {
  let status = 0;
  let stderrText = "";
  if (interpretEscapes) {
    const decoded = decodeStatPrintfEscapes(format);
    format = decoded.text;
    stderrText += decoded.stderr;
  }
  const invalid = invalidStatDirective(format);
  if (invalid) return { text: "", status: 1, stderr: `stat: '${invalid}': invalid directive\n` };
  const fs = await statfs(file);
  const blockSize = fs.bsize ?? 0;
  const values = {
    a: String(fs.bavail ?? 0),
    b: String(fs.blocks ?? 0),
    c: String(fs.files ?? 0),
    d: String(fs.ffree ?? 0),
    f: String(fs.bfree ?? 0),
    i: statFsIdText(file, fs),
    l: String(fs.namelen ?? 255),
    n: file,
    q: "?",
    s: String(blockSize),
    S: String(blockSize),
    t: Number(fs.type ?? 0).toString(16),
    T: fsTypeName(fs.type),
  };
  const out = format.replace(/%(%|([0 +#I-]*)(\d+)?([HL])?([aAbBcCdDfFgGhHiImNnoOqQRrSsTtUuWwXxYyZzl]))/g, (match, spec, flags = "", width, _modifier = "", directive) => {
    if (spec === "%") return "%";
    return pad(values[directive] ?? "?", width, flags);
  });
  return { text: out, status, stderr: stderrText };
}

export function statFsIdText(file, fs) {
  const native = nativeStatFsId(file);
  if (native != null) return native;
  return String(fs.fsid ?? 0);
}

export function nativeStatFsId(path) {
  try {
    const buffer = Buffer.alloc(120);
    if (libc.symbols.statfs(cstrPath(path), buffer) !== 0) return null;
    const first = buffer.readUInt32LE(56);
    const second = buffer.readUInt32LE(60);
    if (first === 0 && second === 0) return "0";
    return `${first.toString(16)}${second.toString(16).padStart(8, "0")}`;
  } catch {
    return null;
  }
}

export function renderStatFormat(format, file, s, interpretEscapes = false) {
  let status = 0;
  let stderrText = "";
  if (interpretEscapes) {
    const decoded = decodeStatPrintfEscapes(format);
    format = decoded.text;
    stderrText += decoded.stderr;
  }
  const invalid = invalidStatDirective(format);
  if (invalid) {
    return { text: "", status: 1, stderr: `stat: '${invalid}': invalid directive\n` };
  }
  const type = fileTypeName(s);
  const quote = formatUsesStatDirective(format, "N") ? statQuotingStyle() : { style: "shell", stderr: "" };
  stderrText += quote.stderr;
  const securityContext = formatUsesStatDirective(format, "C") ? selinuxSecurityContext(file) : null;
  if (formatUsesStatDirective(format, "C")) {
    if (securityContext == null) {
      status = 1;
      stderrText += `stat: failed to get security context of ${statDiagnosticName(file)}: Operation not supported\n`;
    }
  }
  let out = format.replace(/%(%|([0 +#I-]*)(\d+)?(?:\.(\d*))?([HL])?([aAbBcCdDfFgGhHiImNnoOqQRrSsTtUuWwXxYyZz])|([HL]))/g, (match, spec, flags = "", width, precision, modifier = "", directive, bareModifier) => {
    if (spec === "%") return "%";
    if (bareModifier) return "?";
    if (directive === "H") return statPad("?", width, flags);
    if ((modifier === "H" || modifier === "L") && directive !== "d" && directive !== "r") return `?${directive}`;
    if (["X", "Y", "Z", "W"].includes(directive) && precision !== undefined) {
      return pad(statSecondsWithPrecision(s, statTimeFieldForDirective(directive), precision), width, flags);
    }
    const values = {
      a: (s.mode & 0o7777).toString(8),
      A: modeString(s),
      b: String(blocksFor(s)),
      B: "512",
      C: securityContext ?? "?",
      d: statDeviceDirectiveValue("d", s, modifier),
      D: s.dev.toString(16),
      f: (s.mode & 0xffff).toString(16),
      F: type,
      g: String(s.gid),
      G: groupNameSync(s.gid),
      h: String(s.nlink),
      i: String(s.ino),
      m: "/",
      n: file,
      N: statQuotedName(file, quote.style, s),
      o: String(s.blksize ?? 4096),
      q: "?",
      Q: "?",
      r: statDeviceDirectiveValue("r", s, modifier),
      R: statDeviceDirectiveValue("R", s, modifier),
      s: String(s.size),
      t: statDeviceDirectiveValue("t", s, modifier),
      T: statDeviceDirectiveValue("T", s, modifier),
      u: String(s.uid),
      U: userNameForUidSync(s.uid) ?? String(s.uid),
      w: s.birthtimeMs ? statLocalDateText(s, "birthtime") : "-",
      W: s.birthtimeMs ? statSeconds(s, "birthtime") : "0",
      x: statLocalDateText(s, "atime"),
      X: statSeconds(s, "atime"),
      y: statLocalDateText(s, "mtime"),
      Y: statSeconds(s, "mtime"),
      z: statLocalDateText(s, "ctime"),
      Z: statSeconds(s, "ctime"),
    };
    const value = statFormatValue(directive, values[directive], flags);
    return value == null ? match : statPad(value, width, flags);
  });
  return { text: out, status, stderr: stderrText };
}

export function statFormatNeedsNanoseconds(format) {
  return /%[0 +#I-]*\d*(?:\.\d*)?[HL]?[wxyzWXYZ]/.test(format);
}

export function statFormatValue(directive, value, flags = "") {
  if (value == null) return null;
  if (!flags.includes("#")) return value;
  if ((directive === "f" || directive === "D") && !/^0+$/.test(value)) return `0x${value}`;
  if (directive === "a" && !value.startsWith("0")) return `0${value}`;
  return value;
}

export function statDeviceDirectiveValue(directive, statInfo, modifier = "") {
  const raw = directive === "d" ? statInfo.dev : (statInfo.rdev ?? 0);
  const dev = statMajorMinor(raw);
  const major = modifier === "L" ? dev.minor : dev.major;
  if (directive === "d") {
    if (modifier === "H" || modifier === "L") return String(major);
    return String(statInfo.dev);
  }
  if (directive === "r") {
    if (modifier === "H" || modifier === "L") return String(major);
    return String(statInfo.rdev ?? 0);
  }
  if (directive === "R") {
    if (modifier === "H" || modifier === "L") return major.toString(16);
    return Number(statInfo.rdev ?? 0).toString(16);
  }
  if (directive === "t") return dev.major.toString(16);
  if (directive === "T") return dev.minor.toString(16);
  return null;
}

export function statMajorMinor(dev) {
  const value = BigInt(dev);
  const major = ((value >> 8n) & 0xfffn) | ((value >> 32n) & ~0xfffn);
  const minor = (value & 0xffn) | ((value >> 12n) & ~0xffn);
  return { major: Number(major), minor: Number(minor) };
}

export function statPad(value, width, flags = "") {
  const n = Number(width);
  if (!Number.isInteger(n) || value.length >= n) return value;
  if (flags.includes("0") && !flags.includes("-") && value.startsWith("0x")) {
    return `0x${value.slice(2).padStart(n - 2, "0")}`;
  }
  return pad(value, width, flags);
}

export function statLocalDateText(statInfo, field) {
  const date = statInfo[field];
  const padNumber = (value, width = 2) => String(Math.trunc(Math.abs(value))).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetAbs = Math.abs(offsetMinutes);
  const offset = `${offsetSign}${padNumber(Math.trunc(offsetAbs / 60))}${padNumber(offsetAbs % 60)}`;
  const nanos = padNumber(statNanosecondFraction(statInfo, field), 9);
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}.${nanos} ${offset}`;
}

export function statSeconds(statInfo, field) {
  const value = statInfo[`${field}Ns`];
  if (value != null) return String(floorDivBigInt(BigInt(value), 1_000_000_000n));
  return String(Math.floor(statInfo[field].getTime() / 1000));
}

export function statSecondsWithPrecision(statInfo, field, precision) {
  const digits = precision === "" ? 9 : Math.min(10, Number(precision));
  const value = statInfo[`${field}Ns`];
  if (value != null) return formatSignedNanoseconds(value, digits);
  const total = BigInt(statInfo[field].getTime()) * 1_000_000n;
  return formatSignedNanoseconds(total, digits);
}

export function formatSignedNanoseconds(value, digits) {
  let total = BigInt(value);
  const sign = total < 0n ? "-" : "";
  if (total < 0n) total = -total;
  const seconds = total / 1_000_000_000n;
  const nanos = String(total % 1_000_000_000n).padStart(9, "0");
  return `${sign}${seconds}.${nanos.slice(0, digits).padEnd(digits, "0")}`;
}

export function statNanosecondFraction(statInfo, field) {
  const value = statInfo[`${field}Ns`];
  if (value != null) return Number(((BigInt(value) % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n);
  return statInfo[field].getMilliseconds() * 1_000_000;
}

export function statTimeFieldForDirective(directive) {
  return ({ X: "atime", Y: "mtime", Z: "ctime", W: "birthtime" })[directive];
}

export function fsTypeName(type) {
  const names = new Map([
    [0x58465342, "xfs"],
    [0xef53, "ext2/ext3"],
    [0x9123683e, "btrfs"],
    [0x01021994, "tmpfs"],
    [0x6969, "nfs"],
    [0x794c7630, "overlayfs"],
    [0x9fa0, "proc"],
    [0x62656572, "sysfs"],
  ]);
  return names.get(Number(type)) ?? "unknown";
}

export function statQuotingStyle() {
  const value = process.env.QUOTING_STYLE;
  if (value == null || value === "shell-escape") return { style: "shell", stderr: "" };
  if (value === "locale") return { style: "locale", stderr: "" };
  return { style: "shell", stderr: `stat: ignoring invalid value of environment variable QUOTING_STYLE: '${value}'\n` };
}

export function statQuotedName(file, style, s = null) {
  const name = statQuoteSingleName(file, style);
  if (s?.isSymbolicLink?.()) {
    try {
      return `${name} -> ${statQuoteSingleName(readlinkSync(file), style)}`;
    } catch {}
  }
  return name;
}

export function statQuoteSingleName(file, style) {
  if (style === "locale") return `'${String(file).replaceAll("'", "\\'")}'`;
  const text = String(file);
  if (!text.includes("'") && !/[\x00-\x1f\x7f]/.test(text)) return `'${text}'`;
  return shellQuote(text);
}

export function statDiagnosticName(file) {
  return statQuoteSingleName(pathDisplayName(file), "shell");
}

export function formatUsesStatDirective(format, directive) {
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== "%") continue;
    if (format[i + 1] === "%") {
      i++;
      continue;
    }
    const match = format.slice(i).match(/^%([0 +#I-]*)(\d+)?([HL])?([aAbBcCdDfFgGhHiImNnoOqRrSsTtUuWwXxYyZz])/);
    if (match) {
      if (match[4] === directive) return true;
      i += match[0].length - 1;
    }
  }
  return false;
}

export function decodeStatPrintfEscapes(format) {
  let out = "";
  let stderrText = "";
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    if (i + 1 >= format.length) {
      stderrText += "stat: warning: backslash at end of format\n";
      out += "\\";
      continue;
    }
    const next = format[++i];
    const simple = { "0": "\0", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" };
    if (/[0-7]/.test(next)) {
      let digits = next;
      while (digits.length < 3 && /[0-7]/.test(format[i + 1] ?? "")) digits += format[++i];
      out += String.fromCharCode(Number.parseInt(digits, 8) & 0xff);
    } else if (next === "x") {
      let digits = "";
      while (digits.length < 2 && /[0-9a-fA-F]/.test(format[i + 1] ?? "")) digits += format[++i];
      if (!digits) {
        stderrText += "stat: warning: unrecognized escape '\\x'\n";
        out += "x";
      } else {
        out += String.fromCharCode(Number.parseInt(digits, 16) & 0xff);
      }
    } else if (Object.hasOwn(simple, next)) {
      out += simple[next];
    } else {
      stderrText += `stat: warning: unrecognized escape '\\${next}'\n`;
      out += next;
    }
  }
  return { text: out, stderr: stderrText };
}

export function invalidStatDirective(format) {
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== "%") continue;
    if (format[i + 1] === "%") {
      i++;
      continue;
    }
    const rest = format.slice(i);
    if (rest === "%") return null;
    const match = rest.match(/^%([0 +#I-]*)(\d+)?(?:\.(\d*))?(([HL])?([aAbBcCdDfFgGhHiImNnoOqQRrSsTtUuWwXxYyZzl])|[HL])/);
    if (match) {
      i += match[0].length - 1;
      continue;
    }
    const invalid = rest.match(/^%[0 +#I-]*\d*.?/s)?.[0] ?? "%";
    return invalid;
  }
  return null;
}

export function fileTypeName(s) {
  if (s.isDirectory()) return "directory";
  if (s.isSymbolicLink()) return "symbolic link";
  if (s.isBlockDevice()) return "block special file";
  if (s.isCharacterDevice()) return "character special file";
  if (s.isFIFO()) return "fifo";
  if (s.isSocket()) return "socket";
  return s.size === 0 ? "regular empty file" : "regular file";
}

export function userNameForUidSync(uid) {
  try {
    const text = readFileSync("/etc/passwd", "utf8");
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const [name, , id] = line.split(":");
      if (Number(id) === Number(uid)) return name;
    }
  } catch {}
  return null;
}

export function groupNameSync(gid) {
  try {
    const text = readFileSync("/etc/group", "utf8");
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const [name, , id] = line.split(":");
      if (Number(id) === Number(gid)) return name;
    }
  } catch {}
  return String(gid);
}

const singleCall = defineCommand("stat", statCmd, statMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
