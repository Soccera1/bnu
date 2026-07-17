import { FFIType, linkSymbols, ptr } from "bun:ffi";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { chown, copyFile, link as fsLink, unlink as fsUnlink, lchown, lstat, mkdir, mkdtemp, open, readlink, realpath, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { isAbsolute, join, basename as pathBasename, dirname as pathDirname, resolve } from "node:path";
import { AT_FDCWD, cstr, cstrPath, ddBufferIsZero, libc, libcErrno, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, pathDisplayName, pathLikeJoin, selinuxApi, shellEscapeLsName, statAttachNanoseconds, touchStatDate } from "./common.js";
import { InvocationError, UsageError, stdout } from "./diagnostics.js";
import { errnoMessage, openDirectoryPathEntries, restoreSelinuxSecurityContext, selinuxSecurityContext, setFileMode, setSelinuxSecurityContext, touchSetPathTimes } from "./filesystem.js";

export const SEEK_DATA = 3;

export const SEEK_HOLE = 4;

export let reflinkTempId = 0;

export const FICLONE = 0x40049409;

export function cpDuplicateDisplayName(src) {
  return String(src).replace(/^\.\//, "");
}

export function cpRestrictiveDirectoryMode(mode) {
  return (mode & 0o7000) | 0o700;
}

export function stripTrailingSlashesPath(path) {
  return String(path).replace(/\/+$/, "") || path;
}

export async function cpUpdateDecision(src, target, opts, noDereference, overwriteMode = null) {
  if (overwriteMode === "no-clobber" || (overwriteMode == null && (opts.n || opts["no-clobber"]))) {
    if (await lstat(target).catch(() => null)) return { skip: true, fail: false };
  }
  if (!(opts.u || opts.update != null)) return { skip: false, fail: false };
  const mode = cpUpdateMode(opts, overwriteMode);
  if (mode === "all") return { skip: false, fail: false };
  const sourceInfo = await cpUpdateStat(src, noDereference);
  const targetInfo = await cpUpdateStat(target, noDereference);
  if (!targetInfo) return { skip: false, fail: false };
  if (mode === "none" || mode === "none-fail") return { skip: true, fail: mode === "none-fail" };
  if (!sourceInfo) return { skip: false, fail: false };
  if (sourceInfo.isDirectory()) return { skip: false, fail: false };
  if (sourceInfo.dev === targetInfo.dev && sourceInfo.ino === targetInfo.ino) return { skip: true, fail: false };
  return { skip: cpStatMtimeNs(targetInfo) >= cpStatMtimeNs(sourceInfo), fail: false };
}

export async function cpUpdateStat(path, noDereference) {
  return (noDereference ? lstat(path, { bigint: true }) : stat(path, { bigint: true })).catch(() => null);
}

export function cpStatMtimeNs(statInfo) {
  if (statInfo.mtimeNs != null) return BigInt(statInfo.mtimeNs);
  return BigInt(statInfo.mtimeMs) * 1_000_000n;
}

export function cpUpdateMode(opts, overwriteMode = null) {
  if (overwriteMode === "no-clobber" || (overwriteMode == null && (opts.n || opts["no-clobber"]))) return "none";
  if (opts.update === true || opts.update == null) return "older";
  const mode = String(opts.update);
  if (mode === "older" || mode === "all" || mode === "none" || mode === "none-fail") return mode;
  validateUpdateMode("cp", mode);
}

export function validateUpdateMode(program, mode) {
  if (["all", "none", "none-fail", "older"].includes(mode)) return;
  const kind = mode === "" ? "ambiguous" : "invalid";
  throw new UsageError(`${kind} argument ${localeQuotedEscapedDiagnostic(mode)} for ${localeQuotedDiagnostic("--update")}\nValid arguments are:\n  - ${localeQuotedDiagnostic("all")}\n  - ${localeQuotedDiagnostic("none")}\n  - ${localeQuotedDiagnostic("none-fail")}\n  - ${localeQuotedDiagnostic("older")}`, true);
}

export async function withPreservedCopyCreationContext(src, options, create) {
  if (!options.preserveContextAtCreation || !options.selinuxEnabled || !existsSync("/sys/fs/selinux/enforce")) {
    return { value: await create(), handled: false };
  }
  const context = selinuxSecurityContext(src, Boolean(options.noDereferenceContext));
  const api = context != null ? selinuxApi() : null;
  if (context == null && options.requirePreserveContext) {
    throw new UsageError(`failed to get security context of '${pathDisplayName(src)}'`);
  }
  let contextSet = false;
  if (api) {
    const encoded = cstr(context);
    if (api.symbols.security_check_context(encoded) === 0 && api.symbols.setfscreatecon(ptr(encoded)) === 0) {
      contextSet = true;
    } else if (options.requirePreserveContext) {
      throw new UsageError(`failed to set default file creation context to '${context}': Invalid argument`);
    }
  }
  try {
    return { value: await create(), handled: true };
  } finally {
    if (contextSet) api.symbols.setfscreatecon(null);
  }
}

export function copyMetadataAfterCreationContext(options, handled) {
  return handled ? { ...options, preserveContext: false } : options;
}

export function prepareRegularFilePreservedContext(src, dest, sourceStat, options) {
  if (!options.preserveContextAtCreation || !options.selinuxEnabled || !existsSync("/sys/fs/selinux/enforce")) return false;
  const context = selinuxSecurityContext(src, Boolean(options.noDereferenceContext));
  if (context == null) {
    if (options.requirePreserveContext) throw new UsageError(`failed to get security context of '${src}'`);
    return false;
  }
  const api = selinuxApi();
  let contextSet = false;
  if (api) {
    const encoded = cstr(context);
    if (api.symbols.security_check_context(encoded) === 0 && api.symbols.setfscreatecon(ptr(encoded)) === 0) contextSet = true;
  }
  try {
    // Create or truncate before copying any bytes.  Besides keeping the
    // thread-local fscreate context on this thread, this lets an explicitly
    // requested --preserve=context fail with an empty destination on a
    // fixed-context filesystem, as GNU cp does.
    const fd = openSync(dest, "w", cpDefaultFileMode(options.useSourceModeForNewRegularFiles ? sourceStat.mode : undefined));
    closeSync(fd);
  } finally {
    if (contextSet) api.symbols.setfscreatecon(null);
  }
  const actual = selinuxSecurityContext(dest);
  const preserved = actual === context || setSelinuxSecurityContext(dest, context);
  if (!preserved && options.requirePreserveContext) throw new UsageError(`failed to set the security context of '${dest}'`);
  // Archive/all preservation treats an unsupported context as ignorable;
  // either way, do not attempt it again after data has been copied.
  return true;
}

export async function copyPath(src, dest, options, topLevel = false) {
  const dereferenceSource = cpShouldDereferenceSource(src, options, topLevel);
  if (options.hardLink) {
    const srcInfo = await lstat(src).catch(() => null);
    const destInfo = options.force || options.removeDestination ? null : await lstat(dest).catch(() => null);
    if (!dereferenceSource && srcInfo?.isSymbolicLink() && destInfo?.isSymbolicLink() && await readlink(src).catch(() => null) === await readlink(dest).catch(() => null) && !(options.force || options.removeDestination)) return;
    const dereferencedInfo = !dereferenceSource ? srcInfo : await stat(src).catch((error) => {
      if (error?.code === "ENOENT") throw new UsageError(`cannot stat '${src}': No such file or directory`);
      throw error;
    });
    if (dereferencedInfo?.isDirectory()) {
      if (!options.recursive) throw new UsageError(`-r not specified; omitting directory '${src}'`);
      const destInfo = await lstat(dest).catch(() => null);
      await mkdir(dest, { recursive: true, mode: cpInitialDirectoryCreateMode(dereferencedInfo.mode, options) });
      if (options.verbose && !destInfo && !topLevel) stdout(`created directory '${dest}'\n`);
      if (options.oneFileSystem && !topLevel && dereferencedInfo.dev !== options.rootDev) {
        if (options.preserveDirectoryMode && !destInfo) await setFileMode(dest, dereferencedInfo.mode & 0o7777).catch(() => {});
        return;
      }
      const dirSource = !dereferenceSource ? src : await realpath(src);
      for await (const entry of iterateDirectoryPathEntries(dirSource)) await copyPath(pathLikeJoin(dirSource, entry), pathLikeJoin(dest, entry), options);
      if (options.preserveDirectoryMode && !destInfo) await setFileMode(dest, dereferencedInfo.mode & 0o7777).catch(() => {});
      return;
    }
    if (options.force || options.removeDestination) await rm(dest, { force: true, recursive: true });
    let linkSource = src;
    if (dereferenceSource) {
      try {
        linkSource = await realpath(src);
      } catch (error) {
        if (error?.code === "ENOENT") throw new UsageError(`cannot stat '${src}': No such file or directory`);
        throw error;
      }
    }
    try {
      await fsLink(linkSource, dest);
    } catch (error) {
      if (error.code === "EEXIST") throw new UsageError(`cannot create hard link '${dest}' to '${src}'`);
      throw error;
    }
    if (options.verbose) stdout(`'${dest}' => '${src}'\n`);
    return;
  }
  if (options.symbolicLink) {
    if (options.force || options.removeDestination) await rm(dest, { force: true, recursive: true });
    try {
      await symlink(src, dest);
    } catch (error) {
      if (error.code === "EEXIST") throw new UsageError(`cannot create symbolic link '${dest}' to '${src}'`);
      throw error;
    }
    if (options.verbose) stdout(`'${dest}' -> '${src}'\n`);
    return;
  }
  const s = await lstat(src);
  const sourceStat = dereferenceSource && s.isSymbolicLink() ? await stat(src).catch((error) => {
    if (error?.code === "ENOENT") throw new UsageError(`cannot stat '${src}': No such file or directory`);
    throw error;
  }) : s;
  statAttachNanoseconds(sourceStat, src, dereferenceSource);
  const preservedLink = await cpMaybePreserveExistingLink(src, dest, sourceStat, s, dereferenceSource, options);
  if (preservedLink) {
    if (options.verbose) stdout(`'${src}' -> '${dest}'\n`);
    return;
  }
  if (sourceStat.isDirectory()) {
    if (!options.recursive) throw new UsageError(`-r not specified; omitting directory '${src}'`);
    let destInfo = await lstat(dest).catch(() => null);
    if (destInfo?.isSymbolicLink() && options.keepDirectorySymlink) {
      const followed = await stat(dest).catch(() => null);
      if (followed?.isDirectory()) destInfo = followed;
    }
    if (destInfo && !destInfo.isDirectory()) throw new UsageError(`cannot overwrite non-directory '${dest}' with directory '${src}'`);
    const directoryCreation = destInfo
      ? { handled: false }
      : await withPreservedCopyCreationContext(src, options, () => mkdirSync(dest, { recursive: true, mode: cpInitialDirectoryCreateMode(sourceStat.mode, options) }));
    if (destInfo) await mkdir(dest, { recursive: true, mode: cpInitialDirectoryCreateMode(sourceStat.mode, options) });
    if (options.verbose && !destInfo && !topLevel) stdout(`created directory '${dest}'\n`);
    // GNU cp -x still creates a mountpoint directory, but does not descend
    // into a directory that lives on another filesystem.
    const crossFileSystemDirectory = options.oneFileSystem && !topLevel && sourceStat.dev !== options.rootDev;
    const dirSource = dereferenceSource && s.isSymbolicLink() ? await realpath(src) : src;
    let copyError = null;
    if (!crossFileSystemDirectory) {
      try {
        for await (const entry of iterateDirectoryPathEntries(dirSource)) await copyPath(pathLikeJoin(dirSource, entry), pathLikeJoin(dest, entry), options);
      } catch (error) {
        copyError = error;
      }
    }
    if (options.preserveDirectoryMode && !destInfo) await setFileMode(dest, sourceStat.mode & 0o7777).catch(() => {});
    // Restore directory metadata after descendants have been copied.  This
    // includes POSIX ACLs when mode preservation was requested; keeping the
    // initial restrictive mode during traversal avoids making a directory
    // prematurely accessible.
    await applyCopyMetadata(dest, sourceStat, { ...copyMetadataAfterCreationContext(options, directoryCreation.handled), preserveMode: options.preserveMode, sourcePath: src });
    if (copyError) throw copyError;
    return;
  } else if (s.isSymbolicLink() && !dereferenceSource) {
    const linkTarget = await readlink(src);
    const destInfo = options.force || options.removeDestination ? null : await lstat(dest).catch(() => null);
    if (destInfo?.isSymbolicLink() && await readlink(dest).catch(() => null) === linkTarget && !(options.force || options.removeDestination)) return;
    if (options.force || options.removeDestination) await rm(dest, { force: true, recursive: true });
    const symlinkCreation = await withPreservedCopyCreationContext(src, { ...options, noDereferenceContext: true }, () => symlink(linkTarget, dest));
    if (options.preserveMetadata || options.preserveMode || options.preserveContext || options.restoreContext || options.explicitContext != null) {
      await applySymlinkCopyMetadata(dest, sourceStat, { ...copyMetadataAfterCreationContext(options, symlinkCreation.handled), sourcePath: src });
    }
  } else {
    if (options.removeDestination) await rm(dest, { force: true });
    if (await cpDestinationIsDanglingSymlink(dest)) {
      await cpHandleDanglingDestinationSymlink(src, dest, options);
      return;
    }
    let destInfo = await lstat(dest).catch(() => null);
    if (String(dest).endsWith("/") && !destInfo?.isDirectory()) throw new UsageError(`cannot create regular file '${dest}': Not a directory`);
    if (destInfo?.isDirectory()) throw new UsageError(`cannot overwrite directory '${dest}' with non-directory '${src}'`);
    if (cpShouldRecreateSpecialFile(sourceStat, options)) {
      if (destInfo) await rm(dest, { force: true });
      const specialCreation = await withPreservedCopyCreationContext(src, options, () => cpCreateSpecialFile(dest, sourceStat));
      await applyCopyMetadata(dest, sourceStat, { ...copyMetadataAfterCreationContext(options, specialCreation.handled), preserveMode: true, sourcePath: src });
    } else if (options.attributesOnly) {
      const attributeCreation = !destInfo
        ? await withPreservedCopyCreationContext(src, options, () => writeFile(dest, ""))
        : { handled: false };
      await applyCopyMetadata(dest, sourceStat, { ...copyMetadataAfterCreationContext(options, attributeCreation.handled), sourcePath: src });
      if (!options.preserveMode && !destInfo) await setFileMode(dest, cpDefaultFileMode(options.useSourceModeForNewRegularFiles ? sourceStat.mode : undefined)).catch(() => {});
      cpRememberPreservedLink(dest, sourceStat, options);
    } else {
      const contextPrepared = prepareRegularFilePreservedContext(src, dest, sourceStat, options);
      const copyContents = async () => {
        if (options.destinationWasReportedExisting && !destInfo) {
          options.destinationWasReportedExisting = false;
          try {
            const staleTarget = await open(dest, "r+");
            await staleTarget.close();
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
        return cpCopyFileContents(src, dest, sourceStat, options);
      };
      const copyWithRecovery = () => copyContents().catch(async (error) => {
        if (error.code === "EEXIST" && await cpDestinationIsDanglingSymlink(dest)) return cpHandleDanglingDestinationSymlink(src, dest, options);
        if ((error.code === "EEXIST" || error.code === "EACCES" || error.code === "EPERM") && options.force) {
          await rm(dest, { force: true });
          destInfo = null;
          return cpCopyFileContents(src, dest, sourceStat, options);
        }
        if (error.code === "EEXIST" && await cpCanWriteThroughDestinationSymlink(dest)) return cpCopyFileContents(src, dest, sourceStat, options);
        throw error;
      });
      const fileCreation = contextPrepared
        ? { value: await copyWithRecovery(), handled: true }
        : await withPreservedCopyCreationContext(src, options, copyWithRecovery);
      if (!cpShouldReadUntilEof(src, sourceStat) && !cpCopiedSpecialContents(sourceStat, options)) await truncate(dest, sourceStat.size).catch(() => {});
      await applyCopyMetadata(dest, sourceStat, { ...copyMetadataAfterCreationContext(options, fileCreation.handled), sourcePath: src });
      if (!options.preserveMode && destInfo && !destInfo.isSymbolicLink()) await setFileMode(dest, destInfo.mode & 0o7777).catch(() => {});
      else if (!options.preserveMode && !destInfo) await setFileMode(dest, cpDefaultFileMode(options.useSourceModeForNewRegularFiles ? sourceStat.mode : undefined)).catch(() => {});
      cpRememberPreservedLink(dest, sourceStat, options);
      if (options.debug) {
        if (options.verbose && (!topLevel || !sourceStat.isDirectory())) stdout(`'${src}' -> '${dest}'\n`);
        stdout(cpDebugLine(options));
        return;
      }
    }
  }
  if (options.verbose && (!topLevel || !sourceStat.isDirectory())) stdout(`'${src}' -> '${dest}'\n`);
}

export async function cpCopyFileContents(src, dest, sourceStat, options = {}) {
  if (cpShouldReadUntilEof(src, sourceStat) || cpCopiedSpecialContents(sourceStat, options)) {
    await cpCopyStreamContents(src, dest);
    return;
  }
  if (sourceStat?.isFile?.() && options.reflinkMode && options.reflinkMode !== "never") {
    if (cpCloneFile(src, dest, sourceStat.mode)) {
      options.reflinkAttempted = true;
      return;
    }
    if (options.reflinkMode === "always") throw new UsageError(`failed to clone '${src}' from '${dest}': Operation not supported`);
  }
  if (options.sparseMode === "never") {
    await cpCopyRegularFileContents(src, dest, sourceStat, { sparse: false });
    return;
  }
  if (options.sparseMode === "always" || cpSourceLooksSparse(sourceStat)) {
    const sparseDetection = await cpCopyRegularFileContents(src, dest, sourceStat, { sparse: true, scanZeros: options.sparseMode === "always" });
    if (sparseDetection) options.sparseDetection = sparseDetection;
    return;
  }
  await copyFile(src, dest);
}

export function cpDebugLine(options) {
  const offload = options.sparseMode === "never" || options.reflinkMode === "never" ? "avoided" : "unknown";
  const sparseDetection = options.sparseMode === "never" ? "no" : options.sparseDetection ?? "unknown";
  return `copy offload: ${offload}, reflink: ${options.reflinkAttempted ? "yes" : "no"}, sparse detection: ${sparseDetection}\n`;
}

export function cpCloneFile(src, dest, sourceMode = 0o666) {
  if (typeof src !== "string" || typeof dest !== "string") return false;
  let sourceFd = -1;
  let destFd = -1;
  const temp = join(pathDirname(dest), `.${pathBasename(dest)}.bnu-reflink-${process.pid}-${reflinkTempId++}`);
  let cloned = false;
  try {
    sourceFd = openSync(src, "r");
    destFd = openSync(temp, "wx", sourceMode & 0o777);
    if (libc.symbols.ioctl(destFd, FICLONE, sourceFd) !== 0) return false;
    cloned = true;
    closeSync(destFd);
    destFd = -1;
    renameSync(temp, dest);
    return true;
  } catch {
    return false;
  } finally {
    if (destFd >= 0) closeSync(destFd);
    if (sourceFd >= 0) closeSync(sourceFd);
    if (!cloned) {
      try {
        unlinkSync(temp);
      } catch {}
    }
  }
}

export async function cpCopyRegularFileContents(src, dest, sourceStat, options = {}) {
  const destInfo = await stat(dest).catch(() => null);
  if (destInfo && !destInfo.isFile()) {
    await cpCopyStreamContents(src, dest);
    return;
  }
  const source = await open(src, "r");
  const target = await open(dest, "w", 0o600);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  let copiedExtents = false;
  try {
    copiedExtents = options.sparse && await cpCopySparseExtents(source, target, sourceStat.size, buffer, options.scanZeros);
    if (!copiedExtents) {
      while (position < sourceStat.size) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, sourceStat.size - position), position);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        if (!(options.sparse && ddBufferIsZero(chunk))) await target.write(chunk, 0, chunk.length, position);
        position += bytesRead;
      }
    }
  } finally {
    await source.close().catch(() => {});
    await target.close().catch(() => {});
  }
  await truncate(dest, sourceStat.size);
  return options.scanZeros ? "zeros" : options.sparse && copiedExtents ? "SEEK_HOLE" : null;
}

export async function cpCopySparseExtents(source, target, size, buffer, scanZeros = false) {
  let offset = 0;
  while (offset < size) {
    const dataResult = libc.symbols.lseek(source.fd, BigInt(offset), SEEK_DATA);
    if (dataResult < 0) {
      const errno = libcErrno();
      return errno === 6; // ENXIO means there is no more data after the final hole.
    }
    const data = Number(dataResult);
    const holeResult = libc.symbols.lseek(source.fd, BigInt(data), SEEK_HOLE);
    if (holeResult < 0) return false;
    const hole = Math.min(size, Number(holeResult));
    let position = data;
    while (position < hole) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, hole - position), position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (!scanZeros || !ddBufferIsZero(chunk)) await target.write(chunk, 0, bytesRead, position);
      position += bytesRead;
    }
    if (position < hole) return false;
    offset = hole;
  }
  return true;
}

export function cpSourceLooksSparse(sourceStat) {
  return sourceStat?.isFile?.() && sourceStat.size > 0 && sourceStat.blocks != null && sourceStat.blocks * 512 < sourceStat.size;
}

export async function cpCopyStreamContents(src, dest) {
  const destExisted = Boolean(await lstat(dest).catch(() => null));
  const source = await open(src, "r");
  const target = await open(dest, "w", 0o600);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    if (!destExisted) await setFileMode(dest, 0o600).catch(() => {});
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      await target.write(buffer.subarray(0, bytesRead));
    }
  } finally {
    await source.close().catch(() => {});
    await target.close().catch(() => {});
  }
}

export function cpCopiedSpecialContents(sourceStat, options = {}) {
  return Boolean(options.copyContents && !sourceStat?.isFile?.());
}

export function cpShouldReadUntilEof(src, sourceStat) {
  if (sourceStat?.isCharacterDevice?.()) return true;
  if (!sourceStat?.isFile?.()) return false;
  const path = pathDisplayName(src);
  return path === "/proc" || path.startsWith("/proc/") || path === "/sys" || path.startsWith("/sys/");
}

export async function cpMaybePreserveExistingLink(src, dest, sourceStat, linkStat, dereferenceSource, options) {
  if (!options.preserveLinks || !options.linkMap || !sourceStat.isFile()) return false;
  if (linkStat.isSymbolicLink() && !dereferenceSource) return false;
  const key = cpLinkKey(sourceStat);
  const previousDest = options.linkMap.get(key);
  if (!previousDest) return false;
  if (options.removeDestination || options.force) await rm(dest, { force: true, recursive: true });
  else if (await lstat(dest).catch(() => null)) await rm(dest, { force: true, recursive: true });
  await fsLink(previousDest, dest);
  return true;
}

export function cpRememberPreservedLink(dest, sourceStat, options) {
  if (!options.preserveLinks || !options.linkMap || !sourceStat.isFile()) return;
  const key = cpLinkKey(sourceStat);
  if (!options.linkMap.has(key)) options.linkMap.set(key, dest);
}

export function cpLinkKey(statInfo) {
  return `${statInfo.dev}:${statInfo.ino}`;
}

export function cpDirectoryCreateMode(sourceMode, options) {
  if (!options.preserveDirectoryMode) return cpDefaultDirectoryMode();
  return (sourceMode & 0o7777) | 0o700;
}

export function cpInitialDirectoryCreateMode(sourceMode, options) {
  if (options.preserveMode || options.preserveMetadata) return cpRestrictiveDirectoryMode(sourceMode);
  return cpDirectoryCreateMode(sourceMode, options);
}

export function cpDefaultFileMode(sourceMode = 0o666) {
  return (sourceMode & 0o777) & ~process.umask();
}

export function cpDefaultDirectoryMode() {
  return 0o777 & ~process.umask();
}

export async function cpCreateFifo(path, mode) {
  if (libc.symbols.mkfifo(cstr(path), mode) !== 0) throw new Error(`cannot create fifo '${path}'`);
  await setFileMode(path, mode).catch(() => {});
}

export function cpShouldRecreateSpecialFile(sourceStat, options) {
  return options.recursive && !options.copyContents
    && (sourceStat.isFIFO() || sourceStat.isCharacterDevice() || sourceStat.isBlockDevice() || sourceStat.isSocket());
}

export async function cpCreateSpecialFile(path, sourceStat) {
  if (sourceStat.isFIFO()) return cpCreateFifo(path, sourceStat.mode & 0o7777);
  if (libc.symbols.mknod(cstrPath(path), sourceStat.mode >>> 0, sourceStat.rdev) !== 0) {
    const errno = libcErrno();
    const error = new Error(`mknod failed (errno ${errno})`);
    error.code = ({ 1: "EPERM", 13: "EACCES", 17: "EEXIST", 22: "EINVAL" })[errno] ?? "EIO";
    throw error;
  }
}

export function cpShouldDereferenceSource(src, options, topLevel) {
  if (String(src).endsWith("/")) return true;
  if (options.noDereference) return false;
  if (options.dereferenceAll) return true;
  if (options.dereferenceCommandLine && topLevel) return true;
  if (options.hardLink && topLevel) return !options.preserveLinks;
  return topLevel && !options.recursive;
}

export async function cpCanWriteThroughDestinationSymlink(dest) {
  const info = await lstat(dest).catch(() => null);
  if (!info?.isSymbolicLink()) return false;
  return Boolean(await stat(dest).catch(() => null));
}

export async function cpDestinationIsDanglingSymlink(dest) {
  const info = await lstat(dest).catch(() => null);
  if (!info?.isSymbolicLink()) return false;
  try {
    await stat(dest);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ELOOP") return true;
    throw new UsageError(`cannot stat '${dest}': ${errnoMessage(error)}`);
  }
}

export async function cpHandleDanglingDestinationSymlink(src, dest, options) {
  const linkTarget = await readlink(dest);
  if (process.env.POSIXLY_CORRECT) return copyFile(src, isAbsolute(linkTarget) ? linkTarget : join(pathDirname(dest), linkTarget));
  if (options.force && linkTarget === pathBasename(dest)) {
    await rm(dest, { force: true });
    return copyFile(src, dest);
  }
  throw new UsageError(`not writing through dangling symlink '${dest}'`);
}

export async function applyCopyMetadata(path, s, options) {
  if (!options.preserveMetadata && !options.preserveMode && !options.preserveXattrs && !options.preserveContext && !options.restoreContext && options.explicitContext == null) return;
  await applyCopySecurityContext(path, options.sourcePath, options);
  if (options.preserveMode && options.sourcePath != null) await copyPosixAcl(options.sourcePath, path).catch(() => {});
  let ownershipPreserved = true;
  if (options.preserveMetadata) {
    let current = await stat(path).catch(() => null);
    if (!current || current.uid !== s.uid) {
      await chown(path, s.uid, current?.gid ?? s.gid).catch(() => { ownershipPreserved = false; });
      current = await stat(path).catch(() => current);
    }
    // Preserve the group independently.  A non-root owner may be unable to
    // assume the source UID but can still select a supplementary source GID.
    if (!current || current.gid !== s.gid) {
      await chown(path, current?.uid ?? s.uid, s.gid).catch(() => { ownershipPreserved = false; });
      current = await stat(path).catch(() => current);
    }
    ownershipPreserved = ownershipPreserved && current?.uid === s.uid && current?.gid === s.gid;
    await touchSetPathTimes(path, touchStatDate(s, "atime"), touchStatDate(s, "mtime"), false).catch(() => {});
  }
  // chown(2) clears security.capability.  Apply xattrs only after ownership
  // has reached its final value so --preserve=xattr/all retains file caps.
  if (options.preserveXattrs && options.sourcePath != null) {
    try {
      await copyExtendedAttributes(options.sourcePath, path, Boolean(options.noDereferenceContext));
    } catch (error) {
      if (options.requirePreserveXattrs) throw error;
    }
  }
  // chown(2) clears setuid/setgid bits, so restore the source mode last.
  // If ownership could not be preserved, GNU cp deliberately leaves those
  // privilege bits cleared rather than granting them to the copying user.
  if (options.preserveMode) {
    const mode = (s.mode & 0o7777) & (ownershipPreserved ? 0o7777 : ~0o6000);
    await setFileMode(path, mode).catch(() => {});
  }
}

export async function copyPosixAcl(src, dest) {
  let dumped;
  try {
    dumped = Bun.spawnSync(["getfacl", "--absolute-names", "--", String(src)], { stdout: "pipe", stderr: "ignore" });
  } catch {
    return;
  }
  if (dumped.exitCode !== 0 || !dumped.stdout?.byteLength) return;
  const lines = new TextDecoder().decode(dumped.stdout).split(/\r?\n/);
  const fileLine = lines.findIndex((line) => line.startsWith("# file: "));
  if (fileLine < 0) return;
  lines[fileLine] = `# file: ${dest}`;
  const dir = await mkdtemp("/tmp/bnu-acl-");
  const restore = join(dir, "restore");
  try {
    await writeFile(restore, lines.join("\n"));
    Bun.spawnSync(["setfacl", "--restore", restore], { stdout: "ignore", stderr: "ignore" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function applySymlinkCopyMetadata(path, s, options) {
  if (!options.preserveMetadata && !options.preserveMode && !options.preserveXattrs && !options.preserveContext && !options.restoreContext && options.explicitContext == null) return;
  await applyCopySecurityContext(path, options.sourcePath, { ...options, noDereferenceContext: true });
  if (options.preserveXattrs && options.sourcePath != null) {
    try {
      await copyExtendedAttributes(options.sourcePath, path, true);
    } catch (error) {
      if (options.requirePreserveXattrs) throw error;
    }
  }
  if (options.preserveMetadata) {
    await touchSetPathTimes(path, touchStatDate(s, "atime"), touchStatDate(s, "mtime"), true).catch(() => {});
    await lchown(path, s.uid, s.gid).catch(() => {});
  }
}

export async function applyCopySecurityContext(path, sourcePath, options) {
  if (!options.selinuxEnabled) return;
  const noDereference = Boolean(options.noDereferenceContext);
  if (options.explicitContext != null) {
    if (!setSelinuxSecurityContext(path, options.explicitContext, noDereference)) throw new UsageError(`failed to set the security context of '${path}'`);
    return;
  }
  if (options.restoreContext) {
    // -Z starts from the source label even when the destination already
    // exists.  restorecon may then replace it with a pathname default; if no
    // default exists, GNU cp leaves this source label in place.
    if (options.preserveContextAtCreation && sourcePath != null) {
      const sourceContext = selinuxSecurityContext(sourcePath, noDereference);
      if (sourceContext != null) setSelinuxSecurityContext(path, sourceContext, noDereference);
    }
    if (!restoreSelinuxSecurityContext(path, noDereference) && options.requireRestoreContext) {
      throw new UsageError(`failed to restore the security context of '${path}'`);
    }
    return;
  }
  if (!options.preserveContext || sourcePath == null) return;
  const context = selinuxSecurityContext(sourcePath, noDereference);
  if (context == null) {
    if (options.requirePreserveContext) throw new UsageError(`failed to get security context of '${sourcePath}'`);
    return;
  }
  if (!setSelinuxSecurityContext(path, context, noDereference) && options.requirePreserveContext) {
    throw new UsageError(`failed to set the security context of '${path}'`);
  }
}

export async function copyExtendedAttributes(src, dest, noDereference = false) {
  const getArgs = ["getfattr", ...(noDereference ? ["-h"] : []), "--dump", "--absolute-names", "-m", "-", String(src)];
  const dumped = Bun.spawnSync(getArgs, { stdout: "pipe", stderr: "pipe" });
  if (dumped.exitCode !== 0) throw new UsageError(`setting attributes for '${dest}': ${xattrToolError(dumped.stderr)}`);
  const text = new TextDecoder().decode(dumped.stdout ?? new Uint8Array());
  const attributes = text.split(/\r?\n/).filter((line) => /^[^#=][^=]*=/.test(line)
    && !line.startsWith("security.selinux=") && !line.startsWith("system.posix_acl_"));
  const destStat = noDereference ? null : await lstat(dest).catch(() => null);
  const restoreMode = destStat && (destStat.mode & 0o200) === 0 ? destStat.mode & 0o7777 : null;
  try {
    if (restoreMode != null) await setFileMode(dest, restoreMode | 0o200);
    for (const attribute of attributes) {
      const equals = attribute.indexOf("=");
      const name = attribute.slice(0, equals);
      const value = attribute.slice(equals + 1);
      const result = Bun.spawnSync(["setfattr", ...(noDereference ? ["-h"] : []), "-n", name, "-v", value, String(dest)], { stdout: "ignore", stderr: "pipe" });
      if (result.exitCode !== 0) throw new UsageError(`setting attributes for '${dest}': ${xattrToolError(result.stderr)}`);
    }
  } finally {
    if (restoreMode != null) await setFileMode(dest, restoreMode).catch(() => {});
  }
}

export function xattrToolError(output) {
  const message = new TextDecoder().decode(output ?? new Uint8Array()).trim();
  return message.match(/: ([^:\n]+)$/)?.[1] || "Operation not supported";
}

export async function* iterateDirectoryPathEntries(path) {
  yield* await openDirectoryPathEntries(path);
}

export function lnQuotedName(name) {
  return shellEscapeLsName(pathDisplayName(name), true);
}

export async function areSameFile(a, b) {
  const [as, bs] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  return Boolean(as && bs && as.dev === bs.dev && as.ino === bs.ino);
}

export async function ensureBackupDoesNotDestroySource(program, src, target, suffixOption, backupOption) {
  const backup = backupFileName(target, suffixOption, backupOption);
  if (!backup) return;
  if (resolve(src) === resolve(backup) || await areSameFile(src, backup)) {
    const action = program === "mv" ? "moved" : "copied";
    throw new UsageError(`backing up '${target}' might destroy source;  '${src}' not ${action}`);
  }
}

export function backupSuffix(option) {
  const suffix = option && option !== true && option !== "simple" ? option : process.env.SIMPLE_BACKUP_SUFFIX ?? "~";
  return String(suffix).includes("/") ? "~" : String(suffix);
}

export async function backupDestination(target, suffixOption, backupOption = true) {
  const s = await lstat(target).catch(() => null);
  if (!s) return "";
  const backup = backupFileName(target, suffixOption, backupOption);
  if (!backup) return "";
  await fsUnlink(backup).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await rename(target, backup);
  return backup;
}

export function backupFileName(target, suffixOption, backupOption = true) {
  const mode = backupMode(backupOption);
  if (mode === "none" || mode === "off") return "";
  if (mode === "numbered" || mode === "t") return nextNumberedBackupName(target);
  if (mode === "existing" || mode === "nil") return existingNumberedBackupName(target) ? nextNumberedBackupName(target) : `${target}${backupSuffix(suffixOption)}`;
  return `${target}${backupSuffix(suffixOption)}`;
}

export const BACKUP_VALID_ARGUMENTS = [
  ["none", "off"],
  ["simple", "never"],
  ["existing", "nil"],
  ["numbered", "t"],
];

export function validateBackupMode(program, backupOption) {
  backupMode(backupOption, program);
}

export function backupMode(backupOption = true, program = null) {
  if (backupOption === true || backupOption == null) return backupModeFromEnvironment(program);
  const mode = String(backupOption);
  if (mode === "") return backupModeFromEnvironment(program);
  if (backupModeIsValid(mode)) return mode;
  if (program) throw new InvocationError(validBackupModeMessage(mode, "backup type"), 1, true);
  return "existing";
}

export function backupModeFromEnvironment(program = null) {
  const value = process.env.VERSION_CONTROL;
  if (value == null || value === "") return "existing";
  if (backupModeIsValid(value)) return value;
  if (program) throw new InvocationError(validBackupModeMessage(value, "$VERSION_CONTROL"), 1, true);
  return "existing";
}

export function backupModeIsValid(value) {
  return BACKUP_VALID_ARGUMENTS.some((group) => group.includes(value));
}

export function validBackupModeMessage(value, option) {
  return `invalid argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic(option)}\nValid arguments are:\n${BACKUP_VALID_ARGUMENTS.map((group) => `  - ${group.map(localeQuotedDiagnostic).join(", ")}`).join("\n")}`;
}

export function existingNumberedBackupName(target) {
  const dir = pathDirname(target);
  const base = pathBasename(target);
  try {
    return readdirSyncNoThrow(dir).some((name) => name.startsWith(`${base}.~`) && /^\.~\d+~$/.test(name.slice(base.length)));
  } catch {
    return false;
  }
}

export function nextNumberedBackupName(target) {
  const dir = pathDirname(target);
  const base = pathBasename(target);
  let max = 0;
  for (const name of readdirSyncNoThrow(dir)) {
    if (!name.startsWith(`${base}.~`)) continue;
    const match = name.slice(base.length).match(/^\.~(\d+)~$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return join(dir, `${base}.~${max + 1}~`);
}

export async function resolveDestinationOperands(program, operands, opts) {
  const explicitTarget = opts.t ?? opts["target-directory"];
  const noTargetDirectory = opts.T || opts["no-target-directory"];
  if (explicitTarget && noTargetDirectory) throw new UsageError("cannot combine --target-directory and --no-target-directory");
  if (explicitTarget) {
    if (!operands.length) throw new UsageError("missing file operand", true);
    const destStat = await stat(explicitTarget).catch((error) => {
      if (program === "ln" && error?.code === "ENOENT") throw new UsageError(`failed to access ${lnQuotedName(explicitTarget)}: ${errnoMessage(error)}`);
      if ((program === "cp" || program === "mv") && error?.code === "ENOENT") throw new UsageError(`target directory '${explicitTarget}': ${errnoMessage(error)}`);
      if (error?.code !== "ENOENT") throw new UsageError(`target directory '${explicitTarget}': ${errnoMessage(error)}`);
      return null;
    });
    if (program === "ln" && !destStat?.isDirectory()) throw new UsageError(`target '${explicitTarget}' is not a directory`);
    if (!destStat?.isDirectory()) throw new UsageError(`target directory '${explicitTarget}': Not a directory`);
    return { sources: operands, dest: explicitTarget, destStat, useDirectoryTarget: true };
  }
  if (operands.length < 2) {
    if ((program === "cp" || program === "mv" || program === "ln") && operands.length === 0) throw new UsageError("missing file operand", true);
    const suffix = operands.length === 1 ? ` after '${operands[0]}'` : "";
    throw new UsageError(`missing destination file operand${suffix}`, true);
  }
  const dest = operands.at(-1);
  const sources = operands.slice(0, -1);
  if (sources.length > 1 && noTargetDirectory) throw new UsageError(`extra operand '${dest}'`, true);
  const destStat = program === "cp" ? await cpDestinationStat(dest) : await stat(dest).catch(() => null);
  const useDirectoryTarget = !noTargetDirectory && Boolean(destStat?.isDirectory());
  if (sources.length > 1 && !useDirectoryTarget && !destStat) throw new UsageError(`target '${dest}': No such file or directory`);
  if (sources.length > 1 && !useDirectoryTarget) throw new UsageError(`target '${dest}': Not a directory`);
  return { sources, dest, destStat, useDirectoryTarget };
}

export let cpStatApi;

export async function cpDestinationStat(path) {
  if (!process.env.LD_PRELOAD) return await stat(path).catch(() => null);
  if (!cpStatApi) {
    const address = libc.symbols.dlsym(0, ptr(Buffer.from("fstatat\0")));
    cpStatApi = linkSymbols({
      fstatat: { ptr: address, args: [FFIType.i32, FFIType.cstring, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    }).symbols;
  }
  const buffer = Buffer.alloc(144);
  if (cpStatApi.fstatat(AT_FDCWD, cstrPath(path), ptr(buffer), 0) !== 0) return null;
  const mode = buffer.readUInt32LE(24);
  return { isDirectory: () => (mode & 0xf000) === 0x4000 };
}

export function readdirSyncNoThrow(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
