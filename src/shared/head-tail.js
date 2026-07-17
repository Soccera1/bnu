import { open, stat } from "node:fs/promises";
import { UsageError, stdout } from "./diagnostics.js";

export function parseByteCount(value) {
  const match = String(value).match(/^(\d+)([A-Za-z]*)$/);
  if (!match) throw new UsageError(`invalid byte count: ${value}`);
  const n = BigInt(match[1]);
  const scale = {
    "": 1n, b: 512n,
    k: 1024n, K: 1024n, KiB: 1024n, kiB: 1024n,
    m: 1024n ** 2n, M: 1024n ** 2n, MiB: 1024n ** 2n, miB: 1024n ** 2n,
    g: 1024n ** 3n, G: 1024n ** 3n, GiB: 1024n ** 3n, giB: 1024n ** 3n,
    t: 1024n ** 4n, T: 1024n ** 4n, TiB: 1024n ** 4n, tiB: 1024n ** 4n,
    P: 1024n ** 5n, PiB: 1024n ** 5n,
    E: 1024n ** 6n, EiB: 1024n ** 6n,
    Z: 1024n ** 7n, ZiB: 1024n ** 7n,
    Y: 1024n ** 8n, YiB: 1024n ** 8n,
    R: 1024n ** 9n, RiB: 1024n ** 9n,
    Q: 1024n ** 10n, QiB: 1024n ** 10n,
    KB: 1000n, kB: 1000n, MB: 1000n ** 2n, mB: 1000n ** 2n,
    GB: 1000n ** 3n, gB: 1000n ** 3n, TB: 1000n ** 4n, tB: 1000n ** 4n,
    PB: 1000n ** 5n, EB: 1000n ** 6n, ZB: 1000n ** 7n, YB: 1000n ** 8n,
    RB: 1000n ** 9n, QB: 1000n ** 10n,
  }[match[2]];
  if (!scale) throw new UsageError(`invalid byte count: ${value}`);
  const amount = n * scale;
  return amount > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(amount);
}

export async function isTailStreamingDevice(file) {
  const s = await stat(file).catch(() => null);
  return !!(s?.isCharacterDevice?.() || s?.isBlockDevice?.());
}

export async function tailFirstBytes(file, count) {
  if (count <= 0) return;
  const handle = await open(file, "r");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, count));
  let remaining = count;
  try {
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      if (bytesRead === 0) break;
      stdout(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

export function splitDelimitedByteRecords(data, delimiter) {
  const records = [];
  const sep = delimiter.charCodeAt(0);
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== sep) continue;
    records.push(Buffer.from(data.subarray(start, i + 1)));
    start = i + 1;
  }
  if (start < data.length) records.push(Buffer.from(data.subarray(start)));
  return records;
}

export function normalizeHeadTailArgs(args, command) {
  const normalized = [];
  let end = false;
  let valueFor = null;
  for (const arg of args) {
    if (end) {
      normalized.push(arg);
      continue;
    }
    if (valueFor) {
      normalized.push(arg);
      valueFor = null;
      continue;
    }
    if (arg === "--") {
      end = true;
      normalized.push(arg);
    } else if (arg === "-n" || arg === "-c" || arg === "--lines" || arg === "--bytes") {
      valueFor = arg;
      normalized.push(arg);
    } else if (command === "tail" && /^-\d+[cbk].+/.test(arg)) {
      throw new UsageError(`option used in invalid context -- ${arg[1]}`);
    } else if (command === "tail" && /^([+-])(\d+)([cbk])$/.test(arg)) {
      const [, sign, count, suffix] = arg.match(/^([+-])(\d+)([cbk])$/);
      normalized.push("-c", `${sign}${count}${suffix === "c" ? "" : suffix}`);
    } else if (command === "tail" && /^([+-])(\d+)l$/.test(arg)) {
      const [, sign, count] = arg.match(/^([+-])(\d+)l$/);
      normalized.push("-n", `${sign}${count}`);
    } else if (command === "tail" && arg === "+c") {
      normalized.push("-c", "+10");
    } else if (command === "tail" && arg === "+l") {
      normalized.push("-n", "+10");
    } else if (command === "tail" && arg === "-l") {
      normalized.push("-n", "10");
    } else if (command === "tail" && arg === "-b") {
      normalized.push("-c", "10b");
    } else if (/^-\d+[cbk]$/.test(arg)) {
      const suffix = arg.at(-1);
      normalized.push("-c", suffix === "c" ? arg.slice(1, -1) : arg.slice(1));
    } else if (/^-\d/.test(arg)) {
      normalized.push("-n", arg.slice(1));
    } else if (command === "tail" && /^\+\d+$/.test(arg)) {
      normalized.push("-n", arg);
    } else {
      normalized.push(arg);
    }
  }
  return normalized;
}

export function headTailHeaderMode(args) {
  let mode = null;
  let end = false;
  let valueFor = null;
  for (const arg of args) {
    if (end) continue;
    if (valueFor) {
      valueFor = null;
      continue;
    }
    if (arg === "--") {
      end = true;
      continue;
    }
    if (arg === "-n" || arg === "-c" || arg === "--lines" || arg === "--bytes" || arg === "--sleep" || arg === "--sleep-interval" || arg === "--max-unchanged-stats" || arg === "--pid") {
      valueFor = arg;
      continue;
    }
    if (arg === "--quiet" || arg === "--silent") mode = "quiet";
    else if (arg === "--verbose") mode = "verbose";
    else if (/^-[^-]/.test(arg)) {
      for (const ch of arg.slice(1)) {
        if (ch === "q") mode = "quiet";
        else if (ch === "v") mode = "verbose";
      }
    }
  }
  return mode;
}

export function headTailShouldPrintHeader(mode, fileCount) {
  if (mode === "verbose") return true;
  if (mode === "quiet") return false;
  return fileCount > 1;
}
