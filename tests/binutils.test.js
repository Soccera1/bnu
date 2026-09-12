import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, stat, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseObject, parseAr, encodeAr } from "../src/shared/object-files.js";
let dir;
const root = join(import.meta.dir, "..");
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bnu-binutils-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function exec(argv, input = "") {
  const p = Bun.spawn(argv, { cwd: dir, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C", GNULY_CORRECT: "1" } });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
  return { code, stdout: Buffer.from(out).toString(), bytes: Buffer.from(out), stderr: err };
}
const bnu = (args, input) => exec([process.execPath, join(root, "bin/bnu.js"), ...args], input);
async function compile(target = "x86_64-unknown-linux-gnu", name = "fixture.o", debug = false) {
  await writeFile(join(dir, "fixture.c"), 'int data=7; int bss; const char marker[]="printable fixture marker"; int answer(void) { return data+35; }\n');
  const result = await exec(["clang", `--target=${target}`, "-c", ...(debug ? ["-g", "-gdwarf-4"] : []), "fixture.c", "-o", name]);
  expect(result.code).toBe(0);
  return name;
}

test("binutils inspect compiler-generated ELF, COFF and Mach-O on x86-64 and ARM64", async () => {
  for (const target of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc", "x86_64-apple-darwin", "arm64-apple-darwin"]) {
    await compile(target);
    const obj = parseObject(await readFile(join(dir, "fixture.o")));
    expect(obj.sections.some(s => s.executable)).toBe(true);
    const names = await bnu(["nm", "fixture.o"]);
    expect(names.code).toBe(0);
    expect(names.stdout).toMatch(/ T _?answer/);
    expect(names.stdout).toMatch(/ D _?data/);
    expect(names.stdout).toMatch(/ [BC] _?bss/);
    const sizes = await bnu(["size", "fixture.o"]);
    expect(sizes.code).toBe(0);
    expect(sizes.stdout).toContain("fixture.o");
    const dump = await bnu(["objdump", "-fht", "fixture.o"]);
    expect(dump.code).toBe(0);
    expect(dump.stdout).toContain("answer");
    const dis = await bnu(["objdump", "-d", "fixture.o"]);
    expect(dis.code).toBe(0);
    expect(dis.stdout).toMatch(/ret/);
    expect((await bnu(["strings", "fixture.o"])).stdout).toContain("printable fixture marker");
  }
}, 60000);

test("as generates interoperable objects for ELF, COFF and Mach-O targets", async () => {
  for (const target of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc", "x86_64-apple-darwin", "arm64-apple-darwin"]) {
    const arm = /aarch64|arm64/.test(target);
    const source = `.text\n.globl answer\nanswer:\n${arm ? "mov w0, #42" : "mov $42, %eax"}\nret\n`;
    const result = await bnu(["as", `--target=${target}`, "-o", "answer.o"], source);
    expect(result.code).toBe(0);
    const inspect = await exec(["llvm-readobj", "--file-headers", "--symbols", "answer.o"]);
    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain("answer");
  }
  const invalid = await bnu(["as", "-o", "bad.o"], "definitely_not_an_instruction\n");
  expect(invalid.code).not.toBe(0);
  expect(await stat(join(dir, "bad.o")).catch(() => null)).toBeNull();
}, 60000);

test("ar and ranlib produce GNU-compatible archives and usable linker indexes", async () => {
  expect((await bnu(["as", "-o", "answer.o"], ".globl answer\nanswer: mov $42, %eax\nret\n")).code).toBe(0);
  expect((await bnu(["ar", "rcs", "libanswer.a", "answer.o"])).code).toBe(0);
  expect((await exec(["ar", "t", "libanswer.a"])).stdout).toBe("answer.o\n");
  await writeFile(join(dir, "main.c"), "extern int answer(void); int main(void){return answer();}\n");
  expect((await exec(["gcc", "main.c", "libanswer.a", "-o", "main"])).code).toBe(0);
  expect((await exec([join(dir, "main")])).code).toBe(42);
  expect((await bnu(["ar", "rcS", "unindexed.a", "answer.o"])).code).toBe(0);
  expect((await bnu(["ranlib", "unindexed.a"])).code).toBe(0);
  expect((await exec(["nm", "-s", "unindexed.a"])).stdout).toContain("answer in answer.o");
  const before = await readFile(join(dir, "libanswer.a"));
  expect((await bnu(["ranlib", "libanswer.a"])).code).toBe(0);
  expect(await readFile(join(dir, "libanswer.a"))).toEqual(before);
});

test("ar handles long names, member operations, foreign archives and unsafe names", async () => {
  const name = "a very long member filename.txt";
  await writeFile(join(dir, name), "long member\n");
  await writeFile(join(dir, "short"), "short member\n");
  expect((await bnu(["ar", "rc", "test.a", name, "short"])).code).toBe(0);
  expect((await exec(["ar", "p", "test.a", name])).stdout).toBe("long member\n");
  expect((await bnu(["ar", "d", "test.a", "short"])).code).toBe(0);
  expect((await bnu(["ar", "t", "test.a"])).stdout).toBe(`${name}\n`);
  expect((await exec(["ar", "rc", "host.a", name])).code).toBe(0);
  expect((await bnu(["ar", "p", "host.a", name])).stdout).toBe("long member\n");
  await writeFile(join(dir, "café"), "unicode member\n");
  expect((await bnu(["ar", "rc", "unicode.a", "café"])).code).toBe(0);
  expect((await exec(["ar", "t", "unicode.a"])).stdout).toBe("café\n");
  expect((await bnu(["ar", "p", "unicode.a", "café"])).stdout).toBe("unicode member\n");
  await writeFile(join(dir, "bad.a"), encodeAr([{ name: "../outside", data: Buffer.from("unsafe") }]));
  const result = await bnu(["ar", "x", "bad.a"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("unsafe");
  expect(() => parseAr(Buffer.from("!<arch>\nshort"))).toThrow();
});

test("readelf displays ELF headers, symbols, relocations and section contents", async () => {
  await compile();
  const result = await bnu(["readelf", "-hSsr", "-x", ".data", "fixture.o"]);
  expect(result.code).toBe(0);
  for (const text of ["ELF64", ".symtab", "answer", "data", "R_X86_64_", "07000000"]) expect(result.stdout).toContain(text);
  expect((await bnu(["readelf", "-x", "does-not-exist", "fixture.o"])).code).toBe(1);
  await compile("x86_64-pc-windows-msvc");
  expect((await bnu(["readelf", "-h", "fixture.o"])).code).toBe(1);
});

test("objcopy extracts binary data and creates linkable binary ELF wrappers", async () => {
  const binary = Buffer.from([0, 1, 2, 128, 255, 4, 5]);
  await writeFile(join(dir, "input.bin"), binary);
  expect((await bnu(["objcopy", "-I", "binary", "-O", "elf64-x86-64", "input.bin", "wrapped.o"])).code).toBe(0);
  const nm = await exec(["nm", "wrapped.o"]);
  expect(nm.code).toBe(0);
  expect(nm.stdout).toContain("0000000000000000 D _binary_input_bin_start");
  expect(nm.stdout).toContain("0000000000000007 D _binary_input_bin_end");
  expect(nm.stdout).toContain("0000000000000007 A _binary_input_bin_size");
  expect((await bnu(["objcopy", "-O", "binary", "wrapped.o", "roundtrip.bin"])).code).toBe(0);
  expect(await readFile(join(dir, "roundtrip.bin"))).toEqual(binary);
});

test("objcopy adds, renames, updates, dumps and removes ELF sections", async () => {
  await compile();
  await writeFile(join(dir, "note.bin"), "first");
  expect((await bnu(["objcopy", "--add-section=.custom=note.bin", "fixture.o", "added.o"])).code).toBe(0);
  expect((await exec(["readelf", "-p", ".custom", "added.o"])).stdout).toContain("first");
  expect((await bnu(["objcopy", "--rename-section=.custom=.renamed", "added.o", "renamed.o"])).code).toBe(0);
  await writeFile(join(dir, "note.bin"), "second contents");
  expect((await bnu(["objcopy", "--update-section=.renamed=note.bin", "renamed.o"])).code).toBe(0);
  expect((await bnu(["objcopy", "--dump-section=.renamed=dump.bin", "renamed.o", "copy.o"])).code).toBe(0);
  expect(await readFile(join(dir, "dump.bin"), "utf8")).toBe("second contents");
  expect((await bnu(["objcopy", "-R", ".renamed", "copy.o", "removed.o"])).code).toBe(0);
  expect((await exec(["readelf", "-S", "removed.o"])).stdout).not.toContain(".renamed");
  const info = await exec(["readelf", "-a", "removed.o"]);
  expect(info.code).toBe(0);
  expect(info.stderr).toBe("");
});

test("strip preserves executable behavior and relocatable links while removing debug data", async () => {
  await compile("x86_64-unknown-linux-gnu", "fixture.o", true);
  expect((await bnu(["strip", "-g", "-o", "stripped.o", "fixture.o"])).code).toBe(0);
  const sections = await exec(["readelf", "-S", "stripped.o"]);
  expect(sections.code).toBe(0);
  expect(sections.stdout).not.toContain(".debug_");
  expect(sections.stderr).toBe("");
  await writeFile(join(dir, "main.c"), "extern int answer(void); int main(void){return answer();}\n");
  expect((await exec(["gcc", "-g", "main.c", "stripped.o", "-o", "main"])).code).toBe(0);
  expect((await bnu(["strip", "main"])).code).toBe(0);
  expect((await exec([join(dir, "main")])).code).toBe(42);
  expect(parseObject(await readFile(join(dir, "main"))).symbols.filter(s => !s.dynamic)).toHaveLength(0);
  expect((await bnu(["objcopy", "--strip-symbol=data", "fixture.o", "bad.o"])).code).not.toBe(0);
  expect(await stat(join(dir, "bad.o")).catch(() => null)).toBeNull();
});

test("strip and objcopy manipulate COFF and Mach-O headers without corrupting objects", async () => {
  for (const target of ["x86_64-pc-windows-msvc", "x86_64-apple-darwin", "aarch64-pc-windows-msvc", "arm64-apple-darwin"]) {
    await compile(target, "fixture.o", true);
    expect((await bnu(["strip", "-g", "-o", "debugless.o", "fixture.o"])).code).toBe(0);
    const obj = parseObject(await readFile(join(dir, "debugless.o")));
    expect(obj.sections.some(s => /(?:\.debug|__debug)/.test(s.name))).toBe(false);
    expect(obj.symbols.some(s => /answer/.test(s.name))).toBe(true);
    expect((await exec(["llvm-readobj", "--sections", "--symbols", "debugless.o"])).code).toBe(0);
    const textName = target.includes("apple") ? "__text" : ".text";
    expect((await bnu(["objcopy", "-O", "binary", "-j", textName, "fixture.o", "code.bin"])).code).toBe(0);
    expect((await readFile(join(dir, "code.bin"))).length).toBeGreaterThan(0);
    expect((await bnu(["strip", "-o", "all-stripped.o", "fixture.o"])).code).toBe(0);
    expect(parseObject(await readFile(join(dir, "all-stripped.o"))).symbols).toHaveLength(0);
  }
}, 60000);

test("strings handles offsets, minimum length, encodings and stdin like GNU", async () => {
  const input = Buffer.from("\0abc\0printable\n\0word\tword\0", "latin1");
  for (const flags of [[], ["-n", "3"], ["-t", "x"], ["-t", "d"], ["-w"], ["-s", "|"]]) {
    const actual = await bnu(["strings", ...flags], input);
    const expected = await exec(["strings", ...flags], input);
    expect(actual.stdout).toBe(expected.stdout);
    expect(actual.code).toBe(expected.code);
  }
  const input16 = Buffer.from("\0wide text\0", "utf16le");
  expect((await bnu(["strings", "-e", "l"], input16)).stdout).toBe("wide text\n");
});

test("elfedit filters and updates header fields, and C++ demangling matches GNU", async () => {
  await compile();
  expect((await bnu(["elfedit", "--input-mach=x86_64", "--output-osabi=freebsd", "--output-abiversion=3", "fixture.o"])).code).toBe(0);
  const obj = parseObject(await readFile(join(dir, "fixture.o")));
  expect(obj.osabi).toBe(9);
  expect(obj.abiVersion).toBe(3);
  expect((await bnu(["elfedit", "--input-mach=i386", "--output-type=dyn", "fixture.o"])).code).not.toBe(0);
  for (const names of [["_Z3fooi", "_ZN3Foo3barEv", "plain"], ["-p", "_Z3fooi"]]) {
    expect((await bnu(["c++filt", ...names])).stdout).toBe((await exec(["c++filt", ...names])).stdout);
  }
  expect((await bnu(["c++filt"], "call _Z3fooi now\n")).stdout).toBe("call foo(int) now\n");
});

test("binary readers reject malformed file offsets and truncated headers", async () => {
  await compile();
  const bytes = await readFile(join(dir, "fixture.o"));
  for (const length of [0, 4, 16, 40, 63, bytes.length - 1]) {
    const bad = bytes.subarray(0, length);
    expect(() => parseObject(bad)).toThrow();
  }
  const corrupt = Buffer.from(bytes);
  corrupt.writeBigUInt64LE(0xffffffffffffffffn, 40);
  expect(() => parseObject(corrupt)).toThrow();
  await writeFile(join(dir, "bad.o"), corrupt);
  for (const name of ["nm", "readelf", "objdump", "size", "strip"]) {
    const before = await readFile(join(dir, "bad.o"));
    expect((await bnu([name, ...(name === "readelf" ? ["-a"] : name === "objdump" ? ["-h"] : []), "bad.o"])).code).not.toBe(0);
    expect(await readFile(join(dir, "bad.o"))).toEqual(before);
  }
});

test("assembler handles warning controls and reports unsupported DWARF version selection", async () => {
  const source = '.warning "visible warning"\n.text\n.globl sample\nsample: ret\n';
  const ordinary = await bnu(["as", "-o", "ordinary.o"], source);
  expect(ordinary.code).toBe(0); expect(ordinary.stderr).toContain("visible warning");
  expect((await bnu(["as", "-W", "-o", "quiet.o"], source))).toMatchObject({ code: 0, stderr: "" });
  expect((await bnu(["as", "--fatal-warnings", "-o", "fatal.o"], source)).code).toBe(1);
  expect(await stat(join(dir, "fatal.o")).catch(() => null)).toBeNull();
  expect((await bnu(["as", "--gdwarf-4", "-o", "version.o"], ".text\nret\n")).stderr).toContain("selecting a DWARF version is not supported");
  expect((await bnu(["as", "-g", "-o", "debug.o"], ".text\nret\n")).code).toBe(0);
  expect(parseObject(await readFile(join(dir, "debug.o"))).sections.some(section => section.name === ".debug_line")).toBe(true);
});

test("nm and objdump distinguish static symbols from dynamic symbols and relocations", async () => {
  await writeFile(join(dir, "shared.c"), "extern int outside; int exported(void) { return outside; }\n");
  expect((await exec(["clang", "-fPIC", "-shared", "-s", "shared.c", "-o", "shared.so"])).code).toBe(0);
  expect((await bnu(["nm", "shared.so"])).stdout).not.toContain("exported");
  expect((await bnu(["nm", "-D", "shared.so"])).stdout).toContain("exported");
  expect((await bnu(["objdump", "-t", "shared.so"])).stdout).not.toContain("exported");
  expect((await bnu(["objdump", "-T", "shared.so"])).stdout).toContain("exported");
  expect((await bnu(["objdump", "-R", "shared.so"])).stdout).toContain("outside");
});

test("objdump displays archive metadata and rejects unsupported disassembler options", async () => {
  await compile();
  expect((await bnu(["ar", "rcs", "libfixture.a", "fixture.o"])).code).toBe(0);
  const archive = await bnu(["objdump", "-a", "libfixture.a"]);
  expect(archive.code).toBe(0); expect(archive.stdout).toContain("In archive libfixture.a:");
  expect(archive.stdout).toMatch(/\d+\/\d+ \d+ .* fixture\.o/);
  expect((await bnu(["objdump", "-d", "-M", "unknown", "fixture.o"])).code).toBe(1);
  expect((await bnu(["objdump", "-dl", "fixture.o"])).stderr).toContain("source line display is not supported");
});

test("objcopy validates requested input format and binary architecture", async () => {
  await compile();
  expect((await bnu(["objcopy", "-I", "pe-x86-64", "fixture.o", "wrong.o"])).code).toBe(1);
  expect(await stat(join(dir, "wrong.o")).catch(() => null)).toBeNull();
  await writeFile(join(dir, "input.bin"), "binary");
  expect((await bnu(["objcopy", "-I", "binary", "-O", "elf64-littleaarch64", "-B", "aarch64", "input.bin", "arm.o"])).code).toBe(0);
  expect(parseObject(await readFile(join(dir, "arm.o"))).arch).toBe("aarch64");
  expect((await bnu(["objcopy", "-I", "binary", "-O", "elf64-x86-64", "-B", "aarch64", "input.bin", "mismatch.o"])).code).toBe(1);
});

test("c++filt preserves underscored symbols and removes nested function parameters", async () => {
  for (const args of [["__Z3foov"], ["-n", "__Z3foov"], ["-_", "__Z3foov"], ["-p", "_Z3fooPFivE"], ["-p", "_ZNK3FooltEi"], ["-p", "plain(text)"]]) {
    expect((await bnu(["c++filt", ...args])).stdout).toBe((await exec(["c++filt", ...args])).stdout);
  }
});
