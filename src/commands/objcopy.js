#!/usr/bin/env bun
import {readFileSync, writeFileSync, statSync, utimesSync} from "node:fs";
import {defineCommand, runAsMain} from "../shared/command.js";
import {UsageError, stdout} from "../shared/diagnostics.js";
import {options, last, metaOption} from "../shared/utility.js";
import {parseObject} from "../shared/object-files.js";
import {transformObject, binaryToElf} from "../shared/object-transform.js";
export function objcopy(args) {
  const {opts, operands} = options(
      args, {
        I: ["inputTarget", true],
        O: ["outputTarget", true],
        B: ["architecture", true],
        j: ["only", true],
        R: ["remove", true],
        S: "stripAll",
        g: "stripDebug",
        d: "stripDebug",
        K: ["keepSymbols", true],
        N: ["stripSymbols", true],
        p: "preserve",
        v: "verbose"
      },
      {
        "input-target": ["inputTarget", true],
        "output-target": ["outputTarget", true],
        "binary-architecture": ["architecture", true],
        "only-section": ["only", true],
        "remove-section": ["remove", true],
        "strip-all": "stripAll",
        "strip-debug": "stripDebug",
        "strip-unneeded": "stripUnneeded",
        "only-keep-debug": "onlyDebug",
        "keep-symbol": ["keepSymbols", true],
        "strip-symbol": ["stripSymbols", true],
        "preserve-dates": "preserve",
        "add-section": ["add", true],
        "update-section": ["update", true],
        "dump-section": ["dump", true],
        "rename-section": ["rename", true],
        "gap-fill": ["gapFill", true],
        verbose: "verbose"
      });
  if (operands.length < 1 || operands.length > 2)
    throw new UsageError("expected input file and optional output file", true);
  const [input, output = input] = operands, bytes = readFileSync(input), st = statSync(input),
                         config = {
                           stripAll: !!opts.stripAll,
                           stripDebug: !!opts.stripDebug,
                           stripUnneeded: !!opts.stripUnneeded,
                           onlyDebug: !!opts.onlyDebug,
                           only: opts.only,
                           remove: opts.remove,
                           stripSymbols: opts.stripSymbols,
                           outputTarget: last(opts, "outputTarget"),
                           gapFill: Number(last(opts, "gapFill", 0))
                         };
  if (opts.keepSymbols) throw new UsageError("--keep-symbol is not yet supported");
  if (opts.architecture) {
    const architecture = last(opts, "architecture"), target = last(opts, "outputTarget", "elf64-x86-64");
    if (last(opts, "inputTarget") !== "binary") throw new UsageError("--binary-architecture requires --input-target=binary");
    const expected = { "elf64-x86-64": ["i386:x86-64", "x86-64"], "elf32-i386": ["i386"], "elf64-littleaarch64": ["aarch64"] }[target] ?? [];
    if (!expected.includes(architecture)) throw new UsageError(`binary architecture '${architecture}' does not match output target '${target}'`);
  }
  const inputTarget = last(opts, "inputTarget");
  if (inputTarget && inputTarget !== "binary") {
    const object = parseObject(bytes);
    const matches = inputTarget === object.target || (object.format === "elf" && object.le && ((inputTarget === "elf64-x86-64" && object.arch === "x86-64" && object.bits === 64) || (inputTarget === "elf32-i386" && object.arch === "i386" && object.bits === 32) || (inputTarget === "elf64-littleaarch64" && object.arch === "aarch64" && object.bits === 64)));
    if (!matches) throw new UsageError(`input file does not match target '${inputTarget}'`);
  }
  if (!Number.isInteger(config.gapFill) || config.gapFill < 0 || config.gapFill > 255) throw new UsageError("--gap-fill must be a byte value from 0 to 255");
  for (const key of ["add", "update", "rename"]) {
    config[key] = new Map();
    for (const spec of opts[key] ?? []) {
      const eq = spec.indexOf("=");
      if (eq < 1) throw new UsageError(`bad section specification '${spec}'`);
      config[key].set(
          spec.slice(0, eq),
          key === "rename" ? spec.slice(eq + 1) : readFileSync(spec.slice(eq + 1)));
    }
  }
  for (const spec of opts.dump ?? []) {
    const eq = spec.indexOf("=");
    if (eq < 1) throw new UsageError(`bad section specification '${spec}'`);
    const obj = parseObject(bytes), section = obj.sections.find(s => s.name === spec.slice(0, eq));
    if (!section) throw new Error(`section '${spec.slice(0, eq)}' does not exist`);
    writeFileSync(spec.slice(eq + 1), section.data);
  }
  let result;
  if (last(opts, "inputTarget") === "binary") {
    const target = last(opts, "outputTarget", "elf64-x86-64");
    if (!["elf64-x86-64", "elf32-i386", "elf64-littleaarch64"].includes(target))
      throw new Error(`unsupported binary output target '${target}'`);
    result = binaryToElf(bytes, input, target);
  } else
    result = transformObject(bytes, config);
  writeFileSync(output, result, {mode: st.mode});
  if (opts.preserve) utimesSync(output, st.atime, st.mtime);
  if (opts.verbose) stdout(`copy from '${input}' to '${output}'\n`);
  return 0;
}
const singleCall = defineCommand("objcopy", objcopy, metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
