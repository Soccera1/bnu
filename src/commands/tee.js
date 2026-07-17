#!/usr/bin/env bun

import { readSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { localeQuotedDiagnostic, localeQuotedEscapedDiagnostic, parseOptions, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr } from "../shared/diagnostics.js";
import { POLLERR, POLLHUP, POLLNVAL, POLLOUT, pollFd } from "../shared/text.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const TEE_LONG_OPTIONS = ["append", "ignore-interrupts", "output-error", "help", "version"];

export function teeMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeTeeLongOption(arg);
      const [name, inlineValue] = option.slice(2).split(/=(.*)/s, 2);
      if (!TEE_LONG_OPTIONS.includes(name)) return null;
      if (inlineValue != null) {
        if (name !== "output-error") return null;
        validateTeeOutputError({ "output-error": inlineValue });
      }
      if (option === "--help" || option === "--version") return option;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) if (arg[j] !== "a" && arg[j] !== "i" && arg[j] !== "p") return null;
  }
  return null;
}

export function normalizeTeeLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeTeeLongOption(arg));
  }
  return out;
}

export function normalizeTeeLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const matches = TEE_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length !== 1) return arg;
  return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
}

export async function tee(args) {
  const { opts, operands } = parseOptions(normalizeTeeLongOptions(args), { short: { a: false, i: false, p: false }, long: { append: false, "ignore-interrupts": false, "output-error": "optional-value", help: false, version: false } });
  const mode = validateTeeOutputError(opts);
  const targets = [{ name: "standard output", stdout: true, active: true }];
  let status = 0;
  for (const file of operands) {
    try {
      targets.push({ name: file, handle: await open(file, opts.a || opts.append ? "a" : "w"), active: true });
    } catch (error) {
      status = 1;
      stderr(`tee: ${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}\n`);
      if (mode === "exit" || mode === "exit-nopipe") return 1;
    }
  }

  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (targets.some((target) => target.active)) {
      const stdoutTarget = targets.find((target) => target.stdout && target.active);
      if (stdoutTarget && (pollFd(1, POLLOUT) & (POLLERR | POLLHUP | POLLNVAL))) {
        const result = handleTeeTargetError(stdoutTarget, Object.assign(new Error("broken pipe"), { code: "EPIPE" }), mode);
        stdoutTarget.active = false;
        if (result.status) status = result.status;
        if (result.exit) return result.status;
        if (!targets.some((target) => target.active)) return result.status;
      }
      let n;
      try {
        n = readSync(0, buffer, 0, buffer.length, null);
        if (n === 0) break;
      } catch (error) {
        stderr(`tee: read error: ${systemErrorMessage(error)}\n`);
        return 1;
      }
      const chunk = buffer.subarray(0, n);
      for (const target of targets) {
        if (!target.active) continue;
        const result = await writeTeeTarget(target, chunk, mode);
        if (result === "ok") continue;
        target.active = false;
        if (result.status) status = result.status;
        if (result.exit) return result.status;
        if (target.stdout && !targets.some((target) => target.active)) return result.status;
      }
    }
  } finally {
    for (const target of targets) await target.handle?.close().catch(() => {});
  }
  return status;
}

export function validateTeeOutputError(opts) {
  if (opts["output-error"] == null) return opts.p ? "warn-nopipe" : "default";
  const mode = opts["output-error"] === true ? "warn-nopipe" : opts["output-error"];
  if (!["warn", "warn-nopipe", "exit", "exit-nopipe"].includes(mode)) {
    const kind = mode === "" ? "ambiguous" : "invalid";
    throw new UsageError(`${kind} argument ${localeQuotedEscapedDiagnostic(mode)} for ${localeQuotedDiagnostic("--output-error")}\nValid arguments are:\n  - ${localeQuotedDiagnostic("warn")}\n  - ${localeQuotedDiagnostic("warn-nopipe")}\n  - ${localeQuotedDiagnostic("exit")}\n  - ${localeQuotedDiagnostic("exit-nopipe")}`, true);
  }
  return mode;
}

export async function writeTeeTarget(target, chunk, mode) {
  try {
    if (target.stdout) writeSync(1, chunk);
    else await target.handle.write(chunk);
    return "ok";
  } catch (error) {
    return handleTeeTargetError(target, error, mode);
  }
}

export function handleTeeTargetError(target, error, mode) {
  const isPipe = error?.code === "EPIPE";
  const warn = mode === "warn" || mode === "exit" || (!isPipe && mode !== "default");
  const exit = mode === "exit" || (!isPipe && mode === "exit-nopipe");
  const status = isPipe && (mode === "default" || mode === "warn-nopipe" || mode === "exit-nopipe") ? 0 : 1;
  if (warn || (!isPipe && mode === "default")) {
    const name = target.stdout ? target.name : textInputDiagnosticName(target.name);
    stderr(`tee: ${name}: ${systemErrorMessage(error)}\n`);
  }
  return { status, exit };
}

const singleCall = defineCommand("tee", tee, teeMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
