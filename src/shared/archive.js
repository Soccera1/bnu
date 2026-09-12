import { chmodSync, chownSync, constants, closeSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cstr, libc, libcErrno } from "./common.js";

export const padTo = (size, alignment) => (alignment - size % alignment) % alignment;

export function archiveName(name, absolute = false) {
  if (name.includes("\0")) throw new Error("file name contains a null byte");
  return absolute ? name : name.replace(/^\/+/, "");
}

export function filesystemEntry(path, name, dereference = false) {
  const info = (dereference ? statSync : lstatSync)(path);
  const type = info.isDirectory() ? "5" : info.isSymbolicLink() ? "2" : info.isFile() ? "0" : info.isFIFO() ? "6" : "?";
  if (type === "?") throw new Error(`${path}: unsupported file type`);
  return { path, name: type === "5" && !name.endsWith("/") ? `${name}/` : name,
    type, mode: info.mode & 0o7777, fullMode: info.mode, uid: info.uid, gid: info.gid,
    mtime: info.mtimeMs / 1000, atime: info.atimeMs / 1000, ino: info.ino, dev: info.dev,
    nlink: info.nlink, size: type === "0" ? info.size : 0,
    linkname: type === "2" ? readlinkSync(path) : "", info };
}

export function collectEntries(operands, options = {}) {
  const entries = [], links = new Map(), ancestors = new Set();
  const visit = (path, name) => {
    if (options.exclude?.(name)) return;
    if (options.archivePath && resolve(path) === options.archivePath) return;
    const entry = filesystemEntry(path, name, options.dereference);
    const key = `${entry.dev}:${entry.ino}`;
    if (options.archiveIdentity === key) return;
    if (entry.type === "0" && entry.nlink > 1 && options.hardlinks !== false) {
      if (links.has(key)) { entry.type = "1"; entry.linkname = links.get(key); entry.size = 0; }
      else links.set(key, name);
    }
    if (entry.type === "0") entry.data = readFileSync(path);
    else entry.data = Buffer.alloc(0);
    entries.push(entry);
    if (entry.type === "5" && options.recursive !== false) {
      if (ancestors.has(key)) throw new Error(`${path}: directory cycle detected`);
      ancestors.add(key);
      for (const child of readdirSync(path).sort()) visit(join(path, child), `${entry.name}${child}`);
      ancestors.delete(key);
    }
  };
  for (const operand of operands) visit(operand.path, operand.name);
  return entries;
}

function within(root, target) {
  const part = relative(root, target);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

// Never traverse existing symlinks, including links created by earlier members.
// Unlink existing regular files before writing so extraction cannot modify a
// hard-linked file outside the destination tree.
export function safeArchivePath(root, name, makeParents = true) {
  if (!name || name.includes("\0") || isAbsolute(name) || name.split("/").includes("..")) throw new Error(`${name}: unsafe archive path`);
  const target = resolve(root, name);
  if (!within(root, target)) throw new Error(`${name}: unsafe archive path`);
  if (target === root) return target;
  let parent = root;
  for (const component of relative(root, dirname(target)).split(sep).filter(Boolean)) {
    parent = join(parent, component);
    let info;
    try { info = lstatSync(parent); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!makeParents) throw error;
      mkdirSync(parent, { mode: 0o700 });
      info = lstatSync(parent);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name}: refusing to traverse non-directory or symbolic link`);
  }
  return target;
}

export function extractEntries(entries, destination, options = {}) {
  const root = resolve(destination);
  if (!statSync(root).isDirectory()) throw new Error(`${destination}: Not a directory`);
  const directories = [], deferred = [], extracted = new Set();
  const metadata = (entry, path) => {
    if (options.owner) chownSync(path, entry.uid, entry.gid);
    chmodSync(path, options.permissions ? entry.mode : entry.mode & ~process.umask());
    if (options.mtime !== false) utimesSync(path, entry.atime ?? entry.mtime, entry.mtime);
  };
  const extract = (entry, retry = false) => {
    const path = safeArchivePath(root, entry.name, options.makeParents !== false);
    if (path === root && entry.type !== "5") throw new Error(`${entry.name}: cannot replace extraction directory`);
    let previous;
    try { previous = lstatSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous && options.keepOld) throw new Error(`${entry.name}: File exists`);
    if (previous && (options.skipOld || (options.newer && previous.mtimeMs / 1000 >= entry.mtime))) return;
    if (entry.type === "5") {
      if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) throw new Error(`${entry.name}: cannot replace file with directory`);
      if (!previous) mkdirSync(path, { mode: 0o700 });
      directories.push([entry, path]);
    } else if (entry.type === "1") {
      const source = resolve(root, entry.linkname);
      if (!within(root, source) || isAbsolute(entry.linkname) || entry.linkname.split("/").includes("..")) throw new Error(`${entry.name}: unsafe hard link target`);
      if (!extracted.has(source)) {
        if (retry) throw new Error(`${entry.name}: hard link target '${entry.linkname}' was not extracted`);
        deferred.push(entry);
        return;
      }
      safeArchivePath(root, entry.linkname, false);
      const info = lstatSync(source);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${entry.name}: unsafe hard link target`);
      if (previous) unlinkSync(path);
      linkSync(source, path);
    } else if (entry.type === "2") {
      if (entry.linkname.includes("\0") || isAbsolute(entry.linkname) || !within(root, resolve(dirname(path), entry.linkname))) throw new Error(`${entry.name}: unsafe symbolic link target '${entry.linkname}'`);
      if (previous) unlinkSync(path);
      symlinkSync(entry.linkname, path);
    } else if (entry.type === "6") {
      if (previous) unlinkSync(path);
      if (libc.symbols.mkfifo(cstr(path), 0o600) !== 0) throw new Error(`${entry.name}: cannot create FIFO (errno ${libcErrno()})`);
      metadata(entry, path);
    } else if (["0", "\0", "7"].includes(entry.type)) {
      if (options.linkSources && resolve(entry.path) === path) throw new Error(`${entry.name}: source and destination are the same file`);
      if (previous) unlinkSync(path);
      if (options.linkSources) linkSync(entry.path, path);
      else {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, entry.data); } finally { closeSync(fd); }
        metadata(entry, path);
      }
    } else throw new Error(`${entry.name}: unsupported archive member type '${entry.type}'`);
    extracted.add(path);
    options.onEntry?.(entry);
  };
  for (const entry of entries) extract(entry);
  for (let remaining = deferred; remaining.length;) {
    const ready = remaining.filter(entry => extracted.has(resolve(root, entry.linkname)));
    if (!ready.length) throw new Error(`${remaining[0].name}: hard link target '${remaining[0].linkname}' was not extracted`);
    for (const entry of ready) extract(entry, true);
    remaining = remaining.filter(entry => !ready.includes(entry));
  }
  for (const [entry, path] of directories.reverse()) metadata(entry, path);
}

export function archiveListing(entry) {
  const type = { "5": "d", "2": "l", "1": "h", "6": "p" }[entry.type] ?? "-";
  let mode = type;
  for (let shift = 6; shift >= 0; shift -= 3) for (const [mask, char] of [[4, "r"], [2, "w"], [1, "x"]]) mode += entry.mode >> shift & mask ? char : "-";
  const date = new Date(entry.mtime * 1000).toISOString().slice(0, 16).replace("T", " ");
  return `${mode} ${entry.uid}/${entry.gid} ${String(entry.size ?? entry.data?.length ?? 0).padStart(9)} ${date} ${entry.name}${entry.type === "2" ? ` -> ${entry.linkname}` : entry.type === "1" ? ` link to ${entry.linkname}` : ""}`;
}
