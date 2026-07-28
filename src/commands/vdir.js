#!/usr/bin/env bun

import { lsCmd, lsMetaOption } from "../shared/listing.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function vdirCmd(args) {
  return lsCmd(["-l", "--quoting-style=escape", ...args]);
}

const singleCall = defineCommand("vdir", vdirCmd, lsMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
