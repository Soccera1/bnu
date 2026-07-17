#!/usr/bin/env bun

import { closeSync, openSync } from "node:fs";
import { isWriteError, nodeErrorMessage, parseOptions, readFdChunkViews, systemErrorMessage } from "../shared/common.js";
import { stderr, stdout } from "../shared/diagnostics.js";
import { EXPAND_LONG_OPTIONS, combinedTabSpec, nextTabColumn, normalizeTabArgs, normalizeTabCommandLongOptions, parseTabStops, tabCommandMetaOption } from "../shared/tabs.js";
import { nextUtf8Token, tabFoldDiagnosticName } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function expand(args) {
  args = normalizeTabArgs(normalizeTabCommandLongOptions(args, EXPAND_LONG_OPTIONS));
  const { opts, operands } = parseOptions(args, { short: { t: "value", i: false }, long: { tabs: "value", initial: false, help: false, version: false } });
  const stops = parseTabStops(combinedTabSpec(opts.tabs ?? opts.tab, opts.t), "expand");
  const files = operands.length ? operands : ["-"];
  let failed = false;
  for (const file of files) {
    let fd;
    try {
      fd = file === "-" ? 0 : openSync(file, "r");
      streamExpandFd(fd, stops, opts);
    } catch (error) {
      if (isWriteError(error)) throw error;
      stderr(file === "-" ? `expand: ${nodeErrorMessage(error)}\n` : `expand: ${tabFoldDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      failed = true;
    } finally {
      if (fd != null && fd !== 0) closeSync(fd);
    }
  }
  return failed ? 1 : 0;
}

export function streamExpandFd(fd, stops, opts) {
  let column = 0;
  let atLineStart = true;
  let carry = Buffer.alloc(0);
  readFdChunkViews(fd, (chunk) => {
    const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    carry = Buffer.alloc(0);
    const output = [];
    let runStart = 0;
    let index = 0;
    while (index < bytes.length) {
      const byte = bytes[index];
      if (byte >= 0xc2 && byte <= 0xf4) {
        const length = byte <= 0xdf ? 2 : byte <= 0xef ? 3 : 4;
        if (index + length > bytes.length) {
          if (index > runStart) output.push(bytes.subarray(runStart, index));
          carry = Buffer.from(bytes.subarray(index));
          runStart = bytes.length;
          break;
        }
        const token = nextUtf8Token(bytes, index);
        column += token.width;
        atLineStart = false;
        index = token.next;
        continue;
      }
      if (byte === 0x0a) {
        column = 0;
        atLineStart = true;
        index++;
        continue;
      }
      if (byte === 0x09 && (!(opts.i || opts.initial) || atLineStart)) {
        if (index > runStart) output.push(bytes.subarray(runStart, index));
        const next = nextTabColumn(column, stops);
        output.push(Buffer.alloc(next - column, 0x20));
        column = next;
        index++;
        runStart = index;
        continue;
      }
      if (byte === 0x08) column = Math.max(0, column - 1);
      else column++;
      if (byte !== 0x20) atLineStart = false;
      index++;
    }
    if (runStart < bytes.length && !carry.length) output.push(bytes.subarray(runStart));
    for (const piece of output) stdout(piece);
  });
  if (carry.length) stdout(carry);
}

const singleCall = defineCommand("expand", expand, (args) => tabCommandMetaOption("expand", args));
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
