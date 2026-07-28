import { mkdirSync } from "node:fs";
import { chown, unlink as fsUnlink, lstat, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, basename as pathBasename, dirname as pathDirname } from "node:path";
import { localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, parseOptions, pathDisplayName, selinuxRuntimeEnabled, shellEscapeLsName, statAttachNanoseconds, touchStatDate } from "./common.js";
import { backupDestination, cpCopyFileContents, cpDebugLine, validateBackupMode } from "./copy.js";
import { InvocationError, UsageError, stderr, stdout } from "./diagnostics.js";
import { errnoMessage, invalidModeDiagnosticValue, mkdirParents, parseModeSpec, resolveGroup, resolveUser, selinuxSecurityContext, setFileMode, setSelinuxSecurityContext, touchSetPathTimes, withSelinuxCreationContext } from "./filesystem.js";

export const INSTALL_LONG_OPTIONS = ["backup", "compare", "directory", "debug", "group", "mode", "owner", "preserve-timestamps", "strip", "strip-program", "suffix", "target-directory", "no-target-directory", "verbose", "preserve-context", "context", "help", "version"];

export async function installCmd(args, program = "install") {
  args = normalizeInstallLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { c: false, C: false, D: false, d: false, g: "value", m: "value", o: "value", p: false, t: "value", T: false, v: false, b: false, S: "value", s: false, Z: false }, long: { compare: false, debug: false, directory: false, group: "value", mode: "value", "no-target-directory": false, owner: "value", "preserve-context": false, "preserve-timestamps": false, verbose: false, backup: "optional-value", suffix: "value", strip: false, "strip-program": "value", "target-directory": "value", context: "optional-value", help: false, version: false } });
  if (opts.p) opts["preserve-timestamps"] = true;
  if (opts.b != null && opts.backup == null) opts.backup = opts.b;
  if (opts.S != null && opts.suffix == null) opts.suffix = opts.S;
  if (opts.b || opts.backup != null) validateBackupMode(program, opts.backup);
  if ((opts.C || opts.compare) && (opts.s || opts.strip)) throw new UsageError("options --compare (-C) and --strip are mutually exclusive", true);
  if (opts["strip-program"] != null && !(opts.s || opts.strip)) {
    stderr(`${program}: WARNING: ignoring --strip-program option as -s option was not specified\n`);
  }
  const verbose = opts.v || opts.verbose || opts.debug;
  const securityContext = installSecurityContextOptions(program, opts);
  if (opts.d || opts.directory) {
    if (!operands.length) throw new UsageError("missing file operand", true);
    const mode = opts.m || opts.mode ? parseInstallMode(opts.m ?? opts.mode) : undefined;
    const uid = await resolveUser(opts.o ?? opts.owner);
    const gid = await resolveGroup(opts.g ?? opts.group);
    let status = 0;
    await withSelinuxCreationContext(program, securityContext, async (created, sameThread) => {
      for (const dir of operands) {
        try {
          const existing = await lstat(dir).catch(() => null);
          if (existing && !existing.isDirectory()) {
            stderr(`${program}: cannot create directory ${installQuotedName(dir)}: File exists\n`);
            status = 1;
            continue;
          }
          await mkdirParents(dir, mode ?? 0o755, false, created, sameThread);
          if (mode !== undefined) await setFileMode(dir, mode);
          if (uid != null || gid != null) await chown(dir, uid ?? (await stat(dir)).uid, gid ?? (await stat(dir)).gid);
          if (verbose) stdout(`${program}: creating directory ${installQuotedName(dir)}\n`);
        } catch (error) {
          if (error instanceof UsageError && error.message.startsWith("failed to set default file creation context")) throw error;
          stderr(`${program}: cannot create directory ${installQuotedName(dir)}: ${errnoMessage(error)}\n`);
          status = 1;
        }
      }
    });
    return status;
  }
  const targetDirectory = opts.t ?? opts["target-directory"];
  const noTargetDirectory = opts.T || opts["no-target-directory"];
  if (targetDirectory != null && noTargetDirectory) throw new UsageError("cannot combine --target-directory and --no-target-directory");
  if (noTargetDirectory && operands.length > 2) throw new UsageError(`extra operand ${shellEscapeLsName(operands[2], true)}`, true);
  if (targetDirectory == null && operands.length < 2) throw installMissingOperandError(operands);
  if (targetDirectory != null && operands.length < 1) throw installMissingOperandError(operands);
  const mode = opts.m || opts.mode ? parseInstallMode(opts.m ?? opts.mode) : undefined;
  const uid = await resolveUser(opts.o ?? opts.owner);
  const gid = await resolveGroup(opts.g ?? opts.group);
  const dest = targetDirectory ?? operands.at(-1);
  const sources = targetDirectory == null ? operands.slice(0, -1) : operands;
  let destStat = await stat(dest).catch(() => null);
  if (targetDirectory != null && !destStat) {
    if (opts.D) {
      try {
        await withSelinuxCreationContext(program, securityContext, (created, sameThread) => makeInstallParents(dest, opts, program, created, sameThread));
        destStat = await stat(dest);
      } catch (error) {
        stderr(`${program}: cannot create directory ${installQuotedName(dest)}: ${errnoMessage(error)}\n`);
        return 1;
      }
    } else {
      stderr(`${program}: failed to access ${installQuotedName(dest)}: No such file or directory\n`);
      return 1;
    }
  }
  if (targetDirectory != null && destStat && !destStat.isDirectory()) {
    stderr(`${program}: failed to access ${installQuotedName(dest)}: Not a directory\n`);
    return 1;
  }
  if (sources.length > 1 && !destStat?.isDirectory() && !opts.D) throw new UsageError(`target '${dest}' is not a directory`);
  if (noTargetDirectory && destStat?.isDirectory()) throw new UsageError(`cannot overwrite directory '${dest}' with non-directory '${sources[0]}'`);
  for (const src of sources) {
    const target = !noTargetDirectory && (targetDirectory != null || destStat?.isDirectory()) ? join(dest, pathBasename(src)) : dest;
    const srcStat = await stat(src).catch(() => null);
    if (!srcStat) {
      stderr(`${program}: cannot stat ${installQuotedName(src)}: No such file or directory\n`);
      return 1;
    }
    if (srcStat?.isDirectory()) {
      stderr(`${program}: omitting directory ${installQuotedName(src)}\n`);
      return 1;
    }
    const targetStat = await stat(target).catch(() => null);
    if (srcStat && targetStat && srcStat.dev === targetStat.dev && srcStat.ino === targetStat.ino) {
      const targetDisplay = targetDirectory != null && dest === "." ? `./${pathBasename(src)}` : target;
      stderr(`${program}: ${installQuotedName(src)} and ${installQuotedName(targetDisplay)} are the same file\n`);
      return 1;
    }
    if (opts.D || targetDirectory != null) {
      await withSelinuxCreationContext(program, securityContext, (created, sameThread) => makeInstallParents(pathDirname(target), opts, program, created, sameThread));
    }
    if ((opts.C || opts.compare) && await installTargetMatches(src, target, mode ?? 0o755, opts, securityContext, uid, gid)) continue;
    if (opts.b || opts.backup != null) await backupDestination(target, opts.suffix, opts.backup);
    if (await lstat(target).catch(() => null)) {
      await fsUnlink(target);
      if (opts.v || opts.verbose) stdout(`removed ${installQuotedName(target)}\n`);
    }
    const copyDebug = opts.debug ? { reflinkMode: "auto", sparseMode: "auto", debug: true } : {};
    await withSelinuxCreationContext(program, securityContext, async (created) => {
      await cpCopyFileContents(src, target, await stat(src), copyDebug);
      await created(target);
    });
    await setFileMode(target, mode ?? 0o755);
    if (uid != null || gid != null) {
      const s = await stat(target);
      await chown(target, uid ?? s.uid, gid ?? s.gid);
    }
    if (opts["preserve-timestamps"]) {
      const s = statAttachNanoseconds(await stat(src), src, true);
      await touchSetPathTimes(target, touchStatDate(s, "atime"), touchStatDate(s, "mtime"), false);
    }
    if ((opts.s || opts.strip) && !(await stripInstalledFile(target, opts["strip-program"], program))) return 1;
    await applyInstallSecurityContext(src, target, securityContext);
    if (verbose) stdout(`${installQuotedName(src)} -> ${installQuotedName(target)}\n`);
    if (opts.debug) stdout(cpDebugLine(copyDebug));
  }
  return 0;
}

export function installSecurityContextOptions(program, opts) {
  const enabled = selinuxRuntimeEnabled();
  if (typeof opts.context === "string" && !enabled) stderr(`${program}: warning: ignoring --context; it requires an SELinux-enabled kernel\n`);
  if (opts["preserve-context"] && !enabled) stderr(`${program}: WARNING: ignoring --preserve-context; this kernel is not SELinux-enabled\n`);
  const explicitContext = typeof opts.context === "string" && enabled ? opts.context : null;
  const restoreContext = enabled && (opts.Z || opts.context === true);
  const preserveContext = enabled && Boolean(opts["preserve-context"]);
  if (preserveContext && (explicitContext != null || restoreContext)) {
    throw new InvocationError("cannot set target context and preserve it", 1, false);
  }
  return { enabled, explicitContext, restoreContext, preserveContext };
}

export async function applyInstallSecurityContext(src, target, options) {
  if (!options.preserveContext) return;
  const context = selinuxSecurityContext(src);
  if (context == null) throw new UsageError(`failed to get security context of '${src}'`);
  if (!setSelinuxSecurityContext(target, context)) throw new UsageError(`failed to set the security context of '${target}'`);
}

export function installMissingOperandError(operands) {
  return operands.length
    ? new UsageError(`missing destination file operand after '${operands.at(-1)}'`, true)
    : new UsageError("missing file operand", true);
}

export function parseInstallMode(spec) {
  try {
    return /^[0-7]+$/.test(spec) ? Number.parseInt(spec, 8) : parseModeSpec(spec, 0, true, { ignoreUmask: true }).mode;
  } catch (error) {
    if (error instanceof UsageError && invalidModeDiagnosticValue(error.message) != null) {
      throw new UsageError(`invalid mode ${localeQuotedEscapedDiagnostic(spec)}`);
    }
    throw error;
  }
}

export async function makeInstallParents(dir, opts, program = "install", created = async () => {}, sameThread = false) {
  if (!dir || dir === ".") return;
  const parts = [];
  let cursor = dir;
  while (cursor && cursor !== "." && !(await stat(cursor).catch(() => null))) {
    parts.push(cursor);
    cursor = pathDirname(cursor);
  }
  for (const path of parts.reverse()) {
    if (sameThread) mkdirSync(path);
    else await mkdir(path);
    await created(path);
    if (opts.v || opts.verbose) stdout(`${program}: creating directory ${installQuotedName(path)}\n`);
  }
}

export function installQuotedName(path) {
  return shellEscapeLsName(pathDisplayName(path), true);
}

export async function installTargetMatches(src, target, mode, opts, securityContext = {}, uid = null, gid = null) {
  const srcStat = await stat(src).then((s) => statAttachNanoseconds(s, src, true), () => null);
  const targetLinkStat = await lstat(target).catch(() => null);
  if (!srcStat || !targetLinkStat?.isFile()) return false;
  const targetStat = await stat(target);
  if ((mode & 0o7000) !== 0) return false;
  if ((targetStat.mode & 0o7777) !== mode) return false;
  const expectedUid = uid ?? process.getuid?.() ?? targetStat.uid;
  const expectedGid = gid ?? process.getgid?.() ?? targetStat.gid;
  if (targetStat.uid !== expectedUid || targetStat.gid !== expectedGid) return false;
  const [srcBytes, targetBytes] = await Promise.all([readFile(src), readFile(target)]);
  if (srcBytes.length !== targetBytes.length) return false;
  for (let i = 0; i < srcBytes.length; i++) if (srcBytes[i] !== targetBytes[i]) return false;
  if (securityContext.preserveContext && selinuxSecurityContext(src) !== selinuxSecurityContext(target)) return false;
  if (opts["preserve-timestamps"]) await touchSetPathTimes(target, touchStatDate(srcStat, "atime"), touchStatDate(srcStat, "mtime"), false);
  return true;
}

export async function stripInstalledFile(target, stripProgramOption, program = "install") {
  const stripProgram = stripProgramOption ?? "strip";
  const stripTarget = target.startsWith("-") ? `./${target}` : target;
  try {
    const proc = Bun.spawn([stripProgram, stripTarget], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code === 0) return true;
  } catch (error) {
    stderr(`${program}: cannot run strip program ${installQuotedName(stripProgram)}: ${errnoMessage(error)}\n`);
  }
  await rm(target, { force: true });
  return false;
}

export function installMetaOption(args) {
  const normalized = normalizeInstallLongOptions(args);
  const longValueOptions = new Set(["group", "mode", "owner", "strip-program", "suffix", "target-directory"]);
  const longOptionalValueOptions = new Set(["backup", "context"]);
  const longKnownOptions = new Set(INSTALL_LONG_OPTIONS);
  const shortValueOptions = new Set(["g", "m", "o", "S", "t"]);
  const shortKnownOptions = new Set(["b", "c", "C", "D", "d", "g", "m", "o", "p", "s", "S", "t", "T", "v", "Z"]);
  let sawPreserveContext = false;
  let sawContextValue = false;
  for (let i = 0; i < normalized.length; i++) {
    const arg = normalized[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
      if (!longKnownOptions.has(name)) return null;
      if ((arg === "--help" || arg === "--version") && inlineValue == null) {
        if (sawPreserveContext && !selinuxRuntimeEnabled()) stderr("install: WARNING: ignoring --preserve-context; this kernel is not SELinux-enabled\n");
        if (sawContextValue && !selinuxRuntimeEnabled()) stderr("install: warning: ignoring --context; it requires an SELinux-enabled kernel\n");
        return arg;
      }
      if (name === "preserve-context") sawPreserveContext = true;
      if (name === "context" && inlineValue !== undefined) sawContextValue = true;
      if (longValueOptions.has(name)) {
        if (inlineValue == null) i++;
      } else if (longOptionalValueOptions.has(name)) {
        continue;
      } else if (inlineValue != null) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        if (arg.slice(j + 1) === "") i++;
        break;
      }
    }
  }
  return null;
}

export function normalizeInstallLongOptions(args) {
  const out = [];
  const valueOptions = new Set(["group", "mode", "owner", "strip-program", "suffix", "target-directory"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      out.push(arg, ...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      out.push(arg);
      continue;
    }
    const normalized = normalizeLongOptionByPrefix(arg, INSTALL_LONG_OPTIONS);
    out.push(normalized);
    const [name, inlineValue] = normalized.slice(2).split(/=(.*)/s, 2);
    if (valueOptions.has(name) && inlineValue == null && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}
