#!/usr/bin/env bun

import { booleanCommand } from "../shared/common.js";
import { defineCommand, runAsMain } from "../shared/command.js";

const singleCall = defineCommand("true", (args) => booleanCommand("true", args, 0), null);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
