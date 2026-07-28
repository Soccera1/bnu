#!/usr/bin/env bun

import { VERSION, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function echo(args) {
  if (!process.env.POSIXLY_CORRECT && args.length === 1 && args[0] === "--help") {
    stdout("Usage: echo [SHORT-OPTION]... [STRING]...\n  or:  echo LONG-OPTION\nEcho the STRING(s) to standard output.\n\n  -n     do not output the trailing newline\n  -e     enable interpretation of backslash escapes\n  -E     disable interpretation of backslash escapes (default)\n");
    return 0;
  }
  if (!process.env.POSIXLY_CORRECT && args.length === 1 && args[0] === "--version") {
    stdout(`${VERSION}\n`);
    return 0;
  }
  let interpret = false;
  let newline = true;
  let i = 0;
  if (process.env.POSIXLY_CORRECT) {
    interpret = true;
    if (args[0] === "-n") {
      newline = false;
      i = 1;
      while (i < args.length && /^-[eE]+$/.test(args[i])) i++;
    }
  } else {
    while (i < args.length && /^-[neE]+$/.test(args[i])) {
      for (const ch of args[i].slice(1)) {
        if (ch === "n") newline = false;
        if (ch === "e") interpret = true;
        if (ch === "E") interpret = false;
      }
      i++;
    }
  }
  let text = args.slice(i).join(" ");
  if (interpret) {
    const stop = text.indexOf("\\c");
    if (stop !== -1) {
      text = text.slice(0, stop);
      newline = false;
    }
    text = decodeEchoEscapes(text);
  }
  stdout(text + (newline ? "\n" : ""));
  return 0;
}

export function decodeEchoEscapes(text) {
  return text.replace(/\\(0[0-7]{0,3}|[0-7]{1,3}|x[0-9a-fA-F]{1,2}|[\\abefnrtv])/g, (_, escape) => {
    const simple = { "\\": "\\", a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
    if (simple[escape] != null) return simple[escape];
    if (escape.startsWith("x")) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    const digits = escape.startsWith("0") ? escape.slice(1) : escape;
    return String.fromCharCode(Number.parseInt(digits || "0", 8));
  });
}

const singleCall = defineCommand("echo", echo, (args) => !process.env.POSIXLY_CORRECT && args.length === 1 && (args[0] === "--help" || args[0] === "--version") ? args[0] : null);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
