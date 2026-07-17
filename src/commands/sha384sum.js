#!/usr/bin/env bun

import { hashCommand, hashMetaOption } from "../shared/hash.js";
import { defineCommand, runAsMain } from "../shared/command.js";

const singleCall = defineCommand("sha384sum", hashCommand("sha384"), (args) => hashMetaOption("sha384sum", args));
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
