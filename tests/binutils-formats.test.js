import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseObject, encodeAr, parseAr } from "../src/shared/object-files.js";
import { transformObject } from "../src/shared/object-transform.js";

let dir;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),"bnu-formats-"));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
async function run(args) {
  const child=Bun.spawn(args,{cwd:dir,stdin:"ignore",stdout:"pipe",stderr:"pipe"});
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,stdout,stderr};
}
const marker="SENSITIVE_DEBUG_SOURCE_MARKER";
async function compile(target) {
  await writeFile(join(dir,`${marker}.c`),"extern int external(void); static volatile int storage[5]; int answer(void) { return external() + 1 + storage[3]; }\n");
  await writeFile(join(dir,"stub.c"),"extern int answer(void); void __main(void){} int external(void){return 41;} int main(void){return answer();} int entry(void){return answer();}\n");
  const a=await run(["clang",`--target=${target}`,"-g","-gdwarf-4","-c",`${marker}.c`,"-o","original.o"]);
  expect(a.code).toBe(0);
  expect((await run(["clang",`--target=${target}`,"-c","stub.c","-o","stub.o"])).code).toBe(0);
  return await readFile(join(dir,"original.o"));
}

test("strip-debug physically erases debug data and leaves cross-platform objects linkable",async()=>{
  for(const [target,format,arch] of [["x86_64-unknown-linux-gnu","elf","x86_64"],["aarch64-unknown-linux-gnu","elf","arm64"],["x86_64-w64-windows-gnu","coff","x86_64"],["aarch64-w64-windows-gnu","coff","arm64"],["x86_64-apple-macos13","macho","x86_64"],["arm64-apple-macos13","macho","arm64"]]) {
    const original=await compile(target);
    expect(original.includes(Buffer.from(marker))).toBe(true);
    const result=transformObject(original,{stripDebug:true}),obj=parseObject(result);
    expect(obj.format).toBe(format);
    expect(result.includes(Buffer.from(marker))).toBe(false);
    expect(obj.sections.some(s=>/debug/.test(s.name))).toBe(false);
    expect(obj.relocations.length).toBeGreaterThan(0);
    expect(obj.sections.filter(s=>s.bss).reduce((n,s)=>n+s.size,0)).toBeGreaterThanOrEqual(20);
    await writeFile(join(dir,"stripped.o"),result);
    const inspect=await run(["llvm-readobj","--sections","--symbols","--relocations","stripped.o"]);
    expect(inspect.code).toBe(0);expect(inspect.stderr).toBe("");
    const command=format==="elf" ? ["ld.lld","-e","entry","stripped.o","stub.o","-o","linked"] : format==="coff" ? ["lld-link","/entry:entry","/subsystem:console","/nodefaultlib","/out:linked.exe","stripped.o","stub.o"] : ["ld64.lld","-arch",arch,"-platform_version","macos","13.0","13.0","-e","_entry","-o","linked","stripped.o","stub.o"];
    const link=await run(command);expect(link.stderr).toBe("");expect(link.code).toBe(0);
  }
},60000);

test("strip-all preserves dynamic executable behavior and removes debug and local symbol strings",async()=>{
  await compile("x86_64-unknown-linux-gnu");
  expect((await run(["clang","original.o","stub.o","-o","before"])).code).toBe(0);
  const bytes=await readFile(join(dir,"before")),result=transformObject(bytes,{stripAll:true});
  expect(result.includes(Buffer.from(marker))).toBe(false);
  expect(result.includes(Buffer.from("answer\0"))).toBe(false);
  await writeFile(join(dir,"after"),result,{mode:0o755});
  expect((await run([join(dir,"after")])).code).toBe(42);
  const check=await run(["readelf","-a","after"]);expect(check.code).toBe(0);expect(check.stderr).toBe("");
});

test("ELF COMDAT groups and address-significance indexes survive debug stripping",async()=>{
  await writeFile(join(dir,"group.cpp"),"template <typename T> T twice(T v){return v+v;} int answer(){return twice(21);}\n");
  await writeFile(join(dir,"main.cpp"),"int answer(); int main(){return answer();}\n");
  expect((await run(["clang++","-g","-faddrsig","-c","group.cpp","-o","group.o"])).code).toBe(0);
  const transformed=transformObject(await readFile(join(dir,"group.o")),{stripDebug:true});
  await writeFile(join(dir,"stripped.o"),transformed);
  const check=await run(["readelf","-a","stripped.o"]);expect(check.stderr).toBe("");
  const link=await run(["clang++","-fuse-ld=lld","main.cpp","stripped.o","-o","run"]);expect(link.stderr).toBe("");expect(link.code).toBe(0);
  expect((await run([join(dir,"run")])).code).toBe(42);
});

test("archive encoding honors deterministic metadata and host linkers accept foreign member indexes",async()=>{
  const bytes=await compile("x86_64-w64-windows-gnu");
  const archive=encodeAr([{name:"very long object filename.o",data:bytes,mode:0o100755,mtime:123,uid:12,gid:34}]);
  const members=parseAr(archive).filter(m=>!m.special);expect(members[0].name).toBe("very long object filename.o");
  expect(members[0].mode&0o777).toBe(0o644);
  expect(parseAr(encodeAr([{name:"file",data:bytes,mode:0o100755}],true,false)).find(m=>!m.special).mode&0o777).toBe(0o755);
  await writeFile(join(dir,"library.a"),archive);
  const linked=await run(["lld-link","/entry:entry","/subsystem:console","/nodefaultlib","/out:linked.exe","stub.o","library.a"]);
  expect(linked.stderr).toBe("");expect(linked.code).toBe(0);
});

test("PE stripping erases CodeView/PDB identifiers without disturbing mapped sections",async()=>{
  await compile("x86_64-w64-windows-gnu");
  expect((await run(["lld-link","/debug",`/pdb:${marker}.pdb`,"/entry:entry","/subsystem:console","/nodefaultlib","/out:before.exe","original.o","stub.o"])).code).toBe(0);
  const before=await readFile(join(dir,"before.exe"));expect(before.includes(Buffer.from(marker))).toBe(true);
  const after=transformObject(before,{stripDebug:true});expect(after.includes(Buffer.from(marker))).toBe(false);
  const old=parseObject(before),next=parseObject(after);
  expect(next.entry).toBe(old.entry);
  expect(next.sections.find(s=>s.name===".text").data).toEqual(old.sections.find(s=>s.name===".text").data);
  await writeFile(join(dir,"after.exe"),after);
  const check=await run(["llvm-readobj","--file-headers","--sections","after.exe"]);expect(check.code).toBe(0);expect(check.stderr).toBe("");
});

test("ar refuses extraction through symlinks and ranlib -t leaves archive members untouched",async()=>{
  const archive=encodeAr([{name:"member",data:Buffer.from("archive\n"),mode:0o644}]);
  await writeFile(join(dir,"archive.a"),archive);await writeFile(join(dir,"target"),"keep\n");await symlink("target",join(dir,"member"));
  const command=(name,args)=>run([process.execPath,join(import.meta.dir,`../src/commands/${name}.js`),...args]);
  expect((await command("ar",["x","archive.a"])).code).toBe(1);expect(await readFile(join(dir,"target"),"utf8")).toBe("keep\n");
  expect((await command("ranlib",["-t","archive.a"])).code).toBe(0);
  const after=await readFile(join(dir,"archive.a"));
  const masked=Buffer.from(after);archive.copy(masked,24,24,36);expect(masked).toEqual(archive);
  expect(parseAr(after).find(m=>!m.special).data.toString()).toBe("archive\n");
});
