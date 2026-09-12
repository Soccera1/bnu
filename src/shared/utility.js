import {readFileSync} from "node:fs";

import {UsageError} from "./diagnostics.js";

export function metaOption(args) {
  return args.length === 1 && ["--help", "--version"].includes(args[0]) ? args[0] : null;
}

// A small strict getopt parser. Values are arrays so repeated options retain order.
export function options(args, short = {}, long = {}) {
  const opts = {}, operands = [];
  const put = (name, value) => (opts[name] ??= []).push(value);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("="), name = arg.slice(2, eq < 0 ? undefined : eq);
      if (!Object.hasOwn(long, name)) throw new UsageError(`unrecognized option '--${name}'`, true);
      const [key, takesValue] = Array.isArray(long[name]) ? long[name] : [long[name], false];
      if (!takesValue && eq >= 0)
        throw new UsageError(`option '--${name}' doesn't allow an argument`, true);
      const value = takesValue ? eq >= 0 ? arg.slice(eq + 1) : args[++i] : true;
      if (value == null) throw new UsageError(`option '--${name}' requires an argument`, true);
      put(key, value);
    } else {
      for (let j = 1; j < arg.length; j++) {
        const ch = arg[j];
        if (!Object.hasOwn(short, ch)) throw new UsageError(`invalid option -- '${ch}'`, true);
        const [key, takesValue] = Array.isArray(short[ch]) ? short[ch] : [short[ch], false];
        const value = takesValue ? arg.slice(j + 1) || args[++i] : true;
        if (value == null) throw new UsageError(`option requires an argument -- '${ch}'`, true);
        put(key, value);
        if (takesValue) break;
      }
    }
  }
  return {opts, operands};
}
export const last = (opts, key, fallback) => opts[key]?.at(-1) ?? fallback;
export function inputBytes(file = "-") {
  return readFileSync(file === "-" ? 0 : file);
}
export function positiveNumber(value, name, allowZero = false) {
  const n = Number(value);
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0))
    throw new UsageError(`invalid ${name}: '${value}'`, true);
  return n;
}
