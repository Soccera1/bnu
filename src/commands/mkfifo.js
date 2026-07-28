#!/usr/bin/env bun

import { cstr, libc, parseOptions } from "../shared/common.js";
import { UsageError } from "../shared/diagnostics.js";
import { ensureSpecialFileCreatable, normalizeSpecialFileLongOptions, parseSpecialFileCreationMode, selinuxCreationOptions, setFileMode, specialFileMetaOption, specialFileQuotedName, withSelinuxCreationContext } from "../shared/filesystem.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function mkfifoCmd(args) {
  args = normalizeSpecialFileLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { m: "value", Z: false }, long: { mode: "value", context: "optional-value", help: false, version: false } });
  const securityContext = selinuxCreationOptions("mkfifo", opts);
  if (!operands.length) throw new UsageError("missing operand", true);
  const explicitMode = opts.m ?? opts.mode;
  const mode = explicitMode ? parseSpecialFileCreationMode(explicitMode) : 0o666;
  await withSelinuxCreationContext("mkfifo", securityContext, async (created) => {
    for (const path of operands) {
      await ensureSpecialFileCreatable("mkfifo", path, "fifo");
      if (libc.symbols.mkfifo(cstr(path), mode) !== 0) throw new UsageError(`cannot create fifo ${specialFileQuotedName(path)}: Operation not permitted`);
      if (explicitMode) await setFileMode(path, mode);
      await created(path);
    }
  });
  return 0;
}

const singleCall = defineCommand("mkfifo", mkfifoCmd, (args) => specialFileMetaOption("mkfifo", args));
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
