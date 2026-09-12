#!/usr/bin/env bun
import { InvocationError } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";
import { textMeta, textRead, textUnescape } from "../shared/text-tools.js";
import { AwkParser } from "../shared/awk-parser.js";
import { AwkRuntime } from "../shared/awk-runtime.js";

export async function awk(args) {
  const sources = [], assignments = {}, operands = []; let fs, stopped = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (stopped) { operands.push(arg); continue; }
    if (arg === "--") { stopped = true; continue; }
    if (arg === "--posix" || arg === "--traditional" || arg === "--characters-as-bytes") continue;
    const short = arg.match(/^-([Fvfe])(.*)$/s), long = arg.match(/^--(field-separator|assign|file|source)(?:=(.*))?$/s);
    if (short || long) {
      const option = short?.[1] ?? ({"field-separator":"F",assign:"v",file:"f",source:"e"})[long[1]];
      const value = (short ? short[2] || args[++i] : long[2] ?? args[++i]);
      if (value == null) throw new InvocationError(`option '${arg}' requires an argument`,2,true);
      if (option === "F") fs = textUnescape(value);
      else if (option === "v") { const m = value.match(/^([A-Za-z_]\w*)=(.*)$/s); if (!m) throw new InvocationError(`invalid assignment '${value}'`,2,false); assignments[m[1]] = textUnescape(m[2]); }
      else sources.push(option === "f" ? await textRead(value) : value);
      continue;
    }
    if (arg.startsWith("-" ) && arg !== "-") throw new InvocationError(`unrecognized option '${arg}'`,2,true);
    if (!sources.length) sources.push(arg); else operands.push(arg);
    stopped = true;
  }
  if (!sources.length) throw new InvocationError("missing program",2,true);
  const program = new AwkParser(sources.join("\n")).program();
  return new AwkRuntime(program,operands,assignments,fs).run();
}
const singleCall = defineCommand("awk",awk,(args) => textMeta(args,{valueShort:"Fvfe",valueLong:["field-separator","assign","file","source"],stopAtOperand:true}));
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
