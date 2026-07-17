#!/usr/bin/env bun

import { hashCommand, hashMetaOption } from "../shared/hash.js";
import { defineCommand, runAsMain } from "../shared/command.js";

const singleCall = defineCommand("sha1sum", hashCommand("sha1"), (args) => hashMetaOption("sha1sum", args));
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
