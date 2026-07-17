#!/usr/bin/env bun

import { hashCommand, hashMetaOption } from "../shared/hash.js";
import { defineCommand, runAsMain } from "../shared/command.js";

const singleCall = defineCommand("b2sum", hashCommand("blake2b512"), (args) => hashMetaOption("b2sum", args));
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
