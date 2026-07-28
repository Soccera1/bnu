#!/usr/bin/env bun

import { hashCommand, hashMetaOption } from "../shared/hash.js";
import { defineCommand, runAsMain } from "../shared/command.js";

const singleCall = defineCommand("sha256sum", hashCommand("sha256"), (args) => hashMetaOption("sha256sum", args));
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
