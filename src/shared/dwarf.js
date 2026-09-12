// DWARF 2--5 line-number programs and compilation-unit attributes. Encoding
// references: dwarfstd.org/doc/DWARF5.pdf sections 6.2, 7.5 and 7.22.
import { inflateSync } from "node:zlib";
import { isAbsolute, join, normalize } from "node:path";
import { BinaryReader, cstring } from "./object-files.js";

class Cursor extends BinaryReader {
  constructor(bytes,le = true,offset = 0,end = bytes.length) { super(bytes,le); this.p = offset; this.end = end; }
  bytes(size) { if (this.p + size > this.end) throw new Error("truncated DWARF data"); const data = this.range(this.p,size); this.p += size; return data; }
  uint(size) { const data = this.bytes(size); let value = 0n; if (this.le) for (let i = size-1; i >= 0; i--) value = value*256n+BigInt(data[i]); else for (const byte of data) value = value*256n+BigInt(byte); return value; }
  num(size) { const n = this.uint(size); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("DWARF offset exceeds supported range"); return Number(n); }
  byte() { return this.num(1); }
  uleb() { let result = 0n, shift = 0n; for (let i = 0; i < 10; i++) { const byte = this.byte(); result |= BigInt(byte & 127) << shift; if (!(byte & 128)) return Number(result); shift += 7n; } throw new Error("invalid DWARF LEB128 number"); }
  sleb() { let result = 0n, shift = 0n; for (let i = 0; i < 10; i++) { const byte = this.byte(); result |= BigInt(byte & 127) << shift; shift += 7n; if (!(byte & 128)) return Number(byte & 64 ? result-(1n<<shift) : result); } throw new Error("invalid DWARF LEB128 number"); }
  string() { const end = this.b.indexOf(0,this.p); if (end < 0 || end >= this.end) throw new Error("unterminated DWARF string"); const text = this.b.toString("utf8",this.p,end); this.p = end+1; return text; }
  unit() { const start = this.p, initial = this.num(4), offsetSize = initial === 0xffffffff ? 8 : 4, length = offsetSize === 8 ? this.num(8) : initial; if (initial >= 0xfffffff0 && initial !== 0xffffffff || this.p+length > this.end) throw new Error("invalid DWARF unit length"); return {start,offsetSize,end:this.p+length}; }
}

function relocatedSections(obj) {
  const sections = new Map(), byIndex = new Map();
  for (const section of obj.sections) {
    let name = section.name.replace(/^__debug_/,".debug_").replace(/^\.zdebug_/,".debug_"), data = Buffer.from(section.data);
    if (name === ".debug_str_offs") name = ".debug_str_offsets";
    if (!name.startsWith(".debug_")) continue;
    if (section.name.startsWith(".zdebug_")) {
      if (data.subarray(0,4).toString() !== "ZLIB") throw new Error("invalid compressed DWARF section"); data = inflateSync(data.subarray(12));
    } else if (obj.format === "elf" && (section.flags&0x800n)) {
      const header = new BinaryReader(data,obj.le), type = header.u32(0);
      if (type !== 1) throw new Error(`unsupported DWARF compression type ${type}`);
      data = inflateSync(data.subarray(obj.bits === 64 ? 24 : 12));
    }
    const value = {data,section,origins:new Map()}; sections.set(name,value); byIndex.set(section.index,value);
  }
  for (const relocation of obj.relocations) {
    const target = byIndex.get(relocation.section); if (!target) continue;
    const symbol = relocation.symbol, symbolSection = obj.sections.find((s) => s.index === (symbol?.section ?? relocation.targetSection));
    const offset = Number(relocation.offset); let size = 0, relative = false, add = false, subtract = false;
    if (obj.format === "elf") {
      const types = obj.machine === 62 ? {1:8,10:4,11:4} : obj.machine === 3 ? {1:4} : obj.machine === 183 ? {257:8,258:4,259:2} : obj.machine === 40 ? {2:4} : obj.machine === 243 ? {1:4,2:8,35:4,36:8,39:4,40:8} : {};
      size = types[relocation.type] ?? 0;
      if (obj.machine === 243) { add = [35,36].includes(relocation.type); subtract = [39,40].includes(relocation.type); }
    } else if (obj.format === "macho") { if (relocation.type === 0 && !relocation.pcRelative) size = relocation.length; }
    else if (obj.arch === "x86-64") size = ({1:8,2:4,3:4,11:4})[relocation.type] ?? 0;
    else if (obj.arch === "i386") size = ({6:4,7:4,11:4})[relocation.type] ?? 0;
    else if (obj.arch === "aarch64") size = ({1:4,2:4,8:4,14:8})[relocation.type] ?? 0;
    if (!size) continue;
    const reader = new Cursor(target.data,obj.le,offset), stored = reader.uint(size);
    let symbolValue = symbol?.value ?? 0n;
    if (obj.format !== "macho") symbolValue += symbolSection?.addr ?? 0n;
    const value = subtract ? stored-symbolValue : add ? stored+symbolValue : symbolValue+(relocation.addend ?? stored);
    let encoded = BigInt.asUintN(size*8,value);
    for (let i = 0; i < size; i++) { target.data[offset+(obj.le ? i : size-1-i)] = Number(encoded&255n); encoded >>= 8n; }
    if (symbolSection?.executable) target.origins.set(offset,symbolSection.index);
  }
  return sections;
}

export class DwarfInfo {
  constructor(obj) {
    this.obj = obj; this.sections = relocatedSections(obj); this.abbreviations = new Map(); this.units = []; this.dies = new Map(); this.rows = []; this.tables = new Map(); this.functions = [];
    this.readInfo(); this.readLines(); this.readFunctions();
  }
  section(name) { return this.sections.get(name) ?? {data:Buffer.alloc(0),origins:new Map()}; }
  string(name,offset) { const section = this.section(name).data; if (offset < 0 || offset >= section.length) return ""; return cstring(section,Number(offset)); }
  abbreviationsAt(offset) {
    if (this.abbreviations.has(offset)) return this.abbreviations.get(offset);
    const cursor = new Cursor(this.section(".debug_abbrev").data,this.obj.le,offset), result = new Map();
    while (cursor.p < cursor.end) {
      const code = cursor.uleb(); if (!code) break;
      const tag = cursor.uleb(), children = cursor.byte(), attributes = [];
      while (true) { const name = cursor.uleb(), form = cursor.uleb(); if (!name && !form) break; attributes.push({name,form,constant:form === 0x21 ? cursor.sleb() : null}); }
      result.set(code,{tag,children,attributes});
    }
    this.abbreviations.set(offset,result); return result;
  }
  form(cursor,form,unit,constant = null,section = ".debug_info") {
    const address = () => { const offset = cursor.p, value = cursor.uint(unit.addressSize); return {kind:"address",value,section:this.section(section).origins.get(offset)}; };
    switch (form) {
      case 0x01: return address();
      case 0x03: return cursor.bytes(cursor.num(2)); case 0x04: return cursor.bytes(cursor.num(4));
      case 0x05: return cursor.num(2); case 0x06: return cursor.num(4); case 0x07: return cursor.uint(8);
      case 0x08: return cursor.string(); case 0x09: return cursor.bytes(cursor.uleb()); case 0x0a: return cursor.bytes(cursor.byte());
      case 0x0b: case 0x0c: return cursor.byte(); case 0x0d: return cursor.sleb();
      case 0x0e: return this.string(".debug_str",cursor.num(unit.offsetSize)); case 0x0f: return cursor.uleb();
      case 0x10: return {ref:cursor.num(unit.version === 2 ? unit.addressSize : unit.offsetSize)};
      case 0x11: return {ref:unit.start+cursor.num(1)}; case 0x12: return {ref:unit.start+cursor.num(2)}; case 0x13: return {ref:unit.start+cursor.num(4)}; case 0x14: return {ref:unit.start+cursor.num(8)}; case 0x15: return {ref:unit.start+cursor.uleb()};
      case 0x16: return this.form(cursor,cursor.uleb(),unit,null,section);
      case 0x17: return cursor.num(unit.offsetSize); case 0x18: return cursor.bytes(cursor.uleb()); case 0x19: return 1;
      case 0x1a: case 0x1f02: return {kind:"strx",value:cursor.uleb()};
      case 0x1b: case 0x1f01: return {kind:"addrx",value:cursor.uleb()};
      case 0x1c: return cursor.num(4); case 0x1d: return cursor.num(unit.offsetSize); case 0x1e: return cursor.bytes(16);
      case 0x1f: return this.string(".debug_line_str",cursor.num(unit.offsetSize)); case 0x20: return cursor.uint(8);
      case 0x21: return constant; case 0x22: return cursor.uleb(); case 0x23: return {kind:"rnglistx",value:cursor.uleb()}; case 0x24: return cursor.uint(8);
      case 0x25: case 0x26: case 0x27: case 0x28: return {kind:"strx",value:cursor.num(form-0x24)};
      case 0x29: case 0x2a: case 0x2b: case 0x2c: return {kind:"addrx",value:cursor.num(form-0x28)};
      default: throw new Error(`unsupported DWARF attribute form 0x${form.toString(16)}`);
    }
  }
  resolve(value,unit) {
    if (value?.kind === "strx") {
      const base = Number(unit.root.attrs.get(0x72) ?? 0), cursor = new Cursor(this.section(".debug_str_offsets").data,this.obj.le,base+value.value*unit.offsetSize);
      return this.string(".debug_str",cursor.num(unit.offsetSize));
    }
    if (value?.kind === "addrx") {
      const offset = Number(unit.root.attrs.get(0x73) ?? 0)+value.value*unit.addressSize, cursor = new Cursor(this.section(".debug_addr").data,this.obj.le,offset);
      return {kind:"address",value:cursor.uint(unit.addressSize),section:this.section(".debug_addr").origins.get(offset)};
    }
    return value;
  }
  attr(die,name,seen = new Set()) {
    if (!die || seen.has(die.offset)) return undefined;
    seen.add(die.offset);
    if (die.attrs.has(name)) return this.resolve(die.attrs.get(name),die.unit);
    const origin = die.attrs.get(0x31)?.ref ?? die.attrs.get(0x47)?.ref;
    return origin == null ? undefined : this.attr(this.dies.get(origin),name,seen);
  }
  readInfo() {
    const cursor = new Cursor(this.section(".debug_info").data,this.obj.le);
    while (cursor.p < cursor.end) {
      const unit = cursor.unit(); if (cursor.p === unit.end) continue;
      unit.version = cursor.num(2); if (unit.version < 2 || unit.version > 5) throw new Error(`unsupported DWARF version ${unit.version}`);
      if (unit.version >= 5) { unit.type = cursor.byte(); unit.addressSize = cursor.byte(); unit.abbrev = cursor.num(unit.offsetSize); if ([2,6].includes(unit.type)) { cursor.bytes(8); cursor.bytes(unit.offsetSize); } else if ([4,5].includes(unit.type)) cursor.bytes(8); }
      else { unit.abbrev = cursor.num(unit.offsetSize); unit.addressSize = cursor.byte(); }
      if (![1,2,4,8].includes(unit.addressSize)) throw new Error("invalid DWARF address size");
      const abbreviations = this.abbreviationsAt(unit.abbrev), parents = [];
      while (cursor.p < unit.end) {
        const offset = cursor.p, code = cursor.uleb(); if (!code) { parents.pop(); continue; }
        const abbreviation = abbreviations.get(code); if (!abbreviation) throw new Error(`invalid DWARF abbreviation ${code}`);
        const die = {offset,tag:abbreviation.tag,attrs:new Map(),unit,parent:parents.at(-1)};
        for (const spec of abbreviation.attributes) die.attrs.set(spec.name,this.form(cursor,spec.form,unit,spec.constant));
        this.dies.set(offset,die); unit.root ??= die; if (abbreviation.children) parents.push(die);
      }
      this.units.push(unit); cursor.p = unit.end;
    }
  }
  readLines() {
    const section = this.section(".debug_line"), cursor = new Cursor(section.data,this.obj.le);
    while (cursor.p < cursor.end) {
      const unit = cursor.unit(); if (cursor.p === unit.end) continue;
      unit.version = cursor.num(2); if (unit.version < 2 || unit.version > 5) throw new Error(`unsupported DWARF line version ${unit.version}`);
      const compilation = this.units.find((cu) => Number(this.attr(cu.root,0x10)) === unit.start);
      unit.addressSize = unit.version >= 5 ? cursor.byte() : compilation?.addressSize ?? this.obj.bits/8;
      const segmentSize = unit.version >= 5 ? cursor.byte() : 0, headerLength = cursor.num(unit.offsetSize), programStart = cursor.p+headerLength;
      if (programStart > unit.end) throw new Error("invalid DWARF line header length");
      const minInstruction = cursor.byte(), maxOperations = unit.version >= 4 ? cursor.byte() : 1, defaultStatement = cursor.byte(), lineBaseByte = cursor.byte(), lineBase = lineBaseByte > 127 ? lineBaseByte-256 : lineBaseByte, lineRange = cursor.byte(), opcodeBase = cursor.byte();
      if (!maxOperations || !lineRange || !opcodeBase) throw new Error("invalid DWARF line state parameters");
      const lengths = Array.from({length:opcodeBase-1},() => cursor.byte()), directories = [], files = [];
      const compDir = compilation ? this.attr(compilation.root,0x1b) ?? "" : "";
      if (unit.version >= 5) {
        const entries = (target) => {
          const formats = Array.from({length:cursor.byte()},() => ({content:cursor.uleb(),form:cursor.uleb()})), count = cursor.uleb();
          if (count > section.data.length) throw new Error("invalid DWARF line table count");
          for (let i = 0; i < count; i++) { const entry = {}; for (const format of formats) entry[format.content] = this.form(cursor,format.form,unit,null,".debug_line"); target.push(entry); }
        };
        entries(directories); entries(files);
      } else {
        directories.push({1:compDir}); files.push(null);
        while (cursor.p < programStart) { const name = cursor.string(); if (!name) break; directories.push({1:name}); }
        while (cursor.p < programStart) { const name = cursor.string(); if (!name) break; files.push({1:name,2:cursor.uleb(),3:cursor.uleb(),4:cursor.uleb()}); }
      }
      const table = {offset:unit.start,files,directories,compDir,version:unit.version}; this.tables.set(unit.start,table);
      const filePath = (index) => {
        const file = files[index]; if (!file) return "??";
        const name = String(file[1] ?? "??"), directory = String(directories[Number(file[2] ?? 0)]?.[1] ?? compDir);
        return normalize(isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name) ? name : isAbsolute(directory) ? join(directory,name) : join(String(compDir),directory,name));
      };
      table.filePath = filePath;
      let state; const reset = () => { state = {address:0n,opIndex:0,file:1,line:1,column:0,statement:!!defaultStatement,discriminator:0,section:undefined}; };
      reset(); cursor.p = programStart; let previous = null;
      const advance = (operations) => { state.address += BigInt(minInstruction*Math.floor((state.opIndex+operations)/maxOperations)); state.opIndex = (state.opIndex+operations)%maxOperations; };
      const emit = (end = false) => {
        if (previous) { previous.end = state.address; if (previous.end > previous.address) this.rows.push(previous); }
        previous = end ? null : {...state,path:filePath(state.file),table,end:state.address};
        state.discriminator = 0;
      };
      while (cursor.p < unit.end) {
        const opcode = cursor.byte();
        if (!opcode) {
          const length = cursor.uleb(), end = cursor.p+length; if (!length || end > unit.end) throw new Error("invalid DWARF extended line opcode");
          const extended = cursor.byte();
          if (extended === 1) { emit(true); reset(); }
          else if (extended === 2) { cursor.bytes(segmentSize); const offset = cursor.p; state.address = cursor.uint(unit.addressSize); state.opIndex = 0; state.section = section.origins.get(offset); }
          else if (extended === 3 && unit.version < 5) files.push({1:cursor.string(),2:cursor.uleb(),3:cursor.uleb(),4:cursor.uleb()});
          else if (extended === 4) state.discriminator = cursor.uleb();
          cursor.p = end;
        } else if (opcode >= opcodeBase) { const adjusted = opcode-opcodeBase; advance(Math.floor(adjusted/lineRange)); state.line += lineBase+adjusted%lineRange; emit(); }
        else switch (opcode) {
          case 1: emit(); break; case 2: advance(cursor.uleb()); break; case 3: state.line += cursor.sleb(); break; case 4: state.file = cursor.uleb(); break; case 5: state.column = cursor.uleb(); break;
          case 6: state.statement = !state.statement; break; case 7: break; case 8: advance(Math.floor((255-opcodeBase)/lineRange)); break; case 9: state.address += cursor.uint(2); state.opIndex = 0; break;
          case 10: case 11: break; case 12: cursor.uleb(); break;
          default: for (let i = 0; i < lengths[opcode-1]; i++) cursor.uleb();
        }
      }
      cursor.p = unit.end;
    }
    this.rows.sort((a,b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  }
  ranges(die) {
    const low = this.attr(die,0x11), high = this.attr(die,0x12), ranges = this.attr(die,0x55), unit = die.unit;
    if (low?.kind === "address" && high != null) return [{start:low.value,end:high?.kind === "address" ? high.value : low.value+BigInt(high),section:low.section}];
    if (ranges == null) return [];
    const rootLow = this.attr(unit.root,0x11); let base = rootLow?.value ?? 0n, section = rootLow?.section; const result = [];
    if (unit.version < 5) {
      const cursor = new Cursor(this.section(".debug_ranges").data,this.obj.le,Number(ranges)), maximum = (1n<<BigInt(unit.addressSize*8))-1n;
      while (cursor.p < cursor.end) { const at = cursor.p, start = cursor.uint(unit.addressSize), end = cursor.uint(unit.addressSize); if (!start && !end) break; if (start === maximum) { base = end; section = this.section(".debug_ranges").origins.get(at+unit.addressSize); } else result.push({start:base+start,end:base+end,section:this.section(".debug_ranges").origins.get(at) ?? section}); }
    } else {
      let offset = Number(ranges);
      if (ranges.kind === "rnglistx") { const baseOffset = Number(this.attr(unit.root,0x74) ?? 0), cursor = new Cursor(this.section(".debug_rnglists").data,this.obj.le,baseOffset+ranges.value*unit.offsetSize); offset = baseOffset+cursor.num(unit.offsetSize); }
      const cursor = new Cursor(this.section(".debug_rnglists").data,this.obj.le,offset), addr = () => { const at = cursor.p, value = cursor.uint(unit.addressSize); return {value,section:this.section(".debug_rnglists").origins.get(at)}; }, indexed = () => this.resolve({kind:"addrx",value:cursor.uleb()},unit);
      while (cursor.p < cursor.end) {
        const op = cursor.byte(); if (!op) break;
        if (op === 1) { const address = indexed(); base = address.value; section = address.section; }
        else if (op === 2) { const start = indexed(), end = indexed(); result.push({start:start.value,end:end.value,section:start.section}); }
        else if (op === 3) { const start = indexed(); result.push({start:start.value,end:start.value+BigInt(cursor.uleb()),section:start.section}); }
        else if (op === 4) result.push({start:base+BigInt(cursor.uleb()),end:base+BigInt(cursor.uleb()),section});
        else if (op === 5) { const address = addr(); base = address.value; section = address.section; }
        else if (op === 6) { const start = addr(), end = addr(); result.push({start:start.value,end:end.value,section:start.section}); }
        else if (op === 7) { const start = addr(); result.push({start:start.value,end:start.value+BigInt(cursor.uleb()),section:start.section}); }
        else throw new Error(`unsupported DWARF range entry ${op}`);
      }
    }
    return result;
  }
  readFunctions() {
    for (const die of this.dies.values()) if ([0x2e,0x1d].includes(die.tag)) {
      const name = this.attr(die,0x6e) ?? this.attr(die,0x2007) ?? this.attr(die,0x03);
      if (name) for (const range of this.ranges(die)) this.functions.push({...range,name,die});
    }
  }
  lookup(address,section) {
    const matches = (entry) => entry.start <= address && address < entry.end && (section == null || entry.section == null || entry.section === section);
    const row = this.rows.find((entry) => entry.address <= address && address < entry.end && (section == null || entry.section == null || entry.section === section));
    const functions = this.functions.filter(matches).sort((a,b) => { const aSize = a.end-a.start, bSize = b.end-b.start; return aSize < bSize ? -1 : aSize > bSize ? 1 : a.die.offset-b.die.offset; });
    let name = functions[0]?.name;
    if (!name) {
      const symbols = this.obj.symbols.filter((symbol) => !symbol.undefined && !symbol.debug && symbol.name && (section == null || symbol.section === section) && this.obj.sections.find((s) => s.index === symbol.section)?.executable && (this.obj.format !== "elf" || symbol.type === 2));
      const candidates = symbols.map((symbol) => { const section = this.obj.sections.find((s) => s.index === symbol.section); return {symbol,section,start:symbol.value+(["coff","pe"].includes(this.obj.format) ? section?.addr ?? 0n : 0n)}; }).filter(({symbol,section,start}) => start <= address && address < section.addr+BigInt(section.size) && (!symbol.size || address < start+BigInt(symbol.size))).sort((a,b) => a.start > b.start ? -1 : a.start < b.start ? 1 : 0);
      name = candidates[0]?.symbol.name;
    }
    return {path:row?.path ?? "??",line:row?.line ?? 0,column:row?.column ?? 0,discriminator:row?.discriminator ?? 0,name:name ?? "??",functions,row};
  }
}
