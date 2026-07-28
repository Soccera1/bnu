#!/usr/bin/env bun

import { testExpressionStatus } from "../shared/test-expression.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function testCmd(args) {
  return testExpressionStatus(args, "test");
}

const singleCall = defineCommand("test", testCmd, null);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
