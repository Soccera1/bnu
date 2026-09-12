#!/usr/bin/env bun
import {defineCommand, runAsMain} from "../shared/command.js";
import {stdout, stderr, UsageError} from "../shared/diagnostics.js";
import {options, last, metaOption} from "../shared/utility.js";
import {objectMembers, hex, symbolLetter, parseAr} from "../shared/object-files.js";
import {readFileSync} from "node:fs";
import {disassembler, objectTriple, demangle} from "../shared/llvm.js";
export function objdump(args) {
  const {opts, operands} = options(
      args, {
        a: "archive",
        f: "file",
        h: "sections",
        x: "all",
        p: "private",
        t: "symbols",
        T: "dynamic",
        r: "relocs",
        R: "dynamicRelocs",
        s: "contents",
        d: "disassemble",
        D: "disassembleAll",
        C: "demangle",
        j: ["section", true],
        M: ["disasmOptions", true],
        w: "wide",
        z: "zeros",
        l: "line"
      },
      {
        "archive-headers": "archive",
        "file-headers": "file",
        "section-headers": "sections",
        "all-headers": "all",
        "private-headers": "private",
        syms: "symbols",
        "dynamic-syms": "dynamic",
        reloc: "relocs",
        "dynamic-reloc": "dynamicRelocs",
        "full-contents": "contents",
        disassemble: "disassemble",
        "disassemble-all": "disassembleAll",
        demangle: "demangle",
        section: ["section", true],
        "disassembler-options": ["disasmOptions", true],
        "start-address": ["start", true],
        "stop-address": ["stop", true],
        "no-show-raw-insn": "noBytes",
        "show-raw-insn": "bytes",
        wide: "wide"
      });
  if (!operands.length) throw new UsageError("missing file operand", true);
  if (opts.line) throw new UsageError("-l source line display is not supported; use addr2line");
  const disasmOptions = (opts.disasmOptions ?? []).flatMap(value => value.split(",")).filter(Boolean);
  if (disasmOptions.some(value => !["intel", "att"].includes(value))) throw new UsageError("supported disassembler options are intel and att");
  if (!Object.keys(opts).length)
    throw new UsageError("at least one of -a, -d, -f, -h, -p, -r, -s, -t or -x is required", true);
  const start = BigInt(last(opts, "start", 0)),
        stop = BigInt(last(opts, "stop", "0xffffffffffffffff"));
  let status = 0;
  for (const file of operands) try {
      if (opts.archive || opts.all) {
        const bytes = readFileSync(file);
        if (bytes.subarray(0, 8).toString() === "!<arch>\n") {
          stdout(`In archive ${file}:\n`);
          for (const member of parseAr(bytes).filter(member => !member.special)) stdout(`  ${member.mode.toString(8)} ${member.uid}/${member.gid} ${member.data.length} ${new Date(member.mtime * 1000).toISOString()} ${member.name}\n`);
        }
      }
      for (const obj of objectMembers(file)) {
        stdout(`\n${obj.name}:     file format ${obj.target}\n`);
        if (opts.file || opts.all)
          stdout(`architecture: ${obj.arch}, flags 0x${hex(obj.flags ?? 0, 8)}:\nstart address 0x${
              hex(obj.entry, obj.bits / 4)}\n`);
        if (opts.private || opts.all) {
          stdout(`\n${obj.format.toUpperCase()} private headers:\n`);
          if (obj.format === "pe") {
            const optional = obj.headerOffset + 20, bytes = obj.bytes;
            stdout(`ImageBase 0x${hex(obj.imageBase)}\nAddressOfEntryPoint 0x${hex(obj.entry - obj.imageBase)}\nSectionAlignment ${bytes.readUInt32LE(optional + 32)}\nFileAlignment ${bytes.readUInt32LE(optional + 36)}\nSizeOfImage ${bytes.readUInt32LE(optional + 56)}\nSubsystem ${bytes.readUInt16LE(optional + 68)}\n`);
          }
          for (const segment of obj.segments)
            stdout(`${segment.name ?? segment.type} offset 0x${hex(segment.offset)} vaddr 0x${
                hex(segment.vaddr)} filesz 0x${hex(segment.filesz)} memsz 0x${
                hex(segment.memsz)}\n`);
        }
        const sections =
            obj.sections.filter(s => (!opts.section || opts.section.includes(s.name)) && s.size);
        if (opts.sections || opts.all) {
          stdout("Sections:\nIdx Name          Size      VMA               File off  Algn\n");
          for (const s of sections)
            stdout(`${String(s.index).padStart(3)} ${s.name.padEnd(13)} ${hex(s.size, 8)} ${
                hex(s.addr, obj.bits / 4)} ${hex(s.offset, 8)} 2**${
                Math.log2(s.align || 1)}\n                  ${
                    [s.data.length ? "CONTENTS" : null, s.alloc ? "ALLOC" : null,
                     s.executable   ? "CODE" :
                         s.writable ? "DATA" :
                                      "READONLY"]
                        .filter(Boolean)
                        .join(", ")}\n`);
        }
        if (opts.symbols || opts.dynamic || opts.all) {
          stdout("\nSYMBOL TABLE:\n");
          for (const s of obj.symbols.filter(s => opts.dynamic ? s.dynamic : !s.dynamic))
            stdout(`${hex(s.value, obj.bits / 4)} ${s.global ? "g" : "l"} ${symbolLetter(obj, s)} ${
                s.undefined    ? "*UND*" :
                    s.absolute ? "*ABS*" :
                                 obj.sections.find(x => x.index === s.section)?.name ?? "*COM*"}\t${
                hex(s.size, obj.bits / 4)} ${opts.demangle ? demangle(s.name) : s.name}\n`);
        }
        if (opts.dynamicRelocs) {
          stdout("\nDYNAMIC RELOCATION RECORDS:\nOFFSET           TYPE              VALUE\n");
          for (const r of obj.relocations.filter(r => r.symbol?.dynamic || (obj.format === "elf" && obj.sections[obj.sections[r.table]?.link]?.type === 11))) stdout(`${hex(r.offset, obj.bits / 4)} ${String(r.type).padEnd(17)} ${r.symbol?.name ?? ""}${r.addend != null ? `+0x${hex(BigInt.asUintN(obj.bits, r.addend))}` : ""}\n`);
        }
        if (opts.relocs || opts.all)
          for (const s of sections) {
            const relocs = obj.relocations.filter(r => r.section === s.index);
            if (!relocs.length) continue;
            stdout(`\nRELOCATION RECORDS FOR [${
                s.name}]:\nOFFSET           TYPE              VALUE\n`);
            for (const r of relocs)
              stdout(`${hex(r.offset, obj.bits / 4)} ${String(r.type).padEnd(17)} ${
                  r.symbol?.name ?? r.targetSection ??
                  ""}${r.addend != null ? `+0x${hex(BigInt.asUintN(obj.bits, r.addend))}` : ""}\n`);
          }
        if (opts.contents)
          for (const s of sections.filter(s => s.data.length)) {
            stdout(`Contents of section ${s.name}:\n`);
            for (let p = 0; p < s.data.length; p += 16) {
              const addr = s.addr + BigInt(p);
              if (addr < start || addr >= stop) continue;
              const b = s.data.subarray(p, p + 16);
              stdout(` ${hex(addr, 4)} ${b.toString("hex").match(/.{1,8}/g).join(" ").padEnd(35)} ${
                      [...b]
                          .map(n => n >= 32 && n < 127 ? String.fromCharCode(n) : ".")
                          .join("")}\n`);
            }
          }
        if (opts.disassemble || opts.disassembleAll) {
          const dis =
              disassembler(objectTriple(obj), disasmOptions.at(-1) === "intel");
          try {
            for (const s of sections.filter(
                     s => s.data.length && (opts.disassembleAll || s.executable))) {
              stdout(`\nDisassembly of section ${s.name}:\n`);
              const syms = obj.symbols.filter(x => x.section === s.index && x.name);
              for (let p = 0; p < s.data.length;) {
                const addr = s.addr + BigInt(p);
                if (addr >= stop) break;
                const result = dis.instruction(s.data.subarray(p), addr), size = result.size || 1;
                if (addr >= start) {
                  for (const sym of syms.filter(
                           x => (obj.format === "coff" ? x.value + s.addr : x.value) === addr))
                    stdout(`\n${hex(addr, obj.bits / 4)} <${
                        opts.demangle ? demangle(sym.name) : sym.name}>:\n`);
                  stdout(` ${hex(addr, 4)}:\t${
                      opts.noBytes ? "" :
                                     `${
                                             [...s.data.subarray(p, p + size)]
                                                 .map(n => hex(n, 2))
                                                 .join(" ")
                                                 .padEnd(24)}\t`}${
                      result.size ? result.text : `.byte 0x${hex(s.data[p], 2)}`}\n`);
                }
                p += size;
              }
            }
          } finally {
            dis.close();
          }
        }
      }
    } catch (error) {
      stderr(`objdump: ${file}: ${error.message}\n`);
      status = 1;
    }
  return status;
}
const singleCall = defineCommand("objdump", objdump, metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
