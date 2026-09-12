#!/usr/bin/env bun
import { gzipCommand } from "../shared/gzip.js";
import { helpVersionOnlyMetaOption } from "../shared/common.js";
import { defineCommand, runAsMain } from "../shared/command.js";
export const gzipCmd = args => gzipCommand(args, "gzip");
const command = defineCommand("gzip", gzipCmd, helpVersionOnlyMetaOption);
export default command;
if (import.meta.main) await runAsMain(command);
