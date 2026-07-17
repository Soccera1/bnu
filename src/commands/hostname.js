#!/usr/bin/env bun

import { hostname as osHostname } from "node:os";
import { cstr, decodeSurrogateEscapedBytes, libc, normalizeLongOptionByPrefix, parseOptions, readAll } from "../shared/common.js";
import { UsageError, VERSION, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const HOSTNAME_LONG_OPTIONS = ["short", "alias", "domain", "fqdn", "long", "ip-address", "yp", "nis", "file", "help", "version"];

export async function hostnameCmd(args) {
  args = normalizeHostnameLongOptions(args);
  const meta = scanMetaOptionBeforeEnd(args);
  if (meta === "--help") {
    showHostnameHelp();
    return 0;
  }
  if (meta === "--version") {
    stdout(`${VERSION}\n`);
    return 0;
  }
  for (const arg of args) {
    if (arg === "--") break;
    if (arg.startsWith("--help=")) throw new UsageError("option '--help' doesn't allow an argument", true);
    if (arg.startsWith("--version=")) throw new UsageError("option '--version' doesn't allow an argument", true);
  }
  const { opts, operands } = parseOptions(args, { short: { s: false, a: false, d: false, f: false, i: false, y: false, F: "value" }, long: { short: false, alias: false, domain: false, fqdn: false, long: false, "ip-address": false, yp: false, nis: false, file: "value", help: false, version: false } });
  const displayMode = hostnameDisplayMode(args);
  if (displayMode === "short") return hostnamePrintShort();
  if (displayMode === "yp" && operands.length === 0) {
    stdout("(none)\n");
    return 0;
  }
  if (displayMode === "lookup") throw new UsageError("Host name lookup failure");
  if (Object.hasOwn(opts, "F") || Object.hasOwn(opts, "file")) {
    const file = Object.hasOwn(opts, "F") ? opts.F : opts.file;
    let name;
    try {
      name = decodeSurrogateEscapedBytes(await readAll(file)).split(/\r?\n/, 1)[0];
    } catch {
      throw new UsageError(`can't open \`${file}'`);
    }
    return hostnameSetName(name);
  }
  if (operands.length >= 1) {
    return hostnameSetName(operands[0]);
  } else {
    stdout(`${osHostname()}\n`);
  }
  return 0;
}

export function normalizeHostnameLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeLongOptionByPrefix(arg, HOSTNAME_LONG_OPTIONS));
  }
  return out;
}

export function hostnamePrintShort() {
  stdout(`${osHostname().split(".")[0]}\n`);
  return 0;
}

export function hostnameSetName(name) {
  if (libc.symbols.sethostname(cstr(name), Buffer.byteLength(name)) !== 0) {
    throw new UsageError("you don't have permission to set the host name");
  }
  return 0;
}

export function hostnameDisplayMode(args) {
  let mode = null;
  let end = false;
  const longModes = new Map([
    ["short", "short"],
    ["alias", "lookup"],
    ["domain", "lookup"],
    ["fqdn", "lookup"],
    ["long", "lookup"],
    ["ip-address", "lookup"],
    ["yp", "yp"],
    ["nis", "yp"],
  ]);
  for (const arg of args) {
    if (end) continue;
    if (arg === "--") {
      end = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=", 1)[0];
      if (longModes.has(name)) mode = longModes.get(name);
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      for (const ch of arg.slice(1)) {
        if (ch === "s") mode = "short";
        else if (ch === "a" || ch === "d" || ch === "f" || ch === "i") mode = "lookup";
        else if (ch === "y") mode = "yp";
        else if (ch === "F") break;
      }
    }
  }
  return mode;
}

export function showHostnameHelp() {
  stdout("Usage: hostname [NAME]\n");
  stdout("  or:  hostname OPTION\n");
  stdout("Print or set the hostname of the current system.\n\n");
  stdout("  -s, --short    print the short host name\n");
  stdout("  -a, --alias    print alias names\n");
  stdout("  -d, --domain   print DNS domain name\n");
  stdout("  -f, --fqdn, --long\n");
  stdout("                 print fully qualified domain name\n");
  stdout("  -i, --ip-address\n");
  stdout("                 print addresses for the host name\n");
  stdout("  -y, --yp, --nis\n");
  stdout("                 print NIS/YP domain name\n");
  stdout("  -F, --file=FILE\n");
  stdout("                 read host name from FILE\n");
  stdout("      --help     display this help and exit\n");
  stdout("      --version  output version information and exit\n");
}

export function scanMetaOptionBeforeEnd(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg === "--help" || arg === "--version") return arg;
  }
  return null;
}

const singleCall = defineCommand("hostname", hostnameCmd, null);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
