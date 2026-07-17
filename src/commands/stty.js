#!/usr/bin/env bun

import { FFIType, linkSymbols, ptr } from "bun:ffi";
import { open } from "node:fs/promises";
import { libc, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, normalizeLongOptionByPrefix, systemErrorMessage } from "../shared/common.js";
import { UsageError, fail, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const TCSANOW = 0;

export const TCSADRAIN = 1;

export const TIOCGWINSZ = 0x5413;

export const TIOCSWINSZ = 0x5414;

export const TERMIOS_SIZE = 60;

export const TERMIOS_OFFSETS = { iflag: 0, oflag: 4, cflag: 8, lflag: 12, line: 16, cc: 17, ispeed: 52, ospeed: 56 };

export const STTY_CC = { intr: 0, quit: 1, erase: 2, kill: 3, eof: 4, eol: 11, eol2: 16, swtch: 7, start: 8, stop: 9, susp: 10, rprnt: 12, werase: 14, lnext: 15, discard: 13, min: 6, time: 5 };

export const STTY_FLAGS = {
  iflag: { ignbrk: 0o1, brkint: 0o2, ignpar: 0o4, parmrk: 0o10, inpck: 0o20, istrip: 0o40, inlcr: 0o100, igncr: 0o200, icrnl: 0o400, iuclc: 0o1000, ixon: 0o2000, ixany: 0o4000, ixoff: 0o10000, imaxbel: 0o20000, iutf8: 0o40000 },
  oflag: { opost: 0o1, olcuc: 0o2, onlcr: 0o4, ocrnl: 0o10, onocr: 0o20, onlret: 0o40, ofill: 0o100, ofdel: 0o200 },
  cflag: { cs5: 0o0, cs6: 0o20, cs7: 0o40, cs8: 0o60, cstopb: 0o100, cread: 0o200, parenb: 0o400, parodd: 0o1000, hupcl: 0o2000, hup: 0o2000, clocal: 0o4000, cmspar: 0o10000000000, crtscts: 0o20000000000 },
  lflag: { isig: 0o1, icanon: 0o2, xcase: 0o4, echo: 0o10, echoe: 0o20, echok: 0o40, echonl: 0o100, noflsh: 0o200, tostop: 0o400, echoctl: 0o1000, echoprt: 0o2000, echoke: 0o4000, flusho: 0o10000, iexten: 0o100000, extproc: 0o200000 },
};

export const STTY_CS_MASK = 0o60;

export const STTY_DELAY_GROUPS = {
  nl: { mask: 0x100, values: { nl0: 0x0, nl1: 0x100 } },
  cr: { mask: 0x600, values: { cr0: 0x0, cr1: 0x200, cr2: 0x400, cr3: 0x600 } },
  tab: { mask: 0x1800, values: { tab0: 0x0, tab1: 0x800, tab2: 0x1000, tab3: 0x1800 } },
  bs: { mask: 0x2000, values: { bs0: 0x0, bs1: 0x2000 } },
  vt: { mask: 0x4000, values: { vt0: 0x0, vt1: 0x4000 } },
  ff: { mask: 0x8000, values: { ff0: 0x0, ff1: 0x8000 } },
};

export const STTY_OBAUD_MASK = 0x100f;

export const STTY_IBAUD_MASK = 0x100f0000;

export const STTY_SPEED_CODES = new Map([
  [0, 0], [50, 1], [75, 2], [110, 3], [134, 4], [150, 5], [200, 6], [300, 7],
  [600, 8], [1200, 9], [1800, 10], [2400, 11], [4800, 12], [9600, 13],
  [19200, 14], [38400, 15], [57600, 0x1001], [115200, 0x1002], [230400, 0x1003],
  [460800, 0x1004], [500000, 0x1005], [576000, 0x1006], [921600, 0x1007],
  [1000000, 0x1008], [1152000, 0x1009], [1500000, 0x100a], [2000000, 0x100b],
  [2500000, 0x100c], [3000000, 0x100d], [3500000, 0x100e], [4000000, 0x100f],
]);

export const STTY_CODE_SPEEDS = new Map([...STTY_SPEED_CODES].map(([speed, code]) => [code, speed]));

export let sttyTermiosApi;

export function sttyInterposedTermiosApi() {
  if (sttyTermiosApi) return sttyTermiosApi;
  const symbols = {};
  for (const name of ["cfsetispeed", "cfsetospeed"]) {
    const address = libc.symbols.dlsym(0, ptr(Buffer.from(`${name}\0`)));
    symbols[name] = { ptr: address, args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 };
  }
  sttyTermiosApi = linkSymbols(symbols).symbols;
  return sttyTermiosApi;
}

export const STTY_LONG_OPTIONS = ["all", "file", "save", "help", "version"];

export async function sttyCmd(args) {
  const { opts, operands } = parseSttyArgs(args);
  validateSttyOutputStyle(opts, operands);
  validateSttyOperands(operands);
  const target = opts.F ?? opts.file;
  let targetHandle = null;
  let fd = 0;
  if (target != null) {
    try {
      targetHandle = await open(target, "r");
      fd = targetHandle.fd;
    } catch (error) {
      return fail("stty", `${sttyDeviceDisplayName(target)}: ${systemErrorMessage(error)}`);
    }
  }
  if (targetHandle == null && !sttyTargetIsTty(opts)) return fail("stty", `${sttyTargetName(opts)}: Inappropriate ioctl for device`);
  const termios = sttyReadTermios(fd);
  if (!termios) {
    await targetHandle?.close().catch(() => {});
    return fail("stty", `${sttyTargetName(opts)}: Inappropriate ioctl for device`);
  }
  const windowSize = sttyReadWindowSize(fd);
  if (opts.g || opts.save) {
    stdout(sttySavedSettings(termios));
    await targetHandle?.close().catch(() => {});
    return 0;
  }
  const rows = windowSize?.rows ?? process.stdout.rows ?? 0;
  const columns = windowSize?.columns ?? process.stdout.columns ?? 0;
  if (!operands.length || opts.a || opts.all) {
    stdout(opts.a || opts.all ? sttyAllOutput(rows, columns, termios) : sttyDefaultOutput(termios));
    await targetHandle?.close().catch(() => {});
    return 0;
  }
  if (operands.length === 1 && operands[0] === "speed") {
    stdout(sttySpeedOutput(termios));
    await targetHandle?.close().catch(() => {});
    return 0;
  }
  if (operands.length === 1 && operands[0] === "size") {
    stdout(`${rows} ${columns}\n`);
    await targetHandle?.close().catch(() => {});
    return 0;
  }
  if (operands.every((operand) => operand === "drain" || operand === "-drain")) {
    stdout(sttyDefaultOutput(termios));
    await targetHandle?.close().catch(() => {});
    return 0;
  }
  const applied = sttyApplyOperands(termios, operands, windowSize);
  if (applied.windowSize && libc.symbols.ioctl(fd, TIOCSWINSZ, ptr(sttyWindowSizeBuffer(applied.windowSize))) !== 0) {
    await targetHandle?.close().catch(() => {});
    return fail("stty", `${sttyTargetName(opts)}: Inappropriate ioctl for device`);
  }
  if (libc.symbols.tcsetattr(fd, sttyApplyTiming(operands), ptr(applied.termios.buffer)) !== 0) {
    await targetHandle?.close().catch(() => {});
    return fail("stty", `${sttyTargetName(opts)}: Inappropriate ioctl for device`);
  }
  libc.symbols._exit(0);
  return 0;
}

export function sttyMetaOption(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const normalized = normalizeLongOptionByPrefix(arg, STTY_LONG_OPTIONS);
      const [name, inlineValue] = normalized.slice(2).split(/=(.*)/s, 2);
      if ((normalized === "--help" || normalized === "--version") && inlineValue == null) return normalized;
      if (name === "file" && inlineValue == null) i++;
      continue;
    }
    if (arg === "-F") i++;
    else if (arg.startsWith("-F") && arg.length > 2) continue;
  }
  return null;
}

export function parseSttyArgs(args) {
  const opts = {};
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      break;
    }
    if (arg.startsWith("--")) {
      const normalized = normalizeLongOptionByPrefix(arg, STTY_LONG_OPTIONS);
      const [name, inlineValue] = normalized.slice(2).split(/=(.*)/s, 2);
      if (name === "file") {
        if (inlineValue != null) opts.file = inlineValue;
        else if (i + 1 < args.length) opts.file = args[++i];
        else throw new UsageError(`invalid argument ${localeQuotedDiagnostic("--file")}`, true);
      } else if (name === "all" && inlineValue == null) opts.all = true;
      else if (name === "save" && inlineValue == null) opts.save = true;
      else if ((name === "help" || name === "version") && inlineValue == null) opts[name] = true;
      else operands.push(arg);
      continue;
    }
    if (arg === "-a") opts.a = true;
    else if (arg === "-g") opts.g = true;
    else if (arg === "-F") {
      if (i + 1 < args.length) opts.F = args[++i];
      else throw new UsageError("option requires an argument -- 'F'", true);
    } else if (arg.startsWith("-F") && arg.length > 2) opts.F = arg.slice(2);
    else if (/^-[agF]+/.test(arg)) {
      let consumed = false;
      for (let j = 1; j < arg.length; j++) {
        const ch = arg[j];
        if (ch === "a") opts.a = true;
        else if (ch === "g") opts.g = true;
        else if (ch === "F") {
          const rest = arg.slice(j + 1);
          if (rest) opts.F = rest;
          else if (i + 1 < args.length) opts.F = args[++i];
          else operands.push("F");
          consumed = true;
          break;
        } else {
          operands.push(arg);
          consumed = true;
          break;
        }
      }
      if (consumed) continue;
    }
    else operands.push(arg);
  }
  return { opts, operands };
}

export function validateSttyOutputStyle(opts, operands) {
  const styles = [opts.a || opts.all, opts.g || opts.save].filter(Boolean).length;
  if (styles > 1) throw new UsageError("the options for verbose and stty-readable output styles are\nmutually exclusive");
  if (styles && operands.length) throw new UsageError("when specifying an output style, modes may not be set");
}

export function validateSttyOperands(operands) {
  for (let i = 0; i < operands.length; i++) {
    const setting = operands[i];
    if (setting === "size" || setting === "speed") continue;
    if (/^[0-9a-fA-F:]+$/.test(setting) && setting.includes(":")) {
      if (!sttySavedSettingsLooksValid(setting)) throw new UsageError(`invalid argument ${localeQuotedEscapedDiagnostic(setting)}`, true);
      continue;
    }
    if (sttyBareSpeed(setting) != null || STTY_NO_ARG_SETTINGS.has(setting)) continue;
    if (STTY_VALUE_SETTINGS.has(setting)) {
      if (i + 1 >= operands.length) throw new UsageError(`missing argument to '${setting}'`, true);
      const value = operands[++i];
      validateSttyValueSetting(setting, value);
      continue;
    }
    throw new UsageError(`invalid argument ${localeQuotedEscapedDiagnostic(setting)}`, true);
  }
}

export function validateSttyValueSetting(setting, value) {
  if (setting === "line" || setting === "min" || setting === "time") {
    parseSttyInteger(value, 0xffn);
    return;
  }
  if (setting === "ispeed" || setting === "ospeed") {
    parseSttySpeed(value, setting);
    return;
  }
  if (STTY_CONTROL_SETTINGS.has(setting)) {
    if (value === "" || value === "undef" || value === "^-" || value.length === 1 || value.startsWith("^") && value.length >= 2) return;
    parseSttyInteger(value, 0xffn);
  }
}

export const STTY_NO_ARG_SETTING_NAMES = [
  "parenb", "parodd", "cmspar", "cs5", "cs6", "cs7", "cs8", "hupcl", "hup", "cstopb", "cread", "clocal", "crtscts",
  "ignbrk", "brkint", "ignpar", "parmrk", "inpck", "istrip", "inlcr", "igncr", "icrnl", "ixon", "ixoff", "iuclc", "ixany", "imaxbel", "iutf8",
  "opost", "olcuc", "ocrnl", "onlcr", "onocr", "onlret", "ofill", "ofdel", "nl0", "nl1", "cr0", "cr1", "cr2", "cr3", "tab0", "tab1", "tab2", "tab3", "bs0", "bs1", "vt0", "vt1", "ff0", "ff1",
  "isig", "icanon", "iexten", "echo", "echoe", "echok", "echonl", "noflsh", "xcase", "tostop", "echoprt", "echoctl", "echoke", "flusho", "extproc",
  "raw", "cooked", "sane", "cbreak", "pass8", "litout", "nl", "ek", "dec", "evenp", "parity", "oddp",
  "drain",
];

export const STTY_NO_ARG_SETTINGS = new Set(STTY_NO_ARG_SETTING_NAMES.flatMap((name) => [name, `-${name}`]));

export const STTY_VALUE_SETTINGS = new Set([
  "rows", "cols", "columns", "ispeed", "ospeed", "min", "time", "line",
  "intr", "quit", "erase", "kill", "eof", "eol", "eol2", "swtch", "start", "stop", "susp", "rprnt", "werase", "lnext", "discard",
]);

export const STTY_CONTROL_SETTINGS = new Set([
  "intr", "quit", "erase", "kill", "eof", "eol", "eol2", "swtch", "start", "stop", "susp", "rprnt", "werase", "lnext", "discard",
]);

export function sttySavedSettingsLooksValid(value) {
  const parts = value.split(":");
  return parts.length === 36
    && parts.every((part) => /^[0-9a-fA-F]+$/.test(part) && BigInt(`0x${part}`) <= 0xffffffffn);
}

export function sttyTargetIsTty(opts) {
  if (opts.F || opts.file) return false;
  return Boolean(process.stdin.isTTY);
}

export function sttyTargetName(opts) {
  return sttyDeviceDisplayName(opts.F ?? opts.file ?? "'standard input'");
}

export function sttyDeviceDisplayName(target) {
  return target === "" ? "''" : target;
}

export function sttyReadTermios(fd = 0) {
  const buffer = Buffer.alloc(TERMIOS_SIZE);
  if (libc.symbols.tcgetattr(fd, ptr(buffer)) !== 0) return null;
  return { buffer, view: new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength) };
}

export function sttyReadWindowSize(fd = 0) {
  const buffer = Buffer.alloc(8);
  if (libc.symbols.ioctl(fd, TIOCGWINSZ, ptr(buffer)) !== 0) return null;
  return { rows: buffer.readUInt16LE(0), columns: buffer.readUInt16LE(2) };
}

export function sttyWindowSizeBuffer(size) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt16LE(size.rows ?? 0, 0);
  buffer.writeUInt16LE(size.columns ?? 0, 2);
  return buffer;
}

export function sttySavedSettings(termios) {
  const fields = [
    sttyTermiosFlag(termios, "iflag").toString(16),
    sttyTermiosFlag(termios, "oflag").toString(16),
    sttyTermiosFlag(termios, "cflag").toString(16),
    sttyTermiosFlag(termios, "lflag").toString(16),
  ];
  for (let i = 0; i < 32; i++) fields.push(termios.view.getUint8(TERMIOS_OFFSETS.cc + i).toString(16));
  return `${fields.join(":")}\n`;
}

export function sttyDefaultOutput(termios) {
  const toggles = [];
  if (!sttyHasFlag(termios, "iflag", "brkint")) toggles.push("-brkint");
  if (!sttyHasFlag(termios, "iflag", "imaxbel")) toggles.push("-imaxbel");
  if (!sttyHasFlag(termios, "lflag", "echo")) toggles.push("-echo");
  if (!sttyHasFlag(termios, "lflag", "icanon")) toggles.push("-icanon");
  if (!sttyHasFlag(termios, "lflag", "isig")) toggles.push("-isig");
  if (!sttyHasFlag(termios, "oflag", "opost")) toggles.push("-opost");
  return `${sttyVerboseSpeedPrefix(termios)} line = ${termios.view.getUint8(TERMIOS_OFFSETS.line)};\n${toggles.join(" ")}\n`;
}

export function sttyAllOutput(rows, columns, termios) {
  return `${sttyVerboseSpeedPrefix(termios)} rows ${rows}; columns ${columns}; line = ${termios.view.getUint8(TERMIOS_OFFSETS.line)};
intr = ${sttyControlDisplay(termios, "intr")}; quit = ${sttyControlDisplay(termios, "quit")}; erase = ${sttyControlDisplay(termios, "erase")}; kill = ${sttyControlDisplay(termios, "kill")}; eof = ${sttyControlDisplay(termios, "eof")}; eol = ${sttyControlDisplay(termios, "eol")};
eol2 = ${sttyControlDisplay(termios, "eol2")}; swtch = ${sttyControlDisplay(termios, "swtch")}; start = ${sttyControlDisplay(termios, "start")}; stop = ${sttyControlDisplay(termios, "stop")}; susp = ${sttyControlDisplay(termios, "susp")}; rprnt = ${sttyControlDisplay(termios, "rprnt")};
werase = ${sttyControlDisplay(termios, "werase")}; lnext = ${sttyControlDisplay(termios, "lnext")}; discard = ${sttyControlDisplay(termios, "discard")}; min = ${termios.view.getUint8(TERMIOS_OFFSETS.cc + STTY_CC.min)}; time = ${termios.view.getUint8(TERMIOS_OFFSETS.cc + STTY_CC.time)};
${sttyFlagList(termios, "cflag", ["parenb", "parodd", "cmspar", "cs8", "hupcl", "cstopb", "cread", "clocal", "crtscts"])}
${sttyFlagList(termios, "iflag", ["ignbrk", "brkint", "ignpar", "parmrk", "inpck", "istrip", "inlcr", "igncr", "icrnl", "ixon", "ixoff"])}
${sttyFlagList(termios, "iflag", ["iuclc", "ixany", "imaxbel", "iutf8"])}
${sttyFlagList(termios, "oflag", ["opost", "olcuc", "ocrnl", "onlcr", "onocr", "onlret", "ofill", "ofdel"])} ${sttyDelayModeList(termios)}
${sttyFlagList(termios, "lflag", ["isig", "icanon", "iexten", "echo", "echoe", "echok", "echonl", "noflsh", "xcase", "tostop", "echoprt"])}
${sttyFlagList(termios, "lflag", ["echoctl", "echoke", "flusho", "extproc"])}
`;
}

export function sttyTermiosFlag(termios, group) {
  return termios.view.getUint32(TERMIOS_OFFSETS[group], true);
}

export function sttySetTermiosFlag(termios, group, value) {
  termios.view.setUint32(TERMIOS_OFFSETS[group], value >>> 0, true);
}

export function sttyHasFlag(termios, group, name) {
  const flag = STTY_FLAGS[group]?.[name];
  if (flag == null) return false;
  if (group === "cflag" && /^cs[5-8]$/.test(name)) return (sttyTermiosFlag(termios, group) & STTY_CS_MASK) === flag;
  return (sttyTermiosFlag(termios, group) & flag) !== 0;
}

export function sttySetFlag(termios, group, name, enabled) {
  const flag = STTY_FLAGS[group]?.[name];
  if (flag == null) return false;
  let value = sttyTermiosFlag(termios, group);
  if (group === "cflag" && /^cs[5-8]$/.test(name)) value = (value & ~STTY_CS_MASK) | flag;
  else value = enabled ? value | flag : value & ~flag;
  sttySetTermiosFlag(termios, group, value);
  return true;
}

export function sttyFlagList(termios, group, names) {
  return names.map((name) => sttyHasFlag(termios, group, name) ? name : `-${name}`).join(" ");
}

export function sttyDelayModeList(termios) {
  const oflag = sttyTermiosFlag(termios, "oflag");
  return Object.values(STTY_DELAY_GROUPS).map((group) => {
    const active = oflag & group.mask;
    return Object.entries(group.values).find(([, value]) => value === active)?.[0] ?? Object.keys(group.values)[0];
  }).join(" ");
}

export function sttyControlDisplay(termios, setting) {
  const value = termios.view.getUint8(TERMIOS_OFFSETS.cc + STTY_CC[setting]);
  if (value === 0) return "<undef>";
  if (value === 0x7f) return "^?";
  if (value < 0x20) return `^${String.fromCharCode(value + 0x40)}`;
  if (value === 0x20) return " ";
  return String.fromCharCode(value);
}

export function sttyInputSpeed(termios) {
  return termios.view.getUint32(TERMIOS_OFFSETS.ispeed, true);
}

export function sttyOutputSpeed(termios) {
  return termios.view.getUint32(TERMIOS_OFFSETS.ospeed, true);
}

export function sttySpeedOutput(termios) {
  const input = sttyInputSpeed(termios);
  const output = sttyOutputSpeed(termios);
  return input === output ? `${output}\n` : `${input} ${output}\n`;
}

export function sttyVerboseSpeedPrefix(termios) {
  const input = sttyInputSpeed(termios);
  const output = sttyOutputSpeed(termios);
  return input === output ? `speed ${output} baud;` : `ispeed ${input} baud; ospeed ${output} baud;`;
}

export function sttySetSpeed(termios, speed, direction = "both", display = String(speed)) {
  const api = sttyInterposedTermiosApi();
  if ((direction === "both" || direction === "input") && api.cfsetispeed(ptr(termios.buffer), speed) !== 0) {
    throw new UsageError(`unsupported ispeed ${localeQuotedEscapedDiagnostic(display)}`);
  }
  if ((direction === "both" || direction === "output") && api.cfsetospeed(ptr(termios.buffer), speed) !== 0) {
    throw new UsageError(`unsupported ospeed ${localeQuotedEscapedDiagnostic(display)}`);
  }
}

export function sttySyncSpeedFieldsFromCflag(termios) {
  const cflag = sttyTermiosFlag(termios, "cflag");
  const outputCode = cflag & STTY_OBAUD_MASK;
  const inputCode = (cflag & STTY_IBAUD_MASK) >>> 16;
  const output = STTY_CODE_SPEEDS.get(outputCode);
  const input = STTY_CODE_SPEEDS.get(inputCode);
  if (output != null) termios.view.setUint32(TERMIOS_OFFSETS.ospeed, output, true);
  if (input != null) termios.view.setUint32(TERMIOS_OFFSETS.ispeed, input, true);
}

export function sttyApplyOperands(termios, operands, windowSize = null) {
  const next = { buffer: Buffer.from(termios.buffer), view: null };
  next.view = new DataView(next.buffer.buffer, next.buffer.byteOffset, next.buffer.byteLength);
  const nextWindowSize = windowSize == null ? null : { ...windowSize };
  if (operands.length === 1 && sttySavedSettingsLooksValid(operands[0])) {
    sttyApplySavedSettings(next, operands[0]);
    return { termios: next, windowSize: null };
  }
  for (let i = 0; i < operands.length; i++) {
    const setting = operands[i];
    if (STTY_VALUE_SETTINGS.has(setting)) {
      sttyApplyValueSetting(next, nextWindowSize, setting, operands[++i]);
      continue;
    }
    const bareSpeed = sttyBareSpeed(setting);
    if (bareSpeed != null) {
      sttySetSpeed(next, bareSpeed, "both", setting);
      continue;
    }
    sttyApplyModeSetting(next, setting);
  }
  return { termios: next, windowSize: nextWindowSize };
}

export function sttyApplySavedSettings(termios, saved) {
  const parts = saved.split(":").map((part) => Number.parseInt(part, 16));
  if (parts.length < 4 || parts.some((part) => !Number.isFinite(part))) return;
  sttySetTermiosFlag(termios, "iflag", parts[0]);
  sttySetTermiosFlag(termios, "oflag", parts[1]);
  sttySetTermiosFlag(termios, "cflag", parts[2]);
  sttySetTermiosFlag(termios, "lflag", parts[3]);
  for (let i = 0; i < Math.min(32, parts.length - 4); i++) termios.view.setUint8(TERMIOS_OFFSETS.cc + i, parts[i + 4] & 0xff);
  sttySyncSpeedFieldsFromCflag(termios);
}

export function sttyApplyModeSetting(termios, setting) {
  const enabled = !setting.startsWith("-");
  const name = enabled ? setting : setting.slice(1);
  if (name === "drain") return;
  if (name === "raw") return sttyApplyRaw(termios, enabled);
  if (name === "sane") return sttyApplySane(termios);
  if (name === "cooked") return sttyApplyCooked(termios);
  if (name === "cbreak") return sttyApplyCbreak(termios, enabled);
  if (name === "pass8") return sttyApplyPass8(termios, enabled);
  if (name === "litout") return sttyApplyLitout(termios, enabled);
  if (name === "nl") return sttyApplyNl(termios, enabled);
  if (sttyApplyDelayMode(termios, name)) return;
  if (["evenp", "parity"].includes(name)) {
    sttySetFlag(termios, "cflag", "parenb", enabled);
    sttySetFlag(termios, "cflag", "parodd", false);
    return;
  }
  if (name === "oddp") {
    sttySetFlag(termios, "cflag", "parenb", enabled);
    sttySetFlag(termios, "cflag", "parodd", enabled);
    return;
  }
  for (const group of ["iflag", "oflag", "cflag", "lflag"]) {
    if (sttySetFlag(termios, group, name, enabled)) return;
  }
}

export function sttyApplyTiming(operands) {
  let timing = TCSANOW;
  for (const operand of operands) {
    if (operand === "drain") timing = TCSADRAIN;
    else if (operand === "-drain") timing = TCSANOW;
  }
  return timing;
}

export function sttyApplyDelayMode(termios, name) {
  for (const group of Object.values(STTY_DELAY_GROUPS)) {
    if (!(name in group.values)) continue;
    const oflag = sttyTermiosFlag(termios, "oflag");
    sttySetTermiosFlag(termios, "oflag", (oflag & ~group.mask) | group.values[name]);
    return true;
  }
  return false;
}

export function sttyApplyRaw(termios, enabled) {
  if (enabled) {
    for (const name of ["ignbrk", "brkint", "parmrk", "istrip", "inlcr", "igncr", "icrnl", "ixon"]) sttySetFlag(termios, "iflag", name, false);
    sttySetFlag(termios, "oflag", "opost", false);
    for (const name of ["echo", "echonl", "icanon", "isig"]) sttySetFlag(termios, "lflag", name, false);
    sttySetFlag(termios, "cflag", "cs8", true);
    termios.view.setUint8(TERMIOS_OFFSETS.cc + STTY_CC.min, 1);
    termios.view.setUint8(TERMIOS_OFFSETS.cc + STTY_CC.time, 0);
    return;
  }
  for (const name of ["brkint", "icrnl", "ixon"]) sttySetFlag(termios, "iflag", name, true);
  sttySetFlag(termios, "oflag", "opost", true);
  for (const name of ["isig", "icanon", "iexten"]) sttySetFlag(termios, "lflag", name, true);
}

export function sttyApplyCooked(termios) {
  for (const name of ["brkint", "ignpar", "istrip", "icrnl", "ixon"]) sttySetFlag(termios, "iflag", name, true);
  sttySetFlag(termios, "oflag", "opost", true);
  for (const name of ["isig", "icanon"]) sttySetFlag(termios, "lflag", name, true);
}

export function sttyApplyCbreak(termios, enabled) {
  if (enabled) {
    sttySetFlag(termios, "lflag", "icanon", false);
    termios.view.setUint8(TERMIOS_OFFSETS.cc + STTY_CC.min, 1);
    termios.view.setUint8(TERMIOS_OFFSETS.cc + STTY_CC.time, 0);
  } else {
    sttySetFlag(termios, "lflag", "icanon", true);
  }
}

export function sttyApplyPass8(termios, enabled) {
  sttySetFlag(termios, "iflag", "istrip", !enabled);
}

export function sttyApplyLitout(termios, enabled) {
  sttyApplyPass8(termios, enabled);
  sttySetFlag(termios, "oflag", "opost", !enabled);
}

export function sttyApplyNl(termios, enabled) {
  sttySetFlag(termios, "iflag", "icrnl", !enabled);
  sttySetFlag(termios, "oflag", "onlcr", !enabled);
}

export function sttyApplySane(termios) {
  for (const name of ["ignbrk", "parmrk", "inpck", "inlcr", "igncr", "ixoff", "iuclc", "ixany", "iutf8"]) sttySetFlag(termios, "iflag", name, false);
  for (const name of ["brkint", "ignpar", "istrip", "icrnl", "ixon", "imaxbel"]) sttySetFlag(termios, "iflag", name, true);
  for (const name of ["olcuc", "ocrnl", "onocr", "onlret", "ofill", "ofdel"]) sttySetFlag(termios, "oflag", name, false);
  for (const name of ["opost", "onlcr"]) sttySetFlag(termios, "oflag", name, true);
  for (const name of ["parenb", "cstopb", "hupcl", "clocal", "crtscts"]) sttySetFlag(termios, "cflag", name, false);
  sttySetFlag(termios, "cflag", "cs8", true);
  sttySetFlag(termios, "cflag", "cread", true);
  for (const name of ["echonl", "noflsh", "xcase", "tostop", "echoprt", "flusho", "extproc"]) sttySetFlag(termios, "lflag", name, false);
  for (const name of ["isig", "icanon", "iexten", "echo", "echoe", "echok", "echoctl", "echoke"]) sttySetFlag(termios, "lflag", name, true);
  termios.view.setUint8(TERMIOS_OFFSETS.cc + STTY_CC.min, 1);
  termios.view.setUint8(TERMIOS_OFFSETS.cc + STTY_CC.time, 0);
}

export function sttyApplyValueSetting(termios, windowSize, setting, value) {
  if (setting === "ispeed" || setting === "ospeed") {
    sttySetSpeed(termios, parseSttySpeed(value, setting), setting === "ispeed" ? "input" : "output", value);
    return;
  }
  if ((setting === "rows" || setting === "cols" || setting === "columns") && windowSize) {
    if (setting === "rows") windowSize.rows = parseSttyInteger(value, 0xffffn);
    else windowSize.columns = parseSttyInteger(value, 0xffffn);
    return;
  }
  if (setting === "line") {
    termios.view.setUint8(TERMIOS_OFFSETS.line, parseSttyInteger(value, 0xffn));
    return;
  }
  if (setting === "min" || setting === "time") {
    termios.view.setUint8(TERMIOS_OFFSETS.cc + STTY_CC[setting], parseSttyInteger(value, 0xffn));
  } else if (STTY_CONTROL_SETTINGS.has(setting)) {
    termios.view.setUint8(TERMIOS_OFFSETS.cc + STTY_CC[setting], sttyControlValue(value));
  }
}

export function parseSttySpeed(value, setting) {
  const text = String(value);
  if (text === "exta") return 19200;
  if (text === "extb") return 38400;
  const match = text.match(/^\s*\+?(\d+)(?:\.(\d*))?$/);
  if (!match) {
    throw new UsageError(`invalid ${setting} ${localeQuotedEscapedDiagnostic(value)}`, true);
  }
  let speed = BigInt(match[1]);
  const fraction = match[2];
  if (fraction) {
    const first = Number(fraction[0]);
    if (first > 5 || first === 5 && (/[1-9]/.test(fraction.slice(1)) || (speed & 1n) === 1n)) speed++;
  }
  if (speed > 0xffffffffn) {
    throw new UsageError(`invalid ${setting} ${localeQuotedEscapedDiagnostic(value)}`, true);
  }
  return Number(speed);
}

export function sttyBareSpeed(value) {
  try {
    return parseSttySpeed(value, "speed");
  } catch {
    return null;
  }
}

export function parseSttyInteger(value, maximum) {
  const text = String(value);
  const unsigned = text.startsWith("+") ? text.slice(1) : text;
  let parsed;
  if (/^0[xX][0-9a-fA-F]+$/.test(unsigned)) parsed = BigInt(unsigned);
  else if (/^0[0-7]*$/.test(unsigned)) parsed = BigInt(`0o${unsigned.slice(1) || "0"}`);
  else if (/^(?:0|[1-9]\d*)$/.test(unsigned)) parsed = BigInt(unsigned);
  else throw new UsageError(`invalid integer argument: ${localeQuotedEscapedDiagnostic(value)}`);
  if (parsed > maximum) throw new UsageError(`invalid integer argument: ${localeQuotedEscapedDiagnostic(value)}`);
  return Number(parsed);
}

export function sttyControlValue(value) {
  if (value === "") return 0;
  if (value === "undef" || value === "^-") return 0;
  if (value.length === 1) return value.charCodeAt(0) & 0xff;
  if (value.startsWith("^") && value.length >= 2) return value[1] === "?" ? 0x7f : value.charCodeAt(1) & 0x1f;
  return parseSttyInteger(value, 0xffn);
}

const singleCall = defineCommand("stty", sttyCmd, sttyMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
