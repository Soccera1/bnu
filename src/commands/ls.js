#!/usr/bin/env bun

import { lsCmd, lsMetaOption } from "../shared/listing.js";
import { defineCommand, runAsMain } from "../shared/command.js";

const singleCall = defineCommand("ls", lsCmd, lsMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
