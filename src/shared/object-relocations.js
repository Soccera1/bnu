// Relocation formulas: ELF gABI/AAELF64, Microsoft PE/COFF, and Apple's
// mach-o/{x86_64,arm64}/reloc.h. Unsupported relocation types fail explicitly.
export function needsGot(object, relocation) {
  if (object.format === "elf") return object.arch === "x86-64" ? [9, 25, 26, 27, 28, 29, 41, 42].includes(relocation.type) : [311, 312].includes(relocation.type);
  if (object.format === "macho") return object.arch === "x86-64" ? [3, 4].includes(relocation.type) : [5, 6, 7].includes(relocation.type);
  return false;
}

const sign = (value, bits) => BigInt.asIntN(bits, BigInt(value));
const page = address => address & ~4095n;

function checkedWrite(buffer, offset, size, value, signed = false) {
  if (offset < 0 || offset + size > buffer.length) throw new Error("relocation extends past the target section");
  const bits = BigInt(size * 8), minimum = signed ? -(1n << (bits - 1n)) : 0n, maximum = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  if (value < minimum || value > maximum) throw new Error(`relocation overflow: ${value} does not fit in ${size * 8} ${signed ? "signed" : "unsigned"} bits`);
  if (size === 8) buffer.writeBigUInt64LE(BigInt.asUintN(64, value), offset);
  else if (size === 4) buffer.writeUInt32LE(Number(BigInt.asUintN(32, value)), offset);
  else if (size === 2) buffer.writeUInt16LE(Number(BigInt.asUintN(16, value)), offset);
  else if (size === 1) buffer[offset] = Number(BigInt.asUintN(8, value));
  else throw new Error(`unsupported relocation width ${size}`);
}

function readValue(buffer, offset, size, signed = true) {
  if (offset < 0 || offset + size > buffer.length) throw new Error("relocation extends past the target section");
  const value = size === 8 ? buffer.readBigUInt64LE(offset) : BigInt(size === 4 ? buffer.readUInt32LE(offset) : size === 2 ? buffer.readUInt16LE(offset) : buffer[offset]);
  return signed ? sign(value, size * 8) : value;
}

function armImmediate(buffer, offset, value, bits, shift, fieldAt) {
  if (value % (1n << BigInt(shift))) throw new Error("unaligned AArch64 relocation");
  const scaled = value >> BigInt(shift);
  if (scaled < -(1n << BigInt(bits - 1)) || scaled >= 1n << BigInt(bits - 1)) throw new Error("AArch64 branch/address relocation is out of range");
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(fieldAt), word = readValue(buffer, offset, 4, false);
  checkedWrite(buffer, offset, 4, (word & ~mask) | ((scaled & ((1n << BigInt(bits)) - 1n)) << BigInt(fieldAt)));
}

function armAdr(buffer, offset, value, pageRelative) {
  const amount = pageRelative ? value >> 12n : value;
  if (amount < -(1n << 20n) || amount >= 1n << 20n) throw new Error("AArch64 ADR/ADRP relocation is out of range");
  const encoded = BigInt.asUintN(21, amount), word = readValue(buffer, offset, 4, false);
  checkedWrite(buffer, offset, 4, (word & ~0x60ffffe0n) | ((encoded & 3n) << 29n) | ((encoded >> 2n) << 5n));
}

function armLow12(buffer, offset, address, scale = 0) {
  const value = address & 4095n;
  if (value % (1n << BigInt(scale))) throw new Error("unaligned AArch64 page-offset relocation");
  const word = readValue(buffer, offset, 4, false);
  checkedWrite(buffer, offset, 4, (word & ~0x3ffc00n) | ((value >> BigInt(scale)) << 10n));
}

function loadScale(word) {
  return (word & 0x04800000) === 0x04800000 ? 4 : word >>> 30;
}

function elfRelocation(state, object, section, relocation) {
  const b = section.data, at = Number(relocation.offset), p = section.addr + relocation.offset, type = relocation.type;
  if (type === 0) return;
  const s = state.symbolAddress(object, relocation.symbol);
  const g = relocation.gotKey !== undefined ? state.gotSection.addr + BigInt(state.got.get(relocation.gotKey).offset) : 0n;
  const a = relocation.addend ?? readValue(b, at, [1, 24, 25, 27, 28, 29].includes(type) && object.arch === "x86-64" ? 8 : 4);
  if (object.arch === "x86-64") {
    if (type === 1) return checkedWrite(b, at, 8, s + a);
    if ([2, 4].includes(type)) return checkedWrite(b, at, 4, s + a - p, true);
    if ([9, 41, 42].includes(type)) return checkedWrite(b, at, 4, g + a - p, true);
    if (type === 10) return checkedWrite(b, at, 4, s + a);
    if (type === 11) return checkedWrite(b, at, 4, s + a, true);
    if ([12, 14].includes(type)) return checkedWrite(b, at, type === 12 ? 2 : 1, s + a);
    if ([13, 15].includes(type)) return checkedWrite(b, at, type === 13 ? 2 : 1, s + a - p, true);
    if (type === 24) return checkedWrite(b, at, 8, s + a - p, true);
    if (type === 28) return checkedWrite(b, at, 8, g + a - p, true);
    if (type === 27) return checkedWrite(b, at, 8, g + a - state.gotSection.addr);
    if (type === 25 && state.gotSection) return checkedWrite(b, at, 8, s + a - state.gotSection.addr, true);
    if (type === 26 && state.gotSection) return checkedWrite(b, at, 4, state.gotSection.addr + a - p, true);
    if (type === 29 && state.gotSection) return checkedWrite(b, at, 8, state.gotSection.addr + a - p, true);
  } else {
    if ([257, 258, 259].includes(type)) return checkedWrite(b, at, 2 ** (260 - type), s + a);
    if ([260, 261, 262].includes(type)) return checkedWrite(b, at, 2 ** (263 - type), s + a - p, true);
    if ([282, 283].includes(type)) return armImmediate(b, at, s + a - p, 26, 2, 0);
    if ([273, 280].includes(type)) return armImmediate(b, at, s + a - p, 19, 2, 5);
    if (type === 279) return armImmediate(b, at, s + a - p, 14, 2, 5);
    if (type === 274) return armAdr(b, at, s + a - p, false);
    if ([275, 276].includes(type)) return armAdr(b, at, page(s + a) - page(p), true);
    if (type === 311) return armAdr(b, at, page(g + a) - page(p), true);
    if ([277, 278, 284, 285, 286, 299, 312].includes(type)) return armLow12(b, at, (type === 312 ? g : s) + a, ({ 277: 0, 278: 0, 284: 1, 285: 2, 286: 3, 299: 4, 312: 3 })[type]);
    if (type >= 263 && type <= 269) {
      const shift = Math.floor((type - 263) / 2) * 16, value = s + a, word = readValue(b, at, 4, false);
      if ([263, 265, 267].includes(type) && (value < 0n || value >= 1n << BigInt(shift + 16))) throw new Error("AArch64 MOVW relocation is out of range");
      return checkedWrite(b, at, 4, (word & ~0x1fffe0n) | (((value >> BigInt(shift)) & 65535n) << 5n));
    }
  }
  throw new Error(`unsupported ${object.arch} ELF relocation ${type}`);
}

function targetSection(state, object, relocation) {
  let symbol = relocation.symbol;
  if (symbol?.global && state.definitions.has(symbol.name)) ({ object, symbol } = state.definitions.get(symbol.name));
  return symbol?.common ? state.common.get(symbol) : state.sectionMap.get(object).get(symbol?.section ?? relocation.targetSection);
}

function coffRelocation(state, object, section, relocation) {
  const b = section.data, at = Number(relocation.offset), p = section.addr + relocation.offset, type = relocation.type;
  if (type === 0) return;
  const s = state.symbolAddress(object, relocation.symbol), target = targetSection(state, object, relocation);
  const a = size => readValue(b, at, size);
  if (object.arch === "x86-64") {
    if (type === 1) return checkedWrite(b, at, 8, s + a(8));
    if (type === 2) return checkedWrite(b, at, 4, s + a(4));
    if (type === 3) return checkedWrite(b, at, 4, s + a(4) - state.imageBase);
    if (type >= 4 && type <= 9) return checkedWrite(b, at, 4, s + a(4) - p - BigInt(type), true);
    if (type === 10 && target) return checkedWrite(b, at, 2, BigInt(target.index) + a(2));
    if (type === 11 && target) return checkedWrite(b, at, 4, s + a(4) - (target.outputGroup?.addr ?? target.addr));
  } else {
    if (type === 1) return checkedWrite(b, at, 4, s + a(4));
    if (type === 2) return checkedWrite(b, at, 4, s + a(4) - state.imageBase);
    if (type === 14) return checkedWrite(b, at, 8, s + a(8));
    if (type === 17) return checkedWrite(b, at, 4, s + a(4) - p - 4n, true);
    if (type === 13 && target) return checkedWrite(b, at, 2, BigInt(target.index) + a(2));
    if (type === 8 && target) return checkedWrite(b, at, 4, s + a(4) - (target.outputGroup?.addr ?? target.addr));
    const word = Number(readValue(b, at, 4, false));
    if (type === 3) return armImmediate(b, at, s + (sign(word & 0x03ffffff, 26) << 2n) - p, 26, 2, 0);
    if (type === 15 || type === 16) {
      const bits = type === 15 ? 19 : 14, mask = (1 << bits) - 1;
      return armImmediate(b, at, s + (sign((word >>> 5) & mask, bits) << 2n) - p, bits, 2, 5);
    }
    if (type === 4 || type === 5) {
      const extra = sign(((word >>> 29) & 3) | (((word >>> 5) & 0x7ffff) << 2), 21);
      return armAdr(b, at, type === 4 ? page(s + (extra << 12n)) - page(p) : s + extra - p, type === 4);
    }
    if (type === 6 || type === 7) {
      const scale = type === 7 ? loadScale(word) : (word & (1 << 22)) ? 12 : 0;
      return armLow12(b, at, s + (BigInt((word >>> 10) & 0xfff) << BigInt(scale)), scale);
    }
    if ([9, 10, 11].includes(type) && target) {
      const value = s - (target.outputGroup?.addr ?? target.addr), scale = type === 11 ? loadScale(word) : 0;
      return armLow12(b, at, type === 10 ? value >> 12n : value, scale);
    }
  }
  throw new Error(`unsupported ${object.arch} COFF relocation ${type}`);
}

function machoTarget(state, object, relocation) {
  if (relocation.external) return state.symbolAddress(object, relocation.symbol);
  const section = state.sectionMap.get(object).get(relocation.targetSection);
  if (!section) throw new Error("Mach-O relocation references an unsupported section");
  return section.addr - section.source.addr;
}

function machoRelocation(state, object, section, relocation, following, explicitAddend = 0n) {
  const b = section.data, at = Number(relocation.offset), p = section.addr + relocation.offset, type = relocation.type;
  const s = needsGot(object, relocation) ? state.gotSection.addr + BigInt(state.got.get(relocation.gotKey).offset) : machoTarget(state, object, relocation);
  const a = readValue(b, at, relocation.length) + explicitAddend;
  const subtractor = object.arch === "x86-64" ? 5 : 1;
  if (type === subtractor) {
    if (!following || following.type !== 0 || following.offset !== relocation.offset || following.length !== relocation.length) throw new Error("invalid Mach-O subtractor relocation pair");
    checkedWrite(b, at, relocation.length, machoTarget(state, object, following) - s + a, true);
    return 1;
  }
  if (type === 0) { checkedWrite(b, at, relocation.length, s + a); return 0; }
  if (object.arch === "x86-64") {
    if ([1, 2, 3, 4, 6, 7, 8].includes(type)) {
      const extra = ({ 6: 1, 7: 2, 8: 4 })[type] ?? 0;
      const delta = relocation.external ? p + 4n + BigInt(extra) : section.addr - section.source.addr;
      checkedWrite(b, at, 4, s + a - delta, true); return 0;
    }
  } else {
    const word = Number(readValue(b, at, 4, false));
    if (type === 2) { armImmediate(b, at, s + (sign(word & 0x03ffffff, 26) << 2n) + explicitAddend - p, 26, 2, 0); return 0; }
    if (type === 3 || type === 5) {
      const extra = sign(((word >>> 29) & 3) | (((word >>> 5) & 0x7ffff) << 2), 21) << 12n;
      armAdr(b, at, page(s + extra + explicitAddend) - page(p), true); return 0;
    }
    if (type === 4 || type === 6) {
      const scale = (word & 0x3b000000) === 0x39000000 ? loadScale(word) : 0;
      armLow12(b, at, s + (BigInt((word >>> 10) & 0xfff) << BigInt(scale)) + explicitAddend, scale); return 0;
    }
    if (type === 7) { checkedWrite(b, at, relocation.length, s + a - p, true); return 0; }
  }
  throw new Error(`unsupported ${object.arch} Mach-O relocation ${type}`);
}

export function applyRelocations(state, object) {
  for (let index = 0; index < object.relocations.length; index++) {
    let relocation = object.relocations[index];
    const section = state.sectionMap.get(object).get(relocation.section);
    if (!section) continue;
    if (section.bss) throw new Error(`${object.name}: relocation into an uninitialized section`);
    try {
      if (object.format === "elf") elfRelocation(state, object, section, relocation);
      else if (object.format === "coff") coffRelocation(state, object, section, relocation);
      else {
        let addend = 0n;
        if (object.arch === "aarch64" && relocation.type === 10) {
          addend = sign(relocation.symbolIndex, 24);
          const next = object.relocations[++index];
          if (!next || next.offset !== relocation.offset || next.section !== relocation.section || ![3, 4, 5, 6].includes(next.type)) throw new Error("invalid AArch64 Mach-O addend relocation pair");
          relocation = next;
        }
        index += machoRelocation(state, object, section, relocation, object.relocations[index + 1], addend) ?? 0;
      }
    } catch (error) { throw new Error(`${object.name}: ${section.name}+0x${relocation.offset.toString(16)}: ${error.message}`); }
  }
}
