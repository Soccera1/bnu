import { readFileSync } from "node:fs";
import { align, parseAr, parseObject } from "./object-files.js";
import { layoutExecutable, writeExecutable } from "./object-linker-formats.js";
import { applyRelocations, needsGot } from "./object-relocations.js";

function definedSymbols(object) {
  return object.symbols.filter(symbol => symbol.global && !symbol.undefined && !symbol.debug && symbol.name);
}

function chooseObjects(inputs, options) {
  const chosen = [], definitions = new Map(), unresolved = new Set(options.undefined ?? []);
  if (options.entry && !/^(?:0x[\da-f]+|\d+)$/i.test(options.entry)) unresolved.add(options.entry);
  const add = object => {
    if (object.format === "fat") {
      object = object.objects.find(candidate => candidate.arch === options.arch) ?? object.objects[0];
    }
    if (object.type !== 1 || object.format === "pe") throw new Error(`${object.name}: input must be a relocatable object file`);
    const first = chosen[0];
    if (first && (object.format !== first.format || object.machine !== first.machine || object.bits !== first.bits || object.le !== first.le)) throw new Error(`${object.name}: incompatible input object format or architecture`);
    chosen.push(object);
    for (const symbol of definedSymbols(object)) {
      const previous = definitions.get(symbol.name);
      if (previous && !previous.symbol.weak && !symbol.weak && !previous.symbol.common && !symbol.common) throw new Error(`multiple definition of '${symbol.name}' in ${previous.object.name} and ${object.name}`);
      if (!previous || previous.symbol.weak || (previous.symbol.common && !symbol.common)) definitions.set(symbol.name, { object, symbol });
      else if (previous.symbol.common && symbol.common) previous.symbol.size = Math.max(previous.symbol.size || Number(previous.symbol.value), symbol.size || Number(symbol.value));
      unresolved.delete(symbol.name);
    }
    for (const symbol of object.symbols) if (symbol.undefined && !symbol.weak && symbol.name && !definitions.has(symbol.name)) unresolved.add(symbol.name);
  };
  for (const input of inputs) {
    const bytes = readFileSync(input.path);
    if (bytes.subarray(0, 8).toString() !== "!<arch>\n") { add(parseObject(bytes, input.path)); continue; }
    const members = parseAr(bytes).filter(member => !member.special).map(member => ({ ...member, object: null }));
    const load = member => member.object ??= parseObject(member.data, `${input.path}(${member.name})`);
    if (input.wholeArchive) { for (const member of members) add(load(member)); continue; }
    const used = new Set();
    let changed;
    do {
      changed = false;
      for (const member of members) {
        if (used.has(member)) continue;
        const object = load(member);
        if (object.format === "fat") throw new Error("universal archive members require explicit architecture selection");
        if (definedSymbols(object).some(symbol => unresolved.has(symbol.name))) { add(object); used.add(member); changed = true; }
      }
    } while (changed);
  }
  return { objects: chosen, definitions };
}

export function linkObjects(inputs, options = {}) {
  const { objects, definitions } = chooseObjects(inputs, options);
  if (!objects.length) throw new Error("no input object files");
  const first = objects[0], format = first.format === "coff" ? "pe" : first.format;
  if (!['elf', 'pe', 'macho'].includes(format) || first.bits !== 64 || !first.le || !["x86-64", "aarch64"].includes(first.arch)) throw new Error("static linking supports little-endian x86-64 and AArch64 ELF, COFF and Mach-O objects");
  for (const object of objects) if (object.format !== first.format || object.machine !== first.machine || object.bits !== 64 || !object.le) throw new Error(`${object.name}: incompatible input object format or architecture`);
  if (options.arch && options.arch !== first.arch) throw new Error(`input architecture '${first.arch}' does not match '${options.arch}'`);
  if (options.format && options.format !== format) throw new Error(`input format '${format}' does not match output '${options.format}'`);
  if (format !== "pe" && (options.subsystem !== undefined || options.stackSize !== undefined)) throw new Error("--subsystem and --stack are supported only for PE executables");
  const sections = [], sectionMap = new Map();
  for (const object of objects) {
    const map = new Map(); sectionMap.set(object, map);
    for (const source of object.sections) {
      if (source.name === ".drectve" && source.size) throw new Error(`${object.name}: COFF .drectve linker directives are not supported`);
      if (!source.alloc || !source.size || [".llvm_addrsig", ".note.GNU-stack"].includes(source.name)) continue;
      if (source.name.startsWith(".rel") && object.format === "elf" && [4, 9].includes(source.type)) continue;
      if (object.format === "elf" && (source.flags & 0x400n)) throw new Error(`${source.name}: thread-local storage linking is not supported`);
      if ((object.format === "coff" && source.name.startsWith(".tls")) || (object.format === "macho" && [0x11, 0x12, 0x13, 0x14, 0x15].includes(source.type))) throw new Error(`${source.name}: thread-local storage linking is not supported`);
      const section = { ...source, source, object, data: source.bss ? Buffer.alloc(0) : Buffer.from(source.data), align: Math.max(1, source.align), index: sections.length + 1 };
      if (section.size > 512 * 1024 * 1024 || section.align > 1024 * 1024) throw new Error(`${section.name}: section is too large`);
      sections.push(section); map.set(source.index, section);
    }
  }
  const common = new Map();
  for (const definition of definitions.values()) if (definition.symbol.common) {
    const { object, symbol } = definition, size = symbol.size || (object.format === "elf" ? 0 : Number(symbol.value));
    const alignment = object.format === "elf" ? Number(symbol.value) : 8;
    const section = { name: format === "macho" ? "__common" : ".bss", segment: "__DATA", type: 8, flags: format === "macho" ? 1n : 3n, bss: true, alloc: true, writable: true, executable: false, size, align: Math.max(1, alignment), data: Buffer.alloc(0), index: sections.length + 1 };
    sections.push(section); common.set(symbol, section);
  }
  const got = new Map();
  for (const object of objects) for (const relocation of object.relocations) if (sectionMap.get(object).has(relocation.section) && needsGot(object, relocation)) {
    const key = relocation.symbol?.global ? relocation.symbol.name : `${objects.indexOf(object)}:${relocation.symbolIndex}`;
    if (!got.has(key)) got.set(key, { offset: got.size * 8, object, symbol: relocation.symbol });
    relocation.gotKey = key;
  }
  let gotSection;
  if (got.size) {
    gotSection = { name: format === "macho" ? "__got" : ".got", segment: "__DATA", type: 1, flags: 3n, bss: false, alloc: true, writable: true, executable: false, size: got.size * 8, align: 8, data: Buffer.alloc(got.size * 8), index: sections.length + 1 };
    sections.push(gotSection);
  }
  const state = { objects, definitions, sections, sectionMap, common, got, gotSection, format, arch: first.arch, machine: first.machine, options };
  layoutExecutable(state);
  const symbolAddress = (object, symbol, optional = false) => {
    if (!symbol) throw new Error(`${object.name}: relocation references an invalid symbol`);
    if (symbol.global && definitions.has(symbol.name)) ({ object, symbol } = definitions.get(symbol.name));
    if (symbol.undefined) {
      if (symbol.name === "__ImageBase" && format === "pe") return state.imageBase;
      if (symbol.name === "__ehdr_start" && format === "elf") return state.imageBase;
      if (symbol.name === "_GLOBAL_OFFSET_TABLE_" && state.gotSection) return state.gotSection.addr;
      if (["_end", "end", "__end__"].includes(symbol.name)) return state.endAddress;
      if (symbol.weak || optional) return 0n;
      throw new Error(`${object.name}: undefined reference to '${symbol.name}'`);
    }
    if (symbol.absolute) return symbol.value;
    if (symbol.common) return common.get(symbol)?.addr ?? 0n;
    const section = sectionMap.get(object).get(symbol.section);
    if (!section) {
      if (optional) return null;
      throw new Error(`${object.name}: symbol '${symbol.name}' references a discarded or unsupported section`);
    }
    return section.addr + symbol.value - (object.format === "macho" ? section.source.addr : 0n);
  };
  state.symbolAddress = symbolAddress;
  for (const item of got.values()) gotSection.data.writeBigUInt64LE(BigInt.asUintN(64, symbolAddress(item.object, item.symbol)), item.offset);
  for (const object of objects) applyRelocations(state, object);
  const defaultEntry = format === "pe" ? ["mainCRTStartup", "_start", "main"] : format === "macho" ? ["_start", "_main", "start"] : ["_start", "start", "main"];
  const entryName = options.entry ?? defaultEntry.find(name => definitions.has(name));
  if (entryName && /^(0x[\da-f]+|\d+)$/i.test(entryName)) state.entry = BigInt(entryName);
  else {
    const entry = definitions.get(entryName);
    if (!entry) throw new Error(`entry symbol '${entryName ?? defaultEntry[0]}' not defined; specify -e SYMBOL`);
    state.entry = symbolAddress(entry.object, entry.symbol);
  }
  if (!sections.some(section => section.executable && state.entry >= section.addr && state.entry < section.addr + BigInt(section.size))) throw new Error("entry point is outside executable sections");
  const symbols = [];
  for (const object of objects) for (const symbol of object.symbols) {
    if (!symbol.name || symbol.undefined || symbol.debug || (symbol.global && definitions.get(symbol.name)?.symbol !== symbol)) continue;
    const value = symbolAddress(object, symbol, true);
    if (value !== null) symbols.push({ ...symbol, object, value, outputSection: symbol.common ? common.get(symbol) : sectionMap.get(object).get(symbol.section) });
  }
  state.symbols = symbols;
  const bytes = writeExecutable(state);
  const map = [`Entry point 0x${state.entry.toString(16)}`, ...sections.map(section => `${section.name.padEnd(20)} 0x${section.addr.toString(16)} 0x${section.size.toString(16)}${section.object ? ` ${section.object.name}` : ""}`), ...symbols.filter(symbol => symbol.global).map(symbol => `  0x${symbol.value.toString(16)} ${symbol.name}`)].join("\n") + "\n";
  return { bytes, map, state };
}
