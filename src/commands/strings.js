#!/usr/bin/env bun
import {defineCommand, runAsMain} from "../shared/command.js";
import {stdout, stderr, UsageError} from "../shared/diagnostics.js";
import {options, last, metaOption, inputBytes, positiveNumber} from "../shared/utility.js";
import {parseObject} from "../shared/object-files.js";
export function strings(args) {
  args = args.map(a => /^-\d+$/.test(a) ? `--bytes=${a.slice(1)}` : a);
  const {opts, operands} = options(
      args, {
        a: "all",
        d: "data",
        f: "filename",
        n: ["min", true],
        t: ["radix", true],
        o: "octal",
        e: ["encoding", true],
        w: "whitespace",
        s: ["separator", true]
      },
      {
        all: "all",
        data: "data",
        "print-file-name": "filename",
        bytes: ["min", true],
        radix: ["radix", true],
        encoding: ["encoding", true],
        "include-all-whitespace": "whitespace",
        "output-separator": ["separator", true]
      });
  const min = positiveNumber(last(opts, "min", 4), "minimum string length"),
        encoding = last(opts, "encoding", "s"),
        radix = last(opts, "radix", opts.octal ? "o" : null);
  if (!Number.isInteger(min)) throw new UsageError("minimum string length must be an integer");
  if (!["s", "S", "b", "l", "B", "L"].includes(encoding)) throw new UsageError("invalid encoding");
  if (radix && !["o", "x", "d"].includes(radix)) throw new UsageError("invalid radix");
  const width = {s: 1, S: 1, b: 2, l: 2, B: 4, L: 4}[encoding], le = ["l", "L"].includes(encoding);
  let status = 0;
  for (const file of operands.length ? operands : ["-"]) try {
      const bytes = inputBytes(file);
      let chunks = [{data: bytes, offset: 0}];
      if (opts.data && !opts.all) {
        try {
          const obj = parseObject(bytes);
          chunks = obj.sections.filter(s => s.alloc && !s.bss);
        } catch {
        }
      }
      for (const chunk of chunks) {
        let text = "", start = 0;
        const flush = () => {
          if (text.length >= min)
            stdout(`${opts.filename ? `${file}: ` : ""}${
                radix ? `${
                            start.toString(
                                     radix === "x"     ? 16 :
                                         radix === "o" ? 8 :
                                                         10)
                                .padStart(7)} ` :
                        ""}${text}${last(opts, "separator", "\n")}`);
          text = "";
        };
        for (let i = 0; i + width <= chunk.data.length; i += width) {
          const c = width === 1 ? chunk.data[i] :
              width === 2       ? (le ? chunk.data.readUInt16LE(i) : chunk.data.readUInt16BE(i)) :
                                  (le ? chunk.data.readUInt32LE(i) : chunk.data.readUInt32BE(i));
          if ((c >= 32 && c <= 126) || c === 9 ||
              (opts.whitespace && [10, 11, 12, 13].includes(c)) || (encoding === "S" && c >= 128)) {
            if (!text) start = chunk.offset + i;
            text += String.fromCodePoint(c);
          } else
            flush();
        }
        flush();
      }
    } catch (error) {
      stderr(`strings: ${file}: ${error.message}\n`);
      status = 1;
    }
  return status;
}
const singleCall = defineCommand("strings", strings, metaOption);
export default singleCall;
if (import.meta.main) await runAsMain(singleCall);
