import { test,expect,beforeEach,afterEach } from "bun:test";
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { objectMembers } from "../src/shared/object-files.js";
import { DwarfInfo } from "../src/shared/dwarf.js";

let directory;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(),"bnu-dwarf-")); writeFileSync(join(directory,"source.c"),"int add(int x) {\n  return x + 3;\n}\nint main(void) {\n  return add(2);\n}\n"); });
afterEach(() => rmSync(directory,{recursive:true,force:true}));
function native(command,args) {
  const result = Bun.spawnSync([command,...args],{cwd:directory,env:{...process.env,LC_ALL:"C"},stdout:"pipe",stderr:"pipe"});
  if (result.exitCode) throw new Error(`${command} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
async function run(args,input = "",system = false) {
  const proc = Bun.spawn(system ? ["addr2line",...args] : [process.execPath,join(import.meta.dir,"../src/commands/addr2line.js"),...args],{cwd:directory,env:{...process.env,LC_ALL:"C",GNULY_CORRECT:"1"},stdin:new Blob([input]),stdout:"pipe",stderr:"pipe"});
  const [code,stdout,stderr] = await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]); return {code,stdout,stderr};
}
async function same(args,input = "") {
  const actual = await run(args,input), expected = await run(args,input,true);
  expect(actual.code).toBe(expected.code); expect(actual.stdout).toBe(expected.stdout); expect(actual.stderr).toBe("");
  // Some GNU binutils versions warn about Clang's DWARF 5 file index zero,
  // even while returning the correct source mapping. Do not reproduce that bug.
}
test("addr2line matches GNU for DWARF 2 through 5 ELF objects and executables", async () => {
  for (const version of [2,3,4,5]) {
    for (const linked of [false,true]) {
      const file = `elf-${version}${linked ? "" : ".o"}`;
      native("clang",[`-gdwarf-${version}`,"-O0",...(linked ? ["-no-pie"] : ["-c"]),"source.c","-o",file]);
      const obj = objectMembers(join(directory,file))[0], add = obj.symbols.find((symbol) => symbol.name === "add"), main = obj.symbols.find((symbol) => symbol.name === "main");
      const addresses = [add.value,add.value+11n,main.value,main.value+19n,0xffffffffn].map((value) => value.toString(16));
      for (const flags of [[],["-f"],["-afsp"],["-a","-f","-C"]]) {
        const args = [...flags,"-e",file,...addresses]; await same(args);
      }
    }
  }
});
test("addr2line resolves relocated DWARF on COFF and Mach-O across architectures", async () => {
  for (const target of ["x86_64-w64-windows-gnu","aarch64-w64-windows-gnu","x86_64-apple-darwin","arm64-apple-darwin","aarch64-linux-gnu","riscv64-linux-gnu"]) {
    for (const version of [4,5]) {
      const file = `${target}-${version}.o`;
      native("clang",["-target",target,`-gdwarf-${version}`,"-O0","-c","source.c","-o",file]);
      const obj = objectMembers(join(directory,file))[0], main = obj.symbols.find((symbol) => symbol.name === "main" || symbol.name === "_main"), add = obj.symbols.find((symbol) => symbol.name === "add" || symbol.name === "_add");
      const result = await run(["-fse",file,add.value.toString(16),main.value.toString(16)]);
      expect(result).toEqual({code:0,stdout:"add\nsource.c:1\nmain\nsource.c:4\n",stderr:""});
    }
  }
});
test("addr2line reads addresses from stdin and resolves C++ names", async () => {
  writeFileSync(join(directory,"source.cpp"),"int sum(int x) {\n return x+1;\n}\n"); native("clang++",["-g","-c","source.cpp","-o","cpp.o"]);
  const obj = objectMembers(join(directory,"cpp.o"))[0], fn = obj.symbols.find((symbol) => symbol.name.includes("sum"));
  for (const flags of [["-f"],["-fC"],["-afpsC"]]) await same([...flags,"-e","cpp.o"],`${fn.value.toString(16)}\nffffffff\n`);
});
test("addr2line honors section-relative addresses and compressed DWARF", async () => {
  native("clang",["-gdwarf-5","-O0","-ffunction-sections","-c","source.c","-o","sections.o"]);
  for (const section of [".text.add",".text.main"]) await same(["-fse","sections.o","-j",section,"0"]);
  native("clang",["-gdwarf-5","-O0","-c","source.c","-o","compressed.o"]);
  for (const method of ["zlib-gabi","zlib-gnu"]) {
    native("objcopy",[`--compress-debug-sections=${method}`,"compressed.o",`${method}.o`]);
    await same(["-fse",`${method}.o`,"0","b"]);
  }
});
test("addr2line handles optimized inline frames and malformed objects", async () => {
  writeFileSync(join(directory,"inline.c"),"volatile int value;\nstatic inline int bump(int x) {\n value=x;\n return x+1;\n}\nint main(void) {\n return bump(value);\n}\n");
  native("clang",["-gdwarf-5","-O2","-no-pie","inline.c","-o","inline"]);
  const obj = objectMembers(join(directory,"inline"))[0], main = obj.symbols.find((symbol) => symbol.name === "main"), info = new DwarfInfo(obj);
  const addresses = Array.from({length:main.size},(_,i) => (main.value+BigInt(i)).toString(16));
  expect(info.rows.some((row) => row.line === 3)).toBe(true);
  await same(["-fis","-e","inline",...addresses]);
  writeFileSync(join(directory,"invalid"),"not an object"); expect((await run(["-e","invalid","0"])).code).toBe(1);
  const data = readFileSync(join(directory,"inline")); writeFileSync(join(directory,"truncated"),data.subarray(0,30)); expect((await run(["-e","truncated","0"])).code).toBe(1);
  expect((await run(["-e","inline","-j",".missing","0"])).code).toBe(1);
  expect((await run(["-e","inline","--target=invalid","0"])).code).toBe(1);
  await same(["-e","inline","--target=elf64-x86-64",main.value.toString(16)]);
});
