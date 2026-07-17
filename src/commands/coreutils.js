#!/usr/bin/env bun

import { commandNames, hasCommand } from "../shared/catalog.js";
import { invalidOptionMessage } from "../shared/common.js";
import { UsageError, VERSION, fail, stdout } from "../shared/diagnostics.js";
import { main } from "../shared/runtime.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function coreutilsCmd(args) {
  if (args[0]?.startsWith("--coreutils-prog=")) {
    const program = args[0].slice("--coreutils-prog=".length);
    if (!program || !hasCommand(program)) return fail("coreutils", `unknown program '${program}'`);
    return main([program, ...args.slice(1)]);
  }
  if (args[0]?.startsWith("--coreutils-prog-shebang=")) {
    const program = args[0].slice("--coreutils-prog-shebang=".length);
    if (!program || !hasCommand(program)) return fail("coreutils", `unknown program '${program}'`);
    if (args.length < 2) return fail("coreutils", `unknown program '${program}'`);
    return main([program, ...args.slice(2)]);
  }
  if (!args.length) throw new UsageError("missing operand");
  if (args[0] === "--help") {
    stdout("Usage: coreutils --coreutils-prog=PROGRAM_NAME [PARAMETERS]...\n");
    stdout("Execute the PROGRAM_NAME built-in program with the given PARAMETERS.\n\n");
    stdout("      --help     display this help and exit\n");
    stdout("      --version  output version information and exit\n\n");
    stdout(`Built-in programs:\n ${commandNames.join(" ")}\n\n`);
    stdout("Use: 'coreutils --coreutils-prog=PROGRAM_NAME --help' for individual program help.\n");
    return 0;
  }
  if (args[0] === "--version") {
    stdout(`${VERSION}\n`);
    return 0;
  }
  if (args[0].startsWith("-")) throw new UsageError(invalidOptionMessage(args[0]), true);
  return main(args);
}

const singleCall = defineCommand("coreutils", coreutilsCmd, null);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
