import { readFileSync } from "node:fs";
import { executeCommand } from "./runtime.js";
import { hasCommand } from "./catalog.js";

export function defineCommand(name, implementation, metaOption) {
  if (!hasCommand(name)) throw new Error(`Unknown BNU command: ${name}`);
  return (args) => executeCommand(name, implementation, metaOption, args);
}

export async function runAsMain(command, args = singleCallArgs()) {
  globalThis[Symbol.for("bnu.cli")] = true;
  process.exit(await command(args));
}

// Bun consumes a leading `--` between the script name and its arguments. GNU
// utilities need to see that separator because it changes option parsing.
function singleCallArgs() {
  const args = Bun.argv.slice(2);
  try {
    const parts = readFileSync("/proc/self/cmdline").subarray(0, -1).toString("binary").split("\0");
    let scriptIndex = parts.indexOf(Bun.argv[1]);
    if (scriptIndex === -1 && parts.length > 1) scriptIndex = 1;
    if (parts[scriptIndex + 1] === "--" && args[0] !== "--") return ["--", ...args];
  } catch {
    // Non-Linux platforms retain Bun's decoded argument list.
  }
  return args;
}
