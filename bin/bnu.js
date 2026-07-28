#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const here = dirname(realpathSync(Bun.argv[1]));
globalThis[Symbol.for("bnu.cli")] = true;
const { commandNames } = await import(pathToFileURL(join(here, "../src/shared/catalog.js")).href);
const { main } = await import(pathToFileURL(join(here, "../src/shared/runtime.js")).href);
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
