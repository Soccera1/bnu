#!/usr/bin/env bun
import {readFileSync, writeFileSync, statSync, utimesSync} from "node:fs";
import {defineCommand, runAsMain} from "../shared/command.js";
import {UsageError, stdout, stderr} from "../shared/diagnostics.js";
import {options, last, metaOption} from "../shared/utility.js";
import {transformObject} from "../shared/object-transform.js";
export function strip(args) {
  const {opts, operands} = options(
      args, {
        s: "all",
        g: "debug",
        S: "debug",
        d: "debug",
        p: "preserve",
        o: ["output", true],
        R: ["remove", true],
        N: ["symbols", true],
        v: "verbose"
      },
      {
        "strip-all": "all",
        "strip-debug": "debug",
        "strip-unneeded": "unneeded",
        "preserve-dates": "preserve",
        "only-keep-debug": "onlyDebug",
        "remove-section": ["remove", true],
        "strip-symbol": ["symbols", true],
        output: ["output", true],
        verbose: "verbose"
      });
  if (!operands.length) throw new UsageError("missing file operand", true);
  if (opts.output && operands.length !== 1) throw new UsageError("-o requires a single input file");
  let status = 0;
  for (const file of operands) try {
      const st = statSync(file), out = last(opts, "output", file),
            bytes = transformObject(readFileSync(file), {
              stripAll: !!opts.all ||
                  (!opts.debug && !opts.unneeded && !opts.onlyDebug && !opts.symbols &&
                   !opts.remove),
              stripDebug: !!opts.debug || !!opts.unneeded,
              stripUnneeded: !!opts.unneeded,
              onlyDebug: !!opts.onlyDebug,
              remove: opts.remove,
              stripSymbols: opts.symbols
            });
      writeFileSync(out, bytes, {mode: st.mode});
      if (opts.preserve) utimesSync(out, st.atime, st.mtime);
      if (opts.verbose) stdout(`strip '${file}'\n`);
    } catch (error) {
      stderr(`strip: ${file}: ${error.message}\n`);
      status = 1;
    }
  return status;
}
const singleCall = defineCommand("strip", strip, metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
