#!/usr/bin/env bun

import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { localeQuotedDiagnostic, parseOptions, selinuxRuntimeEnabled } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { invalidModeDiagnosticValue, mkdirDiagnosticName, mkdirErrorMessage, mkdirParents, mkdirVerboseName, parseCreationMode, rawOperandPlan, selinuxCreationOptions, setFileMode, withSelinuxCreationContext } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const MKDIR_LONG_OPTIONS = ["mode", "parents", "verbose", "context", "help", "version"];

export function mkdirMetaOption(args) {
  let sawContextValue = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    if (!arg.startsWith("--")) continue;
    const option = normalizeMkdirLongOption(arg);
    const name = option.slice(2).split("=", 1)[0];
    if (!MKDIR_LONG_OPTIONS.includes(name)) return null;
    if (option.includes("=")) {
      if (name === "parents" || name === "verbose" || name === "help" || name === "version") return null;
      if (name === "context") sawContextValue = true;
      continue;
    }
    if (option === "--help" || option === "--version") {
      if (sawContextValue && !selinuxRuntimeEnabled()) stderr("mkdir: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\n");
      return option;
    }
    if (name === "mode") i++;
  }
  return null;
}

export async function mkdirCmd(args) {
  args = normalizeMkdirLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { p: false, m: "value", v: false, Z: false }, long: { parents: false, mode: "value", verbose: false, context: "optional-value", help: false, version: false } });
  const securityContext = selinuxCreationOptions("mkdir", opts);
  if (!operands.length) throw new UsageError("missing operand", true);
  const rawOperands = rawOperandPlan("mkdir", args, operands, {
    valueOptions: ["--mode"],
    shortValueOptions: ["m"],
  });
  const mode = opts.m || opts.mode ? parseMkdirCreationMode(opts.m ?? opts.mode) : undefined;
  const parents = opts.p || opts.parents;
  await withSelinuxCreationContext("mkdir", securityContext, async (created, sameThread) => {
    for (let i = 0; i < operands.length; i++) {
      const dir = rawOperands?.[i] ?? operands[i];
      if (dir === "") throw new UsageError(`cannot create directory ${localeQuotedDiagnostic("")}: No such file or directory`);
      if (parents) await mkdirParents(dir, mode, opts.v || opts.verbose, created, sameThread);
      else {
        try {
          if (sameThread) mkdirSync(dir, { mode });
          else await mkdir(dir, { mode });
        } catch (error) {
          throw new UsageError(`cannot create directory ${mkdirDiagnosticName(dir)}: ${mkdirErrorMessage(error)}`);
        }
        if (mode !== undefined) await setFileMode(dir, mode);
        await created(dir);
        if (opts.v || opts.verbose) stdout(`mkdir: created directory ${mkdirVerboseName(dir)}\n`);
      }
    }
  });
  return 0;
}

export function normalizeMkdirLongOptions(args) {
  const out = [];
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    const option = normalizeMkdirLongOption(arg);
    out.push(option);
    if (option === "--mode" && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

export function normalizeMkdirLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const matches = MKDIR_LONG_OPTIONS.filter((option) => option.startsWith(name));
  if (matches.length === 0) return arg;
  if (matches.length > 1) {
    throw new UsageError(`option '--${name}${eq === -1 ? "" : `=${body.slice(eq + 1)}`}' is ambiguous; possibilities: ${matches.map((option) => `'--${option}'`).join(" ")}`, true);
  }
  return eq === -1 ? `--${matches[0]}` : `--${matches[0]}=${body.slice(eq + 1)}`;
}

export function parseMkdirCreationMode(spec) {
  try {
    return parseCreationMode(spec);
  } catch (error) {
    const mode = error instanceof UsageError ? invalidModeDiagnosticValue(error.message) : null;
    if (mode != null) {
      throw new UsageError(`invalid mode ${localeQuotedDiagnostic(mode)}`, false);
    }
    throw error;
  }
}

const singleCall = defineCommand("mkdir", mkdirCmd, mkdirMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
