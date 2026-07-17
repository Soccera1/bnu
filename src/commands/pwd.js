#!/usr/bin/env bun

import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseOptions } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { processCwdOrNull } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const PWD_LONG_OPTIONS = ["logical", "physical", "help", "version"];

export function pwdMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (arg.startsWith("--")) {
      const option = normalizePwdLongOption(arg);
      const name = option.slice(2).split("=", 1)[0];
      if (!PWD_LONG_OPTIONS.includes(name) || option.includes("=")) return null;
      if (option === "--help" || option === "--version") return option;
      continue;
    }
    for (let j = 1; j < arg.length; j++) if (arg[j] !== "L" && arg[j] !== "P") return null;
  }
  return null;
}

export async function pwd(args) {
  args = normalizePwdLongOptions(args);
  const requestedMode = pwdRequestedMode(args);
  const { operands } = parseOptions(args, { short: { L: false, P: false }, long: { logical: false, physical: false, help: false, version: false } });
  if (operands.length) stderr("pwd: ignoring non-option arguments\n");
  const wrapperPwd = syntacticallyValidLogicalPwd(process.env.BNU_LONG_PWD);
  if (wrapperPwd != null) {
    stdout(`${wrapperPwd}\n`);
    return 0;
  }
  const cwd = processCwdOrNull();
  if (cwd == null) {
    const logical = syntacticallyValidLogicalPwd(process.env.PWD);
    if (logical != null) {
      stdout(`${logical}\n`);
      return 0;
    }
    throw new UsageError("failed to find current directory");
  }
  const physical = await realpath(cwd);
  const useLogical = requestedMode === "logical" || (requestedMode == null && process.env.POSIXLY_CORRECT);
  if (useLogical) {
    const logical = await validLogicalPwd(process.env.PWD, physical);
    stdout(`${logical ?? physical}\n`);
  } else {
    stdout(`${physical}\n`);
  }
  return 0;
}

export function pwdRequestedMode(args) {
  let mode = null;
  let end = false;
  for (const arg of args) {
    if (end) continue;
    if (arg === "--") {
      end = true;
      continue;
    }
    if (arg === "-" || !arg.startsWith("-")) continue;
    if (arg.startsWith("--")) {
      if (arg === "--logical") mode = "logical";
      else if (arg === "--physical") mode = "physical";
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      if (arg[j] === "L") mode = "logical";
      else if (arg[j] === "P") mode = "physical";
    }
  }
  return mode;
}

export function normalizePwdLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizePwdLongOption(arg));
  }
  return out;
}

export function normalizePwdLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = PWD_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

export function syntacticallyValidLogicalPwd(value) {
  if (!value || !isAbsolute(value)) return null;
  if (value.split("/").some((part) => part === "." || part === "..")) return null;
  return value;
}

export async function validLogicalPwd(value, physical) {
  if (syntacticallyValidLogicalPwd(value) == null) return null;
  try {
    return await realpath(value) === physical ? value : null;
  } catch {
    return null;
  }
}

const singleCall = defineCommand("pwd", pwd, pwdMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
