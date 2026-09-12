import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import { encodeTar, decodeTar } from "../src/shared/tar-format.js";
import { encodeCpio, decodeCpio } from "../src/shared/cpio-format.js";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bnu-archives-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function execute(args, input = "", cwd = dir, host = false) {
  const child = Bun.spawn(host ? args : [process.execPath, join(import.meta.dir, "../bin/bnu.js"), ...args], {
    cwd, env: { ...process.env, GNULY_CORRECT: "1", LC_ALL: "C" }, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe",
  });
  const [code, output, stderr] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()]);
  return { code, output: Buffer.from(output), stdout: Buffer.from(output).toString(), stderr };
}

function fixture() {
  mkdirSync(join(dir, "source/sub"), { recursive: true });
  writeFileSync(join(dir, "source/sub/message"), "archive content\n");
  writeFileSync(join(dir, "source/empty"), "");
  chmodSync(join(dir, "source/sub/message"), 0o751);
  utimesSync(join(dir, "source/sub/message"), 1234567800, 1234567890);
  symlinkSync("sub/message", join(dir, "source/link"));
  linkSync(join(dir, "source/sub/message"), join(dir, "source/hard"));
  return "source\nsource/sub\nsource/sub/message\nsource/empty\nsource/link\nsource/hard\n";
}

function assertFixture(root) {
  expect(readFileSync(join(root, "source/sub/message"), "utf8")).toBe("archive content\n");
  expect(readlinkSync(join(root, "source/link"))).toBe("sub/message");
  expect(statSync(join(root, "source/sub/message")).ino).toBe(statSync(join(root, "source/hard")).ino);
  expect(statSync(join(root, "source/sub/message")).mode & 0o777).toBe(0o751);
  expect(statSync(join(root, "source/sub/message")).mtimeMs).toBe(1234567890000);
}

test("tar creates gzip pax archives readable by GNU tar and preserves links and metadata", async () => {
  fixture();
  const created = await execute(["tar", "czf", "bundle.tgz", "source"]);
  expect(created.code).toBe(0);
  mkdirSync(join(dir, "host"));
  expect((await execute(["tar", "xzf", "../bundle.tgz"], "", join(dir, "host"), true)).code).toBe(0);
  assertFixture(join(dir, "host"));
  mkdirSync(join(dir, "bnu"));
  expect((await execute(["tar", "-xf", "bundle.tgz", "-C", "bnu"])).code).toBe(0);
  assertFixture(join(dir, "bnu"));
  const listed = await execute(["tar", "-tf", "bundle.tgz"]);
  expect(listed.stdout).toContain("source/sub/message\n");
});

test("tar extracts GNU long names, POSIX pax, ustar prefixes and selected files", async () => {
  fixture();
  const longName = `${"a".repeat(120)}/${"b".repeat(110)}`;
  mkdirSync(join(dir, "source", longName), { recursive: true });
  writeFileSync(join(dir, "source", longName, "long"), "long name\n");
  for (const format of ["gnu", "posix"]) {
    expect((await execute(["tar", `--format=${format}`, "-cf", `${format}.tar`, "source"], "", dir, true)).code).toBe(0);
    mkdirSync(join(dir, format));
    const result = await execute(["tar", "-xf", `${format}.tar`, "-C", format]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(readFileSync(join(dir, format, "source", longName, "long"), "utf8")).toBe("long name\n");
  }
  expect((await execute(["tar", "-xOf", "gnu.tar", "source/sub/message"])).stdout).toBe("archive content\n");
  const missing = await execute(["tar", "-tf", "gnu.tar", "missing"]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain("Not found in archive");
});

test("tar append, update, delete, exclusions, files-from and positional directories", async () => {
  mkdirSync(join(dir, "one")); mkdirSync(join(dir, "two"));
  writeFileSync(join(dir, "one/a"), "a"); writeFileSync(join(dir, "two/b"), "b");
  expect((await execute(["tar", "-cf", "bundle.tar", "-C", "one", "a", "-C", "../two", "b"])).code).toBe(0);
  expect((await execute(["tar", "-tf", "bundle.tar"])).stdout).toBe("a\nb\n");
  writeFileSync(join(dir, "c"), "c");
  expect((await execute(["tar", "-rf", "bundle.tar", "c"])).code).toBe(0);
  expect((await execute(["tar", "-uf", "bundle.tar", "c"])).code).toBe(0);
  expect((await execute(["tar", "-tf", "bundle.tar"])).stdout).toBe("a\nb\nc\n");
  expect((await execute(["tar", "--delete", "-f", "bundle.tar", "b"])).code).toBe(0);
  expect((await execute(["tar", "-tf", "bundle.tar"])).stdout).toBe("a\nc\n");
  expect((await execute(["tar", "-cf", "from.tar", "--exclude=c", "--null", "-T", "-"], "one\0c\0")).code).toBe(0);
  expect((await execute(["tar", "-tf", "from.tar"])).stdout).toBe("one/\none/a\n");
});

test("tar strip-components and ustar output work with stdin/stdout archives", async () => {
  fixture();
  const archive = await execute(["tar", "--format=ustar", "-cf", "-", "source"]);
  expect(archive.code).toBe(0);
  expect((await execute(["tar", "-tf", "-"], archive.output, dir, true)).stdout).toContain("source/sub/message");
  mkdirSync(join(dir, "out"));
  expect((await execute(["tar", "-xf", "-", "--strip-components=1", "-C", "out"], archive.output)).code).toBe(0);
  expect(readFileSync(join(dir, "out/sub/message"), "utf8")).toBe("archive content\n");
});

const fileEntry = (name, data = "content", extra = {}) => ({ name, type: "0", data: Buffer.from(data), size: Buffer.byteLength(data), mode: 0o644, uid: 1000, gid: 1000, mtime: 1234567890, ino: 1, dev: 0, nlink: 1, ...extra });

test("archive extractors reject traversal, unsafe symlinks and corrupt headers", async () => {
  mkdirSync(join(dir, "out"));
  for (const command of ["tar", "cpio"]) {
    const encode = command === "tar" ? entries => encodeTar(entries) : entries => encodeCpio(entries, "newc");
    const args = command === "tar" ? ["tar", "-xf", "-"] : ["cpio", "-idmu", "--quiet"];
    for (const name of ["../escape", `${dir}/absolute`]) {
      const result = await execute(args, encode([fileEntry(name)]), join(dir, "out"));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("unsafe");
    }
    const link = fileEntry("link", "", { type: "2", linkname: "../", ino: 2 });
    const result = await execute(args, encode([link, fileEntry("link/escape")]), join(dir, "out"));
    expect(result.code).not.toBe(0);
    expect(existsSync(join(dir, "escape"))).toBe(false);
    const corrupted = Buffer.from(encode([fileEntry("file")])); corrupted[0] = 0;
    expect((await execute(args, corrupted, join(dir, "out"))).code).not.toBe(0);
  }
});

test("archive extraction does not follow pre-existing symlinks or clobber external hardlinks", async () => {
  mkdirSync(join(dir, "out")); mkdirSync(join(dir, "outside"));
  writeFileSync(join(dir, "outside/precious"), "unchanged");
  symlinkSync("../outside", join(dir, "out/redirect"));
  linkSync(join(dir, "outside/precious"), join(dir, "out/linked"));
  const hostile = encodeTar([fileEntry("redirect/precious", "overwritten")]);
  expect((await execute(["tar", "-xf", "-"], hostile, join(dir, "out"))).code).toBe(2);
  const normal = encodeTar([fileEntry("linked", "new data")]);
  expect((await execute(["tar", "-xf", "-"], normal, join(dir, "out"))).code).toBe(0);
  expect(readFileSync(join(dir, "outside/precious"), "utf8")).toBe("unchanged");
  expect(readFileSync(join(dir, "out/linked"), "utf8")).toBe("new data");
});

test("tar detects truncation and gzip corruption", async () => {
  const archive = encodeTar([fileEntry("large", "x".repeat(1024))]);
  expect((await execute(["tar", "-tf", "-"], archive.subarray(0, 700))).code).toBe(2);
  const gz = gzipSync(archive); gz[gz.length - 8] ^= 1;
  expect((await execute(["tar", "-tzf", "-"], gz)).code).toBe(2);
});

test("gzip and aliases roundtrip binary stdin, concatenate members and interoperate with GNU gzip", async () => {
  const data = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 256));
  const compressed = await execute(["gzip", "-9nc"], data);
  expect(compressed.code).toBe(0);
  expect(gunzipSync(compressed.output)).toEqual(data);
  expect((await execute(["gzip", "-dc"], compressed.output, dir, true)).output).toEqual(data);
  const host = await execute(["gzip", "-nc"], data, dir, true);
  expect((await execute(["gunzip", "-c"], host.output)).output).toEqual(data);
  expect((await execute(["zcat"], Buffer.concat([host.output, compressed.output]))).output).toEqual(Buffer.concat([data, data]));
});

test("gzip preserves metadata, keeps originals when requested, refuses overwrite and restores original name", async () => {
  const source = join(dir, "original"); writeFileSync(source, "gzip file content\n");
  chmodSync(source, 0o640); utimesSync(source, 1234567800, 1234567890);
  expect((await execute(["gzip", "-k", "original"])).code).toBe(0);
  expect(existsSync(source)).toBe(true);
  expect(statSync(join(dir, "original.gz")).mode & 0o777).toBe(0o640);
  expect((await execute(["gunzip", "original.gz"])).code).toBe(1);
  expect(readFileSync(source, "utf8")).toBe("gzip file content\n");
  expect((await execute(["gzip", "-t", "original.gz"])).code).toBe(0);
  expect((await execute(["gzip", "-l", "original.gz"])).stdout).toContain("original");
  rmSync(source);
  writeFileSync(join(dir, "renamed.gz"), readFileSync(join(dir, "original.gz")));
  expect((await execute(["gunzip", "-N", "renamed.gz"])).code).toBe(0);
  expect(readFileSync(source, "utf8")).toBe("gzip file content\n");
  expect(statSync(source).mtimeMs).toBe(1234567890000);
  expect(existsSync(join(dir, "renamed.gz"))).toBe(false);
});

test("gzip corrupt input never removes source or damages existing output", async () => {
  const compressed = gzipSync("data"); compressed[compressed.length - 8] ^= 1;
  writeFileSync(join(dir, "data.gz"), compressed); writeFileSync(join(dir, "data"), "keep");
  expect((await execute(["gzip", "-df", "data.gz"])).code).toBe(1);
  expect(readFileSync(join(dir, "data"), "utf8")).toBe("keep");
  expect(readFileSync(join(dir, "data.gz"))).toEqual(compressed);
  expect((await execute(["gzip", "-t"], compressed)).code).toBe(1);
  expect((await execute(["gzip", "-dc"], "plain")).code).toBe(1);
  expect((await execute(["gzip", "-cdf"], "plain")).stdout).toBe("plain");
});

test("cpio creates interoperable bin, odc, newc, crc archives and restores hardlinks", async () => {
  const names = fixture();
  for (const format of ["bin", "odc", "newc", "crc"]) {
    const archive = await execute(["cpio", "-o", "-H", format, "--quiet"], names);
    expect(archive).toMatchObject({ code: 0, stderr: "" });
    mkdirSync(join(dir, `${format}-host`));
    expect((await execute(["cpio", "-idmu", "--quiet"], archive.output, join(dir, `${format}-host`), true)).code).toBe(0);
    assertFixture(join(dir, `${format}-host`));
    mkdirSync(join(dir, `${format}-bnu`));
    const result = await execute(["cpio", "-idmu", "--quiet"], archive.output, join(dir, `${format}-bnu`));
    expect(result).toMatchObject({ code: 0, stderr: "" });
    assertFixture(join(dir, `${format}-bnu`));
  }
});

test("cpio reads archives from GNU cpio and supports patterns, null lists and pass-through", async () => {
  const names = fixture();
  for (const format of ["bin", "odc", "newc", "crc"]) {
    const archive = await execute(["cpio", "-oH", format, "--quiet"], names, dir, true);
    mkdirSync(join(dir, format));
    expect((await execute(["cpio", "-idmu", "--quiet"], archive.output, join(dir, format))).code).toBe(0);
    assertFixture(join(dir, format));
    expect((await execute(["cpio", "-t", "--quiet", "source/sub/*"], archive.output)).stdout).toBe("source/sub/message\n");
  }
  mkdirSync(join(dir, "passed"));
  expect((await execute(["cpio", "-0pdmu", "--quiet", "passed"], names.replaceAll("\n", "\0"))).code).toBe(0);
  assertFixture(join(dir, "passed"));
});

test("cpio CRC verification, malformed inputs and missing directory handling", async () => {
  const archive = encodeCpio([fileEntry("nested/file")], "crc");
  const decoded = decodeCpio(archive);
  expect(decoded.entries[0].data.toString()).toBe("content");
  const dataAt = archive.indexOf(Buffer.from("content"));
  archive[dataAt] ^= 1;
  expect((await execute(["cpio", "-t", "--quiet"], archive)).code).toBe(1);
  expect((await execute(["cpio", "-t", "--quiet"], Buffer.from("070701"))).code).toBe(1);
  const valid = encodeCpio([fileEntry("nested/file")], "newc");
  expect((await execute(["cpio", "-i", "--quiet"], valid)).code).toBe(1);
  expect((await execute(["cpio", "-id", "--quiet"], valid)).code).toBe(0);
  expect(readFileSync(join(dir, "nested/file"), "utf8")).toBe("content");
});
