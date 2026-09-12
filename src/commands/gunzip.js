#!/usr/bin/env bun
import { gzipCommand } from "../shared/gzip.js";
import { helpVersionOnlyMetaOption } from "../shared/common.js";
import { defineCommand, runAsMain } from "../shared/command.js";
export const gunzipCmd = args => gzipCommand(args, "gunzip");
const command = defineCommand("gunzip", gunzipCmd, helpVersionOnlyMetaOption);
export default command;
if (import.meta.main) await runAsMain(command);
