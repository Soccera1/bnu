#!/usr/bin/env bun
import {defineCommand, runAsMain} from "../shared/command.js";
import {stdout, stderr, UsageError} from "../shared/diagnostics.js";
import {options, last, metaOption} from "../shared/utility.js";
import {objectMembers, hex, BinaryReader, cstring} from "../shared/object-files.js";
const types = {
  0: "NULL",
  1: "PROGBITS",
  2: "SYMTAB",
  3: "STRTAB",
  4: "RELA",
  5: "HASH",
  6: "DYNAMIC",
  7: "NOTE",
  8: "NOBITS",
  9: "REL",
  10: "SHLIB",
  11: "DYNSYM",
  14: "INIT_ARRAY",
  15: "FINI_ARRAY",
  16: "PREINIT_ARRAY",
  17: "GROUP",
  18: "SYMTAB SECTION INDICES",
  0x6ffffff6: "GNU_HASH",
  0x6fffffff: "VERSYM"
};
export function readelf(args) {
  const {opts, operands} = options(
      args, {
        a: "all",
        h: "header",
        l: "segments",
        S: "sections",
        s: "symbols",
        e: "headers",
        r: "relocs",
        d: "dynamic",
        n: "notes",
        W: "wide",
        x: ["hex", true],
        p: ["strings", true],
        I: "histogram",
        V: "versions"
      },
      {
        all: "all",
        "file-header": "header",
        "program-headers": "segments",
        segments: "segments",
        "section-headers": "sections",
        sections: "sections",
        symbols: "symbols",
        syms: "symbols",
        "dyn-syms": "dynSymbols",
        headers: "headers",
        relocs: "relocs",
        dynamic: "dynamic",
        notes: "notes",
        wide: "wide",
        "hex-dump": ["hex", true],
        "string-dump": ["strings", true],
        "version-info": "versions"
      });
  if (!operands.length) throw new UsageError("missing file operand", true);
  if (!Object.keys(opts).length) throw new UsageError("nothing to do", true);
  let status = 0;
  for (const file of operands) try {
      for (const obj of objectMembers(file)) {
        if (obj.format !== "elf")
          throw new Error("Not an ELF file - it has the wrong magic bytes at the start");
        if (operands.length > 1 || obj.name !== file) stdout(`\nFile: ${obj.name}\n`);
        const wide = obj.bits === 64;
        if (opts.header || opts.headers || opts.all) {
          stdout(`ELF Header:\n  Magic:   ${
                  [...obj.bytes.subarray(0, 16)]
                      .map(n => hex(n, 2))
                      .join(" ")}\n  Class:                             ELF${
              obj.bits}\n  Data:                              2's complement, ${
              obj.le ?
                  "little" :
                  "big"} endian\n  Version:                           1 (current)\n  OS/ABI:                            ${
              obj.osabi === 0 ? "UNIX - System V" :
                                obj.osabi}\n  ABI Version:                       ${
              obj.abiVersion}\n  Type:                              ${{
            0: "NONE",
            1: "REL (Relocatable file)",
            2: "EXEC (Executable file)",
            3: "DYN (Shared object file)",
            4: "CORE"
          }[obj.type] ?? obj.type}\n  Machine:                           ${
              obj.arch}\n  Version:                           0x1\n  Entry point address:               0x${
              hex(obj.entry)}\n  Start of program headers:          ${
              obj.programOffset} (bytes into file)\n  Start of section headers:          ${
              obj.sectionOffset} (bytes into file)\n  Flags:                             0x${
              hex(obj.flags)}\n  Size of this header:               ${
              wide ? 64 : 52} (bytes)\n  Size of program headers:           ${
              obj.programEntrySize} (bytes)\n  Number of program headers:         ${
              obj.segments.length}\n  Size of section headers:           ${
              obj.sectionEntrySize} (bytes)\n  Number of section headers:         ${
              obj.sections.length}\n  Section header string table index: ${obj.stringIndex}\n`);
        }
        if (opts.sections || opts.headers || opts.all) {
          stdout(
              "\nSection Headers:\n  [Nr] Name              Type             Address          Offset   Size     ES Flg Lk Inf Al\n");
          for (const s of obj.sections)
            stdout(`  [${String(s.index).padStart(2)}] ${s.name.padEnd(17)} ${
                (types[s.type] ?? hex(s.type)).padEnd(16)} ${hex(s.addr, wide ? 16 : 8)} ${
                hex(s.offset, 6)} ${hex(s.size, 6)} ${hex(s.entsize, 2)} ${
                (s.writable ? "W" : "") + (s.alloc ? "A" : "") +
                (s.executable ? "X" : "")} ${s.link} ${s.info} ${s.align}\n`);
        }
        if (opts.segments || opts.headers || opts.all) {
          stdout(
              "\nProgram Headers:\n  Type           Offset             VirtAddr           PhysAddr           FileSiz  MemSiz   Flg Align\n");
          for (const s of obj.segments)
            stdout(`  ${
                ({
                  0: "NULL",
                  1: "LOAD",
                  2: "DYNAMIC",
                  3: "INTERP",
                  4: "NOTE",
                  6: "PHDR",
                  7: "TLS",
                  0x6474e551: "GNU_STACK",
                  0x6474e552: "GNU_RELRO"
                }[s.type] ??
                 hex(s.type))
                    .padEnd(14)} 0x${hex(s.offset, 16)} 0x${hex(s.vaddr, 16)} 0x${
                hex(s.paddr,
                    16)} 0x${hex(s.filesz, 6)} 0x${hex(s.memsz, 6)} ${s.flags & 4 ? "R" : " "}${
                s.flags & 2 ? "W" : " "}${s.flags & 1 ? "E" : " "} 0x${hex(s.align)}\n`);
        }
        if (opts.symbols || opts.dynSymbols || opts.all) {
          for (const table of obj.sections.filter(
                   s => (s.type === 2 && !opts.dynSymbols) || s.type === 11)) {
            const syms = obj.symbols.filter(s => s.table === table.index);
            stdout(`\nSymbol table '${table.name}' contains ${
                syms.length +
                1} entries:\n   Num:    Value          Size Type    Bind   Vis      Ndx Name\n`);
            stdout(`     0: ${"0".repeat(wide ? 16 : 8)}     0 NOTYPE  LOCAL  DEFAULT  UND \n`);
            for (const s of syms)
              stdout(`${String(s.index).padStart(6)}: ${hex(s.value, wide ? 16 : 8)} ${
                  String(s.size).padStart(5)} ${
                  ({
                    0: "NOTYPE",
                    1: "OBJECT",
                    2: "FUNC",
                    3: "SECTION",
                    4: "FILE",
                    5: "COMMON",
                    6: "TLS",
                    10: "IFUNC"
                  }[s.type] ??
                   String(s.type))
                      .padEnd(7)} ${
                  ({0: "LOCAL", 1: "GLOBAL", 2: "WEAK", 10: "UNIQUE"}[s.binding] ??
                   String(s.binding))
                      .padEnd(6)} ${
                      ["DEFAULT", "INTERNAL", "HIDDEN", "PROTECTED"][s.visibility].padEnd(8)} ${
                  String(
                      s.undefined    ? "UND" :
                          s.absolute ? "ABS" :
                          s.common   ? "COM" :
                                       s.section)
                      .padStart(3)} ${s.name}\n`);
          }
        }
        if (opts.relocs || opts.all) {
          if (!obj.relocations.length) stdout("\nThere are no relocations in this file.\n");
          for (const table of obj.sections.filter(s => s.type === 4 || s.type === 9)) {
            stdout(`\nRelocation section '${table.name}' at offset 0x${
                hex(table.offset)} contains ${
                obj.relocations.filter(r => r.table === table.index)
                    .length} entries:\n  Offset          Type                 Symbol's Value  Symbol's Name + Addend\n`);
            for (const r of obj.relocations.filter(r => r.table === table.index))
              stdout(`${hex(r.offset, wide ? 12 : 8)}  ${relocationName(obj, r.type).padEnd(20)} ${
                  hex(r.symbol?.value ?? 0n,
                      wide ? 16 :
                             8)} ${r.symbol?.name || obj.sections[r.symbol?.section]?.name || ""}${
                  r.addend != null ?
                      ` ${r.addend < 0n ? "-" : "+"} ${hex(r.addend < 0n ? -r.addend : r.addend)}` :
                      ""}\n`);
          }
        }
        if (opts.dynamic || opts.all) {
          const table = obj.sections.find(s => s.type === 6);
          if (!table)
            stdout("\nThere is no dynamic section in this file.\n");
          else {
            const r = new BinaryReader(table.data, obj.le),
                  strings = obj.sections[table.link]?.data;
            stdout(`\nDynamic section at offset 0x${
                hex(table.offset)}:\n  Tag        Type                         Name/Value\n`);
            for (let p = 0; p + (wide ? 16 : 8) <= table.data.length; p += wide ? 16 : 8) {
              const tag = wide ? r.u64(p) : BigInt(r.u32(p)),
                    value = wide ? r.u64(p + 8) : BigInt(r.u32(p + 4)),
                    name = ({
                             0: "NULL",
                             1: "NEEDED",
                             2: "PLTRELSZ",
                             3: "PLTGOT",
                             4: "HASH",
                             5: "STRTAB",
                             6: "SYMTAB",
                             10: "STRSZ",
                             11: "SYMENT",
                             12: "INIT",
                             13: "FINI",
                             14: "SONAME",
                             15: "RPATH",
                             29: "RUNPATH"
                           })[Number(tag)] ??
                  hex(tag);
              stdout(` 0x${hex(tag, 16)} (${name}) ${
                      [1n, 14n, 15n, 29n].includes(tag) && strings ?
                      `[${cstring(strings, Number(value))}]` :
                      `0x${hex(value)}`}\n`);
              if (tag === 0n) break;
            }
          }
        }
        if (opts.notes || opts.all)
          for (const s of obj.sections.filter(s => s.type === 7)) {
            stdout(`\nDisplaying notes found in: ${s.name}\n`);
            const r = new BinaryReader(s.data, obj.le);
            for (let p = 0; p + 12 <= s.data.length;) {
              const names = r.u32(p), size = r.u32(p + 4), type = r.u32(p + 8);
              p += 12;
              const name = r.str(p, names);
              p += Math.ceil(names / 4) * 4;
              const data = r.range(p, size);
              p += Math.ceil(size / 4) * 4;
              stdout(`  ${name} 0x${hex(size, 8)} type ${type}${
                  name === "GNU" && type === 3 ? ` Build ID: ${data.toString("hex")}` : ""}\n`);
            }
          }
        for (const select of opts.hex ?? []) {
          const s = findSection(obj, select);
          stdout(`\nHex dump of section '${s.name}':\n`);
          for (let i = 0; i < s.data.length; i += 16) {
            const b = s.data.subarray(i, i + 16);
            stdout(`  0x${hex(s.addr + BigInt(i), 8)} ${
                b.toString("hex").match(/.{1,8}/g).join(" ").padEnd(35)} ${
                    [...b]
                        .map(n => n >= 32 && n < 127 ? String.fromCharCode(n) : ".")
                        .join("")}\n`);
          }
        }
        for (const select of opts.strings ?? []) {
          const s = findSection(obj, select);
          stdout(`\nString dump of section '${s.name}':\n`);
          for (let i = 0; i < s.data.length;) {
            const text = cstring(s.data, i);
            if (text) stdout(`  [${hex(i, 6)}] ${text}\n`);
            i += Buffer.byteLength(text) + 1;
          }
        }
        if (opts.histogram || opts.versions)
          throw new UsageError("hash histograms and version tables are not yet supported");
      }
    } catch (error) {
      stderr(`readelf: ${file}: ${error.message}\n`);
      status = 1;
    }
  return status;
}
function findSection(obj, name) {
  const s = obj.sections.find(s => s.name === name || String(s.index) === name);
  if (!s) throw new Error(`section '${name}' does not exist`);
  return s;
}
export function relocationName(obj, type) {
  const x64 = {
    0: "NONE",
    1: "64",
    2: "PC32",
    4: "PLT32",
    5: "COPY",
    6: "GLOB_DAT",
    7: "JUMP_SLOT",
    8: "RELATIVE",
    9: "GOTPCREL",
    10: "32",
    11: "32S",
    24: "PC64",
    41: "GOTPCRELX",
    42: "REX_GOTPCRELX"
  };
  return obj.machine === 62 ? `R_X86_64_${x64[type] ?? type}` :
      obj.machine === 183 ? `R_AARCH64_${
                                ({
                                  257: "ABS64",
                                  258: "ABS32",
                                  261: "PREL32",
                                  275: "ADR_PREL_PG_HI21",
                                  277: "ADD_ABS_LO12_NC",
                                  282: "JUMP26",
                                  283: "CALL26"
                                })[type] ??
                                type}` :
                            `R_${obj.arch}_${type}`;
}
const singleCall = defineCommand("readelf", readelf, metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
