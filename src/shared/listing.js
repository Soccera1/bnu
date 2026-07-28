import { ptr, read, toArrayBuffer } from "bun:ffi";
import { lstatSync, statSync } from "node:fs";
import { lstat, readlink, stat } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { isAbsolute, dirname as pathDirname, resolve } from "node:path";
import { AT_FDCWD, AT_SYMLINK_NOFOLLOW, attachDateNanoseconds, attachStatNanoseconds, bufferPathJoin, compareSortBytes, compareSortLocaleText, cstr, cstrPath, displayWidth, globMatch, groupName, initializeSortLocaleCollation, invalidOptionMessage, isAsciiDigit, isBytePath, libc, libcErrno, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, lsEscapedName, lsUsesUtf8Locale, nativeStatNanoseconds, normalizeLongOptionByPrefix, parseOptions, pathDisplayName, pathLikeJoin, readdirPathEntries, shellEscapeLsName, shellQuoteLsName, systemErrorMessage, userNameForUid } from "./common.js";
import { InvocationError, UsageError, stderr, stdout } from "./diagnostics.js";
import { applyBlockSizeSpecialMode, blockSizeSpecialMode, defaultGNUBlockSize, fileTypeChar, gnuBlockSizeErrorMessage, humanSizeWithUnits, modeString, optionValues, parseGNUBlockSize, rawOperandPlan, rmLibcError, selinuxSecurityContext, validateBlockSizeMetaOption } from "./filesystem.js";
import { lsTimeText, parseGNUBlockSizeEnv } from "./time.js";

export const LS_LONG_OPTIONS = ["all", "almost-all", "author", "directory", "classify", "file-type", "dereference", "dereference-command-line", "dereference-command-line-symlink-to-dir", "full", "full-time", "group-directories-first", "group", "indicator-style", "inode", "size", "human-readable", "si", "kibibytes", "recursive", "reverse", "color", "sort", "time-style", "time", "tabsize", "width", "block-size", "format", "ignore", "hide-control-chars", "hide", "hyperlink", "ignore-backups", "zero", "dired", "quote-name", "literal", "escape", "show-control-chars", "no-group", "numeric-uid-gid", "quoting", "quoting-style", "context", "help", "version"];

export function lsMetaOption(args) {
  const longOptionalValueOptions = new Set(["classify", "color", "hyperlink"]);
  const longValueOptions = new Set(["indicator-style", "sort", "time-style", "time", "tabsize", "width", "block-size", "format", "ignore", "hide", "quoting", "quoting-style"]);
  const longFlagOptions = new Set(LS_LONG_OPTIONS.filter((option) => !longOptionalValueOptions.has(option) && !longValueOptions.has(option) && option !== "help" && option !== "version"));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeLsLongOption(arg);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      return normalized;
    }
    if (longFlagOptions.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      continue;
    }
    if (longOptionalValueOptions.has(name)) {
      if (name === "color" && inlineValue !== undefined) lsColorEnabled({ color: inlineValue });
      if (name === "hyperlink" && inlineValue !== undefined) lsHyperlinkEnabled({ hyperlink: inlineValue });
      if (name === "classify" && inlineValue !== undefined) validateLsClassifyMetaOption(inlineValue);
      continue;
    }
    if (longValueOptions.has(name)) {
      const value = inlineValue ?? args[i + 1];
      if (name === "block-size" && value !== undefined) validateBlockSizeMetaOption("--block-size", value);
      if (name === "width" && value !== undefined) parseLsWidth(value);
      if (name === "tabsize" && value !== undefined) parseLsTabSize(value);
      if (name === "time" && value !== undefined) validateLsTime(value);
      if (name === "sort" && value !== undefined) validateLsSort(value);
      if (name === "indicator-style" && value !== undefined) validateLsIndicatorStyle(value);
      if (name === "format" && value !== undefined) lsLayoutForFormat(value);
      if ((name === "quoting" || name === "quoting-style") && value !== undefined) validateLsQuotingStyle(value);
      if (inlineValue === undefined) i++;
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      i = scanLsShortMetaOption(args, i);
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(invalidOptionMessage(arg), true);
  }
  return null;
}

export function scanLsShortMetaOption(args, index) {
  const arg = args[index];
  const flagOptions = new Set(["a", "A", "B", "D", "H", "L", "c", "u", "l", "d", "f", "g", "G", "o", "n", "i", "s", "h", "k", "1", "F", "R", "S", "t", "X", "U", "r", "b", "C", "x", "m", "q", "Q", "N", "v", "p", "Z", "0"]);
  const valueOptions = new Set(["T", "w", "I"]);
  for (let j = 1; j < arg.length; j++) {
    const ch = arg[j];
    if (valueOptions.has(ch)) {
      const inlineValue = arg.slice(j + 1);
      const value = inlineValue === "" ? args[index + 1] : inlineValue;
      if (ch === "w" && value !== undefined) parseLsWidth(value);
      if (ch === "T" && value !== undefined) parseLsTabSize(value);
      return inlineValue === "" ? index + 1 : index;
    }
    if (flagOptions.has(ch)) {
      continue;
    }
    throw new UsageError(`invalid option -- '${ch}'`, true);
  }
  return index;
}

export function validateLsIndicatorStyle(value) {
  if (lsIndicatorStyle({ "indicator-style": value }) === null) {
    throw new InvocationError(lsInvalidEnumMessage(value, "--indicator-style", LS_INDICATOR_VALID_ARGUMENTS), 1, true);
  }
}

export function validateLsClassifyMetaOption(value) {
  if (lsIndicatorStyle({ classify: value }) === null) {
    throw new InvocationError(lsInvalidEnumMessage(value, "--classify", LS_CLASSIFY_VALID_ARGUMENTS), 1, true);
  }
}

export async function lsCmd(args) {
  args = normalizeLsLongOptions(args);
  const { opts, operands: parsedOperands } = parseOptions(args, { short: { a: false, A: false, B: false, D: false, H: false, L: false, c: false, u: false, l: false, d: false, f: false, g: false, G: false, o: false, n: false, i: false, s: false, h: false, k: false, 1: false, F: false, R: false, S: false, t: false, T: "value", X: false, U: false, r: false, b: false, C: false, x: false, m: false, q: false, Q: false, N: false, v: false, p: false, w: "value", I: "value-array", Z: false, 0: false }, long: { all: false, "almost-all": false, author: false, directory: false, classify: "optional-value", "file-type": false, dereference: false, "dereference-command-line": false, "dereference-command-line-symlink-to-dir": false, full: false, "full-time": false, "group-directories-first": false, group: false, "indicator-style": "value", inode: false, size: false, "human-readable": false, si: false, kibibytes: false, recursive: false, reverse: false, color: "optional-value", hyperlink: "optional-value", hyper: "optional-value", "sort": "value", "time-style": "value", time: "value", "tabsize": "value", width: "value", "block-size": "value", format: "value", ignore: "value-array", hide: "value-array", "ignore-backups": false, zero: false, dired: false, "quote-name": false, literal: false, escape: false, "hide-control-chars": false, "show-control-chars": false, "no-group": false, "numeric-uid-gid": false, quoting: "value", "quoting-style": "value", context: false, help: false, version: false } });
  const operands = rawOperandPlan("ls", args, parsedOperands, {
    valueOptions: ["--indicator-style", "--sort", "--time-style", "--time", "--tabsize", "--width", "--block-size", "--format", "--ignore", "--hide", "--quoting", "--quoting-style"],
    shortValueOptions: ["T", "w", "I"],
  }) ?? parsedOperands;
  opts.localeCollation = initializeSortLocaleCollation();
  if (opts.B) opts["ignore-backups"] = true;
  if (opts.D) opts.dired = true;
  if ((opts[0] || opts.zero) && opts.dired) throw new UsageError("--dired and --zero are incompatible", true);
  applyLsFormatOptions(args, opts);
  opts.allMode = lsAllMode(args, opts);
  opts.ignorePatterns = optionValues(opts.I).concat(optionValues(opts.ignore));
  if (opts.allMode === "visible") opts.ignorePatterns.push(...optionValues(opts.hide));
  if (opts["ignore-backups"]) opts.ignorePatterns.push("*~");
  opts.zero = opts[0] || opts.zero;
  if (opts.literal) opts.N = true;
  if (opts.b || opts.escape) opts.quoting = "escape";
  if (opts["hide-control-chars"]) opts.q = true;
  if (opts["show-control-chars"]) opts.N = true;
  if (opts["no-group"]) opts.G = true;
  if (opts.kibibytes) opts.k = true;
  if (opts["numeric-uid-gid"]) opts.n = true;
  if (opts.n) opts.l = true;
  applyLsBlockSizeSpecialMode(opts);
  opts.width = parseLsWidth(opts.w ?? opts.width);
  opts.tabSize = parseLsTabSize(opts.T ?? opts.tabsize);
  opts.blockSize = lsBlockSize(opts);
  opts.sizeBlockSize = lsSizeBlockSize(opts);
  if (opts.full || opts["full-time"]) {
    opts.l = true;
    if (opts["time-style"] == null) opts["time-style"] = "full-iso";
  }
  if (opts["time-style"] == null && process.env.TIME_STYLE) opts["time-style"] = process.env.TIME_STYLE;
  if (lsUsesLongListing(opts)) validateLsTimeStyle(opts["time-style"]);
  validateLsSort(opts.sort);
  validateLsTime(opts.time);
  validateLsQuotingStyle(opts.quoting ?? opts["quoting-style"]);
  opts.indicatorStyle = lsIndicatorStyle(opts);
  opts.colorEnabled = lsColorEnabled(opts);
  opts.hyperlinkEnabled = lsHyperlinkEnabled(opts);
  if (opts.indicatorStyle === null) {
    const option = opts.classify != null ? "classify" : "indicator-style";
    throw new InvocationError(lsInvalidEnumMessage(opts.classify ?? opts["indicator-style"], `--${option}`, option === "classify" ? LS_CLASSIFY_VALID_ARGUMENTS : LS_INDICATOR_VALID_ARGUMENTS), 1, true);
  }
  const targets = operands.length ? operands : ["."];
  let out = await renderLsTargets(targets, opts, targets.length > 1);
  if (opts.dired) out = formatLsDiredOutput(out, lsResolvedQuotingStyle(opts));
  stdout(out);
  if (opts.majorProblem) return 2;
  return opts.minorProblem ? 1 : 0;
}

export function applyLsFormatOptions(args, opts) {
  let layout = null;
  let diredSeen = Boolean(opts.dired);
  let diredActive = Boolean(opts.dired);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "-" || !arg.startsWith("-")) continue;
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (name === "dired") {
        diredSeen = true;
        diredActive = true;
        layout = "l";
      }
      if (name === "format") {
        const value = inlineValue ?? args[++i];
        layout = lsLayoutForFormat(value);
        if (diredSeen) diredActive = layout === "l";
      }
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (ch === "D") {
        diredSeen = true;
        diredActive = true;
        layout = "l";
      } else if ("Cxm".includes(ch)) {
        layout = ch;
        if (diredSeen) diredActive = false;
      } else if (ch === "1") {
        if (!diredActive) layout = ch;
      } else if ("lgno".includes(ch)) {
        layout = ch;
        if (diredSeen) diredActive = true;
      }
      if (["T", "w", "I"].includes(ch)) break;
    }
  }
  opts.dired = diredActive;
  if (layout == null) return;
  opts[1] = opts.C = opts.x = opts.m = false;
  if (["1", "C", "x", "m"].includes(layout)) opts.l = opts.g = opts.n = opts.o = false;
  if (layout === "1") opts[1] = true;
  else if (layout === "C") opts.C = true;
  else if (layout === "x") opts.x = true;
  else if (layout === "m") opts.m = true;
  else if (layout === "g") opts.g = true;
  else if (layout === "n") opts.n = true;
  else if (layout === "o") opts.o = true;
  else opts.l = true;
}

export function lsLayoutForFormat(value) {
  const text = String(value);
  const layouts = {
    "single-column": "1",
    vertical: "C",
    long: "l",
    verbose: "l",
    commas: "m",
    horizontal: "x",
    across: "x",
  };
  const layout = layouts[text];
  if (layout) return layout;
  throw new InvocationError(lsInvalidEnumMessage(text, "--format", LS_FORMAT_VALID_ARGUMENTS), 1, true);
}

export function normalizeLsLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeLsLongOption(arg));
  }
  return out;
}

export function normalizeLsLongOption(arg) {
  const [rawName, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
  if (rawName.startsWith("hy") && "hyperlink".startsWith(rawName)) {
    return inlineValue === undefined ? "--hyperlink" : `--hyperlink=${inlineValue}`;
  }
  const normalized = normalizeLongOptionByPrefix(arg, LS_LONG_OPTIONS);
  if (normalized === "--hyper" || normalized.startsWith("--hyper=")) return `--hyperlink${normalized.slice("--hyper".length)}`;
  return normalized;
}

export const LS_FORMAT_VALID_ARGUMENTS = [
  ["verbose", "long"],
  ["commas"],
  ["horizontal", "across"],
  ["vertical"],
  ["single-column"],
];

export const LS_INDICATOR_VALID_ARGUMENTS = [
  ["none"],
  ["slash"],
  ["file-type"],
  ["classify"],
];

export const LS_CLASSIFY_VALID_ARGUMENTS = [
  ["always", "yes", "force"],
  ["never", "no", "none"],
  ["auto", "tty", "if-tty"],
];

export const LS_TRISTATE_VALID_ARGUMENTS = LS_CLASSIFY_VALID_ARGUMENTS;

export const LS_SORT_VALID_ARGUMENTS = [
  ["none"],
  ["size"],
  ["time"],
  ["version"],
  ["extension"],
  ["name"],
  ["width"],
];

export const LS_TIME_VALID_ARGUMENTS = [
  ["atime", "access", "use"],
  ["ctime", "status"],
  ["mtime", "modification"],
  ["birth", "creation"],
];

export const LS_QUOTING_STYLE_VALID_ARGUMENTS = [
  ["literal"],
  ["shell"],
  ["shell-always"],
  ["shell-escape"],
  ["shell-escape-always"],
  ["c"],
  ["c-maybe"],
  ["escape"],
  ["locale"],
  ["clocale"],
];

export function lsInvalidEnumMessage(value, option, groups) {
  const kind = value === "" ? "ambiguous" : "invalid";
  return `${kind} argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic(option)}\nValid arguments are:\n${groups.map((group) => `  - ${group.map(localeQuotedDiagnostic).join(", ")}`).join("\n")}`;
}

export function lsUsesLongListing(opts) {
  return Boolean(opts.l || opts.g || opts.o || opts.n);
}

export function lsBlockSize(opts) {
  if (opts["block-size"] !== undefined) {
    try {
      return parseGNUBlockSize(opts["block-size"]);
    } catch {
      throw new UsageError(gnuBlockSizeErrorMessage("--block-size", opts["block-size"]));
    }
  }
  if (opts.k) return 1024;
  return parseGNUBlockSizeEnv(lsBlockSizeEnvValue(), lsDefaultBlockSize());
}

export function lsSizeBlockSize(opts) {
  if (opts["block-size"] !== undefined) return parseGNUBlockSize(opts["block-size"]);
  const envValue = lsSizeBlockSizeEnvValue();
  if (envValue != null) return parseGNUBlockSizeEnv(envValue, lsDefaultBlockSize());
  return 1;
}

export function lsBlockSizeValue(opts) {
  return opts["block-size"] ?? lsBlockSizeEnvValue();
}

export function lsSizeBlockSizeValue(opts) {
  return opts["block-size"] ?? lsSizeBlockSizeEnvValue();
}

export function lsBlockSizeEnvValue() {
  return process.env.LS_BLOCK_SIZE ?? process.env.BLOCK_SIZE ?? process.env.BLOCKSIZE;
}

export function lsSizeBlockSizeEnvValue() {
  return process.env.LS_BLOCK_SIZE ?? process.env.BLOCK_SIZE;
}

export function lsDefaultBlockSize() {
  return defaultGNUBlockSize();
}

export function parseLsWidth(value) {
  if (value == null) return null;
  const text = String(value);
  const width = parseLsUnsignedNumber(text);
  if (width == null) throw new UsageError(`invalid line width: ${localeQuotedEscapedDiagnostic(text)}`);
  if (width === 0) return Number.POSITIVE_INFINITY;
  return width;
}

export function parseLsTabSize(value) {
  if (value == null) return 8;
  const text = String(value);
  const tabSize = parseLsUnsignedNumber(text);
  if (tabSize == null) throw new UsageError(`invalid tab size: ${localeQuotedEscapedDiagnostic(text)}`);
  return tabSize;
}

export function parseLsUnsignedNumber(text) {
  if (/^-/.test(text)) return null;
  let digits = text;
  let base = 10;
  if (/^0[xX]/.test(text)) {
    digits = text.slice(2);
    base = 16;
    if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
  } else if (text.startsWith("0") && text !== "0") {
    digits = text.slice(1);
    base = 8;
    if (!/^[0-7]+$/.test(digits)) return null;
  } else if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number.parseInt(digits || "0", base);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

export function validateLsTimeStyle(style) {
  if (style == null || (typeof style === "string" && style.startsWith("+"))) return;
  const allowed = ["full-iso", "long-iso", "iso", "locale"];
  const normalized = String(style).replace(/^posix-/, "");
  if (allowed.includes(normalized)) return;
  throw new UsageError(`invalid argument ${localeQuotedEscapedDiagnostic(style)} for ${localeQuotedDiagnostic("time style")}
Valid arguments are:
  - [posix-]full-iso
  - [posix-]long-iso
  - [posix-]iso
  - [posix-]locale
  - +FORMAT (e.g., +%H:%M) for a 'date'-style format`, true);
}

export function validateLsSort(sort) {
  if (sort == null) return;
  const allowed = ["none", "size", "time", "version", "extension", "name", "width"];
  if (allowed.includes(String(sort))) return;
  throw new InvocationError(lsInvalidEnumMessage(sort, "--sort", LS_SORT_VALID_ARGUMENTS), 1, true);
}

export function validateLsTime(time) {
  if (time == null) return;
  const allowed = LS_TIME_VALID_ARGUMENTS.flat();
  if (allowed.includes(String(time))) return;
  throw new InvocationError(lsInvalidEnumMessage(time, "--time", LS_TIME_VALID_ARGUMENTS), 1, true);
}

export function validateLsQuotingStyle(style) {
  if (style == null) return;
  const resolved = resolveLsQuotingStyle(style);
  if (resolved) return;
  throw new InvocationError(lsInvalidEnumMessage(style, "--quoting-style", LS_QUOTING_STYLE_VALID_ARGUMENTS), 1, true);
}

export function resolveLsQuotingStyle(style) {
  if (style == null) return null;
  const text = String(style);
  const allowed = LS_QUOTING_STYLE_VALID_ARGUMENTS.flat();
  if (allowed.includes(text)) return text;
  const matches = allowed.filter((candidate) => candidate.startsWith(text));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new InvocationError(`ambiguous argument ${localeQuotedDiagnostic(text)} for ${localeQuotedDiagnostic("--quoting-style")}\nValid arguments are:\n${LS_QUOTING_STYLE_VALID_ARGUMENTS.map((group) => `  - ${group.map(localeQuotedDiagnostic).join(", ")}`).join("\n")}`, 1, true);
  return null;
}

export function lsIndicatorStyle(opts) {
  if (opts.p) return "slash";
  if (opts["file-type"]) return "file-type";
  const style = opts["indicator-style"];
  if (style != null) {
    if (["none", "classify", "file-type", "slash"].includes(style)) return style;
    return null;
  }
  if (opts.F) return "classify";
  if (opts.classify != null) {
    const mode = opts.classify === true ? "always" : opts.classify;
    if (mode === "always" || mode === "yes" || mode === "force") return "classify";
    if (mode === "auto" || mode === "tty" || mode === "if-tty" || mode === "never" || mode === "no" || mode === "none") return "none";
    return null;
  }
  return "none";
}

export function lsColorEnabled(opts) {
  if (opts.color == null || opts.color === "never") return false;
  if (opts.color === true || opts.color === "always" || opts.color === "yes" || opts.color === "force") return terminalSupportsColor();
  if (opts.color === "auto" || opts.color === "tty" || opts.color === "if-tty") return terminalSupportsColor() && Boolean(process.stdout.isTTY);
  throw new InvocationError(lsInvalidEnumMessage(opts.color, "--color", LS_TRISTATE_VALID_ARGUMENTS), 1, true);
}

export function lsHyperlinkEnabled(opts) {
  const value = opts.hyperlink ?? opts.hyper;
  if (opts.dired) return false;
  if (value == null || value === "never" || value === "no" || value === "none") return false;
  if (value === true || value === "always" || value === "yes" || value === "force") return true;
  if (value === "auto" || value === "tty" || value === "if-tty") return Boolean(process.stdout.isTTY);
  throw new InvocationError(lsInvalidEnumMessage(value, "--hyperlink", LS_TRISTATE_VALID_ARGUMENTS), 1, true);
}

export function terminalSupportsColor() {
  if (process.env.COLORTERM) return true;
  if (process.env.TERM === "") return false;
  return process.env.TERM !== "dumb";
}

export function lsAllMode(args, opts) {
  let mode = "visible";
  let sawMode = false;
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "--all") {
      mode = "all";
      sawMode = true;
    } else if (arg === "--almost-all") {
      mode = "almost";
      sawMode = true;
    } else if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === "I") break;
        if (ch === "a" || ch === "f") {
          mode = "all";
          sawMode = true;
        } else if (ch === "A") {
          mode = "almost";
          sawMode = true;
        }
      }
    }
  }
  if (sawMode) return mode;
  if (opts.a || opts.f || opts.all) return "all";
  if (opts.A || opts["almost-all"]) return "almost";
  return "visible";
}

export async function renderLsTargets(targets, opts, labelDirs) {
  const recursiveDirSeen = new Set();
  const targetStats = await Promise.all(targets.map(async (target) => {
    try {
      return { target, ...(await lsEntryStats(target, opts, true)) };
    } catch (error) {
      opts.majorProblem = true;
      stderr(`ls: cannot access '${target}': ${systemErrorMessage(error)}\n`);
      return null;
    }
  }));
  const validTargets = targetStats.filter(Boolean);
  if (!validTargets.length) return "";
  if (validTargets.every(({ stat }) => opts.d || opts.directory || !stat.isDirectory())) {
    const entries = validTargets.map(({ target, stat, linkStat, danglingDereference, targetDirectory, targetMissing, hasCapability }) => ({ name: target, path: target, stat, linkStat, danglingDereference, targetDirectory, targetMissing, hasCapability }));
    sortLsEntries(entries, opts);
    return await renderLsEntries(entries, opts);
  }
  let out = "";
  const fileEntries = validTargets
    .filter(({ stat: s }) => opts.d || opts.directory || !s.isDirectory())
    .map(({ target, stat, linkStat, danglingDereference, targetDirectory, targetMissing, hasCapability }) => ({ name: target, path: target, stat, linkStat, danglingDereference, targetDirectory, targetMissing, hasCapability }));
  if (fileEntries.length) {
    sortLsEntries(fileEntries, opts);
    out += await renderLsEntries(fileEntries, opts);
  }
  let renderedDir = false;
  for (const { target, stat: s } of validTargets) {
    if (!s.isDirectory() || opts.d || opts.directory) continue;
    out += await renderLsDirectory(target, opts, labelDirs || opts.R || opts.recursive, fileEntries.length > 0 || renderedDir, recursiveDirSeen, s);
    renderedDir = true;
  }
  return out;
}

export async function renderLsDirectory(target, opts, label, leadingBlank = false, recursiveDirSeen = new Set(), directoryStat = null) {
  let out = "";
  const currentStat = directoryStat ?? await stat(target).catch(() => null);
  if (currentStat) recursiveDirSeen.add(lsDirectoryIdentity(currentStat));
  if (leadingBlank) out += "\n";
  if (label) out += `${formatLsHyperlink(quoteLsDirectoryLabelName(target, opts), await lsDirectoryLabelPath(target), opts)}:\n`;
  const rawDisplayNames = Boolean((await lstat(target).catch(() => null))?.isSymbolicLink());
  let names = await lsReadDirectoryEntries(target);
  if (opts.allMode === "all") names = [{ name: Buffer.from("."), type: 4 }, { name: Buffer.from(".."), type: 4 }, ...names];
  else if (opts.allMode !== "almost") names = names.filter(({ name }) => !lsDirectoryEntryDisplayName(name, rawDisplayNames).startsWith("."));
  names = names.filter(({ name }) => !lsIgnored(lsDirectoryEntryDisplayName(name, rawDisplayNames), opts));
  const entries = [];
  for (const { name, type, inode } of names) {
    const displayName = lsDirectoryEntryDisplayName(name, rawDisplayNames);
    const path = displayName === "." ? target : displayName === ".." ? pathLikeJoin(target, Buffer.from("..")) : pathLikeJoin(target, name);
    try {
      entries.push({ name: displayName, path, direntInode: inode, ...(await lsEntryStats(path, opts, false)) });
    } catch (error) {
      // readdir has already established that this name exists.  Preserve its
      // d_type when a following metadata lookup fails, as GNU ls does for
      // inaccessible and concurrently removed directory entries.
      opts.minorProblem = true;
      stderr(`ls: cannot access '${pathDisplayName(path)}': ${systemErrorMessage(error)}\n`);
      entries.push({
        name: displayName,
        path,
        direntInode: inode,
        direntTypeChar: lsDirentTypeChar(type),
        statFailed: true,
        stat: lsUnknownStat(type),
      });
    }
  }
  sortLsEntries(entries, opts);
  if (opts.l || opts.g || opts.o || opts.s || opts.size || opts.dired) out += `total ${lsTotalBlocks(entries)}\n`;
  out += await renderLsEntries(entries, opts);
  if (opts.R || opts.recursive) {
    for (const entry of entries) {
      if (entry.name === "." || entry.name === ".." || !entry.stat.isDirectory() || entry.stat.isSymbolicLink()) continue;
      const childTarget = lsRecursiveChildTarget(target, entry);
      const identity = lsDirectoryIdentity(entry.stat);
      if (recursiveDirSeen.has(identity)) {
        opts.majorProblem = true;
        stderr(`ls: ${childTarget}: not listing already-listed directory\n`);
        continue;
      }
      out += `\n${await renderLsDirectory(childTarget, opts, true, false, recursiveDirSeen, entry.stat)}`;
    }
  }
  return out;
}

export function lsReadDirectoryEntries(path) {
  if (process.platform !== "linux") {
    return readdirPathEntries(path).then((names) => names.map((name) => ({ name, type: 0 })));
  }
  const directory = libc.symbols.opendir(cstrPath(path));
  if (!directory) throw rmLibcError(libcErrno());
  const entries = [];
  try {
    while (true) {
      const errnoPointer = libc.symbols.__errno_location();
      if (errnoPointer) libc.symbols.memset(errnoPointer, 0, 4);
      const address = libc.symbols.readdir(directory);
      if (!address) {
        const errno = libcErrno();
        if (errno) throw rmLibcError(errno);
        break;
      }
      const recordLength = read.u16(address, 16);
      const maximumNameLength = Math.max(0, recordLength - 19);
      let nameLength = 0;
      while (nameLength < maximumNameLength && read.u8(address + 19, nameLength) !== 0) nameLength++;
      const name = Buffer.from(new Uint8Array(toArrayBuffer(address + 19, 0, nameLength)));
      if (name.equals(Buffer.from(".")) || name.equals(Buffer.from(".."))) continue;
      entries.push({ name, type: read.u8(address, 18), inode: read.u64(address, 0) });
    }
  } finally {
    libc.symbols.closedir(directory);
  }
  return entries;
}

export function lsDirentTypeChar(type) {
  return ({ 1: "p", 2: "c", 4: "d", 6: "b", 8: "-", 10: "l", 12: "s" })[type] ?? "?";
}

export function lsUnknownStat(type) {
  const isType = (value) => type === value;
  return {
    mode: 0,
    size: 0,
    blocks: 0,
    ino: 0,
    nlink: 0,
    uid: 0,
    gid: 0,
    isFile: () => isType(8),
    isDirectory: () => isType(4),
    isBlockDevice: () => isType(6),
    isCharacterDevice: () => isType(2),
    isSymbolicLink: () => isType(10),
    isFIFO: () => isType(1),
    isSocket: () => isType(12),
  };
}

export function lsDirectoryEntryDisplayName(name, rawDisplayNames = false) {
  if (!isBytePath(name)) return String(name);
  return pathDisplayName(name);
}

export function lsDirectoryIdentity(statInfo) {
  return `${statInfo.dev}:${statInfo.ino}`;
}

export async function lsEntryStats(path, opts, commandLine) {
  const needsNanoseconds = lsNeedsStatNanoseconds(opts);
  const linkStat = lsAttachStatNanoseconds(await lstat(path), path, false, needsNanoseconds);
  const hasCapability = linkStat.isFile() && opts.colorEnabled && lsCapabilityColorEnabled()
    ? lsFileHasCapability(path)
    : false;
  // -F needs the mode bits of regular files to distinguish executable
  // entries.  Perform that required query on the calling thread, while
  // retaining d_type/lstat knowledge for symlinks and directories so those
  // do not acquire an unnecessary target stat.
  if (linkStat.isFile() && opts.indicatorStyle === "classify") lsNativeModeProbe(path);
  if (linkStat.isSymbolicLink() && (opts.L || opts.dereference || (commandLine && (opts.H || opts["dereference-command-line"])))) {
    try {
      return { stat: lsAttachStatNanoseconds(await stat(path), path, true, needsNanoseconds), linkStat, hasCapability };
    } catch (error) {
      if (commandLine) throw error;
      const needsInfo = opts.i || opts.inode || opts.s || opts.size || opts.l || opts.g || opts.o;
      if ((opts.L || opts.dereference) && (needsInfo || error?.code === "ENOENT" || error?.code === "ENOTDIR")) {
        opts.minorProblem = true;
        stderr(`ls: cannot access '${path}': ${systemErrorMessage(error)}\n`);
      }
      if (!needsInfo) return { stat: linkStat, linkStat, targetMissing: true };
      return { stat: linkStat, linkStat, danglingDereference: needsInfo, targetMissing: true };
    }
  }
  if (commandLine && linkStat.isSymbolicLink() && !(opts.d || opts.directory) && (opts.H || opts["dereference-command-line"] || opts.L || opts.dereference || !(opts.F || opts.p || opts.classify != null || opts["file-type"] || opts["indicator-style"]))) {
    try {
      const targetStat = lsAttachStatNanoseconds(await stat(path), path, true, needsNanoseconds);
      if (targetStat.isDirectory()) return { stat: targetStat, linkStat, targetDirectory: true };
    } catch {}
  }
  let targetDirectory = false;
  let targetMissing = false;
  if (linkStat.isSymbolicLink()) {
    try {
      targetDirectory = (await stat(path)).isDirectory();
    } catch {
      targetMissing = true;
    }
  }
  return { stat: linkStat, linkStat, targetDirectory, targetMissing, hasCapability };
}

export let lsCapabilityProbeDone = false;

export function lsCapabilityColorEnabled() {
  const code = lsColorCode("ca");
  return code != null && code !== "" && code !== "00";
}

export function lsFileHasCapability(path) {
  // Match GNU ls/libcap's process capability probe, while reading the file
  // capability directly from Linux's canonical security.capability xattr.
  if (!lsCapabilityProbeDone) {
    const header = Buffer.alloc(8);
    const data = Buffer.alloc(24);
    header.writeUInt32LE(0x20080522, 0);
    libc.symbols.capget(ptr(header), ptr(data));
    lsCapabilityProbeDone = true;
  }
  return libc.symbols.getxattr(cstrPath(path), cstr("security.capability"), 0, 0n) > 0n;
}

export function lsNativeModeProbe(path) {
  const buffer = Buffer.alloc(256);
  libc.symbols.statx(AT_FDCWD, cstrPath(path), AT_SYMLINK_NOFOLLOW, 0x0002, buffer);
}

export function lsNeedsStatNanoseconds(opts) {
  const style = opts["time-style"];
  if (opts.t || opts.c || opts.u || opts.time != null || opts.sort === "time") return true;
  if (style === "full-iso" || style === "posix-full-iso") return true;
  return typeof style === "string" && style.startsWith("+") && /%[-_0^#+]*\d*N/.test(style);
}

export function lsAttachStatNanoseconds(statInfo, path, dereference, enabled = true) {
  if (!enabled) return statInfo;
  try {
    const precise = nativeStatNanoseconds(path, dereference) ?? (dereference ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true }));
    attachStatNanoseconds(statInfo, precise);
  } catch {}
  return statInfo;
}

export function lsRecursiveChildTarget(parent, entry) {
  if (isBytePath(parent)) return entry.path;
  if (parent === "." || parent.startsWith("./")) return `${parent.replace(/\/+$/, "")}/${entry.name}`;
  return entry.path;
}

export function lsIgnored(name, opts) {
  return (opts.ignorePatterns ?? []).some((pattern) => globMatch(String(pattern), name));
}

export function lsTotalBlocks(entries) {
  return entries.reduce((sum, entry) => entry.danglingDereference || entry.statFailed ? sum : sum + Number(lsAllocatedBlockCount(entry.stat, 1024n)), 0);
}

export function sortLsEntries(entries, opts) {
  if (((opts.U || opts.f) && opts.sort == null) || opts.sort === "none") return;
  entries.sort((a, b) => {
    if (opts["group-directories-first"] || opts.group) {
      const dirCompare = Number(lsGroupDirectory(b)) - Number(lsGroupDirectory(a));
      if (dirCompare) return dirCompare;
    }
    let result;
    if (opts.sort === "name") result = compareLsNames(a.name, b.name, opts);
    else if (opts.S || opts.sort === "size") result = b.stat.size - a.stat.size || compareLsNames(a.name, b.name, opts);
    else if (opts.t || opts.c || opts.u || opts.time != null || opts.sort === "time") result = compareBigInt(lsEntryTimeNs(b, opts), lsEntryTimeNs(a, opts)) || compareLsNames(a.name, b.name, opts);
    else if (opts.sort === "width") result = [...pathDisplayName(a.name)].length - [...pathDisplayName(b.name)].length || compareLsNames(a.name, b.name, opts);
    else if (opts.v || opts.sort === "version") result = lsVersionCompare(a.name, b.name);
    else if (opts.X || opts.sort === "extension") result = extensionCompare(a.name, b.name);
    else result = compareLsNames(a.name, b.name, opts);
    return opts.r || opts.reverse ? -result : result;
  });
}

export function compareLsNames(a, b, opts) {
  const aa = pathDisplayName(a);
  const bb = pathDisplayName(b);
  return opts.localeCollation ? compareSortLocaleText(aa, bb) : compareSortBytes(aa, bb);
}

export function lsGroupDirectory(entry) {
  return entry.stat.isDirectory() || entry.targetDirectory;
}

export function lsVersionCompare(a, b) {
  const aa = String(a);
  const bb = String(b);
  let ai = 0;
  let bi = 0;
  while (ai < aa.length || bi < bb.length) {
    if (aa[ai] === "~" || bb[bi] === "~") {
      if (aa[ai] !== "~") return 1;
      if (bb[bi] !== "~") return -1;
      ai++;
      bi++;
      continue;
    }
    if (ai >= aa.length) return -1;
    if (bi >= bb.length) return 1;
    if (isAsciiDigit(aa[ai]) && isAsciiDigit(bb[bi])) {
      const aStart = ai;
      const bStart = bi;
      while (isAsciiDigit(aa[ai])) ai++;
      while (isAsciiDigit(bb[bi])) bi++;
      const aDigits = aa.slice(aStart, ai);
      const bDigits = bb.slice(bStart, bi);
      const na = BigInt(aDigits.replace(/^0+/, "") || "0");
      const nb = BigInt(bDigits.replace(/^0+/, "") || "0");
      if (na !== nb) return na < nb ? -1 : 1;
      if (aDigits.length !== bDigits.length) return aDigits.length - bDigits.length;
      continue;
    }
    if (aa[ai] !== bb[bi]) return aa[ai] < bb[bi] ? -1 : 1;
    ai++;
    bi++;
  }
  return 0;
}

export function lsEntryTimeNs(entry, opts) {
  const mode = lsEntryTimeMode(opts);
  const value = entry.stat[`${mode}Ns`];
  if (value != null) return BigInt(value);
  return BigInt(lsEntryTime(entry, opts).getTime()) * 1_000_000n;
}

export function compareBigInt(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function extensionCompare(a, b) {
  const ax = extensionSortKey(a);
  const bx = extensionSortKey(b);
  if (ax.ext !== bx.ext) return ax.ext < bx.ext ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function extensionSortKey(name) {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return { ext: "" };
  return { ext: name.slice(index + 1) };
}

export async function renderLsEntries(entries, opts) {
  if (!entries.length) return "";
  if (opts.l || opts.g || opts.o) {
    const lines = renderLsLongEntries(await Promise.all(entries.map((entry) => lsLongEntryFields(entry, opts))), opts);
    return opts.zero ? lines.join("\0") + "\0" : lines.join("\n") + "\n";
  }
  if (opts.zero) return entries.map((entry) => formatLsEntry(entry, opts)).join("\0") + "\0";
  if (opts.m) return renderLsCommaEntries(entries, opts);
  const wideQuotedColumns = opts.width == null && (opts.quoting ?? opts["quoting-style"]) === "shell-escape";
  const separator = opts.C || opts.x ? (wideQuotedColumns ? "   " : "  ") : "\n";
  const widths = lsShortEntryWidths(entries, opts);
  const fields = [];
  let emittedInitialColorReset = Boolean(opts.colorResetEmitted);
  for (const entry of entries) {
    let field = formatLsEntry(entry, opts, widths);
    if (emittedInitialColorReset) field = stripLsLeadingReset(field);
    else if (field.startsWith("\x1b[0m")) {
      emittedInitialColorReset = true;
      opts.colorResetEmitted = true;
    }
    fields.push(field);
  }
  return (opts.C || opts.x) && !wideQuotedColumns ? renderLsColumnFields(fields, opts) : fields.join(separator) + "\n";
}

export function renderLsColumnFields(fields, opts) {
  const outputWidth = opts.width ?? lsOutputWidth(opts);
  const widths = fields.map((field) => lsDisplayWidth(stripAnsi(field)));
  const columnCount = lsColumnCount(widths, outputWidth, opts);
  const rowCount = Math.ceil(fields.length / columnCount);
  const columnWidths = Array(columnCount).fill(0);
  for (let row = 0; row < rowCount; row++) {
    for (let column = 0; column < columnCount; column++) {
      const index = lsColumnFieldIndex(row, column, rowCount, columnCount, opts);
      if (index < fields.length) columnWidths[column] = Math.max(columnWidths[column], widths[index]);
    }
  }
  const starts = [];
  let start = 0;
  for (const width of columnWidths) {
    starts.push(start);
    start += width + 2;
  }
  const lines = [];
  for (let row = 0; row < rowCount; row++) {
    let line = "";
    let displayColumn = 0;
    for (let column = 0; column < columnCount; column++) {
      const index = lsColumnFieldIndex(row, column, rowCount, columnCount, opts);
      if (index >= fields.length) continue;
      if (line) {
        const padding = lsColumnPadding(displayColumn, starts[column], opts.tabSize);
        line += padding.text;
        displayColumn = padding.column;
      }
      line += fields[index];
      displayColumn += widths[index];
    }
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

export function lsColumnCount(widths, outputWidth, opts) {
  const count = widths.length;
  if (count <= 1) return count;
  const available = Math.max(1, outputWidth);
  for (let columns = count; columns > 1; columns--) {
    const rows = Math.ceil(count / columns);
    const columnWidths = Array(columns).fill(0);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const index = lsColumnFieldIndex(row, column, rows, columns, opts);
        if (index < count) columnWidths[column] = Math.max(columnWidths[column], widths[index]);
      }
    }
    const total = columnWidths.reduce((sum, width) => sum + width, 0) + ((columns - 1) * 2);
    if (total <= available) return columns;
  }
  return 1;
}

export function lsColumnFieldIndex(row, column, rowCount, columnCount, opts) {
  return opts.x ? (row * columnCount) + column : (column * rowCount) + row;
}

export function lsColumnPadding(column, target, tabSize) {
  let text = "";
  while (column < target) {
    const nextTab = tabSize > 0 ? column + tabSize - (column % tabSize) : Number.POSITIVE_INFINITY;
    if (nextTab <= target && nextTab - column > 1) {
      text += "\t";
      column = nextTab;
    } else {
      text += " ";
      column++;
    }
  }
  return { text, column };
}

export function stripLsLeadingReset(text) {
  return text.startsWith("\x1b[0m") ? text.slice(4) : text;
}

export function renderLsCommaEntries(entries, opts) {
  const fields = [];
  let emittedInitialColorReset = Boolean(opts.colorResetEmitted);
  for (const entry of entries) {
    let field = formatLsEntry(entry, opts);
    if (emittedInitialColorReset) field = stripLsLeadingReset(field);
    else if (field.startsWith("\x1b[0m")) {
      emittedInitialColorReset = true;
      opts.colorResetEmitted = true;
    }
    fields.push(field);
  }
  const width = opts.width ?? Number.POSITIVE_INFINITY;
  const lines = [];
  let line = "";
  for (let i = 0; i < fields.length; i++) {
    const text = `${fields[i]}${i === fields.length - 1 ? "" : ","}`;
    const candidate = line ? `${line} ${text}` : text;
    if (line && width > 0 && candidate.length > width) {
      lines.push(line);
      line = text;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n") + "\n";
}

export function formatLsDiredOutput(output, quotingStyle = "literal") {
  const fileMarks = [];
  const subdirMarks = [];
  let out = "";
  let offset = 0;
  for (const rawLine of output.split(/(?<=\n)/)) {
    if (rawLine === "") continue;
    const hasNewline = rawLine.endsWith("\n");
    const line = hasNewline ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      out += rawLine;
      offset += Buffer.byteLength(rawLine);
      continue;
    }
    const prefixed = `  ${line}`;
    const lineStart = offset;
    const subdir = line.match(/^(.+):$/);
    if (subdir) {
      subdirMarks.push(lineStart + 2, lineStart + 2 + Buffer.byteLength(subdir[1]));
    } else if (!/^total(?:\s|$)/.test(line)) {
      const range = lsDiredFilenameRange(line);
      if (range) fileMarks.push(lineStart + 2 + range.start, lineStart + 2 + range.end);
    }
    const rendered = `${prefixed}${hasNewline ? "\n" : ""}`;
    out += rendered;
    offset += Buffer.byteLength(rendered);
  }
  if (fileMarks.length) out += `//DIRED// ${fileMarks.join(" ")}\n`;
  if (subdirMarks.length) out += `//SUBDIRED// ${subdirMarks.join(" ")}\n`;
  out += `//DIRED-OPTIONS// --quoting-style=${quotingStyle}\n`;
  return out;
}

export function lsDiredFilenameRange(line) {
  let text = line;
  if (/^[bcdlps?-][rwx?-]{9}/.test(line) && line.slice(1, 10).includes("?")) {
    const match = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+)(.*)$/);
    if (!match) return null;
    const prefixBytes = Buffer.byteLength(match[1]);
    return { start: prefixBytes, end: prefixBytes + Buffer.byteLength(match[2]) };
  }
  if (/^[bcdlps-][rwx-]{9}/.test(line)) {
    const hasContextColumn = /^[bcdlps-][rwx-]{9}\s+\S+\s+\S+\s+\S+\s+\?\s+/.test(line);
    const prefixPattern = hasContextColumn
      ? /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+)(.*)$/
      : /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+)(.*)$/;
    const match = line.match(prefixPattern);
    if (!match) return null;
    const prefixBytes = Buffer.byteLength(match[1]);
    text = match[2];
    const symlinkIndex = text.indexOf(" -> ");
    const name = symlinkIndex === -1 ? text : text.slice(0, symlinkIndex);
    return { start: prefixBytes, end: prefixBytes + Buffer.byteLength(name) };
  }
  if (/^\s*$/.test(text)) return null;
  return { start: 0, end: Buffer.byteLength(text) };
}

export function renderLsLongEntries(rows, opts) {
  const widths = {
    inode: maxLsFieldWidth(rows, "inode", 0),
    block: maxLsFieldWidth(rows, "block", 0),
    nlink: maxLsFieldWidth(rows, "nlink", 0),
    user: maxLsFieldWidth(rows, "user", 0),
    author: maxLsFieldWidth(rows, "author", 0),
    group: maxLsFieldWidth(rows, "group", 0),
    context: maxLsFieldWidth(rows, "context", 0),
    size: maxLsFieldWidth(rows, "size", 0),
  };
  return rows.map((row, index) => {
    const fields = [row.mode, row.nlink.padStart(widths.nlink)];
    if (opts.i || opts.inode) fields.unshift(row.inode.padStart(widths.inode));
    if (opts.s || opts.size) fields.unshift(row.block.padStart(widths.block));
    if (!opts.g) fields.push(row.user.padStart(widths.user));
    if (!(opts.G || opts.o)) fields.push(row.group.padStart(widths.group));
    if (opts.author) fields.push(row.author.padStart(widths.author));
    if (opts.Z || opts.context) fields.push(row.context.padStart(widths.context));
    fields.push(row.size.padStart(widths.size), row.time, row.name);
    let line = opts.colorEnabled && lsNormalColorCode() != null ? formatLsNormalLongRow(fields, index === 0) : fields.join(" ");
    if (row.clearToEol && lsDisplayWidth(stripAnsi(line)) >= lsOutputWidth(opts)) line += "\x1b[K";
    return line;
  });
}

export function formatLsNormalLongRow(fields, resetFirst = false) {
  const normal = lsNormalColorCode();
  if (normal == null) return fields.join(" ");
  const coloredPrefix = lsNormalColoredPrefix();
  const normalPrefix = `\x1b[${normal}m`;
  const resetNormalPrefix = `\x1b[0m${normalPrefix}`;
  let name = fields.at(-1);
  if (name.startsWith(resetNormalPrefix) && name.endsWith("\x1b[0m")) name = name.slice(resetNormalPrefix.length, -4);
  else if (name.startsWith(coloredPrefix)) name = `\x1b[m${name.slice(coloredPrefix.length)}`;
  else if (name.startsWith("\x1b[0m")) name = `\x1b[m${name.slice(4)}`;
  else {
    if (name.startsWith(normalPrefix) && name.endsWith("\x1b[0m")) name = name.slice(normalPrefix.length, -4);
    else return `\x1b[${normal}m${fields.join(" ")}\x1b[0m`;
  }
  if (name.startsWith("\x1b[m") && name.endsWith("\x1b[0m")) name = name.slice(0, -4);
  return `${resetFirst ? "\x1b[0m" : ""}\x1b[${normal}m${[...fields.slice(0, -1), name].join(" ")}\x1b[0m`;
}

export function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export function lsDisplayWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += displayWidth(ch);
  return width;
}

export function lsOutputWidth(opts) {
  const value = opts.width ?? process.env.COLUMNS ?? 80;
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? width : 80;
}

export function maxLsFieldWidth(rows, key, minimum) {
  return Math.max(minimum, ...rows.map((row) => row[key]?.length ?? 0));
}

export async function lsLongEntryFields(entry, opts) {
  let name = formatLsName(entry, opts);
  if (lsNeedsShellEscapeColorPadding(entry, name, opts)) name = ` ${name}`;
  if (entry.statFailed) {
    return {
      inode: entry.direntInode == null ? "?" : String(entry.direntInode),
      block: "?",
      mode: `${entry.direntTypeChar ?? "?"}?????????`,
      nlink: "?",
      user: "?",
      author: "?",
      group: "?",
      context: "?",
      size: "?",
      time: "           ?",
      name,
    };
  }
  const uidText = String(entry.stat.uid);
  const gidText = String(entry.stat.gid);
  const numericOwner = opts.n || opts["numeric-uid-gid"];
  const userText = numericOwner ? uidText : await userNameForUid(entry.stat.uid) ?? uidText;
  const groupText = numericOwner ? gidText : await groupName(entry.stat.gid);
  if (entry.danglingDereference) {
    return {
      inode: "?",
      block: "?",
      mode: `${fileTypeChar(entry.linkStat ?? entry.stat)}?????????`,
      nlink: "?",
      user: "?",
      author: "?",
      group: "?",
      context: "?",
      size: "?",
      time: "           ?",
      name,
    };
  }
  if (entry.linkStat?.isSymbolicLink() && entry.stat === entry.linkStat) {
    const target = await readlink(entry.path);
    const quotedTarget = quoteLsName(target, opts);
    name += ` -> ${opts.colorEnabled ? colorizeLsTarget(quotedTarget) : quotedTarget}`;
  } else if (opts.colorEnabled && lsNormalColorCode() == null && name.endsWith("\x1b[0m")) {
    return {
      inode: lsEntryInodeText(entry),
      block: entry.danglingDereference ? "?" : lsBlockText(entry.stat, opts),
      mode: `${modeString(entry.stat)}${lsAclIndicator(entry)}`,
      nlink: String(entry.stat.nlink),
      user: userText,
      author: userText,
      group: groupText,
      context: lsSecurityContext(entry, opts),
      size: String(lsDisplaySize(entry.stat, opts)),
      time: lsTimeText(lsEntryTime(entry, opts), opts),
      name,
      clearToEol: true,
    };
  }
  return {
    inode: lsEntryInodeText(entry),
    block: entry.danglingDereference ? "?" : lsBlockText(entry.stat, opts),
    mode: `${modeString(entry.stat)}${lsAclIndicator(entry)}`,
    nlink: String(entry.stat.nlink),
    user: userText,
    author: userText,
    group: groupText,
    context: lsSecurityContext(entry, opts),
    size: String(lsDisplaySize(entry.stat, opts)),
    time: lsTimeText(lsEntryTime(entry, opts), opts),
    name,
  };
}

export function lsAclIndicator(entry) {
  // POSIX ACLs are represented by a trailing '+' in GNU ls's mode field.
  // Node/Bun do not expose ACLs through stat, so use getfacl when present.
  // A symlink itself cannot carry a POSIX access ACL; only query its target
  // when this ls invocation dereferenced it.
  if (process.platform !== "linux") return "";
  const noDereference = entry.linkStat?.isSymbolicLink() && entry.stat === entry.linkStat;
  if (!noDereference) {
    try {
      const result = Bun.spawnSync(["getfacl", "--omit-header", "--absolute-names", "--", String(entry.path)], { stdout: "pipe", stderr: "ignore" });
      if (result.exitCode === 0 && lsAclIndicatorFromText(new TextDecoder().decode(result.stdout)) === "+") return "+";
    } catch {
      // A missing ACL helper does not prevent checking the SELinux label below.
    }
  }
  // GNU ls uses '.' when a security context exists but no extended ACL does.
  return selinuxSecurityContext(entry.path, noDereference) == null ? "" : ".";
}

export function lsAclIndicatorFromText(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("default:") || line.startsWith("mask:") || /^user:[^:]+:/.test(line) || /^group:[^:]+:/.test(line)) return "+";
  }
  return "";
}

export function lsSecurityContext(entry, _opts) {
  const noDereference = entry.linkStat?.isSymbolicLink() && entry.stat === entry.linkStat;
  return selinuxSecurityContext(entry.path, noDereference) ?? "?";
}

export function lsNeedsShellEscapeColorPadding(entry, renderedName, opts) {
  const quoting = opts.quoting ?? opts["quoting-style"];
  if (quoting !== "shell-escape" || !opts.colorEnabled || !renderedName.startsWith("\x1b[0m")) return false;
  const quoted = quoteLsName(entry.name, opts);
  return !quoted.startsWith("'");
}

export function lsShortEntryWidths(entries, opts) {
  return {
    inode: opts.i || opts.inode ? Math.max(...entries.map((entry) => lsEntryInodeText(entry).length)) : 0,
    block: opts.s || opts.size ? Math.max(...entries.map((entry) => entry.danglingDereference || entry.statFailed ? 1 : lsBlockText(entry.stat, opts).length)) : 0,
  };
}

export function formatLsEntry(entry, opts, widths = null) {
  const name = formatLsName(entry, opts);
  const fields = [];
  if (opts.i || opts.inode) fields.push(lsEntryInodeText(entry).padStart(widths?.inode ?? 0));
  if (opts.s || opts.size) fields.push((entry.danglingDereference || entry.statFailed ? "?" : lsBlockText(entry.stat, opts)).padStart(widths?.block ?? 0));
  if (opts.Z || opts.context) fields.push(entry.statFailed ? "?" : lsSecurityContext(entry, opts));
  fields.push(name);
  return fields.join(" ");
}

export function lsEntryInodeText(entry) {
  if (entry.danglingDereference || (entry.statFailed && entry.direntInode == null)) return "?";
  // d_ino can identify the covered directory entry rather than the mounted
  // object at a mount point.  Since this implementation already gathered
  // metadata, prefer st_ino; this also selects the target inode under -L.
  if (!entry.statFailed && entry.stat?.ino != null) return String(entry.stat.ino);
  return String(entry.direntInode);
}

export function lsBlockText(statInfo, opts) {
  const allocatedBytes = Number(lsAllocatedBytes(statInfo));
  const human = opts.h || opts["human-readable"] || opts.si || opts.blockHumanReadable || opts.blockSi;
  return human ? lsHumanSize(allocatedBytes, opts.si || opts.blockSi ? 1000 : 1024) : String(lsAllocatedBlockCount(statInfo, BigInt(opts.blockSize || 1024)));
}

export function lsDisplaySize(statInfo, opts) {
  if (opts.h || opts["human-readable"] || opts.si) return lsHumanSize(statInfo.size, opts.si ? 1000 : 1024);
  return Math.ceil(statInfo.size / (opts.sizeBlockSize || 1));
}

export function lsAllocatedBytes(statInfo) {
  return BigInt(statInfo.blocks ?? Math.ceil(statInfo.size / 512)) * 512n;
}

export function lsAllocatedBlockCount(statInfo, blockSize) {
  const bytes = lsAllocatedBytes(statInfo);
  return (bytes + blockSize - 1n) / blockSize;
}

export function lsHumanSize(bytes, base = 1024) {
  if (bytes < base) return String(bytes);
  const units = base === 1000 ? ["B", "k", "M", "G", "T"] : ["B", "K", "M", "G", "T"];
  return humanSizeWithUnits(bytes, base, units);
}

export function lsEntryTime(entry, opts) {
  const mode = lsEntryTimeMode(opts);
  return lsStatTime(entry.stat, mode);
}

export function lsEntryTimeMode(opts) {
  const mode = opts.time ?? (opts.u ? "access" : opts.c ? "ctime" : "mtime");
  if (["access", "atime", "use"].includes(mode)) return "atime";
  if (["ctime", "status"].includes(mode)) return "ctime";
  if (["birth", "creation"].includes(mode)) return "birthtime";
  return "mtime";
}

export function lsStatTime(statInfo, mode) {
  const date = statInfo[mode];
  const value = statInfo[`${mode}Ns`];
  if (value == null) return date;
  const fraction = Number(((BigInt(value) % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n);
  return attachDateNanoseconds(new Date(date.getTime()), fraction);
}

export function formatLsName(entry, opts) {
  const name = quoteLsName(entry.name, opts);
  const suffix = classifySuffix(entry.stat, opts);
  const linkedName = opts.hyperlinkEnabled ? formatLsHyperlink(name, lsHyperlinkPath(entry), opts) : name;
  return `${opts.colorEnabled ? colorizeLs(linkedName, entry) : linkedName}${suffix}`;
}

export function lsHyperlinkPath(entry) {
  if (entry.linkStat?.isSymbolicLink() && entry.targetDirectory && !isBytePath(entry.path)) return entry.path.replace(/\/+$/, "");
  return entry.path;
}

export function formatLsHyperlink(name, path, opts) {
  if (!opts.hyperlinkEnabled || opts.zero) return name;
  return `\x1b]8;;${fileUriForLs(path)}\x1b\\${name}\x1b]8;;\x1b\\`;
}

export function fileUriForLs(path) {
  const host = osHostname();
  if (isBytePath(path)) return `file://${host}${encodeLsFileUriBytes(absoluteLsPathBytes(path))}`;
  return `file://${host}${encodeLsFileUriPath(resolve(pathDisplayName(path)))}`;
}

export async function lsDirectoryLabelPath(path) {
  const s = await lstat(path).catch(() => null);
  if (!s?.isSymbolicLink()) return path;
  const target = await readlink(path).catch(() => null);
  if (target == null) return path;
  return isAbsolute(target) ? target : resolve(pathDirname(pathDisplayName(path)), target);
}

export function absoluteLsPathBytes(path) {
  if (path[0] === 0x2f) return Buffer.from(path);
  return bufferPathJoin(Buffer.from(resolve(".")), path);
}

export function encodeLsFileUriBytes(path) {
  return [...Buffer.from(path)].map((byte) => {
    const ch = String.fromCharCode(byte);
    return /[A-Za-z0-9/._~-]/.test(ch) ? ch : `%${byte.toString(16).padStart(2, "0")}`;
  }).join("");
}

export function encodeLsFileUriPath(path) {
  return String(path).replace(/[^A-Za-z0-9/._~-]/g, (ch) => {
    const bytes = new TextEncoder().encode(ch);
    return [...bytes].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  });
}

export function quoteLsName(name, opts) {
  const displayName = pathDisplayName(name);
  if (opts.zero) return displayName;
  const style = lsResolvedQuotingStyle(opts);
  const text = opts.q && !["c", "escape", "shell-escape", "clocale", "locale"].includes(style) ? lsQuestionName(displayName) : displayName;
  if (style === "literal") return text;
  if (style === "shell") return shellQuoteLsName(displayName, false, text);
  if (style === "question") return lsQuestionName(displayName);
  if (style === "escape") return lsEscapedName(displayName, { escapeSpaces: true });
  if (style === "c") return `"${lsEscapedName(displayName)}"`;
  if (style === "clocale") return lsUsesUtf8Locale() ? `‘${lsEscapedName(displayName, { escapeDouble: false })}’` : `"${lsEscapedName(displayName)}"`;
  if (style === "locale") return lsUsesUtf8Locale() ? `‘${lsEscapedName(displayName, { escapeDouble: false })}’` : `'${lsEscapedName(displayName)}'`;
  if (style === "shell-always" || style === "shell-al") return shellQuoteLsName(displayName, true, text);
  if (style === "shell-escape") return shellEscapeLsName(displayName);
  if (style === "shell-escape-always" || style === "shell-escape-al") return shellEscapeLsName(displayName, true);
  return text;
}

export function quoteLsDirectoryLabelName(name, opts) {
  const quoted = quoteLsName(name, opts);
  const style = lsResolvedQuotingStyle(opts);
  const displayName = pathDisplayName(name);
  if ((style === "shell" || style === "shell-escape") && displayName.includes(":") && quoted === displayName) return shellQuoteLsName(displayName, true);
  return quoted;
}

export function lsResolvedQuotingStyle(opts) {
  if (opts.N) return "literal";
  if (opts.Q || opts["quote-name"]) return "c";
  const style = opts.quoting ?? opts["quoting-style"];
  return resolveLsQuotingStyle(style) ?? (opts.q ? "question" : process.stdout.isTTY ? "shell-escape" : "literal");
}

export function lsQuestionName(name) {
  return [...String(name)].map((ch) => {
    const code = ch.codePointAt(0);
    return code < 32 || code === 127 ? "?" : ch;
  }).join("");
}

export function classifySuffix(s, opts) {
  if (opts.indicatorStyle === "none") return "";
  if (s.isDirectory()) return "/";
  if (opts.indicatorStyle === "slash") return "";
  if (s.isSymbolicLink()) return "@";
  if (s.isFIFO()) return "|";
  if (s.isSocket()) return "=";
  if (opts.indicatorStyle === "file-type") return "";
  if (s.mode & 0o111) return "*";
  return "";
}

export function colorizeLs(name, entry) {
  const code = lsColorCodeForEntry(entry);
  if (code != null) return lsColorWrap(name, code);
  const custom = lsColorForName(entry.name);
  if (custom != null) return lsColorWrap(name, custom);
  const fileCode = lsColorCode("fi");
  if (fileCode != null) return lsColorWrap(name, fileCode);
  const normal = lsNormalColorCode();
  return normal == null ? name : `\x1b[0m\x1b[${normal}m${name}\x1b[0m`;
}

export function colorizeLsTarget(name) {
  const code = lsColorCode("mi");
  return code == null ? name : lsColorWrap(name, code, false);
}

export function lsColorWrap(name, code, resetFirst = true) {
  return `${resetFirst ? lsColorResetPrefix() : ""}\x1b[${code}m${name}${lsColorResetSuffix()}`;
}

export function lsColorResetPrefix() {
  const normal = lsNormalColorCode();
  return normal == null ? lsColorResetSuffix() : lsNormalColoredPrefix();
}

export function lsNormalColoredPrefix() {
  const normal = lsNormalColorCode();
  return normal == null ? lsColorResetSuffix() : `${lsColorResetSuffix()}\x1b[${normal}m\x1b[m`;
}

export function lsNormalColorCode() {
  return lsColorCode("no");
}

export function lsColorResetSuffix() {
  const reset = lsColorCode("rs");
  return `\x1b[${reset ?? "0"}m`;
}

export function lsColorCodeForEntry(entry) {
  const s = entry.stat;
  if (entry.linkStat?.isSymbolicLink() && s === entry.linkStat) {
    const linkCode = lsColorCode("ln");
    if (entry.targetMissing) {
      const orphanCode = lsColorCode("or");
      if (orphanCode != null && orphanCode !== "") return orphanCode;
      if (orphanCode === "") return linkCode && linkCode !== "target" ? linkCode : "";
      return linkCode === "target" ? null : linkCode ?? "40;31;01";
    }
    if (linkCode === "target") {
      if (entry.targetDirectory) return lsColorCode("di") ?? "01;34";
      return null;
    }
    return linkCode ?? "01;36";
  }
  if (s.isDirectory()) {
    if ((s.mode & 0o1000) && (s.mode & 0o002)) return lsSpecialDirectoryColor("tw", "30;42");
    if (s.mode & 0o1000) return lsSpecialDirectoryColor("st", "37;44");
    if (s.mode & 0o002) return lsSpecialDirectoryColor("ow", "34;42");
    return lsColorCode("di") || "01;34";
  }
  if (entry.hasCapability) return lsColorCode("ca");
  if (s.mode & 0o4000) return lsColorCode("su") ?? null;
  if (s.mode & 0o2000) return lsColorCode("sg") ?? null;
  if (s.mode & 0o111) return lsColorCode("ex") ?? "01;32";
  if (s.nlink > 1) {
    const hardLinkCode = lsColorCode("mh");
    if (hardLinkCode != null && hardLinkCode !== "" && hardLinkCode !== "00") return hardLinkCode;
  }
  return null;
}

export function lsSpecialDirectoryColor(key, defaultCode) {
  const code = lsColorCode(key);
  if (code == null) return defaultCode;
  if (code === "") return lsColorCode("di") || "01;34";
  return code;
}

export function lsColorCode(key) {
  for (const part of lsColorParts()) {
    if (part.key === key) return part.value;
  }
  return null;
}

export function lsColorForName(name) {
  const wildcardRules = [];
  for (const { key, value } of lsColorParts()) {
    if (!key) continue;
    if (key.startsWith("*")) wildcardRules.push({ key, suffix: key.slice(1), value, extension: key.startsWith("*.") });
  }
  const text = String(name);
  let matched = null;
  for (let i = 0; i < wildcardRules.length; i++) {
    const rule = wildcardRules[i];
    const suffix = rule.suffix;
    if (text.endsWith(suffix)) matched = rule;
    else if (rule.extension && text.toLowerCase().endsWith(suffix.toLowerCase()) && lsExtensionRuleIsCaseInsensitive(wildcardRules, i)) matched = rule;
  }
  if (matched) return matched.value;
  return null;
}

export function lsColorParts() {
  const colors = process.env.LS_COLORS ?? "";
  const parts = [];
  let current = "";
  let escaped = false;
  for (const ch of colors) {
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === ":") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (escaped) current += "\\";
  parts.push(current);
  return parts.flatMap((part) => {
    const index = part.indexOf("=");
    return index < 0 ? [] : [{ key: part.slice(0, index), value: part.slice(index + 1) }];
  });
}

export function lsExtensionRuleIsCaseInsensitive(rules, index) {
  const rule = rules[index];
  const effective = new Map();
  for (const other of rules) {
    if (other.suffix.toLowerCase() === rule.suffix.toLowerCase()) effective.set(other.suffix, other.value);
  }
  const values = [...effective.values()];
  return values.length === 1 || values.every((value) => value === rule.value);
}

export function applyLsBlockSizeSpecialMode(opts) {
  applyBlockSizeSpecialMode(opts, lsSizeBlockSizeValue(opts));
  const mode = blockSizeSpecialMode(lsBlockSizeValue(opts));
  if (mode === "human") opts.blockHumanReadable = true;
  if (mode === "si") opts.blockSi = true;
}
