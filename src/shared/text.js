import { fstatSync, readSync, statSync } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SEEK_CUR, displayWidth, libc, pathDisplayName, shellEscapeLsName } from "./common.js";
import { stdout } from "./diagnostics.js";

export const POLLOUT = 0x004;

export const POLLERR = 0x008;

export const POLLHUP = 0x010;

export const POLLNVAL = 0x020;

export async function spoolInputToTemporaryFile(input, prefix, initialChunks = []) {
  const base = process.env.TMPDIR || "/tmp";
  const dir = await mkdtemp(join(base, `${prefix}-`));
  const path = join(dir, "data");
  const source = input === "-" ? null : await open(input, "r");
  let target;
  try {
    target = await open(path, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const writeChunk = async (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset, null);
        if (bytesWritten === 0) throw new Error("short write while spooling input");
        offset += bytesWritten;
      }
    };
    for (const chunk of initialChunks) await writeChunk(chunk);
    while (true) {
      const n = readSync(source?.fd ?? 0, buffer, 0, buffer.length, null);
      if (n === 0) break;
      await writeChunk(buffer.subarray(0, n));
    }
    await target.close();
    target = null;
    return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await target?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await source?.close().catch(() => {});
  }
}

export function readStdinChunks(accept) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  while (true) {
    const n = readSync(0, buffer, 0, buffer.length, null);
    if (n === 0) break;
    accept(Buffer.from(buffer.subarray(0, n)));
  }
}

export async function writeAll(path, data, append = false) {
  if (path === "-") return stdout(data);
  await writeFile(path, data, append ? { flag: "a" } : undefined);
}

export function isSingleByteLocale() {
  return /^(C|POSIX)$/.test(process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "");
}

export function concatOutputParts(parts) {
  const chunks = parts.map((part) => part instanceof Uint8Array ? Buffer.from(part) : Buffer.from(String(part)));
  return chunks.length ? Buffer.concat(chunks) : "";
}

export function tabFoldDiagnosticName(file) {
  return shellEscapeLsName(pathDisplayName(file));
}

export function nextUtf8Token(bytes, index) {
  const b0 = bytes[index];
  if (b0 < 0x80) return { bytes: bytes.slice(index, index + 1), char: String.fromCharCode(b0), width: b0 === 0x09 ? 0 : 1, next: index + 1 };
  const len = b0 >= 0xc2 && b0 <= 0xdf ? 2 : b0 >= 0xe0 && b0 <= 0xef ? 3 : b0 >= 0xf0 && b0 <= 0xf4 ? 4 : 1;
  if (len === 1 || index + len > bytes.length) return { bytes: bytes.slice(index, index + 1), char: null, width: 1, next: index + 1 };
  for (let i = 1; i < len; i++) {
    if ((bytes[index + i] & 0xc0) !== 0x80) return { bytes: bytes.slice(index, index + 1), char: null, width: 1, next: index + 1 };
  }
  const slice = bytes.slice(index, index + len);
  const char = new TextDecoder("utf-8", { ignoreBOM: true }).decode(slice);
  return { bytes: slice, char, width: displayWidth(char), next: index + len };
}

export function tacRegexPattern(sep) {
  let out = "";
  let lastAtomKind = null;
  for (let i = 0; i < sep.length; i++) {
    const ch = sep[i];
    if (ch === "\\") {
      const next = sep[++i];
      if (next == null) out += ch;
      else if ("()|".includes(next)) out += next;
      else if ("+?{}".includes(next)) out += `\\${next}`;
      else out += ch + next;
      lastAtomKind = "literal";
    } else if (ch === "[") {
      const end = sep.indexOf("]", i + 1);
      if (end === -1) {
        out += ch;
        lastAtomKind = null;
      } else {
        out += sep.slice(i, end + 1);
        i = end;
        lastAtomKind = "bracket";
      }
    } else if (ch === "+" || ch === "?") {
      if (!tacRegexHasPreviousAtom(out)) {
        out += `\\${ch}`;
        lastAtomKind = "literal";
      } else if (lastAtomKind !== "literal" && lastAtomKind !== "bracket") {
        out += ch;
      }
    } else if ("()|{}+?".includes(ch)) {
      out += `\\${ch}`;
      lastAtomKind = "literal";
    } else {
      out += ch;
      lastAtomKind = ch === "." || ch === "_" ? "repeatable" : "literal";
    }
  }
  return out;
}

export function tacRegexHasPreviousAtom(pattern) {
  if (pattern === "" || pattern.endsWith("|") || pattern.endsWith("(")) return false;
  return true;
}

export function splitSeparator(value) {
  return value === "\\0" ? "\0" : value;
}

export function decodeValidUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function prInputIsNonRegular(file) {
  try {
    return !(file === "-" ? fstatSync(0) : statSync(file)).isFile();
  } catch {
    return false;
  }
}

export function fdIsSeekable(fd) {
  return libc.symbols.lseek(fd, 0n, SEEK_CUR) >= 0;
}

export function pollFd(fd, events, timeout = 0) {
  const pollfd = Buffer.alloc(8);
  pollfd.writeInt32LE(fd, 0);
  pollfd.writeInt16LE(events, 4);
  if (libc.symbols.poll(pollfd, 1n, timeout) <= 0) return 0;
  return pollfd.readInt16LE(6);
}
