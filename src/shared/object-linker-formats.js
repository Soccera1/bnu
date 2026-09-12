import { align } from "./object-files.js";

const page = 4096;
const u64 = (buffer, value, at) => buffer.writeBigUInt64LE(BigInt(value), at);
const rank = section => section.executable ? 0 : section.writable ? section.bss ? 3 : 2 : 1;

export function layoutExecutable(state) {
  state.sections.sort((a, b) => rank(a) - rank(b));
  state.sections.forEach((section, index) => { section.index = index + 1; });
  const requestedBase = state.options.imageBase;
  state.imageBase = requestedBase === undefined ? state.format === "elf" ? 0x400000n : state.format === "pe" ? 0x140000000n : 0x100000000n : BigInt(requestedBase);
  if (state.imageBase < 0n || state.imageBase % BigInt(state.format === "pe" ? 65536 : page)) throw new Error("image base must be nonnegative and aligned to 64 KiB (PE) or 4 KiB (ELF/Mach-O)");
  if (state.format === "elf") {
    state.headerSize = align(64 + (state.sections.length + 2) * 56, page);
    let offset = state.headerSize;
    for (const section of state.sections) {
      offset = align(offset, Math.max(page, section.align));
      section.offset = offset; section.addr = state.imageBase + BigInt(offset);
      offset += section.size;
    }
    state.dataEnd = align(offset, 8); state.endAddress = state.imageBase + BigInt(offset);
  } else if (state.format === "pe") {
    // COFF $ subsections are concatenated in lexical order into one image
    // section. In particular, all .pdata records must form one exception table.
    const groups = new Map();
    for (const section of state.sections) {
      const name = section.name.split("$")[0], key = `${name}:${section.bss}:${section.writable}:${section.executable}`;
      if (!groups.has(key)) groups.set(key, { name, bss: section.bss, writable: section.writable, executable: section.executable, fragments: [], size: 0, align: 1 });
      groups.get(key).fragments.push(section);
    }
    state.peSections = [...groups.values()];
    for (const [index, group] of state.peSections.entries()) {
      group.fragments.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      group.index = index + 1;
      for (const section of group.fragments) {
        group.align = Math.max(group.align, section.align); group.size = align(group.size, section.align);
        section.fragmentOffset = group.size; section.outputGroup = group; section.index = group.index;
        group.size += section.size;
      }
    }
    state.headerSize = align(128 + 4 + 20 + 240 + state.peSections.length * 40, 512);
    let offset = state.headerSize, rva = align(state.headerSize, page);
    for (const group of state.peSections) {
      rva = align(rva, Math.max(page, group.align));
      group.offset = group.bss ? 0 : offset; group.addr = state.imageBase + BigInt(rva); group.rawSize = group.bss ? 0 : align(group.size, 512);
      for (const section of group.fragments) {
        section.offset = group.bss ? 0 : offset + section.fragmentOffset;
        section.addr = group.addr + BigInt(section.fragmentOffset);
      }
      offset += group.rawSize; rva += align(group.size, page);
    }
    state.dataEnd = offset; state.endAddress = state.imageBase + BigInt(rva);
  } else {
    const readonly = state.sections.filter(section => !section.writable), writable = state.sections.filter(section => section.writable);
    const threadSize = state.arch === "x86-64" ? 184 : 288;
    state.commandSize = 72 + 72 + readonly.length * 80 + (writable.length ? 72 + writable.length * 80 : 0) + 72 + 24 + threadSize;
    state.headerSize = align(32 + state.commandSize, page);
    let offset = state.headerSize;
    state.machSegments = [{ name: "__PAGEZERO", offset: 0, size: 0, addr: 0n, vmsize: state.imageBase, protection: 0, sections: [] }];
    for (const [name, sections, protection] of [["__TEXT", readonly, 5], ["__DATA", writable, 3]]) {
      if (name === "__DATA" && !sections.length) continue;
      const start = name === "__TEXT" ? 0 : align(offset, page);
      if (name === "__DATA") offset = start;
      for (const section of sections) {
        offset = align(offset, section.align);
        section.offset = offset; section.addr = state.imageBase + BigInt(offset); section.outputSegment = name;
        offset += section.size;
      }
      offset = align(offset, page);
      state.machSegments.push({ name, offset: start, size: offset - start, addr: state.imageBase + BigInt(start), vmsize: BigInt(offset - start), protection, sections });
    }
    state.dataEnd = offset; state.endAddress = state.imageBase + BigInt(offset);
  }
  if (state.dataEnd > 512 * 1024 * 1024) throw new Error("linked image exceeds 512 MiB supported size");
}

function elfSymbols(state) {
  if (state.options.strip) return { symbols: Buffer.alloc(0), strings: Buffer.alloc(0), locals: 0 };
  const list = [...state.symbols.filter(symbol => !symbol.global), ...state.symbols.filter(symbol => symbol.global)];
  const names = [Buffer.from([0])]; let length = 1;
  const symbols = Buffer.alloc((list.length + 1) * 24);
  list.forEach((symbol, index) => {
    const at = (index + 1) * 24, name = Buffer.from(`${symbol.name}\0`);
    symbols.writeUInt32LE(length, at); names.push(name); length += name.length;
    symbols[at + 4] = ((symbol.weak ? 2 : symbol.global ? 1 : 0) << 4) | (symbol.type === 2 ? 2 : symbol.type === 1 ? 1 : 0);
    symbols[at + 5] = symbol.visibility ?? 0;
    symbols.writeUInt16LE(symbol.absolute ? 0xfff1 : symbol.outputSection?.index ?? 0xfff1, at + 6);
    u64(symbols, symbol.value, at + 8); u64(symbols, symbol.size ?? 0, at + 16);
  });
  return { symbols, strings: Buffer.concat(names), locals: list.filter(symbol => !symbol.global).length + 1 };
}

function writeElf(state) {
  const sym = elfSymbols(state), sections = [...state.sections];
  let cursor = state.dataEnd;
  if (sym.symbols.length) {
    const symtab = { name: ".symtab", type: 2, flags: 0n, addr: 0n, offset: cursor, data: sym.symbols, size: sym.symbols.length, align: 8, entsize: 24, link: sections.length + 2, info: sym.locals }; cursor += sym.symbols.length;
    const strtab = { name: ".strtab", type: 3, flags: 0n, addr: 0n, offset: cursor, data: sym.strings, size: sym.strings.length, align: 1 }; cursor += sym.strings.length;
    sections.push(symtab, strtab);
  }
  const shstrtab = { name: ".shstrtab", type: 3, flags: 0n, addr: 0n, offset: cursor, align: 1 };
  sections.push(shstrtab);
  let strings = "\0";
  for (const section of sections) { section.nameOffset = Buffer.byteLength(strings); strings += `${section.name}\0`; }
  shstrtab.data = Buffer.from(strings); shstrtab.size = shstrtab.data.length;
  cursor += shstrtab.size;
  const shoff = align(cursor, 8), buffer = Buffer.alloc(shoff + (sections.length + 1) * 64);
  buffer.set([127, 69, 76, 70, 2, 1, 1], 0);
  buffer.writeUInt16LE(2, 16); buffer.writeUInt16LE(state.machine, 18); buffer.writeUInt32LE(1, 20);
  u64(buffer, state.entry, 24); u64(buffer, 64, 32); u64(buffer, shoff, 40);
  buffer.writeUInt16LE(64, 52); buffer.writeUInt16LE(56, 54); buffer.writeUInt16LE(state.sections.length + 2, 56);
  buffer.writeUInt16LE(64, 58); buffer.writeUInt16LE(sections.length + 1, 60); buffer.writeUInt16LE(sections.length, 62);
  const phdr = (index, type, flags, offset, address, filesz, memsz, alignment) => {
    const at = 64 + index * 56;
    buffer.writeUInt32LE(type, at); buffer.writeUInt32LE(flags, at + 4);
    u64(buffer, offset, at + 8); u64(buffer, address, at + 16); u64(buffer, address, at + 24);
    u64(buffer, filesz, at + 32); u64(buffer, memsz, at + 40); u64(buffer, alignment, at + 48);
  };
  phdr(0, 1, 4, 0, state.imageBase, state.headerSize, state.headerSize, page);
  state.sections.forEach((section, index) => phdr(index + 1, 1, 4 | (section.writable ? 2 : 0) | (section.executable ? 1 : 0), section.offset, section.addr, section.bss ? 0 : section.size, section.size, Math.max(page, section.align)));
  phdr(state.sections.length + 1, 0x6474e551, 6, 0, 0, 0, 0, 16);
  sections.forEach((section, index) => {
    if (!section.bss) section.data.copy(buffer, section.offset);
    const at = shoff + (index + 1) * 64;
    buffer.writeUInt32LE(section.nameOffset, at); buffer.writeUInt32LE(section.bss ? 8 : section.type, at + 4);
    u64(buffer, section.flags, at + 8); u64(buffer, section.addr, at + 16); u64(buffer, section.offset, at + 24); u64(buffer, section.size, at + 32);
    buffer.writeUInt32LE(section.link ?? 0, at + 40); buffer.writeUInt32LE(section.info ?? 0, at + 44); u64(buffer, section.align, at + 48); u64(buffer, section.entsize ?? 0, at + 56);
  });
  return buffer;
}

function writePe(state) {
  const buffer = Buffer.alloc(state.dataEnd), h = 132, opt = h + 20, sections = state.peSections;
  buffer.write("MZ", 0); buffer.writeUInt32LE(128, 60); buffer.write("PE\0\0", 128);
  buffer.writeUInt16LE(state.machine, h); buffer.writeUInt16LE(sections.length, h + 2);
  buffer.writeUInt16LE(240, h + 16); buffer.writeUInt16LE(0x0023, h + 18); // executable, large addresses, fixed image
  buffer.writeUInt16LE(0x20b, opt); buffer[opt + 2] = 1;
  buffer.writeUInt32LE(sections.filter(section => section.executable).reduce((sum, section) => sum + section.rawSize, 0), opt + 4);
  buffer.writeUInt32LE(sections.filter(section => !section.executable && !section.bss).reduce((sum, section) => sum + section.rawSize, 0), opt + 8);
  buffer.writeUInt32LE(sections.filter(section => section.bss).reduce((sum, section) => sum + section.size, 0), opt + 12);
  buffer.writeUInt32LE(Number(state.entry - state.imageBase), opt + 16);
  buffer.writeUInt32LE(Number((state.sections.find(section => section.executable)?.addr ?? state.imageBase) - state.imageBase), opt + 20);
  u64(buffer, state.imageBase, opt + 24); buffer.writeUInt32LE(page, opt + 32); buffer.writeUInt32LE(512, opt + 36);
  buffer.writeUInt16LE(6, opt + 40); buffer.writeUInt16LE(6, opt + 48);
  buffer.writeUInt32LE(Number(state.endAddress - state.imageBase), opt + 56); buffer.writeUInt32LE(state.headerSize, opt + 60);
  buffer.writeUInt16LE(state.options.subsystem ?? 3, opt + 68); buffer.writeUInt16LE(0x100, opt + 70); // NX compatible
  u64(buffer, state.options.stackSize ?? 1024 * 1024, opt + 72); u64(buffer, 4096, opt + 80);
  u64(buffer, 1024 * 1024, opt + 88); u64(buffer, 4096, opt + 96); buffer.writeUInt32LE(16, opt + 108);
  const pdata = sections.find(section => section.name === ".pdata");
  if (pdata) { buffer.writeUInt32LE(Number(pdata.addr - state.imageBase), opt + 112 + 3 * 8); buffer.writeUInt32LE(pdata.size, opt + 116 + 3 * 8); }
  sections.forEach((section, index) => {
    const at = opt + 240 + index * 40;
    buffer.write(section.name.split("$")[0], at, 8); buffer.writeUInt32LE(section.size, at + 8); buffer.writeUInt32LE(Number(section.addr - state.imageBase), at + 12);
    buffer.writeUInt32LE(section.rawSize, at + 16); buffer.writeUInt32LE(section.offset, at + 20);
    const flags = (section.bss ? 0x80 : section.executable ? 0x20 : 0x40) | 0x40000000 | (section.writable ? 0x80000000 : 0) | (section.executable ? 0x20000000 : 0);
    buffer.writeUInt32LE(flags >>> 0, at + 36);
    if (!section.bss) for (const fragment of section.fragments) fragment.data.copy(buffer, fragment.offset);
  });
  return buffer;
}

function writeMachO(state) {
  const symbols = state.options.strip ? [] : state.symbols;
  const nlists = Buffer.alloc(symbols.length * 16), names = [Buffer.from([0])]; let stringLength = 1;
  symbols.forEach((symbol, index) => {
    const at = index * 16, name = Buffer.from(`${symbol.name}\0`);
    nlists.writeUInt32LE(stringLength, at); names.push(name); stringLength += name.length;
    nlists[at + 4] = (symbol.absolute ? 2 : 14) | (symbol.global ? 1 : 0); nlists[at + 5] = symbol.outputSection?.index ?? 0;
    nlists.writeUInt16LE(symbol.weak ? 0x80 : 0, at + 6); u64(nlists, symbol.value, at + 8);
  });
  const strings = Buffer.concat(names), linkeditSize = nlists.length + strings.length;
  const buffer = Buffer.alloc(state.dataEnd + linkeditSize);
  nlists.copy(buffer, state.dataEnd); strings.copy(buffer, state.dataEnd + nlists.length);
  const segments = [...state.machSegments, { name: "__LINKEDIT", offset: state.dataEnd, size: linkeditSize, addr: state.imageBase + BigInt(state.dataEnd), vmsize: BigInt(align(linkeditSize, page)), protection: 1, sections: [] }];
  buffer.writeUInt32LE(0xfeedfacf, 0); buffer.writeUInt32LE(state.machine, 4); buffer.writeUInt32LE(state.arch === "x86-64" ? 3 : 0, 8);
  buffer.writeUInt32LE(2, 12); buffer.writeUInt32LE(segments.length + 2, 16); buffer.writeUInt32LE(state.commandSize, 20); buffer.writeUInt32LE(1, 24);
  let at = 32;
  for (const segment of segments) {
    const size = 72 + segment.sections.length * 80;
    buffer.writeUInt32LE(0x19, at); buffer.writeUInt32LE(size, at + 4); buffer.write(segment.name, at + 8, 16);
    u64(buffer, segment.addr, at + 24); u64(buffer, segment.vmsize, at + 32); u64(buffer, segment.offset, at + 40); u64(buffer, segment.size, at + 48);
    buffer.writeUInt32LE(segment.protection, at + 56); buffer.writeUInt32LE(segment.protection, at + 60); buffer.writeUInt32LE(segment.sections.length, at + 64);
    segment.sections.forEach((section, index) => {
      const p = at + 72 + index * 80;
      buffer.write(section.name, p, 16); buffer.write(segment.name, p + 16, 16); u64(buffer, section.addr, p + 32); u64(buffer, section.size, p + 40);
      buffer.writeUInt32LE(section.bss ? 0 : section.offset, p + 48); buffer.writeUInt32LE(Math.ceil(Math.log2(section.align)), p + 52);
      buffer.writeUInt32LE(section.bss ? 1 : Number(section.flags & 0xffffffffn), p + 64);
      if (!section.bss) section.data.copy(buffer, section.offset);
    });
    at += size;
  }
  buffer.writeUInt32LE(2, at); buffer.writeUInt32LE(24, at + 4); buffer.writeUInt32LE(state.dataEnd, at + 8); buffer.writeUInt32LE(symbols.length, at + 12); buffer.writeUInt32LE(state.dataEnd + nlists.length, at + 16); buffer.writeUInt32LE(strings.length, at + 20); at += 24;
  const threadSize = state.arch === "x86-64" ? 184 : 288;
  buffer.writeUInt32LE(5, at); buffer.writeUInt32LE(threadSize, at + 4); buffer.writeUInt32LE(state.arch === "x86-64" ? 4 : 6, at + 8); buffer.writeUInt32LE(state.arch === "x86-64" ? 42 : 68, at + 12);
  u64(buffer, state.entry, at + 16 + (state.arch === "x86-64" ? 16 * 8 : 32 * 8));
  if (state.arch === "x86-64") u64(buffer, 0x202, at + 16 + 17 * 8);
  return buffer;
}

export function writeExecutable(state) {
  return state.format === "elf" ? writeElf(state) : state.format === "pe" ? writePe(state) : writeMachO(state);
}
