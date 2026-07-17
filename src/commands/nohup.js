#!/usr/bin/env bun

import { closeSync, constants as fsConstants, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { invalidOptionMessage, libc, localeQuotedEscapedDiagnostic, normalizeHelpVersionOnlyLongOption, resolveEnvCommand, systemErrorMessage } from "../shared/common.js";
import { InvocationError, stderr } from "../shared/diagnostics.js";
import { SIG_IGN, commandSpawnErrorMessage } from "../shared/process.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export function nohupMetaOption(args) {
  if (!args.length) return null;
  const normalized = args[0].startsWith("--") ? normalizeHelpVersionOnlyLongOption(args[0]) : args[0];
  const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
  if (name === "help" || name === "version") {
    if (inlineValue !== undefined) throw new InvocationError(`option '--${name}' doesn't allow an argument`);
    return normalized;
  }
  return null;
}

export async function nohupCmd(args) {
  const internalFailure = process.env.POSIXLY_CORRECT ? 127 : 125;
  if (args[0] === "--") args = args.slice(1);
  if (!args.length) throw new InvocationError("missing operand", internalFailure);
  if (args[0].startsWith("-")) throw new InvocationError(invalidOptionMessage(args[0]));
  const ignoringInput = Boolean(process.stdin.isTTY);
  const redirectingStdout = Boolean(process.stdout.isTTY);
  const redirectingStderr = Boolean(process.stderr.isTTY);
  let stdinFd = null;
  let outputFd = null;
  let outputFile = null;
  try {
    if (ignoringInput) stdinFd = openSync("/dev/null", "w");
    if (redirectingStdout) {
      const opened = nohupOpenOutput();
      if (!opened) return internalFailure;
      ({ fd: outputFd, file: outputFile } = opened);
    }
    const advisory = outputFile
      ? `${ignoringInput ? "ignoring input and " : ""}appending output to ${localeQuotedEscapedDiagnostic(outputFile)}`
      : ignoringInput && !redirectingStderr
        ? "ignoring input"
        : ignoringInput && redirectingStderr
          ? "ignoring input and redirecting standard error to standard output"
          : redirectingStderr
            ? "redirecting standard error to standard output"
            : null;
    if (advisory != null && !nohupWriteAdvisory(advisory)) return internalFailure;
    await resolveEnvCommand(args[0], process.env, process.cwd());
    const previousHangup = libc.symbols.signal(1, SIG_IGN);
    let proc;
    try {
      proc = Bun.spawn(["/bin/sh", "-c", 'trap "" HUP\nexec "$@"', "nohup", ...args], {
        stdin: stdinFd ?? "inherit",
        stdout: outputFd ?? "inherit",
        stderr: redirectingStderr ? (outputFd ?? 1) : "inherit",
      });
      return await proc.exited;
    } finally {
      libc.symbols.signal(1, previousHangup);
    }
  } catch (error) {
    stderr(`nohup: failed to run command '${args[0]}': ${commandSpawnErrorMessage(error)}\n`);
    return error.code === "ENOENT" ? 127 : 126;
  } finally {
    if (stdinFd != null) closeSync(stdinFd);
    if (outputFd != null) closeSync(outputFd);
  }
}

export function nohupOpenOutput() {
  const candidates = ["nohup.out"];
  if (process.env.HOME) candidates.push(join(process.env.HOME, "nohup.out"));
  const failures = [];
  const previousUmask = process.umask(0);
  try {
    for (const file of candidates) {
      try {
        return { fd: openSync(file, fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_APPEND, 0o600), file };
      } catch (error) {
        failures.push({ file, error });
      }
    }
  } finally {
    process.umask(previousUmask);
  }
  for (const { file, error } of failures) stderr(`nohup: failed to open ${localeQuotedEscapedDiagnostic(file)}: ${systemErrorMessage(error)}\n`);
  return null;
}

export function nohupWriteAdvisory(message) {
  try {
    writeSync(2, `nohup: ${message}\n`);
    return true;
  } catch {
    return false;
  }
}

const singleCall = defineCommand("nohup", nohupCmd, nohupMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
