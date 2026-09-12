import { chmodSync, chownSync, closeSync, constants, linkSync, lstatSync, openSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseOptions, readAll } from "./common.js";
import { stderr, stdout, UsageError } from "./diagnostics.js";

export function gzipHeader(data) {
  if (data.length < 18 || data[0] !== 31 || data[1] !== 139 || data[2] !== 8) throw new Error("not in gzip format");
  const flags = data[3];
  if (flags & 0xe0) throw new Error("invalid gzip header flags");
  let offset = 10, name;
  if (flags & 4) {
    if (offset + 2 > data.length) throw new Error("unexpected end of gzip header");
    offset += 2 + data.readUInt16LE(offset);
  }
  for (const flag of [8, 16]) if (flags & flag) {
    const end = data.indexOf(0, offset);
    if (end < 0) throw new Error("unexpected end of gzip header");
    if (flag === 8) name = data.subarray(offset, end).toString("latin1");
    offset = end + 1;
  }
  if (flags & 2) offset += 2;
  if (offset + 8 > data.length) throw new Error("unexpected end of gzip header");
  return { name, mtime: data.readUInt32LE(4), offset };
}

export function compressGzip(data, options = {}) {
  const compressed = gzipSync(data, { level: options.level ?? 6 });
  const header = Buffer.from(compressed.subarray(0, 10));
  header.writeUInt32LE(Math.max(0, Math.floor(options.mtime ?? 0)) >>> 0, 4);
  const name = options.name ? Buffer.from(`${basename(options.name)}\0`, "latin1") : Buffer.alloc(0);
  if (name.length) header[3] |= 8;
  return Buffer.concat([header, name, compressed.subarray(10)]);
}

function decompressedName(file, suffix) {
  if (suffix && file.endsWith(suffix)) return file.slice(0, -suffix.length);
  if (/\.t(?:gz|az)$/i.test(file)) return file.slice(0, -4) + ".tar";
  for (const ending of [".gz", ".z", "-gz", "-z", "_z"]) if (file.toLowerCase().endsWith(ending)) return file.slice(0, -ending.length);
  return null;
}

function replaceFile(path, data, info, force, mtime) {
  try {
    lstatSync(path);
    if (!force) throw new Error(`${path} already exists; not overwritten`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = join(dirname(path), `.bnu-gzip-${process.pid}-${Math.random().toString(16).slice(2)}`);
  let created = false;
  try {
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    created = true;
    try { writeFileSync(fd, data); } finally { closeSync(fd); }
    if (info) {
      try { chownSync(temporary, info.uid, info.gid); } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
      chmodSync(temporary, info.mode & 0o7777);
      utimesSync(temporary, info.atime, mtime ? new Date(mtime * 1000) : info.mtime);
    }
    // The destination check above provides the familiar refusal on existing
    // files; hard-linking the completed temp file supplies atomic no-clobber.
    if (!force) {
      linkSync(temporary, path);
      unlinkSync(temporary);
    } else renameSync(temporary, path);
    created = false;
  } finally { if (created) unlinkSync(temporary); }
}

export async function gzipCommand(args, program = "gzip") {
  const { opts, operands } = parseOptions(args, {
    short: { c: false, d: false, f: false, k: false, l: false, n: false, N: false, q: false, r: false, S: "value", t: false, v: false, "1": false, "2": false, "3": false, "4": false, "5": false, "6": false, "7": false, "8": false, "9": false },
    long: { stdout: false, "to-stdout": false, decompress: false, uncompress: false, force: false, keep: false, list: false, "no-name": false, name: false, quiet: false, recursive: false, suffix: "value", test: false, verbose: false, fast: false, best: false },
  });
  const decompress = program !== "gzip" || opts.d || opts.decompress || opts.uncompress || opts.t || opts.test || opts.l || opts.list;
  const toStdout = program === "zcat" || opts.c || opts.stdout || opts["to-stdout"];
  const force = opts.f || opts.force, keep = opts.k || opts.keep;
  const list = opts.l || opts.list, test = opts.t || opts.test;
  const recursive = opts.r || opts.recursive, quiet = opts.q || opts.quiet, verbose = opts.v || opts.verbose;
  const suffix = opts.S ?? opts.suffix ?? ".gz";
  if (!suffix) throw new UsageError("invalid suffix ''");
  let level = opts.fast ? 1 : opts.best ? 9 : 6;
  for (const arg of args) if (/^-[1-9]$/.test(arg)) level = Number(arg[1]);
  for (let number = 1; number <= 9; number++) if (opts[String(number)]) level = number;
  const noName = opts.n || opts["no-name"], restoreName = (opts.N || opts.name) && !noName;
  let status = 0, listed = 0;
  const report = (message, code = 1) => { if (!quiet || code === 1) stderr(`${program}: ${message}\n`); if (status !== 1) status = code; };
  const processFile = async file => {
    try {
      let info, actual = file;
      if (file !== "-") {
        try { info = lstatSync(actual); } catch (error) {
          if (decompress && error.code === "ENOENT") { actual = `${file}${suffix}`; info = lstatSync(actual); }
          else throw error;
        }
        if (info.isDirectory()) {
          if (!recursive) { report(`${file} is a directory -- ignored`, 2); return; }
          for (const child of readdirSync(actual).sort()) await processFile(join(actual, child));
          return;
        }
        if (info.isSymbolicLink()) {
          if (!force && !toStdout) { report(`${file}: symbolic link -- ignored`, 2); return; }
          info = statSync(actual);
        }
        if (!info.isFile()) { report(`${file}: not a regular file -- ignored`, 2); return; }
        if (info.nlink > 1 && !force && !toStdout && !keep && !list && !test) { report(`${file} has ${info.nlink - 1} other link(s) -- unchanged`, 2); return; }
        if (!decompress && actual.endsWith(suffix)) { report(`${file} already has ${suffix} suffix -- unchanged`, 2); return; }
      }
      if (file === "-" && process.stdin.isTTY && !force) throw new Error("compressed data not read from a terminal; use -f to force");
      if ((toStdout || file === "-") && !decompress && process.stdout.isTTY && !force) throw new Error("compressed data not written to a terminal; use -f to force");
      const input = Buffer.from(await readAll(actual));
      let output, header;
      if (decompress) {
        if (force && toStdout && !test && !list && !(input[0] === 31 && input[1] === 139)) output = input;
        else {
          header = gzipHeader(input);
          output = gunzipSync(input);
        }
      } else output = compressGzip(input, { level, name: !noName && file !== "-" ? actual : null, mtime: !noName && info ? info.mtimeMs / 1000 : 0 });
      if (list) {
        if (!listed++) stdout("         compressed        uncompressed  ratio uncompressed_name\n");
        const ratio = output.length ? (100 * (1 - input.length / output.length)).toFixed(1) : "0.0";
        stdout(`${String(input.length).padStart(19)} ${String(output.length).padStart(19)} ${ratio.padStart(5)}% ${file === "-" ? "(stdout)" : decompressedName(actual, suffix) ?? actual}\n`);
      } else if (test) { if (verbose) stderr(`${file}: OK\n`); }
      else if (toStdout || file === "-") stdout(output);
      else {
        let outputName = decompress ? decompressedName(actual, suffix) : `${actual}${suffix}`;
        if (decompress && restoreName && header?.name) {
          const original = basename(header.name.replaceAll("\\", "/"));
          if (original && original !== "." && original !== "..") outputName = join(dirname(actual), original);
        }
        if (!outputName || outputName === actual) { report(`${actual}: unknown suffix -- ignored`, 2); return; }
        replaceFile(outputName, output, info, force, restoreName ? header?.mtime : null);
        if (!keep) unlinkSync(actual);
        if (verbose) stderr(`${actual}: ${input.length ? (100 * (1 - output.length / input.length)).toFixed(1) : "0.0"}% -- ${keep ? "created" : "replaced with"} ${outputName}\n`);
      }
    } catch (error) { report(`${file}: ${error.message}`); }
  };
  for (const file of operands.length ? operands : ["-"]) await processFile(file);
  return status;
}
