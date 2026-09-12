#!/usr/bin/env bun
import {readFileSync, writeFileSync} from "node:fs";
import {defineCommand, runAsMain} from "../shared/command.js";
import {UsageError} from "../shared/diagnostics.js";
import {options, metaOption} from "../shared/utility.js";
import {parseAr, encodeAr} from "../shared/object-files.js";
export function ranlib(args) {
  const {opts, operands} = options(args, {D: "deterministic", U: "nondeterministic", t: "touch"});
  if (!operands.length) throw new UsageError("missing archive operand", true);
  for (const file of operands) {
    const bytes=readFileSync(file),members=parseAr(bytes);
    if(opts.touch) {
      const index=members.find(m=>m.special && m.name!=="//");
      if(!index)throw new Error(`${file}: no archive map to update`);
      const value=String(opts.deterministic?0:Math.floor(Date.now()/1000)).padEnd(12);
      bytes.write(value,index.offset+16,12,"ascii");writeFileSync(file,bytes);
    } else writeFileSync(file,encodeAr(members.filter(m=>!m.special),true,!opts.nondeterministic));
  }
  return 0;
}
const singleCall = defineCommand("ranlib", ranlib, metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
