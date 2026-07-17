#!/usr/bin/env bun

import { cstr, libc, localeQuotedEscapedDiagnostic, parseOptions } from "../shared/common.js";
import { UsageError } from "../shared/diagnostics.js";
import { ensureSpecialFileCreatable, mknodDiagnosticName, normalizeSpecialFileLongOptions, parseSpecialFileCreationMode, selinuxCreationOptions, setFileMode, specialFileMetaOption, specialFileQuotedName, withSelinuxCreationContext } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function mknodCmd(args) {
  args = normalizeSpecialFileLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { m: "value", Z: false }, long: { mode: "value", context: "optional-value", help: false, version: false } });
  const securityContext = selinuxCreationOptions("mknod", opts);
  const explicitMode = opts.m ?? opts.mode;
  const perm = explicitMode ? parseSpecialFileCreationMode(explicitMode) : 0o666;
  if (!operands.length) throw new UsageError("missing operand", true);
  if (operands.length === 1) throw new UsageError(`missing operand after '${operands[0]}'`, true);
  const [path, type, major, minor] = operands;
  if (type === "p") {
    if (operands.length > 2) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[2])}`, true);
    await withSelinuxCreationContext("mknod", securityContext, async (created) => {
      await ensureSpecialFileCreatable("mknod", path, "fifo");
      if (libc.symbols.mkfifo(cstr(path), perm) !== 0) throw new UsageError(`cannot create fifo ${specialFileQuotedName(path)}: Operation not permitted`);
      if (explicitMode) await setFileMode(path, perm);
      await created(path);
    });
    return 0;
  }
  if (operands.length > 4) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[4])}`, true);
  if (major == null) throw new UsageError(`missing operand after '${type}'\nSpecial files require major and minor device numbers.`, true);
  if (minor == null) throw new UsageError(`missing operand after '${major}'`, true);
  if (type === "b" || type === "c" || type === "u") {
    const majorNumber = parseMknodDeviceNumber(major, "major");
    const minorNumber = parseMknodDeviceNumber(minor, "minor");
    await withSelinuxCreationContext("mknod", securityContext, async (created) => {
      await ensureSpecialFileCreatable("mknod", path, "special file");
      const modeType = type === "b" ? 0o060000 : 0o020000;
      if (libc.symbols.mknod(cstr(path), modeType | perm, makedev(majorNumber, minorNumber)) !== 0) throw new UsageError(`${mknodDiagnosticName(path)}: Operation not permitted`);
      await created(path);
    });
    return 0;
  }
  throw new UsageError(`invalid device type ${localeQuotedEscapedDiagnostic(type)}`, true);
}

export function parseMknodDeviceNumber(value, kind) {
  const text = String(value);
  let digits;
  let base;
  if (/^0[xX][0-9A-Fa-f]+$/.test(text)) {
    digits = text.slice(2);
    base = 16n;
  } else if (/^0[0-7]*$/.test(text)) {
    digits = text;
    base = 8n;
  } else if (/^[1-9][0-9]*$/.test(text)) {
    digits = text;
    base = 10n;
  } else {
    throw new UsageError(`invalid ${kind} device number ${localeQuotedEscapedDiagnostic(value)}`);
  }
  let number = 0n;
  for (const ch of digits) {
    number = number * base + BigInt(Number.parseInt(ch, Number(base)));
    if (number > 0xffffffffn) throw new UsageError(`invalid ${kind} device number ${localeQuotedEscapedDiagnostic(value)}`);
  }
  return number;
}

export function makedev(major, minor) {
  return Number(((major & 0xfffn) << 8n) | (minor & 0xffn) | ((minor & ~0xffn) << 12n) | ((major & ~0xfffn) << 32n));
}

const singleCall = defineCommand("mknod", mknodCmd, (args) => specialFileMetaOption("mknod", args));
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
