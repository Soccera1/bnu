import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editScript, lines } from "../src/shared/diff-tools.js";

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bnu-diff-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function run(command, args = [], input = "", system = false) {
  const proc = Bun.spawn(system ? [command, ...args] : [process.execPath, join(import.meta.dir, `../src/commands/${command}.js`), ...args], { cwd: dir, env: { ...process.env, GNULY_CORRECT: "1", LC_ALL: "C" }, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}
async function pair(a, b) { await Promise.all([writeFile(join(dir, "old"), a), writeFile(join(dir, "new"), b)]); }

test("diff normal output, byte comparison and statuses agree with GNU", async () => {
  await pair("one\ntwo\nthree\nfour\n", "zero\none\nTWO\nthree\n");
  expect(await run("diff", ["old", "new"])).toEqual(await run("diff", ["old", "new"], "", true));
  expect((await run("diff", ["old", "old"])).code).toBe(0);
  expect((await run("diff", ["missing", "new"])).code).toBe(2);
  expect((await run("diff", ["--unknown", "old", "new"])).code).toBe(2);
});

test("unified and context diffs interoperate in both directions, including missing final newline", async () => {
  for (const [a, b] of [["a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n", "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nK\nl\n"], ["one\ntwo", "zero\none\nTWO"], ["", "one\ntwo\n"], ["one\ntwo\n", ""], ["a\nc\n", "a\nb\nc\n"]]) {
    await pair(a, b);
    for (const style of ["-u", "-c", "-U0"]) {
      const args = [style, "--label=old", "--label=new", "old", "new"];
      const own = await run("diff", args), host = await run("diff", args, "", true);
      expect(own.code).toBe(1);
      expect(own.stdout).toBe(host.stdout);
      await writeFile(join(dir, "target"), a);
      const apply = await run("patch", ["--batch", "target"], host.stdout);
      expect(apply.code).toBe(0);
      expect(await readFile(join(dir, "target"), "utf8")).toBe(b);
      const reverse = await run("patch", ["-R", "target"], own.stdout);
      expect(reverse.code).toBe(0);
      expect(await readFile(join(dir, "target"), "utf8")).toBe(a);
      const hostApply = await run("patch", ["--batch", "target"], own.stdout, true);
      expect(hostApply.code).toBe(0);
      expect(await readFile(join(dir, "target"), "utf8")).toBe(b);
    }
  }
}, 30000);

test("normal patches apply and reverse with offsets", async () => {
  await pair("a\nb\nc\nd\n", "a\nB\nc\nd\nend\n");
  const normal = await run("diff", ["old", "new"], "", true);
  await writeFile(join(dir, "target"), "prefix\na\nb\nc\nd\n");
  expect((await run("patch", ["target"], normal.stdout)).code).toBe(0);
  expect(await readFile(join(dir, "target"), "utf8")).toBe("prefix\na\nB\nc\nd\nend\n");
  expect((await run("patch", ["-R", "--no-backup-if-mismatch", "target"], normal.stdout)).code).toBe(0);
  expect(await readFile(join(dir, "target"), "utf8")).toBe("prefix\na\nb\nc\nd\n");
});

test("patch -p -d -i, dry run, backups, creation and deletion", async () => {
  await mkdir(join(dir, "work"));
  await writeFile(join(dir, "work", "file"), "old\n");
  const delta = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
  await writeFile(join(dir, "work", "change.patch"), delta);
  expect((await run("patch", ["-d", "work", "-p1", "-i", "change.patch", "--dry-run"])).code).toBe(0);
  expect(await readFile(join(dir, "work", "file"), "utf8")).toBe("old\n");
  expect((await run("patch", ["-d", "work", "-p1", "-i", "change.patch", "-b"])).code).toBe(0);
  expect(await readFile(join(dir, "work", "file.orig"), "utf8")).toBe("old\n");
  expect(await readFile(join(dir, "work", "file"), "utf8")).toBe("new\n");
  const create = "--- /dev/null\n+++ b/sub/new-file\n@@ -0,0 +1 @@\n+created\n";
  expect((await run("patch", ["-d", "work", "-p1"], create)).code).toBe(0);
  expect(await readFile(join(dir, "work", "sub", "new-file"), "utf8")).toBe("created\n");
  expect((await run("patch", ["-d", "work", "-p1", "-R"], create)).code).toBe(0);
  expect(await Bun.file(join(dir, "work", "sub", "new-file")).exists()).toBe(false);
});

test("patch rejects failed hunks, malformed patches and unsafe paths without corrupting files", async () => {
  await writeFile(join(dir, "file"), "actual\n");
  const delta = "--- file\n+++ file\n@@ -1 +1 @@\n-other\n+new\n";
  expect((await run("patch", [], delta)).code).toBe(1);
  expect(await readFile(join(dir, "file"), "utf8")).toBe("actual\n");
  expect(await readFile(join(dir, "file.rej"), "utf8")).toContain("-other\n+new\n");
  expect((await run("patch", [], delta.replace("@@ -1 +1 @@", "@@ -1,2 +1 @@"))).code).toBe(2);
  expect((await run("patch", ["-p0"], delta.replaceAll("file\n", "../escape\n"))).code).toBe(2);
  await symlink("file", join(dir, "link"));
  expect((await run("patch", [], delta.replaceAll("file\n", "link\n"))).code).toBe(2);
  expect(await readFile(join(dir, "file"), "utf8")).toBe("actual\n");
});

test("diff recursive, exclusions, missing files, brief, whitespace and binary comparison", async () => {
  await pair("Hello \tworld\n\n", "hello world\n");
  expect((await run("diff", ["-ibB", "old", "new"])).code).toBe(0);
  expect((await run("diff", ["-q", "old", "new"])).stdout).toBe("Files old and new differ\n");
  await pair(Buffer.from([0, 1]), Buffer.from([0, 2]));
  expect((await run("diff", ["old", "new"])).stdout).toBe("Binary files old and new differ\n");
  for (const sub of ["a", "b"]) await mkdir(join(dir, sub));
  await writeFile(join(dir, "a", "one"), "same\n"); await writeFile(join(dir, "b", "one"), "same\n");
  await writeFile(join(dir, "b", "extra"), "extra\n");
  expect((await run("diff", ["-r", "a", "b"])).stdout).toBe("Only in b: extra\n");
  expect((await run("diff", ["-r", "--exclude=extra", "a", "b"])).code).toBe(0);
  const created = await run("diff", ["-ruN", "a", "b"]);
  expect(created.code).toBe(1); expect(created.stdout).toContain("+extra\n");
});

test("Myers reconstruction and linear-space fallback preserve both inputs", () => {
  let seed = 77;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let trial = 0; trial < 100; trial++) {
    const a = Array.from({ length: next() % 30 }, () => `${next() % 8}\n`), b = Array.from({ length: next() % 30 }, () => `${next() % 8}\n`);
    const script = editScript(a, b);
    expect(script.filter((o) => o.type !== "+").map((o) => o.line)).toEqual(a);
    expect(script.filter((o) => o.type !== "-").map((o) => o.other ?? o.line)).toEqual(b);
  }
  const a = Array.from({ length: 600 }, (_, i) => `left-${i}\n`), b = Array.from({ length: 600 }, (_, i) => `right-${i}\n`);
  const script = editScript(a, b);
  expect(script.filter((o) => o.type === "-").map((o) => o.line)).toEqual(a);
  expect(script.filter((o) => o.type === "+").map((o) => o.line)).toEqual(b);
});

test("cmp compares bytes, skips, limits, stdin and error statuses", async () => {
  await pair("one\ntwo\n", "one\nTwo\n");
  for (const args of [["old", "new"], ["-l", "old", "new"], ["-s", "old", "new"], ["-n4", "old", "new"], ["-i5", "old", "new"]]) expect(await run("cmp", args)).toEqual(await run("cmp", args, "", true));
  expect((await run("cmp", ["old", "-"], "one\ntwo\n")).code).toBe(0);
  expect((await run("cmp", ["-s", "absent", "old"])).code).toBe(2);
});

test("sdiff side-by-side marks changes and can suppress common lines", async () => {
  await pair("same\nold\n", "same\nnew\nextra\n");
  const result = await run("sdiff", ["-w40", "-s", "old", "new"]);
  expect(result.code).toBe(1); expect(result.stdout).not.toContain("same");
  expect(result.stdout).toContain("| new"); expect(result.stdout).toContain("> extra");
});

test("diff3 merges independent changes and identifies conflicts like GNU", async () => {
  for (const [a, base, b] of [["ONE\ntwo\nthree\n", "one\ntwo\nthree\n", "one\ntwo\nTHREE\n"], ["one\nOURS\nthree\n", "one\ntwo\nthree\n", "one\nTHEIRS\nthree\n"], ["one\nSAME\n", "one\ntwo\n", "one\nSAME\n"], ["one\ntwo\n", "one\ntwo\n", "one\nNEW\ntwo\n"]]) {
    await writeFile(join(dir, "mine"), a); await writeFile(join(dir, "base"), base); await writeFile(join(dir, "theirs"), b);
    expect(await run("diff3", ["-m", "mine", "base", "theirs"])).toEqual(await run("diff3", ["-m", "mine", "base", "theirs"], "", true));
    expect(await run("diff3", ["mine", "base", "theirs"])).toEqual(await run("diff3", ["mine", "base", "theirs"], "", true));
  }
});

test("patch input selectors reject mismatched formats before writing",async()=>{
  await pair("old\n","new\n");
  for(const [selector,style] of [["-u","-u"],["-c","-c"],["-n","--normal"]]) {
    const delta=await run("diff",[style,"old","new"],"",true);
    await writeFile(join(dir,"target"),"old\n");
    expect((await run("patch",[selector,"target"],delta.stdout)).code).toBe(0);
    expect(await readFile(join(dir,"target"),"utf8")).toBe("new\n");
    await writeFile(join(dir,"target"),"old\n");
    expect((await run("patch",[selector==="-u"?"-c":"-u","target"],delta.stdout)).code).toBe(2);
    expect(await readFile(join(dir,"target"),"utf8")).toBe("old\n");
  }
});

test("patch forward avoids duplicate insertions and batch recognizes reversed changes",async()=>{
  const insertion="--- file\n+++ file\n@@ -0,0 +1 @@\n+inserted\n";
  await writeFile(join(dir,"file"),"");
  expect((await run("patch",["-N"],insertion)).code).toBe(0);
  expect((await run("patch",["--forward"],insertion)).code).toBe(1);
  expect(await readFile(join(dir,"file"),"utf8")).toBe("inserted\n");
  const change="--- file\n+++ file\n@@ -1 +1 @@\n-old\n+new\n";
  await writeFile(join(dir,"file"),"new\n");
  expect((await run("patch",["--batch"],change)).code).toBe(0);
  expect(await readFile(join(dir,"file"),"utf8")).toBe("old\n");
  await writeFile(join(dir,"file"),"new\n");
  expect((await run("patch",["--force"],change)).code).toBe(1);
  expect(await readFile(join(dir,"file"),"utf8")).toBe("new\n");
});

test("diff and sdiff ignore expressions use GNU basic regex classes and backreferences",async()=>{
  await pair("header\n11\n","header\n22\n");
  const pattern="^\\([[:digit:]]\\)\\1$";
  const expected=await run("diff",["-I",pattern,"old","new"],"",true);
  expect(expected.code).toBe(0);
  expect(await run("diff",["-I",pattern,"old","new"])).toEqual(expected);
  expect((await run("sdiff",["-I",pattern,"old","new"])).code).toBe((await run("sdiff",["-I",pattern,"old","new"],"",true)).code);
  expect((await run("diff",["-I","[","old","new"])).code).toBe(2);
});
