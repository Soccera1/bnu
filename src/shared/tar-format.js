import { padTo } from "./archive.js";

// POSIX ustar headers and POSIX.1-2001 pax extended records. GNU long-name
// records and base-256 numbers are accepted when reading GNU-created archives.
const stringAt = (buffer, offset, length) => buffer.subarray(offset, offset + length).toString("utf8").split("\0", 1)[0];

function numberAt(buffer, offset, length) {
  const data = buffer.subarray(offset, offset + length);
  if (data[0] & 0x80) {
    let value = BigInt(data[0] & 0x7f);
    for (const byte of data.subarray(1)) value = value * 256n + BigInt(byte);
    if (data[0] & 0x40) value -= 1n << BigInt(length * 8 - 1);
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("archive numeric field is too large");
    return Number(value);
  }
  const text = data.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]*$/.test(text)) throw new Error("invalid octal field in tar header");
  return text ? Number.parseInt(text, 8) : 0;
}

function setNumber(buffer, offset, length, value) {
  const text = Math.floor(value).toString(8);
  if (value < 0 || text.length >= length) throw new Error("value does not fit in ustar header");
  buffer.write(text.padStart(length - 1, "0"), offset, length - 1, "ascii");
}

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return [name, ""];
  for (let slash = name.lastIndexOf("/", name.length - 2); slash > 0; slash = name.lastIndexOf("/", slash - 1)) {
    const prefix = name.slice(0, slash), leaf = name.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(leaf) <= 100) return [leaf, prefix];
  }
  return null;
}

function header(entry) {
  const buffer = Buffer.alloc(512);
  const parts = splitName(entry.name);
  if (!parts) throw new Error(`${entry.name}: file name too long for ustar`);
  if (Buffer.byteLength(entry.linkname ?? "") > 100) throw new Error(`${entry.name}: link name too long for ustar`);
  buffer.write(parts[0], 0, 100);
  setNumber(buffer, 100, 8, entry.mode ?? 0o644);
  setNumber(buffer, 108, 8, entry.uid ?? 0);
  setNumber(buffer, 116, 8, entry.gid ?? 0);
  setNumber(buffer, 124, 12, entry.data?.length ?? 0);
  setNumber(buffer, 136, 12, entry.mtime ?? 0);
  buffer.fill(32, 148, 156);
  buffer.write(entry.type ?? "0", 156, 1);
  buffer.write(entry.linkname ?? "", 157, 100);
  buffer.write("ustar\0", 257, 6);
  buffer.write("00", 263, 2);
  buffer.write(entry.uname ?? "", 265, 32);
  buffer.write(entry.gname ?? "", 297, 32);
  setNumber(buffer, 329, 8, 0);
  setNumber(buffer, 337, 8, 0);
  buffer.write(parts[1], 345, 155);
  const checksum = buffer.reduce((sum, byte) => sum + byte, 0);
  buffer.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return buffer;
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`);
}

export function encodeTar(entries, options = {}) {
  const chunks = [];
  const append = entry => {
    const data = entry.data ?? Buffer.alloc(0);
    chunks.push(header(entry), data, Buffer.alloc(padTo(data.length, 512)));
  };
  for (const [index, source] of entries.entries()) {
    const entry = { ...source }, attrs = {};
    if (!splitName(entry.name)) { attrs.path = entry.name; entry.name = `PaxFile.${index}`; }
    if (Buffer.byteLength(entry.linkname ?? "") > 100) { attrs.linkpath = entry.linkname; entry.linkname = ""; }
    for (const [key, width] of [["uid", 8], ["gid", 8], ["mtime", 12]]) {
      const value = entry[key] ?? 0;
      if (value < 0 || Math.floor(value).toString(8).length >= width || (key === "mtime" && !Number.isInteger(value))) {
        attrs[key] = String(value); entry[key] = 0;
      }
    }
    if (Object.keys(attrs).length) {
      if (options.format === "ustar" || options.format === "v7") throw new Error(`${source.name}: metadata cannot be represented in ${options.format} format`);
      const data = Buffer.concat(Object.entries(attrs).map(([key, value]) => paxRecord(key, value)));
      append({ name: `PaxHeaders/${index}`, type: "x", mode: 0o644, data });
    }
    append(entry);
  }
  chunks.push(Buffer.alloc(1024));
  const data = Buffer.concat(chunks);
  return Buffer.concat([data, Buffer.alloc(padTo(data.length, options.blockSize ?? 10240))]);
}

function readPax(data) {
  const attrs = {};
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(32, offset);
    if (space < 0) throw new Error("invalid pax record");
    const text = data.subarray(offset, space).toString("ascii");
    if (!/^\d+$/.test(text)) throw new Error("invalid pax record length");
    const length = Number(text);
    if (length <= space - offset + 2 || offset + length > data.length || data[offset + length - 1] !== 10) throw new Error("invalid pax record length");
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equal = record.indexOf("=");
    if (equal <= 0) throw new Error("invalid pax record");
    attrs[record.slice(0, equal)] = record.slice(equal + 1);
    offset += length;
  }
  return attrs;
}

export function decodeTar(input) {
  const buffer = Buffer.from(input), entries = [];
  let offset = 0, extended = {}, global = {}, end = 0;
  while (offset + 512 <= buffer.length) {
    const record = buffer.subarray(offset, offset + 512);
    if (record.every(byte => byte === 0)) return { entries, end: offset };
    const checksum = numberAt(record, 148, 8);
    const calculated = record.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    const signed = record.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte > 127 ? byte - 256 : byte), 0);
    if (checksum !== calculated && checksum !== signed) throw new Error("invalid tar header checksum");
    const type = String.fromCharCode(record[156]);
    const attrs = { ...global, ...extended };
    const size = !["x", "g", "L", "K"].includes(type) && attrs.size !== undefined ? Number(attrs.size) : numberAt(record, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > buffer.length) throw new Error("unexpected end of tar archive");
    const data = buffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + size + padTo(size, 512);
    if (offset > buffer.length) throw new Error("unexpected end of tar archive");
    end = offset;
    if (type === "x") { extended = { ...extended, ...readPax(data) }; continue; }
    if (type === "g") { global = { ...global, ...readPax(data) }; continue; }
    if (type === "L" || type === "K") { extended[type === "L" ? "path" : "linkpath"] = data.toString("utf8").replace(/\0.*$/s, ""); continue; }
    if (type === "S" || Object.keys(attrs).some(key => key.startsWith("GNU.sparse"))) throw new Error("GNU sparse archives are not supported");
    const prefix = stringAt(record, 257, 6) === "ustar" ? stringAt(record, 345, 155) : "";
    const entry = { name: attrs.path ?? `${prefix ? `${prefix}/` : ""}${stringAt(record, 0, 100)}`,
      mode: numberAt(record, 100, 8), uid: Number(attrs.uid ?? numberAt(record, 108, 8)),
      gid: Number(attrs.gid ?? numberAt(record, 116, 8)), mtime: Number(attrs.mtime ?? numberAt(record, 136, 12)),
      type: type === "\0" ? "0" : type, linkname: attrs.linkpath ?? stringAt(record, 157, 100),
      uname: attrs.uname ?? stringAt(record, 265, 32), gname: attrs.gname ?? stringAt(record, 297, 32), size, data };
    if (!Number.isFinite(entry.mtime) || !Number.isSafeInteger(entry.uid) || !Number.isSafeInteger(entry.gid)) throw new Error("invalid pax numeric field");
    if (entry.type === "0" && entry.name.endsWith("/")) entry.type = "5";
    entries.push(entry);
    extended = {};
  }
  if (offset !== buffer.length || !entries.length) throw new Error("unexpected end of tar archive");
  return { entries, end };
}
