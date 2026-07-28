import { localeQuotedDiagnostic, localeQuotedEscapedDiagnostic } from "./common.js";
import { UsageError } from "./diagnostics.js";

export const EXPAND_LONG_OPTIONS = ["tabs", "initial", "help", "version"];

export const UNEXPAND_LONG_OPTIONS = ["tabs", "all", "first-only", "help", "version"];

export function tabCommandMetaOption(program, args) {
  const longOptions = program === "expand" ? EXPAND_LONG_OPTIONS : UNEXPAND_LONG_OPTIONS;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeTabCommandLongOption(arg, longOptions);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!longOptions.includes(name)) return null;
      if (inlineValue != null) {
        if (name !== "tabs") return null;
        validateTabMetaOptionValue(program, inlineValue);
      }
      if (option === "--help" || option === "--version") return option;
      if (name === "tabs" && inlineValue == null) {
        validateTabMetaOptionValue(program, args[i + 1]);
        i++;
      }
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    if (/^-\d[\d,\s]*$/.test(arg)) continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (program === "expand" && ch === "i") continue;
      if (program === "unexpand" && ch === "a") continue;
      if (ch !== "t") return null;
      const value = arg.slice(j + 1) || args[i + 1];
      validateTabMetaOptionValue(program, value);
      if (!arg.slice(j + 1)) i++;
      break;
    }
  }
  return null;
}

export function validateTabMetaOptionValue(program, value) {
  try {
    parseTabStops(value, program);
  } catch (error) {
    if (error instanceof UsageError && ["tab size cannot be 0", "tab sizes must be ascending"].includes(error.message)) return;
    throw error;
  }
}

export function normalizeTabCommandLongOptions(args, longOptions) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeTabCommandLongOption(arg, longOptions));
  }
  return out;
}

export function normalizeTabCommandLongOption(arg, longOptions) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const optionNames = name === "tab" || "tabs".startsWith(name) ? ["tabs"] : longOptions.filter((option) => option.startsWith(name));
  if (optionNames.length !== 1) return arg;
  return eq === -1 ? `--${optionNames[0]}` : `--${optionNames[0]}=${body.slice(eq + 1)}`;
}

export function parseTabStops(value = "8", program = null) {
  const text = String(value).replace(/^["']|["']$/g, "").trim();
  if (text === "" || text === "," || text === "/" || text === "+") return [8];
  const parts = text.split(/[,\t ]+/).filter(Boolean);
  const diagnostics = [];
  let interval = null;
  let intervalMode = null;
  let zeroInterval = false;
  const numbers = [];
  let previous = 0;
  for (let index = 0; index < parts.length; index++) {
    let part = parts[index];
    if (part === "/" || part === "+") continue;
    if (part.includes("/") && !part.startsWith("/") && !part.startsWith("+/")) throw new UsageError("'/' specifier not at start of number: '/'");
    const matchedInterval = /^[/+]+(?=\/?\d)/.test(part);
    if (matchedInterval && part.startsWith("/") && index !== parts.length - 1) throw new UsageError("'/' specifier only allowed with the last value");
    part = part.replace(/^[/+]+(?=\/?\d)/, (prefix) => {
      intervalMode = prefix.includes("+") ? "+" : "/";
      return "";
    }).replace(/^\//, "");
    if (!/^\d+$/.test(part)) {
      const leadingDigits = part.match(/^\d+/)?.[0] ?? "";
      if (leadingDigits !== "" && Number(leadingDigits) > Number.MAX_SAFE_INTEGER) diagnostics.push(`tab stop is too large ${localeQuotedDiagnostic(leadingDigits)}`);
      const invalid = invalidTabSizeCharacters(part);
      if (diagnostics.length) {
        diagnostics.push(`tab size contains invalid character(s): ${localeQuotedEscapedDiagnostic(invalid)}`);
        continue;
      }
      throw new UsageError(`tab size contains invalid character(s): ${localeQuotedEscapedDiagnostic(invalid)}`);
    }
    const n = Number(part);
    if (n === 0) {
      if (matchedInterval) {
        zeroInterval = true;
        continue;
      }
      throw new UsageError("tab size cannot be 0");
    }
    if (n > Number.MAX_SAFE_INTEGER) {
      diagnostics.push(`tab stop is too large ${localeQuotedDiagnostic(part)}`);
      continue;
    }
    if (matchedInterval) interval = n;
    else {
      if (n <= previous) throw new UsageError("tab sizes must be ascending");
      numbers.push(n);
      previous = n;
    }
  }
  if (diagnostics.length) throw new UsageError(formatTabDiagnostics(diagnostics, program));
  const stops = numbers.length ? numbers : interval ? [interval] : zeroInterval ? [8] : [];
  if (interval) {
    stops.interval = interval;
    stops.intervalMode = intervalMode;
  }
  if (!stops.length || stops.some((n) => !Number.isInteger(n) || n <= 0)) throw new UsageError(`invalid tab size: ${value}`);
  return stops;
}

export function formatTabDiagnostics(diagnostics, program = null) {
  if (diagnostics.length <= 1 || !program) return diagnostics.join("\n");
  return diagnostics.map((message, index) => index === 0 ? message : `${program}: ${message}`).join("\n");
}

export function invalidTabSizeCharacters(part) {
  const stripped = String(part).replace(/^[+/]?\d*/, "").replace(/^[+/]/, "");
  return stripped || String(part);
}

export function normalizeTabArgs(args) {
  const out = [];
  const obsolete = [];
  const shortTabs = [];
  let scanning = true;
  const requireValue = (index, option) => {
    if (index + 1 < args.length) return args[index + 1];
    throw new UsageError(`option requires an argument -- '${option.slice(1)}'`, true);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (scanning && /^-\d[\d,\s]*$/.test(arg)) obsolete.push(arg.slice(1));
    else if (arg === "-t") {
      shortTabs.push(requireValue(i, arg));
      i++;
      scanning = false;
    } else if (/^-t.+/.test(arg)) {
      shortTabs.push(arg.slice(2));
      scanning = false;
    }
    else if (arg === "-a" || arg === "--all" || arg === "--first-only" || arg === "-i" || arg === "--initial") {
      out.push(arg);
    }
    else {
      scanning = false;
      out.push(arg);
    }
  }
  const tabSpecs = [...obsolete, ...shortTabs];
  return tabSpecs.length ? ["-t", tabSpecs.join(","), ...out] : out;
}

export function combinedTabSpec(longSpec, shortSpec) {
  if (longSpec != null && shortSpec != null) return `${longSpec},${shortSpec}`;
  return shortSpec ?? longSpec;
}

export function nextTabColumn(column, stops) {
  if (stops.length === 1 && !stops.interval) return column + (stops[0] - (column % stops[0]));
  for (const stop of stops) if (stop > column) return stop;
  if (stops.interval) {
    if (stops.intervalMode === "+" && stops.length) {
      const base = stops.at(-1);
      return base + Math.ceil((column + 1 - base) / stops.interval) * stops.interval;
    }
    return column + (stops.interval - (column % stops.interval));
  }
  return column + 1;
}
