import { ptr, read } from "bun:ffi";
import { stat } from "node:fs/promises";
import { cstr, libc, localeQuotedEscapedDiagnostic } from "./common.js";
import { InvocationError } from "./diagnostics.js";

export const SIG_IGN = 1;

export function normalizeInvocationLongOptionByPrefix(arg, longOptions) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (longOptions.includes(name)) return arg;
  const matches = longOptions.filter((option) => option.startsWith(name));
  if (matches.length === 1) return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
  if (matches.length > 1) throw new InvocationError(`option '${arg}' is ambiguous; possibilities: ${matches.map((option) => `'--${option}'`).join(" ")}`);
  return arg;
}

export const SIGNAL_NAMES = ["EXIT", "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS", "FPE", "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM", "STKFLT", "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG", "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH", "IO", "PWR", "SYS"];

export function signalNumberFromOperand(signal) {
  const text = String(signal).replace(/^SIG/i, "").toUpperCase();
  const rtmin = text.match(/^RTMIN(?:\+(\d+))?$/);
  if (rtmin) {
    const signum = 34 + Number(rtmin[1] ?? 0);
    return signum <= 64 ? signum : -1;
  }
  const rtmax = text.match(/^RTMAX(?:-(\d+))?$/);
  if (rtmax) {
    const signum = 64 - Number(rtmax[1] ?? 0);
    return signum >= 34 ? signum : -1;
  }
  if (/^\d+$/.test(text)) {
    const status = Number(text);
    const signum = status >= 128 ? status & 127 : status;
    // Linux leaves 32 and 33 reserved by its threading implementation.  GNU
    // kill accepts them while enumerating a numeric range, but has no name to
    // print for either one.
    return signum >= 0 && signum <= 64 ? signum : -1;
  }
  const index = SIGNAL_NAMES.indexOf(text);
  return index;
}

export function signalDisplayName(signum) {
  if (signum === 34) return "RTMIN";
  if (signum === 64) return "RTMAX";
  if (signum > 34 && signum <= 49) return `RTMIN+${signum - 34}`;
  if (signum >= 50 && signum < 64) return `RTMAX-${64 - signum}`;
  return SIGNAL_NAMES[signum];
}

export async function isKnownUnexecutableCommand(command) {
  if (!(command === "." || command === ".." || command.includes("/"))) return false;
  try {
    const s = await stat(command);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export function parseDuration(value) {
  const text = String(value);
  const match = text.match(/^(\+?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|0[xX](?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP][+-]?\d+)?|[iI][nN][fF](?:[iI][nN][iI][tT][yY])?))([smhd]?)$/);
  if (!match) throw new InvocationError(`invalid time interval ${localeQuotedEscapedDiagnostic(value)}`, 125, true);
  let amount = parseDurationNumber(match[1]);
  if (Number.isNaN(amount) || amount < 0) throw new InvocationError(`invalid time interval ${localeQuotedEscapedDiagnostic(value)}`, 125, true);
  if (amount === 0 && /[1-9]/.test(match[1]) && !/^0+(?:\.0*)?(?:[eE][+-]?\d+)?$/.test(match[1])) amount = Number.MIN_VALUE;
  return amount * { "": 1000, s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
}

export function parseDurationNumber(value) {
  const text = String(value).replace(/^\+/, "");
  if (/^inf(?:inity)?$/i.test(text)) return Infinity;
  if (/^0x/i.test(text)) return parseHexFloat(text);
  return Number(value);
}

export function parseHexFloat(value) {
  const [, mantissa, exponentText] = value.match(/^0[xX]([0-9a-fA-F]*(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+)(?:[pP]([+-]?\d+))?$/) ?? [];
  if (mantissa == null) return NaN;
  const [whole, fraction = ""] = mantissa.split(".");
  let amount = Number.parseInt(whole || "0", 16);
  for (let i = 0; i < fraction.length; i++) amount += Number.parseInt(fraction[i], 16) / 16 ** (i + 1);
  return amount * 2 ** Number(exponentText ?? 0);
}

export function commandSpawnErrorMessage(error) {
  if (error?.code === "ENOENT" || /not found/i.test(error?.message || "")) return "No such file or directory";
  if (error?.code === "EACCES" || /permission denied/i.test(error?.message || "")) return "Permission denied";
  if (error?.code === "EISDIR" || /is a directory/i.test(error?.message || "")) return "Is a directory";
  return error?.message || String(error);
}

export function execCommand(command, options = {}) {
  const file = cstr(options.executable ?? command[0]);
  const strings = [options.argv0 ?? command[0], ...command.slice(1)].map(cstr);
  const argv = cStringVector(strings);
  if (options.env) {
    const environmentStrings = Object.entries(options.env).map(([name, value]) => cstr(`${name}=${value}`));
    const envp = cStringVector(environmentStrings);
    libc.symbols.execve(file, ptr(argv), ptr(envp));
  } else {
    libc.symbols.execvp(file, ptr(argv));
  }
  const errnoPointer = libc.symbols.__errno_location();
  const errno = errnoPointer ? read.i32(errnoPointer, 0) : 0;
  return {
    errno,
    message: errno === 2 ? "No such file or directory" : errno === 13 ? "Permission denied" : `execution failed (errno ${errno})`,
  };
}

export function isDirectCommandInvocation() {
  return globalThis[Symbol.for("bnu.cli")] === true || import.meta.main;
}

export function cStringVector(strings) {
  const vector = Buffer.alloc((strings.length + 1) * 8);
  strings.forEach((value, index) => vector.writeBigUInt64LE(BigInt(ptr(value)), index * 8));
  return vector;
}
