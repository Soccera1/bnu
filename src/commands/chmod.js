#!/usr/bin/env bun

import { lstat, stat } from "node:fs/promises";
import { changeDirectory, invalidOptionMessage, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, pathDisplayName, pathLikeJoin, readdirPathEntries } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { chmodQuotedName, errnoMessage, invalidClusterOptionMessage, isAccessError, isRecursiveRootTarget, openDirectoryPathEntries, parseModeSpec, preserveRootError, preserveRootMessage, processCwdOrNull, referenceStat, setFileMode } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const CHMOD_LONG_OPTIONS = ["changes", "recursive", "silent", "quiet", "dereference", "no-dereference", "reference", "preserve-root", "no-preserve-root", "verbose", "help", "version"];

export function chmodMetaOption(args) {
  const longFlagOptions = new Set(["changes", "recursive", "silent", "quiet", "dereference", "no-dereference", "preserve-root", "no-preserve-root", "verbose"]);
  const shortFlagOptions = new Set(["R", "c", "f", "h", "H", "L", "P", "v"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeLongOptionByPrefix(arg, CHMOD_LONG_OPTIONS);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      return normalized;
    }
    if (longFlagOptions.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      continue;
    }
    if (name === "reference") {
      if (inlineValue === undefined) i++;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-" && !isChmodModeToken(arg)) {
      if ([...arg.slice(1)].every((ch) => shortFlagOptions.has(ch))) continue;
      throw new UsageError(invalidClusterOptionMessage(arg, shortFlagOptions), true);
    }
    continue;
  }
  return null;
}

export async function chmodCmd(args) {
  args = normalizeChmodArgs(args);
  const { recursive, changes, verbose, silent, dereference, traversal, preserveRoot, modeSpec, reference, files } = parseChmodArgs(args);
  if (!modeSpec) throw new UsageError("missing operand", true);
  if (reference != null && !files.length) throw new UsageError("missing operand", true);
  if (!files.length) throw new UsageError(`missing operand after '${modeSpec}'`, true);
  if (reference == null && !isChmodModeToken(modeSpec)) throw new UsageError(`invalid mode: ${localeQuotedEscapedDiagnostic(modeSpec)}`, true);
  const referenceMode = reference == null ? null : (await referenceStat(reference)).mode & 0o7777;
  let failed = false;
  for (const file of files) {
    const ok = await chmodPath(file, modeSpec, { recursive, changes, verbose, silent, dereference, traversal, preserveRoot, referenceMode }, true, file);
    if (!ok) failed = true;
  }
  return failed ? 1 : 0;
}

export async function chmodPath(path, modeSpec, options, isRoot = false, display = path, relativeToChangedCwd = false) {
  let ok = true;
  let s;
  try {
    const linkInfo = await lstat(path);
    const isLink = linkInfo.isSymbolicLink();
    const shouldDereference = isLink && (options.recursive
      ? options.traversal === "L" || (isRoot && options.traversal === "H")
      : options.dereference);
    if (isLink && !shouldDereference) return true;
    try {
      s = shouldDereference || !isLink ? await stat(path) : linkInfo;
    } catch (error) {
      error.danglingSymlink = isLink && error?.code === "ENOENT";
      throw error;
    }
    if (options.recursive && options.preserveRoot && s.isDirectory() && await isRecursiveRootTarget(path)) throw preserveRootError("chmod", path);
    const before = s.mode & 0o7777;
    const { mode: after, ok: modeOk } = options.referenceMode == null ? parseModeSpec(modeSpec, before, s.isDirectory()) : { mode: options.referenceMode, ok: true };
    await setFileMode(path, after);
    if ((options.changes || options.verbose) && before !== after) stdout(`mode of ${chmodQuotedName(display)} changed from ${octalMode(before)} (${modeBitsString(before)}) to ${octalMode(after)} (${modeBitsString(after)})\n`);
    else if (options.verbose) stdout(`mode of ${chmodQuotedName(display)} retained as ${octalMode(after)} (${modeBitsString(after)})\n`);
    if (!modeOk) {
      if (!options.silent) stderr(`chmod: ${chmodQuotedName(display)}: new permissions are ${modeBitsString(after)}, not ${modeBitsString(parseModeSpec(modeSpec, before, s.isDirectory(), { ignoreUmask: true }).mode)}\n`);
      ok = false;
    }
  } catch (error) {
    if (!options.silent) stderr(chmodErrorLine(display, error));
    return false;
  }
  if (options.recursive && s.isDirectory()) {
    try {
      if (isRoot) {
        const entries = await openDirectoryPathEntries(path);
        for await (const entry of entries) {
          const childDisplay = `${String(display).replace(/\/+$/, "")}/${pathDisplayName(entry)}`;
          if (!(await chmodPath(pathLikeJoin(path, entry), modeSpec, options, false, childDisplay, relativeToChangedCwd))) ok = false;
        }
        return ok;
      }
      const entries = await readdirPathEntries(path);
      const restoreCwd = relativeToChangedCwd ? null : processCwdOrNull();
      if (chmodCanRelativeTraverse(path)) {
        changeDirectory(path);
        try {
          for (const entry of entries) {
            const childDisplay = `${String(display).replace(/\/+$/, "")}/${pathDisplayName(entry)}`;
            if (!(await chmodPath(entry, modeSpec, options, false, childDisplay, true))) ok = false;
          }
        } finally {
          changeDirectory(restoreCwd ?? "..");
        }
      } else {
        for (const entry of entries) {
          const childDisplay = `${String(display).replace(/\/+$/, "")}/${pathDisplayName(entry)}`;
          if (!(await chmodPath(pathLikeJoin(path, entry), modeSpec, options, false, childDisplay))) ok = false;
        }
      }
    } catch (error) {
      if (!options.silent) stderr(chmodErrorLine(display, error));
      ok = false;
    }
  }
  return ok;
}

export function chmodCanRelativeTraverse(path) {
  const text = pathDisplayName(path);
  return !text.includes("\uFFFD") && text !== "" && text !== "." && text !== "..";
}

export function normalizeChmodArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      out.push(...args.slice(i));
      break;
    }
    if (arg.startsWith("--")) {
      const normalized = normalizeLongOptionByPrefix(arg, CHMOD_LONG_OPTIONS);
      if (normalized === "--reference" && i + 1 < args.length) {
        out.push(`${normalized}=${args[++i]}`);
      } else {
        out.push(normalized);
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

export function parseChmodArgs(args) {
  let recursive = false;
  let changes = false;
  let verbose = false;
  let silent = false;
  let dereference = true;
  let traversal = "H";
  let preserveRoot = false;
  let reference = null;
  let explicitOperandStart = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!explicitOperandStart && rest.length === 0 && arg === "--") {
      explicitOperandStart = true;
      rest.push(...args.slice(i + 1));
      break;
    }
    if (!explicitOperandStart && (arg === "--reference" || arg.startsWith("--reference="))) {
      if (arg === "--reference") {
        if (i + 1 >= args.length) throw new UsageError("option '--reference' requires an argument", true);
        reference = args[++i];
      } else {
        reference = arg.slice("--reference=".length);
      }
      continue;
    }
    if (!explicitOperandStart && isChmodOption(arg)) {
      for (const option of expandChmodOption(arg)) {
        if (option === "R" || option === "recursive") recursive = true;
        else if (option === "c" || option === "changes") changes = true;
        else if (option === "v" || option === "verbose") verbose = true;
        else if (option === "f" || option === "silent" || option === "quiet") silent = true;
        else if (option === "H" || option === "L" || option === "P") traversal = option;
        else if (option === "h" || option === "no-dereference") dereference = false;
        else if (option === "dereference" || option === "deref") dereference = true;
        else if (option === "preserve-root") preserveRoot = true;
        else if (option === "no-preserve-root") preserveRoot = false;
      }
      continue;
    }
    if (!explicitOperandStart && rest.length === 0 && arg.startsWith("-") && !isChmodModeToken(arg)) {
      throw new UsageError(invalidOptionMessage(arg), true);
    }
    rest.push(arg);
  }
  if (explicitOperandStart) {
    const [modeSpec, ...files] = rest;
    return { recursive, changes, verbose, silent, dereference, traversal, preserveRoot, modeSpec: reference == null ? modeSpec : "--reference", reference, files: reference == null ? files : rest };
  }

  const modeParts = [];
  const files = [];
  let afterFile = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--" && modeParts.length) {
      files.push(...rest.slice(i + 1));
      break;
    }
    if (arg === "--" && afterFile) {
      files.push(arg);
      continue;
    }
    if (!afterFile && isChmodModeToken(arg)) modeParts.push(arg);
    else if (isChmodModeToken(arg)) modeParts.push(arg);
    else {
      files.push(arg);
      afterFile = true;
    }
  }
  if (reference != null) return { recursive, changes, verbose, silent, dereference, traversal, preserveRoot, modeSpec: "--reference", reference, files: rest };
  if (!modeParts.length && rest.length) return { recursive, changes, verbose, silent, dereference, traversal, preserveRoot, modeSpec: rest[0], files: rest.slice(1) };
  return { recursive, changes, verbose, silent, dereference, traversal, preserveRoot, modeSpec: modeParts.join(","), files };
}

export function isChmodOption(arg) {
  if (["--recursive", "--changes", "--silent", "--quiet", "--dereference", "--no-dereference", "--preserve-root", "--no-preserve-root", "--verbose"].includes(arg)) return true;
  return /^-[RcfvHLP]+$/.test(arg) || arg === "-h";
}

export function expandChmodOption(arg) {
  if (arg.startsWith("--")) return [arg.slice(2)];
  return arg.slice(1).split("");
}

export function isChmodModeToken(arg) {
  if (arg === "--") return true;
  return arg.split(",").every((part) => /^[0-7]+$/.test(part) || /^[+=-][0-7]+$/.test(part) || /^[ugoa]*[+=-][rwxXstugo]*$/.test(part));
}

export function octalMode(mode) {
  return mode.toString(8).padStart(4, "0");
}

export function modeBitsString(mode) {
  let out = "";
  const chars = ["r", "w", "x"];
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let bit = 2; bit >= 0; bit--) out += mode & (1 << (shift + bit)) ? chars[2 - bit] : "-";
  }
  return out;
}

export function chmodErrorLine(path, error) {
  if (error?.preserveRoot) return preserveRootMessage("chmod", error.path, error.rootPath);
  if (error?.danglingSymlink) return `chmod: cannot operate on dangling symlink ${chmodQuotedName(path)}\n`;
  if (isAccessError(error)) return `chmod: cannot access ${chmodQuotedName(path)}: ${errnoMessage(error)}\n`;
  return `chmod: changing permissions of ${chmodQuotedName(path)}: ${errnoMessage(error)}\n`;
}

const singleCall = defineCommand("chmod", chmodCmd, chmodMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
