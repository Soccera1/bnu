#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { globMatch, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, normalizeLongOptionsByPrefix, parseOptions, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const DIRCOLORS_LONG_OPTIONS = ["sh", "bourne-shell", "csh", "c-shell", "print-database", "print-ls-colors", "help", "version"];

export async function dircolors(args) {
  args = normalizeDircolorsLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { b: false, c: false, p: false }, long: { sh: false, "bourne-shell": false, csh: false, "c-shell": false, "print-database": false, "print-ls-colors": false, help: false, version: false } });
  const db = DEFAULT_DIRCOLORS_DATABASE;
  if (operands.length > 1) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[1])}`, true);
  if ((opts.p || opts["print-database"]) && (opts["print-ls-colors"] || opts["print-ls"])) throw new UsageError("options --print-database and --print-ls-colors are mutually exclusive", true);
  if ((opts.b || opts.sh || opts["bourne-shell"] || opts.c || opts.csh || opts["c-shell"]) && (opts.p || opts["print-database"])) {
    throw new UsageError("the options to output non shell syntax,\nand to select a shell syntax are mutually exclusive", true);
  }
  if ((opts.p || opts["print-database"]) && operands.length > 0) {
    throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[0])}\nfile operands cannot be combined with --print-database (-p)`, true);
  }
  if (opts.p || opts["print-database"]) {
    stdout(db);
    return 0;
  }
  let input;
  if (operands[0]) {
    try {
      input = operands[0] === "-" ? await readStdinText() : await readFile(operands[0], "utf8");
    } catch (error) {
      const name = textInputDiagnosticName(operands[0]);
      const message = error?.code === "EISDIR" ? `${name}: read error: ${systemErrorMessage(error)}` : `${name}: ${systemErrorMessage(error)}`;
      stderr(`dircolors: ${message}\n`);
      return 1;
    }
  } else {
    input = db;
  }
  const parsed = dircolorsValue(input, operands[0] ?? null);
  if (opts["print-ls-colors"] || opts["print-ls"]) {
    stdout(parsed.parts.map((part) => {
      const [key, value] = part.split("=", 2);
      return `\x1b[${value.replaceAll("\\:", ":")}m${key}\t${value.replaceAll("\\:", ":")}\x1b[0m\n`;
    }).join(""));
    return 0;
  }
  const value = parsed.parts.length ? `${parsed.parts.join(":")}:` : "";
  if (opts.c || opts.csh || opts["c-shell"]) stdout(`setenv LS_COLORS '${value}'\n`);
  else stdout(`LS_COLORS='${shellSingleQuoteContent(value)}';\nexport LS_COLORS\n`);
  return 0;
}

export const DEFAULT_DIRCOLORS_DATABASE = [
  "RESET 0",
  "DIR 01;34",
  "LINK 01;36",
  "MULTIHARDLINK 00",
  "FIFO 40;33",
  "SOCK 01;35",
  "DOOR 01;35",
  "BLK 40;33;01",
  "CHR 40;33;01",
  "ORPHAN 01;05;37;41",
  "MISSING 01;05;37;41",
  "SETUID 37;41",
  "SETGID 30;43",
  "CAPABILITY 00",
  "STICKY_OTHER_WRITABLE 30;42",
  "OTHER_WRITABLE 34;42",
  "STICKY 37;44",
  "EXEC 01;32",
  ".7z 01;31",
  ".ace 01;31",
  ".alz 01;31",
  ".apk 01;31",
  ".arc 01;31",
  ".arj 01;31",
  ".bz 01;31",
  ".bz2 01;31",
  ".cab 01;31",
  ".cpio 01;31",
  ".crate 01;31",
  ".deb 01;31",
  ".drpm 01;31",
  ".dwm 01;31",
  ".dz 01;31",
  ".ear 01;31",
  ".egg 01;31",
  ".esd 01;31",
  ".gz 01;31",
  ".jar 01;31",
  ".lha 01;31",
  ".lrz 01;31",
  ".lz 01;31",
  ".lz4 01;31",
  ".lzh 01;31",
  ".lzma 01;31",
  ".lzo 01;31",
  ".pyz 01;31",
  ".rar 01;31",
  ".rpm 01;31",
  ".rz 01;31",
  ".sar 01;31",
  ".swm 01;31",
  ".t7z 01;31",
  ".tar 01;31",
  ".taz 01;31",
  ".tbz 01;31",
  ".tbz2 01;31",
  ".tgz 01;31",
  ".tlz 01;31",
  ".txz 01;31",
  ".tz 01;31",
  ".tzo 01;31",
  ".tzst 01;31",
  ".udeb 01;31",
  ".war 01;31",
  ".whl 01;31",
  ".wim 01;31",
  ".xz 01;31",
  ".z 01;31",
  ".zip 01;31",
  ".zoo 01;31",
  ".zst 01;31",
  ".avif 01;35",
  ".jpg 01;35",
  ".jpeg 01;35",
  ".jxl 01;35",
  ".mjpg 01;35",
  ".mjpeg 01;35",
  ".gif 01;35",
  ".bmp 01;35",
  ".pbm 01;35",
  ".pgm 01;35",
  ".ppm 01;35",
  ".tga 01;35",
  ".xbm 01;35",
  ".xpm 01;35",
  ".tif 01;35",
  ".tiff 01;35",
  ".png 01;35",
  ".svg 01;35",
  ".svgz 01;35",
  ".mng 01;35",
  ".pcx 01;35",
  ".mov 01;35",
  ".mpg 01;35",
  ".mpeg 01;35",
  ".m2v 01;35",
  ".mkv 01;35",
  ".webm 01;35",
  ".webp 01;35",
  ".ogm 01;35",
  ".mp4 01;35",
  ".m4v 01;35",
  ".mp4v 01;35",
  ".vob 01;35",
  ".qt 01;35",
  ".nuv 01;35",
  ".wmv 01;35",
  ".asf 01;35",
  ".rm 01;35",
  ".rmvb 01;35",
  ".flc 01;35",
  ".avi 01;35",
  ".fli 01;35",
  ".flv 01;35",
  ".gl 01;35",
  ".dl 01;35",
  ".xcf 01;35",
  ".xwd 01;35",
  ".yuv 01;35",
  ".cgm 01;35",
  ".emf 01;35",
  ".ogv 01;35",
  ".ogx 01;35",
  ".cfg 00;32",
  ".conf 00;32",
  ".diff 00;32",
  ".doc 00;32",
  ".ini 00;32",
  ".log 00;32",
  ".patch 00;32",
  ".pdf 00;32",
  ".ps 00;32",
  ".tex 00;32",
  ".txt 00;32",
  ".aac 00;36",
  ".au 00;36",
  ".flac 00;36",
  ".m4a 00;36",
  ".mid 00;36",
  ".midi 00;36",
  ".mka 00;36",
  ".mp3 00;36",
  ".mpc 00;36",
  ".ogg 00;36",
  ".ra 00;36",
  ".wav 00;36",
  ".oga 00;36",
  ".opus 00;36",
  ".spx 00;36",
  ".xspf 00;36",
  "*~ 00;90",
  "*# 00;90",
  ".bak 00;90",
  ".crdownload 00;90",
  ".dpkg-dist 00;90",
  ".dpkg-new 00;90",
  ".dpkg-old 00;90",
  ".dpkg-tmp 00;90",
  ".old 00;90",
  ".orig 00;90",
  ".part 00;90",
  ".rej 00;90",
  ".rpmnew 00;90",
  ".rpmorig 00;90",
  ".rpmsave 00;90",
  ".swp 00;90",
  ".tmp 00;90",
  ".ucf-dist 00;90",
  ".ucf-new 00;90",
  ".ucf-old 00;90",
  "",
].join("\n");

export function dircolorsMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const normalized = normalizeDircolorsLongOption(arg);
      const name = normalized.slice(2).split("=", 1)[0];
      if (!DIRCOLORS_LONG_OPTIONS.includes(name) || normalized.includes("=")) return null;
      if (normalized === "--help" || normalized === "--version") return normalized;
      continue;
    }
    if (arg === "-b" || arg === "-c" || arg === "-p") continue;
    if (arg.startsWith("-") && arg !== "-") return null;
  }
  return null;
}

export function normalizeDircolorsLongOptions(args) {
  return normalizeLongOptionsByPrefix(args, DIRCOLORS_LONG_OPTIONS);
}

export function normalizeDircolorsLongOption(arg) {
  return normalizeLongOptionByPrefix(arg, DIRCOLORS_LONG_OPTIONS);
}

export async function readStdinText() {
  const data = await Bun.stdin.arrayBuffer();
  return new TextDecoder().decode(data);
}

export function dircolorsValue(db, sourceName = null) {
  const keys = {
    RESET: "rs",
    NORMAL: "no",
    FILE: "fi",
    DIR: "di",
    LINK: "ln",
    FIFO: "pi",
    SOCK: "so",
    DOOR: "do",
    BLK: "bd",
    CHR: "cd",
    ORPHAN: "or",
    MISSING: "mi",
    SETUID: "su",
    SETGID: "sg",
    CAPABILITY: "ca",
    STICKY_OTHER_WRITABLE: "tw",
    OTHER_WRITABLE: "ow",
    STICKY: "st",
    EXEC: "ex",
    MULTIHARDLINK: "mh",
    OWT: "tw",
    LEFTCODE: "lc",
    RIGHTCODE: "rc",
    ENDCODE: "ec",
  };
  const parts = [];
  let active = true;
  let sawSelector = false;
  let lineNo = 0;
  for (const raw of db.split("\n")) {
    lineNo++;
    const line = raw.trimStart().startsWith("#") ? "" : raw.replace(/\s+#.*/, "").trim();
    if (!line) continue;
    const match = line.match(/^(\S+)(?:\s+(.+))?$/);
    const key = match?.[1]?.toUpperCase();
    let value = match?.[2];
    if (!value) throw new UsageError(`${sourceName ? `${sourceName}:` : ""}${lineNo}: invalid line;  missing second token`);
    if (key === "TERM" || key === "COLORTERM") {
      sawSelector = true;
      const envValue = key === "TERM" ? process.env.TERM ?? "none" : process.env.COLORTERM ?? "";
      active = globMatch(value, envValue);
      continue;
    }
    if (!sawSelector || active) {
      const mapped = keys[key];
      if (mapped) parts.push(`${mapped}=${dircolorsEscapeValue(value)}`);
      else if (key.startsWith(".")) parts.push(`*${match[1]}=${dircolorsEscapeValue(value)}`);
      else if (key.startsWith("*")) parts.push(`${match[1]}=${dircolorsEscapeValue(value)}`);
    }
  }
  return { parts };
}

export function dircolorsEscapeValue(value) {
  let out = "";
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      out += ch === ":" ? "\\:" : `\\${ch}`;
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else {
      out += ch === ":" ? "\\:" : ch;
    }
  }
  if (escaped) out += "\\";
  return out;
}

export function shellSingleQuoteContent(value) {
  return value.replaceAll("'", "'\\''");
}

const singleCall = defineCommand("dircolors", dircolors, dircolorsMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
