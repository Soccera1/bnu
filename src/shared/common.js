import { CString, FFIType, dlopen, ptr, read } from "bun:ffi";
import { closeSync, existsSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { machine as osMachine } from "node:os";
import { isAbsolute, join } from "node:path";
import { UsageError, VERSION, encodeSurrogateEscapedString, stdout } from "./diagnostics.js";

export const libc = dlopen("libc.so.6", {
  chdir: { args: [FFIType.cstring], returns: FFIType.i32 },
  chroot: { args: [FFIType.cstring], returns: FFIType.i32 },
  execve: { args: [FFIType.cstring, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  execvp: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
  dlsym: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  __errno_location: { args: [], returns: FFIType.ptr },
  chmod: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
  clock_settime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },
  memset: { args: [FFIType.ptr, FFIType.i32, FFIType.u64], returns: FFIType.ptr },
  syscall: { args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i64 },
  ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  kill: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  renameat2: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
  sched_getscheduler: { args: [FFIType.i32], returns: FFIType.i32 },
  signal: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
  sync: { args: [], returns: FFIType.void },
  _exit: { args: [FFIType.i32], returns: FFIType.void },
  sethostname: { args: [FFIType.cstring, FFIType.u64], returns: FFIType.i32 },
  setgid: { args: [FFIType.u32], returns: FFIType.i32 },
  setgroups: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  setuid: { args: [FFIType.u32], returns: FFIType.i32 },
  statfs: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
  statx: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  tcgetattr: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  tcsetattr: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  mkfifo: { args: [FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
  mknod: { args: [FFIType.cstring, FFIType.u32, FFIType.u64], returns: FFIType.i32 },
  opendir: { args: [FFIType.cstring], returns: FFIType.ptr },
  readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
  closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  inotify_init1: { args: [FFIType.i32], returns: FFIType.i32 },
  inotify_add_watch: { args: [FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
  inotify_rm_watch: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  getpriority: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  capget: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  getxattr: { args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  setxattr: { args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  lsetxattr: { args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
  setpriority: { args: [FFIType.i32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
  setlocale: { args: [FFIType.i32, FFIType.cstring], returns: FFIType.ptr },
  nl_langinfo: { args: [FFIType.i32], returns: FFIType.ptr },
  strcoll: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.i32 },
  truncate: { args: [FFIType.cstring, FFIType.i64], returns: FFIType.i32 },
  utimensat: { args: [FFIType.i32, FFIType.cstring, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});

export let libselinux;

export let libselinuxResolved = false;

export function selinuxApi() {
  if (libselinuxResolved) return libselinux;
  libselinuxResolved = true;
  try {
    libselinux = dlopen("libselinux.so.1", {
      context_free: { args: [FFIType.ptr], returns: FFIType.void },
      context_new: { args: [FFIType.cstring], returns: FFIType.ptr },
      context_range_set: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      context_role_set: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      context_str: { args: [FFIType.ptr], returns: FFIType.ptr },
      context_type_set: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      context_user_set: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
      getcon: { args: [FFIType.ptr], returns: FFIType.i32 },
      getfilecon: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
      lgetfilecon: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
      freecon: { args: [FFIType.ptr], returns: FFIType.void },
      security_check_context: { args: [FFIType.cstring], returns: FFIType.i32 },
      security_compute_create: { args: [FFIType.cstring, FFIType.cstring, FFIType.u16, FFIType.ptr], returns: FFIType.i32 },
      setexeccon: { args: [FFIType.cstring], returns: FFIType.i32 },
      setfscreatecon: { args: [FFIType.ptr], returns: FFIType.i32 },
      setfilecon: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.i32 },
      lsetfilecon: { args: [FFIType.cstring, FFIType.cstring], returns: FFIType.i32 },
      string_to_security_class: { args: [FFIType.cstring], returns: FFIType.u16 },
    });
  } catch {
    libselinux = null;
  }
  return libselinux;
}

export const SEEK_SET = 0;

export const SEEK_CUR = 1;

export const enc = new TextEncoder();

export const SIGPIPE_MASK = 1n << 12n;

export const BNU_SIGPIPE_DEFAULT_ENV = "BNU_SIGPIPE_DEFAULT";

export const AT_FDCWD = -100;

export const AT_SYMLINK_NOFOLLOW = 0x100;

export const STATX_ALL = 0x0fff;

export function decodeSurrogateEscapedBytes(bytes) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return decoder.decode(bytes);
  } catch {
    // Preserve undecodable bytes below while still decoding each maximal
    // valid UTF-8 unit.  The overwhelmingly common valid-input path above
    // avoids building large strings one code point at a time.
  }
  let out = "";
  let start = 0;
  while (start < bytes.length) {
    let end = start + 1;
    let decoded = null;
    while (end <= bytes.length) {
      try {
        decoded = decoder.decode(bytes.subarray(start, end));
        break;
      } catch {
        end++;
      }
    }
    if (decoded == null) {
      out += String.fromCharCode(0xdc00 + bytes[start++]);
    } else {
      out += decoded;
      start = end;
    }
  }
  return out;
}

export function parentIgnoresSigpipe() {
  if (process.env[BNU_SIGPIPE_DEFAULT_ENV] === "1") return false;
  try {
    const status = readFileSync(`/proc/${process.ppid}/status`, "utf8");
    const ignored = status.match(/^SigIgn:\s*([0-9a-fA-F]+)/m)?.[1];
    return ignored != null && (BigInt(`0x${ignored}`) & SIGPIPE_MASK) !== 0n;
  } catch {
    return false;
  }
}

export function invalidOptionMessage(arg) {
  return arg?.startsWith("--") ? `unrecognized option '${arg}'` : `invalid option -- '${String(arg ?? "").slice(1, 2)}'`;
}

export function helpVersionOnlyMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg !== "-" && arg.startsWith("-") && !arg.startsWith("--")) return null;
    if (!arg.startsWith("--")) continue;
    const option = normalizeHelpVersionOnlyLongOption(arg);
    if (option.includes("=") || !["--help", "--version"].includes(option)) return null;
    return option;
  }
  return null;
}

export function normalizeHelpVersionOnlyLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeHelpVersionOnlyLongOption(arg));
  }
  return out;
}

export function normalizeHelpVersionOnlyLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = ["help", "version"].find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

export function parseOptions(args, spec = {}) {
  const opts = {};
  const operands = [];
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (end || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      end = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      const mode = spec.long?.[name];
      if (mode === undefined) throw new UsageError(`unrecognized option '${arg}'`, true);
      if (mode === "value" || mode === "value-array") {
        if (inlineValue != null) setParsedOptionValue(opts, name, inlineValue, mode === "value-array");
        else if (i + 1 < args.length) setParsedOptionValue(opts, name, args[++i], mode === "value-array");
        else throw new UsageError(`option '--${name}' requires an argument`, true);
      } else if (mode === "optional-value") {
        opts[name] = inlineValue ?? true;
      } else {
        if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
        opts[name] = true;
      }
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      const mode = spec.short?.[ch];
      if (mode === undefined) throw new UsageError(`invalid option -- '${ch}'`, true);
      if (mode === "value" || mode === "value-array") {
        if (arg.slice(j + 1)) setParsedOptionValue(opts, ch, arg.slice(j + 1), mode === "value-array");
        else if (i + 1 < args.length) setParsedOptionValue(opts, ch, args[++i], mode === "value-array");
        else throw new UsageError(`option requires an argument -- '${ch}'`, true);
        break;
      }
      if (mode === "optional-value") {
        opts[ch] = arg.slice(j + 1) || true;
        break;
      }
      opts[ch] = true;
    }
  }
  return { opts, operands };
}

export function setParsedOptionValue(opts, name, value, append = false) {
  if (!append || opts[name] == null) {
    opts[name] = value;
  } else if (Array.isArray(opts[name])) {
    opts[name].push(value);
  } else {
    opts[name] = [opts[name], value];
  }
}

export async function readAll(path) {
  if (path === "-") return readStdinBytes();
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

export function readStdinBytes() {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  while (true) {
    const n = readSync(0, buffer, 0, buffer.length, null);
    if (n === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, n)));
    total += n;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function readFdChunkViews(fd, accept, size = 64 * 1024) {
  const buffer = Buffer.allocUnsafe(size);
  while (true) {
    const n = readSync(fd, buffer, 0, buffer.length, null);
    if (n === 0) break;
    accept(buffer.subarray(0, n));
  }
}

export function readFdByteRecords(fd, sepByte, accept) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = [];
  let pendingLength = 0;
  const flush = (hasSep) => {
    const bytes = new Uint8Array(pendingLength);
    let offset = 0;
    for (const chunk of pending) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    pending = [];
    pendingLength = 0;
    accept(bytes, hasSep);
  };
  while (true) {
    const n = readSync(fd, buffer, 0, buffer.length, null);
    if (n === 0) break;
    let start = 0;
    for (let i = 0; i < n; i++) {
      if (buffer[i] !== sepByte) continue;
      pending.push(Buffer.from(buffer.subarray(start, i)));
      pendingLength += i - start;
      flush(true);
      start = i + 1;
    }
    if (start < n) {
      pending.push(Buffer.from(buffer.subarray(start, n)));
      pendingLength += n - start;
    }
  }
  if (pendingLength) flush(false);
}

export function readStdinByteRecords(sepByte, accept) {
  readFdByteRecords(0, sepByte, accept);
}

export function fdStat(fd) {
  try {
    return fstatSync(fd);
  } catch {
    return null;
  }
}

export function wcFiles0SourceIsNonRegular(source) {
  try {
    return !(source === "-" ? fstatSync(0) : statSync(source)).isFile();
  } catch {
    return false;
  }
}

export function splitFiles0ByteNames(bytes) {
  if (bytes.byteLength === 0) return [];
  const names = [];
  let start = 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] !== 0) continue;
    names.push(Buffer.from(bytes.subarray(start, i)));
    start = i + 1;
  }
  if (start < bytes.byteLength) names.push(Buffer.from(bytes.subarray(start)));
  return names;
}

export function wcFileNameIsDash(file) {
  return file === "-" || (isBytePath(file) && Buffer.from(file).equals(Buffer.from("-")));
}

export function wcFileNameIsEmpty(file) {
  return file === "" || (isBytePath(file) && file.byteLength === 0);
}

export function displayWidth(ch) {
  const code = ch.codePointAt(0) ?? 0;
  if (code === 0 || ch === "\b" || ch === "\r" || ch === "\n" || ch === "\f") return 0;
  if (isCombiningMark(code) || isZeroWidthFormat(code)) return 0;
  if (isWideCodePoint(code)) return 2;
  return 1;
}

export function isZeroWidthFormat(code) {
  return code === 0x061c || code === 0x180e || code === 0xfeff
    || (code >= 0x200b && code <= 0x200f)
    || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x2064)
    || (code >= 0x2066 && code <= 0x206f)
    || (code >= 0xfe00 && code <= 0xfe0f)
    || (code >= 0xe0000 && code <= 0xe007f);
}

export function isCombiningMark(code) {
  return (code >= 0x0300 && code <= 0x036f)
    || (code >= 0x1ab0 && code <= 0x1aff)
    || (code >= 0x1dc0 && code <= 0x1dff)
    || (code >= 0x20d0 && code <= 0x20ff)
    || (code >= 0xfe20 && code <= 0xfe2f);
}

export function isWideCodePoint(code) {
  return (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff);
}

export function inRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index <= end);
}

export function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function isGb18030Locale() {
  return /gb18030/i.test(process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "");
}

export function gb18030Units(bytes) {
  const units = [];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0x80 && i + 1 < bytes.length) units.push(bytes.slice(i, ++i + 1));
    else units.push(bytes.slice(i, i + 1));
  }
  return units;
}

export function isUtf8Continuation(byte) {
  return byte != null && byte >= 0x80 && byte <= 0xbf;
}

export function textInputDiagnosticName(file) {
  return shellEscapeLsName(pathDisplayName(file));
}

export function isUtf8Locale() {
  return /utf-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "");
}

export function rawCommandArgs(command) {
  try {
    const parts = readFileSync("/proc/self/cmdline").subarray(0, -1).toString("binary").split("\0").map((part) => Buffer.from(part, "binary"));
    const commandBytes = Buffer.from(command);
    const index = parts.findIndex((part) => part.equals(commandBytes) || bufferPathBasename(part).equals(commandBytes));
    if (index !== -1) return parts.slice(index + 1);
    const scriptIndex = parts.findIndex((part) => bufferPathBasename(part).toString() === "bnu.js");
    if (scriptIndex !== -1 && parts[scriptIndex + 1]?.equals(commandBytes)) return parts.slice(scriptIndex + 2);
    return null;
  } catch {
    return null;
  }
}

export const LC_COLLATE = 3;

export function initializeSortLocaleCollation() {
  const locale = process.env.LC_ALL || process.env.LC_COLLATE || process.env.LANG || "C";
  if (locale === "C" || locale === "POSIX") return false;
  return libc.symbols.setlocale(LC_COLLATE, cstr("")) !== null;
}

export function compareSortLocaleText(a, b) {
  const aa = encodeSurrogateEscapedString(a);
  const bb = encodeSurrogateEscapedString(b);
  // strcoll(3) is NUL-terminated.  GNU sort still accepts embedded NUL bytes
  // in newline-delimited records, so retain a length-aware byte comparison
  // for that uncommon case.
  if (aa.includes(0) || bb.includes(0)) return compareByteArrays(aa, bb);
  const result = libc.symbols.strcoll(cstrPath(aa), cstrPath(bb));
  return result < 0 ? -1 : result > 0 ? 1 : 0;
}

export function compareSortBytes(a, b) {
  return compareByteArrays(encodeSurrogateEscapedString(a), encodeSurrogateEscapedString(b));
}

export function compareByteArrays(a, b) {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

export function isAsciiDigit(ch) {
  return ch >= "0" && ch <= "9";
}

export function readStdinRecords(sep, accept) {
  const sepByte = sep === "\0" ? 0 : 10;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pending = [];
  let pendingLength = 0;
  const flush = () => {
    const bytes = new Uint8Array(pendingLength);
    let offset = 0;
    for (const chunk of pending) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    pending = [];
    pendingLength = 0;
    accept(decodeSurrogateEscapedBytes(bytes));
  };
  while (true) {
    const n = readSync(0, buffer, 0, buffer.length, null);
    if (n === 0) break;
    let start = 0;
    for (let i = 0; i < n; i++) {
      if (buffer[i] !== sepByte) continue;
      pending.push(Buffer.from(buffer.subarray(start, i)));
      pendingLength += i - start;
      flush();
      start = i + 1;
    }
    if (start < n) {
      pending.push(Buffer.from(buffer.subarray(start, n)));
      pendingLength += n - start;
    }
  }
  if (pendingLength) flush();
}

export function createFdRecordReader(fd, separator) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  let length = 0;
  let eof = false;
  let pending = [];
  return {
    next() {
      while (true) {
        for (let index = offset; index < length; index++) {
          if (buffer[index] !== separator) continue;
          const tail = Buffer.from(buffer.subarray(offset, index));
          offset = index + 1;
          if (!pending.length) return tail;
          pending.push(tail);
          const record = Buffer.concat(pending);
          pending = [];
          return record;
        }
        if (offset < length) pending.push(Buffer.from(buffer.subarray(offset, length)));
        if (eof) {
          if (!pending.length) return null;
          const record = Buffer.concat(pending);
          pending = [];
          return record;
        }
        length = readSync(fd, buffer, 0, buffer.length, null);
        offset = 0;
        if (length === 0) eof = true;
      }
    },
  };
}

export function normalizeLongOptionsByPrefix(args, longOptions) {
  const out = [];
  for (const arg of args) {
    if (arg === "--") {
      out.push(arg);
      continue;
    }
    if (!arg.startsWith("--") || arg === "--") {
      out.push(arg);
      continue;
    }
    out.push(normalizeLongOptionByPrefix(arg, longOptions));
  }
  return out;
}

export function normalizeLongOptionByPrefix(arg, longOptions, reportAmbiguous = true) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (longOptions.includes(name)) return arg;
  const matches = longOptions.filter((option) => option.startsWith(name));
  if (matches.length === 1) return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
  if (matches.length > 1 && reportAmbiguous) {
    throw new UsageError(`option '${arg}' is ambiguous; possibilities: ${matches.map((option) => `'--${option}'`).join(" ")}`, true);
  }
  return arg;
}

export function shellQuote(value) {
  if (value === "") return "''";
  if (/[\u0080-\u009f]/.test(value)) return shellQuoteBytes(enc.encode(value));
  if (process.env.LC_ALL === "C" && /[^\x00-\x7f]/.test(value)) return shellQuoteBytes(enc.encode(value));
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(value) && !value.startsWith("~")) return value;
  if (/^[^\s"'\\$`;&|()<>{}!*?\[\]#]+$/u.test(value) && !value.startsWith("~")) return value;
  if (/[\x00-\x1f\x7f]/.test(value)) return shellQuoteControl(value);
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function shellQuoteControl(value) {
  let out = "";
  let segment = "";
  const flush = () => {
    if (segment) {
      out += `'${segment}'`;
      segment = "";
    } else if (!out) {
      out += "''";
    }
  };
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (ch === "'") {
      flush();
      out += "\\'''";
    } else if (code < 0x20 || code === 0x7f) {
      flush();
      out += `$'${shellEscapeByte(code)}'`;
    } else {
      segment += ch;
    }
  }
  flush();
  return out;
}

export function shellQuoteBytes(bytes) {
  return `''$'${[...bytes].map(shellEscapeByte).join("")}'`;
}

export function shellEscapeByte(byte) {
  if (byte === 7) return "\\a";
  if (byte === 8) return "\\b";
  if (byte === 9) return "\\t";
  if (byte === 10) return "\\n";
  if (byte === 13) return "\\r";
  return `\\${byte.toString(8).padStart(3, "0")}`;
}

export function pad(value, width, flags = "") {
  const n = Number(width);
  if (!Number.isInteger(n) || value.length >= n) return value;
  const fill = flags.includes("0") && !flags.includes("-") ? "0" : " ";
  return flags.includes("-") ? value.padEnd(n, " ") : value.padStart(n, fill);
}

export async function randomPicker(source, options = {}) {
  if (source == null) return (max) => Math.floor(Math.random() * max);
  const bytes = readRandomSourceBytes(source);
  if (options.boundedBits && bytes.length === 0) {
    const error = new Error("end of file");
    error.code = "EOF";
    throw error;
  }
  if (!options.boundedBits) {
    let offset = 0;
    return (max) => {
      if (max <= 0) return 0;
      if (!bytes.length) return 0;
      let value = 0;
      for (let i = 0; i < 4; i++) {
        value = (value << 8) | bytes[offset++ % bytes.length];
      }
      return (value >>> 0) % max;
    };
  }
  let bitOffset = 0;
  const nextBit = () => {
    if (bitOffset >= bytes.length * 8) {
      const error = new Error("end of file");
      error.code = "EOF";
      throw error;
    }
    const bit = (bytes[bitOffset >> 3] >> (bitOffset & 7)) & 1;
    bitOffset++;
    return bit;
  };
  return (max) => {
    if (max <= 0) return 0;
    if (!bytes.length) return 0;
    const bits = Math.ceil(Math.log2(max));
    while (true) {
      let value = 0;
      for (let i = 0; i < bits; i++) value |= nextBit() << i;
      if (value < max) return value;
    }
  };
}

export function readRandomSourceBytes(source) {
  const fd = openSync(source, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export function attachDateNanoseconds(date, nanoseconds) {
  date.__bnuNanoseconds = nanoseconds;
  return date;
}

export async function groupName(gid) {
  const groups = await readGroup();
  for (const [name, id] of groups) if (id === gid) return name;
  return String(gid);
}

export async function userNameForUid(uid) {
  const passwd = await readPasswd();
  for (const [name, row] of passwd) if (row.uid === Number(uid)) return name;
  return null;
}

export async function supplementaryGroupsForUser(user) {
  const ids = [];
  try {
    const text = await readFile("/etc/group", "utf8");
    for (const line of text.split("\n")) {
      const [,, gid, members = ""] = line.split(":");
      if (members.split(",").includes(user)) ids.push(Number(gid));
    }
  } catch {}
  return ids;
}

export function uniqueNumbers(values) {
  return [...new Set(values.map(Number))];
}

export function orderedGroupIds(primary, values) {
  return [Number(primary), ...uniqueNumbers(values).filter((gid) => gid !== Number(primary))];
}

export function machineName() {
  const map = { x64: "x86_64", arm64: "aarch64", ia32: "i686" };
  return osMachine?.() || map[process.arch] || process.arch;
}

export function systemErrorMessage(error) {
  if (error?.code === "ENOENT") return "No such file or directory";
  if (error?.code === "EACCES") return "Permission denied";
  if (error?.code === "EISDIR") return "Is a directory";
  if (error?.code === "ELOOP") return "Too many levels of symbolic links";
  if (error?.code === "ENOSPC") return "No space left on device";
  if (error?.code === "ENAMETOOLONG") return "File name too long";
  if (error?.code === "ENOTDIR") return "Not a directory";
  if (error?.code === "EBADF") return "Bad file descriptor";
  if (error?.code === "EINVAL") return "Invalid argument";
  return error?.message || String(error);
}

export function selinuxRuntimeEnabled() {
  if (process.platform !== "linux") return false;
  if (smackRuntimeEnabled()) return true;
  if (existsSync("/sys/fs/selinux/enforce")) return true;
  try {
    const result = Bun.spawnSync(["getenforce"], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return false;
    return new TextDecoder().decode(result.stdout).trim() !== "Disabled";
  } catch {
    return false;
  }
}

export function smackRuntimeEnabled() {
  if (process.platform !== "linux") return false;
  try {
    const modules = readFileSync("/sys/kernel/security/lsm", "utf8").trim().split(",");
    if (modules.includes("smack")) return true;
  } catch {}
  return existsSync("/sys/fs/smackfs");
}

export function processSecurityContext() {
  if (smackRuntimeEnabled()) {
    try {
      const context = readFileSync("/proc/self/attr/current", "utf8").replace(/[\0\r\n]+$/, "");
      if (context) return context;
    } catch {}
  }
  const lsmContext = lsmSelfSecurityContext();
  if (lsmContext != null) return lsmContext;
  if (existsSync("/sys/fs/selinux/enforce")) {
    const api = selinuxApi();
    if (api) {
      const output = Buffer.alloc(8);
      if (api.symbols.getcon(ptr(output)) === 0) {
        const address = read.ptr(ptr(output), 0);
        if (address) {
          try {
            const context = new CString(address).toString().replace(/[\0\r\n]+$/, "");
            if (context) return context;
          } finally {
            api.symbols.freecon(address);
          }
        }
      }
    }
    try {
      const context = readFileSync("/proc/self/attr/current", "utf8").replace(/[\0\r\n]+$/, "");
      if (context) return context;
    } catch {}
  }
  // ps exposes the same process label on SELinux systems and also provides a
  // useful fallback for minimal runtimes where libselinux is unavailable.
  try {
    const result = Bun.spawnSync(["ps", "-o", "label=", "-p", String(process.pid)], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return null;
    return new TextDecoder().decode(result.stdout).trim() || null;
  } catch {
    return null;
  }
}

export function lsmSelfSecurityContext() {
  if (process.platform !== "linux") return null;
  // lsm_get_self_attr(LSM_ATTR_CURRENT, ...) is syscall 459 on Linux's
  // current native ABIs.  Unlike the legacy proc attribute, it can select the
  // SELinux record correctly when several security modules are compiled in.
  const size = Buffer.alloc(4);
  libc.symbols.syscall(459, 100, 0, ptr(size), 0);
  const required = size.readUInt32LE(0);
  if (required < 32 || required > 1024 * 1024) return null;
  const records = Buffer.alloc(required);
  size.writeUInt32LE(required, 0);
  const count = Number(libc.symbols.syscall(459, 100, ptr(records), ptr(size), 0));
  if (count <= 0) return null;
  let offset = 0;
  for (let index = 0; index < count && offset + 32 <= records.length; index++) {
    const id = records.readBigUInt64LE(offset);
    const length = Number(records.readBigUInt64LE(offset + 16));
    const contextLength = Number(records.readBigUInt64LE(offset + 24));
    if (length < 32 || offset + length > records.length || contextLength > length - 32) return null;
    if (id === 101n) {
      const context = records.subarray(offset + 32, offset + 32 + contextLength).toString("utf8").replace(/[\0\r\n]+$/, "");
      return context || null;
    }
    offset += length;
  }
  return null;
}

export function lsUsesUtf8Locale() {
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  return /utf-?8/i.test(locale);
}

export function localeQuotedDiagnostic(value) {
  return lsUsesUtf8Locale() ? `\u2018${value}\u2019` : `'${value}'`;
}

export function localeQuotedEscapedDiagnostic(value) {
  return localeQuotedDiagnostic(lsEscapedName(value, { escapeDouble: false }));
}

export function lsEscapedName(name, { escapeDouble = true, escapeSpaces = false } = {}) {
  return [...String(name)].map((ch) => {
    const code = ch.codePointAt(0);
    if (ch === " " && escapeSpaces) return "\\ ";
    if (ch === "\\") return "\\\\";
    if (ch === "\"" && escapeDouble) return "\\\"";
    if (ch === "\n") return "\\n";
    if (ch === "\t") return "\\t";
    if (ch === "\r") return "\\r";
    if (ch === "\b") return "\\b";
    if (ch === "\f") return "\\f";
    if (ch === "\v") return "\\v";
    if (ch === "\x07") return "\\a";
    if (code < 32 || code === 127) return `\\${code.toString(8).padStart(3, "0")}`;
    return ch;
  }).join("");
}

export function shellEscapeLsName(name, always = false) {
  const text = String(name);
  if (!always && /^[A-Za-z0-9_.,@%+=/-]+$/.test(text)) return text;
  if (!/[\x00-\x1f\x7f]/.test(text)) return shellQuoteLsName(text, always);
  const parts = [];
  let plain = "";
  let escaped = "";
  const flushPlain = () => {
    if (plain) {
      parts.push(`'${plain.replaceAll("'", "'\\''")}'`);
      plain = "";
    }
  };
  const flushEscaped = () => {
    if (escaped) {
      parts.push(`$'${escaped}'`);
      escaped = "";
    }
  };
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 32 || code === 127) {
      flushPlain();
      escaped += lsEscapedName(ch);
    } else {
      flushEscaped();
      plain += ch;
    }
  }
  flushPlain();
  flushEscaped();
  if (!parts.length) return "''";
  if (always && parts.length === 1 && !parts[0].startsWith("$")) return parts[0];
  return parts.join("");
}

export function shellQuoteLsName(name, always = false, rendered = name) {
  const text = String(name);
  const out = String(rendered);
  if (!always && !/[\s\\'"$`|&;<>(){}\[\]*?!]/.test(text)) return out;
  if (out.includes("'") && !out.includes("\"")) return `"${out.replaceAll("\\", "\\\\").replaceAll("$", "\\$").replaceAll("`", "\\`").replaceAll("\"", "\\\"")}"`;
  return `'${out.replaceAll("'", "'\\''")}'`;
}

export function statAttachNanoseconds(statInfo, path, dereference) {
  try {
    const precise = nativeStatNanoseconds(path, dereference) ?? (dereference ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true }));
    attachStatNanoseconds(statInfo, precise);
  } catch {}
  return statInfo;
}

export function nativeStatNanoseconds(path, dereference) {
  const buffer = Buffer.alloc(256);
  const flags = dereference ? 0 : AT_SYMLINK_NOFOLLOW;
  if (libc.symbols.statx(AT_FDCWD, cstrPath(path), flags, STATX_ALL, buffer) !== 0) return null;
  const mask = buffer.readUInt32LE(0);
  const fields = [
    ["atime", 0x0020, 64],
    ["birthtime", 0x0800, 80],
    ["ctime", 0x0080, 96],
    ["mtime", 0x0040, 112],
  ];
  const result = {};
  for (const [field, bit, offset] of fields) {
    if ((mask & bit) === 0) continue;
    const seconds = buffer.readBigInt64LE(offset);
    const nanoseconds = BigInt(buffer.readUInt32LE(offset + 8));
    result[`${field}Ns`] = seconds * 1_000_000_000n + nanoseconds;
  }
  return result;
}

export function attachStatNanoseconds(statInfo, precise) {
  for (const field of ["atime", "mtime", "ctime", "birthtime"]) {
    const value = precise[`${field}Ns`];
    if (value == null) continue;
    statInfo[`${field}Ns`] = value;
    statInfo[field] = dateFromNanoseconds(value);
  }
  return statInfo;
}

export function dateFromNanoseconds(value) {
  const total = BigInt(value);
  const milliseconds = floorDivBigInt(total, 1_000_000n);
  const nanoseconds = Number(((total % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n);
  return attachDateNanoseconds(new Date(Number(milliseconds)), nanoseconds);
}

export async function readPasswd() {
  const rows = new Map();
  try {
    const text = await readFile("/etc/passwd", "utf8");
    for (const line of text.split("\n")) {
      const [name,, uid, gid, gecos = "", home = "", shell = ""] = line.split(":");
      if (name) rows.set(name, { uid: Number(uid), gid: Number(gid), gecos, home, shell });
    }
  } catch {}
  return rows;
}

export async function readGroup() {
  const rows = new Map();
  try {
    const text = await readFile("/etc/group", "utf8");
    for (const line of text.split("\n")) {
      const [name,, gid] = line.split(":");
      if (name) rows.set(name, Number(gid));
    }
  } catch {}
  return rows;
}

export function ddBufferIsZero(chunk) {
  for (const byte of chunk) if (byte !== 0) return false;
  return true;
}

export function globMatch(pattern, value) {
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") regex += ".*";
    else if (ch === "?") regex += ".";
    else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) regex += "\\[";
      else {
        let body = pattern.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        regex += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else {
      regex += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`).test(value);
}

export function selinuxAllocatedString(api, invoke) {
  const output = Buffer.alloc(8);
  if (invoke(ptr(output)) < 0) return null;
  const address = read.ptr(ptr(output), 0);
  if (!address) return null;
  try {
    return new CString(address).toString().replace(/[\0\r\n]+$/, "") || null;
  } finally {
    api.symbols.freecon(address);
  }
}

export function hasSurrogateEscapedBytes(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc80 && code <= 0xdcff) return true;
  }
  return false;
}

export function cstr(value) {
  return Buffer.from(`${value}\0`);
}

export function cstrPath(value) {
  const bytes = isBytePath(value) ? Buffer.from(value) : Buffer.from(String(value));
  return Buffer.concat([bytes, Buffer.from([0])]);
}

export function changeDirectory(path) {
  if (libc.symbols.chdir(cstrPath(path)) !== 0) {
    const error = new Error(`chdir '${pathDisplayName(path)}' failed`);
    error.code = "EACCES";
    throw error;
  }
}

export function headTailDiagnosticName(file) {
  return shellEscapeLsName(pathDisplayName(file), true);
}

export function isWriteError(error) {
  return error?.syscall === "write" || ["EPIPE", "ENOSPC"].includes(error?.code);
}

export function nodeErrorMessage(error) {
  if (error?.code === "ENOENT") return "No such file or directory";
  if (error?.code === "ENOSPC") return "No space left on device";
  return error?.message || String(error);
}

export function writeEnvironment(env, sep) {
  for (const [key, value] of Object.entries(env).filter(([key]) => key !== "_" && key !== "PWD").sort(([a], [b]) => a.localeCompare(b))) stdout(encodeEnvironmentEntry(`${key}=${value}${sep}`));
}

export function encodeEnvironmentEntry(entry) {
  if (!/[\u00A0\uFFFD\uDC80-\uDCFF]/.test(entry)) return entry;
  const parts = [];
  let text = "";
  for (let i = 0; i < entry.length; i++) {
    const code = entry.charCodeAt(i);
    const raw = code === 0x00a0 || code === 0xfffd ? 0xa0 : code >= 0xdc80 && code <= 0xdcff ? code & 0xff : null;
    if (raw == null) {
      text += entry[i];
      continue;
    }
    if (text) {
      parts.push(Buffer.from(text));
      text = "";
    }
    parts.push(Buffer.from([raw]));
  }
  if (text) parts.push(Buffer.from(text));
  return Buffer.concat(parts);
}

export async function booleanCommand(program, args, code) {
  if (args.length === 1 && args[0] === "--help") {
    showBooleanHelp(program, code);
    return code;
  }
  if (args.length === 1 && args[0] === "--version") {
    stdout(`${VERSION}\n`);
    return code;
  }
  return code;
}

export function showBooleanHelp(program, code) {
  stdout(`Usage: ${program} [ignored command line arguments]\n`);
  stdout(`  or:  ${program} OPTION\n`);
  stdout(`Exit with a status code indicating ${code === 0 ? "success" : "failure"}.\n\n`);
  stdout("      --help     display this help and exit\n");
  stdout("      --version  output version information and exit\n");
}

export async function resolveEnvCommand(command, env, cwd) {
  const searchPath = Object.hasOwn(env, "PATH") ? String(env.PATH) : "/bin:/usr/bin";
  const candidates = command.includes("/") ? [command] : searchPath.split(":").map((dir) => join(dir || ".", command));
  for (const candidate of candidates) {
    const full = isAbsolute(candidate) ? candidate : join(cwd, candidate);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) {
      const error = new Error("Permission denied");
      error.code = "EACCES";
      throw error;
    }
    await access(full, fsConstants.X_OK).catch((error) => {
      error.code = "EACCES";
      throw error;
    });
    return command.includes("/") ? candidate : full;
  }
  const error = new Error("No such file or directory");
  error.code = "ENOENT";
  throw error;
}

export function touchStatDate(statInfo, field) {
  const date = statInfo[field];
  const value = statInfo[`${field}Ns`];
  return value == null ? date : attachDateNanoseconds(date, Number(((BigInt(value) % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n));
}

export function libcErrno() {
  const errnoPointer = libc.symbols.__errno_location();
  return errnoPointer ? read.i32(errnoPointer, 0) : 0;
}

export function floorDivBigInt(value, divisor) {
  const quotient = value / divisor;
  return value >= 0n || value % divisor === 0n ? quotient : quotient - 1n;
}

export async function readdirPathEntries(path) {
  return await readdir(path, { encoding: "buffer" });
}

export function pathLikeJoin(parent, child) {
  if (isBytePath(parent) || isBytePath(child)) return bufferPathJoin(parent, isBytePath(child) ? Buffer.from(child) : Buffer.from(String(child)));
  return join(parent, child);
}

export function isBytePath(path) {
  return path instanceof Uint8Array;
}

export function pathDisplayName(path) {
  return isBytePath(path) ? decodeUtf8SurrogateEscaped(Buffer.from(path)) : String(path);
}

export function decodeUtf8SurrogateEscaped(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
    } else if (b >= 0xc2 && b <= 0xdf && i + 1 < bytes.length && isUtf8Continuation(bytes[i + 1])) {
      out += String.fromCodePoint(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b >= 0xe0 && b <= 0xef && i + 2 < bytes.length && isUtf8Continuation(bytes[i + 1]) && isUtf8Continuation(bytes[i + 2])
      && !(b === 0xe0 && bytes[i + 1] < 0xa0) && !(b === 0xed && bytes[i + 1] >= 0xa0)) {
      out += String.fromCodePoint(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else if (b >= 0xf0 && b <= 0xf4 && i + 3 < bytes.length && isUtf8Continuation(bytes[i + 1]) && isUtf8Continuation(bytes[i + 2]) && isUtf8Continuation(bytes[i + 3])
      && !(b === 0xf0 && bytes[i + 1] < 0x90) && !(b === 0xf4 && bytes[i + 1] >= 0x90)) {
      out += String.fromCodePoint(((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f));
      i += 4;
    } else {
      out += String.fromCharCode(0xdc00 + b);
      i++;
    }
  }
  return out;
}

export function bufferPathBasename(path) {
  let end = path.length;
  while (end > 1 && path[end - 1] === 0x2f) end--;
  const slash = path.lastIndexOf(0x2f, end - 1);
  return path.subarray(slash + 1, end);
}

export function bufferPathJoin(dir, base) {
  const normalizedDir = isBytePath(dir) ? Buffer.from(dir) : Buffer.from(String(dir));
  const sep = normalizedDir.length && normalizedDir[normalizedDir.length - 1] !== 0x2f ? Buffer.from("/") : Buffer.alloc(0);
  return Buffer.concat([normalizedDir, sep, base]);
}

export function parseGNUSize(value) {
  const match = String(value).match(/^(\d+)([A-Za-z]*)$/);
  if (!match) throw new UsageError(`invalid file size: ${value}`);
  const n = BigInt(match[1]);
  const suffix = match[2];
  const binary = {
    "": 1n, b: 512n,
    K: 1024n, k: 1024n, KiB: 1024n, kiB: 1024n,
    M: 1024n ** 2n, m: 1024n ** 2n, MiB: 1024n ** 2n, miB: 1024n ** 2n,
    G: 1024n ** 3n, g: 1024n ** 3n, GiB: 1024n ** 3n, giB: 1024n ** 3n,
    T: 1024n ** 4n, t: 1024n ** 4n, TiB: 1024n ** 4n, tiB: 1024n ** 4n,
    P: 1024n ** 5n, PiB: 1024n ** 5n,
    E: 1024n ** 6n, EiB: 1024n ** 6n,
    Z: 1024n ** 7n, ZiB: 1024n ** 7n,
    Y: 1024n ** 8n, YiB: 1024n ** 8n,
  };
  const decimal = {
    KB: 1000n, kB: 1000n, MB: 1000n ** 2n, mB: 1000n ** 2n,
    GB: 1000n ** 3n, gB: 1000n ** 3n, TB: 1000n ** 4n, tB: 1000n ** 4n,
    PB: 1000n ** 5n, EB: 1000n ** 6n, ZB: 1000n ** 7n, YB: 1000n ** 8n,
  };
  const scale = binary[suffix] ?? decimal[suffix];
  if (!scale) throw new UsageError(`invalid file size: ${value}`);
  const amount = n * scale;
  return amount > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(amount);
}

export function statSyncNoThrow(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
