#!/usr/bin/env bun

import { stat, statfs, truncate, writeFile } from "node:fs/promises";
import { dirname as pathDirname } from "node:path";
import { cstrPath, libc, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions, pathDisplayName, shellEscapeLsName, systemErrorMessage } from "../shared/common.js";
import { UsageError, stderr } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const TRUNCATE_LONG_OPTIONS = ["io-blocks", "no-create", "reference", "size", "help", "version"];

export function truncateMetaOption(args) {
  const longValueOptions = new Set(["reference", "size"]);
  const shortValueOptions = new Set(["r", "s"]);
  const shortKnownOptions = new Set(["c", "o", "r", "s"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeTruncateLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!TRUNCATE_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (name === "size" && inlineValue != null && !isValidTruncateSizeOperand(inlineValue)) return null;
      if (inlineValue == null && longValueOptions.has(name)) {
        if (name === "size" && (i + 1 >= args.length || !isValidTruncateSizeOperand(args[i + 1]))) return null;
        i++;
      }
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        const inlineValue = arg.slice(j + 1);
        if (ch === "s" && inlineValue !== "" && !isValidTruncateSizeOperand(inlineValue)) return null;
        if (inlineValue === "") {
          if (ch === "s" && (i + 1 >= args.length || !isValidTruncateSizeOperand(args[i + 1]))) return null;
          i++;
        }
        break;
      }
    }
  }
  return null;
}

export async function truncateCmd(args) {
  args = normalizeTruncateLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { s: "value", c: false, r: "value", o: false }, long: { size: "value", "no-create": false, reference: "value", "io-blocks": false, help: false, version: false } });
  const size = opts.s ?? opts.size;
  const reference = opts.r ?? opts.reference;
  if (size == null && reference == null) throw new UsageError("you must specify either '--size' or '--reference'", true);
  if (size != null) truncateTargetSize(0, size);
  if (reference != null && size != null && !isTruncateRelativeSize(size)) {
    throw new UsageError(`you must specify a relative ${localeQuotedDiagnostic("--size")} with ${localeQuotedDiagnostic("--reference")}`, true);
  }
  if (!operands.length) throw new UsageError("missing file operand", true);
  if ((opts.o || opts["io-blocks"]) && reference != null && size == null) throw new UsageError("'--io-blocks' was specified but '--size' was not", true);
  let referenceSize = null;
  if (reference != null) {
    try {
      referenceSize = (await stat(reference)).size;
    } catch (error) {
      throw new UsageError(`cannot stat ${truncateQuotedName(reference)}: ${systemErrorMessage(error)}`);
    }
  }
  let status = 0;
  for (const file of operands) {
    try {
      let missing = false;
      const current = await stat(file).then((s) => s.size, (error) => {
        if (error.code === "ENOENT" && (opts.c || opts["no-create"])) return null;
        if (error.code === "ENOENT") {
          missing = true;
          return 0;
        }
        throw error;
      });
      if (current == null) continue;
      if (missing) await writeFile(file, "");
      const base = referenceSize ?? current;
      const ioBlockSize = opts.o || opts["io-blocks"] ? await truncateIoBlockSize(file) : 1;
      const target = size == null ? BigInt(referenceSize) : truncateTargetSize(base, size, ioBlockSize);
      if (target < 0n) throw new UsageError(`Invalid number: ${localeQuotedDiagnostic(size ?? target)}: Value too large for defined data type`);
      await truncateFileToSize(file, target);
    } catch (error) {
      if (error instanceof UsageError) throw error;
      stderr(`truncate: ${truncateErrorPrefix(error, file)}: ${truncateErrorMessage(error)}\n`);
      status = 1;
    }
  }
  return status;
}

export function normalizeTruncateLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, TRUNCATE_LONG_OPTIONS);
}

export function normalizeTruncateLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, TRUNCATE_LONG_OPTIONS);
}

export function isValidTruncateSizeOperand(value) {
  try {
    truncateTargetSize(0, value);
    return true;
  } catch {
    return false;
  }
}

export function isTruncateRelativeSize(spec) {
  return /^[+\-<>/%]/.test(String(spec).trimStart());
}

export async function truncateIoBlockSize(file) {
  try {
    const fs = await statfs(file);
    return fs.bsize || 512;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const dir = pathDirname(file) || ".";
    const fs = await statfs(dir);
    return fs.bsize || 512;
  }
}

export function truncateTargetSize(current, spec, blockScale = 1) {
  current = BigInt(current);
  const text = String(spec).trimStart();
  const op = /^[+\-<>/%]/.test(text) ? text[0] : "";
  const amount = parseGNUSizeCheckedNumber(op ? text.slice(1) : text, BigInt(blockScale), text);
  if (op === "+") return current + amount;
  if (op === "-") return current > amount ? current - amount : 0n;
  if (op === "<") return current < amount ? current : amount;
  if (op === ">") return current > amount ? current : amount;
  if ((op === "/" || op === "%") && amount === 0n) throw new UsageError(`division by zero`);
  if (op === "/") return current - (current % amount);
  if (op === "%") return current + ((amount - (current % amount)) % amount);
  return amount;
}

export async function truncateFileToSize(file, size) {
  if (size <= BigInt(Number.MAX_SAFE_INTEGER)) {
    await truncate(file, Number(size));
    return;
  }
  if (libc.symbols.truncate(cstrPath(file), size) !== 0) {
    throw new Error("Invalid argument");
  }
}

export function parseGNUSizeCheckedNumber(value, extraScale = 1n, original = value) {
  const match = String(value).match(/^(\d+)([A-Za-z]*)$/);
  if (!match) throw new UsageError(`Invalid number: ${localeQuotedEscapedDiagnostic(original)}`);
  const suffixScales = {
    "": 1n, K: 1024n, k: 1024n, KiB: 1024n, kiB: 1024n,
    M: 1024n ** 2n, m: 1024n ** 2n, MiB: 1024n ** 2n, miB: 1024n ** 2n,
    G: 1024n ** 3n, g: 1024n ** 3n, GiB: 1024n ** 3n, giB: 1024n ** 3n,
    T: 1024n ** 4n, t: 1024n ** 4n, TiB: 1024n ** 4n, tiB: 1024n ** 4n,
    P: 1024n ** 5n, PiB: 1024n ** 5n,
    E: 1024n ** 6n, EiB: 1024n ** 6n,
    Z: 1024n ** 7n, ZiB: 1024n ** 7n,
    Y: 1024n ** 8n, YiB: 1024n ** 8n,
    R: 1024n ** 9n, RiB: 1024n ** 9n,
    Q: 1024n ** 10n, QiB: 1024n ** 10n,
    KB: 1000n, kB: 1000n, MB: 1000n ** 2n, mB: 1000n ** 2n,
    GB: 1000n ** 3n, gB: 1000n ** 3n, TB: 1000n ** 4n, tB: 1000n ** 4n,
    PB: 1000n ** 5n, EB: 1000n ** 6n, ZB: 1000n ** 7n, YB: 1000n ** 8n,
    RB: 1000n ** 9n, QB: 1000n ** 10n,
  };
  const scale = suffixScales[match[2]];
  if (!scale) throw new UsageError(`Invalid number: ${localeQuotedEscapedDiagnostic(original)}`);
  const amount = BigInt(match[1]) * scale * extraScale;
  if (amount > 9223372036854775807n) {
    throw new UsageError(`Invalid number: ${localeQuotedEscapedDiagnostic(original)}: Value too large for defined data type`);
  }
  return amount;
}

export function truncateErrorPrefix(error, file) {
  if ((error?.code === "ENOENT" && error?.syscall === "open") || error?.code === "ENOTDIR" || error?.code === "EISDIR") return `cannot open ${truncateQuotedName(file)} for writing`;
  return `failed to truncate ${truncateQuotedName(file)}`;
}

export function truncateQuotedName(path) {
  return shellEscapeLsName(pathDisplayName(path), true);
}

export function truncateErrorMessage(error) {
  if (error?.code === "ENOENT") return "No such file or directory";
  if (error?.code === "EISDIR") return "Is a directory";
  if (error?.code === "ENOTDIR") return "Not a directory";
  if (error?.code === "EINVAL") return "Invalid argument";
  return error?.message || String(error);
}

const singleCall = defineCommand("truncate", truncateCmd, truncateMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
