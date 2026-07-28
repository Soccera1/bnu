#!/usr/bin/env bun

import { constants as fsConstants } from "node:fs";
import { access, lstat, readdir, rename, rm } from "node:fs/promises";
import { join, basename as pathBasename, resolve } from "node:path";
import { AT_FDCWD, cstrPath, invalidOptionMessage, libc, normalizeLongOptionByPrefix, parseOptions, selinuxRuntimeEnabled } from "../shared/common.js";
import { areSameFile, backupDestination, copyPath, cpDuplicateDisplayName, cpUpdateDecision, ensureBackupDoesNotDestroySource, resolveDestinationOperands, stripTrailingSlashesPath, validateBackupMode, validateUpdateMode } from "../shared/copy.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { confirmRemoval, errnoMessage, modeString, restoreSelinuxSecurityContext } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const RENAME_EXCHANGE = 2;

export const MV_LONG_OPTIONS = ["backup", "debug", "exchange", "force", "interactive", "no-clobber", "no-copy", "strip-trailing-slashes", "suffix", "target-directory", "no-target-directory", "update", "verbose", "context", "help", "version"];

export function mvMetaOption(args) {
  const longFlagOptions = new Set(["debug", "exchange", "force", "interactive", "no-clobber", "no-copy", "strip-trailing-slashes", "no-target-directory", "verbose", "context"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeLongOptionByPrefix(arg, MV_LONG_OPTIONS);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      return normalized;
    }
    if (longFlagOptions.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      continue;
    }
    if (name === "suffix" || name === "target-directory") {
      if (inlineValue === undefined) i++;
      continue;
    }
    if (name === "backup") continue;
    if (name === "update") {
      if (inlineValue !== undefined) validateUpdateMode("mv", inlineValue);
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      i = scanMvShortMetaOption(args, i);
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(invalidOptionMessage(arg), true);
    continue;
  }
  return null;
}

export function scanMvShortMetaOption(args, index) {
  const arg = args[index];
  for (let j = 1; j < arg.length; j++) {
    const ch = arg[j];
  if ("dfinuvbTZ".includes(ch)) continue;
    if (ch === "t" || ch === "S") return arg.slice(j + 1) ? index : index + 1;
    throw new UsageError(`invalid option -- '${ch}'`, true);
  }
  return index;
}

export async function mvCmd(args) {
  args = normalizeMvArgs(args);
  const { opts, operands } = parseOptions(args, { short: { f: false, i: false, n: false, u: false, t: "value", T: false, v: false, b: false, S: "value", Z: false }, long: { context: false, force: false, interactive: false, "no-clobber": false, "no-copy": false, update: "optional-value", target: "value", "target-directory": "value", "no-target-directory": false, "strip-trailing-slashes": false, verbose: false, debug: false, exchange: false, backup: "optional-value", b: "optional-value", suffix: "value", help: false, version: false } });
  const selinuxEnabled = selinuxRuntimeEnabled();
  const securityContext = {
    selinuxEnabled,
    restoreContext: selinuxEnabled && Boolean(opts.Z || opts.context),
    preserveContext: selinuxEnabled && !(opts.Z || opts.context),
  };
  if (opts.target != null && opts["target-directory"] == null) opts["target-directory"] = opts.target;
  if (opts.b != null && opts.backup == null) opts.backup = opts.b;
  if (opts.S != null && opts.suffix == null) opts.suffix = opts.S;
  const { sources, dest, useDirectoryTarget } = await resolveDestinationOperands("mv", operands, opts);
  const backupRequested = opts.b || opts.backup != null;
  if (backupRequested) validateBackupMode("mv", opts.backup);
  const overwriteMode = mvOverwriteMode(args, opts);
  const forceOverwrite = mvForceOverwriteIsEffective(args);
  if (backupRequested && (opts.exchange || overwriteMode === "no-clobber" || opts.update === "none" || opts.update === "none-fail")) {
    throw new UsageError("cannot combine --backup with --exchange, -n, or --update=none-fail", true);
  }
  if (opts.exchange) return mvExchangeCmd(sources, dest, useDirectoryTarget, opts, securityContext);
  const seenSources = new Set();
  const createdTargets = new Set();
  const linkMap = new Map();
  let status = 0;
  for (const src of sources) {
    const normalizedSrc = opts["strip-trailing-slashes"] ? stripTrailingSlashesPath(src) : src;
    try {
      const target = useDirectoryTarget ? join(dest, pathBasename(normalizedSrc)) : dest;
      const sourceInfo = await lstat(normalizedSrc).catch((error) => {
        if (error?.code === "ENOENT") throw new UsageError(`cannot stat '${src}': No such file or directory`);
        throw error;
      });
      const sourceKey = `${sourceInfo.dev}:${sourceInfo.ino}`;
      if (sourceInfo.isDirectory() && seenSources.has(sourceKey)) {
        stderr(`mv: warning: source directory '${cpDuplicateDisplayName(src)}' specified more than once\n`);
        continue;
      }
      seenSources.add(sourceKey);
      await ensureMvNotIntoSelf(src, target, sourceInfo);
      const targetKey = resolve(target);
      if (!backupRequested && createdTargets.has(targetKey)) throw new UsageError(`will not overwrite just-created '${target}' with '${src}'`);
      if (!backupRequested && await areSameFile(normalizedSrc, target) && !await mvSameFileIsAllowed(normalizedSrc, target, sourceInfo)) throw new UsageError(`'${src}' and '${target}' are the same file`);
      await ensureMvTargetTypeCompatible(src, target, sourceInfo);
      const updateDecision = await cpUpdateDecision(normalizedSrc, target, opts, false, overwriteMode);
      if (updateDecision.skip) {
        if (updateDecision.fail) {
          stderr(`mv: not replacing '${target}'\n`);
          status = 1;
        }
        continue;
      }
      const targetInfo = await lstat(target).catch(() => null);
      const writeProtected = targetInfo && await mvTargetIsWriteProtected(target, targetInfo);
      const shouldPrompt = targetInfo && (overwriteMode === "interactive"
        || (overwriteMode === "replace" && !forceOverwrite && writeProtected && process.stdin.isTTY));
      if (shouldPrompt && !confirmRemoval(mvOverwritePrompt(target, targetInfo, writeProtected))) {
        status = 1;
        continue;
      }
      if (backupRequested) await ensureBackupDoesNotDestroySource("mv", normalizedSrc, target, opts.suffix, opts.backup);
      const backupName = backupRequested ? await backupDestination(target, opts.suffix, opts.backup) : "";
      const renamed = await mvRenameOrCopy(normalizedSrc, target, sourceInfo, opts, mvDisplayTarget(src, target, useDirectoryTarget), linkMap, securityContext);
      createdTargets.add(targetKey);
      if (renamed && (opts.v || opts.verbose || opts.debug)) stdout(`renamed '${src}' -> '${target}'${backupName ? ` (backup: '${backupName}')` : ""}\n`);
    } catch (error) {
      status = 1;
      if (error instanceof UsageError) stderr(`mv: ${error.message}\n`);
      else stderr(`mv: ${error.message || String(error)}\n`);
    }
  }
  return status;
}

export function normalizeMvArgs(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--") {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(arg.startsWith("--") ? normalizeLongOptionByPrefix(arg, MV_LONG_OPTIONS) : arg);
  }
  return out;
}

export async function mvExchangeCmd(sources, dest, useDirectoryTarget, opts, securityContext) {
  if (!useDirectoryTarget && sources.length !== 1) throw new UsageError(`extra operand '${sources[1] ?? dest}'`, true);
  let status = 0;
  for (const source of sources) {
    const src = opts["strip-trailing-slashes"] ? stripTrailingSlashesPath(source) : source;
    const target = useDirectoryTarget ? join(dest, pathBasename(src)) : dest;
    const exchanged = await mvExchangePair(src, target, opts, securityContext);
    if (!exchanged) status = 1;
  }
  return status;
}

export async function mvExchangePair(src, target, opts, securityContext) {
  try {
    const sourceInfo = await lstat(src).catch((error) => {
      if (error?.code === "ENOENT") throw new UsageError(`cannot stat '${src}': No such file or directory`);
      throw error;
    });
    const targetInfo = await lstat(target);
    if (libc.symbols.renameat2(AT_FDCWD, cstrPath(src), AT_FDCWD, cstrPath(target), RENAME_EXCHANGE) !== 0) {
      throw new UsageError(`cannot exchange '${src}' and '${target}': Operation not supported`);
    }
    if (securityContext.restoreContext) {
      if (!restoreSelinuxSecurityContext(src, targetInfo.isSymbolicLink(), targetInfo.isDirectory())) {
        throw new UsageError(`failed to restore the security context of '${src}'`);
      }
      if (!restoreSelinuxSecurityContext(target, sourceInfo.isSymbolicLink(), sourceInfo.isDirectory())) {
        throw new UsageError(`failed to restore the security context of '${target}'`);
      }
    }
    if (opts.v || opts.verbose || opts.debug) stdout(`exchanged '${src}' <-> '${target}'\n`);
    return true;
  } catch (error) {
    if (error instanceof UsageError) stderr(`mv: ${error.message}\n`);
    else stderr(`mv: cannot exchange '${src}' and '${target}': ${errnoMessage(error)}\n`);
    return false;
  }
}

export function mvOverwriteMode(args, opts) {
  let mode = "replace";
  let sawOverwriteOption = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "-i" || arg === "--interactive") { mode = "interactive"; sawOverwriteOption = true; }
    else if (arg === "-n" || arg === "--no-clobber") { mode = "no-clobber"; sawOverwriteOption = true; }
    else if (arg === "-f" || arg === "--force") { mode = "replace"; sawOverwriteOption = true; }
    else if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === "i") { mode = "interactive"; sawOverwriteOption = true; }
        else if (ch === "n") { mode = "no-clobber"; sawOverwriteOption = true; }
        else if (ch === "f") { mode = "replace"; sawOverwriteOption = true; }
      }
    }
  }
  if (!sawOverwriteOption && (opts.i || opts.interactive)) return "interactive";
  if (!sawOverwriteOption && (opts.n || opts["no-clobber"])) return "no-clobber";
  return mode;
}

export function mvForceOverwriteIsEffective(args) {
  let forced = false;
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "-f" || arg === "--force") forced = true;
    else if (arg === "-i" || arg === "--interactive" || arg === "-n" || arg === "--no-clobber") forced = false;
    else if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === "f") forced = true;
        else if (ch === "i" || ch === "n") forced = false;
      }
    }
  }
  return forced;
}

export async function mvTargetIsWriteProtected(target, targetInfo) {
  if (targetInfo.isSymbolicLink()) return false;
  try {
    await access(target, fsConstants.W_OK);
    return false;
  } catch {
    return true;
  }
}

export function mvOverwritePrompt(target, targetInfo, writeProtected) {
  if (writeProtected) {
    const mode = (targetInfo.mode & 0o7777).toString(8).padStart(4, "0");
    return `mv: replace '${target}', overriding mode ${mode} (${modeString(targetInfo).slice(1)})? `;
  }
  return `mv: overwrite '${target}'? `;
}

export async function ensureMvTargetTypeCompatible(src, target, sourceInfo) {
  const targetInfo = await lstat(target).catch(() => null);
  if (!targetInfo) return;
  if (targetInfo.isDirectory() && !targetInfo.isSymbolicLink() && !sourceInfo.isDirectory()) {
    throw new UsageError(`cannot overwrite directory '${target}' with non-directory '${src}'`);
  }
  if (sourceInfo.isDirectory() && (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())) {
    throw new UsageError(`cannot overwrite non-directory '${target}' with directory '${src}'`);
  }
  if (sourceInfo.isDirectory() && targetInfo.isDirectory()) {
    const entries = await readdir(target).catch(() => []);
    if (entries.length > 0) throw new UsageError(`cannot overwrite '${target}': Directory not empty`);
  }
}

export async function mvSameFileIsAllowed(src, target, sourceInfo) {
  if (sourceInfo.isSymbolicLink()) return false;
  const targetInfo = await lstat(target).catch(() => null);
  if (!targetInfo?.isSymbolicLink()) return false;
  return sourceInfo.dev !== targetInfo.dev;
}

export async function mvRenameOrCopy(src, target, sourceInfo, opts, displayTarget = target, linkMap = new Map(), securityContext = {}) {
  try {
    await rename(src, target);
    if (securityContext.restoreContext
      && !restoreSelinuxSecurityContext(target, sourceInfo.isSymbolicLink(), sourceInfo.isDirectory())) {
      throw new UsageError(`failed to restore the security context of '${target}'`);
    }
    return true;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (isDirectoryNotEmptyRenameError(error)) throw new UsageError(`cannot overwrite '${target}': Directory not empty`);
    if (error?.code !== "EXDEV") throw new UsageError(`cannot move '${src}' to '${displayTarget}': ${errnoMessage(error)}`);
    if (opts["no-copy"]) throw new UsageError(`inter-device move failed: '${src}' to '${target}'; --no-copy specified`);
  }
  await ensureMvCrossDeviceDirectoryReplaceable(src, target, sourceInfo);
  try {
    await copyPath(src, target, {
      force: true,
      removeDestination: true,
      recursive: true,
      preserveMode: true,
      preserveDirectoryMode: true,
      preserveMetadata: true,
      preserveLinks: true,
      preserveXattrs: true,
      requirePreserveXattrs: false,
      reflinkMode: "auto",
      sparseMode: "auto",
      attributesOnly: false,
      debug: false,
      linkMap,
      symbolicLink: false,
      hardLink: false,
      noDereference: true,
      dereferenceAll: false,
      dereferenceCommandLine: false,
      selinuxEnabled: Boolean(securityContext.selinuxEnabled),
      preserveContext: Boolean(securityContext.preserveContext),
      preserveContextAtCreation: Boolean(securityContext.preserveContext),
      requirePreserveContext: false,
      restoreContext: Boolean(securityContext.restoreContext),
      requireRestoreContext: Boolean(securityContext.restoreContext),
      explicitContext: null,
      verbose: opts.v || opts.verbose,
    }, true);
  } catch (error) {
    throw new UsageError(`inter-device move failed: '${src}' to '${target}'; unable to remove target: ${errnoMessage(error)}`);
  }
  if ((opts.v || opts.verbose) && sourceInfo.isDirectory()) stdout(`copied '${src}' -> '${target}'\n`);
  try {
    await rm(src, { force: true, recursive: sourceInfo.isDirectory() });
  } catch (error) {
    const message = error?.code === "EFAULT" ? "Operation not permitted" : errnoMessage(error);
    throw new UsageError(`cannot remove '${src}': ${message}`);
  }
  return false;
}

export function mvDisplayTarget(src, target, useDirectoryTarget) {
  if (useDirectoryTarget && (target === pathBasename(src) || target === `./${pathBasename(src)}`)) return `./${pathBasename(src)}`;
  return target;
}

export function isDirectoryNotEmptyRenameError(error) {
  return error?.code === "ENOTEMPTY" || error?.code === "EEXIST" || /ENOTEMPTY|EEXIST|Directory not empty/i.test(error?.message ?? "");
}

export async function ensureMvCrossDeviceDirectoryReplaceable(src, target, sourceInfo) {
  if (!sourceInfo.isDirectory()) return;
  const targetInfo = await lstat(target).catch(() => null);
  if (!targetInfo?.isDirectory() || targetInfo.isSymbolicLink()) return;
  const entries = await readdir(target).catch(() => []);
  if (entries.length > 0) {
    throw new UsageError(`inter-device move failed: '${src}' to '${target}'; unable to remove target: Directory not empty`);
  }
}

export async function ensureMvNotIntoSelf(src, target, sourceInfo) {
  if (!sourceInfo?.isDirectory()) return;
  const sourcePath = resolve(src);
  const targetPath = resolve(target);
  if (targetPath === sourcePath || targetPath.startsWith(`${sourcePath}/`)) {
    throw new UsageError(`cannot move '${src}' to a subdirectory of itself, '${target}'`);
  }
}

const singleCall = defineCommand("mv", mvCmd, mvMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
