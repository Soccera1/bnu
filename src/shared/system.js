import { readFile } from "node:fs/promises";
import { statSyncNoThrow } from "./common.js";

export async function readUtmpRecords(file) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    return [];
  }
  return parseUtmpRecords(bytes);
}

export function nulTerminatedBufferString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString();
}

export function parseUtmpRecords(bytes) {
  const recordSize = 384;
  const records = [];
  for (let offset = 0; offset + recordSize <= bytes.length; offset += recordSize) {
    records.push({
      type: bytes.readInt16LE(offset),
      pid: bytes.readInt32LE(offset + 4),
      line: nulTerminatedBufferString(bytes.subarray(offset + 8, offset + 40)),
      id: nulTerminatedBufferString(bytes.subarray(offset + 40, offset + 44)),
      user: nulTerminatedBufferString(bytes.subarray(offset + 44, offset + 76)),
      host: nulTerminatedBufferString(bytes.subarray(offset + 76, offset + 332)),
      exitTermination: bytes.readInt16LE(offset + 332),
      exitStatus: bytes.readInt16LE(offset + 334),
      time: bytes.readInt32LE(offset + 340),
    });
  }
  return records;
}

export async function filterWhoUsers(records, requireLiveLine = false) {
  const users = records.filter((record) => record.type === 7 && record.user);
  if (!requireLiveLine) return users;
  const live = [];
  for (const record of users) {
    if (record.line && statSyncNoThrow(`/dev/${record.line}`)) live.push(record);
  }
  return live;
}

export function whoBootRecord(records, allowFallback = false) {
  const boots = records.filter((record) => record.time && record.type === 2);
  if (boots.length || !allowFallback) return boots.at(-1) ?? null;
  return records.filter((record) => record.time).sort((a, b) => a.time - b.time).at(-1) ?? null;
}

export function formatWhoDate(seconds) {
  const date = new Date(seconds * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  if (!whoUsesPosixDateFormat()) return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getMonth()]} ${String(date.getDate()).padStart(2)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function whoUsesPosixDateFormat() {
  const locale = process.env.LC_ALL || process.env.LC_TIME || process.env.LANG || "";
  return locale === "C" || locale === "POSIX";
}
