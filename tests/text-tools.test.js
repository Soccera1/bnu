import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, openSync, closeSync, writeSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(),"bnu-text-")); });
afterEach(() => { rmSync(directory,{recursive:true,force:true}); });
async function run(command,args,input = "",native = false) {
  const proc = Bun.spawn(native ? [command,...args] : [process.execPath,join(import.meta.dir,`../src/commands/${command}.js`),...args], {cwd:directory,env:{...process.env,LC_ALL:"C",GNULY_CORRECT:"1"},stdin:new Blob([input]),stdout:"pipe",stderr:"pipe"});
  const [code,stdout,stderr] = await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()]);
  return {code,stdout,stderr};
}
async function same(command,args,input = "") {
  const [actual,expected] = await Promise.all([run(command,args,input),run(command,args,input,true)]);
  expect(actual.stdout).toBe(expected.stdout);
  expect(actual.code).toBe(expected.code);
  expect(actual.stderr).toBe(expected.stderr);
}

test("grep matches BRE, ERE, fixed strings and POSIX longest matches", async () => {
  const input = "abc abc\na+b\naaa\n123\nhello_world\nworld!\n";
  for (const args of [["a\\+"],["-Eo","a|abc"],["-F","a+b"],["-n","^[[:digit:]]\\+$"],["-w","world"],["-iv","ABC"],["-x","aaa"],["-e","123","-e","world"]]) await same("grep",args,input);
});
test("grep preserves prefixes, contexts, counts and match byte offsets", async () => {
  const input = "one\ntwo two\nthree\nfour\nfive two\nsix\nseven\neight\n";
  for (const args of [["-nbo","two"],["-n","-C1","two"],["-n","-B2","-A1","five"],["-c","two"],["-m1","-A1","two"],["-v","-m2","two"],["-q","missing"],["-q","two"],["-zno","b"],["-o","a*"],["-o","^"]]) await same("grep",args,args.includes("-zno") ? "ab\0bc\0" : input);
});
test("grep recursively selects file patterns and filenames", async () => {
  mkdirSync(join(directory,"nested")); writeFileSync(join(directory,"a.txt"),"yes\nno\n"); writeFileSync(join(directory,"b.txt"),"no\n"); writeFileSync(join(directory,"nested","c.txt"),"yes\n"); writeFileSync(join(directory,"nested","d.log"),"yes\n");
  for (const args of [["-nH","yes","a.txt"],["-l","yes","a.txt","b.txt"],["-L","yes","a.txt","b.txt"],["-c","yes","a.txt","b.txt"],["-r","--include=*.txt","yes","nested"],["-r","--exclude=*.log","yes","nested"]]) await same("grep",args);
});
test("grep reports errors and empty pattern files correctly", async () => {
  writeFileSync(join(directory,"patterns"),""); await same("grep",["-f","patterns"],"one\n");
  expect((await run("grep",["["],"one\n")).code).toBe(2);
  expect((await run("grep",["x","missing"])).code).toBe(2);
  await same("grep",["-a","x"],"a\0x\n"); await same("grep",["-I","x"],"a\0x\n");
});
test("sed substitutions honor captures, occurrence, empties and transliteration", async () => {
  const input = "ab ab ab\nfoo123\nAAAA\n";
  for (const script of ["s/ab/X/g","s/ab/X/2","s/ab/X/2g","s/\\(foo\\)\\([0-9]*\\)/\\2-\\1/","s/a*/X/g","s/ab/[&]/g","s/A/\\l&/g","y/ab/AB/","s/no/yes/;s//x/"] ) await same("sed",[script],input);
  await same("sed",["-En","s/(foo)([0-9]+)/\\2\\1/p"],input);
});
test("sed addresses, ranges, branches and grouped commands", async () => {
  const input = "one\ntwo\nthree\nfour\nfive\nsix\n";
  for (const args of [["2,4d"],["-n","2,4p"],["-n","1~2p"],["-n","0,/three/p"],["-n","2,+2p"],["/two/,/four/!d"],["-n","2,4{s/o/O/g;p;}"] ,["-n","$p"],["2q"],["3Q"],["-n","/t/!p"],[":a;s/ee/e/;ta"]]) await same("sed",args,input);
});
test("sed pattern and hold spaces, multi-line cycles and inserted text", async () => {
  const input = "one\ntwo\nthree\nfour\nfive\n";
  for (const args of [["N;s/\\n/:/"],["-n","h;n;G;p"],["1h;1!H;$!d;x"],["-n","N;P;D"],["2a\\\nadded"],["2i\\\ninserted"],["2,4c\\\nchanged"],["n;d"],["-n","p"]]) await same("sed",args,input);
  await same("sed",["-n","p"],"unterminated"); await same("sed",["s/x/y/"],"x");
});
test("sed script files and in-place backups preserve data", async () => {
  writeFileSync(join(directory,"script"),"s/one/two/\n"); writeFileSync(join(directory,"input"),"one\n");
  await same("sed",["-f","script","-e","s/two/three/","input"]);
  const edited = await run("sed",["-i.bak","s/one/two/","input"]); expect(edited.code).toBe(0); expect(edited.stdout).toBe(""); expect(readFileSync(join(directory,"input"),"utf8")).toBe("two\n"); expect(readFileSync(join(directory,"input.bak"),"utf8")).toBe("one\n");
  expect((await run("sed",["s/unclosed/"],"data\n")).code).toBe(1);
});
test("awk fields, numeric aggregation, patterns, BEGIN and END", async () => {
  const input = "alice 12\nbob 4\nalice 6\n";
  for (const program of ["{print $2, $1}","BEGIN{sum=0} {sum += $2} END{print NR,sum}","$2 > 5 {print NR, NF, $0}","/alice/ {print $1}","$1 ~ /^a/ && $2 != 6 { print $0 }","NR==1,NR==2","{counts[$1]++} END {print counts[\"alice\"], counts[\"bob\"]}","{ $2 *= 2; print }","{NF=1;print}","{print length, substr($1,2,2),toupper($1)}"]) await same("awk",[program],input);
  await same("awk",["-F:","BEGIN{OFS=\"|\"} {print $2,$1}"],"a:b\nc:d\n");
});
test("awk expression precedence, strings, comparisons and formatted output", async () => {
  for (const program of ["BEGIN{print 2+3*4, 2^3^2, -2^2}","BEGIN{a=3;print a++,++a,a; print a?\"yes\":\"no\"}","BEGIN{a=\"foo\";print a \"bar\", \"10\"<2, 10<2}","BEGIN{printf \"%04d %.2f %s\\n\",12,1/3,\"ok\"}","BEGIN{print sprintf(\"%s:%d\",\"x\",4)}","BEGIN{print(1,2,3)}","{print $1==0, $1<10, ($1 ? 1 : 0)}"]) await same("awk",[program],"0\n2\n12\nx\n");
});
test("awk loops, conditionals, functions, arrays and deletion", async () => {
  for (const program of ["BEGIN{for(i=1;i<=5;i++){if(i==3)continue; s+=i} print s}","BEGIN{i=0;while(i<3){i++;print i} do{i--}while(i>0);print i}","function square(x){return x*x} BEGIN{print square(5)}","function fact(n){if(n<2)return 1;return n*fact(n-1)} BEGIN{print fact(6)}","BEGIN{a[\"x\"]=2;a[\"y\"]=4;for(k in a)s+=a[k];delete a[\"x\"]; print s,(\"x\" in a),(\"y\" in a)}","BEGIN{a[1,2]=3;print a[1,2],((1,2) in a)}"]) await same("awk",[program]);
});
test("awk builtins use regexes, captures, split and replacements", async () => {
  for (const program of ["BEGIN{s=\"abc123abc\";print sub(/[0-9]+/,\"<&>\",s),s;print gsub(/abc/,\"X\",s),s}","BEGIN{n=split(\"one:two:three\",a,/:/);print n,a[2]}","BEGIN{print match(\"hello 123\",/[0-9]+/),RSTART,RLENGTH}","BEGIN{print int(-2.8),sqrt(9),index(\"hello\",\"ll\"),tolower(\"ABC\")}","{gsub(/a/,\"A\");print}","BEGIN{s=\"aaa\";gsub(/a*/,\"X\",s);print s}"]) await same("awk",[program],"abc\ndata\n");
});
test("awk file assignments, getline, redirects and exit statuses", async () => {
  writeFileSync(join(directory,"input"),"one 1\ntwo 2\n");
  await same("awk",["-v","prefix=ok","{print prefix, FNR, $1}","input"]);
  await same("awk",["{print x,FNR,$1}","x=1","input","x=2","input"]);
  await same("awk",["BEGIN{while((getline line < \"input\")>0) print line; close(\"input\")}"]);
  await same("awk",["{print;getline;print}","input"]);
  await same("awk",["BEGIN{exit 7} END{print \"done\"}"]);
  const output = await run("awk",["BEGIN{print \"hello\" > \"output\";close(\"output\")}"]); expect(output.code).toBe(0); expect(readFileSync(join(directory,"output"),"utf8")).toBe("hello\n");
  expect((await run("awk",["BEGIN{print 1/0}"])).code).toBe(2);
  expect((await run("awk",["BEGIN{print ("])).code).toBe(2);
});
test("text tools preserve option arguments, PCRE syntax and awk array reference semantics", async () => {
  await same("grep",["-e","--help"],"--help\nother\n");
  await same("grep",["-Po","(?<=x)\\d+"],"x123 y45 x67\n");
  await same("grep",["-Po","foo\\Kbar"],"foobar\n");
  await same("grep",["x"],"a\0x\n");
  await same("grep",["--color=always","-nH","-e","one","-e","two"],"one two one\nother\n");
  await same("grep",["--color=always","-no","a"],"abc aba\n");
  await same("sed",["-ne","s/a/A/p"],"abc\ndef\n");
  await same("sed",["--expression="],"unchanged\n");
  await same("awk",["-v","n=10","BEGIN{print n<2}"]);
  await same("awk",["{print $1++; print $0}"],"2 3\n");
  await same("awk",["function fill(a){a[1]=3} BEGIN{fill(b);print b[1]}"]);
  await same("awk",["BEGIN{print 1,\n2}"]);
});
test("sed unbuffered mode emits a record before stdin closes and handles lookahead", async () => {
  const fifo = join(directory,"input.fifo");
  expect(Bun.spawnSync(["mkfifo",fifo]).exitCode).toBe(0);
  let writer = openSync(fifo,constants.O_RDWR), reader = openSync(fifo,"r");
  const proc = Bun.spawn([process.execPath,join(import.meta.dir,"../src/commands/sed.js"),"-u","s/a/A/"],{cwd:directory,env:{...process.env,GNULY_CORRECT:"1"},stdin:reader,stdout:"pipe",stderr:"pipe"});
  closeSync(reader); let timer;
  try {
    writeSync(writer,"abc\n");
    const output = await Promise.race([proc.stdout.getReader().read(),new Promise((_,reject) => { timer = setTimeout(() => reject(new Error("sed -u did not emit before EOF")),5000); })]);
    clearTimeout(timer); expect(new TextDecoder().decode(output.value)).toBe("Abc\n");
    closeSync(writer); writer = null; expect(await proc.exited).toBe(0);
  } finally { clearTimeout(timer); if (writer != null) closeSync(writer); proc.kill(); }
  for (const script of ["$p","N;P;D","h;n;G;p","1,3c\\\nchanged"]) await same("sed",["-un",script],"a\nb\nc\nd\n");
  for (const input of ["abcdefghijklmnop\n","abcdefghi\n","short\n"]) await same("sed",["-l","10","-n","l"],input);
});
