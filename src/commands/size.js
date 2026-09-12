#!/usr/bin/env bun
import {defineCommand, runAsMain} from "../shared/command.js";
import {stdout, stderr, UsageError} from "../shared/diagnostics.js";
import {options, last, metaOption} from "../shared/utility.js";
import {objectMembers} from "../shared/object-files.js";
export function size(args) {
  const {opts, operands} = options(
      args, {
        A: "sysv",
        B: "berkeley",
        G: "gnu",
        d: "decimal",
        x: "hex",
        o: "octal",
        t: "totals",
        f: "full"
      },
      {format: ["format", true], radix: ["radix", true], totals: "totals"});
  const format = last(opts, "format", opts.sysv ? "sysv" : opts.gnu ? "gnu" : "berkeley");
  if (opts.full) throw new UsageError("-f section-level summary is not supported; use -A for section sizes");
  if (!["sysv", "gnu", "berkeley"].includes(format))
    throw new UsageError(`invalid format '${format}'`);
  const radix = Number(last(opts, "radix", opts.hex ? 16 : opts.octal ? 8 : 10));
  if (![8, 10, 16].includes(radix)) throw new UsageError("invalid radix");
  const num = n => (radix === 16 ? "0x" : radix === 8 ? "0" : "") + n.toString(radix);
  let status = 0, header = false, totals = [0, 0, 0];
  for (const file of operands.length ? operands : ["a.out"]) try {
      for (const obj of objectMembers(file)) {
        const sections = obj.sections.filter(s => s.alloc),
              text = sections.filter(s => !s.bss && (format === "gnu" ? s.executable : !s.writable)).reduce((n, s) => n + s.size, 0),
              data = sections.filter(s => !s.bss && (format === "gnu" ? !s.executable : s.writable)).reduce((n, s) => n + s.size, 0),
              bss = sections.filter(s => s.bss).reduce((n, s) => n + s.size, 0),
              total = text + data + bss;
        totals = totals.map((n, i) => n + [text, data, bss][i]);
        if (format === "sysv") {
          stdout(`${obj.name}  :\nsection                 size         addr\n`);
          for (const s of obj.sections.filter(
                   s => s.size && ![2, 3, 4, 9, 11].includes(obj.format === "elf" ? s.type : -1)))
            stdout(`${s.name.padEnd(22)} ${num(s.size).padStart(8)} ${num(s.addr).padStart(12)}\n`);
          stdout(`Total                  ${
              num(obj.sections
                      .filter(
                          s => s.size &&
                              ![2, 3, 4, 9, 11].includes(obj.format === "elf" ? s.type : -1))
                      .reduce((n, s) => n + s.size, 0))}\n\n`);
        } else {
          if (!header) {
            stdout(format === "gnu" ? "      text       data        bss      total filename\n" : "   text\t   data\t    bss\t    dec\t    hex\tfilename\n");
            header = true;
          }
          if (format === "gnu") stdout(`${[text, data, bss, total].map(n => num(n).padStart(10)).join(" ")} ${obj.name}\n`);
          else stdout(`${num(text).padStart(7)}\t${num(data).padStart(7)}\t${num(bss).padStart(7)}\t${
              total.toString().padStart(7)}\t${total.toString(16).padStart(7)}\t${obj.name}\n`);
        }
      }
    } catch (error) {
      stderr(`size: ${file}: ${error.message}\n`);
      status = 1;
    }
  if (opts.totals && format !== "sysv") {
    const sum = totals.reduce((a, b) => a + b, 0);
    if (format === "gnu") stdout(`${[...totals, sum].map(n => num(n).padStart(10)).join(" ")} (TOTALS)\n`);
    else stdout(`${totals.map(n => num(n).padStart(7)).join("\t")}\t${sum.toString().padStart(7)}\t${
        sum.toString(16).padStart(7)}\t(TOTALS)\n`);
  }
  return status;
}
const singleCall = defineCommand("size", size, metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
