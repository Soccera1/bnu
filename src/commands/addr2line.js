#!/usr/bin/env bun
import { basename } from "node:path";
import { defineCommand, runAsMain } from "../shared/command.js";
import { stdout, UsageError } from "../shared/diagnostics.js";
import { options, last, metaOption, inputBytes } from "../shared/utility.js";
import { objectMembers, hex } from "../shared/object-files.js";
import { DwarfInfo } from "../shared/dwarf.js";
import { demangle } from "../shared/llvm.js";

export function addr2line(args) {
  const {opts,operands} = options(args,{e:["executable",true],a:"addresses",f:"functions",C:"demangle",p:"pretty",s:"basename",i:"inlines",j:["section",true],b:["target",true]}, {exe:["executable",true],addresses:"addresses",functions:"functions",demangle:"demangle","pretty-print":"pretty",basenames:"basename",inlines:"inlines",section:["section",true],target:["target",true]});
  const filename = last(opts,"executable","a.out"), objects = objectMembers(filename);
  if (objects.length !== 1) throw new UsageError("please specify a single object file");
  const obj = objects[0], target = last(opts,"target");
  if (target !== undefined) {
    const aliases = new Set([obj.target]);
    if (obj.format === "elf") {
      aliases.add(`elf${obj.bits}-${obj.le ? "little" : "big"}`);
      if (obj.arch === "x86-64") aliases.add("elf64-x86-64");
      else if (obj.arch === "i386") aliases.add("elf32-i386");
      else aliases.add(`elf${obj.bits}-${obj.le ? "little" : "big"}${obj.arch}`);
    } else if (["coff","pe"].includes(obj.format)) {
      const arch = obj.arch === "aarch64" ? "aarch64" : obj.arch === "x86-64" ? "x86-64" : obj.arch;
      aliases.add(`${obj.format === "pe" ? "pei" : "pe"}-${arch}`);
    } else if (obj.format === "macho") {
      aliases.add(`mach-o-${obj.arch === "aarch64" ? "arm64" : obj.arch === "x86-64" ? "x86-64" : obj.arch}`);
      aliases.add(`mach-o-${obj.bits}`);
    }
    if (!aliases.has(target)) throw new UsageError(`target '${target}' does not match this ${obj.target} object`);
  }
  const dwarf = new DwarfInfo(obj), sectionName = last(opts,"section"), section = sectionName == null ? null : obj.sections.find((entry) => entry.name === sectionName);
  if (sectionName != null && !section) throw new UsageError(`cannot find section '${sectionName}'`);
  const addresses = operands.length ? operands : inputBytes().toString().split(/\s+/).filter(Boolean);
  for (const text of addresses) {
    let address;
    if (/^(?:0x)?[\da-fA-F]+$/.test(text)) address = BigInt(text.startsWith("0x") ? text : "0x"+text);
    else {
      const symbolic = text.match(/^([^+]+)(?:\+(0x[\da-fA-F]+|\d+))?$/), symbol = symbolic && obj.symbols.find((entry) => entry.name === symbolic[1]);
      address = symbol ? symbol.value+BigInt(symbolic[2] ?? 0) : 0n;
    }
    const absolute = address+(section?.addr ?? 0n), result = dwarf.lookup(absolute,section?.index);
    const location = (path,line,discriminator = 0) => `${opts.basename ? basename(path) : path}:${line || (path === "??" ? "0" : "?")}${discriminator ? ` (discriminator ${discriminator})` : ""}`;
    const name = opts.demangle ? demangle(result.name) : result.name, prefix = opts.addresses ? `0x${hex(address,obj.bits/4)}${opts.pretty ? ": " : "\n"}` : "";
    stdout(prefix+(opts.functions ? name+(opts.pretty ? name === "??" ? " " : " at " : "\n") : "")+location(result.path,result.line,result.discriminator)+"\n");
    if (opts.inlines && result.functions.length > 1) {
      let inner = result.functions[0];
      for (const outer of result.functions.slice(1)) {
        const callFile = dwarf.attr(inner.die,0x58), callLine = Number(dwarf.attr(inner.die,0x59) ?? 0), table = dwarf.tables.get(Number(dwarf.attr(inner.die.unit.root,0x10))), path = callFile != null ? table?.filePath(Number(callFile)) ?? "??" : result.path;
        const outerName = opts.demangle ? demangle(outer.name) : outer.name;
        stdout((opts.pretty ? " (inlined by) " : "")+(opts.functions ? outerName+(opts.pretty ? " at " : "\n") : "")+location(path,callLine)+"\n"); inner = outer;
      }
    }
  }
  return 0;
}
const singleCall = defineCommand("addr2line",addr2line,metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
