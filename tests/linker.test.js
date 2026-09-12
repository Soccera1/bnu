import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeAr, parseObject } from "../src/shared/object-files.js";

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bnu-linker-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function run(args, host = false) {
  const proc = Bun.spawn(host ? args : [process.execPath, join(import.meta.dir, "../bin/bnu.js"), ...args], {
    cwd: dir, env: { ...process.env, GNULY_CORRECT: "1" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

async function assemble(target, name, source) {
  writeFileSync(join(dir, `${name}.s`), source);
  const result = await run(["clang", "-target", target, "-c", `${name}.s`, "-o", `${name}.o`], true);
  expect(result).toMatchObject({ code: 0, stderr: "" });
}

test("ld links and runs an ELF executable with cross-object calls, data, bss and static archive selection", async () => {
  await assemble("x86_64-linux-gnu", "start", ".global _start\n.text\n_start:\n call answer\n mov %eax, %edi\n mov $60, %eax\n syscall\n");
  writeFileSync(join(dir, "answer.c"), "int data = 40; int zero; int answer(void) { zero = 2; return data + zero; }\n");
  expect((await run(["clang", "-c", "-ffreestanding", "-fno-pic", "-fno-pie", "answer.c", "-o", "answer.o"], true)).code).toBe(0);
  await assemble("x86_64-linux-gnu", "unused", ".global answer\n.text\nanswer:\n ret\n");
  writeFileSync(join(dir, "libanswers.a"), encodeAr([{ name: "answer.o", data: readFileSync(join(dir, "answer.o")) }, { name: "unused.o", data: readFileSync(join(dir, "unused.o")) }]));
  const linked = await run(["ld", "-static", "-o", "program", "start.o", "-L.", "-lanswers", "-Map=program.map"]);
  expect(linked).toMatchObject({ code: 0, stderr: "" });
  expect((await run([join(dir, "program")], true)).code).toBe(42);
  expect(readFileSync(join(dir, "program.map"), "utf8")).toContain("answer");
  const inspected = await run(["llvm-readobj", "--file-headers", "--program-headers", "--symbols", "program"], true);
  expect(inspected).toMatchObject({ code: 0, stderr: "" });
  expect(inspected.stdout).toContain("Executable");
  expect(inspected.stdout).toContain("answer");
  const object = parseObject(readFileSync(join(dir, "program")));
  expect(object.segments.some(segment => segment.type === 0x6474e551 && segment.flags === 6)).toBe(true);
  expect(object.segments.some(segment => segment.type === 1 && (segment.flags & 3) === 3)).toBe(false);
});

test("ld handles ELF GOT references, weak undefined symbols and COMMON allocation", async () => {
  await assemble("x86_64-linux-gnu", "start", ".global _start\n.weak absent\n.comm common,8,8\n.text\n_start:\n mov value@GOTPCREL(%rip), %rax\n mov (%rax), %edi\n movq $2, common(%rip)\n add common(%rip), %edi\n mov $60, %eax\n syscall\n.data\n.quad absent\n");
  await assemble("x86_64-linux-gnu", "value", ".global value\n.data\nvalue: .long 40\n");
  expect(await run(["ld", "-o", "program", "start.o", "value.o"])).toMatchObject({ code: 0, stderr: "" });
  expect((await run([join(dir, "program")], true)).code).toBe(42);
});

test("ld AArch64 ELF runs under qemu with function, ADRP, low12 and data relocations", async () => {
  if (!Bun.which("qemu-aarch64")) return;
  await assemble("aarch64-linux-gnu", "start", ".global _start\n.text\n_start:\n bl answer\n mov x8, #93\n svc #0\n");
  await assemble("aarch64-linux-gnu", "answer", ".global answer\n.text\nanswer:\n adrp x1, value\n add x1, x1, :lo12:value\n ldr w0, [x1]\n add w0, w0, #2\n ret\n.data\nvalue: .long 40\n");
  expect(await run(["ld", "-m", "aarch64linux", "-o", "program", "start.o", "answer.o"])).toMatchObject({ code: 0, stderr: "" });
  expect((await run(["qemu-aarch64", join(dir, "program")], true)).code).toBe(42);
});

test("ld reports unresolved symbols, duplicate definitions and incompatible inputs without an output", async () => {
  await assemble("x86_64-linux-gnu", "start", ".global _start\n.text\n_start: call missing\n");
  const unresolved = await run(["ld", "-o", "missing", "start.o"]);
  expect(unresolved.code).toBe(1); expect(unresolved.stderr).toContain("undefined reference to 'missing'");
  expect(existsSync(join(dir, "missing"))).toBe(false);
  const duplicate = await run(["ld", "-o", "duplicate", "start.o", "start.o"]);
  expect(duplicate.code).toBe(1); expect(duplicate.stderr).toContain("multiple definition");
  await assemble("aarch64-linux-gnu", "arm", ".global _start\n.text\n_start: ret\n");
  expect((await run(["ld", "-o", "mixed", "start.o", "arm.o"])).stderr).toContain("incompatible");
  expect((await run(["ld", "-shared", "start.o"])).stderr).toContain("only static executable linking");
  await assemble("x86_64-linux-gnu", "plain", ".global _start\n.text\n_start: ret\n");
  expect((await run(["ld", "-e", "0", "plain.o"])).stderr).toContain("entry point is outside executable sections");
});

async function verifyNativeTarget(target, format, arch) {
  const entry = format === "macho" ? "_start" : "_start", answer = format === "macho" ? "_answer" : "answer", value = format === "macho" ? "_value" : "value";
  let start;
  if (arch === "x86-64") start = `.global ${entry}\n.text\n${entry}:\n call ${answer}\n mov ${value}(%rip), %eax\n ret\n.data\n.global pointer\npointer: .quad ${value}\n`;
  else start = `.global ${entry}\n.text\n${entry}:\n bl ${answer}\n adrp x0, ${value}${format === "macho" ? "@PAGE" : ""}\n add x0, x0, ${format === "macho" ? `${value}@PAGEOFF` : `:lo12:${value}`}\n ldr w0, [x0]\n ret\n.data\n.global pointer\npointer: .quad ${value}\n`;
  await assemble(target, "start", start);
  await assemble(target, "answer", `.global ${answer}\n.text\n${answer}:\n${arch === "x86-64" ? " mov $42, %eax" : " mov w0, #42"}\n ret\n.data\n.global ${value}\n${value}: .long 42\n`);
  const result = await run(["ld", "-o", "program", "-e", entry, "start.o", "answer.o"]);
  expect(result).toMatchObject({ code: 0, stderr: "" });
  const object = parseObject(readFileSync(join(dir, "program")));
  expect(object.format).toBe(format); expect(object.arch).toBe(arch); expect(object.type).toBe(2);
  expect(object.relocations).toHaveLength(0);
  const inspected = await run(["llvm-readobj", "--file-headers", "--sections", "program"], true);
  expect(inspected).toMatchObject({ code: 0, stderr: "" });
  const linkedData = object.sections.filter(section => section.writable && section.size && !section.bss);
  const pointer = linkedData.find(section => section.data.length >= 8)?.data.readBigUInt64LE(0);
  expect(pointer).toBeGreaterThan(0x1000n);
  expect(object.sections.some(section => section.addr <= pointer && section.addr + BigInt(section.size) > pointer)).toBe(true);
  const code = object.sections.filter(section => section.executable && section.size);
  if (arch === "x86-64") {
    const target = code[0].addr + 5n + BigInt(code[0].data.readInt32LE(1));
    const targetSection = code.find(section => section.addr <= target && target < section.addr + BigInt(section.size));
    expect(targetSection?.data.subarray(Number(target - targetSection.addr), Number(target - targetSection.addr) + 5).toString("hex")).toBe("b82a000000");
    expect(code[0].addr + 11n + BigInt(code[0].data.readInt32LE(7))).toBe(pointer);
  } else {
    const branch = BigInt.asIntN(26, BigInt(code[0].data.readUInt32LE(0) & 0x03ffffff));
    const target = code[0].addr + branch * 4n;
    const targetSection = code.find(section => section.addr <= target && target < section.addr + BigInt(section.size));
    expect(targetSection?.data.readUInt32LE(Number(target - targetSection.addr))).toBe(0x52800540);
    const adrp = code[0].data.readUInt32LE(4), add = code[0].data.readUInt32LE(8);
    const pages = BigInt.asIntN(21, BigInt(((adrp >>> 29) & 3) | (((adrp >>> 5) & 0x7ffff) << 2)));
    expect(((code[0].addr + 4n) & ~4095n) + pages * 4096n + BigInt((add >>> 10) & 4095)).toBe(pointer);
  }
}

test("ld creates a native x86-64 pe executable with resolved instructions and pointers", async () => {
  await verifyNativeTarget("x86_64-pc-windows-msvc", "pe", "x86-64");
}, 60_000);

test("ld creates a native aarch64 pe executable with resolved instructions and pointers", async () => {
  await verifyNativeTarget("arm64-pc-windows-msvc", "pe", "aarch64");
}, 60_000);

test("ld creates a native x86-64 macho executable with resolved instructions and pointers", async () => {
  await verifyNativeTarget("x86_64-apple-macos", "macho", "x86-64");
}, 60_000);

test("ld creates a native aarch64 macho executable with resolved instructions and pointers", async () => {
  await verifyNativeTarget("arm64-apple-macos", "macho", "aarch64");
}, 60_000);

test("ld creates a native aarch64 elf executable with resolved instructions and pointers", async () => {
  await verifyNativeTarget("aarch64-linux-gnu", "elf", "aarch64");
}, 60_000);


test("ld links freestanding C emitted for all supported target families", async () => {
  writeFileSync(join(dir, "main.c"), "extern int value; extern int other(int); int entry(void) { return other(value + 2); }\n");
  writeFileSync(join(dir, "other.c"), "int value = 40; int other(int x) { return x; }\n");
  for (const target of ["x86_64-linux-gnu", "aarch64-linux-gnu", "x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc", "x86_64-apple-macos", "arm64-apple-macos"]) {
    for (const source of ["main", "other"]) {
      const compiled = await run(["clang", "-target", target, "-ffreestanding", "-fno-stack-protector", ...(target.includes("windows") ? ["-funwind-tables"] : []), "-c", `${source}.c`, "-o", `${source}.o`], true);
      expect(compiled).toMatchObject({ code: 0, stderr: "" });
    }
    const linked = await run(["ld", "-e", target.includes("apple") ? "_entry" : "entry", "-o", "program", "main.o", "other.o"]);
    expect(linked).toMatchObject({ code: 0, stderr: "" });
    expect((await run(["llvm-readobj", "--file-headers", "program"], true)).code).toBe(0);
    if (target.includes("windows")) {
      const bytes = readFileSync(join(dir, "program")), object = parseObject(bytes);
      const expectedPdata = ["main", "other"].reduce((sum, name) => sum + (parseObject(readFileSync(join(dir, `${name}.o`))).sections.find(section => section.name === ".pdata")?.size ?? 0), 0);
      expect(object.sections.filter(section => section.name === ".text")).toHaveLength(1);
      if (expectedPdata) {
        const pdata = object.sections.filter(section => section.name === ".pdata");
        expect(pdata).toHaveLength(1); expect(pdata[0].size).toBe(expectedPdata);
        const optional = object.headerOffset + 20;
        expect(bytes.readUInt32LE(optional + 116 + 3 * 8)).toBe(expectedPdata);
      }
    }
  }
});
