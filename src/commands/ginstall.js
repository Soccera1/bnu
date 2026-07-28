#!/usr/bin/env bun

import { installCmd, installMetaOption } from "../shared/install.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function ginstallCmd(args) {
  return installCmd(args, "ginstall");
}

const singleCall = defineCommand("ginstall", ginstallCmd, installMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
