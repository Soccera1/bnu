#!/usr/bin/env bun

import { link as fsLink, unlink as fsUnlink, lstat, readlink, realpath, rename, stat, symlink } from "node:fs/promises";
import { isAbsolute, join, basename as pathBasename, dirname as pathDirname, relative, resolve } from "node:path";
import { bufferPathBasename, bufferPathJoin, invalidOptionMessage, normalizeLongOptionByPrefix, parseOptions, pathDisplayName, rawCommandArgs, shellEscapeLsName } from "../shared/common.js";
import { areSameFile, backupFileName, lnQuotedName, resolveDestinationOperands, validateBackupMode } from "../shared/copy.js";
import { UsageError, stdout } from "../shared/diagnostics.js";
import { confirmRemoval, errnoMessage, rawArgLooksLikeOption } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const LN_LONG_OPTIONS = ["backup", "directory", "force", "interactive", "logical", "no-dereference", "physical", "relative", "suffix", "symbolic", "target-directory", "target-dir", "no-target-directory", "verbose", "help", "version"];

export function lnMetaOption(args) {
  const longFlagOptions = new Set(["directory", "force", "interactive", "logical", "no-dereference", "physical", "relative", "symbolic", "no-target-directory", "verbose"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeLnLongOption(arg);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      return normalized;
    }
    if (longFlagOptions.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      continue;
    }
    if (name === "suffix" || name === "target-directory" || name === "target-dir") {
      if (inlineValue === undefined) i++;
      continue;
    }
    if (name === "backup") continue;
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      i = scanLnShortMetaOption(args, i);
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(invalidOptionMessage(arg), true);
    continue;
  }
  return null;
}

export function scanLnShortMetaOption(args, index) {
  const arg = args[index];
  for (let j = 1; j < arg.length; j++) {
    const ch = arg[j];
    if ("sfidFLPnrTvb".includes(ch)) continue;
    if (ch === "t" || ch === "S") return arg.slice(j + 1) ? index : index + 1;
    throw new UsageError(`invalid option -- '${ch}'`, true);
  }
  return index;
}

export async function lnCmd(args) {
  args = normalizeLnArgs(args);
  const { opts, operands } = parseOptions(args, { short: { s: false, f: false, i: false, L: false, P: false, F: false, d: false, n: false, r: false, t: "value", T: false, v: false, b: false, S: "value" }, long: { symbolic: false, force: false, interactive: false, logical: false, physical: false, directory: false, "no-dereference": false, relative: false, "target-directory": "value", "target-dir": "value", "no-target-directory": false, verbose: false, backup: "optional-value", b: "optional-value", suffix: "value", help: false, version: false } });
  if (opts["target-dir"] != null && opts["target-directory"] == null) opts["target-directory"] = opts["target-dir"];
  if (opts.b != null && opts.backup == null) opts.backup = opts.b;
  if (opts.S != null && opts.suffix == null) opts.suffix = opts.S;
  if ((opts.r || opts.relative) && !(opts.s || opts.symbolic)) throw new UsageError("cannot do --relative without --symbolic");
  const { sources, dest, useDirectoryTarget } = await resolveLnDestinationOperands(operands, opts);
  const backup = opts.b || opts.backup != null;
  if (backup) validateBackupMode("ln", opts.backup);
  const force = lnForceMode(args, opts);
  const dereferenceSource = lnDereferenceSource(args);
  const rawPlan = rawLnPlan(opts, operands, useDirectoryTarget);
  const createdTargets = new Set();
  let failed = false;
  for (const src of sources) {
    const rawSource = rawPlan?.sources.shift();
    const target = rawPlan && rawSource
      ? rawLnTarget(rawSource, rawPlan.dest, rawPlan.useDirectoryTarget)
      : useDirectoryTarget ? join(dest, pathBasename(src)) : dest;
    const operationSource = rawSource ?? src;
    const targetKey = resolve(pathDisplayName(target));
    if ((force === "force" || (backup && !useDirectoryTarget)) && await areSameFile(src, target)) {
      if (!opts.s && !opts.symbolic && force === "force" && useDirectoryTarget) continue;
      throw new UsageError(`'${src}' and '${target}' are the same file`);
    }
    if (!backup && createdTargets.has(targetKey)) throw new UsageError(`will not overwrite just-created '${target}' with '${src}'`);
    if (backup) await backupLinkDestination(target, opts.suffix);
    else if (force === "force") await removeLinkDestination(target);
    else if (force === "interactive" && await lstat(target).then(() => true, () => false)) {
      if (!confirmRemoval(`ln: replace '${target}'? `)) {
        failed = true;
        continue;
      }
      await removeLinkDestination(target);
    }
    const linkSource = rawSource ? operationSource : opts.r || opts.relative ? await relativeLinkSource(src, target) : src;
    try {
      if (opts.s || opts.symbolic || opts.r || opts.relative) await symlink(linkSource, target);
      else await fsLink(rawSource ?? await hardLinkSource(src, dereferenceSource, opts.F || opts.d || opts.directory), target);
    } catch (error) {
      if (String(error?.message ?? "").startsWith("failed to access ")) throw new UsageError(error.message);
      if (String(error?.message ?? "").endsWith(": hard link not allowed for directory")) throw new UsageError(error.message);
      const kind = opts.s || opts.symbolic || opts.r || opts.relative ? "symbolic link" : "hard link";
      const message = error?.code === "EEXIST" ? "File exists" : errnoMessage(error);
      const targetDisplay = lnTargetDisplay(target, sources.length === 1 && operands.length === 1 && !useDirectoryTarget);
      throw new UsageError(`failed to create ${kind} '${targetDisplay}': ${message}`);
    }
    createdTargets.add(targetKey);
    if (opts.v || opts.verbose) stdout(`'${target}' => '${src}'\n`);
  }
  return failed ? 1 : 0;
}

export function normalizeLnArgs(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--") {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(arg.startsWith("--") ? normalizeLnLongOption(arg) : arg);
  }
  return out;
}

export function lnTargetDisplay(target, implicitSingleTarget = false) {
  if (!implicitSingleTarget) return target;
  const text = pathDisplayName(target);
  if (text === "" || text.startsWith("/") || text.startsWith("./") || text.startsWith("../")) return target;
  return `./${text}`;
}

export function normalizeLnLongOption(arg) {
  if (arg === "--target-dir" || arg.startsWith("--target-dir=")) return arg;
  const options = LN_LONG_OPTIONS.filter((option) => option !== "target-dir");
  return normalizeLongOptionByPrefix(arg, options);
}

export function rawLnPlan(opts, operands, useDirectoryTarget) {
  if (!operands.some((operand) => operand.includes("\uFFFD"))) return null;
  const raw = rawCommandArgs("ln");
  if (!raw) return null;
  const parsed = parseRawLnArgs(raw);
  if (!parsed || parsed.operands.length !== operands.length) return null;
  if (opts.t || opts["target-directory"]) {
    return { sources: parsed.operands, dest: parsed.targetDirectory, useDirectoryTarget: true };
  }
  if (!useDirectoryTarget || parsed.operands.length < 2) return null;
  return { sources: parsed.operands.slice(0, -1), dest: parsed.operands.at(-1), useDirectoryTarget: true };
}

export function parseRawLnArgs(rawArgs) {
  const operands = [];
  let targetDirectory = null;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.equals(Buffer.from("--"))) {
      operands.push(...rawArgs.slice(i + 1));
      break;
    }
    if (!rawArgLooksLikeOption(arg)) {
      operands.push(arg);
      continue;
    }
    const text = arg.toString();
    if (text === "-t" || text === "--target-directory" || text === "--target-dir") {
      targetDirectory = rawArgs[++i] ?? null;
      continue;
    }
    if (text.startsWith("--target-directory=")) {
      targetDirectory = arg.subarray(Buffer.from("--target-directory=").length);
      continue;
    }
    if (text.startsWith("--target-dir=")) {
      targetDirectory = arg.subarray(Buffer.from("--target-dir=").length);
      continue;
    }
    if (arg.length > 2 && arg[0] === 0x2d && arg.includes(0x74)) {
      const tIndex = arg.indexOf(0x74);
      if (tIndex !== arg.length - 1) targetDirectory = arg.subarray(tIndex + 1);
      else targetDirectory = rawArgs[++i] ?? null;
    }
  }
  if (targetDirectory && operands.length) return { operands, targetDirectory };
  return { operands, targetDirectory };
}

export function rawLnTarget(source, dest, useDirectoryTarget) {
  if (!useDirectoryTarget) return dest;
  return bufferPathJoin(dest, bufferPathBasename(source));
}

export async function hardLinkSource(src, dereferenceSource, allowDirectory = false) {
  if (dereferenceSource) {
    let resolved;
    try {
      resolved = await realpath(src);
    } catch (error) {
      throw new Error(`failed to access ${lnQuotedName(src)}: ${errnoMessage(error)}`);
    }
    if (!allowDirectory && (await stat(resolved)).isDirectory()) throw new Error(`${lnDiagnosticName(src)}: hard link not allowed for directory`);
    return resolved;
  }
  const s = (src.endsWith("/") ? await stat(src).catch(() => null) : await lstat(src).catch(() => null));
  if (!s) throw new Error(`failed to access ${lnQuotedName(src)}: No such file or directory`);
  if (!allowDirectory && s?.isDirectory()) throw new Error(`${lnDiagnosticName(src)}: hard link not allowed for directory`);
  return src;
}

export function lnDiagnosticName(name) {
  return shellEscapeLsName(pathDisplayName(name));
}

export async function resolveLnDestinationOperands(operands, opts) {
  if (operands.length === 1 && !opts.t && !opts["target-directory"]) {
    return { sources: operands, dest: pathBasename(operands[0]), destStat: await stat(pathBasename(operands[0])).catch(() => null), useDirectoryTarget: false };
  }
  const noDereference = opts.n || opts["no-dereference"];
  if (noDereference && operands.length === 2 && !opts.t && !opts["target-directory"]) {
    const dest = operands[1];
    const destLstat = await lstat(dest).catch(() => null);
    if (destLstat?.isSymbolicLink()) return { sources: [operands[0]], dest, destStat: destLstat, useDirectoryTarget: false };
  }
  return resolveDestinationOperands("ln", operands, opts);
}

export function lnForceMode(args, opts) {
  let mode = opts.f || opts.force ? "force" : "none";
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "-f" || arg === "--force") mode = "force";
    else if (arg === "-i" || arg === "--interactive") mode = "interactive";
    else if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === "f") mode = "force";
        else if (ch === "i") mode = "interactive";
      }
    }
  }
  return mode;
}

export function lnDereferenceSource(args) {
  let dereference = false;
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "-L" || arg === "--logical") dereference = true;
    else if (arg === "-P" || arg === "--physical") dereference = false;
    else if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === "L") dereference = true;
        else if (ch === "P") dereference = false;
        else if (ch === "s") return false;
      }
    }
    if (arg === "-s" || arg === "--symbolic") return false;
  }
  return dereference;
}

export async function backupLinkDestination(target, suffixOption) {
  const s = await lstat(target).catch(() => null);
  if (!s) return;
  const backup = backupFileName(target, suffixOption, "simple");
  await fsUnlink(backup).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await rename(target, backup);
}

export async function removeLinkDestination(target) {
  const s = await lstat(target).catch(() => null);
  if (s?.isDirectory() && !s.isSymbolicLink()) return;
  await fsUnlink(target).catch((error) => {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR" && error?.code !== "ELOOP" && error?.code !== "ENAMETOOLONG") throw error;
  });
}

export async function relativeLinkSource(src, target) {
  if (src === "") return src;
  const resolvedSource = await resolveSymlinkChain(src).catch(() => resolve(src));
  const targetDir = pathDirname(resolve(target));
  const rel = relative(targetDir, resolvedSource);
  return rel || ".";
}

export async function resolveSymlinkChain(path) {
  let current = resolve(path);
  for (let i = 0; i < 40; i++) {
    const s = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!s) return current;
    if (!s.isSymbolicLink()) return current;
    const linkTarget = await readlink(current);
    current = isAbsolute(linkTarget) ? linkTarget : resolve(pathDirname(current), linkTarget);
  }
  return current;
}

const singleCall = defineCommand("ln", lnCmd, lnMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
