#!/usr/bin/env bun

import { localeQuotedDiagnostic } from "../shared/common.js";
import { fail } from "../shared/diagnostics.js";
import { testExpressionStatus } from "../shared/test-expression.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function bracketCmd(args) {
  if (args.at(-1) !== "]") return fail("[", `missing ${localeQuotedDiagnostic("]")}`, 2);
  return testExpressionStatus(args, "[");
}

const singleCall = defineCommand("[", bracketCmd, (args) => args.length === 1 && (args[0] === "--help" || args[0] === "--version") ? args[0] : null);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
