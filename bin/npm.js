#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const bun = require.resolve("bun/bin/bun.exe");
const launcher = fileURLToPath(new URL("../runtime/bnu.js", import.meta.url));
const child = spawn(bun, [launcher, ...process.argv.slice(2)], { stdio: "inherit" });

child.on("error", (error) => {
  console.error(`bnu: failed to start bundled Bun runtime: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
