#!/usr/bin/env bun
import {defineCommand, runAsMain} from "../shared/command.js";
import {stdout, stderr, UsageError} from "../shared/diagnostics.js";
import {options, last, metaOption} from "../shared/utility.js";
import {objectMembers, symbolLetter, hex, parseAr, BinaryReader, cstring} from "../shared/object-files.js";
import {readFileSync} from "node:fs";
import {demangle} from "../shared/llvm.js";
export function nm(args) {
  const {opts, operands} = options(
      args, {
        a: "debug",
        A: "prefix",
        o: "prefix",
        g: "global",
        u: "undefined",
        U: "defined",
        n: "numeric",
        v: "numeric",
        p: "noSort",
        r: "reverse",
        S: "size",
        s: "armap",
        D: "dynamic",
        C: "demangle",
        P: "portable",
        j: "just",
        t: ["radix", true],
        f: ["format", true]
      },
      {
        "debug-syms": "debug",
        "print-file-name": "prefix",
        "extern-only": "global",
        "undefined-only": "undefined",
        "defined-only": "defined",
        "numeric-sort": "numeric",
        "no-sort": "noSort",
        "reverse-sort": "reverse",
        "print-size": "size",
        "size-sort": "sizeSort",
        "dynamic": "dynamic",
        "demangle": "demangle",
        "portability": "portable",
        "format": ["format", true],
        "radix": ["radix", true],
        "just-symbols": "just",
        "print-armap": "armap"
      });
  const radix = last(opts, "radix", "x");
  if (!["x", "d", "o"].includes(radix)) throw new UsageError(`invalid radix '${radix}'`);
  const format = opts.portable ? "posix" : last(opts, "format", "bsd");
  if (!["bsd", "posix", "sysv", "just-symbols"].includes(format))
    throw new UsageError(`invalid output format '${format}'`);
  let status = 0;
  for (const file of operands.length ? operands : ["a.out"]) {
    try {
      if (opts.armap) {
        const bytes = readFileSync(file);
        if (bytes.subarray(0, 8).toString() === "!<arch>\n") {
          const members = parseAr(bytes);
          const index = members.find(m => m.name === "/" || m.name === "/SYM64");
          if (index) {
            const reader = new BinaryReader(index.data, false);
            const wide = index.name === "/SYM64";
            const width = wide ? 8 : 4;
            const count = wide ? reader.num64(0) : reader.u32(0);
            reader.range(width, count * width);
            let p = width * (count + 1);
            stdout("\nArchive index:\n");
            for (let i = 0; i < count; i++) {
              const offset = wide ? reader.num64(width * (i + 1)) : reader.u32(width * (i + 1));
              const name = cstring(index.data, p);
              p += Buffer.byteLength(name) + 1;
              stdout(`${name} in ${members.find(m => m.offset === offset)?.name ?? "?"}\n`);
            }
          }
        }
      }
      for (const obj of objectMembers(file)) {
        let symbols = obj.symbols.filter(
            s => s.name &&
                (opts.debug ||
                 (!s.debug && s.type !== 3 && s.type !== 4 || obj.format !== "elf")) &&
                (!opts.global || s.global) && (!opts.undefined || s.undefined) &&
                (!opts.defined || !s.undefined) && (opts.dynamic ? s.dynamic : !s.dynamic));
        if (!opts.noSort)
          symbols.sort((a, b) => {
            if (opts.sizeSort) return a.size - b.size || a.name.localeCompare(b.name, "en");
            if (opts.numeric) {
              if (a.undefined !== b.undefined) return a.undefined ? -1 : 1;
              if (a.value !== b.value) return a.value < b.value ? -1 : 1;
            }
            return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
          });
        if (opts.reverse) symbols.reverse();
        if (!opts.prefix && (operands.length > 1 || obj.name !== file)) stdout(`\n${obj.name}:\n`);
        const number = (n, pad = true) => BigInt(n)
                                              .toString(
                                                  radix === "x"     ? 16 :
                                                      radix === "o" ? 8 :
                                                                      10)
                                              .padStart(pad ? obj.bits / 4 : 0, "0");
        if (format === "sysv")
          stdout(`\nSymbols from ${
              obj.name}:\n\nName                  Value           Class        Type         Size             Line  Section\n`);
        for (const s of symbols) {
          const name = opts.demangle ? demangle(s.name) : s.name, letter = symbolLetter(obj, s),
                prefix = opts.prefix ? `${obj.name}:` : "";
          let value = s.value;
          if (obj.format === "coff" || obj.format === "pe")
            value += (obj.sections.find(x => x.index === s.section)?.addr ?? 0n);
          if (opts.just || format === "just-symbols")
            stdout(`${prefix}${name}\n`);
          else if (format === "posix")
            stdout(`${prefix}${name} ${letter}${
                s.undefined ? "  " : ` ${number(value, false)} ${number(s.size, false)}`}\n`);
          else if (format === "sysv")
            stdout(`${name.padEnd(20)}|${number(value)}|   ${letter}  |${
                String(s.type).padEnd(10)}|${number(s.size)}|     |${
                obj.sections.find(x => x.index === s.section)?.name ?? "*UND*"}\n`);
          else
            stdout(`${prefix}${s.undefined ? " ".repeat(obj.bits / 4) : number(value)}${
                opts.size && !s.undefined ? ` ${number(s.size)}` : ""} ${letter} ${name}\n`);
        }
      }
    } catch (error) {
      stderr(`nm: ${file}: ${error.message}\n`);
      status = 1;
    }
  }
  return status;
}
const singleCall = defineCommand("nm", nm, metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
