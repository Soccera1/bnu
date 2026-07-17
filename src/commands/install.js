#!/usr/bin/env bun

import { installCmd, installMetaOption } from "../shared/install.js";
import { defineCommand, runAsMain } from "../shared/command.js";

const singleCall = defineCommand("install", installCmd, installMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
