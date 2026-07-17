#!/usr/bin/env bun

import { booleanCommand } from "../shared/common.js";
import { defineCommand, runAsMain } from "../shared/command.js";

const singleCall = defineCommand("false", (args) => booleanCommand("false", args, 1), null);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
