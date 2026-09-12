import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commandNames, coreutilsCommandNames } from "../src/shared/catalog.js";
const root = join(import.meta.dir, "..");
const added = ["addr2line", "ar", "as", "awk", "c++filt", "cmp", "cpio", "diff", "diff3", "elfedit", "grep", "gunzip", "gzip", "ld", "nm", "objcopy", "objdump", "patch", "ranlib", "readelf", "sdiff", "sed", "size", "strings", "strip", "tar", "wget", "zcat"];
let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bnu-integration-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function run(argv, input = "", cwd = dir) {
  const p = Bun.spawn(argv, { cwd, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", env: { ...process.env, GNULY_CORRECT: "1" } });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, stdout, stderr };
}

test("all requested utility entries are discoverable and expose useful direct help", async () => {
  const help = await run([process.execPath, join(root, "bin/bnu.js"), "--help"]);
  const entries = await readdir(join(root, "src/commands"));
  for (const name of added) {
    expect(commandNames).toContain(name);
    expect(coreutilsCommandNames).not.toContain(name);
    expect(help.stdout).toContain(name);
    expect(entries).toContain(`${name}.js`);
    const result = await run([process.execPath, join(root, "src/commands", `${name}.js`), "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Usage: ${name} `);
    expect(result.stdout.split("\n").length).toBeGreaterThan(6);
    const version = await run([process.execPath, join(root, "src/commands", `${name}.js`), "--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^bnu /);
  }
}, 60_000);

test("generated command wrappers execute the new utilities with literal arguments", async () => {
  const wrappers = join(dir, "wrappers with spaces");
  expect((await run([process.execPath, join(root, "scripts/link-commands.js"), wrappers])).code).toBe(0);
  const entries = await readdir(wrappers);
  for (const name of added) expect(entries).toContain(name);
  expect(await run([join(wrappers, "grep"), "-F", "a;echo wrong"], "a;echo wrong\nother\n")).toMatchObject({ code: 0, stdout: "a;echo wrong\n", stderr: "" });
  expect(await run([join(wrappers, "sed"), "s/old/new/"], "old\n")).toMatchObject({ code: 0, stdout: "new\n" });
  expect(await run([join(wrappers, "awk"), "{total+=$1} END{print total}"], "1\n2\n")).toMatchObject({ code: 0, stdout: "3\n" });
}, 60_000);

test("production build contains and runs every new command entry", async () => {
  const result = await run([process.execPath, "scripts/build.js"], "", root);
  expect(result.code).toBe(0);
  const entries = await readdir(join(root, "dist/commands"));
  for (const name of added) {
    expect(entries).toContain(`${name}.js`);
    const help = await run([process.execPath, join(root, "dist/commands", `${name}.js`), "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(`Usage: ${name} `);
  }
  expect(await run([process.execPath, join(root, "dist/runtime/bnu.js"), "grep", "-n", "match"], "other\nmatch\n")).toMatchObject({ code: 0, stdout: "2:match\n", stderr: "" });
  expect(await run([process.execPath, join(root, "dist/commands/awk.js"), "BEGIN{print 6*7}"])).toMatchObject({ code: 0, stdout: "42\n", stderr: "" });
}, 60_000);
