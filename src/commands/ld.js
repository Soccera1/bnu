#!/usr/bin/env bun
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineCommand, runAsMain } from "../shared/command.js";
import { helpVersionOnlyMetaOption } from "../shared/common.js";
import { stderr, stdout, UsageError } from "../shared/diagnostics.js";
import { linkObjects } from "../shared/object-linker.js";

const formats = value => {
  if (/elf|^aarch64linux$/i.test(value)) return "elf";
  if (/^(?:pei?|i386pep|arm64pe)/i.test(value)) return "pe";
  if (/mach/i.test(value)) return "macho";
  throw new UsageError(`unsupported output format or emulation '${value}'`);
};
const architecture = value => /aarch64|arm64/i.test(value) ? "aarch64" : /x86.?64|amd64|i386pep/i.test(value) ? "x86-64" : null;

export async function ldCmd(args) {
  const inputs = [], libraryPaths = ["."], options = { undefined: [] };
  let output = "a.out", wholeArchive = false, mapFile, printMap = false, end = false;
  const value = (index, inline, option) => {
    const result = inline || args[index + 1];
    if (result === undefined) throw new UsageError(`option '${option}' requires an argument`, true);
    return [result, inline ? index : index + 1];
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (end || !arg.startsWith("-") || arg === "-") { inputs.push({ path: arg, wholeArchive }); continue; }
    if (arg === "--") { end = true; continue; }
    if (["-static", "--static", "-Bstatic", "--no-dynamic-linker", "--no-undefined"].includes(arg)) continue;
    if (arg === "--whole-archive") { wholeArchive = true; continue; }
    if (arg === "--no-whole-archive") { wholeArchive = false; continue; }
    if (["-s", "--strip-all"].includes(arg)) { options.strip = true; continue; }
    if (["-S", "--strip-debug"].includes(arg)) continue; // Executable output already omits debug sections.
    if (["-M", "--print-map"].includes(arg)) { printMap = true; continue; }
    if (["-v", "--verbose"].includes(arg)) { stdout("BNU native static linker: ELF, PE/COFF and Mach-O; x86-64 and AArch64\n"); if (args.length === 1) return 0; continue; }
    if (["-r", "--relocatable", "-shared", "--shared", "-pie", "--pie", "-dynamic", "-Bdynamic"].includes(arg)) throw new UsageError(`${arg}: only static executable linking is supported`);
    let name, inline;
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("="); name = arg.slice(2, equal < 0 ? undefined : equal); inline = equal < 0 ? "" : arg.slice(equal + 1);
    } else if (["-arch", "-Map", "-entry", "-oformat", "-image_base", "-subsystem", "-stack"].includes(arg)) { name = arg.slice(1); inline = ""; }
    else if (arg.startsWith("-Map=")) { name = "Map"; inline = arg.slice(5); }
    else { name = ({ o: "output", e: "entry", L: "library-path", l: "library", m: "emulation", u: "undefined" })[arg[1]]; inline = arg.slice(2); }
    if (!name || !["output", "entry", "library-path", "library", "emulation", "oformat", "arch", "image-base", "image_base", "subsystem", "stack", "undefined", "Map", "map"].includes(name)) throw new UsageError(`unrecognized or unsupported option '${arg}'`, true);
    let parameter; [parameter, index] = value(index, inline, arg);
    if (name === "output") output = parameter;
    else if (name === "entry") options.entry = parameter;
    else if (name === "library-path") libraryPaths.push(parameter);
    else if (name === "library") {
      const candidates = parameter.startsWith(":") ? [parameter.slice(1)] : [`lib${parameter}.a`, `${parameter}.lib`];
      const file = libraryPaths.flatMap(directory => candidates.map(candidate => join(directory, candidate))).find(candidate => existsSync(candidate));
      if (!file) throw new UsageError(`cannot find -l${parameter}`);
      inputs.push({ path: file, wholeArchive });
    } else if (name === "emulation" || name === "oformat") {
      options.format = formats(parameter); options.arch = architecture(parameter) ?? options.arch;
    } else if (name === "arch") {
      const arch = architecture(parameter);
      if (!arch) throw new UsageError(`unsupported architecture '${parameter}'`);
      options.arch = arch;
    } else if (name === "image-base" || name === "image_base" || name === "stack") {
      if (!/^(?:0x[\da-f]+|\d+)$/i.test(parameter)) throw new UsageError(`invalid numeric value '${parameter}'`);
      options[name === "stack" ? "stackSize" : "imageBase"] = BigInt(parameter);
    } else if (name === "subsystem") {
      const subsystems = { native: 1, windows: 2, console: 3, posix: 7, "efi-app": 10, "efi_application": 10 };
      options.subsystem = subsystems[parameter] ?? (/^\d+$/.test(parameter) ? Number(parameter) : null);
      if (options.subsystem === null || options.subsystem > 65535) throw new UsageError(`invalid subsystem '${parameter}'`);
    } else if (name === "undefined") options.undefined.push(parameter);
    else mapFile = parameter;
  }
  if (!inputs.length) throw new UsageError("no input files", true);
  try {
    const result = linkObjects(inputs, options);
    writeFileSync(output, result.bytes); chmodSync(output, 0o777 & ~process.umask());
    if (mapFile) writeFileSync(mapFile, result.map);
    if (printMap) stdout(result.map);
    return 0;
  } catch (error) { stderr(`ld: ${error.message}\n`); return 1; }
}

const command = defineCommand("ld", ldCmd, helpVersionOnlyMetaOption);
export default command;
if (import.meta.main) await runAsMain(command);
