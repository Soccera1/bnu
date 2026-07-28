import { FFIType, linkSymbols, ptr } from "bun:ffi";
import { existsSync, lstatSync, mkdirSync, readSync } from "node:fs";
import { chmod as fsChmod, lstat, lutimes, mkdir, opendir, realpath, stat, utimes } from "node:fs/promises";
import { isAbsolute, dirname as pathDirname, resolve } from "node:path";
import { AT_FDCWD, AT_SYMLINK_NOFOLLOW, cstr, cstrPath, floorDivBigInt, invalidOptionMessage, isBytePath, libc, libcErrno, localeQuotedEscapedDiagnostic, lsEscapedName, lsUsesUtf8Locale, parseGNUSize, pathDisplayName, rawCommandArgs, readGroup, readPasswd, selinuxAllocatedString, selinuxApi, selinuxRuntimeEnabled, shellEscapeLsName, smackRuntimeEnabled, systemErrorMessage } from "./common.js";
import { UsageError, stderr, stdout } from "./diagnostics.js";

export let stdinLineBuffer = "";

export function invalidClusterOptionMessage(arg, validOptions) {
  if (arg?.startsWith("--")) return invalidOptionMessage(arg);
  const option = [...String(arg ?? "").slice(1)].find((ch) => !validOptions.has(ch));
  return `invalid option -- '${option ?? String(arg ?? "").slice(1, 2)}'`;
}

export const SPECIAL_FILE_LONG_OPTIONS = ["mode", "context", "help", "version"];

export function specialFileMetaOption(program, args) {
  let sawContextValue = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (!arg.startsWith("--")) continue;
    const option = normalizeSpecialFileLongOption(arg);
    const name = option.slice(2).split("=", 1)[0];
    if (!SPECIAL_FILE_LONG_OPTIONS.includes(name)) return null;
    if (option.includes("=")) {
      if (name === "help" || name === "version") return null;
      if (name === "context") sawContextValue = true;
      continue;
    }
    if (option === "--help" || option === "--version") {
      if (sawContextValue && !selinuxRuntimeEnabled()) stderr(`${program}: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\n`);
      return option;
    }
    if (name === "mode") i++;
  }
  return null;
}

export function validateBlockSizeMetaOption(option, value) {
  try {
    parseGNUBlockSize(value);
  } catch {
    throw new UsageError(gnuBlockSizeErrorMessage(option, value), false);
  }
}

export function processCwdOrNull() {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

export function fileTypeChar(s) {
  if (s.isDirectory()) return "d";
  if (s.isSymbolicLink()) return "l";
  if (s.isBlockDevice()) return "b";
  if (s.isCharacterDevice()) return "c";
  if (s.isFIFO()) return "p";
  if (s.isSocket()) return "s";
  return "-";
}

export function modeString(s) {
  const mode = s.mode;
  const chars = ["r", "w", "x"];
  let out = fileTypeChar(s);
  for (let shift = 6; shift >= 0; shift -= 3) {
    for (let bit = 2; bit >= 0; bit--) {
      if (bit === 0 && shift === 6 && (mode & 0o4000)) out += mode & 0o100 ? "s" : "S";
      else if (bit === 0 && shift === 3 && (mode & 0o2000)) out += mode & 0o010 ? "s" : "S";
      else if (bit === 0 && shift === 0 && (mode & 0o1000)) out += mode & 0o001 ? "t" : "T";
      else out += mode & (1 << (shift + bit)) ? chars[2 - bit] : "-";
    }
  }
  return out;
}

export function blocksFor(s) {
  return s.blocks ?? Math.ceil(s.size / 512);
}

export function defaultGNUBlockSize() {
  return process.env.POSIXLY_CORRECT ? 512 : 1024;
}

export function optionValues(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export function selinuxSecurityContext(path, noDereference = false) {
  if (process.platform !== "linux") return null;
  // A disk can retain stale SELinux attributes after being booted with SMACK.
  // GNU coreutils selects the active LSM, so prefer SMACK64 whenever SMACK is
  // active rather than returning an unrelated security.selinux attribute.
  if (smackRuntimeEnabled()) return securityXattrText(path, "security.SMACK64", noDereference);
  const api = selinuxApi();
  if (api) {
    const getter = selinuxInterposedContextGetter(api, noDereference);
    return selinuxAllocatedString(api, (output) => getter(cstrPath(path), output));
  }
  try {
    const result = Bun.spawnSync(["getfattr", ...(noDereference ? ["-h"] : []), "--only-values", "-n", "security.selinux", "--", String(path)], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0 || !result.stdout?.byteLength) return null;
    // Linux stores security.selinux as a NUL-terminated context.  getfattr's
    // --only-values output preserves that terminator, unlike ordinary text
    // attributes, so remove it along with any line ending.
    const value = new TextDecoder().decode(result.stdout).replace(/[\0\r\n]+$/, "");
    return value || null;
  } catch {
    return null;
  }
}

export function securityXattrText(path, name, noDereference = false) {
  try {
    const result = Bun.spawnSync(["getfattr", ...(noDereference ? ["-h"] : []), "--only-values", "-n", name, "--", String(path)], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0 || !result.stdout?.byteLength) return null;
    return new TextDecoder().decode(result.stdout).replace(/[\0\r\n]+$/, "") || null;
  } catch {
    return null;
  }
}

export const selinuxContextGetters = new Map();

export function selinuxInterposedContextGetter(api, noDereference) {
  const name = noDereference ? "lgetfilecon" : "getfilecon";
  if (selinuxContextGetters.has(name)) return selinuxContextGetters.get(name);
  const address = libc.symbols.dlsym(0, ptr(Buffer.from(`${name}\0`)));
  const getter = address
    ? linkSymbols({ [name]: { ptr: address, args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 } }).symbols[name]
    : api.symbols[name];
  selinuxContextGetters.set(name, getter);
  return getter;
}

export let lastSecurityContextErrno = 0;

export function setSelinuxSecurityContext(path, context, noDereference = false) {
  if (smackRuntimeEnabled()) {
    const value = Buffer.from(String(context));
    const errnoPointer = libc.symbols.__errno_location();
    if (errnoPointer) libc.symbols.memset(errnoPointer, 0, 4);
    const setter = noDereference ? libc.symbols.lsetxattr : libc.symbols.setxattr;
    const result = setter(cstrPath(path), cstr("security.SMACK64"), ptr(value), BigInt(value.byteLength), 0);
    lastSecurityContextErrno = result === 0 ? 0 : libcErrno();
    return result === 0;
  }
  lastSecurityContextErrno = 0;
  const api = existsSync("/sys/fs/selinux/enforce") ? selinuxApi() : null;
  if (api) {
    if (api.symbols.security_check_context(cstr(context)) !== 0) return false;
    const setter = noDereference ? api.symbols.lsetfilecon : api.symbols.setfilecon;
    return setter(cstrPath(path), cstr(context)) === 0;
  }
  try {
    const result = Bun.spawnSync(["setfattr", ...(noDereference ? ["-h"] : []), "-n", "security.selinux", "-v", String(context), "--", String(path)], { stdout: "ignore", stderr: "ignore" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export function restoreSelinuxSecurityContext(path, noDereference = false, recursive = false) {
  try {
    const result = Bun.spawnSync(["restorecon", ...(noDereference ? ["-h"] : []), ...(recursive ? ["-R"] : []), "-F", "--", String(path)], { stdout: "ignore", stderr: "ignore" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export function selinuxCreationOptions(program, opts) {
  const enabled = selinuxRuntimeEnabled();
  const explicitContext = typeof opts.context === "string" && enabled ? opts.context : null;
  if (typeof opts.context === "string" && !enabled) {
    stderr(`${program}: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\n`);
  }
  return {
    enabled,
    explicitContext,
    restoreContext: enabled && (opts.Z || opts.context === true),
  };
}

export async function withSelinuxCreationContext(program, options, create) {
  const api = options.explicitContext != null && existsSync("/sys/fs/selinux/enforce") ? selinuxApi() : null;
  let defaultContextSet = false;
  if (api) {
    if (api.symbols.security_check_context(cstr(options.explicitContext)) !== 0
      || api.symbols.setfscreatecon(ptr(cstr(options.explicitContext))) !== 0) {
      throw new UsageError(`failed to set default file creation context to '${options.explicitContext}': Invalid argument`);
    }
    defaultContextSet = true;
  }
  const created = async (path) => {
    if (options.explicitContext != null && !defaultContextSet) {
      if (!setSelinuxSecurityContext(path, options.explicitContext)) {
        const message = lastSecurityContextErrno === 1 ? "Operation not permitted" : "Invalid argument";
        throw new UsageError(`failed to set default file creation context to '${options.explicitContext}': ${message}`);
      }
    } else if (options.restoreContext && !restoreSelinuxSecurityContext(path)) {
      throw new UsageError(`failed to restore context for '${path}'`);
    }
  };
  try {
    // setfscreatecon(3) is thread-local.  Bun's promise-based mkdir may run
    // the syscall on a worker thread, so callers that create directories must
    // use their synchronous path while an explicit creation context is set.
    return await create(created, defaultContextSet);
  } finally {
    if (defaultContextSet) api.symbols.setfscreatecon(null);
  }
}

export function parseGNUBlockSize(value) {
  value = String(value).replace(/^'/, "");
  if (value === "human-readable" || value === "si") return 1;
  return /^\D+$/.test(String(value)) ? parseGNUSize(`1${value}`) : parseGNUSize(value);
}

export function gnuBlockSizeErrorMessage(option, value) {
  const text = String(value).replace(/^'/, "");
  if (/^\+?\d+[A-Za-z]+$/.test(text)) return `invalid suffix in ${option} argument '${value}'`;
  return `invalid ${option} argument '${value}'`;
}

export function parseGNUBlockSizeEnvInfo(value, defaultSize) {
  if (value == null || value === "") return { size: defaultSize, fallback: "default" };
  try {
    return { size: parseGNUBlockSize(value), fallback: null };
  } catch {
    const match = String(value).replace(/^'/, "").match(/^\+?(\d+)/);
    if (match) return { size: Number(match[1]), fallback: "numeric" };
    return { size: defaultSize, fallback: "default" };
  }
}

export function blockSizeSpecialMode(value) {
  const text = value == null ? "" : String(value).replace(/^'/, "");
  if (text === "human-readable") return "human";
  if (text === "si") return "si";
  return null;
}

export function applyBlockSizeSpecialMode(opts, value) {
  const mode = blockSizeSpecialMode(value);
  if (mode === "human") opts["human-readable"] = true;
  if (mode === "si") opts.si = true;
}

export function humanSizeWithUnits(bytes, base, units) {
  let value = bytes;
  let unit = 0;
  while (value >= base && unit < units.length - 1) {
    value /= base;
    unit++;
  }
  if (unit === 0) return `${value}${units[unit]}`;
  const digits = value >= 10 ? 0 : 1;
  const factor = 10 ** digits;
  const rounded = Math.ceil(value * factor) / factor;
  return `${rounded.toFixed(digits)}${units[unit]}`;
}

export async function resolveUser(value) {
  if (value == null || value === "") return null;
  if (/^\+\d+$/.test(value)) return Number(value.slice(1));
  if (/^\d+$/.test(value)) return Number(value);
  const user = (await readPasswd()).get(value);
  if (!user) throw new UsageError(`invalid user: ${localeQuotedEscapedDiagnostic(value)}`);
  return user.uid;
}

export async function resolveGroup(value) {
  if (value == null || value === "") return null;
  if (/^\+\d+$/.test(value)) return Number(value.slice(1));
  if (/^\d+$/.test(value)) return Number(value);
  const gid = (await readGroup()).get(value);
  if (gid == null) throw new UsageError(`invalid group: ${localeQuotedEscapedDiagnostic(value)}`);
  return gid;
}

export async function ensureSpecialFileCreatable(program, path, kind) {
  try {
    await lstat(path);
    throw new UsageError(specialFileCreationMessage(program, path, kind, "File exists"));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (error?.code === "ENOTDIR") throw new UsageError(specialFileCreationMessage(program, path, kind, "Not a directory"));
    if (error?.code !== "ENOENT") throw new UsageError(specialFileCreationMessage(program, path, kind, systemErrorMessage(error)));
  }
  const dir = pathDirname(path);
  if (dir && dir !== ".") {
    try {
      const parent = await stat(dir);
      if (!parent.isDirectory()) throw new UsageError(specialFileCreationMessage(program, path, kind, "Not a directory"));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError(specialFileCreationMessage(program, path, kind, systemErrorMessage(error)));
    }
  }
}

export function specialFileCreationMessage(program, path, kind, message) {
  if (program === "mknod") return `${mknodDiagnosticName(path)}: ${message}`;
  return `cannot create ${kind} ${specialFileQuotedName(path)}: ${message}`;
}

export function specialFileQuotedName(path) {
  return shellEscapeLsName(pathDisplayName(path), true);
}

export function mknodDiagnosticName(path) {
  return shellEscapeLsName(pathDisplayName(path));
}

export async function setFileMode(path, mode) {
  if (isBytePath(path)) {
    await fsChmod(path, mode);
    return;
  }
  if (libc.symbols.chmod(cstr(path), mode) !== 0) {
    const errno = libcErrno();
    const error = new Error(`chmod '${path}' failed (errno ${errno})`);
    error.code = ({ 1: "EPERM", 2: "ENOENT", 13: "EACCES", 20: "ENOTDIR", 30: "EROFS" })[errno] ?? "EIO";
    throw error;
  }
}

export const TOUCH_NOW = Symbol("touch-now");

export const TOUCH_OMIT = Symbol("touch-omit");

export async function touchSetPathTimes(path, atime, mtime, noDereference) {
  if (touchSetPathTimesNative(path, atime, mtime, noDereference)) return;
  if (atime === TOUCH_NOW || atime === TOUCH_OMIT || mtime === TOUCH_NOW || mtime === TOUCH_OMIT) {
    const errno = libcErrno();
    const error = new Error(`utimensat failed (errno ${errno})`);
    error.code = ({
      1: "EPERM",
      2: "ENOENT",
      5: "EIO",
      9: "EBADF",
      13: "EACCES",
      20: "ENOTDIR",
      21: "EISDIR",
      22: "EINVAL",
      28: "ENOSPC",
      30: "EROFS",
      36: "ENAMETOOLONG",
      40: "ELOOP",
    })[errno] ?? "EIO";
    throw error;
  }
  return (noDereference ? lutimes : utimes)(path, atime, mtime);
}

export function touchSetPathTimesNative(path, atime, mtime, noDereference) {
  const times = Buffer.alloc(32);
  writeTimespec(times, 0, atime);
  writeTimespec(times, 16, mtime);
  return libc.symbols.utimensat(AT_FDCWD, cstrPath(path), times, noDereference ? AT_SYMLINK_NOFOLLOW : 0) === 0;
}

export function writeTimespec(buffer, offset, date) {
  if (date === TOUCH_NOW || date === TOUCH_OMIT) {
    buffer.writeBigInt64LE(0n, offset);
    buffer.writeBigInt64LE(BigInt(date === TOUCH_NOW ? 1_073_741_823 : 1_073_741_822), offset + 8);
    return;
  }
  const total = dateAbsoluteNanoseconds(date);
  const sec = floorDivBigInt(total, 1_000_000_000n);
  const nsec = ((total % 1_000_000_000n) + 1_000_000_000n) % 1_000_000_000n;
  buffer.writeBigInt64LE(sec, offset);
  buffer.writeBigInt64LE(nsec, offset + 8);
}

export function dateAbsoluteNanoseconds(date) {
  const milliseconds = BigInt(date.getTime());
  const seconds = floorDivBigInt(milliseconds, 1000n);
  const millisecondFraction = Number(((milliseconds % 1000n) + 1000n) % 1000n);
  const nanoseconds = BigInt(date.__bnuNanoseconds ?? millisecondFraction * 1_000_000);
  return seconds * 1_000_000_000n + nanoseconds;
}

export function invalidModeDiagnosticValue(message) {
  return message.match(/^invalid mode: '(.+)'$/)?.[1]
    ?? message.match(/^invalid mode: \u2018(.+)\u2019$/)?.[1]
    ?? null;
}

export function normalizeSpecialFileLongOptions(args) {
  const out = [];
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    const option = normalizeSpecialFileLongOption(arg);
    out.push(option);
    if (option === "--mode" && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

export function normalizeSpecialFileLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const matches = SPECIAL_FILE_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length === 0) return arg;
  return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
}

export function parseSpecialFileCreationMode(spec) {
  try {
    return parseCreationMode(spec, 0o666);
  } catch (error) {
    if (error instanceof UsageError && invalidModeDiagnosticValue(error.message) != null) throw new UsageError("invalid mode", false);
    throw error;
  }
}

export function rawOperandPlan(command, args, operands, spec = {}) {
  const raw = rawCommandArgs(command);
  if (!raw) return null;
  const rawOperands = parseRawOperands(raw, spec);
  if (rawOperands.length !== operands.length) return null;
  if (!rawOperands.some((operand, index) => rawPathNeedsBytes(operand) || !operand.equals(Buffer.from(operands[index])))) return null;
  return rawOperands;
}

export function parseRawOperands(rawArgs, spec = {}) {
  const operands = [];
  const valueOptions = new Set(spec.valueOptions ?? []);
  const shortValueOptions = new Set(spec.shortValueOptions ?? []);
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
    if (valueOptions.has(text)) {
      i++;
      continue;
    }
    if ([...valueOptions].some((option) => text.startsWith(`${option}=`))) continue;
    if (arg.length > 2 && arg[0] === 0x2d && arg[1] !== 0x2d) {
      const letters = arg.toString().slice(1);
      const valueIndex = [...letters].findIndex((ch) => shortValueOptions.has(ch));
      if (valueIndex !== -1 && valueIndex === letters.length - 1) i++;
    }
  }
  return operands;
}

export async function mkdirParents(dir, mode, verbose, created = async () => {}, sameThread = false) {
  const absolute = isAbsolute(dir);
  const parts = String(dir).split("/").filter((part) => part !== "");
  let current = absolute ? "/" : "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === ".") continue;
    if (part === "..") {
      current = current ? pathDirname(current) : "..";
      continue;
    }
    current = current === "" || current === "/" ? `${current}${part}` : `${current}/${part}`;
    const isFinal = i === parts.length - 1 || parts.slice(i + 1).every((tail) => tail === ".");
    const createMode = isFinal ? mode : defaultDirectoryMode();
    try {
      if (sameThread) mkdirSync(current, { mode: createMode });
      else await mkdir(current, { mode: createMode });
      if (createMode !== undefined) await setFileMode(current, createMode);
      await created(current);
      if (verbose) stdout(`mkdir: created directory ${mkdirVerboseName(current)}\n`);
    } catch (error) {
      if (error?.code !== "EEXIST") throw new UsageError(`cannot create directory ${mkdirDiagnosticName(current)}: ${mkdirErrorMessage(error)}`);
      const s = await stat(current);
      if (!s.isDirectory()) throw new UsageError(`cannot create directory ${mkdirDiagnosticName(current)}: Not a directory`);
    }
  }
}

export function mkdirVerboseName(path) {
  return shellEscapeLsName(pathDisplayName(path), true);
}

export function mkdirDiagnosticName(path) {
  const text = pathDisplayName(path);
  const escaped = lsEscapedName(text, { escapeDouble: false });
  return lsUsesUtf8Locale() ? `\u2018${escaped}\u2019` : `'${escaped.replaceAll("'", "\\'")}'`;
}

export function mkdirErrorMessage(error) {
  if (error?.code === "EEXIST") return "File exists";
  return systemErrorMessage(error);
}

export function defaultDirectoryMode() {
  return (0o777 & ~process.umask()) | 0o300;
}

export function parseCreationMode(spec, base = 0o777) {
  return /^[0-7]+$/.test(spec) ? Number.parseInt(spec, 8) : parseModeSpec(spec, base, true).mode;
}

export function linkQuotedName(path) {
  return shellEscapeLsName(pathDisplayName(path), true);
}

export function rmLibcError(errno) {
  const error = new Error(({
    5: "Input/output error",
    10: "No child processes",
    13: "Permission denied",
    22: "Invalid argument",
    38: "Function not implemented",
  })[errno] ?? `error ${errno}`);
  error.code = ({ 5: "EIO", 10: "ECHILD", 13: "EACCES", 22: "EINVAL", 38: "ENOSYS" })[errno] ?? "EIO";
  return error;
}

export function confirmRemoval(prompt) {
  stderr(prompt);
  const bytes = new Uint8Array(1024);
  while (!stdinLineBuffer.includes("\n")) {
    const n = readSync(0, bytes, 0, bytes.length, null);
    if (!n) break;
    stdinLineBuffer += Buffer.from(bytes.subarray(0, n)).toString("utf8");
  }
  const newline = stdinLineBuffer.indexOf("\n");
  const text = newline === -1 ? stdinLineBuffer : stdinLineBuffer.slice(0, newline);
  stdinLineBuffer = newline === -1 ? "" : stdinLineBuffer.slice(newline + 1);
  return /^[yY]/.test(text.trimStart());
}

export function isWriteProtected(s) {
  return !s.isSymbolicLink() && !(s.mode & 0o200);
}

export function rawPathNeedsBytes(path) {
  return Buffer.from(path).some((byte) => byte >= 0x80);
}

export function rawArgLooksLikeOption(arg) {
  return arg.length > 1 && arg[0] === 0x2d;
}

export async function openDirectoryPathEntries(path) {
  const directory = await opendir(path, { encoding: "buffer" });
  return {
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          const entry = await directory.read();
          if (!entry) break;
          // Bun returns the encoded name directly for encoding:"buffer",
          // while Node returns a Dirent whose name uses that encoding.
          yield entry.name ?? entry;
        }
      } finally {
        try {
          await directory.close();
        } catch (error) {
          if (error?.code !== "ERR_DIR_CLOSED") throw error;
        }
      }
    }
  };
}

export function parseModeSpec(spec, current, isDirectory = false, parseOptions = {}) {
  if (spec === "--") return { mode: current, ok: true };
  if (spec.includes(",")) {
    let mode = current;
    let ok = true;
    for (const clause of spec.split(",")) {
      const parsed = parseModeSpec(clause, mode, isDirectory, parseOptions);
      mode = parsed.mode;
      ok &&= parsed.ok;
    }
    return { mode, ok };
  }
  if (/^[0-7]+$/.test(spec)) {
    const next = Number.parseInt(spec, 8);
    const preserveDirectorySpecialBits = isDirectory && next <= 0o777 && !spec.startsWith("00");
    return { mode: preserveDirectorySpecialBits ? next | (current & 0o6000) : next, ok: true };
  }
  if (/^=[0-7]+$/.test(spec)) return { mode: Number.parseInt(spec.slice(1), 8), ok: true };
  if (/^\+[0-7]+$/.test(spec)) return { mode: current | Number.parseInt(spec.slice(1), 8), ok: true };
  if (/^-[0-7]+$/.test(spec)) return { mode: current & ~Number.parseInt(spec.slice(1), 8), ok: true };
  let mode = current;
  let ok = true;
  for (const clause of expandSymbolicModeClauses(spec)) {
    const match = clause.match(/^([ugoa]*)([+=-])([rwxXstugo]*)$/);
    if (!match) throw new UsageError(`invalid mode: ${localeQuotedEscapedDiagnostic(spec)}`, true);
    if (/[ugo]/.test(match[3]) && match[3].length !== 1) throw new UsageError(`invalid mode: ${localeQuotedEscapedDiagnostic(spec)}`, true);
    const explicitWho = match[1] !== "";
    const who = match[1] || "a";
    const op = match[2];
    const perms = symbolicBits(match[3], who, mode, isDirectory);
    const mask = whoMask(who);
    const setMask = explicitWho || parseOptions.ignoreUmask ? mask : mask & ~process.umask();
    if (op === "=") mode = (mode & ~mask) | (perms & setMask);
    else if (op === "+") mode |= perms & setMask;
    else {
      mode &= ~(perms & setMask);
      if (!explicitWho && (mode & perms & (mask & ~setMask))) ok = false;
    }
  }
  return { mode, ok };
}

export function expandSymbolicModeClauses(spec) {
  const clauses = [];
  for (const clause of spec.split(",")) {
    const compound = clause.match(/^([ugoa]*)=([+-][rwxXstugo]+)$/);
    if (compound) {
      clauses.push(`${compound[1]}=`, `${compound[1]}${compound[2]}`);
    } else {
      clauses.push(clause);
    }
  }
  return clauses;
}

export function errnoMessage(error) {
  if (error?.code === "EACCES") return "Permission denied";
  if (error?.code === "ENOENT") return "No such file or directory";
  if (error?.code === "ENOTDIR") return "Not a directory";
  if (error?.code === "EISDIR") return "Is a directory";
  if (error?.code === "ENOTEMPTY") return "Directory not empty";
  if (error?.code === "EEXIST") return "Directory not empty";
  if (error?.code === "EPERM") return "Operation not permitted";
  if (error?.code === "EROFS") return "Read-only file system";
  if (error?.code === "EINVAL") return "Invalid argument";
  return error?.message || String(error);
}

export async function referenceStat(path) {
  try {
    return await stat(path);
  } catch (error) {
    throw new UsageError(`failed to get attributes of ${chmodQuotedName(path)}: ${errnoMessage(error)}`);
  }
}

export function chmodQuotedName(path) {
  return shellEscapeLsName(pathDisplayName(path), true);
}

export function isAccessError(error) {
  return error?.code === "EACCES" || error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

export function lstatSyncNoThrow(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

export async function isRecursiveRootTarget(path) {
  try {
    return await realpath(path) === "/";
  } catch {
    return resolve(path) === "/";
  }
}

export function preserveRootError(command, path) {
  const error = new Error("preserve-root");
  error.preserveRoot = true;
  error.path = path;
  error.rootPath = path === "/" ? null : "/";
  return error;
}

export function preserveRootMessage(command, path, rootPath = null) {
  const target = rootPath ? `'${path}' (same as '${rootPath}')` : `'${path}'`;
  return `${command}: it is dangerous to operate recursively on ${target}\n${command}: use --no-preserve-root to override this failsafe\n`;
}

export function whoMask(who) {
  let mask = 0;
  if (who.includes("a") || who.includes("u")) mask |= 0o4700;
  if (who.includes("a") || who.includes("g")) mask |= 0o2070;
  if (who.includes("a") || who.includes("o")) mask |= 0o1007;
  return mask;
}

export function symbolicBits(perms, who, current, isDirectory = false) {
  let bits = 0;
  const apply = (u, g, o) => {
    if (who.includes("a") || who.includes("u")) bits |= u;
    if (who.includes("a") || who.includes("g")) bits |= g;
    if (who.includes("a") || who.includes("o")) bits |= o;
  };
  for (const ch of perms) {
    if (ch === "r") apply(0o400, 0o040, 0o004);
    else if (ch === "w") apply(0o200, 0o020, 0o002);
    else if (ch === "x") apply(0o100, 0o010, 0o001);
    else if (ch === "X") {
      if (isDirectory || (current & 0o111)) apply(0o100, 0o010, 0o001);
    }
    else if (ch === "s") apply(0o4000, 0o2000, 0);
    else if (ch === "t") apply(0, 0, 0o1000);
    else if (ch === "u") bits |= copyClassBits(current, 6, who);
    else if (ch === "g") bits |= copyClassBits(current, 3, who);
    else if (ch === "o") bits |= copyClassBits(current, 0, who);
  }
  return bits;
}

export function copyClassBits(mode, shift, who) {
  const classBits = (mode >> shift) & 7;
  let bits = 0;
  if (who.includes("a") || who.includes("u")) bits |= classBits << 6;
  if (who.includes("a") || who.includes("g")) bits |= classBits << 3;
  if (who.includes("a") || who.includes("o")) bits |= classBits;
  return bits;
}
