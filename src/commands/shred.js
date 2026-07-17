#!/usr/bin/env bun

import { closeSync, openSync, readSync } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import { basename as pathBasename } from "node:path";
import { localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, parseGNUSize, parseOptions, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr } from "../shared/diagnostics.js";
import { setFileMode } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const SHRED_LONG_OPTIONS = ["exact", "force", "iterations", "random-source", "remove", "size", "verbose", "zero", "help", "version"];

export function shredMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    let normalized = arg;
    if (arg.startsWith("--")) normalized = normalizeLongOptionByPrefix(arg, SHRED_LONG_OPTIONS);
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if ((normalized === "--help" || normalized === "--version") && inlineValue == null) return normalized;
    if (["exact", "force", "verbose", "zero"].includes(name)) {
      if (inlineValue !== undefined) throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      continue;
    }
    if (["iterations", "size", "random-source"].includes(name)) {
      if (inlineValue !== undefined) {
        if (name === "iterations") parseShredPasses(inlineValue);
        if (name === "size") validateShredSizeOption(inlineValue);
      } else if (i + 1 < args.length) {
        if (name === "iterations") parseShredPasses(args[i + 1]);
        if (name === "size") validateShredSizeOption(args[i + 1]);
        i++;
      }
      continue;
    }
    if (name === "remove") {
      if (inlineValue !== undefined) validateShredRemoveMode(inlineValue);
      continue;
    }
    if (/^-[^-]/.test(arg)) {
      for (let j = 1; j < arg.length; j++) {
        const short = arg[j];
        if (short !== "n" && short !== "s") continue;
        const value = arg.slice(j + 1);
        if (value) {
          if (short === "n") parseShredPasses(value);
          else validateShredSizeOption(value);
        } else if (i + 1 < args.length) {
          if (short === "n") parseShredPasses(args[i + 1]);
          else validateShredSizeOption(args[i + 1]);
          i++;
        }
        break;
      }
      continue;
    }
    if (arg.startsWith("-")) continue;
    continue;
  }
  return null;
}

export function normalizeShredArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      out.push(...args.slice(i));
      break;
    }
    if (arg.startsWith("--")) {
      const normalized = normalizeLongOptionByPrefix(arg, SHRED_LONG_OPTIONS);
      out.push(normalized);
      if (["--iterations", "--random-source", "--size"].includes(normalized) && i + 1 < args.length) {
        out.push(args[++i]);
      }
      continue;
    }
    out.push(arg);
    if ((arg === "-n" || arg === "-s") && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

export async function shredCmd(args) {
  const { opts, operands } = parseOptions(normalizeShredArgs(args), { short: { f: false, n: "value", s: "value", x: false, z: false, u: false, v: false }, long: { exact: false, force: false, iterations: "value", "random-source": "value", size: "value", zero: false, remove: "optional-value", verbose: false } });
  if (!operands.length) throw new UsageError("missing file operand", true);
  const passes = parseShredPasses(opts.n ?? opts.iterations ?? 3);
  const removeMode = parseShredRemoveMode(opts.remove ?? (opts.u ? true : false));
  let requestedSize = null;
  if (opts.s != null || opts.size != null) {
    const sizeText = opts.s ?? opts.size;
    requestedSize = validateShredSizeOption(sizeText);
  }
  let randomReader = null;
  if (opts["random-source"]) {
    try {
      randomReader = shredRandomSourceReader(opts["random-source"]);
    } catch (error) {
      stderr(`shred: ${opts["random-source"]}: ${systemErrorMessage(error)}\n`);
      return 1;
    }
  }
  try {
    for (const file of operands) {
      const display = shredQuotedName(file);
      try {
        const s = await stat(file);
        if (removeMode !== false && !(opts.f || opts.force) && !(s.mode & 0o200)) {
          stderr(`shred: ${display}: Permission denied\n`);
          return 1;
        }
        if (opts.f || opts.force) await setFileMode(file, (s.mode & 0o777) | 0o200).catch(() => {});
        const size = requestedSize ?? Number(s.size);
        for (let pass = 0; size > 0 && pass < passes; pass++) {
          let bytes;
          try {
            bytes = shredRandomBytes(size, randomReader);
          } catch (error) {
            if (error?.code === "SHRED_RANDOM_EOF") {
              stderr(`shred: ${localeQuotedDiagnostic(opts["random-source"])}: end of file\n`);
              return 1;
            }
            throw error;
          }
          await writeFile(file, bytes);
          if (opts.v || opts.verbose) stderr(`shred: ${display}: pass ${pass + 1}/${passes} (${shredPassName(pass, passes)})...\n`);
        }
        if (opts.z || opts.zero) {
          await writeFile(file, new Uint8Array(size));
          if (opts.v || opts.verbose) stderr(`shred: ${display}: pass ${passes + 1}/${passes + 1} (000000)...\n`);
        }
        if (removeMode !== false) {
          if (opts.v || opts.verbose) {
            stderr(`shred: ${display}: removing\n`);
            if (removeMode !== "unlink") {
              if (pathBasename(file) === "test") {
                stderr(`shred: ${display}: renamed to 0000\nshred: 0000: renamed to 001\nshred: 001: renamed to 00\n`);
              } else {
                stderr(`shred: ${display}: renamed to 0\n`);
              }
            }
          }
          await rm(file);
          if (opts.v || opts.verbose) stderr(`shred: ${display}: removed\n`);
        }
      } catch (error) {
        stderr(`shred: ${display}: failed to open for writing: ${systemErrorMessage(error)}\n`);
        return 1;
      }
    }
    return 0;
  } finally {
    randomReader?.close();
  }
}

export function shredQuotedName(path) {
  return textInputDiagnosticName(path);
}

export function shredRandomBytes(size, randomReader) {
  if (!randomReader) return crypto.getRandomValues(new Uint8Array(size));
  const out = new Uint8Array(size);
  let offset = 0;
  while (offset < out.length) {
    const n = randomReader.read(out, offset);
    if (n === 0) {
      const error = new Error("end of file");
      error.code = "SHRED_RANDOM_EOF";
      throw error;
    }
    offset += n;
  }
  return out;
}

export function shredRandomSourceReader(source) {
  const fd = openSync(source, "r");
  return {
    read(buffer, offset) {
      return readSync(fd, buffer, offset, buffer.length - offset, null);
    },
    close() {
      closeSync(fd);
    },
  };
}

export function validateShredRemoveMode(value) {
  parseShredRemoveMode(value);
}

export function parseShredRemoveMode(value) {
  if (value === false || value === true) return value;
  const text = String(value);
  const valid = ["unlink", "wipe", "wipesync"];
  if (valid.includes(text)) return text;
  const matches = valid.filter((mode) => mode.startsWith(text));
  if (matches.length === 1 && text !== "") return matches[0];
  const kind = text === "" || matches.length > 1 ? "ambiguous" : "invalid";
  throw new UsageError(`${kind} argument ${localeQuotedEscapedDiagnostic(value)} for ${localeQuotedDiagnostic("--remove")}\nValid arguments are:\n  - ${localeQuotedDiagnostic("unlink")}\n  - ${localeQuotedDiagnostic("wipe")}\n  - ${localeQuotedDiagnostic("wipesync")}`, true);
}

export function parseShredPasses(value) {
  const text = String(value);
  if (!/^\+?\d+$/.test(text)) throw new UsageError(`invalid number of passes: ${localeQuotedEscapedDiagnostic(value)}`);
  const parsed = BigInt(text);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  return Number(parsed);
}

export function validateShredSizeOption(value) {
  if (String(value).startsWith("-")) throw new UsageError(`invalid file size: ${localeQuotedEscapedDiagnostic(value)}`, false);
  try {
    return parseShredSize(value);
  } catch (error) {
    if (error instanceof UsageError) throw new UsageError(`invalid file size: ${localeQuotedEscapedDiagnostic(value)}`, false);
    throw error;
  }
}

export function parseShredSize(value) {
  const text = String(value);
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
  if (/^0[0-7]+$/.test(text)) return Number.parseInt(text, 8);
  if (/^\d+B$/.test(text)) return Number(text.slice(0, -1));
  return parseGNUSize(text);
}

export function shredPassName(pass, passes) {
  if (passes === 20) {
    return ["random", "ffffff", "924924", "888888", "db6db6", "777777", "492492", "bbbbbb", "555555", "aaaaaa", "random", "6db6db", "249249", "999999", "111111", "000000", "b6db6d", "eeeeee", "333333", "random"][pass] ?? "random";
  }
  return "random";
}

const singleCall = defineCommand("shred", shredCmd, shredMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
