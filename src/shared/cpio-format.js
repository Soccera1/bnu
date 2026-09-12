import { padTo } from "./archive.js";
import { decodeTar, encodeTar } from "./tar-format.js";

const uint = (value, digits, base) => {
  const text = Math.floor(value).toString(base);
  if (value < 0 || text.length > digits) throw new Error("value does not fit in cpio header");
  return text.padStart(digits, "0");
};
const checksum = data => data.reduce((sum, byte) => (sum + byte) >>> 0, 0);

export function encodeCpio(entries, format = "bin", blockSize = 512) {
  if (format === "tar" || format === "ustar") return encodeTar(entries.map(entry => ({ ...entry, mtime: Math.floor(entry.mtime) })), { format: "ustar", blockSize });
  if (!["newc", "crc", "odc", "bin"].includes(format)) throw new Error(`unsupported cpio format '${format}'`);
  const chunks = [], inodes = new Map(), lastLinks = new Map();
  for (const [index, entry] of entries.entries()) if (entry.type === "0" && entry.nlink > 1) lastLinks.set(`${entry.dev}:${entry.ino}`, index);
  for (const [index, entry] of [...entries, { name: "TRAILER!!!", type: "0", mode: 0, uid: 0, gid: 0, ino: 0, dev: 0, nlink: 1, mtime: 0, data: Buffer.alloc(0) }].entries()) {
    const key = `${entry.dev}:${entry.ino}`;
    if (!inodes.has(key)) inodes.set(key, inodes.size + 1);
    const ino = inodes.get(key), name = Buffer.from(`${entry.name.replace(/\/$/, "")}\0`);
    let data = entry.type === "2" ? Buffer.from(entry.linkname) : entry.type === "0" ? entry.data : Buffer.alloc(0);
    if (["newc", "crc"].includes(format) && lastLinks.has(key) && index !== lastLinks.get(key)) data = Buffer.alloc(0);
    const mode = (entry.mode ?? 0o644) | ({ "0": 0o100000, "5": 0o040000, "2": 0o120000, "6": 0o010000 }[entry.type] ?? 0);
    let header;
    if (format === "newc" || format === "crc") {
      const fields = [ino, mode, entry.uid, entry.gid, entry.nlink ?? 1, Math.floor(entry.mtime), data.length, 0, 0, 0, 0, name.length, format === "crc" && entry.type === "0" ? checksum(data) : 0];
      header = Buffer.from((format === "crc" ? "070702" : "070701") + fields.map(value => uint(value, 8, 16)).join(""));
      chunks.push(header, name, Buffer.alloc(padTo(header.length + name.length, 4)), data, Buffer.alloc(padTo(data.length, 4)));
    } else if (format === "odc") {
      header = Buffer.from("070707" + [0, ino, mode, entry.uid, entry.gid, entry.nlink ?? 1, 0].map(value => uint(value, 6, 8)).join("") + uint(entry.mtime, 11, 8) + uint(name.length, 6, 8) + uint(data.length, 11, 8));
      chunks.push(header, name, data);
    } else {
      header = Buffer.alloc(26);
      const fields = [0o70707, 0, ino, mode, entry.uid, entry.gid, entry.nlink ?? 1, 0, Math.floor(entry.mtime / 65536), Math.floor(entry.mtime) % 65536, name.length, Math.floor(data.length / 65536), data.length % 65536];
      for (const [fieldIndex, value] of fields.entries()) {
        if (value < 0 || value > 65535) throw new Error(`${entry.name}: value does not fit in binary cpio header; use -H newc`);
        header.writeUInt16LE(value, fieldIndex * 2);
      }
      chunks.push(header, name, Buffer.alloc(padTo(header.length + name.length, 2)), data, Buffer.alloc(padTo(data.length, 2)));
    }
  }
  const data = Buffer.concat(chunks);
  return Buffer.concat([data, Buffer.alloc(padTo(data.length, blockSize))]);
}

export function decodeCpio(input) {
  const buffer = Buffer.from(input);
  if (buffer.length >= 512 && buffer.subarray(257, 262).toString() === "ustar") return { ...decodeTar(buffer), format: "ustar" };
  const entries = [], groups = new Map();
  let offset = 0, format;
  while (offset < buffer.length) {
    const start = offset, magic = buffer.subarray(offset, offset + 6).toString("ascii");
    let headerSize, alignment, fields;
    const numeric = (at, width, base) => {
      const value = buffer.subarray(start + at, start + at + width).toString("ascii");
      if (value.length !== width || !(base === 16 ? /^[\da-fA-F]+$/ : /^[0-7]+$/).test(value)) throw new Error("invalid cpio numeric header");
      return Number.parseInt(value, base);
    };
    if (magic === "070701" || magic === "070702") {
      format = magic === "070702" ? "crc" : "newc"; headerSize = 110; alignment = 4;
      const numbers = Array.from({ length: 13 }, (_, index) => numeric(6 + index * 8, 8, 16));
      const [ino, mode, uid, gid, nlink, mtime, size, devmajor, devminor, rdevmajor, rdevminor, namesize, check] = numbers;
      fields = { ino, mode, uid, gid, nlink, mtime, size, dev: `${devmajor}:${devminor}`, namesize, check };
    } else if (magic === "070707") {
      format = "odc"; headerSize = 76; alignment = 1;
      const [dev, ino, mode, uid, gid, nlink, rdev] = Array.from({ length: 7 }, (_, index) => numeric(6 + index * 6, 6, 8));
      fields = { dev, ino, mode, uid, gid, nlink, mtime: numeric(48, 11, 8), namesize: numeric(59, 6, 8), size: numeric(65, 11, 8) };
    } else if (offset + 26 <= buffer.length && (buffer.readUInt16LE(offset) === 0o70707 || buffer.readUInt16BE(offset) === 0o70707)) {
      format = "bin"; headerSize = 26; alignment = 2;
      const little = buffer.readUInt16LE(offset) === 0o70707;
      const values = Array.from({ length: 13 }, (_, index) => little ? buffer.readUInt16LE(offset + index * 2) : buffer.readUInt16BE(offset + index * 2));
      const [, dev, ino, mode, uid, gid, nlink, rdev, mtHigh, mtLow, namesize, sizeHigh, sizeLow] = values;
      fields = { dev, ino, mode, uid, gid, nlink, mtime: mtHigh * 65536 + mtLow, namesize, size: sizeHigh * 65536 + sizeLow };
    } else throw new Error("invalid or unsupported cpio archive header");
    offset += headerSize;
    if (fields.namesize < 1 || offset + fields.namesize > buffer.length || buffer[offset + fields.namesize - 1] !== 0) throw new Error("invalid cpio file name");
    const name = buffer.subarray(offset, offset + fields.namesize - 1).toString("utf8").replace(/\0+$/, "");
    offset += fields.namesize + padTo(headerSize + fields.namesize, alignment);
    if (offset + fields.size > buffer.length) throw new Error("unexpected end of cpio archive");
    const data = buffer.subarray(offset, offset + fields.size);
    offset += fields.size + padTo(fields.size, alignment);
    if (offset > buffer.length) throw new Error("unexpected end of cpio archive");
    // GNU cpio CRC archives checksum regular file data, not symlink targets.
    if (format === "crc" && (fields.mode & 0o170000) === 0o100000 && checksum(data) !== fields.check) throw new Error(`${name}: cpio checksum mismatch`);
    if (name === "TRAILER!!!") {
      for (const group of groups.values()) {
        const contents = group.findLast(entry => entry.data.length)?.data ?? Buffer.alloc(0);
        for (const entry of group) { entry.data = contents; entry.size = contents.length; }
      }
      return { entries, end: start, format, bytes: offset };
    }
    const type = { [0o100000]: "0", [0o040000]: "5", [0o120000]: "2", [0o010000]: "6", [0o020000]: "3", [0o060000]: "4" }[fields.mode & 0o170000] ?? "?";
    const entry = { ...fields, name, mode: fields.mode & 0o7777, type, data, linkname: type === "2" ? data.toString("utf8") : "" };
    entries.push(entry);
    if (type === "0" && fields.nlink > 1) {
      const key = `${fields.dev}:${fields.ino}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
  }
  throw new Error("premature end of cpio archive (missing trailer)");
}

export function cpioHardlinks(entries) {
  const links = new Map();
  return entries.map(entry => {
    if (entry.type !== "0" || entry.nlink <= 1) return entry;
    const key = `${entry.dev}:${entry.ino}`;
    if (links.has(key)) return { ...entry, type: "1", linkname: links.get(key), data: Buffer.alloc(0), size: 0 };
    links.set(key, entry.name);
    return entry;
  });
}
