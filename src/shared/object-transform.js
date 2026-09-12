import {align, cstring, encodeAr, parseAr, parseObject} from "./object-files.js";

function writer(buffer, le = true) {
  return {
    u16: (o, n) => le ? buffer.writeUInt16LE(n, o) : buffer.writeUInt16BE(n, o),
    u32: (o, n) => le ? buffer.writeUInt32LE(n >>> 0, o) : buffer.writeUInt32BE(n >>> 0, o),
    u64: (o, n) =>
        le ? buffer.writeBigUInt64LE(BigInt(n), o) : buffer.writeBigUInt64BE(BigInt(n), o)
  };
}
function remapAddressSignificance(data,symbolMap) {
  const values=[];
  for(let p=0;p<data.length;) {
    let index=0,shift=0,byte;
    do {if(p>=data.length || shift>49)throw new Error("invalid LLVM address-significance table");byte=data[p++];index+=(byte&127)*2**shift;shift+=7;} while(byte&128);
    let mapped=symbolMap.get(index);if(mapped==null)continue;
    do {let next=mapped&127;mapped=Math.floor(mapped/128);if(mapped)next|=128;values.push(next);}while(mapped);
  }
  return Buffer.from(values);
}
export function transformObject(bytes, config = {}) {
  if (bytes.subarray(0, 8).toString() === "!<arch>\n")
    return encodeAr(parseAr(bytes)
                        .filter(m => !m.special)
                        .map(m => ({...m, data: transformObject(m.data, config)})));
  const obj = parseObject(bytes);
  if (obj.format === "fat") return transformFat(bytes, config);
  if (config.outputTarget === "binary") return binaryImage(obj, config);
  if (config.outputTarget &&
      ![obj.target, "elf64-x86-64", "elf32-i386", "pe-x86-64", "pei-x86-64", "mach-o-x86-64",
        "mach-o-arm64"]
           .includes(config.outputTarget))
    throw new Error(`unsupported output target '${config.outputTarget}'`);
  if (config.outputTarget) {
    const format = config.outputTarget.startsWith("elf") ? "elf" :
        config.outputTarget.startsWith("mach-o")         ? "macho" :
        config.outputTarget.startsWith("pei")            ? "pe" :
                                                           "coff";
    if (obj.format !== format)
      throw new Error("cross-format object conversion requires binary intermediate input");
    const requested=config.outputTarget;
    const arch=/aarch64|arm64/.test(requested)?"aarch64":/x86-64/.test(requested)?"x86-64":/i386/.test(requested)?"i386":null;
    if(arch && arch!==obj.arch)throw new Error("changing object architecture requires assembling for the requested target");
  }
  if (obj.format === "elf") return transformElf(obj, config);
  if (obj.format === "coff" || obj.format === "pe") return transformCoff(obj, config);
  return transformMachO(obj, config);
}
const debugSection = s => /^\.(?:z?debug|stab)|^__debug|^__zdebug/.test(s.name);
const matches = (patterns, name) => patterns?.some(
    p => new RegExp(`^${
                        p.replace(/[.+^${}()|[\]\\]/g, "\\$&")
                            .replaceAll("*", ".*")
                            .replaceAll("?", ".")}$`)
             .test(name));
function removed(s, c) {
  return ((c.stripDebug || c.stripAll || c.stripUnneeded) && debugSection(s)) || matches(c.remove, s.name) ||
      (c.only?.length && !matches(c.only, s.name) && s.alloc);
}
function transformElf(obj, c) {
  const wide = obj.bits === 64;
  const headerEnd=Math.max(wide ? 64 : 52,obj.programOffset+obj.programEntrySize*obj.segments.length);
  const preservedEnd=obj.type===1 ? headerEnd : Math.max(headerEnd,...obj.segments.map(s=>s.offset+s.filesz));
  const out = Buffer.from(obj.bytes.subarray(0,preservedEnd)), w = writer(out, obj.le);
  let sections = obj.sections.map(s => ({...s, data: Buffer.from(s.data)}));
  const removedIds = new Set(
      sections
          .filter(
              s => s.index !== 0 && (removed(s, c) || (c.stripAll && (s.type===2 || (!s.alloc && [9,4].includes(s.type))))))
          .map(s => s.index));
  if (c.stripAll)
    for (const s of sections.filter(s => s.type === 2)) {
      if(!sections.some(other=>other.index!==s.index && !removedIds.has(other.index) && other.link===s.link)) removedIds.add(s.link);
    }
  for (const s of sections.filter(s => s.type === 4 || s.type === 9))
    if (removedIds.has(s.info)) removedIds.add(s.index);
  sections = sections.filter(s => !removedIds.has(s.index));
  for (const s of obj.sections) if(removedIds.has(s.index) && s.offset<out.length && s.type!==8) out.fill(0,s.offset,Math.min(out.length,s.offset+s.data.length));
  // Preserve allocated section offsets in executables so program headers and dynamic pointers
  // remain valid.
  for (const s of sections) {
    if(s.index && (obj.type===1 || s.offset+s.data.length>out.length)) s.changed=true;
    if (c.rename?.has(s.name)) s.name = c.rename.get(s.name);
    if (c.update?.has(s.name)) {
      const data = c.update.get(s.name);
      if (obj.type !== 1 && s.alloc && data.length > s.size)
        throw new Error(`cannot grow allocated section '${s.name}' in an executable`);
      s.data = data;
      s.size = data.length;
      s.changed = true;
    }
    if (c.onlyDebug && s.alloc && s.type !== 7) {
      if(s.offset<out.length) out.fill(0,s.offset,Math.min(out.length,s.offset+s.data.length));
      s.type = 8;
      s.data = Buffer.alloc(0);
    }
  }
  let next = Math.max(...obj.sections.map(s => s.index), 0) + 1;
  for (const [name, data] of c.add ?? []) {
    if (sections.some(s => s.name === name)) throw new Error(`section '${name}' already exists`);
    sections.push({
      index: next++,
      name,
      type: 1,
      flags: 0n,
      addr: 0n,
      offset: 0,
      size: data.length,
      link: 0,
      info: 0,
      align: 1,
      entsize: 0,
      data,
      changed: true
    });
  }
  let shstr = sections.find(s => s.index === obj.stringIndex && !sections.some(other=>[2,11].includes(other.type)&&other.link===s.index));
  if (!shstr) {
    shstr = {
      index: next++,
      name: ".shstrtab",
      type: 3,
      flags: 0n,
      addr: 0n,
      offset: 0,
      size: 0,
      link: 0,
      info: 0,
      align: 1,
      entsize: 0
    };
    sections.push(shstr);
  }
  const indices = new Map(sections.map((s, i) => [s.index, i]));
  const stringTables=new Map();
  for(const s of sections.filter(s=>s.type===2)) {
    const strings=sections.find(x=>x.index===s.link);
    if(strings && !strings.alloc && !stringTables.has(strings.index)) stringTables.set(strings.index,{section:strings,parts:[Buffer.from([0])],length:1,names:new Map([["",0]])});
  }
  for (const s of sections) {
    if (s.type === 2 || s.type === 11) {
      const keepSymbols = [];
      const tableSymbols = obj.symbols.filter(x => x.table === s.index),
            referenced =
                new Set(obj.relocations
                            .filter(r => !removedIds.has(r.section) && r.symbol?.table === s.index)
                            .map(r => r.symbolIndex));
      const count = s.data.length / s.entsize, symbolMap = new Map();
      for (let i = 0; i < count; i++) {
        const symbol = tableSymbols.find(x => x.index === i);
        if (s.type===2 && i && symbol &&
            ((c.stripSymbols?.includes(symbol.name)) || removedIds.has(symbol.section) ||
             (c.stripUnneeded && !symbol.global && !referenced.has(i)) ||
             ((c.stripDebug || c.stripUnneeded) && symbol.type === 4))) {
          if (referenced.has(i))
            throw new Error(`symbol '${symbol.name}' is needed by a relocation`);
          continue;
        }
        const data = Buffer.from(s.data.subarray(i * s.entsize, (i + 1) * s.entsize));
        const stringTable=stringTables.get(s.link);
        if(stringTable) {
          const name=symbol?.name??"";
          if(!stringTable.names.has(name)) { stringTable.names.set(name,stringTable.length); const bytes=Buffer.from(name+"\0"); stringTable.parts.push(bytes); stringTable.length+=bytes.length; }
          writer(data,obj.le).u32(0,stringTable.names.get(name));
        }
        if (symbol && symbol.section > 0 && symbol.section < 0xff00) {
          const wi = writer(data, obj.le);
          wi.u16(wide ? 6 : 14, indices.get(symbol.section) ?? 0);
        }
        symbolMap.set(i, keepSymbols.length);
        keepSymbols.push(data);
      }
      s.data = Buffer.concat(keepSymbols);
      s.size = s.data.length;
      s.changed = true;
      if (s.type === 2)
        s.info = keepSymbols.findIndex((b, i) => i > 0 && ((b[wide ? 4 : 12] >> 4) !== 0));
      if (s.info < 0) s.info = keepSymbols.length;
      for(const table of sections.filter(x=>x.type===0x6fff4c03 && x.link===s.index)) {
        table.data=remapAddressSignificance(table.data,symbolMap);table.size=table.data.length;table.changed=true;
      }
      for(const group of sections.filter(x=>x.type===17 && x.link===s.index)) {
        group.info=symbolMap.get(group.info)??0;
        if(!group.info) throw new Error("cannot remove the signature symbol of a retained section group");
      }
      for (const rel of sections.filter(
               x => (x.type === 4 || x.type === 9) && x.link === s.index)) {
        const rw = writer(rel.data, obj.le);
        for (const r of obj.relocations.filter(x => x.table === rel.index)) {
          const p = r.recordOffset - rel.offset;
          const index = symbolMap.get(r.symbolIndex);
          if (index == null) throw new Error("removed a required relocation symbol");
          if (wide)
            rw.u64(p + 8, (BigInt(index) << 32n) | BigInt(r.type));
          else
            rw.u32(p + 4, (index << 8) | r.type);
        }
        rel.changed = true;
      }
    }
  }
  for(const {section,parts} of stringTables.values()) { section.data=Buffer.concat(parts);section.size=section.data.length;section.changed=true; }
  for(const group of sections.filter(s=>s.type===17)) {
    const reader=(p)=>obj.le ? group.data.readUInt32LE(p) : group.data.readUInt32BE(p);
    if(group.data.length<4 || group.data.length%4) throw new Error("invalid ELF section group");
    const entries=[reader(0)];
    for(let p=4;p<group.data.length;p+=4) if(indices.has(reader(p))) entries.push(indices.get(reader(p)));
    group.data=Buffer.alloc(entries.length*4);const gw=writer(group.data,obj.le);entries.forEach((n,i)=>gw.u32(i*4,n));group.size=group.data.length;group.changed=true;
  }
  let names = "\0";
  for (const s of sections) {
    s.nameOffset = Buffer.byteLength(names);
    if (s.index === 0)
      s.nameOffset = 0;
    else
      names += `${s.name}\0`;
  }
  shstr.data = Buffer.from(names);
  shstr.size = shstr.data.length;
  shstr.changed = true;
  let length = out.length;
  const chunks = [out];
  for (const s of sections) {
    if(s.index===0) continue;
    if (s.type === 8) continue;
    if (s.changed) {
      if (obj.type !== 1 && s.alloc) {
        if(s.data.length>s.size || s.offset+s.data.length>out.length) throw new Error(`cannot relocate allocated section '${s.name}'`);
        const old=obj.sections.find(old=>old.index===s.index);
        if(old && s.size<old.size)out.fill(0,s.offset,Math.min(out.length,s.offset+old.data.length));
        s.data.copy(out, s.offset);
        continue;
      }
      const start = align(length, s.align || 1);
      chunks.push(Buffer.alloc(start - length), s.data);
      s.offset = start;
      length = start + s.data.length;
    }
  }
  const headerStart = align(length, wide ? 8 : 4);
  chunks.push(Buffer.alloc(headerStart - length));
  const headers = Buffer.alloc(sections.length * (wide ? 64 : 40)), hw = writer(headers, obj.le),
        word = (o, n) => wide ? hw.u64(o, n) : hw.u32(o, Number(n));
  sections.forEach((s, i) => {
    const p = i * (wide ? 64 : 40);
    if (i === 0) return;
    hw.u32(p, s.nameOffset);
    hw.u32(p + 4, s.type);
    word(p + 8, s.flags);
    word(p + (wide ? 16 : 12), s.addr);
    word(p + (wide ? 24 : 16), s.offset);
    word(p + (wide ? 32 : 20), s.size);
    hw.u32(p + (wide ? 40 : 24), indices.get(s.link) ?? 0);
    hw.u32(p + (wide ? 44 : 28), [4, 9].includes(s.type) ? indices.get(s.info) ?? 0 : s.info);
    word(p + (wide ? 48 : 32), s.align);
    word(p + (wide ? 56 : 36), s.entsize);
  });
  chunks.push(headers);
  if (wide)
    w.u64(40, headerStart);
  else
    w.u32(32, headerStart);
  w.u16(wide ? 60 : 48, sections.length);
  w.u16(wide ? 62 : 50, indices.get(shstr.index));
  return Buffer.concat(chunks);
}
function transformCoff(obj, c) {
  if (c.add?.size || c.update?.size || c.onlyDebug)
    throw new Error("adding/replacing sections and separate debug files currently require ELF");
  const sections = obj.sections.filter(s => !removed(s, c)),
        indices = new Map(sections.map((s, i) => [s.index, i + 1]));
  const referenced=new Set(obj.relocations.filter(r=>indices.has(r.section)).map(r=>r.symbolIndex));
  // Weak external auxiliary records name another symbol by table index.
  for(const symbol of obj.symbols) if(symbol.storage===105 && symbol.aux) referenced.add(obj.bytes.readUInt32LE(symbol.recordOffset+18));
  const kept=obj.symbols.filter(symbol=> {
    if(c.stripAll) return false;
    const drop=(symbol.section>0 && !indices.has(symbol.section)) || c.stripSymbols?.includes(symbol.name) || ((c.stripDebug || c.stripUnneeded) && symbol.storage===103) || (c.stripUnneeded && !symbol.global && !referenced.has(symbol.index) && symbol.storage!==3);
    if(drop && referenced.has(symbol.index)) throw new Error(`symbol '${symbol.name}' is needed by a relocation`);
    return !drop;
  });
  const symbolMap=new Map();let symbolCount=0;
  for(const symbol of kept) { symbolMap.set(symbol.index,symbolCount);symbolCount+=1+symbol.aux; }
  const strings=[Buffer.alloc(4)], stringOffsets=new Map();let stringLength=4;
  const stringOffset=name=> { if(!stringOffsets.has(name)) { stringOffsets.set(name,stringLength);const b=Buffer.from(name+"\0");strings.push(b);stringLength+=b.length; }return stringOffsets.get(name); };
  const symbols=[];
  for(const symbol of kept) {
    const b=Buffer.from(obj.bytes.subarray(symbol.recordOffset,symbol.recordOffset+18*(1+symbol.aux)));
    b.fill(0,0,8);
    if(Buffer.byteLength(symbol.name)<=8) b.write(symbol.name,0);else { b.writeUInt32LE(0,0);b.writeUInt32LE(stringOffset(symbol.name),4); }
    if(symbol.section>0) b.writeInt16LE(indices.get(symbol.section),12);
    if(symbol.storage===3 && symbol.aux && symbol.section>0) {
      // IMAGE_AUX_SYMBOL.Section: associative COMDAT section number.
      if(b[18+14]===5) {
        const associated=b.readUInt16LE(18+12)|(b.readUInt16LE(18+16)<<16), mapped=indices.get(associated);
        if(!mapped) throw new Error("retained COMDAT refers to a removed section");
        b.writeUInt16LE(mapped&65535,18+12);b.writeUInt16LE(mapped>>>16,18+16);
      }
      if(c.stripAll || c.stripDebug) b.writeUInt16LE(0,18+6);
    }
    if(symbol.storage===105 && symbol.aux) {
      const target=symbolMap.get(b.readUInt32LE(18));if(target==null) throw new Error("removed weak external target");b.writeUInt32LE(target,18);
    }
    symbols.push(b);
  }
  const pe=obj.format==="pe", originalHeaderEnd=obj.sectionOffset+obj.sections.length*40;
  let prefix;
  if(pe) {
    // PE RVAs, import tables and loader directories address mapped payloads.
    // Keep their offsets and erase only explicitly removed data.
    prefix=Buffer.from(obj.bytes);
    for(const s of obj.sections.filter(s=>!indices.has(s.index))) {
      prefix.fill(0,s.offset,s.offset+s.data.length);
      if(s.relocCount) prefix.fill(0,s.relocOffset,s.relocOffset+s.relocCount*10);
    }
    if(obj.symbolOffset) prefix.fill(0,obj.symbolOffset,Math.min(prefix.length,obj.symbolOffset+obj.symbolCount*18+(obj.stringSize??0)));
    if(c.stripAll || c.stripDebug || c.stripUnneeded) {
      const countAt=obj.headerOffset+20+(obj.bits===64 ? 108 : 92),dirs=obj.headerOffset+20+(obj.bits===64 ? 112 : 96);
      if(prefix.readUInt32LE(countAt)>6) {
        const rva=prefix.readUInt32LE(dirs+6*8),size=prefix.readUInt32LE(dirs+6*8+4);
        const owner=obj.sections.find(s=>BigInt(rva)>=s.addr-obj.imageBase && BigInt(rva+size)<=s.addr-obj.imageBase+BigInt(s.data.length));
        if(rva && size && owner) {
          const at=owner.offset+Number(BigInt(rva)-(owner.addr-obj.imageBase));
          if(size%28)throw new Error("invalid PE debug directory size");
          for(let p=at;p<at+size;p+=28) {
            const length=prefix.readUInt32LE(p+16),offset=prefix.readUInt32LE(p+24);
            if(offset>prefix.length-length)throw new Error("invalid PE debug data offset");
            prefix.fill(0,offset,offset+length);
          }
          prefix.fill(0,at,at+size);
        }
        prefix.fill(0,dirs+6*8,dirs+7*8);
      }
      prefix.writeUInt32LE(0,obj.headerOffset+20+64);
    }
  } else prefix=Buffer.from(obj.bytes.subarray(0,obj.sectionOffset+sections.length*40));
  const chunks=[prefix];let length=prefix.length;
  const append=(bytes,alignment=4)=>{const offset=align(length,alignment);chunks.push(Buffer.alloc(offset-length),bytes);length=offset+bytes.length;return offset;};
  for(const section of sections) {
    const h=Buffer.from(obj.bytes.subarray(section.headerOffset,section.headerOffset+40)),name=c.rename?.get(section.name)??section.name;
    h.fill(0,0,8);
    if(Buffer.byteLength(name)<=8) h.write(name,0);else {const encoded=`/${stringOffset(name)}`;if(encoded.length>8)throw new Error("COFF string table too large");h.write(encoded,0);}
    const data=section.name===".llvm_addrsig" ? remapAddressSignificance(section.data,symbolMap) : section.data;
    if(!pe) {h.writeUInt32LE(section.bss?section.rawSize:data.length,16);h.writeUInt32LE(data.length ? append(data,Math.min(section.align||1,8192)) : 0,20);}
    if(c.stripAll) {h.writeUInt32LE(0,24);h.writeUInt16LE(0,32);}
    else if(section.relocCount) {
      const rel=Buffer.from(obj.bytes.subarray(section.relocOffset,section.relocOffset+section.relocCount*10));
      for(let p=0;p<rel.length;p+=10) {const index=symbolMap.get(rel.readUInt32LE(p+4));if(index==null)throw new Error("removed a required COFF relocation symbol");rel.writeUInt32LE(index,p+4);}
      if(pe) rel.copy(prefix,section.relocOffset);else h.writeUInt32LE(append(rel),24);
    } else h.writeUInt32LE(0,24);
    const lineOffset=h.readUInt32LE(28),lineCount=h.readUInt16LE(34);
    if(c.stripAll || c.stripDebug || c.stripUnneeded) {h.writeUInt32LE(0,28);h.writeUInt16LE(0,34);}
    else if(!pe && lineCount) h.writeUInt32LE(append(obj.bytes.subarray(lineOffset,lineOffset+lineCount*6)),28);
    h.copy(prefix,obj.sectionOffset+(indices.get(section.index)-1)*40);
  }
  if(pe) prefix.fill(0,obj.sectionOffset+sections.length*40,originalHeaderEnd);
  const symbolOffset=(symbols.length || stringLength>4) ? append(Buffer.concat(symbols)) : 0;
  if(symbolOffset) {const table=Buffer.concat(strings);table.writeUInt32LE(stringLength,0);append(table,1);}
  prefix.writeUInt16LE(sections.length,obj.headerOffset+2);
  prefix.writeUInt32LE(symbolOffset,obj.headerOffset+8);prefix.writeUInt32LE(symbolCount,obj.headerOffset+12);
  if(c.stripAll) prefix.writeUInt16LE(prefix.readUInt16LE(obj.headerOffset+18)|8|4,obj.headerOffset+18);
  return Buffer.concat(chunks);
}
function transformMachO(obj, c) {
  if (c.add?.size || c.update?.size || c.onlyDebug)
    throw new Error("adding/replacing sections and separate debug files currently require ELF");
  const out = Buffer.from(obj.bytes), w = writer(out, obj.le), wide = obj.bits === 64;
  const stripSymbolsAll=!!c.stripAll && obj.type===1;
  const sections=obj.sections.filter(s=>!removed(s,c)),indices=new Map(sections.map((s,i)=>[s.index,i+1]));
  for(const section of obj.sections.filter(s=>!indices.has(s.index))) {
    if(section.data.length) out.fill(0,section.offset,section.offset+section.data.length);
    if(section.relocCount) out.fill(0,section.relocOffset,section.relocOffset+section.relocCount*8);
  }
  const referenced=new Set(obj.relocations.filter(r=>indices.has(r.section)&&r.external).map(r=>r.symbolIndex));
  const kept=obj.symbols.filter(symbol=>{
    if(stripSymbolsAll) return false;
    const drop=(symbol.section && !indices.has(symbol.section)) || ((c.stripAll || c.stripDebug || c.stripUnneeded) && symbol.debug) || c.stripSymbols?.includes(symbol.name) || ((c.stripAll || c.stripUnneeded) && !symbol.global && !referenced.has(symbol.index));
    if(drop && referenced.has(symbol.index)) throw new Error(`symbol '${symbol.name}' is needed by a relocation`);
    return !drop;
  });
  const symbolMap=new Map(kept.map((s,i)=>[s.index,i]));
  // Linkedit tables contain symbol indices too, so preserve all symbols named
  // by a live indirect-symbol entry (stubs and lazy/non-lazy symbol pointers).
  for(const command of obj.commands.filter(cmd=>cmd.cmd===0xb)) {
    const at=obj.le ? out.readUInt32LE(command.offset+56) : out.readUInt32BE(command.offset+56),count=obj.le ? out.readUInt32LE(command.offset+60) : out.readUInt32BE(command.offset+60);
    if(at+count*4>out.length) throw new Error("invalid Mach-O indirect symbol table");
    for(let i=0;i<count;i++) {
      const old=obj.le ? out.readUInt32LE(at+i*4) : out.readUInt32BE(at+i*4);
      if(old&0xc0000000) continue;
      const next=symbolMap.get(old);
      if(next==null && !stripSymbolsAll) throw new Error("cannot remove symbol used by a Mach-O indirect symbol table");
      if(next!=null) w.u32(at+i*4,next);
    }
  }
  const newCommands=[];
  const commandBuffers=new Map();
  for(const command of obj.commands) {
    const data=Buffer.from(out.subarray(command.offset,command.offset+command.size));commandBuffers.set(command.offset,data);newCommands.push(data);
  }
  for (const command of obj.commands.filter(c => c.cmd === 1 || c.cmd === 0x19)) {
    const w64 = command.cmd === 0x19, start = command.offset + (w64 ? 72 : 56), ss = w64 ? 80 : 68;
    const original = obj.sections.filter(
              s => s.headerOffset >= start && s.headerOffset < command.offset + command.size),
          keep = original.filter(s => !removed(s, c));
    const commandData=Buffer.alloc((w64?72:56)+keep.length*ss),cw=writer(commandData,obj.le);
    out.copy(commandData,0,command.offset,start);cw.u32(4,commandData.length);cw.u32(w64?64:48,keep.length);
    for (let i = 0; i < keep.length; i++) {
      const s = keep[i], h = Buffer.from(obj.bytes.subarray(s.headerOffset, s.headerOffset + ss)),
            hw = writer(h, obj.le);
      if (c.rename?.has(s.name)) {
        const name = c.rename.get(s.name);
        if (Buffer.byteLength(name) > 16)
          throw new Error("Mach-O section names must fit in 16 bytes");
        h.fill(0, 0, 16);
        h.write(name, 0);
      }
      if (stripSymbolsAll) {
        if(s.relocCount) out.fill(0,s.relocOffset,s.relocOffset+s.relocCount*8);
        hw.u32(w64 ? 56 : 48, 0);
        hw.u32(w64 ? 60 : 52, 0);
      }
      h.copy(commandData,(w64?72:56)+i*ss);
    }
    newCommands[obj.commands.indexOf(command)]=commandData;commandBuffers.set(command.offset,commandData);
  }
  if(obj.symtab) {
    const table=obj.symtab,entry=wide?16:12,strings=Buffer.alloc(table.stringSize),symbols=[];let stringLength=1;
    for(const symbol of kept) {
      const data=Buffer.from(obj.bytes.subarray(symbol.recordOffset,symbol.recordOffset+entry)),sw=writer(data,obj.le);
      if(symbol.name) {
        const old=obj.le ? data.readUInt32LE(0) : data.readUInt32BE(0),name=Buffer.from(symbol.name+"\0");
        if(old+name.length>strings.length) throw new Error("invalid Mach-O string table entry");
        name.copy(strings,old);stringLength=Math.max(stringLength,old+name.length);
      } else sw.u32(0,0);
      if(symbol.section) data[5]=indices.get(symbol.section)??0;
      symbols.push(data);
    }
    const str=strings.subarray(0,stringLength),syms=Buffer.concat(symbols);
    if(str.length>table.stringSize || syms.length>table.count*entry) throw new Error("cannot grow Mach-O linkedit tables");
    out.fill(0,table.offset,table.offset+table.count*entry);out.fill(0,table.strings,table.strings+table.stringSize);
    syms.copy(out,table.offset);if(!stripSymbolsAll)str.copy(out,table.strings);
    const sw=writer(commandBuffers.get(table.command),obj.le);sw.u32(12,kept.length);sw.u32(20,stripSymbolsAll?0:str.length);
    for(const command of obj.commands.filter(c=>c.cmd===0xb)) {
      const buffer=commandBuffers.get(command.offset),dw=writer(buffer,obj.le);
      if(stripSymbolsAll) buffer.fill(0,8);
      else {
        const local=kept.filter(s=>!s.global),external=kept.filter(s=>s.global&&!s.undefined),undef=kept.filter(s=>s.global&&s.undefined);
        dw.u32(8,0);dw.u32(12,local.length);dw.u32(16,local.length);dw.u32(20,external.length);dw.u32(24,local.length+external.length);dw.u32(28,undef.length);
      }
    }
  }
  if(!stripSymbolsAll) for(const relocation of obj.relocations.filter(r=>indices.has(r.section))) {
    const index=relocation.external?symbolMap.get(relocation.symbolIndex):indices.get(relocation.targetSection);
    if(index==null && relocation.targetSection!==0) throw new Error("removed a required Mach-O relocation target");
    const p=relocation.recordOffset+4,bits=obj.le?out.readUInt32LE(p):out.readUInt32BE(p);w.u32(p,(bits&0xff000000)|(index??0));
  }
  const commands=Buffer.concat(newCommands),head=wide?32:28;
  out.fill(0,head,head+obj.commands.reduce((n,c)=>n+c.size,0));commands.copy(out,head);w.u32(20,commands.length);
  return out;
}
function transformFat(bytes, c) {
  const le = [0xcafebabe, 0xcafebabf].includes(bytes.readUInt32LE()),
        wide = [0xbfbafeca, 0xcafebabf].includes(bytes.readUInt32LE()),
        count = le ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4),
        header = Buffer.from(bytes.subarray(0, 8 + count * (wide ? 32 : 20))),
        w = writer(header, le), u32 = p => le ? bytes.readUInt32LE(p) : bytes.readUInt32BE(p),
        u64 = p => Number(le ? bytes.readBigUInt64LE(p) : bytes.readBigUInt64BE(p)),
        chunks = [header];
  let length = header.length;
  for (let i = 0; i < count; i++) {
    const p = 8 + i * (wide ? 32 : 20), offset = wide ? u64(p + 8) : u32(p + 8),
          size = wide ? u64(p + 16) : u32(p + 12), alignment = 2 ** u32(p + (wide ? 24 : 16)),
          data = transformObject(bytes.subarray(offset, offset + size), c),
          start = align(length, alignment);
    chunks.push(Buffer.alloc(start - length), data);
    if (wide) {
      w.u64(p + 8, start);
      w.u64(p + 16, data.length);
    } else {
      w.u32(p + 8, start);
      w.u32(p + 12, data.length);
    }
    length = start + data.length;
  }
  return Buffer.concat(chunks);
}
export function binaryImage(obj, c = {}) {
  const sections = obj.sections.filter(s => s.alloc && s.data.length && !removed(s, c));
  if (!sections.length) return Buffer.alloc(0);
  const low = sections.reduce((n, s) => s.addr < n ? s.addr : n, sections[0].addr),
        high = sections.reduce(
            (n, s) => s.addr + BigInt(s.data.length) > n ? s.addr + BigInt(s.data.length) : n, low);
  if (high - low > 1024n * 1024n * 1024n)
    throw new Error("binary output address range exceeds 1 GiB");
  const b = Buffer.alloc(Number(high - low), c.gapFill ?? 0);
  for (const s of sections) s.data.copy(b, Number(s.addr - low));
  return b;
}
// Construct ELF relocatables for objcopy -I binary and native linker output.
export function binaryToElf(data, name = "data", target = "elf64-x86-64") {
  const wide = target !== "elf32-i386",
        machine = target.includes("aarch64") ? 183 :
      wide                                   ? 62 :
                                               3,
        header = Buffer.alloc(wide ? 64 : 52), hw = writer(header);
  Buffer.from([127, 69, 76, 70, wide ? 2 : 1, 1, 1]).copy(header);
  hw.u16(16, 1);
  hw.u16(18, machine);
  hw.u32(20, 1);
  hw.u16(wide ? 52 : 40, header.length);
  hw.u16(wide ? 58 : 46, wide ? 64 : 40);
  const names = "\0.data\0.symtab\0.strtab\0.shstrtab\0",
        base = `_binary_${name.replace(/[^a-zA-Z0-9]/g, "_")}`,
        strings = `\0${base}_start\0${base}_end\0${base}_size\0`,
        symbols = Buffer.alloc((wide ? 24 : 16) * 4), sw = writer(symbols), entry = wide ? 24 : 16;
  for (let i = 1; i <= 3; i++) {
    const p = i * entry;
    sw.u32(p, i === 1 ? 1 : i === 2 ? base.length + 8 : 2 * base.length + 13);
    symbols[p + (wide ? 4 : 12)] = 0x10;
    sw.u16(p + (wide ? 6 : 14), i === 3 ? 0xfff1 : 1);
    if (wide)
      sw.u64(p + 8, i === 1 ? 0 : data.length);
    else
      sw.u32(p + 4, i === 1 ? 0 : data.length);
  }
  const sections = [
    {name: "", type: 0, data: Buffer.alloc(0), flags: 0}, {name: ".data", type: 1, data, flags: 3},
    {
      name: ".symtab",
      type: 2,
      data: symbols,
      link: 3,
      info: 1,
      align: wide ? 8 : 4,
      entsize: entry
    },
    {name: ".strtab", type: 3, data: Buffer.from(strings)},
    {name: ".shstrtab", type: 3, data: Buffer.from(names)}
  ];
  let length = header.length;
  const chunks = [header];
  for (const s of sections) {
    s.offset = align(length, s.align || 1);
    chunks.push(Buffer.alloc(s.offset - length), s.data);
    length = s.offset + s.data.length;
  }
  const start = align(length, wide ? 8 : 4), sh = Buffer.alloc(sections.length * (wide ? 64 : 40)),
        w = writer(sh), word = (o, n) => wide ? w.u64(o, n) : w.u32(o, n);
  sections.forEach((s, i) => {
    if (!i) return;
    const p = i * (wide ? 64 : 40);
    w.u32(p, names.indexOf(`${s.name}\0`));
    w.u32(p + 4, s.type);
    word(p + 8, s.flags || 0);
    word(p + (wide ? 24 : 16), s.offset);
    word(p + (wide ? 32 : 20), s.data.length);
    w.u32(p + (wide ? 40 : 24), s.link || 0);
    w.u32(p + (wide ? 44 : 28), s.info || 0);
    word(p + (wide ? 48 : 32), s.align || 1);
    word(p + (wide ? 56 : 36), s.entsize || 0);
  });
  if (wide)
    hw.u64(40, start);
  else
    hw.u32(32, start);
  hw.u16(wide ? 60 : 48, sections.length);
  hw.u16(wide ? 62 : 50, 4);
  chunks.push(Buffer.alloc(start - length), sh);
  return Buffer.concat(chunks);
}
