// Object-file layouts follow the ELF gABI, Microsoft PE/COFF specification,
// and Apple's mach-o/loader.h. All offsets from input are checked before use.
import {readFileSync} from "node:fs";
export const align = (n, a = 1) => Math.ceil(n / Math.max(1, a)) * Math.max(1, a);
export const hex = (n, width = 0) => BigInt(n).toString(16).padStart(width, "0");
export function cstring(b, offset = 0, end = b.length) {
  if (offset < 0 || offset >= end) return "";
  const n = b.indexOf(0, offset);
  return b.toString("utf8", offset, n < 0 || n > end ? end : n);
}
export class BinaryReader {
  constructor(bytes, le = true) {
    this.b = bytes;
    this.le = le;
  }
  range(o, n) {
    if (!Number.isSafeInteger(o) || !Number.isSafeInteger(n) || o < 0 || n < 0 ||
        o > this.b.length - n)
      throw new Error("truncated or malformed object file");
    return this.b.subarray(o, o + n);
  }
  u8(o) {
    this.range(o, 1);
    return this.b[o];
  }
  u16(o) {
    this.range(o, 2);
    return this.le ? this.b.readUInt16LE(o) : this.b.readUInt16BE(o);
  }
  i16(o) {
    this.range(o, 2);
    return this.le ? this.b.readInt16LE(o) : this.b.readInt16BE(o);
  }
  u32(o) {
    this.range(o, 4);
    return this.le ? this.b.readUInt32LE(o) : this.b.readUInt32BE(o);
  }
  i32(o) {
    this.range(o, 4);
    return this.le ? this.b.readInt32LE(o) : this.b.readInt32BE(o);
  }
  u64(o) {
    this.range(o, 8);
    return this.le ? this.b.readBigUInt64LE(o) : this.b.readBigUInt64BE(o);
  }
  i64(o) {
    this.range(o, 8);
    return this.le ? this.b.readBigInt64LE(o) : this.b.readBigInt64BE(o);
  }
  num64(o) {
    const n = this.u64(o);
    if (n > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("object offset exceeds supported range");
    return Number(n);
  }
  str(o, n) {
    return cstring(this.range(o, n));
  }
}
export function parseObject(bytes, name = "") {
  const b = Buffer.from(bytes), r = new BinaryReader(b);
  if (b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])))
    return parseElf(b, name);
  if (b.length >= 4 && [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(r.u32(0)))
    return parseMachO(b, name);
  if (b.length >= 4 && [0xbebafeca, 0xcafebabe, 0xbfbafeca, 0xcafebabf].includes(r.u32(0))) {
    r.le = [0xcafebabe, 0xcafebabf].includes(r.u32(0));
    const wide = [0xbfbafeca, 0xcafebabf].includes(b.readUInt32LE(0));
    const count = r.u32(4);
    r.range(8, count * (wide ? 32 : 20));
    const objects = [];
    for (let i = 0; i < count; i++) {
      const p = 8 + i * (wide ? 32 : 20), offset = wide ? r.num64(p + 8) : r.u32(p + 8),
            size = wide ? r.num64(p + 16) : r.u32(p + 12);
      objects.push(parseObject(r.range(offset, size), name));
    }
    return {format: "fat", name, bytes: b, objects};
  }
  if (b.length >= 20 &&
      (b.subarray(0, 2).toString() === "MZ" ||
       [0x14c, 0x8664, 0x1c0, 0x1c4, 0xaa64, 0x5032, 0x5064].includes(r.u16(0))))
    return parseCoff(b, name);
  throw new Error("file format not recognized");
}
export function objectMembers(file) {
  const bytes = readFileSync(file);
  if (bytes.subarray(0, 8).toString() === "!<arch>\n")
    return parseAr(bytes)
        .filter(m => !m.special)
        .flatMap(m => expandObject(parseObject(m.data, `${file}(${m.name})`)));
  return expandObject(parseObject(bytes, file));
}
function expandObject(obj) {
  return obj.format === "fat" ? obj.objects : [obj];
}
export const ELF_MACHINES = {
  3: "i386",
  40: "arm",
  62: "x86-64",
  183: "aarch64",
  243: "riscv"
};
export function parseElf(b, name) {
  const bits = b[4] === 1 ? 32 : b[4] === 2 ? 64 : 0;
  if (!bits || ![1, 2].includes(b[5])) throw new Error("invalid ELF identification");
  const r = new BinaryReader(b, b[5] === 1), wide = bits === 64;
  r.range(0, wide ? 64 : 52);
  const word = o => wide ? r.num64(o) : r.u32(o), big = o => wide ? r.u64(o) : BigInt(r.u32(o));
  const machine = r.u16(18), sectionOffset = word(wide ? 40 : 32),
        sectionEntrySize = r.u16(wide ? 58 : 46), programOffset = word(wide ? 32 : 28),
        programEntrySize = r.u16(wide ? 54 : 42);
  let sectionCount = r.u16(wide ? 60 : 48), stringIndex = r.u16(wide ? 62 : 50),
      programCount = r.u16(wide ? 56 : 44);
  if (sectionOffset && sectionCount === 0) sectionCount = word(sectionOffset + (wide ? 32 : 20));
  if (stringIndex === 0xffff) stringIndex = r.u32(sectionOffset + (wide ? 40 : 24));
  if (programCount === 0xffff) programCount = r.u32(sectionOffset + (wide ? 44 : 28));
  if (sectionCount && sectionEntrySize < (wide ? 64 : 40))
    throw new Error("invalid ELF section header size");
  if (programCount && programEntrySize < (wide ? 56 : 32))
    throw new Error("invalid ELF program header size");
  r.range(sectionOffset, sectionCount * sectionEntrySize);
  r.range(programOffset, programCount * programEntrySize);
  const obj = {
    format: "elf",
    target: `elf${bits}-${r.le ? "little" : "big"}${ELF_MACHINES[machine] ?? machine}`,
    bits,
    le: r.le,
    machine,
    arch: ELF_MACHINES[machine] ?? String(machine),
    name,
    bytes: b,
    type: r.u16(16),
    entry: big(24),
    flags: r.u32(wide ? 48 : 36),
    osabi: b[7],
    abiVersion: b[8],
    sectionOffset,
    sectionEntrySize,
    stringIndex,
    programOffset,
    programEntrySize,
    sections: [],
    symbols: [],
    relocations: [],
    segments: []
  };
  for (let i = 0; i < sectionCount; i++) {
    const p = sectionOffset + i * sectionEntrySize, type = r.u32(p + 4),
          size = word(p + (wide ? 32 : 20)), offset = word(p + (wide ? 24 : 16)),
          flags = big(p + 8);
    obj.sections.push({
      index: i,
      headerOffset: p,
      nameOffset: r.u32(p),
      name: "",
      type,
      flags,
      addr: big(p + (wide ? 16 : 12)),
      offset,
      size,
      link: r.u32(p + (wide ? 40 : 24)),
      info: r.u32(p + (wide ? 44 : 28)),
      align: word(p + (wide ? 48 : 32)),
      entsize: word(p + (wide ? 56 : 36)),
      data: type === 8 ? Buffer.alloc(0) : r.range(offset, size),
      alloc: !!(flags & 2n),
      writable: !!(flags & 1n),
      executable: !!(flags & 4n),
      bss: type === 8
    });
  }
  const names = obj.sections[stringIndex]?.data ?? Buffer.alloc(0);
  for (const s of obj.sections) s.name = cstring(names, s.nameOffset);
  for (let i = 0; i < programCount; i++) {
    const p = programOffset + i * programEntrySize;
    obj.segments.push({
      type: r.u32(p),
      flags: r.u32(p + (wide ? 4 : 24)),
      offset: word(p + (wide ? 8 : 4)),
      vaddr: big(p + (wide ? 16 : 8)),
      paddr: big(p + (wide ? 24 : 12)),
      filesz: word(p + (wide ? 32 : 16)),
      memsz: word(p + (wide ? 40 : 20)),
      align: word(p + (wide ? 48 : 28))
    });
  }
  const symbolTables = new Map();
  for (const s of obj.sections.filter(s => s.type === 2 || s.type === 11)) {
    if (s.entsize < (wide ? 24 : 16) || s.size % s.entsize)
      throw new Error("invalid ELF symbol table");
    const strings = obj.sections[s.link]?.data;
    if (!strings) throw new Error("invalid ELF symbol string table");
    const table = [];
    for (let i = 0; i < s.size / s.entsize; i++) {
      const p = s.offset + i * s.entsize, info = r.u8(p + (wide ? 4 : 12)),
            section = r.u16(p + (wide ? 6 : 14));
      const symbol = {
        index: i,
        table: s.index,
        recordOffset: p,
        name: cstring(strings, r.u32(p)),
        value: big(p + (wide ? 8 : 4)),
        size: word(p + (wide ? 16 : 8)),
        binding: info >> 4,
        type: info & 15,
        visibility: r.u8(p + (wide ? 5 : 13)) & 3,
        section,
        undefined: section === 0,
        absolute: section === 0xfff1,
        common: section === 0xfff2,
        global: info >> 4 !== 0,
        weak: info >> 4 === 2,
        dynamic: s.type === 11
      };
      table.push(symbol);
      if (i) obj.symbols.push(symbol);
    }
    symbolTables.set(s.index, table);
  }
  for (const s of obj.sections.filter(s => s.type === 4 || s.type === 9)) {
    const min = wide ? (s.type === 4 ? 24 : 16) : (s.type === 4 ? 12 : 8);
    if (s.entsize < min || s.size % s.entsize) throw new Error("invalid ELF relocation table");
    for (let i = 0; i < s.size / s.entsize; i++) {
      const p = s.offset + i * s.entsize, info = big(p + (wide ? 8 : 4)),
            index = Number(wide ? info >> 32n : info >> 8n);
      obj.relocations.push({
        section: s.info,
        table: s.index,
        recordOffset: p,
        offset: big(p),
        type: Number(wide ? info & 0xffffffffn : info & 255n),
        symbol: symbolTables.get(s.link)?.[index],
        symbolIndex: index,
        addend: s.type === 4 ? (wide ? r.i64(p + 16) : BigInt(r.i32(p + 8))) : null
      });
    }
  }
  return obj;
}
export function parseCoff(b, name) {
  const r = new BinaryReader(b), pe = b.subarray(0, 2).toString() === "MZ";
  let h = 0;
  if (pe) {
    h = r.u32(60);
    if (r.range(h, 4).toString() !== "PE\0\0") throw new Error("invalid PE signature");
    h += 4;
  }
  r.range(h, 20);
  const machine = r.u16(h), count = r.u16(h + 2), symoff = r.u32(h + 8), symcount = r.u32(h + 12),
        optional = r.u16(h + 16), sectionOffset = h + 20 + optional;
  r.range(sectionOffset, count * 40);
  if (symcount) r.range(symoff, symcount * 18);
  let strings = Buffer.alloc(0);
  if (symoff && symoff + symcount * 18 + 4 <= b.length) {
    const p = symoff + symcount * 18;
    strings = r.range(p, r.u32(p));
  }
  if(pe && ![0x10b,0x20b].includes(r.u16(h+20)))throw new Error("invalid PE optional header magic");
  const bits = pe                                ? (r.u16(h + 20) === 0x20b ? 64 : 32) :
      [0x8664, 0xaa64, 0x5064].includes(machine) ? 64 :
                                                   32;
  if (pe) {if(optional<(bits===64?112:96))throw new Error("invalid PE optional header size");r.range(h + 20, bits === 64 ? 112 : 96);}
  const imageBase = pe ? (bits === 64 ? r.u64(h + 44) : BigInt(r.u32(h + 48))) : 0n;
  const obj = {
    format: pe ? "pe" : "coff",
    target: `${pe ? "pei" : "pe"}-${
        machine === 0x8664     ? "x86-64" :
            machine === 0xaa64 ? "aarch64" :
                                 "i386"}`,
    bits,
    le: true,
    machine,
    arch: ({0x8664: "x86-64",
            0x14c: "i386",
            0xaa64: "aarch64",
            0x1c4: "arm",
            0x5064: "riscv"})[machine] ??
        String(machine),
    name,
    bytes: b,
    type: pe ? 2 : 1,
    headerOffset: h,
    entry: pe ? imageBase + BigInt(r.u32(h + 36)) : 0n,
    imageBase,
    sectionOffset,
    symbolOffset: symoff,
    symbolCount: symcount,
    stringSize: strings.length,
    sections: [],
    symbols: [],
    relocations: [],
    segments: []
  };
  for (let i = 0; i < count; i++) {
    const p = sectionOffset + i * 40;
    let sname = r.str(p, 8);
    if (/^\/\d+$/.test(sname)) sname = cstring(strings, Number(sname.slice(1)));
    const flags = BigInt(r.u32(p + 36)), size = r.u32(p + 16), offset = r.u32(p + 20),
          bss = !!(flags & 128n);
    obj.sections.push({
      index: i + 1,
      headerOffset: p,
      name: sname,
      addr: imageBase + BigInt(r.u32(p + 12)),
      offset,
      size: pe ? r.u32(p + 8) : size,
      rawSize: size,
      flags,
      type: bss ? 8 : 1,
      data: offset && size ? r.range(offset, size) : Buffer.alloc(0),
      alloc: !sname.startsWith(".debug") && !(flags & 0x800n),
      executable: !!(flags & 0x20000020n),
      writable: !!(flags & 0x80000000n),
      bss,
      align: 2 ** Math.max(0, Number((flags >> 20n) & 15n) - 1),
      relocOffset: r.u32(p + 24),
      relocCount: r.u16(p + 32)
    });
  }
  const table = [];
  for (let i = 0; i < symcount;) {
    const p = symoff + i * 18,
          sname = r.u32(p) === 0 ? cstring(strings, r.u32(p + 4)) : r.str(p, 8),
          section = r.i16(p + 12), storage = r.u8(p + 16), aux = r.u8(p + 17);
    if (i + aux >= symcount) throw new Error("invalid COFF auxiliary symbols");
    const symbol = {
      index: i,
      recordOffset: p,
      name: sname,
      value: BigInt(r.u32(p + 8)),
      size: 0,
      binding: storage === 2 ? 1 : 0,
      type: r.u16(p + 14) === 32 ? 2 : 0,
      section,
      storage,
      aux,
      global: storage === 2 || storage === 105,
      weak: storage === 105,
      undefined: section === 0 && r.u32(p + 8) === 0,
      absolute: section === -1,
      common: section === 0 && r.u32(p + 8) !== 0
    };
    table[i] = symbol;
    obj.symbols.push(symbol);
    i += 1 + aux;
  }
  for (const s of obj.sections) {
    r.range(s.relocOffset, s.relocCount * 10);
    for (let i = 0; i < s.relocCount; i++) {
      const p = s.relocOffset + i * 10, index = r.u32(p + 4);
      obj.relocations.push({
        section: s.index,
        recordOffset: p,
        offset: BigInt(r.u32(p)),
        type: r.u16(p + 8),
        symbol: table[index],
        symbolIndex: index,
        addend: null
      });
    }
  }
  return obj;
}
export function parseMachO(b, name) {
  const magic = b.readUInt32LE(0), le = [0xfeedface, 0xfeedfacf].includes(magic),
        bits = [0xfeedfacf, 0xcffaedfe].includes(magic) ? 64 : 32, r = new BinaryReader(b, le),
        wide = bits === 64, head = wide ? 32 : 28;
  r.range(0, head);
  const machine = r.u32(4), ncmds = r.u32(16), sizeofcmds = r.u32(20);
  r.range(head, sizeofcmds);
  const obj = {
    format: "macho",
    target: `mach-o-${bits === 64 ? "64" : "32"}`,
    bits,
    le,
    machine,
    arch: ({7: "i386", 0x1000007: "x86-64", 12: "arm", 0x100000c: "aarch64"})[machine] ??
        String(machine),
    name,
    bytes: b,
    type: r.u32(12),
    flags: r.u32(24),
    entry: 0n,
    sections: [],
    symbols: [],
    relocations: [],
    segments: [],
    commands: []
  };
  let p = head, symtab;
  for (let i = 0; i < ncmds; i++) {
    r.range(p, 8);
    const cmd = r.u32(p), size = r.u32(p + 4);
    if (size < 8 || p + size > head + sizeofcmds) throw new Error("invalid Mach-O load command");
    obj.commands.push({cmd, size, offset: p});
    if (cmd === 1 || cmd === 0x19) {
      const w = cmd === 0x19, word = o => w ? r.num64(o) : r.u32(o),
            big = o => w ? r.u64(o) : BigInt(r.u32(o));
      const count = r.u32(p + (w ? 64 : 48)), start = p + (w ? 72 : 56), ss = w ? 80 : 68;
      if (start + count * ss > p + size) throw new Error("invalid Mach-O segment");
      obj.segments.push({
        name: r.str(p + 8, 16),
        vaddr: big(p + 24),
        memsz: word(p + (w ? 32 : 28)),
        offset: word(p + (w ? 40 : 32)),
        filesz: word(p + (w ? 48 : 36)),
        flags: r.u32(p + (w ? 60 : 44))
      });
      for (let j = 0; j < count; j++) {
        const q = start + j * ss, flags = BigInt(r.u32(q + (w ? 64 : 56))),
              type = Number(flags & 255n), size = word(q + (w ? 40 : 36)),
              offset = r.u32(q + (w ? 48 : 40)), bss = [1, 12, 18].includes(type),
              sname = r.str(q, 16), segment = r.str(q + 16, 16);
        obj.sections.push({
          index: obj.sections.length + 1,
          headerOffset: q,
          name: sname,
          segment,
          addr: big(q + 32),
          size,
          offset,
          flags,
          type,
          data: bss ? Buffer.alloc(0) : r.range(offset, size),
          align: 2 ** r.u32(q + (w ? 52 : 44)),
          relocOffset: r.u32(q + (w ? 56 : 48)),
          relocCount: r.u32(q + (w ? 60 : 52)),
          alloc: segment !== "__DWARF",
          writable: segment !== "__TEXT",
          executable: !!(flags & 0x80000400n),
          bss
        });
      }
    } else if (cmd === 2) {
      if (size < 24) throw new Error("invalid Mach-O symbol command");
      symtab = {
        offset: r.u32(p + 8),
        count: r.u32(p + 12),
        strings: r.u32(p + 16),
        stringSize: r.u32(p + 20),
        command: p
      };
    } else if (cmd === 0x80000028) {
      if (size < 24) throw new Error("invalid Mach-O entry command");
      obj.entry = r.u64(p + 8);
    } else if (cmd === 5) {
      // LC_UNIXTHREAD encodes the initial architecture-specific register set.
      let at=p+8;
      while(at+8<=p+size) {
        const flavor=r.u32(at),count=r.u32(at+4),state=at+8;
        if(state+count*4>p+size) throw new Error("invalid Mach-O thread state");
        if(machine===0x1000007 && flavor===4 && count>=42) obj.entry=r.u64(state+16*8);
        else if(machine===7 && flavor===1 && count>=16) obj.entry=BigInt(r.u32(state+10*4));
        else if(machine===0x100000c && flavor===6 && count>=68) obj.entry=r.u64(state+32*8);
        else if(machine===12 && flavor===1 && count>=17) obj.entry=BigInt(r.u32(state+15*4));
        at=state+count*4;
      }
    }
    p += size;
  }
  if (symtab) {
    obj.symtab = symtab;
    const strings = r.range(symtab.strings, symtab.stringSize), ss = wide ? 16 : 12;
    r.range(symtab.offset, symtab.count * ss);
    for (let i = 0; i < symtab.count; i++) {
      const p = symtab.offset + i * ss, type = r.u8(p + 4), section = r.u8(p + 5),
            desc = r.u16(p + 6), value = wide ? r.u64(p + 8) : BigInt(r.u32(p + 8));
      obj.symbols.push({
        index: i,
        recordOffset: p,
        name: cstring(strings, r.u32(p)),
        value,
        size: 0,
        type,
        section,
        global: !!(type & 1),
        weak: !!(desc & 0xc0),
        undefined: (type & 14) === 0 && value === 0n,
        common: (type & 14) === 0 && value !== 0n,
        absolute: (type & 14) === 2,
        debug: !!(type & 0xe0)
      });
    }
  }
  for (const s of obj.sections) {
    r.range(s.relocOffset, s.relocCount * 8);
    for (let i = 0; i < s.relocCount; i++) {
      const p = s.relocOffset + i * 8, address = r.u32(p), bits = r.u32(p + 4);
      if (address & 0x80000000) continue;
      const index = bits & 0xffffff, external = !!(bits & 0x8000000);
      obj.relocations.push({
        section: s.index,
        recordOffset: p,
        offset: BigInt(address),
        symbolIndex: index,
        symbol: external ? obj.symbols[index] : undefined,
        targetSection: external ? undefined : index,
        pcRelative: !!(bits & 0x1000000),
        length: 1 << ((bits >>> 25) & 3),
        type: bits >>> 28,
        external,
        addend: null
      });
    }
  }
  return obj;
}
export function symbolLetter(obj, symbol) {
  if (symbol.debug) return "-";
  if (symbol.weak) return symbol.undefined ? "w" : symbol.type === 1 ? "V" : "W";
  let letter = symbol.undefined ? "U" : symbol.absolute ? "A" : symbol.common ? "C" : null;
  if (!letter) {
    const s = obj.sections.find(s => s.index === symbol.section);
    letter = !s ? "?" : s.bss ? "B" : s.executable ? "T" : s.writable ? "D" : s.alloc ? "R" : "N";
  }
  return symbol.global || symbol.undefined ? letter : letter.toLowerCase();
}
export function parseAr(bytes) {
  const b = Buffer.from(bytes), r = new BinaryReader(b);
  if (r.range(0, 8).toString() !== "!<arch>\n")
    throw new Error("file format not recognized as an archive");
  let p = 8, names = Buffer.alloc(0);
  const entries = [];
  while (p < b.length) {
    const h = r.range(p, 60);
    if (h.subarray(58).toString() !== "`\n") throw new Error("malformed archive member header");
    const numeric = (a, z, base = 10) => {
      const s = h.subarray(a, z).toString().trim();
      if (!s) return 0;
      if (!(base === 8 ? /^[0-7]+$/ : /^\d+$/).test(s))
        throw new Error("invalid archive member size or metadata");
      return parseInt(s, base);
    };
    const size = numeric(48, 58), raw = h.subarray(0, 16).toString().trim();
    let data = r.range(p + 60, size), name = raw;
    if (raw === "//")
      names = data;
    else if (raw.startsWith("#1/")) {
      const n = Number(raw.slice(3));
      if (!/^\d+$/.test(raw.slice(3)) || !Number.isSafeInteger(n) || n > size) throw new Error("invalid archive extended name");
      name = cstring(data, 0, n);
      data = data.subarray(n);
    } else if (/^\/\d+$/.test(raw)) {
      const offset = Number(raw.slice(1));
      if (offset >= names.length) throw new Error("invalid archive name offset");
      const end = names.indexOf("/\n", offset);
      name = names.subarray(offset, end < 0 ? names.length : end).toString();
    } else if (raw.endsWith("/") && raw !== "/")
      name = raw.slice(0, -1);
    entries.push({
      name,
      data,
      offset: p,
      size,
      mtime: numeric(16, 28),
      uid: numeric(28, 34),
      gid: numeric(34, 40),
      mode: numeric(40, 48, 8),
      special: ["/", "//", "/SYM64/", "__.SYMDEF", "__.SYMDEF SORTED"].includes(raw) ||
          name.startsWith("__.SYMDEF")
    });
    p = align(p + 60 + size, 2);
  }
  return entries;
}
export function encodeAr(entries, index = true, deterministic = true) {
  const names = [];
  let table = "";
  for (const m of entries) {
    if (Buffer.byteLength(m.name) > 15 || /[\s/]/.test(m.name)) {
      names.push(`/${Buffer.byteLength(table)}`);
      table += `${m.name}/\n`;
    } else
      names.push(`${m.name}/`);
  }
  const symbolNames = [];
  if (index)
    for (let i = 0; i < entries.length; i++) {
      let obj;
      try {
        obj = parseObject(entries[i].data);
      } catch {
        continue;
      }
      for (const s of (obj.format === "fat" ? obj.objects[0] : obj).symbols)
        if (s.name && s.global && !s.undefined) symbolNames.push({name: s.name, member: i});
    }
  const indexLength = 4 + symbolNames.length * 4 +
      symbolNames.reduce((n, s) => n + Buffer.byteLength(s.name) + 1, 0);
  let offset = 8 + (index ? 60 + align(indexLength, 2) : 0) +
      (table ? 60 + align(Buffer.byteLength(table), 2) : 0);
  const offsets = entries.map(m => {
    const p = offset;
    offset += 60 + align(m.data.length, 2);
    return p;
  });
  const chunks = [Buffer.from("!<arch>\n")];
  function add(name, data, m = {}) {
    const field = (v, n) => {
      const s = String(v);
      const size = Buffer.byteLength(s);
      if (size > n) throw new Error("archive metadata too large");
      return s + " ".repeat(n - size);
    };
    chunks.push(
        Buffer.from(
            field(name, 16) + field(deterministic ? 0 : m.mtime ?? 0, 12) +
            field(deterministic ? 0 : m.uid ?? 0, 6) + field(deterministic ? 0 : m.gid ?? 0, 6) +
            field((deterministic ? 0o644 : m.mode ?? 0o644).toString(8), 8) +
            field(data.length, 10) + "`\n"),
        data);
    if (data.length % 2) chunks.push(Buffer.from("\n"));
  }
  if (index) {
    const data = Buffer.alloc(indexLength);
    data.writeUInt32BE(symbolNames.length);
    let p = 4 + symbolNames.length * 4;
    symbolNames.forEach((s, i) => {
      data.writeUInt32BE(offsets[s.member], 4 + i * 4);
      p += data.write(s.name, p);
      data[p++] = 0;
    });
    add("/", data);
  }
  if (table) add("//", Buffer.from(table));
  entries.forEach((m, i) => add(names[i], m.data, m));
  return Buffer.concat(chunks);
}
