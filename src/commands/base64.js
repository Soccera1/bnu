#!/usr/bin/env bun

import { baseEncodingDiagnosticName, baseEncodingMetaOption, decodeBase64, ensureSingleInputOperand, formatEncodedOutput, normalizeBaseEncodingLongOptions, parseWrap } from "../shared/checksum.js";
import { nodeErrorMessage, parseOptions, readAll, systemErrorMessage } from "../shared/common.js";
import { stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function base64Cmd(args) {
  args = normalizeBaseEncodingLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { d: false, i: false, w: "value" }, long: { decode: false, "ignore-garbage": false, wrap: "value", help: false, version: false } });
  ensureSingleInputOperand(operands);
  const wrap = parseWrap(opts.w ?? opts.wrap ?? 76);
  const file = operands[0] ?? "-";
  let data;
  try {
    data = await readAll(file);
  } catch (error) {
    const message = error?.code === "EISDIR" ? "read error: Is a directory" : file === "-" ? nodeErrorMessage(error) : `${baseEncodingDiagnosticName(file)}: ${systemErrorMessage(error)}`;
    stderr(`base64: ${message}\n`);
    return 1;
  }
  if (opts.d || opts.decode) {
    stdout(decodeBase64(new TextDecoder().decode(data), opts.i || opts["ignore-garbage"]));
    return 0;
  }
  const encoded = Buffer.from(data).toString("base64");
  stdout(formatEncodedOutput(encoded, wrap));
  return 0;
}

const singleCall = defineCommand("base64", base64Cmd, baseEncodingMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
