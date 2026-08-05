#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { commandNames } from "../src/shared/catalog.js";
import { main } from "../src/shared/runtime.js";

globalThis[Symbol.for("bnu.cli")] = true;
let invokedPath = Bun.argv[1];
try {
  if (process.env._ && realpathSync(process.env._) === realpathSync(Bun.argv[1])) invokedPath = process.env._;
} catch {
  // Fall back to Bun's resolved script path when the shell-provided path is not usable.
}
const invokedAs = basename(invokedPath).replace(/\.js$/, "");
const argv = invokedAs === "bnu"
  ? Bun.argv.slice(2)
  : commandNames.includes(invokedAs)
    ? [invokedAs, ...Bun.argv.slice(2)]
    : ["coreutils", `--coreutils-prog=${invokedAs}`, ...Bun.argv.slice(2)];

process.exit(await main(argv));
