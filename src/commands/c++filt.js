#!/usr/bin/env bun
import {defineCommand, runAsMain} from "../shared/command.js";
import {stdout, UsageError} from "../shared/diagnostics.js";
import {options, last, metaOption, inputBytes} from "../shared/utility.js";
import {demangle} from "../shared/llvm.js";
export function cppfilt(args) {
  const {opts, operands} = options(
      args,
      {n: "noStrip", _: "strip", p: "noParams", t: "types", s: ["format", true], i: "noVerbose"}, {
        "no-strip-underscore": "noStrip",
        "strip-underscore": "strip",
        "no-params": "noParams",
        types: "types",
        format: ["format", true],
        "no-verbose": "noVerbose"
      });
  if (!["auto", "gnu-v3"].includes(last(opts, "format", "auto")))
    throw new UsageError("supported demangling formats: auto, gnu-v3");
  if (opts.noVerbose) throw new UsageError("--no-verbose demangling is not supported");
  const convert = text => {
    if ((!opts.strip || opts.noStrip) && text.startsWith("__Z")) return text;
    const input = opts.strip && text.startsWith("_") ? text.slice(1) : text;
    let output = demangle(input, !!opts.types);
    if (opts.noParams && output !== input) {
      let templates = 0;
      for (let at = 0; at < output.length; at++) {
        if (output[at] === "<" && !/operator<*$/.test(output.slice(0, at))) templates++;
        else if (output[at] === ">") templates = Math.max(0, templates - 1);
        else if (output[at] === "(" && templates === 0) {
          if (output.slice(0, at).endsWith("operator") && output[at + 1] === ")") { at++; continue; }
          output = output.slice(0, at); break;
        }
      }
    }
    return output;
  };
  if (operands.length)
    for (const name of operands) stdout(`${convert(name)}\n`);
  else
    stdout(inputBytes().toString().replace(/[$.\w]+/g, convert));
  return 0;
}
const singleCall = defineCommand("c++filt", cppfilt, metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
