import { chown, lchown, lstat, stat } from "node:fs/promises";
import { groupName, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, pathDisplayName, pathLikeJoin, readdirPathEntries, shellEscapeLsName, userNameForUid } from "./common.js";
import { UsageError, stderr, stdout } from "./diagnostics.js";
import { errnoMessage, invalidClusterOptionMessage, isAccessError, isRecursiveRootTarget, preserveRootError, preserveRootMessage, resolveGroup, resolveUser } from "./filesystem.js";

export const CHOWN_LONG_OPTIONS = ["changes", "recursive", "silent", "quiet", "dereference", "no-dereference", "from", "reference", "preserve-root", "no-preserve-root", "verbose", "help", "version"];

export function chownMetaOption(args) {
  const longValueOptions = new Set(["from", "reference"]);
  const longFlagOptions = new Set(["changes", "recursive", "silent", "quiet", "dereference", "no-dereference", "preserve-root", "no-preserve-root", "verbose"]);
  const shortFlagOptions = new Set(["R", "c", "f", "h", "H", "L", "P", "v"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeLongOptionByPrefix(arg, CHOWN_LONG_OPTIONS);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      return normalized;
    }
    if (longFlagOptions.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      continue;
    }
    if (name === "from") return null;
    if (longValueOptions.has(name)) {
      if (inlineValue === undefined) i++;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      if ([...arg.slice(1)].every((ch) => shortFlagOptions.has(ch))) continue;
      throw new UsageError(invalidClusterOptionMessage(arg, shortFlagOptions), true);
    }
    return null;
  }
  return null;
}

export function normalizeChownArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      out.push(...args.slice(i));
      break;
    }
    if (arg.startsWith("--")) {
      const normalized = normalizeLongOptionByPrefix(arg, CHOWN_LONG_OPTIONS);
      if ((normalized === "--from" || normalized === "--reference") && i + 1 < args.length) {
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

export function parseChownSpec(spec) {
  if (spec === "") return { ownerPart: "", groupPart: null, separator: null };
  const colon = spec.indexOf(":");
  const dot = spec.indexOf(".");
  let index = colon;
  let separator = ":";
  if (index === -1 || (dot !== -1 && dot < index)) index = dot;
  if (index === dot) separator = ".";
  if (index === -1) return { ownerPart: spec, groupPart: null, separator: null };
  const ownerPart = spec.slice(0, index);
  const groupPart = spec.slice(index + 1);
  if (/^\d+$/.test(ownerPart) && groupPart === "" && separator === ":") throw new UsageError(`invalid spec: ${localeQuotedEscapedDiagnostic(spec)}`);
  return { ownerPart, groupPart, separator };
}

export async function resolveChownOwnerGroupSpec(spec, options = {}) {
  const { ownerPart, groupPart, separator } = parseChownSpec(spec);
  if (separator === ".") {
    try {
      if (groupPart === "" && /^\d+$/.test(ownerPart)) throw new UsageError(`invalid user: ${localeQuotedEscapedDiagnostic(spec)}`);
      const uid = await resolveUser(ownerPart);
      const gid = groupPart == null ? null : await resolveGroup(groupPart);
      if (options.warnDot) stderr(`${options.warningCommand ?? "chown"}: warning: '.' should be ':': '${spec}'\n`);
      return { uid, gid };
    } catch {
      throw new UsageError(`invalid user: ${localeQuotedEscapedDiagnostic(spec)}`);
    }
  }
  let uid;
  try {
    uid = await resolveUser(ownerPart);
  } catch {
    if (groupPart === "") throw new UsageError(`invalid spec: ${localeQuotedEscapedDiagnostic(spec)}`);
    throw new UsageError(`invalid user: ${localeQuotedEscapedDiagnostic(spec)}`);
  }
  try {
    return { uid, gid: groupPart == null ? null : await resolveGroup(groupPart) };
  } catch {
    throw new UsageError(`invalid group: ${localeQuotedEscapedDiagnostic(spec)}`);
  }
}

export async function chownPath(path, uid, gid, recursive, options = { dereference: true }, isRoot = false, display = path) {
  let ok = true;
  const linkInfo = await lstat(path);
  let operationInfo = linkInfo;
  let traversalInfo = linkInfo;
  const isLink = linkInfo.isSymbolicLink();
  const followForTraversal = isLink && recursive && (options.traversal === "L" || (isRoot && options.traversal === "H"));
  // Recursive -P changes a symlink itself.  -H still dereferences symlinks for
  // the ownership operation, but only descends through a command-line one;
  // -L both dereferences and descends through every symlink.
  const shouldDereference = isLink && options.dereference && (!recursive || options.traversal !== "P");
  if (isLink && (shouldDereference || followForTraversal)) {
    try {
      const followedInfo = await stat(path);
      if (shouldDereference) operationInfo = followedInfo;
      if (followForTraversal) traversalInfo = followedInfo;
    } catch (error) {
      error.cannotDereference = true;
      throw error;
    }
  }
  if (recursive && options.preserveRoot && traversalInfo.isDirectory() && await isRecursiveRootTarget(path)) throw preserveRootError(options.command, path);
  const nextUid = uid ?? operationInfo.uid;
  const nextGid = gid ?? operationInfo.gid;
  const fromMatches = (options.fromUid == null || operationInfo.uid === options.fromUid) && (options.fromGid == null || operationInfo.gid === options.fromGid);
  if (recursive && traversalInfo.isDirectory() && (!isLink || followForTraversal)) {
    for (const entry of await readdirPathEntries(path)) {
      const childDisplay = `${String(display).replace(/\/+$/, "")}/${pathDisplayName(entry)}`;
      try {
        if (!(await chownPath(pathLikeJoin(path, entry), uid, gid, true, options, false, childDisplay))) ok = false;
      } catch (error) {
        ok = false;
        if (options.verbose) stdout(chownFailureVerboseLine(childDisplay, options));
        if (!options.silent) stderr(options.command === "chgrp" ? chgrpErrorLine(childDisplay, error) : chownErrorLine(childDisplay, error));
      }
    }
  }
  if (fromMatches) {
    if (isLink && !shouldDereference) await lchown(path, nextUid, nextGid);
    else await chown(path, nextUid, nextGid);
    const changed = operationInfo.uid !== nextUid || operationInfo.gid !== nextGid;
    if ((options.changes || options.verbose) && changed) stdout(await chownVerboseLine(options.command, display, operationInfo.uid, operationInfo.gid, nextUid, nextGid, options, true));
    else if (options.verbose) stdout(await chownVerboseLine(options.command, display, operationInfo.uid, operationInfo.gid, nextUid, nextGid, options, false));
  } else if (options.verbose) {
    stdout(await chownVerboseLine(options.command, display, operationInfo.uid, operationInfo.gid, operationInfo.uid, operationInfo.gid, options, false));
  }
  return ok;
}

export function chownFailureVerboseLine(path, options) {
  const kind = options.failureKind === "group" ? "group" : "ownership";
  const suffix = options.failureSpec == null || options.failureSpec === "" ? "" : ` to ${options.failureSpec}`;
  return `failed to change ${kind} of ${chownQuotedName(path)}${suffix}\n`;
}

export async function chownVerboseLine(command, path, beforeUid, beforeGid, afterUid, afterGid, options, changed) {
  if (command === "chgrp") {
    const before = await groupName(beforeGid);
    const after = await groupName(afterGid);
    return changed ? `changed group of ${chownQuotedName(path)} from ${before} to ${after}\n` : `group of ${chownQuotedName(path)} retained as ${after}\n`;
  }
  const before = await chownOwnershipDisplay(beforeUid, beforeGid, options);
  const after = await chownOwnershipDisplay(afterUid, afterGid, options);
  if (changed) return `changed ownership of ${chownQuotedName(path)}${before ? ` from ${before}` : ""}${after ? ` to ${after}` : ""}\n`;
  return `ownership of ${chownQuotedName(path)} retained${after ? ` as ${after}` : ""}\n`;
}

export async function chownOwnershipDisplay(uid, gid, options) {
  const parts = [];
  if (options.reportUid) parts.push(await userNameForUid(uid) ?? String(uid));
  if (options.reportGid) parts.push(await groupName(gid));
  return parts.join(":");
}

export function chownErrorLine(path, error) {
  if (error?.preserveRoot) return preserveRootMessage("chown", error.path, error.rootPath);
  if (error?.cannotDereference) return `chown: cannot dereference ${chownQuotedName(path)}: ${errnoMessage(error)}\n`;
  if (isAccessError(error)) return `chown: cannot access ${chownQuotedName(path)}: ${errnoMessage(error)}\n`;
  return `chown: changing ownership of ${chownQuotedName(path)}: ${errnoMessage(error)}\n`;
}

export function chgrpErrorLine(path, error) {
  if (error?.preserveRoot) return preserveRootMessage("chgrp", error.path, error.rootPath);
  if (error?.cannotDereference) return `chgrp: cannot dereference ${chownQuotedName(path)}: ${errnoMessage(error)}\n`;
  if (isAccessError(error)) return `chgrp: cannot access ${chownQuotedName(path)}: ${errnoMessage(error)}\n`;
  return `chgrp: changing group of ${chownQuotedName(path)}: ${errnoMessage(error)}\n`;
}

export function chownQuotedName(path) {
  return shellEscapeLsName(pathDisplayName(path), true);
}
