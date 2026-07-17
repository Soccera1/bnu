#!/usr/bin/env bun

import { closeSync, existsSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import { lstat, open, stat, writeFile } from "node:fs/promises";
import { dirname as pathDirname } from "node:path";
import { SEEK_SET, cstrPath, headTailDiagnosticName, isWriteError, libc, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, nodeErrorMessage, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions, pathLikeJoin, readAll, readFdChunkViews, readdirPathEntries, systemErrorMessage } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { headTailHeaderMode, headTailShouldPrintHeader, isTailStreamingDevice, normalizeHeadTailArgs, parseByteCount, splitDelimitedByteRecords, tailFirstBytes } from "../shared/head-tail.js";
import { POLLERR, POLLHUP, POLLNVAL, POLLOUT, pollFd, readStdinChunks } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const SEEK_END = 2;

export const POLLIN = 0x001;

export const IN_MODIFY = 0x00000002;

export const IN_ATTRIB = 0x00000004;

export const IN_CLOSE_WRITE = 0x00000008;

export const IN_MOVED_FROM = 0x00000040;

export const IN_MOVED_TO = 0x00000080;

export const IN_CREATE = 0x00000100;

export const IN_DELETE = 0x00000200;

export const IN_DELETE_SELF = 0x00000400;

export const IN_MOVE_SELF = 0x00000800;

export const TAIL_LONG_OPTIONS = ["bytes", "debug", "follow", "lines", "max-unchanged-stats", "pid", "quiet", "retry", "silent", "sleep-interval", "verbose", "zero-terminated", "help", "version"];

export function tailMetaOption(args) {
  const longValueOptions = new Set(["bytes", "lines", "sleep-interval", "max-unchanged-stats", "pid"]);
  const longOptionalValueOptions = new Set(["follow"]);
  const shortValueOptions = new Set(["c", "n", "s"]);
  const shortKnownOptions = new Set(["c", "n", "q", "v", "z", "f", "F", "s"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeTailLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!TAIL_LONG_OPTIONS.includes(name) && name !== "-disable-inotify") return null;
      if (name === "follow" && inlineValue != null && !["descriptor", "name"].includes(inlineValue)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (longValueOptions.has(name)) {
        const value = inlineValue ?? args[i + 1];
        if (value !== undefined) {
          if (name === "bytes") parseTailCount(value, 10, true);
          if (name === "lines") parseTailCount(value, 10, false);
          if (name === "sleep-interval") parseTailSleepInterval(value);
          if (name === "pid" && !/^\d*$/.test(value)) throw new UsageError(`invalid PID: ${localeQuotedEscapedDiagnostic(value)}`);
        }
        if (inlineValue == null) i++;
      }
      else if (inlineValue == null && longOptionalValueOptions.has(name)) continue;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    if (/^-\d/.test(arg) || /^\+\d/.test(arg)) continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        const value = inlineValue === "" ? args[i + 1] : inlineValue;
        if (value !== undefined) {
          if (ch === "s") parseTailSleepInterval(value);
          else parseTailCount(value, 10, ch === "c");
        }
        if (inlineValue === "") i++;
        break;
      }
    }
  }
  return null;
}

export async function tail(args) {
  args = normalizeHeadTailArgs(normalizeTailLongOptions(args), "tail");
  const pidList = tailPidList(args);
  const headerMode = headTailHeaderMode(args);
  const { opts, operands } = parseOptions(args, { short: { n: "value", c: "value", q: false, v: false, z: false, f: false, F: false, s: "value" }, long: { lines: "value", bytes: "value", quiet: false, silent: false, verbose: false, "zero-terminated": false, follow: "optional-value", sleep: "value", "sleep-interval": "value", "max-unchanged-stats": "value", pid: "value", retry: false, debug: false, "-disable-inotify": false, help: false, version: false } });
  const files = operands.length ? operands : ["-"];
  const bytesMode = opts.c ?? opts.bytes;
  const count = parseTailCount(bytesMode ?? opts.n ?? opts.lines, 10, bytesMode != null);
  const rawCount = String(bytesMode ?? opts.n ?? opts.lines ?? "");
  const delimiter = opts.z || opts["zero-terminated"] ? "\0" : "\n";
  const follow = opts.f || opts.F || opts.follow != null;
  const followMode = opts.F ? "name" : opts.follow === true ? "descriptor" : opts.follow ?? (opts.f ? "descriptor" : null);
  if (followMode != null && !["descriptor", "name"].includes(followMode)) {
    const kind = followMode === "" ? "ambiguous" : "invalid";
    throw new UsageError(`${kind} argument ${localeQuotedDiagnostic(followMode)} for ${localeQuotedDiagnostic("--follow")}\nValid arguments are:\n  - ${localeQuotedDiagnostic("descriptor")}\n  - ${localeQuotedDiagnostic("name")}`, true);
  }
  const followByName = followMode === "name";
  const retryInitialOpen = opts.retry || opts.F;
  const sleepInterval = parseTailSleepInterval(opts.s ?? opts.sleep ?? opts["sleep-interval"]);
  parseTailMaxUnchangedStats(opts["max-unchanged-stats"]);
  if (opts.retry && !follow) stderr("tail: warning: --retry ignored; --retry is useful only when following\n");
  if (follow && files.includes("-") && process.env.BNU_STDIN_CLOSED === "1") {
    stderr("tail: cannot fstat 'standard input'\n");
    stderr("tail: no files remaining\n");
    return 1;
  }
  if (count === 0 && !follow && !rawCount.startsWith("+")) return 0;
  const followOffsets = new Map();
  const followIdentities = new Map();
  const followInaccessible = new Map();
  const followFiles = [];
  let followHasNonRegular = false;
  let renderedAnyFile = false;
  let lastOutputFile = null;
  let failed = false;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const header = headTailShouldPrintHeader(headerMode, files.length) ? `${renderedAnyFile ? "\n" : ""}==> ${tailDisplayName(file)} <==\n` : "";
    const rawBytes = bytesMode == null ? "" : String(bytesMode);
    if (!follow && file === "-" && bytesMode != null && rawBytes.startsWith("+")) {
      if (header) stdout(header);
      let skip = Math.max(0, tailStartOffset(count));
      readStdinChunks((chunk) => {
        if (skip >= chunk.length) {
          skip -= chunk.length;
          return;
        }
        stdout(skip > 0 ? chunk.slice(skip) : chunk);
        skip = 0;
      });
      renderedAnyFile = true;
      continue;
    }
    if (!follow && file === "-" && bytesMode == null && rawCount.startsWith("+")) {
      if (header) stdout(header);
      readTailFdFromRecord(0, count, delimiter);
      renderedAnyFile = true;
      continue;
    }
    if (!follow && file !== "-" && bytesMode == null && rawCount.startsWith("+") && await isTailStreamingDevice(file)) {
      if (header) stdout(header);
      let fd;
      try {
        fd = openSync(file, "r");
        readTailFdFromRecord(fd, count, delimiter);
        renderedAnyFile = true;
      } catch (error) {
        if (isWriteError(error)) throw error;
        stderr(`tail: error reading ${headTailDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
        failed = true;
      } finally {
        if (fd != null) closeSync(fd);
      }
      continue;
    }
    if (bytesMode != null && file !== "-" && await isTailBlockDevice(file)) {
      if (header) stdout(header);
      try {
        await tailBlockDeviceBytes(file, count, rawBytes.startsWith("+"));
      } catch (error) {
        stderr(`tail: error reading ${headTailDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
        failed = true;
      }
      continue;
    }
    if (bytesMode != null && file !== "-" && !rawBytes.startsWith("+") && await isTailStreamingDevice(file)) {
      if (header) stdout(header);
      try {
        await tailFirstBytes(file, count);
      } catch (error) {
        stderr(`tail: error reading ${headTailDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
        failed = true;
      }
      continue;
    }
    if (follow && file === "-") {
      try {
        fstatSync(0);
      } catch {
        stderr("tail: cannot fstat 'standard input'\n");
        failed = true;
        continue;
      }
    }
    const fileInfo = file === "-" ? null : await stat(file).catch(() => null);
    if (follow && (!fileInfo || !fileInfo.isFile())) followHasNonRegular = true;
    if (follow && pidList.length && fileInfo?.isFIFO?.()) {
      followOffsets.set(file, 0);
      followIdentities.set(file, await tailFollowIdentity(file, followByName));
      followFiles.push(file);
      renderedAnyFile = true;
      continue;
    }
    if (retryInitialOpen && fileInfo?.isDirectory()) {
      stderr(`tail: cannot follow ${headTailDiagnosticName(file)}: Is a directory\n`);
      // -F retries an initially untailable name.  Report its inaccessible
      // state now, rather than waiting for the first polling cycle: callers
      // (and GNU's follow protocol) need both diagnostics before a rapid
      // directory-to-file replacement can occur.
      if (followByName) stderr(`tail: ${headTailDiagnosticName(file)} has become inaccessible: Is a directory\n`);
      failed = true;
      followFiles.push(file);
      followOffsets.set(file, null);
      followIdentities.set(file, await tailFollowIdentity(file, followByName));
      if (!followByName) followInaccessible.set(file, "Is a directory");
      continue;
    }
    let data;
    try {
      data = await readAll(file);
    } catch (error) {
      if (error?.code === "EISDIR") {
        if (header) stdout(header);
        renderedAnyFile = true;
        stderr(`tail: error reading ${headTailDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      } else {
        stderr(file === "-" ? `tail: ${nodeErrorMessage(error)}\n` : `tail: cannot open ${headTailDiagnosticName(file)} for reading: ${systemErrorMessage(error)}\n`);
      }
      failed = true;
      if (retryInitialOpen && file !== "-") {
        followFiles.push(file);
        followOffsets.set(file, null);
        followIdentities.set(file, null);
      }
      continue;
    }
    followOffsets.set(file, data.length);
    followIdentities.set(file, await tailFollowIdentity(file, followByName));
    if (file !== "-") followFiles.push(file);
    if (header) {
      stdout(header);
      lastOutputFile = file;
    }
    renderedAnyFile = true;
    if (bytesMode != null) {
      stdout(rawBytes.startsWith("+") ? data.slice(Math.max(0, tailStartOffset(count))) : data.slice(Math.max(0, data.length - count)));
    } else {
      const raw = String(opts.n ?? opts.lines ?? "");
      const lines = splitDelimitedByteRecords(data, delimiter);
      stdout(raw.startsWith("+") ? Buffer.concat(lines.slice(Math.max(0, tailStartOffset(count)))) : count === 0 ? "" : Buffer.concat(lines.slice(-count)));
    }
  }
  if (follow && followFiles.length) {
    if (opts.retry && followMode === "descriptor") stderr("tail: warning: --retry only effective for the initial open\n");
    if (opts.debug) {
      // Descriptor-following a device uses its blocking read semantics;
      // regular files use inotify unless explicitly disabled, while
      // name-following non-regular files must poll.
      const mode = opts["-disable-inotify"]
        ? "polling"
        : followHasNonRegular
          ? followByName ? "polling" : "blocking"
          : "notification";
      stderr(`tail: using ${mode} mode\n`);
    }
    const followStatus = await followTailFiles(followFiles, followOffsets, {
      followByName,
      inotifyMode: !opts["-disable-inotify"],
      retryInitialOpen,
      identities: followIdentities,
      inaccessible: followInaccessible,
      interval: sleepInterval,
      headers: (opts.v || opts.verbose || files.length > 1) && !(opts.q || opts.quiet || opts.silent),
      lastOutputFile,
      pids: pidList,
    });
    if (followStatus !== 0) return followStatus;
  } else if (follow && failed) {
    stderr("tail: no files remaining\n");
  }
  return failed ? 1 : 0;
}

export async function followTailFiles(files, offsets, options) {
  const removedParentDirs = new Set();
  const inotify = options.inotifyMode ? tailInotifyOpen(files, options.followByName) : null;
  if (!inotify) options.inotifyMode = false;
  await tailTestPauseBeforeInotifyScan();
  try {
    while (true) {
    if (options.pids?.length && !options.pids.some(tailPidAlive)) return 0;
    if (pollFd(1, POLLOUT) & (POLLERR | POLLHUP | POLLNVAL)) return 0;
    const iterationFiles = inotify?.pendingFiles?.length ? inotify.pendingFiles.splice(0) : files;
    for (const file of iterationFiles) {
      let actualFile = file;
      let identity = await tailFollowIdentity(file, options.followByName);
      let s = await stat(file).catch(() => null);
      if (!s && !options.followByName && options.identities?.get(file) != null) {
        actualFile = await findTailMovedPath(file, options.identities.get(file)) ?? file;
        if (actualFile !== file) {
          identity = await tailFollowIdentity(actualFile, false);
          s = await stat(actualFile).catch(() => null);
        }
      }
      tailInotifyUpdateFile(inotify, file, s, identity);
      if (!s || s.isDirectory()) {
        if (offsets.get(file) === null && s?.isDirectory() && !options.followByName) {
          stderr(`tail: ${headTailDiagnosticName(file)} has been replaced with an untailable file\n`);
          stderr("tail: no files remaining\n");
          return 1;
        }
        if (options.followByName && options.identities?.get(file) != null && offsets.get(file) !== null) {
          stderr(`tail: ${headTailDiagnosticName(file)} has become inaccessible: ${s?.isDirectory() ? "Is a directory" : "No such file or directory"}\n`);
          if (options.inotifyMode && !s && !removedParentDirs.has(pathDirname(String(file))) && !(await lstat(pathDirname(String(file))).catch(() => null))) {
            removedParentDirs.add(pathDirname(String(file)));
            stderr("tail: directory containing watched file was removed\n");
            stderr("tail: inotify cannot be used, reverting to polling\n");
          }
          if (!s && !options.retryInitialOpen && await findTailMovedPath(file, options.identities.get(file))) {
            stderr("tail: no files remaining\n");
            return 1;
          }
          offsets.set(file, null);
          options.identities.set(file, null);
        } else if (options.followByName && offsets.get(file) === null && s?.isDirectory() && options.inaccessible?.has(file)) {
          stderr(`tail: ${headTailDiagnosticName(file)} has become inaccessible: ${options.inaccessible.get(file)}\n`);
          options.inaccessible.delete(file);
        }
        continue;
      }
      let offset = offsets.has(file) ? offsets.get(file) : 0;
      const previousIdentity = options.identities?.get(file);
      if (offset === null) {
        if (options.inaccessible?.has(file)) {
          stderr(`tail: ${headTailDiagnosticName(file)} has become inaccessible: ${options.inaccessible.get(file)}\n`);
          options.inaccessible.delete(file);
        }
        stderr(`tail: ${headTailDiagnosticName(file)} has appeared;  following new file\n`);
        offset = 0;
      } else if (options.followByName && previousIdentity != null && identity != null && previousIdentity !== identity) {
        stderr(`tail: ${headTailDiagnosticName(file)} has been replaced; following new file\n`);
        offset = 0;
      } else if (s.size < offset) {
        stderr(`tail: ${headTailDiagnosticName(file)}: file truncated\n`);
        offset = 0;
      }
      if (s.size <= offset) {
        offsets.set(file, offset);
        if (identity != null) options.identities?.set(file, identity);
        continue;
      }
      if (options.headers && options.lastOutputFile !== file) {
        stdout(`${options.lastOutputFile == null ? "" : "\n"}==> ${tailDisplayName(file)} <==\n`);
        options.lastOutputFile = file;
      }
      await writeFileRange(actualFile, offset, s.size - offset);
      offsets.set(file, s.size);
      if (identity != null) options.identities?.set(file, identity);
    }
      if (inotify) tailInotifyWait(inotify, options.interval);
      else await Bun.sleep(options.interval);
    }
  } finally {
    tailInotifyClose(inotify);
  }
}

export async function tailTestPauseBeforeInotifyScan() {
  const ready = process.env.BNU_TAIL_INOTIFY_READY_FILE;
  const proceed = process.env.BNU_TAIL_INOTIFY_CONTINUE_FILE;
  if (!ready || !proceed) return;
  await writeFile(ready, "ready\n");
  const deadline = Date.now() + 30_000;
  while (!existsSync(proceed)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the inotify race test continuation marker");
    await Bun.sleep(10);
  }
}

export function tailInotifyOpen(files, followByName) {
  let fd;
  try {
    fd = libc.symbols.inotify_init1(fsConstants.O_NONBLOCK | fsConstants.O_CLOEXEC);
  } catch {
    return null;
  }
  if (fd < 0) return null;
  const state = { fd, files: new Map(), parents: new Map(), pendingFiles: [] };
  if (followByName) {
    for (const file of files) {
      const parent = pathDirname(String(file));
      if (state.parents.has(parent)) continue;
      const wd = libc.symbols.inotify_add_watch(fd, cstrPath(parent), IN_CREATE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO | IN_ATTRIB);
      if (wd >= 0) state.parents.set(parent, wd);
    }
  }
  return state;
}

export function tailInotifyUpdateFile(state, file, statInfo, identity) {
  if (!state) return;
  const current = state.files.get(file);
  const watchable = statInfo && (statInfo.isFile() || statInfo.isFIFO());
  if (current && (!watchable || current.identity !== identity)) {
    libc.symbols.inotify_rm_watch(state.fd, current.wd);
    state.files.delete(file);
  }
  if (!watchable || state.files.has(file)) return;
  const wd = libc.symbols.inotify_add_watch(state.fd, cstrPath(file), IN_MODIFY | IN_ATTRIB | IN_CLOSE_WRITE | IN_DELETE_SELF | IN_MOVE_SELF);
  if (wd >= 0) state.files.set(file, { wd, identity });
}

export function tailInotifyWait(state, timeout) {
  if (!(pollFd(state.fd, POLLIN, timeout) & POLLIN)) return;
  const events = Buffer.allocUnsafe(64 * 1024);
  try {
    const bytesRead = readSync(state.fd, events, 0, events.length, null);
    for (let offset = 0; offset + 16 <= bytesRead;) {
      const wd = events.readInt32LE(offset);
      const nameLength = events.readUInt32LE(offset + 12);
      for (const [file, watch] of state.files) {
        if (watch.wd === wd && state.pendingFiles.at(-1) !== file) {
          state.pendingFiles.push(file);
          break;
        }
      }
      offset += 16 + nameLength;
    }
  } catch (error) {
    if (error?.code !== "EAGAIN") throw error;
  }
}

export function tailInotifyClose(state) {
  if (!state) return;
  for (const { wd } of state.files.values()) libc.symbols.inotify_rm_watch(state.fd, wd);
  for (const wd of state.parents.values()) libc.symbols.inotify_rm_watch(state.fd, wd);
  closeSync(state.fd);
}

export function tailPidList(args) {
  const pids = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value = null;
    if (arg === "--pid") value = args[++i];
    else if (arg.startsWith("--pid=")) value = arg.slice("--pid=".length);
    if (value == null) continue;
    if (value === "") {
      pids.push(0);
      continue;
    }
    if (!/^\d+$/.test(value)) throw new UsageError(`invalid PID: ${localeQuotedEscapedDiagnostic(value)}`);
    pids.push(Number(value));
  }
  return pids;
}

export function normalizeTailLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, TAIL_LONG_OPTIONS);
}

export function normalizeTailLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, TAIL_LONG_OPTIONS);
}

export function tailPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tailDisplayName(file) {
  return file === "-" ? "standard input" : file;
}

export async function tailFollowIdentity(file, followByName = true) {
  const s = await (followByName ? lstat(file) : stat(file)).catch(() => null);
  return s ? `${s.dev}:${s.ino}` : null;
}

export async function findTailMovedPath(file, identity) {
  const dir = pathDirname(String(file));
  for (const entry of await readdirPathEntries(dir).catch(() => [])) {
    const candidate = pathLikeJoin(dir, entry);
    if (candidate === file) continue;
    if (await tailFollowIdentity(candidate, false) === identity) return candidate;
  }
  return null;
}

export async function writeFileRange(file, offset, length) {
  const handle = await open(file, "r");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, length));
  let position = offset;
  let remaining = length;
  try {
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), position);
      if (bytesRead === 0) break;
      stdout(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

export function parseTailSleepInterval(value) {
  if (value == null || value === true) return 1000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError(`invalid number of seconds: ${localeQuotedEscapedDiagnostic(value)}`);
  return Math.max(1, Math.trunc(seconds * 1000));
}

export function parseTailMaxUnchangedStats(value) {
  if (value == null) return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new UsageError(`invalid maximum number of unchanged stats between opens: ${localeQuotedEscapedDiagnostic(text)}`);
  return Number(text);
}

export async function isTailBlockDevice(file) {
  const s = await stat(file).catch(() => null);
  return Boolean(s?.isBlockDevice?.());
}

export async function tailBlockDeviceBytes(file, count, fromStart) {
  const handle = await open(file, "r");
  try {
    const end = libc.symbols.lseek(handle.fd, 0n, SEEK_END);
    if (end < 0n) throw new Error("cannot seek to end of device");
    const requested = BigInt(Math.max(0, count));
    const start = fromStart
      ? BigInt(Math.max(0, tailStartOffset(count)))
      : end > requested ? end - requested : 0n;
    const boundedStart = start > end ? end : start;
    if (libc.symbols.lseek(handle.fd, boundedStart, SEEK_SET) < 0n) throw new Error("cannot seek on device");
    let remaining = end - boundedStart;
    const buffer = Buffer.allocUnsafe(Number(remaining > 64n * 1024n ? 64n * 1024n : remaining || 1n));
    while (remaining > 0n) {
      const wanted = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining);
      const { bytesRead } = await handle.read(buffer, 0, wanted, null);
      if (bytesRead === 0) break;
      stdout(buffer.subarray(0, bytesRead));
      remaining -= BigInt(bytesRead);
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

export function parseTailCount(value, defaultValue, bytesMode) {
  if (value == null) return defaultValue;
  const text = String(value);
  const countText = text.replace(/^[+-]/, "");
  let count;
  try {
    count = parseByteCount(countText);
  } catch (error) {
    if (error instanceof UsageError) throw new UsageError(`invalid number of ${bytesMode ? "bytes" : "lines"}: ${localeQuotedEscapedDiagnostic(countText)}`);
    throw error;
  }
  if (!Number.isFinite(count) || count < 0) throw new UsageError(`invalid number of ${bytesMode ? "bytes" : "lines"}: ${localeQuotedEscapedDiagnostic(countText)}`);
  return Math.trunc(count);
}

export function tailStartOffset(count) {
  return Math.max(0, count - 1);
}

export function readTailFdFromRecord(fd, count, delimiter) {
  const targetRecord = tailStartOffset(count);
  const sep = delimiter.charCodeAt(0);
  let seen = 0;
  let emitting = targetRecord === 0;
  readFdChunkViews(fd, (chunk) => {
    if (emitting) {
      stdout(chunk);
      return;
    }
    let offset = 0;
    while (offset < chunk.length) {
      if (chunk[offset] === sep) {
        seen++;
        if (seen >= targetRecord) {
          stdout(chunk.subarray(offset + 1));
          emitting = true;
          return;
        }
      }
      offset++;
    }
  });
}

const singleCall = defineCommand("tail", tail, tailMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
