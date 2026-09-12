#!/usr/bin/env bun
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let testFiles = (await readdir(join(root, "tests")))
  .filter((name) => name.endsWith(".test.js")).sort();
const requested = process.argv.slice(2).map((name) => basename(name));
for (const file of requested) {
  if (!testFiles.includes(file)) throw new Error(`run-bun-tests-bounded: unknown test file ${file}`);
}
if (requested.length) testFiles = testFiles.filter((file) => requested.includes(file));
const tests = [];
for (const file of testFiles) {
  const testFile = join(root, "tests", file);
  const source = await readFile(testFile, "utf8");
  const names = [...source.matchAll(/^test\("((?:[^"\\]|\\.)+)"/gm)]
    .map((match) => JSON.parse(`"${match[1]}"`));
  if (!names.length) throw new Error(`run-bun-tests-bounded: no named tests found in ${file}`);
  const registrations = [...source.matchAll(/^[ \t]*test(?:\.\w+)?\s*\(/gm)];
  if (registrations.length !== names.length || new Set(names).size !== names.length) {
    throw new Error(`run-bun-tests-bounded: ${file} must use unique, top-level test("literal name", ...) registrations so no cases are silently omitted`);
  }
  tests.push(...names.map((name) => ({ name, testFile })));
}
if (tests.length === 0) {
  console.error("run-bun-tests-bounded: no tests found");
  process.exit(2);
}

const failures = [];
for (let index = 0; index < tests.length; index++) {
  const { name, testFile } = tests[index];
  console.log(`\nBOUNDED TEST ${index + 1}/${tests.length}: ${name}`);
  const exactPattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const proc = Bun.spawn([
    process.execPath,
    join(root, "scripts/run-memory-bounded.js"),
    "--rss-limit", process.env.BNU_TEST_RSS_LIMIT ?? "1GiB",
    "--memory-limit", process.env.BNU_TEST_MEMORY_LIMIT ?? "4GiB",
    "--",
    process.execPath,
    "test",
    testFile,
    "--test-name-pattern", exactPattern,
    "--timeout", process.env.BNU_TEST_TIMEOUT ?? "300000",
    "--max-concurrency", "1",
  ], {
    cwd: root,
    env: {
      ...process.env,
      BNU_FACTOR_WORKERS: process.env.BNU_FACTOR_WORKERS ?? "1",
      GNULY_CORRECT: "1",
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) failures.push({ name, code });
}

if (failures.length) {
  console.error(`\n${failures.length} bounded test process(es) failed:`);
  for (const failure of failures) console.error(`- ${failure.name} (exit ${failure.code})`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} bounded test processes passed.`);
