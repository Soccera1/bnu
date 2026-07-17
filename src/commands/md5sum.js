#!/usr/bin/env bun

import { hashCommand, hashMetaOption } from "../shared/hash.js";
import { defineCommand, runAsMain } from "../shared/command.js";

const singleCall = defineCommand("md5sum", hashCommand("md5"), (args) => hashMetaOption("md5sum", args));
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
