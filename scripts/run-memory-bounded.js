#!/usr/bin/env bun
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
const rssLimit = parseByteSize(takeValue("--rss-limit") ?? "1GiB");
const memoryLimit = parseByteSize(takeValue("--memory-limit") ?? "3GiB");
if (args[0] === "--") args.shift();
if (args.length === 0) {
  console.error("usage: run-memory-bounded.js [--rss-limit SIZE] [--memory-limit SIZE] -- COMMAND [ARG]...");
  process.exit(2);
}

const command = ["/usr/bin/prlimit", `--as=${memoryLimit}`, "--", ...args];
const proc = Bun.spawn(command, {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

let stopped = false;
let checking = false;
let limitMessage = "";
const watchdog = setInterval(async () => {
  if (stopped || checking) return;
  checking = true;
  try {
    const { bytes, pids } = await processTreeResidentBytes(proc.pid);
    if (!stopped && bytes > rssLimit) {
      limitMessage = `process-tree RSS limit exceeded: ${bytes} > ${rssLimit} bytes`;
      killProcessTree(pids);
    }
  } finally {
    checking = false;
  }
}, 100);

const code = await proc.exited;
stopped = true;
clearInterval(watchdog);
if (limitMessage) console.error(`run-memory-bounded: ${limitMessage}`);
process.exit(limitMessage ? 137 : code);

function takeValue(name) {
  const exact = args.indexOf(name);
  if (exact !== -1) {
    if (exact + 1 >= args.length) throw new Error(`${name} requires a value`);
    return args.splice(exact, 2)[1];
  }
  const prefix = `${name}=`;
  const joined = args.findIndex((arg) => arg.startsWith(prefix));
  if (joined !== -1) return args.splice(joined, 1)[0].slice(prefix.length);
  return null;
}

function parseByteSize(value) {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?i?b)?$/i.exec(value);
  if (!match) throw new Error(`invalid byte size: ${value}`);
  const units = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3, tb: 1024 ** 4, tib: 1024 ** 4 };
  return Math.floor(Number(match[1]) * units[(match[2] ?? "b").toLowerCase()]);
}

async function processTreeResidentBytes(rootPid) {
  const pending = [rootPid];
  const seen = new Set();
  let bytes = 0;
  while (pending.length) {
    const pid = pending.pop();
    if (!Number.isInteger(pid) || seen.has(pid)) continue;
    seen.add(pid);
    try {
      const children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
      for (const child of children.trim().split(/\s+/)) if (child) pending.push(Number(child));
    } catch {}
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) bytes += Number(match[1]) * 1024;
    } catch {}
  }
  return { bytes, pids: [...seen] };
}

function killProcessTree(pids) {
  for (const pid of pids.reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
