#!/usr/bin/env bun
import {writeFileSync} from "node:fs";
import {defineCommand, runAsMain} from "../shared/command.js";
import {stderr, UsageError} from "../shared/diagnostics.js";
import {inputBytes, last, options, metaOption} from "../shared/utility.js";
import {assemble} from "../shared/llvm.js";
export function as (args) {
  const {opts, operands} =
      options(args, {o: ["output", true], I: ["include", true], g: "debug", W: "noWarn"}, {
        "32": "32",
        "64": "64",
        target: ["target", true],
        march: ["cpu", true],
        mcpu: ["cpu", true],
        mattr: ["features", true],
        defsym: ["define", true],
        "fatal-warnings": "fatalWarnings",
        "gdwarf-4": "dwarf4",
        "gdwarf-5": "dwarf5"
      });
  let target = last(
      opts, "target",
      `${
          opts["32"]                   ? "i386" :
              process.arch === "arm64" ? "aarch64" :
                                         "x86_64"}-unknown-linux-gnu`);
  if (opts["64"] && opts["32"]) throw new UsageError("--32 and --64 are mutually exclusive");
  if (opts.dwarf4 || opts.dwarf5) throw new UsageError("selecting a DWARF version is not supported; use -g for the LLVM default version");
  if (opts.include)
    throw new UsageError(
        "-I include search paths are not supported; use explicit paths in .include directives");
  let source =
      (operands.length ? operands : ["-"]).map(file => inputBytes(file).toString()).join("\n");
  for (const define of opts.define ?? []) {
    const match = define.match(/^([.$\w]+)=(.+)$/);
    if (!match) throw new UsageError(`invalid symbol definition '${define}'`);
    source = `.set ${match[1]}, ${match[2]}\n${source}`;
  }
  if (opts.debug)
    source = `.file 1 ${JSON.stringify(operands[0] ?? "stdin")}\n.loc 1 1 0\n${source}`;
  const data = assemble(source, target, last(opts, "cpu", "generic"), last(opts, "features", ""), {
    noWarn: Boolean(opts.noWarn), fatalWarnings: Boolean(opts.fatalWarnings), onWarning: text => stderr(`as: warning: ${text}\n`),
  });
  writeFileSync(last(opts, "output", "a.out"), data);
  return 0;
}
const singleCall = defineCommand("as", as, metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
