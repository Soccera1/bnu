#!/usr/bin/env bun

import { hashCommand, hashMetaOption } from "../shared/hash.js";
import { defineCommand, runAsMain } from "../shared/command.js";

const singleCall = defineCommand("sha224sum", hashCommand("sha224"), (args) => hashMetaOption("sha224sum", args));
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
