#!/usr/bin/env bun
import { gzipCommand } from "../shared/gzip.js";
import { helpVersionOnlyMetaOption } from "../shared/common.js";
import { defineCommand, runAsMain } from "../shared/command.js";
export const zcatCmd = args => gzipCommand(args, "zcat");
const command = defineCommand("zcat", zcatCmd, helpVersionOnlyMetaOption);
export default command;
if (import.meta.main) await runAsMain(command);
