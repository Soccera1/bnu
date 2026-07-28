#!/usr/bin/env bun

import { lsCmd, lsMetaOption } from "../shared/listing.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function dirCmd(args) {
  return lsCmd(["-C", "--quoting-style=escape", ...args]);
}

const singleCall = defineCommand("dir", dirCmd, lsMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
