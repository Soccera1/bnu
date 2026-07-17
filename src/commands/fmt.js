#!/usr/bin/env bun

import { closeSync, openSync, readSync } from "node:fs";
import { decodeSurrogateEscapedBytes, invalidOptionMessage, isWriteError, localeQuotedEscapedDiagnostic, pathDisplayName, readAll, shellEscapeLsName, systemErrorMessage } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { prInputIsNonRegular } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const FMT_LONG_OPTIONS = ["width", "goal", "prefix", "crown-margin", "split-only", "tagged-paragraph", "uniform-spacing", "help", "version"];

export function fmtMetaOption(args) {
  const longValueOptions = new Set(["width", "goal", "prefix"]);
  const shortValueOptions = new Set(["w", "g", "p"]);
  const shortKnownOptions = new Set(["c", "s", "t", "u", "w", "g", "p"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeFmtLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!FMT_LONG_OPTIONS.includes(name)) return null;
      if ((option === "--help" || option === "--version") && inlineValue == null) return option;
      if (inlineValue == null && longValueOptions.has(name)) i++;
      else if (inlineValue != null && !longValueOptions.has(name)) return null;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    if (/^-\d/.test(arg)) continue;
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j];
      if (!shortKnownOptions.has(ch)) return null;
      if (shortValueOptions.has(ch)) {
        if (arg.slice(j + 1) === "") i++;
        break;
      }
    }
  }
  return null;
}

export async function fmtCmd(args) {
  const { opts, operands } = parseFmtOptions(args);
  const widthOption = opts.w ?? opts.width;
  const goalOption = opts.g ?? opts.goal;
  const parsedGoal = goalOption == null ? null : parseFmtWidth(goalOption, "goal", { max: null });
  const width = parseFmtWidth(widthOption ?? (parsedGoal === 0 ? "10" : "75"), "width");
  if (parsedGoal != null && parsedGoal > width) throw new UsageError(`invalid width: ${localeQuotedEscapedDiagnostic(goalOption)}: Value too large for defined data type`);
  const goal = parsedGoal != null ? parsedGoal : Math.max(1, Math.floor(width * 0.93));
  const files = operands.length ? operands : ["-"];
  if (files.length === 1 && fmtCanStream(opts) && prInputIsNonRegular(files[0])) {
    const file = files[0];
    let fd = 0;
    try {
      if (file !== "-") fd = openSync(file, "r");
      streamFmtDefaultFd(fd, width, goal, opts);
      return 0;
    } catch (error) {
      if (isWriteError(error)) throw error;
      const name = shellEscapeLsName(pathDisplayName(file), true);
      const message = error?.code === "EISDIR" ? `error reading ${name}: ${systemErrorMessage(error)}` : `cannot open ${name} for reading: ${systemErrorMessage(error)}`;
      stderr(`fmt: ${message}\n`);
      return 1;
    } finally {
      if (file !== "-" && fd !== 0) closeSync(fd);
    }
  }
  let out = "";
  let failed = false;
  for (const file of files) {
    let text;
    try {
      text = decodeSurrogateEscapedBytes(await readAll(file));
    } catch (error) {
      const name = shellEscapeLsName(pathDisplayName(file), true);
      const message = error?.code === "EISDIR" ? `error reading ${name}: ${systemErrorMessage(error)}` : `cannot open ${name} for reading: ${systemErrorMessage(error)}`;
      stderr(`fmt: ${message}\n`);
      failed = true;
      continue;
    }
    if (opts.p || opts.prefix) out += formatPrefixedText(text, opts.p ?? opts.prefix, width, goal, opts);
    else {
      const paragraphs = text.split(/\n[ \t]*\n/);
      out += paragraphs.map((p) => formatParagraph(p, width, goal, opts)).join("\n\n");
    }
  }
  if (out) stdout(out + (out.endsWith("\n") ? "" : "\n"));
  return failed ? 1 : 0;
}

export function fmtCanStream(opts) {
  return !(opts.p || opts.prefix || opts.c || opts.s || opts.t || opts.u);
}

export function streamFmtDefaultFd(fd, width, goal, opts) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const initial = [];
  let initialLength = 0;
  const threshold = 32 * 1024;
  while (initialLength <= threshold) {
    const n = readSync(fd, buffer, 0, buffer.length, null);
    if (n === 0) {
      const text = decodeSurrogateEscapedBytes(Buffer.concat(initial, initialLength));
      const paragraphs = text.split(/\n[ \t]*\n/);
      const out = paragraphs.map((paragraph) => formatParagraph(paragraph, width, goal, opts)).join("\n\n");
      if (out) stdout(out + (out.endsWith("\n") ? "" : "\n"));
      return;
    }
    initial.push(Buffer.from(buffer.subarray(0, n)));
    initialLength += n;
  }
  const state = createFmtStreamingState(width, goal, opts);
  state.accept(decodeSurrogateEscapedBytes(Buffer.concat(initial, initialLength)));
  while (true) {
    const n = readSync(fd, buffer, 0, buffer.length, null);
    if (n === 0) break;
    state.accept(decodeSurrogateEscapedBytes(buffer.subarray(0, n)));
  }
  state.finish();
}

export function createFmtStreamingState(width, goal, opts) {
  let pendingLine = "";
  let words = [];
  let indent = "";
  let paragraphStarted = false;
  let paragraphEmitted = false;
  let streamingLongWord = false;
  const contentWidth = () => Math.max(1, width - indent.length);
  const contentGoal = () => adjustedFmtGoal(goal, indent.length);
  const writeWrappedLine = (line) => {
    stdout(`${indent}${line}\n`);
    paragraphEmitted = true;
  };
  const consumeFirstWrappedLine = () => {
    const count = takeFmtStreamingLineWords(words, contentWidth(), contentGoal(), explicitFmtGoal(opts));
    writeWrappedLine(renderFmtLine(words.splice(0, count)));
  };
  const flushStableLines = () => {
    while (fmtLineLength(words) > contentWidth() * 10 && words.length > 1) consumeFirstWrappedLine();
  };
  const addLineWords = (line) => {
    if (!paragraphStarted) {
      indent = line.match(/^[ \t]*/)?.[0] ?? "";
      paragraphStarted = true;
    }
    words.push(...wordsForFmt(line, opts));
    flushStableLines();
  };
  const flushParagraph = () => {
    if (streamingLongWord) {
      stdout("\n");
      streamingLongWord = false;
      paragraphEmitted = true;
    }
    if (words.length) {
      const lines = wrapWords(words, contentWidth(), contentGoal(), explicitFmtGoal(opts)).split("\n");
      for (const line of lines) writeWrappedLine(line);
      words = [];
    }
    const hadContent = paragraphStarted || paragraphEmitted;
    indent = "";
    paragraphStarted = false;
    paragraphEmitted = false;
    return hadContent;
  };
  const beginLongWord = () => {
    if (words.length) {
      const lines = wrapWords(words, contentWidth(), contentGoal(), explicitFmtGoal(opts)).split("\n");
      for (const line of lines) writeWrappedLine(line);
      words = [];
    }
    if (!paragraphStarted) paragraphStarted = true;
    stdout(indent);
    stdout(pendingLine);
    pendingLine = "";
    streamingLongWord = true;
  };
  const processCompleteLine = (line) => {
    if (streamingLongWord) {
      if (line) stdout(line);
      stdout("\n");
      streamingLongWord = false;
      paragraphEmitted = true;
      return;
    }
    if (/^[ \t\r\f\v]*$/.test(line)) {
      flushParagraph();
      stdout("\n");
      return;
    }
    addLineWords(line);
  };
  return {
    accept(text) {
      let start = 0;
      for (let index = 0; index < text.length; index++) {
        if (text[index] !== "\n") continue;
        pendingLine += text.slice(start, index);
        processCompleteLine(pendingLine);
        pendingLine = "";
        start = index + 1;
      }
      pendingLine += text.slice(start);
      if (streamingLongWord) {
        stdout(pendingLine);
        pendingLine = "";
      } else if (pendingLine.length >= Math.max(64 * 1024, width * 4) && !/[ \t\r\f\v]/.test(pendingLine)) {
        beginLongWord();
      }
    },
    finish() {
      if (pendingLine || streamingLongWord) {
        if (streamingLongWord) {
          if (pendingLine) stdout(pendingLine);
          pendingLine = "";
        } else addLineWords(pendingLine);
      }
      flushParagraph();
    },
  };
}

export function takeFmtStreamingLineWords(words, width, goal, explicitGoal) {
  if (explicitGoal) return takeFmtLineWords(words, 0, width, goal, true);
  let bestCount = 1;
  let bestCost = Infinity;
  let length = 0;
  for (let index = 0; index < words.length; index++) {
    length += fmtWordLength(words[index]);
    if (index) length += fmtJoinSpaces(words[index - 1]);
    if (index > 0 && length > width) break;
    const overflow = Math.max(0, length - width);
    const under = Math.max(0, goal - length);
    const overGoal = Math.max(0, length - goal);
    const cost = overflow * overflow * 10000 + under * under * 1.95 + overGoal * overGoal * 2;
    if (cost < bestCost || (cost === bestCost && length === width)) {
      bestCost = cost;
      bestCount = index + 1;
    }
    if (length > width) break;
  }
  return bestCount;
}

export function parseFmtOptions(args) {
  args = normalizeFmtLongOptions(args);
  const opts = {};
  const operands = [];
  let sawOption = false;
  const longOptions = [
    ["width", "value", "w"],
    ["goal", "value", "g"],
    ["prefix", "value", "p"],
    ["crown-margin", "flag", "c"],
    ["split-only", "flag", "s"],
    ["tagged-paragraph", "flag", "t"],
    ["uniform-spacing", "flag", "u"],
    ["help", "flag", "help"],
    ["version", "flag", "version"],
  ];
  const resolveLong = (arg) => {
    if (!arg.startsWith("--") || arg === "--") return null;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const value = eq === -1 ? null : body.slice(eq + 1);
    const matches = longOptions.filter(([option]) => option.startsWith(name));
    if (matches.length !== 1) return null;
    const [option, kind, short] = matches[0];
    return { option, kind, short, value, hasInlineValue: eq !== -1 };
  };
  const requireValue = (index, option) => {
    if (index + 1 < args.length) return args[index + 1];
    if (option.startsWith("--")) throw new UsageError(`option '${option}' requires an argument`, true);
    throw new UsageError(`option requires an argument -- '${option.slice(1)}'`, true);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    const long = resolveLong(arg);
    if (long) {
      if (long.kind === "value") {
        opts[long.short] = long.hasInlineValue ? long.value : requireValue(i, `--${long.option}`);
        if (!long.hasInlineValue) i++;
      } else {
        if (long.hasInlineValue) throw new UsageError(`option '--${long.option}' doesn't allow an argument`, true);
        opts[long.short] = true;
      }
      sawOption = true;
      continue;
    }
    if (/^-\d/.test(arg)) {
      if (sawOption) throw new UsageError(`invalid option -- ${arg[1]}; -WIDTH is recognized only when it is the first\noption; use -w N instead`, true);
      opts.w = arg.slice(1);
      sawOption = true;
    }
    else if (/^-w(?:[+-]|\d)/.test(arg)) {
      opts.w = arg.slice(2);
      sawOption = true;
    }
    else if (/^-g(?:[+-]|\d)/.test(arg)) {
      opts.g = arg.slice(2);
      sawOption = true;
    }
    else if (arg.startsWith("-p") && arg.length > 2) {
      opts.p = arg.slice(2);
      sawOption = true;
    }
    else if (arg === "-w" || arg === "--width") {
      opts.w = requireValue(i, arg);
      i++;
      sawOption = true;
    }
    else if (arg.startsWith("--width=")) {
      opts.width = arg.slice("--width=".length);
      sawOption = true;
    }
    else if (arg === "-g" || arg === "--goal") {
      opts.g = requireValue(i, arg);
      i++;
      sawOption = true;
    }
    else if (arg.startsWith("--goal=")) {
      opts.goal = arg.slice("--goal=".length);
      sawOption = true;
    }
    else if (arg === "-p" || arg === "--prefix") {
      opts.p = requireValue(i, arg);
      i++;
      sawOption = true;
    }
    else if (arg.startsWith("--prefix=")) {
      opts.prefix = arg.slice("--prefix=".length);
      sawOption = true;
    }
    else if (arg === "-c" || arg === "--crown-margin") {
      opts.c = true;
      sawOption = true;
    }
    else if (arg === "-s" || arg === "--split-only") {
      opts.s = true;
      sawOption = true;
    }
    else if (arg === "-t" || arg === "--tagged-paragraph") {
      opts.t = true;
      sawOption = true;
    }
    else if (arg === "-u" || arg === "--uniform-spacing") {
      opts.u = true;
      sawOption = true;
    }
    else if (arg.startsWith("-")) throw new UsageError(invalidOptionMessage(arg), true);
    else {
      operands.push(arg);
      sawOption = true;
    }
  }
  return { opts, operands };
}

export function normalizeFmtLongOptions(args, reportAmbiguous = true) {
  const out = [];
  for (const arg of args) {
    if (arg === "--") {
      out.push(arg);
      continue;
    }
    if (!arg.startsWith("--") || arg === "--") {
      out.push(arg);
      continue;
    }
    out.push(normalizeFmtLongOption(arg, reportAmbiguous));
  }
  return out;
}

export function normalizeFmtLongOption(arg, reportAmbiguous = true) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  const matches = FMT_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length === 1) return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
  if (matches.length > 1 && reportAmbiguous) {
    throw new UsageError(`option '${arg}' is ambiguous; possibilities: ${matches.map((option) => `'--${option}'`).join(" ")}`, true);
  }
  return arg;
}

export function parseFmtWidth(value, kind = "width", { max = 2500 } = {}) {
  const raw = String(value);
  if (!/^\+?\d+$/.test(raw)) throw new UsageError(`invalid width: ${localeQuotedEscapedDiagnostic(raw)}`);
  const width = Number(raw);
  if (!Number.isSafeInteger(width) || (max != null && width > max)) {
    const reason = kind === "goal" ? "Value too large for defined data type" : "Numerical result out of range";
    throw new UsageError(`invalid width: ${localeQuotedEscapedDiagnostic(raw)}: ${reason}`);
  }
  return width;
}

export function formatParagraph(paragraph, width, goal, opts) {
  if (opts.s) return paragraph.split(/\n/).map((line) => formatIndentedFmtLine(line, width, goal, opts)).join("\n");
  const leadingNewlines = paragraph.match(/^\n*/)?.[0] ?? "";
  const body = paragraph.slice(leadingNewlines.length);
  if (opts.c) return leadingNewlines + formatCrownMarginParagraph(body, width, goal, opts);
  if (opts.t) return leadingNewlines + formatTaggedParagraph(body, width, goal, opts);
  const indent = body.match(/^[ \t]*/)?.[0] ?? "";
  return leadingNewlines + indent + wrapWords(wordsForFmt(body, opts), Math.max(1, width - indent.length), adjustedFmtGoal(goal, indent.length), explicitFmtGoal(opts)).split("\n").join(`\n${indent}`);
}

export function formatCrownMarginParagraph(body, width, goal, opts) {
  const lines = body.split(/\n/);
  const firstIndent = lines[0]?.match(/^[ \t]*/)?.[0] ?? "";
  const restIndent = lines.find((line, index) => index > 0 && line.trim() !== "")?.match(/^[ \t]*/)?.[0] ?? firstIndent;
  const wrapped = wrapWords(wordsForFmt(body, opts), Math.max(1, width - restIndent.length), adjustedFmtGoal(goal, restIndent.length), explicitFmtGoal(opts)).split("\n");
  if (!wrapped.length) return firstIndent;
  return wrapped.map((line, index) => `${index === 0 ? firstIndent : restIndent}${line}`).join("\n");
}

export function formatTaggedParagraph(body, width, goal, opts) {
  const lines = body.split(/\n/);
  const firstIndent = lines[0]?.match(/^[ \t]*/)?.[0] ?? "";
  const restIndent = lines.find((line, index) => index > 0 && line.trim() !== "")?.match(/^[ \t]*/)?.[0];
  if (restIndent != null && restIndent !== firstIndent) {
    return wrapFmtTaggedWords(wordsForFmt(body, opts), { firstIndent, restIndent, width, goal, explicitGoal: explicitFmtGoal(opts) });
  }
  return lines.map((line) => {
    if (line.trim() === "") return line;
    const indent = line.match(/^[ \t]*/)?.[0] ?? "";
    const words = wordsForFmt(line, opts);
    if (words.length <= 1) return `${indent}${renderFmtLine(words)}`;
    const rest = wrapWords(words.slice(1), width, goal, explicitFmtGoal(opts));
    return `${indent}${words[0].replaceAll("\0", "")}${rest ? `\n${rest}` : ""}`;
  }).join("\n");
}

export function wrapFmtTaggedWords(words, { firstIndent, restIndent, width, goal, explicitGoal }) {
  if (!words.length) return firstIndent;
  const lines = [];
  let index = 0;
  let first = true;
  while (index < words.length) {
    const indent = first ? firstIndent : restIndent;
    const lineWidth = Math.max(1, width - indent.length);
    const lineGoal = adjustedFmtGoal(goal, indent.length);
    const take = takeFmtLineWords(words, index, lineWidth, lineGoal, explicitGoal);
    lines.push(`${indent}${renderFmtLine(words.slice(index, take))}`);
    index = take;
    first = false;
  }
  return lines.join("\n");
}

export function takeFmtLineWords(words, start, width, goal, explicitGoal) {
  let take = start + 1;
  let len = fmtWordLength(words[start]);
  for (let i = start + 1; i < words.length; i++) {
    const nextLen = len + fmtJoinSpaces(words[i - 1]) + fmtWordLength(words[i]);
    if (nextLen > width) break;
    if (explicitGoal && goal > 0 && len >= goal) break;
    len = nextLen;
    take = i + 1;
  }
  return take;
}

export function formatIndentedFmtLine(line, width, goal, opts) {
  const indent = line.match(/^[ \t]*/)?.[0] ?? "";
  return indent + wrapWords(wordsForFmt(line, opts), Math.max(1, width - indent.length), adjustedFmtGoal(goal, indent.length), explicitFmtGoal(opts)).split("\n").join(`\n${indent}`);
}

export function explicitFmtGoal(opts) {
  return opts.g !== undefined || opts.goal !== undefined;
}

export function adjustedFmtGoal(goal, indentLength) {
  return goal === 0 ? 0 : Math.max(1, goal - indentLength);
}

export function wordsForFmt(text, opts) {
  let normalized = String(text).replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
  if (opts.u) normalized = normalized.replace(/[ \t\n\r\f\v]+/g, " ").replace(/([.!?]) (?=\S)/g, "$1  ");
  const words = normalized.split(/[ \t\n\r\f\v]+/).filter(Boolean);
  if (opts.u) return words;
  const sentenceBreaks = [...normalized.matchAll(/(\S+[.!?][)"']*) {2,}(?=\S)/g)].map((match) => match[1]);
  for (let i = 0; i < words.length; i++) {
    if (sentenceBreaks.includes(words[i])) words[i] += "\0";
  }
  return words;
}

export function wrapWords(words, width, goal = width, explicitGoal = false) {
  if (!words.length) return "";
  if (explicitGoal && goal === 0) return wrapWordsZeroGoal(words, width);
  if (explicitGoal) return wrapWordsToGoal(words, width, goal);
  const n = words.length;
  const dp = Array(n + 1).fill(Infinity);
  const next = Array(n).fill(n);
  dp[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    let len = 0;
    for (let j = i; j < n; j++) {
      len += fmtWordLength(words[j]);
      if (j > i) len += fmtJoinSpaces(words[j - 1]);
      if (len > width && j > i) break;
      const overflow = Math.max(0, len - width);
      const under = Math.max(0, goal - len);
      const overGoal = Math.max(0, len - goal);
      const cost = overflow * overflow * 10000 + under * under * 1.95 + overGoal * overGoal * 2 + dp[j + 1];
      const currentLen = fmtLineLength(words.slice(i, next[i]));
      const prefer = cost < dp[i] || (cost === dp[i] && (len === width || (currentLen !== width && len < currentLen)));
      if (prefer) {
        dp[i] = cost;
        next[i] = j + 1;
      }
      if (len > width) break;
    }
  }
  const lines = [];
  for (let i = 0; i < n; i = next[i]) lines.push(renderFmtLine(words.slice(i, next[i])));
  return lines.join("\n");
}

export function wrapWordsZeroGoal(words, width) {
  const totalLen = fmtLineLength(words);
  if (totalLen <= width) return renderFmtLine(words);
  const lines = [];
  let remaining = words.slice();
  while (remaining.length) {
    if (fmtLineLength(remaining) <= width) {
      lines.push(renderFmtLine(remaining));
      break;
    }
    let take = 1;
    if (fmtLineLength(remaining.slice(1)) > width) {
      let len = fmtWordLength(remaining[0]);
      const target = Math.max(1, Math.floor(width / 2));
      while (take < remaining.length - 1 && len < target) {
        len += fmtJoinSpaces(remaining[take - 1]) + fmtWordLength(remaining[take]);
        take++;
      }
    }
    lines.push(renderFmtLine(remaining.slice(0, take)));
    remaining = remaining.slice(take);
  }
  return lines.join("\n");
}

export function wrapWordsToGoal(words, width, goal) {
  const lines = [];
  let line = [];
  let len = 0;
  for (const word of words) {
    const nextLen = line.length ? len + fmtJoinSpaces(line.at(-1)) + fmtWordLength(word) : fmtWordLength(word);
    const initial = /^[A-Z]\.\0?$/.test(word);
    if (line.length && (len >= goal || nextLen > width || (nextLen > goal && len >= goal - 1) || (initial && len >= goal - 3))) {
      lines.push(renderFmtLine(line));
      line = [word];
      len = fmtWordLength(word);
    } else {
      line.push(word);
      len = nextLen;
    }
  }
  if (line.length) lines.push(renderFmtLine(line));
  return lines.join("\n");
}

export function fmtWordLength(word) {
  return word.replaceAll("\0", "").length;
}

export function fmtJoinSpaces(previousWord) {
  return previousWord.endsWith("\0") ? 2 : 1;
}

export function fmtLineLength(words) {
  if (!words.length) return 0;
  let len = 0;
  for (let i = 0; i < words.length; i++) {
    len += fmtWordLength(words[i]);
    if (i) len += fmtJoinSpaces(words[i - 1]);
  }
  return len;
}

export function renderFmtLine(words) {
  let out = "";
  for (let i = 0; i < words.length; i++) {
    if (i) out += " ".repeat(fmtJoinSpaces(words[i - 1]));
    out += words[i].replaceAll("\0", "");
  }
  return out;
}

export function formatPrefixedText(text, prefix, width, goal, opts) {
  const lines = text.split(/(?<=\n)/);
  let out = "";
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const firstBody = group[0].body;
    const lead = firstBody.match(/^\s*/)?.[0] ?? "";
    const words = wordsForFmt(group.map(({ body }) => body).join(" "), opts);
    out += wrapWords(words, Math.max(1, width - prefix.length - lead.length), adjustedFmtGoal(goal, prefix.length + lead.length), explicitFmtGoal(opts))
      .split("\n")
      .map((part) => `${prefix}${lead}${part}`)
      .join("\n");
    if (group.at(-1).hadNewline) out += "\n";
    group = [];
  };
  for (const raw of lines) {
    if (raw === "") continue;
    const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (!line.startsWith(prefix) || line === prefix) {
      flush();
      out += raw;
      continue;
    }
    group.push({ body: line.slice(prefix.length), hadNewline: raw.endsWith("\n") });
  }
  flush();
  return out;
}

const singleCall = defineCommand("fmt", fmtCmd, fmtMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
