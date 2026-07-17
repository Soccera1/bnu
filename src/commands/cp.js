#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { copyFile, link as fsLink, lstat, mkdir, readlink, stat } from "node:fs/promises";
import { isAbsolute, join, basename as pathBasename, dirname as pathDirname, resolve } from "node:path";
import { bufferPathBasename, bufferPathJoin, invalidOptionMessage, isBytePath, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, parseOptions, pathDisplayName, pathLikeJoin, rawCommandArgs, readdirPathEntries, selinuxRuntimeEnabled } from "../shared/common.js";
import { applyCopySecurityContext, areSameFile, backupDestination, backupFileName, backupModeFromEnvironment, copyPath, cpDuplicateDisplayName, cpRestrictiveDirectoryMode, cpShouldDereferenceSource, cpUpdateDecision, ensureBackupDoesNotDestroySource, resolveDestinationOperands, stripTrailingSlashesPath, validateBackupMode, validateUpdateMode, withPreservedCopyCreationContext } from "../shared/copy.js";
import { InvocationError, UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { confirmRemoval, isWriteProtected, modeString, rawArgLooksLikeOption, rawPathNeedsBytes, setFileMode } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const CP_LONG_OPTIONS = ["archive", "attributes-only", "backup", "copy-contents", "debug", "force", "interactive", "dereference", "keep-directory-symlink", "link", "no-clobber", "no-dereference", "preserve", "no-preserve", "parents", "recursive", "reflink", "remove-destination", "sparse", "strip-trailing-slashes", "suffix", "symbolic-link", "target-directory", "no-target-directory", "update", "verbose", "one-file-system", "context", "help", "version"];

export function cpMetaOption(args) {
  const longFlagOptions = new Set(["archive", "attributes-only", "copy-contents", "debug", "force", "interactive", "dereference", "no-dereference", "keep-directory-symlink", "link", "no-clobber", "parents", "recursive", "remove-destination", "strip-trailing-slashes", "symbolic-link", "no-target-directory", "verbose", "one-file-system"]);
  let sawContextValue = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeLongOptionByPrefix(arg, CP_LONG_OPTIONS);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      if (sawContextValue) stderr("cp: warning: ignoring --context; it requires an SELinux-enabled kernel\n");
      return normalized;
    }
    if (longFlagOptions.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      continue;
    }
    if (name === "suffix" || name === "target-directory" || name === "no-preserve" || name === "sparse") {
      if (inlineValue === undefined) i++;
      if (name === "no-preserve" && inlineValue !== undefined) validateCpPreserveList(inlineValue, "--no-preserve");
      if (name === "sparse" && inlineValue !== undefined) validateSparseMode("cp", inlineValue);
      continue;
    }
    if (name === "preserve") {
      if (inlineValue !== undefined) validateCpPreserveList(inlineValue, "--preserve");
      continue;
    }
    if (name === "context") {
      if (inlineValue !== undefined) sawContextValue = true;
      continue;
    }
    if (name === "backup") continue;
    if (name === "reflink") {
      if (inlineValue !== undefined) validateReflinkMode("cp", inlineValue);
      continue;
    }
    if (name === "update") {
      if (inlineValue !== undefined) validateUpdateMode("cp", inlineValue);
      continue;
    }
    if (arg.startsWith("-") && !arg.startsWith("--")) {
      i = scanCpShortMetaOption(args, i);
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(invalidOptionMessage(arg), true);
    continue;
  }
  return null;
}

export function scanCpShortMetaOption(args, index) {
  const arg = args[index];
  for (let j = 1; j < arg.length; j++) {
    const ch = arg[j];
    if ("finrRapsdlHLPTuvbxZ".includes(ch)) continue;
    if (ch === "t" || ch === "S") return arg.slice(j + 1) ? index : index + 1;
    throw new UsageError(`invalid option -- '${ch}'`, true);
  }
  return index;
}

export async function cpCmd(args) {
  args = normalizeCpArgs(args);
  const { opts, operands } = parseOptions(args, { short: { f: false, i: false, n: false, r: false, R: false, a: false, p: false, s: false, d: false, l: false, H: false, L: false, P: false, u: false, v: false, t: "value", T: false, b: false, S: "value", x: false, Z: false }, long: { force: false, interactive: false, "no-clobber": false, recursive: false, archive: false, preserve: "optional-value", parent: false, parents: false, "symbolic-link": false, "no-dereference": false, link: false, dereference: false, "no-preserve": "value", update: "optional-value", verbose: false, debug: false, reflink: "optional-value", sparse: "value", "target-directory": "value", "no-target-directory": false, "remove-destination": false, rem: false, "attributes-only": false, "copy-contents": false, context: "optional-value", backup: "optional-value", b: "optional-value", suffix: "value", "strip-trailing-slashes": false, "one-file-system": false, "keep-directory-symlink": false, help: false, version: false } });
  const selinuxEnabled = selinuxRuntimeEnabled();
  if (typeof opts.context === "string" && !selinuxEnabled) stderr("cp: warning: ignoring --context; it requires an SELinux-enabled kernel\n");
  if (opts.b != null && opts.backup == null) opts.backup = opts.b;
  if (opts.S != null && opts.suffix == null) opts.suffix = opts.S;
  const reflinkMode = cpReflinkMode(opts);
  const sparseMode = cpSparseMode(opts);
  validateCpPreserveOptions(opts);
  const securityContextOptions = cpSecurityContextOptions(opts, selinuxEnabled);
  const noDereference = opts.d || opts.P || opts["no-dereference"];
  const backupRequested = opts.b || opts.backup != null;
  if (backupRequested) validateBackupMode("cp", opts.backup);
  const overwriteMode = cpOverwriteMode(args, opts);
  if (backupRequested && (overwriteMode === "no-clobber" || opts.update === "none" || opts.update === "none-fail")) {
    throw new UsageError("--backup is mutually exclusive with -n or --update=none-fail", true);
  }
  if (reflinkMode === "always" && opts.sparse != null) throw new UsageError("options --reflink and --sparse are mutually exclusive");
  const { sources, dest, destStat, useDirectoryTarget } = await resolveDestinationOperands("cp", operands, opts);
  if (cpParents(opts) && !useDirectoryTarget) throw new UsageError("with --parents, the destination must be a directory", true);
  const seenSources = new Set();
  const createdTargets = new Map();
  const linkMap = new Map();
  const rawPlan = rawCpPlan(opts, operands, useDirectoryTarget);
  let status = 0;
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const normalizedSrc = opts["strip-trailing-slashes"] ? stripTrailingSlashesPath(src) : src;
    const rawSource = rawPlan?.sources[i];
    const operationSource = rawSource ? await resolveRawExistingPath(stripTrailingDotPathBytes(rawSource)) : normalizedSrc;
    try {
      const target = rawSource ? rawCpTargetPath(rawSource, rawPlan.dest, rawPlan.useDirectoryTarget, opts) : cpTargetPath(normalizedSrc, dest, useDirectoryTarget, opts);
      const sourceInfo = await cpTopLevelSourceStat(operationSource, opts, noDereference);
      if (!sourceInfo) throw new UsageError(`cannot stat '${src}': No such file or directory`);
      const sourceKey = rawSource ? rawPathKey(rawSource) : resolve(src);
      if (sourceInfo && seenSources.has(sourceKey) && !backupRequested) {
        const kind = sourceInfo.isDirectory() ? "directory" : "file";
        stderr(`cp: warning: source ${kind} '${cpDuplicateDisplayName(src)}' specified more than once\n`);
        if (sourceInfo.isDirectory()) continue;
      }
      seenSources.add(sourceKey);
      const targetKey = isBytePath(target) ? rawPathKey(target) : resolve(target);
      if (backupRequested && createdTargets.has(targetKey) && !cpBackupIsNumbered(opts)) throw new UsageError(`will not overwrite just-created '${target}' with '${src}'`);
      await ensureCpNotIntoSelf(operationSource, target, noDereference);
      const updateDecision = await cpUpdateDecision(operationSource, target, opts, noDereference, overwriteMode);
      if (updateDecision.skip) {
        if (opts.debug) stdout(`skipped '${src}'\n`);
        if (updateDecision.fail) {
          stderr(`cp: not replacing '${target}'\n`);
          status = 1;
        }
        continue;
      }
      const copyForce = opts.f || opts.force || backupRequested || overwriteMode === "interactive";
      if (overwriteMode === "interactive") {
        const targetInfo = await lstat(target).catch(() => null);
        if (targetInfo && !confirmRemoval(cpOverwritePrompt(target, targetInfo))) {
          status = 1;
          continue;
        }
      }
      if (backupRequested) await ensureBackupDoesNotDestroySource("cp", src, target, opts.suffix, opts.backup);
      const sameFile = await cpSameFile(operationSource, target, opts);
      if (sameFile && (opts.l || opts.link) && await cpHardLinkSameFileIsNoop(src, target, opts, backupRequested)) continue;
      if ((opts.l || opts.link) && (opts.d || opts["no-dereference"]) && src !== target && await areSamePathEntry(operationSource, target)) continue;
      if (sameFile && await cpSameFileIsError(src, target, opts, backupRequested)) throw new UsageError(`'${src}' and '${target}' are the same file`);
      if (sameFile && backupRequested && (opts.f || opts.force) && (!(opts.d || opts["no-dereference"]) || src === target) && !await cpTargetIsSymlink(target)) {
        const backup = backupFileName(target, opts.suffix, opts.backup);
        if (opts.l || opts.link) await fsLink(src, backup);
        else await copyFile(src, backup);
        continue;
      }
      const parentModeRestores = cpParents(opts) ? await cpPrepareParentDirectories(operationSource, dest, noDereference, cpPreserveMode(opts), cpPreserveMetadata(opts), securityContextOptions) : [];
      const actualTargetInfo = await lstat(target).catch(() => null);
      const destinationWasReportedExisting = Boolean(!actualTargetInfo && destStat && !useDirectoryTarget && sources.length === 1);
      const targetExisted = Boolean(actualTargetInfo || destinationWasReportedExisting);
      const createdByDifferentSource = createdTargets.has(targetKey) && createdTargets.get(targetKey) !== sourceKey;
      if (!backupRequested && createdByDifferentSource && await cpTargetIsSymlink(target)) {
        throw new UsageError(`will not copy '${src}' through just-created symlink '${target}'`);
      }
      if (!backupRequested && createdByDifferentSource) {
        throw new UsageError(`will not overwrite just-created '${target}' with '${src}'`);
      }
      if (backupRequested && await cpShouldBackupDestination(target)) await backupDestination(target, opts.suffix, opts.backup);
      await copyPath(operationSource, target, {
        force: copyForce,
        removeDestination: opts["remove-destination"] || opts.rem,
        destinationWasReportedExisting,
        recursive: opts.r || opts.R || opts.recursive || opts.a || opts.archive,
        preserveMode: cpPreserveMode(opts),
        preserveDirectoryMode: !cpNoPreserveAttrs(opts).includes("mode"),
        useSourceModeForNewRegularFiles: cpUseSourceModeForNewRegularFiles(opts),
        preserveMetadata: cpPreserveMetadata(opts),
        preserveLinks: cpPreserveLinks(opts),
        preserveXattrs: cpPreserveXattrs(opts),
        requirePreserveXattrs: cpRequirePreserveXattrs(opts),
        ...securityContextOptions,
        attributesOnly: opts["attributes-only"],
        debug: opts.debug,
        linkMap,
        symbolicLink: opts.s || opts["symbolic-link"],
        hardLink: opts.l || opts.link,
        sparseMode,
        noDereference,
        dereferenceAll: opts.L || opts.dereference,
        dereferenceCommandLine: opts.H,
        copyContents: opts["copy-contents"],
        keepDirectorySymlink: opts["keep-directory-symlink"],
        oneFileSystem: opts.x || opts["one-file-system"],
        rootDev: sourceInfo.dev,
        reflinkMode,
        verbose: opts.v || opts.verbose || opts.debug,
      }, true);
      for (const restore of parentModeRestores.reverse()) {
        if (restore.sourcePath != null) await applyCopySecurityContext(restore.path, restore.sourcePath, securityContextOptions);
        if (restore.mode != null) await setFileMode(restore.path, restore.mode).catch(() => {});
      }
      if (!targetExisted || await cpCopiedMatchingSymlink(src, target, noDereference)) createdTargets.set(targetKey, sourceKey);
    } catch (error) {
      status = 1;
      if (error instanceof UsageError) stderr(`cp: ${error.message}\n`);
      else stderr(`cp: ${error.message || String(error)}\n`);
    }
  }
  return status;
}

export async function cpCopiedMatchingSymlink(src, target, noDereference) {
  if (!noDereference) return false;
  const [srcInfo, targetInfo] = await Promise.all([lstat(src).catch(() => null), lstat(target).catch(() => null)]);
  if (!srcInfo?.isSymbolicLink() || !targetInfo?.isSymbolicLink()) return false;
  return await readlink(src).catch(() => null) === await readlink(target).catch(() => null);
}

export async function cpTopLevelSourceStat(src, opts, noDereference) {
  const dereferenceSource = cpShouldDereferenceSource(src, {
    noDereference,
    dereferenceAll: opts.L || opts.dereference,
    dereferenceCommandLine: opts.H,
    recursive: opts.r || opts.R || opts.recursive || opts.a || opts.archive,
    hardLink: opts.l || opts.link,
    preserveLinks: cpPreserveLinks(opts),
  }, true);
  return (dereferenceSource ? stat(src) : lstat(src)).catch(() => null);
}

export function cpOverwritePrompt(target, targetInfo) {
  if (isWriteProtected(targetInfo)) {
    return `cp: replace '${target}', overriding mode ${(targetInfo.mode & 0o7777).toString(8).padStart(4, "0")} (${modeString(targetInfo).slice(1)})? `;
  }
  return `cp: overwrite '${target}'? `;
}

export function normalizeCpArgs(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--") {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(arg.startsWith("--") ? normalizeLongOptionByPrefix(arg, CP_LONG_OPTIONS) : arg);
  }
  return out;
}

export function cpOverwriteMode(args, opts) {
  let mode = "replace";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "-i" || arg === "--interactive") mode = "interactive";
    else if (arg === "-n" || arg === "--no-clobber") mode = "no-clobber";
    else if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === "i") mode = "interactive";
        else if (ch === "n") mode = "no-clobber";
      }
    }
  }
  if (mode === "replace" && (opts.i || opts.interactive)) return "interactive";
  if (mode === "replace" && (opts.n || opts["no-clobber"])) return "no-clobber";
  return mode;
}

export function cpReflinkMode(opts) {
  if (opts.reflink == null) return opts.debug && opts.sparse == null ? "auto" : "never";
  const mode = opts.reflink === true ? "always" : String(opts.reflink);
  if (mode === "always" || mode === "auto" || mode === "never") return mode;
  validateReflinkMode("cp", mode);
}

export function cpSparseMode(opts) {
  if (opts.sparse == null) return "auto";
  const mode = String(opts.sparse);
  if (mode === "always" || mode === "auto" || mode === "never") return mode;
  validateSparseMode("cp", mode);
}

export function cpBackupIsNumbered(opts) {
  const mode = opts.backup === true || opts.backup == null ? backupModeFromEnvironment() : String(opts.backup);
  return mode === "numbered" || mode === "t";
}

export async function cpShouldBackupDestination(target) {
  const info = await lstat(target).catch(() => null);
  return Boolean(info && !info.isDirectory());
}

export async function cpPrepareParentDirectories(src, destRoot, noDereference, preserveMode, preserveMetadata = false, securityOptions = {}) {
  if (noDereference) await lstat(src);
  else await stat(src);
  const parentRel = pathDirname(cpParentPath(src));
  if (parentRel === "." || parentRel === "") return [];
  const parentParts = parentRel.split("/").filter(Boolean);
  let destPrefix = destRoot;
  let srcPrefix = isAbsolute(src) ? "/" : "";
  const restores = [];
  for (const part of parentParts) {
    destPrefix = join(destPrefix, part);
    srcPrefix = srcPrefix === "" || srcPrefix === "/" ? `${srcPrefix}${part}` : join(srcPrefix, part);
    const mode = preserveMode ? (await stat(srcPrefix).catch(() => null))?.mode & 0o7777 : undefined;
    const createMode = mode != null ? cpRestrictiveDirectoryMode(mode) : preserveMetadata ? 0o700 : 0o755;
    const exists = Boolean(await lstat(destPrefix).catch(() => null));
    if (!exists) {
      if (securityOptions.preserveContextAtCreation) {
        await withPreservedCopyCreationContext(srcPrefix, securityOptions, () => mkdirSync(destPrefix, { mode: createMode }));
      } else {
        await mkdir(destPrefix, { recursive: false, mode: createMode });
      }
    }
    if (mode !== undefined || securityOptions.preserveContext) {
      restores.push({ path: destPrefix, mode, sourcePath: securityOptions.preserveContext ? srcPrefix : null });
    }
  }
  return restores;
}

export function cpPreserveMode(opts) {
  if (opts.preserve != null) {
    const attrs = opts.preserve === true ? ["mode", "ownership", "timestamps"] : String(opts.preserve).split(",");
    if (attrs.includes("all") || attrs.includes("mode")) return true;
  }
  if (opts.p || opts.a || opts.archive) return !cpNoPreserveAttrs(opts).includes("mode");
  return false;
}

export const CP_PRESERVE_VALID_ARGUMENTS = [
  ["mode"],
  ["timestamps"],
  ["ownership"],
  ["links"],
  ["context"],
  ["xattr"],
  ["all"],
];

export function validateCpPreserveOptions(opts) {
  if (opts.preserve != null && opts.preserve !== true) {
    validateCpPreserveList(String(opts.preserve), "--preserve");
  }
  if (opts["no-preserve"] != null) validateCpPreserveList(String(opts["no-preserve"]), "--no-preserve");
}

export function cpSecurityContextOptions(opts, selinuxEnabled) {
  const noPreserve = cpNoPreserveAttrs(opts);
  const preserveAttrs = opts.preserve == null || opts.preserve === true ? [] : String(opts.preserve).split(",");
  const explicitlyRequired = preserveAttrs.includes("context");
  if (explicitlyRequired && !selinuxEnabled) throw new InvocationError("cannot preserve security context without an SELinux-enabled kernel", 1, false);
  const requestedDefault = Boolean(opts.Z || opts.context === true);
  const explicitContext = typeof opts.context === "string" && selinuxEnabled ? opts.context : null;
  if (explicitlyRequired && (requestedDefault || explicitContext != null)) {
    throw new InvocationError("cannot set target context and preserve it", 1, false);
  }
  const preserveRequested = !noPreserve.some((attr) => attr === "all" || attr === "context")
    && (opts.a || opts.archive || preserveAttrs.includes("all") || explicitlyRequired);
  const preserveContext = selinuxEnabled && preserveRequested && !requestedDefault && explicitContext == null;
  const restoreContext = selinuxEnabled && requestedDefault;
  return {
    selinuxEnabled,
    preserveContext,
    // GNU creates with the source label before applying a pathname default.
    // If no default is defined, -Z therefore retains the source label.
    preserveContextAtCreation: preserveContext || restoreContext,
    requirePreserveContext: explicitlyRequired,
    restoreContext,
    explicitContext,
  };
}

export function validateCpPreserveList(value, option) {
  const valid = new Set(["mode", "timestamps", "ownership", "link", "links", "context", "xattr", "all"]);
  const attrs = [];
  for (const attr of value.split(",")) {
    if (attr === "") throw new InvocationError(cpPreserveInvalidMessage(attr, option, "ambiguous"), 1, true);
    if (!valid.has(attr)) throw new InvocationError(cpPreserveInvalidMessage(attr, option, "invalid"), 1, true);
    attrs.push(attr);
  }
  return attrs;
}

export function cpPreserveInvalidMessage(value, option, kind) {
  return `${kind} argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic(option)}\nValid arguments are:\n${CP_PRESERVE_VALID_ARGUMENTS.map((group) => `  - ${group.map(localeQuotedDiagnostic).join(", ")}`).join("\n")}`;
}

export function cpPreserveMetadata(opts) {
  const preserve = opts.p || opts.a || opts.archive || opts.preserve != null;
  if (!preserve) return false;
  if (cpNoPreserveAttrs(opts).includes("all")) return false;
  if (opts.preserve != null && !(opts.p || opts.a || opts.archive)) {
    const attrs = opts.preserve === true ? ["mode", "ownership", "timestamps"] : String(opts.preserve).split(",");
    return attrs.includes("all") || attrs.includes("ownership") || attrs.includes("timestamps");
  }
  return true;
}

export function cpNoPreserveAttrs(opts) {
  return String(opts["no-preserve"] ?? "").split(",").filter(Boolean);
}

export function cpPreserveLinks(opts) {
  if (cpNoPreserveAttrs(opts).includes("links")) return false;
  if (opts.d || opts.a || opts.archive) return true;
  if (opts.preserve == null) return false;
  const attrs = opts.preserve === true ? ["mode", "ownership", "timestamps"] : String(opts.preserve).split(",");
  return attrs.includes("all") || attrs.includes("links") || attrs.includes("link");
}

export function cpPreserveXattrs(opts) {
  if (cpNoPreserveAttrs(opts).some((attr) => attr === "all" || attr === "xattr")) return false;
  if (opts.a || opts.archive) return true;
  if (opts.preserve == null) return false;
  const attrs = opts.preserve === true ? ["mode", "ownership", "timestamps"] : String(opts.preserve).split(",");
  return attrs.includes("all") || attrs.includes("xattr");
}

export function cpRequirePreserveXattrs(opts) {
  if (opts.preserve == null || opts.preserve === true) return false;
  return String(opts.preserve).split(",").includes("xattr");
}

export function cpUseSourceModeForNewRegularFiles(opts) {
  return !cpNoPreserveAttrs(opts).some((attr) => attr === "all" || attr === "mode");
}

export function cpParents(opts) {
  return Boolean(opts.parents || opts.parent);
}

export function cpTargetPath(src, dest, useDirectoryTarget, opts) {
  if (cpParents(opts)) return join(dest, cpParentPath(src));
  return useDirectoryTarget ? join(dest, pathBasename(src.replace(/\/+$/, ""))) : dest;
}

export function rawCpPlan(opts, operands, useDirectoryTarget) {
  const raw = rawCommandArgs("cp");
  if (!raw) return null;
  const rawOperands = parseRawCpOperands(raw);
  if (rawOperands.length !== operands.length) return null;
  if (!rawOperands.some((operand, index) => rawPathNeedsBytes(operand) || !operand.equals(Buffer.from(operands[index])))) return null;
  if (useDirectoryTarget) return { sources: rawOperands.slice(0, -1), dest: rawOperands.at(-1), useDirectoryTarget: true };
  return { sources: rawOperands.slice(0, -1), dest: rawOperands.at(-1), useDirectoryTarget: false };
}

export function parseRawCpOperands(rawArgs) {
  const operands = [];
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
    if (["-t", "--target-directory", "--target", "--suffix", "-S"].includes(text)) {
      i++;
      continue;
    }
    if (/^(--target-directory|--target|--suffix|--backup|--preserve|--no-preserve|--update|--reflink|--sparse)=/.test(text)) continue;
    if (arg.length > 2 && arg[0] === 0x2d) {
      const letters = arg.toString().slice(1);
      const valueIndex = [...letters].findIndex((ch) => ch === "t" || ch === "S");
      if (valueIndex !== -1 && valueIndex === letters.length - 1) i++;
    }
  }
  return operands;
}

export function rawCpTargetPath(src, dest, useDirectoryTarget, opts) {
  if (cpParents(opts)) return bufferPathJoin(dest, Buffer.from(cpParentPath(pathDisplayName(src))));
  if (rawPathEndsWithSlashDot(src)) return dest;
  return useDirectoryTarget ? bufferPathJoin(dest, bufferPathBasename(stripTrailingSlashBytes(src))) : dest;
}

export function rawPathEndsWithSlashDot(path) {
  return path.length >= 2 && path[path.length - 2] === 0x2f && path[path.length - 1] === 0x2e;
}

export function stripTrailingSlashBytes(path) {
  let end = path.length;
  while (end > 1 && path[end - 1] === 0x2f) end--;
  return path.subarray(0, end);
}

export function stripTrailingDotPathBytes(path) {
  if (path.length >= 2 && path[path.length - 2] === 0x2f && path[path.length - 1] === 0x2e) return path.subarray(0, path.length - 2);
  return path;
}

export function rawPathKey(path) {
  return Buffer.from(path).toString("hex");
}

export async function resolveRawExistingPath(path) {
  if (await lstat(path).then(() => true, () => false)) return path;
  const absolute = path[0] === 0x2f;
  const parts = Buffer.from(path).toString("binary").split("/").map((part) => Buffer.from(part, "binary"));
  let current = absolute ? Buffer.from("/") : Buffer.from(".");
  for (const part of parts) {
    if (!part.length || part.equals(Buffer.from("."))) continue;
    if (part.equals(Buffer.from(".."))) {
      current = pathLikeJoin(current, part);
      continue;
    }
    const entries = await readdirPathEntries(current);
    const display = part.toString();
    let match = entries.find((entry) => Buffer.from(entry).equals(part) || pathDisplayName(entry) === display);
    if (!match && rawPathNeedsBytes(part)) {
      const candidates = entries.filter((entry) => rawPathNeedsBytes(entry));
      if (candidates.length === 1) match = candidates[0];
    }
    if (!match) return path;
    current = pathLikeJoin(current, match);
  }
  return current;
}

export function cpParentPath(src) {
  const stripped = String(src).replace(/^\/+/, "").replace(/\/+$/, "");
  return stripped || ".";
}

export async function ensureCpNotIntoSelf(src, target, noDereference) {
  const sourceInfo = noDereference ? await lstat(src).catch(() => null) : await stat(src).catch(() => null);
  if (!sourceInfo?.isDirectory()) return;
  const sourcePath = resolve(pathDisplayName(src));
  const targetPath = resolve(pathDisplayName(target));
  if (targetPath === sourcePath || targetPath.startsWith(`${sourcePath}/`)) {
    throw new UsageError(`cannot copy a directory, '${pathDisplayName(src)}', into itself, '${pathDisplayName(target)}'`);
  }
}

export async function cpSameFileIsError(src, target, opts, backupRequested) {
  if (opts.s || opts["symbolic-link"]) return !await cpTargetIsReplaceableSymlink(src, target);
  if (opts.l || opts.link) return false;
  if (backupRequested && (opts.d || opts["no-dereference"])) {
    const srcInfo = await lstat(src).catch(() => null);
    if (srcInfo?.isSymbolicLink() && src !== target) return false;
  }
  if (backupRequested && (opts.f || opts.force)) {
    const srcInfo = await lstat(src).catch(() => null);
    if (srcInfo && !srcInfo.isSymbolicLink()) return false;
    if (await cpTargetIsSymlink(target)) return false;
  }
  if (backupRequested && resolve(src) !== resolve(target)) {
    const srcInfo = await lstat(src).catch(() => null);
    if (srcInfo && !srcInfo.isSymbolicLink()) return false;
    if (await cpTargetIsSymlink(target)) return false;
  }
  if ((opts["remove-destination"] || opts.rem) && resolve(src) !== resolve(target)) {
    const srcInfo = await lstat(src).catch(() => null);
    if (srcInfo && !srcInfo.isSymbolicLink()) return false;
    if (await cpTargetIsSymlink(target)) return false;
  }
  return true;
}

export async function cpSameFile(src, target, opts) {
  if (opts.d || opts.P || opts["no-dereference"]) {
    const [srcInfo, targetInfo] = await Promise.all([lstat(src).catch(() => null), lstat(target).catch(() => null)]);
    if (srcInfo?.isSymbolicLink() && targetInfo?.isSymbolicLink()) return resolve(src) === resolve(target) && src === target;
  }
  return areSameFile(src, target);
}

export function validateReflinkMode(program, mode) {
  if (["auto", "always", "never"].includes(mode)) return;
  const kind = mode === "" ? "ambiguous" : "invalid";
  throw new UsageError(`${kind} argument ${localeQuotedEscapedDiagnostic(mode)} for ${localeQuotedDiagnostic("--reflink")}\nValid arguments are:\n  - ${localeQuotedDiagnostic("auto")}\n  - ${localeQuotedDiagnostic("always")}\n  - ${localeQuotedDiagnostic("never")}`, true);
}

export function validateSparseMode(program, mode) {
  if (["never", "auto", "always"].includes(mode)) return;
  const kind = mode === "" ? "ambiguous" : "invalid";
  throw new UsageError(`${kind} argument ${localeQuotedEscapedDiagnostic(mode)} for ${localeQuotedDiagnostic("--sparse")}\nValid arguments are:\n  - ${localeQuotedDiagnostic("never")}\n  - ${localeQuotedDiagnostic("auto")}\n  - ${localeQuotedDiagnostic("always")}`, true);
}

export async function cpHardLinkSameFileIsNoop(src, target, opts, backupRequested) {
  if (backupRequested && (opts.f || opts.force) && resolve(src) === resolve(target)) return false;
  const targetInfo = await lstat(target).catch(() => null);
  return Boolean(targetInfo && !targetInfo.isSymbolicLink());
}

export async function cpTargetIsSymlink(target) {
  return Boolean((await lstat(target).catch(() => null))?.isSymbolicLink());
}

export async function cpTargetIsReplaceableSymlink(src, target) {
  if (resolve(src) === resolve(target)) return false;
  return cpTargetIsSymlink(target);
}

export async function areSamePathEntry(a, b) {
  const [as, bs] = await Promise.all([lstat(a).catch(() => null), lstat(b).catch(() => null)]);
  return Boolean(as && bs && areSamePathStats(as, bs));
}

export function areSamePathStats(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

const singleCall = defineCommand("cp", cpCmd, cpMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
