#!/usr/bin/env bun
import {readFileSync, writeFileSync} from "node:fs";
import {defineCommand, runAsMain} from "../shared/command.js";
import {UsageError} from "../shared/diagnostics.js";
import {options, last, metaOption} from "../shared/utility.js";
import {parseObject} from "../shared/object-files.js";
export function elfedit(args) {
  const long = {};
  for (const direction of ["input", "output"])
    for (const field of ["mach", "type", "osabi", "abiversion"])
      long[`${direction}-${field}`] = [`${direction}-${field}`, true];
  const {opts, operands} = options(args, {}, long);
  if (!operands.length) throw new UsageError("missing file operand", true);
  const maps = {
    mach: {i386: 3, iamcu: 6, x86_64: 62, l1om: 180, k1om: 181, aarch64: 183, arm: 40, riscv: 243},
    type: {none: 0, rel: 1, exec: 2, dyn: 3},
    osabi: {
      none: 0,
      hpux: 1,
      netbsd: 2,
      gnu: 3,
      linux: 3,
      solaris: 6,
      aix: 7,
      irix: 8,
      freebsd: 9,
      openbsd: 12
    }
  };
  const values = {};
  for (const [name, list] of Object.entries(opts)) {
    const field = name.split("-")[1], value = list.at(-1),
          n = maps[field]?.[value] ?? (/^\d+$/.test(value) ? Number(value) : NaN);
    if (!Number.isInteger(n) || n < 0 || n > (["mach", "type"].includes(field) ? 65535 : 255))
      throw new UsageError(`invalid ${field} '${value}'`);
    values[name] = n;
  }
  for (const file of operands) {
    const bytes = readFileSync(file), obj = parseObject(bytes);
    if (obj.format !== "elf") throw new Error(`${file}: not an ELF file`);
    const current =
        {mach: obj.machine, type: obj.type, osabi: obj.osabi, abiversion: obj.abiVersion};
    for (const field of Object.keys(current)) {
      if (values[`input-${field}`] != null && values[`input-${field}`] !== current[field])
        throw new Error(`${file}: unmatched input ${field}`);
      const value = values[`output-${field}`];
      if (value != null) {
        if (field === "mach" || field === "type")
          bytes[obj.le ? "writeUInt16LE" : "writeUInt16BE"](value, field === "mach" ? 18 : 16);
        else
          bytes[field === "osabi" ? 7 : 8] = value;
      }
    }
    writeFileSync(file, bytes);
  }
  return 0;
}
const singleCall = defineCommand("elfedit", elfedit, metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
