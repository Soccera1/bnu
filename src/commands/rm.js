#!/usr/bin/env bun

import { FFIType, linkSymbols, ptr, read, toArrayBuffer } from "bun:ffi";
import { unlinkSync, writeFileSync } from "node:fs";
import { unlink as fsUnlink, lstat, rmdir } from "node:fs/promises";
import { isAbsolute, basename as pathBasename, dirname as pathDirname } from "node:path";
import { changeDirectory, cstrPath, invalidOptionMessage, libc, libcErrno, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, parseOptions, pathDisplayName, pathLikeJoin, rawCommandArgs, shellEscapeLsName } from "../shared/common.js";
import { InvocationError, UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { confirmRemoval, errnoMessage, isRecursiveRootTarget, isWriteProtected, lstatSyncNoThrow, preserveRootMessage, processCwdOrNull, rawArgLooksLikeOption, rmLibcError } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const RM_LONG_OPTIONS = ["force", "interactive", "recursive", "dir", "verbose", "preserve-root", "no-preserve-root", "-presume-input-tty", "one-file-system", "help", "version"];

export function rmMetaOption(args) {
  const longFlagOptions = new Set(["force", "recursive", "dir", "verbose", "no-preserve-root", "-presume-input-tty", "one-file-system"]);
  for (const arg of args) {
    if (arg === "--") return null;
    rejectAbbreviatedRmNoPreserveRoot(arg);
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeLongOptionByPrefix(arg, RM_LONG_OPTIONS);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      return normalized;
    }
    if (longFlagOptions.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      continue;
    }
    if (name === "interactive") {
      if (inlineValue !== undefined) validateRmInteractiveValue(inlineValue);
      continue;
    }
    if (name === "preserve-root") {
      if (inlineValue !== undefined) validateRmPreserveRootValue(inlineValue);
      continue;
    }
    if (/^-[firdvIR]+$/.test(arg)) continue;
    if (arg.startsWith("-")) throw rmInvalidOptionUsageError(arg, args);
    continue;
  }
  return null;
}

export let rmDirectoryApi;

export function rmInterposedDirectoryApi() {
  if (!process.env.LD_PRELOAD) {
    return {
      opendir: libc.symbols.opendir,
      readdir: libc.symbols.readdir,
      closedir: libc.symbols.closedir,
    };
  }
  if (rmDirectoryApi) return rmDirectoryApi;
  const definitions = {
    opendir: { args: [FFIType.cstring], returns: FFIType.ptr },
    readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
    closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  };
  const symbols = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const address = libc.symbols.dlsym(0, ptr(Buffer.from(`${name}\0`)));
    symbols[name] = { ptr: address, ...definition };
  }
  rmDirectoryApi = linkSymbols(symbols).symbols;
  return rmDirectoryApi;
}

export function rmReadDirectoryEntries(path) {
  return [...rmIterateDirectoryEntries(path)];
}

export function rmIterateDirectoryEntries(path) {
  const api = rmInterposedDirectoryApi();
  const directory = api.opendir(cstrPath(path));
  if (!directory) throw rmLibcError(libcErrno());
  return (function* () {
    let yielded = 0;
    try {
      while (true) {
        const errnoPointer = libc.symbols.__errno_location();
        if (errnoPointer) libc.symbols.memset(errnoPointer, 0, 4);
        const address = api.readdir(directory);
        if (!address) {
          const errno = libcErrno();
          if (errno) {
            const error = rmLibcError(errno);
            error.rmPartialTraversal = yielded > 0;
            throw error;
          }
          break;
        }
        // Linux struct dirent places d_name immediately after d_type at byte
        // 19.  Copy it before the next call reuses libc's dirent storage.
        const recordLength = read.u16(address, 16);
        const maximumNameLength = Math.max(0, recordLength - 19);
        let nameLength = 0;
        while (nameLength < maximumNameLength && read.u8(address + 19, nameLength) !== 0) nameLength++;
        const name = Buffer.from(new Uint8Array(toArrayBuffer(address + 19, 0, nameLength)));
        if (name.equals(Buffer.from(".")) || name.equals(Buffer.from(".."))) continue;
        yielded++;
        yield name;
      }
    } finally {
      api.closedir(directory);
    }
  })();
}

export function rmPrimeDirectoryEntries(entries) {
  const first = entries.next();
  return (function* () {
    if (!first.done) yield first.value;
    yield* entries;
  })();
}

export async function rmCmd(args) {
  for (const arg of args) {
    if (arg === "--") break;
    rejectAbbreviatedRmNoPreserveRoot(arg);
  }
  args = normalizeRmArgs(args);
  let parsed;
  try {
    parsed = parseOptions(args, { short: { f: false, i: false, I: false, r: false, R: false, d: false, v: false }, long: { force: false, interactive: "optional-value", recursive: false, dir: false, verbose: false, "preserve-root": "optional-value", "no-preserve-root": false, "-presume-input-tty": false, "one-file-system": false, help: false, version: false } });
  } catch (error) {
    const hint = rmDashFileHint(args);
    if (hint && error instanceof UsageError && error.showHelp) throw new UsageError(`${error.message}\n${hint}`, true);
    throw error;
  }
  const { opts, operands } = parsed;
  validateRmInteractive(opts);
  validateRmPreserveRoot(opts);
  if (!operands.length) {
    if (opts.f || opts.force) return 0;
    throw new UsageError("missing operand", true);
  }
  const preserveRoot = !opts["no-preserve-root"];
  const options = {
    force: opts.f || opts.force,
    recursive: opts.r || opts.R || opts.recursive,
    dir: opts.d || opts.dir,
    verbose: opts.v || opts.verbose,
    preserveRoot,
    preserveRootAll: preserveRoot && opts["preserve-root"] === "all",
    oneFileSystem: opts["one-file-system"],
    interactive: rmInteractiveMode(args, opts),
    presumeInputTty: opts["-presume-input-tty"],
  };
  if (options.interactive === "once" && (operands.length > 3 || options.recursive)) {
    const suffix = options.recursive ? " recursively" : "";
    if (!confirmRemoval(`rm: remove ${operands.length} argument${operands.length === 1 ? "" : "s"}${suffix}? `)) return 0;
  }
  const rawOperands = rawRmOperands(operands);
  let failed = false;
  for (let i = 0; i < operands.length; i++) {
    const target = rawOperands?.[i] ?? operands[i];
    if (options.recursive && options.preserveRoot && await isRecursiveRootTarget(target)) {
      stderr(preserveRootMessage("rm", operands[i]));
      failed = true;
      continue;
    }
    if (options.recursive && !options.preserveRoot && process.env.BNU_RM_TEST_INTERCEPT_FILE && await isRecursiveRootTarget(target)) {
      rmTestInterceptRemoval();
    }
    const targetOptions = { ...options };
    if (options.recursive && (options.oneFileSystem || options.preserveRootAll)) {
      targetOptions.rootDev = await rmRootDevice(target);
      if (targetOptions.preserveRootAll && targetOptions.rootDev != null && await rmIsDifferentDeviceFromParent(target, targetOptions.rootDev)) {
        stderr(rmDifferentDeviceMessage(rmDisplayPath(operands[i])));
        stderr("rm: and --preserve-root=all is in effect\n");
        failed = true;
        continue;
      }
    }
    if (!await removePath(target, targetOptions, rmDisplayPath(operands[i]), true)) failed = true;
  }
  return failed ? 1 : 0;
}

export function rejectAbbreviatedRmNoPreserveRoot(arg) {
  if (!arg.startsWith("--") || arg.includes("=")) return;
  const name = arg.slice(2);
  if (name !== "no-preserve-root" && "no-preserve-root".startsWith(name)) {
    throw new InvocationError("you may not abbreviate the --no-preserve-root option", 1, false);
  }
}

export function normalizeRmArgs(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--") {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(arg.startsWith("--") ? normalizeLongOptionByPrefix(arg, RM_LONG_OPTIONS) : arg);
  }
  return out;
}

export function rawRmOperands(operands) {
  if (!operands.some((operand) => operand.includes("\uFFFD"))) return null;
  const raw = rawCommandArgs("rm");
  if (!raw) return null;
  const parsed = [];
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg.equals(Buffer.from("--"))) {
      parsed.push(...raw.slice(i + 1));
      break;
    }
    if (!rawArgLooksLikeOption(arg)) {
      parsed.push(arg);
      continue;
    }
    const text = arg.toString();
    if (text === "--interactive" || text === "-I") continue;
    if (text === "--") continue;
    if (text.startsWith("--interactive=")) continue;
  }
  return parsed.length === operands.length ? parsed : null;
}

export function validateRmInteractive(opts) {
  const mode = opts.interactive === true ? "always" : opts.interactive;
  if (mode == null) return;
  validateRmInteractiveValue(mode);
}

export function validateRmInteractiveValue(mode) {
  if (!["always", "yes", "once", "no", "never", "none"].includes(mode)) {
    const kind = mode === "" ? "ambiguous" : "invalid";
    throw new UsageError(`${kind} argument ${localeQuotedEscapedDiagnostic(mode)} for ${localeQuotedDiagnostic("--interactive")}\nValid arguments are:\n  - ${["never", "no", "none"].map(localeQuotedDiagnostic).join(", ")}\n  - ${localeQuotedDiagnostic("once")}\n  - ${["always", "yes"].map(localeQuotedDiagnostic).join(", ")}`, true);
  }
}

export function validateRmPreserveRoot(opts) {
  const value = opts["preserve-root"];
  if (value == null || value === true) return;
  validateRmPreserveRootValue(value);
}

export function validateRmPreserveRootValue(value) {
  if (value !== "all") throw new UsageError(`unrecognized --preserve-root argument: '${value}'`);
}

export function rmInteractiveMode(args, opts) {
  let mode = "never";
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "-f" || arg === "--force") mode = "never";
    else if (arg === "-i") mode = "always";
    else if (arg === "-I") mode = "once";
    else if (arg === "--interactive") mode = "always";
    else if (arg.startsWith("--interactive=")) mode = arg.slice("--interactive=".length);
    else if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === "f") mode = "never";
        else if (ch === "i") mode = "always";
        else if (ch === "I") mode = "once";
      }
    }
  }
  if ((opts.f || opts.force) && mode === "never") return "never";
  return mode;
}

export async function removePath(path, options, display = path, isRoot = false) {
  if (options.recursive && isDotOrDotDotPath(path)) {
    stderr(`rm: refusing to remove '.' or '..' directory: skipping ${rmQuotedName(path)}\n`);
    return false;
  }
  let s;
  try {
    s = await lstat(path);
  } catch (error) {
    if (options.force && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return true;
    stderr(rmErrorLine(display, error));
    return false;
  }
  if (s.isDirectory()) {
    if (!options.recursive && !options.dir) {
      stderr(`rm: cannot remove ${rmQuotedName(display)}: Is a directory\n`);
      return false;
    }
    if (options.recursive && options.oneFileSystem && !isRoot && options.rootDev != null && s.dev !== options.rootDev) {
      stderr(rmDifferentDeviceMessage(display));
      return false;
    }
    if (options.recursive) {
      if (isRoot && options.interactive === "always" && !confirmRemoval(`rm: descend into directory ${rmQuotedName(display)}? `)) return true;
      let entries;
      try {
        entries = options.interactive === "always"
          ? rmReadDirectoryEntries(path)
          : rmPrimeDirectoryEntries(rmIterateDirectoryEntries(path));
      } catch (error) {
        if (options.force && (error?.code === "EACCES" || error?.code === "EPERM")) {
          try {
            await rmdir(path);
            if (options.verbose) stdout(`removed directory ${rmQuotedName(display)}\n`);
            return true;
          } catch {}
        }
        if (error.rmPartialTraversal) stderr(`rm: traversal failed: ${pathDisplayName(display)}: ${errnoMessage(error)}\n`);
        else stderr(rmErrorLine(path, error));
        return false;
      }
      if (!isRoot && entries.length > 0 && options.interactive === "always" && !confirmRemoval(`rm: descend into directory ${rmQuotedName(display)}? `)) return true;
      let ok = true;
      try {
        const chdirName = rmRelativeTraversalName(path, isRoot);
        if (chdirName != null) {
          const restoreCwd = isRoot ? processCwdOrNull() : null;
          try {
            changeDirectory(chdirName);
          } catch (error) {
            stderr(rmErrorLine(display, error));
            return false;
          }
          try {
            for (const entry of entries) {
              const childDisplay = `${display.replace(/\/+$/, "")}/${pathDisplayName(entry)}`;
              if (rmFastUnlinkEntry(entry, options)) continue;
              if (!await removePath(entry, options, childDisplay, false)) ok = false;
            }
          } finally {
            changeDirectory(restoreCwd ?? "..");
          }
        } else {
          for (const entry of entries) {
            const child = pathLikeJoin(path, entry);
            const childDisplay = `${display.replace(/\/+$/, "")}/${pathDisplayName(entry)}`;
            if (rmFastUnlinkEntry(child, options)) continue;
            if (!await removePath(child, options, childDisplay, false)) ok = false;
          }
        }
      } catch (error) {
        if (error.rmPartialTraversal) stderr(`rm: traversal failed: ${pathDisplayName(display)}: ${errnoMessage(error)}\n`);
        else stderr(rmErrorLine(path, error));
        return false;
      }
      if (!ok) return false;
    }
    if (shouldPromptForRemoval(options, s) && !confirmRemoval(`rm: ${rmDirectoryPromptAction(s)} ${rmQuotedName(display)}? `)) return true;
    try {
      rmTestInterceptRemoval();
      await rmdir(path);
      if (options.verbose) stdout(`removed directory ${rmQuotedName(display)}\n`);
      return true;
    } catch (error) {
      stderr(rmErrorLine(display, error, error?.code !== "ENOTEMPTY"));
      return false;
    }
  }
  if (shouldPromptForRemoval(options, s) && !confirmRemoval(`rm: remove ${rmPromptDescription(s)} ${rmQuotedName(display)}? `)) return true;
  try {
    rmTestInterceptRemoval();
    await fsUnlink(path);
    if (options.verbose) stdout(`removed ${rmQuotedName(display)}\n`);
    return true;
  } catch (error) {
    stderr(rmErrorLine(display, error));
    return false;
  }
}

export function rmFastUnlinkEntry(path, options) {
  rmTestInterceptRemoval();
  if (process.env.LD_PRELOAD || options.verbose || options.interactive === "always" || options.presumeInputTty) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    // Directories, mount points, immutable files, and permission failures
    // require the full metadata-aware recursive/diagnostic path below.
    return false;
  }
}

export function rmTestInterceptRemoval() {
  const evidence = process.env.BNU_RM_TEST_INTERCEPT_FILE;
  if (!evidence) return;
  writeFileSync(evidence, "removal attempted\n");
  process.exit(0);
}

export async function rmRootDevice(path) {
  try {
    return (await lstat(path)).dev;
  } catch {
    return null;
  }
}

export async function rmIsDifferentDeviceFromParent(path, rootDev) {
  const parent = pathDirname(String(path).replace(/\/+$/, "") || ".");
  try {
    return (await lstat(parent)).dev !== rootDev;
  } catch {
    return false;
  }
}

export function rmDifferentDeviceMessage(path) {
  return `rm: skipping ${rmQuotedName(path)}, since it's on a different device\n`;
}

export function rmFileTypeDescription(s) {
  if (s.isSymbolicLink()) return "symbolic link";
  if (s.isFIFO()) return "fifo";
  if (s.isDirectory()) return "directory";
  return s.size === 0 ? "regular empty file" : "regular file";
}

export function rmPromptDescription(s) {
  const type = rmFileTypeDescription(s);
  return s.isSymbolicLink() || (s.mode & 0o200) ? type : `write-protected ${type}`;
}

export function shouldPromptForRemoval(options, s) {
  if (options.interactive === "always") return true;
  if (options.presumeInputTty && isWriteProtected(s)) return true;
  return options.interactive === "once" && isWriteProtected(s);
}

export function rmDirectoryPromptAction(s) {
  if (!(s.mode & 0o500)) return "attempt removal of inaccessible directory";
  return `remove ${rmPromptDescription(s)}`;
}

export function rmDisplayPath(path) {
  return String(path).replace(/\/+$/, "/");
}

export function rmRelativeTraversalName(path, isRoot = false) {
  const text = pathDisplayName(path);
  if (isRoot && isAbsolute(text)) return null;
  if (text.includes("\uFFFD") || /[\uDC80-\uDCFF]/.test(text) || text === "" || text === "." || text === "..") return null;
  return text;
}

export function isDotOrDotDotPath(path) {
  const stripped = String(path).replace(/\/+$/, "");
  const base = pathBasename(stripped);
  return base === "." || base === "..";
}

export function rmErrorLine(path, error, directory = false) {
  const action = directory ? "cannot remove directory" : "cannot remove";
  return `rm: ${action} ${rmQuotedName(path)}: ${errnoMessage(error)}\n`;
}

export function rmQuotedName(path) {
  return shellEscapeLsName(pathDisplayName(path), true);
}

export function rmInvalidOptionUsageError(arg, args) {
  const message = invalidOptionMessage(rmInvalidOptionArg(arg));
  const hint = rmDashFileHint(args);
  return new UsageError(hint ? `${message}\n${hint}` : message, true);
}

export function rmInvalidOptionArg(arg) {
  if (arg.startsWith("--")) return arg;
  for (const ch of arg.slice(1)) {
    if (!"firdvIR".includes(ch)) return `-${ch}`;
  }
  return arg;
}

export function rmDashFileHint(args) {
  for (const arg of args) {
    if (!arg.startsWith("-") || arg === "-" || arg === "--") continue;
    if (!lstatSyncNoThrow(arg)) continue;
    return `Try 'rm ./${rmShellEscapeCommandPath(arg)}' to remove the file ${rmShellQuote(arg)}.`;
  }
  return "";
}

export function rmShellEscapeCommandPath(path) {
  return /^[A-Za-z0-9_./=-]+$/.test(path) ? path : rmShellQuote(path);
}

export function rmShellQuote(value) {
  const text = String(value);
  if (!/[^A-Za-z0-9_./=-]/.test(text)) return `'${text}'`;
  return `'${text.replace(/'/g, "'\\''").replace(/\n/g, () => "'$'\\n''")}'`;
}

const singleCall = defineCommand("rm", rmCmd, rmMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
