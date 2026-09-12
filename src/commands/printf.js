#!/usr/bin/env bun

import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";
import { PRINTF_STOP, formatPrintf, formatPrintfResult, validatePrintfFormat, encodePrintfOutput, parsePrintfConversion, parsePrintfEscape } from "../shared/printf.js";

// Preserve the formatting exports for existing API consumers.
export * from "../shared/printf.js";

export async function printfCmd(args) {
  if (args[0] === "--") args = args.slice(1);
  if (!args.length) throw new UsageError("missing operand", true);
  const [format, ...values] = args;
  const validation = validatePrintfFormat(format);
  if (!validation.ok) {
    stderr(`${validation.message}\n`);
    return 1;
  }
  const streamedStatus = streamLargeSimplePrintf(format, values);
  if (streamedStatus != null) return streamedStatus;
  let out = "";
  let stop = false;
  const warnings = [];
  const append = (text) => {
    const idx = text.indexOf(PRINTF_STOP);
    if (idx === -1) {
      out += text;
      return;
    }
    out += text.slice(0, idx);
    stop = true;
  };
  if (!values.length) append(formatPrintf(format, [], warnings));
  else if (countPrintfConversions(format) === 0) {
    append(formatPrintf(format, [], warnings));
    warnings.push(`printf: warning: ignoring excess arguments, starting with '${values[0]}'`);
  }
  else {
    let status = 0;
    for (let i = 0; i < values.length && !stop;) {
      const before = i;
      const rendered = formatPrintfResult(format, values.slice(i), warnings);
      status ||= rendered.status;
      append(rendered.text);
      i += Math.max(1, rendered.consumed);
      if (i === before) break;
    }
    if (warnings.length) stderr(`${warnings.join("\n")}\n`);
    stdout(encodePrintfOutput(out));
    return status;
  }
  if (warnings.length) stderr(`${warnings.join("\n")}\n`);
  stdout(encodePrintfOutput(out));
  return 0;
}

export function streamLargeSimplePrintf(format, values) {
  if (!format.startsWith("%")) return null;
  const conversion = parsePrintfConversion(format, 0);
  if (conversion.invalid || conversion.percent || conversion.length !== format.length || conversion.index != null) return null;
  if (conversion.width?.star || conversion.precision?.star) return null;
  const width = Number(conversion.width?.value);
  if (!Number.isSafeInteger(width) || width < 1024 * 1024 || conversion.flags?.includes("0")) return null;
  const precision = conversion.precision?.value;
  const coreFormat = `%${conversion.flags ?? ""}${precision == null ? "" : `.${precision}`}${conversion.type}`;
  const warnings = [];
  let status = 0;
  let index = 0;
  const iterations = values.length ? Infinity : 1;
  for (let iteration = 0; iteration < iterations && (values.length === 0 ? iteration === 0 : index < values.length); iteration++) {
    const rendered = formatPrintfResult(coreFormat, values.slice(index), warnings);
    status ||= rendered.status;
    if (rendered.fatal) break;
    const padding = Math.max(0, width - rendered.text.length);
    if (conversion.flags?.includes("-")) {
      stdout(encodePrintfOutput(rendered.text));
      writePrintfPadding(padding, 0x20);
    } else {
      writePrintfPadding(padding, 0x20);
      stdout(encodePrintfOutput(rendered.text));
    }
    if (!values.length) break;
    index += Math.max(1, rendered.consumed);
  }
  if (warnings.length) stderr(`${warnings.join("\n")}\n`);
  return status;
}

export function writePrintfPadding(length, byte) {
  if (length <= 0) return;
  const block = Buffer.alloc(Math.min(64 * 1024, length), byte);
  let remaining = length;
  while (remaining > 0) {
    const count = Math.min(block.length, remaining);
    stdout(count === block.length ? block : block.subarray(0, count));
    remaining -= count;
  }
}

export function countPrintfConversions(format) {
  let count = 0;
  for (let i = 0; i < format.length;) {
    if (format[i] === "\\") {
      i += parsePrintfEscape(format, i).length;
    } else if (format[i] === "%") {
      const conv = parsePrintfConversion(format, i);
      if (!conv.percent && !conv.invalid) count++;
      i += conv.length || 1;
    } else {
      i++;
    }
  }
  return count;
}

const singleCall = defineCommand("printf", printfCmd, (args) => args.length === 1 && (args[0] === "--help" || args[0] === "--version") ? args[0] : null);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
