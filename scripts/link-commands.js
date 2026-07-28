#!/usr/bin/env bun
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandNames } from "../src/shared/catalog.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = resolve(process.argv[2] ?? "dist/bin");
const bun = shellQuote(process.execPath);

await mkdir(targetDir, { recursive: true });

for (const command of commandNames) {
  const path = resolve(targetDir, command);
  const commandScript = shellQuote(resolve(root, "src/commands", `${command}.js`));
  const script = command === "pwd"
    ? `#!/bin/sh
saved_pwd=$PWD
actual_pwd=$(command pwd -P 2>/dev/null || :)
test -n "$actual_pwd" && saved_pwd=$actual_pwd
if [ \${#saved_pwd} -gt 4000 ]; then
  cd / || exit 1
  BNU_LONG_PWD=$saved_pwd PWD=$saved_pwd exec ${bun} ${commandScript} "$@"
fi
exec ${bun} ${commandScript} "$@"
`
    : command === "tail" || command === "tac" || command === "timeout"
    ? `#!/bin/sh
if [ ! -e /proc/$$/fd/0 ]; then
  BNU_STDIN_CLOSED=1
  export BNU_STDIN_CLOSED
fi
exec ${bun} ${commandScript} "$@"
`
    : `#!/bin/sh\nexec ${bun} ${commandScript} "$@"\n`;
  await writeFile(path, script);
  await chmod(path, 0o755);
}

console.log(`Linked ${commandNames.length} command wrappers into ${targetDir}`);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
