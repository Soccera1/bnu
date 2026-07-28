#!/usr/bin/env bun

import { hashCommand, hashMetaOption } from "../shared/hash.js";
import { defineCommand, runAsMain } from "../shared/command.js";

const singleCall = defineCommand("sha512sum", hashCommand("sha512"), (args) => hashMetaOption("sha512sum", args));
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
