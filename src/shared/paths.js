import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, basename as pathBasename, dirname as pathDirname, resolve } from "node:path";
import { pathDisplayName, shellEscapeLsName } from "./common.js";

export function readlinkQuotedName(path) {
  const name = pathDisplayName(path);
  return name === "" ? "''" : shellEscapeLsName(name);
}

export async function canonicalPath(path, opts = {}) {
  if (opts.s || opts.strip || opts["no-symlinks"]) return lexicalAbsolute(path);
  if (opts.L || opts.logical) return logicalCanonicalPath(path, opts);
  if (opts.m || opts["canonicalize-missing"]) return canonicalizeMissing(path);
  return physicalCanonicalPath(path, opts);
}

export async function logicalCanonicalPath(path, opts = {}) {
  const lexical = lexicalAbsolute(path);
  if (opts.m || opts["canonicalize-missing"] || opts.E) return lexical;
  if (opts.e || opts["canonicalize-existing"]) return realpath(lexical);
  try {
    return await realpath(lexical);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return join(await realpath(pathDirname(lexical)), pathBasename(lexical));
  }
}

export async function physicalCanonicalPath(path, opts = {}) {
  const mustExist = opts.e || opts["canonicalize-existing"];
  const allowMissingFinal = !mustExist;
  const allowMissingAny = opts.m || opts["canonicalize-missing"];
  const trailingSlash = /\/$/.test(path) && path !== "/";
  const absolute = isAbsolute(path) ? path : `${process.cwd().replace(/\/+$/, "")}/${path}`;
  const parts = absolute.split("/").filter(Boolean);
  let current = "/";
  let symlinkDepth = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === ".") continue;
    if (part === "..") {
      current = pathDirname(current.replace(/\/+$/, "") || "/");
      continue;
    }
    const candidate = join(current, part);
    let s;
    try {
      s = await lstat(candidate);
    } catch (error) {
      if (allowMissingAny) return normalize(join(candidate, ...parts.slice(i + 1)));
      if (allowMissingFinal && error.code === "ENOENT" && i === parts.length - 1) return candidate;
      throw error;
    }
    if (s.isSymbolicLink()) {
      if (++symlinkDepth > 40) {
        const error = new Error("Too many levels of symbolic links");
        error.code = "ELOOP";
        throw error;
      }
      const target = await readlink(candidate);
      const targetParts = target.split("/").filter(Boolean);
      const rest = parts.slice(i + 1);
      parts.splice(i, parts.length - i, ...targetParts, ...rest);
      if (isAbsolute(target)) current = "/";
      i--;
    } else {
      current = candidate;
    }
  }
  if (!allowMissingAny && trailingSlash && !(await stat(current).catch(() => null))?.isDirectory()) {
    const error = new Error("Not a directory");
    error.code = "ENOTDIR";
    throw error;
  }
  return current;
}

export async function canonicalizeMissing(path) {
  return physicalCanonicalPath(path, { m: true });
}

export function readlinkErrorMessage(error) {
  if (error?.code === "EINVAL") return "Invalid argument";
  if (error?.code === "ENOENT") return "No such file or directory";
  if (error?.code === "ENOTDIR") return "Not a directory";
  if (error?.code === "ELOOP") return "Too many levels of symbolic links";
  return error?.message || String(error);
}

export function lexicalAbsolute(path) {
  return normalize(isAbsolute(path) ? path : resolve(process.cwd(), path));
}
