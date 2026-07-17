import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, lstat, lutimes, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, statfs, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { availableParallelism, hostname as osHostname, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Most of this suite is an exact GNU compatibility suite. Friendly diagnostics
// have focused tests below and GNU text is selected explicitly everywhere else.
process.env.GNULY_CORRECT ??= "1";

let dir;

async function run(args, input = "", options = {}) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), ...args], {
    cwd: options.cwd ?? dir,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

async function runWithFriendlyDiagnostics(args, input = "", options = {}) {
  const env = { ...process.env, ...options.env };
  delete env.GNULY_CORRECT;
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), ...args], {
    cwd: options.cwd ?? dir,
    env,
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

async function systemRun(args, input = "", options = {}) {
  const proc = Bun.spawn(args, {
    cwd: options.cwd ?? dir,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

function diagnosticQuote(value) {
  const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  return /utf-?8/i.test(locale) ? `\u2018${value}\u2019` : `'${value}'`;
}

async function sampleCommand(args) {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), ...args], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  proc.kill("SIGTERM");
  await proc.exited.catch(() => {});
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(value ?? new Uint8Array());
}

async function shell(script) {
  const proc = Bun.spawn(["/bin/sh", "-c", script], {
    cwd: dir,
    env: { ...process.env, BNU: join(import.meta.dir, "../bin/bnu.js"), BUN: process.execPath },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bnu-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("friendly diagnostics and GNULY_CORRECT compatibility", async () => {
  const missing = await runWithFriendlyDiagnostics(["cat", "does-not-exist"]);
  expect(missing).toMatchObject({ code: 1, stdout: "" });
  expect(missing.stderr).toBe(
    "cat: does-not-exist: No such file or directory\n" +
    "Hint: Check that the path exists and is spelled correctly.\n",
  );

  const typo = await runWithFriendlyDiagnostics(["ls", "--colr"]);
  expect(typo).toMatchObject({ code: 2, stdout: "" });
  expect(typo.stderr).toBe(
    "ls: unrecognized option '--colr'\n" +
    "Hint: Did you mean '--color'? Run 'ls --help' to see all options.\n" +
    "Try 'ls --help' for more information.\n",
  );

  expect(await runWithFriendlyDiagnostics(["lss"])).toMatchObject({
    code: 1,
    stderr:
      "bnu: unknown command 'lss'\n" +
      "Hint: Did you mean 'ls'? Run 'bnu --help' to list commands.\n",
  });

  const offset = await runWithFriendlyDiagnostics(["od", "-j", "10"], "abc");
  expect(offset.stderr).toContain("Hint: Reduce the requested offset so it falls within the available input.\n");

  const cycle = await runWithFriendlyDiagnostics(["tsort"], "a b\nb a\n");
  expect(cycle.stderr).toContain("Hint: Remove a dependency cycle from the input graph and try again.\n");

  const uncommon = await runWithFriendlyDiagnostics(["rm", "--preserve-root=bad"]);
  expect(uncommon.stderr).toContain(
    "Hint: Use the full option '--no-preserve-root', or use '--preserve-root=all'.\n",
  );

  await mkdir(join(dir, "friendly-source-dir"));
  const targetedCases = [
    { args: ["cut", "-f", "0"], input: "a\n", hint: "Use a position of 1 or greater" },
    { args: ["date", "--date=not-a-date"], hint: "Use a recognized date" },
    { args: ["chmod", "bogus", "file"], hint: "Use an octal mode such as '755'" },
    { args: ["mktemp", "XX"], hint: "Use a template ending in at least three X characters" },
    { args: ["expr", "1", "/", "0"], hint: "Use a nonzero divisor" },
    { args: ["timeout", "not-a-duration", "true"], hint: "Use a nonnegative duration" },
    { args: ["join", "-1", "0", "left", "right"], hint: "Use file number 1 or 2 and field numbers starting at 1" },
    { args: ["tr", "z-a", "x"], hint: "Put the lower position first" },
    { args: ["od", "--address-radix=q"], hint: "Use a supported type string" },
    { args: ["dd", "bs=not-a-size"], hint: "Use NAME=VALUE operands" },
    { args: ["split", "--bytes=not-a-size"], hint: "Use a positive chunk size/count" },
    { args: ["numfmt", "--from=unknown"], hint: "Choose one of the valid values listed above" },
    { args: ["csplit", "-", "/[/"], input: "a\n", hint: "Use a non-empty, valid regular expression" },
    { args: ["seq", "--format=%d", "1"], hint: "Use finite numeric operands" },
    { args: ["stdbuf", "--output=wat", "true"], hint: "Use buffering mode 'L', '0'" },
    { args: ["comm", "-", "-"], input: "a\n", hint: "Use standard input for only one input file" },
    { args: ["stat", "--file-system", "-"], hint: "Name a filesystem path instead of '-'" },
    { args: ["tsort"], input: "unpaired\n", hint: "Provide dependency tokens in pairs" },
    { args: ["cp", "friendly-source-dir", "friendly-copy"], hint: "Add the recursive option" },
    { args: ["chroot", "--skip-chdir", "/tmp", "true"], hint: "Use --skip-chdir only with NEWROOT '/'" },
  ];
  const targetedResults = await Promise.all(targetedCases.map((entry) => runWithFriendlyDiagnostics(entry.args, entry.input ?? "")));
  for (let index = 0; index < targetedCases.length; index++) {
    expect(targetedResults[index].code).not.toBe(0);
    expect(targetedResults[index].stderr).toContain(`Hint: ${targetedCases[index].hint}`);
    expect(targetedResults[index].stderr).not.toContain("Hint: Review the arguments and current system state");
  }

  const missingCommand = await runWithFriendlyDiagnostics(["timeout"]);
  expect(missingCommand).toMatchObject({ code: 125 });
  expect(missingCommand.stderr).toContain("Hint: Add the required command or argument. Expected form: timeout");

  const missingValue = await runWithFriendlyDiagnostics(["head", "--lines"]);
  expect(missingValue.stderr).toContain("Hint: Provide the missing value as '--lines=VALUE' or '--lines VALUE'.");

  const flagValue = await runWithFriendlyDiagnostics(["basename", "--zero=1", "file"]);
  expect(flagValue.stderr).toContain("Hint: Use '--zero' by itself; this flag does not take a value.");

  const debug = await runWithFriendlyDiagnostics(["sort", "--debug"], "b\na\n");
  expect(debug).toMatchObject({ code: 0 });
  expect(debug.stderr).not.toContain("Hint:");

  const dateDebug = await runWithFriendlyDiagnostics(["date", "--debug", "--date=@0", "+%s"]);
  expect(dateDebug).toMatchObject({ code: 0, stdout: "0\n" });
  expect(dateDebug.stderr).not.toContain("Hint:");

  const ignoredOperand = await runWithFriendlyDiagnostics(["pwd", "ignored"]);
  expect(ignoredOperand).toMatchObject({ code: 0 });
  expect(ignoredOperand.stderr).toContain("Hint: Remove the operands; 'pwd' does not use positional arguments.");

  for (const value of ["1", "true", "True", "TRUE"]) {
    expect(await run(["cat", "does-not-exist"], "", { env: { GNULY_CORRECT: value } })).toMatchObject({
      code: 1,
      stderr: "cat: does-not-exist: No such file or directory\n",
    });
  }

  for (const value of ["", "0", "false", "False", "FALSE"]) {
    expect(await run(["cat", "does-not-exist"], "", { env: { GNULY_CORRECT: value } })).toMatchObject({
      code: 1,
      stderr:
        "cat: does-not-exist: No such file or directory\n" +
        "Hint: Check that the path exists and is spelled correctly.\n",
    });
  }
});

test("echo, basename, dirname, pwd", async () => {
  expect(await run(["echo", "-n", "hello"])).toMatchObject({ code: 0, stdout: "hello" });
  const rawBasename = await shell(`name=$(printf 'dir/m\\363unt'); "$BUN" "$BNU" basename "$name" | od -An -tx1 | tr -d ' \n'`);
  expect(rawBasename).toMatchObject({ code: 0, stdout: "6df3756e740a", stderr: "" });
  const rawDirname = await shell(`name=$(printf 'd\\363r/file'); "$BUN" "$BNU" dirname "$name" | od -An -tx1 | tr -d ' \n'`);
  expect(rawDirname).toMatchObject({ code: 0, stdout: "64f3720a", stderr: "" });
  expect(await run(["echo", "-e", "\\x41\\101\\0\\033"])).toMatchObject({ code: 0, stdout: "AA\0\x1b\n" });
  expect(await run(["echo", "-e", "before\\cafter"])).toMatchObject({ code: 0, stdout: "before" });
  expect((await run(["echo", "--help"])).stdout).toContain("Usage: echo");
  expect(await run(["echo", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["echo", "--version", "extra"])).toMatchObject({ code: 0, stdout: "--version extra\n" });
  expect(await run(["echo", "-n", "-E", "foo\\n"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 0, stdout: "foo\n" });
  expect(await run(["echo", "-nE", "foo"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 0, stdout: "-nE foo\n" });
  expect(await run(["echo", "--version"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 0, stdout: "--version\n" });
  expect(await run(["echo", "-/"])).toMatchObject({ code: 0, stdout: "-/\n" });
  expect(await run(["echo", "--", "foo"])).toMatchObject({ code: 0, stdout: "-- foo\n" });
  expect(await run(["true", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: true [ignored command line arguments]\n  or:  true OPTION\n"), stderr: "" });
  expect(await run(["true", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n", stderr: "" });
  expect(await run(["true", "--bad", "--help"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["false", "--version"])).toMatchObject({ code: 1, stdout: "bnu 9.11\n", stderr: "" });
  expect(await run(["false", "--help"])).toMatchObject({ code: 1, stdout: expect.stringContaining("Usage: false [ignored command line arguments]\n  or:  false OPTION\n"), stderr: "" });
  expect(await run(["false", "--version", "extra"])).toMatchObject({ code: 1, stdout: "" });
  expect(await run(["false", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "" });
  expect((await run(["yes", "--help"])).stdout).toStartWith("Usage: yes [STRING]...\n  or:  yes OPTION\n");
  expect((await run(["yes", "extra", "--help"])).stdout).toStartWith("Usage: yes [STRING]...\n  or:  yes OPTION\n");
  expect(await run(["yes", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect((await run(["yes", "--h"])).stdout).toStartWith("Usage: yes [STRING]...\n  or:  yes OPTION\n");
  expect((await run(["yes", "extra", "--he"])).stdout).toStartWith("Usage: yes [STRING]...\n  or:  yes OPTION\n");
  expect(await run(["yes", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["yes", "extra", "--ver"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["yes", "--h=1"])).toMatchObject({ code: 1, stderr: "yes: option '--help' doesn't allow an argument\nTry 'yes --help' for more information.\n" });
  expect(await run(["yes", "extra", "--v=1"])).toMatchObject({ code: 1, stderr: "yes: option '--version' doesn't allow an argument\nTry 'yes --help' for more information.\n" });
  expect(await run(["yes", "--bad", "--help"])).toMatchObject({ code: 1, stderr: "yes: unrecognized option '--bad'\nTry 'yes --help' for more information.\n" });
  expect(await run(["yes", "extra", "-x", "--help"])).toMatchObject({ code: 1, stderr: "yes: invalid option -- 'x'\nTry 'yes --help' for more information.\n" });
  expect(await sampleCommand(["yes"])).toStartWith("y\ny\n");
  expect(await sampleCommand(["yes", "a", "b"])).toStartWith("a b\na b\n");
  expect(await sampleCommand(["yes", "--", "--help"])).toStartWith("--help\n--help\n");
  expect(await run(["basename", "/a/b/c.txt", ".txt"])).toMatchObject({ code: 0, stdout: "c\n" });
  expect(await run(["basename", "/"])).toMatchObject({ code: 0, stdout: "/\n" });
  expect(await run(["basename", "foo", "foo"])).toMatchObject({ code: 0, stdout: "foo\n" });
  expect(await run(["basename", "a-a", "-a"])).toMatchObject({ code: 0, stdout: "a\n" });
  expect(await run(["basename", "a", "b", "c"])).toMatchObject({ code: 1, stderr: `basename: extra operand ${diagnosticQuote("c")}\nTry 'basename --help' for more information.\n` });
  expect(await run(["basename", "a", "b", "c\nd"])).toMatchObject({ code: 1, stderr: `basename: extra operand ${diagnosticQuote("c\\nd")}\nTry 'basename --help' for more information.\n` });
  expect((await run(["basename"])).stderr).toContain("Try 'basename --help' for more information.");
  expect(await run(["basename", "-s"])).toMatchObject({ code: 1, stderr: "basename: option requires an argument -- 's'\nTry 'basename --help' for more information.\n" });
  expect(await run(["basename", "--suffix"])).toMatchObject({ code: 1, stderr: "basename: option '--suffix' requires an argument\nTry 'basename --help' for more information.\n" });
  expect(await run(["basename", "--bad"])).toMatchObject({ code: 1, stderr: "basename: unrecognized option '--bad'\nTry 'basename --help' for more information.\n" });
  expect(await run(["basename", "-s", ".txt", "/a/one.txt", "/b/two.txt"])).toMatchObject({ code: 0, stdout: "one\ntwo\n" });
  expect(await run(["basename", "--suffix=.txt", "-z", "/a/one.txt", "/b/two.txt"])).toMatchObject({ code: 0, stdout: "one\0two\0" });
  expect(await run(["basename", "-a", "/a/one", "/b/two"])).toMatchObject({ code: 0, stdout: "one\ntwo\n" });
  expect(await run(["basename", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: basename NAME [SUFFIX]\n  or:  basename OPTION... NAME...\n") });
  expect(await run(["basename", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["basename", "--z", "/a/b"])).toMatchObject({ code: 0, stdout: "b\0" });
  expect(await run(["basename", "--ze", "/a/b"])).toMatchObject({ code: 0, stdout: "b\0" });
  expect(await run(["basename", "--m", "/a/one", "/b/two"])).toMatchObject({ code: 0, stdout: "one\ntwo\n" });
  expect(await run(["basename", "--su", ".txt", "/a/one.txt", "/b/two.txt"])).toMatchObject({ code: 0, stdout: "one\ntwo\n" });
  expect(await run(["basename", "--z=1", "/a/b"])).toMatchObject({ code: 1, stderr: "basename: option '--zero' doesn't allow an argument\nTry 'basename --help' for more information.\n" });
  expect(await run(["basename", "--m=1", "foo"])).toMatchObject({ code: 1, stderr: "basename: option '--multiple' doesn't allow an argument\nTry 'basename --help' for more information.\n" });
  expect(await run(["basename", "foo", "--help"])).toMatchObject({ code: 0, stdout: "foo\n" });
  expect(await run(["basename", "-s", "--help", "/a/help"])).toMatchObject({ code: 0, stdout: "help\n" });
  expect(await run(["dirname", "/a/b/c.txt"])).toMatchObject({ code: 0, stdout: "/a/b\n" });
  expect(await run(["dirname", "//a//"])).toMatchObject({ code: 0, stdout: "/\n" });
  expect(await run(["dirname", "///a///b"])).toMatchObject({ code: 0, stdout: "///a\n" });
  expect(await run(["dirname", "///a//b/"])).toMatchObject({ code: 0, stdout: "///a\n" });
  expect((await run(["dirname"])).stderr).toContain("Try 'dirname --help' for more information.");
  expect(await run(["dirname", "--bad"])).toMatchObject({ code: 1, stderr: "dirname: unrecognized option '--bad'\nTry 'dirname --help' for more information.\n" });
  expect(await run(["dirname", "-z", "/a/b/c", "/d/e/f"])).toMatchObject({ code: 0, stdout: "/a/b\0/d/e\0" });
  expect(await run(["dirname", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: dirname [OPTION] NAME...\n") });
  expect(await run(["dirname", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["dirname", "--z", "/a/b"])).toMatchObject({ code: 0, stdout: "/a\0" });
  expect(await run(["dirname", "/a/b", "-z"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 0, stdout: "/a\n.\n" });
  expect(await run(["dirname", "foo", "--help"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 0, stdout: ".\n.\n", stderr: "" });
  expect(await run(["dirname", "-z", "foo", "--help"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 0, stdout: ".\0.\0", stderr: "" });
  expect(await run(["dirname", "--ze", "/a/b"])).toMatchObject({ code: 0, stdout: "/a\0" });
  expect(await run(["dirname", "--z=1", "/a/b"])).toMatchObject({ code: 1, stderr: "dirname: option '--zero' doesn't allow an argument\nTry 'dirname --help' for more information.\n" });
  expect(await run(["dirname", "--h=1", "/a/b"])).toMatchObject({ code: 1, stderr: "dirname: option '--help' doesn't allow an argument\nTry 'dirname --help' for more information.\n" });
  expect(await run(["dirname", "-x", "--help"])).toMatchObject({ code: 1, stderr: "dirname: invalid option -- 'x'\nTry 'dirname --help' for more information.\n" });
  expect(await run(["dirname", "foo", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: dirname [OPTION] NAME...\n") });
  expect((await run(["pwd"])).stdout.trim()).toBe(dir);
  expect((await run(["pwd", "-P"])).stdout.trim()).toBe(dir);
  expect((await run(["pwd", "--p"])).stdout.trim()).toBe(dir);
  expect((await run(["pwd", "--ph"])).stdout.trim()).toBe(dir);
  expect((await run(["pwd", "-L"], "", { env: { PWD: "/definitely/not-here" } })).stdout.trim()).toBe(dir);
  expect(await run(["pwd", "-L"], "", { env: { PWD: `${dir}/.` } })).toMatchObject({ code: 0, stdout: `${dir}\n` });
  expect(await run(["pwd", "--l"], "", { env: { PWD: `${dir}/.` } })).toMatchObject({ code: 0, stdout: `${dir}\n` });
  expect(await run(["pwd", "--lo"], "", { env: { PWD: `${dir}/.` } })).toMatchObject({ code: 0, stdout: `${dir}\n` });
  expect(await run(["pwd", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: pwd [OPTION]...\n") });
  expect(await run(["pwd", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["pwd", "--l=1"])).toMatchObject({ code: 1, stderr: "pwd: option '--logical' doesn't allow an argument\nTry 'pwd --help' for more information.\n" });
  expect(await run(["pwd", "--p=1"])).toMatchObject({ code: 1, stderr: "pwd: option '--physical' doesn't allow an argument\nTry 'pwd --help' for more information.\n" });
  expect(await run(["pwd", "--bad", "--help"])).toMatchObject({ code: 1, stderr: "pwd: unrecognized option '--bad'\nTry 'pwd --help' for more information.\n" });
  expect(await run(["pwd", "-x", "--help"])).toMatchObject({ code: 1, stderr: "pwd: invalid option -- 'x'\nTry 'pwd --help' for more information.\n" });
  await mkdir(join(dir, "pwd-real"));
  await symlink("pwd-real", join(dir, "pwd-link"));
  expect(await run(["pwd"], "", { cwd: join(dir, "pwd-real"), env: { PWD: join(dir, "pwd-link"), POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 0, stdout: `${join(dir, "pwd-link")}\n` });
  expect(await run(["pwd", "-LP"], "", { cwd: join(dir, "pwd-real"), env: { PWD: join(dir, "pwd-link"), POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 0, stdout: `${join(dir, "pwd-real")}\n` });
  expect(await run(["pwd", "-PL"], "", { cwd: join(dir, "pwd-real"), env: { PWD: join(dir, "pwd-link"), POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 0, stdout: `${join(dir, "pwd-link")}\n` });
  expect(await run(["pwd", "--physical", "--logical"], "", { cwd: join(dir, "pwd-real"), env: { PWD: join(dir, "pwd-link"), POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 0, stdout: `${join(dir, "pwd-link")}\n` });
  expect(await run(["pwd"], "", { env: { BNU_LONG_PWD: `${dir}/long-wrapper-pwd` } })).toMatchObject({ code: 0, stdout: `${dir}/long-wrapper-pwd\n` });
  expect(await run(["pwd", "extra"])).toMatchObject({ code: 0, stdout: `${dir}\n`, stderr: "pwd: ignoring non-option arguments\n" });
  const yesFull = Bun.spawn(["/bin/sh", "-c", `${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} yes >/dev/full`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await yesFull.exited).toBe(1);
  expect(await new Response(yesFull.stderr).text()).toBe("yes: standard output: No space left on device\n");
  const yesPipe = Bun.spawn(["/bin/sh", "-c", `${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} yes | head -n1`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await yesPipe.exited).toBe(0);
  expect(await new Response(yesPipe.stdout).text()).toBe("y\n");
  expect(await new Response(yesPipe.stderr).text()).toBe("");
});

test("cat, wc, head, tail operate on files and stdin", async () => {
  await writeFile(join(dir, "in.txt"), "one\ntwo\nthree\n");
  await mkdir(join(dir, "stream-dir"));
  expect(await run(["cat", "-n", "in.txt"])).toMatchObject({ code: 0, stdout: "     1\tone\n     2\ttwo\n     3\tthree\n" });
  expect(await run(["cat", "--n"], "a\n")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "cat: option '--n' is ambiguous; possibilities: '--number-nonblank' '--number'\nTry 'cat --help' for more information.\n",
  });
  expect(await run(["cat", "--number-n"], "a\n\n")).toMatchObject({ code: 0, stdout: "     1\ta\n\n" });
  expect(await run(["cat", "--s"], "a\n")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "cat: option '--s' is ambiguous; possibilities: '--squeeze-blank' '--show-nonprinting' '--show-ends' '--show-tabs' '--show-all'\nTry 'cat --help' for more information.\n",
  });
  expect(await run(["cat", "--squeeze"], "a\n\n\nb\n")).toMatchObject({ code: 0, stdout: "a\n\nb\n" });
  const catHelp = await run(["cat", "--help"]);
  expect(catHelp).toMatchObject({ code: 0 });
  expect(catHelp.stdout).toContain("  -e\n");
  expect(catHelp.stdout).toContain("  -t\n");
  expect(await run(["cat", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "cat: unrecognized option '--bad'\nTry 'cat --help' for more information.\n" });
  expect(await run(["cat", "--version=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "cat: option '--version' doesn't allow an argument\nTry 'cat --help' for more information.\n" });
  expect(await run(["cat", "-u", "in.txt"])).toMatchObject({ code: 0, stdout: "one\ntwo\nthree\n" });
  expect(await run(["cat", "cat-missing-a", "in.txt", "cat-missing-b"])).toMatchObject({ code: 1, stdout: "one\ntwo\nthree\n", stderr: "cat: cat-missing-a: No such file or directory\ncat: cat-missing-b: No such file or directory\n" });
  expect(await run(["cat", "missing'cat", "in.txt", "missing\ncat"])).toMatchObject({ code: 1, stdout: "one\ntwo\nthree\n", stderr: "cat: \"missing'cat\": No such file or directory\ncat: 'missing'$'\\n''cat': No such file or directory\n" });
  expect(await run(["cat", "stream-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "cat: stream-dir: Is a directory\n" });
  await mkdir(join(dir, "dir'cat"));
  expect(await run(["cat", "dir'cat"])).toMatchObject({ code: 1, stdout: "", stderr: "cat: \"dir'cat\": Is a directory\n" });
  await symlink("loop'cat", join(dir, "loop'cat"));
  expect(await run(["cat", "loop'cat"])).toMatchObject({ code: 1, stdout: "", stderr: "cat: \"loop'cat\": Too many levels of symbolic links\n" });
  expect(await run(["cat", "-e"], "a\tb\n")).toMatchObject({ code: 0, stdout: "a\tb$\n" });
  expect(await run(["cat", "-t"], "a\tb\n")).toMatchObject({ code: 0, stdout: "a^Ib\n" });
  expect(await run(["cat", "-v"], "a\u0001\u007f\n")).toMatchObject({ code: 0, stdout: "a^A^?\n" });
  await writeFile(join(dir, "cat-raw"), Uint8Array.of(0xff, 0x0a));
  const catRaw = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "cat", "cat-raw"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "cat-raw-out")),
    stderr: "pipe",
  });
  expect(await catRaw.exited).toBe(0);
  expect(await new Response(catRaw.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "cat-raw-out"))]).toEqual([0xff, 0x0a]);
  expect(await run(["cat", "-v", "cat-raw"], "", { env: { LC_ALL: "C" } })).toMatchObject({ code: 0, stdout: "M-^?\n" });
  const catRawNumbered = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "cat", "-n", "cat-raw"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "cat-raw-numbered-out")),
    stderr: "pipe",
  });
  expect(await catRawNumbered.exited).toBe(0);
  expect(await new Response(catRawNumbered.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "cat-raw-numbered-out"))]).toEqual([0x20, 0x20, 0x20, 0x20, 0x20, 0x31, 0x09, 0xff, 0x0a]);
  expect(await run(["cat", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Concatenate FILE(s) to standard output.\n") });
  expect(await run(["cat", "-E"], "a\rb\r\nc\n\r\nd\r")).toMatchObject({ code: 0, stdout: "a\rb^M$\nc$\n^M$\nd\r" });
  await writeFile(join(dir, "cr-left"), "1\r");
  await writeFile(join(dir, "cr-right"), "\n2\r\n");
  expect(await run(["cat", "-E", "cr-left", "cr-right"])).toMatchObject({ code: 0, stdout: "1^M$\n2^M$\n" });
  await writeFile(join(dir, "cat-self"), "x\n");
  const appendSelf = Bun.spawn(["/bin/sh", "-c", `${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} cat cat-self >>cat-self`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await appendSelf.exited).toBe(1);
  expect(await readFile(join(dir, "cat-self"), "utf8")).toBe("x\n");
  await writeFile(join(dir, "cat-doc"), "x\n");
  await writeFile(join(dir, "cat-doc-end"), "y\n");
  const truncateSelf = Bun.spawn(["/bin/sh", "-c", `${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} cat cat-doc cat-doc-end >cat-doc`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await truncateSelf.exited).toBe(0);
  expect(await readFile(join(dir, "cat-doc"), "utf8")).toBe("y\n");
  expect(await run(["mkfifo", "cat-fifo"])).toMatchObject({ code: 0 });
  const catBuf = Bun.spawn(["/bin/sh", "-c", `${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} dd count=1 if=cat-fifo status=none >cat-out & pid=$!; (printf '1\\n'; sleep 1; printf '2\\n') | ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} cat -v >cat-fifo; wait $pid`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await catBuf.exited).toBe(0);
  expect(await readFile(join(dir, "cat-out"), "utf8")).toBe("1\n");
  expect((await run(["wc", "in.txt"])).stdout).toContain(" 3  3 14 in.txt\n");
  expect(await run(["wc", "--debug", "in.txt"])).toMatchObject({ code: 0, stdout: " 3  3 14 in.txt\n", stderr: "" });
  await writeFile(join(dir, "wc-empty"), "");
  expect(await run(["wc", "wc-empty"])).toMatchObject({ code: 0, stdout: "0 0 0 wc-empty\n" });
  expect(await run(["wc", "/dev/null"])).toMatchObject({ code: 0, stdout: "      0       0       0 /dev/null\n" });
  const wcFiles0Raw = Bun.spawn(["/bin/sh", "-c", `name=$(printf 'wc-\\377'); printf 'payload\\n' > "$name"; printf '%s\\0' "$name" > wc-files0-raw; LC_ALL=C ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} wc -c --files0-from=wc-files0-raw >wc-files0-raw-out`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await wcFiles0Raw.exited).toBe(0);
  expect(await new Response(wcFiles0Raw.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "wc-files0-raw-out"))]).toEqual([0x38, 0x20, 0x77, 0x63, 0x2d, 0xff, 0x0a]);
  expect(await run(["wc", "--b"], "abc\n")).toMatchObject({ code: 0, stdout: "4\n" });
  expect(await run(["wc", "--max"], "ab\n")).toMatchObject({ code: 0, stdout: "2\n" });
  expect(await run(["wc", "--bad", "--help"], "abc\n")).toMatchObject({ code: 1, stdout: "", stderr: "wc: unrecognized option '--bad'\nTry 'wc --help' for more information.\n" });
  expect(await run(["wc", "--b=1"], "abc\n")).toMatchObject({ code: 1, stdout: "", stderr: "wc: option '--bytes' doesn't allow an argument\nTry 'wc --help' for more information.\n" });
  expect(await run(["wc", "--v=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "wc: option '--version' doesn't allow an argument\nTry 'wc --help' for more information.\n" });
  expect(await run(["wc", "missing-wc-file", "--help"], "abc\n")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: wc [OPTION]... [FILE]...\n  or:  wc [OPTION]... --files0-from=F\n"), stderr: "" });
  expect(await run(["wc", "missing-wc-file", "--version"], "abc\n")).toMatchObject({ code: 0, stdout: "bnu 9.11\n", stderr: "" });
  expect(await run(["wc", "--total", "--help"], "abc\n")).toMatchObject(await systemRun(["wc", "--total", "--help"], "abc\n"));
  expect(await run(["wc", "--total=bad", "in.txt"])).toMatchObject(await systemRun(["wc", "--total=bad", "in.txt"]));
  expect(await run(["wc", "--total=bad", "--help"])).toMatchObject(await systemRun(["wc", "--total=bad", "--help"]));
  expect(await run(["wc", "--total=bad\nx", "in.txt"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `wc: invalid argument ${diagnosticQuote("bad\\nx")} for ${diagnosticQuote("--total")}\nValid arguments are:\n  - ${diagnosticQuote("auto")}\n  - ${diagnosticQuote("always")}\n  - ${diagnosticQuote("only")}\n  - ${diagnosticQuote("never")}\nTry 'wc --help' for more information.\n`,
  });
  expect(await run(["wc", "--total=", "in.txt"])).toMatchObject(await systemRun(["wc", "--total=", "in.txt"]));
  expect(await run(["wc", "--total=", "--help"])).toMatchObject(await systemRun(["wc", "--total=", "--help"]));
  expect(await run(["wc", "--total=only", "--help"], "abc\n")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: wc [OPTION]... [FILE]...\n  or:  wc [OPTION]... --files0-from=F\n") });
  expect(await run(["truncate", "-s", "9007199254740993", "wc-huge-size"])).toMatchObject({ code: 0 });
  expect(await run(["wc", "-c", "--total=only", "wc-huge-size"])).toMatchObject({ code: 0, stdout: "9007199254740993\n" });
  expect(await run(["wc", "wc-missing-a", "in.txt", "wc-missing-b"])).toMatchObject({ code: 1, stdout: " 3  3 14 in.txt\n 3  3 14 total\n", stderr: "wc: wc-missing-a: No such file or directory\nwc: wc-missing-b: No such file or directory\n" });
  expect(await run(["wc", "missing'wc"])).toMatchObject({ code: 1, stdout: "", stderr: "wc: \"missing'wc\": No such file or directory\n" });
  expect(await run(["wc", "stream-dir"])).toMatchObject({ code: 1, stdout: "      0       0       0 stream-dir\n", stderr: "wc: stream-dir: Is a directory\n" });
  expect(await run(["wc", "stream-dir", "in.txt"])).toMatchObject({ code: 1, stdout: "      0       0       0 stream-dir\n      3       3      14 in.txt\n      3       3      14 total\n", stderr: "wc: stream-dir: Is a directory\n" });
  await mkdir(join(dir, "wc'dir"));
  expect(await run(["wc", "wc'dir"])).toMatchObject({ code: 1, stdout: "      0       0       0 wc'dir\n", stderr: "wc: \"wc'dir\": Is a directory\n" });
  await symlink("wc-loop", join(dir, "wc-loop"));
  expect(await run(["wc", "wc-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "wc: wc-loop: Too many levels of symbolic links\n" });
  await mkdir(join(dir, "wc-list-dir"));
  expect(await run(["wc", "--files0-from=wc-list-dir"])).toMatchObject(await systemRun(["/usr/bin/wc", "--files0-from=wc-list-dir"]));
  expect(await run(["wc", "--files0-from=missing\nwc-list"])).toMatchObject({ code: 1, stdout: "", stderr: "wc: cannot open 'missing'$'\\n''wc-list' for reading: No such file or directory\n" });
  await mkdir(join(dir, "wc\nlist-dir"));
  expect(await run(["wc", "--files0-from=wc\nlist-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "wc: 'wc'$'\\n''list-dir': read error: Is a directory\n" });
  await writeFile(join(dir, "wc'list"), "\0");
  expect(await run(["wc", "--files0-from=wc'list"])).toMatchObject({ code: 1, stdout: "", stderr: "wc: \"wc'list\":1: invalid zero-length file name\n" });
  expect(await run(["head", "-n", "2", "in.txt"])).toMatchObject({ code: 0, stdout: "one\ntwo\n" });
  await writeFile(join(dir, "head-tail-raw"), Uint8Array.of(0xff, 0x0a, 0x61, 0x0a));
  const headRaw = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "head", "-n1", "head-tail-raw"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "head-raw-out")),
    stderr: "pipe",
  });
  expect(await headRaw.exited).toBe(0);
  expect(await new Response(headRaw.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "head-raw-out"))]).toEqual([0xff, 0x0a]);
  expect(await run(["head", "head-missing-a", "in.txt", "head-missing-b"])).toMatchObject({ code: 1, stdout: "==> in.txt <==\none\ntwo\nthree\n", stderr: "head: cannot open 'head-missing-a' for reading: No such file or directory\nhead: cannot open 'head-missing-b' for reading: No such file or directory\n" });
  expect(await run(["head", "missing'head"])).toMatchObject({ code: 1, stdout: "", stderr: "head: cannot open \"missing'head\" for reading: No such file or directory\n" });
  expect(await run(["head", "missing\nhead"])).toMatchObject({ code: 1, stdout: "", stderr: "head: cannot open 'missing'$'\\n''head' for reading: No such file or directory\n" });
  expect(await run(["head", "stream-dir", "in.txt"])).toMatchObject({ code: 1, stdout: "==> stream-dir <==\n\n==> in.txt <==\none\ntwo\nthree\n", stderr: "head: error reading 'stream-dir': Is a directory\n" });
  await mkdir(join(dir, "head'dir"));
  expect(await run(["head", "head'dir"])).toMatchObject({ code: 1, stdout: "", stderr: "head: error reading \"head'dir\": Is a directory\n" });
  await symlink("head-loop", join(dir, "head-loop"));
  expect(await run(["head", "head-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "head: cannot open 'head-loop' for reading: Too many levels of symbolic links\n" });
  expect(await run(["head", "--l=2"], "a\nb\nc\n")).toMatchObject({ code: 0, stdout: "a\nb\n" });
  expect(await run(["head", "--b=2"], "abc")).toMatchObject({ code: 0, stdout: "ab" });
  expect(await run(["head", "--s"], "a\n")).toMatchObject({ code: 0, stdout: "a\n" });
  expect(await run(["head", "--bad", "--help"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: "head: unrecognized option '--bad'\nTry 'head --help' for more information.\n" });
  expect(await run(["head", "--q=1"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: "head: option '--quiet' doesn't allow an argument\nTry 'head --help' for more information.\n" });
  expect(await run(["head", "--version=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "head: option '--version' doesn't allow an argument\nTry 'head --help' for more information.\n" });
  expect(await run(["head", "--lines", "--help"], "a\n")).toMatchObject(await systemRun(["/usr/bin/head", "--lines", "--help"], "a\n"));
  expect(await run(["head", "--lines", "--help", "--version"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `head: invalid number of lines: ${diagnosticQuote("-help")}\n` });
  expect(await run(["head", "--bytes", "--help", "--version"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `head: invalid number of bytes: ${diagnosticQuote("-help")}\n` });
  expect(await run(["head", "-n", "--help", "--version"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `head: invalid number of lines: ${diagnosticQuote("-help")}\n` });
  expect(await run(["head", "-n--help", "--version"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `head: invalid number of lines: ${diagnosticQuote("-help")}\n` });
  expect(await run(["head", "-c", "--help", "--version"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `head: invalid number of bytes: ${diagnosticQuote("-help")}\n` });
  expect(await run(["head", "-c--help", "--version"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `head: invalid number of bytes: ${diagnosticQuote("-help")}\n` });
  expect(await run(["head", "--lines=1", "--help"], "a\n")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: head [OPTION]... [FILE]...\n") });
  expect(await run(["head", "--lines=bad", "--help"], "a\n")).toMatchObject(await systemRun(["/usr/bin/head", "--lines=bad", "--help"], "a\n"));
  expect(await run(["head", "--bytes=bad", "--help"], "abc")).toMatchObject(await systemRun(["/usr/bin/head", "--bytes=bad", "--help"], "abc"));
  expect(await run(["head", "in.txt", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: head [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["head", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Print the first 10 lines of each FILE to standard output.\n") });
  expect(await run(["head", "-q", "-v", "in.txt"])).toMatchObject({ code: 0, stdout: "==> in.txt <==\none\ntwo\nthree\n" });
  expect(await run(["head", "-v", "-q", "in.txt"])).toMatchObject({ code: 0, stdout: "one\ntwo\nthree\n" });
  expect(await run(["head", "in.txt", "-qv"])).toMatchObject({ code: 0, stdout: "==> in.txt <==\none\ntwo\nthree\n" });
  expect(await run(["tail", "-n", "1", "in.txt"])).toMatchObject({ code: 0, stdout: "three\n" });
  const tailRaw = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tail", "-n+1", "head-tail-raw"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "tail-raw-out")),
    stderr: "pipe",
  });
  expect(await tailRaw.exited).toBe(0);
  expect(await new Response(tailRaw.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "tail-raw-out"))]).toEqual([0xff, 0x0a, 0x61, 0x0a]);
  expect(await run(["tail", "--l=2"], "a\nb\nc\n")).toMatchObject({ code: 0, stdout: "b\nc\n" });
  expect(await run(["tail", "--b=2"], "abc")).toMatchObject({ code: 0, stdout: "bc" });
  expect(await run(["tail", "--bad", "--help"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: "tail: unrecognized option '--bad'\nTry 'tail --help' for more information.\n" });
  expect(await run(["tail", "--s=0.1", "--pid=999999999", "-f", "/dev/null"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "tail: option '--s=0.1' is ambiguous; possibilities: '--silent' '--sleep-interval'\nTry 'tail --help' for more information.\n",
  });
  expect(await run(["tail", "--ver=foo"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "tail: option '--ver=foo' is ambiguous; possibilities: '--verbose' '--version'\nTry 'tail --help' for more information.\n",
  });
  expect(await run(["tail", "--sleep", "--help", "/dev/null"])).toMatchObject(await systemRun(["tail", "--sleep", "--help", "/dev/null"]));
  expect(await run(["tail", "--sleep=0.1", "--help", "/dev/null"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: tail [OPTION]... [FILE]...\n") });
  expect(await run(["tail", "--lines", "--help", "--version"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid number of lines: ${diagnosticQuote("-help")}\n` });
  expect(await run(["tail", "--bytes", "--help", "--version"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid number of bytes: ${diagnosticQuote("-help")}\n` });
  expect(await run(["tail", "-n", "--help", "--version"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid number of lines: ${diagnosticQuote("-help")}\n` });
  expect(await run(["tail", "-n--help", "--version"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid number of lines: ${diagnosticQuote("-help")}\n` });
  expect(await run(["tail", "-c", "--help", "--version"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid number of bytes: ${diagnosticQuote("-help")}\n` });
  expect(await run(["tail", "-c--help", "--version"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid number of bytes: ${diagnosticQuote("-help")}\n` });
  expect(await run(["tail", "--lines=bad", "--help"], "a\n")).toMatchObject(await systemRun(["tail", "--lines=bad", "--help"], "a\n"));
  expect(await run(["tail", "--bytes=bad", "--help"], "abc")).toMatchObject(await systemRun(["tail", "--bytes=bad", "--help"], "abc"));
  expect(await run(["tail", "--pid=bad", "--help"], "abc")).toMatchObject(await systemRun(["tail", "--pid=bad", "--help"], "abc"));
  expect(await run(["tail", "--pid", "--help", "--version"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid PID: ${diagnosticQuote("--help")}\n` });
  expect(await run(["tail", "in.txt", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n", stderr: "" });
  expect(await run(["tail", "--follow=", "--help", "/dev/null"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `tail: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--follow")}\nValid arguments are:\n  - ${diagnosticQuote("descriptor")}\n  - ${diagnosticQuote("name")}\nTry 'tail --help' for more information.\n`,
  });
  expect(await run(["tail", "--follow=bad", "--help", "/dev/null"])).toMatchObject(await systemRun(["tail", "--follow=bad", "--help", "/dev/null"]));
  expect(await run(["tail", "--follow=name", "--help", "/dev/null"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: tail [OPTION]... [FILE]...\n") });
  expect(await run(["tail", "stream-dir", "in.txt"])).toMatchObject({ code: 1, stdout: "==> stream-dir <==\n\n==> in.txt <==\none\ntwo\nthree\n", stderr: "tail: error reading 'stream-dir': Is a directory\n" });
  expect(await run(["tail", "missing'tail"])).toMatchObject({ code: 1, stdout: "", stderr: "tail: cannot open \"missing'tail\" for reading: No such file or directory\n" });
  expect(await run(["tail", "missing\ntail"])).toMatchObject({ code: 1, stdout: "", stderr: "tail: cannot open 'missing'$'\\n''tail' for reading: No such file or directory\n" });
  await mkdir(join(dir, "tail'dir"));
  expect(await run(["tail", "tail'dir"])).toMatchObject({ code: 1, stdout: "", stderr: "tail: error reading \"tail'dir\": Is a directory\n" });
  await symlink("tail-loop", join(dir, "tail-loop"));
  expect(await run(["tail", "tail-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "tail: cannot open 'tail-loop' for reading: Too many levels of symbolic links\n" });
  expect(await run(["tail", "-q", "-v", "in.txt"])).toMatchObject({ code: 0, stdout: "==> in.txt <==\none\ntwo\nthree\n" });
  expect(await run(["tail", "-v", "-q", "in.txt"])).toMatchObject({ code: 0, stdout: "one\ntwo\nthree\n" });
  expect(await run(["tail", "in.txt", "-qv"])).toMatchObject({ code: 0, stdout: "==> in.txt <==\none\ntwo\nthree\n" });
  expect(await run(["tail", "--debug", "-n", "1", "in.txt"])).toMatchObject({ code: 0, stdout: "three\n" });
  const tailHelp = (await run(["tail", "--help"])).stdout;
  expect(tailHelp).toContain("Print the last 10 lines of each FILE to standard output.\n");
  for (const option of ["-F", "-f"]) expect(tailHelp).toContain(`  ${option}\n`);
  expect(await run(["tail", "-s.1", "-n", "1", "in.txt"])).toMatchObject({ code: 0, stdout: "three\n", stderr: "" });
  expect(await run(["tail", "--sleep-interval=.1", "-n", "1", "in.txt"])).toMatchObject({ code: 0, stdout: "three\n", stderr: "" });
  expect(await run(["tail", "--sleep-interval=bad", "in.txt"])).toMatchObject(await systemRun(["tail", "--sleep-interval=bad", "in.txt"]));
  expect(await run(["tail", "--sleep-interval=1\n2", "in.txt"])).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid number of seconds: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["tail", "--pid=bad", "-f", "in.txt"])).toMatchObject(await systemRun(["tail", "--pid=bad", "-f", "in.txt"]));
  expect(await run(["tail", "--pid=1\n2", "-f", "in.txt"])).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid PID: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["tail", "--max-unchanged-stats=bad", "-f", "in.txt"])).toMatchObject(await systemRun(["tail", "--max-unchanged-stats=bad", "-f", "in.txt"]));
  expect(await run(["tail", "--max-unchanged-stats=1\n2", "-f", "in.txt"])).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid maximum number of unchanged stats between opens: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["head", "-2", "in.txt"])).toMatchObject({ code: 0, stdout: "one\ntwo\n" });
  expect(await run(["head", "-1c"], "abc")).toMatchObject({ code: 0, stdout: "a" });
  expect(await run(["head", "--bytes=bad", "in.txt"])).toMatchObject(await systemRun(["/usr/bin/head", "--bytes=bad", "in.txt"]));
  expect(await run(["head", "--lines=bad", "in.txt"])).toMatchObject(await systemRun(["/usr/bin/head", "--lines=bad", "in.txt"]));
  expect(await run(["head", "-14c"], "1234567890abcdefg")).toMatchObject({ code: 0, stdout: "1234567890abcd" });
  expect((await run(["head", "-2b"], "x".repeat(2000))).stdout.length).toBe(1024);
  expect((await run(["head", "-1k"], "x".repeat(2000))).stdout.length).toBe(1024);
  expect(await run(["head", "-n", "1B"], "a\nb\n")).toMatchObject({ code: 1, stdout: "", stderr: `head: invalid number of lines: ${diagnosticQuote("1B")}\n` });
  expect(await run(["head", "-n", "1\n2"], "a\nb\n")).toMatchObject({ code: 1, stdout: "", stderr: `head: invalid number of lines: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["head", "-c", "1B"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `head: invalid number of bytes: ${diagnosticQuote("1B")}\n` });
  expect(await run(["head", "-c", "1\n2"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `head: invalid number of bytes: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["head", "-n", "1R"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a\nb\n" });
  expect(await run(["head", "-n", "1QB"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a\nb\n" });
  expect((await run(["head", "-c", "1kB"], "x".repeat(1500))).stdout.length).toBe(1000);
  expect((await run(["head", "-c", "1kiB"], "x".repeat(1500))).stdout.length).toBe(1024);
  expect(await run(["head", "-c", "1EiB"], "abc")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["head", "-c", "1YB"], "abc")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["head", "-c", "1R"], "abc")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["head", "-c", "1QB"], "abc")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["head", "-c", "1e"], "abc")).toMatchObject(await systemRun(["/usr/bin/head", "-c", "1e"], "abc"));
  expect(await run(["head", "--bytes=-2", "---presume-input-pipe"], "abc")).toMatchObject({ code: 0, stdout: "a" });
  expect(await run(["head", "--lines=-1", "---presume-input-pipe"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a\n" });
  expect(await run(["tail", "-2", "in.txt"])).toMatchObject({ code: 0, stdout: "two\nthree\n" });
  expect(await run(["tail", "+2c"], "abcd")).toMatchObject({ code: 0, stdout: "bcd" });
  expect(await run(["tail", "-n", "1B"], "a\nb\n")).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid number of lines: ${diagnosticQuote("1B")}\n` });
  expect(await run(["tail", "-n", "1\n2"], "a\nb\n")).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid number of lines: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["tail", "-c", "1B"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid number of bytes: ${diagnosticQuote("1B")}\n` });
  expect(await run(["tail", "-c", "1\n2"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `tail: invalid number of bytes: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["tail", "-n", "1R"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a\nb\n" });
  expect(await run(["tail", "-n", "1QB"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a\nb\n" });
  expect((await run(["tail", "-c", "1kB"], "x".repeat(1500))).stdout.length).toBe(1000);
  expect((await run(["tail", "-c", "1kiB"], "x".repeat(1500))).stdout.length).toBe(1024);
  expect(await run(["tail", "-c", "1EiB"], "abc")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["tail", "-c", "1YB"], "abc")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["tail", "-c", "1R"], "abc")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["tail", "-c", "1QB"], "abc")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["tail", "-c", "1e"], "abc")).toMatchObject(await systemRun(["/usr/bin/tail", "-c", "1e"], "abc"));
  expect(await run(["tail", "-1l"], "one\ntwo\n")).toMatchObject({ code: 0, stdout: "two\n" });
  expect(await run(["tail", "+2l"], "one\ntwo\n")).toMatchObject({ code: 0, stdout: "two\n" });
  expect(await run(["tail", "+c"], "x" + "y".repeat(10) + "z")).toMatchObject({ code: 0, stdout: "yyz" });
  expect(await run(["tail", "+l"], "x\n" + "y\n".repeat(10) + "z")).toMatchObject({ code: 0, stdout: "y\ny\nz" });
  expect(await run(["tail", "-l"], "x\n" + "y\n".repeat(10) + "z")).toMatchObject({ code: 0, stdout: "y\n".repeat(9) + "z" });
  expect((await run(["tail", "-b"], "x\n".repeat(512 * 10 / 2 + 1))).stdout.length).toBe(512 * 10);
  const headLinePipe = Bun.spawn(["/bin/sh", "-c", `printf 'a\\nb\\n' | (${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} head -n 1 >/dev/null; cat)`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await headLinePipe.exited).toBe(0);
  expect(await new Response(headLinePipe.stdout).text()).toBe("b\n");
  await writeFile(join(dir, "head-seek-lines"), "a\nb\nc\n");
  const headSeekLines = Bun.spawn(["/bin/sh", "-c", `(${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} head -n -1 >/dev/null; cat) < head-seek-lines`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await headSeekLines.exited).toBe(0);
  expect(await new Response(headSeekLines.stdout).text()).toBe("c\n");
  const headBytePipe = Bun.spawn(["/bin/sh", "-c", `printf 'abc\\ndef\\n' | (${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} dd bs=1 skip=1 count=0 status=none; ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} head -c-4)`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await headBytePipe.exited).toBe(0);
  expect(await new Response(headBytePipe.stdout).text()).toBe("bc\n");
  await writeFile(join(dir, "head-seek-bytes"), "abcdef");
  const headSeekBytes = Bun.spawn(["/bin/sh", "-c", `(${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} head -c -2 >/dev/null; cat) < head-seek-bytes`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await headSeekBytes.exited).toBe(0);
  expect(await new Response(headSeekBytes.stdout).text()).toBe("ef");
  const headFull = Bun.spawn(["/bin/sh", "-c", `printf 'abc\\n' | ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} head --lines=-0 >/dev/full`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await headFull.exited).toBe(1);
  expect(await new Response(headFull.stderr).text()).toBe("head: error writing 'standard output': No space left on device\n");
  expect(await run(["tail", "-n", "0", "in.txt"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["tail", "-n", "+0", "in.txt"])).toMatchObject({ code: 0, stdout: "one\ntwo\nthree\n" });
  expect(await run(["tail", "-n", "-0", "in.txt"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["tail", "+2", "in.txt"])).toMatchObject({ code: 0, stdout: "two\nthree\n" });
  await writeFile(join(dir, "nul.txt"), "one\0two\0three\0");
  expect(await run(["head", "-z", "-n", "2", "nul.txt"])).toMatchObject({ code: 0, stdout: "one\0two\0" });
  expect(await run(["tail", "--zero-terminated", "-n", "2", "nul.txt"])).toMatchObject({ code: 0, stdout: "two\0three\0" });
  expect(await run(["tail", "-f", "-c3", "-", "tail-missing"], "bar\n")).toMatchObject({
    code: 1,
    stdout: "==> standard input <==\nar\n",
    stderr: "tail: cannot open 'tail-missing' for reading: No such file or directory\ntail: no files remaining\n",
  });
  await writeFile(join(dir, "tail-pipe-source"), "==> standard input <==\nar\n");
  const tailPipe = Bun.spawn(["/bin/bash", "-lc", `/usr/bin/timeout 2s ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} tail -n2 -f tail-pipe-source | /usr/bin/head -n2 > tail-pipe-out; printf '%s\\n' "\${PIPESTATUS[0]}" > tail-pipe-status`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await tailPipe.exited).toBe(0);
  expect(await readFile(join(dir, "tail-pipe-status"), "utf8")).toBe("0\n");
  expect(await readFile(join(dir, "tail-pipe-out"), "utf8")).toBe("==> standard input <==\nar\n");
  await writeFile(join(dir, "tail-follow"), "seed\n");
  const tailFollow = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tail", "--sleep=0.2", "-n", "0", "-f", "tail-follow"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await Promise.race([tailFollow.exited.then(() => "exited"), Bun.sleep(150).then(() => "running")])).toBe("running");
  tailFollow.kill("SIGTERM");
  await tailFollow.exited.catch(() => {});
  expect(await new Response(tailFollow.stdout).text()).toBe("");
  expect(await new Response(tailFollow.stderr).text()).toBe("");
  await writeFile(join(dir, "tail-pid"), "");
  const tailPidSleeper = Bun.spawn(["/bin/sh", "-c", "sleep 2"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  const tailPid = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tail", "-f", "--sleep=0.1", `--pid=${tailPidSleeper.pid}`, "tail-pid"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await Promise.race([tailPid.exited.then(() => "exited"), Bun.sleep(150).then(() => "running")])).toBe("running");
  tailPidSleeper.kill("SIGTERM");
  await tailPidSleeper.exited.catch(() => {});
  expect(await Promise.race([tailPid.exited.then(() => "exited"), Bun.sleep(1000).then(() => "running")])).toBe("exited");
  expect(await new Response(tailPid.stderr).text()).toBe("");
  const tailMissingFollow = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tail", "-f", "tail-missing"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const tailMissingFollowState = await Promise.race([tailMissingFollow.exited.then(() => "exited"), Bun.sleep(1000).then(() => "running")]);
  if (tailMissingFollowState === "running") {
    tailMissingFollow.kill("SIGTERM");
    await tailMissingFollow.exited.catch(() => {});
  }
  expect(tailMissingFollowState).toBe("exited");
  const tailClosedStdin = await shell(`
    BNU_STDIN_CLOSED=1 "$BUN" "$BNU" tail -f - <&-
  `);
  expect(tailClosedStdin).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "tail: cannot fstat 'standard input'\ntail: no files remaining\n",
  });
  await writeFile(join(dir, "tail-name-a"), "");
  await writeFile(join(dir, "tail-name-rotated"), "");
  const tailNameRecreate = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tail", "--follow=name", "--sleep=0.1", "-n", "0", "tail-name-a", "tail-name-rotated"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.sleep(1000);
  await writeFile(join(dir, "tail-name-a"), "a\n");
  await Bun.sleep(250);
  await rm(join(dir, "tail-name-rotated"));
  await Bun.sleep(250);
  await writeFile(join(dir, "tail-name-rotated"), "rotated\n");
  await Bun.sleep(350);
  tailNameRecreate.kill("SIGTERM");
  await tailNameRecreate.exited.catch(() => {});
  expect(await new Response(tailNameRecreate.stdout).text()).toContain("rotated\n");
  expect(await new Response(tailNameRecreate.stderr).text()).toContain("tail: 'tail-name-rotated' has become inaccessible: No such file or directory\n");
  await writeFile(join(dir, "tail-empty-replaced"), "");
  const tailEmptyReplaced = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tail", "-F", "--sleep=0.05", "-n", "0", "tail-empty-replaced"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.sleep(150);
  for (let i = 0; i < 8; i++) {
    await writeFile(join(dir, "tail-empty-next"), "");
    await rename(join(dir, "tail-empty-next"), join(dir, "tail-empty-replaced"));
    await Bun.sleep(20);
  }
  tailEmptyReplaced.kill("SIGTERM");
  await tailEmptyReplaced.exited.catch(() => {});
  const emptyReplaceMessages = (await new Response(tailEmptyReplaced.stderr).text()).match(/has been replaced/g) ?? [];
  expect(emptyReplaceMessages.length).toBeLessThanOrEqual(8);
  await writeFile(join(dir, "tail-name-moved"), "");
  const tailNameMoved = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tail", "--follow=name", "--sleep=0.1", "tail-name-moved"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.sleep(1000);
  await rename(join(dir, "tail-name-moved"), join(dir, "tail-name-moved-away"));
  expect(await Promise.race([tailNameMoved.exited, Bun.sleep(1000).then(() => "running")])).toBe(1);
  expect(await new Response(tailNameMoved.stderr).text()).toContain("tail: no files remaining\n");
  const tailRetryMissing = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tail", "-F", "--sleep=0.2", "tail-missing"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await Promise.race([tailRetryMissing.exited.then(() => "exited"), Bun.sleep(150).then(() => "running")])).toBe("running");
  tailRetryMissing.kill("SIGTERM");
  await tailRetryMissing.exited.catch(() => {});
  await symlink("tail-target-a", join(dir, "tail-symlink"));
  const tailSymlink = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tail", "-F", "--sleep=0.1", "tail-symlink"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.sleep(150);
  await writeFile(join(dir, "tail-target-a"), "A\n");
  await Bun.sleep(250);
  await symlink("tail-target-b", join(dir, "tail-symlink.new"));
  await rename(join(dir, "tail-symlink.new"), join(dir, "tail-symlink"));
  await Bun.sleep(150);
  await writeFile(join(dir, "tail-target-b"), "B\n");
  await Bun.sleep(250);
  tailSymlink.kill("SIGTERM");
  await tailSymlink.exited.catch(() => {});
  expect(await new Response(tailSymlink.stdout).text()).toContain("A\nB\n");
  await mkdir(join(dir, "tail-untailable"));
  const tailUntailable = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tail", "-F", "--sleep=0.1", "tail-untailable"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.sleep(1000);
  tailUntailable.kill("SIGTERM");
  await tailUntailable.exited.catch(() => {});
  const tailUntailableErr = await new Response(tailUntailable.stderr).text();
  expect(tailUntailableErr).toContain("tail: cannot follow 'tail-untailable': Is a directory\n");
  expect(tailUntailableErr).toContain("tail: 'tail-untailable' has become inaccessible: Is a directory\n");
  await mkdir(join(dir, "tail'untailable"));
  const tailQuotedUntailable = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tail", "-F", "--sleep=0.1", "tail'untailable"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.sleep(1000);
  tailQuotedUntailable.kill("SIGTERM");
  await tailQuotedUntailable.exited.catch(() => {});
  const tailQuotedUntailableErr = await new Response(tailQuotedUntailable.stderr).text();
  expect(tailQuotedUntailableErr).toContain("tail: cannot follow \"tail'untailable\": Is a directory\n");
  expect(tailQuotedUntailableErr).toContain("tail: \"tail'untailable\" has become inaccessible: Is a directory\n");
  await writeFile(join(dir, "tail-descriptor"), "");
  const tailDescriptor = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tail", "-f", "--sleep=0.1", "tail-descriptor"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await Bun.sleep(150);
  await writeFile(join(dir, "tail-descriptor"), "one\n");
  await Bun.sleep(250);
  await rename(join(dir, "tail-descriptor"), join(dir, "tail-descriptor-renamed"));
  await writeFile(join(dir, "tail-descriptor-renamed"), "one\ntwo\n");
  await Bun.sleep(250);
  tailDescriptor.kill("SIGTERM");
  await tailDescriptor.exited.catch(() => {});
  expect(await new Response(tailDescriptor.stdout).text()).toContain("one\ntwo\n");
  await writeFile(join(dir, "-2"), "dash\n");
  expect(await run(["head", "--", "-2"])).toMatchObject({ code: 0, stdout: "dash\n" });
  expect(await run(["wc", "-c"], "abc")).toMatchObject({ code: 0, stdout: "3\n" });
  expect(await run(["wc", "-m", "-c"], "é\n")).toMatchObject({ code: 0, stdout: "      2       3\n" });
  expect(await run(["wc", "-L"], "ab\tc\nwide\n")).toMatchObject({ code: 0, stdout: "9\n" });
  await writeFile(join(dir, "wc-a"), "x\n");
  await writeFile(join(dir, "wc-b"), "y\nz\n");
  await writeFile(join(dir, "wc-list"), "wc-a\0wc-b\0");
  expect(await run(["wc", "-l", "--files0-from=wc-list", "--total=only"])).toMatchObject({ code: 0, stdout: "3\n" });
  expect(await run(["wc", "--files0-from", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "wc: cannot open '--help' for reading: No such file or directory\n" });
  await symlink("wc-files0-loop", join(dir, "wc-files0-loop"));
  expect(await run(["wc", "--files0-from=wc-files0-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "wc: cannot open 'wc-files0-loop' for reading: Too many levels of symbolic links\n" });
  expect(await run(["wc", "--files0-from=-"], "missing\0missing\0")).toMatchObject({ code: 1, stdout: "0 0 0 total\n", stderr: "wc: missing: No such file or directory\nwc: missing: No such file or directory\n" });
  expect(await run(["wc", "--files0-from=-"], "missing\nfile\0")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "wc: 'missing'$'\\n''file': No such file or directory\n",
  });
  expect(await run(["wc", "--files0-from=-"], "\0wc-a\0")).toMatchObject({ code: 1, stdout: "1 1 2 wc-a\n1 1 2 total\n", stderr: "wc: -:1: invalid zero-length file name\n" });
  expect(await run(["wc", "--files0-from=-"], "-")).toMatchObject({ code: 1, stderr: "wc: when reading file names from standard input, no file name of '-' allowed\n" });
  await writeFile(join(dir, "1\n2"), "");
  expect(await run(["wc", "--files0-from=-"], "1\n2\0")).toMatchObject({ code: 0, stdout: "0 0 0 '1'$'\\n''2'\n" });
  expect(await run(["wc", "-c", "wc-a", "wc-b"])).toMatchObject({ code: 0, stdout: "2 wc-a\n4 wc-b\n6 total\n" });
  expect(await run(["truncate", "-s", "1G", "wc-big"])).toMatchObject({ code: 0 });
  expect(await run(["wc", "-c", "--files0-from=-"], "wc-big\0wc-a\0")).toMatchObject({ code: 0, stdout: "1073741824 wc-big\n2 wc-a\n1073741826 total\n" });
});

test("text filters stream special-file operands and preserve multibyte cut units", async () => {
  const bnu = join(import.meta.dir, "../bin/bnu.js");
  for (const args of [
    ["cat", "/dev/zero"],
    ["cut", "-b1-", "/dev/zero"],
    ["cut", "-c1-", "/dev/zero"],
    ["cut", "-f1", "/dev/zero"],
    ["cut", "-z", "-c1-", "/dev/zero"],
    ["cut", "-z", "-f1-", "/dev/zero"],
    ["expand", "/dev/zero"],
    ["unexpand", "/dev/zero"],
    ["fold", "/dev/zero"],
    ["fold", "-b", "/dev/zero"],
    ["fold", "-c", "/dev/zero"],
    ["paste", "/dev/zero"],
    ["od", "-v", "/dev/zero"],
    ["comm", "-z", "/dev/zero", "/dev/zero"],
    ["uniq", "-z", "-D", "/dev/zero"],
    ["head", "-z", "-n-1", "/dev/zero"],
    ["tail", "-n+1", "-z", "/dev/zero"],
    ["join", "-a", "1", "-z", "/dev/zero", "/dev/null"],
    ["fmt", "/dev/zero"],
    ["pr", "/dev/zero"],
  ]) {
    const child = Bun.spawn(["/usr/bin/timeout", "5s", process.execPath, bnu, ...args], {
      cwd: dir,
      stdout: Bun.file("/dev/full"),
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toBe(args[0] === "head"
      ? "head: error writing 'standard output': No space left on device\n"
      : `${args[0]}: write error: No space left on device\n`);
  }

  const factor = Bun.spawn(["/usr/bin/env", "--default-signal=PIPE", "/bin/sh", "-c", `/usr/bin/yes 1 | ${process.execPath} ${bnu} factor`], {
    cwd: dir,
    stdout: Bun.file("/dev/full"),
    stderr: "pipe",
  });
  expect(await factor.exited).toBe(1);
  expect(await new Response(factor.stderr).text()).toBe("factor: write error: No space left on device\n");

  const checksum = (await run(["cksum", "-a", "sha3", "-l", "256", "/dev/null"])).stdout.trim();
  const checker = Bun.spawn(["/usr/bin/env", "--default-signal=PIPE", "/bin/sh", "-c", `/usr/bin/yes "$CHECKSUM" | ${process.execPath} ${bnu} cksum --check`], {
    cwd: dir,
    env: { ...process.env, CHECKSUM: checksum },
    stdout: Bun.file("/dev/full"),
    stderr: "pipe",
  });
  expect(await checker.exited).toBe(1);
  expect(await new Response(checker.stderr).text()).toBe("cksum: write error: No space left on device\n");

  for (const [command, pipeline] of [
    ["wc", `/usr/bin/yes /dev/null | /usr/bin/tr '\\n' '\\0' | ${process.execPath} ${bnu} wc --files0-from=-`],
    ["du", `/usr/bin/yes /dev/null | /usr/bin/tr '\\n' '\\0' | ${process.execPath} ${bnu} du -l --files0-from=-`],
    ["fmt", `/usr/bin/yes | ${process.execPath} ${bnu} fmt`],
  ]) {
    const child = Bun.spawn(["/usr/bin/env", "--default-signal=PIPE", "/bin/sh", "-c", pipeline], {
      cwd: dir,
      stdout: Bun.file("/dev/full"),
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toBe(`${command}: write error: No space left on device\n`);
  }

  await writeFile(join(dir, "cut-invalid-utf8"), Buffer.from([0xc3, 0x78, 0x0a]));
  const invalidOutput = join(dir, "cut-invalid-output");
  const invalid = Bun.spawn([process.execPath, bnu, "cut", "-c1-2", "cut-invalid-utf8"], { cwd: dir, stdout: Bun.file(invalidOutput), stderr: "pipe" });
  expect(await invalid.exited).toBe(0);
  expect([...await readFile(invalidOutput)]).toEqual([0xc3, 0x78, 0x0a]);

  await writeFile(join(dir, "cut-utf8-units"), Buffer.from([0xc3, 0xa9, 0xc3, 0xbc, 0x78, 0x0a]));
  const unitOutput = join(dir, "cut-unit-output");
  const units = Bun.spawn([process.execPath, bnu, "cut", "-b1-2,4", "-n", "--output-delimiter=:", "cut-utf8-units"], { cwd: dir, stdout: Bun.file(unitOutput), stderr: "pipe", env: { ...process.env, LC_ALL: "C.UTF-8" } });
  expect(await units.exited).toBe(0);
  expect([...await readFile(unitOutput)]).toEqual([0xc3, 0xa9, 0x3a, 0xc3, 0xbc, 0x0a]);
  expect(await run(["cut", "-w", "-f2"], "a\u2003b\n", { env: { LC_ALL: "C.UTF-8" } })).toMatchObject({ code: 0, stdout: "b\n" });
  expect(await run(["cut", "-sw", "-f2"], "a\u00a0b\n", { env: { LC_ALL: "C.UTF-8" } })).toMatchObject({ code: 0, stdout: "" });
});

test("filesystem utilities create, copy, move, link, remove", async () => {
  expect(await run(["link"])).toMatchObject({ code: 1, stderr: "link: missing operand\nTry 'link --help' for more information.\n" });
  expect(await run(["link", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: link FILE1 FILE2\n  or:  link OPTION\n") });
  expect(await run(["link", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["link", "--h=1"])).toMatchObject({ code: 1, stderr: "link: option '--help' doesn't allow an argument\nTry 'link --help' for more information.\n" });
  expect(await run(["link", "one"])).toMatchObject({ code: 1, stderr: "link: missing operand after 'one'\nTry 'link --help' for more information.\n" });
  expect(await run(["link", "one", "two", "three"])).toMatchObject(await systemRun(["link", "one", "two", "three"]));
  expect(await run(["link", "one", "two", "extra\narg"])).toMatchObject({ code: 1, stderr: `link: extra operand ${diagnosticQuote("extra\\narg")}\nTry 'link --help' for more information.\n` });
  expect(await run(["unlink"])).toMatchObject({ code: 1, stderr: "unlink: missing operand\nTry 'unlink --help' for more information.\n" });
  expect(await run(["unlink", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: unlink FILE\n  or:  unlink OPTION\n") });
  expect(await run(["unlink", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["unlink", "--v=1"])).toMatchObject({ code: 1, stderr: "unlink: option '--version' doesn't allow an argument\nTry 'unlink --help' for more information.\n" });
  expect(await run(["unlink", "one", "two"])).toMatchObject(await systemRun(["unlink", "one", "two"]));
  expect(await run(["unlink", "one", "extra\narg"])).toMatchObject({ code: 1, stderr: `unlink: extra operand ${diagnosticQuote("extra\\narg")}\nTry 'unlink --help' for more information.\n` });
  expect(await run(["mkdir", "-p", "a/b"])).toMatchObject({ code: 0 });
  expect(await run(["touch", "a/b/file"])).toMatchObject({ code: 0 });
  await writeFile(join(dir, "a/b/file"), "payload");
  expect(await run(["cp", "a/b/file", "copy"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "copy"), "utf8")).toBe("payload");
  expect(await run(["cp", "/dev/null", "null-copy"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "null-copy"))).size).toBe(0);
  await mkdir(join(dir, "special-target"));
  expect(await run(["cp", "--target-directory=special-target", "/dev/null"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "special-target/null"))).size).toBe(0);
  await writeFile(join(dir, "cp-target-prefix"), "target");
  expect(await run(["cp", "--target", "special-target", "cp-target-prefix"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "special-target/cp-target-prefix"), "utf8")).toBe("target");
  expect(await run(["cp", "--no", "--help"])).toMatchObject({
    code: 1,
    stderr: "cp: option '--no' is ambiguous; possibilities: '--no-clobber' '--no-dereference' '--no-preserve' '--no-target-directory'\nTry 'cp --help' for more information.\n",
  });
  expect(await run(["cp", "--s", "--help"])).toMatchObject({
    code: 1,
    stderr: "cp: option '--s' is ambiguous; possibilities: '--sparse' '--strip-trailing-slashes' '--suffix' '--symbolic-link'\nTry 'cp --help' for more information.\n",
  });
  expect(await run(["cp", "--force=bad", "--help"])).toMatchObject({
    code: 1,
    stderr: "cp: option '--force' doesn't allow an argument\nTry 'cp --help' for more information.\n",
  });
  expect(await run(["cp", "--copy=bad", "--help"])).toMatchObject({
    code: 1,
    stderr: "cp: option '--copy-contents' doesn't allow an argument\nTry 'cp --help' for more information.\n",
  });
  expect(await run(["cp", "--preserve=", "--help"])).toMatchObject({
    code: 1,
    stderr: `cp: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--preserve")}\nValid arguments are:\n  - ${diagnosticQuote("mode")}\n  - ${diagnosticQuote("timestamps")}\n  - ${diagnosticQuote("ownership")}\n  - ${diagnosticQuote("links")}\n  - ${diagnosticQuote("context")}\n  - ${diagnosticQuote("xattr")}\n  - ${diagnosticQuote("all")}\nTry 'cp --help' for more information.\n`,
  });
  expect(await run(["cp", "--no-preserve=", "--help"])).toMatchObject({
    code: 1,
    stderr: `cp: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--no-preserve")}\nValid arguments are:\n  - ${diagnosticQuote("mode")}\n  - ${diagnosticQuote("timestamps")}\n  - ${diagnosticQuote("ownership")}\n  - ${diagnosticQuote("links")}\n  - ${diagnosticQuote("context")}\n  - ${diagnosticQuote("xattr")}\n  - ${diagnosticQuote("all")}\nTry 'cp --help' for more information.\n`,
  });
  expect(await run(["cp", "--preserve=bad\nmode", "--help"])).toMatchObject({
    code: 1,
    stderr: `cp: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--preserve")}\nValid arguments are:\n  - ${diagnosticQuote("mode")}\n  - ${diagnosticQuote("timestamps")}\n  - ${diagnosticQuote("ownership")}\n  - ${diagnosticQuote("links")}\n  - ${diagnosticQuote("context")}\n  - ${diagnosticQuote("xattr")}\n  - ${diagnosticQuote("all")}\nTry 'cp --help' for more information.\n`,
  });
  expect(await run(["cp", "--update=", "--help"])).toMatchObject({
    code: 1,
    stderr: `cp: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--update")}\nValid arguments are:\n  - ${diagnosticQuote("all")}\n  - ${diagnosticQuote("none")}\n  - ${diagnosticQuote("none-fail")}\n  - ${diagnosticQuote("older")}\nTry 'cp --help' for more information.\n`,
  });
  expect(await run(["cp", "--update=bad", "--help"])).toMatchObject(await systemRun(["cp", "--update=bad", "--help"]));
  expect(await run(["cp", "--update=bad\nmode", "--help"])).toMatchObject({
    code: 1,
    stderr: `cp: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--update")}\nValid arguments are:\n  - ${diagnosticQuote("all")}\n  - ${diagnosticQuote("none")}\n  - ${diagnosticQuote("none-fail")}\n  - ${diagnosticQuote("older")}\nTry 'cp --help' for more information.\n`,
  });
  expect(await run(["cp", "--reflink=", "--help"])).toMatchObject({
    code: 1,
    stderr: `cp: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--reflink")}\nValid arguments are:\n  - ${diagnosticQuote("auto")}\n  - ${diagnosticQuote("always")}\n  - ${diagnosticQuote("never")}\nTry 'cp --help' for more information.\n`,
  });
  expect(await run(["cp", "--reflink=bad", "--help"])).toMatchObject(await systemRun(["cp", "--reflink=bad", "--help"]));
  expect(await run(["cp", "--reflink=bad\nmode", "--help"])).toMatchObject({
    code: 1,
    stderr: `cp: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--reflink")}\nValid arguments are:\n  - ${diagnosticQuote("auto")}\n  - ${diagnosticQuote("always")}\n  - ${diagnosticQuote("never")}\nTry 'cp --help' for more information.\n`,
  });
  expect(await run(["cp", "--sparse=", "--help"])).toMatchObject({
    code: 1,
    stderr: `cp: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--sparse")}\nValid arguments are:\n  - ${diagnosticQuote("never")}\n  - ${diagnosticQuote("auto")}\n  - ${diagnosticQuote("always")}\nTry 'cp --help' for more information.\n`,
  });
  expect(await run(["cp", "--sparse=bad", "--help"])).toMatchObject(await systemRun(["cp", "--sparse=bad", "--help"]));
  expect(await run(["cp", "--sparse=bad\nmode", "--help"])).toMatchObject({
    code: 1,
    stderr: `cp: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--sparse")}\nValid arguments are:\n  - ${diagnosticQuote("never")}\n  - ${diagnosticQuote("auto")}\n  - ${diagnosticQuote("always")}\nTry 'cp --help' for more information.\n`,
  });
  expect(await run(["cp", "--suffix", "--help", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["cp", "moved", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: cp [OPTION]... [-T] SOURCE DEST\n"), stderr: "" });
  expect(await run(["cp", "--ver=bad", "--help"])).toMatchObject({
    code: 1,
    stderr: "cp: option '--ver=bad' is ambiguous; possibilities: '--verbose' '--version'\nTry 'cp --help' for more information.\n",
  });
  expect(await run(["mv", "copy", "moved"])).toMatchObject({ code: 0 });
  await writeFile(join(dir, "mv-same"), "same");
  await link(join(dir, "mv-same"), join(dir, "mv-same-link"));
  expect(await run(["mv", "mv-same", "mv-same"])).toMatchObject({ code: 1, stderr: "mv: 'mv-same' and 'mv-same' are the same file\n" });
  expect(await run(["mv", "mv-same", "mv-same-link"])).toMatchObject({ code: 1, stderr: "mv: 'mv-same' and 'mv-same-link' are the same file\n" });
  expect(await readFile(join(dir, "mv-same"), "utf8")).toBe("same");
  await writeFile(join(dir, "mv-backup-hard"), "hard");
  await link(join(dir, "mv-backup-hard"), join(dir, "mv-backup-hard-link"));
  expect(await run(["mv", "--backup=simple", "mv-backup-hard", "mv-backup-hard-link"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "mv-backup-hard"))).rejects.toThrow();
  expect(await readFile(join(dir, "mv-backup-hard-link"), "utf8")).toBe("hard");
  expect(await readFile(join(dir, "mv-backup-hard-link~"), "utf8")).toBe("hard");
  expect(await run(["ln", "-s", "moved", "sym"])).toMatchObject({ code: 0 });
  expect(await run(["ln", "moved", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: ln [OPTION]... [-T] TARGET LINK_NAME\n"), stderr: "" });
  expect(await run(["readlink", "sym"])).toMatchObject({ code: 0, stdout: "moved\n" });
  expect(await run(["cp", "-s", "moved", "cp-sym"])).toMatchObject({ code: 0 });
  expect(await run(["readlink", "cp-sym"])).toMatchObject({ code: 0, stdout: "moved\n" });
  const cpDebug = await run(["cp", "--debug", "moved", "debug-copy"]);
  expect(cpDebug.stdout).toStartWith("'moved' -> 'debug-copy'\n");
  expect(cpDebug.stdout).toMatch(/copy offload: (unknown|avoided), reflink: (yes|no), sparse detection: (unknown|no|SEEK_HOLE)\n$/);
  expect(await run(["cp", "--debug", "--sparse=never", "moved", "debug-sparse-never"])).toMatchObject({
    code: 0,
    stdout: "'moved' -> 'debug-sparse-never'\ncopy offload: avoided, reflink: no, sparse detection: no\n",
  });
  expect((await run(["cp", "--debug", "--attributes-only", "moved", "debug-copy"])).stdout).not.toContain("copy offload:");
  expect((await run(["cp", "--debug", "--update=none", "moved", "debug-copy"])).stdout).toContain("skipped");
  expect(await run(["cp", "--strip-trailing-slashes", "moved", "strip-slash-copy"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "strip-slash-copy"), "utf8")).toBe("payload");
  await mkdir(join(dir, "one-file-system-src"));
  await writeFile(join(dir, "one-file-system-src/file"), "onefs");
  expect(await run(["cp", "-xR", "--keep-directory-symlink", "one-file-system-src", "one-file-system-copy"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "one-file-system-copy/file"), "utf8")).toBe("onefs");
  expect(await run(["cp", "--reflink=auto", "moved", "reflink-auto-copy"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "reflink-auto-copy"), "utf8")).toBe("payload");
  expect(await run(["cp", "--reflink=auto", "--sparse=always", "moved", "reflink-sparse-copy"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "reflink-sparse-copy"), "utf8")).toBe("payload");
  expect(await run(["cp", "--reflink", "--sparse=always", "moved", "reflink-sparse-required-copy"])).toMatchObject({ code: 1, stderr: "cp: options --reflink and --sparse are mutually exclusive\n" });
  expect(await run(["cp", "--reflink=auto", "--reflink=never", "moved", "reflink-never-copy"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "reflink-never-copy"), "utf8")).toBe("payload");
  const reflinkRequired = await run(["cp", "--reflink", "moved", "reflink-required-copy"]);
  if (reflinkRequired.code === 0) {
    expect(await readFile(join(dir, "reflink-required-copy"), "utf8")).toBe("payload");
  } else {
    expect(reflinkRequired.stderr).toContain("failed to clone");
    await expect(stat(join(dir, "reflink-required-copy"))).rejects.toThrow();
  }
  expect(await run(["mkfifo", "cp-copy-contents-fifo"])).toMatchObject({ code: 0 });
  const cpCopyContents = await shell(`
    /usr/bin/timeout 5s /bin/sh -c '
      "$BUN" "$BNU" cp -R --copy-contents cp-copy-contents-fifo cp-copy-contents-out &
      cpid=$!
      sleep .1
      printf "fifo payload" > cp-copy-contents-fifo
      wait "$cpid"
    '
  `);
  expect(cpCopyContents).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "cp-copy-contents-out"))).isFIFO()).toBe(false);
  expect(await readFile(join(dir, "cp-copy-contents-out"), "utf8")).toBe("fifo payload");
  await mkdir(join(dir, "parent-copy-root"));
  expect(await run(["cp", "--parent", "a/b/file", "parent-copy-root"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "parent-copy-root/a/b/file"), "utf8")).toBe("payload");
  const cpHelp = (await run(["cp", "--help"])).stdout;
  expect(cpHelp).toContain("Usage: cp [OPTION]... [-T] SOURCE DEST\n  or:  cp [OPTION]... SOURCE... DIRECTORY\n  or:  cp [OPTION]... -t DIRECTORY SOURCE...\n");
  expect(cpHelp).toContain("  --parents\n");
  expect(cpHelp).not.toContain("  --parent\n");
  await mkdir(join(dir, "parent-mode-root"));
  await run(["chmod", "700", "a"]);
  await run(["chmod", "710", "a/b"]);
  expect(await run(["cp", "-p", "--parent", "a/b/file", "parent-mode-root"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "parent-mode-root/a"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(dir, "parent-mode-root/a/b"))).mode & 0o777).toBe(0o710);
  await run(["chmod", "755", "a"]);
  await run(["chmod", "755", "a/b"]);
  await mkdir(join(dir, "cp-readonly-src/nested"), { recursive: true });
  await writeFile(join(dir, "cp-readonly-src/nested/file"), "readonly");
  await run(["chmod", "-R", "555", "cp-readonly-src"]);
  expect(await run(["cp", "-a", "cp-readonly-src", "cp-readonly-dst"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "cp-readonly-dst"))).mode & 0o777).toBe(0o555);
  expect((await stat(join(dir, "cp-readonly-dst/nested"))).mode & 0o777).toBe(0o555);
  await run(["chmod", "-R", "755", "cp-readonly-src"]);
  await run(["chmod", "-R", "755", "cp-readonly-dst"]);
  expect(await run(["mkfifo", "cp-perm-race-fifo"])).toMatchObject({ code: 0 });
  const cpCopyContentsPerms = await shell(`
    /usr/bin/timeout 5s /bin/sh -c '
      "$BUN" "$BNU" cp -p --copy-contents cp-perm-race-fifo cp-perm-race-out &
      cpid=$!
      (
        while [ ! -f cp-perm-race-out ]; do echo x; done
        stat --format=%a cp-perm-race-out > cp-perm-race-mode
        echo done
      ) > cp-perm-race-fifo
      wait "$cpid"
    '
  `);
  expect(cpCopyContentsPerms).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "cp-perm-race-mode"), "utf8")).toBe("600\n");
  const sparseSource = await open(join(dir, "sparse-source"), "w");
  await sparseSource.write(Buffer.from("A"), 0, 1, 0);
  await sparseSource.write(Buffer.from("Z"), 0, 1, 1024 * 1024 - 1);
  await sparseSource.close();
  await writeFile(join(dir, "sparse-dest"), "");
  await truncate(join(dir, "sparse-dest"), 524288);
  expect(await run(["cp", "--reflink=never", "--sparse=always", "sparse-source", "sparse-dest"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "sparse-dest"))).size).toBe(1024 * 1024);
  const sparseExtentDebug = await run(["cp", "--debug", "--reflink=never", "sparse-source", "sparse-debug-extents"]);
  expect(sparseExtentDebug).toMatchObject({ code: 0 });
  expect(sparseExtentDebug.stdout).toContain("sparse detection: SEEK_HOLE\n");
  await writeFile(join(dir, "sparse-zero-source"), Buffer.alloc(256 * 1024));
  const sparseZeroDebug = await run(["cp", "--debug", "--reflink=never", "--sparse=always", "sparse-zero-source", "sparse-debug-zero"]);
  expect(sparseZeroDebug).toMatchObject({ code: 0 });
  expect(sparseZeroDebug.stdout).toContain("sparse detection: zeros\n");
  expect((await stat(join(dir, "sparse-debug-zero"))).blocks).toBeLessThan((await stat(join(dir, "sparse-zero-source"))).blocks);
  expect(await run(["cp", "--sparse=never", "sparse-source", "sparse-dense"])).toMatchObject({ code: 0 });
  expect(await run(["cp", "--sparse=always", "sparse-source", "sparse-preserved"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "sparse-dense"))).blocks).toBeGreaterThan((await stat(join(dir, "sparse-preserved"))).blocks);
  expect(await run(["mkfifo", "sparse-pipe"])).toMatchObject({ code: 0 });
  expect(await shell(`
    /usr/bin/timeout 5s /bin/sh -c '
      cat sparse-pipe > sparse-pipe-copy &
      cpid=$!
      "$BUN" "$BNU" cp --sparse=always sparse-source sparse-pipe
      wait "$cpid"
    '
  `)).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "sparse-pipe-copy"))).toEqual(await readFile(join(dir, "sparse-source")));
  await mkdir(join(dir, "preserve-link-dest"));
  await writeFile(join(dir, "preserve-link-a"), "linked");
  await link(join(dir, "preserve-link-a"), join(dir, "preserve-link-b"));
  await writeFile(join(dir, "preserve-link-dest/preserve-link-a"), "");
  await writeFile(join(dir, "preserve-link-dest/preserve-link-b"), "");
  expect(await run(["cp", "--preserve=link", "preserve-link-a", "preserve-link-b", "preserve-link-dest"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "preserve-link-dest/preserve-link-a"))).ino).toBe((await stat(join(dir, "preserve-link-dest/preserve-link-b"))).ino);
  await writeFile(join(dir, "cp-interactive-src"), "new");
  await writeFile(join(dir, "cp-interactive-dst"), "old");
  expect(await run(["cp", "-vi", "cp-interactive-src", "cp-interactive-dst"], "n\n")).toMatchObject({ code: 1, stdout: "" });
  expect(await readFile(join(dir, "cp-interactive-dst"), "utf8")).toBe("old");
  expect(await run(["cp", "-vni", "cp-interactive-src", "cp-interactive-dst"], "y\n")).toMatchObject({ code: 0, stdout: "'cp-interactive-src' -> 'cp-interactive-dst'\n" });
  expect(await readFile(join(dir, "cp-interactive-dst"), "utf8")).toBe("new");
  await writeFile(join(dir, "cp-interactive-dst"), "old");
  expect(await run(["cp", "-vin", "cp-interactive-src", "cp-interactive-dst"], "y\n")).toMatchObject({ code: 0, stdout: "" });
  expect(await readFile(join(dir, "cp-interactive-dst"), "utf8")).toBe("old");
  expect(await run(["cp", "-bn", "cp-interactive-src", "cp-interactive-dst"])).toMatchObject({ code: 1 });
  await writeFile(join(dir, "cp-mode-src"), "mode");
  await run(["chmod", "600", "cp-mode-src"]);
  expect(await run(["cp", "--no-preserve=mode", "cp-mode-src", "cp-mode-default"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "cp-mode-default"))).mode & 0o777).toBe(0o644);
  expect(await run(["cp", "--preserve=bad", "cp-mode-src", "cp-preserve-bad"])).toMatchObject(await systemRun(["cp", "--preserve=bad", "cp-mode-src", "cp-preserve-bad"]));
  await expect(stat(join(dir, "cp-preserve-bad"))).rejects.toThrow();
  expect(await run(["cp", "--preserve=bad\nmode", "cp-mode-src", "cp-preserve-bad-newline"])).toMatchObject({
    code: 1,
    stderr: `cp: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--preserve")}\nValid arguments are:\n  - ${diagnosticQuote("mode")}\n  - ${diagnosticQuote("timestamps")}\n  - ${diagnosticQuote("ownership")}\n  - ${diagnosticQuote("links")}\n  - ${diagnosticQuote("context")}\n  - ${diagnosticQuote("xattr")}\n  - ${diagnosticQuote("all")}\nTry 'cp --help' for more information.\n`,
  });
  await expect(stat(join(dir, "cp-preserve-bad-newline"))).rejects.toThrow();
  expect(await run(["cp", "--preserve=", "cp-mode-src", "cp-preserve-empty"])).toMatchObject(await systemRun(["cp", "--preserve=", "cp-mode-src", "cp-preserve-empty"]));
  await expect(stat(join(dir, "cp-preserve-empty"))).rejects.toThrow();
  expect(await run(["cp", "--no-preserve=bad", "cp-mode-src", "cp-no-preserve-bad"])).toMatchObject(await systemRun(["cp", "--no-preserve=bad", "cp-mode-src", "cp-no-preserve-bad"]));
  await expect(stat(join(dir, "cp-no-preserve-bad"))).rejects.toThrow();
  expect(await run(["cp", "--no-preserve=bad\nmode", "cp-mode-src", "cp-no-preserve-bad-newline"])).toMatchObject({
    code: 1,
    stderr: `cp: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--no-preserve")}\nValid arguments are:\n  - ${diagnosticQuote("mode")}\n  - ${diagnosticQuote("timestamps")}\n  - ${diagnosticQuote("ownership")}\n  - ${diagnosticQuote("links")}\n  - ${diagnosticQuote("context")}\n  - ${diagnosticQuote("xattr")}\n  - ${diagnosticQuote("all")}\nTry 'cp --help' for more information.\n`,
  });
  await expect(stat(join(dir, "cp-no-preserve-bad-newline"))).rejects.toThrow();
  expect(await run(["cp", "--no-preserve=", "cp-mode-src", "cp-no-preserve-empty"])).toMatchObject(await systemRun(["cp", "--no-preserve=", "cp-mode-src", "cp-no-preserve-empty"]));
  await expect(stat(join(dir, "cp-no-preserve-empty"))).rejects.toThrow();
  expect(await run(["cp", "--preserve=context", "cp-mode-src", "cp-preserve-context"])).toMatchObject({
    code: 1,
    stderr: "cp: cannot preserve security context without an SELinux-enabled kernel\n",
  });
  await expect(stat(join(dir, "cp-preserve-context"))).rejects.toThrow();
  expect(await run(["cp", "--preserve=all,context", "cp-mode-src", "cp-preserve-context-list"])).toMatchObject({
    code: 1,
    stderr: "cp: cannot preserve security context without an SELinux-enabled kernel\n",
  });
  await expect(stat(join(dir, "cp-preserve-context-list"))).rejects.toThrow();
  expect(await run(["cp", "--preserve=all", "cp-mode-src", "cp-preserve-all"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "cp-preserve-all"), "utf8")).toBe("mode");
  expect(await run(["cp", "cp-mode-src", "cp-mode-source"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "cp-mode-source"))).mode & 0o777).toBe(0o600);
  await writeFile(join(dir, "cp-mode-zero-src"), "mode");
  await writeFile(join(dir, "cp-mode-zero-dst"), "old");
  await run(["chmod", "0", "cp-mode-zero-dst"]);
  const modeZeroCopy = await run(["cp", "-if", "cp-mode-zero-src", "cp-mode-zero-dst"], "y\n");
  expect(modeZeroCopy.code).toBe(0);
  expect(modeZeroCopy.stderr).toStartWith("cp: replace 'cp-mode-zero-dst', overriding mode 0000");
  expect(await readFile(join(dir, "cp-mode-zero-dst"), "utf8")).toBe("mode");
  await writeFile(join(dir, "cp-force-mode-src"), "new");
  await writeFile(join(dir, "cp-force-mode-dst"), "old");
  await run(["chmod", "450", "cp-force-mode-src"]);
  await run(["chmod", "644", "cp-force-mode-dst"]);
  expect(await run(["cp", "-f", "cp-force-mode-src", "cp-force-mode-dst"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "cp-force-mode-dst"))).mode & 0o777).toBe(0o644);
  expect(await run(["cp", "-Z", "cp-mode-zero-src", "cp-context-copy"])).toMatchObject({ code: 0, stderr: "" });
  expect(await run(["cp", "--context=system_u:object_r:tmp_t:s0", "cp-mode-zero-src", "cp-context-copy-2"])).toMatchObject({ code: 0, stderr: "cp: warning: ignoring --context; it requires an SELinux-enabled kernel\n" });
  expect(await run(["cp", "--context=system_u:object_r:tmp_t:s0", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: cp [OPTION]... [-T] SOURCE DEST\n"), stderr: "cp: warning: ignoring --context; it requires an SELinux-enabled kernel\n" });
  await mkdir(join(dir, "cp-no-access/inner"), { recursive: true });
  await run(["chmod", "0", "cp-no-access"]);
  await symlink("cp-no-access/inner", join(dir, "cp-no-access-link"));
  await writeFile(join(dir, "cp-no-access-src"), "x");
  expect(await run(["cp", "cp-no-access-src", "cp-no-access-link"])).toMatchObject({ code: 1, stderr: "cp: cannot stat 'cp-no-access-link': Permission denied\n" });
  expect(await run(["cp", "--target-directory=cp-no-access-link", "cp-no-access-src"])).toMatchObject({ code: 1, stderr: "cp: target directory 'cp-no-access-link': Permission denied\n" });
  await run(["chmod", "700", "cp-no-access"]);
  await mkdir(join(dir, "cp-partial-src/inner"), { recursive: true });
  await writeFile(join(dir, "cp-partial-src/no-read"), "x");
  await run(["chmod", "500", "cp-partial-src"]);
  await run(["chmod", "0", "cp-partial-src/no-read"]);
  expect(await run(["cp", "-pR", "cp-partial-src", "cp-partial-dst"])).toMatchObject({ code: 1 });
  expect((await lstat(join(dir, "cp-partial-dst"))).mode & 0o777).toBe(0o500);
  await run(["chmod", "700", "cp-partial-dst"]);
  await run(["chmod", "700", "cp-partial-src"]);
  await run(["chmod", "600", "cp-partial-src/no-read"]);
  await mkdir(join(dir, "abuse-a"));
  await mkdir(join(dir, "abuse-b"));
  await mkdir(join(dir, "abuse-c"));
  await symlink("../abuse-target", join(dir, "abuse-a/one"));
  await writeFile(join(dir, "abuse-b/one"), "payload");
  expect(await run(["cp", "-dR", "abuse-a/one", "abuse-b/one", "abuse-c"])).toMatchObject({ code: 1, stderr: "cp: will not copy 'abuse-b/one' through just-created symlink 'abuse-c/one'\n" });
  await expect(stat(join(dir, "abuse-target"))).rejects.toThrow();
  await writeFile(join(dir, "abuse-target"), "original");
  expect(await run(["cp", "-dR", "abuse-a/one", "abuse-b/one", "abuse-c"])).toMatchObject({ code: 1, stderr: "cp: will not copy 'abuse-b/one' through just-created symlink 'abuse-c/one'\n" });
  expect(await readFile(join(dir, "abuse-target"), "utf8")).toBe("original");
  await mkdir(join(dir, "childproof-cp-dest"));
  await mkdir(join(dir, "childproof-cp-a"));
  await mkdir(join(dir, "childproof-cp-b"));
  await writeFile(join(dir, "childproof-cp-a/f"), "a");
  await writeFile(join(dir, "childproof-cp-b/f"), "b");
  expect(await run(["cp", "childproof-cp-a/f", "childproof-cp-b/f", "childproof-cp-dest"])).toMatchObject({ code: 1 });
  expect(await readFile(join(dir, "childproof-cp-dest/f"), "utf8")).toBe("a");
  expect(await readFile(join(dir, "childproof-cp-b/f"), "utf8")).toBe("b");
  await writeFile(join(dir, "attr-source"), "source");
  await writeFile(join(dir, "attr-dest"), "dest");
  expect(await run(["cp", "--attributes-only", "attr-source", "attr-dest"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "attr-dest"), "utf8")).toBe("dest");
  await run(["chmod", "600", "attr-source"]);
  expect(await run(["cp", "--attributes-only", "attr-source", "attr-created"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "attr-created"), "utf8")).toBe("");
  expect((await stat(join(dir, "attr-created"))).mode & 0o777).toBe(0o600);
  expect(await run(["cp", "--attributes-only", "--no-preserve=mode", "attr-source", "attr-created-default-mode"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "attr-created-default-mode"), "utf8")).toBe("");
  expect((await stat(join(dir, "attr-created-default-mode"))).mode & 0o777).toBe(0o644);
  await symlink("attr-source", join(dir, "attr-link"));
  expect(await run(["cp", "-a", "--attributes-only", "attr-link", "attr-dest"])).toMatchObject({ code: 1 });
  expect(await readFile(join(dir, "attr-dest"), "utf8")).toBe("dest");
  expect(await run(["cp", "-a", "--remove-destination", "--attributes-only", "attr-link", "attr-dest"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "attr-dest"))).isSymbolicLink()).toBe(true);
  await writeFile(join(dir, "archive-link-file"), "");
  await symlink("archive-link-file", join(dir, "archive-link"));
  const archiveLinkTime = new Date("2011-01-01T00:00:00Z");
  await lutimes(join(dir, "archive-link"), archiveLinkTime, archiveLinkTime);
  expect(await run(["cp", "-al", "archive-link", "archive-link-copy"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "archive-link-copy"))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(dir, "archive-link-copy"))).mtime.getUTCFullYear()).toBe(2011);
  expect(await run(["cp", "-Pp", "archive-link", "archive-link-preserved"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "archive-link-preserved"))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(dir, "archive-link-preserved"))).mtime.getUTCFullYear()).toBe(2011);
  await writeFile(join(dir, "preserve-ns-source"), "ns");
  await systemRun(["/usr/bin/touch", "-a", "-d", "2026-01-01 01:02:03.111111111 +0000", "preserve-ns-source"]);
  await systemRun(["/usr/bin/touch", "-m", "-d", "2026-01-02 03:04:05.222222222 +0000", "preserve-ns-source"]);
  expect(await run(["cp", "-p", "preserve-ns-source", "preserve-ns-copy"])).toMatchObject({ code: 0 });
  expect(await run(["stat", "-c", "%x|%y", "preserve-ns-copy"], "", { env: { TZ: "UTC0" } })).toMatchObject({
    code: 0,
    stdout: "2026-01-01 01:02:03.111111111 +0000|2026-01-02 03:04:05.222222222 +0000\n",
  });
  expect(await run(["link", "moved", "moved-hard"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "moved-hard"), "utf8")).toBe("payload");
  await writeFile(join(dir, "-dash-source"), "dash");
  expect(await run(["link", "--", "-dash-source", "-dash-hard"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "-dash-hard"), "utf8")).toBe("dash");
  expect(await run(["link", "moved"])).toMatchObject({ code: 1, stderr: "link: missing operand after 'moved'\nTry 'link --help' for more information.\n" });
  expect(await run(["link", "moved", "moved-hard"])).toMatchObject({ code: 1, stderr: "link: cannot create link 'moved-hard' to 'moved': File exists\n" });
  expect(await run(["link", "missing\nlink-src", "link-dst"])).toMatchObject({ code: 1, stderr: "link: cannot create link 'link-dst' to 'missing'$'\\n''link-src': No such file or directory\n" });
  expect(await run(["link", "missing'link-src", "link-dst"])).toMatchObject({ code: 1, stderr: "link: cannot create link 'link-dst' to \"missing'link-src\": No such file or directory\n" });
  await writeFile(join(dir, "link-dst\nexists"), "old");
  expect(await run(["link", "moved", "link-dst\nexists"])).toMatchObject({ code: 1, stderr: "link: cannot create link 'link-dst'$'\\n''exists' to 'moved': File exists\n" });
  await writeFile(join(dir, "link-dst'exists"), "old");
  expect(await run(["link", "moved", "link-dst'exists"])).toMatchObject({ code: 1, stderr: "link: cannot create link \"link-dst'exists\" to 'moved': File exists\n" });
  expect(await run(["link", "one", "two", "three"])).toMatchObject(await systemRun(["link", "one", "two", "three"]));
  await writeFile(join(dir, "unlink-me"), "x");
  expect(await run(["unlink", "unlink-me"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "unlink-me"))).rejects.toThrow();
  await writeFile(join(dir, "-dash-file"), "x");
  expect(await run(["unlink", "--", "-dash-file"])).toMatchObject({ code: 0 });
  expect(await run(["unlink", "missing-unlink"])).toMatchObject({ code: 1, stderr: "unlink: cannot unlink 'missing-unlink': No such file or directory\n" });
  expect(await run(["unlink", "missing\nunlink"])).toMatchObject({ code: 1, stderr: "unlink: cannot unlink 'missing'$'\\n''unlink': No such file or directory\n" });
  expect(await run(["unlink", "missing'unlink"])).toMatchObject({ code: 1, stderr: "unlink: cannot unlink \"missing'unlink\": No such file or directory\n" });
  expect(await run(["unlink", "one", "two"])).toMatchObject({ code: 1 });
  await writeFile(join(dir, "backup-target"), "target");
  await writeFile(join(dir, "backup-target~"), "source");
  expect(await run(["cp", "--b=simple", "backup-target~", "backup-target"])).toMatchObject({ code: 1, stderr: "cp: backing up 'backup-target' might destroy source;  'backup-target~' not copied\n" });
  expect(await run(["mv", "--b=simple", "backup-target~", "backup-target"])).toMatchObject({ code: 1, stderr: "mv: backing up 'backup-target' might destroy source;  'backup-target~' not moved\n" });
  await writeFile(join(dir, "mv-backup-source"), "new");
  await writeFile(join(dir, "mv-backup-target"), "old");
  expect(await run(["mv", "--verbose", "--backup=numbered", "mv-backup-source", "mv-backup-target"])).toMatchObject({ code: 0, stdout: "renamed 'mv-backup-source' -> 'mv-backup-target' (backup: 'mv-backup-target.~1~')\n" });
  expect(await readFile(join(dir, "mv-backup-target.~1~"), "utf8")).toBe("old");
  await writeFile(join(dir, "mv-debug-source"), "debug");
  expect(await run(["mv", "--debug", "mv-debug-source", "mv-debug-target"])).toMatchObject({ code: 0, stdout: "renamed 'mv-debug-source' -> 'mv-debug-target'\n" });
  expect(await readFile(join(dir, "mv-debug-target"), "utf8")).toBe("debug");
  await writeFile(join(dir, "mv-strip-source"), "strip");
  expect(await run(["mv", "--strip-trailing-slashes", "--no-copy", "mv-strip-source", "mv-strip-target"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "mv-strip-target"), "utf8")).toBe("strip");
  await writeFile(join(dir, "mv-backup-no-clobber-src"), "new");
  await writeFile(join(dir, "mv-backup-no-clobber-dst"), "old");
  expect(await run(["cp", "-bn", "moved", "mv-backup-no-clobber-dst"])).toMatchObject({
    code: 1,
    stderr: "cp: --backup is mutually exclusive with -n or --update=none-fail\nTry 'cp --help' for more information.\n",
  });
  expect(await run(["cp", "--backup", "--update=none", "moved", "mv-backup-no-clobber-dst"])).toMatchObject({
    code: 1,
    stderr: "cp: --backup is mutually exclusive with -n or --update=none-fail\nTry 'cp --help' for more information.\n",
  });
  expect(await run(["mv", "-bn", "mv-backup-no-clobber-src", "mv-backup-no-clobber-dst"])).toMatchObject({
    code: 1,
    stderr: "mv: cannot combine --backup with --exchange, -n, or --update=none-fail\nTry 'mv --help' for more information.\n",
  });
  expect(await run(["mv", "--backup", "--exchange", "mv-backup-no-clobber-src", "mv-backup-no-clobber-dst"])).toMatchObject({
    code: 1,
    stderr: "mv: cannot combine --backup with --exchange, -n, or --update=none-fail\nTry 'mv --help' for more information.\n",
  });
  expect(await run(["cp", "moved", "no-such/"])).toMatchObject({ code: 1, stderr: "cp: cannot create regular file 'no-such/': Not a directory\n" });
  await writeFile(join(dir, "update-old"), "old");
  await run(["touch", "-d", "yesterday", "update-old"]);
  await writeFile(join(dir, "update-new"), "new");
  expect(await run(["cp", "--update=none", "update-new", "update-old"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "update-old"), "utf8")).toBe("old");
  expect(await run(["cp", "--update=none-fail", "update-new", "update-old"])).toMatchObject({ code: 1, stderr: "cp: not replacing 'update-old'\n" });
  expect(await run(["cp", "--update=all", "update-new", "update-old"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "update-old"), "utf8")).toBe("new");
  await writeFile(join(dir, "update-ns-src"), "ns-new");
  await writeFile(join(dir, "update-ns-dst"), "ns-old");
  await systemRun(["/usr/bin/touch", "-d", "2026-01-02 03:04:05.123456789 +0000", "update-ns-src"]);
  await systemRun(["/usr/bin/touch", "-d", "2026-01-02 03:04:05.123456788 +0000", "update-ns-dst"]);
  expect(await run(["cp", "-u", "update-ns-src", "update-ns-dst"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "update-ns-dst"), "utf8")).toBe("ns-new");
  await writeFile(join(dir, "mv-update-old"), "old");
  await run(["touch", "-d", "yesterday", "mv-update-old"]);
  await writeFile(join(dir, "mv-update-new"), "new");
  expect(await run(["mv", "-u", "mv-update-old", "mv-update-new"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "mv-update-new"), "utf8")).toBe("new");
  expect(await readFile(join(dir, "mv-update-old"), "utf8")).toBe("old");
  expect(await run(["mv", "--update=none-fail", "mv-update-new", "mv-update-old"])).toMatchObject({ code: 1, stderr: "mv: not replacing 'mv-update-old'\n" });
  expect(await readFile(join(dir, "mv-update-new"), "utf8")).toBe("new");
  await writeFile(join(dir, "mv-update-ns-src"), "mv-ns-new");
  await writeFile(join(dir, "mv-update-ns-dst"), "mv-ns-old");
  await systemRun(["/usr/bin/touch", "-d", "2026-01-02 03:04:05.123456789 +0000", "mv-update-ns-src"]);
  await systemRun(["/usr/bin/touch", "-d", "2026-01-02 03:04:05.123456788 +0000", "mv-update-ns-dst"]);
  expect(await run(["mv", "-u", "mv-update-ns-src", "mv-update-ns-dst"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "mv-update-ns-dst"), "utf8")).toBe("mv-ns-new");
  await expect(stat(join(dir, "mv-update-ns-src"))).rejects.toThrow();
  await writeFile(join(dir, "mv-if-src"), "if");
  await writeFile(join(dir, "mv-if-dst"), "old");
  await run(["chmod", "0", "mv-if-dst"]);
  expect(await run(["mv", "-if", "mv-if-src", "mv-if-dst"])).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(join(dir, "mv-if-dst"), "utf8")).toBe("if");
  await writeFile(join(dir, "mv-fi-src"), "fi");
  await writeFile(join(dir, "mv-fi-dst"), "old");
  await run(["chmod", "0", "mv-fi-dst"]);
  expect(await run(["mv", "-fi", "mv-fi-src", "mv-fi-dst"], "y\n")).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "mv-fi-dst"), "utf8")).toBe("fi");
  await writeFile(join(dir, "mv-protected-src"), "new");
  await writeFile(join(dir, "mv-protected-dst"), "old");
  await run(["chmod", "0", "mv-protected-dst"]);
  expect(await shell(`
    printf 'n\n' | script -qefc '"$BUN" "$BNU" mv mv-protected-src mv-protected-dst' /dev/null >mv-protected-transcript 2>&1
    test $? -eq 1
    grep -F "mv: replace 'mv-protected-dst', overriding mode 0000 (---------)?" mv-protected-transcript >/dev/null
    test -f mv-protected-src
  `)).toMatchObject({ code: 0 });
  await run(["chmod", "600", "mv-protected-dst"]);
  expect(await readFile(join(dir, "mv-protected-dst"), "utf8")).toBe("old");
  await writeFile(join(dir, "cp-file-over-dir"), "file");
  await mkdir(join(dir, "cp-dir-target"));
  expect(await run(["cp", "-T", "cp-file-over-dir", "cp-dir-target"])).toMatchObject({ code: 1, stderr: "cp: cannot overwrite directory 'cp-dir-target' with non-directory 'cp-file-over-dir'\n" });
  await mkdir(join(dir, "cp-dir-over-file"));
  await writeFile(join(dir, "cp-file-target"), "file");
  expect(await run(["cp", "-R", "cp-dir-over-file", "cp-file-target"])).toMatchObject({ code: 1, stderr: "cp: cannot overwrite non-directory 'cp-file-target' with directory 'cp-dir-over-file'\n" });
  await writeFile(join(dir, "mv-file-over-dir"), "file");
  await mkdir(join(dir, "mv-dir-target/mv-file-over-dir"), { recursive: true });
  expect(await run(["mv", "mv-file-over-dir", "mv-dir-target"])).toMatchObject({ code: 1, stderr: "mv: cannot overwrite directory 'mv-dir-target/mv-file-over-dir' with non-directory 'mv-file-over-dir'\n" });
  await mkdir(join(dir, "mv-dir-over-file"));
  await writeFile(join(dir, "mv-file-target"), "file");
  expect(await run(["mv", "mv-dir-over-file", "mv-file-target"])).toMatchObject({ code: 1, stderr: "mv: cannot overwrite non-directory 'mv-file-target' with directory 'mv-dir-over-file'\n" });
  await mkdir(join(dir, "mv-nonempty-target/t"), { recursive: true });
  await mkdir(join(dir, "mv-nonempty-src/t"), { recursive: true });
  await writeFile(join(dir, "mv-nonempty-target/t/file"), "x");
  expect(await run(["mv", "mv-nonempty-src/t", "mv-nonempty-target"])).toMatchObject({ code: 1, stderr: "mv: cannot overwrite 'mv-nonempty-target/t': Directory not empty\n" });
  let remoteDir;
  try {
    remoteDir = await mkdtemp("/dev/shm/bnu-test-");
    if ((await stat(dir)).dev !== (await stat(remoteDir)).dev) {
      await writeFile(join(dir, "mv-cross-device"), "local");
      await writeFile(join(remoteDir, "remote-file"), "remote");
      await symlink(join(remoteDir, "remote-file"), join(remoteDir, "remote-link"));
      expect(await run(["mv", "mv-cross-device", join(remoteDir, "remote-link")])).toMatchObject({ code: 0 });
      await expect(lstat(join(dir, "mv-cross-device"))).rejects.toThrow();
      expect(await readFile(join(remoteDir, "remote-file"), "utf8")).toBe("remote");
      expect(await readFile(join(remoteDir, "remote-link"), "utf8")).toBe("local");
      expect((await lstat(join(remoteDir, "remote-link"))).isSymbolicLink()).toBe(false);
      expect(await run(["mkfifo", "mv-cross-fifo"])).toMatchObject({ code: 0 });
      expect(await run(["mv", "-v", "mv-cross-fifo", remoteDir])).toMatchObject({ code: 0, stdout: `'mv-cross-fifo' -> '${join(remoteDir, "mv-cross-fifo")}'\n` });
      expect((await lstat(join(remoteDir, "mv-cross-fifo"))).isFIFO()).toBe(true);
      await writeFile(join(remoteDir, "remote-same-file"), "same");
      await symlink(join(remoteDir, "remote-same-file"), join(dir, "remote-same-link"));
      expect(await run(["mv", join(remoteDir, "remote-same-file"), "remote-same-link"])).toMatchObject({ code: 0 });
      expect(await readFile(join(dir, "remote-same-link"), "utf8")).toBe("same");
      expect((await lstat(join(dir, "remote-same-link"))).isSymbolicLink()).toBe(false);
      await mkdir(join(dir, "mv-cross-dir"));
      await writeFile(join(dir, "mv-cross-dir/local"), "local");
      await mkdir(join(remoteDir, "mv-cross-dir"));
      await writeFile(join(remoteDir, "mv-cross-dir/remote"), "remote");
      expect(await run(["mv", "mv-cross-dir", remoteDir])).toMatchObject({ code: 1 });
      expect(await readFile(join(remoteDir, "mv-cross-dir/remote"), "utf8")).toBe("remote");
      expect(await readFile(join(dir, "mv-cross-dir/local"), "utf8")).toBe("local");
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "EACCES") throw error;
  } finally {
    if (remoteDir) await rm(remoteDir, { recursive: true, force: true });
  }
  await mkdir(join(dir, "dup-dest"));
  await writeFile(join(dir, "dup-source"), "dup");
  expect(await run(["cp", "dup-source", "dup-source", "dup-dest"])).toMatchObject({ code: 0, stderr: "cp: warning: source file 'dup-source' specified more than once\n" });
  expect(await readFile(join(dir, "dup-dest/dup-source"), "utf8")).toBe("dup");
  await mkdir(join(dir, "mv-dup-dest"));
  await writeFile(join(dir, "mv-dup-source"), "dup");
  expect(await run(["mv", "mv-dup-source", "mv-dup-source", "mv-dup-dest"])).toMatchObject({ code: 1, stderr: "mv: cannot stat 'mv-dup-source': No such file or directory\n" });
  await expect(stat(join(dir, "mv-dup-source"))).rejects.toThrow();
  expect(await readFile(join(dir, "mv-dup-dest/mv-dup-source"), "utf8")).toBe("dup");
  expect(await run(["rm", "--preserve-root", "mv-debug-target"])).toMatchObject({ code: 0 });
  expect(await run(["rm", "-r", "a", "moved", "moved-hard", "mv-same", "mv-same-link", "mv-backup-hard-link", "mv-backup-hard-link~", "sym", "strip-slash-copy", "one-file-system-src", "one-file-system-copy", "reflink-auto-copy", "reflink-sparse-copy", "reflink-never-copy", "sparse-source", "sparse-dest", "sparse-debug-extents", "sparse-zero-source", "sparse-debug-zero", "sparse-dense", "sparse-preserved", "sparse-pipe", "sparse-pipe-copy", "preserve-link-a", "preserve-link-b", "preserve-link-dest", "cp-interactive-src", "cp-interactive-dst", "cp-mode-zero-src", "cp-mode-zero-dst", "cp-no-access", "cp-no-access-link", "cp-no-access-src", "cp-partial-src", "cp-partial-dst", "abuse-a", "abuse-b", "abuse-c", "abuse-target", "archive-link-file", "archive-link", "archive-link-copy", "backup-target", "backup-target~", "mv-backup-target", "mv-backup-target.~1~", "mv-strip-target", "mv-if-dst", "mv-fi-dst", "mv-protected-src", "mv-protected-dst", "mv-protected-transcript", "mv-file-over-dir", "mv-dir-target", "mv-dir-over-file", "mv-file-target", "dup-dest", "mv-dup-dest", "update-old", "update-new", "mv-update-old", "mv-update-new", "--", "-dash-source", "-dash-hard"])).toMatchObject({ code: 0 });
});

test("mkdir and rmdir support verbose, parent, and non-empty modes", async () => {
  expect(await run(["mkdir"])).toMatchObject({ code: 1, stderr: "mkdir: missing operand\nTry 'mkdir --help' for more information.\n" });
  expect(await run(["rmdir"])).toMatchObject({ code: 1, stderr: "rmdir: missing operand\nTry 'rmdir --help' for more information.\n" });
  expect(await run(["rm"])).toMatchObject({ code: 1, stderr: "rm: missing operand\nTry 'rm --help' for more information.\n" });
  const mkdirHelp = (await run(["mkdir", "--h"])).stdout;
  expect(mkdirHelp).toContain("Usage: mkdir [OPTION]... DIRECTORY...\n");
  expect(mkdirHelp).toContain("-m, --mode=MODE   set file mode (as in chmod), not a=rwx - umask\n");
  expect(mkdirHelp).toContain("                   with their file modes unaffected by any -m option\n");
  expect(mkdirHelp).toContain("--context[=CTX]   like -Z, or if CTX is specified then set the\n");
  expect(await run(["mkdir", "--p", "mkdir-prefix/child"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "mkdir-prefix/child"))).resolves.toBeTruthy();
  expect(await run(["mkdir", "mkdir-prefix"])).toMatchObject(await systemRun(["/usr/bin/mkdir", "mkdir-prefix"]));
  await writeFile(join(dir, "mkdir-file-parent"), "x");
  expect(await run(["mkdir", "-p", "mkdir-file-parent/child"])).toMatchObject(await systemRun(["/usr/bin/mkdir", "-p", "mkdir-file-parent/child"]));
  expect(await run(["mkdir", "--m=700", "mkdir-mode-inline"])).toMatchObject({ code: 0 });
  expect(((await stat(join(dir, "mkdir-mode-inline"))).mode & 0o777)).toBe(0o700);
  expect(await run(["mkdir", "--mo", "755", "mkdir-mode-next"])).toMatchObject({ code: 0 });
  expect(((await stat(join(dir, "mkdir-mode-next"))).mode & 0o777)).toBe(0o755);
  expect(await run(["mkdir", "--verb", "mkdir-verbose"])).toMatchObject({ code: 0, stdout: "mkdir: created directory 'mkdir-verbose'\n" });
  expect(await run(["mkdir", "-v", "mkdir-verbose\nnewline"])).toMatchObject({ code: 0, stdout: "mkdir: created directory 'mkdir-verbose'$'\\n''newline'\n" });
  expect(await run(["mkdir", "-v", "mkdir-verbose'quote"])).toMatchObject({ code: 0, stdout: "mkdir: created directory \"mkdir-verbose'quote\"\n" });
  expect(await run(["mkdir", "--v"])).toMatchObject({ code: 1, stderr: "mkdir: option '--v' is ambiguous; possibilities: '--verbose' '--version'\nTry 'mkdir --help' for more information.\n" });
  expect(await run(["mkdir", "--m"])).toMatchObject({ code: 1, stderr: "mkdir: option '--mode' requires an argument\nTry 'mkdir --help' for more information.\n" });
  expect(await run(["mkdir", "--m", "--h"])).toMatchObject({ code: 1, stderr: "mkdir: missing operand\nTry 'mkdir --help' for more information.\n" });
  expect(await run(["mkdir", "--m", "--h", "mkdir-bad-mode"])).toMatchObject(await systemRun(["/usr/bin/mkdir", "--m", "--h", "mkdir-bad-mode"]));
  expect(await run(["mkdir", "--p=1", "mkdir-bad-parent"])).toMatchObject({ code: 1, stderr: "mkdir: option '--parents' doesn't allow an argument\nTry 'mkdir --help' for more information.\n" });
  expect(await run(["mkdir", "-p", ""])).toMatchObject(await systemRun(["/usr/bin/mkdir", "-p", ""]));
  expect(await run(["mkdir", "-v", "-p", "parents/child"])).toMatchObject({ code: 0, stdout: "mkdir: created directory 'parents'\nmkdir: created directory 'parents/child'\n" });
  expect(await run(["mkdir", "-pv", "parents\nnewline/child'quote"])).toMatchObject({
    code: 0,
    stdout: `mkdir: created directory 'parents'$'\\n''newline'\nmkdir: created directory 'parents'$'\\n''newline/child'\\''quote'\n`,
  });
  expect(await run(["mkdir", "mkdir-verbose\nnewline"])).toMatchObject({ code: 1, stdout: "", stderr: `mkdir: cannot create directory ${diagnosticQuote("mkdir-verbose\\nnewline")}: File exists\n` });
  expect(await run(["mkdir", "mkdir-verbose'quote"])).toMatchObject({ code: 1, stdout: "", stderr: `mkdir: cannot create directory ${diagnosticQuote("mkdir-verbose'quote")}: File exists\n` });
  await writeFile(join(dir, "mkdir-parent\nfile"), "x");
  expect(await run(["mkdir", "-p", "mkdir-parent\nfile/child"])).toMatchObject({ code: 1, stdout: "", stderr: `mkdir: cannot create directory ${diagnosticQuote("mkdir-parent\\nfile")}: Not a directory\n` });
  await writeFile(join(dir, "mkdir-parent'file"), "x");
  expect(await run(["mkdir", "-p", "mkdir-parent'file/child"])).toMatchObject({ code: 1, stdout: "", stderr: `mkdir: cannot create directory ${diagnosticQuote("mkdir-parent'file")}: Not a directory\n` });
  expect(await run(["rmdir", "-p", "parents/child"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "parents"))).rejects.toThrow();
  await mkdir(join(dir, "parents2/child"), { recursive: true });
  expect(await run(["rmdir", "--pa", "parents2/child"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "parents2"))).rejects.toThrow();
  await mkdir(join(dir, "parents3/child"), { recursive: true });
  expect(await run(["rmdir", "--par", "parents3/child"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "parents3"))).rejects.toThrow();
  await mkdir(join(dir, "rmdir-verbose"));
  expect(await run(["rmdir", "-v", "rmdir-verbose"])).toMatchObject({ code: 0, stdout: "rmdir: removing directory, 'rmdir-verbose'\n" });
  await mkdir(join(dir, "rmdir-verbose-parent/child"), { recursive: true });
  expect(await run(["rmdir", "-vp", "rmdir-verbose-parent/child"])).toMatchObject({ code: 0, stdout: "rmdir: removing directory, 'rmdir-verbose-parent/child'\nrmdir: removing directory, 'rmdir-verbose-parent'\n" });
  await mkdir(join(dir, "rmdir-verbose\nparent/child'leaf"), { recursive: true });
  expect(await run(["rmdir", "-pv", "rmdir-verbose\nparent/child'leaf"])).toMatchObject({
    code: 0,
    stdout: `rmdir: removing directory, 'rmdir-verbose'$'\\n''parent/child'\\''leaf'\nrmdir: removing directory, 'rmdir-verbose'$'\\n''parent'\n`,
    stderr: "",
  });
  expect(await run(["rmdir", "missing\nrmdir"])).toMatchObject({ code: 1, stdout: "", stderr: "rmdir: failed to remove 'missing'$'\\n''rmdir': No such file or directory\n" });
  expect(await run(["rmdir", "missing'rmdir"])).toMatchObject({ code: 1, stdout: "", stderr: "rmdir: failed to remove \"missing'rmdir\": No such file or directory\n" });
  await writeFile(join(dir, "rmdir-file\nplain"), "x");
  expect(await run(["rmdir", "rmdir-file\nplain"])).toMatchObject({ code: 1, stdout: "", stderr: "rmdir: failed to remove 'rmdir-file'$'\\n''plain': Not a directory\n" });
  await writeFile(join(dir, "rmdir-file'plain"), "x");
  expect(await run(["rmdir", "rmdir-file'plain"])).toMatchObject({ code: 1, stdout: "", stderr: "rmdir: failed to remove \"rmdir-file'plain\": Not a directory\n" });
  expect(await run(["rmdir", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: rmdir [OPTION]... DIRECTORY...\n") });
  expect(await run(["rmdir", "--v"])).toMatchObject({ code: 1, stderr: "rmdir: option '--v' is ambiguous; possibilities: '--verbose' '--version'\nTry 'rmdir --help' for more information.\n" });
  expect(await run(["rmdir", "--pa=1", "parents3"])).toMatchObject({ code: 1, stderr: "rmdir: option '--path' doesn't allow an argument\nTry 'rmdir --help' for more information.\n" });
  expect(await run(["rmdir", "--par=1", "parents3"])).toMatchObject({ code: 1, stderr: "rmdir: option '--parents' doesn't allow an argument\nTry 'rmdir --help' for more information.\n" });
  expect(await run(["rmdir", "-x", "--help"])).toMatchObject({ code: 1, stderr: "rmdir: invalid option -- 'x'\nTry 'rmdir --help' for more information.\n" });
  await mkdir(join(dir, "rmdir-posix-parent/child"), { recursive: true });
  expect(await run(["rmdir", "rmdir-posix-parent/child", "-p"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 1, stderr: "rmdir: failed to remove '-p': No such file or directory\n" });
  await expect(stat(join(dir, "rmdir-posix-parent/child"))).rejects.toThrow();
  await expect(stat(join(dir, "rmdir-posix-parent"))).resolves.toBeTruthy();
  await mkdir(join(dir, "rmdir-posix-help/child"), { recursive: true });
  expect(await run(["rmdir", "rmdir-posix-help/child", "--help"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 1, stderr: "rmdir: failed to remove '--help': No such file or directory\n" });
  await expect(stat(join(dir, "rmdir-posix-help/child"))).rejects.toThrow();
  await expect(stat(join(dir, "rmdir-posix-help"))).resolves.toBeTruthy();
  await mkdir(join(dir, "nonempty"));
  await writeFile(join(dir, "nonempty/file"), "x");
  expect(await run(["rmdir", "--ignore-fail-on-non-empty", "nonempty"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "nonempty"))).isDirectory()).toBe(true);
  await writeFile(join(dir, "remove-me"), "x");
  expect(await run(["rm", "-v", "remove-me"])).toMatchObject({ code: 0, stdout: "removed 'remove-me'\n" });
  await writeFile(join(dir, "remove\nme"), "x");
  expect(await run(["rm", "-v", "remove\nme"])).toMatchObject({ code: 0, stdout: "removed 'remove'$'\\n''me'\n" });
  await writeFile(join(dir, "remove'me"), "x");
  expect(await run(["rm", "-v", "remove'me"])).toMatchObject({ code: 0, stdout: "removed \"remove'me\"\n" });
  expect(await run(["rm", "missing\nremove"])).toMatchObject({ code: 1, stdout: "", stderr: "rm: cannot remove 'missing'$'\\n''remove': No such file or directory\n" });
  expect(await run(["rm", "missing'remove"])).toMatchObject({ code: 1, stdout: "", stderr: "rm: cannot remove \"missing'remove\": No such file or directory\n" });
  await mkdir(join(dir, "remove-dir\nplain"));
  expect(await run(["rm", "remove-dir\nplain"])).toMatchObject({ code: 1, stdout: "", stderr: "rm: cannot remove 'remove-dir'$'\\n''plain': Is a directory\n" });
  await mkdir(join(dir, "remove-dir'plain"));
  expect(await run(["rm", "remove-dir'plain"])).toMatchObject({ code: 1, stdout: "", stderr: "rm: cannot remove \"remove-dir'plain\": Is a directory\n" });
  await mkdir(join(dir, "remove-tree\nplain"));
  await writeFile(join(dir, "remove-tree\nplain/file'plain"), "x");
  expect(await run(["rm", "-rv", "remove-tree\nplain"])).toMatchObject({
    code: 0,
    stdout: `removed 'remove-tree'$'\\n''plain/file'\\''plain'\nremoved directory 'remove-tree'$'\\n''plain'\n`,
    stderr: "",
  });
  await mkdir(join(dir, "rm-malloc-perturb/a/b"), { recursive: true });
  await writeFile(join(dir, "rm-malloc-perturb/a/file"), "x");
  expect(await run(["rm", "-rf", "rm-malloc-perturb"], "", { env: { MALLOC_PERTURB_: "87" } })).toMatchObject({ code: 0, stdout: "", stderr: "" });
  await expect(stat(join(dir, "rm-malloc-perturb"))).rejects.toThrow();
  expect(await run(["rm", "."])).toMatchObject(await systemRun(["/usr/bin/rm", "."]));
  expect(await run(["rm", "-r", "."])).toMatchObject(await systemRun(["/usr/bin/rm", "-r", "."]));
  await mkdir(join(dir, "empty-dir"));
  expect(await run(["rm", "-d", "empty-dir"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "empty-dir"))).rejects.toThrow();
  await mkdir(join(dir, "rm-recursive-prefix/sub"), { recursive: true });
  await writeFile(join(dir, "rm-recursive-prefix/sub/file"), "x");
  expect(await run(["rm", "--r", "rm-recursive-prefix"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "rm-recursive-prefix"))).rejects.toThrow();
  await writeFile(join(dir, "interactive-remove"), "x");
  expect(await run(["rm", "-I", "interactive-remove"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "interactive-remove"))).rejects.toThrow();
  await writeFile(join(dir, "never-remove"), "x");
  expect(await run(["rm", "--interactive=never", "never-remove"])).toMatchObject({ code: 0 });
  await writeFile(join(dir, "never-remove-prefix"), "x");
  expect(await run(["rm", "--inter=never", "never-remove-prefix"])).toMatchObject({ code: 0 });
  await writeFile(join(dir, "-foo"), "x");
  expect(await run(["rm", "-foo"])).toMatchObject({
    code: 1,
    stderr: "rm: invalid option -- 'o'\nTry 'rm ./-foo' to remove the file '-foo'.\nTry 'rm --help' for more information.\n",
  });
  await writeFile(join(dir, "-foo\nbar"), "x");
  expect(await run(["rm", "-foo\nbar"])).toMatchObject({
    code: 1,
    stderr: "rm: invalid option -- 'o'\nTry 'rm ./'-foo'$'\\n''bar'' to remove the file '-foo'$'\\n''bar'.\nTry 'rm --help' for more information.\n",
  });
  expect(await run(["rm", "--bad", "--help"])).toMatchObject({ code: 1, stderr: "rm: unrecognized option '--bad'\nTry 'rm --help' for more information.\n" });
  expect(await run(["rm", "--no-preserve", "/"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "rm: you may not abbreviate the --no-preserve-root option\n",
  });
  expect(await run(["rm", "--no-preserve", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "rm: you may not abbreviate the --no-preserve-root option\n",
  });
  const rmHelp = await run(["rm", "--help"]);
  expect(rmHelp.code).toBe(0);
  expect(rmHelp.stdout).toContain("Remove (unlink) the FILE(s).\n");
  expect(rmHelp.stdout).toContain("  -I\n");
  expect(rmHelp.stdout).toContain("  -R\n");
  expect(rmHelp.stdout).toContain("  -i\n");
  await writeFile(join(dir, "rm-meta"), "x");
  expect(await run(["rm", "rm-meta", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: rm [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await readFile(join(dir, "rm-meta"), "utf8")).toBe("x");
  expect(await run(["rm", "--force=bad", "--help"])).toMatchObject({ code: 1, stderr: "rm: option '--force' doesn't allow an argument\nTry 'rm --help' for more information.\n" });
  expect(await run(["rm", "--interactive=", "never-remove"])).toMatchObject({
    code: 1,
    stderr: `rm: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--interactive")}\nValid arguments are:\n  - ${diagnosticQuote("never")}, ${diagnosticQuote("no")}, ${diagnosticQuote("none")}\n  - ${diagnosticQuote("once")}\n  - ${diagnosticQuote("always")}, ${diagnosticQuote("yes")}\nTry 'rm --help' for more information.\n`,
  });
  expect(await run(["rm", "--interactive=maybe", "never-remove"])).toMatchObject(await systemRun(["rm", "--interactive=maybe", "never-remove"]));
  expect(await run(["rm", "--interactive=bad\nmode", "never-remove"])).toMatchObject({
    code: 1,
    stderr: `rm: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--interactive")}\nValid arguments are:\n  - ${diagnosticQuote("never")}, ${diagnosticQuote("no")}, ${diagnosticQuote("none")}\n  - ${diagnosticQuote("once")}\n  - ${diagnosticQuote("always")}, ${diagnosticQuote("yes")}\nTry 'rm --help' for more information.\n`,
  });
  expect(await run(["rm", "--pres=bad", "--help"])).toMatchObject({ code: 1, stderr: "rm: unrecognized --preserve-root argument: 'bad'\n" });
  expect(await run(["rm", "--one=bad", "--help"])).toMatchObject({ code: 1, stderr: "rm: option '--one-file-system' doesn't allow an argument\nTry 'rm --help' for more information.\n" });
  await mkdir(join(dir, "rm-one-file-system/sub"), { recursive: true });
  await writeFile(join(dir, "rm-one-file-system/sub/file"), "x");
  expect(await run(["rm", "--one-file-system", "-rf", "rm-one-file-system"])).toMatchObject({ code: 0, stderr: "" });
  await expect(stat(join(dir, "rm-one-file-system"))).rejects.toThrow();
  await mkdir(join(dir, "rm-preserve-root-all/sub"), { recursive: true });
  await writeFile(join(dir, "rm-preserve-root-all/sub/file"), "x");
  expect(await run(["rm", "--preserve-root=all", "-rf", "rm-preserve-root-all"])).toMatchObject({ code: 0, stderr: "" });
  await expect(stat(join(dir, "rm-preserve-root-all"))).rejects.toThrow();
  expect(await run(["rm", "--preserve-root=bogus", "-rf", "missing"])).toMatchObject({ code: 1, stderr: "rm: unrecognized --preserve-root argument: 'bogus'\n" });
  expect(await shell(`
    set -e
    mkdir deep
    perl -e 'my $d = "x" x 200; chdir "deep" or die $!; foreach my $i (1..24) { mkdir($d, 0700) && chdir $d or die $! }'
    printf n > no
    "$BUN" "$BNU" rm ---presume-input-tty -r deep < no
    test ! -d deep
  `)).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["mkdir", "-m", "u=rwx,go=", "private-dir"])).toMatchObject({ code: 0 });
  expect(((await stat(join(dir, "private-dir"))).mode & 0o777)).toBe(0o700);
  expect(await run(["mkdir", "-m", "755", "public-dir"])).toMatchObject({ code: 0 });
  expect(((await stat(join(dir, "public-dir"))).mode & 0o777)).toBe(0o755);
  expect(await run(["mkdir", "-Z", "context-dir"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "context-dir"))).isDirectory()).toBe(true);
  expect(await run(["mkdir", "--context=system_u:object_r:tmp_t:s0"])).toMatchObject({
    code: 1,
    stderr: "mkdir: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\nmkdir: missing operand\nTry 'mkdir --help' for more information.\n",
  });
  expect(await run(["mkdir", "--context=system_u:object_r:tmp_t:s0", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: mkdir [OPTION]... DIRECTORY...\n"), stderr: "mkdir: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\n" });
  expect(await run(["mkdir", "--context=system_u:object_r:tmp_t:s0", "context-dir-2"])).toMatchObject({ code: 0, stderr: "mkdir: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\n" });
  expect((await stat(join(dir, "context-dir-2"))).isDirectory()).toBe(true);
});

test("cp, mv and ln support GNU target directory forms", async () => {
  await mkdir(join(dir, "target"));
  await writeFile(join(dir, "one"), "1");
  await writeFile(join(dir, "two"), "2");
  expect(await run(["cp"])).toMatchObject({
    code: 1,
    stderr: "cp: missing file operand\nTry 'cp --help' for more information.\n",
  });
  expect(await run(["cp", "missing-source", "target/missing-copy"])).toMatchObject(await systemRun(["/usr/bin/cp", "missing-source", "target/missing-copy"]));
  expect(await run(["cp", "-T", "one", "two", "target"])).toMatchObject({
    code: 1,
    stderr: "cp: extra operand 'target'\nTry 'cp --help' for more information.\n",
  });
  expect(await run(["cp", "one", "two", "missing-target"])).toMatchObject({
    code: 1,
    stderr: "cp: target 'missing-target': No such file or directory\n",
  });
  expect(await run(["cp", "-t", "missing-target", "one"])).toMatchObject({
    code: 1,
    stderr: "cp: target directory 'missing-target': No such file or directory\n",
  });
  expect(await run(["cp", "--parents", "one", "two"])).toMatchObject({
    code: 1,
    stderr: "cp: with --parents, the destination must be a directory\nTry 'cp --help' for more information.\n",
  });
  await writeFile(join(dir, "backup-dst"), "old");
  await writeFile(join(dir, "backup-empty-dst"), "old");
  expect(await run(["cp", "--backup=", "one", "backup-empty-dst"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "backup-empty-dst"), "utf8")).toBe("1");
  expect(await readFile(join(dir, "backup-empty-dst~"), "utf8")).toBe("old");
  await writeFile(join(dir, "mv-backup-empty-src"), "new");
  await writeFile(join(dir, "mv-backup-empty-dst"), "old");
  expect(await run(["mv", "--backup=", "mv-backup-empty-src", "mv-backup-empty-dst"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "mv-backup-empty-dst"), "utf8")).toBe("new");
  expect(await readFile(join(dir, "mv-backup-empty-dst~"), "utf8")).toBe("old");
  await writeFile(join(dir, "backup-empty-env-dst"), "old");
  expect(await run(["cp", "--backup=", "one", "backup-empty-env-dst"], "", { env: { VERSION_CONTROL: "bad\nmode" } })).toMatchObject({
    code: 1,
    stderr: `cp: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("$VERSION_CONTROL")}\nValid arguments are:\n  - ${diagnosticQuote("none")}, ${diagnosticQuote("off")}\n  - ${diagnosticQuote("simple")}, ${diagnosticQuote("never")}\n  - ${diagnosticQuote("existing")}, ${diagnosticQuote("nil")}\n  - ${diagnosticQuote("numbered")}, ${diagnosticQuote("t")}\nTry 'cp --help' for more information.\n`,
  });
  expect(await run(["cp", "--backup=bad", "one", "backup-dst"])).toMatchObject(await systemRun(["cp", "--backup=bad", "one", "backup-dst"]));
  expect(await run(["cp", "--backup=bad\nmode", "one", "backup-dst"])).toMatchObject({
    code: 1,
    stderr: `cp: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("backup type")}\nValid arguments are:\n  - ${diagnosticQuote("none")}, ${diagnosticQuote("off")}\n  - ${diagnosticQuote("simple")}, ${diagnosticQuote("never")}\n  - ${diagnosticQuote("existing")}, ${diagnosticQuote("nil")}\n  - ${diagnosticQuote("numbered")}, ${diagnosticQuote("t")}\nTry 'cp --help' for more information.\n`,
  });
  expect(await readFile(join(dir, "backup-dst"), "utf8")).toBe("old");
  await expect(stat(join(dir, "backup-dst~"))).rejects.toThrow();
  expect(await run(["cp", "--backup", "one", "backup-dst"], "", { env: { VERSION_CONTROL: "bad" } })).toMatchObject(await systemRun(["cp", "--backup", "one", "backup-dst"], "", { env: { VERSION_CONTROL: "bad" } }));
  expect(await run(["cp", "--backup", "one", "backup-dst"], "", { env: { VERSION_CONTROL: "bad\nmode" } })).toMatchObject({
    code: 1,
    stderr: `cp: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("$VERSION_CONTROL")}\nValid arguments are:\n  - ${diagnosticQuote("none")}, ${diagnosticQuote("off")}\n  - ${diagnosticQuote("simple")}, ${diagnosticQuote("never")}\n  - ${diagnosticQuote("existing")}, ${diagnosticQuote("nil")}\n  - ${diagnosticQuote("numbered")}, ${diagnosticQuote("t")}\nTry 'cp --help' for more information.\n`,
  });
  expect(await readFile(join(dir, "backup-dst"), "utf8")).toBe("old");
  await expect(stat(join(dir, "backup-dst~"))).rejects.toThrow();
  expect(await run(["cp", "-t", "target", "one", "two"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "target/one"), "utf8")).toBe("1");
  expect(await readFile(join(dir, "target/two"), "utf8")).toBe("2");
  expect(await run(["cp", "-T", "one", "target/flat"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "target/flat"), "utf8")).toBe("1");
  expect(await run(["mv", "-t", "target", "one"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "target/one"), "utf8")).toBe("1");
  await writeFile(join(dir, "move-src"), "m");
  expect(await run(["mv", "-T", "move-src", "target/moved"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "target/moved"), "utf8")).toBe("m");
  await writeFile(join(dir, "move-target-alias"), "a");
  expect(await run(["mv", "--target=target", "move-target-alias"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "target/move-target-alias"), "utf8")).toBe("a");
  await writeFile(join(dir, "move-target-prefix"), "p");
  expect(await run(["mv", "--t", "target", "move-target-prefix"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "target/move-target-prefix"), "utf8")).toBe("p");
  await writeFile(join(dir, "move-missing-target"), "m");
  expect(await run(["mv", "-t", "missing-target", "move-missing-target"])).toMatchObject(await systemRun(["mv", "-t", "missing-target", "move-missing-target"]));
  expect(await run(["mv", "--target=missing-target", "move-missing-target"])).toMatchObject(await systemRun(["mv", "--target=missing-target", "move-missing-target"]));
  await writeFile(join(dir, "move-missing-a"), "a");
  await writeFile(join(dir, "move-missing-b"), "b");
  expect(await run(["mv", "move-missing-a", "move-missing-b", "missing-mv-target"])).toMatchObject({
    code: 1,
    stderr: "mv: target 'missing-mv-target': No such file or directory\n",
  });
  expect(await run(["mv", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: mv [OPTION]... [-T] SOURCE DEST\n  or:  mv [OPTION]... SOURCE... DIRECTORY\n  or:  mv [OPTION]... -t DIRECTORY SOURCE...\n") });
  expect(await run(["mv", "--no", "--help"])).toMatchObject({
    code: 1,
    stderr: "mv: option '--no' is ambiguous; possibilities: '--no-clobber' '--no-copy' '--no-target-directory'\nTry 'mv --help' for more information.\n",
  });
  expect(await run(["mv", "--force=bad", "--help"])).toMatchObject({
    code: 1,
    stderr: "mv: option '--force' doesn't allow an argument\nTry 'mv --help' for more information.\n",
  });
  expect(await run(["mv", "--debug=bad", "--help"])).toMatchObject({
    code: 1,
    stderr: "mv: option '--debug' doesn't allow an argument\nTry 'mv --help' for more information.\n",
  });
  expect(await run(["mv", "--update=", "--help"])).toMatchObject({
    code: 1,
    stderr: `mv: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--update")}\nValid arguments are:\n  - ${diagnosticQuote("all")}\n  - ${diagnosticQuote("none")}\n  - ${diagnosticQuote("none-fail")}\n  - ${diagnosticQuote("older")}\nTry 'mv --help' for more information.\n`,
  });
  expect(await run(["mv", "--update=bad", "--help"])).toMatchObject(await systemRun(["mv", "--update=bad", "--help"]));
  expect(await run(["mv", "--update=bad\nmode", "--help"])).toMatchObject({
    code: 1,
    stderr: `mv: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--update")}\nValid arguments are:\n  - ${diagnosticQuote("all")}\n  - ${diagnosticQuote("none")}\n  - ${diagnosticQuote("none-fail")}\n  - ${diagnosticQuote("older")}\nTry 'mv --help' for more information.\n`,
  });
  expect(await run(["mv", "--suffix", "--help", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["mv", "move-target-prefix", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: mv [OPTION]... [-T] SOURCE DEST\n"), stderr: "" });
  expect(await run(["mv", "--ver=bad", "--help"])).toMatchObject({
    code: 1,
    stderr: "mv: option '--ver=bad' is ambiguous; possibilities: '--verbose' '--version'\nTry 'mv --help' for more information.\n",
  });
  expect(await run(["mv"])).toMatchObject({ code: 1, stderr: "mv: missing file operand\nTry 'mv --help' for more information.\n" });
  await writeFile(join(dir, "exchange-a"), "left");
  await writeFile(join(dir, "exchange-b"), "right");
  expect(await run(["mv", "--exchange", "-vT", "exchange-a", "exchange-b"])).toMatchObject({ code: 0, stdout: "exchanged 'exchange-a' <-> 'exchange-b'\n" });
  expect(await readFile(join(dir, "exchange-a"), "utf8")).toBe("right");
  expect(await readFile(join(dir, "exchange-b"), "utf8")).toBe("left");
  await writeFile(join(dir, "exchange-file"), "file");
  await mkdir(join(dir, "exchange-dir"));
  expect(await run(["mv", "--exchange", "-T", "exchange-file", "exchange-dir"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "exchange-file"))).isDirectory()).toBe(true);
  expect(await readFile(join(dir, "exchange-dir"), "utf8")).toBe("file");
  await mkdir(join(dir, "exchange-target"));
  await writeFile(join(dir, "exchange-multi-a"), "A");
  await writeFile(join(dir, "exchange-multi-b"), "B");
  await writeFile(join(dir, "exchange-target/exchange-multi-a"), "TA");
  await writeFile(join(dir, "exchange-target/exchange-multi-b"), "TB");
  expect(await run(["mv", "--exchange", "-t", "exchange-target", "exchange-multi-a", "exchange-multi-b"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "exchange-multi-a"), "utf8")).toBe("TA");
  expect(await readFile(join(dir, "exchange-multi-b"), "utf8")).toBe("TB");
  expect(await readFile(join(dir, "exchange-target/exchange-multi-a"), "utf8")).toBe("A");
  expect(await readFile(join(dir, "exchange-target/exchange-multi-b"), "utf8")).toBe("B");
  expect(await run(["mv", "--exchange", "-t", "exchange-target", "exchange-missing-a", "exchange-missing-b"])).toMatchObject({
    code: 1,
    stderr: "mv: cannot stat 'exchange-missing-a': No such file or directory\nmv: cannot stat 'exchange-missing-b': No such file or directory\n",
  });
  expect(await run(["mv", "--exchange", "exchange-dir", "exchange-missing"])).toMatchObject({ code: 1 });
  expect(await run(["mv", "--exchange", "exchange-a", "exchange-b", "exchange-missing-target"])).toMatchObject({
    code: 1,
    stderr: "mv: target 'exchange-missing-target': No such file or directory\n",
  });
  expect(await run(["mv", "missing-only"])).toMatchObject({ code: 1, stderr: "mv: missing destination file operand after 'missing-only'\nTry 'mv --help' for more information.\n" });
  await mkdir(join(dir, "replace-dir/sub"), { recursive: true });
  await mkdir(join(dir, "empty-dir-target"));
  expect(await run(["mv", "-fT", "replace-dir", "empty-dir-target"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "empty-dir-target/sub"))).isDirectory()).toBe(true);
  await mkdir(join(dir, "nonempty-src"));
  await mkdir(join(dir, "nonempty-target/sub"), { recursive: true });
  expect(await run(["mv", "-fT", "nonempty-src", "nonempty-target"])).toMatchObject({ code: 1 });
  await writeFile(join(dir, "file-over-dir"), "x");
  await mkdir(join(dir, "dir-target"));
  expect(await run(["mv", "-fT", "file-over-dir", "dir-target"])).toMatchObject({ code: 1 });
  await writeFile(join(dir, "link-src"), "l");
  await writeFile(join(dir, "ln-interactive-dst"), "old");
  expect(await run(["ln", "-i", "link-src", "ln-interactive-dst"], "n\n")).toMatchObject({
    code: 1,
    stderr: "ln: replace 'ln-interactive-dst'? ",
  });
  expect(await readFile(join(dir, "ln-interactive-dst"), "utf8")).toBe("old");
  expect(await run(["ln", "-if", "link-src", "ln-interactive-dst"], "n\n")).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(join(dir, "ln-interactive-dst"), "utf8")).toBe("l");
  expect(await run(["ln", "-s", "-t", "target", "link-src"])).toMatchObject({ code: 0 });
  expect(await run(["readlink", "target/link-src"])).toMatchObject({ code: 0, stdout: "link-src\n" });
  await writeFile(join(dir, "ln-target-prefix-src"), "prefix");
  expect(await run(["ln", "--target", "target", "ln-target-prefix-src"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "target/ln-target-prefix-src"), "utf8")).toBe("prefix");
  await writeFile(join(dir, "ln-target-dir-alias-src"), "alias");
  expect(await run(["ln", "--target-dir=target", "ln-target-dir-alias-src"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "target/ln-target-dir-alias-src"), "utf8")).toBe("alias");
  const lnHelp = await run(["ln", "--help"]);
  expect(lnHelp.stdout).toContain("  -d\n");
  expect(lnHelp).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: ln [OPTION]... [-T] TARGET LINK_NAME\n  or:  ln [OPTION]... TARGET\n  or:  ln [OPTION]... TARGET... DIRECTORY\n  or:  ln [OPTION]... -t DIRECTORY TARGET...\n") });
  expect(await run(["ln", "-d", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: ln [OPTION]... [-T] TARGET LINK_NAME\n") });
  expect(await run(["ln", "--n", "--help"])).toMatchObject({
    code: 1,
    stderr: "ln: option '--n' is ambiguous; possibilities: '--no-dereference' '--no-target-directory'\nTry 'ln --help' for more information.\n",
  });
  expect(await run(["ln", "--s", "--help"])).toMatchObject({
    code: 1,
    stderr: "ln: option '--s' is ambiguous; possibilities: '--suffix' '--symbolic'\nTry 'ln --help' for more information.\n",
  });
  expect(await run(["ln", "--force=bad", "--help"])).toMatchObject({
    code: 1,
    stderr: "ln: option '--force' doesn't allow an argument\nTry 'ln --help' for more information.\n",
  });
  expect(await run(["ln", "--symbolic=bad", "--help"])).toMatchObject({
    code: 1,
    stderr: "ln: option '--symbolic' doesn't allow an argument\nTry 'ln --help' for more information.\n",
  });
  expect(await run(["ln", "--suffix", "--help", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["ln", "--ver=bad", "--help"])).toMatchObject({
    code: 1,
    stderr: "ln: option '--ver=bad' is ambiguous; possibilities: '--verbose' '--version'\nTry 'ln --help' for more information.\n",
  });
  expect(await run(["ln"])).toMatchObject({ code: 1, stderr: "ln: missing file operand\nTry 'ln --help' for more information.\n" });
  expect(await run(["ln", "-t", "missing-ln-target", "link-src"])).toMatchObject({
    code: 1,
    stderr: "ln: failed to access 'missing-ln-target': No such file or directory\n",
  });
  await writeFile(join(dir, "ln-file-target"), "file");
  expect(await run(["ln", "-t", "ln-file-target", "link-src"])).toMatchObject({
    code: 1,
    stderr: "ln: target 'ln-file-target' is not a directory\n",
  });
  expect(await run(["ln", "one", "two", "missing-ln-dir"])).toMatchObject({
    code: 1,
    stderr: "ln: target 'missing-ln-dir': No such file or directory\n",
  });
  expect(await run(["ln", "missing-ln-source", "ln-missing-target"])).toMatchObject({
    code: 1,
    stderr: "ln: failed to access 'missing-ln-source': No such file or directory\n",
  });
  expect(await run(["ln", "missing\nln-source", "ln-missing-newline-target"])).toMatchObject({
    code: 1,
    stderr: "ln: failed to access 'missing'$'\\n''ln-source': No such file or directory\n",
  });
  expect(await run(["ln", "missing'ln-source", "ln-missing-quote-target"])).toMatchObject({
    code: 1,
    stderr: "ln: failed to access \"missing'ln-source\": No such file or directory\n",
  });
  expect(await run(["ln", "-t", "missing\nln-target", "link-src"])).toMatchObject({
    code: 1,
    stderr: "ln: failed to access 'missing'$'\\n''ln-target': No such file or directory\n",
  });
  await mkdir(join(dir, "ln-hard-directory-source"));
  expect(await run(["ln", "ln-hard-directory-source", "ln-hard-directory-target"])).toMatchObject({
    code: 1,
    stderr: "ln: ln-hard-directory-source: hard link not allowed for directory\n",
  });
  await mkdir(join(dir, "ln-hard-directory\nsource"));
  expect(await run(["ln", "ln-hard-directory\nsource", "ln-hard-directory-newline-target"])).toMatchObject({
    code: 1,
    stderr: "ln: 'ln-hard-directory'$'\\n''source': hard link not allowed for directory\n",
  });
  await mkdir(join(dir, "ln-hard-directory'source"));
  expect(await run(["ln", "ln-hard-directory'source", "ln-hard-directory-quote-target"])).toMatchObject({
    code: 1,
    stderr: "ln: \"ln-hard-directory'source\": hard link not allowed for directory\n",
  });
  expect(await run(["ln", "link-src", "link-src"])).toMatchObject({
    code: 1,
    stderr: "ln: failed to create hard link 'link-src': File exists\n",
  });
  expect(await run(["ln", "-s", "link-src"])).toMatchObject(await systemRun(["/usr/bin/ln", "-s", "link-src"]));
  expect(await run(["ln", "-b", "link-src", "link-src"])).toMatchObject({
    code: 1,
    stderr: "ln: 'link-src' and 'link-src' are the same file\n",
  });
  const lnValidBackupModes = `Valid arguments are:\n  - ${diagnosticQuote("none")}, ${diagnosticQuote("off")}\n  - ${diagnosticQuote("simple")}, ${diagnosticQuote("never")}\n  - ${diagnosticQuote("existing")}, ${diagnosticQuote("nil")}\n  - ${diagnosticQuote("numbered")}, ${diagnosticQuote("t")}\n`;
  await writeFile(join(dir, "ln-backup-empty"), "old");
  expect(await run(["ln", "--backup=", "link-src", "ln-backup-empty"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "ln-backup-empty~"), "utf8")).toBe("old");
  await writeFile(join(dir, "ln-backup-empty-env-bad"), "old");
  expect(await run(["ln", "--backup=", "link-src", "ln-backup-empty-env-bad"], "", { env: { VERSION_CONTROL: "bad" } })).toMatchObject({
    code: 1,
    stderr: `ln: invalid argument ${diagnosticQuote("bad")} for ${diagnosticQuote("$VERSION_CONTROL")}\n${lnValidBackupModes}Try 'ln --help' for more information.\n`,
  });
  expect(await run(["ln", "--backup=bad", "link-src", "ln-backup-bad"])).toMatchObject({
    code: 1,
    stderr: `ln: invalid argument ${diagnosticQuote("bad")} for ${diagnosticQuote("backup type")}\n${lnValidBackupModes}Try 'ln --help' for more information.\n`,
  });
  expect(await run(["ln", "--backup", "link-src", "ln-backup-env-bad"], "", { env: { VERSION_CONTROL: "bad" } })).toMatchObject({
    code: 1,
    stderr: `ln: invalid argument ${diagnosticQuote("bad")} for ${diagnosticQuote("$VERSION_CONTROL")}\n${lnValidBackupModes}Try 'ln --help' for more information.\n`,
  });
  expect(await run(["ln", "-r", "link-src", "ln-relative-without-symbolic"])).toMatchObject({
    code: 1,
    stderr: "ln: cannot do --relative without --symbolic\n",
  });
  expect(await run(["ln", "-T", "link-src", "target"])).toMatchObject({
    code: 1,
    stderr: "ln: failed to create hard link 'target': File exists\n",
  });
  const lnDirectoryShort = await run(["ln", "-F", ".", "ln-directory-short"]);
  expect(lnDirectoryShort.code).toBe(1);
  expect(lnDirectoryShort.stderr).toContain("ln: failed to create hard link 'ln-directory-short'");
  expect(lnDirectoryShort.stderr).not.toContain("invalid option");
  const lnDirectoryShortD = await run(["ln", "-d", ".", "ln-directory-short-d"]);
  expect(lnDirectoryShortD.code).toBe(1);
  expect(lnDirectoryShortD.stderr).toContain("ln: failed to create hard link 'ln-directory-short-d'");
  expect(lnDirectoryShortD.stderr).not.toContain("invalid option");
  const lnDirectoryLong = await run(["ln", "--directory", ".", "ln-directory-long"]);
  expect(lnDirectoryLong.code).toBe(1);
  expect(lnDirectoryLong.stderr).toContain("ln: failed to create hard link 'ln-directory-long'");
  expect(lnDirectoryLong.stderr).not.toContain("unrecognized option");
  expect(await run(["ln", "-sF", ".", "ln-directory-symlink"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "ln-directory-symlink"))).isSymbolicLink()).toBe(true);
  await symlink("missing-ln-source", join(dir, "ln-dangling"));
  expect(await run(["ln", "-L", "ln-dangling", "ln-logical-hard"])).toMatchObject({
    code: 1,
    stderr: "ln: failed to access 'ln-dangling': No such file or directory\n",
  });
  expect(await run(["ln", "-P", "ln-dangling", "ln-physical-hard"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "ln-physical-hard"))).isSymbolicLink()).toBe(true);
  await mkdir(join(dir, "childproof-ln-target"));
  await mkdir(join(dir, "childproof-ln-a"));
  await mkdir(join(dir, "childproof-ln-b"));
  await writeFile(join(dir, "childproof-ln-a/f"), "a");
  await writeFile(join(dir, "childproof-ln-b/f"), "b");
  expect(await run(["ln", "-f", "childproof-ln-a/f", "childproof-ln-b/f", "childproof-ln-target"])).toMatchObject({ code: 1 });
  expect((await stat(join(dir, "childproof-ln-a/f"))).ino).toBe((await stat(join(dir, "childproof-ln-target/f"))).ino);
  expect((await stat(join(dir, "childproof-ln-b/f"))).ino).not.toBe((await stat(join(dir, "childproof-ln-target/f"))).ino);
  expect(await shell(`
    set -e
    name=$(printf '\\377')
    printf x > "$name"
    mkdir raw-dst
    "$BUN" "$BNU" ln "$name" raw-dst
    test -f "raw-dst/$name"
    "$BUN" "$BNU" rm -f "raw-dst/$name"
    "$BUN" "$BNU" ln -s -t raw-dst "$name"
    test -L "raw-dst/$name"
    "$BUN" "$BNU" chmod -R u+rwx .
    "$BUN" "$BNU" rm -rf raw-dst "$name"
  `)).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await shell(`
    set -e
    name=$(printf '\\377\\174\\355\\272\\255\\174\\302\\211\\174\\355\\246\\277\\355\\277\\277')
    mkdir "$name" cp-raw-dst
    printf 1 > "$name/file1"
    printf 2 > "$name/file2"
    LC_ALL=C "$BUN" "$BNU" cp -r "$name"/. cp-raw-dst
    test "$(cat cp-raw-dst/file1)" = 1
    test "$(cat cp-raw-dst/file2)" = 2
    "$BUN" "$BNU" rm cp-raw-dst/file1 cp-raw-dst/file2
    test -f "$name/file1"
    test -f "$name/file2"
    "$BUN" "$BNU" chmod -R u+rwx .
    "$BUN" "$BNU" rm -rf cp-raw-dst "$name"
  `)).toMatchObject({ code: 0, stdout: "", stderr: "" });
});

test("readlink and realpath support canonical and relative output modes", async () => {
  await mkdir(join(dir, "root/actual/sub"), { recursive: true });
  await writeFile(join(dir, "root/actual/sub/file"), "payload");
  await symlink("actual", join(dir, "root/link"));
  expect(await run(["readlink", "root/link"])).toMatchObject({ code: 0, stdout: "actual\n" });
  expect(await run(["readlink", "-n", "root/link"])).toMatchObject({ code: 0, stdout: "actual" });
  expect(await run(["readlink", "-z", "root/link"])).toMatchObject({ code: 0, stdout: "actual\0" });
  expect(await run(["readlink", "--no-n", "root/link"])).toMatchObject({ code: 0, stdout: "actual" });
  expect(await run(["readlink", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "readlink: unrecognized option '--bad'\nTry 'readlink --help' for more information.\n" });
  expect(await run(["readlink", "--c", "root/link", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "readlink: option '--c' is ambiguous; possibilities: '--canonicalize' '--canonicalize-existing' '--canonicalize-missing'\nTry 'readlink --help' for more information.\n" });
  expect(await run(["readlink", "--zero=foo", "root/link"])).toMatchObject({ code: 1, stdout: "", stderr: "readlink: option '--zero' doesn't allow an argument\nTry 'readlink --help' for more information.\n" });
  const readlinkHelp = (await run(["readlink", "--z", "root/link", "--help"])).stdout;
  expect(readlinkHelp).toContain("Usage: readlink [OPTION]... FILE...\n");
  expect(readlinkHelp).toContain("-f, --canonicalize\n         canonicalize by following every symlink\n");
  expect(readlinkHelp).toContain("         all but the last component must exist\n");
  expect(readlinkHelp).toContain("-q, --quiet\n         suppress most error messages\n");
  expect(readlinkHelp).toContain("-s, --silent\n         suppress most error messages\n");
  expect(readlinkHelp).toContain("-z, --zero\n         end each output line with NUL, not newline\n");
  expect(await run(["readlink", "missing-readlink"])).toMatchObject({ code: 1, stdout: "", stderr: "" });
  expect(await run(["readlink", "-v", "missing-readlink"])).toMatchObject({ code: 1, stdout: "", stderr: "readlink: missing-readlink: No such file or directory\n" });
  expect(await run(["readlink", "-v", "missing\nreadlink"])).toMatchObject({ code: 1, stdout: "", stderr: "readlink: 'missing'$'\\n''readlink': No such file or directory\n" });
  expect(await run(["readlink", "-v", "missing'readlink"])).toMatchObject({ code: 1, stdout: "", stderr: "readlink: \"missing'readlink\": No such file or directory\n" });
  expect(await run(["readlink", "-qv", "missing-readlink"])).toMatchObject({ code: 1, stdout: "", stderr: "readlink: missing-readlink: No such file or directory\n" });
  expect(await run(["readlink", "-vq", "missing-readlink"])).toMatchObject({ code: 1, stdout: "", stderr: "" });
  await writeFile(join(dir, "regular-readlink"), "regular");
  await writeFile(join(dir, "regular'readlink"), "regular");
  expect(await run(["readlink", "regular-readlink"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 1, stdout: "", stderr: "readlink: regular-readlink: Invalid argument\n" });
  expect(await run(["readlink", "regular'readlink"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 1, stdout: "", stderr: "readlink: \"regular'readlink\": Invalid argument\n" });
  expect(await run(["readlink", "-q", "regular-readlink"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 1, stdout: "", stderr: "readlink: regular-readlink: Invalid argument\n" });
  expect(await run(["readlink", "missing-readlink"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 1, stdout: "", stderr: "readlink: missing-readlink: No such file or directory\n" });
  expect(await run(["readlink", "-f", "regular-readlink"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 0, stdout: `${join(dir, "regular-readlink")}\n`, stderr: "" });
  expect(await run(["readlink"])).toMatchObject({ code: 1, stderr: "readlink: missing operand\nTry 'readlink --help' for more information.\n" });
  expect(await run(["readlink", "-f", "root/link/sub/file"])).toMatchObject({ code: 0, stdout: `${join(dir, "root/actual/sub/file")}\n` });
  expect(await run(["readlink", "-m", "root/link/"])).toMatchObject({ code: 0, stdout: `${join(dir, "root/actual")}\n` });
  expect(await run(["readlink", "-m", "root/actual/sub/file/extra"])).toMatchObject({ code: 0, stdout: `${join(dir, "root/actual/sub/file/extra")}\n` });
  expect(await run(["readlink", "-m", "-n", "--zero", "/1", "/1"])).toMatchObject({ code: 0, stdout: "/1\0/1\0" });
  expect(await run(["readlink", "root/link", "missing"])).toMatchObject({ code: 1, stdout: "actual\n" });
  expect(await run(["realpath", "-e", "root/link/sub/file"])).toMatchObject({ code: 0, stdout: `${join(dir, "root/actual/sub/file")}\n` });
  expect(await run(["realpath", "-m", "root/link/missing/../sub/file"])).toMatchObject({ code: 0, stdout: `${join(dir, "root/actual/sub/file")}\n` });
  expect(await run(["realpath", "-s", "root/link/sub/file"])).toMatchObject({ code: 0, stdout: `${join(dir, "root/link/sub/file")}\n` });
  expect(await run(["realpath", "--relative-to=root", "root/link/sub/file"])).toMatchObject({ code: 0, stdout: "actual/sub/file\n" });
  expect(await run(["realpath", "--relative-to", "--help", "root/link/sub/file"])).toMatchObject({ code: 0, stdout: "../root/actual/sub/file\n" });
  const realpathHelp = (await run(["realpath", "--relative-to=root", "--help", "root/link/sub/file"])).stdout;
  expect(realpathHelp).toContain("Usage: realpath [OPTION]... FILE...\n");
  expect(realpathHelp).toContain("-E, --canonicalize           all but the last component must exist (default)\n");
  expect(realpathHelp).toContain("-m, --canonicalize-missing   no path components need exist or be a directory\n");
  expect(realpathHelp).toContain("--relative-to=DIR        print the resolved path relative to DIR\n");
  expect(realpathHelp).toContain("-s, --strip, --no-symlinks   don't expand symlinks\n");
  expect(realpathHelp).toContain("-z, --zero                   end each output line with NUL, not newline\n");
  expect(await run(["realpath", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "realpath: unrecognized option '--bad'\nTry 'realpath --help' for more information.\n" });
  expect(await run(["realpath", "--r=root", "root/link/sub/file"])).toMatchObject({ code: 1, stdout: "", stderr: "realpath: option '--r=root' is ambiguous; possibilities: '--relative-to' '--relative-base'\nTry 'realpath --help' for more information.\n" });
  expect(await run(["realpath", "--zero=foo", "root/link/sub/file"])).toMatchObject({ code: 1, stdout: "", stderr: "realpath: option '--zero' doesn't allow an argument\nTry 'realpath --help' for more information.\n" });
  expect(await run(["realpath", "-z", "root/link/sub/file"])).toMatchObject({ code: 0, stdout: `${join(dir, "root/actual/sub/file")}\0` });
  expect(await run(["realpath"])).toMatchObject({ code: 1, stderr: "realpath: missing operand\nTry 'realpath --help' for more information.\n" });
  expect(await run(["realpath", "-e", "missing"])).toMatchObject({ code: 1, stdout: "", stderr: "realpath: missing: No such file or directory\n" });
  expect(await run(["realpath", "-e", "missing\nrealpath"])).toMatchObject({ code: 1, stdout: "", stderr: "realpath: 'missing'$'\\n''realpath': No such file or directory\n" });
  expect(await run(["realpath", "-e", "missing'realpath"])).toMatchObject({ code: 1, stdout: "", stderr: "realpath: \"missing'realpath\": No such file or directory\n" });
  expect(await run(["realpath", "-q", "-e", "missing"])).toMatchObject({ code: 1, stdout: "", stderr: "" });
  expect(await run(["realpath", ""])).toEqual(await systemRun(["realpath", ""]));
  expect(await run(["realpath", "-q", ""])).toEqual(await systemRun(["realpath", "-q", ""]));
  await writeFile(join(dir, "plain-realpath"), "plain");
  expect(await run(["realpath", "-e", "--relative-to=missing\nbase", "plain-realpath"])).toMatchObject({ code: 1, stdout: "", stderr: "realpath: 'missing'$'\\n''base': No such file or directory\n" });
  await writeFile(join(dir, "realpath'not-dir"), "plain");
  expect(await run(["realpath", "-e", "--relative-base=realpath'not-dir", "plain-realpath"])).toMatchObject({ code: 1, stdout: "", stderr: "realpath: \"realpath'not-dir\": Not a directory\n" });
  expect(await run(["realpath", "--relative-to=", "plain-realpath"])).toEqual(await systemRun(["realpath", "--relative-to=", "plain-realpath"]));
  expect(await run(["realpath", "-q", "--relative-to=", "plain-realpath"])).toEqual(await systemRun(["realpath", "-q", "--relative-to=", "plain-realpath"]));
  expect(await run(["realpath", "--relative-base=", "plain-realpath"])).toEqual(await systemRun(["realpath", "--relative-base=", "plain-realpath"]));
  expect(await run(["realpath", "-e", "missing", "root/link/sub/file"])).toMatchObject({ code: 1, stdout: `${join(dir, "root/actual/sub/file")}\n`, stderr: "realpath: missing: No such file or directory\n" });
});

test("seq, printenv, env, test, true and false", async () => {
  expect(await run(["seq", "3"])).toMatchObject({ code: 0, stdout: "1\n2\n3\n" });
  expect(await run(["seq", "0", ".1", ".3"])).toMatchObject({ code: 0, stdout: "0.0\n0.1\n0.2\n0.3\n" });
  expect(await run(["seq", "1.00", ".25", "1.50"])).toMatchObject({ code: 0, stdout: "1.00\n1.25\n1.50\n" });
  expect(await run(["seq", "-s", ",", "-w", "-2", "2", "2"])).toMatchObject({ code: 0, stdout: "-2,00,02\n" });
  expect(await run(["seq", "-w", "-10", "5", "0"])).toMatchObject({ code: 0, stdout: "-10\n-05\n000\n" });
  expect(await run(["seq", "-f", "v%04.1f", "1", "0.5", "2"])).toMatchObject({ code: 0, stdout: "v01.0\nv01.5\nv02.0\n" });
  expect(await run(["seq", "-f", "%010.2e", "1", "3"])).toMatchObject({ code: 0, stdout: "001.00e+00\n002.00e+00\n003.00e+00\n" });
  expect(await run(["seq", "-f", "%A", "1", "3"])).toMatchObject({ code: 0, stdout: "0X8P-3\n0X8P-2\n0XCP-2\n" });
  expect(await run(["seq", "-f", "%+010a", "1", "3"])).toMatchObject({ code: 0, stdout: "+0x0008p-3\n+0x0008p-2\n+0x000cp-2\n" });
  expect(await run(["seq", "-f", "%#.3a", "1", "3"])).toMatchObject({ code: 0, stdout: "0x8.000p-3\n0x8.000p-2\n0xc.000p-2\n" });
  expect(await run(["seq", "--f=%02g", "1", "3"])).toMatchObject({ code: 0, stdout: "01\n02\n03\n" });
  expect(await run(["seq", "--s", ",", "1", "3"])).toMatchObject({ code: 0, stdout: "1,2,3\n" });
  expect(await run(["seq", "--e", "8", "10"])).toMatchObject({ code: 0, stdout: "08\n09\n10\n" });
  expect(await run(["seq", "10.8", "0.1", "10.95"])).toMatchObject({ code: 0, stdout: "10.8\n10.9\n" });
  expect(await run(["seq", "-s,,", "1", "3"])).toMatchObject({ code: 0, stdout: "1,,2,,3\n" });
  expect(await run(["seq", "999999999999999999999999999999999999999999999999999999999999999999999999999999999", "1000000000000000000000000000000000000000000000000000000000000000000000000000000001"])).toMatchObject({ code: 0, stdout: "999999999999999999999999999999999999999999999999999999999999999999999999999999999\n1000000000000000000000000000000000000000000000000000000000000000000000000000000000\n1000000000000000000000000000000000000000000000000000000000000000000000000000000001\n" });
  expect(await run(["seq", "18446744073709551617", "18446744073709551617"])).toMatchObject({ code: 0, stdout: "18446744073709551617\n" });
  expect(await run(["seq", "-0", "2"])).toMatchObject({ code: 0, stdout: "-0\n1\n2\n" });
  expect((await shell(`"$BUN" "$BNU" seq inf inf 2>/dev/null | head -n3`)).stdout).toBe("inf\ninf\ninf\n");
  expect((await shell(`"$BUN" "$BNU" seq -f %f inf inf 2>/dev/null | head -n3`)).stdout).toBe("inf\ninf\ninf\n");
  expect((await shell(`"$BUN" "$BNU" seq -f %010f inf inf 2>/dev/null | head -n1`)).stdout).toBe("       inf\n");
  expect(await run(["seq"])).toMatchObject({ code: 1, stderr: "seq: missing operand\nTry 'seq --help' for more information.\n" });
  expect(await run(["seq", "1", "2", "3", "4"])).toMatchObject(await systemRun(["seq", "1", "2", "3", "4"]));
  expect(await run(["seq", "-s"])).toMatchObject({ code: 1, stderr: "seq: option requires an argument -- 's'\nTry 'seq --help' for more information.\n" });
  expect(await run(["seq", "--separator"])).toMatchObject({ code: 1, stderr: "seq: option '--separator' requires an argument\nTry 'seq --help' for more information.\n" });
  expect(await run(["seq", "-f"])).toMatchObject({ code: 1, stderr: "seq: option requires an argument -- 'f'\nTry 'seq --help' for more information.\n" });
  expect(await run(["seq", "--format"])).toMatchObject({ code: 1, stderr: "seq: option '--format' requires an argument\nTry 'seq --help' for more information.\n" });
  expect(await run(["seq", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "seq: unrecognized option '--bad'\nTry 'seq --help' for more information.\n" });
  expect(await run(["seq", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: seq [OPTION]... LAST\n  or:  seq [OPTION]... FIRST LAST\n  or:  seq [OPTION]... FIRST INCREMENT LAST\n") });
  expect(await run(["seq", "--version=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "seq: option '--version' doesn't allow an argument\nTry 'seq --help' for more information.\n" });
  expect(await run(["seq", "--equal-width=foo", "1", "3"])).toMatchObject({ code: 1, stdout: "", stderr: "seq: option '--equal-width' doesn't allow an argument\nTry 'seq --help' for more information.\n" });
  expect(await run(["seq", "--separator", "--help", "1", "3"])).toMatchObject({ code: 0, stdout: "1--help2--help3\n" });
  expect(await run(["seq", "1", "--separator=,", "3"])).toMatchObject(await systemRun(["seq", "1", "--separator=,", "3"]));
  expect(await run(["seq", "1", "3", "--help"])).toMatchObject(await systemRun(["seq", "1", "3", "--help"]));
  expect(await run(["seq", "1\n2"])).toMatchObject(await systemRun(["seq", "1\n2"]));
  expect(await run(["seq", "1", "0\t0", "2"])).toMatchObject(await systemRun(["seq", "1", "0\t0", "2"]));
  expect(await run(["seq", "1", "2", "3", "4\n5"])).toMatchObject(await systemRun(["seq", "1", "2", "3", "4\n5"]));
  expect(await run(["seq", "3 "])).toMatchObject(await systemRun(["seq", "3 "]));
  expect(await run(["seq", " 3"])).toMatchObject(await systemRun(["seq", " 3"]));
  expect(await run(["seq", "1e", "3"])).toMatchObject(await systemRun(["seq", "1e", "3"]));
  expect(await run(["seq", "1", "1e", "3"])).toMatchObject(await systemRun(["seq", "1", "1e", "3"]));
  expect(await run(["seq", "1", "1", "1e"])).toMatchObject(await systemRun(["seq", "1", "1", "1e"]));
  expect(await run(["seq", "nan"])).toMatchObject(await systemRun(["seq", "nan"]));
  expect(await run(["seq", "nan", "1"])).toMatchObject(await systemRun(["seq", "nan", "1"]));
  expect(await run(["seq", "1", "nan", "2"])).toMatchObject(await systemRun(["seq", "1", "nan", "2"]));
  expect(await run(["seq", "1", "1", "nan"])).toMatchObject(await systemRun(["seq", "1", "1", "nan"]));
  expect(await run(["seq", "-nan", "1"])).toMatchObject(await systemRun(["seq", "-nan", "1"]));
  expect(await run(["seq", "1", "0", "bad"])).toMatchObject(await systemRun(["seq", "1", "0", "bad"]));
  expect(await run(["seq", "--format=%s", "1", "2"])).toMatchObject({ code: 1, stderr: `seq: format ${diagnosticQuote("%s")} has unknown %s directive\n` });
  expect(await run(["seq", "--format=x%y", "1", "2"])).toMatchObject({ code: 1, stderr: `seq: format ${diagnosticQuote("x%y")} has unknown %y directive\n` });
  expect(await run(["seq", "--format=x%y\nz", "1", "2"])).toMatchObject({ code: 1, stderr: `seq: format ${diagnosticQuote("x%y\\nz")} has unknown %y directive\n` });
  expect(await run(["seq", "--format=x%", "1", "2"])).toMatchObject({ code: 1, stderr: `seq: format ${diagnosticQuote("x%")} ends in %\n` });
  expect(await run(["seq", "--format=%g%s", "1", "2"])).toMatchObject({ code: 1, stderr: `seq: format ${diagnosticQuote("%g%s")} has too many % directives\n` });
  expect(await run(["seq", "--format=%g\n%s", "1", "2"])).toMatchObject({ code: 1, stderr: `seq: format ${diagnosticQuote("%g\\n%s")} has too many % directives\n` });
  expect(await run(["seq", "--format=abc", "1", "2"])).toMatchObject({ code: 1, stderr: `seq: format ${diagnosticQuote("abc")} has no % directive\n` });
  expect(await run(["seq", "--format=%2147483648g", "1", "0"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["seq", "--format=%2147483648g", "1", "1"])).toMatchObject({ code: 1, stdout: "", stderr: "seq: write error: Value too large for defined data type\n" });
  expect(await run(["seq", "--format=%.2147483648g", "1", "1"])).toMatchObject({ code: 1, stdout: "", stderr: "seq: write error: Value too large for defined data type\n" });
  expect((await shell(`bash -c '(trap "" PIPE; bash -c '\\''trap - PIPE; "$BUN" "$BNU" seq 999999 2>err | head -n1 >out'\\''; sed "s/^\\\\(seq: write error:\\\\) .*/\\\\1/" err)'`)).stdout).toBe("seq: write error:\n");
  expect(await shell(`bash -c '(trap "" PIPE; "$BUN" "$BNU" env --default-signal bash -c '\\''trap - PIPE; "$BUN" "$BNU" seq 999999 2>err | head -n1 >out'\\''; cat out; cat err)'`)).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await shell(`bash -c '(trap "" PIPE; printf x | "$BUN" "$BNU" env --default-signal=PIPE "$BUN" "$BNU" dd status=none 2>err | :; cat err)'`)).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["env", "--default-signal=BAD", "true"])).toMatchObject({ code: 125, stderr: "env: 'BAD': invalid signal\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "--ignore-signal=BAD", "true"])).toMatchObject({ code: 125, stderr: "env: 'BAD': invalid signal\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "--block-signal=BAD", "true"])).toMatchObject({ code: 125, stderr: "env: 'BAD': invalid signal\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "--deb=bad"])).toMatchObject(await systemRun(["env", "--deb=bad"]));
  expect(await run(["env", "--default-s=BAD", "true"])).toMatchObject({ code: 125, stderr: "env: 'BAD': invalid signal\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "--ignore-s=BAD", "true"])).toMatchObject({ code: 125, stderr: "env: 'BAD': invalid signal\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "--block-s=BAD", "true"])).toMatchObject({ code: 125, stderr: "env: 'BAD': invalid signal\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "--list-signal=bad"])).toMatchObject(await systemRun(["env", "--list-signal=bad"]));
  expect((await run(["printenv", "PATH"])).code).toBe(0);
  expect((await run(["printenv", "-0", "PATH"])).stdout).toEndWith("\0");
  expect(await run(["printenv", "--n", "PATH"])).toMatchObject({ code: 0, stdout: expect.stringMatching(/\0$/) });
  const printenvHelp = (await run(["printenv", "--h"])).stdout;
  expect(printenvHelp).toContain("Usage: printenv [OPTION] [VARIABLE]...\n");
  expect(printenvHelp).toContain("-0, --null     end each output line with NUL, not newline\n");
  expect(printenvHelp).toContain("Your shell may have its own version of printenv, which usually supersedes\nthe version described here.  Please refer to your shell's documentation\n");
  expect(await run(["printenv", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["printenv", "--n=1", "PATH"])).toMatchObject({ code: 2, stderr: "printenv: option '--null' doesn't allow an argument\nTry 'printenv --help' for more information.\n" });
  expect(await run(["printenv", "PATH", "--h"])).toMatchObject({ code: 1, stdout: expect.stringMatching(/\n$/) });
  expect(await run(["printenv", "--bad", "--help"])).toMatchObject({ code: 2, stderr: "printenv: unrecognized option '--bad'\nTry 'printenv --help' for more information.\n" });
  expect(await run(["printenv", "-a"], "", { env: { "-a": "b" } })).toMatchObject({ code: 2, stderr: "printenv: invalid option -- 'a'\nTry 'printenv --help' for more information.\n" });
  expect(await run(["printenv", "--", "-a"], "", { env: { "-a": "b" } })).toMatchObject({ code: 0, stdout: "b\n" });
  expect(await run(["printenv", "--nullish"], "", { env: { "--nullish": "long" } })).toMatchObject({ code: 2, stderr: "printenv: unrecognized option '--nullish'\nTry 'printenv --help' for more information.\n" });
  const printenvWrapper = join(dir, "printenv-wrapper");
  await writeFile(printenvWrapper, `#!${process.execPath}
import { readFileSync } from "node:fs";
import { main } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/coreutils.js")).href)};

function rawScriptArgs() {
  try {
    const parts = readFileSync("/proc/self/cmdline", "utf8").split("\\0").filter(Boolean);
    const scriptIndex = parts.indexOf(Bun.argv[1]);
    if (scriptIndex !== -1) return parts.slice(scriptIndex + 1);
  } catch {}
  return Bun.argv.slice(2);
}

process.exit(await main(["printenv", ...rawScriptArgs()]));
`);
  await chmod(printenvWrapper, 0o755);
  expect(await systemRun([printenvWrapper, "--", "-a"], "", { env: { "-a": "b" } })).toMatchObject({ code: 0, stdout: "b\n" });
  expect(await run(["env", "-i", "A=B"])).toMatchObject({ code: 0, stdout: "A=B\n" });
  expect(await run(["env", "-i", "printenv"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["env", "PATH=", "printenv"])).toMatchObject({ code: 127, stderr: "env: 'printenv': No such file or directory\n" });
  expect(await run(["env", "-", "-0", "A=B"])).toMatchObject({ code: 0, stdout: "A=B\0" });
  await mkdir(join(dir, "work"));
  expect(await run(["env", "-C", "work", process.execPath, "-e", "console.log(process.cwd())"])).toMatchObject({ code: 0, stdout: `${join(dir, "work")}\n` });
  expect(await run(["env", "--chdir=missing'cwd", "true"])).toMatchObject({ code: 125, stdout: "", stderr: "env: cannot change directory to \"missing'cwd\": No such file or directory\n" });
  expect(await run(["env", "--chdir=missing\ncwd", "true"])).toMatchObject({ code: 125, stdout: "", stderr: "env: cannot change directory to 'missing'$'\\n''cwd': No such file or directory\n" });
  expect(await run(["env", "--", process.execPath, "-e", "console.log('separator')"])).toMatchObject({ code: 0, stdout: "separator\n" });
  expect(await run(["env", "--", "-a=b", "printenv", "--", "-a"])).toMatchObject({ code: 0, stdout: "b\n" });
  expect(await run(["env", "-S", `${process.execPath} -e "console.log('split')" `])).toMatchObject({ code: 0, stdout: "split\n" });
  expect(await run(["env", "-v -S cat -n"])).toMatchObject({ code: 125, stderr: "env: invalid option -- ' '\nenv: use -[v]S to pass options in shebang lines\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "-v\t-S cat -n"])).toMatchObject({ code: 125, stderr: "env: invalid option -- '\t'\nenv: use -[v]S to pass options in shebang lines\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "cat -n", "./xxx"])).toMatchObject({ code: 127, stderr: "env: 'cat -n': No such file or directory\nenv: use -[v]S to pass options in shebang lines\n" });
  expect(await run(["env", "-a", "custom-zero", "/bin/sh", "-c", "printf '%s\\n' \"$0\""])).toMatchObject({ code: 0, stdout: "custom-zero\n" });
  expect(await run(["env", "-a=custom-zero", "/bin/sh", "-c", "printf '%s\\n' \"$0\""])).toMatchObject({ code: 0, stdout: "=custom-zero\n" });
  expect(await run(["env", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]\n") });
  expect(await run(["env", "--he=bad"])).toMatchObject(await systemRun(["env", "--he=bad"]));
  expect(await run(["env", "--ve=bad"])).toMatchObject(await systemRun(["env", "--ve=bad"]));
  expect(await run(["env", "--bad", "--help"])).toMatchObject({ code: 125, stderr: "env: unrecognized option '--bad'\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "--bad=4"])).toMatchObject({ code: 125, stderr: "env: unrecognized option '--bad=4'\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "FOO=bar", "--help"])).toMatchObject({ code: 127, stderr: "env: '--help': No such file or directory\n" });
  expect(await run(["env", "-a"])).toMatchObject({ code: 125, stderr: "env: option requires an argument -- 'a'\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "--argv0"])).toMatchObject({ code: 125, stderr: "env: option '--argv0' requires an argument\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "-u"])).toMatchObject({ code: 125, stderr: "env: option requires an argument -- 'u'\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "--unset"])).toMatchObject({ code: 125, stderr: "env: option '--unset' requires an argument\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "--unset=bad=name", "true"])).toMatchObject({ code: 125, stdout: "", stderr: `env: cannot unset ${diagnosticQuote("bad=name")}: Invalid argument\n` });
  expect(await run(["env", "--unset=bad\nname=1", "true"])).toMatchObject({ code: 125, stdout: "", stderr: `env: cannot unset ${diagnosticQuote("bad\\nname=1")}: Invalid argument\n` });
  expect(await run(["env", "-C"])).toMatchObject({ code: 125, stderr: "env: option requires an argument -- 'C'\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "--chdir"])).toMatchObject({ code: 125, stderr: "env: option '--chdir' requires an argument\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "-S"])).toMatchObject({ code: 125, stderr: "env: option requires an argument -- 'S'\nTry 'env --help' for more information.\n" });
  expect(await run(["env", "--split-string"])).toMatchObject({ code: 125, stderr: "env: option '--split-string' requires an argument\nTry 'env --help' for more information.\n" });
  expect((await run(["env", "NON_UTF8_TEST=\uFFFD", "env"])).stdout).toContain("NON_UTF8_TEST=�\n");
  expect((await run(["env", "NON_UTF8_TEST\uFFFD=1", "env"])).stdout).toContain("NON_UTF8_TEST�=1\n");
  expect((await run(["env", "NON_UTF8_TEST=\u00A0", "env"])).stdout).toContain("NON_UTF8_TEST=�\n");
  expect((await run(["env", "NON_UTF8_TEST\u00A0=1", "env"])).stdout).toContain("NON_UTF8_TEST�=1\n");
  expect((await run(["env", "NON_UTF8_TEST=\uDCA0", "env"])).stdout).toContain("NON_UTF8_TEST=�\n");
  expect((await run(["env", "NON_UTF8_TEST\uDCA0=1", "env"])).stdout).toContain("NON_UTF8_TEST�=1\n");
  expect(await run(["test", "4", "-gt", "3"])).toMatchObject({ code: 0 });
  await writeFile(join(dir, "empty"), "");
  await writeFile(join(dir, "script"), "#!/bin/sh\n");
  await symlink("script", join(dir, "script-link"));
  expect(await run(["test", "-f", "script"])).toMatchObject({ code: 0 });
  expect(await run(["test", "-s", "empty"])).toMatchObject({ code: 1 });
  expect(await run(["test", "-L", "script-link"])).toMatchObject({ code: 0 });
  expect(await run(["chmod", "755", "script"])).toMatchObject({ code: 0 });
  expect(await run(["test", "-x", "script"])).toMatchObject({ code: 0 });
  expect(await run(["[", "-r", "script", "]"])).toMatchObject({ code: 0 });
  expect(await run(["[", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: test EXPRESSION\n  or:  test\n  or:  [ EXPRESSION ]\n") });
  expect(await run(["[", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["[", "-r", "script"])).toMatchObject({ code: 2, stderr: `[: missing ${diagnosticQuote("]")}\n` });
  expect(await run(["[", "1", "-eq", "x", "]"])).toMatchObject({ code: 2, stderr: `[: invalid integer ${diagnosticQuote("x")}\n` });
  expect(await run(["[", "1", "-eq", "x\ny", "]"])).toMatchObject({ code: 2, stderr: `[: invalid integer ${diagnosticQuote("x\\ny")}\n` });
  expect(await run(["[", "1", "-eq", "]"])).toMatchObject({ code: 2, stderr: `[: missing argument after ${diagnosticQuote("-eq")}\n` });
  expect(await run(["test", "1", "-eq", "x"])).toMatchObject({ code: 2, stderr: `test: invalid integer ${diagnosticQuote("x")}\n` });
  expect(await run(["test", "1", "-eq", "x\ny"])).toMatchObject({ code: 2, stderr: `test: invalid integer ${diagnosticQuote("x\\ny")}\n` });
  await writeFile(join(dir, "older"), "old");
  await writeFile(join(dir, "newer"), "new");
  expect(await run(["touch", "-d", "2020-01-01T00:00:00Z", "older"])).toMatchObject({ code: 0 });
  expect(await run(["touch", "-d", "2021-01-01T00:00:00Z", "newer"])).toMatchObject({ code: 0 });
  expect(await run(["test", "newer", "-nt", "older"])).toMatchObject({ code: 0 });
  expect(await run(["test", "older", "-ot", "newer"])).toMatchObject({ code: 0 });
  await writeFile(join(dir, "newer-ns"), "new");
  await writeFile(join(dir, "older-ns"), "old");
  await systemRun(["/usr/bin/touch", "-d", "2026-01-02 03:04:05.123456789 +0000", "newer-ns"]);
  await systemRun(["/usr/bin/touch", "-d", "2026-01-02 03:04:05.123456788 +0000", "older-ns"]);
  expect(await run(["test", "newer-ns", "-nt", "older-ns"])).toMatchObject({ code: 0 });
  expect(await run(["test", "older-ns", "-ot", "newer-ns"])).toMatchObject({ code: 0 });
  expect(await run(["link", "newer", "newer-hard"])).toMatchObject({ code: 0 });
  expect(await run(["test", "newer", "-ef", "newer-hard"])).toMatchObject({ code: 0 });
  expect(await run(["true"])).toMatchObject({ code: 0 });
  expect(await run(["false"])).toMatchObject({ code: 1 });
  expect(await run(["test", "--version"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["test", "!", "--version"])).toMatchObject({ code: 1, stdout: "" });
  expect(await run(["[", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["[", "--version", "]"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["true", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n", stderr: "" });
  expect(await run(["false", "--version"])).toMatchObject({ code: 1, stdout: "bnu 9.11\n", stderr: "" });
  expect(await run(["true", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: true [ignored command line arguments]\n  or:  true OPTION\n"), stderr: "" });
  expect(await run(["false", "--help"])).toMatchObject({ code: 1, stdout: expect.stringContaining("Usage: false [ignored command line arguments]\n  or:  false OPTION\n"), stderr: "" });
  expect(await run(["true", "--help", "extra"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["false", "--help", "extra"])).toMatchObject({ code: 1, stdout: "" });
  const bracketFull = Bun.spawn(["/bin/sh", "-c", `${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} '[' --version >/dev/full`], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await bracketFull.exited).toBe(2);
  expect(await new Response(bracketFull.stderr).text()).toBe("[: write error: No space left on device\n");
  const full = Bun.spawn(["/bin/sh", "-c", `${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} true --version >/dev/full`], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await full.exited).toBe(1);
});

test("tee and truncate write expected data", async () => {
  expect(await run(["tee", "out"], "abcdef")).toMatchObject({ code: 0, stdout: "abcdef" });
  expect(await readFile(join(dir, "out"), "utf8")).toBe("abcdef");
  expect(await run(["tee", "-ai", "out"], "G")).toMatchObject({ code: 0, stdout: "G" });
  expect(await readFile(join(dir, "out"), "utf8")).toBe("abcdefG");
  expect(await run(["tee", "--h"], "x")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: tee [OPTION]... [FILE]...\n") });
  expect(await run(["tee", "--help"], "x")).toMatchObject({ code: 0, stdout: expect.stringContaining("Copy standard input to each FILE, and also to standard output.\n") });
  expect(await run(["tee", "--v"], "x")).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["tee", "tee-meta-out", "--help"], "x")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: tee [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["tee", "--app", "out"], "H")).toMatchObject({ code: 0, stdout: "H" });
  expect(await readFile(join(dir, "out"), "utf8")).toBe("abcdefGH");
  expect(await run(["tee", "--ig"], "x")).toMatchObject({ code: 0, stdout: "x" });
  expect(await run(["tee", "--out=exit"], "x")).toMatchObject({ code: 0, stdout: "x" });
  expect(await run(["tee", "--bad", "--help"], "x")).toMatchObject({ code: 1, stdout: "", stderr: "tee: unrecognized option '--bad'\nTry 'tee --help' for more information.\n" });
  expect(await run(["tee", "-x", "--help"], "x")).toMatchObject({ code: 1, stdout: "", stderr: "tee: invalid option -- 'x'\nTry 'tee --help' for more information.\n" });
  expect(await run(["tee", "--h=foo"], "x")).toMatchObject({ code: 1, stdout: "", stderr: "tee: option '--help' doesn't allow an argument\nTry 'tee --help' for more information.\n" });
  expect(await run(["tee", "--app=foo"], "x")).toMatchObject({ code: 1, stdout: "", stderr: "tee: option '--append' doesn't allow an argument\nTry 'tee --help' for more information.\n" });
  expect(await run(["tee", "-p", "--output-error", "pipe-mode"], "p")).toMatchObject({ code: 0, stdout: "p" });
  expect(await readFile(join(dir, "pipe-mode"), "utf8")).toBe("p");
  expect(await run(["tee", "--output-error=warn", "--help"], "x")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: tee [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["tee", "missing'parent/out"], "x")).toMatchObject({ code: 1, stdout: "x", stderr: "tee: \"missing'parent/out\": No such file or directory\n" });
  expect(await run(["tee", "missing\nparent/out"], "x")).toMatchObject({ code: 1, stdout: "x", stderr: "tee: 'missing'$'\\n''parent/out': No such file or directory\n" });
  await mkdir(join(dir, "dir'tee"));
  expect(await run(["tee", "dir'tee"], "x")).toMatchObject({ code: 1, stdout: "x", stderr: "tee: \"dir'tee\": Is a directory\n" });
  await symlink("loop'tee", join(dir, "loop'tee"));
  expect(await run(["tee", "loop'tee"], "x")).toMatchObject({ code: 1, stdout: "x", stderr: "tee: \"loop'tee\": Too many levels of symbolic links\n" });
  await symlink("/dev/full", join(dir, "full'tee"));
  expect(await run(["tee", "full'tee"], "x")).toMatchObject({ code: 1, stdout: "x", stderr: "tee: \"full'tee\": No space left on device\n" });
  expect(await run(["tee", "--output-error=", "bad"], "x")).toMatchObject({
    code: 1,
    stderr: `tee: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--output-error")}\nValid arguments are:\n  - ${diagnosticQuote("warn")}\n  - ${diagnosticQuote("warn-nopipe")}\n  - ${diagnosticQuote("exit")}\n  - ${diagnosticQuote("exit-nopipe")}\nTry 'tee --help' for more information.\n`,
  });
  expect(await run(["tee", "--output-error=bogus", "bad"], "x")).toMatchObject({
    code: 1,
    stderr: `tee: invalid argument ${diagnosticQuote("bogus")} for ${diagnosticQuote("--output-error")}\nValid arguments are:\n  - ${diagnosticQuote("warn")}\n  - ${diagnosticQuote("warn-nopipe")}\n  - ${diagnosticQuote("exit")}\n  - ${diagnosticQuote("exit-nopipe")}\nTry 'tee --help' for more information.\n`,
  });
  expect(await run(["tee", "--output-error=bad\nmode"], "x")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `tee: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--output-error")}\nValid arguments are:\n  - ${diagnosticQuote("warn")}\n  - ${diagnosticQuote("warn-nopipe")}\n  - ${diagnosticQuote("exit")}\n  - ${diagnosticQuote("exit-nopipe")}\nTry 'tee --help' for more information.\n`,
  });
  expect(await run(["truncate"])).toMatchObject({ code: 1, stderr: "truncate: you must specify either '--size' or '--reference'\nTry 'truncate --help' for more information.\n" });
  expect(await run(["truncate", "-s", "1"])).toMatchObject({ code: 1, stderr: "truncate: missing file operand\nTry 'truncate --help' for more information.\n" });
  expect(await run(["truncate", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "truncate: unrecognized option '--bad'\nTry 'truncate --help' for more information.\n" });
  expect(await run(["truncate", "--version=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "truncate: option '--version' doesn't allow an argument\nTry 'truncate --help' for more information.\n" });
  expect(await run(["truncate", "--no-create=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "truncate: option '--no-create' doesn't allow an argument\nTry 'truncate --help' for more information.\n" });
  expect(await run(["truncate", "--io=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "truncate: option '--io-blocks' doesn't allow an argument\nTry 'truncate --help' for more information.\n" });
  expect(await run(["truncate", "--size", "bad"])).toMatchObject(await systemRun(["/usr/bin/truncate", "--size", "bad"]));
  expect(await run(["truncate", "--size", "1\t2", "truncate-tab-size"])).toMatchObject(await systemRun(["/usr/bin/truncate", "--size", "1\t2", "truncate-tab-size"]));
  expect(await run(["truncate", "--size", "/0"])).toMatchObject(await systemRun(["/usr/bin/truncate", "--size", "/0"]));
  expect(await run(["truncate", "--reference", "out", "--size", "3"])).toMatchObject(await systemRun(["truncate", "--reference", "out", "--size", "3"]));
  expect(await run(["truncate", "--size", "--help", "truncate-size-help"])).toMatchObject(await systemRun(["/usr/bin/truncate", "--size", "--help", "truncate-size-help"]));
  expect(await run(["truncate", "--size=bad", "truncate-bad-size", "--help"])).toMatchObject(await systemRun(["/usr/bin/truncate", "--size=bad", "truncate-bad-size", "--help"]));
  expect(await run(["truncate", "--s", "1", "truncate-help", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: truncate OPTION... FILE...\n") });
  expect(await run(["truncate", "--n", "--s=1", "truncate-no-create-prefix"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  await expect(stat(join(dir, "truncate-no-create-prefix"))).rejects.toThrow();
  expect(await run(["truncate", "-s", "3", "out"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "out"), "utf8")).toBe("abc");
  expect(await run(["truncate", "--s=2", "truncate-size-prefix"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "truncate-size-prefix"))).size).toBe(2);
  expect(await run(["truncate", "-s", "+2K", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(2051);
  expect(await run(["truncate", "-s", "-1K", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(1027);
  expect(await run(["truncate", "-s", "1k", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(1024);
  expect(await run(["truncate", "-s", "1b", "out"])).toMatchObject(await systemRun(["/usr/bin/truncate", "-s", "1b", "out"]));
  expect(await run(["truncate", "-s", "1m", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(1024 ** 2);
  expect(await run(["truncate", "-s", "1kiB", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(1024);
  expect(await run(["truncate", "-s", "1miB", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(1024 ** 2);
  expect(await run(["truncate", "-s", "1piB", "out"])).toMatchObject({ code: 1 });
  expect(await run(["truncate", "-s", "1kB", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(1000);
  expect(await run(["truncate", "-s", "1mB", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(1000 ** 2);
  expect(await run(["truncate", "-s", "1gB", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(1000 ** 3);
  expect(await run(["truncate", "-s", "1tB", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(1000 ** 4);
  expect(await run(["truncate", "-s", "1pB", "out"])).toMatchObject({ code: 1 });
  expect(await run(["truncate", "-s", "1EB", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(1000 ** 6);
  expect(await run(["truncate", "-s", "1E", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(1024 ** 6);
  expect(await run(["truncate", "-s", "1Z", "out"])).toMatchObject(await systemRun(["/usr/bin/truncate", "-s", "1Z", "out"]));
  await writeFile(join(dir, "ref"), "12345");
  expect(await run(["truncate", "-r", "ref", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(5);
  expect(await run(["truncate", "--reference=missing-ref", "out"])).toMatchObject({ code: 1, stderr: "truncate: cannot stat 'missing-ref': No such file or directory\n" });
  expect(await run(["truncate", "--reference=missing\nref", "out"])).toMatchObject({ code: 1, stderr: "truncate: cannot stat 'missing'$'\\n''ref': No such file or directory\n" });
  expect(await run(["truncate", "--reference=missing'ref", "out"])).toMatchObject({ code: 1, stderr: "truncate: cannot stat \"missing'ref\": No such file or directory\n" });
  await writeFile(join(dir, "truncate-parent-file"), "x");
  expect(await run(["truncate", "--reference=truncate-parent-file/ref", "out"])).toMatchObject({ code: 1, stderr: "truncate: cannot stat 'truncate-parent-file/ref': Not a directory\n" });
  await writeFile(join(dir, "truncate-parent\nfile"), "x");
  expect(await run(["truncate", "--reference=truncate-parent\nfile/ref", "out"])).toMatchObject({ code: 1, stderr: "truncate: cannot stat 'truncate-parent'$'\\n''file/ref': Not a directory\n" });
  await writeFile(join(dir, "truncate-parent'file"), "x");
  expect(await run(["truncate", "-s", "1", "truncate-parent'file/out"])).toMatchObject({ code: 1, stderr: "truncate: cannot open \"truncate-parent'file/out\" for writing: Not a directory\n" });
  expect(await run(["truncate", "-r", "ref", "-s", "+2", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(7);
  expect(await run(["truncate", "-r", "ref", "-s", "-2", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(3);
  expect(await run(["truncate", "-r", "ref", "-s", "3", "out"])).toMatchObject({
    code: 1,
    stderr: `truncate: you must specify a relative ${diagnosticQuote("--size")} with ${diagnosticQuote("--reference")}\nTry 'truncate --help' for more information.\n`,
  });
  expect((await stat(join(dir, "out"))).size).toBe(3);
  expect(await run(["truncate", "-s", " +1", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(4);
  const ioBlockSize = (await statfs(dir)).bsize;
  expect(await run(["truncate", "--io-blocks", "-s", "1", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(ioBlockSize);
  expect(await run(["truncate", "-o", "-s", "1K", "out"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "out"))).size).toBe(ioBlockSize * 1024);
  expect(await run(["truncate", "--io-blocks", "--reference=ref", "out"])).toMatchObject({ code: 1, stderr: "truncate: '--io-blocks' was specified but '--size' was not\nTry 'truncate --help' for more information.\n" });
  expect(await run(["truncate", "-s", "/0", "out"])).toMatchObject({ code: 1 });
  expect(await run(["truncate", "-c", "-s", "4", "missing"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "missing"))).rejects.toThrow();
  expect(await run(["truncate", "-s0", "first", ".", "second"])).toMatchObject({ code: 1 });
  expect((await stat(join(dir, "first"))).size).toBe(0);
  expect((await stat(join(dir, "second"))).size).toBe(0);
  expect(await run(["truncate", "-s", "1G", "created-big"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "created-big"))).size).toBe(1024 ** 3);
  const overflow = await run(["truncate", "-s", "18446744073709551616", "too-big"]);
  expect(overflow.code).toBe(1);
  expect(overflow.stderr).toContain("Value too large");
  expect(await run(["truncate", "-s", "+18446744073709551616", "out"])).toMatchObject({ code: 1 });
  expect(await run(["truncate", "-s", "1", "."])).toMatchObject({ code: 1, stderr: "truncate: cannot open '.' for writing: Is a directory\n" });
  await mkdir(join(dir, "truncate\nfolder"));
  expect(await run(["truncate", "-s", "1", "truncate\nfolder"])).toMatchObject({ code: 1, stderr: "truncate: cannot open 'truncate'$'\\n''folder' for writing: Is a directory\n" });
});

test("touch supports explicit, reference, and access-only timestamps", async () => {
  expect(await run(["touch"])).toMatchObject({ code: 1, stderr: "touch: missing file operand\nTry 'touch --help' for more information.\n" });
  expect(await run(["touch", "--time=bogus"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `touch: invalid argument ${diagnosticQuote("bogus")} for ${diagnosticQuote("--time")}\nValid arguments are:\n  - ${diagnosticQuote("atime")}, ${diagnosticQuote("access")}, ${diagnosticQuote("use")}\n  - ${diagnosticQuote("mtime")}, ${diagnosticQuote("modify")}\nTry 'touch --help' for more information.\n`,
  });
  expect(await run(["touch", "--time=bad\nmode"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `touch: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--time")}\nValid arguments are:\n  - ${diagnosticQuote("atime")}, ${diagnosticQuote("access")}, ${diagnosticQuote("use")}\n  - ${diagnosticQuote("mtime")}, ${diagnosticQuote("modify")}\nTry 'touch --help' for more information.\n`,
  });
  expect(await run(["touch", "--time=bad", "--help"])).toMatchObject(await systemRun(["touch", "--time=bad", "--help"]));
  expect(await run(["touch", "--date=bogus"])).toMatchObject({ code: 1, stdout: "", stderr: `touch: invalid date format ${diagnosticQuote("bogus")}\n` });
  expect(await run(["touch", "--date=bad\ndate"])).toMatchObject({ code: 1, stdout: "", stderr: `touch: invalid date format ${diagnosticQuote("bad\\ndate")}\n` });
  expect(await run(["touch", "-t", "bad"])).toMatchObject({ code: 1, stdout: "", stderr: `touch: invalid date format ${diagnosticQuote("bad")}\n` });
  expect(await run(["touch", "-t", "bad\nstamp"])).toMatchObject({ code: 1, stdout: "", stderr: `touch: invalid date format ${diagnosticQuote("bad\\nstamp")}\n` });
  expect(await run(["touch", "--reference="])).toMatchObject({ code: 1, stdout: "", stderr: "touch: failed to get attributes of '': No such file or directory\n" });
  expect(await run(["touch", "-r", "missing-ref"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: failed to get attributes of 'missing-ref': No such file or directory\n" });
  expect(await run(["touch", "-r", "missing'ref", "target"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: failed to get attributes of \"missing'ref\": No such file or directory\n" });
  expect(await run(["touch", "-r", "missing\nref", "target"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: failed to get attributes of 'missing'$'\\n''ref': No such file or directory\n" });
  expect(await run(["touch", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: unrecognized option '--bad'\nTry 'touch --help' for more information.\n" });
  expect(await run(["touch", "--n", "ambiguous-touch", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: option '--n' is ambiguous; possibilities: '--no-create' '--no-dereference'\nTry 'touch --help' for more information.\n" });
  expect(await run(["touch", "--version=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: option '--version' doesn't allow an argument\nTry 'touch --help' for more information.\n" });
  expect(await run(["touch", "--no-create=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: option '--no-create' doesn't allow an argument\nTry 'touch --help' for more information.\n" });
  expect(await run(["touch", "--time="])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `touch: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--time")}\nValid arguments are:\n  - ${diagnosticQuote("atime")}, ${diagnosticQuote("access")}, ${diagnosticQuote("use")}\n  - ${diagnosticQuote("mtime")}, ${diagnosticQuote("modify")}\nTry 'touch --help' for more information.\n`,
  });
  expect(await run(["touch", "--time=", "--help"])).toMatchObject(await systemRun(["touch", "--time=", "--help"]));
  expect(await run(["touch", "--time", "--help", "time-help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `touch: invalid argument ${diagnosticQuote("--help")} for ${diagnosticQuote("--time")}\nValid arguments are:\n  - ${diagnosticQuote("atime")}, ${diagnosticQuote("access")}, ${diagnosticQuote("use")}\n  - ${diagnosticQuote("mtime")}, ${diagnosticQuote("modify")}\nTry 'touch --help' for more information.\n`,
  });
  expect(await run(["touch", "--date", "--help", "date-help"])).toMatchObject(await systemRun(["/usr/bin/touch", "--date", "--help", "date-help"]));
  expect(await run(["touch", "--date=bogus", "ordinary-before-help", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: touch [OPTION]... FILE...\n") });
  expect(await run(["touch", "--no-c", "no-create-before-help", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: touch [OPTION]... FILE...\n") });
  expect(await run(["touch", "ordinary-before-help", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: touch [OPTION]... FILE...\n") });
  expect(await run(["touch", "-f", "ignored-f"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect((await stat(join(dir, "ignored-f"))).isFile()).toBe(true);
  await writeFile(join(dir, "touch-file-parent"), "parent");
  expect(await run(["touch", "touch-file-parent/"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: setting times of 'touch-file-parent/': Not a directory\n" });
  expect(await run(["touch", "-c", "touch-file-parent/new"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: setting times of 'touch-file-parent/new': Not a directory\n" });
  expect(await run(["touch", "touch'file-parent/new"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: cannot touch \"touch'file-parent/new\": No such file or directory\n" });
  expect(await run(["touch", "touch\nfile-parent/new"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: cannot touch 'touch'$'\\n''file-parent/new': No such file or directory\n" });
  expect(await run(["touch", "missing-touch-dir/"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: setting times of 'missing-touch-dir/': No such file or directory\n" });
  expect(await run(["touch", "missing'touch-dir/"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: setting times of \"missing'touch-dir/\": No such file or directory\n" });
  expect(await run(["touch", "missing\ntouch-dir/"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: setting times of 'missing'$'\\n''touch-dir/': No such file or directory\n" });
  expect(await run(["touch", "-c", "missing-touch-dir/"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["touch", "-d", "2020-01-02T03:04:05Z", "dated"])).toMatchObject({ code: 0 });
  expect(Math.trunc((await stat(join(dir, "dated"))).mtimeMs / 1000)).toBe(1577934245);
  expect(await run(["touch", "--time=a", "-d", "2020-01-02T03:04:05Z", "time-abbrev"])).toMatchObject({ code: 0 });
  expect(await run(["touch", "--d=2020-01-02T03:04:05Z", "prefix-dated"])).toMatchObject({ code: 0 });
  expect(Math.trunc((await stat(join(dir, "prefix-dated"))).mtimeMs / 1000)).toBe(1577934245);
  expect(await run(["touch", "-t", "202112312359.58", "stamp"])).toMatchObject({ code: 0 });
  const stamped = await stat(join(dir, "stamp"));
  expect(stamped.mtime.toISOString()).toBe("2021-12-31T12:59:58.000Z");
  expect(await run(["touch", "-t", "202001010000.0", "stamp"])).toMatchObject(await systemRun(["/usr/bin/touch", "-t", "202001010000.0", "stamp"]));
  expect(await run(["touch", "-t", "202001010000.00", "stamp"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["touch", "-t", "bad", "--help"])).toMatchObject(await systemRun(["/usr/bin/touch", "-t", "bad", "--help"]));
  expect(await run(["touch", "-tbad", "--help"])).toMatchObject(await systemRun(["/usr/bin/touch", "-tbad", "--help"]));
  expect(await run(["touch", "-d", "@0", "-t", "202001010101", "stamp"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: cannot specify times from more than one source\nTry 'touch --help' for more information.\n" });
  expect(await run(["touch", "-r", "dated", "-t", "202001010101", "stamp"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: cannot specify times from more than one source\nTry 'touch --help' for more information.\n" });
  expect(await run(["touch", "-d", "@0", "-t", "202001010101"])).toMatchObject({ code: 1, stdout: "", stderr: "touch: cannot specify times from more than one source\nTry 'touch --help' for more information.\n" });
  expect(await run(["touch", "-t", "197001010000.60", "leap"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0 });
  expect(await run(["stat", "--p=%.9Y\\n", "leap"])).toMatchObject({ code: 0, stdout: "60.000000000\n" });
  await writeFile(join(dir, "target"), "x");
  expect(await run(["touch", "-r", "dated", "target"])).toMatchObject({ code: 0 });
  expect(Math.trunc((await stat(join(dir, "target"))).mtimeMs / 1000)).toBe(1577934245);
  await writeFile(join(dir, "reference-ns"), "ref");
  await writeFile(join(dir, "target-ns"), "target");
  await systemRun(["/usr/bin/touch", "-a", "-d", "2026-01-01 01:02:03.111111111 +0000", "reference-ns"]);
  await systemRun(["/usr/bin/touch", "-m", "-d", "2026-01-02 03:04:05.222222222 +0000", "reference-ns"]);
  expect(await run(["touch", "-r", "reference-ns", "target-ns"])).toMatchObject({ code: 0 });
  expect(await run(["stat", "-c", "%x|%y", "target-ns"], "", { env: { TZ: "UTC0" } })).toMatchObject({
    code: 0,
    stdout: "2026-01-01 01:02:03.111111111 +0000|2026-01-02 03:04:05.222222222 +0000\n",
  });
  await writeFile(join(dir, "reference-negative-ns"), "ref");
  await writeFile(join(dir, "target-negative-ns"), "target");
  await systemRun(["/usr/bin/touch", "-a", "-d", "1969-12-31 23:59:58.876543211 +0000", "reference-negative-ns"]);
  await systemRun(["/usr/bin/touch", "-m", "-d", "1969-12-31 23:59:59.123456789 +0000", "reference-negative-ns"]);
  expect(await run(["touch", "-r", "reference-negative-ns", "target-negative-ns"])).toMatchObject({ code: 0 });
  expect(await run(["stat", "-c", "%x|%y", "target-negative-ns"], "", { env: { TZ: "UTC0" } })).toMatchObject({
    code: 0,
    stdout: "1969-12-31 23:59:58.876543211 +0000|1969-12-31 23:59:59.123456789 +0000\n",
  });
  expect(await run(["touch", "--ref=dated", "--date=-5 days", "target"])).toMatchObject({ code: 0 });
  expect(Math.trunc((await stat(join(dir, "target"))).mtimeMs / 1000)).toBe(1577502245);
  const beforePastHour = Date.now() - 3600_000;
  expect(await run(["touch", "-d", "-1 hour", "past-hour"])).toMatchObject({ code: 0 });
  const pastHourDelta = Math.abs((await stat(join(dir, "past-hour"))).mtimeMs - beforePastHour);
  expect(pastHourDelta).toBeLessThan(10_000);
  const beforeFutureHour = Date.now() + 3600_000;
  expect(await run(["touch", "-d", "+1 hour", "future-hour"])).toMatchObject({ code: 0 });
  const futureHourDelta = Math.abs((await stat(join(dir, "future-hour"))).mtimeMs - beforeFutureHour);
  expect(futureHourDelta).toBeLessThan(10_000);
  const beforeYesterday = Date.now() - 86400_000;
  expect(await run(["touch", "-d", "yesterday", "yesterday-file"])).toMatchObject({ code: 0 });
  expect(Math.abs((await stat(join(dir, "yesterday-file"))).mtimeMs - beforeYesterday)).toBeLessThan(10_000);
  expect(await run(["touch", "-d", "2026-06-15 +01 month", "plus-month"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "plus-month"))).mtime.toISOString().startsWith("2026-07-15")).toBe(true);
  expect(await run(["touch", "-d", "2026-06-15 -1 year", "minus-year"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "minus-year"))).mtime.toISOString().startsWith("2025-06-15")).toBe(true);
  expect(await run(["touch", "-r", "dated", "target"])).toMatchObject({ code: 0 });
  expect(await run(["touch", "-a", "-d", "2022-01-02T03:04:05Z", "target"])).toMatchObject({ code: 0 });
  const accessOnly = await stat(join(dir, "target"));
  expect(Math.trunc(accessOnly.mtimeMs / 1000)).toBe(1577934245);
  expect(Math.trunc(accessOnly.atimeMs / 1000)).toBe(1641092645);
  expect(await run(["touch", "--time=mtime", "-d", "2023-01-02T03:04:05Z", "target"])).toMatchObject({ code: 0 });
  const modifyOnly = await stat(join(dir, "target"));
  expect(Math.trunc(modifyOnly.atimeMs / 1000)).toBe(1641092645);
  expect(Math.trunc(modifyOnly.mtimeMs / 1000)).toBe(1672628645);
  expect(await run(["touch", "--time=bogus", "target"])).toMatchObject({
    code: 1,
    stderr: `touch: invalid argument ${diagnosticQuote("bogus")} for ${diagnosticQuote("--time")}\nValid arguments are:\n  - ${diagnosticQuote("atime")}, ${diagnosticQuote("access")}, ${diagnosticQuote("use")}\n  - ${diagnosticQuote("mtime")}, ${diagnosticQuote("modify")}\nTry 'touch --help' for more information.\n`,
  });
  expect(await run(["touch", "-d", "bogus", "target"])).toMatchObject(await systemRun(["/usr/bin/touch", "-d", "bogus", "target"]));
  expect(await run(["touch", "-r", "missing-ref", "target"])).toMatchObject({ code: 1, stderr: "touch: failed to get attributes of 'missing-ref': No such file or directory\n" });
  expect(await run(["touch", "-h", "missing-link"])).toMatchObject({ code: 1, stderr: "touch: setting times of 'missing-link': No such file or directory\n" });
  expect(await run(["touch", "-h", "missing'link"])).toMatchObject({ code: 1, stderr: "touch: setting times of \"missing'link\": No such file or directory\n" });
  expect(await run(["touch", "-h", "missing\nlink"])).toMatchObject({ code: 1, stderr: "touch: setting times of 'missing'$'\\n''link': No such file or directory\n" });
  await writeFile(join(dir, "link-target"), "x");
  await symlink("link-target", join(dir, "link"));
  expect(await run(["touch", "-h", "-d", "2024-01-02T03:04:05Z", "link"])).toMatchObject({ code: 0 });
  expect(Math.trunc((await lstat(join(dir, "link"))).mtimeMs / 1000)).toBe(1704164645);
  expect(Math.trunc((await stat(join(dir, "link-target"))).mtimeMs / 1000)).not.toBe(1704164645);
  await symlink("missing-target", join(dir, "dangling-touch-ref"));
  expect(await run(["touch", "-h", "-r", "dangling-touch-ref", "target"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "target"))).isFile()).toBe(true);
  const touchStdout = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "touch", "-h", "-"], {
    cwd: dir,
    stdin: "ignore",
    stdout: Bun.file(join(dir, "touch-stdout")),
    stderr: "pipe",
  });
  expect(await touchStdout.exited).toBe(0);
  expect(await new Response(touchStdout.stderr).text()).toBe("");
  expect((await stat(join(dir, "touch-stdout"))).isFile()).toBe(true);
  expect(await run(["touch", "01010000", "legacy"], "", { env: { POSIXLY_CORRECT: "1", _POSIX2_VERSION: "199209" } })).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "01010000"))).rejects.toThrow();
  expect((await stat(join(dir, "legacy"))).isFile()).toBe(true);
});

test("sort, uniq, cut, paste and comm handle common text workflows", async () => {
  await writeFile(join(dir, "words"), "b\nA\na\nb\n");
  expect(await run(["sort", "-f", "words"])).toMatchObject({ code: 0, stdout: "A\na\nb\nb\n" });
  expect(await run(["sort", "-u", "words"])).toMatchObject({ code: 0, stdout: "A\na\nb\n" });
  await mkdir(join(dir, "sort-dir"));
  expect(await run(["sort", "sort-dir"])).toMatchObject({ code: 2, stdout: "", stderr: "sort: read failed: sort-dir: Is a directory\n" });
  expect(await run(["uniq", "-c"], "a\na\nb\n")).toMatchObject({ code: 0, stdout: "      2 a\n      1 b\n" });
  expect(await run(["uniq", "--c"], "a\na\nb\n")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "uniq: option '--c' is ambiguous; possibilities: '--count' '--check-chars'\nTry 'uniq --help' for more information.\n",
  });
  expect(await run(["uniq", "--bad", "--help"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: "uniq: unrecognized option '--bad'\nTry 'uniq --help' for more information.\n" });
  expect(await run(["uniq", "--version=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: option '--version' doesn't allow an argument\nTry 'uniq --help' for more information.\n" });
  expect(await run(["uniq", "-f", "1"], "1 alpha\n2 alpha\n3 beta\n")).toMatchObject({ code: 0, stdout: "1 alpha\n3 beta\n" });
  expect(await run(["uniq", "--skip-fields", "--help"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: "uniq: --help: invalid number of fields to skip\n" });
  expect(await run(["uniq", "--skip-fields=bad", "--help"], "a\n")).toMatchObject(await systemRun(["uniq", "--skip-fields=bad", "--help"], "a\n"));
  expect(await run(["uniq", "--skip-fields", "bad", "--help"], "a\n")).toMatchObject(await systemRun(["uniq", "--skip-fields", "bad", "--help"], "a\n"));
  expect(await run(["uniq", "--skip-chars=bad", "--help"], "a\n")).toMatchObject(await systemRun(["uniq", "--skip-chars=bad", "--help"], "a\n"));
  expect(await run(["uniq", "--check-chars=bad", "--help"], "a\n")).toMatchObject(await systemRun(["uniq", "--check-chars=bad", "--help"], "a\n"));
  expect(await run(["uniq", "-fbad", "--help"], "a\n")).toMatchObject(await systemRun(["uniq", "-fbad", "--help"], "a\n"));
  expect(await run(["uniq", "-f", "bad", "--help"], "a\n")).toMatchObject(await systemRun(["uniq", "-f", "bad", "--help"], "a\n"));
  expect(await run(["uniq", "-sbad", "--help"], "a\n")).toMatchObject(await systemRun(["uniq", "-sbad", "--help"], "a\n"));
  expect(await run(["uniq", "-wbad", "--help"], "a\n")).toMatchObject(await systemRun(["uniq", "-wbad", "--help"], "a\n"));
  expect(await run(["uniq", "--skip-fields=1", "--help"], "a\n")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: uniq [OPTION]... [INPUT [OUTPUT]]\n") });
  expect(await run(["uniq", "-f", "1", "--help"], "a\n")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: uniq [OPTION]... [INPUT [OUTPUT]]\n") });
  expect(await run(["uniq", "uniq-missing", "--help"], "a\n")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: uniq [OPTION]... [INPUT [OUTPUT]]\n"), stderr: "" });
  expect(await run(["uniq", "-s", "2", "-w", "3"], "xxabc1\nyyabc2\nzzdef\n")).toMatchObject({ code: 0, stdout: "xxabc1\nzzdef\n" });
  expect(await run(["uniq", "--check=1"], "aa\nab\n")).toMatchObject({ code: 0, stdout: "aa\n" });
  expect(await run(["uniq", "-D"], "a\na\nb\nc\nc\nc\n")).toMatchObject({ code: 0, stdout: "a\na\nc\nc\nc\n" });
  expect(await run(["uniq", "--all-repeated=separate"], "a\na\nb\nc\nc\n")).toMatchObject({ code: 0, stdout: "a\na\n\nc\nc\n" });
  expect(await run(["uniq", "--all=separate"], "a\na\nb\nb\n")).toMatchObject({ code: 0, stdout: "a\na\n\nb\nb\n" });
  expect(await run(["uniq", "--group="], "a\n")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `uniq: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--group")}\nValid arguments are:\n  - ${diagnosticQuote("prepend")}\n  - ${diagnosticQuote("append")}\n  - ${diagnosticQuote("separate")}\n  - ${diagnosticQuote("both")}\nTry 'uniq --help' for more information.\n`,
  });
  expect(await run(["uniq", "--all-repeated="], "a\n")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `uniq: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--all-repeated")}\nValid arguments are:\n  - ${diagnosticQuote("none")}\n  - ${diagnosticQuote("prepend")}\n  - ${diagnosticQuote("separate")}\nTry 'uniq --help' for more information.\n`,
  });
  expect(await run(["uniq", "--group=bad", "--help"], "a\n")).toMatchObject(await systemRun(["uniq", "--group=bad", "--help"], "a\n"));
  expect(await run(["uniq", "-D", "--group=bad"], "a\n")).toMatchObject(await systemRun(["uniq", "-D", "--group=bad"], "a\n"));
  expect(await run(["uniq", "--all-repeated=bad\nmode"], "a\n")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `uniq: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--all-repeated")}\nValid arguments are:\n  - ${diagnosticQuote("none")}\n  - ${diagnosticQuote("prepend")}\n  - ${diagnosticQuote("separate")}\nTry 'uniq --help' for more information.\n`,
  });
  expect(await run(["uniq", "--group=both", "--help"], "a\n")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: uniq [OPTION]... [INPUT [OUTPUT]]\n") });
  expect(await run(["uniq", "-1"], "a a\nb a\n")).toMatchObject({ code: 0, stdout: "a a\n" });
  expect(await run(["uniq", "+1"], "baa\naaa\n")).toMatchObject({ code: 0, stdout: "baa\n" });
  expect(await run(["uniq", "-f", "+1"], "1 alpha\n2 alpha\n3 beta\n")).toMatchObject({ code: 0, stdout: "1 alpha\n3 beta\n" });
  expect(await run(["uniq", "-f", "10000000000"], "1\n2\n3\n")).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["uniq", "-f", "-1"])).toMatchObject({ code: 1, stderr: "uniq: -1: invalid number of fields to skip\n" });
  expect(await run(["uniq", "-s", "x"])).toMatchObject({ code: 1, stderr: "uniq: x: invalid number of bytes to skip\n" });
  expect(await run(["uniq", "-w", "x"])).toMatchObject({ code: 1, stderr: "uniq: x: invalid number of bytes to compare\n" });
  expect(await run(["uniq", "-d", "-u"], "a\na\n\b")).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["uniq", "-D", "-c"], "a\na\n")).toMatchObject({ code: 1, stderr: "uniq: printing all duplicated lines and repeat counts is meaningless\nTry 'uniq --help' for more information.\n" });
  expect(await run(["uniq", "--all-repeated=badoption"], "a\n")).toMatchObject(await systemRun(["uniq", "--all-repeated=badoption"], "a\n"));
  expect(await run(["uniq", "--group"], "a\na\nb\nc\nc\n")).toMatchObject({ code: 0, stdout: "a\na\n\nb\n\nc\nc\n" });
  expect(await run(["uniq", "--group=both"], "a\na\nb\n")).toMatchObject({ code: 0, stdout: "\na\na\n\nb\n\n" });
  expect(await run(["uniq", "--all-repeated=append"], "a\na\n")).toMatchObject({ code: 1 });
  expect(await run(["uniq", "-z", "-i"], "A\0a\0b\0")).toMatchObject({ code: 0, stdout: "A\0b\0" });
  await writeFile(join(dir, "uniq-in"), "a\na\nb\n");
  expect(await run(["uniq", "uniq-in", "uniq-out"])).toMatchObject({ code: 0, stdout: "" });
  expect(await readFile(join(dir, "uniq-out"), "utf8")).toBe("a\nb\n");
  expect(await run(["uniq", "uniq-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: uniq-missing: No such file or directory\n" });
  expect(await run(["uniq", "missing'uniq"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: \"missing'uniq\": No such file or directory\n" });
  expect(await run(["uniq", "missing\nuniq"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: 'missing'$'\\n''uniq': No such file or directory\n" });
  await mkdir(join(dir, "uniq-dir"));
  expect(await run(["uniq", "uniq-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: error reading 'uniq-dir': Is a directory\n" });
  await mkdir(join(dir, "dir'uniq"));
  expect(await run(["uniq", "dir'uniq"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: error reading \"dir'uniq\": Is a directory\n" });
  await symlink("uniq-input-loop", join(dir, "uniq-input-loop"));
  expect(await run(["uniq", "uniq-input-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: uniq-input-loop: Too many levels of symbolic links\n" });
  await symlink("loop'uniq", join(dir, "loop'uniq"));
  expect(await run(["uniq", "loop'uniq"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: \"loop'uniq\": Too many levels of symbolic links\n" });
  expect(await run(["uniq", "uniq-in", "uniq-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: uniq-dir: Is a directory\n" });
  expect(await run(["uniq", "uniq-in", "dir'uniq"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: \"dir'uniq\": Is a directory\n" });
  await symlink("uniq-loop", join(dir, "uniq-loop"));
  expect(await run(["uniq", "uniq-in", "uniq-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: uniq-loop: Too many levels of symbolic links\n" });
  await writeFile(join(dir, "parent'uniq"), "parent");
  expect(await run(["uniq", "uniq-in", "parent'uniq/out"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: \"parent'uniq/out\": Not a directory\n" });
  expect(await run(["uniq", "uniq-in", "uniq-missing-dir/out"])).toMatchObject({ code: 1, stdout: "", stderr: "uniq: uniq-missing-dir/out: No such file or directory\n" });
  expect(await run(["uniq", "uniq-in", "uniq-out", "extra"])).toMatchObject({ code: 1, stderr: `uniq: extra operand ${diagnosticQuote("extra")}\nTry 'uniq --help' for more information.\n` });
  expect(await run(["uniq", "uniq-in", "uniq-out", "extra\narg"])).toMatchObject({ code: 1, stderr: `uniq: extra operand ${diagnosticQuote("extra\\narg")}\nTry 'uniq --help' for more information.\n` });
  await writeFile(join(dir, "uniq-invalid"), Uint8Array.of(0x20, 0x79, 0x20, 0x7a, 0x0a, 0xa0, 0x20, 0x79, 0x20, 0x7a, 0x0a));
  const uniqInvalid = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "uniq", "-f1", "uniq-invalid"], {
    cwd: dir,
    stdin: "ignore",
    stdout: Bun.file(join(dir, "uniq-invalid-out")),
    stderr: "pipe",
  });
  expect(await uniqInvalid.exited).toBe(0);
  expect(await new Response(uniqInvalid.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "uniq-invalid-out"))]).toEqual([0x20, 0x79, 0x20, 0x7a, 0x0a, 0xa0, 0x20, 0x79, 0x20, 0x7a, 0x0a]);
  expect(await run(["cut", "-d", ",", "-f", "2"], "x,y,z\n1,2,3\n")).toMatchObject({ code: 0, stdout: "y\n2\n" });
  expect(await run(["cut", "--b=1"], "abc\n")).toMatchObject({ code: 0, stdout: "a\n" });
  expect(await run(["cut", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: cut OPTION... [FILE]...\n") });
  expect(await run(["cut", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("  -F\n") });
  expect(await run(["cut", "--v"])).toMatchObject({ code: 0, stdout: expect.stringContaining("bnu 9.11\n") });
  await writeFile(join(dir, "cut-meta"), "abc\n");
  expect(await run(["cut", "cut-meta", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: cut OPTION... [FILE]...\n"), stderr: "" });
  expect(await run(["cut", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "cut: unrecognized option '--bad'\nTry 'cut --help' for more information.\n" });
  expect(await run(["cut", "--help=1", "--version"])).toMatchObject({ code: 1, stdout: "", stderr: "cut: option '--help' doesn't allow an argument\nTry 'cut --help' for more information.\n" });
  expect(await run(["cut", "--version=1", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "cut: option '--version' doesn't allow an argument\nTry 'cut --help' for more information.\n" });
  expect(await run(["cut", "--c=1"], "abc\n")).toMatchObject({ code: 1, stdout: "", stderr: "cut: option '--c=1' is ambiguous; possibilities: '--characters' '--complement'\nTry 'cut --help' for more information.\n" });
  expect(await run(["cut", "--o=:", "-d", ",", "-f", "1,2"], "a,b,c\n")).toMatchObject({ code: 1, stdout: "", stderr: "cut: option '--o=:' is ambiguous; possibilities: '--only-delimited' '--output-delimiter'\nTry 'cut --help' for more information.\n" });
  expect(await run(["cut", "--only", "-d", ",", "-f", "1"], "plain\n")).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["cut", "--whitespace", "-f", "2"], "a b\n")).toMatchObject({ code: 0, stdout: "b\n" });
  expect(await run(["cut", "--whitespace=bad", "-f", "1"], "a b\n")).toMatchObject(await systemRun(["cut", "--whitespace=bad", "-f", "1"], "a b\n"));
  expect(await run(["cut", "--whitespace=bad", "--help"])).toMatchObject(await systemRun(["cut", "--whitespace=bad", "--help"]));
  expect(await run(["cut", "--whitespace=bad\nmode", "-f", "1"], "a b\n")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `cut: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--whitespace-delimited")}\nValid arguments are:\n  - ${diagnosticQuote("trimmed")}\nTry 'cut --help' for more information.\n`,
  });
  expect(await run(["cut", "--bytes", "--help"], "abc\n")).toMatchObject({ code: 1, stdout: "", stderr: "cut: invalid byte or character range\nTry 'cut --help' for more information.\n" });
  expect(await run(["cut", "-d", "ab", "--help"])).toMatchObject(await systemRun(["cut", "-d", "ab", "--help"]));
  expect(await run(["cut", "--delimiter=ab", "--help"])).toMatchObject(await systemRun(["cut", "--delimiter=ab", "--help"]));
  expect(await run(["cut", "--delimiter", "--help", "--version"])).toMatchObject({ code: 1, stdout: "", stderr: "cut: the delimiter must be a single character\nTry 'cut --help' for more information.\n" });
  expect(await run(["cut", "-d", "x", "-f", "1", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: cut OPTION... [FILE]...\n") });
  expect(await run(["cut", "--bytes=bad", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: cut OPTION... [FILE]...\n") });
  await writeFile(join(dir, "cut-in"), "one\ntwo\nthree\n");
  expect(await run(["cut", "-c", "1", "cut-missing-a", "cut-in", "cut-missing-b"])).toMatchObject({ code: 1, stdout: "o\nt\nt\n", stderr: "cut: cut-missing-a: No such file or directory\ncut: cut-missing-b: No such file or directory\n" });
  await mkdir(join(dir, "cut-dir"));
  expect(await run(["cut", "-c", "1", "cut-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "cut: cut-dir: Is a directory\n" });
  expect(await run(["cut", "-c", "1-2,5-", "--output-delimiter=:"], "abcdef\n")).toMatchObject({ code: 0, stdout: "ab:ef\n" });
  expect(await run(["cut", "-c", "2-4", "--complement"], "abcdef\n")).toMatchObject({ code: 0, stdout: "aef\n" });
  expect(await run(["cut", "-b", "1-2,5-", "--output-delimiter=:"], "abcdef\n")).toMatchObject({ code: 0, stdout: "ab:ef\n" });
  expect(await run(["cut", "-b", "+1"], "abcdef\n")).toMatchObject(await systemRun(["cut", "-b", "+1"], "abcdef\n"));
  expect(await run(["cut", "-b", "--"], "abcdef\n")).toMatchObject({ code: 1, stderr: "cut: invalid byte or character range\nTry 'cut --help' for more information.\n" });
  expect(await run(["cut", "-b", "18446744073709551614"], "abcdef\n")).toMatchObject({ code: 0, stdout: "\n" });
  expect(await run(["cut", "-b", "18446744073709551614-", "/dev/null"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["cut", "-b", "1-18446744073709551614", "/dev/null"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["cut", "-b", "18446744073709551615"], "abcdef\n")).toMatchObject(await systemRun(["cut", "-b", "18446744073709551615"], "abcdef\n"));
  expect(await run(["cut", "-b", "1-18446744073709551615"], "abcdef\n")).toMatchObject(await systemRun(["cut", "-b", "1-18446744073709551615"], "abcdef\n"));
  expect(await run(["cut", "-c", "1,a"], "abcdef\n")).toMatchObject(await systemRun(["cut", "-c", "1,a"], "abcdef\n"));
  expect(await run(["cut", "-b", "1-2x"], "abcdef\n")).toMatchObject(await systemRun(["cut", "-b", "1-2x"], "abcdef\n"));
  expect(await run(["cut", "-s", "-d", ":", "-f", "2", "--output-delimiter=/"], "plain\na:b:c\n")).toMatchObject({ code: 0, stdout: "b\n" });
  expect(await run(["cut", "-d", ":", "-f", "+1"], "a:b:c\n")).toMatchObject(await systemRun(["cut", "-d", ":", "-f", "+1"], "a:b:c\n"));
  expect(await run(["cut", "-f", "--"], "a:b:c\n")).toMatchObject({ code: 1, stderr: "cut: invalid field range\nTry 'cut --help' for more information.\n" });
  expect(await run(["cut", "-f", "18446744073709551615"], "a:b:c\n")).toMatchObject(await systemRun(["cut", "-f", "18446744073709551615"], "a:b:c\n"));
  expect(await run(["cut", "-d", ":", "-f", "1-2x"], "a:b:c\n")).toMatchObject(await systemRun(["cut", "-d", ":", "-f", "1-2x"], "a:b:c\n"));
  expect(await run(["cut", "-c", "4"], "123\n")).toMatchObject({ code: 0, stdout: "\n" });
  expect(await run(["cut", "-c", "1"], "x")).toMatchObject({ code: 0, stdout: "x\n" });
  expect(await run(["cut", "-d", ":", "--out=_", "-f", "2,3"], "a:b:c\n")).toMatchObject({ code: 0, stdout: "b_c\n" });
  expect(await run(["cut", "-b", "1-2,3-4", "--output-d=:"], "abcd\n")).toMatchObject({ code: 0, stdout: "ab:cd\n" });
  expect(await run(["cut", "-c", "1-3,2-4,6", "--output-d=:"], "abcdefg\n")).toMatchObject({ code: 0, stdout: "abcd:f\n" });
  const cutChunkBoundary = "a".repeat(65536);
  expect(await run(["cut", "-f1"], cutChunkBoundary)).toMatchObject({ code: 0, stdout: `${cutChunkBoundary}\n` });
  expect(await run(["cut", "-s", "-d", ":", "-f2"], `${cutChunkBoundary}:value`)).toMatchObject({ code: 0, stdout: "value\n" });
  expect(await run(["cut", "-b", "65535-65536,65538-65539", "--output-delimiter=:"], `${cutChunkBoundary}bcde\n`)).toMatchObject({ code: 0, stdout: "aa:cd\n" });
  expect(await run(["cut", "-d", "", "-f", "2"], "a\0b\0c\n")).toMatchObject({ code: 0, stdout: "b\n" });
  expect(await run(["cut", "-d", "", "--out=_", "-f", "2,3"], "a\0b\0c\n")).toMatchObject({ code: 0, stdout: "b_c\n" });
  expect(await run(["cut", "-d", "\n", "-f", "1,2", "--ou=:"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a:b\n" });
  expect(await run(["cut", "-d'\n'", "-f1"], "a:1\nb:")).toMatchObject({ code: 0, stdout: "a:1\n" });
  expect(await run(["cut", "-F", "2,3", "-d", ","], "1,2,3\n")).toMatchObject({ code: 0, stdout: "2 3\n" });
  expect(await run(["cut", "-s", "-d", ":", "-f", "3-"], ":::\n:1\n")).toMatchObject({ code: 0, stdout: ":\n\n" });
  expect(await run(["cut", "-s", "--whitespace-delimited=trimmed", "-f", "1"], "  a  \n")).toMatchObject({ code: 0, stdout: "" });
  const badCutDelimiter = await run(["cut", "-d", ":", "-b", "1"], "a:b\n");
  expect(badCutDelimiter).toMatchObject({ code: 1 });
  expect(badCutDelimiter.stderr).toContain("an input delimiter makes sense");
  const badCutSuppress = await run(["cut", "-s", "-b", "1"], "abc\n");
  expect(badCutSuppress).toMatchObject({ code: 1 });
  expect(badCutSuppress.stderr).toContain("suppressing non-delimited lines");
  expect(await run(["cut", "-b", "1", "-f", "1"])).toMatchObject({ code: 1, stderr: "cut: only one list may be specified\nTry 'cut --help' for more information.\n" });
  expect(await run(["cut", "-z", "-d", ":", "-f", "1"], "a:b\0c:d\0")).toMatchObject({ code: 0, stdout: "a\0c\0" });
  expect(await run(["cut", "-w", "-f", "2,3"], "  alpha   beta gamma  \nplain\n")).toMatchObject({ code: 0, stdout: "alpha\tbeta\nplain\n" });
  expect(await run(["cut", "--whitespace-delimited=trimmed", "-f", "1,2"], "  alpha   beta gamma  \n")).toMatchObject({ code: 0, stdout: "alpha\tbeta\n" });
  expect(await run(["cut", "-F", "2,3"], "  alpha   beta gamma  \nplain\n")).toMatchObject({ code: 0, stdout: "alpha beta\nplain\n" });
  expect(await run(["cut", "-w", "-s", "-f", "2"], "  alpha   beta\nplain\n")).toMatchObject({ code: 0, stdout: "alpha\n" });
  expect(await run(["cut", "-d", ":", "-f", "1", "missing'cut"])).toMatchObject({ code: 1, stdout: "", stderr: "cut: \"missing'cut\": No such file or directory\n" });
  expect(await run(["cut", "-d", ":", "-f", "1", "missing\ncut"])).toMatchObject({ code: 1, stdout: "", stderr: "cut: 'missing'$'\\n''cut': No such file or directory\n" });
  await mkdir(join(dir, "dir'cut"));
  expect(await run(["cut", "-d", ":", "-f", "1", "dir'cut"])).toMatchObject({ code: 1, stdout: "", stderr: "cut: \"dir'cut\": Is a directory\n" });
  await writeFile(join(dir, "cut-raw-char"), Uint8Array.of(0xff, 0x61, 0x0a));
  const cutRawChar = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "cut", "-c1", "cut-raw-char"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "cut-raw-char-out")),
    stderr: "pipe",
  });
  expect(await cutRawChar.exited).toBe(0);
  expect(await new Response(cutRawChar.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "cut-raw-char-out"))]).toEqual([0xff, 0x0a]);
  const cutRawCharStdin = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "cut", "-c1"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: Bun.file(join(dir, "cut-raw-char")),
    stdout: Bun.file(join(dir, "cut-raw-char-stdin-out")),
    stderr: "pipe",
  });
  expect(await cutRawCharStdin.exited).toBe(0);
  expect(await new Response(cutRawCharStdin.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "cut-raw-char-stdin-out"))]).toEqual([0xff, 0x0a]);
  await writeFile(join(dir, "cut-raw-field"), Uint8Array.of(0xff, 0x3a, 0xfe, 0x0a));
  const cutRawField = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "cut", "-d:", "-f2", "cut-raw-field"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "cut-raw-field-out")),
    stderr: "pipe",
  });
  expect(await cutRawField.exited).toBe(0);
  expect(await new Response(cutRawField.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "cut-raw-field-out"))]).toEqual([0xfe, 0x0a]);
  expect(await shell(`bash -c 'delim=$(printf "\\242\\343"); printf "1\${delim}2\${delim}3\\n" | LC_ALL=zh_CN.gb18030 "$BUN" "$BNU" cut -d "$delim" -f2,3 --output-delimiter=_ | /usr/bin/od -An -tx1 | tr -d " \\n"'`)).toMatchObject({ code: 0, stdout: "325f330a", stderr: "" });
  expect(await shell(`bash -c 'delim=$(printf "\\377"); printf "1\${delim}2\${delim}3\\n" | LC_ALL=zh_CN.gb18030 "$BUN" "$BNU" cut -d "$delim" -f2,3 --output-delimiter=_ | /usr/bin/od -An -tx1 | tr -d " \\n"'`)).toMatchObject({ code: 0, stdout: "325f330a", stderr: "" });
  await writeFile(join(dir, "left"), "a\nb\nc\n");
  await writeFile(join(dir, "right"), "1\n2\n");
  expect(await run(["paste", "left", "right"])).toMatchObject({ code: 0, stdout: "a\t1\nb\t2\nc\t\n" });
  expect(await run(["paste", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: paste [OPTION]... [FILE]...\n") });
  expect(await run(["paste", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Write lines consisting of the sequentially corresponding lines from\n") });
  expect(await run(["paste", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["paste", "left", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: paste [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["paste", "--se"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a\tb\n" });
  expect(await run(["paste", "--z"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a\nb\n\0" });
  expect(await run(["paste", "--del=,", "left", "right"])).toMatchObject({ code: 0, stdout: "a,1\nb,2\nc,\n" });
  expect(await run(["paste", "--delimiters=,", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: paste [OPTION]... [FILE]...\n") });
  expect(await run(["paste", "--delimiters=\\", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: paste [OPTION]... [FILE]...\n") });
  expect(await run(["paste", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "paste: unrecognized option '--bad'\nTry 'paste --help' for more information.\n" });
  expect(await run(["paste", "-x", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "paste: invalid option -- 'x'\nTry 'paste --help' for more information.\n" });
  expect(await run(["paste", "--h=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "paste: option '--help' doesn't allow an argument\nTry 'paste --help' for more information.\n" });
  expect(await run(["paste", "--se=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "paste: option '--serial' doesn't allow an argument\nTry 'paste --help' for more information.\n" });
  expect(await run(["paste", "--delimiters", "--help"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  await writeFile(join(dir, "third"), "x\ny\nz\n");
  expect(await run(["paste", "-d", ",:", "left", "right", "third"])).toMatchObject({ code: 0, stdout: "a,1:x\nb,2:y\nc,:z\n" });
  expect(await run(["paste", "left", "paste-missing", "right"])).toMatchObject({ code: 1, stdout: "", stderr: "paste: paste-missing: No such file or directory\n" });
  expect(await run(["paste", "missing'paste"])).toMatchObject({ code: 1, stdout: "", stderr: "paste: \"missing'paste\": No such file or directory\n" });
  expect(await run(["paste", "missing\npaste"])).toMatchObject({ code: 1, stdout: "", stderr: "paste: 'missing'$'\\n''paste': No such file or directory\n" });
  await mkdir(join(dir, "paste-dir"));
  await symlink("paste-loop", join(dir, "paste-loop"));
  expect(await run(["paste", "paste-dir", "paste-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "paste: paste-dir: Is a directory\npaste: paste-dir: Is a directory\n" });
  await mkdir(join(dir, "dir'paste"));
  expect(await run(["paste", "dir'paste"])).toMatchObject({ code: 1, stdout: "", stderr: "paste: \"dir'paste\": Is a directory\n" });
  expect(await run(["paste", "paste-dir", "right"])).toMatchObject({ code: 1, stdout: "\t1\n\t2\n", stderr: "paste: paste-dir: Is a directory\n" });
  expect(await run(["paste", "left", "paste-dir", "right"])).toMatchObject({ code: 1, stdout: "a\t\t1\nb\t\t2\nc\t\t\n", stderr: "paste: paste-dir: Is a directory\n" });
  expect(await run(["paste", "paste-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "paste: paste-loop: Too many levels of symbolic links\n" });
  expect(await run(["paste", "-", "-"], "a\nb\nc\nd\n")).toMatchObject({ code: 0, stdout: "a\tb\nc\td\n" });
  expect(await run(["paste"], "")).toMatchObject({ code: 0, stdout: "" });
  await writeFile(join(dir, "left0"), "a\0b\0");
  await writeFile(join(dir, "right0"), "1\02\0");
  expect(await run(["paste", "-z", "-d", ":", "left0", "right0"])).toMatchObject({ code: 0, stdout: "a:1\02\0b:\0" });
  await writeFile(join(dir, "paste-raw-left"), Uint8Array.of(0xff, 0x0a));
  await writeFile(join(dir, "paste-raw-right"), "x\n");
  const pasteRaw = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "paste", "paste-raw-left", "paste-raw-right"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "paste-raw-out")),
    stderr: "pipe",
  });
  expect(await pasteRaw.exited).toBe(0);
  expect(await new Response(pasteRaw.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "paste-raw-out"))]).toEqual([0xff, 0x09, 0x78, 0x0a]);
  const pasteRawSerial = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "paste", "-s", "paste-raw-left"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "paste-raw-serial-out")),
    stderr: "pipe",
  });
  expect(await pasteRawSerial.exited).toBe(0);
  expect(await new Response(pasteRawSerial.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "paste-raw-serial-out"))]).toEqual([0xff, 0x0a]);
  await writeFile(join(dir, "paste-raw0-left"), Uint8Array.of(0xff, 0x00));
  await writeFile(join(dir, "paste-raw0-right"), Uint8Array.of(0x78, 0x00));
  const pasteRaw0 = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "paste", "-z", "paste-raw0-left", "paste-raw0-right"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "paste-raw0-out")),
    stderr: "pipe",
  });
  expect(await pasteRaw0.exited).toBe(0);
  expect(await new Response(pasteRaw0.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "paste-raw0-out"))]).toEqual([0xff, 0x09, 0x78, 0x00]);
  expect(await run(["paste", "-s", "-d", "\\t"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a\tb\n" });
  expect(await run(["paste", "-s", "left", "paste-missing-a", "right", "paste-missing-b"])).toMatchObject({ code: 1, stdout: "a\tb\tc\n1\t2\n", stderr: "paste: paste-missing-a: No such file or directory\npaste: paste-missing-b: No such file or directory\n" });
  expect(await run(["paste", "-s", "paste-dir", "left"])).toMatchObject({ code: 1, stdout: "\na\tb\tc\n", stderr: "paste: paste-dir: Is a directory\n" });
  expect(await run(["paste", "-s", "-d", "\\b"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a\bb\n" });
  expect(await run(["paste", "-s", "-d", "\\f"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a\fb\n" });
  expect(await run(["paste", "-s", "-d", "\\r"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a\rb\n" });
  expect(await run(["paste", "-s", "-d", "\\v"], "a\nb\n")).toMatchObject({ code: 0, stdout: "a\vb\n" });
  expect(await run(["paste", "-d", "\\"])).toMatchObject({ code: 1, stderr: "paste: delimiter list ends with an unescaped backslash: \\\n" });
  await writeFile(join(dir, "c1"), "a\nb\n");
  await writeFile(join(dir, "c2"), "b\nc\n");
  expect(await run(["comm", "c1", "c2"])).toMatchObject({ code: 0, stdout: "a\n\t\tb\n\tc\n" });
  expect(await run(["comm", "--output-delimiter=|", "c1", "c2"])).toMatchObject({ code: 0, stdout: "a\n||b\n|c\n" });
  expect(await run(["comm", "--total", "c1", "c2"])).toMatchObject({ code: 0, stdout: "a\n\t\tb\n\tc\n1\t1\t1\ttotal\n" });
  expect(await run(["comm", "--h", "c1", "c2"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: comm [OPTION]... FILE1 FILE2\n") });
  expect(await run(["comm", "--v", "c1", "c2"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["comm", "c1", "c2", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n", stderr: "" });
  expect(await run(["comm", "--o=|", "c1", "c2"])).toMatchObject({ code: 0, stdout: "a\n||b\n|c\n" });
  expect(await run(["comm", "--output-delimiter=|", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: comm [OPTION]... FILE1 FILE2\n") });
  expect(await run(["comm", "--output-delimiter=|", "--output-delimiter=+", "--help"])).toMatchObject(await systemRun(["comm", "--output-delimiter=|", "--output-delimiter=+", "--help"]));
  expect(await run(["comm", "--output-delimiter", "|", "--output-delimiter", "+", "--help"])).toMatchObject(await systemRun(["comm", "--output-delimiter", "|", "--output-delimiter", "+", "--help"]));
  expect(await run(["comm", "--t", "c1", "c2"])).toMatchObject({ code: 0, stdout: "a\n\t\tb\n\tc\n1\t1\t1\ttotal\n" });
  expect(await run(["comm", "--z", "cz-missing-a", "cz-missing-b"])).toMatchObject({ code: 1, stdout: "", stderr: "comm: cz-missing-a: No such file or directory\n" });
  expect(await run(["comm", "--bad", "--help", "c1", "c2"])).toMatchObject({ code: 1, stdout: "", stderr: "comm: unrecognized option '--bad'\nTry 'comm --help' for more information.\n" });
  expect(await run(["comm", "-x", "--help", "c1", "c2"])).toMatchObject({ code: 1, stdout: "", stderr: "comm: invalid option -- 'x'\nTry 'comm --help' for more information.\n" });
  expect(await run(["comm", "--h=foo", "c1", "c2"])).toMatchObject({ code: 1, stdout: "", stderr: "comm: option '--help' doesn't allow an argument\nTry 'comm --help' for more information.\n" });
  expect(await run(["comm", "--t=foo", "c1", "c2"])).toMatchObject({ code: 1, stdout: "", stderr: "comm: option '--total' doesn't allow an argument\nTry 'comm --help' for more information.\n" });
  expect(await run(["comm", "--output-delimiter", "--help", "c1", "c2"])).toMatchObject({ code: 0, stdout: "a\n--help--helpb\n--helpc\n" });
  const commHelp = (await run(["comm", "--help"])).stdout;
  for (const option of ["-1", "-2", "-3"]) expect(commHelp).toContain(`  ${option}\n`);
  expect(await run(["comm", "c1"])).toMatchObject({ code: 1, stderr: "comm: missing operand after 'c1'\nTry 'comm --help' for more information.\n" });
  expect(await run(["comm", "c1", "c2", "extra"])).toMatchObject({ code: 1, stderr: `comm: extra operand ${diagnosticQuote("extra")}\nTry 'comm --help' for more information.\n` });
  expect(await run(["comm", "c1", "c2", "extra\narg"])).toMatchObject({ code: 1, stderr: `comm: extra operand ${diagnosticQuote("extra\\narg")}\nTry 'comm --help' for more information.\n` });
  expect(await run(["comm", "comm-missing", "c2"])).toMatchObject({ code: 1, stdout: "", stderr: "comm: comm-missing: No such file or directory\n" });
  expect(await run(["comm", "c1", "comm-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "comm: comm-missing: No such file or directory\n" });
  expect(await run(["comm", "missing'comm", "c2"])).toMatchObject({ code: 1, stdout: "", stderr: "comm: \"missing'comm\": No such file or directory\n" });
  expect(await run(["comm", "c1", "missing\ncomm"])).toMatchObject({ code: 1, stdout: "", stderr: "comm: 'missing'$'\\n''comm': No such file or directory\n" });
  await mkdir(join(dir, "comm-dir"));
  expect(await run(["comm", "comm-dir", "c2"])).toMatchObject({ code: 1, stdout: "", stderr: "comm: comm-dir: Is a directory\n" });
  expect(await run(["comm", "c1", "comm-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "comm: comm-dir: Is a directory\n" });
  await mkdir(join(dir, "dir'comm"));
  expect(await run(["comm", "dir'comm", "c2"])).toMatchObject({ code: 1, stdout: "", stderr: "comm: \"dir'comm\": Is a directory\n" });
  expect(await run(["comm", "--output-delimiter=", "c1", "c2"])).toMatchObject({ code: 0, stdout: "a\n\0\0b\n\0c\n" });
  expect(await run(["comm", "--output-delimiter=,", "--output-delimiter=+", "c1", "c2"])).toMatchObject({ code: 1, stderr: "comm: multiple output delimiters specified\n" });
  await writeFile(join(dir, "comm-blank"), "\n");
  expect(await run(["comm", "comm-blank", "c1"])).toMatchObject({ code: 0, stdout: "\n\ta\n\tb\n" });
  expect(await run(["comm", "-", "-"], "a\nb\n")).toMatchObject({ code: 1, stdout: "a\n\tb\n", stderr: "comm: -\n" });
  expect(await run(["comm", "-", "-"], "a\na\n")).toMatchObject({ code: 1, stdout: "\t\ta\n", stderr: "comm: -\n" });
  await writeFile(join(dir, "comm-raw-left"), Uint8Array.of(0xff, 0x0a));
  await writeFile(join(dir, "comm-raw-right"), Uint8Array.of(0xfe, 0x0a));
  const commRaw = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "comm", "comm-raw-left", "comm-raw-right"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "comm-raw-out")),
    stderr: "pipe",
  });
  expect(await commRaw.exited).toBe(0);
  expect(await new Response(commRaw.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "comm-raw-out"))]).toEqual([0x09, 0xfe, 0x0a, 0xff, 0x0a]);
  await writeFile(join(dir, "cz1"), "a\0b\0");
  await writeFile(join(dir, "cz2"), "b\0c\0");
  expect(await run(["comm", "-z", "cz1", "cz2"])).toMatchObject({ code: 0, stdout: "a\0\t\tb\0\tc\0" });
  await writeFile(join(dir, "unsorted1"), "b\na\n");
  await writeFile(join(dir, "unsorted2"), "b\nc\n");
  expect(await run(["comm", "unsorted1", "unsorted2"])).toMatchObject({ code: 1 });
  expect(await run(["comm", "--nocheck-order", "unsorted1", "unsorted2"])).toMatchObject({ code: 0 });
  await writeFile(join(dir, "unsorted-paired-a"), "b\na\n");
  await writeFile(join(dir, "unsorted-paired-b"), "b\na\n");
  expect(await run(["comm", "unsorted-paired-a", "unsorted-paired-b"])).toMatchObject({ code: 0, stdout: "\t\tb\n\t\ta\n" });
  expect(await run(["comm", "--check-order", "unsorted-paired-a", "unsorted-paired-b"])).toMatchObject({ code: 1 });
});

test("sort supports common GNU comparison modes and output options", async () => {
  expect(await run(["sort", "-V"], "v2\nv10\nv1\n")).toMatchObject({ code: 0, stdout: "v1\nv2\nv10\n" });
  expect(await run(["sort", "-V"], "gcc-c++-10.8.12-0.7rc2.fc9.tar.bz2\ngcc-c++-10.fc9.tar.gz\n")).toMatchObject({ code: 0, stdout: "gcc-c++-10.fc9.tar.gz\ngcc-c++-10.8.12-0.7rc2.fc9.tar.bz2\n" });
  expect(await run(["sort", "-V"], "glibc-common-11-0.6rc2.ebuild\nglibc-common-11b.ebuild\nlibstdc++-4.10.4.20040204svn.rpm\nlibstdc++-4a.fc8.tar.gz\nnss_ldap-10.11.8.6.20040204cvs.fc10.ebuild\nnss_ldap-10beta1.fc8.tar.gz\n")).toMatchObject({ code: 0, stdout: "glibc-common-11b.ebuild\nglibc-common-11-0.6rc2.ebuild\nlibstdc++-4a.fc8.tar.gz\nlibstdc++-4.10.4.20040204svn.rpm\nnss_ldap-10beta1.fc8.tar.gz\nnss_ldap-10.11.8.6.20040204cvs.fc10.ebuild\n" });
  expect(await run(["sort", "-M"], "Mar\nJan\nFeb\n")).toMatchObject({ code: 0, stdout: "Jan\nFeb\nMar\n" });
  expect(await run(["sort", "-M"], "déc.\njanv.\naoût\nfévr.\n", { env: { LC_ALL: "fr_FR.utf8" } })).toMatchObject({
    code: 0,
    stdout: "janv.\nfévr.\naoût\ndéc.\n",
  });
  expect(await run(["sort", "-h"], "2K\n100\n1M\n")).toMatchObject({ code: 0, stdout: "100\n2K\n1M\n" });
  expect(await run(["sort", "-h"], "1K\n02\n1\n")).toMatchObject({ code: 0, stdout: "1\n02\n1K\n" });
  expect(await run(["sort", "-n"], "-18446744073709551615\n-18446744073709551616\n-922337203685477580.1\n-922337203685477580\n")).toMatchObject({ code: 0, stdout: "-18446744073709551616\n-18446744073709551615\n-922337203685477580.1\n-922337203685477580\n" });
  expect(await run(["sort", "-g"], "1.0e100\n1.0e-4932\n1.0e-308\n-1.0e100\n")).toMatchObject({ code: 0, stdout: "-1.0e100\n1.0e-4932\n1.0e-308\n1.0e100\n" });
  expect(await run(["sort", "-d"], "b-2\nb 1\nb_0\n")).toMatchObject({ code: 0, stdout: "b 1\nb_0\nb-2\n" });
  expect(await run(["sort"], "a_a\na b\n", { env: { LC_ALL: "en_US.iso88591" } })).toMatchObject({ code: 0, stdout: "a_a\na b\n" });
  expect(await run(["sort"], "é\ne\nE\nè\n", { env: { LC_ALL: "en_US.UTF-8" } })).toMatchObject({ code: 0, stdout: "e\nE\né\nè\n" });
  expect(await run(["sort", "-z"], "b\0a\0")).toMatchObject({ code: 0, stdout: "a\0b\0" });
  expect(await run(["sort", "-c"], "a\na\n")).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["sort", "-c"], "b\na\n")).toMatchObject({ code: 1, stderr: "sort: -:2: disorder: a\n" });
  const sortHelp = await run(["sort", "--help"]);
  expect(sortHelp).toMatchObject({ code: 0 });
  expect(sortHelp.stdout).toContain("  -c\n");
  expect(sortHelp.stdout).toContain("  -C\n");
  expect(await run(["sort", "-cu"], "a\na\n")).toMatchObject({ code: 1 });
  expect(await run(["sort", "-C"], "b\na\n")).toMatchObject({ code: 1, stdout: "", stderr: "" });
  expect(await run(["sort", "--check=quiet"], "b\na\n")).toMatchObject({ code: 1, stdout: "", stderr: "" });
  await writeFile(join(dir, "sort-random-source"), Buffer.from([1, 2, 3, 4, 16, 17, 18, 19, 24, 25, 26, 27, 32, 33, 34, 35, 40, 41, 42, 43, 48, 49, 50, 51]));
  const randomSort = await run(["sort", "-R", "--random-source=sort-random-source"], "1\n2\n3\n4\n5\n6\n");
  expect(randomSort).toMatchObject({ code: 0, stdout: "1\n3\n5\n2\n4\n6\n" });
  expect(await run(["sort", "-n"], randomSort.stdout)).toMatchObject({ code: 0, stdout: "1\n2\n3\n4\n5\n6\n" });
  const nbsp = 0xa0;
  const humanThousandsInput = Buffer.from([
    ...Buffer.from("1 1k 1 M 4"), nbsp, ...Buffer.from("003 1M\n"),
    ...Buffer.from("2k 2M 2 k 4"), nbsp, ...Buffer.from("002 2\n"),
    ...Buffer.from("3M 3 3 G 4"), nbsp, ...Buffer.from("001 3k\n"),
  ]);
  await writeFile(join(dir, "human-thousands"), humanThousandsInput);
  expect(await run(["sort", "-h", "-k", "5", "-o", "human-thousands-out", "human-thousands"], "", { env: { LC_ALL: "sv_SE" } })).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "human-thousands-out"))).toEqual(Buffer.from([
    ...Buffer.from("3M 3 3 G 4"), nbsp, ...Buffer.from("001 3k\n"),
    ...Buffer.from("2k 2M 2 k 4"), nbsp, ...Buffer.from("002 2\n"),
    ...Buffer.from("1 1k 1 M 4"), nbsp, ...Buffer.from("003 1M\n"),
  ]));
  await writeFile(join(dir, "unsorted"), "3\n1\n2\n");
  expect(await run(["sort", "-o", "sorted", "unsorted"])).toMatchObject({ code: 0, stdout: "" });
  expect(await readFile(join(dir, "sorted"), "utf8")).toBe("1\n2\n3\n");
  const sortFiles0Raw = Bun.spawn(["/bin/sh", "-c", `name=$(printf 'sort-\\377'); printf 'b\\na\\n' > "$name"; printf '%s\\0' "$name" > sort-files0-raw; LC_ALL=C ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} sort --files0-from=sort-files0-raw >sort-files0-raw-out`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await sortFiles0Raw.exited).toBe(0);
  expect(await new Response(sortFiles0Raw.stderr).text()).toBe("");
  expect(await readFile(join(dir, "sort-files0-raw-out"), "utf8")).toBe("a\nb\n");
  await writeFile(join(dir, "sort-check-bad"), "b\na\n");
  expect(await run(["sort", "-c", "sort-check-bad"])).toMatchObject({ code: 1, stderr: "sort: sort-check-bad:2: disorder: a\n" });
  expect(await run(["sort", "--check", "sort-check-bad"])).toMatchObject({ code: 1, stdout: "", stderr: "sort: sort-check-bad:2: disorder: a\n" });
  expect(await run(["sort", "--che", "sort-check-bad"])).toMatchObject({ code: 1, stdout: "", stderr: "sort: sort-check-bad:2: disorder: a\n" });
  expect(await run(["sort", "--check", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: sort [OPTION]... [FILE]...\n") });
  await writeFile(join(dir, "sort-a"), "b\n");
  await writeFile(join(dir, "sort-b"), "a");
  expect(await run(["sort", "-c", "sort-a", "sort-b"])).toMatchObject({ code: 2, stderr: "sort: extra operand 'sort-b' not allowed with -c\n" });
  expect(await run(["sort", "-C", "sort-a", "sort-b"])).toMatchObject({ code: 2, stderr: "sort: extra operand 'sort-b' not allowed with -C\n" });
  await writeFile(join(dir, "sort-list"), "sort-b\0sort-b\0sort-a\0");
  expect(await run(["sort", "--files0-from=sort-list"])).toMatchObject({ code: 0, stdout: "a\na\nb\n" });
  expect(await run(["sort", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: sort [OPTION]... [FILE]...\n  or:  sort [OPTION]... --files0-from=F\n") });
  expect(await run(["sort", "--he=bad", "sort-a"])).toMatchObject(await systemRun(["sort", "--he=bad", "sort-a"]));
  expect(await run(["sort", "--ver=bad", "sort-a"])).toMatchObject(await systemRun(["sort", "--ver=bad", "sort-a"]));
  expect(await run(["sort", "--buf=bad", "sort-a"])).toMatchObject(await systemRun(["sort", "--buf=bad", "sort-a"]));
  expect(await run(["sort", "--key=bad", "sort-a"])).toMatchObject(await systemRun(["sort", "--key=bad", "sort-a"]));
  expect(await run(["sort", "--key=bad", "--help"])).toMatchObject(await systemRun(["sort", "--key=bad", "--help"]));
  expect(await run(["sort", "--key", "bad", "--help"])).toMatchObject(await systemRun(["sort", "--key", "bad", "--help"]));
  expect(await run(["sort", "-k", "bad", "--help"])).toMatchObject(await systemRun(["sort", "-k", "bad", "--help"]));
  expect(await run(["sort", "--key=1", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: sort [OPTION]... [FILE]...\n") });
  expect(await run(["sort", "--key=1\nx", "sort-a"])).toMatchObject({ code: 2, stdout: "", stderr: `sort: stray character in field spec: invalid field specification ${diagnosticQuote("1\\nx")}\n` });
  expect(await run(["sort", "--key=0\nx", "sort-a"])).toMatchObject({ code: 2, stdout: "", stderr: `sort: field number is zero: invalid field specification ${diagnosticQuote("0\\nx")}\n` });
  expect(await run(["sort", "--key=1.0", "sort-a"])).toMatchObject({ code: 2, stdout: "", stderr: `sort: character offset is zero: invalid field specification ${diagnosticQuote("1.0")}\n` });
  expect(await run(["sort", "--key=1,bad", "sort-a"])).toMatchObject(await systemRun(["sort", "--key=1,bad", "sort-a"]));
  await mkdir(join(dir, "sort-list-dir"));
  expect(await run(["sort", "--files0-from=sort-list-dir"])).toMatchObject({ code: 2, stdout: "", stderr: "sort: cannot read file names from 'sort-list-dir'\n" });
  expect(await run(["sort", "--files0-from=missing\nsort-list"])).toMatchObject({ code: 2, stdout: "", stderr: "sort: open failed: 'missing'$'\\n''sort-list': No such file or directory\n" });
  await mkdir(join(dir, "sort'list-dir"));
  expect(await run(["sort", "--files0-from=sort'list-dir"])).toMatchObject({ code: 2, stdout: "", stderr: "sort: cannot read file names from \"sort'list-dir\"\n" });
  await writeFile(join(dir, "sort\nempty-list"), "");
  expect(await run(["sort", "--files0-from=sort\nempty-list"])).toMatchObject({ code: 2, stdout: "", stderr: "sort: no input from 'sort'$'\\n''empty-list'\n" });
  await writeFile(join(dir, "sort'zero-list"), "\0");
  expect(await run(["sort", "--files0-from=sort'zero-list"])).toMatchObject({ code: 2, stdout: "", stderr: "sort: \"sort'zero-list\":1: invalid zero-length file name\n" });
  expect(await run(["sort", "--files0-from=-"], "-")).toMatchObject({ code: 2, stderr: "sort: when reading file names from standard input, no file name of '-' allowed\n" });
  expect(await run(["sort", "--files0-from=-"], "\0sort-a\0")).toMatchObject({ code: 2, stderr: "sort: -:1: invalid zero-length file name\n" });
  expect(await run(["sort", "-m", "--batch-size=1", "sort-a", "sort-b"])).toMatchObject(await systemRun(["sort", "-m", "--batch-size=1", "sort-a", "sort-b"]));
  expect(await run(["sort", "--batch-size=bad", "--help"])).toMatchObject(await systemRun(["sort", "--batch-size=bad", "--help"]));
  expect(await run(["sort", "--batch-size=2", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: sort [OPTION]... [FILE]...\n") });
  expect(await run(["sort", "-m", "--batch-size=1K", "sort-a", "sort-b"])).toMatchObject({ code: 2, stdout: "", stderr: "sort: invalid suffix in --batch-size argument '1K'\n" });
  expect(await run(["sort", "-m", "--batch-size=1\n2", "sort-a", "sort-b"])).toMatchObject({ code: 2, stdout: "", stderr: "sort: invalid suffix in --batch-size argument '1\n2'\n" });
  expect(await run(["sort", "--buffer-size=1E"], "")).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["sort", "--buffer-size=bad", "--help"])).toMatchObject(await systemRun(["sort", "--buffer-size=bad", "--help"]));
  expect(await run(["sort", "-S", "bad", "--help"])).toMatchObject(await systemRun(["sort", "-S", "bad", "--help"]));
  expect(await run(["sort", "--buffer-size=1KB"], "")).toMatchObject({ code: 2, stdout: "", stderr: "sort: invalid suffix in --buffer-size argument '1KB'\n" });
  expect(await run(["sort", "--buffer-size=1KiB"], "")).toMatchObject({ code: 2, stdout: "", stderr: "sort: invalid suffix in --buffer-size argument '1KiB'\n" });
  expect(await run(["sort", "--buffer-size=1Z"], "")).toMatchObject({ code: 2, stdout: "", stderr: "sort: --buffer-size argument '1Z' too large\n" });
  expect(await run(["sort", "--buffer-size=1R"], "")).toMatchObject({ code: 2, stdout: "", stderr: "sort: --buffer-size argument '1R' too large\n" });
  expect(await run(["sort", "-m", "--batch-size=2", "-T", "missing\ntmp", "sort-a", "sort-b", "sort-check-bad"])).toMatchObject({
    code: 2,
    stdout: "",
    stderr: "sort: cannot create temporary file in 'missing'$'\\n''tmp': No such file or directory\n",
  });
  await writeFile(join(dir, "sort'parent"), "x");
  expect(await run(["sort", "-o", "sort'parent/out", "sort-a"])).toMatchObject({ code: 2, stdout: "", stderr: "sort: open failed: \"sort'parent/out\": Not a directory\n" });
  expect(await run(["sort", "--parallel=bad", "sort-a"])).toMatchObject({ code: 2, stderr: "sort: invalid --parallel argument 'bad'\n" });
  expect(await run(["sort", "--parallel=bad", "--help"])).toMatchObject(await systemRun(["sort", "--parallel=bad", "--help"]));
  expect(await run(["sort", "--parallel=1", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: sort [OPTION]... [FILE]...\n") });
  expect(await run(["sort", "--parallel=0", "sort-a"])).toMatchObject({ code: 2, stderr: "sort: number in parallel must be nonzero\n" });
  expect(await run(["sort", "--parallel=+1", "sort-a"])).toMatchObject({ code: 0, stdout: "b\n", stderr: "" });
  expect(await run(["sort", "--parallel=+0", "sort-a"])).toMatchObject({ code: 2, stderr: "sort: number in parallel must be nonzero\n" });
  expect(await run(["sort", "--parallel=1.5", "sort-a"])).toMatchObject({ code: 2, stderr: "sort: invalid suffix in --parallel argument '1.5'\n" });
  expect(await run(["sort", "--check=", "sort-a"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `sort: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--check")}\nValid arguments are:\n  - ${diagnosticQuote("quiet")}, ${diagnosticQuote("silent")}\n  - ${diagnosticQuote("diagnose-first")}\nTry 'sort --help' for more information.\n`,
  });
  expect(await run(["sort", "--check=bad", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `sort: invalid argument ${diagnosticQuote("bad")} for ${diagnosticQuote("--check")}\nValid arguments are:\n  - ${diagnosticQuote("quiet")}, ${diagnosticQuote("silent")}\n  - ${diagnosticQuote("diagnose-first")}\nTry 'sort --help' for more information.\n`,
  });
  expect(await run(["sort", "-t", "xx", "sort-a"])).toMatchObject(await systemRun(["sort", "-t", "xx", "sort-a"]));
  expect(await run(["sort", "--field-separator=xx", "--help"])).toMatchObject(await systemRun(["sort", "--field-separator=xx", "--help"]));
  expect(await run(["sort", "-t", "xx", "--help"])).toMatchObject(await systemRun(["sort", "-t", "xx", "--help"]));
  expect(await run(["sort", "--field-separator=x", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: sort [OPTION]... [FILE]...\n") });
  expect(await run(["sort", "-t", "ab\nc", "sort-a"])).toMatchObject({ code: 2, stdout: "", stderr: `sort: multi-character tab ${diagnosticQuote("ab\\nc")}\n` });
  expect(await run(["sort", "-t", "", "sort-a"])).toMatchObject({ code: 2, stdout: "", stderr: "sort: empty tab\n" });
  expect(await run(["sort", "-R", "--random-source=", "sort-a"])).toMatchObject({ code: 2, stdout: "", stderr: "sort: open failed: '': No such file or directory\n" });
  expect(await run(["sort", "--random-source=missing-random", "-R", "sort-a"])).toMatchObject({ code: 2, stdout: "", stderr: "sort: open failed: missing-random: No such file or directory\n" });
  expect(await run(["sort", "--sort=", "sort-a"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `sort: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--sort")}\nValid arguments are:\n  - ${diagnosticQuote("general-numeric")}\n  - ${diagnosticQuote("human-numeric")}\n  - ${diagnosticQuote("month")}\n  - ${diagnosticQuote("numeric")}\n  - ${diagnosticQuote("random")}\n  - ${diagnosticQuote("version")}\nTry 'sort --help' for more information.\n`,
  });
  expect(await run(["sort", "--sort=", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `sort: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--sort")}\nValid arguments are:\n  - ${diagnosticQuote("general-numeric")}\n  - ${diagnosticQuote("human-numeric")}\n  - ${diagnosticQuote("month")}\n  - ${diagnosticQuote("numeric")}\n  - ${diagnosticQuote("random")}\n  - ${diagnosticQuote("version")}\nTry 'sort --help' for more information.\n`,
  });
  expect(await run(["sort", "--sort=bad", "sort-a"])).toMatchObject(await systemRun(["sort", "--sort=bad", "sort-a"]));
  expect(await run(["sort", "--sort=bad", "--help"])).toMatchObject(await systemRun(["sort", "--sort=bad", "--help"]));
  expect(await run(["sort", "--sort=bad\nmode", "sort-a"])).toMatchObject({
    code: 1,
    stderr: `sort: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--sort")}\nValid arguments are:\n  - ${diagnosticQuote("general-numeric")}\n  - ${diagnosticQuote("human-numeric")}\n  - ${diagnosticQuote("month")}\n  - ${diagnosticQuote("numeric")}\n  - ${diagnosticQuote("random")}\n  - ${diagnosticQuote("version")}\nTry 'sort --help' for more information.\n`,
  });
  expect(await run(["sort", "--debug", "sort-a"], "", { env: { LC_ALL: "C" } })).toMatchObject({
    code: 0,
    stderr: "sort: text ordering performed using simple byte comparison\n",
  });
  expect(await run(["sort", "--debug", "sort-a"], "", { env: { LC_ALL: "C.UTF-8" } })).toMatchObject({
    code: 0,
    stderr: `sort: text ordering performed using ${diagnosticQuote("C.UTF-8")} sorting rules\n`,
  });
  const missingTempDir = await run(["sort", "-m", "--batch-size=2", "-T", "does/not/exist", "sort-a", "sort-b", "sort-a"]);
  expect(missingTempDir).toMatchObject({ code: 2 });
  expect(missingTempDir.stderr).toContain("sort: cannot create temporary file in 'does/not/exist':");
  expect(await run(["sort", "-m", "--batch-size=4", "-T", "does/not/exist", "sort-a", "sort-b"])).toMatchObject({ code: 0, stdout: "a\nb\n" });
  await writeFile(join(dir, "sort-merge-a"), "a\nc\n");
  await writeFile(join(dir, "sort-merge-b"), "b\nd\n");
  expect(await run(["sort", "-m", "sort-merge-a", "sort-merge-b"])).toMatchObject({ code: 0, stdout: "a\nb\nc\nd\n" });
  await writeFile(join(dir, "sort-merge-unsorted-a"), "b 2\na 10\na 2\n");
  await writeFile(join(dir, "sort-merge-unsorted-b"), "b 2\na 10\na 2\n");
  expect(await run(["sort", "-m", "sort-merge-unsorted-a", "sort-merge-unsorted-b"])).toMatchObject({ code: 0, stdout: "b 2\na 10\na 2\nb 2\na 10\na 2\n" });
  await writeFile(join(dir, "sort-compress-helper"), "#!/bin/sh\ntouch sort-compress-ok\n");
  await chmod(join(dir, "sort-compress-helper"), 0o755);
  expect(await run(["sort", "--compress-program=./sort-compress-helper"], "b\na\n")).toMatchObject({ code: 0, stdout: "a\nb\n" });
  expect(await stat(join(dir, "sort-compress-ok")).catch(() => null)).toBeNull();
  expect(await run(["sort", "-m", "--batch-size=2", "--compress-program=./sort-compress-helper", "sort-a", "sort-b", "sort-a"])).toMatchObject({ code: 0, stdout: "a\nb\nb\n" });
  expect((await stat(join(dir, "sort-compress-ok"))).isFile()).toBe(true);
  await writeFile(join(dir, "sort-compress-fail"), "#!/bin/sh\n[ \"$1\" = -d ] && exit 7\ncat >/dev/null\n");
  await chmod(join(dir, "sort-compress-fail"), 0o755);
  expect(await run(["sort", "--compress-program=./sort-compress-fail"], "b\na\n")).toMatchObject(await systemRun(["/usr/bin/sort", "--compress-program=./sort-compress-fail"], "b\na\n"));
  expect(await run(["sort", "-m", "--batch-size=2", "--compress-program=./sort-compress-fail", "sort-a", "sort-b", "sort-a"])).toMatchObject({ code: 2, stdout: "" });
  expect(await run(["sort", "--compress-program=missing-helper"], "b\na\n")).toMatchObject(await systemRun(["/usr/bin/sort", "--compress-program=missing-helper"], "b\na\n"));
  expect(await run(["sort", "-m", "--batch-size=2", "--compress-program=missing-helper", "sort-a", "sort-b", "sort-a"])).toMatchObject(await systemRun(["/usr/bin/sort", "-m", "--batch-size=2", "--compress-program=missing-helper", "sort-a", "sort-b", "sort-a"]));
  await writeFile(join(dir, "sort-compress-large"), Array.from({ length: 2000 }, (_, i) => String(2000 - i).padStart(4, "0")).join("\n") + "\n");
  const missingCompress = await run(["sort", "-S", "1k", "--compress-program=missing-helper", "sort-compress-large"]);
  expect(missingCompress).toMatchObject({ code: 0, stderr: "sort: could not run compress program 'missing-helper': No such file or directory\n" });
  expect(missingCompress.stdout.split("\n").slice(0, 3)).toEqual(["0001", "0002", "0003"]);
  expect(await shell('"$BUN" "$BNU" sort --debug /dev/null 2>/dev/full')).toMatchObject({ code: 2 });
});

test("base64 and checksum utilities", async () => {
  expect(await run(["base64"], "")).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["base64"], "hello")).toMatchObject({ code: 0, stdout: "aGVsbG8=\n" });
  expect(await run(["base64", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: base64 [OPTION]... [FILE]\n") });
  expect(await run(["basenc", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: basenc [OPTION]... [FILE]\n") });
  expect(await run(["base64", "--v"])).toMatchObject({ code: 0, stdout: expect.stringContaining("bnu 9.11\n") });
  await writeFile(join(dir, "base64-meta"), "hello");
  expect(await run(["base64", "base64-meta", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: base64 [OPTION]... [FILE]\n"), stderr: "" });
  expect(await run(["base64", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "base64: unrecognized option '--bad'\nTry 'base64 --help' for more information.\n" });
  expect(await run(["base64", "--h=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "base64: option '--help' doesn't allow an argument\nTry 'base64 --help' for more information.\n" });
  expect(await run(["base64", "--help=1", "--version"])).toMatchObject({ code: 1, stdout: "", stderr: "base64: option '--help' doesn't allow an argument\nTry 'base64 --help' for more information.\n" });
  expect(await run(["base64", "--d"], "YQ==")).toMatchObject({ code: 0, stdout: "a" });
  expect(await run(["base64", "--i", "--d"], "Y!!Q==")).toMatchObject({ code: 0, stdout: "a" });
  expect(await run(["base64", "--w=0"], "a")).toMatchObject({ code: 0, stdout: "YQ==" });
  expect(await run(["base64", "--w", "--help"], "a")).toMatchObject(await systemRun(["base64", "--w", "--help"], "a"));
  expect(await run(["base64", "--wrap=0"], "a")).toMatchObject({ code: 0, stdout: "YQ==" });
  expect(await run(["base64", "--wrap=+0"], "a")).toMatchObject({ code: 0, stdout: "YQ==" });
  expect(await run(["base64", "--wrap=+4"], "abc")).toMatchObject({ code: 0, stdout: "YWJj\n" });
  expect(await run(["base64", "--wrap=9223372036854775807"], "abc")).toMatchObject({ code: 0, stdout: "YWJj\n" });
  expect(await run(["base64", "--wrap=999999999999999999999999"], "abc")).toMatchObject({ code: 0, stdout: "YWJj" });
  expect(await run(["base64", "--wrap=0x0"], "")).toMatchObject(await systemRun(["base64", "--wrap=0x0"], ""));
  expect(await run(["base64", "--wrap=1\n2"], "")).toMatchObject({ code: 1, stdout: "", stderr: `base64: invalid wrap size: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["base64", "--wrap=-1"], "")).toMatchObject(await systemRun(["base64", "--wrap=-1"], ""));
  expect(await run(["base64", "--wrap=bad", "--help"])).toMatchObject(await systemRun(["base64", "--wrap=bad", "--help"]));
  expect(await run(["base64", "--wrap=-1", "--help"])).toMatchObject(await systemRun(["base64", "--wrap=-1", "--help"]));
  expect(await run(["base64", "--wrap", "bad", "--help"])).toMatchObject(await systemRun(["base64", "--wrap", "bad", "--help"]));
  expect(await run(["base64", "-w", "bad", "--help"])).toMatchObject(await systemRun(["base64", "-w", "bad", "--help"]));
  expect(await run(["base64", "--wrap", "0", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: base64 [OPTION]... [FILE]\n") });
  expect(await run(["base64", "/dev/null", "extra\narg"])).toMatchObject({ code: 1, stdout: "", stderr: `base64: extra operand ${diagnosticQuote("extra\\narg")}\nTry 'base64 --help' for more information.\n` });
  expect(await run(["base64", "base64-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "base64: base64-missing: No such file or directory\n" });
  expect(await run(["base64", "missing'base64"])).toMatchObject({ code: 1, stdout: "", stderr: "base64: \"missing'base64\": No such file or directory\n" });
  expect(await run(["base64", "missing\nbase64"])).toMatchObject({ code: 1, stdout: "", stderr: "base64: 'missing'$'\\n''base64': No such file or directory\n" });
  await mkdir(join(dir, "base64-dir"));
  expect(await run(["base64", "base64-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "base64: read error: Is a directory\n" });
  await symlink("base64-loop", join(dir, "base64-loop"));
  expect(await run(["base64", "base64-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "base64: base64-loop: Too many levels of symbolic links\n" });
  await symlink("loop'base64", join(dir, "loop'base64"));
  expect(await run(["base64", "loop'base64"])).toMatchObject({ code: 1, stdout: "", stderr: "base64: \"loop'base64\": Too many levels of symbolic links\n" });
  expect(await run(["base64", "-d"], "aGVsbG8=\n")).toMatchObject({ code: 0, stdout: "hello" });
  expect(await run(["base64", "-d", "base64-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "base64: base64-missing: No such file or directory\n" });
  expect(await run(["base64", "-d"], "MTIzNA==MTIzNA")).toMatchObject({ code: 0, stdout: "12341234" });
  expect(await run(["base64", "-d"], "SGVsbG9=")).toMatchObject({ code: 1, stdout: "Hello", stderr: "base64: invalid input\n" });
  expect(await run(["base64", "-d"], "mzxw6===")).toMatchObject({ code: 1, stdout: "\uFFFD<p", stderr: "base64: invalid input\n" });
  expect(await run(["base64", "-di"], "aGV!!sbG8=\n")).toMatchObject({ code: 0, stdout: "hello" });
  expect(await run(["base64", "-d"], "aGV!!sbG8=\n")).toMatchObject({ code: 1, stdout: "he", stderr: "base64: invalid input\n" });
  expect(await run(["base64", "-di"], "bad!!\n")).toMatchObject({ code: 1, stdout: "m�", stderr: "base64: invalid input\n" });
  expect(await run(["base32"], "abc")).toMatchObject({ code: 0, stdout: "MFRGG===\n" });
  expect(await run(["base32", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: base32 [OPTION]... [FILE]\n") });
  expect(await run(["base32", "--v"])).toMatchObject({ code: 0, stdout: expect.stringContaining("bnu 9.11\n") });
  await writeFile(join(dir, "base32-meta"), "abc");
  expect(await run(["base32", "base32-meta", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: base32 [OPTION]... [FILE]\n"), stderr: "" });
  expect(await run(["base32", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "base32: unrecognized option '--bad'\nTry 'base32 --help' for more information.\n" });
  expect(await run(["base32", "--h=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "base32: option '--help' doesn't allow an argument\nTry 'base32 --help' for more information.\n" });
  expect(await run(["base32", "--d"], "ME======")).toMatchObject({ code: 0, stdout: "a" });
  expect(await run(["base32", "--i", "--d"], "M!!E======")).toMatchObject({ code: 0, stdout: "a" });
  expect(await run(["base32", "--w", "--help"], "a")).toMatchObject(await systemRun(["base32", "--w", "--help"], "a"));
  expect(await run(["base32", "--wrap=bad", "--help"])).toMatchObject(await systemRun(["base32", "--wrap=bad", "--help"]));
  expect(await run(["base32", "-w", "bad", "--help"])).toMatchObject(await systemRun(["base32", "-w", "bad", "--help"]));
  expect(await run(["base32", "base32-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "base32: base32-missing: No such file or directory\n" });
  expect(await run(["base32", "missing'base32"])).toMatchObject({ code: 1, stdout: "", stderr: "base32: \"missing'base32\": No such file or directory\n" });
  expect(await run(["base32", "missing\nbase32"])).toMatchObject({ code: 1, stdout: "", stderr: "base32: 'missing'$'\\n''base32': No such file or directory\n" });
  await mkdir(join(dir, "base32-dir"));
  expect(await run(["base32", "base32-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "base32: read error: Is a directory\n" });
  await symlink("base32-loop", join(dir, "base32-loop"));
  expect(await run(["base32", "base32-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "base32: base32-loop: Too many levels of symbolic links\n" });
  await symlink("loop'base32", join(dir, "loop'base32"));
  expect(await run(["base32", "loop'base32"])).toMatchObject({ code: 1, stdout: "", stderr: "base32: \"loop'base32\": Too many levels of symbolic links\n" });
  expect(await run(["base32", "-d"], "MFRGG===\n")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["base32", "-d"], "mfrgg===\n")).toMatchObject({ code: 1, stdout: "", stderr: "base32: invalid input\n" });
  expect(await run(["base32", "-di"], "mfrgg===\n")).toMatchObject({ code: 1, stdout: "", stderr: "base32: invalid input\n" });
  expect(await run(["base32", "-d"], "MFRgG===\n")).toMatchObject({ code: 1, stdout: "a", stderr: "base32: invalid input\n" });
  expect(await run(["base32", "-d", "base32-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "base32: base32-missing: No such file or directory\n" });
  expect(await run(["base32", "-d", "--ignore-garbage"], "MF!!RGG===\n")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["base32", "-d"], "MF!!RGG===\n")).toMatchObject({ code: 1, stdout: "a", stderr: "base32: invalid input\n" });
  expect(await run(["md5sum"], "abc")).toMatchObject({ code: 0, stdout: "900150983cd24fb0d6963f7d28e17f72  -\n" });
  const md5Help = await run(["md5sum", "--help"]);
  const md5HelpStdout = String(md5Help.stdout);
  expect(md5Help).toMatchObject({ code: 0, stdout: expect.stringContaining("Print or check MD5 (128-bit) checksums.\nLegacy interface to the cksum utility.\n") });
  expect(md5HelpStdout.includes("--length")).toBe(false);
  expect(md5HelpStdout.includes("  -l\n")).toBe(false);
  expect(md5HelpStdout).toContain("  -w\n");
  expect(await run(["md5sum", "-b"], "abc")).toMatchObject({ code: 0, stdout: "900150983cd24fb0d6963f7d28e17f72 *-\n" });
  expect(await run(["md5sum", "--tag"], "abc")).toMatchObject({ code: 0, stdout: "MD5 (-) = 900150983cd24fb0d6963f7d28e17f72\n" });
  expect(await run(["sha256sum"], "abc")).toMatchObject({ code: 0, stdout: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n" });
  expect(await run(["sha256sum", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Print or check SHA256 (256-bit) checksums.\nLegacy interface to the cksum utility.\n") });
  expect(await run(["sha256sum", "--length=bad", "--help"])).toMatchObject(await systemRun(["sha256sum", "--length=bad", "--help"]));
  expect(await run(["cksum", "--algorithm=sha256"], "abc")).toMatchObject({ code: 0, stdout: "SHA256 (-) = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n" });
  expect(await run(["cksum", "--alg=sha256", "--unt"], "abc")).toMatchObject({ code: 0, stdout: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n" });
  expect(await run(["cksum", "--bad", "--help"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: "cksum: unrecognized option '--bad'\nTry 'cksum --help' for more information.\n" });
  expect(await run(["cksum", "--b=1"], "abc")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "cksum: option '--b=1' is ambiguous; possibilities: '--base64' '--binary'\nTry 'cksum --help' for more information.\n",
  });
  expect(await run(["cksum", "--version=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "cksum: option '--version' doesn't allow an argument\nTry 'cksum --help' for more information.\n" });
  expect(await run(["cksum", "--alg", "--help"], "abc")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringContaining(`cksum: invalid argument ${diagnosticQuote("--help")} for ${diagnosticQuote("--algorithm")}\n`),
  });
  expect(await run(["cksum", "--alg=crc", "--help"], "abc")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: cksum [OPTION]... [FILE]...\n") });
  expect(await run(["cksum", "--algorithm=", "--help"], "abc")).toMatchObject(await systemRun(["cksum", "--algorithm=", "--help"], "abc"));
  expect(await run(["cksum", "--algorithm=bad", "--help"], "abc")).toMatchObject(await systemRun(["cksum", "--algorithm=bad", "--help"], "abc"));
  expect(await run(["cksum", "-a", "bad", "--help"], "abc")).toMatchObject(await systemRun(["cksum", "-a", "bad", "--help"], "abc"));
  expect(await run(["cksum", "-abad", "--help"], "abc")).toMatchObject(await systemRun(["cksum", "-abad", "--help"], "abc"));
  expect(await run(["cksum", "-a", "sha2", "--help"], "abc")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: cksum [OPTION]... [FILE]...\n") });
  expect(await run(["cksum", "-w", "--help", "--help"], "abc")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: cksum [OPTION]... [FILE]...\n") });
  expect(await run(["cksum", "BEFORE", "--help", "AFTER"], "abc")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: cksum [OPTION]... [FILE]...\n") });
  expect(await run(["cksum", "BEFORE", "--version", "AFTER"], "abc")).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["cksum", "--algorithm=sm3", "--untagged"], "abc")).toMatchObject({ code: 0, stdout: "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0  -\n" });
  expect(await run(["cksum", "--algorithm=md5", "--tag", "--untagged"], "abc")).toMatchObject({ code: 0, stdout: "900150983cd24fb0d6963f7d28e17f72  -\n" });
  expect(await run(["cksum", "--algorithm=md5", "--untagged", "--tag"], "abc")).toMatchObject({ code: 0, stdout: "MD5 (-) = 900150983cd24fb0d6963f7d28e17f72\n" });
  expect(await run(["cksum", "--algorithm=md5", "--untagged", "--binary", "--text"], "abc")).toMatchObject({ code: 0, stdout: "900150983cd24fb0d6963f7d28e17f72  -\n" });
  expect(await run(["cksum", "--status"], "abc")).toMatchObject({ code: 1, stderr: "cksum: the --status option is meaningful only when verifying checksums\nTry 'cksum --help' for more information.\n" });
  expect(await run(["cksum", "--ignore-missing"], "abc")).toMatchObject({ code: 1, stderr: "cksum: the --ignore-missing option is meaningful only when verifying checksums\nTry 'cksum --help' for more information.\n" });
  expect(await run(["cksum", "--algorithm=bad"], "abc")).toMatchObject({
    code: 1,
    stderr: `cksum: invalid argument ${diagnosticQuote("bad")} for ${diagnosticQuote("--algorithm")}\nValid arguments are:\n  - ${diagnosticQuote("bsd")}\n  - ${diagnosticQuote("sysv")}\n  - ${diagnosticQuote("crc")}\n  - ${diagnosticQuote("crc32b")}\n  - ${diagnosticQuote("md5")}\n  - ${diagnosticQuote("sha1")}\n  - ${diagnosticQuote("sha224")}\n  - ${diagnosticQuote("sha256")}\n  - ${diagnosticQuote("sha384")}\n  - ${diagnosticQuote("sha512")}\n  - ${diagnosticQuote("sha2")}\n  - ${diagnosticQuote("sha3")}\n  - ${diagnosticQuote("blake2b")}\n  - ${diagnosticQuote("sm3")}\nTry 'cksum --help' for more information.\n`,
  });
  expect(await run(["cksum", "--algorithm=bad\nmode"], "abc")).toMatchObject({
    code: 1,
    stderr: `cksum: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--algorithm")}\nValid arguments are:\n  - ${diagnosticQuote("bsd")}\n  - ${diagnosticQuote("sysv")}\n  - ${diagnosticQuote("crc")}\n  - ${diagnosticQuote("crc32b")}\n  - ${diagnosticQuote("md5")}\n  - ${diagnosticQuote("sha1")}\n  - ${diagnosticQuote("sha224")}\n  - ${diagnosticQuote("sha256")}\n  - ${diagnosticQuote("sha384")}\n  - ${diagnosticQuote("sha512")}\n  - ${diagnosticQuote("sha2")}\n  - ${diagnosticQuote("sha3")}\n  - ${diagnosticQuote("blake2b")}\n  - ${diagnosticQuote("sm3")}\nTry 'cksum --help' for more information.\n`,
  });
  expect(await run(["sm3sum"], "abc")).toMatchObject({ code: 0, stdout: "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0  -\n" });
  expect(await run(["cksum", "--algorithm=sha2", "--length=224", "--untagged"], "abc")).toMatchObject({ code: 0, stdout: "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7  -\n" });
  expect(await run(["cksum", "--algorithm=md5", "--length=0", "--untagged"], "abc")).toMatchObject({ code: 0, stdout: "900150983cd24fb0d6963f7d28e17f72  -\n" });
  expect(await run(["cksum", "--algorithm=blake2b", "--length=8", "--untagged"], "test input\n")).toMatchObject({ code: 0, stdout: "86  -\n" });
  expect(await run(["cksum", "--length=7"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: "cksum: --length is only supported with --algorithm blake2b, sha2, or sha3\n" });
  expect(await run(["cksum", "--algorithm=md5", "--length=16"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: "cksum: --length is only supported with --algorithm blake2b, sha2, or sha3\n" });
  expect(await run(["cksum", "--algorithm=sha2", "--length=7"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `cksum: invalid length: ${diagnosticQuote("7")}\ncksum: digest length for ${diagnosticQuote("SHA2")} must be 224, 256, 384, or 512\n` });
  expect(await run(["cksum", "--algorithm=sha2", "--length=bad"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `cksum: invalid length: ${diagnosticQuote("bad")}\n` });
  expect(await run(["cksum", "--length=bad", "--help"])).toMatchObject(await systemRun(["cksum", "--length=bad", "--help"]));
  expect(await run(["cksum", "--length", "bad", "--help"])).toMatchObject(await systemRun(["cksum", "--length", "bad", "--help"]));
  expect(await run(["cksum", "-l", "bad", "--help"])).toMatchObject(await systemRun(["cksum", "-l", "bad", "--help"]));
  expect(await run(["cksum", "-lbad", "--help"])).toMatchObject(await systemRun(["cksum", "-lbad", "--help"]));
  expect(await run(["cksum", "--length=-1", "--help"])).toMatchObject(await systemRun(["cksum", "--length=-1", "--help"]));
  expect(await run(["cksum", "--algorithm=sha2", "--length=7\n8"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `cksum: invalid length: ${diagnosticQuote("7\\n8")}\n` });
  expect(await run(["cksum", "--algorithm=sha2", "--length=-1"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `cksum: invalid length: ${diagnosticQuote("-1")}: Value too large for defined data type\n` });
  expect(await run(["cksum", "--algorithm=sha3", "--length=bad"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `cksum: invalid length: ${diagnosticQuote("bad")}\n` });
  expect(await run(["cksum", "--algorithm=blake2b", "--length=9"], "abc")).toMatchObject({ code: 1, stdout: "", stderr: `cksum: invalid length: ${diagnosticQuote("9")}\ncksum: length is not a multiple of 8\n` });
  expect(await run(["cksum", "--algorithm=blake2b", "--length=0"], "abc")).toMatchObject({ code: 0, stdout: "BLAKE2b (-) = ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923\n" });
  expect(await run(["b2sum", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  const b2Help = await run(["b2sum", "--help"]);
  const b2HelpStdout = String(b2Help.stdout);
  expect(b2Help).toMatchObject({ code: 0, stdout: expect.stringContaining("Print or check BLAKE2b (512-bit) checksums.\nLegacy interface to the cksum utility.\n") });
  expect(b2HelpStdout).toContain("--length");
  expect(b2HelpStdout).toContain("  -l\n");
  expect(b2HelpStdout).toContain("  -w\n");
  expect(await run(["b2sum", "--l=128"], "")).toMatchObject({ code: 0, stdout: "cae66941d9efbd404e4d88758ea67670  -\n" });
  expect(await run(["b2sum", "--l", "--help"], "")).toMatchObject({ code: 1, stdout: "", stderr: `b2sum: invalid length: ${diagnosticQuote("--help")}\n` });
  expect(await run(["b2sum", "--length=128"], "")).toMatchObject({ code: 0, stdout: "cae66941d9efbd404e4d88758ea67670  -\n" });
  expect(await run(["b2sum", "--length=bad", "--help"])).toMatchObject(await systemRun(["b2sum", "--length=bad", "--help"]));
  expect(await run(["b2sum", "--length", "bad", "--help"])).toMatchObject(await systemRun(["b2sum", "--length", "bad", "--help"]));
  expect(await run(["b2sum", "-l", "bad", "--help"])).toMatchObject(await systemRun(["b2sum", "-l", "bad", "--help"]));
  expect(await run(["b2sum", "-lbad", "--help"])).toMatchObject(await systemRun(["b2sum", "-lbad", "--help"]));
  expect(await run(["b2sum", "-l", "513", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: b2sum [OPTION]... [FILE]...\n") });
  expect((await run(["cksum", "--algorithm=sha3", "--length=216"], "")).stderr).toContain(`digest length for ${diagnosticQuote("SHA3")}`);
  expect((await run(["b2sum", "--length=513"], "")).stderr).toContain(`maximum digest length for ${diagnosticQuote("BLAKE2b")}`);
  expect(await run(["b2sum", "--length=bad"], "")).toMatchObject({ code: 1, stdout: "", stderr: `b2sum: invalid length: ${diagnosticQuote("bad")}\n` });
  expect(await run(["b2sum", "--length=1\n2"], "")).toMatchObject({ code: 1, stdout: "", stderr: `b2sum: invalid length: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["b2sum", "--length=-1"], "")).toMatchObject({ code: 1, stdout: "", stderr: `b2sum: invalid length: ${diagnosticQuote("-1")}: Value too large for defined data type\n` });
  expect(await run(["b2sum", "--length=-1\n2"], "")).toMatchObject({ code: 1, stdout: "", stderr: `b2sum: invalid length: ${diagnosticQuote("-1\\n2")}\n` });
  expect(await run(["cksum", "--algorithm=md5", "--base64"], "abc")).toMatchObject({ code: 0, stdout: "MD5 (-) = kAFQmDzST7DWlj99KOF/cg==\n" });
  const cksumHelp = (await run(["cksum", "--help"])).stdout;
  expect(cksumHelp).toContain("Print or verify checksums.\nBy default use the 32 bit CRC algorithm.\n");
  expect(cksumHelp).toContain("  blake2b\n  sm3\n");
  expect(await run(["sm3sum", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Print or check SM3 (256-bit) checksums.\nLegacy interface to the cksum utility.\n") });
  await writeFile(join(dir, "crc-bytes"), Uint8Array.from({ length: 65 }, (_, i) => i));
  await writeFile(join(dir, "empty"), "");
  await writeFile(join(dir, "a\nb"), "");
  await mkdir(join(dir, "checksum-dir"));
  const zeroMd5 = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "md5sum", "--text", "--zero", "a\nb"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(await zeroMd5.exited).toBe(0);
  expect(new Uint8Array(await new Response(zeroMd5.stdout).arrayBuffer())).toEqual(Buffer.from("d41d8cd98f00b204e9800998ecf8427e  a\nb\0"));
  expect(await run(["cksum", "crc-bytes"])).toMatchObject({ code: 0, stdout: "796287823 65 crc-bytes\n" });
  expect(await run(["cksum", "--algorithm=crc32b", "crc-bytes"])).toMatchObject({ code: 0, stdout: "1086353368 65 crc-bytes\n" });
  expect(await run(["cksum", "--algorithm=crc32b", "-"], "abc")).toMatchObject({ code: 0, stdout: "891568578 3 -\n" });
  expect(await run(["cksum", "--debug", "crc-bytes"])).toMatchObject({ code: 0, stdout: "796287823 65 crc-bytes\n" });
  expect(await run(["cksum", "checksum-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "cksum: checksum-dir: Is a directory\n" });
  expect(await run(["cksum", "cksum-missing-a", "crc-bytes", "cksum-missing-b"])).toMatchObject({ code: 1, stdout: "796287823 65 crc-bytes\n", stderr: "cksum: cksum-missing-a: No such file or directory\ncksum: cksum-missing-b: No such file or directory\n" });
  expect(await run(["cksum", "missing'cksum"])).toMatchObject({ code: 1, stdout: "", stderr: "cksum: \"missing'cksum\": No such file or directory\n" });
  expect(await run(["cksum", "missing\ncksum"])).toMatchObject({ code: 1, stdout: "", stderr: "cksum: 'missing'$'\\n''cksum': No such file or directory\n" });
  await mkdir(join(dir, "dir'cksum"));
  expect(await run(["cksum", "dir'cksum"])).toMatchObject({ code: 1, stdout: "", stderr: "cksum: \"dir'cksum\": Is a directory\n" });
  await symlink("loop'cksum", join(dir, "loop'cksum"));
  expect(await run(["cksum", "loop'cksum"])).toMatchObject({ code: 1, stdout: "", stderr: "cksum: \"loop'cksum\": Too many levels of symbolic links\n" });
  expect(await run(["md5sum", "missing'cksum"])).toMatchObject({ code: 1, stdout: "", stderr: "md5sum: \"missing'cksum\": No such file or directory\n" });
  expect(await run(["b2sum", "loop'cksum"])).toMatchObject({ code: 1, stdout: "", stderr: "b2sum: \"loop'cksum\": Too many levels of symbolic links\n" });
  expect(await run(["cksum", "--debug", "--algorithm=md5", "empty"])).toMatchObject({ code: 0, stdout: "MD5 (empty) = d41d8cd98f00b204e9800998ecf8427e\n", stderr: "" });
  expect(await run(["cksum", "--algorithm=md5", "cksum-missing", "empty"])).toMatchObject({ code: 1, stdout: "MD5 (empty) = d41d8cd98f00b204e9800998ecf8427e\n", stderr: "cksum: cksum-missing: No such file or directory\n" });
  expect(await run(["md5sum", "checksum-dir", "empty"])).toMatchObject({ code: 1, stdout: "d41d8cd98f00b204e9800998ecf8427e  empty\n", stderr: "md5sum: checksum-dir: Is a directory\n" });
  expect(await run(["b2sum", "checksum-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "b2sum: checksum-dir: Is a directory\n" });
  expect(await run(["cksum", "--untagged", "--algorithm=bsd", "empty"])).toMatchObject({ code: 0, stdout: "00000     0 empty\n" });
  expect(await run(["cksum", "--untagged", "--algorithm=sysv", "cksum-missing", "empty"])).toMatchObject({ code: 1, stdout: "0 0 empty\n", stderr: "cksum: cksum-missing: No such file or directory\n" });
  expect(await run(["cksum", "--untagged", "--algorithm=sysv", "empty"])).toMatchObject({ code: 0, stdout: "0 0 empty\n" });
  expect(await run(["cksum", "--untagged", "--binary", "--algorithm=md5", "empty"])).toMatchObject({ code: 0, stdout: "d41d8cd98f00b204e9800998ecf8427e *empty\n" });
  expect(await run(["cksum", "--text", "--tag", "--algorithm=md5", "empty"])).toMatchObject({ code: 1 });
  const rawCrc = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "cksum", "--raw", "--algorithm=crc", "empty"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(await rawCrc.exited).toBe(0);
  expect(new Uint8Array(await new Response(rawCrc.stdout).arrayBuffer())).toEqual(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
  const rawCrcLengthZero = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "cksum", "--raw", "--algorithm=crc", "--length=0", "empty"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(await rawCrcLengthZero.exited).toBe(0);
  expect(new Uint8Array(await new Response(rawCrcLengthZero.stdout).arrayBuffer())).toEqual(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
  const rawBsd = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "cksum", "--raw", "--algorithm=bsd", "empty"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(await rawBsd.exited).toBe(0);
  expect(new Uint8Array(await new Response(rawBsd.stdout).arrayBuffer())).toEqual(Uint8Array.of(0, 0));
  await writeFile(join(dir, "be"), Uint8Array.of(0x12, 0x34));
  expect(await run(["od", "--endian=big", "-An", "-tu2", "be"])).toMatchObject({ code: 0, stdout: "  4660\n" });
});

test("checksum utilities verify checksum files", async () => {
  await writeFile(join(dir, "data"), "abc");
  await writeFile(join(dir, "data.md5"), "900150983cd24fb0d6963f7d28e17f72  data\n");
  expect(await run(["md5sum", "-c", "data.md5"])).toMatchObject({ code: 0, stdout: "data: OK\n" });
  const md5RawCheck = Bun.spawn(["/bin/sh", "-c", `name=$(printf 'sum-\\377'); printf 'abc' > "$name"; printf '900150983cd24fb0d6963f7d28e17f72  %s\\n' "$name" > raw.md5; LC_ALL=C ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} md5sum -c raw.md5 >raw-md5-out`], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await md5RawCheck.exited).toBe(0);
  expect(await new Response(md5RawCheck.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "raw-md5-out"))]).toEqual([0x27, 0x73, 0x75, 0x6d, 0x2d, 0x27, 0x24, 0x27, 0x5c, 0x33, 0x37, 0x37, 0x27, 0x3a, 0x20, 0x4f, 0x4b, 0x0a]);
  expect(await run(["md5sum", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "md5sum: unrecognized option '--bad'\nTry 'md5sum --help' for more information.\n" });
  expect(await run(["md5sum", "--sta", "--check", "missing"])).toMatchObject({ code: 1, stdout: "", stderr: "md5sum: missing: No such file or directory\n" });
  expect(await run(["md5sum", "--st=1", "data.md5"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "md5sum: option '--st=1' is ambiguous; possibilities: '--status' '--strict'\nTry 'md5sum --help' for more information.\n",
  });
  expect(await run(["md5sum", "--version=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "md5sum: option '--version' doesn't allow an argument\nTry 'md5sum --help' for more information.\n" });
  expect(await run(["md5sum", "--tag", "data"])).toMatchObject({ code: 0, stdout: "MD5 (data) = 900150983cd24fb0d6963f7d28e17f72\n" });
  expect(await run(["md5sum", "--quiet", "data"])).toMatchObject({ code: 1, stderr: "md5sum: the --quiet option is meaningful only when verifying checksums\nTry 'md5sum --help' for more information.\n" });
  expect(await run(["md5sum", "--warn", "data"])).toMatchObject({ code: 1, stderr: "md5sum: the --warn option is meaningful only when verifying checksums\nTry 'md5sum --help' for more information.\n" });
  expect(await run(["md5sum", "-w", "data"])).toMatchObject({ code: 1, stderr: "md5sum: the --warn option is meaningful only when verifying checksums\nTry 'md5sum --help' for more information.\n" });
  expect(await run(["b2sum", "--tag", "--length=128", "data"])).toMatchObject({ code: 0, stdout: "BLAKE2b-128 (data) = cf4ab791c62b8d2b2109c90275287816\n" });
  await writeFile(join(dir, "compact.md5"), "MD5(data)= 900150983cd24fb0d6963f7d28e17f72\n");
  expect(await run(["md5sum", "--check", "compact.md5"])).toMatchObject({ code: 0, stdout: "data: OK\n" });
  expect(await run(["md5sum", "--ignore-missing", "data"])).toMatchObject({ code: 1 });
  expect(await run(["md5sum", "--quiet", "-c", "data.md5"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  await writeFile(join(dir, "dir-tagged.md5"), "MD5 (.) = d41d8cd98f00b204e9800998ecf8427e\n");
  expect(await run(["cksum", "--check", "dir-tagged.md5"])).toMatchObject({
    code: 1,
    stdout: ".: FAILED open or read\n",
    stderr: "cksum: .: Is a directory\ncksum: WARNING: 1 listed file could not be read\n",
  });
  await writeFile(join(dir, "data.md5"), "00000000000000000000000000000000  data\n");
  expect(await run(["md5sum", "--check", "data.md5"])).toMatchObject({ code: 1, stdout: "data: FAILED\n" });
  expect(await run(["md5sum", "--status", "-c", "data.md5"])).toMatchObject({ code: 1, stdout: "", stderr: "" });
  await writeFile(join(dir, "mixed.md5"), "bad line\n900150983cd24fb0d6963f7d28e17f72  data\n");
  expect(await run(["md5sum", "-c", "mixed.md5"])).toMatchObject({ code: 0, stdout: "data: OK\n" });
  const warned = await run(["md5sum", "--warn", "-c", "mixed.md5"]);
  expect(warned).toMatchObject({ code: 0, stdout: "data: OK\n" });
  expect(warned.stderr).toContain("improperly formatted MD5 checksum line");
  const warnedShort = await run(["md5sum", "-w", "-c", "mixed.md5"]);
  expect(warnedShort).toMatchObject({ code: 0, stdout: "data: OK\n" });
  expect(warnedShort.stderr).toContain("improperly formatted MD5 checksum line");
  expect(await run(["md5sum", "--strict", "-c", "mixed.md5"])).toMatchObject({ code: 1, stdout: "data: OK\n" });
  await writeFile(join(dir, "missing.md5"), "900150983cd24fb0d6963f7d28e17f72  missing\n");
  expect(await run(["md5sum", "--ignore-missing", "-c", "missing.md5"])).toMatchObject({ code: 1, stdout: "" });
  await writeFile(join(dir, "some-missing.md5"), "900150983cd24fb0d6963f7d28e17f72  missing\n900150983cd24fb0d6963f7d28e17f72  data\n");
  expect(await run(["md5sum", "--ignore-missing", "-c", "some-missing.md5"])).toMatchObject({ code: 0, stdout: "data: OK\n" });
  const sha2b64 = await run(["cksum", "--algorithm=sha2", "--length=224", "--base64", "--untagged", "data"]);
  await writeFile(join(dir, "data.sha2b64"), sha2b64.stdout);
  expect(await run(["cksum", "--algorithm=sha2", "--check", "data.sha2b64"])).toMatchObject({ code: 0, stdout: "data: OK\n" });
  const taggedSm3 = await run(["cksum", "--algorithm=sm3", "data"]);
  await writeFile(join(dir, "data.sm3"), taggedSm3.stdout);
  expect(await run(["cksum", "--check", "data.sm3"])).toMatchObject({ code: 0, stdout: "data: OK\n" });
  const untaggedMd5 = await run(["cksum", "--algorithm=md5", "--untagged", "data"]);
  await writeFile(join(dir, "data.ckmd5"), untaggedMd5.stdout);
  expect(await run(["cksum", "--algorithm=md5", "--check", "--tag", "--untagged", "data.ckmd5"])).toMatchObject({ code: 0, stdout: "data: OK\n" });
  const taggedSha2 = await run(["cksum", "--algorithm=sha2", "--length=384", "data"]);
  await writeFile(join(dir, "data.sha384tag"), taggedSha2.stdout.replace(/^SHA/, "SHA2-"));
  expect(await run(["cksum", "--algorithm=sha2", "--check", "data.sha384tag"])).toMatchObject({ code: 0, stdout: "data: OK\n" });
  const shortBlake = await run(["cksum", "--algorithm=blake2b", "--length=8", "--untagged", "data"]);
  await writeFile(join(dir, "data.b2"), shortBlake.stdout);
  expect(await run(["cksum", "--algorithm=blake2b", "--check", "data.b2"])).toMatchObject({ code: 0, stdout: "data: OK\n" });
  await writeFile(join(dir, "data.crc"), "891568578 3 data\n");
  expect(await run(["cksum", "--algorithm=crc32b", "--check", "data.crc"])).toMatchObject({ code: 1, stderr: "cksum: --check is not supported with --algorithm={bsd,sysv,crc,crc32b}\n" });
  await writeFile(join(dir, "bad.sm3"), `${taggedSm3.stdout}invalid line\n`);
  expect((await run(["cksum", "--status", "--warn", "--check", "bad.sm3"])).stderr).toContain("improperly formatted");
  expect(await run(["cksum", "--warn", "--status", "--check", "bad.sm3"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  await writeFile(join(dir, " "), "space\n");
  const spaceSum = await run(["md5sum", "--text", " "]);
  await writeFile(join(dir, "space.md5"), spaceSum.stdout);
  expect(await run(["md5sum", "--strict", "--check", "space.md5"])).toMatchObject({ code: 0, stdout: " : OK\n" });
  await writeFile(join(dir, "test\n\\\\file"), "");
  expect(await run(["md5sum", "--tag", "test\n\\\\file"])).toMatchObject({ code: 0, stdout: "\\MD5 (test\\n\\\\\\\\file) = d41d8cd98f00b204e9800998ecf8427e\n" });
});

test("launcher exposes the multi-call command surface", async () => {
  const proc = Bun.spawn([join(import.meta.dir, "../bin/bnu.js"), "echo", "via", "launcher"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(0);
  expect(await new Response(proc.stdout).text()).toBe("via launcher\n");
  await symlink(join(import.meta.dir, "../bin/bnu.js"), join(dir, "unknown-multicall"));
  const multicallPath = join(dir, "unknown-multicall");
  const multicall = Bun.spawn([multicallPath], { cwd: dir, env: { ...process.env, _: multicallPath }, stdout: "pipe", stderr: "pipe" });
  expect(await multicall.exited).toBe(1);
  expect(await new Response(multicall.stdout).text()).toBe("");
  expect(await new Response(multicall.stderr).text()).toBe("coreutils: unknown program 'unknown-multicall'\n");
  expect((await run(["cksum", "--help"])).stdout).toContain("--algorithm");
  expect(await run(["ginstall", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: install [OPTION]... [-T] SOURCE DEST\n") });
  expect((await run(["ginstall", "--help"])).stdout).toContain("--target-directory");
  const lsHelp = (await run(["ls", "--help"])).stdout;
  expect(lsHelp).toContain("List information about the FILEs (the current directory by default).\n");
  expect(lsHelp).toContain("--color");
  const tailHelp = (await run(["tail", "--help"])).stdout;
  expect(tailHelp).toContain("--sleep-interval");
  expect(tailHelp).not.toContain("--sleep\n");
  const invalid = await run(["cat", "-/"]);
  expect(invalid).toMatchObject({ code: 1 });
  expect(invalid.stderr).toContain("cat: invalid option -- '/'");
  expect(invalid.stderr).toContain("Try 'cat --help' for more information.");
  for (const command of ["factor", "fmt", "seq", "sleep", "tsort"]) {
    const result = await run([command, "-/"]);
    expect(result).toMatchObject({ code: 1 });
    expect(result.stderr).toContain(`${command}: invalid option -- '/'`);
    expect(result.stderr).toContain(`Try '${command} --help' for more information.`);
  }
  expect(await run(["yes", "--bad-option"])).toMatchObject({ code: 1, stderr: "yes: unrecognized option '--bad-option'\nTry 'yes --help' for more information.\n" });
  for (const command of ["dir", "ls", "printenv", "sort", "tty", "vdir"]) {
    const result = await run([command, "-/"]);
    expect(result).toMatchObject({ code: 2 });
    expect(result.stderr).toContain(`${command}: invalid option -- '/'`);
    expect(result.stderr).toContain(`Try '${command} --help' for more information.`);
  }
  for (const command of ["chroot", "env", "runcon", "stdbuf", "timeout"]) {
    const result = await run([command, "-/"]);
    expect(result).toMatchObject({ code: 125 });
    expect(result.stderr).toContain(`${command}: invalid option -- '/'`);
    expect(result.stderr).toContain(`Try '${command} --help' for more information.`);
  }
  for (const command of ["coreutils", "date", "dd"]) {
    const result = await run([command, "-/"]);
    expect(result).toMatchObject({ code: 1 });
    expect(result.stderr).toContain(`${command}: invalid option -- '/'`);
    expect(result.stderr).toContain(`Try '${command} --help' for more information.`);
  }
  const nohupInvalid = await run(["nohup", "-/"]);
  expect(nohupInvalid).toMatchObject({ code: 125 });
  expect(nohupInvalid.stderr).toContain("nohup: invalid option -- '/'");
  expect(nohupInvalid.stderr).toContain("Try 'nohup --help' for more information.");
});

test("GNU upstream test harness exposes selectable tests", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--list"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const stdout = await new Response(proc.stdout).text();
  const expectedDefaultTests = [
    "tests/misc/false-status.sh",
    "tests/misc/printenv.sh",
    "tests/misc/pathchk.sh",
    "tests/misc/echo.sh",
    "tests/misc/invalid-opt.pl",
    "tests/help/help-version.sh",
    "tests/help/help-version-getopt.sh",
    "tests/misc/basename.pl",
    "tests/misc/dirname.pl",
    "tests/misc/user.sh",
    "tests/env/env.sh",
    "tests/env/env-S.pl",
    "tests/env/env-S-script.sh",
    "tests/env/env-null.sh",
    "tests/env/env-signal-handler.sh",
    "tests/basenc/basenc.pl",
    "tests/basenc/base64.pl",
    "tests/basenc/large-input.sh",
    "tests/basenc/bounded-memory.sh",
    "tests/cat/cat-E.sh",
    "tests/cat/cat-buf.sh",
    "tests/cat/cat-self.sh",
    "tests/cat/cat-proc.sh",
    "tests/cat/splice.sh",
    "tests/wc/wc.pl",
    "tests/wc/wc-cpu.sh",
    "tests/wc/wc-total.sh",
    "tests/wc/wc-files0.sh",
    "tests/wc/wc-files0-from.pl",
    "tests/wc/wc-nbsp.sh",
    "tests/wc/wc-parallel.sh",
    "tests/wc/wc-proc.sh",
    "tests/id/uid.sh",
    "tests/id/zero.sh",
    "tests/id/context.sh",
    "tests/id/no-context.sh",
    "tests/groups/groups-version.sh",
    "tests/groups/groups-dash.sh",
    "tests/groups/groups-process-all.sh",
    "tests/nproc/nproc-positive.sh",
    "tests/nproc/nproc-avail.sh",
    "tests/nproc/nproc-override.sh",
    "tests/nproc/nproc-quota.sh",
    "tests/tty/tty.sh",
    "tests/stty/bad-speed.sh",
    "tests/stty/stty-invalid.sh",
    "tests/stty/stty-row-col.sh",
    "tests/stty/stty.sh",
    "tests/head/head-c.sh",
    "tests/head/head-elide-tail.pl",
    "tests/head/head-write-error.sh",
    "tests/head/head.pl",
    "tests/join/join.pl",
    "tests/join/join-utf8.sh",
    "tests/misc/comm.pl",
    "tests/misc/io-errors.sh",
    "tests/misc/tty-eof.pl",
    "tests/misc/xstrtol.pl",
    "tests/cksum/cksum.sh",
    "tests/cksum/cksum-a.sh",
    "tests/cksum/cksum-c.sh",
    "tests/cksum/cksum-base64.pl",
    "tests/cksum/cksum-base64-untagged.sh",
    "tests/cksum/cksum-raw.sh",
    "tests/cksum/sum.pl",
    "tests/cksum/sum-sysv.sh",
    "tests/cksum/b2sum.sh",
    "tests/cksum/md5sum.pl",
    "tests/cksum/md5sum-bsd.sh",
    "tests/cksum/md5sum-newline.pl",
    "tests/cksum/md5sum-parallel.sh",
    "tests/cksum/sha1sum.pl",
    "tests/cksum/sha1sum-vec.pl",
    "tests/cksum/sha224sum.pl",
    "tests/cksum/sha256sum.pl",
    "tests/cksum/sha384sum.pl",
    "tests/cksum/sha512sum.pl",
    "tests/cksum/cksum-sha3.sh",
    "tests/cksum/sm3sum.pl",
    "tests/expr/expr.pl",
    "tests/expr/expr-multibyte.pl",
    "tests/test/test-file.sh",
    "tests/test/test.pl",
    "tests/test/test-diag.pl",
    "tests/test/test-N.sh",
    "tests/seq/seq-io-errors.sh",
    "tests/seq/seq.pl",
    "tests/seq/seq-extra-number.sh",
    "tests/seq/seq-epipe.sh",
    "tests/seq/seq-locale.sh",
    "tests/seq/seq-long-double.sh",
    "tests/seq/seq-precision.sh",
    "tests/pwd/pwd-option.sh",
    "tests/pwd/argument.sh",
    "tests/pwd/pwd-long.sh",
    "tests/readlink/can-e.sh",
    "tests/readlink/can-f.sh",
    "tests/readlink/can-m.sh",
    "tests/readlink/multi.sh",
    "tests/readlink/readlink-fp-loop.sh",
    "tests/readlink/readlink-posix.sh",
    "tests/readlink/readlink-root.sh",
    "tests/readlink/rl-1.sh",
    "tests/misc/realpath.sh",
    "tests/mktemp/mktemp-misc.sh",
    "tests/mktemp/mktemp.pl",
    "tests/mktemp/bad-unicode.sh",
    "tests/mktemp/write-error.sh",
    "tests/date/date-debug.sh",
    "tests/date/date.pl",
    "tests/date/date-ethiopia.sh",
    "tests/date/date-iran.sh",
    "tests/date/date-locale-hour.sh",
    "tests/date/date-next-dow.pl",
    "tests/date/percent-percent.sh",
    "tests/date/reference.sh",
    "tests/date/resolution.sh",
    "tests/date/date-sec.sh",
    "tests/date/date-thailand.sh",
    "tests/date/date-tz.sh",
    "tests/truncate/truncate-overflow.sh",
    "tests/truncate/multiple-files.sh",
    "tests/truncate/truncate-dangling-symlink.sh",
    "tests/truncate/truncate-dir-fail.sh",
    "tests/truncate/truncate-fail-diag.sh",
    "tests/truncate/truncate-fifo.sh",
    "tests/truncate/truncate-no-create-missing.sh",
    "tests/truncate/truncate-parameters.sh",
    "tests/truncate/truncate-relative.sh",
    "tests/truncate/truncate-owned-by-other.sh",
    "tests/tee/append.sh",
    "tests/tee/tee.sh",
    "tests/uniq/uniq.pl",
    "tests/uniq/uniq-perf.sh",
    "tests/uniq/uniq-collate.sh",
    "tests/tr/tr.pl",
    "tests/tr/tr-case-class.sh",
    "tests/tac/tac.pl",
    "tests/tac/tac-2-nonseekable.sh",
    "tests/tac/tac-continue.sh",
    "tests/tac/tac-locale.sh",
    "tests/cut/cut.pl",
    "tests/cut/mb-non-utf8.sh",
    "tests/cut/bounded-memory.sh",
    "tests/cut/cut-huge-range.sh",
    "tests/touch/empty-file.sh",
    "tests/touch/60-seconds.sh",
    "tests/touch/dangling-symlink.sh",
    "tests/touch/dir-1.sh",
    "tests/touch/fifo.sh",
    "tests/touch/no-dereference.sh",
    "tests/touch/no-create-missing.sh",
    "tests/touch/no-rights.sh",
    "tests/touch/not-owner.sh",
    "tests/touch/now-owned-by-other.sh",
    "tests/touch/obsolescent.sh",
    "tests/touch/fail-diag.sh",
    "tests/touch/read-only.sh",
    "tests/touch/relative.sh",
    "tests/touch/trailing-slash.sh",
    "tests/df/total-verify.sh",
    "tests/df/df-P.sh",
    "tests/df/df-output.sh",
    "tests/df/df-symlink.sh",
    "tests/df/over-mount-device.sh",
    "tests/df/problematic-chars.sh",
    "tests/df/total-unprocessed.sh",
    "tests/df/header.sh",
    "tests/df/unreadable.sh",
    "tests/df/sync.sh",
    "tests/du/exclude.sh",
    "tests/du/basic.sh",
    "tests/du/apparent.sh",
    "tests/du/deref.sh",
    "tests/du/deref-args.sh",
    "tests/du/files0-from.pl",
    "tests/du/files0-from-dir.sh",
    "tests/du/hard-link.sh",
    "tests/du/inodes.sh",
    "tests/du/max-depth.sh",
    "tests/du/no-deref.sh",
    "tests/du/slash.sh",
    "tests/du/trailing-slash.sh",
    "tests/du/two-args.sh",
    "tests/du/inacc-dest.sh",
    "tests/du/inacc-dir.sh",
    "tests/du/inaccessible-cwd.sh",
    "tests/du/long-from-unreadable.sh",
    "tests/du/long-sloop.sh",
    "tests/du/no-x.sh",
    "tests/du/one-file-system.sh",
    "tests/du/restore-wd.sh",
    "tests/du/bind-mount-dir-cycle-v2.sh",
    "tests/du/bind-mount-dir-cycle.sh",
    "tests/du/move-dir-while-traversing.sh",
    "tests/du/threshold.sh",
    "tests/cp/same-file.sh",
    "tests/cp/link.sh",
    "tests/cp/backup-1.sh",
    "tests/cp/backup-dir.sh",
    "tests/cp/backup-is-src.sh",
    "tests/cp/abuse.sh",
    "tests/cp/acl.sh",
    "tests/cp/capability.sh",
    "tests/cp/attr-existing.sh",
    "tests/cp/cp-a-selinux.sh",
    "tests/cp/no-ctx.sh",
    "tests/cp/cp-HL.sh",
    "tests/cp/cp-deref.sh",
    "tests/cp/cp-i.sh",
    "tests/cp/cp-mv-backup.sh",
    "tests/cp/cp-mv-enotsup-xattr.sh",
    "tests/cp/cross-dev-symlink.sh",
    "tests/cp/deref-slink.sh",
    "tests/cp/debug.sh",
    "tests/cp/dir-rm-dest.sh",
    "tests/cp/dir-slash.sh",
    "tests/cp/dir-vs-file.sh",
    "tests/cp/existing-perm-dir.sh",
    "tests/cp/existing-perm-race.sh",
    "tests/cp/cp-parents.sh",
    "tests/cp/fail-perm.sh",
    "tests/cp/into-self.sh",
    "tests/cp/keep-directory-symlink.sh",
    "tests/cp/link-deref.sh",
    "tests/cp/link-no-deref.sh",
    "tests/cp/link-preserve.sh",
    "tests/cp/link-symlink.sh",
    "tests/cp/file-perm-race.sh",
    "tests/cp/no-deref-link1.sh",
    "tests/cp/no-deref-link2.sh",
    "tests/cp/no-deref-link3.sh",
    "tests/cp/non-utf8-name.sh",
    "tests/cp/nfs-removal-race.sh",
    "tests/cp/parent-perm.sh",
    "tests/cp/parent-perm-race.sh",
    "tests/cp/preserve-2.sh",
    "tests/cp/preserve-link.sh",
    "tests/cp/preserve-mode.sh",
    "tests/cp/preserve-gid.sh",
    "tests/cp/preserve-slink-time.sh",
    "tests/cp/proc-short-read.sh",
    "tests/cp/proc-zero-len.sh",
    "tests/cp/r-vs-symlink.sh",
    "tests/cp/readonly-dir.sh",
    "tests/cp/reflink-auto.sh",
    "tests/cp/reflink-perm.sh",
    "tests/cp/slink-2-slink.sh",
    "tests/cp/sparse.sh",
    "tests/cp/sparse-2.sh",
    "tests/cp/sparse-extents.sh",
    "tests/cp/sparse-extents-2.sh",
    "tests/cp/sparse-perf.sh",
    "tests/cp/sparse-to-pipe.sh",
    "tests/cp/special-bits.sh",
    "tests/cp/special-f.sh",
    "tests/cp/src-base-dot.sh",
    "tests/cp/symlink-slash.sh",
    "tests/cp/thru-dangling.sh",
    "tests/mv/acl.sh",
    "tests/mv/update.sh",
    "tests/mv/i-1.pl",
    "tests/mv/i-2.sh",
    "tests/mv/i-3.sh",
    "tests/mv/i-4.sh",
    "tests/mv/i-5.sh",
    "tests/mv/backup-is-src.sh",
    "tests/mv/childproof.sh",
    "tests/mv/no-copy.sh",
    "tests/mv/into-self.sh",
    "tests/mv/into-self-2.sh",
    "tests/mv/into-self-3.sh",
    "tests/mv/into-self-4.sh",
    "tests/mv/no-target-dir.sh",
    "tests/mv/backup-dir.sh",
    "tests/mv/dir2dir.sh",
    "tests/mv/dup-source.sh",
    "tests/mv/diag.sh",
    "tests/mv/dir-file.sh",
    "tests/mv/force.sh",
    "tests/mv/hard-link-1.sh",
    "tests/mv/hard-2.sh",
    "tests/mv/hard-3.sh",
    "tests/mv/hard-4.sh",
    "tests/mv/hardlink-case.sh",
    "tests/mv/i-link-no.sh",
    "tests/mv/mv-exchange.sh",
    "tests/mv/mv-special-1.sh",
    "tests/mv/mv-special-2.sh",
    "tests/mv/meta-to-xpart.sh",
    "tests/mv/sticky-to-xpart.sh",
    "tests/mv/mv-n.sh",
    "tests/mv/part-fail.sh",
    "tests/mv/part-hardlink.sh",
    "tests/mv/part-rename.sh",
    "tests/mv/part-symlink.sh",
    "tests/mv/partition-perm.sh",
    "tests/mv/perm-1.sh",
    "tests/mv/symlink-onto-hardlink.sh",
    "tests/mv/symlink-onto-hardlink-to-self.sh",
    "tests/mv/to-symlink.sh",
    "tests/mv/trailing-slash.sh",
    "tests/mv/atomic.sh",
    "tests/mv/atomic2.sh",
    "tests/ln/backup-1.sh",
    "tests/ln/backup-suffix-traversal.sh",
    "tests/ln/hard-backup.sh",
    "tests/ln/hard-to-sym.sh",
    "tests/ln/misc.sh",
    "tests/ln/non-utf8-src.sh",
    "tests/ln/relative.sh",
    "tests/ln/slash-decorated-nonexistent-dest.sh",
    "tests/ln/sf-1.sh",
    "tests/ln/target-1.sh",
    "tests/rm/dangling-symlink.sh",
    "tests/rm/d-1.sh",
    "tests/rm/d-2.sh",
    "tests/rm/d-3.sh",
    "tests/rm/dash-hint.sh",
    "tests/rm/dir-nonrecur.sh",
    "tests/rm/f-1.sh",
    "tests/rm/i-never.sh",
    "tests/rm/i-no-r.sh",
    "tests/rm/ignorable.sh",
    "tests/rm/dot-rel.sh",
    "tests/rm/empty-name.pl",
    "tests/rm/fail-eacces.sh",
    "tests/rm/r-1.sh",
    "tests/rm/r-2.sh",
    "tests/rm/r-3.sh",
    "tests/rm/r-4.sh",
    "tests/rm/rm1.sh",
    "tests/rm/rm2.sh",
    "tests/rm/rm3.sh",
    "tests/rm/rm4.sh",
    "tests/rm/rm5.sh",
    "tests/rm/v-slash.sh",
    "tests/rm/deep-1.sh",
    "tests/rm/deep-2.sh",
    "tests/rm/dir-no-w.sh",
    "tests/rm/empty-inacc.sh",
    "tests/rm/cycle.sh",
    "tests/rm/i-1.sh",
    "tests/rm/isatty.sh",
    "tests/rm/inaccessible.sh",
    "tests/rm/interactive-always.sh",
    "tests/rm/interactive-once.sh",
    "tests/rm/ir-1.sh",
    "tests/rm/one-file-system2.sh",
    "tests/rm/readdir-bug.sh",
    "tests/rm/rm-readdir-fail.sh",
    "tests/rm/empty-immutable-skip.sh",
    "tests/rm/fail-2eperm.sh",
    "tests/rm/no-give-up.sh",
    "tests/rm/one-file-system.sh",
    "tests/rm/read-only.sh",
    "tests/rm/sunos-1.sh",
    "tests/rm/unread2.sh",
    "tests/rm/unread3.sh",
    "tests/rm/unreadable.pl",
    "tests/rmdir/ignore.sh",
    "tests/rmdir/fail-perm.sh",
    "tests/rmdir/symlink-errors.sh",
    "tests/rmdir/t-slash.sh",
    "tests/od/od-N.sh",
    "tests/od/od.pl",
    "tests/od/od-j.sh",
    "tests/od/od-multiple-t.sh",
    "tests/od/od-endian.sh",
    "tests/od/od-float.sh",
    "tests/od/od-x8.sh",
    "tests/stat/stat-fmt.sh",
    "tests/stat/stat-printf.pl",
    "tests/stat/stat-birthtime.sh",
    "tests/stat/stat-hyphen.sh",
    "tests/stat/stat-nanoseconds.sh",
    "tests/stat/stat-slash.sh",
    "tests/chown/basic.sh",
    "tests/chown/deref.sh",
    "tests/chown/separator.sh",
    "tests/chown/preserve-root.sh",
    "tests/chgrp/basic.sh",
    "tests/chgrp/default-no-deref.sh",
    "tests/chgrp/deref.sh",
    "tests/chgrp/from.sh",
    "tests/chgrp/no-x.sh",
    "tests/chgrp/posix-H.sh",
    "tests/chgrp/recurse.sh",
    "tests/chroot/chroot-fail.sh",
    "tests/chroot/chroot-credentials.sh",
    "tests/install/install-C.sh",
    "tests/install/install-C-root.sh",
    "tests/install/install-C-selinux.sh",
    "tests/install/install-Z-selinux.sh",
    "tests/install/basic-1.sh",
    "tests/install/create-leading.sh",
    "tests/install/d-slashdot.sh",
    "tests/install/trap.sh",
    "tests/install/strip-program.sh",
    "tests/misc/dircolors.pl",
    "tests/misc/arch.sh",
    "tests/chcon/chcon-fail.sh",
    "tests/misc/coreutils.sh",
    "tests/misc/mknod.sh",
    "tests/misc/option-aliases.sh",
    "tests/pr/pr-tests.pl",
    "tests/pr/bounded-memory.sh",
    "tests/ptx/ptx.pl",
    "tests/ptx/ptx-overrun.sh",
    "tests/paste/paste.pl",
    "tests/paste/multi-byte.sh",
    "tests/expand/expand.pl",
    "tests/expand/mb.sh",
    "tests/expand/bounded-memory.sh",
    "tests/unexpand/unexpand.pl",
    "tests/unexpand/mb.sh",
    "tests/unexpand/bounded-memory.sh",
    "tests/fold/fold.pl",
    "tests/fold/fold-nbsp.sh",
    "tests/fold/fold-spaces.sh",
    "tests/fold/fold-characters.sh",
    "tests/fold/fold-zero-width.sh",
    "tests/printf/printf.sh",
    "tests/printf/printf-hex.sh",
    "tests/printf/printf-cov.pl",
    "tests/printf/printf-indexed.sh",
    "tests/printf/printf-mb.sh",
    "tests/printf/printf-quote.sh",
    "tests/printf/printf-surprise.sh",
    "tests/nl/nl.sh",
    "tests/nl/multiple-files.sh",
    "tests/nl/multibyte.sh",
    "tests/numfmt/numfmt.pl",
    "tests/numfmt/mb-non-utf8.sh",
    "tests/shuf/shuf.sh",
    "tests/fmt/base.pl",
    "tests/fmt/goal-option.sh",
    "tests/fmt/long-line.sh",
    "tests/fmt/non-space.sh",
    "tests/fmt/width.sh",
    "tests/head/head-pos.sh",
    "tests/tail/tail-c.sh",
    "tests/tail/tail.pl",
    "tests/tail/basic-seek.sh",
    "tests/tail/F-headers.sh",
    "tests/tail/F-vs-missing.sh",
    "tests/tail/F-vs-rename.sh",
    "tests/tail/descriptor-vs-rename.sh",
    "tests/tail/start-middle.sh",
    "tests/tail/tail-n0f.sh",
    "tests/tail/truncate.sh",
    "tests/tail/overlay-headers.sh",
    "tests/tail/flush-initial.sh",
    "tests/tail/retry.sh",
    "tests/tail/symlink.sh",
    "tests/tail/wait.sh",
    "tests/tail/assert.sh",
    "tests/tail/assert-2.sh",
    "tests/tail/follow-name.sh",
    "tests/tail/inotify-dir-recreate.sh",
    "tests/tail/follow-stdin.sh",
    "tests/tail/pid.sh",
    "tests/tail/pid-pipe.sh",
    "tests/tail/pipe-f.sh",
    "tests/tail/pipe-f2.sh",
    "tests/tail/proc-ksyms.sh",
    "tests/tail/tail-sysfs.sh",
    "tests/tail/append-only.sh",
    "tests/tail/debug.sh",
    "tests/tail/end-of-device.sh",
    "tests/tail/inotify-only-regular.sh",
    "tests/tail/inotify-rotate-resources.sh",
    "tests/split/filter.sh",
    "tests/split/suffix-length.sh",
    "tests/split/suffix-auto-length.sh",
    "tests/split/additional-suffix.sh",
    "tests/split/b-chunk.sh",
    "tests/split/l-chunk.sh",
    "tests/split/l-chunk-root.sh",
    "tests/split/r-chunk.sh",
    "tests/split/numeric.sh",
    "tests/split/record-sep.sh",
    "tests/split/split-io-err.sh",
    "tests/split/fail.sh",
    "tests/split/guard-input.sh",
    "tests/split/non-utf8.sh",
    "tests/split/line-bytes.sh",
    "tests/csplit/csplit.sh",
    "tests/csplit/csplit-1000.sh",
    "tests/csplit/csplit-suppress-matched.pl",
    "tests/csplit/csplit-io-err.sh",
    "tests/shred/shred-exact.sh",
    "tests/shred/shred-passes.sh",
    "tests/shred/shred-remove.sh",
    "tests/shred/shred-size.sh",
    "tests/dd/misc.sh",
    "tests/dd/bytes.sh",
    "tests/dd/conv-case.sh",
    "tests/dd/stderr.sh",
    "tests/dd/stats.sh",
    "tests/dd/ascii.sh",
    "tests/dd/reblock.sh",
    "tests/dd/unblock.pl",
    "tests/dd/unblock-sync.sh",
    "tests/dd/skip-seek.pl",
    "tests/dd/skip-seek2.sh",
    "tests/dd/sparse.sh",
    "tests/dd/not-rewound.sh",
    "tests/dd/direct.sh",
    "tests/dd/nocache.sh",
    "tests/dd/nocache_eof.sh",
    "tests/dd/nocache_fail.sh",
    "tests/dd/fail-ftruncate-fstat.sh",
    "tests/dd/partial-write.sh",
    "tests/dd/skip-seek-past-file.sh",
    "tests/dd/skip-seek-past-dev.sh",
    "tests/sort/sort.pl",
    "tests/sort/sort-locale.sh",
    "tests/sort/sort-debug-warn.sh",
    "tests/sort/sort-debug-keys.sh",
    "tests/sort/sort-discrim.sh",
    "tests/sort/sort-field-limit.sh",
    "tests/sort/sort-exit-early.sh",
    "tests/sort/sort-rand.sh",
    "tests/sort/sort-h-thousands-sep.sh",
    "tests/sort/sort-compress.sh",
    "tests/sort/sort-files0-from.pl",
    "tests/sort/sort-float.sh",
    "tests/sort/sort-merge.pl",
    "tests/sort/sort-month.sh",
    "tests/sort/sort-NaN-infloop.sh",
    "tests/sort/sort-unique.sh",
    "tests/sort/sort-version.sh",
    "tests/timeout/init-parent.sh",
    "tests/timeout/timeout-blocked.pl",
    "tests/timeout/timeout-parameters.sh",
    "tests/timeout/timeout.sh",
    "tests/timeout/timeout-large-parameters.sh",
    "tests/timeout/timeout-group.sh",
    "tests/runcon/runcon-compute.sh",
    "tests/runcon/runcon-no-reorder.sh",
    "tests/misc/nohup.sh",
    "tests/nice/nice-fail.sh",
    "tests/nice/nice.sh",
    "tests/misc/stdbuf.sh",
    "tests/misc/sync.sh",
    "tests/misc/sleep.sh",
    "tests/misc/yes.sh",
    "tests/misc/kill.sh",
    "tests/misc/time-style.sh",
    "tests/misc/tsort.pl",
    "tests/misc/usage_vs_getopt.sh",
    "tests/misc/getopt_vs_usage.sh",
    "tests/misc/usage_vs_refs.sh",
    "tests/misc/warning-errors.sh",
    "tests/chmod/c-option.sh",
    "tests/chmod/equal-x.sh",
    "tests/chmod/equals.sh",
    "tests/chmod/ignore-symlink.sh",
    "tests/chmod/no-x.sh",
    "tests/chmod/octal.sh",
    "tests/chmod/only-op.sh",
    "tests/chmod/partial-fail.sh",
    "tests/chmod/setgid.sh",
    "tests/chmod/inaccessible.sh",
    "tests/chmod/silent.sh",
    "tests/chmod/symlinks.sh",
    "tests/chmod/thru-dangling.sh",
    "tests/chmod/umask-x.sh",
    "tests/chmod/usage.sh",
    "tests/ls/ls-misc.pl",
    "tests/ls/ls-time.sh",
    "tests/ls/recursive.sh",
    "tests/ls/a-option.sh",
    "tests/ls/no-arg.sh",
    "tests/ls/file-type.sh",
    "tests/ls/classify.sh",
    "tests/ls/abmon-align.sh",
    "tests/ls/birthtime.sh",
    "tests/ls/color-clear-to-eol.sh",
    "tests/ls/color-dtype-dir.sh",
    "tests/ls/color-norm.sh",
    "tests/ls/color-term.sh",
    "tests/ls/color-ext.sh",
    "tests/ls/dangle.sh",
    "tests/ls/infloop.sh",
    "tests/ls/symlink-slash.sh",
    "tests/ls/symlink-loop.sh",
    "tests/ls/zero-option.sh",
    "tests/ls/time-style-diag.sh",
    "tests/ls/x-option.sh",
    "tests/ls/m-option.sh",
    "tests/ls/block-size.sh",
    "tests/ls/dired.sh",
    "tests/ls/follow-slink.sh",
    "tests/ls/group-dirs.sh",
    "tests/ls/hex-option.sh",
    "tests/ls/hyperlink.sh",
    "tests/ls/inode.sh",
    "tests/ls/w-option.sh",
    "tests/ls/multihardlink.sh",
    "tests/ls/non-utf8-hidden.sh",
    "tests/ls/quote-align.sh",
    "tests/ls/quoting-utf8.sh",
    "tests/ls/acl.sh",
    "tests/ls/capability.sh",
    "tests/ls/no-cap.sh",
    "tests/ls/getxattr-speedup.sh",
    "tests/ls/nameless-uid.sh",
    "tests/ls/size-align.sh",
    "tests/ls/symlink-quote.sh",
    "tests/ls/slink-acl.sh",
    "tests/ls/sort-width-option.sh",
    "tests/ls/readdir-mountpoint-inode.sh",
    "tests/ls/selinux-segfault.sh",
    "tests/ls/stat-vs-dirent.sh",
    "tests/ls/stat-free-color.sh",
    "tests/ls/stat-free-symlinks.sh",
    "tests/ls/stat-dtype.sh",
    "tests/ls/stat-failed.sh",
    "tests/ls/removed-directory.sh",
    "tests/ls/root-rel-symlink-color.sh",
    "tests/ls/rt-1.sh",
    "tests/fold/multiple-files.sh",
    "tests/mkdir/p-1.sh",
    "tests/mkdir/p-2.sh",
    "tests/mkdir/p-3.sh",
    "tests/mkdir/p-acl.sh",
    "tests/mkdir/p-slashdot.sh",
    "tests/mkdir/p-thru-slink.sh",
    "tests/mkdir/p-v.sh",
    "tests/mkdir/parents.sh",
    "tests/mkdir/perm.sh",
    "tests/mkdir/special-1.sh",
    "tests/mkdir/t-slash.sh",
    "tests/mkdir/restorecon.sh",
    "tests/mkdir/selinux.sh",
    "tests/mkdir/writable-under-readonly.sh",
    "tests/misc/read-errors.sh",
    "tests/misc/close-stdout.sh",
    "tests/misc/responsive.sh",
    "tests/misc/xattr.sh",
    "tests/misc/selinux.sh",
    "tests/split/lines.sh",
    "tests/factor/factor.pl",
    "tests/factor/factor-parallel.sh",
  ];
  expect(stdout).toBe(`${expectedDefaultTests.join("\n")}\n`);

  const allProc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--all", "--list"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await allProc.exited).toBe(0);
  const allStdout = await new Response(allProc.stdout).text();
  expect(allStdout).toContain("tests/misc/echo.sh\n");
  expect(allStdout).toContain("tests/split/fail.sh\n");
  expect(allStdout).toContain("tests/ls/group-dirs.sh\n");
  expect(allStdout).toContain("tests/factor/t00.sh\n");
  expect(allStdout).not.toContain("tests/ls/dtype-color.sh\n");

  const rootProc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--root-tests", "--list"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await rootProc.exited).toBe(0);
  const rootTests = (await new Response(rootProc.stdout).text()).trim().split("\n");
  expect(rootTests).toHaveLength(41);
  expect(rootTests).toContain("tests/chown/basic.sh");

  const nonRootProc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--nonroot-tests", "--list"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await nonRootProc.exited).toBe(0);
  const nonRootTests = (await new Response(nonRootProc.stdout).text()).trim().split("\n");
  expect(nonRootTests).toHaveLength(692);
  expect(nonRootTests).not.toContain("tests/chown/basic.sh");
});

test("GNU upstream test harness can select a bounded test", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--max-output", "64KiB", "--list", "tests/misc/echo.sh"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const stdout = await new Response(proc.stdout).text();
  expect(stdout).toBe("tests/misc/echo.sh\n");
});

test("GNU upstream test harness accepts very expensive opt-in flag", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--very-expensive", "--list"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const stdout = await new Response(proc.stdout).text();
  expect(stdout).toContain("tests/misc/echo.sh\n");
  expect(stdout).toContain("tests/stty/stty-pairs.sh\n");
  expect(stdout).toContain("tests/sort/sort-compress-proc.sh\n");
  expect(stdout).toContain("tests/od/big-w.sh\n");
  expect(stdout).toContain("tests/du/8gb.sh\n");
  expect(stdout).toContain("tests/rm/ext3-perf.sh\n");
  expect(stdout).toContain("tests/tail/big-4gb.sh\n");
  expect(stdout).toContain("tests/tail/inotify-hash-abuse2.sh\n");
  expect(stdout).toContain("tests/tail/inotify-rotate.sh\n");
  expect(stdout).toContain("tests/sort/sort-benchmark-random.sh\n");
  expect(stdout).toContain("tests/sort/sort-compress-hang.sh\n");
  expect(stdout).toContain("tests/cp/perm.sh\n");
  expect(stdout).toContain("tests/factor/t05.sh\n");
  expect(stdout).toContain("tests/factor/t40.sh\n");
});

test("GNU upstream test harness accepts expensive opt-in flag", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--expensive", "--list"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const stdout = await new Response(proc.stdout).text();
  expect(stdout).toContain("tests/misc/echo.sh\n");
  expect(stdout).toContain("tests/sort/sort-compress-proc.sh\n");
  expect(stdout).toContain("tests/du/fd-leak.sh\n");
  expect(stdout).toContain("tests/mv/leak-fd.sh\n");
  expect(stdout).toContain("tests/rm/hash.sh\n");
  expect(stdout).toContain("tests/tail/big-4gb.sh\n");
  expect(stdout).toContain("tests/tail/inotify-hash-abuse.sh\n");
  expect(stdout).toContain("tests/tail/inotify-hash-abuse2.sh\n");
  expect(stdout).toContain("tests/tail/inotify-rotate.sh\n");
});

test("GNU upstream test harness accepts terminal test mode", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--tty", "--list", "tests/stty/stty-row-col.sh"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  expect(await new Response(proc.stdout).text()).toBe("tests/stty/stty-row-col.sh\n");
});

test("GNU upstream test harness supplies errno constants", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--max-output", "64KiB", "tests/rm/d-2.sh"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect(stdout).toContain("PASS tests/rm/d-2.sh\n");
  expect(stderr).not.toContain("FAIL tests/rm/d-2.sh");
});

test("GNU upstream test harness wrappers preserve option separators", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--max-output", "64KiB", "tests/od/od.pl"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect(stdout).toContain("PASS tests/od/od.pl\n");
  expect(stderr).not.toContain("invalid-off-4");
});

test("GNU upstream test harness exposes cksum algorithm help", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--max-output", "128KiB", "tests/cksum/cksum-base64.pl"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect(stdout).toContain("PASS tests/cksum/cksum-base64.pl\n");
  expect(stderr).not.toContain("not equal to");
});

test("GNU upstream test harness exposes df output help", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--max-output", "128KiB", "tests/df/df-output.sh"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect(stdout).toContain("PASS tests/df/df-output.sh\n");
  expect(stderr).not.toContain("Usage: df [OPTION]... [FILE]...");
});

test("GNU upstream test harness runs observable tail inotify fallback coverage", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--strict", "--max-output", "128KiB", "tests/tail/inotify-dir-recreate.sh", "tests/tail/inotify-race.sh"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const stdout = await new Response(proc.stdout).text();
  expect(stdout).toContain("PASS tests/tail/inotify-dir-recreate.sh\n");
  expect(stdout).toContain("PASS tests/tail/inotify-race.sh\n");
  expect(stdout).toContain("GNU tests: 2 passed, 0 skipped, 0 failed\n");
});

test("GNU upstream test harness runs timeout process-group coverage", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--strict", "--max-output", "64KiB", "tests/timeout/timeout-group.sh"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect(stdout).toContain("PASS tests/timeout/timeout-group.sh\n");
  expect(stdout).toContain("GNU tests: 1 passed, 0 skipped, 0 failed\n");
  expect(stderr).not.toContain("getcwd() failed");
});

test("GNU upstream test harness suppresses expected deleted-cwd readlink noise", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--strict", "--max-output", "64KiB", "tests/readlink/can-e.sh", "tests/readlink/can-f.sh", "tests/readlink/can-m.sh"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  expect(stdout).toContain("PASS tests/readlink/can-e.sh\n");
  expect(stdout).toContain("PASS tests/readlink/can-f.sh\n");
  expect(stdout).toContain("PASS tests/readlink/can-m.sh\n");
  expect(stdout).toContain("GNU tests: 3 passed, 0 skipped, 0 failed\n");
  expect(stderr).not.toContain("getcwd() failed");
});

test("GNU upstream test harness exposes a compiler for helper probes", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/run-gnu-tests.js", "--strict", "--max-output", "1MiB", "tests/rm/r-root.sh"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await proc.exited).toBe(0);
  const stderr = await new Response(proc.stderr).text();
  expect(stderr).not.toContain("-Wall: command not found");
});

test("expand, unexpand, fold and tac transform text", async () => {
  expect(await run(["expand", "-t", "4"], "a\tb\n")).toMatchObject({ code: 0, stdout: "a   b\n" });
  expect(await run(["expand", "-3"], "a\tb\tc")).toMatchObject({ code: 0, stdout: "a  b  c" });
  expect(await run(["expand", "-4", "-9"], "a\tb\tc")).toMatchObject({ code: 0, stdout: "a   b    c" });
  expect(await run(["expand", "--tabs=3 6 9"], "a\tb\tc\td\te")).toMatchObject({ code: 0, stdout: "a  b  c  d e" });
  expect(await run(["expand", "--tabs=1,/5"], "\ta\tb\tc")).toMatchObject({ code: 0, stdout: " a   b    c" });
  expect(await run(["expand", "--tabs=1,+5"], "\ta\tb\tc")).toMatchObject({ code: 0, stdout: " a    b    c" });
  expect(await run(["expand", "--tabs=+/5"], "\ta\tb")).toMatchObject({ code: 0, stdout: "     a    b" });
  expect(await run(["expand", "--tabs=+0"], "a\tb\n")).toMatchObject({ code: 0, stdout: "a       b\n" });
  expect(await run(["expand", "--tabs=1,+0"], "a\tb\n")).toMatchObject({ code: 0, stdout: "a b\n" });
  expect(await run(["expand", "-t+"], "\ta\tb\n")).toMatchObject({ code: 0, stdout: "        a       b\n" });
  expect(await run(["expand", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: expand [OPTION]... [FILE]...\n") });
  expect(await run(["expand", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Convert tabs in each FILE to spaces, writing to standard output.\n") });
  expect(await run(["expand", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["expand", "--t=4"], "a\tb\n")).toMatchObject({ code: 0, stdout: "a   b\n" });
  expect(await run(["expand", "--i"], "a\tb\n \tc\n")).toMatchObject({ code: 0, stdout: "a\tb\n        c\n" });
  expect(await run(["expand", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "expand: unrecognized option '--bad'\nTry 'expand --help' for more information.\n" });
  expect(await run(["expand", "-x", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "expand: invalid option -- 'x'\nTry 'expand --help' for more information.\n" });
  expect(await run(["expand", "--h=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "expand: option '--help' doesn't allow an argument\nTry 'expand --help' for more information.\n" });
  expect(await run(["expand", "--tabs", "--help"])).toMatchObject(await systemRun(["expand", "--tabs", "--help"]));
  expect(await run(["expand", "-t", "bad", "--help"])).toMatchObject(await systemRun(["expand", "-t", "bad", "--help"]));
  expect(await run(["expand", "-tbad", "--help"])).toMatchObject(await systemRun(["expand", "-tbad", "--help"]));
  expect(await run(["expand", "--tabs=999999999999999999999999999999", "--help"])).toMatchObject(await systemRun(["expand", "--tabs=999999999999999999999999999999", "--help"]));
  expect(await run(["expand", "--tabs=0", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: expand [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["expand", "--tabs=1,2", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: expand [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["expand", "--tabs=1", "-t/5"], "\ta\tb\tc")).toMatchObject({ code: 0, stdout: " a   b    c" });
  const expandChunkBoundary = Buffer.concat([Buffer.alloc(65535, 0x61), Buffer.from("界\tz\n")]);
  expect(await run(["expand", "-t4"], expandChunkBoundary)).toMatchObject(await systemRun(["expand", "-t4"], expandChunkBoundary));
  expect(await run(["expand", "--tab=1,2", "-t+5"], "\ta\tb\tc")).toMatchObject({ code: 0, stdout: " a     b    c" });
  expect(await run(["expand", "--tabs=/,/5"], "\ta\tb")).toMatchObject({ code: 0, stdout: "     a    b" });
  expect(await run(["expand"], "\bc\td")).toMatchObject({ code: 0, stdout: "\bc       d" });
  await writeFile(join(dir, "expand-in"), "one\ntwo\nthree\n");
  expect(await run(["expand", "expand-missing-a", "expand-in", "expand-missing-b"])).toMatchObject({ code: 1, stdout: "one\ntwo\nthree\n", stderr: "expand: expand-missing-a: No such file or directory\nexpand: expand-missing-b: No such file or directory\n" });
  expect(await run(["expand", "missing'expand"])).toMatchObject({ code: 1, stdout: "", stderr: "expand: \"missing'expand\": No such file or directory\n" });
  expect(await run(["expand", "missing\nexpand"])).toMatchObject({ code: 1, stdout: "", stderr: "expand: 'missing'$'\\n''expand': No such file or directory\n" });
  await mkdir(join(dir, "expand-dir"));
  expect(await run(["expand", "expand-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "expand: expand-dir: Is a directory\n" });
  await mkdir(join(dir, "dir'expand"));
  expect(await run(["expand", "dir'expand"])).toMatchObject({ code: 1, stdout: "", stderr: "expand: \"dir'expand\": Is a directory\n" });
  expect((await run(["expand", "--tabs=a"])).stderr).toContain("tab size contains invalid character");
  expect(await run(["expand", "--tabs=a\nb"])).toMatchObject({ code: 1, stdout: "", stderr: `expand: tab size contains invalid character(s): ${diagnosticQuote("a\\nb")}\n` });
  expect(await run(["expand", "--tabs=999999999999999999999999999999\n9"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `expand: tab stop is too large ${diagnosticQuote("999999999999999999999999999999")}\nexpand: tab size contains invalid character(s): ${diagnosticQuote("\\n9")}\n`,
  });
  expect(await run(["expand", "-t1x"])).toMatchObject(await systemRun(["expand", "-t1x"]));
  expect(await run(["expand", "-t1,+x"])).toMatchObject(await systemRun(["expand", "-t1,+x"]));
  expect((await run(["expand", "--tabs=0"])).stderr).toContain("tab size cannot be 0");
  expect(await run(["expand", "--tabs=3,3"])).toMatchObject({ code: 1 });
  expect(await run(["expand", "--tabs=/3,6,8"])).toMatchObject({ code: 1 });
  expect(await run(["expand", "-t/3", "-t/6"])).toMatchObject({ code: 1 });
  expect(await run(["expand", `-t${"18446744073709551616"}`])).toMatchObject({ code: 1 });
  expect(await run(["unexpand", "-a", "-t", "4"], "a   b\n")).toMatchObject({ code: 0, stdout: "a\tb\n" });
  expect(await run(["unexpand", "-t", "3"], "   a  b\n")).toMatchObject({ code: 0, stdout: "\ta\tb\n" });
  expect(await run(["unexpand", "-t", "3", "--first-only"], "   a  b\n")).toMatchObject({ code: 0, stdout: "\ta  b\n" });
  expect(await run(["unexpand", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: unexpand [OPTION]... [FILE]...\n") });
  expect(await run(["unexpand", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Convert blanks in each FILE to tabs, writing to standard output.\n") });
  expect(await run(["unexpand", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["unexpand", "--t=3"], "   a  b\n")).toMatchObject({ code: 0, stdout: "\ta\tb\n" });
  expect(await run(["unexpand", "--f"], "   a  b\n")).toMatchObject({ code: 0, stdout: "   a  b\n" });
  expect(await run(["unexpand", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "unexpand: unrecognized option '--bad'\nTry 'unexpand --help' for more information.\n" });
  expect(await run(["unexpand", "-x", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "unexpand: invalid option -- 'x'\nTry 'unexpand --help' for more information.\n" });
  expect(await run(["unexpand", "--h=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "unexpand: option '--help' doesn't allow an argument\nTry 'unexpand --help' for more information.\n" });
  expect(await run(["unexpand", "--tabs", "--help"])).toMatchObject(await systemRun(["unexpand", "--tabs", "--help"]));
  expect(await run(["unexpand", "-t", "bad", "--help"])).toMatchObject(await systemRun(["unexpand", "-t", "bad", "--help"]));
  expect(await run(["unexpand", "-tbad", "--help"])).toMatchObject(await systemRun(["unexpand", "-tbad", "--help"]));
  expect(await run(["unexpand", "--tabs=999999999999999999999999999999", "--help"])).toMatchObject(await systemRun(["unexpand", "--tabs=999999999999999999999999999999", "--help"]));
  expect(await run(["unexpand", "--tabs=0", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: unexpand [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["unexpand", "--tabs=1,2", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: unexpand [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["unexpand", "-a", "-3"], "a  b  c")).toMatchObject({ code: 0, stdout: "a\tb\tc" });
  expect(await run(["unexpand", "-3"], "   a   b")).toMatchObject({ code: 0, stdout: "\ta   b" });
  expect(await run(["unexpand", "-a", "-t", "8,9"], "x\t \t y\n")).toMatchObject({ code: 0, stdout: "x\t\t\t y\n" });
  const unexpandChunkBoundary = Buffer.concat([Buffer.alloc(65535, 0x61), Buffer.from("  b\n")]);
  expect(await run(["unexpand", "-a", "-t8"], unexpandChunkBoundary)).toMatchObject(await systemRun(["unexpand", "-a", "-t8"], unexpandChunkBoundary));
  expect(await run(["unexpand", "--tabs=+0"], "a       b\n")).toMatchObject({ code: 0, stdout: "a\tb\n" });
  expect(await run(["unexpand", "--tabs=1,+0"], "a b\n")).toMatchObject({ code: 0, stdout: "a b\n" });
  expect(await run(["unexpand", "--tabs=a\nb"])).toMatchObject({ code: 1, stdout: "", stderr: `unexpand: tab size contains invalid character(s): ${diagnosticQuote("a\\nb")}\n` });
  expect(await run(["unexpand", "--tabs=999999999999999999999999999999\n9"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `unexpand: tab stop is too large ${diagnosticQuote("999999999999999999999999999999")}\nunexpand: tab size contains invalid character(s): ${diagnosticQuote("\\n9")}\n`,
  });
  expect(await run(["unexpand", "-t+"], "\ta\tb\n")).toMatchObject({ code: 0, stdout: "\ta\tb\n" });
  expect(await run(["unexpand", "unexpand-missing-a", "expand-in", "unexpand-missing-b"])).toMatchObject({ code: 1, stdout: "one\ntwo\nthree\n", stderr: "unexpand: unexpand-missing-a: No such file or directory\nunexpand: unexpand-missing-b: No such file or directory\n" });
  expect(await run(["unexpand", "missing'unexpand"])).toMatchObject({ code: 1, stdout: "", stderr: "unexpand: \"missing'unexpand\": No such file or directory\n" });
  expect(await run(["unexpand", "missing\nunexpand"])).toMatchObject({ code: 1, stdout: "", stderr: "unexpand: 'missing'$'\\n''unexpand': No such file or directory\n" });
  expect(await run(["expand", "expand-in", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: expand [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["unexpand", "expand-in", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: unexpand [OPTION]... [FILE]...\n"), stderr: "" });
  await mkdir(join(dir, "unexpand-dir"));
  expect(await run(["unexpand", "unexpand-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "unexpand: unexpand-dir: Is a directory\n" });
  await mkdir(join(dir, "dir'unexpand"));
  expect(await run(["unexpand", "dir'unexpand"])).toMatchObject({ code: 1, stdout: "", stderr: "unexpand: \"dir'unexpand\": Is a directory\n" });
  expect(await run(["unexpand", "-t"])).toMatchObject({ code: 1, stderr: "unexpand: option requires an argument -- 't'\nTry 'unexpand --help' for more information.\n" });
  expect(await run(["unexpand", "-t1x"])).toMatchObject(await systemRun(["unexpand", "-t1x"]));
  expect(await run(["unexpand", "-t1,+x"])).toMatchObject(await systemRun(["unexpand", "-t1,+x"]));
  expect(await run(["fold", "-w", "4"], "abcdef\n")).toMatchObject({ code: 0, stdout: "abcd\nef\n" });
  const foldZeroWidth = Buffer.alloc(65537);
  expect(await run(["fold"], foldZeroWidth)).toMatchObject(await systemRun(["fold"], foldZeroWidth));
  expect(await run(["fold", "--characters"], foldZeroWidth)).toMatchObject(await systemRun(["fold", "--characters"], foldZeroWidth));
  expect(await run(["wc", "-L"], "\u200B\n")).toMatchObject({ code: 0, stdout: "0\n" });
  expect(await run(["fold", "-4"], "abcdef\n")).toMatchObject({ code: 0, stdout: "abcd\nef\n" });
  expect(await run(["fold", "-b4"], "abcdef\n")).toMatchObject({ code: 0, stdout: "abcd\nef\n" });
  expect(await run(["fold", "-c4"], "abcdef\n")).toMatchObject({ code: 0, stdout: "abcd\nef\n" });
  expect(await run(["fold", "-s4"], "abcdef\n")).toMatchObject({ code: 0, stdout: "abcd\nef\n" });
  expect(await run(["fold", "-w", "+4"], "abcdef\n")).toMatchObject({ code: 0, stdout: "abcd\nef\n" });
  expect(await run(["fold", "-c", "-w", "3"], "ééx\n")).toMatchObject({ code: 0, stdout: "ééx\n" });
  expect(await run(["fold", "-b", "-w", "3"], "ééx\n")).toMatchObject({ code: 0, stdout: "é\néx\n" });
  expect(await run(["fold", "-b", "-c", "-w", "3"], "ééx\n")).toMatchObject({ code: 0, stdout: "ééx\n" });
  expect(await run(["fold", "-c", "-b", "-w", "3"], "ééx\n")).toMatchObject({ code: 0, stdout: "é\néx\n" });
  expect(await run(["fold", "--bytes", "--spaces", "-w", "6"], "one two three\n")).toMatchObject({ code: 0, stdout: "one \ntwo \nthree\n" });
  expect(await run(["fold", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: fold [OPTION]... [FILE]...\n") });
  expect(await run(["fold", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Wrap input lines in each FILE, writing to standard output.\n") });
  expect(await run(["fold", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["fold", "expand-in", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: fold [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["fold", "--b", "--w=3"], "ééx\n")).toMatchObject({ code: 0, stdout: "é\néx\n" });
  expect(await run(["fold", "--c", "--w=3"], "ééx\n")).toMatchObject({ code: 0, stdout: "ééx\n" });
  expect(await run(["fold", "--s", "--w=4"], "a cd fgh\n")).toMatchObject({ code: 0, stdout: "a \ncd \nfgh\n" });
  expect(await run(["fold", "--bad", "--help"], "x")).toMatchObject({ code: 1, stdout: "", stderr: "fold: unrecognized option '--bad'\nTry 'fold --help' for more information.\n" });
  expect(await run(["fold", "-x", "--help"], "x")).toMatchObject({ code: 1, stdout: "", stderr: "fold: invalid option -- 'x'\nTry 'fold --help' for more information.\n" });
  expect(await run(["fold", "--h=foo"], "x")).toMatchObject({ code: 1, stdout: "", stderr: "fold: option '--help' doesn't allow an argument\nTry 'fold --help' for more information.\n" });
  expect(await run(["fold", "--b=foo"], "x")).toMatchObject({ code: 1, stdout: "", stderr: "fold: option '--bytes' doesn't allow an argument\nTry 'fold --help' for more information.\n" });
  expect(await run(["fold", "--width", "--help"], "x")).toMatchObject(await systemRun(["fold", "--width", "--help"], "x"));
  expect(await run(["fold", "--width=1", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: fold [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["fold", "--width", "bad", "--help"])).toMatchObject(await systemRun(["fold", "--width", "bad", "--help"]));
  expect(await run(["fold", "-wbad", "--help"])).toMatchObject(await systemRun(["fold", "-wbad", "--help"]));
  expect(await run(["fold", "-w0", "--help"])).toMatchObject(await systemRun(["fold", "-w0", "--help"]));
  expect(await run(["fold", "-4x", "--help"])).toMatchObject(await systemRun(["fold", "-4x", "--help"]));
  expect(await run(["fold", "-bs4x", "--help"])).toMatchObject(await systemRun(["fold", "-bs4x", "--help"]));
  expect(await run(["fold", "-w", "2", "-s"], "a\t")).toMatchObject({ code: 0, stdout: "a\n\t" });
  expect(await run(["fold", "-w", "4", "-s"], "a cd fgh\n")).toMatchObject({ code: 0, stdout: "a \ncd \nfgh\n" });
  expect(await run(["fold", "--spaces", "-w", "10"], "abcdefghijklmnop\u2007qrstuvwxyz\n")).toMatchObject({ code: 0, stdout: "abcdefghij\nklmnop\u2007qrs\ntuvwxyz\n" });
  expect(await run(["fold", "--spaces", "-w", "10"], "abcdefghijklmnop\u2002qrstuvwxyz\n")).toMatchObject({ code: 0, stdout: "abcdefghij\nklmnop\u2002\nqrstuvwxyz\n" });
  expect(await run(["fold", "--characters", "-w", "5"], "\uB250\uB250\uB250\n")).toMatchObject({ code: 0, stdout: "\uB250\uB250\uB250\n" });
  expect(await run(["fold", "-w", "2"], "e\u0301e\u0301x\n")).toMatchObject({ code: 0, stdout: "e\u0301e\u0301\nx\n" });
  expect(await run(["fold", "-w", "3"], "ab\fcd\n")).toMatchObject({ code: 0, stdout: "ab\f\ncd\n" });
  expect(await run(["fold", "-w", "0"], "x")).toMatchObject(await systemRun(["fold", "-w", "0"], "x"));
  expect(await run(["fold", "-w", "+0"], "x")).toMatchObject(await systemRun(["fold", "-w", "+0"], "x"));
  expect(await run(["fold", "-w", "bad"], "x")).toMatchObject(await systemRun(["fold", "-w", "bad"], "x"));
  expect(await run(["fold", "-w", "1\n2"], "x")).toMatchObject({ code: 1, stdout: "", stderr: `fold: invalid number of columns: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["fold", "-w", "0\n"], "x")).toMatchObject({ code: 1, stdout: "", stderr: `fold: invalid number of columns: ${diagnosticQuote("0\\n")}\n` });
  expect(await run(["fold", "-w", "9223372036854775808"], "abc\n")).toMatchObject({ code: 0, stdout: "abc\n" });
  expect(await run(["fold", "-w", "18446744073709551610"], "x")).toMatchObject(await systemRun(["fold", "-w", "18446744073709551610"], "x"));
  expect(await run(["fold", "-4x"], "x")).toMatchObject(await systemRun(["fold", "-4x"], "x"));
  expect(await run(["fold", "-bs4x"], "x")).toMatchObject(await systemRun(["fold", "-bs4x"], "x"));
  expect(await run(["fold", "missing'fold"])).toMatchObject({ code: 1, stdout: "", stderr: "fold: \"missing'fold\": No such file or directory\n" });
  expect(await run(["fold", "missing\nfold"])).toMatchObject({ code: 1, stdout: "", stderr: "fold: 'missing'$'\\n''fold': No such file or directory\n" });
  await mkdir(join(dir, "dir'fold"));
  expect(await run(["fold", "dir'fold"])).toMatchObject({ code: 1, stdout: "", stderr: "fold: \"dir'fold\": Is a directory\n" });
  await writeFile(join(dir, "fold-raw"), Uint8Array.of(0xff, 0x61, 0x0a));
  const foldRaw = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "fold", "-w1", "fold-raw"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "fold-raw-out")),
    stderr: "pipe",
  });
  expect(await foldRaw.exited).toBe(0);
  expect(await new Response(foldRaw.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "fold-raw-out"))]).toEqual([0xff, 0x0a, 0x61, 0x0a]);
  const foldRawStdin = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "fold", "-w1"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: Bun.file(join(dir, "fold-raw")),
    stdout: Bun.file(join(dir, "fold-raw-stdin-out")),
    stderr: "pipe",
  });
  expect(await foldRawStdin.exited).toBe(0);
  expect(await new Response(foldRawStdin.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "fold-raw-stdin-out"))]).toEqual([0xff, 0x0a, 0x61, 0x0a]);
  await mkdir(join(dir, "fold-dir"));
  expect(await run(["fold", "fold-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "fold: fold-dir: Is a directory\n" });
  expect(await shell(`printf '\\303' | "$BUN" "$BNU" fold | wc -c`)).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["tac"], "one\ntwo\nthree\n")).toMatchObject({ code: 0, stdout: "three\ntwo\none\n" });
  expect(await run(["tac"], "a\n", { env: { TMPDIR: join(dir, "missing-tac-tmpdir") } })).toMatchObject({ code: 0, stdout: "a\n", stderr: "" });
  expect(await run(["tac", "-s", ":"], "a:b:c:")).toMatchObject({ code: 0, stdout: "c:b:a:" });
  expect(await run(["tac", "-s", ""], "a\0b\0")).toMatchObject({ code: 0, stdout: "b\0a\0" });
  expect(await run(["tac", "-r", "-s", ""], "a\0b\0")).toMatchObject({ code: 1, stderr: "tac: separator cannot be empty\n" });
  expect(await run(["tac", "-r", "-s", "\\._+"], "1._2.__3.___4._")).toMatchObject({ code: 0, stdout: "4._3.___2.__1._" });
  expect(await run(["tac", "-r", "-s", "[0-9]+"], "aa11bb222cc")).toMatchObject({ code: 0, stdout: "cc22bb21aa1" });
  expect(await run(["tac", "-r", "-s", ".."], "aa11bb222cc")).toMatchObject({ code: 0, stdout: "cc22b21baa1" });
  expect(await run(["tac", "-r", "-s", "("], "a(b(c")).toMatchObject({ code: 0, stdout: "cb(a(" });
  expect(await run(["tac", "-r", "-s", "(b)"], "a(b)c(b)d")).toMatchObject({ code: 0, stdout: "dc(b)a(b)" });
  expect(await run(["tac", "-r", "-s", "\\|"], "aaabbbab")).toMatchObject({ code: 0, stdout: "babbbaaa" });
  expect(await run(["tac", "-r", "-s", "\\(ab\\)"], "xxabyyabzz")).toMatchObject({ code: 0, stdout: "zzyyabxxab" });
  expect(await run(["tac", "-r", "-s", "\\(a\\|b\\)"], "aaabbbab")).toMatchObject({ code: 0, stdout: "babbbaaa" });
  expect(await run(["tac", "-r", "-s", "|"], "aa|bb|cc")).toMatchObject({ code: 0, stdout: "ccbb|aa|" });
  expect(await run(["tac", "-r", "-s", "+"], "aa+bb+cc")).toMatchObject({ code: 0, stdout: "ccbb+aa+" });
  expect(await run(["tac", "-r", "-s", "?"], "aa?bb?cc")).toMatchObject({ code: 0, stdout: "ccbb?aa?" });
  expect(await run(["tac", "-r", "-s", "a{2}"], "xxa{2}yya{2}zz")).toMatchObject({ code: 0, stdout: "zzyya{2}xxa{2}" });
  expect(await run(["tac", "-r", "-s", "["], "abc")).toMatchObject({ code: 1, stdout: "", stderr: "tac: Invalid regular expression\n" });
  await writeFile(join(dir, "tac-raw-regex"), Uint8Array.of(0xff, 0x78, 0xfe, 0x78));
  const tacRawRegex = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "tac", "-r", "-s", "x", "tac-raw-regex"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "tac-raw-regex-out")),
    stderr: "pipe",
  });
  expect(await tacRawRegex.exited).toBe(0);
  expect(await new Response(tacRawRegex.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "tac-raw-regex-out"))]).toEqual([0xfe, 0x78, 0xff, 0x78]);
  expect(await run(["tac", "-b", "-s", ":"], "a:b:c:")).toMatchObject({ code: 0, stdout: "::c:ba" });
  expect(await run(["tac", "-b", "-r", "-s", "\\._+"], "._1._2.__3.___4")).toMatchObject({ code: 0, stdout: ".___4.__3._2._1" });
  expect(await run(["tac", "--before"], "a\nb\nc\n")).toMatchObject({ code: 0, stdout: "\n\nc\nba" });
  expect(await run(["tac", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: tac [OPTION]... [FILE]...\n") });
  expect(await run(["tac", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Write each FILE to standard output, last line first.\n") });
  expect(await run(["tac", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["tac", "expand-in", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n", stderr: "" });
  expect(await run(["tac", "--b"], "a:b:c:")).toMatchObject({ code: 0, stdout: "a:b:c:" });
  expect(await run(["tac", "--r"], "a:b:c:")).toMatchObject({ code: 0, stdout: "a:b:c:" });
  expect(await run(["tac", "--se=:"], "a:b:c:")).toMatchObject({ code: 0, stdout: "c:b:a:" });
  expect(await run(["tac", "--bad", "--help"], "x")).toMatchObject({ code: 1, stdout: "", stderr: "tac: unrecognized option '--bad'\nTry 'tac --help' for more information.\n" });
  expect(await run(["tac", "-x", "--help"], "x")).toMatchObject({ code: 1, stdout: "", stderr: "tac: invalid option -- 'x'\nTry 'tac --help' for more information.\n" });
  expect(await run(["tac", "--h=foo"], "x")).toMatchObject({ code: 1, stdout: "", stderr: "tac: option '--help' doesn't allow an argument\nTry 'tac --help' for more information.\n" });
  expect(await run(["tac", "--b=foo"], "x")).toMatchObject({ code: 1, stdout: "", stderr: "tac: option '--before' doesn't allow an argument\nTry 'tac --help' for more information.\n" });
  expect(await run(["tac", "--separator", "--help"], "a:b:c:")).toMatchObject({ code: 0, stdout: "a:b:c:", stderr: "" });
  await writeFile(join(dir, "tac-in"), "one\ntwo\n");
  expect(await run(["tac", "-", "-"], "one\ntwo\n")).toMatchObject({ code: 0, stdout: "two\none\ntwo\none\n" });
  expect(await shell(`printf 'one\\ntwo\\n' | "$BUN" "$BNU" tac - -`)).toMatchObject({ code: 0, stdout: "two\none\n", stderr: "" });
  expect(await shell(`"$BUN" "$BNU" tac - - < tac-in`)).toMatchObject({ code: 0, stdout: "two\none\ntwo\none\n", stderr: "" });
  expect(await shell(`BNU_STDIN_CLOSED=1 "$BUN" "$BNU" tac - <&-`)).toMatchObject({ code: 1, stdout: "", stderr: "tac: 'standard input': read error: Bad file descriptor\n" });
  expect(await shell(`BNU_STDIN_CLOSED=1 "$BUN" "$BNU" tac - tac-in <&-`)).toMatchObject({
    code: 1,
    stdout: "two\none\n",
    stderr: "tac: 'standard input': read error: Bad file descriptor\n",
  });
  expect(await run(["tac", "tac-in", "-"], "one\ntwo\n")).toMatchObject({ code: 0, stdout: "two\none\ntwo\none\n" });
  expect(await run(["tac", "-", "tac-in"], "one\ntwo\n")).toMatchObject({ code: 0, stdout: "two\none\ntwo\none\n" });
  expect(await run(["tac", "tac-missing-a", "tac-in", "tac-missing-b"])).toMatchObject({ code: 1, stdout: "two\none\n", stderr: "tac: failed to open 'tac-missing-a' for reading: No such file or directory\ntac: failed to open 'tac-missing-b' for reading: No such file or directory\n" });
  expect(await run(["tac", "missing'tac"])).toMatchObject({ code: 1, stdout: "", stderr: "tac: failed to open \"missing'tac\" for reading: No such file or directory\n" });
  expect(await run(["tac", "missing\ntac"])).toMatchObject({ code: 1, stdout: "", stderr: "tac: failed to open 'missing'$'\\n''tac' for reading: No such file or directory\n" });
  await mkdir(join(dir, "tac-dir"));
  expect(await run(["tac", "tac-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "tac: tac-dir: read error: Is a directory\n" });
  await mkdir(join(dir, "dir'tac"));
  expect(await run(["tac", "dir'tac"])).toMatchObject({ code: 1, stdout: "", stderr: "tac: \"dir'tac\": read error: Is a directory\n" });
  await symlink("tac-loop", join(dir, "tac-loop"));
  expect(await run(["tac", "tac-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "tac: failed to open 'tac-loop' for reading: Too many levels of symbolic links\n" });
  await symlink("loop'tac", join(dir, "loop'tac"));
  expect(await run(["tac", "loop'tac"])).toMatchObject({ code: 1, stdout: "", stderr: "tac: failed to open \"loop'tac\" for reading: Too many levels of symbolic links\n" });
});

test("printf, factor, sum, cksum and shuf basic behavior", async () => {
  expect(await run(["printf", "%s:%03d\\n", "n", "7"])).toMatchObject({ code: 0, stdout: "n:007\n" });
  expect(await sampleCommand(["printf", "%20000000f", "0"])).toStartWith(" ".repeat(64));
  expect(await run(["printf", "%.4X %5.4d %E %.4G\\n", "999", "42", "2", "3"])).toMatchObject({ code: 0, stdout: "03E7  0042 2.000000E+00 3\n" });
  expect(await run(["printf", "%2$s%1$s\\n", "1", "2"])).toMatchObject({ code: 0, stdout: "21\n" });
  expect(await run(["printf", "%s %3$s %s\\n", "A", "B", "C", "D"])).toMatchObject({ code: 0, stdout: "A C B\nD  \n" });
  expect(await run(["printf", "%1$*2$.*3$d\\n", "1", "3", "2"])).toMatchObject({ code: 0, stdout: " 01\n" });
  expect(await run(["printf", "%10$ s", "x"])).toMatchObject(await systemRun(["/usr/bin/printf", "%10$ s", "x"]));
  expect(await run(["printf", "%-2$s %1$s\\n", "A", "B"])).toMatchObject({ code: 1, stderr: "printf: %-2$: invalid conversion specification\n" });
  expect(await run(["printf"])).toMatchObject({ code: 1, stderr: "printf: missing operand\nTry 'printf --help' for more information.\n" });
  expect(await run(["printf", "--"])).toMatchObject({ code: 1, stderr: "printf: missing operand\nTry 'printf --help' for more information.\n" });
  expect(await run(["printf", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: printf FORMAT [ARGUMENT]...\n  or:  printf OPTION\n"), stderr: "" });
  expect(await run(["printf", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n", stderr: "" });
  expect(await run(["printf", "--bad", "--help"])).toMatchObject({ code: 0, stdout: "--bad", stderr: "printf: warning: ignoring excess arguments, starting with '--help'\n" });
  expect(await run(["printf", "x", "--help"])).toMatchObject({ code: 0, stdout: "x", stderr: "printf: warning: ignoring excess arguments, starting with '--help'\n" });
  expect(await run(["printf", "--version=foo"])).toMatchObject({ code: 0, stdout: "--version=foo", stderr: "" });
  expect(await run(["printf", "B", "1"])).toMatchObject({ code: 0, stdout: "B", stderr: "printf: warning: ignoring excess arguments, starting with '1'\n" });
  expect(await run(["printf", "%d", "9z"])).toMatchObject({ code: 1, stdout: "9", stderr: `printf: ${diagnosticQuote("9z")}: value not completely converted\n` });
  expect(await run(["printf", "%d\n", "9\n2"])).toMatchObject({ code: 1, stdout: "9\n", stderr: `printf: ${diagnosticQuote("9\\n2")}: value not completely converted\n` });
  expect(await run(["printf", "%d\\n", "--"])).toMatchObject({ code: 1, stdout: "0\n", stderr: `printf: ${diagnosticQuote("--")}: expected a numeric value\n` });
  expect(await run(["printf", "%d\n", "x\ny"])).toMatchObject({ code: 1, stdout: "0\n", stderr: `printf: ${diagnosticQuote("x\\ny")}: expected a numeric value\n` });
  expect(await run(["printf", "%d %d %x\\n", "010", "0x10", "0x10"])).toMatchObject({ code: 0, stdout: "8 16 10\n" });
  expect(await run(["printf", "%d\\n", "08"])).toMatchObject({ code: 1, stdout: "0\n", stderr: `printf: ${diagnosticQuote("08")}: value not completely converted\n` });
  expect(await run(["printf", "%i %d %.1f\\n", "010", "0b10", "0x10"])).toMatchObject({ code: 0, stdout: "8 2 16.0\n" });
  expect(await run(["printf", "%#x %#X %#o\\n", "10", "10", "10"])).toMatchObject({ code: 0, stdout: "0xa 0XA 012\n" });
  expect(await run(["printf", "%#08x %#5.3x %#.0x %#.0o %.0d\\n", "10", "10", "0", "0", "0"])).toMatchObject({ code: 0, stdout: "0x00000a 0x00a  0 \n" });
  expect(await run(["printf", "%f %f\\n", "inf", "nan"])).toMatchObject({ code: 0, stdout: "inf nan\n" });
  expect(await run(["printf", "%F %E %G\\n", "inf", "nan", "inf"])).toMatchObject({ code: 0, stdout: "INF NAN INF\n" });
  expect(await run(["printf", "%f %F\\n", "-inf", "-nan"])).toMatchObject({ code: 0, stdout: "-inf -NAN\n" });
  expect(await run(["printf", "%a %.1a %#a %A\\n", "1", "1.5", "2", "1e20"])).toMatchObject({ code: 0, stdout: "0x8p-3 0xc.0p-3 0x8.p-2 0XA.D78EBC5AC62P+63\n" });
  expect(await run(["printf", "%.0a %.3a %10a\\n", "1e20", "1e20", "-1"])).toMatchObject({ code: 0, stdout: "0xbp+63 0xa.d79p+63    -0x8p-3\n" });
  expect(await run(["printf", "%f %.2f %e\\n", "1e20", "1.5e20", "1e20"])).toMatchObject({ code: 0, stdout: "100000000000000000000.000000 150000000000000000000.00 1.000000e+20\n" });
  expect(await run(["printf", "%g %g %G\\n", "1e6", "1e-9", "1e6"])).toMatchObject({ code: 0, stdout: "1e+06 1e-09 1E+06\n" });
  expect(await run(["printf", "%e %.2e %g %.3g %E %G\\n", "1e309", "9.999999e309", "12.34e309", "9.999999e309", "-1.5e309", "1e309"])).toMatchObject({
    code: 0,
    stdout: "1.000000e+309 1.00e+310 1.234e+310 1e+310 -1.500000E+309 1E+309\n",
  });
  expect(await run(["printf", "%d\\n", "9223372036854775808"])).toMatchObject(await systemRun(["printf", "%d\\n", "9223372036854775808"]));
  expect(await run(["printf", "%u\\n", "18446744073709551616"])).toMatchObject(await systemRun(["printf", "%u\\n", "18446744073709551616"]));
  expect(await run(["printf", "%u %x %o\\n", "-1", "-1", "-1"])).toMatchObject({ code: 0, stdout: "18446744073709551615 ffffffffffffffff 1777777777777777777777\n" });
  expect(await run(["printf", "\\u263A\\n"])).toMatchObject({ code: 0, stdout: "☺\n" });
  expect(await run(["printf", "%b\\n", "\\U0001F600"])).toMatchObject({ code: 0, stdout: "😀\n" });
  expect(await run(["printf", "--", "foo\\n"])).toMatchObject({ code: 0, stdout: "foo\n" });
  expect(await run(["printf", "1 %*sy\\n", "-3", "x"])).toMatchObject({ code: 0, stdout: "1 x  y\n" });
  expect(await run(["printf", "9 %*dx\\n", "-2", "0"])).toMatchObject({ code: 0, stdout: "9 0 x\n" });
  expect(await run(["printf", "11 %*c\\n", "2", "x"])).toMatchObject({ code: 0, stdout: "11  x\n" });
  expect(await run(["printf", "%c|%c|%c\\n", "abc", "", "xyz"])).toMatchObject({ code: 0, stdout: "a|\0|x\n" });
  expect(await run(["printf", "12 %*s\\n", "", "empty width"])).toMatchObject({ code: 1, stdout: "12 empty width\n", stderr: `printf: ${diagnosticQuote("")}: expected a numeric value\n` });
  expect(await run(["printf", "13 %*s\\n", "9z", "partial width"])).toMatchObject({ code: 1, stdout: "13 partial width\n", stderr: `printf: ${diagnosticQuote("9z")}: value not completely converted\n` });
  expect(await run(["printf", "14 %.*sx\\n", "", "empty precision"])).toMatchObject({ code: 1, stdout: "14 x\n", stderr: `printf: ${diagnosticQuote("")}: expected a numeric value\n` });
  expect(await run(["printf", "%d\\n", "\"a", "\"a\"", "\"", "a"])).toMatchObject({
    code: 1,
    stdout: "97\n97\n0\n0\n",
    stderr: `printf: warning: \": character(s) following character constant have been ignored\nprintf: ${diagnosticQuote("\"")}: expected a numeric value\nprintf: ${diagnosticQuote("a")}: expected a numeric value\n`,
  });
  expect(await run(["printf", "a\\cb\\n"])).toMatchObject({ code: 0, stdout: "a" });
  expect(await run(["printf", "%bX\\n%s\\n", "a\\cb", "later"])).toMatchObject({ code: 0, stdout: "a" });
  expect(await run(["printf", "%q\\n", "simple", "a b", "a'b"])).toMatchObject({ code: 0, stdout: "simple\n'a b'\n\"a'b\"\n" });
  expect(await run(["printf", "%2$q %1$q\\n", "a b", "c d"])).toMatchObject({ code: 0, stdout: "'c d' 'a b'\n" });
  expect(await run(["printf", "%10q\\n", "a b"])).toMatchObject({ code: 1, stderr: "printf: %10q: invalid conversion specification\n" });
  expect(await run(["printf", "%.3q\\n", "a b"])).toMatchObject({ code: 1, stderr: "printf: %.3q: invalid conversion specification\n" });
  expect(await run(["printf", "%#q\\n", "a b"])).toMatchObject({ code: 1, stderr: "printf: %#q: invalid conversion specification\n" });
  expect(await run(["printf", "%1$10q\\n", "a b"])).toMatchObject({ code: 1, stderr: "printf: %1$10q: invalid conversion specification\n" });
  expect(await run(["printf", "%(bad)T", "0"])).toMatchObject({ code: 1, stderr: "printf: %(: invalid conversion specification\n" });
  expect(await run(["printf", "%q\\n", "", "'", "~a", "a~", "a\r", "\x01'\x01"])).toMatchObject({ code: 0, stdout: "''\n\"'\"\n'~a'\na~\n'a'$'\\r'\n''$'\\001'\\'''$'\\001'\n" });
  expect(await run(["printf", "%q\\n", "áḃç"], "", { env: { LC_ALL: "C" } })).toMatchObject({ code: 0, stdout: "''$'\\303\\241\\341\\270\\203\\303\\247'\n" });
  const rawPrintf = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "printf", "\\377"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(await rawPrintf.exited).toBe(0);
  expect(new Uint8Array(await new Response(rawPrintf.stdout).arrayBuffer())).toEqual(Uint8Array.of(0xff));
  expect(await run(["factor", "84"])).toMatchObject({ code: 0, stdout: "84: 2 2 3 7\n" });
  expect(await run(["factor", "0", "1"])).toMatchObject({ code: 0, stdout: "0:\n1:\n" });
  expect(await run(["factor", "00", "01", "00012"])).toMatchObject({ code: 0, stdout: "0:\n1:\n12: 2 2 3\n" });
  expect(await run(["factor", "--exponents", "84"])).toMatchObject({ code: 0, stdout: "84: 2^2 3 7\n" });
  expect(await run(["factor", "--e", "84"])).toMatchObject({ code: 0, stdout: "84: 2^2 3 7\n" });
  expect(await run(["factor", "--ex", "84"])).toMatchObject({ code: 0, stdout: "84: 2^2 3 7\n" });
  expect(await run(["factor", "12\n3"])).toMatchObject(await systemRun(["/usr/bin/factor", "12\n3"]));
  expect(await run(["factor", "12\t3"])).toMatchObject(await systemRun(["/usr/bin/factor", "12\t3"]));
  expect(await run(["factor", "12 3"])).toMatchObject(await systemRun(["/usr/bin/factor", "12 3"]));
  expect(await run(["factor", ""])).toMatchObject(await systemRun(["/usr/bin/factor", ""]));
  const rawFactor = Bun.spawn(["/bin/sh", "-c", `printf '12\\377\\n' | LC_ALL=C ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} factor 2>factor-raw-err`], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await rawFactor.exited).toBe(1);
  expect(await new Response(rawFactor.stdout).text()).toBe("");
  expect([...await readFile(join(dir, "factor-raw-err"))]).toEqual([0x66, 0x61, 0x63, 0x74, 0x6f, 0x72, 0x3a, 0x20, 0x27, 0x31, 0x32, 0x5c, 0x33, 0x37, 0x37, 0x27, 0x20, 0x69, 0x73, 0x20, 0x6e, 0x6f, 0x74, 0x20, 0x61, 0x20, 0x76, 0x61, 0x6c, 0x69, 0x64, 0x20, 0x70, 0x6f, 0x73, 0x69, 0x74, 0x69, 0x76, 0x65, 0x20, 0x69, 0x6e, 0x74, 0x65, 0x67, 0x65, 0x72, 0x0a]);
  expect(await run(["factor", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: factor [OPTION] [NUMBER]...\n") });
  expect(await run(["factor", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["factor", "--e=1", "84"])).toMatchObject({ code: 1, stderr: "factor: option '--exponents' doesn't allow an argument\nTry 'factor --help' for more information.\n" });
  expect(await run(["factor", "--bad", "--help"])).toMatchObject({ code: 1, stderr: "factor: unrecognized option '--bad'\nTry 'factor --help' for more information.\n" });
  expect(await run(["factor", "-x", "--help"])).toMatchObject({ code: 1, stderr: "factor: invalid option -- 'x'\nTry 'factor --help' for more information.\n" });
  expect(await run(["factor", "-h"], "84 13\n")).toMatchObject({ code: 0, stdout: "84: 2^2 3 7\n13: 13\n" });
  expect(await run(["factor"], "2147483647 0 00012\n")).toMatchObject({ code: 0, stdout: "2147483647: 2147483647\n0:\n12: 2 2 3\n" });
  const denseFactorInput = Array.from({ length: 10001 }, (_, n) => String(n)).join("\n") + "\n";
  const denseFactor = await run(["factor"], denseFactorInput);
  expect(denseFactor.code).toBe(0);
  expect(createHash("sha1").update(denseFactor.stdout).digest("hex")).toBe("8ebfb72a67903f0fd0975abf405c85794f175f4a");
  // Cross the streaming flush boundary used by upstream factor/t00 without
  // retaining its output or allowing a regression to exhaust the host.
  expect(await shell(`seq 0 400000 | /usr/bin/prlimit --as=3221225472 -- "$BUN" "$BNU" factor | sha1sum`)).toMatchObject({
    code: 0,
    stdout: "5f3d756b7a80162c16502f44d8531caecd6c561f  -\n",
  });
  expect(await shell(`seq 100000 | sed '/[24680]$/d' | "$BUN" "$BNU" split -nr/4 --filter='"$BUN" "$BNU" factor' | sed 's/.*: //; / /d' | wc -l`)).toMatchObject({ code: 0, stdout: "9592\n", stderr: "" });
  const range64FactorInput = Array.from({ length: 1000 }, (_, i) => String(18446744073708551616n + BigInt(i))).join("\n") + "\n";
  const range64Factor = await run(["factor"], range64FactorInput);
  expect(range64Factor.code).toBe(0);
  expect(createHash("sha1").update(range64Factor.stdout).digest("hex")).toBe("a63e5b34378674902ea47fcd7426f455696c859e");
  const parallelRange64FactorInput = Array.from({ length: 4000 }, (_, i) => String(18446744073708551616n + BigInt(i))).join("\n") + "\n";
  const parallelRange64Factor = await run(["factor"], parallelRange64FactorInput);
  expect(parallelRange64Factor.code).toBe(0);
  expect(createHash("sha1").update(parallelRange64Factor.stdout).digest("hex")).toBe("7f951fe41ee9d28645484a61e19d2f088c6e4951");
  expect(await run(["factor", "+7"])).toMatchObject({ code: 0, stdout: "7: 7\n" });
  expect(await run(["factor", "a", "4"])).toMatchObject(await systemRun(["/usr/bin/factor", "a", "4"]));
  expect(await run(["factor", "--", "-1"])).toMatchObject(await systemRun(["/usr/bin/factor", "--", "-1"]));
  await mkdir(join(dir, "stdin-read-dir"));
  expect(await shell(`"$BUN" "$BNU" factor < stdin-read-dir`)).toMatchObject({ code: 1, stdout: "", stderr: "factor: error reading input: Is a directory\n" });
  expect(await shell(`"$BUN" "$BNU" numfmt < stdin-read-dir`)).toMatchObject({ code: 1, stdout: "", stderr: "numfmt: error reading input: Is a directory\n" });
  expect(await shell(`"$BUN" "$BNU" tr A B < stdin-read-dir`)).toMatchObject({ code: 1, stdout: "", stderr: "tr: read error: Is a directory\n" });
  expect(await shell(`"$BUN" "$BNU" tee tee-read-dir-out < stdin-read-dir`)).toMatchObject({ code: 1, stdout: "", stderr: "tee: read error: Is a directory\n" });
  expect(await run(["factor", "170141183460469225450570946617781744489"])).toMatchObject({
    code: 0,
    stdout: "170141183460469225450570946617781744489: 9223372036854775421 18446744073709551709\n",
  });
  expect(await run(["factor", "170141183460469229545748130981302223887"])).toMatchObject({
    code: 0,
    stdout: "170141183460469229545748130981302223887: 9223372036854775643 18446744073709551709\n",
  });
  expect(await run(["factor", "+170141183460469231731687303715884105729"])).toMatchObject({
    code: 0,
    stdout: "170141183460469231731687303715884105729: 3 56713727820156410577229101238628035243\n",
  });
  expect(await run(["sum"], "abc")).toMatchObject({ code: 0, stdout: "16556     1\n" });
  expect(await run(["sum", "-"], "abc")).toMatchObject({ code: 0, stdout: "16556     1 -\n" });
  expect(await run(["sum", "-r"], "abc\n")).toMatchObject({ code: 0, stdout: "08288     1\n" });
  expect(await run(["sum", "-s"], "abc")).toMatchObject({ code: 0, stdout: "294 1\n" });
  expect(await run(["sum", "--s"], "abc")).toMatchObject({ code: 0, stdout: "294 1\n" });
  expect(await run(["sum", "--sy"], "abc")).toMatchObject({ code: 0, stdout: "294 1\n" });
  const sumHelp = await run(["sum", "--h"]);
  const sumHelpStdout = sumHelp.stdout;
  expect(sumHelp).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: sum [OPTION]... [FILE]...\n") });
  expect(sumHelpStdout).toContain("Print or check BSD (16-bit) checksums.\nLegacy interface to the cksum utility.\n");
  expect(sumHelpStdout).toContain("With no FILE, or when FILE is -, read standard input.\n");
  expect(sumHelpStdout).toContain("         use BSD sum algorithm (the default), use 1K blocks\n");
  expect(sumHelpStdout).toContain("         use System V sum algorithm, use 512 bytes blocks\n");
  expect(await run(["sum", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["sum", "--s=1"], "abc")).toMatchObject({ code: 1, stderr: "sum: option '--sysv' doesn't allow an argument\nTry 'sum --help' for more information.\n" });
  expect(await run(["sum", "--bad", "--help"], "abc")).toMatchObject({ code: 1, stderr: "sum: unrecognized option '--bad'\nTry 'sum --help' for more information.\n" });
  expect(await run(["sum", "-x", "--help"], "abc")).toMatchObject({ code: 1, stderr: "sum: invalid option -- 'x'\nTry 'sum --help' for more information.\n" });
  expect(await run(["sum", "-s", "-"], "abc")).toMatchObject({ code: 0, stdout: "294 1 -\n" });
  expect(await run(["sum", "-rs"], "abc\n")).toMatchObject({ code: 0, stdout: "304 1\n" });
  expect(await run(["sum", "-sr"], "abc\n")).toMatchObject({ code: 0, stdout: "08288     1\n" });
  expect(await run(["sum", "-r", "--sysv"], "abc\n")).toMatchObject({ code: 0, stdout: "304 1\n" });
  expect(await run(["sum", "--sysv", "-r"], "abc\n")).toMatchObject({ code: 0, stdout: "08288     1\n" });
  await writeFile(join(dir, "sum-ok"), "abc");
  expect(await run(["sum", "sum-ok", "-s"])).toMatchObject({ code: 0, stdout: "294 1 sum-ok\n" });
  expect(await run(["sum", "-s", "sum-ok", "-r"])).toMatchObject({ code: 0, stdout: "16556     1 sum-ok\n" });
  expect(await run(["sum", "sum-ok", "--sysv"])).toMatchObject({ code: 0, stdout: "294 1 sum-ok\n" });
  expect(await run(["sum", "--", "sum-ok", "-s"])).toMatchObject({ code: 1, stdout: "16556     1 sum-ok\n", stderr: "sum: -s: No such file or directory\n" });
  expect(await run(["sum", "sum-ok", "-s"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 1, stdout: "16556     1 sum-ok\n", stderr: "sum: -s: No such file or directory\n" });
  expect(await run(["sum", "sum-missing-a", "sum-ok", "sum-missing-b"])).toMatchObject({
    code: 1,
    stdout: "16556     1 sum-ok\n",
    stderr: "sum: sum-missing-a: No such file or directory\nsum: sum-missing-b: No such file or directory\n",
  });
  expect(await run(["sum", "missing'sum"])).toMatchObject({ code: 1, stdout: "", stderr: "sum: \"missing'sum\": No such file or directory\n" });
  expect(await run(["sum", "missing\nsum"])).toMatchObject({ code: 1, stdout: "", stderr: "sum: 'missing'$'\\n''sum': No such file or directory\n" });
  await mkdir(join(dir, "dir'sum"));
  expect(await run(["sum", "dir'sum"])).toMatchObject({ code: 1, stdout: "", stderr: "sum: \"dir'sum\": Is a directory\n" });
  await symlink("loop'sum", join(dir, "loop'sum"));
  expect(await run(["sum", "loop'sum"])).toMatchObject({ code: 1, stdout: "", stderr: "sum: \"loop'sum\": Too many levels of symbolic links\n" });
  expect(await run(["cksum"], "abc")).toMatchObject({ code: 0, stdout: "1219131554 3\n" });
  expect(await run(["cksum", "-"], "abc")).toMatchObject({ code: 0, stdout: "1219131554 3 -\n" });
  const shuffled = await run(["shuf", "-i", "1-3", "-n", "2"]);
  expect(shuffled.code).toBe(0);
  expect(shuffled.stdout.trim().split("\n")).toHaveLength(2);
  expect(await run(["shuf", "-n", "+1"], "a\nb\n")).toMatchObject({ code: 0 });
  expect(await run(["shuf", "-n", " 1"], "a\nb\n")).toMatchObject({ code: 0 });
  expect(await run(["shuf", "-n", "999999999999999999999999"], "a\nb\n")).toMatchObject({ code: 0 });
  expect(await run(["shuf", "-i", "+1-+3", "-n", "+1"])).toMatchObject({ code: 0 });
  expect(await run(["shuf", "-n", "1\n2"], "a\nb\n")).toMatchObject(await systemRun(["shuf", "-n", "1\n2"], "a\nb\n"));
  expect(await run(["shuf", "-i", "1\t-3"])).toMatchObject(await systemRun(["shuf", "-i", "1\t-3"]));
  expect(await run(["shuf", "--input-range="], "a\nb\n")).toMatchObject({ code: 1, stdout: "", stderr: "shuf: invalid input range: ‘’\n" });
  expect(await run(["shuf", "-e", "-r", "-n", "3", "x"])).toMatchObject({ code: 0, stdout: "x\nx\nx\n" });
  expect(await run(["shuf", "--repeat", "--head-count=0", "-e"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["shuf", "--input-range=3-1"])).toMatchObject(await systemRun(["shuf", "--input-range=3-1"]));
  const zeroRandom = await shell(`printf 'a\\nb\\nc\\n' | timeout 2 "$BUN" "$BNU" shuf --random-source=/dev/zero --head-count=2`);
  expect(zeroRandom).toMatchObject({ code: 0, stderr: "" });
  expect(zeroRandom.stdout.trim().split("\n")).toHaveLength(2);
  expect(await run(["shuf", "--h"])).toMatchObject({
    code: 1,
    stderr: "shuf: option '--h' is ambiguous; possibilities: '--head-count' '--help'\nTry 'shuf --help' for more information.\n",
  });
  expect(await run(["shuf", "--he=1"], "a\nb\n")).toMatchObject({
    code: 1,
    stderr: "shuf: option '--he=1' is ambiguous; possibilities: '--head-count' '--help'\nTry 'shuf --help' for more information.\n",
  });
  expect(await run(["shuf", "--hea=1"], "a\nb\n")).toMatchObject({ code: 0 });
  expect(await run(["shuf", "--e", "a"])).toMatchObject({ code: 0, stdout: "a\n" });
  expect(await run(["shuf", "--ec=foo", "a"])).toMatchObject({
    code: 1,
    stderr: "shuf: option '--echo' doesn't allow an argument\nTry 'shuf --help' for more information.\n",
  });
  expect(await run(["shuf", "--r", "--n=3", "-e", "x"])).toMatchObject({
    code: 1,
    stderr: "shuf: option '--r' is ambiguous; possibilities: '--random-source' '--repeat'\nTry 'shuf --help' for more information.\n",
  });
  expect(await run(["shuf", "--n=1"], "a\n")).toMatchObject({
    code: 1,
    stderr: "shuf: unrecognized option '--n=1'\nTry 'shuf --help' for more information.\n",
  });
  expect(await run(["shuf", "--bad", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "shuf: unrecognized option '--bad'\nTry 'shuf --help' for more information.\n",
  });
  expect(await run(["shuf", "--version=foo"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "shuf: option '--version' doesn't allow an argument\nTry 'shuf --help' for more information.\n",
  });
  expect(await run(["shuf", "--help=1", "--version"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "shuf: option '--help' doesn't allow an argument\nTry 'shuf --help' for more information.\n",
  });
  expect(await run(["shuf", "--head-count", "--help"], "a\n")).toMatchObject(await systemRun(["shuf", "--head-count", "--help"], "a\n"));
  expect(await run(["shuf", "--head-count=1", "--help"])).toMatchObject({
    code: 0,
    stdout: expect.stringContaining("Usage: shuf [OPTION]... [FILE]\n  or:  shuf -e [OPTION]... [ARG]...\n  or:  shuf -i LO-HI [OPTION]...\n"),
  });
  expect(await run(["shuf", "--head-count=bad", "--help"], "a\n")).toMatchObject(await systemRun(["shuf", "--head-count=bad", "--help"], "a\n"));
  expect(await run(["shuf", "--head-count=", "--help"], "a\n")).toMatchObject(await systemRun(["shuf", "--head-count=", "--help"], "a\n"));
  expect(await run(["shuf", "--input-range=bad", "--help"])).toMatchObject(await systemRun(["shuf", "--input-range=bad", "--help"]));
  expect(await run(["shuf", "--input-range=", "--help"])).toMatchObject(await systemRun(["shuf", "--input-range=", "--help"]));
  expect(await run(["shuf", "--input-range", "bad", "--help"])).toMatchObject(await systemRun(["shuf", "--input-range", "bad", "--help"]));
  expect(await run(["shuf", "-i", "bad", "--help"])).toMatchObject(await systemRun(["shuf", "-i", "bad", "--help"]));
  await writeFile(join(dir, "shuf-meta"), "a\nb\n");
  expect(await run(["shuf", "shuf-meta", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: shuf [OPTION]... [FILE]\n"), stderr: "" });
  const nul = await run(["shuf", "-z", "-n", "2"], "a\0b\0c\0");
  expect(nul.code).toBe(0);
  expect(nul.stdout.endsWith("\0")).toBe(true);
  expect(nul.stdout.split("\0").filter(Boolean)).toHaveLength(2);
  await writeFile(join(dir, "shuf-raw"), Uint8Array.of(0xff, 0x0a));
  const shufRaw = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "shuf", "shuf-raw"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "shuf-raw-out")),
    stderr: "pipe",
  });
  expect(await shufRaw.exited).toBe(0);
  expect(await new Response(shufRaw.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "shuf-raw-out"))]).toEqual([0xff, 0x0a]);
  await writeFile(join(dir, "shuf-raw0"), Uint8Array.of(0xff, 0x00));
  const shufRaw0 = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "shuf", "-z", "shuf-raw0"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "shuf-raw0-out")),
    stderr: "pipe",
  });
  expect(await shufRaw0.exited).toBe(0);
  expect(await new Response(shufRaw0.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "shuf-raw0-out"))]).toEqual([0xff, 0x00]);
  await writeFile(join(dir, "random"), new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));
  expect(await run(["shuf", "--random-source=random", "-i", "1-3"])).toMatchObject({ code: 0, stdout: "1\n2\n3\n" });
  await writeFile(join(dir, "shuf-abc-random"), "a\nb\nc\n");
  expect(await run(["shuf", "--random-source=shuf-abc-random", "-i", "1-3"])).toMatchObject({ code: 0, stdout: "2\n1\n3\n" });
  expect(await run(["shuf", "--random-source=shuf-abc-random", "-r", "-n", "5", "-i", "1-2"])).toMatchObject({ code: 0, stdout: "2\n1\n1\n1\n1\n" });
  await writeFile(join(dir, "shuf-empty-random"), "");
  expect(await run(["shuf", "-n", "0", "--random-source=shuf-empty-random", "shuf-meta"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["shuf", "-n", "1", "--random-source=shuf-empty-random", "shuf-meta"])).toMatchObject({ code: 1, stdout: "", stderr: "shuf: shuf-empty-random: end of file\n" });
  expect(await run(["shuf", "--random-source=random", "--random-source=random", "-e", "a"])).toMatchObject({ code: 0, stdout: "a\n" });
  expect(await run(["shuf", "--random-source=random", "--random-source=other-random", "-e", "a"])).toMatchObject({ code: 1, stderr: "shuf: multiple random sources specified\n" });
  expect(await run(["shuf", "--random-source=", "shuf-meta"])).toMatchObject({ code: 1, stdout: "", stderr: "shuf: '': No such file or directory\n" });
  expect(await run(["shuf", "--random-source=shuf-random-missing", "shuf-meta"])).toMatchObject(await systemRun(["shuf", "--random-source=shuf-random-missing", "shuf-meta"]));
  expect(await run(["shuf", "--random-source=missing'shuf-rs", "shuf-meta"])).toMatchObject({ code: 1, stdout: "", stderr: "shuf: \"missing'shuf-rs\": No such file or directory\n" });
  expect(await run(["shuf", "--random-source=missing\nshuf-rs", "shuf-meta"])).toMatchObject({ code: 1, stdout: "", stderr: "shuf: 'missing'$'\\n''shuf-rs': No such file or directory\n" });
  await writeFile(join(dir, "shuf-a"), "a\n");
  await writeFile(join(dir, "shuf-b"), "b\n");
  await mkdir(join(dir, "shuf-dir"));
  expect(await run(["shuf", "shuf-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "shuf: read error: Is a directory\n" });
  expect(await run(["shuf", "missing'shuf"])).toMatchObject({ code: 1, stdout: "", stderr: "shuf: \"missing'shuf\": No such file or directory\n" });
  expect(await run(["shuf", "missing\nshuf"])).toMatchObject({ code: 1, stdout: "", stderr: "shuf: 'missing'$'\\n''shuf': No such file or directory\n" });
  await writeFile(join(dir, "shuf-unreadable"), "x\n");
  await chmod(join(dir, "shuf-unreadable"), 0);
  expect(await run(["shuf", "shuf-unreadable"])).toMatchObject({ code: 1, stdout: "", stderr: "shuf: shuf-unreadable: Permission denied\n" });
  await symlink("shuf-loop", join(dir, "shuf-loop"));
  expect(await run(["shuf", "shuf-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "shuf: shuf-loop: Too many levels of symbolic links\n" });
  await symlink("loop'shuf", join(dir, "loop'shuf"));
  expect(await run(["shuf", "loop'shuf"])).toMatchObject({ code: 1, stdout: "", stderr: "shuf: \"loop'shuf\": Too many levels of symbolic links\n" });
  await mkdir(join(dir, "dir'shuf-rs"));
  expect(await run(["shuf", "--random-source=dir'shuf-rs", "shuf-meta"])).toMatchObject({ code: 1, stdout: "", stderr: `shuf: ${diagnosticQuote("dir'shuf-rs")}: read error: Is a directory\n` });
  await symlink("loop'shuf-rs", join(dir, "loop'shuf-rs"));
  expect(await run(["shuf", "--random-source=loop'shuf-rs", "shuf-meta"])).toMatchObject({ code: 1, stdout: "", stderr: "shuf: \"loop'shuf-rs\": Too many levels of symbolic links\n" });
  expect(await run(["shuf", "shuf-a", "shuf-b"])).toMatchObject(await systemRun(["shuf", "shuf-a", "shuf-b"]));
  expect(await run(["shuf", "shuf-a", "extra\narg"])).toMatchObject(await systemRun(["shuf", "shuf-a", "extra\narg"]));
  expect(await run(["shuf", "-i", "1-2", "extra"])).toMatchObject(await systemRun(["shuf", "-i", "1-2", "extra"]));
  expect(await run(["shuf", "-i", "1-2", "extra\narg"])).toMatchObject(await systemRun(["shuf", "-i", "1-2", "extra\narg"]));
  expect(await run(["shuf", "-n", "-1"], "a\n")).toMatchObject(await systemRun(["shuf", "-n", "-1"], "a\n"));
  expect(await run(["shuf", "-n", "1x"], "a\n")).toMatchObject(await systemRun(["shuf", "-n", "1x"], "a\n"));
  expect(await run(["shuf", "-n", ""], "a\n")).toMatchObject(await systemRun(["shuf", "-n", ""], "a\n"));
  expect(await run(["shuf", "-o", "shuffled", "-e", "a", "b"])).toMatchObject({ code: 0, stdout: "" });
  expect((await readFile(join(dir, "shuffled"), "utf8")).trim().split("\n").sort().join("")).toBe("ab");
  expect(await run(["shuf", "-o", "shuf-raw-file-out", "shuf-raw"])).toMatchObject({ code: 0, stdout: "" });
  expect([...await readFile(join(dir, "shuf-raw-file-out"))]).toEqual([0xff, 0x0a]);
  expect(await run(["shuf", "-o", "shuffled-a", "-o", "shuffled-b", "-e", "a"])).toMatchObject({ code: 1, stderr: "shuf: multiple output files specified\n" });
  expect((await run(["shuf", "-n10", "-i0-9", "-n3", "-n20"])).stdout.trim().split("\n")).toHaveLength(3);
  expect(await run(["shuf", "-i0-9", "-e", "A"])).toMatchObject({ code: 1, stderr: "shuf: cannot combine -e and -i options\nTry 'shuf --help' for more information.\n" });
  expect(await run(["shuf", "-i0-9", "-i8-90"])).toMatchObject({ code: 1 });
  expect(await run(["shuf", "-i", "bad"])).toMatchObject(await systemRun(["shuf", "-i", "bad"]));
  expect(await run(["shuf", "-i", "2-1"])).toMatchObject(await systemRun(["shuf", "-i", "2-1"]));
  expect(await run(["shuf", "-r", "-n", "1", "-i", "2-1"])).toMatchObject(await systemRun(["shuf", "-r", "-n", "1", "-i", "2-1"]));
  for (const option of ["--head-count", "--input-range", "--output", "--random-source"]) {
    expect(await run(["shuf", option])).toMatchObject({ code: 1, stderr: `shuf: option '${option}' requires an argument\nTry 'shuf --help' for more information.\n` });
  }
  expect(await run(["shuf", "--bad=4"])).toMatchObject({ code: 1, stderr: "shuf: unrecognized option '--bad=4'\nTry 'shuf --help' for more information.\n" });
  expect(await run(["shuf", "-i1-18446744073709551615", "-n2"])).toMatchObject({ code: 0 });
  expect(await sampleCommand(["shuf", "--rep", "-e", "A"])).toStartWith("A\nA\n");
});

test("mktemp creates files and directories from templates", async () => {
  const file = await run(["mktemp", "sample.XXXXXX"]);
  expect(file.code).toBe(0);
  expect(file.stdout.trim()).toStartWith("sample.");
  expect(await readFile(join(dir, file.stdout.trim()), "utf8")).toBe("");
  const suffixed = await run(["mktemp", "--suffix=.tmp", "sample.XXXXXX"]);
  expect(suffixed.code).toBe(0);
  expect(suffixed.stdout.trim()).toEndWith(".tmp");
  expect(await readFile(join(dir, suffixed.stdout.trim()), "utf8")).toBe("");
  const prefixSuffixed = await run(["mktemp", "--s=.tmp", "sample.XXXXXX"]);
  expect(prefixSuffixed.code).toBe(0);
  expect(prefixSuffixed.stdout.trim()).toEndWith(".tmp");
  expect(await readFile(join(dir, prefixSuffixed.stdout.trim()), "utf8")).toBe("");
  const implicitSuffix = await run(["mktemp", "implicit.XXX.txt"]);
  expect(implicitSuffix.code).toBe(0);
  expect(implicitSuffix.stdout.trim()).toStartWith("implicit.");
  expect(implicitSuffix.stdout.trim()).toEndWith(".txt");
  expect(await run(["mktemp", "--suffix=a/b", "bad.XXXXXX"])).toMatchObject(await systemRun(["/usr/bin/mktemp", "--suffix=a/b", "bad.XXXXXX"]));
  expect(await run(["mktemp", "aXXXX/b"])).toMatchObject({ code: 1, stdout: "", stderr: `mktemp: invalid suffix ${diagnosticQuote("/b")}, contains directory separator\n` });
  expect(await run(["mktemp", "aXXX/bXX"])).toMatchObject({ code: 1, stdout: "", stderr: `mktemp: too few X's in template ${diagnosticQuote("aXXX/bXX")}\n` });
  expect(await run(["mktemp", "ab\nXX"])).toMatchObject(await systemRun(["/usr/bin/mktemp", "ab\nXX"]));
  expect(await run(["mktemp", "-t", "ab\t/XXX"])).toMatchObject(await systemRun(["/usr/bin/mktemp", "-t", "ab\t/XXX"]));
  expect(await run(["mktemp", "-t", "/abs.XXX"])).toMatchObject({ code: 1, stdout: "", stderr: `mktemp: invalid template, ${diagnosticQuote("/abs.XXX")}, contains directory separator\n` });
  expect(await run(["mktemp", "--suffix=.s", "a.XXX.t"])).toMatchObject({ code: 1, stdout: "", stderr: `mktemp: with --suffix, template ${diagnosticQuote("a.XXX.t")} must end in X\n` });
  expect(await run(["mktemp", "--suffix"])).toMatchObject({ code: 1, stderr: "mktemp: option '--suffix' requires an argument\nTry 'mktemp --help' for more information.\n" });
  const helpSuffix = await run(["mktemp", "--suffix", "--help", "sample.XXXXXX"]);
  expect(helpSuffix.code).toBe(0);
  expect(helpSuffix.stdout.trim()).toEndWith("--help");
  expect(await readFile(join(dir, helpSuffix.stdout.trim()), "utf8")).toBe("");
  expect(await run(["mktemp", "-p"])).toMatchObject({ code: 1, stderr: "mktemp: option requires an argument -- 'p'\nTry 'mktemp --help' for more information.\n" });
  const madeDir = await run(["mktemp", "-d", "dir.XXXXXX"]);
  expect(madeDir.code).toBe(0);
  expect(madeDir.stdout.trim()).toStartWith("dir.");
  const prefixDir = await run(["mktemp", "--di", "dir.XXXXXX"]);
  expect(prefixDir.code).toBe(0);
  expect((await stat(join(dir, prefixDir.stdout.trim()))).isDirectory()).toBe(true);
  expect(await run(["mktemp", "--d", "dir.XXXXXX"])).toMatchObject({ code: 1, stderr: "mktemp: option '--d' is ambiguous; possibilities: '--directory' '--dry-run'\nTry 'mktemp --help' for more information.\n" });
  const suffixedDir = await run(["mktemp", "-d", "--suffix=.d", "dir.XXXXXX"]);
  expect(suffixedDir.code).toBe(0);
  expect((await stat(join(dir, suffixedDir.stdout.trim()))).isDirectory()).toBe(true);
  await mkdir(join(dir, "tmp-parent"));
  expect(await run(["mktemp", "--q", "missing-parent/XXX"])).toMatchObject({ code: 1, stdout: "", stderr: "" });
  const tmpdirFile = await run(["mktemp", "--tmpdir=tmp-parent", "nested.XXXXXX"]);
  expect(tmpdirFile.code).toBe(0);
  expect(tmpdirFile.stdout.trim()).toStartWith("tmp-parent/nested.");
  expect(await readFile(join(dir, tmpdirFile.stdout.trim()), "utf8")).toBe("");
  const prefixTmpdirFile = await run(["mktemp", "--tm=tmp-parent", "prefix.XXXXXX"]);
  expect(prefixTmpdirFile.code).toBe(0);
  expect(prefixTmpdirFile.stdout.trim()).toStartWith("tmp-parent/prefix.");
  expect(await readFile(join(dir, prefixTmpdirFile.stdout.trim()), "utf8")).toBe("");
  const tmpdirBare = await run(["mktemp", "--tmpdir=tmp-parent", "XXX"]);
  expect(tmpdirBare.code).toBe(0);
  expect(tmpdirBare.stdout.trim()).toMatch(/^tmp-parent\/[A-Za-z0-9]{3}$/);
  expect(await readFile(join(dir, tmpdirBare.stdout.trim()), "utf8")).toBe("");
  const pBare = await run(["mktemp", "-p", "tmp-parent", "XXX"]);
  expect(pBare.code).toBe(0);
  expect(pBare.stdout.trim()).toMatch(/^tmp-parent\/[A-Za-z0-9]{3}$/);
  expect(await readFile(join(dir, pBare.stdout.trim()), "utf8")).toBe("");
  const tBare = await run(["mktemp", "-t", "XXX"], "", { env: { TMPDIR: join(dir, "tmp-parent") } });
  expect(tBare.code).toBe(0);
  expect(tBare.stdout.trim()).toMatch(new RegExp(`^${join(dir, "tmp-parent").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[A-Za-z0-9]{3}$`));
  expect(await readFile(tBare.stdout.trim(), "utf8")).toBe("");
  const tWithPUnsetTmpdir = await run(["mktemp", "-p", "tmp-parent", "-t", "tp.XXX"], "", { env: { TMPDIR: "" } });
  expect(tWithPUnsetTmpdir.code).toBe(0);
  expect(tWithPUnsetTmpdir.stdout.trim()).toMatch(/^tmp-parent\/tp\.[A-Za-z0-9]{3}$/);
  expect(await readFile(join(dir, tWithPUnsetTmpdir.stdout.trim()), "utf8")).toBe("");
  const tmpdirOptional = await run(["mktemp", "--tmpdir", "opt.XXXXXX"], "", { env: { TMPDIR: join(dir, "tmp-parent") } });
  expect(tmpdirOptional.code).toBe(0);
  expect(tmpdirOptional.stdout.trim()).toStartWith(join(dir, "tmp-parent/opt."));
  const emptyTmpdirOption = await run(["mktemp", "--tmpdir=", "empty-opt.XXXXXX"], "", { env: { TMPDIR: join(dir, "tmp-parent") } });
  expect(emptyTmpdirOption.code).toBe(0);
  expect(emptyTmpdirOption.stdout.trim()).toStartWith(join(dir, "tmp-parent/empty-opt."));
  const emptyPOption = await run(["mktemp", "-p", "", "empty-p.XXXXXX"], "", { env: { TMPDIR: join(dir, "tmp-parent") } });
  expect(emptyPOption.code).toBe(0);
  expect(emptyPOption.stdout.trim()).toStartWith(join(dir, "tmp-parent/empty-p."));
  const defaultTemplate = await run(["mktemp"], "", { env: { TMPDIR: join(dir, "tmp-parent") } });
  expect(defaultTemplate.code).toBe(0);
  expect(defaultTemplate.stdout.trim()).toStartWith(join(dir, "tmp-parent/tmp."));
  const emptyEnvTemplate = await run(["mktemp"], "", { env: { TMPDIR: "" } });
  expect(emptyEnvTemplate.code).toBe(0);
  expect(emptyEnvTemplate.stdout.trim()).toStartWith("/tmp/tmp.");
  const dotTemplate = await run(["mktemp"], "", { env: { TMPDIR: "." } });
  expect(dotTemplate.code).toBe(0);
  expect(dotTemplate.stdout.trim()).toStartWith("./tmp.");
  expect(await readFile(join(dir, dotTemplate.stdout.trim()), "utf8")).toBe("");
  const missingParent = await run(["mktemp"], "", { env: { TMPDIR: "no/such/dir" } });
  expect(missingParent).toMatchObject({ code: 1, stdout: "" });
  expect(missingParent).toMatchObject(await systemRun(["/usr/bin/mktemp"], "", { env: { TMPDIR: "no/such/dir" } }));
  expect(await run(["mktemp", "missing\nparent/tmp.XXXXXX"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `mktemp: failed to create file via template ${diagnosticQuote("missing\\nparent/tmp.XXXXXX")}: No such file or directory\n`,
  });
  expect(await run(["mktemp", "--quiet"], "", { env: { TMPDIR: "no/such/dir" } })).toMatchObject({ code: 1, stdout: "", stderr: "" });
  await writeFile(join(dir, "mktemp-parent-file"), "x");
  expect(await run(["mktemp", "mktemp-parent-file/nested.XXXXXX"])).toMatchObject(await systemRun(["/usr/bin/mktemp", "mktemp-parent-file/nested.XXXXXX"]));
  const dryRun = await run(["mktemp", "-u", "dry.XXXXXX"]);
  expect(dryRun.code).toBe(0);
  await expect(stat(join(dir, dryRun.stdout.trim()))).rejects.toThrow();
  const prefixDryRun = await run(["mktemp", "--dr", "dry.XXXXXX"]);
  expect(prefixDryRun.code).toBe(0);
  await expect(stat(join(dir, prefixDryRun.stdout.trim()))).rejects.toThrow();
  expect(await run(["mktemp", "--dry-run=1", "dry.XXXXXX"])).toMatchObject({ code: 1, stderr: "mktemp: option '--dry-run' doesn't allow an argument\nTry 'mktemp --help' for more information.\n" });
  const mktempHelp = (await run(["mktemp", "--h"])).stdout;
  expect(mktempHelp).toContain("Usage: mktemp [OPTION]... [TEMPLATE]\n");
  expect(mktempHelp).toContain("TEMPLATE must contain at least 3 consecutive 'X's in last component.\n");
  expect(mktempHelp).toContain("If TEMPLATE is not specified, use tmp.XXXXXXXXXX, and --tmpdir is implied.\n");
  expect(mktempHelp).toContain("-u, --dry-run     do not create anything; merely print a name (unsafe)\n");
  expect(mktempHelp).toContain("--suffix=SUFF     append SUFF to TEMPLATE; SUFF must not contain a slash.\n");
  expect(mktempHelp).toContain("                   unlike with -t, TEMPLATE may contain slashes,\n");
  expect(await run(["mktemp", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["mktemp", "sample.XXXXXX", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: mktemp [OPTION]... [TEMPLATE]\n") });
  expect(await run(["mktemp", "sample.XXXXXX", "--help"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 1, stderr: "mktemp: too many templates\nTry 'mktemp --help' for more information.\n" });
  expect(await run(["mktemp", "sample.XXXXXX", "--version"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 1, stderr: "mktemp: too many templates\nTry 'mktemp --help' for more information.\n" });
  expect(await run(["mktemp", "--bad", "--help"])).toMatchObject({ code: 1, stderr: "mktemp: unrecognized option '--bad'\nTry 'mktemp --help' for more information.\n" });
  const full = Bun.file("/dev/full");
  if (await full.exists()) {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "mktemp", "-p", "tmp-parent"], {
      cwd: dir,
      stdout: full,
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    expect(await readdir(join(dir, "tmp-parent"))).toEqual([]);
  }
});

test("date command exposes stable output shapes", async () => {
  expect(await run(["date", "-u", "-d", "2020-01-02T03:04:05Z", "+%Y-%m-%d %T %Z"])).toMatchObject({ code: 0, stdout: "2020-01-02 03:04:05 UTC\n" });
  expect(await run(["date", "-u", "--set", "@0"])).toMatchObject({
    code: 1,
    stdout: "Thu Jan  1 00:00:00 UTC 1970\n",
    stderr: "date: cannot set date: Operation not permitted\n",
  });
  const utcDateOptions = { env: { LC_ALL: "C", TZ: "UTC0" } };
  expect(await run(["date", "010100002030"], "", utcDateOptions)).toMatchObject(await systemRun(["date", "010100002030"], "", utcDateOptions));
  expect(await run(["date", "0101000068"], "", utcDateOptions)).toMatchObject(await systemRun(["date", "0101000068"], "", utcDateOptions));
  expect(await run(["date", "022900002023"], "", utcDateOptions)).toMatchObject(await systemRun(["date", "022900002023"], "", utcDateOptions));
  expect(await run(["date", "-d", "now", "not-a-format"], "", utcDateOptions)).toMatchObject(await systemRun(["date", "-d", "now", "not-a-format"], "", utcDateOptions));
  expect(await run(["date", "-d"])).toMatchObject({ code: 1, stderr: "date: option requires an argument -- 'd'\nTry 'date --help' for more information.\n" });
  expect(await run(["date", "-f"])).toMatchObject({ code: 1, stderr: "date: option requires an argument -- 'f'\nTry 'date --help' for more information.\n" });
  expect(await run(["date", "-r"])).toMatchObject({ code: 1, stderr: "date: option requires an argument -- 'r'\nTry 'date --help' for more information.\n" });
  expect(await run(["date", "--date"])).toMatchObject({ code: 1, stderr: "date: option '--date' requires an argument\nTry 'date --help' for more information.\n" });
  expect(await run(["date", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "date: unrecognized option '--bad'\nTry 'date --help' for more information.\n" });
  expect(await run(["date", "--d=@0", "+%s"])).toMatchObject({ code: 1, stdout: "", stderr: "date: option '--d=@0' is ambiguous; possibilities: '--date' '--debug'\nTry 'date --help' for more information.\n" });
  expect(await run(["date", "--dat=@0", "+%s"])).toMatchObject({ code: 0, stdout: "0\n" });
  expect(await run(["date", "--de", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: date [OPTION]... [+FORMAT]\n  or:  date [OPTION]... MMDDhhmm[[CC]YY][.ss]\n") });
  expect(await run(["date", "--dat", "--help", "+%s"])).toMatchObject(await systemRun(["date", "--dat", "--help", "+%s"]));
  expect(await run(["date", "--r=missing", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "date: option '--r=missing' is ambiguous; possibilities: '--reference' '--resolution' '--rfc-email' '--rfc-822' '--rfc-2822' '--rfc-3339'\nTry 'date --help' for more information.\n" });
  expect(await run(["date", "--v=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "date: option '--version' doesn't allow an argument\nTry 'date --help' for more information.\n" });
  expect(await run(["date", "--debug=1"])).toMatchObject({ code: 1, stdout: "", stderr: "date: option '--debug' doesn't allow an argument\nTry 'date --help' for more information.\n" });
  expect(await run(["date", "+%F", "extra\narg"])).toMatchObject({ code: 1, stdout: "", stderr: `date: extra operand ${diagnosticQuote("extra\\narg")}\nTry 'date --help' for more information.\n` });
  expect(await run(["date", "--rfc-3339", "--help"])).toMatchObject(await systemRun(["date", "--rfc-3339", "--help"]));
  expect(await run(["date", "--rfc-3339", "bad", "--help"])).toMatchObject(await systemRun(["date", "--rfc-3339", "bad", "--help"]));
  expect(await run(["date", "--iso", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: date [OPTION]... [+FORMAT]\n") });
  expect(await run(["date", "--iso=seconds", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: date [OPTION]... [+FORMAT]\n") });
  expect(await run(["date", "--rfc-3339=", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `date: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--rfc-3339")}\nValid arguments are:\n  - ${diagnosticQuote("date")}\n  - ${diagnosticQuote("seconds")}\n  - ${diagnosticQuote("ns")}\nTry 'date --help' for more information.\n`,
  });
  expect(await run(["date", "--iso-8601=bad", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `date: invalid argument ${diagnosticQuote("bad")} for ${diagnosticQuote("--iso-8601")}\nValid arguments are:\n  - ${diagnosticQuote("hours")}\n  - ${diagnosticQuote("minutes")}\n  - ${diagnosticQuote("date")}\n  - ${diagnosticQuote("seconds")}\n  - ${diagnosticQuote("ns")}\nTry 'date --help' for more information.\n`,
  });
  expect(await run(["date", "-u", "--rfc-3=seconds", "-d", "@0"])).toMatchObject({ code: 0, stdout: "1970-01-01 00:00:00+00:00\n" });
  expect(await run(["date", "--file="])).toMatchObject({ code: 1, stdout: "", stderr: "date: '': No such file or directory\n" });
  expect(await run(["date", "--reference="])).toMatchObject({ code: 1, stderr: "date: '': No such file or directory\n" });
  expect(await run(["date", "-r", "date-missing", "+%s"])).toMatchObject({ code: 1, stderr: "date: date-missing: No such file or directory\n" });
  await symlink("date-ref-loop", join(dir, "date-ref-loop"));
  expect(await run(["date", "-r", "date-ref-loop", "+%s"])).toMatchObject({ code: 1, stdout: "", stderr: "date: date-ref-loop: Too many levels of symbolic links\n" });
  await writeFile(join(dir, "date-ref-negative-ns"), "");
  await systemRun(["/usr/bin/touch", "-d", "1969-12-31 23:59:59.123456789 +0000", "date-ref-negative-ns"]);
  expect(await run(["date", "-r", "date-ref-negative-ns", "+%s.%N"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "-1.123456789\n" });
  expect(await run(["date", "-f", "date-file-missing", "+%s"])).toMatchObject({ code: 1, stdout: "", stderr: "date: date-file-missing: No such file or directory\n" });
  expect(await run(["date", "-d", "@0", "-r", "date-missing", "+%s"])).toMatchObject({ code: 1, stderr: "date: the options to specify dates for printing are mutually exclusive\nTry 'date --help' for more information.\n" });
  expect(await run(["date", "--bad=4"])).toMatchObject({ code: 1, stderr: "date: unrecognized option '--bad=4'\nTry 'date --help' for more information.\n" });
  expect(await run(["date", "-d", "2025-10-11T13:00"], "", { env: { LC_ALL: "en_US.UTF-8" } })).toMatchObject({ code: 0, stdout: "Sat Oct 11 01:00:00 PM AEDT 2025\n" });
  expect(await run(["date", "-u", "-d", "@0", "+%s %F %T %z %:z %j %N"])).toMatchObject({ code: 0, stdout: "0 1970-01-01 00:00:00 +0000 +00:00 001 000000000\n" });
  expect(await run(["date", "-u", "-d", "@0", "+%#a %#A %#b %#B %#p %#P"])).toMatchObject({ code: 0, stdout: "THU THURSDAY JAN JANUARY am am\n" });
  expect(await run(["date", "-u", "-d", "@0", "+%Ec|%Ex|%EX|%EC|%Ey|%EY|%Od|%Om|%Oy|%OH|%OS|%OV|%Ou|%Ow|%O:::z|%_5Od"])).toMatchObject({ code: 0, stdout: "Thu Jan  1 00:00:00 1970|01/01/70|00:00:00|19|70|1970|01|01|70|00|00|01|4|4|+00|    1\n" });
  expect(await run(["date", "-u", "-d", "@0", "+%%|%5%|%05%|%_5%|%-5%|%5Q|%05Q|%_5Q|%-5Q"])).toMatchObject({ code: 0, stdout: "%|   %5%|00%05%|  %_5%|%-5%|  %5Q|0%05Q| %_5Q|%-5Q\n" });
  expect(await run(["date", "-u", "-d", "@0", "+%^P %#c"])).toMatchObject({ code: 0, stdout: "am Thu Jan  1 00:00:00 1970\n" });
  expect(await run(["date", "-u", "-d", "@0", "+%5d|%-5d|%-_5d|%-05d|%-5Y"])).toMatchObject({ code: 0, stdout: "00001|1|    1|00001|1970\n" });
  expect(await run(["date", "-u", "-d", "@1", "+%5a|%#5a|%^10b|%5p|%5Z"])).toMatchObject({ code: 0, stdout: "  Thu|  THU|       JAN|   AM|  UTC\n" });
  expect(await run(["date", "-u", "-d", "@1", "+%+5s|%+5d|%+5y|%+5C|%+6Y"])).toMatchObject({ code: 0, stdout: "00001|00001|+0070|+0019|+01970\n" });
  expect(await run(["date", "--uct", "-d", "@0", "+%s %z"])).toMatchObject({ code: 0, stdout: "0 +0000\n" });
  expect(await run(["date", "-u", "-d", "@0", "+%-N"])).toMatchObject({ code: 0, stdout: "000000000\n" });
  expect(await run(["date", "-u", "-d", "@0.123456789", "+%3N|%5N|%10N|%_10N|%-10N"])).toMatchObject({ code: 0, stdout: "123|12345|1234567890|123456789 |123456789\n" });
  expect(await run(["date", "--resolution"])).toMatchObject({ code: 0, stdout: "0.000000001\n" });
  expect(await run(["date", "-u", "-d", "@1.123456789", "--rfc-3339=ns"])).toMatchObject({ code: 0, stdout: "1970-01-01 00:00:01.123456789+00:00\n" });
  expect(await run(["date", "--rfc-3339=bad"])).toMatchObject(await systemRun(["date", "--rfc-3339=bad"]));
  expect(await run(["date", "--iso-8601=bad"])).toMatchObject(await systemRun(["date", "--iso-8601=bad"]));
  expect(await run(["date", "--rfc-3339=bad\nmode"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `date: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--rfc-3339")}\nValid arguments are:\n  - ${diagnosticQuote("date")}\n  - ${diagnosticQuote("seconds")}\n  - ${diagnosticQuote("ns")}\nTry 'date --help' for more information.\n`,
  });
  expect(await run(["date", "--iso-8601=bad\nmode"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `date: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--iso-8601")}\nValid arguments are:\n  - ${diagnosticQuote("hours")}\n  - ${diagnosticQuote("minutes")}\n  - ${diagnosticQuote("date")}\n  - ${diagnosticQuote("seconds")}\n  - ${diagnosticQuote("ns")}\nTry 'date --help' for more information.\n`,
  });
  expect(await run(["date", "-d", "bad\nname"])).toMatchObject(await systemRun(["date", "-d", "bad\nname"]));
  expect(await run(["date", "-d", "bad\tname"])).toMatchObject(await systemRun(["date", "-d", "bad\tname"]));
  expect(await run(["date", "-r", "missing\nname"])).toMatchObject(await systemRun(["date", "-r", "missing\nname"]));
  expect(await run(["date", "+%s", "extra"])).toMatchObject({ code: 1, stdout: "", stderr: `date: extra operand ${diagnosticQuote("extra")}\nTry 'date --help' for more information.\n` });
  expect(await run(["date", "-u", "-d", "2026-09-10", "+%Y"], "", { env: { LC_ALL: "am_ET.UTF-8" } })).toMatchObject({ code: 0, stdout: "2018\n" });
  expect(await run(["date", "-u", "-d", "2026-09-12", "+%Y"], "", { env: { LC_ALL: "am_ET.UTF-8" } })).toMatchObject({ code: 0, stdout: "2019\n" });
  expect(await run(["date", "-u", "-d", "2026-03-19", "+%Y"], "", { env: { LC_ALL: "fa_IR.UTF-8" } })).toMatchObject({ code: 0, stdout: "1404\n" });
  expect(await run(["date", "-u", "-d", "2026-03-22", "+%Y"], "", { env: { LC_ALL: "fa_IR.UTF-8" } })).toMatchObject({ code: 0, stdout: "1405\n" });
  expect(await run(["date", "-u", "-d", "2026-01-01", "+%Y %B"], "", { env: { LC_ALL: "th_TH.UTF-8" } })).toMatchObject({ code: 0, stdout: "2569 \u0e21\u0e01\u0e23\u0e32\u0e04\u0e21\n" });
  expect(await run(["date", "-u", "-d", "2026-01-01", "--iso-8601=hours"], "", { env: { LC_ALL: "th_TH.UTF-8" } })).toMatchObject({ code: 0, stdout: "2026-01-01T00+00:00\n" });
  expect(await run(["date", "-u", "-d", "2026-01-01", "--rfc-3339=date"], "", { env: { LC_ALL: "am_ET.UTF-8" } })).toMatchObject({ code: 0, stdout: "2026-01-01\n" });
  expect(await run(["date", "-d", "1970-01-01 00:00:01", "+%s"], "", { env: { TZ: "UTC+2" } })).toMatchObject({ code: 0, stdout: "7201\n" });
  expect(await run(["date", "-d", "1970-01-01 00:00:01.123456789", "+%s.%N"], "", { env: { TZ: "UTC+2" } })).toMatchObject({ code: 0, stdout: "7201.123456789\n" });
  expect(await run(["date", "-u", "-d", "1969-12-31 13:00:00.00000001-1100", "--rfc-3339=ns"])).toMatchObject({ code: 0, stdout: "1970-01-01 00:00:00.000000010+00:00\n" });
  expect(await run(["date", "-u", "-d", "1969-12-31 13:00:00.00000001-1100", "--iso=ns"])).toMatchObject({ code: 0, stdout: "1970-01-01T00:00:00,000000010+00:00\n" });
  expect(await run(["date", "-u", "-d", "21:04 +0100", "+%S"])).toMatchObject({ code: 0, stdout: "00\n" });
  expect(await run(["date", "-u", "-d", "2020-12-31T23:59:58.123Z", "+%G-%V %q %R %r"])).toMatchObject({ code: 0, stdout: "2020-53 4 23:59 11:59:58 PM\n" });
  expect(await run(["date", "-u", "-d", "2020-01-02T03:04:05Z", "+%k|%l|%P|%U|%W|%_d|%-d|%0d"])).toMatchObject({ code: 0, stdout: " 3| 3|am|00|00| 2|2|02\n" });
  expect(await run(["date", "-u", "-d", "1999-06-05T05:00:00Z", "+%0e|%0k|%0l"])).toMatchObject({ code: 0, stdout: "05|05|05\n" });
  expect(await run(["date", "+%z|%:z|%::z|%:::z"], "", { env: { TZ: "XXX12:34:56" } })).toMatchObject({ code: 0, stdout: "-1234|-12:34|-12:34:56|-12:34:56\n" });
  expect(await run(["date", "+%z|%:z|%::z|%:::z"], "", { env: { TZ: "XXX-1:02:03" } })).toMatchObject({ code: 0, stdout: "+0102|+01:02|+01:02:03|+01:02:03\n" });
  expect(await run(["date", "-u", "-d", "1999-01-08T00:00:00Z", "+%03d|%_3d|%3004Y"])).toMatchObject({ code: 0, stdout: `008|  8|${"0".repeat(3000)}1999\n` });
  expect(await run(["date", "-u", "-d", "@-22", "+%05s|%_5s|%8:z|%+6Y|%+4C"])).toMatchObject({ code: 0, stdout: "-0022|  -22|+0000:00|+01969|+019\n" });
  expect(await run(["date", "-u", "-d", "1997-01-19 08:17:48 +0", "+%x_%X_%y_%Y"])).toMatchObject({ code: 0, stdout: "01/19/97_08:17:48_97_1997\n" });
  expect(await run(["date", "-u", "-d", "Apr 11 22:59:00 2011"])).toMatchObject({ code: 0, stdout: "Mon Apr 11 22:59:00 UTC 2011\n" });
  expect(await run(["date", "-d", "2011-12-11", "+%F %T %Z %z"], "", { env: { TZ: "Europe/Helsinki" } })).toMatchObject({ code: 0, stdout: "2011-12-11 00:00:00 EET +0200\n" });
  expect(await run(["date", "-d", "@0", "+%Z %z %:::z"], "", { env: { TZ: "Australia/Melbourne" } })).toMatchObject({ code: 0, stdout: "AEST +1000 +10\n" });
  expect(await run(["date", "-d", "2026-07-01T00:00:00", "+%Z %z"], "", { env: { TZ: "Europe/London" } })).toMatchObject({ code: 0, stdout: "BST +0100\n" });
  expect(await run(["date", "-d", "@0", "+%Z %z"], "", { env: { TZ: "America/New_York" } })).toMatchObject({ code: 0, stdout: "EST -0500\n" });
  expect(await run(["date", "-d", "@0", "+%Z %z"], "", { env: { TZ: "Pacific/Auckland" } })).toMatchObject({ code: 0, stdout: "NZST +1200\n" });
  expect(await run(["date", "-d", "2011-12-11 EET"], "", { env: { TZ: "Europe/Helsinki" } })).toMatchObject({ code: 0, stdout: "Sun Dec 11 00:00:00 EET 2011\n" });
  expect(await run(["date", "-d", "2011-06-11 EEST"], "", { env: { TZ: "Europe/Helsinki" } })).toMatchObject({ code: 0, stdout: "Sat Jun 11 00:00:00 EEST 2011\n" });
  expect(await run(["date", "-d", "2016-06-01 EDT + 6 months", "+%s|%F|%T|%z"], "", { env: { TZ: "America/New_York" } })).toMatchObject({ code: 0, stdout: "1480564800|2016-11-30|23:00:00|-0500\n" });
  expect(await run(["date", "-u", "-d", "1995-1-1", "+%U"])).toMatchObject({ code: 0, stdout: "01\n" });
  expect(await run(["date", "-u", "-d", "000909", "+%Y-%m-%d %T"])).toMatchObject({ code: 0, stdout: "2000-09-09 00:00:00\n" });
  expect(await run(["date", "-d", "1.2. 3:4:5.6", "+%m-%d-%T"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "02-01-03:04:05\n" });
  expect(await run(["date", "-d", "3 1.2.", "+%m-%d-%H"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "02-01-03\n" });
  expect(await run(["date", "-u", "-d", "2026(this is a comment)-01-05", "+%Y-%m-%d"])).toMatchObject({ code: 0, stdout: "2026-01-05\n" });
  expect(await run(["date", "-d", "1(ignore this comment", "+%H:%M:%S"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "01:00:00\n" });
  expect(await run(["date", "-u", "-d", "1997-01-19T08:17:48+0", "+%d_%D_%e_%h_%H"])).toMatchObject({ code: 0, stdout: "19_01/19/97_19_Jan_08\n" });
  expect(await run(["date", "-u", "-d", "2020-01-02T03:04:05Z", "--rfc-3339=seconds"])).toMatchObject({ code: 0, stdout: "2020-01-02 03:04:05+00:00\n" });
  expect(await run(["date", "-u", "-d", "@31536000", "--iso=sec"])).toMatchObject({ code: 0, stdout: "1971-01-01T00:00:00+00:00\n" });
  expect(await run(["date", "-u", "-d", "@31536000", "--rfc-3339=sec"])).toMatchObject({ code: 0, stdout: "1971-01-01 00:00:00+00:00\n" });
  expect(await run(["date", "-u", "-d", "1997-01-19 08:17:48 +0 4 seconds ago", "+%Y-%m-%d %T"])).toMatchObject({ code: 0, stdout: "1997-01-19 08:17:44\n" });
  expect(await run(["date", "-u", "-d", "1997-01-19 08:17:48 +0 next month", "+%Y-%m-%d %T"])).toMatchObject({ code: 0, stdout: "1997-02-19 08:17:48\n" });
  expect(await run(["date", "-u", "-d", "1997-01-19 08:17:48 +0 this year", "+%Y-%m-%d %T"])).toMatchObject({ code: 0, stdout: "1997-01-19 08:17:48\n" });
  expect(await run(["date", "-u", "-d", "20050101 +1 day", "+%F"])).toMatchObject({ code: 0, stdout: "2005-01-02\n" });
  expect(await run(["date", "-u", "-d", "1970-01-01 UTC 946684800 sec", "+%Y-%m-%d %T %z"])).toMatchObject({ code: 0, stdout: "2000-01-01 00:00:00 +0000\n" });
  expect(await run(["date", "-u", "-d", "1970-01-01 00:00:00.1234567 UTC +961062237.987654321 sec", "--iso=ns"])).toMatchObject({ code: 0, stdout: "2000-06-15T09:43:58,111111021+00:00\n" });
  expect(await run(["date", "-u", "-d1970-01-01 00:00:00.1234567 UTC +961062237.987654321 sec", "--rfc-3339=ns"])).toMatchObject({ code: 0, stdout: "2000-06-15 09:43:58.111111021+00:00\n" });
  expect(await run(["date", "-u", "-d", "1970-12-31T23:59:59+00:00 - 1 year"])).toMatchObject({ code: 0, stdout: "Wed Dec 31 23:59:59 UTC 1969\n" });
  expect(await run(["date", "-u", "-d", "09:00B", "+%T"])).toMatchObject({ code: 0, stdout: "07:00:00\n" });
  expect(await run(["date", "-u", "-d", "09:00L", "+%T"])).toMatchObject({ code: 0, stdout: "22:00:00\n" });
  expect(await run(["date", "-u", "-d", "09:00N", "+%T"])).toMatchObject({ code: 0, stdout: "10:00:00\n" });
  expect(await run(["date", "-u", "-d", "09:00Z", "+%T"])).toMatchObject({ code: 0, stdout: "09:00:00\n" });
  expect(await run(["date", "-u", "-d", "1970-01-01 x", "+%F %T %s"])).toMatchObject({ code: 0, stdout: "1970-01-01 11:00:00 39600\n" });
  expect(await run(["date", "-u", "-d", "1970-01-01 10:30x", "+%F %T %s"])).toMatchObject({ code: 0, stdout: "1970-01-01 21:30:00 77400\n" });
  expect(await run(["date", "-u", "-d", "1970-01-01 n", "+%F %T %s"])).toMatchObject({ code: 0, stdout: "1970-01-01 01:00:00 3600\n" });
  expect(await run(["date", "-u", "-d", "Jan 1 1970 x", "+%F %T %s"])).toMatchObject({ code: 0, stdout: "1970-01-01 11:00:00 39600\n" });
  expect(await run(["date", "-u", "-d", "Jan 1 10:30:15.25 1970 x", "+%F %T.%N %s"])).toMatchObject({ code: 0, stdout: "1970-01-01 21:30:15.250000000 77415\n" });
  expect(await run(["date", "-u", "-d", "1970 Jan 1 10:30 UTC", "+%F %T.%N %s"])).toMatchObject({ code: 1, stdout: "", stderr: `date: invalid date ${diagnosticQuote("1970 Jan 1 10:30 UTC")}\n` });
  expect(await run(["date", "-u", "-d", "1970/02/01 x", "+%F %T %s"])).toMatchObject({ code: 0, stdout: "1970-02-01 11:00:00 2718000\n" });
  expect(await run(["date", "-u", "-d", "01/01/1970 10:30x", "+%F %T %s"])).toMatchObject({ code: 0, stdout: "1970-01-01 21:30:00 77400\n" });
  expect(await run(["date", "-u", "-d", "10:30 UTC-05", "+%H:%M"])).toMatchObject({ code: 0, stdout: "15:30\n" });
  expect(await run(["date", "-d", "TZ=\"UTC\" 2020-01-01 00:00", "+%s"])).toMatchObject({ code: 0, stdout: "1577836800\n" });
  expect(await run(["date", "-d", "TZ=UTC 2020-01-01 00:00", "+%s"])).toMatchObject({ code: 1, stdout: "", stderr: `date: invalid date ${diagnosticQuote("TZ=UTC 2020-01-01 00:00")}\n` });
  expect(await run(["date", "-d", "TZ=Bad/Zone 2020-01-01", "+%s"])).toMatchObject({ code: 1, stdout: "", stderr: `date: invalid date ${diagnosticQuote("TZ=Bad/Zone 2020-01-01")}\n` });
  expect(await run(["date", "-d", "TZ=\"GMT\" 2020-01-01 00:00", "+%s"])).toMatchObject({ code: 0, stdout: "1577836800\n" });
  expect(await run(["date", "-d", "TZ=\"CET\" 2020-01-01 00:00", "+%s"])).toMatchObject({ code: 0, stdout: "1577833200\n" });
  expect(await run(["date", "-d", "TZ=\"EST\" 2020-01-01 00:00", "+%s"])).toMatchObject({ code: 0, stdout: "1577854800\n" });
  expect(await run(["date", "-d", "TZ=\"EST5\" 1970-01-01 00:00"], "", { env: { TZ: "PST8" } })).toMatchObject({ code: 0, stdout: "Wed Dec 31 21:00:00 PST 1969\n" });
  expect(await run(["date", "-d", "TZ=\"Asia/Tokyo\" 1990-12-11 00:00:00", "+%s"])).toMatchObject({ code: 0, stdout: "660841200\n" });
  expect(await run(["date", "-d", "TZ=\"Asia/Tokyo\" Sun, 90-12-11 + 3 days - 90 minutes", "+%s"])).toMatchObject({ code: 0, stdout: "661095000\n" });
  expect(await run(["date", "-d", "TZ=\"America/Edmonton\" 2006-04-02 02:30:00"])).toMatchObject(await systemRun(["date", "-d", "TZ=\"America/Edmonton\" 2006-04-02 02:30:00"]));
  const utcNow = new Date();
  const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][utcNow.getUTCDay()];
  const todayUtc = utcNow.toISOString().slice(0, 10);
  const nextWeekday = new Date(Date.UTC(utcNow.getUTCFullYear(), utcNow.getUTCMonth(), utcNow.getUTCDate() + 7)).toISOString().slice(0, 10);
  expect(await run(["date", "-d", weekday, "+%Y-%m-%d"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: `${todayUtc}\n` });
  expect(await run(["date", "-d", `next ${weekday}`, "+%Y-%m-%d"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: `${nextWeekday}\n` });
  expect(await run(["date", "-u", "-d", "@0", "-I"])).toMatchObject({ code: 0, stdout: "1970-01-01\n" });
  expect(await run(["date", "-u", "-d", "@0", "-Ihours"])).toMatchObject({ code: 0, stdout: "1970-01-01T00+00:00\n" });
  expect(await run(["date", "-u", "-d", "2020-01-02T03:04:05Z", "-Iseconds"])).toMatchObject({ code: 0, stdout: "2020-01-02T03:04:05+00:00\n" });
  expect(await run(["date", "-u", "-R", "-d", "2020-01-02T03:04:05Z"])).toMatchObject({ code: 0, stdout: "Thu, 02 Jan 2020 03:04:05 +0000\n" });
  expect(await run(["date", "-u", "--rfc-822", "-d", "2020-01-02T03:04:05Z"])).toMatchObject({ code: 0, stdout: "Thu, 02 Jan 2020 03:04:05 +0000\n" });
  expect(await run(["date", "-u", "--rfc-2822", "-d", "2020-01-02T03:04:05Z"])).toMatchObject({ code: 0, stdout: "Thu, 02 Jan 2020 03:04:05 +0000\n" });
  await writeFile(join(dir, "dates"), "@0\n2020-01-02T03:04:05Z\n");
  expect(await run(["date", "-u", "-f", "dates", "+%s"])).toMatchObject({ code: 0, stdout: "0\n1577934245\n" });
  const rawDateFile = Bun.spawn(["/bin/sh", "-c", `printf 'bad\\377\\n' > raw-dates; LC_ALL=C ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} date -f raw-dates >raw-date-out 2>raw-date-err`], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await rawDateFile.exited).toBe(1);
  expect(await readFile(join(dir, "raw-date-out"), "utf8")).toBe("");
  expect([...await readFile(join(dir, "raw-date-err"))]).toEqual([0x64, 0x61, 0x74, 0x65, 0x3a, 0x20, 0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0x20, 0x64, 0x61, 0x74, 0x65, 0x20, 0x27, 0x62, 0x61, 0x64, 0x5c, 0x33, 0x37, 0x37, 0x27, 0x0a]);
  await mkdir(join(dir, "date-file-dir"));
  await symlink("date-file-loop", join(dir, "date-file-loop"));
  expect(await run(["date", "-f", "date-file-dir", "+%s"])).toMatchObject({ code: 1, stdout: "", stderr: "date: date-file-dir: read error: Is a directory\n" });
  expect(await run(["date", "-f", "date-file-loop", "+%s"])).toMatchObject({ code: 1, stdout: "", stderr: "date: date-file-loop: Too many levels of symbolic links\n" });
  await writeFile(join(dir, "reference-time"), "x");
  expect(await run(["touch", "-d", "2020-01-02T03:04:05Z", "reference-time"])).toMatchObject({ code: 0 });
  expect(await run(["date", "-u", "-r", "reference-time", "+%s"])).toMatchObject({ code: 0, stdout: "1577934245\n" });
  await systemRun(["/usr/bin/touch", "-d", "2026-01-02 03:04:05.123456789 +0000", "reference-time"]);
  expect(await run(["date", "-u", "-r", "reference-time", "+%s.%N"])).toMatchObject({ code: 0, stdout: "1767323045.123456789\n" });
  const debugDate = await run(["date", "--debug", "-u", "-d", "@0", "+%F"]);
  expect(debugDate).toMatchObject({ code: 0, stdout: "1970-01-01\n" });
  expect(debugDate.stderr).toContain("parsed number of seconds part");
});

test("platform information commands expose stable output shapes", async () => {
  expect((await run(["arch"])).stdout.trim().length).toBeGreaterThan(0);
  expect(await run(["arch", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: arch [OPTION]...\n") });
  expect(await run(["arch", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["arch", "--h=1"])).toMatchObject({ code: 1, stderr: "arch: option '--help' doesn't allow an argument\nTry 'arch --help' for more information.\n" });
  expect(await run(["arch", "extra"])).toMatchObject(await systemRun(["arch", "extra"]));
  const unameKernel = await run(["uname"]);
  expect(unameKernel.code).toBe(0);
  expect(unameKernel.stdout.trim().length).toBeGreaterThan(0);
  expect(await run(["uname", "-s"])).toMatchObject({ code: 0, stdout: unameKernel.stdout });
  expect(await run(["uname", "extra"])).toMatchObject(await systemRun(["uname", "extra"]));
  expect((await run(["uname", "-n"])).stdout.trim().length).toBeGreaterThan(0);
  expect((await run(["uname", "-m"])).stdout.trim()).toBe((await run(["arch"])).stdout.trim());
  expect(await run(["uname", "-p"])).toMatchObject(await systemRun(["/usr/bin/uname", "-p"]));
  expect(await run(["uname", "-i"])).toMatchObject(await systemRun(["/usr/bin/uname", "-i"]));
  expect(await run(["uname", "--kernel-n"])).toMatchObject(await systemRun(["/usr/bin/uname", "--kernel-n"]));
  expect(await run(["uname", "--kernel-re"])).toMatchObject(await systemRun(["/usr/bin/uname", "--kernel-re"]));
  expect(await run(["uname", "--kernel-v"])).toMatchObject(await systemRun(["/usr/bin/uname", "--kernel-v"]));
  expect(await run(["uname", "--operating"])).toMatchObject(await systemRun(["/usr/bin/uname", "--operating"]));
  expect(await run(["uname", "--process"])).toMatchObject(await systemRun(["/usr/bin/uname", "--process"]));
  expect(await run(["uname", "--n"])).toMatchObject(await systemRun(["/usr/bin/uname", "--n"]));
  expect(await run(["uname", "--kernel"])).toMatchObject({ code: 1, stderr: "uname: option '--kernel' is ambiguous; possibilities: '--kernel-name' '--kernel-release' '--kernel-version'\nTry 'uname --help' for more information.\n" });
  expect(await run(["uname", "--h"])).toMatchObject({ code: 1, stderr: "uname: option '--h' is ambiguous; possibilities: '--hardware-platform' '--help'\nTry 'uname --help' for more information.\n" });
  expect(await run(["uname", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["uname", "--he", "-s"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: uname [OPTION]...\n") });
  expect(await run(["uname", "-x", "--help"])).toMatchObject({ code: 1, stderr: "uname: invalid option -- 'x'\nTry 'uname --help' for more information.\n" });
  expect(await run(["uname", "--version=1"])).toMatchObject({ code: 1, stderr: "uname: option '--version' doesn't allow an argument\nTry 'uname --help' for more information.\n" });
  expect(await run(["uname", "--kernel=bad", "--help"])).toMatchObject({ code: 1, stderr: "uname: option '--kernel=bad' is ambiguous; possibilities: '--kernel-name' '--kernel-release' '--kernel-version'\nTry 'uname --help' for more information.\n" });
  expect(await run(["uname", "--all=bad", "--help"])).toMatchObject({ code: 1, stderr: "uname: option '--all' doesn't allow an argument\nTry 'uname --help' for more information.\n" });
  expect(await run(["uname", "--kernel-n=bad", "--help"])).toMatchObject({ code: 1, stderr: "uname: option '--kernel-name' doesn't allow an argument\nTry 'uname --help' for more information.\n" });
  expect(await run(["uname", "--bad=1", "--help"])).toMatchObject({ code: 1, stderr: "uname: unrecognized option '--bad=1'\nTry 'uname --help' for more information.\n" });
  expect((await run(["uname", "-a"])).stdout.trim().split(/\s+/).length).toBeGreaterThanOrEqual(5);
  let expectedHostid = "00000000";
  try {
    const hostidBytes = await readFile("/etc/hostid");
    if (hostidBytes.length >= 4) expectedHostid = hostidBytes.readUInt32LE(0).toString(16).padStart(8, "0");
  } catch {}
  expect(await run(["hostid"])).toMatchObject({ code: 0, stdout: `${expectedHostid}\n` });
  expect(await run(["hostid", "--he"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: hostid [OPTION]\n") });
  expect(await run(["hostid", "--ver"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["hostid", "--v=1"])).toMatchObject({ code: 1, stderr: "hostid: option '--version' doesn't allow an argument\nTry 'hostid --help' for more information.\n" });
  expect(await run(["hostid", "extra"])).toMatchObject(await systemRun(["hostid", "extra"]));
  expect(await run(["arch", "-/"])).toMatchObject({ code: 1 });
  expect(await run(["groups", "-/"])).toMatchObject({ code: 1 });
  expect(await run(["groups", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: groups [OPTION]... [USERNAME]...\n") });
  expect(await run(["groups", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("the current process (which may differ if the groups database has changed).\n") });
  expect(await run(["groups", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["groups", "--h=1"])).toMatchObject({ code: 1, stderr: "groups: option '--help' doesn't allow an argument\nTry 'groups --help' for more information.\n" });
  const hostname = await run(["hostname"]);
  expect(hostname.code).toBe(0);
  expect(hostname.stdout.trim().length).toBeGreaterThan(0);
  expect(await run(["hostname", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: hostname [NAME]\n  or:  hostname OPTION\n") });
  expect(await run(["hostname", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["hostname", "--help=bad"])).toMatchObject({ code: 1, stderr: "hostname: option '--help' doesn't allow an argument\nTry 'hostname --help' for more information.\n" });
  expect(await run(["hostname", "--he=bad"])).toMatchObject({ code: 1, stderr: "hostname: option '--help' doesn't allow an argument\nTry 'hostname --help' for more information.\n" });
  expect(await run(["hostname", "--version=bad"])).toMatchObject({ code: 1, stderr: "hostname: option '--version' doesn't allow an argument\nTry 'hostname --help' for more information.\n" });
  expect(await run(["hostname", "--ver=bad"])).toMatchObject({ code: 1, stderr: "hostname: option '--version' doesn't allow an argument\nTry 'hostname --help' for more information.\n" });
  expect(await run(["hostname", "BEFORE", "--help", "AFTER"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: hostname [NAME]\n  or:  hostname OPTION\n") });
  expect(await run(["hostname", "BEFORE", "--version", "AFTER"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["hostname", "--", "--help"])).toMatchObject(await systemRun(["/usr/bin/hostname", "--", "--help"]));
  const shortHostname = osHostname().split(".")[0];
  expect(await run(["hostname", "-s"])).toMatchObject({ code: 0, stdout: `${shortHostname}\n`, stderr: "" });
  expect(await run(["hostname", "--short", "ignored"])).toMatchObject({ code: 0, stdout: `${shortHostname}\n`, stderr: "" });
  expect(await run(["hostname", "-ys"])).toMatchObject({ code: 0, stdout: `${shortHostname}\n`, stderr: "" });
  expect(await run(["hostname", "-sy"])).toMatchObject({ code: 0, stdout: "(none)\n", stderr: "" });
  expect(await run(["hostname", "--yp"])).toMatchObject({ code: 0, stdout: "(none)\n", stderr: "" });
  expect(await run(["hostname", "--nis"])).toMatchObject({ code: 0, stdout: "(none)\n", stderr: "" });
  expect(await run(["hostname", "--fqdn"])).toMatchObject({ code: 1, stdout: "", stderr: "hostname: Host name lookup failure\n" });
  expect(await run(["hostname", "--alias"])).toMatchObject({ code: 1, stdout: "", stderr: "hostname: Host name lookup failure\n" });
  expect(await run(["hostname", "--ip-address"])).toMatchObject({ code: 1, stdout: "", stderr: "hostname: Host name lookup failure\n" });
  expect(await run(["hostname", "--file="])).toMatchObject({ code: 1, stdout: "", stderr: "hostname: can't open `'\n" });
  expect(await run(["hostname", "--file=missing-hostname-file"])).toMatchObject({ code: 1, stderr: "hostname: can't open `missing-hostname-file'\n" });
  expect(await run(["hostname", "--file=missing-hostname-file", "ignored"])).toMatchObject(await systemRun(["/usr/bin/hostname", "--file=missing-hostname-file", "ignored"]));
  expect(await run(["hostname", "--short=bad"])).toMatchObject({ code: 1, stderr: "hostname: option '--short' doesn't allow an argument\nTry 'hostname --help' for more information.\n" });
  expect(await run(["hostname", "--sh=bad"])).toMatchObject({ code: 1, stderr: "hostname: option '--short' doesn't allow an argument\nTry 'hostname --help' for more information.\n" });
  expect(await run(["hostname", "--fq=bad"])).toMatchObject({ code: 1, stderr: "hostname: option '--fqdn' doesn't allow an argument\nTry 'hostname --help' for more information.\n" });
  expect(await run(["hostname", "new-name"])).toMatchObject(await systemRun(["/usr/bin/hostname", "new-name"]));
  expect(await run(["hostname", "one", "two"])).toMatchObject(await systemRun(["/usr/bin/hostname", "one", "two"]));
  for (const command of ["arch", "hostid", "logname", "whoami", "tty", "uname"]) {
    expect(await run([command, "extra\narg"])).toMatchObject(await systemRun([command, "extra\narg"]));
  }
  const coreutilsHelp = await run(["coreutils", "--help"]);
  const coreutilsHelpStdout = coreutilsHelp.stdout;
  expect(coreutilsHelp).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: coreutils --coreutils-prog=PROGRAM_NAME [PARAMETERS]...\n") });
  expect(coreutilsHelpStdout.includes("Built-in programs:\n")).toBe(true);
  expect(coreutilsHelpStdout.includes("Use: 'coreutils --coreutils-prog=PROGRAM_NAME --help' for individual program help.\n")).toBe(true);
  expect(await run(["coreutils", "--coreutils-prog=echo", "via-prog"])).toMatchObject({ code: 0, stdout: "via-prog\n", stderr: "" });
  expect(await run(["coreutils", "--coreutils-prog-shebang=echo", "wrapper-name", "via-shebang"])).toMatchObject({ code: 0, stdout: "via-shebang\n", stderr: "" });
  expect(await run(["coreutils", "--coreutils-prog-shebang=echo"])).toMatchObject({ code: 1, stdout: "", stderr: "coreutils: unknown program 'echo'\n" });
  expect(await run(["coreutils", "--coreutils-prog-shebang=missing", "wrapper-name"])).toMatchObject({ code: 1, stdout: "", stderr: "coreutils: unknown program 'missing'\n" });
  expect(await run(["tty"])).toMatchObject({ code: 1, stdout: "not a tty\n" });
  expect(await run(["tty", "-s"])).toMatchObject({ code: 1, stdout: "" });
  expect(await run(["tty", "--quiet"])).toMatchObject({ code: 1, stdout: "" });
  expect(await run(["tty", "--sil"])).toMatchObject({ code: 1, stdout: "" });
  expect(await run(["tty", "--q"])).toMatchObject({ code: 1, stdout: "" });
  const ttyHelp = (await run(["tty", "--he", "extra"])).stdout;
  expect(ttyHelp).toContain("Usage: tty [OPTION]...\n");
  expect(ttyHelp).toContain("         print nothing, only return an exit status\n");
  expect(await run(["tty", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["tty", "--s=1", "--h"])).toMatchObject({ code: 2, stderr: "tty: option '--silent' doesn't allow an argument\nTry 'tty --help' for more information.\n" });
  expect(await run(["tty", "-x", "--help"])).toMatchObject({ code: 2, stderr: "tty: invalid option -- 'x'\nTry 'tty --help' for more information.\n" });
  expect(await run(["tty", "extra"])).toMatchObject(await systemRun(["tty", "extra"]));
  const fullTty = Bun.spawn(["/bin/sh", "-c", `${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} tty </dev/null >/dev/full`], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await fullTty.exited).toBe(3);
  expect((await run(["id", "-u"])).stdout.trim()).toMatch(/^\d+$/);
  expect((await run(["id", "-gn"])).stdout.trim()).not.toMatch(/^\d+$/);
  expect((await run(["id", "-Gn"])).stdout.trim()).not.toMatch(/^\d+( \d+)*$/);
  expect((await run(["id", "-z", "-u"])).stdout).toBe((await run(["id", "-u"])).stdout.trim() + "\0");
  expect((await run(["id", "-z", "-Gn"])).stdout).toContain("\0");
  expect(await run(["id", "-z"])).toMatchObject({ code: 1 });
  expect(await run(["id", "-n"])).toMatchObject({ code: 1 });
  expect(await run(["id", "-u", "-G"])).toMatchObject({ code: 1 });
  expect(await run(["id", "-Z"])).toMatchObject({ code: 1, stderr: "id: --context (-Z) works only on an SELinux-enabled kernel\n" });
  expect(await run(["id", "--context"])).toMatchObject({ code: 1, stderr: "id: --context (-Z) works only on an SELinux-enabled kernel\n" });
  expect(await run(["id", "-Z", "--version"])).toMatchObject({ code: 1, stderr: "id: --context (-Z) works only on an SELinux-enabled kernel\n" });
  expect(await run(["id", "--context", "--help"])).toMatchObject({ code: 1, stderr: "id: --context (-Z) works only on an SELinux-enabled kernel\n" });
  expect(await run(["id", "--he=bad"])).toMatchObject(await systemRun(["id", "--he=bad"]));
  expect(await run(["id", "--u"])).toMatchObject(await systemRun(["id", "--u"]));
  expect(await run(["id", "--g"])).toMatchObject(await systemRun(["id", "--g"]));
  expect(await run(["id", "--n=bad"])).toMatchObject(await systemRun(["id", "--n=bad"]));
  const currentUser = (await run(["whoami"])).stdout.trim();
  expect(await run(["id", "-un", currentUser])).toMatchObject({ code: 0, stdout: `${currentUser}\n` });
  expect(await run(["id", "-Gn", currentUser])).toMatchObject(await systemRun(["/usr/bin/id", "-Gn", currentUser]));
  expect(await run(["id", "definitely-missing-user"])).toMatchObject(await systemRun(["/usr/bin/id", "definitely-missing-user"]));
  expect(await run(["id", "+99999999"])).toMatchObject(await systemRun(["/usr/bin/id", "+99999999"]));
  expect(await run(["id", "-u", "definitely-missing-user"])).toMatchObject(await systemRun(["/usr/bin/id", "-u", "definitely-missing-user"]));
  expect(await run(["id", currentUser, "extra"])).toMatchObject({ code: 1 });
  expect((await run(["groups"])).stdout).toBe((await run(["id", "-Gn"])).stdout);
  expect(await run(["groups", currentUser])).toMatchObject(await systemRun(["/usr/bin/groups", currentUser]));
  expect(await run(["groups", "definitely-missing-user"])).toMatchObject(await systemRun(["/usr/bin/groups", "definitely-missing-user"]));
  expect(await run(["groups", "definitely-missing-user"], "", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/groups", "definitely-missing-user"], "", { env: { LC_ALL: "C" } }));
  for (const command of ["arch", "groups", "hostid", "logname", "users", "whoami", "link", "unlink"]) {
    expect(await run([command, "-x", "--help"])).toMatchObject({ code: 1, stderr: expect.stringContaining(`${command}: invalid option -- 'x'\n`) });
  }
  expect((await run(["whoami"])).stdout).toBe((await run(["id", "-un"])).stdout);
  expect(await run(["whoami", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: whoami [OPTION]...\n") });
  expect(await run(["whoami", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["whoami", "--v=1"])).toMatchObject({ code: 1, stderr: "whoami: option '--version' doesn't allow an argument\nTry 'whoami --help' for more information.\n" });
  expect(await run(["whoami", "extra"])).toMatchObject(await systemRun(["whoami", "extra"]));
  expect((await run(["logname"])).stdout.trim().length).toBeGreaterThan(0);
  expect(await run(["logname", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: logname [OPTION]\n") });
  expect(await run(["logname", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["logname", "--v=1"])).toMatchObject({ code: 1, stderr: "logname: option '--version' doesn't allow an argument\nTry 'logname --help' for more information.\n" });
  expect(await run(["logname", "extra"])).toMatchObject({ code: 1 });
  expect(await run(["users"])).toMatchObject(await systemRun(["/usr/bin/users"]));
  expect(await run(["users", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: users [OPTION]... [FILE]\n") });
  expect(await run(["users", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("If FILE is not specified, use /var/run/utmp.  /var/log/wtmp as FILE is common.\n") });
  expect(await run(["users", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["users", "--h=1"])).toMatchObject({ code: 1, stderr: "users: option '--help' doesn't allow an argument\nTry 'users --help' for more information.\n" });
  const utmpUsers = Buffer.alloc(384 * 2);
  utmpUsers.writeInt16LE(7, 0);
  utmpUsers.write("alice", 44, "utf8");
  utmpUsers.writeInt16LE(7, 384);
  utmpUsers.write("bob", 384 + 44, "utf8");
  await writeFile(join(dir, "users-utmp"), utmpUsers);
  expect(await run(["users", "users-utmp"])).toMatchObject({ code: 0, stdout: "alice bob\n" });
  await writeFile(join(dir, "utmp-like"), "");
  expect(await run(["users", "utmp-like"])).toMatchObject({ code: 0, stdout: "" });
  await writeFile(join(dir, "non-utmp-like"), "x");
  expect(await run(["users", "non-utmp-like"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["users", "missing-utmp"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["users", "one", "two"])).toMatchObject(await systemRun(["users", "one", "two"]));
  expect(await run(["users", "one", "extra\narg"])).toMatchObject(await systemRun(["users", "one", "extra\narg"]));
  expect(Number((await run(["nproc"])).stdout.trim())).toBeGreaterThanOrEqual(1);
  const nprocRoot = join(dir, "nproc-cgroup");
  await mkdir(join(nprocRoot, "proc/self"), { recursive: true });
  await mkdir(join(nprocRoot, "sys/fs/cgroup/foo"), { recursive: true });
  await writeFile(join(nprocRoot, "proc/self/cgroup"), "0::/foo\n");
  await writeFile(join(nprocRoot, "proc/self/sched"), "policy : 0\n");
  await writeFile(join(nprocRoot, "sys/fs/cgroup/foo/cpu.max"), "40000 100000\n");
  const nprocQuotaEnv = { BNU_NPROC_TEST_ROOT: nprocRoot, OMP_NUM_THREADS: "", OMP_THREAD_LIMIT: "" };
  expect(await run(["nproc"], "", { env: nprocQuotaEnv })).toMatchObject({ code: 0, stdout: "1\n" });
  await writeFile(join(nprocRoot, "sys/fs/cgroup/foo/cpu.max"), "150000 100000\n");
  expect(await run(["nproc"], "", { env: nprocQuotaEnv })).toMatchObject({ code: 0, stdout: `${Math.min(2, availableParallelism())}\n` });
  await writeFile(join(nprocRoot, "sys/fs/cgroup/foo/cpu.max"), "140000 100000\n");
  expect(await run(["nproc"], "", { env: nprocQuotaEnv })).toMatchObject({ code: 0, stdout: "1\n" });
  await writeFile(join(nprocRoot, "sys/fs/cgroup/foo/cpu.max"), "max 100000\n");
  await writeFile(join(nprocRoot, "sys/fs/cgroup/cpu.max"), "150000 100000\n");
  expect(await run(["nproc"], "", { env: nprocQuotaEnv })).toMatchObject({ code: 0, stdout: `${Math.min(2, availableParallelism())}\n` });
  await writeFile(join(nprocRoot, "sys/fs/cgroup/cpu.max"), "max 100000\n");
  expect(await run(["nproc"], "", { env: { ...nprocQuotaEnv, OMP_NUM_THREADS: "3" } })).toMatchObject({ code: 0, stdout: "3\n" });
  await writeFile(join(nprocRoot, "sys/fs/cgroup/foo/cpu.max"), "150000 100000\n");
  expect(await run(["nproc"], "", { env: { ...nprocQuotaEnv, OMP_THREAD_LIMIT: "10" } })).toMatchObject({ code: 0, stdout: `${Math.min(2, availableParallelism())}\n` });
  await writeFile(join(nprocRoot, "proc/self/sched"), "policy : 1\n");
  expect(await run(["nproc"], "", { env: nprocQuotaEnv })).toMatchObject({ code: 0, stdout: `${availableParallelism()}\n` });
  await writeFile(join(nprocRoot, "proc/self/sched"), "policy : -1\n");
  expect(await run(["nproc"], "", { env: nprocQuotaEnv })).toMatchObject({ code: 0, stdout: `${availableParallelism()}\n` });
  await writeFile(join(nprocRoot, "proc/self/sched"), "policy : 0\n");
  await writeFile(join(nprocRoot, "sys/fs/cgroup/foo/cpu.max"), "max 100000\n");
  expect(await run(["nproc"], "", { env: nprocQuotaEnv })).toMatchObject({ code: 0, stdout: `${availableParallelism()}\n` });
  expect(await run(["nproc", "--all"], "", { env: nprocQuotaEnv })).toMatchObject(await run(["nproc", "--all"]));
  expect(await run(["nproc"], "", { env: { OMP_NUM_THREADS: "3" } })).toMatchObject({ code: 0, stdout: "3\n" });
  expect(await run(["nproc"], "", { env: { OMP_NUM_THREADS: "9007199254740993", OMP_THREAD_LIMIT: "" } })).toMatchObject({ code: 0, stdout: "9007199254740993\n" });
  expect(await run(["nproc"], "", { env: { OMP_NUM_THREADS: "18446744073709551616", OMP_THREAD_LIMIT: "" } })).toMatchObject({ code: 0, stdout: "18446744073709551615\n" });
  expect(await run(["nproc"], "", { env: { OMP_NUM_THREADS: "18446744073709551615", OMP_THREAD_LIMIT: "9007199254740993" } })).toMatchObject({ code: 0, stdout: "9007199254740993\n" });
  expect(await run(["nproc", "--ignore=1"], "", { env: { OMP_NUM_THREADS: "3", OMP_THREAD_LIMIT: "2" } })).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["nproc", "--i=1"], "", { env: { OMP_NUM_THREADS: "3", OMP_THREAD_LIMIT: "2" } })).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["nproc", "--ig", "1"], "", { env: { OMP_NUM_THREADS: "3", OMP_THREAD_LIMIT: "2" } })).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["nproc", "--ignore=99"], "", { env: { OMP_NUM_THREADS: "1" } })).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["nproc", "--ignore= 1"], "", { env: { OMP_NUM_THREADS: "3" } })).toMatchObject({ code: 0, stdout: "2\n" });
  expect(await run(["nproc", "--ignore=+2"], "", { env: { OMP_NUM_THREADS: "3" } })).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["nproc", "--ignore=999999999999999999999999"], "", { env: { OMP_NUM_THREADS: "3" } })).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["nproc", "--all"], "", { env: { OMP_NUM_THREADS: "1" } })).toMatchObject(await run(["nproc", "--all"]));
  expect(await run(["nproc", "--a"], "", { env: { OMP_NUM_THREADS: "1" } })).toMatchObject(await run(["nproc", "--all"]));
  const nprocHelp = (await run(["nproc", "--h"])).stdout;
  expect(nprocHelp).toContain("Usage: nproc [OPTION]...\n");
  expect(nprocHelp).toContain("which may be less than the number of online processors.\n");
  expect(nprocHelp).toContain("then they will determine the minimum and maximum returned value respectively.\n");
  expect(nprocHelp).toContain("         The result is guaranteed to be at least 1.\n");
  expect(await run(["nproc", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["nproc", "--a=1"])).toMatchObject({ code: 1, stderr: "nproc: option '--all' doesn't allow an argument\nTry 'nproc --help' for more information.\n" });
  expect(await run(["nproc", "-x", "--help"])).toMatchObject({ code: 1, stderr: "nproc: invalid option -- 'x'\nTry 'nproc --help' for more information.\n" });
  expect(await run(["nproc", "-x", "--version"])).toMatchObject({ code: 1, stderr: "nproc: invalid option -- 'x'\nTry 'nproc --help' for more information.\n" });
  expect(await run(["nproc", "--i", "--h"])).toMatchObject(await systemRun(["nproc", "--i", "--h"]));
  expect(await run(["nproc", "--use=4"])).toMatchObject({ code: 1, stderr: "nproc: unrecognized option '--use=4'\nTry 'nproc --help' for more information.\n" });
  expect(await run(["nproc", "--ignore=0x2"])).toMatchObject(await systemRun(["nproc", "--ignore=0x2"]));
  expect(await run(["nproc", "--ignore=1\n2"])).toMatchObject({ code: 1, stderr: `nproc: invalid number: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["nproc", "--ignore=bad", "--help"])).toMatchObject(await systemRun(["nproc", "--ignore=bad", "--help"]));
  expect(await run(["nproc", "--ignore=-1"])).toMatchObject(await systemRun(["nproc", "--ignore=-1"]));
  expect(await run(["nproc", "--ignore="])).toMatchObject(await systemRun(["nproc", "--ignore="]));
  expect(await run(["nproc", "--ignore=", "--help"])).toMatchObject(await systemRun(["nproc", "--ignore=", "--help"]));
  expect(await run(["nproc", "--ignore=   "])).toMatchObject(await systemRun(["nproc", "--ignore=   "]));
  expect(await run(["nproc", "extra"])).toMatchObject(await systemRun(["nproc", "extra"]));
  expect(await run(["nproc", "extra\narg"])).toMatchObject(await systemRun(["nproc", "extra\narg"]));
  expect(await run(["nproc", "--all", "extra"])).toMatchObject(await systemRun(["nproc", "--all", "extra"]));
});

test("uptime reports GNU coreutils uptime format", async () => {
  expect((await run(["uptime"])).stdout).toMatch(/^ \d{2}:\d{2}:\d{2} up +(?:(?:\d+ days?, +)?\d+:\d{2}|\?\?\?\? days \?\?:\?\?),  \d+ users?,  load average: \d+\.\d{2}, \d+\.\d{2}, \d+\.\d{2}\n$/);
  const uptimeHelp = await run(["uptime", "--h"]);
  expect(uptimeHelp.stdout).not.toContain("--pretty");
  expect(uptimeHelp.stdout).not.toContain("--raw");
  expect(uptimeHelp).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: uptime [OPTION]... [FILE]\n") });
  expect(await run(["uptime", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["uptime", "--pretty"])).toMatchObject({ code: 1, stderr: "uptime: unrecognized option '--pretty'\nTry 'uptime --help' for more information.\n" });
  expect(await run(["uptime", "--raw", "--help"])).toMatchObject({ code: 1, stderr: "uptime: unrecognized option '--raw'\nTry 'uptime --help' for more information.\n" });
  expect(await run(["uptime", "-p"])).toMatchObject({ code: 1, stderr: "uptime: invalid option -- 'p'\nTry 'uptime --help' for more information.\n" });
  const bootRecord = Buffer.alloc(384);
  bootRecord.writeInt16LE(2, 0);
  bootRecord.writeInt32LE(Math.trunc(Date.now() / 1000) - (2 * 86400 + 3 * 3600 + 4 * 60), 340);
  await writeFile(join(dir, "boot-utmp"), bootRecord);
  expect((await run(["uptime", "boot-utmp"])).stdout).toMatch(/^ \d{2}:\d{2}:\d{2} up 2 days,  3:04,  0 users,  load average: \d+\.\d{2}, \d+\.\d{2}, \d+\.\d{2}\n$/);
  await writeFile(join(dir, "empty-utmp"), "");
  const emptyUtmp = await run(["uptime", "empty-utmp"]);
  expect(emptyUtmp).toMatchObject({ code: 1, stderr: "uptime: couldn't get boot time\n" });
  expect(emptyUtmp.stdout).toMatch(/^ \d{2}:\d{2}:\d{2} up \?\?\?\? days \?\?:\?\?,  0 users,  load average: \d+\.\d{2}, \d+\.\d{2}, \d+\.\d{2}\n$/);
  expect(await run(["uptime", "one", "two"])).toMatchObject({ code: 1, stderr: `uptime: extra operand ${diagnosticQuote("two")}\nTry 'uptime --help' for more information.\n` });
});

test("pathchk and sync return command statuses", async () => {
  expect(await run(["pathchk"])).toMatchObject({ code: 1, stderr: "pathchk: missing operand\nTry 'pathchk --help' for more information.\n" });
  expect(await run(["pathchk", "valid/path"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["pathchk", ""])).toMatchObject({ code: 1, stderr: "pathchk: '': No such file or directory\n" });
  expect(await run(["pathchk", "-P", ""])).toMatchObject({ code: 1, stderr: "pathchk: empty file name\n" });
  expect(await run(["pathchk", "x".repeat(300)])).toMatchObject({ code: 1, stderr: `pathchk: ${"x".repeat(300)}: File name too long\n` });
  await writeFile(join(dir, "plain-file"), "");
  expect(await run(["pathchk", "plain-file/child"])).toMatchObject({ code: 1, stderr: "pathchk: plain-file/child: Not a directory\n" });
  expect(await run(["pathchk", "-p", "portable_1"])).toMatchObject({ code: 0 });
  expect(await run(["pathchk", "-p", "plain-file/child"])).toMatchObject({ code: 0, stderr: "" });
  expect(await run(["pathchk", "-p", "plain-file/has space"])).toMatchObject(await systemRun(["pathchk", "-p", "plain-file/has space"]));
  expect(await run(["pathchk", "--p", "componenttoolong"])).toMatchObject(await systemRun(["pathchk", "--p", "componenttoolong"]));
  const pathchkHelp = await run(["pathchk", "--h", "valid/path"]);
  const pathchkHelpStdout = pathchkHelp.stdout;
  expect(pathchkHelp).toMatchObject({ code: 0 });
  expect(pathchkHelpStdout).toContain("Usage: pathchk [OPTION]... NAME...\n");
  expect(pathchkHelpStdout).toContain("  -p     check for most POSIX systems\n");
  expect(pathchkHelpStdout).toContain("  -P     check for empty names and leading \"-\"\n");
  expect(pathchkHelpStdout).toContain("         check for all POSIX systems (equivalent to -p -P)\n");
  expect(await run(["pathchk", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["pathchk", "-x", "--help"])).toMatchObject({ code: 1, stderr: "pathchk: invalid option -- 'x'\nTry 'pathchk --help' for more information.\n" });
  expect(await run(["pathchk", "--p=1", "valid/path"])).toMatchObject({ code: 1, stderr: "pathchk: option '--portability' doesn't allow an argument\nTry 'pathchk --help' for more information.\n" });
  expect(await run(["pathchk", "valid/path", "--h"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["pathchk", "valid/path", "--bad"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["pathchk", "--portability", "componenttoolong"])).toMatchObject(await systemRun(["pathchk", "--portability", "componenttoolong"]));
  expect(await run(["pathchk", "--portability", "plain-file/child"])).toMatchObject({ code: 0, stderr: "" });
  const longPortable = "x".repeat(300);
  expect(await run(["pathchk", "--portability", longPortable])).toMatchObject({ code: 1, stderr: `pathchk: limit 255 exceeded by length 300 of file name '${longPortable}'\n` });
  expect(await run(["pathchk", "--portability", "has space"])).toMatchObject(await systemRun(["pathchk", "--portability", "has space"]));
  expect(await run(["pathchk", "--portability", "bad:name"])).toMatchObject({ code: 1, stdout: "", stderr: `pathchk: non-portable character ${diagnosticQuote(":")} in file name 'bad:name'\n` });
  expect(await run(["pathchk", "-p", "a\tb"])).toMatchObject({ code: 1, stdout: "", stderr: `pathchk: non-portable character ${diagnosticQuote("\\t")} in file name 'a'$'\\t''b'\n` });
  expect(await run(["pathchk", "-p", "a\u0001b"])).toMatchObject({ code: 1, stdout: "", stderr: `pathchk: non-portable character ${diagnosticQuote("\\001")} in file name 'a'$'\\001''b'\n` });
  expect(await run(["pathchk", "-p", "a'b"])).toMatchObject({ code: 1, stdout: "", stderr: `pathchk: non-portable character ${diagnosticQuote("'")} in file name "a'b"\n` });
  expect(await run(["pathchk", "-p", "--", "-file"])).toMatchObject({ code: 0, stderr: "" });
  expect(await run(["pathchk", "-P", "--", "-file"])).toMatchObject({ code: 1, stderr: "pathchk: leading '-' in a component of file name '-file'\n" });
  expect(await run(["pathchk", "-P", "--", "plain-file/-child"])).toMatchObject({ code: 1, stderr: "pathchk: leading '-' in a component of file name 'plain-file/-child'\n" });
  expect(await run(["pathchk", "--portability", "--", "-file"])).toMatchObject({ code: 1, stderr: "pathchk: leading '-' in a component of file name '-file'\n" });
  expect(await run(["pathchk", "-P", "dir//file"])).toMatchObject({ code: 0, stderr: "" });
  expect(await run(["sync"])).toMatchObject({ code: 0 });
  await writeFile(join(dir, "sync-file"), "x");
  expect(await run(["sync", "sync-file"])).toMatchObject({ code: 0 });
  expect(await run(["sync", "missing'sync"])).toMatchObject({ code: 1, stdout: "", stderr: "sync: error opening \"missing'sync\": No such file or directory\n" });
  expect(await run(["sync", "missing\nsync"])).toMatchObject({ code: 1, stdout: "", stderr: "sync: error opening 'missing'$'\\n''sync': No such file or directory\n" });
  expect(await run(["sync", "-d", "sync-file"])).toMatchObject({ code: 0 });
  expect(await run(["sync", "--d", "sync-file"])).toMatchObject({ code: 0 });
  expect(await run(["sync", "sync-file", "--d"])).toMatchObject({ code: 0 });
  expect(await run(["sync", "sync-file", "-d"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 1, stderr: "sync: error opening '-d': No such file or directory\n" });
  expect(await run(["sync", "sync-file", "--d"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 1, stderr: "sync: error opening '--d': No such file or directory\n" });
  expect(await run(["sync", "--file-system", "sync-file"])).toMatchObject({ code: 0 });
  expect(await run(["sync", "--fi", "sync-file"])).toMatchObject({ code: 0 });
  const syncHelp = (await run(["sync", "--h", "sync-file"])).stdout;
  expect(syncHelp).toContain("Usage: sync [OPTION] [FILE]...\n");
  expect(syncHelp).toContain("If one or more files are specified, sync only them,\nor their containing file systems.\n");
  expect(syncHelp).toContain("-d, --data             sync only file data, no unneeded metadata\n");
  expect(syncHelp).toContain("-f, --file-system      sync the file systems that contain the files\n");
  expect(await run(["sync", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["sync", "--d=1", "sync-file"])).toMatchObject({ code: 1, stderr: "sync: option '--data' doesn't allow an argument\nTry 'sync --help' for more information.\n" });
  expect(await run(["sync", "--f=1", "sync-file"])).toMatchObject({ code: 1, stderr: "sync: option '--file-system' doesn't allow an argument\nTry 'sync --help' for more information.\n" });
  expect(await run(["sync", "--data", "--file-system"])).toMatchObject({ code: 1, stderr: "sync: cannot specify both --data and --file-system\n" });
  expect(await run(["sync", "-d", "-f", "sync-file"])).toMatchObject({ code: 1, stderr: "sync: cannot specify both --data and --file-system\n" });
  expect(await run(["sync", "-d"])).toMatchObject({ code: 1 });
  const missing = await run(["sync", "missing-file"]);
  expect(missing).toMatchObject({ code: 1 });
  expect(missing.stderr).toBe("sync: error opening 'missing-file': No such file or directory\n");
  await symlink("missing-sync-target", join(dir, "sync-dangling"));
  expect(await run(["sync", "sync-dangling"])).toMatchObject({ code: 1, stdout: "", stderr: "sync: error opening 'sync-dangling': No such file or directory\n" });
  const mixed = await run(["sync", "missing-a", "sync-file", "missing-b"]);
  expect(mixed).toMatchObject({ code: 1 });
  expect(mixed.stderr).toBe("sync: error opening 'missing-a': No such file or directory\nsync: error opening 'missing-b': No such file or directory\n");
  expect(await run(["mkfifo", "sync-fifo"])).toMatchObject({ code: 0 });
  const syncFifo = Bun.spawn(["timeout", "2", process.execPath, join(import.meta.dir, "../bin/bnu.js"), "sync", "sync-fifo"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await syncFifo.exited).toBe(0);
});

test("ls, stat and du report filesystem data", async () => {
  await mkdir(join(dir, "tree/sub"), { recursive: true });
  await writeFile(join(dir, "tree/a.txt"), "abc");
  await writeFile(join(dir, "tree/sub/b.txt"), "defgh");
  expect(await run(["stat"])).toMatchObject({ code: 1, stderr: "stat: missing operand\nTry 'stat --help' for more information.\n" });
  expect(await run(["stat", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: stat [OPTION]... FILE...\n") });
  expect(await run(["stat", "--he=bad", "tree/a.txt"])).toMatchObject(await systemRun(["stat", "--he=bad", "tree/a.txt"]));
  expect((await run(["ls", "tree"])).stdout).toBe("a.txt\nsub\n");
  expect((await run(["ls", "-1", "tree"])).stdout).toBe("a.txt\nsub\n");
  expect(await run(["ls", "--he=bad", "tree"])).toMatchObject(await systemRun(["ls", "--he=bad", "tree"]));
  await symlink("ls-loop", join(dir, "ls-loop"));
  expect(await run(["ls", "-L", "ls-loop"])).toMatchObject({ code: 2, stdout: "", stderr: "ls: cannot access 'ls-loop': Too many levels of symbolic links\n" });
  const statDefault = await run(["stat", "tree/a.txt"]);
  expect(statDefault).toMatchObject({ code: 0, stderr: "" });
  expect(statDefault.stdout).toContain("  File: tree/a.txt\n");
  expect(statDefault.stdout).toMatch(/Size: 3\s+Blocks: \d+\s+IO Block: \d+\s+regular file/);
  expect(statDefault.stdout).toMatch(/Device: \d+,\d+\s+Inode: \d+\s+Links: 1/);
  expect(statDefault.stdout).toMatch(/Access: \(0?644\/-rw-r--r--\)\s+Uid: \(\s*\d+\/\s*.+\)\s+Gid: \(\s*\d+\/\s*.+\)/);
  expect(statDefault.stdout).toContain("Modify: ");
  expect(statDefault.stdout).toContain("Change: ");
  expect(statDefault.stdout).toContain(" Birth: ");
  expect(await run(["stat", "-c", "%n %s %F", "tree/a.txt"])).toMatchObject({ code: 0, stdout: "tree/a.txt 3 regular file\n" });
  await writeFile(join(dir, "stat-empty"), "");
  expect(await run(["stat", "-c", "%n %s %F", "stat-empty"])).toMatchObject({ code: 0, stdout: "stat-empty 0 regular empty file\n" });
  expect(await run(["stat", "-c", "%u %U %g %G", "tree/a.txt"])).toMatchObject(await systemRun(["/usr/bin/stat", "-c", "%u %U %g %G", "tree/a.txt"]));
  expect(await run(["stat", "-c", "%N", "tree/a.txt"])).toMatchObject({ code: 0, stdout: "'tree/a.txt'\n" });
  await symlink("tree/a.txt", join(dir, "stat-link"));
  await symlink("missing-stat-target", join(dir, "stat-dangling"));
  expect(await run(["stat", "-c", "%N", "stat-link"])).toMatchObject({ code: 0, stdout: "'stat-link' -> 'tree/a.txt'\n" });
  expect(await run(["stat", "-L", "-c", "%N", "stat-link"])).toMatchObject({ code: 0, stdout: "'stat-link'\n" });
  expect(await run(["stat", "-L", "-c", "%n:%s:%F", "stat-link", "stat-dangling"])).toMatchObject({ code: 1, stdout: "stat-link:3:regular file\n", stderr: "stat: cannot statx 'stat-dangling': No such file or directory\n" });
  expect(await run(["stat", "missing\nstat"])).toMatchObject({ code: 1, stdout: "", stderr: "stat: cannot statx 'missing'$'\\n''stat': No such file or directory\n" });
  expect(await run(["stat", "missing'stat"])).toMatchObject({ code: 1, stdout: "", stderr: "stat: cannot statx \"missing'stat\": No such file or directory\n" });
  expect(await run(["stat", "--cached=always", "-c", "%n %s", "tree/a.txt"])).toMatchObject({ code: 0, stdout: "tree/a.txt 3\n" });
  expect(await run(["stat", "--cached=", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `stat: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--cached")}\nValid arguments are:\n  - ${diagnosticQuote("default")}\n  - ${diagnosticQuote("never")}\n  - ${diagnosticQuote("always")}\nTry 'stat --help' for more information.\n`,
  });
  expect(await run(["stat", "--ca=bad", "tree/a.txt"])).toMatchObject(await systemRun(["stat", "--ca=bad", "tree/a.txt"]));
  expect(await run(["stat", "--cached=bad", "tree/a.txt"])).toMatchObject(await systemRun(["stat", "--cached=bad", "tree/a.txt"]));
  expect(await run(["stat", "--cached", "bad", "--help"])).toMatchObject(await systemRun(["stat", "--cached", "bad", "--help"]));
  expect(await run(["stat", "--cached=bad\nmode", "tree/a.txt"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `stat: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--cached")}\nValid arguments are:\n  - ${diagnosticQuote("default")}\n  - ${diagnosticQuote("never")}\n  - ${diagnosticQuote("always")}\nTry 'stat --help' for more information.\n`,
  });
  const statFsDefault = await run(["stat", "--file-system", "tree/a.txt"]);
  expect(statFsDefault).toMatchObject({ code: 0, stderr: "" });
  expect(statFsDefault.stdout).toContain('  File: "tree/a.txt"\n');
  expect(statFsDefault.stdout).toMatch(/ID: \S+\s+Namelen: \d+\s+Type: \S+/);
  expect(statFsDefault.stdout).toMatch(/Block size: \d+\s+Fundamental block size: \d+/);
  expect(statFsDefault.stdout).toMatch(/Blocks: Total: \d+\s+Free: \d+\s+Available: \d+/);
  expect(statFsDefault.stdout).toMatch(/Inodes: Total: \d+\s+Free: \d+\n$/);
  expect(statFsDefault.stdout).not.toContain("regular file");
  expect(await run(["stat", "-f", "missing'stat"])).toMatchObject({ code: 1, stdout: "", stderr: "stat: cannot read file system information for \"missing'stat\": No such file or directory\n" });
  expect(await run(["stat", "-f", "-c", "%i", "tree/a.txt"])).toMatchObject(await systemRun(["/usr/bin/stat", "-f", "-c", "%i", "tree/a.txt"]));
  expect(await run(["stat", "-f", "-c", "%A", "tree/a.txt"])).toMatchObject({ code: 0, stdout: "?\n" });
  expect(await run(["stat", "-c", "%02s", "tree/a.txt"])).toMatchObject({ code: 0, stdout: "03\n" });
  expect(await run(["stat", "-c", "%q", "tree/a.txt"])).toMatchObject({ code: 0, stdout: "?\n" });
  expect(await run(["stat", "-c", "%Q", "tree/a.txt"])).toMatchObject({ code: 0, stdout: "?\n" });
  expect(await run(["stat", "-c", "%#a", "tree/a.txt"])).toMatchObject({ code: 0, stdout: "0644\n" });
  expect((await run(["stat", "-c", "%#f %#D", "tree/a.txt"])).stdout.trim()).toMatch(/^0x[0-9a-f]+ 0x[0-9a-f]+$/);
  expect(await run(["stat", "-c", "%C", "tree/a.txt"])).toMatchObject({ code: 1, stdout: "?\n", stderr: "stat: failed to get security context of 'tree/a.txt': Operation not supported\n" });
  await writeFile(join(dir, "stat\ncontext"), "x");
  expect(await run(["stat", "-c", "%C", "stat\ncontext"])).toMatchObject({ code: 1, stdout: "?\n", stderr: "stat: failed to get security context of 'stat'$'\\n''context': Operation not supported\n" });
  await writeFile(join(dir, "stat'context"), "x");
  expect(await run(["stat", "-c", "%C", "stat'context"])).toMatchObject({ code: 1, stdout: "?\n", stderr: "stat: failed to get security context of \"stat'context\": Operation not supported\n" });
  expect((await run(["stat", "-c", "%A %f %i %h %u %g %X %Y %Z", "tree/a.txt"])).stdout.trim()).toMatch(/^-rw-r--r-- [0-9a-f]+ \d+ 1 \d+ \d+ \d+ \d+ \d+$/);
  expect(await run(["stat", "-c", "%t %T %r %R %Hr %Lr", "/dev/null"])).toMatchObject(await systemRun(["/usr/bin/stat", "-c", "%t %T %r %R %Hr %Lr", "/dev/null"]));
  expect(await run(["stat", "-c", "%H %L %Hd %Ld %HR %LR %Ht %LT", "tree/a.txt"])).toMatchObject(await systemRun(["/usr/bin/stat", "-c", "%H %L %Hd %Ld %HR %LR %Ht %LT", "tree/a.txt"]));
  await writeFile(join(dir, "stat-ns"), "");
  await systemRun(["/usr/bin/touch", "-d", "2026-01-02 03:04:05.123456789 +0000", "stat-ns"]);
  await systemRun(["/usr/bin/touch", "-a", "-d", "2026-01-01 01:02:03.111111111 +0000", "stat-ns"]);
  expect(await run(["du", "-b", "--time", "--time-style=full-iso", "stat-ns"], "", { env: { TZ: "UTC0" } })).toMatchObject({
    code: 0,
    stdout: "0\t2026-01-02 03:04:05.123456789 +0000\tstat-ns\n",
  });
  expect(await run(["du", "-b", "--time=atime", "--time-style=full-iso", "stat-ns"], "", { env: { TZ: "UTC0" } })).toMatchObject({
    code: 0,
    stdout: "0\t2026-01-01 01:02:03.111111111 +0000\tstat-ns\n",
  });
  expect(await run(["du", "-b", "--time=", "stat-ns"])).toMatchObject({
    code: 1,
    stderr: `du: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--time")}\nValid arguments are:\n  - ${diagnosticQuote("atime")}, ${diagnosticQuote("access")}, ${diagnosticQuote("use")}\n  - ${diagnosticQuote("ctime")}, ${diagnosticQuote("status")}\nTry 'du --help' for more information.\n`,
  });
  expect(await run(["du", "-b", "--time=bad", "stat-ns"])).toMatchObject(await systemRun(["du", "-b", "--time=bad", "stat-ns"]));
  expect(await run(["du", "-b", "--time=bad\nmode", "stat-ns"])).toMatchObject({
    code: 1,
    stderr: `du: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--time")}\nValid arguments are:\n  - ${diagnosticQuote("atime")}, ${diagnosticQuote("access")}, ${diagnosticQuote("use")}\n  - ${diagnosticQuote("ctime")}, ${diagnosticQuote("status")}\nTry 'du --help' for more information.\n`,
  });
  expect(await run(["du", "-b", "--time", "atime", "stat-ns"], "", { env: { TZ: "UTC0" } })).toMatchObject(await systemRun(["du", "-b", "--time", "atime", "stat-ns"], "", { env: { TZ: "UTC0" } }));
  expect(await run(["stat", "-c", "%y", "stat-ns"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "2026-01-02 03:04:05.123456789 +0000\n" });
  expect(await run(["stat", "-c", "%.9Y", "stat-ns"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "1767323045.123456789\n" });
  expect(await run(["stat", "-c", "%I18.10Y", "stat-ns"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "1767323045.1234567890\n" });
  await writeFile(join(dir, "stat-negative-ns-a"), "");
  await writeFile(join(dir, "stat-negative-ns-b"), "");
  await systemRun(["/usr/bin/touch", "-d", "1969-12-31 23:59:59.123456789 +0000", "stat-negative-ns-a"]);
  await systemRun(["/usr/bin/touch", "-d", "1969-12-31 23:59:58.876543211 +0000", "stat-negative-ns-b"]);
  expect(await run(["stat", "-c", "%Y|%.9Y|%y", "stat-negative-ns-a", "stat-negative-ns-b"], "", { env: { TZ: "UTC0" } })).toMatchObject({
    code: 0,
    stdout: "-1|-0.876543211|1969-12-31 23:59:59.123456789 +0000\n-2|-1.123456789|1969-12-31 23:59:58.876543211 +0000\n",
  });
  expect(await run(["stat", "--printf=%n\\n%s", "tree/a.txt"])).toMatchObject({ code: 0, stdout: "tree/a.txt\n3" });
  expect(await run(["stat", "--printf=", "tree/a.txt"])).toMatchObject({ code: 0, stdout: "" });
  expect(await shell('"$BUN" "$BNU" stat --printf "\\\\" . 2>/dev/full')).toMatchObject({ code: 1 });
  expect(await run(["stat", "--format=%n", "-"], "abc")).toMatchObject({ code: 0, stdout: "-\n" });
  expect(await run(["stat", "-f", "-"], "abc")).toMatchObject({ code: 1, stdout: "" });
  expect((await run(["stat", "-f", "-c", "%n %s %T", "."])).stdout.trim()).toMatch(/^\. \d+ \S+$/);
  expect(await run(["stat", "-f", "-c", "%q", "."])).toMatchObject({ code: 0, stdout: "?\n" });
  expect((await run(["stat", "-t", "tree/a.txt"])).stdout).toContain("tree/a.txt 3 ");
  expect(await run(["du", "-b", "tree/a.txt"])).toMatchObject({ code: 0, stdout: "3\ttree/a.txt\n" });
  expect(await run(["du", "-bc", "tree/a.txt", "tree/sub/b.txt"])).toMatchObject({ code: 0, stdout: "3\ttree/a.txt\n5\ttree/sub/b.txt\n8\ttotal\n" });
  await mkdir(join(dir, "dot-du/sub"), { recursive: true });
  await writeFile(join(dir, "dot-du/sub/file"), "x");
  expect(await run(["du", "-a", "-b", "."], "", { cwd: join(dir, "dot-du") })).toMatchObject({ code: 0, stdout: "1\t./sub/file\n1\t./sub\n1\t.\n" });
  expect(await run(["du", "--apparent-size", "-B", "2", "tree/sub/b.txt"])).toMatchObject({ code: 0, stdout: "3\ttree/sub/b.txt\n" });
  expect(await run(["du", "--block-size=human-readable", "tree/sub/b.txt"])).toMatchObject({ code: 0, stdout: "4.0K\ttree/sub/b.txt\n" });
  expect(await run(["du", "--block-size=si", "tree/sub/b.txt"])).toMatchObject({ code: 0, stdout: "4.1k\ttree/sub/b.txt\n" });
  expect(await run(["du", "tree/sub/b.txt"], "", { env: { BLOCK_SIZE: "1R" } })).toMatchObject({ code: 0, stdout: "4096\ttree/sub/b.txt\n" });
  expect(await run(["du", "tree/sub/b.txt"], "", { env: { DU_BLOCK_SIZE: "1KB" } })).toMatchObject({ code: 0, stdout: "5\ttree/sub/b.txt\n" });
  expect(await run(["du", "tree/sub/b.txt"], "", { env: { POSIXLY_CORRECT: "1" } })).toMatchObject({ code: 0, stdout: "8\ttree/sub/b.txt\n" });
  expect(await run(["du", "tree/sub/b.txt"], "", { env: { POSIXLY_CORRECT: "1", BLOCK_SIZE: "bad" } })).toMatchObject({ code: 0, stdout: "8\ttree/sub/b.txt\n" });
  expect(await run(["du", "--block-size=bad", "tree/sub/b.txt"])).toMatchObject({ code: 1, stdout: "", stderr: "du: invalid --block-size argument 'bad'\n" });
  expect(await run(["du", "--block-size=bad", "--help"])).toMatchObject(await systemRun(["du", "--block-size=bad", "--help"]));
  expect(await run(["du", "--block-size", "bad", "--help"])).toMatchObject(await systemRun(["du", "--block-size", "bad", "--help"]));
  expect(await run(["du", "--block-size=1R", "tree/sub/b.txt"])).toMatchObject({ code: 1, stdout: "", stderr: "du: invalid suffix in --block-size argument '1R'\n" });
  expect(await run(["du", "-Bbad", "tree/sub/b.txt"])).toMatchObject({ code: 1, stdout: "", stderr: "du: invalid -B argument 'bad'\n" });
  expect(await run(["du", "-Bbad", "--help"])).toMatchObject(await systemRun(["du", "-Bbad", "--help"]));
  expect(await run(["du", "-B", "bad", "--help"])).toMatchObject(await systemRun(["du", "-B", "bad", "--help"]));
  expect(await run(["du", "-B1B", "tree/sub/b.txt"])).toMatchObject({ code: 1, stdout: "", stderr: "du: invalid suffix in -B argument '1B'\n" });
  expect(await run(["du", "--max-depth=bad", "tree"])).toMatchObject(await systemRun(["du", "--max-depth=bad", "tree"]));
  expect(await run(["du", "--max-depth=bad", "--help"])).toMatchObject({
    code: 0,
    stdout: expect.stringContaining("Usage: du [OPTION]... [FILE]...\n"),
    stderr: `du: invalid maximum depth ${diagnosticQuote("bad")}\n`,
  });
  expect(await run(["du", "--max-depth", "bad", "--help"])).toMatchObject({
    code: 0,
    stdout: expect.stringContaining("Usage: du [OPTION]... [FILE]...\n"),
    stderr: `du: invalid maximum depth ${diagnosticQuote("bad")}\n`,
  });
  expect(await run(["du", "-dbad", "--help"])).toMatchObject({
    code: 0,
    stdout: expect.stringContaining("Usage: du [OPTION]... [FILE]...\n"),
    stderr: `du: invalid maximum depth ${diagnosticQuote("bad")}\n`,
  });
  expect(await run(["du", "-d", "bad", "--help"])).toMatchObject({
    code: 0,
    stdout: expect.stringContaining("Usage: du [OPTION]... [FILE]...\n"),
    stderr: `du: invalid maximum depth ${diagnosticQuote("bad")}\n`,
  });
  expect(await run(["du", "--max-depth=1\n2", "tree"])).toMatchObject({ code: 1, stdout: "", stderr: `du: invalid maximum depth ${diagnosticQuote("1\\n2")}\nTry 'du --help' for more information.\n` });
  expect(await run(["du", "--max-depth=1.5", "tree"])).toMatchObject(await systemRun(["du", "--max-depth=1.5", "tree"]));
  expect(await run(["du", "-b", "--max-depth=-1", "tree"])).toMatchObject({ code: 0, stdout: "8\ttree\n" });
  expect(await run(["du", "-b", "-d-1", "tree"])).toMatchObject({ code: 0, stdout: "8\ttree\n" });
  expect(await run(["du", "-b", "-s", "--max-depth=-1", "tree"])).toMatchObject({ code: 1, stdout: "", stderr: "du: warning: summarizing conflicts with --max-depth=-1\nTry 'du --help' for more information.\n" });
  expect(await run(["du", "-b", "-s", "--max-depth=1", "tree"])).toMatchObject({ code: 1, stdout: "", stderr: "du: warning: summarizing conflicts with --max-depth=1\nTry 'du --help' for more information.\n" });
  expect(await run(["du", "-b", "-s", "--max-depth=+1", "tree"])).toMatchObject({ code: 1, stdout: "", stderr: "du: warning: summarizing conflicts with --max-depth=1\nTry 'du --help' for more information.\n" });
  expect(await run(["du", "--threshold", "bad", "--help"])).toMatchObject(await systemRun(["du", "--threshold", "bad", "--help"]));
  expect(await run(["du", "-tbad", "--help"])).toMatchObject(await systemRun(["du", "-tbad", "--help"]));
  expect(await run(["du", "-t", "bad", "--help"])).toMatchObject(await systemRun(["du", "-t", "bad", "--help"]));
  expect(await run(["du", "--ap", "-B", "2", "tree/sub/b.txt"])).toMatchObject({ code: 0, stdout: "3\ttree/sub/b.txt\n" });
  expect(await run(["du", "tree/a.txt", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: du [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["du", "--a"])).toMatchObject({
    code: 1,
    stderr: "du: option '--a' is ambiguous; possibilities: '--all' '--apparent-size'\nTry 'du --help' for more information.\n",
  });
  expect(await run(["du", "--all=bad"])).toMatchObject({
    code: 1,
    stderr: "du: option '--all' doesn't allow an argument\nTry 'du --help' for more information.\n",
  });
  expect(await run(["du", "-A", "-B", "1", "tree/sub/b.txt"])).toMatchObject({ code: 0, stdout: "5\ttree/sub/b.txt\n" });
  expect(await run(["du", "--apparent-size", "-m", "tree/sub/b.txt"])).toMatchObject({ code: 0, stdout: "1\ttree/sub/b.txt\n" });
  const duHelp = (await run(["du", "--help"])).stdout;
  expect(duHelp).toContain("Usage: du [OPTION]... [FILE]...\n  or:  du [OPTION]... --files0-from=F\n");
  for (const option of ["-k", "-m"]) expect(duHelp).toContain(`  ${option}\n`);
  expect(await run(["du", "--apparent-size", "--si", "tree/sub/b.txt"])).toMatchObject({ code: 0, stdout: "5B\ttree/sub/b.txt\n" });
  expect(await run(["du", "--human", "--apparent", "tree/sub/b.txt"])).toMatchObject({ code: 0, stdout: "5B\ttree/sub/b.txt\n" });
  await writeFile(join(dir, "decimal-du"), "");
  await truncate(join(dir, "decimal-du"), 1500);
  expect(await run(["du", "--apparent-size", "--si", "decimal-du"])).toMatchObject({ code: 0, stdout: "1.5k\tdecimal-du\n" });
  await mkdir(join(dir, "inode-tree"));
  await writeFile(join(dir, "inode-tree/file"), "");
  await link(join(dir, "inode-tree/file"), join(dir, "inode-tree/hardlink"));
  expect(await run(["du", "--inodes", "inode-tree"])).toMatchObject({ code: 0, stdout: "2\tinode-tree\n" });
  expect(await run(["du", "--apparent-size", "--inodes", "inode-tree"])).toMatchObject({ code: 0, stdout: "2\tinode-tree\n", stderr: "du: warning: options --apparent-size and -b are ineffective with --inodes\n" });
  expect(await run(["du", "--inodes", "--count-links", "inode-tree"])).toMatchObject({ code: 0, stdout: "3\tinode-tree\n" });
  expect(await run(["du", "--inodes", "--threshold=2", "inode-tree"])).toMatchObject({ code: 0, stdout: "2\tinode-tree\n" });
  expect(await run(["du", "--inodes", "--threshold=1K", "inode-tree"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["du", "--inodes", "--threshold=-1", "inode-tree"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["du", "--inodes", "--threshold=1.5", "inode-tree"])).toMatchObject({ code: 1, stdout: "", stderr: "du: invalid suffix in --threshold argument '1.5'\n" });
  await writeFile(join(dir, "du-threshold-small"), "12345");
  await writeFile(join(dir, "du-threshold-large"), "");
  await truncate(join(dir, "du-threshold-large"), 20480);
  expect(await run(["du", "-b", "-t", "10000", "du-threshold-small", "du-threshold-large"])).toMatchObject({ code: 0, stdout: "20480\tdu-threshold-large\n" });
  expect(await run(["du", "-b", "--threshold=bad", "du-threshold-small"])).toMatchObject({ code: 1, stderr: "du: invalid --threshold argument 'bad'\n" });
  expect(await run(["du", "--threshold=bad", "--help"])).toMatchObject(await systemRun(["du", "--threshold=bad", "--help"]));
  expect(await run(["du", "-b", "--threshold=1.5K", "du-threshold-small"])).toMatchObject({ code: 1, stderr: "du: invalid suffix in --threshold argument '1.5K'\n" });
  expect(await run(["du", "-b", "--threshold=1b", "du-threshold-small"])).toMatchObject({ code: 1, stdout: "", stderr: "du: invalid suffix in --threshold argument '1b'\n" });
  expect(await run(["du", "-b", "--threshold=0R", "du-threshold-small"])).toMatchObject({ code: 0, stdout: "5\tdu-threshold-small\n" });
  expect(await run(["du", "-b", "--threshold=1R", "du-threshold-small"])).toMatchObject({ code: 1, stdout: "", stderr: "du: --threshold argument '1R' too large\n" });
  expect(await run(["du", "-b", "--threshold=9223372036854775808", "du-threshold-small"])).toMatchObject({ code: 1, stdout: "", stderr: "du: --threshold argument '9223372036854775808' too large\n" });
  expect(await run(["du", "-b", "--threshold=-9223372036854775808", "du-threshold-small"])).toMatchObject({ code: 0, stdout: "5\tdu-threshold-small\n" });
  expect(await run(["du", "-b", "--threshold=-9223372036854775809", "du-threshold-small"])).toMatchObject({ code: 1, stdout: "", stderr: "du: --threshold argument '-9223372036854775809' too large\n" });
  await mkdir(join(dir, "inode-si"));
  for (let i = 0; i < 1100; i++) await writeFile(join(dir, "inode-si", `f${i}`), "");
  expect(await run(["du", "--inodes", "--si", "inode-si"])).toMatchObject({ code: 0, stdout: "1.2k\tinode-si\n" });
  expect(await run(["du", "-0", "-b", "tree/a.txt"])).toMatchObject({ code: 0, stdout: "3\ttree/a.txt\0" });
  await writeFile(join(dir, "du-list"), "tree/a.txt\0tree/a.txt\0missing\0");
  expect(await run(["du", "--files0-from=du-list", "tree/a.txt"])).toMatchObject({ code: 1, stderr: `du: extra operand ${diagnosticQuote("tree/a.txt")}\nfile operands cannot be combined with --files0-from\nTry 'du --help' for more information.\n` });
  expect(await run(["du", "--files0-from=du-list", "tree/a\nx"])).toMatchObject({ code: 1, stderr: `du: extra operand ${diagnosticQuote("tree/a\\nx")}\nfile operands cannot be combined with --files0-from\nTry 'du --help' for more information.\n` });
  expect(await run(["du", "-b", "--files0-from=du-list"])).toMatchObject({ code: 1, stdout: "3\ttree/a.txt\n", stderr: "du: cannot access 'missing': No such file or directory\n" });
  expect(await run(["du", "-b", "missing\nfile"])).toMatchObject({ code: 1, stdout: "", stderr: "du: cannot access 'missing'$'\\n''file': No such file or directory\n" });
  expect(await run(["du", "-b", "missing'file"])).toMatchObject({ code: 1, stdout: "", stderr: "du: cannot access \"missing'file\": No such file or directory\n" });
  const duFiles0Raw = Bun.spawn(["/bin/sh", "-c", `name=$(printf 'du-\\377'); printf 'raw\\n' > "$name"; printf '%s\\0' "$name" > du-files0-raw; LC_ALL=C ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} du -b --files0-from=du-files0-raw >du-files0-raw-out`], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await duFiles0Raw.exited).toBe(0);
  expect(await new Response(duFiles0Raw.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "du-files0-raw-out"))]).toEqual([0x34, 0x09, 0x64, 0x75, 0x2d, 0xff, 0x0a]);
  expect(await run(["du", "-b", "--files0-from=-"], "-")).toMatchObject({ code: 1, stderr: "du: when reading file names from standard input, no file name of '-' allowed\n" });
  await symlink("du-list-loop", join(dir, "du-list-loop"));
  expect(await run(["du", "--files0-from=du-list-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "du: cannot open 'du-list-loop' for reading: Too many levels of symbolic links\n" });
  await mkdir(join(dir, "du-list-dir"));
  expect(await run(["du", "--files0-from=du-list-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "du: du-list-dir: read error: Is a directory\n" });
  await mkdir(join(dir, "du list dir"));
  expect(await run(["du", "--files0-from=du list dir"])).toMatchObject({ code: 1, stdout: "", stderr: "du: 'du list dir': read error: Is a directory\n" });
  expect(await run(["du", "--exclude-from=missing-exclude", "tree"])).toMatchObject({ code: 1, stdout: "", stderr: "du: missing-exclude: No such file or directory\nTry 'du --help' for more information.\n" });
  expect(await run(["du", "--exclude-from=du-list-dir", "tree"])).toMatchObject({ code: 1, stdout: "", stderr: "du: du-list-dir: Is a directory\nTry 'du --help' for more information.\n" });
  const duExcludeReplacement = Bun.spawn(["/bin/sh", "-c", `dir=$(printf 'du-excl-\\377'); child=$(printf 'x-\\377'); mkdir "$dir"; printf data > "$dir/$child"; printf '%s\\0' "$dir" > du-excl-roots0; printf 'x-\\357\\277\\275\\n' > du-excl-replacement; LC_ALL=C ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} du -a -b --files0-from=du-excl-roots0 --exclude-from=du-excl-replacement >du-excl-replacement-out`], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await duExcludeReplacement.exited).toBe(0);
  expect(await new Response(duExcludeReplacement.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "du-excl-replacement-out"))]).toEqual([0x34, 0x09, 0x64, 0x75, 0x2d, 0x65, 0x78, 0x63, 0x6c, 0x2d, 0xff, 0x2f, 0x78, 0x2d, 0xff, 0x0a, 0x34, 0x09, 0x64, 0x75, 0x2d, 0x65, 0x78, 0x63, 0x6c, 0x2d, 0xff, 0x0a]);
  expect((await run(["du", "-ch", "tree/a.txt", "tree/sub/b.txt"])).stdout).toContain("total\n");
  expect((await run(["du", "-a", "-b", "tree"])).stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[1])).toEqual(["tree/sub/b.txt", "tree/sub", "tree/a.txt", "tree"]);
  expect((await run(["du", "-b", "--max-depth=1", "tree"])).stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[1])).toEqual(["tree/sub", "tree"]);
  expect((await run(["du", "-b", "--max=1", "tree"])).stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[1])).toEqual(["tree/sub", "tree"]);
  expect((await run(["du", "-b", "--exclude=sub", "tree"])).stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[1])).toEqual(["tree"]);
  await symlink("tree", join(dir, "du-tree-link"));
  expect(await run(["du", "-b", "-s", "du-tree-link"])).toMatchObject({ code: 0, stdout: "4\tdu-tree-link\n" });
  expect(await run(["du", "-b", "-s", "-D", "du-tree-link"])).toMatchObject({ code: 0, stdout: "8\tdu-tree-link\n" });
  expect(await run(["du", "-b", "-s", "--dereference-arg", "du-tree-link"])).toMatchObject({ code: 0, stdout: "8\tdu-tree-link\n" });
  expect(await run(["du", "-b", "-s", "-H", "du-tree-link"])).toMatchObject({ code: 0, stdout: "8\tdu-tree-link\n" });
  expect(await run(["du", "-b", "-s", "-L", "--no-dereference", "du-tree-link"])).toMatchObject({ code: 0, stdout: "4\tdu-tree-link\n" });
  expect(await run(["du", "-b", "-s", "--no-dereference", "-L", "du-tree-link"])).toMatchObject({ code: 0, stdout: "8\tdu-tree-link\n" });
  expect(await run(["du", "-b", "-s", "-D", "--no-dereference", "du-tree-link"])).toMatchObject({ code: 0, stdout: "4\tdu-tree-link\n" });
  expect(await run(["du", "-b", "-s", "-L", "-P", "du-tree-link"])).toMatchObject({ code: 0, stdout: "4\tdu-tree-link\n" });
  expect((await run(["du", "-D", "-b", "du-tree-link"])).stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[1])).toEqual(["du-tree-link/sub", "du-tree-link"]);
  expect((await run(["du", "-b", "--exclude=[ab].txt", "tree"])).stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[1])).toEqual(["tree/sub", "tree"]);
  await mkdir(join(dir, "du-inacc/sub"), { recursive: true });
  const readableSummary = await run(["du", "-s", "du-inacc"]);
  try {
    await chmod(join(dir, "du-inacc/sub"), 0);
    const unreadableSummary = await run(["du", "-s", "du-inacc"]);
    expect(unreadableSummary.code).toBe(1);
    expect(unreadableSummary.stdout).toBe(readableSummary.stdout);
  } finally {
    await chmod(join(dir, "du-inacc/sub"), 0o755).catch(() => {});
  }
  await symlink("/dev/shm", join(dir, "du-other-fs"));
  expect((await run(["du", "-xL", "du-other-fs"])).stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[1])).toEqual(["du-other-fs"]);
});

test("ls supports common listing modes", async () => {
  await mkdir(join(dir, "tree/sub"), { recursive: true });
  await writeFile(join(dir, "tree/.hidden"), "x");
  await writeFile(join(dir, "tree/small"), "x");
  await writeFile(join(dir, "tree/large"), "xxxx");
  await writeFile(join(dir, "tree/sub/nested"), "n");
  await run(["chmod", "u+x", "tree/small"]);
  const lsHelp = await run(["ls", "--help"]);
  expect(lsHelp.code).toBe(0);
  for (const option of ["-1", "-C", "-S", "-U", "-X", "-c", "-g", "-l", "-m", "-o", "-p", "-t", "-u", "-v", "-x"]) expect(lsHelp.stdout).toContain(`  ${option}\n`);
  expect((await run(["ls", "-a", "tree"])).stdout).toBe(".\n..\n.hidden\nlarge\nsmall\nsub\n");
  expect(new Set((await run(["ls", "-f", "tree"])).stdout.split("\n").filter(Boolean))).toEqual(new Set([".", "..", ".hidden", "large", "small", "sub"]));
  expect((await run(["ls", "-A", "tree"])).stdout).toBe(".hidden\nlarge\nsmall\nsub\n");
  expect((await run(["ls", "-1", "-I", "l*", "-I", "small", "tree"])).stdout).toBe("sub\n");
  expect((await run(["ls", "-F", "tree"])).stdout).toBe("large\nsmall*\nsub/\n");
  expect((await run(["ls", "--classify=always", "tree"])).stdout).toBe("large\nsmall*\nsub/\n");
  expect((await run(["ls", "--classify=yes", "tree"])).stdout).toBe("large\nsmall*\nsub/\n");
  expect((await run(["ls", "--classify=force", "tree"])).stdout).toBe("large\nsmall*\nsub/\n");
  expect((await run(["ls", "--classify=never", "tree"])).stdout).toBe("large\nsmall\nsub\n");
  expect((await run(["ls", "--classify=no", "tree"])).stdout).toBe("large\nsmall\nsub\n");
  expect((await run(["ls", "--classify=none", "tree"])).stdout).toBe("large\nsmall\nsub\n");
  expect((await run(["ls", "--classify=tty", "tree"])).stdout).toBe("large\nsmall\nsub\n");
  expect((await run(["ls", "--classify=if-tty", "tree"])).stdout).toBe("large\nsmall\nsub\n");
  expect((await run(["ls", "--indicator-style=file-type", "tree"])).stdout).toBe("large\nsmall\nsub/\n");
  expect(await run(["ls", "--classify=bad", "tree"])).toMatchObject(await systemRun(["ls", "--classify=bad", "tree"]));
  expect(await run(["ls", "--classify=bad", "--help"])).toMatchObject(await systemRun(["ls", "--classify=bad", "--help"]));
  expect(await run(["ls", "--color=", "tree"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `ls: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--color")}\nValid arguments are:\n  - ${diagnosticQuote("always")}, ${diagnosticQuote("yes")}, ${diagnosticQuote("force")}\n  - ${diagnosticQuote("never")}, ${diagnosticQuote("no")}, ${diagnosticQuote("none")}\n  - ${diagnosticQuote("auto")}, ${diagnosticQuote("tty")}, ${diagnosticQuote("if-tty")}\nTry 'ls --help' for more information.\n`,
  });
  expect(await run(["ls", "--indicator-style=", "tree"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `ls: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--indicator-style")}\nValid arguments are:\n  - ${diagnosticQuote("none")}\n  - ${diagnosticQuote("slash")}\n  - ${diagnosticQuote("file-type")}\n  - ${diagnosticQuote("classify")}\nTry 'ls --help' for more information.\n`,
  });
  expect(await run(["ls", "--indicator-style=bad", "tree"])).toMatchObject(await systemRun(["ls", "--indicator-style=bad", "tree"]));
  expect(await run(["ls", "--indicator-style=bad", "--help"])).toMatchObject(await systemRun(["ls", "--indicator-style=bad", "--help"]));
  expect(await run(["ls", "--format=bad", "tree"])).toMatchObject(await systemRun(["ls", "--format=bad", "tree"]));
  expect(await run(["ls", "--format=bad", "--help"])).toMatchObject(await systemRun(["ls", "--format=bad", "--help"]));
  expect((await run(["ls", "-1", "--hyperlink=always", "tree/small"])).stdout).toBe(`\x1b]8;;file://${osHostname()}${join(dir, "tree/small")}\x1b\\tree/small\x1b]8;;\x1b\\\n`);
  expect((await run(["ls", "-Z", "tree/small"])).stdout).toBe("? tree/small\n");
  expect((await run(["ls", "-Zi", "tree/small"])).stdout).toMatch(/^\d+ \? tree\/small\n$/);
  expect((await run(["ls", "-Zs", "tree/small"])).stdout).toBe("4 ? tree/small\n");
  expect((await run(["ls", "-lZ", "tree/small"])).stdout).toMatch(/^-rwxr--r--\s+1\s+\S+\s+\S+\s+\?\s+1\s+\S+\s+\d+\s+\d\d:\d\d tree\/small\n$/);
  const diredContext = (await run(["ls", "-lZ", "--dired", "tree/small"])).stdout;
  const diredContextMatch = diredContext.match(/\/\/DIRED\/\/ (\d+) (\d+)\n/);
  expect(diredContextMatch).not.toBeNull();
  expect(Buffer.from(diredContext).subarray(Number(diredContextMatch[1]), Number(diredContextMatch[2])).toString()).toBe("tree/small");
  expect(await run(["ls", "--hyperlink=bad", "tree"])).toMatchObject(await systemRun(["ls", "--hyperlink=bad", "tree"]));
  expect(await run(["ls", "--hyperlink=bad", "--help"])).toMatchObject(await systemRun(["ls", "--hyperlink=bad", "--help"]));
  expect(await run(["ls", "--hyper=bad", "tree"])).toMatchObject(await systemRun(["ls", "--hyper=bad", "tree"]));
  expect(await run(["ls", "--hy=bad", "--help"])).toMatchObject(await systemRun(["ls", "--hy=bad", "--help"]));
  expect(await run(["ls", "--hyperlink=", "tree"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `ls: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--hyperlink")}\nValid arguments are:\n  - ${diagnosticQuote("always")}, ${diagnosticQuote("yes")}, ${diagnosticQuote("force")}\n  - ${diagnosticQuote("never")}, ${diagnosticQuote("no")}, ${diagnosticQuote("none")}\n  - ${diagnosticQuote("auto")}, ${diagnosticQuote("tty")}, ${diagnosticQuote("if-tty")}\nTry 'ls --help' for more information.\n`,
  });
  expect(await run(["ls", "--color=bad", "tree"])).toMatchObject(await systemRun(["ls", "--color=bad", "tree"]));
  expect(await run(["ls", "--color=bad", "--help"])).toMatchObject(await systemRun(["ls", "--color=bad", "--help"]));
  expect(await run(["ls", "--sor=bad", "tree"])).toMatchObject(await systemRun(["ls", "--sor=bad", "tree"]));
  expect(await run(["ls", "--wid=bad", "tree"])).toMatchObject(await systemRun(["ls", "--wid=bad", "tree"]));
  expect(await run(["ls", "--block-size=bad", "--help"])).toMatchObject(await systemRun(["ls", "--block-size=bad", "--help"]));
  expect(await run(["ls", "--block-size", "bad", "--help"])).toMatchObject(await systemRun(["ls", "--block-size", "bad", "--help"]));
  expect(await run(["ls", "--width=bad", "--help"])).toMatchObject(await systemRun(["ls", "--width=bad", "--help"]));
  expect(await run(["ls", "--width", "bad", "--help"])).toMatchObject(await systemRun(["ls", "--width", "bad", "--help"]));
  expect(await run(["ls", "--tabsize=bad", "--help"])).toMatchObject(await systemRun(["ls", "--tabsize=bad", "--help"]));
  expect(await run(["ls", "--tabsize", "bad", "--help"])).toMatchObject(await systemRun(["ls", "--tabsize", "bad", "--help"]));
  expect(await run(["ls", "--time=bad", "--help"])).toMatchObject(await systemRun(["ls", "--time=bad", "--help"]));
  await mkdir(join(dir, "ls-loop-tree"));
  await symlink("loop", join(dir, "ls-loop-tree/loop"));
  const lsLongLoop = await run(["ls", "-lL", "ls-loop-tree"]);
  expect(lsLongLoop.code).toBe(1);
  expect(lsLongLoop.stderr).toContain("ls: cannot access 'ls-loop-tree/loop': Too many levels of symbolic links\n");
  expect(lsLongLoop.stdout).toContain("l?????????");
  expect(lsLongLoop.stdout).toMatch(/^l\?{9}\s+\?\s+\?\s+\?\s+\?\s+\?\s+loop$/m);
  expect((await run(["ls", "--file-type", "tree"])).stdout).toBe("large\nsmall\nsub/\n");
  await mkdir(join(dir, "quote"));
  await writeFile(join(dir, "quote/name with spaces"), "x");
  await writeFile(join(dir, "quote/name'with-quote"), "x");
  await writeFile(join(dir, "quote/line\nbreak"), "x");
  await writeFile(join(dir, "quote/q\x07"), "x");
  await writeFile(join(dir, "quote/plain"), "x");
  await mkdir(join(dir, "tty-quote"));
  await writeFile(join(dir, "tty-quote/line\n\nbreak"), "x");
  const ttyQuoted = await shell(`script -qefc '"$BUN" "$BNU" ls -1 tty-quote' /dev/null`);
  expect(ttyQuoted).toMatchObject({ code: 0, stderr: "" });
  expect(ttyQuoted.stdout.replaceAll("\r\n", "\n")).toBe("'line'$'\\n\\n''break'\n");
  expect((await run(["ls", "-1", "--quoting-style=shell", "quote/name with spaces", "quote/plain"])).stdout).toBe("'quote/name with spaces'\nquote/plain\n");
  expect((await run(["ls", "-1", "--quoting-style=shell", "quote/name'with-quote"])).stdout).toBe("\"quote/name'with-quote\"\n");
  expect((await run(["ls", "-1", "--quoting-style=shell-always", "quote/plain"])).stdout).toBe("'quote/plain'\n");
  expect((await run(["ls", "-1", "--quoting-style=shell-al", "-q", "quote/q\x07"])).stdout).toBe("'quote/q?'\n");
  expect((await run(["ls", "-1", "--quoting-style=shell-escape", "quote/line\nbreak"])).stdout).toBe("'quote/line'$'\\n''break'\n");
  expect((await run(["ls", "-1", "--quoting-style=shell-escape-always", "quote/plain"])).stdout).toBe("'quote/plain'\n");
  expect((await run(["ls", "-1", "--quoting-style=escape", "quote/name with spaces"])).stdout).toBe("quote/name\\ with\\ spaces\n");
  expect(await run(["ls", "--quoting-style=bad", "quote/plain"])).toMatchObject({
    code: 1,
    stderr: `ls: invalid argument ${diagnosticQuote("bad")} for ${diagnosticQuote("--quoting-style")}\nValid arguments are:\n  - ${diagnosticQuote("literal")}\n  - ${diagnosticQuote("shell")}\n  - ${diagnosticQuote("shell-always")}\n  - ${diagnosticQuote("shell-escape")}\n  - ${diagnosticQuote("shell-escape-always")}\n  - ${diagnosticQuote("c")}\n  - ${diagnosticQuote("c-maybe")}\n  - ${diagnosticQuote("escape")}\n  - ${diagnosticQuote("locale")}\n  - ${diagnosticQuote("clocale")}\nTry 'ls --help' for more information.\n`,
  });
  expect(await run(["ls", "--quoting-style=bad", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `ls: invalid argument ${diagnosticQuote("bad")} for ${diagnosticQuote("--quoting-style")}\nValid arguments are:\n  - ${diagnosticQuote("literal")}\n  - ${diagnosticQuote("shell")}\n  - ${diagnosticQuote("shell-always")}\n  - ${diagnosticQuote("shell-escape")}\n  - ${diagnosticQuote("shell-escape-always")}\n  - ${diagnosticQuote("c")}\n  - ${diagnosticQuote("c-maybe")}\n  - ${diagnosticQuote("escape")}\n  - ${diagnosticQuote("locale")}\n  - ${diagnosticQuote("clocale")}\nTry 'ls --help' for more information.\n`,
  });
  expect(await run(["ls", "--quoting-style=", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `ls: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--quoting-style")}\nValid arguments are:\n  - ${diagnosticQuote("literal")}\n  - ${diagnosticQuote("shell")}\n  - ${diagnosticQuote("shell-always")}\n  - ${diagnosticQuote("shell-escape")}\n  - ${diagnosticQuote("shell-escape-always")}\n  - ${diagnosticQuote("c")}\n  - ${diagnosticQuote("c-maybe")}\n  - ${diagnosticQuote("escape")}\n  - ${diagnosticQuote("locale")}\n  - ${diagnosticQuote("clocale")}\nTry 'ls --help' for more information.\n`,
  });
  expect(await run(["ls", "--quoting-style=bad\nmode", "quote/plain"])).toMatchObject({
    code: 1,
    stderr: `ls: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--quoting-style")}\nValid arguments are:\n  - ${diagnosticQuote("literal")}\n  - ${diagnosticQuote("shell")}\n  - ${diagnosticQuote("shell-always")}\n  - ${diagnosticQuote("shell-escape")}\n  - ${diagnosticQuote("shell-escape-always")}\n  - ${diagnosticQuote("c")}\n  - ${diagnosticQuote("c-maybe")}\n  - ${diagnosticQuote("escape")}\n  - ${diagnosticQuote("locale")}\n  - ${diagnosticQuote("clocale")}\nTry 'ls --help' for more information.\n`,
  });
  expect(await run(["ls", "--quoting-style=shell-e", "quote/plain"])).toMatchObject({
    code: 1,
    stderr: `ls: ambiguous argument ${diagnosticQuote("shell-e")} for ${diagnosticQuote("--quoting-style")}\nValid arguments are:\n  - ${diagnosticQuote("literal")}\n  - ${diagnosticQuote("shell")}\n  - ${diagnosticQuote("shell-always")}\n  - ${diagnosticQuote("shell-escape")}\n  - ${diagnosticQuote("shell-escape-always")}\n  - ${diagnosticQuote("c")}\n  - ${diagnosticQuote("c-maybe")}\n  - ${diagnosticQuote("escape")}\n  - ${diagnosticQuote("locale")}\n  - ${diagnosticQuote("clocale")}\nTry 'ls --help' for more information.\n`,
  });
  expect((await run(["ls", "-1", "--quoting-style=shell", "quote/q\x07"])).stdout).toBe("quote/q\x07\n");
  expect((await run(["ls", "-1", "-q", "--quoting-style=shell", "quote/q\x07"])).stdout).toBe("quote/q?\n");
  expect((await run(["ls", "-1", "--escape", "quote/q\x07"])).stdout).toBe("quote/q\\a\n");
  expect((await run(["ls", "-1", "-b", "quote/name with spaces"])).stdout).toBe("quote/name\\ with\\ spaces\n");
  expect((await run(["ls", "-1", "--hide-control-chars", "quote/q\x07"])).stdout).toBe("quote/q?\n");
  expect((await run(["ls", "-1", "--show-control-chars", "quote/q\x07"])).stdout).toBe("quote/q\x07\n");
  expect((await run(["ls", "-1", "--literal", "quote/q\x07"])).stdout).toBe("quote/q\x07\n");
  expect((await run(["ls", "-p", "tree"])).stdout).toBe("large\nsmall\nsub/\n");
  expect((await run(["ls", "-S", "tree"])).stdout).toBe("sub\nlarge\nsmall\n");
  expect((await run(["ls", "-Sr", "tree"])).stdout).toBe("small\nlarge\nsub\n");
  await mkdir(join(dir, "size-tie"));
  await writeFile(join(dir, "size-tie/b.txt"), "x");
  await writeFile(join(dir, "size-tie/a.log"), "x");
  await writeFile(join(dir, "size-tie/c"), "x");
  expect((await run(["ls", "-1S", "size-tie"])).stdout).toBe("a.log\nb.txt\nc\n");
  expect((await run(["ls", "-1Sr", "size-tie"])).stdout).toBe("c\nb.txt\na.log\n");
  expect((await run(["ls", "--group-directories-first", "tree"])).stdout).toBe("sub\nlarge\nsmall\n");
  expect((await run(["ls", "--sort=width", "tree"])).stdout).toBe("sub\nlarge\nsmall\n");
  expect(await run(["ls", "--sort=", "tree"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `ls: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--sort")}\nValid arguments are:\n  - ${diagnosticQuote("none")}\n  - ${diagnosticQuote("size")}\n  - ${diagnosticQuote("time")}\n  - ${diagnosticQuote("version")}\n  - ${diagnosticQuote("extension")}\n  - ${diagnosticQuote("name")}\n  - ${diagnosticQuote("width")}\nTry 'ls --help' for more information.\n`,
  });
  expect(await run(["ls", "--sort=bad", "tree"])).toMatchObject(await systemRun(["ls", "--sort=bad", "tree"]));
  expect(await run(["ls", "--sort", "bad", "--help"])).toMatchObject(await systemRun(["ls", "--sort", "bad", "--help"]));
  expect((await run(["ls", "-w2", "-m", "tree/large", "tree/small"])).stdout).toBe("tree/large,\ntree/small\n");
  expect((await run(["ls", "-sm", "tree/large", "tree/small"])).stdout).toContain(", ");
  await writeFile(join(dir, "ls-comma-a-empty"), "");
  await writeFile(join(dir, "ls-comma-z-big"), "x".repeat(2000));
  expect((await run(["ls", "-sm", "ls-comma-a-empty", "ls-comma-z-big"])).stdout).toMatch(/^0 ls-comma-a-empty, \d+ ls-comma-z-big\n$/);
  await mkdir(join(dir, "columns"));
  await writeFile(join(dir, "columns/a"), "x");
  await writeFile(join(dir, "columns/big"), "x");
  await writeFile(join(dir, "columns/link"), "x");
  await writeFile(join(dir, "columns/linktarget"), "x");
  expect((await run(["ls", "-C", "columns"])).stdout).toBe("a  big\tlink  linktarget\n");
  expect((await run(["ls", "-x", "columns"])).stdout).toBe("a  big\tlink  linktarget\n");
  expect((await run(["ls", "-C", "-w20", "columns"])).stdout).toBe("a    link\nbig  linktarget\n");
  expect((await run(["ls", "-x", "-w20", "columns"])).stdout).toBe("a     big\nlink  linktarget\n");
  expect((await run(["ls", "-C", "--tabsize=0", "columns"])).stdout).toBe("a  big  link  linktarget\n");
  expect((await run(["ls", "-C", "--tabsize=2", "columns"])).stdout).toBe("a  big\tlink\tlinktarget\n");
  expect(await run(["ls", "--width=bad"])).toMatchObject(await systemRun(["ls", "--width=bad"]));
  expect(await run(["ls", "-wbad", "--help"])).toMatchObject(await systemRun(["ls", "-wbad", "--help"]));
  expect(await run(["ls", "-w", "bad", "--help"])).toMatchObject(await systemRun(["ls", "-w", "bad", "--help"]));
  expect(await run(["ls", "--width=1\n2"])).toMatchObject({ code: 2, stdout: "", stderr: `ls: invalid line width: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["ls", "--tabsize=bad"])).toMatchObject(await systemRun(["ls", "--tabsize=bad"]));
  expect(await run(["ls", "-Tbad", "--help"])).toMatchObject(await systemRun(["ls", "-Tbad", "--help"]));
  expect(await run(["ls", "-T", "bad", "--help"])).toMatchObject(await systemRun(["ls", "-T", "bad", "--help"]));
  expect(await run(["ls", "--tabsize=1\n2"])).toMatchObject({ code: 2, stdout: "", stderr: `ls: invalid tab size: ${diagnosticQuote("1\\n2")}\n` });
  await mkdir(join(dir, "longopts"));
  await writeFile(join(dir, "longopts/decimal-size"), "");
  await truncate(join(dir, "longopts/decimal-size"), 1500);
  expect((await run(["ls", "-lh", "--si", "longopts/decimal-size"])).stdout).toContain("1.5k");
  expect((await run(["ls", "-lh", "--time-style=+:T:", "tree/small"])).stdout.trim().split(/\s+/)[4]).toBe("1");
  const smallStat = await lstat(join(dir, "tree/small"));
  const smallBlocks512 = smallStat.blocks ?? Math.ceil(smallStat.size / 512);
  const smallBlocks = Math.ceil(smallBlocks512 / 2);
  expect((await run(["ls", "-s", "tree/small"])).stdout.trim().split(/\s+/)[0]).toBe(String(smallBlocks));
  expect((await run(["ls", "-s", "--block-size=1", "tree/small"])).stdout.trim().split(/\s+/)[0]).toBe(String(smallBlocks512 * 512));
  expect((await run(["ls", "-s", "--block-size=human-readable", "tree/small"])).stdout.trim().split(/\s+/)[0]).toBe("4.0K");
  expect((await run(["ls", "-s", "--block-size=si", "tree/small"])).stdout.trim().split(/\s+/)[0]).toBe("4.1k");
  expect((await run(["ls", "-s", "tree/small"], "", { env: { BLOCK_SIZE: "1R" } })).stdout.trim().split(/\s+/)[0]).toBe(String(smallBlocks512 * 512));
  expect((await run(["ls", "-s", "tree/small"], "", { env: { LS_BLOCK_SIZE: "bad" } })).stdout.trim().split(/\s+/)[0]).toBe(String(smallBlocks));
  expect((await run(["ls", "-og", "longopts/decimal-size"], "", { env: { BLOCKSIZE: "512" } })).stdout.trim().split(/\s+/)[2]).toBe("1500");
  expect((await run(["ls", "-og", "longopts/decimal-size"], "", { env: { BLOCKSIZE: "human-readable" } })).stdout.trim().split(/\s+/)[2]).toBe("1500");
  expect((await run(["ls", "-s", "tree/small"], "", { env: { BLOCKSIZE: "si" } })).stdout.trim().split(/\s+/)[0]).toBe("4.1k");
  expect((await run(["ls", "-og", "longopts/decimal-size"], "", { env: { BLOCK_SIZE: "bad" } })).stdout.trim().split(/\s+/)[2]).toBe("2");
  expect((await run(["ls", "-og", "longopts/decimal-size"], "", { env: { LS_BLOCK_SIZE: "bad" } })).stdout.trim().split(/\s+/)[2]).toBe("2");
  expect(await run(["ls", "-s", "--block-size=1R", "tree/small"])).toMatchObject({ code: 2, stdout: "", stderr: "ls: invalid suffix in --block-size argument '1R'\n" });
  expect((await run(["ls", "-l", "--no-group", "longopts/decimal-size"])).stdout.trim().split(/\s+/).length).toBe(8);
  expect((await run(["ls", "-l", "longopts/decimal-size"], "", { env: { BLOCK_SIZE: "si" } })).stdout.trim().split(/\s+/)[4]).toBe("1.5k");
  const currentUserName = (await systemRun(["id", "-un"])).stdout.trim();
  const currentGroupName = (await systemRun(["id", "-gn"])).stdout.trim();
  const currentUid = String(process.getuid?.() ?? (await stat(join(dir, "longopts/decimal-size"))).uid);
  const currentGid = String(process.getgid?.() ?? (await stat(join(dir, "longopts/decimal-size"))).gid);
  const longNameFields = (await run(["ls", "-l", "longopts/decimal-size"])).stdout.trim().split(/\s+/);
  expect(longNameFields[2]).toBe(currentUserName);
  expect(longNameFields[3]).toBe(currentGroupName);
  expect((await run(["ls", "-l", "--time-style=+:T:", "longopts/decimal-size"])).stdout).toBe(`-rw-r--r-- 1 ${currentUserName} ${currentGroupName} 1500 :T: longopts/decimal-size\n`);
  const numericNameFields = (await run(["ls", "--numeric-uid-gid", "longopts/decimal-size"])).stdout.trim().split(/\s+/);
  expect(numericNameFields[0]).toBe("-rw-r--r--");
  expect(numericNameFields[2]).toBe(currentUid);
  expect(numericNameFields[3]).toBe(currentGid);
  expect((await run(["ls", "-l", "--author", "longopts/decimal-size"])).stdout.trim().split(/\s+/).length).toBe(10);
  expect(await run(["ls", "--kibibytes", "longopts/decimal-size"])).toMatchObject({ code: 0 });
  expect(await run(["ls", "-w-1"])).toMatchObject({ code: 2 });
  expect(await run(["ls", "-w08"])).toMatchObject({ code: 2 });
  expect(await run(["ls", "-T0x10", "-w010", "-x", "tree/large", "tree/small"])).toMatchObject({ code: 0 });
  expect((await run(["ls", "-w0", "-x", "-T1", "tree/large", "tree/small"])).stdout).toBe("tree/large  tree/small\n");
  expect((await run(["ls", "-w4", "-x", "-T0", "tree/large", "tree/small"])).stdout).toBe("tree/large\ntree/small\n");
  expect((await run(["ls", "--format=single-column", "tree/large", "tree/small"])).stdout).toBe("tree/large\ntree/small\n");
  expect((await run(["ls", "--format=commas", "tree/large", "tree/small"])).stdout).toBe("tree/large, tree/small\n");
  expect(await run(["ls", "--format=", "tree"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `ls: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--format")}\nValid arguments are:\n  - ${diagnosticQuote("verbose")}, ${diagnosticQuote("long")}\n  - ${diagnosticQuote("commas")}\n  - ${diagnosticQuote("horizontal")}, ${diagnosticQuote("across")}\n  - ${diagnosticQuote("vertical")}\n  - ${diagnosticQuote("single-column")}\nTry 'ls --help' for more information.\n`,
  });
  expect((await run(["ls", "-l", "-C", "tree/large", "tree/small"])).stdout).toBe("tree/large  tree/small\n");
  expect((await run(["ls", "-C", "--format=single-column", "tree/large", "tree/small"])).stdout).toBe("tree/large\ntree/small\n");
  await run(["touch", "-d", "2020-01-01T00:00:00Z", "tree/small"]);
  await run(["touch", "-d", "2020-01-02T00:00:00Z", "tree/large"]);
  expect((await run(["ls", "-t", "tree/small", "tree/large"])).stdout).toBe("tree/large\ntree/small\n");
  await mkdir(join(dir, "time-sort"));
  await writeFile(join(dir, "time-sort/a"), "x");
  await writeFile(join(dir, "time-sort/b"), "x");
  await writeFile(join(dir, "time-sort/c"), "x");
  await run(["touch", "-d", "2020-01-03T00:00:00Z", "time-sort/c", "time-sort/a", "time-sort/b"]);
  expect((await run(["ls", "-1t", "time-sort/a", "time-sort/b", "time-sort/c"])).stdout).toBe("time-sort/a\ntime-sort/b\ntime-sort/c\n");
  expect((await run(["ls", "-1rt", "time-sort/a", "time-sort/b", "time-sort/c"])).stdout).toBe("time-sort/c\ntime-sort/b\ntime-sort/a\n");
  await run(["touch", "-d", "2020-01-04T00:00:00Z", "time-sort/c"]);
  expect((await run(["ls", "-1t", "--sort=name", "time-sort/a", "time-sort/b", "time-sort/c"])).stdout).toBe("time-sort/a\ntime-sort/b\ntime-sort/c\n");
  expect((await run(["ls", "-1U", "--sort=name", "time-sort/c", "time-sort/a", "time-sort/b"])).stdout).toBe("time-sort/a\ntime-sort/b\ntime-sort/c\n");
  expect((await run(["ls", "--time=mtime", "time-sort/a", "time-sort/b", "time-sort/c"])).stdout).toBe("time-sort/c\ntime-sort/a\ntime-sort/b\n");
  expect(await run(["ls", "--time=", "time-sort/a"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `ls: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--time")}\nValid arguments are:\n  - ${diagnosticQuote("atime")}, ${diagnosticQuote("access")}, ${diagnosticQuote("use")}\n  - ${diagnosticQuote("ctime")}, ${diagnosticQuote("status")}\n  - ${diagnosticQuote("mtime")}, ${diagnosticQuote("modification")}\n  - ${diagnosticQuote("birth")}, ${diagnosticQuote("creation")}\nTry 'ls --help' for more information.\n`,
  });
  expect(await run(["ls", "--time=bad", "time-sort/a"])).toMatchObject({
    code: 1,
    stderr: `ls: invalid argument ${diagnosticQuote("bad")} for ${diagnosticQuote("--time")}\nValid arguments are:\n  - ${diagnosticQuote("atime")}, ${diagnosticQuote("access")}, ${diagnosticQuote("use")}\n  - ${diagnosticQuote("ctime")}, ${diagnosticQuote("status")}\n  - ${diagnosticQuote("mtime")}, ${diagnosticQuote("modification")}\n  - ${diagnosticQuote("birth")}, ${diagnosticQuote("creation")}\nTry 'ls --help' for more information.\n`,
  });
  await run(["touch", "-m", "-d", "1998-01-15T23:00:00Z", "time-sort/a"]);
  await run(["touch", "-a", "-d", "1998-01-14T11:00:00Z", "time-sort/a"]);
  expect((await run(["ls", "--full", "-l", "--time=mtime", "time-sort/a"], "", { env: { TZ: "UTC0" } })).stdout).toContain("1998-01-15 23:00:00.000000000 +0000 time-sort/a\n");
  expect((await run(["ls", "--full-time", "--time=mtime", "time-sort/a"], "", { env: { TZ: "UTC0" } })).stdout).toContain("1998-01-15 23:00:00.000000000 +0000 time-sort/a\n");
  expect((await run(["ls", "--full-time", "-lu", "time-sort/a"], "", { env: { TZ: "UTC0" } })).stdout).toContain("1998-01-14 11:00:00.000000000 +0000 time-sort/a\n");
  await systemRun(["/usr/bin/touch", "-d", "2026-01-02 03:04:05.123456789 +0000", "time-sort/ns-new"]);
  await systemRun(["/usr/bin/touch", "-d", "2026-01-02 03:04:05.123456788 +0000", "time-sort/ns-old"]);
  expect((await run(["ls", "--full-time", "time-sort/ns-new"], "", { env: { TZ: "UTC0" } })).stdout).toContain("2026-01-02 03:04:05.123456789 +0000 time-sort/ns-new\n");
  expect((await run(["ls", "-1t", "time-sort/ns-old", "time-sort/ns-new"])).stdout).toBe("time-sort/ns-new\ntime-sort/ns-old\n");
  await writeFile(join(dir, "time-sort/recent"), "x");
  expect((await run(["ls", "-l", "time-sort/recent"], "", { env: { TZ: "UTC0" } })).stdout).toMatch(/[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2} time-sort\/recent\n$/);
  await writeFile(join(dir, "tree/alpha.c"), "x");
  await writeFile(join(dir, "tree/beta.txt"), "x");
  await writeFile(join(dir, "tree/gamma.h"), "x");
  expect((await run(["ls", "-1X", "tree"])).stdout).toBe("large\nsmall\nsub\nalpha.c\ngamma.h\nbeta.txt\n");
  expect((await run(["ls", "-1Xr", "tree"])).stdout).toBe("beta.txt\ngamma.h\nalpha.c\nsub\nsmall\nlarge\n");
  expect((await run(["ls", "-1", "-I", "small", "--ignore=*.txt", "tree"])).stdout).toBe("alpha.c\ngamma.h\nlarge\nsub\n");
  expect((await run(["ls", "-1", "--hide=*.txt", "tree"])).stdout).toBe("alpha.c\ngamma.h\nlarge\nsmall\nsub\n");
  expect((await run(["ls", "-1A", "--hide=*.txt", "tree"])).stdout).toBe(".hidden\nalpha.c\nbeta.txt\ngamma.h\nlarge\nsmall\nsub\n");
  await mkdir(join(dir, "backups"));
  await writeFile(join(dir, "backups/keep"), "x");
  await writeFile(join(dir, "backups/old~"), "x");
  await writeFile(join(dir, "backups/~"), "x");
  expect((await run(["ls", "-1", "--ignore-backups", "backups"])).stdout).toBe("keep\n");
  expect((await run(["ls", "-1B", "backups"])).stdout).toBe("keep\n");
  expect((await run(["ls", "-1", "--sort=none", "tree"])).stdout).toContain("alpha.c\nbeta.txt\ngamma.h\n");
  await run(["ln", "tree/small", "tree/small-hard"]);
  const inodeLines = (await run(["ls", "-i", "tree/small", "tree/small-hard"])).stdout.trim().split(/\n|  /).filter(Boolean);
  expect(inodeLines.map((line) => line.split(/\s+/)[0])).toEqual([(await lstat(join(dir, "tree/small"))).ino.toString(), (await lstat(join(dir, "tree/small-hard"))).ino.toString()]);
  await writeFile(join(dir, "tree/hard-one"), "x");
  await link(join(dir, "tree/hard-one"), join(dir, "tree/hard-two.png"));
  expect((await run(["ls", "-U1", "--color=always", "tree/hard-one", "tree/hard-two.png"], "", { env: { LS_COLORS: "mh=44;37:*.png=01;35" } })).stdout).toBe("\x1b[0m\x1b[44;37mtree/hard-one\x1b[0m\n\x1b[44;37mtree/hard-two.png\x1b[0m\n");
  await run(["chmod", "a+x", "tree/hard-two.png"]);
  expect((await run(["ls", "-U1", "--color=always", "tree/hard-one", "tree/hard-two.png"], "", { env: { LS_COLORS: "mh=44;37:*.png=01;35:ex=01;32" } })).stdout).toBe("\x1b[0m\x1b[01;32mtree/hard-one\x1b[0m\n\x1b[01;32mtree/hard-two.png\x1b[0m\n");
  await run(["chmod", "a-x", "tree/hard-two.png"]);
  expect((await run(["ls", "-U1", "--color=always", "tree/hard-one", "tree/hard-two.png"], "", { env: { LS_COLORS: "mh=00:*.png=01;35" } })).stdout).toBe("tree/hard-one\n\x1b[0m\x1b[01;35mtree/hard-two.png\x1b[0m\n");
  await writeFile(join(dir, "tree/img1.jpg"), "x");
  await writeFile(join(dir, "tree/IMG2.JPG"), "x");
  await writeFile(join(dir, "tree/img3.JpG"), "x");
  await writeFile(join(dir, "tree/colon.foo"), "x");
  await writeFile(join(dir, "tree/semicolon.foo"), "x");
  await writeFile(join(dir, "tree/reset-color"), "x");
  expect((await run(["ls", "-U1", "--color=always", "tree/img1.jpg", "tree/IMG2.JPG", "tree/img3.JpG"], "", { env: { LS_COLORS: "*.jpg=01;35:*.JPG=01;35" } })).stdout).toBe("\x1b[0m\x1b[01;35mtree/img1.jpg\x1b[0m\n\x1b[01;35mtree/IMG2.JPG\x1b[0m\n\x1b[01;35mtree/img3.JpG\x1b[0m\n");
  expect((await run(["ls", "-U1", "--color=always", "tree/img1.jpg", "tree/IMG2.JPG", "tree/img3.JpG"], "", { env: { LS_COLORS: "*.jpg=01;35:*.JPG=01;35;46" } })).stdout).toBe("\x1b[0m\x1b[01;35mtree/img1.jpg\x1b[0m\n\x1b[01;35;46mtree/IMG2.JPG\x1b[0m\ntree/img3.JpG\n");
  expect((await run(["ls", "-U1", "--color=always", "tree/colon.foo"], "", { env: { LS_COLORS: "*.foo=01\\:31" } })).stdout).toBe("\x1b[0m\x1b[01:31mtree/colon.foo\x1b[0m\n");
  expect((await run(["ls", "-U1", "--color=always", "tree/semicolon.foo"], "", { env: { LS_COLORS: "*.foo=01\\;31" } })).stdout).toBe("\x1b[0m\x1b[01;31mtree/semicolon.foo\x1b[0m\n");
  expect((await run(["ls", "-U1", "--color=always", "tree/reset-color"], "", { env: { LS_COLORS: "fi=32:rs=31" } })).stdout).toBe("\x1b[31m\x1b[32mtree/reset-color\x1b[31m\n");
  await writeFile(join(dir, "tree/backup~"), "x");
  await writeFile(join(dir, "tree/hash#"), "x");
  expect((await run(["ls", "-U1", "--color=always", "tree/backup~", "tree/hash#"], "", { env: { LS_COLORS: "*~=00;90:*#=00;90" } })).stdout).toBe("\x1b[0m\x1b[00;90mtree/backup~\x1b[0m\n\x1b[00;90mtree/hash#\x1b[0m\n");
  await symlink("small", join(dir, "tree/small-link"));
  const linkInodes = (await run(["ls", "-Ci", "tree/small", "tree/small-link"])).stdout.trim().split(/\s+/);
  expect(linkInodes[0]).not.toBe(linkInodes[2]);
  const derefInodes = (await run(["ls", "-CLi", "tree/small", "tree/small-link"])).stdout.trim().split(/\s+/);
  expect(derefInodes[0]).toBe(derefInodes[2]);
  const commandLineDerefInodes = (await run(["ls", "-CHi", "tree/small", "tree/small-link"])).stdout.trim().split(/\s+/);
  expect(commandLineDerefInodes[0]).toBe(commandLineDerefInodes[2]);
  const directoryAllDerefInodes = (await run(["ls", "-CLi", "tree"])).stdout.trim().split(/\s+/);
  expect(directoryAllDerefInodes[directoryAllDerefInodes.indexOf("small") - 1]).toBe(directoryAllDerefInodes[directoryAllDerefInodes.indexOf("small-link") - 1]);
  const directoryDerefInodes = (await run(["ls", "-CHi", "tree"])).stdout.trim().split(/\s+/);
  expect(directoryDerefInodes[directoryDerefInodes.indexOf("small") - 1]).not.toBe(directoryDerefInodes[directoryDerefInodes.indexOf("small-link") - 1]);
  await symlink("sub", join(dir, "tree/sub-link"));
  expect((await run(["ls", "-FL", "tree/sub-link"])).stdout).toBe("nested\n");
  expect((await run(["ls", "tree/sub-link"])).stdout).toBe("nested\n");
  expect((await run(["ls", "-F", "tree/sub-link"])).stdout).toBe("tree/sub-link@\n");
  expect((await run(["ls", "-dF", "tree/sub-link"])).stdout).toBe("tree/sub-link@\n");
  await symlink("missing", join(dir, "tree/dangling"));
  expect(await run(["ls", "-L", "tree/dangling"])).toMatchObject({ code: 2 });
  const derefTree = await run(["ls", "-L", "tree"]);
  expect(derefTree).toMatchObject({ code: 1, stderr: "ls: cannot access 'tree/dangling': No such file or directory\n" });
  expect(derefTree.stdout).toContain("dangling\n");
  const implicitDanglingInode = await run(["ls", "-Li", "tree"]);
  expect(implicitDanglingInode).toMatchObject({ code: 1 });
  expect(implicitDanglingInode.stdout).toContain("? dangling\n");
  await symlink("loop", join(dir, "tree/loop"));
  expect(await run(["ls", "-L", "tree/loop"])).toMatchObject({ code: 2 });
  const implicitLoop = await run(["ls", "-L", "tree"]);
  expect(implicitLoop.stdout).toContain("loop\n");
  expect(implicitLoop.stderr).not.toContain("tree/loop");
  await mkdir(join(dir, "tree/cycle"));
  await symlink("../cycle", join(dir, "tree/cycle/sub"));
  const recursiveCycle = await run(["ls", "-RL", "tree/cycle"]);
  expect(recursiveCycle).toMatchObject({ code: 2, stdout: "tree/cycle:\nsub\n" });
  expect(recursiveCycle.stderr).toBe("ls: tree/cycle/sub: not listing already-listed directory\n");
  expect((await run(["ls", "-s", "tree/small"])).stdout.trim()).toMatch(/^\d+ tree\/small$/);
  expect((await run(["ls", "-lsh", "tree/small"])).stdout.trim()).toContain("tree/small");
  await writeFile(join(dir, "tree/block-1024"), "");
  await truncate(join(dir, "tree/block-1024"), 1024);
  expect((await run(["ls", "-og", "tree/block-1024"])).stdout.trim().split(/\s+/)[2]).toBe("1024");
  expect((await run(["ls", "-og", "--block-size=512", "tree/block-1024"])).stdout.trim().split(/\s+/)[2]).toBe("2");
  const block1024Stat = await lstat(join(dir, "tree/block-1024"));
  const block1024Blocks512 = block1024Stat.blocks ?? Math.ceil(block1024Stat.size / 512);
  expect((await run(["ls", "-s", "--block-size=512", "tree/block-1024"])).stdout.trim()).toBe(`${block1024Blocks512} tree/block-1024`);
  await mkdir(join(dir, "size-align"));
  await writeFile(join(dir, "size-align/small"), "");
  await writeFile(join(dir, "size-align/alloc"), "\n");
  await writeFile(join(dir, "size-align/large"), "");
  await truncate(join(dir, "size-align/large"), 123456);
  const alignedSizeLines = (await run(["ls", "-s", "-l", "small", "alloc", "large"], "", { cwd: join(dir, "size-align") })).stdout.trimEnd().split("\n");
  expect(new Set(alignedSizeLines.map((line) => line.length)).size).toBe(1);
  expect(await run(["ls", "--time=birth", "-l", "tree/small"])).toMatchObject({ code: 0 });
  expect(await run(["ls", "--time=creation", "-t", "tree/small"])).toMatchObject({ code: 0 });
  const badTimeStyle = await run(["ls", "-l", "--time-style=XX", "tree"]);
  expect(badTimeStyle).toMatchObject({ code: 2, stdout: "" });
  expect(badTimeStyle).toMatchObject(await systemRun(["ls", "-l", "--time-style=XX", "tree"]));
  expect(await run(["ls", "--time-style=XX", "tree/small"])).toMatchObject(await systemRun(["ls", "--time-style=XX", "tree/small"]));
  expect(await run(["ls", "--format=single-column", "--time-style=XX", "tree/small"])).toMatchObject(await systemRun(["ls", "--format=single-column", "--time-style=XX", "tree/small"]));
  expect(await run(["ls", "-l", "--time-style=bad\nstyle", "tree/small"])).toMatchObject({
    code: 2,
    stdout: "",
    stderr: `ls: invalid argument ${diagnosticQuote("bad\\nstyle")} for ${diagnosticQuote("time style")}\nValid arguments are:\n  - [posix-]full-iso\n  - [posix-]long-iso\n  - [posix-]iso\n  - [posix-]locale\n  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\nTry 'ls --help' for more information.\n`,
  });
  await mkdir(join(dir, "tree/empty"));
  expect((await run(["ls", "-aA", "tree/empty"])).stdout).toBe("");
  expect((await run(["ls", "-Aa", "tree/empty"])).stdout).toBe(".\n..\n");
  expect((await run(["ls", "--zero", "-x", "-m", "-C", "-Q", "-q", "tree/empty"])).stdout).toBe("");
  await writeFile(join(dir, "tree/zero-a"), "x");
  await writeFile(join(dir, "tree/zero-b"), "x");
  expect((await run(["ls", "--zero", "-x", "-m", "-C", "-Q", "-q", "tree/zero-a", "tree/zero-b"])).stdout).toBe("tree/zero-a\0tree/zero-b\0");
  expect(await run(["ls", "--dired", "--zero", "tree"])).toMatchObject({ code: 2 });
  expect(await run(["ls", "-D", "--zero", "tree"])).toMatchObject({ code: 2 });
  await mkdir(join(dir, "tree/dired-empty"));
  expect((await run(["ls", "-R", "-D", "tree/dired-empty"])).stdout).toBe("  tree/dired-empty:\n  total 0\n//SUBDIRED// 2 18\n//DIRED-OPTIONS// --quoting-style=literal\n");
  await writeFile(join(dir, "tree/dired-a"), "x");
  await writeFile(join(dir, "tree/dired-b"), "x");
  const shortDired = await run(["ls", "-D", "tree/dired-a"]);
  expect(shortDired.stdout).toContain("-rw-r--r--");
  expect(shortDired.stdout).toContain("//DIRED//");
  expect((await run(["dir", "-D", "tree/dired-a"])).stdout).toContain("//DIRED-OPTIONS// --quoting-style=escape\n");
  expect((await run(["vdir", "-D", "tree/dired-a"])).stdout).toContain("//DIRED-OPTIONS// --quoting-style=escape\n");
  const dired = await run(["ls", "-l", "--dired", "tree/dired-a", "tree/dired-b"]);
  expect(dired.stdout).toContain("//DIRED//");
  const [start, end] = dired.stdout.match(/\/\/DIRED\/\/ (\d+) (\d+)/).slice(1).map(Number);
  expect(Buffer.from(dired.stdout).subarray(start, end).toString()).toBe("tree/dired-a");
  await writeFile(join(dir, "tree/control-\x07"), "x");
  expect((await run(["ls", "-q", "tree/control-\x07"])).stdout).toBe("tree/control-?\n");
  expect((await run(["ls", "-Q", "tree/control-\x07"])).stdout).toBe("\"tree/control-\\a\"\n");
  expect((await run(["ls", "--quoting=escape", "tree/control-\x07"])).stdout).toBe("tree/control-\\a\n");
  expect((await run(["ls", "--quoting=shell-escape", "tree/control-\x07"])).stdout).toBe("'tree/control-'$'\\a'\n");
  expect((await run(["ls", "-N", "tree/control-\x07"])).stdout).toBe("tree/control-\x07\n");
  await writeFile(join(dir, "tree/hello world"), "x");
  expect((await run(["ls", "--hyper", "tree/hello world"])).stdout).toBe(`\x1b]8;;file://${osHostname()}${dir}/tree/hello%20world\x1b\\tree/hello world\x1b]8;;\x1b\\\n`);
  const rawHyperlink = Bun.spawn(["/bin/sh", "-c", `mkdir ls-hyper-raw; name=$(printf 'invalidutf8\\351'); : > "ls-hyper-raw/$name"; LC_ALL=C ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} ls --hyper ls-hyper-raw >ls-hyper-raw-out`], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await rawHyperlink.exited).toBe(0);
  expect(await new Response(rawHyperlink.stderr).text()).toBe("");
  const rawHyperlinkOut = await readFile(join(dir, "ls-hyper-raw-out"));
  expect(rawHyperlinkOut.includes(Buffer.from("invalidutf8%e9\x1b\\invalidutf8"))).toBe(true);
  expect(rawHyperlinkOut.includes(Buffer.from([0xe9, 0x1b, 0x5d, 0x38, 0x3b, 0x3b, 0x1b, 0x5c, 0x0a]))).toBe(true);
  const rawCommandLine = Bun.spawn(["/bin/sh", "-c", `name=$(printf 'ls-command-line-\\351'); : > "$name"; LC_ALL=en_US.iso88591 ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} ls -1 "$name" >ls-command-line-raw-out`], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await rawCommandLine.exited).toBe(0);
  expect(await new Response(rawCommandLine.stderr).text()).toBe("");
  expect(await readFile(join(dir, "ls-command-line-raw-out"))).toEqual(Buffer.concat([Buffer.from("ls-command-line-"), Buffer.from([0xe9, 0x0a])]));
  expect((await run(["ls", "--quoting-style=locale", "tree/hello world"], "", { env: { LC_ALL: "C" } })).stdout).toBe("'tree/hello world'\n");
  expect((await run(["ls", "--quoting-style=clocale", "tree/hello world"], "", { env: { LC_ALL: "C" } })).stdout).toBe("\"tree/hello world\"\n");
  expect((await run(["ls", "--quoting-style=locale", "tree/hello world"], "", { env: { LC_ALL: "en_US.UTF-8" } })).stdout).toBe("‘tree/hello world’\n");
  await mkdir(join(dir, "dir:name"));
  await writeFile(join(dir, "dir:name/a b"), "x");
  await writeFile(join(dir, "dir:name/c.foo"), "x");
  const quotedColored = await run(["ls", "-R", "--quoting=shell-escape", "--color=always", "dir:name"], "", { env: { TERM: "xterm", LS_COLORS: "*.foo=0;31;42", TIME_STYLE: "+T" } });
  expect(quotedColored.stdout).toContain("'dir:name':\n");
  expect(quotedColored.stdout).toContain("'a b'");
  expect(quotedColored.stdout).toContain("\x1b[0;31;42mc.foo\x1b[0m");
  const recursive = await run(["ls", "-R", "tree"]);
  expect(recursive.stdout).toContain("tree:\n");
  expect(recursive.stdout).toContain("tree/sub:\n");
  const dotRecursive = await run(["ls", "-R", "."], "", { cwd: join(dir, "tree") });
  expect(dotRecursive.stdout).toContain("./sub:\n");
  await mkdir(join(dir, "rec-x"));
  await mkdir(join(dir, "rec-y"));
  await writeFile(join(dir, "rec-file"), "");
  expect((await run(["ls", "-R1", "rec-x", "rec-y", "rec-file"])).stdout).toBe("rec-file\n\nrec-x:\n\nrec-y:\n");
  expect((await run(["ls", "--color=always", "-F", "tree"])).stdout).toContain("\x1b[01;34msub\x1b[0m/");
  expect((await run(["ls", "--color=auto", "-F", "tree"], "", { env: { TERM: "xterm" } })).stdout).not.toContain("\x1b[");
  expect((await run(["ls", "--color=always", "tree/small"], "", { env: { TERM: "dumb", COLORTERM: "" } })).stdout).toBe("tree/small\n");
  expect((await run(["ls", "--color=always", "tree/small"], "", { env: { TERM: "", COLORTERM: "nonempty" } })).stdout).toContain("\x1b[0m\x1b[01;32mtree/small\x1b[0m");
  expect((await run(["ls", "--color=always", "tree/small"], "", { env: { TERM: "", COLORTERM: "" } })).stdout).toBe("tree/small\n");
  expect((await run(["ls", "--color", "tree/small"], "", { env: { TERM: "xterm" } })).stdout).toContain("\x1b[0m\x1b[01;32mtree/small\x1b[0m");
  expect((await run(["ls", "--color=always", "-F", "tree/sub-link"], "", { env: { TERM: "", COLORTERM: "", LS_COLORS: "ln=01;36:di=01;34:or=40;31;01" } })).stdout).toBe("tree/sub-link@\n");
  expect((await run(["ls", "--color=always", "tree/dangling"], "", { env: { LS_COLORS: "or=36:mi=35" } })).stdout).toBe("\x1b[0m\x1b[36mtree/dangling\x1b[0m\n");
  expect((await run(["ls", "--color=always", "-o", "--time-style=+:TIME:", "tree/dangling"], "", { env: { LS_COLORS: "ln=34:mi=35:or=36" } })).stdout).toContain("\x1b[0m\x1b[36mtree/dangling\x1b[0m -> \x1b[35mmissing\x1b[0m\n");
  await mkdir(join(dir, "tree/world"));
  await run(["chmod", "777", "tree/world"]);
  expect((await run(["ls", "-d", "--color=always", "tree/world"], "", { env: { LS_COLORS: "ow=34;42:tw=30;42:di=01;34" } })).stdout).toContain("\x1b[0m\x1b[34;42mtree/world\x1b[0m");
  await mkdir(join(dir, "tree/sticky"));
  await run(["chmod", "1755", "tree/sticky"]);
  expect((await run(["ls", "-dU1", "--color=always", "tree/sub", "tree/world", "tree/large", "tree/sticky"], "", { env: { TERM: "xterm", LS_COLORS: "" } })).stdout).toBe("\x1b[0m\x1b[01;34mtree/sub\x1b[0m\n\x1b[34;42mtree/world\x1b[0m\ntree/large\n\x1b[37;44mtree/sticky\x1b[0m\n");
  expect((await run(["ls", "-d", "--color=always", "tree/world"], "", { env: { TERM: "xterm", LS_COLORS: "ow=:" } })).stdout).toBe("\x1b[0m\x1b[01;34mtree/world\x1b[0m\n");
  expect((await run(["ls", "-og", "--color=always", "--time-style=+:TIME:", "tree/img1.jpg"], "", { env: { TERM: "xterm", LS_COLORS: "*.jpg=0;31;42" } })).stdout).toContain(":TIME: \x1b[0m\x1b[0;31;42mtree/img1.jpg\x1b[0m\n");
  await writeFile(join(dir, "ver-a"), "");
  await writeFile(join(dir, "ver-a2"), "");
  await writeFile(join(dir, "ver-a10"), "");
  expect((await run(["ls", "-v", "ver-a10", "ver-a2", "ver-a"])).stdout).toBe("ver-a\nver-a2\nver-a10\n");
  await writeFile(join(dir, "zz~"), "");
  await writeFile(join(dir, "zz"), "");
  await writeFile(join(dir, "zz.~1~"), "");
  await writeFile(join(dir, "zz.0"), "");
  expect((await run(["ls", "-v", "zz.0", "zz.~1~", "zz", "zz~"])).stdout).toBe("zz~\nzz\nzz.~1~\nzz.0\n");
  const missingLs = await run(["ls", "tree", "tree/no-such"]);
  expect(missingLs).toMatchObject({ code: 2 });
  expect(missingLs.stdout).toContain("tree:");
  expect(missingLs.stderr).toContain("ls: cannot access 'tree/no-such': No such file or directory\n");
  expect(await run(["mkfifo", "tree/fifo"])).toMatchObject({ code: 0 });
  expect((await run(["ls", "-dgo", "tree/fifo"])).stdout.slice(0, 10)).toBe("prw-r--r--");
  expect((await run(["ls", "-dgo", "tree/sub"])).stdout.slice(0, 10)).toBe("drwxr-xr-x");
  expect((await run(["ls", "-d", "tree/missing"])).code).toBe(2);
});

test("join, split, tr and nl handle common text workflows", async () => {
  expect(await run(["join"])).toMatchObject({ code: 1, stderr: "join: missing operand\nTry 'join --help' for more information.\n" });
  expect(await run(["join", "left"])).toMatchObject({ code: 1, stderr: "join: missing operand after 'left'\nTry 'join --help' for more information.\n" });
  expect(await run(["join", "left", "right", "extra"])).toMatchObject({ code: 1, stderr: "join: extra operand 'extra'\nTry 'join --help' for more information.\n" });
  expect(await run(["join", "left", "right", "extra\narg"])).toMatchObject({ code: 1, stderr: "join: extra operand 'extra'$'\\n''arg'\nTry 'join --help' for more information.\n" });
  await writeFile(join(dir, "left"), "1 alpha\n2 beta\n");
  await writeFile(join(dir, "right"), "1 red\n2 blue\n");
  await writeFile(join(dir, "join-header-left"), "id name\n1 one\n2 two\n");
  await writeFile(join(dir, "join-header-right"), "id age\n1 10\n3 30\n");
  expect(await run(["join", "left", "right"])).toMatchObject({ code: 0, stdout: "1 alpha red\n2 beta blue\n" });
  const joinStdinBytes = Uint8Array.of(0x78, 0xa0, 0x79, 0x0a);
  expect(await run(["join", "-a2", "-o2.1", "/dev/null", "-"], joinStdinBytes, { env: { LC_ALL: "fr_FR.iso88591" } }))
    .toMatchObject(await systemRun(["/usr/bin/join", "-a2", "-o2.1", "/dev/null", "-"], joinStdinBytes, { env: { LC_ALL: "fr_FR.iso88591" } }));
  expect(await run(["join", "--header", "-o", "auto", "join-header-left", "join-header-right"])).toMatchObject(await systemRun(["join", "--header", "-o", "auto", "join-header-left", "join-header-right"]));
  expect(await run(["join", "left", "right", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: join [OPTION]... FILE1 FILE2\n"), stderr: "" });
  expect(await run(["join", "-j", "+1", "left", "right"])).toMatchObject({ code: 0, stdout: "1 alpha red\n2 beta blue\n" });
  expect(await run(["join", "-1", "+1", "-2", "+1", "left", "right"])).toMatchObject({ code: 0, stdout: "1 alpha red\n2 beta blue\n" });
  expect(await run(["join", "-1", "0", "left", "right"])).toMatchObject(await systemRun(["join", "-1", "0", "left", "right"]));
  expect(await run(["join", "-2", "0", "left", "right"])).toMatchObject(await systemRun(["join", "-2", "0", "left", "right"]));
  expect(await run(["join", "-j", "0", "left", "right"])).toMatchObject(await systemRun(["join", "-j", "0", "left", "right"]));
  expect(await run(["join", "-1", "bad", "--help"])).toMatchObject(await systemRun(["join", "-1", "bad", "--help"]));
  expect(await run(["join", "-jbad", "--help"])).toMatchObject(await systemRun(["join", "-jbad", "--help"]));
  expect(await run(["join", "-a3", "--help"])).toMatchObject(await systemRun(["join", "-a3", "--help"]));
  expect(await run(["join", "-v", "3", "--help"])).toMatchObject(await systemRun(["join", "-v", "3", "--help"]));
  expect(await run(["join", "-o", "1.0", "--help"])).toMatchObject(await systemRun(["join", "-o", "1.0", "--help"]));
  expect(await run(["join", "-t", "xx", "--help"])).toMatchObject(await systemRun(["join", "-t", "xx", "--help"]));
  expect(await run(["join", "-11", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: join [OPTION]... FILE1 FILE2\n") });
  expect(await run(["join", "-o", "1.1", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: join [OPTION]... FILE1 FILE2\n") });
  expect(await run(["join", "-1", "1\n2", "left", "right"])).toMatchObject({ code: 1, stdout: "", stderr: `join: invalid field number: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["join", "-a", "1\n2", "left", "right"])).toMatchObject({ code: 1, stdout: "", stderr: `join: invalid file number: ${diagnosticQuote("1\\n2")}\n` });
  await writeFile(join(dir, "join-dup-left"), "a L1\na L2\nc LC\n");
  await writeFile(join(dir, "join-dup-right"), "a R1\na R2\nb RB\n");
  expect(await run(["join", "join-dup-left", "join-dup-right"])).toMatchObject({ code: 0, stdout: "a L1 R1\na L1 R2\na L2 R1\na L2 R2\n" });
  expect(await run(["join", "-a2", "join-dup-left", "join-dup-right"])).toMatchObject({ code: 0, stdout: "a L1 R1\na L1 R2\na L2 R1\na L2 R2\nb RB\n" });
  expect(await run(["join", "-v2", "join-dup-left", "join-dup-right"])).toMatchObject({ code: 0, stdout: "b RB\n" });
  expect(await run(["join", "--v", "left", "right"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["join", "--i", "left", "right"])).toMatchObject({ code: 0, stdout: "1 alpha red\n2 beta blue\n" });
  expect(await run(["join", "--ch", "left", "right"])).toMatchObject({ code: 0, stdout: "1 alpha red\n2 beta blue\n" });
  expect(await run(["join", "--n", "reverse-left-missing", "reverse-right-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "join: reverse-left-missing: No such file or directory\n" });
  expect(await run(["join", "--h", "left", "right"])).toMatchObject({ code: 1, stdout: "", stderr: "join: option '--h' is ambiguous; possibilities: '--header' '--help'\nTry 'join --help' for more information.\n" });
  expect(await run(["join", "--he", "left", "right"])).toMatchObject({ code: 1, stdout: "", stderr: "join: option '--he' is ambiguous; possibilities: '--header' '--help'\nTry 'join --help' for more information.\n" });
  expect(await run(["join", "--bad", "--help", "left", "right"])).toMatchObject({ code: 1, stdout: "", stderr: "join: unrecognized option '--bad'\nTry 'join --help' for more information.\n" });
  expect(await run(["join", "-x", "--help", "left", "right"])).toMatchObject({ code: 1, stdout: "", stderr: "join: invalid option -- 'x'\nTry 'join --help' for more information.\n" });
  expect(await run(["join", "--check=foo", "left", "right"])).toMatchObject({ code: 1, stdout: "", stderr: "join: option '--check-order' doesn't allow an argument\nTry 'join --help' for more information.\n" });
  const joinHelp = (await run(["join", "--help"])).stdout;
  expect(joinHelp).toContain("Usage: join [OPTION]... FILE1 FILE2\n");
  for (const option of ["-1", "-2", "-a", "-e", "-j", "-o", "-t", "-v"]) expect(joinHelp).toContain(`  ${option}\n`);
  expect(await run(["join", "join-missing", "right"])).toMatchObject({ code: 1, stdout: "", stderr: "join: join-missing: No such file or directory\n" });
  expect(await run(["join", "left", "join-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "join: join-missing: No such file or directory\n" });
  expect(await run(["join", "missing'join", "right"])).toMatchObject({ code: 1, stdout: "", stderr: "join: \"missing'join\": No such file or directory\n" });
  expect(await run(["join", "left", "missing\njoin"])).toMatchObject({ code: 1, stdout: "", stderr: "join: 'missing'$'\\n''join': No such file or directory\n" });
  await symlink("join-loop", join(dir, "join-loop"));
  expect(await run(["join", "join-loop", "right"])).toMatchObject({ code: 1, stdout: "", stderr: "join: join-loop: Too many levels of symbolic links\n" });
  expect(await run(["join", "left", "join-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "join: join-loop: Too many levels of symbolic links\n" });
  await symlink("loop'join", join(dir, "loop'join"));
  expect(await run(["join", "loop'join", "right"])).toMatchObject({ code: 1, stdout: "", stderr: "join: \"loop'join\": Too many levels of symbolic links\n" });
  await mkdir(join(dir, "join-dir"));
  expect(await run(["join", "join-dir", "right"])).toMatchObject({ code: 1, stdout: "", stderr: "join: read error: Is a directory\n" });
  expect(await run(["join", "left", "join-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "join: read error: Is a directory\n" });
  await mkdir(join(dir, "dir'join"));
  expect(await run(["join", "dir'join", "right"])).toMatchObject({ code: 1, stdout: "", stderr: "join: read error: Is a directory\n" });
  await writeFile(join(dir, "case-left"), "a lower\nB upper\n");
  await writeFile(join(dir, "case-right"), "A red\nb blue\n");
  expect(await run(["join", "--ignore-case", "case-left", "case-right"])).toMatchObject({ code: 0, stdout: "a lower red\nB upper blue\n" });
  await writeFile(join(dir, "case-unsorted-left"), "b first\nA second\n");
  const caseOrdered = await run(["join", "--ignore-case", "--check-order", "case-unsorted-left", "case-right"]);
  expect(caseOrdered).toMatchObject({ code: 1 });
  expect(caseOrdered.stderr).toContain("case-unsorted-left:2: is not sorted: A second");
  await writeFile(join(dir, "months-left"), "apr 15\naug 20\ndec 18\nfeb 05\n");
  await writeFile(join(dir, "months-right"), "apr 06\naug 14\ndate\nfeb 15\n");
  expect(await run(["join", "-a1", "-a2", "-e", "-", "-o", "2.2,1.1", "months-left", "months-right"])).toMatchObject({ code: 0, stdout: "06 apr\n14 aug\n- -\n- dec\n15 feb\n" });
  expect(await run(["join", "-o", "0", "1.2", "2.2", "months-left", "months-right"])).toMatchObject({ code: 0, stdout: "apr 15 06\naug 20 14\nfeb 05 15\n" });
  expect(await run(["join", "-o", "0", "1.2", "-e", "-", "months-left", "months-right"])).toMatchObject({ code: 0, stdout: "apr 15\naug 20\nfeb 05\n" });
  expect(await run(["join", "-o", "1.0", "months-left", "months-right"])).toMatchObject(await systemRun(["join", "-o", "1.0", "months-left", "months-right"]));
  expect(await run(["join", "-o", "2.0", "months-left", "months-right"])).toMatchObject(await systemRun(["join", "-o", "2.0", "months-left", "months-right"]));
  expect(await run(["join", "-o", "bad", "months-left", "months-right"])).toMatchObject(await systemRun(["join", "-o", "bad", "months-left", "months-right"]));
  expect(await run(["join", "-o", "3\n.1", "months-left", "months-right"])).toMatchObject({ code: 1, stdout: "", stderr: `join: invalid file number in field spec: ${diagnosticQuote("3\\n.1")}\n` });
  expect(await run(["join", "-o", "1.0\n", "months-left", "months-right"])).toMatchObject({ code: 1, stdout: "", stderr: `join: invalid field number: ${diagnosticQuote("0\\n")}\n` });
  expect(await run(["join", "-o", "1.2\n2.2", "months-left", "months-right"])).toMatchObject({ code: 1, stdout: "", stderr: `join: invalid field number: ${diagnosticQuote("2\\n2.2")}\n` });
  await writeFile(join(dir, "wide-left"), "a 1 2\nb 1\nd 1 2\n");
  await writeFile(join(dir, "wide-right"), "a 3 4\nb 3 4\nc 3 4\n");
  expect(await run(["join", "-a1", "-a2", "-e", ".", "-o", "auto", "wide-left", "wide-right"])).toMatchObject({ code: 0, stdout: "a 1 2 3 4\nb 1 . 3 4\nc . . 3 4\nd 1 2 . .\n" });
  await writeFile(join(dir, "reverse-left"), "b 1\na 2\n");
  await writeFile(join(dir, "reverse-right"), "b Y\na Z\n");
  expect(await run(["join", "--nocheck-order", "reverse-left", "reverse-right"])).toMatchObject({ code: 0, stdout: "b 1 Y\na 2 Z\n" });
  const ordered = await run(["join", "--check-order", "reverse-left", "reverse-right"]);
  expect(ordered).toMatchObject({ code: 1 });
  expect(ordered.stderr).toContain("is not sorted");
  await writeFile(join(dir, "header-left"), "ID Name\n1 A\n");
  await writeFile(join(dir, "header-right"), "ID Color\n1 red\n");
  expect(await run(["join", "--header", "header-left", "header-right"])).toMatchObject({ code: 0, stdout: "ID Name Color\n1 A red\n" });
  expect(await run(["join", "-t", "xx", "left", "right"])).toMatchObject(await systemRun(["join", "-t", "xx", "left", "right"]));
  expect(await run(["join", "-txx", "left", "right"])).toMatchObject(await systemRun(["join", "-txx", "left", "right"]));
  expect(await run(["join", "-t", "ab\nc", "left", "right"])).toMatchObject({ code: 1, stdout: "", stderr: `join: multi-character tab ${diagnosticQuote("ab\\nc")}\n` });
  expect(await run(["join", "-t", "", "left", "right"])).toMatchObject({ code: 0, stdout: "" });
  await writeFile(join(dir, "nul-left"), "a\0c\0e");
  await writeFile(join(dir, "nul-right"), "a\0b\0c");
  expect(await run(["join", "-z", "nul-left", "nul-right"])).toMatchObject({ code: 0, stdout: "a\0c\0" });
  await writeFile(join(dir, "join-nul-left"), "a\0x\n");
  await writeFile(join(dir, "join-nul-right"), "a\0y\n");
  expect(await run(["join", "-t", "\\0", "join-nul-left", "join-nul-right"])).toMatchObject({ code: 0, stdout: "a\0x\0y\n" });
  await writeFile(join(dir, "utf8-left"), "1𐏐left\n");
  await writeFile(join(dir, "utf8-right"), "1𐏐right\n");
  expect(await run(["join", "-t", "𐏐", "utf8-left", "utf8-right"])).toMatchObject({ code: 0, stdout: "1𐏐left𐏐right\n" });
  await writeFile(join(dir, "latin-left"), Buffer.from([97, 0xa7, 49, 10]));
  await writeFile(join(dir, "latin-right"), Buffer.from([97, 0xa7, 50, 0xa7, 10]));
  expect(await run(["join", "-t", "\uFFFD", "latin-left", "latin-right"])).toMatchObject({ code: 0, stdout: Buffer.from([97, 0xa7, 49, 0xa7, 50, 0xa7, 10]).toString() });
  for (const option of ["-t", "-1", "-2", "-j", "-a", "-v", "-e", "-o"]) {
    expect(await run(["join", option])).toMatchObject({ code: 1, stderr: `join: option requires an argument -- '${option.slice(1)}'\nTry 'join --help' for more information.\n` });
  }
  expect(await run(["tr", "a-z", "A-Z"], "abc xyz\n")).toMatchObject({ code: 0, stdout: "ABC XYZ\n" });
  expect(await run(["tr", "-d", "0-9"], "a1b2\n")).toMatchObject({ code: 0, stdout: "ab\n" });
  expect(await run(["nl"], "one\n\ntwo\n")).toMatchObject({ code: 0, stdout: "     1\tone\n       \n     2\ttwo\n" });
  expect(await run(["nl", "-ba", "-n", "rz", "-w", "3", "-s", ":", "-v", "5", "-i", "2"], "a\nb\nc\n")).toMatchObject({ code: 0, stdout: "005:a\n007:b\n009:c\n" });
  await writeFile(join(dir, "nl-raw"), Uint8Array.of(0xff, 0x0a));
  const nlRaw = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "nl", "-ba", "nl-raw"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "nl-raw-out")),
    stderr: "pipe",
  });
  expect(await nlRaw.exited).toBe(0);
  expect(await new Response(nlRaw.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "nl-raw-out"))]).toEqual([0x20, 0x20, 0x20, 0x20, 0x20, 0x31, 0x09, 0xff, 0x0a]);
  await writeFile(join(dir, "nl-left-no-newline"), "a");
  await writeFile(join(dir, "nl-right-newline"), "b\n");
  expect(await run(["nl", "-ba", "nl-left-no-newline", "nl-right-newline"])).toMatchObject({ code: 0, stdout: "     1\ta\n     2\tb\n" });
  expect(await run(["nl", "missing'nl"])).toMatchObject({ code: 1, stdout: "", stderr: "nl: \"missing'nl\": No such file or directory\n" });
  expect(await run(["nl", "missing\nnl"])).toMatchObject({ code: 1, stdout: "", stderr: "nl: 'missing'$'\\n''nl': No such file or directory\n" });
  await mkdir(join(dir, "dir'nl"));
  expect(await run(["nl", "dir'nl"])).toMatchObject({ code: 1, stdout: "", stderr: "nl: \"dir'nl\": Is a directory\n" });
  await symlink("loop'nl", join(dir, "loop'nl"));
  expect(await run(["nl", "loop'nl"])).toMatchObject({ code: 1, stdout: "", stderr: "nl: \"loop'nl\": Too many levels of symbolic links\n" });
  expect(await run(["nl", "-ba", "-w", "+3", "-v", "+5", "-i", "+2"], "a\nb\n")).toMatchObject({ code: 0, stdout: "  5\ta\n  7\tb\n" });
  expect(await run(["nl", "--bo=a"], "a\n\n")).toMatchObject({ code: 0, stdout: "     1\ta\n     2\t\n" });
  expect(await run(["nl", "--number-s=:"], "a\n")).toMatchObject({ code: 0, stdout: "     1:a\n" });
  expect(await run(["nl", "--v"])).toMatchObject({ code: 0, stdout: expect.stringContaining("bnu 9.11\n") });
  expect(await run(["nl", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Write each FILE to standard output, with line numbers added.\n") });
  expect(await run(["nl", "--v=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "nl: option '--version' doesn't allow an argument\nTry 'nl --help' for more information.\n" });
  expect(await run(["nl", "--h"])).toMatchObject({ code: 1, stdout: "", stderr: "nl: option '--h' is ambiguous; possibilities: '--header-numbering' '--help'\nTry 'nl --help' for more information.\n" });
  expect(await run(["nl", "--num=a"])).toMatchObject({ code: 1, stdout: "", stderr: "nl: option '--num=a' is ambiguous; possibilities: '--number-separator' '--number-width' '--number-format'\nTry 'nl --help' for more information.\n" });
  expect(await run(["nl", "-x", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: nl [OPTION]... [FILE]...\n"), stderr: "nl: invalid option -- 'x'\n" });
  expect(await run(["nl", "--help=1", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n", stderr: "nl: option '--help' doesn't allow an argument\n" });
  expect(await run(["nl", "--body=bad", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: nl [OPTION]... [FILE]...\n"), stderr: `nl: invalid body numbering style: ${diagnosticQuote("bad")}\n` });
  expect(await run(["nl", "--body-numbering", "bad", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: nl [OPTION]... [FILE]...\n"), stderr: `nl: invalid body numbering style: ${diagnosticQuote("bad")}\n` });
  expect(await run(["nl", "-b", "bad", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: nl [OPTION]... [FILE]...\n"), stderr: `nl: invalid body numbering style: ${diagnosticQuote("bad")}\n` });
  expect(await run(["nl", "-n", "bad", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: nl [OPTION]... [FILE]...\n"), stderr: `nl: invalid line numbering format: ${diagnosticQuote("bad")}\n` });
  expect(await run(["nl", "--no-renumber=bad", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: nl [OPTION]... [FILE]...\n"), stderr: "nl: option '--no-renumber' doesn't allow an argument\n" });
  expect(await run(["nl", "--body-numbering", "--help"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `nl: invalid body numbering style: ${diagnosticQuote("--help")}\nTry 'nl --help' for more information.\n` });
  expect(await run(["nl", "-b", "x"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `nl: invalid body numbering style: ${diagnosticQuote("x")}\nTry 'nl --help' for more information.\n` });
  expect(await run(["nl", "-b", "x\ny"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `nl: invalid body numbering style: ${diagnosticQuote("x\\ny")}\nTry 'nl --help' for more information.\n` });
  expect(await run(["nl", "-h", "x"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `nl: invalid header numbering style: ${diagnosticQuote("x")}\nTry 'nl --help' for more information.\n` });
  expect(await run(["nl", "-f", "x"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `nl: invalid footer numbering style: ${diagnosticQuote("x")}\nTry 'nl --help' for more information.\n` });
  expect(await run(["nl", "-n", "rzbad"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `nl: invalid line numbering format: ${diagnosticQuote("rzbad")}\nTry 'nl --help' for more information.\n` });
  expect(await run(["nl", "-n", "r\nz"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `nl: invalid line numbering format: ${diagnosticQuote("r\\nz")}\nTry 'nl --help' for more information.\n` });
  expect(await run(["nl", "-w", "1\n2"])).toMatchObject({ code: 1, stdout: "", stderr: `nl: invalid line number field width: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["nl", "--number-width", "bad", "--help"])).toMatchObject(await systemRun(["nl", "--number-width", "bad", "--help"]));
  expect(await run(["nl", "-w", "bad", "--help"])).toMatchObject(await systemRun(["nl", "-w", "bad", "--help"]));
  expect(await run(["nl", "-wbad", "--help"])).toMatchObject(await systemRun(["nl", "-wbad", "--help"]));
  expect(await run(["nl", "--line-increment", "bad", "--help"])).toMatchObject(await systemRun(["nl", "--line-increment", "bad", "--help"]));
  expect(await run(["nl", "-i", "bad", "--help"])).toMatchObject(await systemRun(["nl", "-i", "bad", "--help"]));
  expect(await run(["nl", "--number-width", "3", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: nl [OPTION]... [FILE]...\n") });
  expect(await run(["nl", "-w", "x"])).toMatchObject(await systemRun(["nl", "-w", "x"]));
  expect(await run(["nl", "-w", "0"])).toMatchObject(await systemRun(["nl", "-w", "0"]));
  expect(await run(["nl", "-w", "+0"])).toMatchObject(await systemRun(["nl", "-w", "+0"]));
  expect(await run(["nl", "-w", "-1"])).toMatchObject(await systemRun(["nl", "-w", "-1"]));
  expect(await run(["nl", "-w", "2147483648"])).toMatchObject(await systemRun(["nl", "-w", "2147483648"]));
  expect(await run(["nl", "-w", "+2147483648"])).toMatchObject(await systemRun(["nl", "-w", "+2147483648"]));
  expect(await run(["nl", "-v", "x"])).toMatchObject(await systemRun(["nl", "-v", "x"]));
  expect(await run(["nl", "-v", "1\n2"])).toMatchObject({ code: 1, stdout: "", stderr: `nl: invalid starting line number: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["nl", "-i", "x"])).toMatchObject(await systemRun(["nl", "-i", "x"]));
  expect(await run(["nl", "-i", "1\n2"])).toMatchObject({ code: 1, stdout: "", stderr: `nl: invalid line number increment: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["nl", "-v", "+9223372036854775808"])).toMatchObject(await systemRun(["nl", "-v", "+9223372036854775808"]));
  expect(await run(["nl", "-i", "-9223372036854775809"])).toMatchObject(await systemRun(["nl", "-i", "-9223372036854775809"]));
  expect(await run(["nl", "-ba", "-n", "ln", "-w", "3", "-s", ":"], "a\nb\n")).toMatchObject({ code: 0, stdout: "1  :a\n2  :b\n" });
  expect(await run(["nl", "-ba", "-l", "2"], "a\n\n\nb\n")).toMatchObject({ code: 0, stdout: "     1\ta\n       \n     2\t\n     3\tb\n" });
  expect(await run(["nl", "-l", "-1"], "a\n")).toMatchObject(await systemRun(["nl", "-l", "-1"], "a\n"));
  expect(await run(["nl", "-l", "1\n2"], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: `nl: invalid line number of blank lines: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["nl", "-l", "bad"], "a\n")).toMatchObject(await systemRun(["nl", "-l", "bad"], "a\n"));
  expect(await run(["nl", "-bp^[ab]"], "a\nc\nb\n")).toMatchObject({ code: 0, stdout: "     1\ta\n       c\n     2\tb\n" });
  expect(await run(["nl", "-bp("], "a\n(a)\n")).toMatchObject({ code: 0, stdout: "       a\n     1\t(a)\n" });
  expect(await run(["nl", "-bp(a)"], "a\n(a)\n")).toMatchObject({ code: 0, stdout: "       a\n     1\t(a)\n" });
  expect(await run(["nl", "-bp\\(a\\)"], "a\n(a)\n")).toMatchObject({ code: 0, stdout: "     1\ta\n     2\t(a)\n" });
  expect(await run(["nl", "-bp["], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: "nl: Invalid regular expression\n" });
  expect(await run(["nl", "-hp["], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: "nl: Invalid regular expression\n" });
  expect(await run(["nl", "-fp["], "a\n")).toMatchObject({ code: 1, stdout: "", stderr: "nl: Invalid regular expression\n" });
  expect(await run(["nl", "-ha", "-fa"], "\\:\\:\\:\na\n\\:\\:\nb\n\\:\nc\n")).toMatchObject({ code: 0, stdout: "\n     1\ta\n\n     1\tb\n\n     1\tc\n" });
  expect(await run(["nl", "-p", "-ha", "-fa"], "\\:\\:\\:\na\n\\:\\:\nb\n\\:\nc\n")).toMatchObject({ code: 0, stdout: "\n     1\ta\n\n     2\tb\n\n     3\tc\n" });
  expect(await run(["nl", "-p", "-ha", "-fa", "-d", "\uFFFD"], Buffer.from([0xc3, 0x3a, 0xc3, 0x3a, 0xc3, 0x3a, 0x0a, 0x61, 0x0a, 0xc3, 0x3a, 0xc3, 0x3a, 0x0a, 0x62, 0x0a, 0xc3, 0x3a, 0x0a, 0x63, 0x0a]))).toMatchObject({ code: 0, stdout: "\n     1\ta\n\n     2\tb\n\n     3\tc\n" });
  expect(await run(["nl", "-d", ""], "a\n\\:\\:\nc\n")).toMatchObject({ code: 0, stdout: "     1\ta\n     2\t\\:\\:\n     3\tc\n" });
  expect(await run(["nl", "-v9223372036854775807", "-i-9223372036854775808"], "a\nb\n")).toMatchObject({ code: 0, stdout: "9223372036854775807\ta\n    -1\tb\n" });
  await writeFile(join(dir, "nl-a"), "a\n");
  await writeFile(join(dir, "nl-b"), "b\n");
  await mkdir(join(dir, "nl-dir"));
  await symlink("nl-loop", join(dir, "nl-loop"));
  const nlMissing = await run(["nl", "nl-a", "nl-missing", "nl-b"]);
  expect(nlMissing).toMatchObject({ code: 1, stdout: "     1\ta\n     2\tb\n" });
  expect(nlMissing.stderr).toContain("nl: nl-missing: No such file or directory");
  expect(await run(["nl", "nl-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "nl: nl-dir: Is a directory\n" });
  expect(await run(["nl", "nl-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "nl: nl-loop: Too many levels of symbolic links\n" });
  await writeFile(join(dir, "lines"), "a\nb\nc\n");
  expect(await run(["split", "-b", "0"])).toMatchObject(await systemRun(["split", "-b", "0"]));
  expect(await run(["split", "-b", "x"])).toMatchObject(await systemRun(["split", "-b", "x"]));
  expect(await run(["split", "-C", "0"])).toMatchObject(await systemRun(["split", "-C", "0"]));
  expect(await run(["split", "-C", "x"])).toMatchObject(await systemRun(["split", "-C", "x"]));
  expect(await run(["split", "-l", "0"])).toMatchObject(await systemRun(["split", "-l", "0"]));
  expect(await run(["split", "-l", "x"])).toMatchObject(await systemRun(["split", "-l", "x"]));
  expect(await run(["split", "-l", "1\n2"])).toMatchObject({ code: 1, stdout: "", stderr: `split: invalid number of lines: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["split", "-b", "1\n2"])).toMatchObject({ code: 1, stdout: "", stderr: `split: invalid number of bytes: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["split", "-C", "1\n2"])).toMatchObject({ code: 1, stdout: "", stderr: `split: invalid number of lines: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["split", "-n", "-1", "lines"])).toMatchObject(await systemRun(["split", "-n", "-1", "lines"]));
  expect(await run(["split", "-l", "-1", "lines"])).toMatchObject(await systemRun(["split", "-l", "-1", "lines"]));
  expect(await run(["split", "-b", "-2", "lines"])).toMatchObject(await systemRun(["split", "-b", "-2", "lines"]));
  expect(await run(["split", "-C", "-2", "lines"])).toMatchObject(await systemRun(["split", "-C", "-2", "lines"]));
  expect(await run(["split", "-a", "-1", "lines"])).toMatchObject(await systemRun(["split", "-a", "-1", "lines"]));
  expect(await run(["split", "-a", "bad", "lines"])).toMatchObject(await systemRun(["split", "-a", "bad", "lines"]));
  expect(await run(["split", "-a", "1\n2", "lines"])).toMatchObject({ code: 1, stdout: "", stderr: `split: invalid suffix length: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["split", "-abad", "lines"])).toMatchObject(await systemRun(["split", "-abad", "lines"]));
  expect(await run(["split", "-a", "bad", "split-missing"])).toMatchObject(await systemRun(["split", "-a", "bad", "split-missing"]));
  expect(await run(["split", "--additional-suffix=/", "split-missing"])).toMatchObject(await systemRun(["split", "--additional-suffix=/", "split-missing"]));
  expect(await run(["split", "--additional-suffix=/x", "split-missing"])).toMatchObject(await systemRun(["split", "--additional-suffix=/x", "split-missing"]));
  expect(await run(["split", "--additional-suffix=bad\n/suf", "lines"])).toMatchObject({ code: 1, stdout: "", stderr: `split: invalid suffix ${diagnosticQuote("bad\\n/suf")}, contains directory separator\nTry 'split --help' for more information.\n` });
  expect(await run(["split", "-d", "--numeric-suffixes=+1", "lines"])).toMatchObject({ code: 1, stderr: "split: '+1': invalid start value for numerical suffix\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "-d", "--numeric-suffixes=+1", "split-missing"])).toMatchObject({ code: 1, stderr: "split: '+1': invalid start value for numerical suffix\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "-x", "--hex-suffixes=g", "lines"])).toMatchObject({ code: 1, stderr: "split: 'g': invalid start value for hexadecimal suffix\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "--num", "lines"])).toMatchObject({ code: 1, stderr: "split: option '--num' is ambiguous; possibilities: '--number' '--numeric-suffixes'\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "--h", "lines"])).toMatchObject({ code: 1, stdout: "", stderr: "split: option '--h' is ambiguous; possibilities: '--hex-suffixes' '--help'\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "--v", "lines"])).toMatchObject({ code: 1, stdout: "", stderr: "split: option '--v' is ambiguous; possibilities: '--verbose' '--version'\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "split: unrecognized option '--bad'\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "-x", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: split [OPTION]... [FILE [PREFIX]]\n") });
  expect(await run(["split", "--bytes", "bad", "--help"])).toMatchObject(await systemRun(["split", "--bytes", "bad", "--help"]));
  expect(await run(["split", "--lines", "bad", "--help"])).toMatchObject(await systemRun(["split", "--lines", "bad", "--help"]));
  expect(await run(["split", "--number", "bad", "--help"])).toMatchObject(await systemRun(["split", "--number", "bad", "--help"]));
  expect(await run(["split", "--suffix-length", "bad", "--help"])).toMatchObject(await systemRun(["split", "--suffix-length", "bad", "--help"]));
  expect(await run(["split", "-b", "bad", "--help"])).toMatchObject(await systemRun(["split", "-b", "bad", "--help"]));
  expect(await run(["split", "-n", "bad", "--help"])).toMatchObject(await systemRun(["split", "-n", "bad", "--help"]));
  expect(await run(["split", "--bytes=1", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: split [OPTION]... [FILE [PREFIX]]\n") });
  expect(await run(["split", "--lines", "1", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: split [OPTION]... [FILE [PREFIX]]\n") });
  expect(await run(["split", "--h=foo", "lines"])).toMatchObject({ code: 1, stdout: "", stderr: "split: option '--h=foo' is ambiguous; possibilities: '--hex-suffixes' '--help'\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "--verbose=foo", "lines"])).toMatchObject({ code: 1, stdout: "", stderr: "split: option '--verbose' doesn't allow an argument\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "lines", "prefix", "extra"])).toMatchObject({ code: 1, stderr: `split: extra operand ${diagnosticQuote("extra")}\nTry 'split --help' for more information.\n` });
  expect(await run(["split", "lines", "prefix", "extra\narg"])).toMatchObject({ code: 1, stderr: `split: extra operand ${diagnosticQuote("extra\\narg")}\nTry 'split --help' for more information.\n` });
  expect(await run(["split", "-d", "-a20", "--numeric-suffixes=18446744073709551615", "lines", "large-dec"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "large-dec18446744073709551615"), "utf8")).toBe("a\nb\nc\n");
  expect(await run(["split", "--hex=e", "lines", "hex-abbrev"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "hex-abbrev0e"), "utf8")).toBe("a\nb\nc\n");
  expect(await run(["split", "--", "--num"])).toMatchObject({ code: 1, stderr: "split: cannot open '--num' for reading: No such file or directory\n" });
  expect(await run(["split", "lines", "--", "--hex"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "--hexaa"), "utf8")).toBe("a\nb\nc\n");
  await mkdir(join(dir, "split-input-dir"));
  await symlink("split-input-loop", join(dir, "split-input-loop"));
  expect(await run(["split", "split-input-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "split: split-input-dir: Is a directory\n" });
  expect(await run(["split", "split-input-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "split: cannot open 'split-input-loop' for reading: Too many levels of symbolic links\n" });
  expect(await run(["split", "-x", "-a16", "--hex-suffixes=ffffffffffffffff", "lines", "large-hex"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "large-hexffffffffffffffff"), "utf8")).toBe("a\nb\nc\n");
  expect(await run(["split", "-d", "-a1", "--numeric-suffixes=10", "lines"])).toMatchObject({ code: 1, stderr: "split: numerical suffix start value is too large for the suffix length\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "-a", "0", "-n", "2", "lines", "zero-suffix"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "zero-suffixaa"), "utf8")).toBe("a\nb");
  expect(await readFile(join(dir, "zero-suffixab"), "utf8")).toBe("\nc\n");
  expect(await run(["split", "-a1", "-n27"], "")).toMatchObject({ code: 1, stderr: "split: the suffix length needs to be at least 2\n" });
  expect(await run(["split", "-d", "-a1", "-n11"], "")).toMatchObject({ code: 1, stderr: "split: the suffix length needs to be at least 2\n" });
  expect(await run(["split", "-x", "-a1", "-n17"], "")).toMatchObject({ code: 1, stderr: "split: the suffix length needs to be at least 2\n" });
  await writeFile(join(dir, "six-lines"), "a\nb\nc\nd\ne\nf\n");
  expect(await run(["split", "-d5", "six-lines", "obsolete-digits"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "obsolete-digits00"), "utf8")).toBe("a\nb\nc\nd\ne\n");
  expect(await readFile(join(dir, "obsolete-digits01"), "utf8")).toBe("f\n");
  expect(await run(["split", "-du5", "six-lines", "obsolete-cluster"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "obsolete-cluster00"), "utf8")).toBe("a\nb\nc\nd\ne\n");
  expect(await readFile(join(dir, "obsolete-cluster01"), "utf8")).toBe("f\n");
  expect(await run(["split", "-5", "-l1", "six-lines"])).toMatchObject({ code: 1, stderr: "split: cannot split in more than one way\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "-b1", "-l1", "six-lines"])).toMatchObject({ code: 1, stderr: "split: cannot split in more than one way\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "--number=2", "--lines=1", "six-lines"])).toMatchObject({ code: 1, stderr: "split: cannot split in more than one way\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "-n", "1/+2", "lines"])).toMatchObject({ code: 0, stdout: "a\nb" });
  expect(await run(["split", "-n", "+1/2", "lines"])).toMatchObject({ code: 0, stdout: "a\nb" });
  expect(await run(["split", "-l", "+2", "lines", "plus-lines"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "plus-linesaa"), "utf8")).toBe("a\nb\n");
  await writeFile(join(dir, "plus-bytes"), "abcd");
  expect(await run(["split", "-b", "+2", "plus-bytes", "plus-bytes-out"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "plus-bytes-outaa"), "utf8")).toBe("ab");
  await writeFile(join(dir, "suffix-bytes"), "x".repeat(1500));
  expect(await run(["split", "-b", "1k", "suffix-bytes", "suffix-binary"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "suffix-binaryaa"))).size).toBe(1024);
  expect((await stat(join(dir, "suffix-binaryab"))).size).toBe(476);
  expect(await run(["split", "-b", "1kB", "suffix-bytes", "suffix-decimal"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "suffix-decimalaa"))).size).toBe(1000);
  expect((await stat(join(dir, "suffix-decimalab"))).size).toBe(500);
  expect(await run(["split", "-b", "1kiB", "suffix-bytes", "suffix-ib"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "suffix-ibaa"))).size).toBe(1024);
  expect(await run(["split", "-b", "1E", "suffix-bytes", "suffix-exa"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "suffix-exaaa"))).size).toBe(1500);
  expect(await run(["split", "-b", "1ZB", "suffix-bytes", "suffix-zetta"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "suffix-zettaaa"))).size).toBe(1500);
  expect(await run(["split", "-b", "1YiB", "suffix-bytes", "suffix-yobi"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "suffix-yobiaa"))).size).toBe(1500);
  expect(await run(["split", "-b", "1e", "suffix-bytes", "suffix-lower-exa"])).toMatchObject({ code: 1 });
  expect(await run(["split", "-l", "2", "lines", "part"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "partaa"), "utf8")).toBe("a\nb\n");
  expect(await readFile(join(dir, "partab"), "utf8")).toBe("c\n");
  await writeFile(join(dir, "split-raw"), Uint8Array.of(0xff, 0x0a, 0x61, 0x0a));
  expect(await run(["split", "-l", "1", "split-raw", "split-raw-lines"])).toMatchObject({ code: 0 });
  expect([...await readFile(join(dir, "split-raw-linesaa"))]).toEqual([0xff, 0x0a]);
  expect([...await readFile(join(dir, "split-raw-linesab"))]).toEqual([0x61, 0x0a]);
  expect(await run(["split", "-C", "2", "split-raw", "split-raw-line-bytes"])).toMatchObject({ code: 0 });
  expect([...await readFile(join(dir, "split-raw-line-bytesaa"))]).toEqual([0xff, 0x0a]);
  expect([...await readFile(join(dir, "split-raw-line-bytesab"))]).toEqual([0x61, 0x0a]);
  expect(await run(["split", "--unbuffered", "-l", "2", "lines", "unbuf"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "unbufaa"), "utf8")).toBe("a\nb\n");
  await writeFile(join(dir, "xaa"), "1\n2\n3\n4\n");
  await symlink("xaa", join(dir, "same-link"));
  await link(join(dir, "xaa"), join(dir, "same-hard"));
  expect(await run(["split", "-C", "2", "xaa"])).toMatchObject({ code: 1 });
  expect(await run(["split", "-C", "2", "same-link"])).toMatchObject({ code: 1 });
  expect(await run(["split", "-C", "2", "same-hard"])).toMatchObject({ code: 1 });
  expect(await readFile(join(dir, "xaa"), "utf8")).toBe("1\n2\n3\n4\n");
  await mkdir(join(dir, "split-dir-outaa"));
  expect(await run(["split", "-l", "1", "lines", "split-dir-out"])).toMatchObject({ code: 1, stdout: "", stderr: "split: split-dir-outaa: Is a directory\n" });
  expect(await run(["split", "-l", "1", "lines", "bad", "extra"])).toMatchObject({ code: 1 });
  await expect(readFile(join(dir, "badaa"), "utf8")).rejects.toThrow();
  await writeFile(join(dir, "bytes"), "abcdefghi");
  expect(await run(["split", "-n", "3", "bytes", "chunk"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "chunkaa"), "utf8")).toBe("abc");
  expect(await readFile(join(dir, "chunkab"), "utf8")).toBe("def");
  expect(await readFile(join(dir, "chunkac"), "utf8")).toBe("ghi");
  expect(await run(["split", "-n", "2/3", "bytes"])).toMatchObject({ code: 0, stdout: "def" });
  await writeFile(join(dir, "records"), "a\nb\nc\nd\n");
  expect(await run(["split", "-n", "r/2", "-d", "-a", "1", "records", "rr"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "rr0"), "utf8")).toBe("a\nc\n");
  expect(await readFile(join(dir, "rr1"), "utf8")).toBe("b\nd\n");
  await writeFile(join(dir, "split-raw-round-robin"), Uint8Array.of(0xff, 0x0a, 0x61, 0x0a, 0xfe, 0x0a));
  expect(await run(["split", "-n", "r/2", "-d", "-a", "1", "split-raw-round-robin", "split-raw-rr"])).toMatchObject({ code: 0 });
  expect([...await readFile(join(dir, "split-raw-rr0"))]).toEqual([0xff, 0x0a, 0xfe, 0x0a]);
  expect([...await readFile(join(dir, "split-raw-rr1"))]).toEqual([0x61, 0x0a]);
  await writeFile(join(dir, "lchunk"), "12345\n1\n12345\n1\n12345\n1\n12345\n1\n12345\n\n\n12345\n1\n12345\n1\n12345\n1\n12345\n1\n12345\n1\n");
  expect(await run(["split", "-n", "l/2", "-", "pipe-lch"], "1\n2\n3\n4\n")).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "pipe-lchaa"), "utf8")).toBe("1\n2\n");
  expect(await readFile(join(dir, "pipe-lchab"), "utf8")).toBe("3\n4\n");
  expect(await run(["split", "-n", "l/8", "lchunk", "lch"])).toMatchObject({ code: 0 });
  for (const [name, text] of [
    ["lchaa", "12345\n1\n12345\n"],
    ["lchab", "1\n12345\n"],
    ["lchac", "1\n12345\n"],
    ["lchad", "1\n12345\n\n\n"],
    ["lchae", "12345\n1\n12345\n"],
    ["lchaf", "1\n12345\n"],
    ["lchag", "1\n12345\n"],
    ["lchah", "1\n12345\n1\n"],
  ]) expect(await readFile(join(dir, name), "utf8")).toBe(text);
  expect(await run(["split", "-n", "l/13/15", "lchunk"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["split", "-n", "l/14/15", "lchunk"])).toMatchObject({ code: 0, stdout: "1\n12345\n" });
  expect(await run(["split", "-n", "l/16/15", "lchunk"])).toMatchObject(await systemRun(["split", "-n", "l/16/15", "lchunk"]));
  expect(await run(["split", "-n", "l/1o", "lchunk"])).toMatchObject(await systemRun(["split", "-n", "l/1o", "lchunk"]));
  expect(await run(["split", "-n", "", "lchunk"])).toMatchObject(await systemRun(["split", "-n", "", "lchunk"]));
  expect(await run(["split", "-n", "/2", "lchunk"])).toMatchObject(await systemRun(["split", "-n", "/2", "lchunk"]));
  expect(await run(["split", "-n", "1/2/3", "lchunk"])).toMatchObject(await systemRun(["split", "-n", "1/2/3", "lchunk"]));
  expect(await run(["split", "-n", "l/", "lchunk"])).toMatchObject(await systemRun(["split", "-n", "l/", "lchunk"]));
  expect(await run(["split", "-n", "b/2", "lchunk"])).toMatchObject(await systemRun(["split", "-n", "b/2", "lchunk"]));
  expect(await run(["split", "-n", "1\n2", "lchunk"])).toMatchObject({ code: 1, stdout: "", stderr: `split: invalid number of chunks: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["split", "-n", "1\n2/3", "lchunk"])).toMatchObject({ code: 1, stdout: "", stderr: `split: invalid chunk number: ${diagnosticQuote("1\\n2")}\n` });
  await writeFile(join(dir, "lchunk-noeol"), "12\n34\n5");
  expect(await run(["split", "-n", "l/7/7", "lchunk-noeol"])).toMatchObject({ code: 0, stdout: "5" });
  expect(await run(["split", "-1", "lines", "obsolete"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "obsoleteaa"), "utf8")).toBe("a\n");
  expect(await run(["split", "-0", "lines", "bad-obsolete"])).toMatchObject({ code: 1 });
  expect(await run(["split", "-99999999999999999991", "lines", "huge-obsolete"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "huge-obsoleteaa"), "utf8")).toBe("a\nb\nc\n");
  expect(await run(["split", "--number=r/9223372036854775807/18446744073709551615"], "")).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["split", "--number=r/18446744073709551615", "lines"])).toMatchObject(await systemRun(["split", "--number=r/18446744073709551615", "lines"]));
  expect(await run(["split", "--number=r/18446744073709551616"], "")).toMatchObject({ code: 1 });
  expect(await run(["split", "-C", "4", "--additional-suffix=.txt", "records", "line"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "lineaa.txt"), "utf8")).toBe("a\nb\n");
  expect(await readFile(join(dir, "lineab.txt"), "utf8")).toBe("c\nd\n");
  await symlink("/dev/full", join(dir, "fullaa"));
  expect(await run(["split", "-b", "1", "-", "full"], "ab\n")).toMatchObject({ code: 1, stderr: "split: fullaa: No space left on device\n" });
  expect((await lstat(join(dir, "fullaa"))).isSymbolicLink()).toBe(true);
  expect(await run(["split", "-l", "2", "--filter=cat > \"$FILE.out\"", "records", "filtered"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "filteredaa.out"), "utf8")).toBe("a\nb\n");
  expect(await readFile(join(dir, "filteredab.out"), "utf8")).toBe("c\nd\n");
  expect(await run(["split", "-b", "4", "--filter=cat > \"$FILE.out\""], "1\n2\n3\n4\n5\n")).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "xaa.out"), "utf8")).toBe("1\n2\n");
  expect(await readFile(join(dir, "xab.out"), "utf8")).toBe("3\n4\n");
  expect(await readFile(join(dir, "xac.out"), "utf8")).toBe("5\n");
  expect(await run(["split", "-n", "r/2", "--filter=cat > \"$FILE.rr\""], "1\n2\n3\n4\n")).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "xaa.rr"), "utf8")).toBe("1\n3\n");
  expect(await readFile(join(dir, "xab.rr"), "utf8")).toBe("2\n4\n");
  const roundRobinEndless = Bun.spawn(["/bin/sh", "-c", `yes | timeout 5 ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} split -n r/2 --filter='head -c1 >$FILE.n' -`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await roundRobinEndless.exited).toBe(0);
  expect(await readFile(join(dir, "xaa.n"), "utf8")).toBe("y");
  expect(await readFile(join(dir, "xab.n"), "utf8")).toBe("y");
  const longRoundRobinRecord = `${"a".repeat(70_000)}\n`;
  expect(await run(["split", "-n", "r/2", "--filter=cat > \"$FILE.long\""], `${longRoundRobinRecord}b\n`)).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "xaa.long"), "utf8")).toBe(longRoundRobinRecord);
  expect(await readFile(join(dir, "xab.long"), "utf8")).toBe("b\n");
  const endlessSplit = Bun.spawn(["/bin/sh", "-c", `yes | timeout .5 ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} split -b 1000000 --filter='head -c1 >/dev/null'`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await endlessSplit.exited).toBe(124);
  expect(await run(["split", "-n", "1/2", "--filter=cat >/dev/null", "records"])).toMatchObject({ code: 1 });
  expect(await run(["split", "-l", "2", "--additional-suffix=a/b", "records", "bad-suffix"])).toMatchObject(await systemRun(["split", "-l", "2", "--additional-suffix=a/b", "records", "bad-suffix"]));
  await expect(readFile(join(dir, "bad-suffixaa/b"), "utf8")).rejects.toThrow();
  expect(await run(["split", "-b", "2", "-x", "-a", "1", "bytes", "hex"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "hex0"), "utf8")).toBe("ab");
  expect(await readFile(join(dir, "hex1"), "utf8")).toBe("cd");
  expect(await run(["split", "-l", "1", "--numeric-suffixes=5", "lines", "num"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "num05"), "utf8")).toBe("a\n");
  expect(await readFile(join(dir, "num06"), "utf8")).toBe("b\n");
  await writeFile(join(dir, "numeric-auto"), "x".repeat(91));
  expect(await run(["split", "-b", "1", "--numeric", "numeric-auto", "autonum"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "autonum89"), "utf8")).toBe("x");
  expect(await readFile(join(dir, "autonum9000"), "utf8")).toBe("x");
  expect(await run(["split", "-b", "1", "--numeric=89", "numeric-auto", "fixednum"])).toMatchObject({ code: 1, stderr: "split: output file suffixes exhausted\n" });
  expect(await readFile(join(dir, "fixednum99"), "utf8")).toBe("x");
  await expect(readFile(join(dir, "fixednum100"), "utf8")).rejects.toThrow();
  expect(await run(["split", "-l", "1", "--hex-suffixes=15", "lines", "hstart"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "hstart15"), "utf8")).toBe("a\n");
  expect(await readFile(join(dir, "hstart16"), "utf8")).toBe("b\n");
  await writeFile(join(dir, "many"), `${"x\n".repeat(27)}`);
  expect(await run(["split", "-l", "1", "-a", "1", "many", "tiny"])).toMatchObject({ code: 1, stderr: "split: output file suffixes exhausted\n" });
  expect(await readFile(join(dir, "tinya"), "utf8")).toBe("x\n");
  expect(await readFile(join(dir, "tinyz"), "utf8")).toBe("x\n");
  await expect(readFile(join(dir, "tinyaa"), "utf8")).rejects.toThrow();
  expect(await run(["split", "-l", "1", "-a", "2", "many", "manypart"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "manypartaz"), "utf8")).toBe("x\n");
  expect(await readFile(join(dir, "manypartba"), "utf8")).toBe("x\n");
  expect(await run(["split", "-a", "2", "-n", "1000"], "")).toMatchObject({ code: 1 });
  await writeFile(join(dir, "colon-records"), "a:b:c:");
  expect(await run(["split", "-l", "2", "-t:", "colon-records", "colon"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "colonaa"), "utf8")).toBe("a:b:");
  expect(await readFile(join(dir, "colonab"), "utf8")).toBe("c:");
  expect(await run(["split", "---io=2", "-C", "4", "records", "iotest"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "iotestaa"), "utf8")).toBe("a\nb\n");
  await writeFile(join(dir, "no-eol"), "0123456789");
  expect(await run(["split", "-C", "3", "no-eol", "noeol"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "noeolaa"), "utf8")).toBe("012");
  expect(await readFile(join(dir, "noeolab"), "utf8")).toBe("345");
  await writeFile(join(dir, "long-line"), "1\n2222\n3\n4");
  expect(await run(["split", "-C", "4", "long-line", "longc"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "longcaa"), "utf8")).toBe("1\n");
  expect(await readFile(join(dir, "longcab"), "utf8")).toBe("2222");
  expect(await readFile(join(dir, "longcac"), "utf8")).toBe("\n3\n");
  expect(await run(["split", "-t"], "")).toMatchObject({ code: 1, stderr: "split: option requires an argument -- 't'\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "--separator"], "")).toMatchObject({ code: 1, stderr: "split: option '--separator' requires an argument\nTry 'split --help' for more information.\n" });
  expect(await run(["split", "-t", ""], "")).toMatchObject({ code: 1, stderr: "split: empty record separator\n" });
  expect(await run(["split", "-t", "--help", "--version"], "")).toMatchObject({ code: 1, stdout: "", stderr: `split: multi-character separator ${diagnosticQuote("--help")}\n` });
  expect(await run(["split", "--separator", "--help", "--version"], "")).toMatchObject({ code: 1, stdout: "", stderr: `split: multi-character separator ${diagnosticQuote("--help")}\n` });
  expect(await run(["split", "--separator=xx", "--help"], "")).toMatchObject({ code: 1, stdout: "", stderr: `split: multi-character separator ${diagnosticQuote("xx")}\n` });
  expect(await run(["split", "-txx"], "")).toMatchObject({ code: 1, stderr: `split: multi-character separator ${diagnosticQuote("xx")}\n` });
  expect(await run(["split", "-ta", "-tb"], "")).toMatchObject({ code: 1 });
  expect(await run(["split", "-t:", "-t:"], "")).toMatchObject({ code: 0 });
});

test("tr supports classes, escapes, complement and squeezing", async () => {
  expect(await run(["tr", "[:lower:]", "[:upper:]"], "abc xyz\n")).toMatchObject({ code: 0, stdout: "ABC XYZ\n" });
  expect(await run(["tr", "-d", "[:digit:]"], "a1b2c3\n")).toMatchObject({ code: 0, stdout: "abc\n" });
  expect(await run(["tr", "--del", "a"], "abc")).toMatchObject({ code: 0, stdout: "bc" });
  expect(await run(["tr", "--squeeze", "a"], "aaabb")).toMatchObject({ code: 0, stdout: "abb" });
  expect(await run(["tr", "--tr", "a", "b"], "abc")).toMatchObject({ code: 0, stdout: "bbc" });
  expect(await run(["tr", "--delete=1", "a"])).toMatchObject({ code: 1, stderr: "tr: option '--delete' doesn't allow an argument\nTry 'tr --help' for more information.\n" });
  expect(await run(["tr", "--h", "a", "b"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: tr [OPTION]... STRING1 [STRING2]\n") });
  expect(await run(["tr", "--v", "a", "b"])).toMatchObject({ code: 0, stdout: expect.stringContaining("bnu 9.11\n") });
  expect(await run(["tr", "--h=foo", "a", "b"])).toMatchObject({ code: 1, stdout: "", stderr: "tr: option '--help' doesn't allow an argument\nTry 'tr --help' for more information.\n" });
  expect(await run(["tr", "--v=foo", "a", "b"])).toMatchObject({ code: 1, stdout: "", stderr: "tr: option '--version' doesn't allow an argument\nTry 'tr --help' for more information.\n" });
  expect(await run(["tr", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "tr: unrecognized option '--bad'\nTry 'tr --help' for more information.\n" });
  expect(await run(["tr", "--delete", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: tr [OPTION]... STRING1 [STRING2]\n") });
  expect(await run(["tr", "\\n", ","], "a\nb\n")).toMatchObject({ code: 0, stdout: "a,b," });
  expect(await run(["tr", "\\141-\\143", "X-Z"], "abc")).toMatchObject({ code: 0, stdout: "XYZ" });
  expect(await run(["tr", "A", "\\400"], "A0 ")).toMatchObject({ code: 0, stdout: " 0 ", stderr: "tr: warning: the ambiguous octal escape \\400 is being\n\tinterpreted as the 2-byte sequence \\040, 0\n" });
  expect(await run(["tr", "-d", "\\777"], "?7X")).toMatchObject({ code: 0, stdout: "X", stderr: "tr: warning: the ambiguous octal escape \\777 is being\n\tinterpreted as the 2-byte sequence \\077, 7\n" });
  expect(await run(["tr", "z-a", "A-Z"], "azm")).toMatchObject({ code: 1, stdout: "", stderr: "tr: range-endpoints of 'z-a' are in reverse collating sequence order\n" });
  expect(await run(["tr", "-d", "z-a"], "azm")).toMatchObject({ code: 1, stdout: "", stderr: "tr: range-endpoints of 'z-a' are in reverse collating sequence order\n" });
  expect(await run(["tr", "-c", "[:digit:]", "x"], "a12 b\n")).toMatchObject({ code: 0, stdout: "x12xxx" });
  expect(await run(["tr", "-s", "a-z", "A-Z"], "boook\n")).toMatchObject({ code: 0, stdout: "BOK\n" });
  expect(await run(["tr", "-s", " "], "a   b\n")).toMatchObject({ code: 0, stdout: "a b\n" });
  expect(await run(["tr", "abcd", "x[y*]"], "abcde")).toMatchObject({ code: 0, stdout: "xyyye" });
  expect(await run(["tr", "a[=*2][=c=]", "xyyz"], "a=c")).toMatchObject({ code: 0, stdout: "xyz" });
  expect(await run(["tr", "a[b*512]c", "1[x*]2"], "abc")).toMatchObject({ code: 0, stdout: "1x2" });
  expect(await run(["tr", "[b*010]cd", "[a*7]BC[x*]"], "bcd")).toMatchObject({ code: 0, stdout: "BCx" });
  expect(await run(["tr", "-t", "abcd", "xy"], "abcde")).toMatchObject({ code: 0, stdout: "xycde" });
  expect(await run(["tr", "-cs", "[:alnum:]", "[\\n*]"], "The big fox.")).toMatchObject({ code: 0, stdout: "The\nbig\nfox\n" });
  expect(await run(["tr", "-c", "[a*65536]\n", "[b*]"], "abcd")).toMatchObject({ code: 0, stdout: "abbb" });
  expect(await run(["tr", "-d", "[=]=]"], "[[]]")).toMatchObject({ code: 0, stdout: "[[" });
  expect(await run(["tr", "[=ab=]", "x"], "ab")).toMatchObject({ code: 1, stdout: "", stderr: "tr: ab: equivalence class operand must be a single character\n" });
  expect(await run(["tr", "[[::]]", "x"])).toMatchObject({ code: 1, stdout: "", stderr: "tr: missing character class name '[::]'\n" });
  expect(await run(["tr", "[:*3][:digit:]", "a-m"], ":1239")).toMatchObject({ code: 0, stdout: "cefgm" });
  expect(await run(["tr", "[:upper:][:lower:]", "a-z[:upper:]"], "abc.xyz")).toMatchObject({ code: 0, stdout: "ABC.XYZ" });
  expect(await run(["tr"])).toMatchObject({ code: 1, stderr: "tr: missing operand\nTry 'tr --help' for more information.\n" });
  expect(await run(["tr", "-ds", "a"])).toMatchObject({ code: 1, stderr: "tr: missing operand after 'a'\nTwo strings must be given when both deleting and squeezing repeats.\nTry 'tr --help' for more information.\n" });
  expect(await run(["tr", "-d", "a", "b"])).toMatchObject({ code: 1, stderr: `tr: extra operand ${diagnosticQuote("b")}\nOnly one string may be given when deleting without squeezing repeats.\nTry 'tr --help' for more information.\n` });
  expect(await run(["tr", "-d", "a", "b\nc"])).toMatchObject({ code: 1, stderr: `tr: extra operand ${diagnosticQuote("b\\nc")}\nOnly one string may be given when deleting without squeezing repeats.\nTry 'tr --help' for more information.\n` });
  expect(await run(["tr", "-d", "a", "b\nc", "z"])).toMatchObject({ code: 1, stderr: `tr: extra operand ${diagnosticQuote("b\\nc")}\nTry 'tr --help' for more information.\n` });
  expect(await run(["tr", "a", "b", "c"])).toMatchObject({ code: 1, stderr: `tr: extra operand ${diagnosticQuote("c")}\nTry 'tr --help' for more information.\n` });
  expect(await run(["tr", "a", "b", "c\nd"])).toMatchObject({ code: 1, stderr: `tr: extra operand ${diagnosticQuote("c\\nd")}\nTry 'tr --help' for more information.\n` });
  expect(await run(["tr", "[a*]", "x"])).toMatchObject({ code: 1, stderr: "tr: the [c*] repeat construct may not appear in string1\n" });
  expect(await run(["tr", "[a*0]", "x"])).toMatchObject({ code: 1, stderr: "tr: the [c*] repeat construct may not appear in string1\n" });
  expect(await run(["tr", "[a*bad]", "x"])).toMatchObject(await systemRun(["tr", "[a*bad]", "x"]));
  expect(await run(["tr", "[:lower:]", "[a*b\nad]"])).toMatchObject({ code: 1, stdout: "", stderr: `tr: invalid repeat count ${diagnosticQuote("b\\\\nad")} in [c*n] construct\n` });
  expect(await run(["tr", "[a*999999999999999999999999]", "x"])).toMatchObject(await systemRun(["tr", "[a*999999999999999999999999]", "x"]));
  expect(await run(["tr", "a", ""])).toMatchObject({ code: 1, stderr: "tr: when not truncating set1, string2 must be non-empty\n" });
  expect(await run(["tr", "[:upper:] ", "[:lower:]"])).toMatchObject({ code: 1, stderr: "tr: when translating with string1 longer than string2,\nthe latter string must not end with a character class\n" });
  expect(await run(["tr", "A-Y[:lower:]", "a-z[:upper:]"])).toMatchObject({ code: 1, stderr: "tr: misaligned [:upper:] and/or [:lower:] construct\n" });
  expect(await run(["tr", "-cs", "[:upper:]", "X[Y*]"])).toMatchObject({ code: 1, stderr: "tr: when translating with complemented character classes,\nstring2 must map all characters in the domain to one\n" });
  expect(await run(["tr", "[:fooclass:]", "x"])).toMatchObject({ code: 1, stderr: "tr: invalid character class 'fooclass'\n" });
  expect(await run(["tr", "--bad=4", "a", "b"])).toMatchObject({ code: 1, stderr: "tr: unrecognized option '--bad=4'\nTry 'tr --help' for more information.\n" });
});

test("basenc, od and numfmt handle numeric and formatted text", async () => {
  expect(await run(["basenc", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: basenc [OPTION]... [FILE]\n") });
  expect(await run(["basenc", "--v"])).toMatchObject({ code: 0, stdout: expect.stringContaining("bnu 9.11\n") });
  expect(await run(["basenc", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "basenc: unrecognized option '--bad'\nTry 'basenc --help' for more information.\n" });
  expect(await run(["basenc", "--h=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "basenc: option '--help' doesn't allow an argument\nTry 'basenc --help' for more information.\n" });
  expect(await run(["basenc", "--version=1", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "basenc: option '--version' doesn't allow an argument\nTry 'basenc --help' for more information.\n" });
  expect(await run(["basenc", "--b"])).toMatchObject({ code: 1, stdout: "", stderr: "basenc: option '--b' is ambiguous; possibilities: '--base64' '--base64url' '--base58' '--base32' '--base32hex' '--base16' '--base2msbf' '--base2lsbf'\nTry 'basenc --help' for more information.\n" });
  expect(await run(["basenc", "--base6"])).toMatchObject({ code: 1, stdout: "", stderr: "basenc: option '--base6' is ambiguous; possibilities: '--base64' '--base64url'\nTry 'basenc --help' for more information.\n" });
  expect(await run(["basenc", "--wrap=bad"])).toMatchObject({ code: 1, stdout: "", stderr: `basenc: invalid wrap size: ${diagnosticQuote("bad")}\n` });
  expect(await run(["basenc", "--wrap=bad", "--help"])).toMatchObject(await systemRun(["basenc", "--wrap=bad", "--help"]));
  expect(await run(["basenc", "--base64", "--wrap", "bad", "--help"])).toMatchObject(await systemRun(["basenc", "--base64", "--wrap", "bad", "--help"]));
  expect(await run(["basenc", "--base64", "--wrap=1\n2"])).toMatchObject({ code: 1, stdout: "", stderr: `basenc: invalid wrap size: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["basenc", "--w", "--help", "--base64"], "a")).toMatchObject(await systemRun(["basenc", "--w", "--help", "--base64"], "a"));
  expect(await run(["basenc", "--base64", "--base32"], "abc")).toMatchObject({ code: 0, stdout: "MFRGG===\n" });
  expect(await run(["basenc", "--base32", "--base64"], "abc")).toMatchObject({ code: 0, stdout: "YWJj\n" });
  expect(await run(["basenc", "--base16"], "abc")).toMatchObject({ code: 0, stdout: "616263\n" });
  expect(await run(["basenc", "--base16", "-d"], "616263\n")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["basenc", "--base16", "-d"], "61!!6263\n")).toMatchObject({ code: 1, stdout: "a", stderr: "basenc: invalid input\n" });
  expect(await run(["basenc", "--base16", "-di"], "61!!6263\n")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["basenc", "--base16", "-d"], "616\n")).toMatchObject({ code: 1, stdout: "a", stderr: "basenc: invalid input\n" });
  expect(await run(["basenc", "--base64", "basenc-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "basenc: basenc-missing: No such file or directory\n" });
  expect(await run(["basenc", "--base64", "missing'basenc"])).toMatchObject({ code: 1, stdout: "", stderr: "basenc: \"missing'basenc\": No such file or directory\n" });
  expect(await run(["basenc", "--base64", "missing\nbasenc"])).toMatchObject({ code: 1, stdout: "", stderr: "basenc: 'missing'$'\\n''basenc': No such file or directory\n" });
  await mkdir(join(dir, "basenc-dir"));
  expect(await run(["basenc", "--base64", "basenc-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "basenc: read error: Is a directory\n" });
  await symlink("basenc-loop", join(dir, "basenc-loop"));
  expect(await run(["basenc", "--base64", "basenc-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "basenc: basenc-loop: Too many levels of symbolic links\n" });
  await symlink("loop'basenc", join(dir, "loop'basenc"));
  expect(await run(["basenc", "--base64", "loop'basenc"])).toMatchObject({ code: 1, stdout: "", stderr: "basenc: \"loop'basenc\": Too many levels of symbolic links\n" });
  expect(await run(["basenc", "--base64", "-d", "basenc-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "basenc: basenc-missing: No such file or directory\n" });
  expect(await run(["basenc", "--base32"], "abc")).toMatchObject({ code: 0, stdout: "MFRGG===\n" });
  expect(await run(["basenc", "--base32", "-d"], "MF!!RGG===\n")).toMatchObject({ code: 1, stdout: "a", stderr: "basenc: invalid input\n" });
  expect(await run(["basenc", "--base32", "-di"], "MF!!RGG===\n")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["basenc", "--base32", "-di"], "mfrgg===\n")).toMatchObject({ code: 1, stdout: "", stderr: "basenc: invalid input\n" });
  expect(await run(["basenc", "--base32hex"], "abc")).toMatchObject({ code: 0, stdout: "C5H66===\n" });
  expect(await run(["basenc", "--base32hex", "-d"], "C5H66===")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["basenc", "--base32hex", "-d"], "c5h66===")).toMatchObject({ code: 1, stdout: "", stderr: "basenc: invalid input\n" });
  expect(await run(["basenc", "--base2m"], "ab")).toMatchObject({ code: 0, stdout: "0110000101100010\n" });
  expect(await run(["basenc", "--base2l", "-d"], "1000011001000110")).toMatchObject({ code: 0, stdout: "ab" });
  expect(await run(["basenc", "--z85"], "ABCD")).toMatchObject({ code: 0, stdout: "k%^}b\n" });
  const basencStreamingInput = Uint8Array.from({ length: 8204 }, (_, index) => (index * 131 + 17) & 255);
  for (const algorithm of ["base64", "base64url", "base32", "base32hex", "base16", "base2msbf", "base2lsbf", "z85"]) {
    expect(await run(["basenc", `--${algorithm}`, "--wrap=77"], basencStreamingInput))
      .toMatchObject(await systemRun(["basenc", `--${algorithm}`, "--wrap=77"], basencStreamingInput));
  }
  expect(await run(["basenc", "--z85", "-d"], "hello")).toMatchObject({ code: 0, stdout: "5jXu" });
  expect(await run(["basenc", "--base58"], "Hello World!")).toMatchObject({ code: 0, stdout: "2NEpo7TZRRrLZSi2U\n" });
  expect(await run(["basenc", "--base58", "-d"], "2NEpo7TZRRrLZSi2U")).toMatchObject({ code: 0, stdout: "Hello World!" });
  expect(await run(["basenc", "--base64", "-d"], "YW!!Jj\n")).toMatchObject({ code: 1, stdout: "a", stderr: "basenc: invalid input\n" });
  expect(await run(["basenc", "--base64", "-d"], "mzxw6===")).toMatchObject({ code: 1, stdout: "\uFFFD<p", stderr: "basenc: invalid input\n" });
  expect(await run(["basenc", "--base64", "-di"], "YW!!Jj\n")).toMatchObject({ code: 0, stdout: "abc" });
  expect(await run(["basenc", "--base64", "-di"], "bad!!\n")).toMatchObject({ code: 1, stdout: "m�", stderr: "basenc: invalid input\n" });
  expect(await run(["basenc", "--base64url", "-di"], "YW!!Jj\n")).toMatchObject({ code: 0, stdout: "abc" });
  const odHelp = await run(["od", "--h"]);
  expect(odHelp.code).toBe(0);
  expect(odHelp.stdout).toContain("Usage: od [OPTION]... [FILE]...\n  or:  od [-abcdfilosx]... [FILE] [[+]OFFSET[.][b]]\n  or:  od --traditional [OPTION]... [FILE] [[+]OFFSET[.][b] [+][LABEL][.][b]]\n");
  for (const option of ["-a", "-b", "-c", "-d", "-f", "-i", "-l", "-o", "-s", "-x"]) expect(odHelp.stdout).toContain(`  ${option}\n`);
  expect(await run(["od", "--v"])).toMatchObject({ code: 0, stdout: expect.stringContaining("bnu 9.11\n") });
  await writeFile(join(dir, "od-meta"), "AB");
  expect(await run(["od", "od-meta", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: od [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["od", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "od: unrecognized option '--bad'\nTry 'od --help' for more information.\n" });
  expect(await run(["od", "--h=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "od: option '--help' doesn't allow an argument\nTry 'od --help' for more information.\n" });
  expect(await run(["od", "--help=1", "--version"])).toMatchObject({ code: 1, stdout: "", stderr: "od: option '--help' doesn't allow an argument\nTry 'od --help' for more information.\n" });
  expect(await run(["od", "--a=x"], "AB")).toMatchObject({ code: 0, stdout: "000000 041101\n000002\n" });
  expect(await run(["od", "--r=1"], "AB")).toMatchObject({ code: 0, stdout: "0000000 000101\n0000001\n" });
  expect(await run(["od", "--s=1"], "AB")).toMatchObject({ code: 1, stdout: "", stderr: "od: option '--s=1' is ambiguous; possibilities: '--skip-bytes' '--strings'\nTry 'od --help' for more information.\n" });
  expect(await run(["od", "--read", "--help"], "AB")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid --read-bytes argument '--help'\n" });
  expect(await run(["od", "--read=1", "--help"], "AB")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: od [OPTION]... [FILE]...\n  or:  od [-abcdfilosx]... [FILE] [[+]OFFSET[.][b]]\n") });
  expect(await run(["od", "--read-bytes", "bad", "--help"], "AB")).toMatchObject(await systemRun(["od", "--read-bytes", "bad", "--help"], "AB"));
  expect(await run(["od", "--read-bytes", "1", "--help"], "AB")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: od [OPTION]... [FILE]...\n") });
  expect(await run(["od", "-N", "bad", "--help"], "AB")).toMatchObject(await systemRun(["od", "-N", "bad", "--help"], "AB"));
  expect(await run(["od", "-Nbad", "--help"], "AB")).toMatchObject(await systemRun(["od", "-Nbad", "--help"], "AB"));
  expect(await run(["od", "-N1", "--help"], "AB")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: od [OPTION]... [FILE]...\n") });
  expect(await run(["od", "-A", "x", "-t", "x1"], "AB")).toMatchObject({ code: 0, stdout: "000000 41 42\n000002\n" });
  expect(await run(["od", "--format="], "AB")).toMatchObject({ code: 0, stdout: "0000000 041101\n0000002\n", stderr: "" });
  expect(await run(["od", "--format=", "-t", "x1"], "AB")).toMatchObject({ code: 0, stdout: "0000000 41 42\n0000002\n", stderr: "" });
  expect(await run(["od", "-A", "xx"], "AB")).toMatchObject({ code: 0, stdout: "000000 041101\n000002\n" });
  expect(await run(["od", "--address-radix=nn"], "AB")).toMatchObject({ code: 0, stdout: " 041101\n" });
  expect(await run(["od", "-A", ""], "AB")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid output address radix '\0'; it must be one character from [doxn]\n" });
  expect(await run(["od", "--address-radix="], "AB")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid output address radix '\0'; it must be one character from [doxn]\n" });
  expect(await run(["od", "-An", "-t", "c"], "ABC\n")).toMatchObject({ code: 0, stdout: "   A   B   C  \\n\n" });
  const odControlBytes = Buffer.from([0x61, 0x01, 0x02, 0xff, 0x00, 0x0a]);
  expect(await run(["od", "-An", "-t", "c"], odControlBytes)).toMatchObject(await systemRun(["/usr/bin/od", "-An", "-t", "c"], odControlBytes));
  expect(await run(["od", "-An", "-t", "a"], odControlBytes)).toMatchObject(await systemRun(["/usr/bin/od", "-An", "-t", "a"], odControlBytes));
  expect(await run(["od", "-An", "-t", "u1"], "ABC\n")).toMatchObject({ code: 0, stdout: "  65  66  67  10\n" });
  expect(await run(["od", "--endian=big", "-t", "x2"], "AB")).toMatchObject({ code: 0, stdout: "0000000 4142\n0000002\n" });
  expect(await run(["od", "--endian", "bad", "--help"], "AB")).toMatchObject(await systemRun(["od", "--endian", "bad", "--help"], "AB"));
  expect(await run(["od", "--endian", "big", "--help"], "AB")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: od [OPTION]... [FILE]...\n") });
  expect(await run(["od", "--endian=", "-t", "x2"], "AB")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `od: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--endian")}\nValid arguments are:\n  - ${diagnosticQuote("little")}\n  - ${diagnosticQuote("big")}\nTry 'od --help' for more information.\n`,
  });
  expect(await run(["od", "--endian=", "--help"], "AB")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `od: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--endian")}\nValid arguments are:\n  - ${diagnosticQuote("little")}\n  - ${diagnosticQuote("big")}\nTry 'od --help' for more information.\n`,
  });
  expect(await run(["od", "--endian=bad", "-t", "x2"], "AB")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `od: invalid argument ${diagnosticQuote("bad")} for ${diagnosticQuote("--endian")}\nValid arguments are:\n  - ${diagnosticQuote("little")}\n  - ${diagnosticQuote("big")}\nTry 'od --help' for more information.\n`,
  });
  expect(await run(["od", "--endian=bad\nmode", "-t", "x2"], "AB")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `od: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--endian")}\nValid arguments are:\n  - ${diagnosticQuote("little")}\n  - ${diagnosticQuote("big")}\nTry 'od --help' for more information.\n`,
  });
  expect(await run(["od", "--endian", "-t", "x2"], "AB")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `od: invalid argument ${diagnosticQuote("-t")} for ${diagnosticQuote("--endian")}\nValid arguments are:\n  - ${diagnosticQuote("little")}\n  - ${diagnosticQuote("big")}\nTry 'od --help' for more information.\n`,
  });
  expect(await run(["od", "-A", "d", "-j", "2", "-N", "3", "-t", "x1"], "abcdef")).toMatchObject({ code: 0, stdout: "0000002 63 64 65\n0000005\n" });
  expect(await run(["od", "-x"], "ABCD")).toMatchObject({ code: 0, stdout: "0000000 4241 4443\n0000004\n" });
  expect(await run(["od", "-s"], "ABCD")).toMatchObject({ code: 0, stdout: "0000000  16961  17475\n0000004\n" });
  expect(await run(["od", "-bx"], "ABCD")).toMatchObject({ code: 0, stdout: "0000000 101 102 103 104\n           4241    4443\n0000004\n" });
  expect(await run(["od", "-An", "-N", "+1", "-t", "x1"], "abcd")).toMatchObject({ code: 0, stdout: " 61\n" });
  expect(await run(["od", "-An", "-j", "+1", "-t", "x1"], "abcd")).toMatchObject({ code: 0, stdout: " 62 63 64\n" });
  expect(await run(["od", "-An", "--read-bytes=+1", "-t", "x1"], "abcd")).toMatchObject({ code: 0, stdout: " 61\n" });
  expect(await run(["od", "-An", "--skip-bytes=+1", "-t", "x1"], "abcd")).toMatchObject({ code: 0, stdout: " 62 63 64\n" });
  expect(await run(["od", "-j", "bad"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid suffix in -j argument 'bad'\n" });
  expect(await run(["od", "-j", ""], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid -j argument ''\n" });
  expect(await run(["od", "-j", "-1"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid -j argument '-1'\n" });
  expect(await run(["od", "-j", "1R"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: -j argument '1R' too large\n" });
  expect(await run(["od", "-j", "1RB"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: -j argument '1RB' too large\n" });
  expect(await run(["od", "-N", "bad"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid suffix in -N argument 'bad'\n" });
  expect(await run(["od", "-N", ""], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid -N argument ''\n" });
  expect(await run(["od", "-N", "-1"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid -N argument '-1'\n" });
  expect(await run(["od", "-N", "1Y"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: -N argument '1Y' too large\n" });
  expect(await run(["od", "--skip-bytes=bad"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid suffix in --skip-bytes argument 'bad'\n" });
  expect(await run(["od", "--skip-bytes=bad", "--help"])).toMatchObject(await systemRun(["od", "--skip-bytes=bad", "--help"]));
  expect(await run(["od", "--skip-bytes", "bad", "--help"], "AB")).toMatchObject(await systemRun(["od", "--skip-bytes", "bad", "--help"], "AB"));
  expect(await run(["od", "-j", "bad", "--help"], "AB")).toMatchObject(await systemRun(["od", "-j", "bad", "--help"], "AB"));
  expect(await run(["od", "--skip-bytes="], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid --skip-bytes argument ''\n" });
  expect(await run(["od", "--read-bytes=bad"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid suffix in --read-bytes argument 'bad'\n" });
  expect(await run(["od", "--read-bytes=bad", "--help"])).toMatchObject(await systemRun(["od", "--read-bytes=bad", "--help"]));
  expect(await run(["od", "--read-bytes="], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid --read-bytes argument ''\n" });
  expect(await run(["od", "-An", "-w2", "-t", "x1"], "abcd")).toMatchObject({ code: 0, stdout: " 61 62\n 63 64\n" });
  expect(await run(["od", "-t", "x1"], "\0".repeat(64))).toMatchObject({ code: 0, stdout: "0000000 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n*\n0000100\n" });
  expect(await run(["od", "-v", "-t", "x1", "-w16"], "\0".repeat(32))).toMatchObject({ code: 0, stdout: "0000000 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n0000020 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00\n0000040\n" });
  expect(await run(["od", "-w", "bad"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: bad: No such file or directory\n" });
  expect(await run(["od", "-wbad", "--help"], "AB")).toMatchObject(await systemRun(["od", "-wbad", "--help"], "AB"));
  expect(await run(["od", "-w4"], "AB\n")).toMatchObject({ code: 0, stdout: "0000000 041101 000012\n0000003\n" });
  expect(await run(["od", "--width=bad"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid --width argument 'bad'\n" });
  expect(await run(["od", "--width=bad", "--help"])).toMatchObject(await systemRun(["od", "--width=bad", "--help"]));
  expect(await run(["od", "--width", "bad", "--help"], "AB")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: od [OPTION]... [FILE]...\n") });
  expect(await run(["od", "--width=1x"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid suffix in --width argument '1x'\n" });
  expect(await run(["od", "--width=1x", "--help"])).toMatchObject(await systemRun(["od", "--width=1x", "--help"]));
  expect(await run(["od", "-w1x"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid suffix in -w argument '1x'\n" });
  expect(await run(["od", "-w-1"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid -w argument '-1'\n" });
  expect(await run(["od", "-w0"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid -w argument '0'\n" });
  expect(await run(["od", "-w4", "-tcz"], "x")).toMatchObject({ code: 0, stdout: "0000000   x              >x<\n0000001\n" });
  expect(await run(["od", "-An", "-c", "-j", "3"], "abcd")).toMatchObject({ code: 0, stdout: "   d\n" });
  expect(await run(["od", "-An", "-j", "4"], "abcd")).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["od", "-An", "-j", "1kB"], "abcd")).toMatchObject({ code: 1, stdout: "", stderr: "od: cannot skip past end of combined input\n" });
  await writeFile(join(dir, "od-skip"), "abc");
  expect(await run(["od", "-An", "-t", "x1", "-j", "3", "od-skip", "od-skip"])).toMatchObject({ code: 0, stdout: " 61 62 63\n" });
  expect(await run(["od", "-j1", "/dev/null"])).toMatchObject({ code: 0, stdout: "0000001\n" });
  expect(await run(["od", "-j1", "-N0", "/dev/null"])).toMatchObject({ code: 0, stdout: "0000001\n" });
  expect(await run(["od", "--traditional"], "")).toMatchObject({ code: 0, stdout: "0000000\n" });
  expect(await run(["od", "--traditional", "-t", "x1", "1", "2"], "abcdef")).toMatchObject({ code: 0, stdout: "0000001 (0000002) 62 63 64 65 66\n0000006 (0000007)\n" });
  await writeFile(join(dir, "od-traditional"), "abcdef\n");
  expect(await run(["od", "--traditional", "od-traditional", "+1", "bad"])).toMatchObject({ code: 1, stdout: "", stderr: `od: extra operand ${diagnosticQuote("+1")}\nod: compatibility mode supports at most one file\nTry 'od --help' for more information.\n` });
  expect(await run(["od", "--traditional", "od-traditional", "bad", "+1"])).toMatchObject({ code: 1, stdout: "", stderr: `od: extra operand ${diagnosticQuote("bad")}\nod: compatibility mode supports at most one file\nTry 'od --help' for more information.\n` });
  expect(await run(["od", "--traditional", "od-traditional", "first\nfile"])).toMatchObject({ code: 1, stdout: "", stderr: `od: extra operand ${diagnosticQuote("first\\nfile")}\nod: compatibility mode supports at most one file\nTry 'od --help' for more information.\n` });
  expect(await run(["od", "--traditional", "od-traditional", "08"])).toMatchObject({ code: 1, stdout: "", stderr: `od: extra operand ${diagnosticQuote("08")}\nod: compatibility mode supports at most one file\nTry 'od --help' for more information.\n` });
  expect(await run(["od", "--traditional", "od-traditional", "+08"])).toMatchObject({ code: 1, stdout: "", stderr: `od: extra operand ${diagnosticQuote("+08")}\nod: compatibility mode supports at most one file\nTry 'od --help' for more information.\n` });
  expect(await run(["od", "--traditional", "-j2", "od-traditional", "+1"])).toMatchObject({ code: 0, stdout: "0000001 061542 062544 005146\n0000007\n" });
  expect(await run(["od", "--traditional", "--skip-bytes=2", "-N2", "od-traditional", "+1", "+3"])).toMatchObject({ code: 0, stdout: "0000001 (0000003) 061542\n0000003 (0000005)\n" });
  expect(await shell('printf abcdefg | ("$BUN" "$BNU" od -An -N3 -c; "$BUN" "$BNU" od -An -N3 -c)')).toMatchObject({ code: 0, stdout: "   a   b   c\n   d   e   f\n" });
  expect(await run(["od", "-t", "x"], "ABCDEFGH\n")).toMatchObject({ code: 0, stdout: "0000000 44434241 48474645 0000000a\n0000011\n" });
  expect(await run(["od", "-t", "xz"], "ABCDEFGH\n")).toMatchObject({ code: 0, stdout: "0000000 44434241 48474645 0000000a           >ABCDEFGH.<\n0000011\n" });
  expect(await run(["od", "-t", "u"], "ABCDEFGH\n")).toMatchObject({ code: 0, stdout: "0000000 1145258561 1212630597         10\n0000011\n" });
  expect(await run(["od", "-An", "-t", "x8"], "abcdefgh")).toMatchObject({ code: 0, stdout: " 6867666564636261\n" });
  expect(await run(["od", "-t", "x1c"], "AB\n")).toMatchObject({ code: 0, stdout: "0000000  41  42  0a\n          A   B  \\n\n0000003\n" });
  expect(await run(["od", "-t", "x1d1"], "AB\n")).toMatchObject({ code: 0, stdout: "0000000   41   42   0a\n          65   66   10\n0000003\n" });
  expect(await run(["od", "-An", "-t", "d1x1"], "AB\n")).toMatchObject({ code: 0, stdout: "   65   66   10\n   41   42   0a\n" });
  expect(await run(["od", "-t", "u1x1"], "AB\n")).toMatchObject({ code: 0, stdout: "0000000  65  66  10\n         41  42  0a\n0000003\n" });
  expect(await run(["od", "-An", "-t", "x1", "-t", "c"], "AB\n")).toMatchObject({ code: 0, stdout: "  41  42  0a\n   A   B  \\n\n" });
  expect(await run(["od", "-t", "x1cz"], "AB\n")).toMatchObject({ code: 0, stdout: "0000000  41  42  0a\n          A   B  \\n                                                      >AB.<\n0000003\n" });
  const floatBytes = Buffer.from([0, 0, 0x80, 0x3f, 0, 0, 0, 0x40]);
  expect(await run(["od", "-An", "-t", "f", "--endian=little"], floatBytes)).toMatchObject({ code: 0, stdout: "        2.000000473111868\n" });
  expect(await run(["od", "-An", "-t", "fF", "--endian=little"], floatBytes)).toMatchObject({ code: 0, stdout: "               1               2\n" });
  expect(await run(["od", "-An", "-t", "f2"], Buffer.from([1, 2, 3]))).toMatchObject({ code: 0, stderr: "" });
  expect(await run(["od", "-An", "-t", "f4"], Buffer.from([1, 2, 3]))).toMatchObject({ code: 0, stderr: "" });
  expect(await run(["od", "-An", "-t", "f8"], Buffer.from([1, 2, 3]))).toMatchObject({ code: 0, stderr: "" });
  expect(await run(["od", "-An", "-t", "fH"], Buffer.from([0x78, 0x0a]))).toMatchObject({ code: 0, stdout: "   0.00019741058\n" });
  expect(await run(["od", "-An", "-t", "fB"], Buffer.from([0x78, 0x0a]))).toMatchObject({ code: 0, stdout: "   1.1940766e-32\n" });
  expect(await run(["od", "-t", "bad"], "x\n")).toMatchObject(await systemRun(["od", "-t", "bad"], "x\n"));
  expect(await run(["od", "-t", "f3z"], "x\n")).toMatchObject(await systemRun(["od", "-t", "f3z"], "x\n"));
  expect(await run(["od", "-A", "q"], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid output address radix 'q'; it must be one character from [doxn]\n" });
  expect(await run(["od", "-t", "q1"], "x\n")).toMatchObject(await systemRun(["od", "-t", "q1"], "x\n"));
  expect(await run(["od", "-t", "a1"], "x\n")).toMatchObject(await systemRun(["od", "-t", "a1"], "x\n"));
  expect(await run(["od", "-t", "c1z"], "x\n")).toMatchObject(await systemRun(["od", "-t", "c1z"], "x\n"));
  expect(await run(["od", "-t", "x9"], "x\n")).toMatchObject(await systemRun(["od", "-t", "x9"], "x\n"));
  expect(await run(["od", "-t", "q\n1"], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: `od: invalid character 'q' in type string ${diagnosticQuote("q\\n1")}\n` });
  expect(await run(["od", "-t", "x1\nq"], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: `od: invalid character '\n' in type string ${diagnosticQuote("x1\\nq")}\n` });
  expect(await run(["od", "-t", "f3\nz"], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: `od: invalid type string ${diagnosticQuote("f3\\nz")};\nthis system doesn't provide a 3-byte floating point type\n` });
  expect(await run(["od", "-t", "x9\nz"], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: `od: invalid type string ${diagnosticQuote("x9\\nz")};\nthis system doesn't provide a 9-byte integral type\n` });
  expect(await run(["od", "-N10", "-S10"], "          ")).toMatchObject({ code: 0, stdout: "0000000           \n" });
  expect(await run(["od", "-S10"], "          ")).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["od", "-S0"], Buffer.from([0]))).toMatchObject({ code: 0, stdout: "0000000 \n" });
  expect(await run(["od", "--strings=0"], Buffer.from([0x61, 0, 0]))).toMatchObject({ code: 0, stdout: "0000000 a\n0000002 \n" });
  expect(await run(["od", "-S", ""], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid -S argument ''\n" });
  expect(await run(["od", "-S", "bad"], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid suffix in -S argument 'bad'\n" });
  expect(await run(["od", "-S", "bad", "--help"], "x\n")).toMatchObject(await systemRun(["od", "-S", "bad", "--help"], "x\n"));
  expect(await run(["od", "-S", "x"], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid -S argument 'x'\n" });
  expect(await run(["od", "-S", "1R"], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: "od: -S argument '1R' too large\n" });
  expect(await run(["od", "-S", "R"], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: "od: -S argument 'R' too large\n" });
  expect(await run(["od", "-S", "QB"], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: "od: -S argument 'QB' too large\n" });
  expect(await run(["od", "--strings="], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid --strings argument ''\n" });
  expect(await run(["od", "--strings=bad"], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid suffix in --strings argument 'bad'\n" });
  expect(await run(["od", "--strings=bad", "--help"])).toMatchObject(await systemRun(["od", "--strings=bad", "--help"]));
  expect(await run(["od", "--strings", "bad", "--help"], "x\n")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: od [OPTION]... [FILE]...\n") });
  expect(await run(["od", "--strings=-1"], "x\n")).toMatchObject({ code: 1, stdout: "", stderr: "od: invalid --strings argument '-1'\n" });
  expect(await run(["od", "--strings=-1", "--help"])).toMatchObject(await systemRun(["od", "--strings=-1", "--help"]));
  await writeFile(join(dir, "1"), "xy");
  expect(await run(["od", "-An", "-tx1", "1"])).toMatchObject({ code: 0, stdout: " 78 79\n" });
  expect(await run(["od", "-An", "-tx1", "1."])).toMatchObject({ code: 1, stderr: "od: 1.: No such file or directory\n" });
  await mkdir(join(dir, "od-dir"));
  expect(await run(["od", "od-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "od: od-dir: Is a directory\n" });
  expect(await run(["od", "+1."], "a")).toMatchObject({ code: 0, stdout: "0000001\n" });
  expect(await run(["od", "+1", "-tx1"], "abcdef")).toMatchObject({ code: 1, stderr: "od: +1: No such file or directory\n" });
  expect(await run(["od", "+1.b"], "a".repeat(512))).toMatchObject({ code: 0, stdout: "0001000\n" });
  expect(await run(["od", "+ 0"], "")).toMatchObject({ code: 1, stderr: "od: '+ 0': No such file or directory\n" });
  expect(await run(["numfmt", "--from=si", "1K", "2M"])).toMatchObject({ code: 0, stdout: "1000\n2000000\n" });
  expect(await run(["numfmt", "12\n3"])).toMatchObject(await systemRun(["/usr/bin/numfmt", "12\n3"]));
  expect(await run(["numfmt", "--field=2", "a\n12"])).toMatchObject(await systemRun(["/usr/bin/numfmt", "--field=2", "a\n12"]));
  expect(await run(["numfmt", "--h"])).toMatchObject({ code: 1, stdout: "", stderr: "numfmt: option '--h' is ambiguous; possibilities: '--header' '--help'\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--v"])).toMatchObject({ code: 0, stdout: expect.stringContaining("bnu 9.11\n") });
  expect(await run(["numfmt", "1", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: numfmt [OPTION]... [NUMBER]...\n"), stderr: "" });
  expect(await run(["numfmt", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "numfmt: unrecognized option '--bad'\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--version=1", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "numfmt: option '--version' doesn't allow an argument\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--f=si", "1K"])).toMatchObject({ code: 1, stdout: "", stderr: "numfmt: option '--f=si' is ambiguous; possibilities: '--from' '--from-unit' '--field' '--format'\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--fr=si", "1K"])).toMatchObject({ code: 1, stdout: "", stderr: "numfmt: option '--fr=si' is ambiguous; possibilities: '--from' '--from-unit'\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--for=%5f", "1"])).toMatchObject({ code: 0, stdout: "    1\n" });
  expect(await run(["numfmt", "--from", "--help", "1"])).toMatchObject(await systemRun(["numfmt", "--from", "--help", "1"]));
  expect(await run(["numfmt", "--from", "bad", "--help"])).toMatchObject(await systemRun(["numfmt", "--from", "bad", "--help"]));
  expect(await run(["numfmt", "--from", "si", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: numfmt [OPTION]... [NUMBER]...\n") });
  expect(await run(["numfmt", "--from=si", "--help", "1K"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: numfmt [OPTION]... [NUMBER]...\n") });
  expect(await run(["numfmt", "--from=s", "1K"])).toMatchObject({ code: 0, stdout: "1000\n" });
  expect(await run(["numfmt", "--from=a", "1Ki"])).toMatchObject({ code: 0, stdout: "1024\n" });
  expect(await run(["numfmt", "--from=iec", "1K"])).toMatchObject({ code: 0, stdout: "1024\n" });
  expect(await run(["numfmt", "--from=iec-i", "1Ki"])).toMatchObject({ code: 0, stdout: "1024\n" });
  expect(await run(["numfmt", "--from=auto", "1Ki"])).toMatchObject({ code: 0, stdout: "1024\n" });
  expect(await run(["numfmt", "--from=si", "1.5"])).toMatchObject({ code: 0, stdout: "1.5\n" });
  expect(await run(["numfmt", "--from=iec", "1.25"])).toMatchObject({ code: 0, stdout: "1.25\n" });
  expect(await run(["numfmt", "--from=si", "1.25K"])).toMatchObject({ code: 0, stdout: "1250\n" });
  expect(await run(["numfmt", "--from=iec", "1KB"])).toMatchObject({ code: 2, stderr: `numfmt: invalid suffix in input ${diagnosticQuote("1KB")}: ${diagnosticQuote("B")}\n` });
  expect(await run(["numfmt", "--from=si", "1Ki"])).toMatchObject({ code: 2, stderr: `numfmt: invalid suffix in input ${diagnosticQuote("1Ki")}: ${diagnosticQuote("i")}\n` });
  expect(await run(["numfmt", "--from=auto", "1KiB"])).toMatchObject({ code: 2, stderr: `numfmt: invalid suffix in input ${diagnosticQuote("1KiB")}: ${diagnosticQuote("B")}\n` });
  expect(await run(["numfmt", "--from=auto", "1B"])).toMatchObject({ code: 2, stderr: `numfmt: invalid suffix in input: ${diagnosticQuote("1B")}\n` });
  expect(await run(["numfmt", "--from=auto", "1i"])).toMatchObject({ code: 2, stderr: `numfmt: invalid suffix in input: ${diagnosticQuote("1i")}\n` });
  expect(await run(["numfmt", "--invalid=abort", "bad", "1"])).toMatchObject({ code: 2, stdout: "", stderr: `numfmt: invalid number: ${diagnosticQuote("bad")}\n` });
  expect(await run(["numfmt", "--invalid=abort", "1", "bad", "2"])).toMatchObject({ code: 2, stdout: "1\n", stderr: `numfmt: invalid number: ${diagnosticQuote("bad")}\n` });
  expect(await run(["numfmt", "--header=1"], "h\n1\nbad\n2\n")).toMatchObject({ code: 2, stdout: "h\n1\n", stderr: `numfmt: invalid number: ${diagnosticQuote("bad")}\n` });
  expect(await run(["numfmt", "-d,", "12\n3"])).toMatchObject(await systemRun(["/usr/bin/numfmt", "-d,", "12\n3"]));
  expect(await run(["numfmt", "-d,", "12\t3"])).toMatchObject(await systemRun(["/usr/bin/numfmt", "-d,", "12\t3"]));
  expect(await run(["numfmt", "--zero-terminated"], "1\u0002\0")).toMatchObject({ code: 2, stdout: "", stderr: `numfmt: invalid suffix in input: ${diagnosticQuote("1\\002")}\n` });
  const rawNumfmt = Bun.spawn(["/bin/sh", "-c", `printf '12\\377\\n' | LC_ALL=C ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} numfmt >numfmt-raw-out 2>numfmt-raw-err`], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await rawNumfmt.exited).toBe(2);
  expect(await readFile(join(dir, "numfmt-raw-out"), "utf8")).toBe("");
  expect([...await readFile(join(dir, "numfmt-raw-err"))]).toEqual([0x6e, 0x75, 0x6d, 0x66, 0x6d, 0x74, 0x3a, 0x20, 0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0x20, 0x73, 0x75, 0x66, 0x66, 0x69, 0x78, 0x20, 0x69, 0x6e, 0x20, 0x69, 0x6e, 0x70, 0x75, 0x74, 0x3a, 0x20, 0x27, 0x31, 0x32, 0x5c, 0x33, 0x37, 0x37, 0x27, 0x0a]);
  const rawHeaderNumfmt = Bun.spawn(["/bin/sh", "-c", `printf 'h\\n12\\377\\n' | LC_ALL=C ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} numfmt --header=1 >numfmt-header-raw-out 2>numfmt-header-raw-err`], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await rawHeaderNumfmt.exited).toBe(2);
  expect(await readFile(join(dir, "numfmt-header-raw-out"), "utf8")).toBe("h\n");
  expect([...await readFile(join(dir, "numfmt-header-raw-err"))]).toEqual([0x6e, 0x75, 0x6d, 0x66, 0x6d, 0x74, 0x3a, 0x20, 0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0x20, 0x73, 0x75, 0x66, 0x66, 0x69, 0x78, 0x20, 0x69, 0x6e, 0x20, 0x69, 0x6e, 0x70, 0x75, 0x74, 0x3a, 0x20, 0x27, 0x31, 0x32, 0x5c, 0x33, 0x37, 0x37, 0x27, 0x0a]);
  expect(await run(["numfmt", "--from"])).toMatchObject({ code: 1, stderr: "numfmt: option '--from' requires an argument\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--bad=4"])).toMatchObject({ code: 1, stderr: "numfmt: unrecognized option '--bad=4'\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--from=bad", "1"])).toMatchObject(await systemRun(["numfmt", "--from=bad", "1"]));
  expect(await run(["numfmt", "--from=bad\nmode", "1"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `numfmt: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--from")}\nValid arguments are:\n  - ${diagnosticQuote("none")}\n  - ${diagnosticQuote("auto")}\n  - ${diagnosticQuote("si")}\n  - ${diagnosticQuote("iec")}\n  - ${diagnosticQuote("iec-i")}\nTry 'numfmt --help' for more information.\n`,
  });
  expect(await run(["numfmt", "--from=", "1"])).toMatchObject(await systemRun(["numfmt", "--from=", "1"]));
  expect(await run(["numfmt", "--from=", "--help"])).toMatchObject(await systemRun(["numfmt", "--from=", "--help"]));
  expect(await run(["numfmt", "-d"])).toMatchObject({ code: 1, stderr: "numfmt: option requires an argument -- 'd'\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--to=iec", "2048"])).toMatchObject({ code: 0, stdout: "2.0K\n" });
  expect(await run(["numfmt", "--to=s", "1000"])).toMatchObject({ code: 0, stdout: "1.0k\n" });
  expect(await run(["numfmt", "--to=i", "1000"])).toMatchObject(await systemRun(["numfmt", "--to=i", "1000"]));
  expect(await run(["numfmt", "--to", "bad", "--help"])).toMatchObject(await systemRun(["numfmt", "--to", "bad", "--help"]));
  expect(await run(["numfmt", "--to=bad", "1"])).toMatchObject(await systemRun(["numfmt", "--to=bad", "1"]));
  expect(await run(["numfmt", "--to=auto", "1"])).toMatchObject(await systemRun(["numfmt", "--to=auto", "1"]));
  expect(await run(["numfmt", "--to=", "1"])).toMatchObject(await systemRun(["numfmt", "--to=", "1"]));
  expect(await run(["numfmt", "--to=", "--help"])).toMatchObject(await systemRun(["numfmt", "--to=", "--help"]));
  expect(await run(["numfmt", "--round=from-zero", "--to=si", "1500"])).toMatchObject({ code: 0, stdout: "1.5k\n" });
  expect(await run(["numfmt", "--round=f", "--to=si", "1500"])).toMatchObject({ code: 0, stdout: "1.5k\n" });
  expect(await run(["numfmt", "--round=n", "--to=si", "1500"])).toMatchObject({ code: 0, stdout: "1.5k\n" });
  expect(await run(["numfmt", "--round", "bad", "--help"])).toMatchObject(await systemRun(["numfmt", "--round", "bad", "--help"]));
  expect(await run(["numfmt", "--round=bad", "--to=si", "1500"])).toMatchObject(await systemRun(["numfmt", "--round=bad", "--to=si", "1500"]));
  expect(await run(["numfmt", "--round=", "--help"])).toMatchObject(await systemRun(["numfmt", "--round=", "--help"]));
  expect(await run(["numfmt", "--round=bad", "--help"])).toMatchObject(await systemRun(["numfmt", "--round=bad", "--help"]));
  expect(await run(["numfmt", "--round=bad\nmode", "--to=si", "1500"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `numfmt: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--round")}\nValid arguments are:\n  - ${diagnosticQuote("up")}\n  - ${diagnosticQuote("down")}\n  - ${diagnosticQuote("from-zero")}\n  - ${diagnosticQuote("towards-zero")}\n  - ${diagnosticQuote("nearest")}\nTry 'numfmt --help' for more information.\n`,
  });
  expect(await run(["numfmt", "--invalid=bad", "1"])).toMatchObject(await systemRun(["numfmt", "--invalid=bad", "1"]));
  expect(await run(["numfmt", "--invalid=i", "bad"])).toMatchObject({ code: 0, stdout: "bad\n", stderr: "" });
  expect(await run(["numfmt", "--invalid=w", "bad"])).toMatchObject({ code: 0, stdout: "bad\n", stderr: `numfmt: invalid number: ${diagnosticQuote("bad")}\n` });
  expect(await run(["numfmt", "--invalid", "bad", "--help"])).toMatchObject(await systemRun(["numfmt", "--invalid", "bad", "--help"]));
  expect(await run(["numfmt", "--invalid=", "--help"])).toMatchObject(await systemRun(["numfmt", "--invalid=", "--help"]));
  expect(await run(["numfmt", "--invalid=bad", "--help"])).toMatchObject(await systemRun(["numfmt", "--invalid=bad", "--help"]));
  expect(await run(["numfmt", "--to=si", "--suffix=B", "--padding=6", "1000", "2000000"])).toMatchObject({ code: 0, stdout: " 1.0kB\n 2.0MB\n" });
  expect(await run(["numfmt", "--to=si", "--", "998.9", "999.01", "-999.01"])).toMatchObject({ code: 0, stdout: "999\n1.0k\n-1.0k\n" });
  expect(await run(["numfmt", "--to=si", "--format=%.2f", "--", "998.9", "999.01", "-999.01"])).toMatchObject({ code: 0, stdout: "999.00\n1.00k\n-1.00k\n" });
  expect(await run(["numfmt", "--to=si", "--round=nearest", "--format=%.2f", "--", "999.5", "-999.5"])).toMatchObject({ code: 0, stdout: "1.00k\n-1.00k\n" });
  expect(await run(["numfmt", "--format=%+5f", "--", "1", "-1"])).toMatchObject({ code: 0, stdout: "    1\n   -1\n" });
  expect(await run(["numfmt", "--format=%0+5f", "--", "1", "-1"])).toMatchObject({ code: 0, stdout: "00001\n-0001\n" });
  expect(await run(["numfmt", "--format=%-+5f", "1"])).toMatchObject(await systemRun(["numfmt", "--format=%-+5f", "1"]));
  expect(await run(["numfmt", "--format=%s", "1"])).toMatchObject(await systemRun(["numfmt", "--format=%s", "1"]));
  expect(await run(["numfmt", "--format", "%s", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: numfmt [OPTION]... [NUMBER]...\n") });
  expect(await run(["numfmt", "--format", "%f%f", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: numfmt [OPTION]... [NUMBER]...\n") });
  expect(await run(["numfmt", "--format=%s\nx", "1"])).toMatchObject({ code: 1, stdout: "", stderr: `numfmt: invalid format ${diagnosticQuote("%s\\nx")}, directive must be %[0]['][-][N][.][N]f\n` });
  expect(await run(["numfmt", "--format=%f%f", "1"])).toMatchObject(await systemRun(["numfmt", "--format=%f%f", "1"]));
  expect(await run(["numfmt", "--format=%f\n%f", "1"])).toMatchObject({ code: 1, stdout: "", stderr: `numfmt: format ${diagnosticQuote("%f\\n%f")} has too many % directives\n` });
  expect(await run(["numfmt", "--padding=+3", "1"])).toMatchObject({ code: 0, stdout: "  1\n" });
  expect(await run(["numfmt", "--padding=+0", "1"])).toMatchObject(await systemRun(["numfmt", "--padding=+0", "1"]));
  expect(await run(["numfmt", "--padding", "bad", "--help"])).toMatchObject(await systemRun(["numfmt", "--padding", "bad", "--help"]));
  expect(await run(["numfmt", "--padding", "3", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: numfmt [OPTION]... [NUMBER]...\n") });
  expect(await run(["numfmt", "--padding=bad", "1"])).toMatchObject(await systemRun(["numfmt", "--padding=bad", "1"]));
  expect(await run(["numfmt", "--header=1", "--field=2", "--from=si", "--invalid=ignore"], "name size\na 1K\nb bad\n")).toMatchObject({ code: 0, stdout: "name size\na 1000\nb bad\n" });
  expect(await run(["numfmt", "--header=+1", "--from=si"], "size\n1K\n")).toMatchObject({ code: 0, stdout: "size\n1000\n" });
  expect(await run(["numfmt", "--header=bad", "1"])).toMatchObject(await systemRun(["numfmt", "--header=bad", "1"]));
  expect(await run(["numfmt", "--header", "bad", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: numfmt [OPTION]... [NUMBER]...\n") });
  expect(await run(["numfmt", "--field=", "1"])).toMatchObject({ code: 1, stdout: "", stderr: "numfmt: fields are numbered from 1\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--field", "bad", "--help"])).toMatchObject(await systemRun(["numfmt", "--field", "bad", "--help"]));
  expect(await run(["numfmt", "--field=bad", "--help"])).toMatchObject(await systemRun(["numfmt", "--field=bad", "--help"]));
  expect(await run(["numfmt", "--field", "--help", "--version"])).toMatchObject({ code: 1, stdout: "", stderr: "numfmt: invalid field range\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--field=--help", "--version"])).toMatchObject({ code: 1, stdout: "", stderr: "numfmt: invalid field range\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--field", "1", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: numfmt [OPTION]... [NUMBER]...\n") });
  expect(await run(["numfmt", "--field=1,,2", "1 2"])).toMatchObject({ code: 1, stdout: "", stderr: "numfmt: fields are numbered from 1\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--field=9999999999999999999", "--from=si", "1K"])).toMatchObject({ code: 0, stdout: "1K\n" });
  expect(await run(["numfmt", "--field=1,9999999999999999999", "--from=si", "1K"])).toMatchObject({ code: 0, stdout: "1000\n" });
  expect(await run(["numfmt", "--field=99999999999999999999", "--from=si", "1K"])).toMatchObject({ code: 1, stderr: "numfmt: field number '99999999999999999999' is too large\nTry 'numfmt --help' for more information.\n" });
  expect(await run(["numfmt", "--field=1.2", "1"])).toMatchObject(await systemRun(["numfmt", "--field=1.2", "1"]));
  expect(await run(["numfmt", "--field=1:2", "1"])).toMatchObject(await systemRun(["numfmt", "--field=1:2", "1"]));
  expect(await run(["numfmt", "--from-unit=2K", "1"])).toMatchObject({ code: 0, stdout: "2000\n" });
  expect(await run(["numfmt", "--to-unit=1K", "1000"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["numfmt", "--from-unit", "1KB", "--help"])).toMatchObject(await systemRun(["numfmt", "--from-unit", "1KB", "--help"]));
  expect(await run(["numfmt", "--from-unit", "2K", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: numfmt [OPTION]... [NUMBER]...\n") });
  expect(await run(["numfmt", "--from-unit=1KB", "1"])).toMatchObject(await systemRun(["numfmt", "--from-unit=1KB", "1"]));
  expect(await run(["numfmt", "--from-unit=1\n2", "1"])).toMatchObject({ code: 1, stdout: "", stderr: `numfmt: invalid unit size: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["numfmt", "-d", ":", "--field=2", "--from=iec"], "a:2K\n")).toMatchObject({ code: 0, stdout: "a:2048\n" });
  expect(await run(["numfmt", "-d", "ab", "--help"])).toMatchObject(await systemRun(["numfmt", "-d", "ab", "--help"]));
  expect(await run(["numfmt", "--delimiter=ab", "--help"])).toMatchObject(await systemRun(["numfmt", "--delimiter=ab", "--help"]));
  expect(await run(["numfmt", "-d", ":", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: numfmt [OPTION]... [NUMBER]...\n") });
  expect(await run(["numfmt", "-d", "ab", "--field=2", "1ab2"])).toMatchObject({ code: 1, stderr: "numfmt: the delimiter must be a single character\n" });
  expect(await run(["numfmt", "-d", "ç", "--field=2", "aç2"])).toMatchObject({ code: 0, stdout: "aç2\n" });
  expect(await run(["numfmt", "-d", "ç", "--field=2", "aç2"], "", { env: { LC_ALL: "C" } })).toMatchObject({ code: 1, stderr: "numfmt: the delimiter must be a single character\n" });
  expect(await shell(`bash -c 'LC_ALL=C "$BUN" "$BNU" numfmt -d $'"'"'\\302'"'"' --field=2 --invalid=ignore $'"'"'1\\302\\2672K'"'"''`)).toMatchObject({ code: 0, stdout: "1·2K\n" });
  expect(await shell(`bash -c 'delim=$(printf "\\242\\343"); input=$(printf "1\\242\\3432K"); LC_ALL=zh_CN.gb18030 "$BUN" "$BNU" numfmt --from=si --field=2 -d "$delim" "$input" | /usr/bin/od -An -tx1 | tr -d " \\n"'`)).toMatchObject({ code: 0, stdout: "31a2e3323030300a" });
  expect(await shell(`bash -c 'delim=$(printf "\\377"); input=$(printf "1\\3772K"); LC_ALL=zh_CN.gb18030 "$BUN" "$BNU" numfmt --from=si --field=2 -d "$delim" "$input" | /usr/bin/od -An -tx1 | tr -d " \\n"'`)).toMatchObject({ code: 0, stdout: "31ff323030300a" });
});

test("fmt handles formatting options and file diagnostics", async () => {
  expect(await run(["fmt", "-w", "10"], "alpha beta gamma\n")).toMatchObject({ code: 0, stdout: "alpha beta\ngamma\n" });
  await writeFile(join(dir, "fmt-raw"), Uint8Array.of(0xff, 0x20, 0x61, 0x20, 0x62, 0x20, 0x63, 0x0a));
  const fmtRaw = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "fmt", "-w1", "fmt-raw"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "fmt-raw-out")),
    stderr: "pipe",
  });
  expect(await fmtRaw.exited).toBe(0);
  expect(await new Response(fmtRaw.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "fmt-raw-out"))]).toEqual([0xff, 0x0a, 0x61, 0x0a, 0x62, 0x0a, 0x63, 0x0a]);
  expect(await run(["fmt", "-w", "+10"], "one two three four\n")).toMatchObject({ code: 0, stdout: "one two\nthree four\n" });
  expect(await run(["fmt", "-w+10"], "one two three four\n")).toMatchObject({ code: 0, stdout: "one two\nthree four\n" });
  expect(await run(["fmt", "--width=+10"], "one two three four\n")).toMatchObject({ code: 0, stdout: "one two\nthree four\n" });
  expect(await run(["fmt", "-w", "0"], "a b c\n")).toMatchObject({ code: 0, stdout: "a\nb\nc\n" });
  expect(await run(["fmt", "-g", "0"], "a b c\n")).toMatchObject({ code: 0, stdout: "a b c\n" });
  expect(await run(["fmt", "-g", "+0"], "a b c\n")).toMatchObject({ code: 0, stdout: "a b c\n" });
  expect(await run(["fmt", "-g+0"], "one two three\n")).toMatchObject({ code: 0, stdout: "one\ntwo three\n" });
  expect(await run(["fmt", "-g", "+0"], "one two three\n")).toMatchObject({ code: 0, stdout: "one\ntwo three\n" });
  expect(await run(["fmt", "-w", "75", "-g", "+0"], "one two three\n")).toMatchObject({ code: 0, stdout: "one two three\n" });
  expect(await run(["fmt", "-u"], "alpha   beta\n")).toMatchObject({ code: 0, stdout: "alpha beta\n" });
  expect(await run(["fmt", "-w", "10", "-g", "8"], "one two three four\n")).toMatchObject({ code: 0, stdout: "one two\nthree four\n" });
  expect(await run(["fmt", "-w", "+10", "-g", "+8"], "one two three four\n")).toMatchObject({ code: 0, stdout: "one two\nthree four\n" });
  expect(await run(["fmt", "-g", "10", "-w", "12"], "Alpha beta gamma delta E. Zeta eta\n")).toMatchObject({ code: 0, stdout: "Alpha beta\ngamma delta\nE. Zeta eta\n" });
  expect(await run(["fmt", "-w", "7"], "aa bb cc dd ee")).toMatchObject({ code: 0, stdout: "aa\nbb cc\ndd ee\n" });
  expect(await run(["fmt", "-w1", "-s"], "=\u00a0=\n")).toMatchObject({ code: 0, stdout: "=\u00a0=\n" });
  expect(await run(["fmt", "-w", "12", "--crown-margin"], "  alpha beta gamma\n  delta epsilon\n")).toMatchObject({ code: 0, stdout: "  alpha beta\n  gamma\n  delta\n  epsilon\n" });
  expect(await run(["fmt", "-w", "12", "--tagged-paragraph"], "  alpha beta gamma\n  delta epsilon\n")).toMatchObject({ code: 0, stdout: "  alpha\nbeta gamma\n  delta\nepsilon\n" });
  expect(await run(["fmt", "-t", "-w", "12"], "tag one two three\n  cont four five\n")).toMatchObject({ code: 0, stdout: "tag one two\n  three cont\n  four five\n" });
  expect(await run(["fmt", "-p", "# ", "-w", "10"], "# one two three\nplain text\n")).toMatchObject({ code: 0, stdout: "# one two\n# three\nplain text\n" });
  expect(await run(["fmt", "--w=5"], "one two three\n")).toMatchObject({ code: 0, stdout: "one\ntwo\nthree\n" });
  expect(await run(["fmt", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: fmt [-WIDTH] [OPTION]... [FILE]...\n") });
  expect(await run(["fmt", "--v"])).toMatchObject({ code: 0, stdout: expect.stringContaining("bnu 9.11\n") });
  expect(await run(["fmt", "fmt-raw", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: fmt [-WIDTH] [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["fmt", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: unrecognized option '--bad'\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "--h=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: option '--help' doesn't allow an argument\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "--v=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: option '--version' doesn't allow an argument\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "--help=1", "--version"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: option '--help' doesn't allow an argument\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "--version=1", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: option '--version' doesn't allow an argument\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "--width", "--help"])).toMatchObject(await systemRun(["fmt", "--width", "--help"]));
  expect(await run(["fmt", "--width=5", "--help"], "one two three\n")).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: fmt [-WIDTH] [OPTION]... [FILE]...\n") });
  expect(await run(["fmt", "--go", "x"], "")).toMatchObject(await systemRun(["fmt", "--go", "x"], ""));
  expect(await run(["fmt", "--spl"], "one two three\n")).toMatchObject({ code: 0, stdout: "one two three\n" });
  expect(await run(["fmt", "--cro=x"], "")).toMatchObject({ code: 1, stderr: "fmt: option '--crown-margin' doesn't allow an argument\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "-p>"], ">one two three\n>four five\n")).toMatchObject({ code: 0, stdout: ">one two three four five\n" });
  expect(await run(["fmt", "-p", ">"], "> quoted\n> text\n")).toMatchObject({ code: 0, stdout: "> quoted text\n" });
  expect(await run(["fmt", "-p", "\u00e7"], "\u00e7a\n\u00e7b\n")).toMatchObject({ code: 0, stdout: "\u00e7a b\n" });
  await writeFile(join(dir, "fmt-input"), "one two three\n");
  expect(await run(["fmt", "fmt-input", "-5"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: invalid option -- 5; -WIDTH is recognized only when it is the first\noption; use -w N instead\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "--", "-5"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: cannot open '-5' for reading: No such file or directory\n" });
  expect(await run(["fmt", "--", "-w", "5", "fmt-input"])).toMatchObject({ code: 1, stdout: "one two three\n", stderr: "fmt: cannot open '-w' for reading: No such file or directory\nfmt: cannot open '5' for reading: No such file or directory\n" });
  expect(await run(["fmt", "missing'fmt"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: cannot open \"missing'fmt\" for reading: No such file or directory\n" });
  expect(await run(["fmt", "missing\nfmt"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: cannot open 'missing'$'\\n''fmt' for reading: No such file or directory\n" });
  await mkdir(join(dir, "dir'fmt"));
  expect(await run(["fmt", "dir'fmt"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: error reading \"dir'fmt\": Is a directory\n" });
  await symlink("loop'fmt", join(dir, "loop'fmt"));
  expect(await run(["fmt", "loop'fmt"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: cannot open \"loop'fmt\" for reading: Too many levels of symbolic links\n" });
  expect(await run(["fmt", "-w"])).toMatchObject({ code: 1, stderr: "fmt: option requires an argument -- 'w'\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "--width"])).toMatchObject({ code: 1, stderr: "fmt: option '--width' requires an argument\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "-g"])).toMatchObject({ code: 1, stderr: "fmt: option requires an argument -- 'g'\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "--goal"])).toMatchObject({ code: 1, stderr: "fmt: option '--goal' requires an argument\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "-p"])).toMatchObject({ code: 1, stderr: "fmt: option requires an argument -- 'p'\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "--prefix"])).toMatchObject({ code: 1, stderr: "fmt: option '--prefix' requires an argument\nTry 'fmt --help' for more information.\n" });
  expect(await run(["fmt", "-72x"], "")).toMatchObject(await systemRun(["fmt", "-72x"], ""));
  expect(await run(["fmt", "-w", "-1"], "")).toMatchObject(await systemRun(["fmt", "-w", "-1"], ""));
  expect(await run(["fmt", "-w-10"], "")).toMatchObject(await systemRun(["fmt", "-w-10"], ""));
  expect(await run(["fmt", "-g-10"], "")).toMatchObject(await systemRun(["fmt", "-g-10"], ""));
  expect(await run(["fmt", "-g", "x"], "")).toMatchObject(await systemRun(["fmt", "-g", "x"], ""));
  expect(await run(["fmt", "-w", "1\n2"], "")).toMatchObject({ code: 1, stdout: "", stderr: `fmt: invalid width: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["fmt", "-g", "1\n2"], "")).toMatchObject({ code: 1, stdout: "", stderr: `fmt: invalid width: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["fmt", "-w+bad"], "")).toMatchObject(await systemRun(["fmt", "-w+bad"], ""));
  expect(await run(["fmt", "-g+bad"], "")).toMatchObject(await systemRun(["fmt", "-g+bad"], ""));
  expect(await run(["fmt", "-w", "2500"], "a b\n")).toMatchObject({ code: 0, stdout: "a b\n" });
  expect(await run(["fmt", "-w", "2501"], "")).toMatchObject(await systemRun(["fmt", "-w", "2501"], ""));
  expect(await run(["fmt", "-g", "76"], "")).toMatchObject(await systemRun(["fmt", "-g", "76"], ""));
  expect(await run(["fmt", "-w", "2500", "-g", "2500"], "a b\n")).toMatchObject({ code: 0, stdout: "a b\n" });
  expect(await run(["fmt", "-w", "32767"], "")).toMatchObject(await systemRun(["fmt", "-w", "32767"], ""));
  expect(await run(["fmt", "-g", "32767"], "")).toMatchObject(await systemRun(["fmt", "-g", "32767"], ""));
  expect(await run(["fmt", "-w", "32768"], "")).toMatchObject(await systemRun(["fmt", "-w", "32768"], ""));
  expect(await run(["fmt", "-g", "32768"], "")).toMatchObject(await systemRun(["fmt", "-g", "32768"], ""));
  expect(await run(["fmt", "-w", "+32768"], "")).toMatchObject(await systemRun(["fmt", "-w", "+32768"], ""));
  await mkdir(join(dir, "fmt-dir"));
  expect(await run(["fmt", "fmt-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: error reading 'fmt-dir': Is a directory\n" });
  const missingFmt = await run(["fmt", "fmt-missing"]);
  expect(missingFmt).toMatchObject({ code: 1, stdout: "" });
  expect(missingFmt.stderr).toContain("fmt: cannot open 'fmt-missing' for reading: No such file or directory");
  await symlink("fmt-loop", join(dir, "fmt-loop"));
  expect(await run(["fmt", "fmt-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "fmt: cannot open 'fmt-loop' for reading: Too many levels of symbolic links\n" });
});

test("expr handles numeric, string and regex expressions", async () => {
  expect(await run(["expr", "7", "+", "5"])).toMatchObject({ code: 0, stdout: "12\n" });
  expect(await run(["expr", "--", "-11", "+", "12"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "(", "100", "%", "6", ")", "-", "8"])).toMatchObject({ code: 0, stdout: "-4\n" });
  expect(await run(["expr", "1", "|", "(", "1", "/", "0", ")"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "0", "&", "(", "1", "/", "0", ")"])).toMatchObject({ code: 1, stdout: "0\n" });
  expect(await run(["expr", "1", "|"])).toMatchObject(await systemRun(["expr", "1", "|"]));
  expect(await run(["expr", "0", "&"])).toMatchObject(await systemRun(["expr", "0", "&"]));
  expect(await run(["expr", "(", "1", "+", "2"])).toMatchObject(await systemRun(["expr", "(", "1", "+", "2"]));
  expect(await run(["expr", "(", "1", "+", "2", "+"])).toMatchObject(await systemRun(["expr", "(", "1", "+", "2", "+"]));
  expect(await run(["expr", "1", "=", "1", "extra"])).toMatchObject(await systemRun(["expr", "1", "=", "1", "extra"]));
  expect(await run(["expr", "98782897298723498732987928734", "+", "1"])).toMatchObject({ code: 0, stdout: "98782897298723498732987928735\n" });
  expect(await run(["expr", "+", "1"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "1", "+", "+", "2"])).toMatchObject({ code: 0, stdout: "3\n" });
  expect(await run(["expr", "+", "length"])).toMatchObject({ code: 0, stdout: "length\n" });
  expect(await run(["expr", "+", ")"])).toMatchObject({ code: 0, stdout: ")\n" });
  expect(await run(["expr", "+"])).toMatchObject({ code: 2, stderr: `expr: syntax error: missing argument after ${diagnosticQuote("+")}\n` });
  expect(await run(["expr", "00"])).toMatchObject({ code: 1, stdout: "00\n" });
  expect(await run(["expr", "000"])).toMatchObject({ code: 1, stdout: "000\n" });
  expect(await run(["expr", "--", "-00"])).toMatchObject({ code: 1, stdout: "-00\n" });
  expect(await run(["expr", "--", "+0"])).toMatchObject({ code: 0, stdout: "+0\n" });
  expect(await run(["expr", "a", "=", "b"])).toMatchObject({ code: 1, stdout: "0\n" });
  expect(await run(["expr", "length", "abcdef"])).toMatchObject({ code: 0, stdout: "6\n" });
  expect(await shell(`raw=$(printf '\\316\\261bcdef'); LC_ALL=C "$BUN" "$BNU" expr length "$raw"`)).toMatchObject({ code: 0, stdout: "7\n", stderr: "" });
  expect(await shell(`raw=$(printf '\\316\\261bcdef'); LC_ALL=fr_FR.utf8 "$BUN" "$BNU" expr length "$raw"`)).toMatchObject({ code: 0, stdout: "6\n", stderr: "" });
  expect(await run(["expr", "substr", "abcdef", "2", "3"])).toMatchObject({ code: 0, stdout: "bcd\n" });
  expect(await run(["expr", "substr", "abcdef", "x", "3"])).toMatchObject({ code: 1, stdout: "\n" });
  expect(await run(["expr", "substr", "abcdef", "2", "x"])).toMatchObject({ code: 1, stdout: "\n" });
  expect(await run(["expr", "substr", "abcdef", "+2", "3"])).toMatchObject({ code: 1, stdout: "\n" });
  expect(await run(["expr", "substr", "abcdef"])).toMatchObject({ code: 2, stderr: `expr: syntax error: missing argument after ${diagnosticQuote("abcdef")}\n` });
  expect(await run(["expr", "substr", "abcdef", "2"])).toMatchObject({ code: 2, stderr: `expr: syntax error: missing argument after ${diagnosticQuote("2")}\n` });
  expect(await run(["expr", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: expr EXPRESSION\n  or:  expr OPTION\n") });
  expect(await run(["expr", "--help", "x"])).toMatchObject({ code: 2, stderr: `expr: syntax error: unexpected argument ${diagnosticQuote("x")}\n` });
  expect(await run(["expr", "index", "abcdef", "dx"])).toMatchObject({ code: 0, stdout: "4\n" });
  expect(await run(["expr", "index", "abcdef"])).toMatchObject({ code: 2, stderr: `expr: syntax error: missing argument after ${diagnosticQuote("abcdef")}\n` });
  expect(await run(["expr", "foobar", ":", "foo\\(.*\\)"])).toMatchObject({ code: 0, stdout: "bar\n" });
  expect(await run(["expr", "foobar", ":", "foo"])).toMatchObject({ code: 0, stdout: "3\n" });
  expect(await run(["expr", "a(", ":", "a("])).toMatchObject({ code: 0, stdout: "2\n" });
  expect(await run(["expr", "a^b", ":", "a^b"])).toMatchObject({ code: 0, stdout: "3\n" });
  expect(await run(["expr", "a*b", ":", "a\\(*\\)b"])).toMatchObject({ code: 0, stdout: "*\n" });
  expect(await run(["expr", "b", ":", "a*\\(^b$\\)c*"])).toMatchObject({ code: 0, stdout: "b\n" });
  expect(await run(["expr", "{1}a", ":", "\\(\\{1\\}a\\)"])).toMatchObject({ code: 0, stdout: "{1}a\n" });
  expect(await run(["expr", "aa", ":", "a\\{1\\}\\{1\\}"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "a", ":", "**a"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "abc", ":", "[[:alpha:]]*"])).toMatchObject({ code: 0, stdout: "3\n" });
  expect(await run(["expr", "123", ":", "[[:digit:]]*"])).toMatchObject({ code: 0, stdout: "3\n" });
  expect(await run(["expr", "abc", ":", "[^[:digit:]]*"])).toMatchObject({ code: 0, stdout: "3\n" });
  expect(await run(["expr", "abc", ":", "[[:bad:]]"])).toMatchObject({ code: 2, stderr: "expr: Invalid character class name\n" });
  expect(await run(["expr", "abc", ":", "[z-a]"])).toMatchObject({ code: 1, stdout: "0\n" });
  expect(await run(["expr", "abc", ":", "[z-a]*"])).toMatchObject({ code: 1, stdout: "0\n" });
  expect(await run(["expr", "abc", ":", "[az-a]*"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "abc", ":", "[^z-a]*"])).toMatchObject({ code: 0, stdout: "3\n" });
  expect(await run(["expr", "]", ":", "[]a]"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "a", ":", "[]a]"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "b", ":", "[^]a]"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "\\", ":", "[a\\-z]"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "-", ":", "[a\\-z]"])).toMatchObject({ code: 1, stdout: "0\n" });
  expect(await run(["expr", "-", ":", "[\\-]"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "\\", ":", "[\\]"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "\\]", ":", "[\\]]"])).toMatchObject({ code: 0, stdout: "2\n" });
  expect(await run(["expr", "a", ":", "[[=a=]]"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "a", ":", "[[.a.]]"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "a", ":", "[[=a=][:digit:]]"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "b", ":", "[^[=a=]]"])).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["expr", "a", ":", "[[=ab=]]"])).toMatchObject({ code: 2, stderr: "expr: Invalid collation character\n" });
  expect(await run(["expr", "abc", ":", "["])).toMatchObject({ code: 2, stderr: "expr: Invalid regular expression\n" });
  expect(await run(["expr", "abc", ":", "\\"])).toMatchObject({ code: 2, stderr: "expr: Trailing backslash\n" });
  expect(await run(["expr", "match", "foo", "bar\\(.*\\)"])).toMatchObject({ code: 1, stdout: "\n" });
  expect(await run(["expr", "match", "foo"])).toMatchObject({ code: 2, stderr: `expr: syntax error: missing argument after ${diagnosticQuote("foo")}\n` });
});

test("df, tsort, timeout, nice, nohup and kill command surfaces", async () => {
  const df = await run(["df", "."]);
  expect(df.code).toBe(0);
  expect(df.stdout).toContain("Filesystem");
  expect(df.stdout.trim().split("\n").length).toBeGreaterThan(1);
  // No operands enumerate the mount table, while the kernel API mounts only
  // appear when --all is requested.
  const defaultDfMounts = await run(["df", "--output=target"]);
  const allDfMounts = await run(["df", "--all", "--output=target"]);
  expect(defaultDfMounts).toMatchObject({ code: 0, stderr: "" });
  expect(defaultDfMounts.stdout).not.toContain("\n/proc\n");
  expect(allDfMounts.stdout).toContain("\n/proc\n");
  const dfi = await run(["df", "-i", "."]);
  expect(dfi).toMatchObject({ code: 0 });
  expect(dfi.stdout).toContain("Inodes");
  expect(dfi.stdout).toContain("IUse%");
  expect(dfi.stdout.trim().split("\n").length).toBeGreaterThan(1);
  expect((await run(["df", "-ih", "."])).stdout).toContain("Inodes");
  expect((await run(["df", "-h", "."])).stdout.split("\n")[0].replace(/ +/g, " ")).toBe("Filesystem Size Used Avail Use% Mounted on");
  expect((await run(["df", "-H", "."])).stdout.trim().split("\n").at(-1)).toMatch(/\s[0-9.]+[BKMGTP]\s+[0-9.]+[BKMGTP]\s+[0-9.]+[BKMGTP]\s+\d+% \S+$/);
  expect((await run(["df", "-k", "."])).stdout.trim().split("\n").length).toBeGreaterThan(1);
  expect(await run(["df", "--sync", "--output=target", "."])).toMatchObject({
    code: 0,
    stdout: (await run(["df", "--no-sync", "--sync", "--output=target", "."])).stdout,
  });
  expect(await run(["df", "--sync", "--no-sync", "--output=target", "."])).toMatchObject({ code: 0 });
  await writeFile(join(dir, "--sync"), "");
  expect(await run(["df", "--no-sync", "--output=file", "--", "--sync"])).toMatchObject({ code: 0, stdout: "File\n--sync\n" });
  const dfHelp = (await run(["df", "--help"])).stdout;
  expect(dfHelp).toContain("Show information about the file system on which each FILE resides,\n");
  expect(dfHelp).toContain("  -k\n");
  expect((await run(["df", "-BM", "."])).stdout.trim().split("\n").length).toBeGreaterThan(1);
  expect(await run(["df", "--he=bad", "."])).toMatchObject(await systemRun(["df", "--he=bad", "."]));
  expect((await run(["df", "--block-size=human-readable", "."])).stdout.split("\n")[0].replace(/ +/g, " ")).toBe("Filesystem Size Used Avail Use% Mounted on");
  expect((await run(["df", "--block-size=si", "."])).stdout.split("\n")[0].replace(/ +/g, " ")).toBe("Filesystem Size Used Avail Use% Mounted on");
  expect(await run(["df", "--block-size=bad", "."])).toMatchObject({ code: 1, stdout: "", stderr: "df: invalid --block-size argument 'bad'\n" });
  expect(await run(["df", "--block-size=bad", "--help"])).toMatchObject(await systemRun(["df", "--block-size=bad", "--help"]));
  expect(await run(["df", "--block-size", "bad", "--help"])).toMatchObject(await systemRun(["df", "--block-size", "bad", "--help"]));
  expect(await run(["df", "--block-size=1R", "."])).toMatchObject({ code: 1, stdout: "", stderr: "df: invalid suffix in --block-size argument '1R'\n" });
  expect(await run(["df", "--blo=bad", "."])).toMatchObject(await systemRun(["df", "--blo=bad", "."]));
  expect(await run(["df", "-Bbad", "."])).toMatchObject({ code: 1, stdout: "", stderr: "df: invalid -B argument 'bad'\n" });
  expect(await run(["df", "-Bbad", "--help"])).toMatchObject(await systemRun(["df", "-Bbad", "--help"]));
  expect(await run(["df", "-B", "bad", "--help"])).toMatchObject(await systemRun(["df", "-B", "bad", "--help"]));
  expect(await run(["df", "-B1B", "."])).toMatchObject({ code: 1, stdout: "", stderr: "df: invalid suffix in -B argument '1B'\n" });
  expect((await run(["df", "-B1", "."])).stdout.split("\n")[0]).toContain("1B-blocks");
  expect((await run(["df", "--block-size=1KB", "."])).stdout.split("\n")[0]).toContain("1kB-blocks");
  expect((await run(["df", "--block-size=1KiB", "."])).stdout.split("\n")[0]).toContain("1K-blocks");
  expect((await run(["df", "."], "", { env: { BLOCK_SIZE: "1R" } })).stdout.split("\n")[0]).toContain("1B-blocks");
  expect((await run(["df", "."], "", { env: { DF_BLOCK_SIZE: "1KB" } })).stdout.split("\n")[0]).toContain("1kB-blocks");
  expect((await run(["df", "."], "", { env: { BLOCK_SIZE: "bad" } })).stdout.split("\n")[0]).toContain("1K-blocks");
  expect((await run(["df", "."], "", { env: { POSIXLY_CORRECT: "1" } })).stdout.split("\n")[0]).toContain("512B-blocks");
  expect((await run(["df", "."], "", { env: { POSIXLY_CORRECT: "1", BLOCK_SIZE: "bad" } })).stdout.split("\n")[0]).toContain("512B-blocks");
  expect((await run(["df", "--local", "--output=source,target", "."])).stdout.split("\n")[0]).toBe("Filesystem     Mounted on");
  const dfType = await run(["df", "-T", "."]);
  expect(dfType).toMatchObject({ code: 0 });
  expect(dfType.stdout.split("\n")[0]).toContain("Type");
  const currentFsType = dfType.stdout.trim().split("\n").at(-1).trim().split(/\s+/)[1];
  expect(await run(["df", "-t", currentFsType, "."])).toMatchObject({ code: 0 });
  expect(await run(["df", "--type=", "."])).toMatchObject({ code: 1, stdout: "", stderr: "df: no file systems processed\n" });
  expect(await run(["df", "-t", ",", "."])).toMatchObject({ code: 1, stdout: "", stderr: "df: no file systems processed\n" });
  expect(await run(["df", "-x", currentFsType, "."])).toMatchObject({ code: 1, stderr: "df: no file systems processed\n" });
  expect((await run(["df", "-P", "."])).stdout.split("\n")[0].replace(/ +/g, " ")).toBe("Filesystem 1024-blocks Used Available Capacity Mounted on");
  expect((await run(["df", "--out=source,size", "--out=target", "."])).stdout.split("\n")[0].replace(/ +/g, " ")).toBe("Filesystem 1K-blocks Mounted on");
  expect((await run(["df", "--output=source,pcent", "/dev/null"])).stdout.split("\n")[0]).toBe((await systemRun(["df", "--output=source,pcent", "/dev/null"])).stdout.split("\n")[0]);
  const dfOutputDefault = await run(["df", "--output", "."]);
  const systemDfOutputDefault = await systemRun(["df", "--output", "."]);
  expect(dfOutputDefault).toMatchObject({ code: 0, stderr: "" });
  expect(dfOutputDefault.stdout.replace(/\d+/g, "#")).toBe(systemDfOutputDefault.stdout.replace(/\d+/g, "#"));
  const dfOutputNumbers = await run(["df", "--output=itotal,iused,iavail,ipcent,size,used,avail,pcent", "."]);
  const systemDfOutputNumbers = await systemRun(["df", "--output=itotal,iused,iavail,ipcent,size,used,avail,pcent", "."]);
  expect(dfOutputNumbers).toMatchObject({ code: 0, stderr: "" });
  expect(dfOutputNumbers.stdout.replace(/\d+/g, "#")).toBe(systemDfOutputNumbers.stdout.replace(/\d+/g, "#"));
  const dfOutputInodes = await run(["df", "--output=itotal", "."]);
  expect(dfOutputInodes.stdout.split(/\s+/).filter(Boolean).at(-1)).toBe(String(Number((await statfs(dir)).files)));
  expect((await run(["df", "--ou=source", "."])).stdout.split("\n")[0]).toBe("Filesystem");
  expect((await run(["df", "--outp=source", "."])).stdout.split("\n")[0]).toBe("Filesystem");
  expect((await run(["df", "--outpu=source", "."])).stdout.split("\n")[0]).toBe("Filesystem");
  const dfOutputPrefix = await run(["df", "--ou", "df-missing", "."]);
  expect(dfOutputPrefix).toMatchObject({ code: 1, stderr: "df: df-missing: No such file or directory\n" });
  expect(dfOutputPrefix.stdout.split("\n")[0]).toContain("Filesystem");
  await symlink(".", join(dir, "df-link"));
  const dfSourceTarget = await run(["df", "--out=source,target", "."]);
  expect(dfSourceTarget).toMatchObject({ code: 0 });
  expect(await run(["df", "--out=source,target", "df-link"])).toMatchObject({ code: 0, stdout: dfSourceTarget.stdout });
  expect(await run(["df", "--out=file,target", "df-link"])).toMatchObject({ code: 0, stdout: expect.stringMatching(/^File\s+Mounted on\ndf-link \S+\n$/) });
  expect(await run(["df", "--total", "missing-df"])).toMatchObject({ code: 1, stdout: "", stderr: "df: missing-df: No such file or directory\n" });
  expect(await run(["df", "--output=target,source,target", "."])).toMatchObject({ code: 1, stderr: `df: option --output: field ${diagnosticQuote("target")} used more than once\nTry 'df --help' for more information.\n` });
  expect(await run(["df", "--output=bad", "--help"])).toMatchObject(await systemRun(["df", "--output=bad", "--help"]));
  expect(await run(["df", "--output=", "."])).toMatchObject({ code: 1, stdout: "", stderr: `df: option --output: field ${diagnosticQuote("")} unknown\nTry 'df --help' for more information.\n` });
  expect(await run(["df", "--output=source,,target", "."])).toMatchObject({ code: 1, stdout: "", stderr: `df: option --output: field ${diagnosticQuote("")} unknown\nTry 'df --help' for more information.\n` });
  expect(await run(["df", "--output=source,bad\nfield", "."])).toMatchObject({ code: 1, stdout: "", stderr: `df: option --output: field ${diagnosticQuote("bad\\nfield")} unknown\nTry 'df --help' for more information.\n` });
  const dfTotal = await run(["df", "--total", "."]);
  expect(dfTotal).toMatchObject({ code: 0 });
  expect(dfTotal.stdout.trim().split("\n").at(-1)).toMatch(/^total\s+\S+\s+\S+\s+\S+\s+\d+% -$/);
  expect((await run(["df", "--output=source,target", "--total", "."])).stdout.trim().split("\n").at(-1)).toMatch(/^total\s+-$/);
  expect((await run(["df", "--output=target", "--total", "."])).stdout.trim().split("\n").at(-1)).toBe("total");
  const dfiTotal = await run(["df", "-i", "--total", "."]);
  expect(dfiTotal).toMatchObject({ code: 0 });
  expect(dfiTotal.stdout.trim().split("\n").at(-1)).toMatch(/^total\s+\S+\s+\S+\s+\S+\s+\d+% -$/);
  expect(await run(["df", "df-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "df: df-missing: No such file or directory\n" });
  expect(await run(["df", "missing'df"])).toMatchObject({ code: 1, stdout: "", stderr: "df: \"missing'df\": No such file or directory\n" });
  expect(await run(["df", "missing\ndf"])).toMatchObject({ code: 1, stdout: "", stderr: "df: 'missing'$'\\n''df': No such file or directory\n" });
  await symlink("df-loop", join(dir, "df-loop"));
  expect(await run(["df", "df-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "df: df-loop: Too many levels of symbolic links\n" });
  await symlink("loop'df", join(dir, "loop'df"));
  expect(await run(["df", "loop'df"])).toMatchObject({ code: 1, stdout: "", stderr: "df: \"loop'df\": Too many levels of symbolic links\n" });
  expect(await run(["df", "--total", "df-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "df: df-loop: Too many levels of symbolic links\n" });
  expect(await run(["tsort"], "a b\nb c\n")).toMatchObject({ code: 0, stdout: "a\nb\nc\n" });
  expect(await run(["tsort"], "a b b c c d d e e f f g\nc x x y y z\n")).toMatchObject({ code: 0, stdout: "a\nb\nc\nx\nd\ny\ne\nz\nf\ng\n" });
  expect(await run(["tsort", "--h"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: tsort [OPTION] [FILE]\n") });
  expect(await run(["tsort", "--ver"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["tsort", "BEFORE", "--help", "AFTER"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: tsort [OPTION] [FILE]\n") });
  expect(await run(["tsort", "BEFORE", "--version", "AFTER"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["tsort", "--bad", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "tsort: unrecognized option '--bad'\nTry 'tsort --help' for more information.\n" });
  expect(await run(["tsort", "--h=foo"])).toMatchObject({ code: 1, stdout: "", stderr: "tsort: option '--help' doesn't allow an argument\nTry 'tsort --help' for more information.\n" });
  expect(await run(["tsort", "-x", "--help"])).toMatchObject({ code: 1, stdout: "", stderr: "tsort: invalid option -- 'x'\nTry 'tsort --help' for more information.\n" });
  expect(await run(["tsort"], "a\n")).toMatchObject({ code: 1, stderr: "tsort: -: input contains an odd number of tokens\n" });
  expect(await run(["tsort", "-", "extra"], "")).toMatchObject({ code: 1, stderr: `tsort: extra operand ${diagnosticQuote("extra")}\nTry 'tsort --help' for more information.\n` });
  expect(await run(["tsort"], "t b\nt s\ns t\n")).toMatchObject({ code: 1, stdout: "s\nt\nb\n", stderr: "tsort: -: input contains a loop:\ntsort: s\ntsort: t\n" });
  expect(await run(["timeout", "2", process.execPath, "-e", "console.log('done')"])).toMatchObject({ code: 0, stdout: "done\n" });
  expect(await run(["timeout", ".2", process.execPath, "-e", "console.log('decimal')"])).toMatchObject({ code: 0, stdout: "decimal\n" });
  expect(await run(["timeout", "+.2", process.execPath, "-e", "console.log('plus-decimal')"])).toMatchObject({ code: 0, stdout: "plus-decimal\n" });
  expect(await run(["timeout", "+0x.8p-2", process.execPath, "-e", "console.log('plus-hex')"])).toMatchObject({ code: 0, stdout: "plus-hex\n" });
  expect(await run(["timeout", "0", process.execPath, "-e", "setTimeout(() => console.log('no-timeout'), 20)"])).toMatchObject({ code: 0, stdout: "no-timeout\n" });
  expect(await run(["timeout", "2", "/bin/sh", "-c", "printf '%s\\n' \"$1\"", "sh", "--version"])).toMatchObject({ code: 0, stdout: "--version\n" });
  expect(await run(["timeout", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: timeout [OPTION]... DURATION COMMAND [ARG]...\n") });
  expect(await run(["timeout", "--help=bad"])).toMatchObject({ code: 125, stderr: "timeout: option '--help' doesn't allow an argument\nTry 'timeout --help' for more information.\n" });
  expect(await run(["timeout", "--ve=bad"])).toMatchObject(await systemRun(["timeout", "--ve=bad"]));
  expect(await run(["timeout"])).toMatchObject({ code: 125, stderr: "Try 'timeout --help' for more information.\n" });
  expect(await run(["timeout", "1"])).toMatchObject({ code: 125, stderr: "Try 'timeout --help' for more information.\n" });
  expect(await run(["timeout", "-s"])).toMatchObject({ code: 125, stderr: "timeout: option requires an argument -- 's'\nTry 'timeout --help' for more information.\n" });
  expect(await run(["timeout", "-k"])).toMatchObject({ code: 125, stderr: "timeout: option requires an argument -- 'k'\nTry 'timeout --help' for more information.\n" });
  expect(await run(["timeout", "--signal"])).toMatchObject({ code: 125, stderr: "timeout: option '--signal' requires an argument\nTry 'timeout --help' for more information.\n" });
  expect(await run(["timeout", "--kill-after"])).toMatchObject({ code: 125, stderr: "timeout: option '--kill-after' requires an argument\nTry 'timeout --help' for more information.\n" });
  expect(await run(["timeout", "--bad", "--help"])).toMatchObject({ code: 125, stderr: "timeout: unrecognized option '--bad'\nTry 'timeout --help' for more information.\n" });
  expect(await run(["timeout", "-s", "bad", "--help"])).toMatchObject(await systemRun(["timeout", "-s", "bad", "--help"]));
  expect(await run(["timeout", "-s", "--help"])).toMatchObject(await systemRun(["timeout", "-s", "--help"]));
  expect(await run(["timeout", "--signal=bad", "--help"])).toMatchObject(await systemRun(["timeout", "--signal=bad", "--help"]));
  expect(await run(["timeout", "-k", "bad", "--help"])).toMatchObject(await systemRun(["timeout", "-k", "bad", "--help"]));
  expect(await run(["timeout", "-k", "--help"])).toMatchObject(await systemRun(["timeout", "-k", "--help"]));
  expect(await run(["timeout", "--kill-after=bad", "--help"])).toMatchObject(await systemRun(["timeout", "--kill-after=bad", "--help"]));
  expect(await run(["timeout", "--foreground=bad", "1", "true"])).toMatchObject({ code: 125, stderr: "timeout: option '--foreground' doesn't allow an argument\nTry 'timeout --help' for more information.\n" });
  expect(await run(["timeout", "--preserve-status=bad", "1", "true"])).toMatchObject({ code: 125, stderr: "timeout: option '--preserve-status' doesn't allow an argument\nTry 'timeout --help' for more information.\n" });
  expect(await run(["timeout", "--verbose=bad", "1", "true"])).toMatchObject({ code: 125, stderr: "timeout: option '--verbose' doesn't allow an argument\nTry 'timeout --help' for more information.\n" });
  expect(await run(["timeout", "1\t2", "true"])).toMatchObject(await systemRun(["timeout", "1\t2", "true"]));
  expect(await run(["timeout", "bad", "true"])).toMatchObject(await systemRun(["timeout", "bad", "true"]));
  expect(await run(["timeout", "--kill-after=bad", "true"])).toMatchObject(await systemRun(["timeout", "--kill-after=bad", "true"]));
  expect(await run(["timeout", "--signal=BAD", "true"])).toMatchObject(await systemRun(["timeout", "--signal=BAD", "true"]));
  expect(await run(["timeout", "1", "definitely-missing-command"])).toMatchObject({ code: 127, stderr: "timeout: failed to run command 'definitely-missing-command': No such file or directory\n" });
  expect(await run(["timeout", "1", "."])).toMatchObject({ code: 126, stderr: "timeout: failed to run command '.': Permission denied\n" });
  expect((await run(["timeout", "0.05", process.execPath, "-e", "setTimeout(()=>{}, 1000)"])).code).toBe(124);
  expect(await run(["timeout", "--verbose", "--signal=RTMIN", "0.05", "/usr/bin/sleep", "1"])).toMatchObject({ code: 124, stderr: "timeout: sending signal RTMIN to command '/usr/bin/sleep'\n" });
  expect((await run(["timeout", "-s", "KILL", "0.05", process.execPath, "-e", "setTimeout(()=>{}, 1000)"])).code).toBe(137);
  expect((await run(["timeout", "--preserve-status", "0.2", "sh", "-c", "trap 'exit 7' TERM; sleep 1"])).code).toBe(7);
  const timeoutForward = await shell(`
    "$BUN" "$BNU" timeout 30 "$BUN" -e 'Bun.write("timeout-child.pid", String(process.pid)); setInterval(()=>{}, 1000)' &
    tpid=$!
    for i in 1 2 3 4 5 6 7 8 9 10; do
      test -s timeout-child.pid && break
      sleep .05
    done
    test -s timeout-child.pid || exit 2
    cpid=$(cat timeout-child.pid)
    kill "$tpid"
    wait "$tpid" 2>/dev/null
    sleep .1
    if kill -0 "$cpid" 2>/dev/null; then
      kill "$cpid" 2>/dev/null
      exit 3
    fi
  `);
  expect(timeoutForward).toMatchObject({ code: 0 });
  const timeoutSignalZero = await run(["timeout", "-v", "-s0", "-k", "0.05", "0.05", process.execPath, "-e", "setTimeout(()=>{}, 1000)"]);
  expect(timeoutSignalZero.stderr).toContain("timeout: sending signal 0 to command");
  expect(await run(["sleep", "0s", "0.001s"])).toMatchObject({ code: 0 });
  expect(await run(["sleep", ".001s"])).toMatchObject({ code: 0 });
  expect(await run(["sleep", "+1e-3"])).toMatchObject({ code: 0 });
  expect(await run(["sleep", "+0x.002p1"])).toMatchObject({ code: 0 });
  expect(await run(["sleep", "0x.002p1"])).toMatchObject({ code: 0 });
  expect((await run(["sleep", "--help"])).stdout).toStartWith("Usage: sleep NUMBER[SUFFIX]...\n  or:  sleep OPTION\n");
  expect((await run(["sleep", "--help"])).stdout).toContain("SUFFIX may be 's','m','h', or 'd', for seconds, minutes, hours, days.\n");
  expect((await run(["sleep", "0", "--help"])).stdout).toStartWith("Usage: sleep NUMBER[SUFFIX]...\n  or:  sleep OPTION\n");
  expect(await run(["sleep", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect((await run(["sleep", "--h"])).stdout).toStartWith("Usage: sleep NUMBER[SUFFIX]...\n  or:  sleep OPTION\n");
  expect((await run(["sleep", "0", "--he"])).stdout).toStartWith("Usage: sleep NUMBER[SUFFIX]...\n  or:  sleep OPTION\n");
  expect(await run(["sleep", "--v"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["sleep", "0", "--ver"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["sleep", "--h=1"])).toMatchObject({ code: 1, stderr: "sleep: option '--help' doesn't allow an argument\nTry 'sleep --help' for more information.\n" });
  expect(await run(["sleep", "0", "--v=1"])).toMatchObject({ code: 1, stderr: "sleep: option '--version' doesn't allow an argument\nTry 'sleep --help' for more information.\n" });
  expect(await run(["sleep", "--bad", "--help"])).toMatchObject({ code: 1, stderr: "sleep: unrecognized option '--bad'\nTry 'sleep --help' for more information.\n" });
  expect(await run(["sleep", "-x", "--help"])).toMatchObject({ code: 1, stderr: "sleep: invalid option -- 'x'\nTry 'sleep --help' for more information.\n" });
  expect(await run(["sleep", "--"])).toMatchObject({ code: 0 });
  expect(await run(["sleep", "--", "0.001"])).toMatchObject({ code: 0 });
  expect(await run(["sleep", "--", "--help"])).toMatchObject(await systemRun(["sleep", "--", "--help"]));
  expect(await run(["sleep", "--bad-option"])).toMatchObject({ code: 1, stderr: "sleep: unrecognized option '--bad-option'\nTry 'sleep --help' for more information.\n" });
  expect(await run(["sleep", "-"])).toMatchObject(await systemRun(["sleep", "-"]));
  expect(await run(["sleep", "-1"])).toMatchObject({ code: 1, stderr: "sleep: invalid option -- '1'\nTry 'sleep --help' for more information.\n" });
  expect(await run(["sleep"])).toMatchObject({ code: 1, stderr: "sleep: missing operand\nTry 'sleep --help' for more information.\n" });
  expect(await run(["sleep", "1\n2"])).toMatchObject(await systemRun(["sleep", "1\n2"]));
  expect(await run(["sleep", "nan"])).toMatchObject(await systemRun(["sleep", "nan"]));
  expect(await run(["sleep", "1fortnight"])).toMatchObject(await systemRun(["sleep", "1fortnight"]));
  expect(await run(["timeout", "0.1", join(import.meta.dir, "../bin/bnu.js"), "sleep", "inf"])).toMatchObject({ code: 124 });
  expect(await run(["timeout", "0.1", join(import.meta.dir, "../bin/bnu.js"), "sleep", "INF"])).toMatchObject({ code: 124 });
  expect(await run(["timeout", "0.1", join(import.meta.dir, "../bin/bnu.js"), "sleep", "Infinity"])).toMatchObject({ code: 124 });
  expect(await run(["nice", process.execPath, "-e", "console.log('nice')"])).toMatchObject({ code: 0, stdout: "nice\n" });
  expect(await run(["nice", "-n5", process.execPath, "-e", "console.log('n5')"])).toMatchObject({ code: 0, stdout: "n5\n" });
  expect(await run(["nice", "--adjustment=5", process.execPath, "-e", "console.log('eq')"])).toMatchObject({ code: 0, stdout: "eq\n" });
  expect(await run(["nice", "-5", process.execPath, "-e", "console.log('old')"])).toMatchObject({ code: 0, stdout: "old\n" });
  expect(await run(["nice", "-1", "-2", join(import.meta.dir, "../bin/bnu.js"), "nice"])).toMatchObject({ code: 0, stdout: "2\n" });
  expect(await run(["nice", "-n", "1", join(import.meta.dir, "../bin/bnu.js"), "nice", "-n", "2", join(import.meta.dir, "../bin/bnu.js"), "nice"])).toMatchObject({ code: 0, stdout: "3\n" });
  const negativeNice = await run(["nice", "-n", "-1", join(import.meta.dir, "../bin/bnu.js"), "nice"]);
  expect(negativeNice).toMatchObject({ code: 0, stdout: "0\n" });
  expect(negativeNice.stderr).toContain("cannot set niceness");
  expect(await run(["nice", "-n", "1"])).toMatchObject({ code: 125, stderr: "nice: a command must be given with an adjustment\nTry 'nice --help' for more information.\n" });
  expect(await run(["nice", "-1"])).toMatchObject({ code: 125, stderr: "nice: a command must be given with an adjustment\nTry 'nice --help' for more information.\n" });
  expect(await run(["nice", "-n"])).toMatchObject({ code: 125, stderr: "nice: option requires an argument -- 'n'\nTry 'nice --help' for more information.\n" });
  expect(await run(["nice", "--adjustment"])).toMatchObject({ code: 125, stderr: "nice: option '--adjustment' requires an argument\nTry 'nice --help' for more information.\n" });
  expect(await run(["nice", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: nice [OPTION] [COMMAND [ARG]...]\n") });
  expect(await run(["nice", "--he=bad"])).toMatchObject(await systemRun(["nice", "--he=bad"]));
  expect(await run(["nice", "--ve=bad"])).toMatchObject(await systemRun(["nice", "--ve=bad"]));
  expect(await run(["nice", "--bad", "--help"])).toMatchObject({ code: 125, stderr: "nice: unrecognized option '--bad'\nTry 'nice --help' for more information.\n" });
  expect(await run(["nice", "---"])).toMatchObject({ code: 125 });
  expect(await run(["nice", "-n", "1a"])).toMatchObject({ code: 125 });
  expect(await run(["nice", "-n", "1\n2"])).toMatchObject({ code: 125, stderr: `nice: invalid adjustment ${diagnosticQuote("1\\n2")}\n` });
  const niceInvalid = await run(["nice", "-/"]);
  expect(niceInvalid).toMatchObject({ code: 125 });
  expect(niceInvalid.stderr).toContain("nice: invalid option -- '/'");
  expect(niceInvalid.stderr).toContain("Try 'nice --help' for more information.");
  expect(await run(["nice", "sh", "-c", "exit 2"])).toMatchObject({ code: 2 });
  expect(await run(["nice", "/bin/sh", "-c", "printf '%s\\n' \"$1\"", "sh", "--version"])).toMatchObject({ code: 0, stdout: "--version\n" });
  expect(await run(["nice", "."])).toMatchObject({ code: 126, stderr: "nice: '.': Permission denied\n" });
  expect(await run(["nice", "definitely-missing-command"])).toMatchObject({ code: 127, stderr: "nice: 'definitely-missing-command': No such file or directory\n" });
  expect(await run(["nproc"], "", { env: { OMP_NUM_THREADS: "2,ignored", OMP_THREAD_LIMIT: "" } })).toMatchObject({ code: 0, stdout: "2\n" });
  expect(await run(["nproc"], "", { env: { OMP_NUM_THREADS: " 2 ", OMP_THREAD_LIMIT: "" } })).toMatchObject({ code: 0, stdout: "2\n" });
  expect(await run(["nproc"], "", { env: { OMP_NUM_THREADS: " 4 ", OMP_THREAD_LIMIT: " 2 " } })).toMatchObject({ code: 0, stdout: "2\n" });
  expect(await run(["nproc"], "", { env: { OMP_NUM_THREADS: "2bad", OMP_THREAD_LIMIT: "1" } })).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["nproc"], "", { env: { OMP_NUM_THREADS: "-2", OMP_THREAD_LIMIT: "1bad" } })).toMatchObject({ code: 0 });
  expect(await run(["nohup", process.execPath, "-e", "console.log('nohup')"])).toMatchObject({ code: 0, stdout: "nohup\n" });
  expect(await run(["nohup", "sh", "-c", "cat; kill -HUP $$; echo survived"], "piped input\n")).toMatchObject({ code: 0, stdout: "piped input\nsurvived\n", stderr: "" });
  expect(await run(["nohup", "--", "sh", "-c", "printf 'dash command\\n'"])).toMatchObject({ code: 0, stdout: "dash command\n" });
  expect(await run(["nohup", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: nohup COMMAND [ARG]...\n  or:  nohup OPTION\n") });
  expect(await run(["nohup", "--version=bad"])).toMatchObject(await systemRun(["nohup", "--version=bad"]));
  expect(await run(["nohup", "--hel=bad"])).toMatchObject(await systemRun(["nohup", "--hel=bad"]));
  const missingNohup = await run(["nohup", "definitely-missing-command"]);
  expect(missingNohup.code).toBe(127);
  expect(missingNohup.stderr).toBe("nohup: failed to run command 'definitely-missing-command': No such file or directory\n");
  if ((await shell("command -v script >/dev/null")).code === 0) {
    const nohupPty = await shell(`script -qfec 'rm -f nohup.out; umask 0777; "$BUN" "$BNU" nohup sh -c "echo stdout; echo stderr >&2"; mode=$(stat -c %a nohup.out); printf "MODE=%s\\n" "$mode"; printf "FILE="; tr "\\n" - < nohup.out; printf "\\n"; rm -f nohup.out' /dev/null`);
    expect(nohupPty).toMatchObject({ code: 0, stderr: "" });
    const nohupPtyOutput = nohupPty.stdout.replaceAll("\r\n", "\n");
    expect(nohupPtyOutput).toContain(`nohup: ignoring input and appending output to ${diagnosticQuote("nohup.out")}\n`);
    expect(nohupPtyOutput).toContain("MODE=600\nFILE=stdout-stderr-\n");
  }
  expect(await run(["kill", "-l"])).toMatchObject({ code: 0 });
  expect(await run(["kill", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: kill [-s SIGNAL | --signal SIGNAL | -SIGNAL] PID...\n  or:  kill [-l | --list | -t | --table] [SIGNAL]...\n") });
  expect(await run(["kill", "-l", "15"])).toMatchObject({ code: 0, stdout: "TERM\n" });
  expect(await run(["kill", "--list=TERM"])).toMatchObject({ code: 0, stdout: "15\n" });
  expect(await run(["kill", "-l", "34", "35", "63", "64"])).toMatchObject({
    code: 0,
    stdout: "RTMIN\nRTMIN+1\nRTMAX-1\nRTMAX\n",
  });
  expect(await run(["kill", "-l", "RTMIN+2", "RTMAX-2"])).toMatchObject({ code: 0, stdout: "36\n62\n" });
  expect((await run(["kill", "-l"])).stdout).toContain("RTMAX\n");
  expect((await run(["kill", "-L"])).stdout).toContain("15 TERM");
  expect(await run(["kill", "-s", "0", String(process.pid)])).toMatchObject({ code: 0 });
  expect(await run(["kill", "-0", String(process.pid)])).toMatchObject({ code: 0 });
});

test("install, dd, dircolors and shred cover file setup workflows", async () => {
  await writeFile(join(dir, "source"), "abcdef");
  expect(await run(["shred"])).toMatchObject({ code: 1, stderr: "shred: missing file operand\nTry 'shred --help' for more information.\n" });
  expect(await run(["install", "-m", "700", "source", "installed"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "installed"), "utf8")).toBe("abcdef");
  expect((await stat(join(dir, "installed"))).mode & 0o777).toBe(0o700);
  expect((await run(["install", "--preserve", "--help"])).stderr).toContain("option '--preserve' is ambiguous; possibilities: '--preserve-timestamps' '--preserve-context'");
  const installHelp = await run(["install", "-p", "--help", "--help"]);
  expect(installHelp.code).toBe(0);
  expect(installHelp.stdout).toContain("Usage: install [OPTION]... [-T] SOURCE DEST\n  or:  install [OPTION]... SOURCE... DIRECTORY\n  or:  install [OPTION]... -t DIRECTORY SOURCE...\n  or:  install [OPTION]... -d DIRECTORY...\n");
  expect(installHelp.stdout).toContain("  --context\n");
  expect(installHelp.stdout).toContain("  -D\n");
  expect(installHelp.stdout).toContain("  -Z\n");
  expect(installHelp.stdout).toContain("  -c\n");
  expect((await run(["install", "--debug=bad", "--help"])).stderr).toContain("option '--debug' doesn't allow an argument");
  expect(await run(["install", "--target", "--help", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["install", "--strip-p=./stripper", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: install") });
  expect(await run(["install", "--context", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: install") });
  expect(await run(["install", "--context=system_u:object_r:tmp_t:s0", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: install") });
  expect(await run(["install", "--context=system_u:object_r:tmp_t:s0", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n", stderr: "install: warning: ignoring --context; it requires an SELinux-enabled kernel\n" });
  expect(await run(["install", "--preserve-context", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: install"), stderr: "install: WARNING: ignoring --preserve-context; this kernel is not SELinux-enabled\n" });
  expect(await run(["install", "source", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: install [OPTION]... [-T] SOURCE DEST\n"), stderr: "" });
  await writeFile(join(dir, "installed-backup-empty"), "old");
  expect(await run(["install", "--backup=", "source", "installed-backup-empty"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "installed-backup-empty"), "utf8")).toBe("abcdef");
  expect(await readFile(join(dir, "installed-backup-empty~"), "utf8")).toBe("old");
  expect(await run(["install", "--backup=bad", "source", "installed-backup-bad"])).toMatchObject(await systemRun(["install", "--backup=bad", "source", "installed-backup-bad"]));
  expect(await run(["install", "--backup", "source", "installed-backup-env-bad"], "", { env: { VERSION_CONTROL: "bad" } })).toMatchObject(await systemRun(["install", "--backup", "source", "installed-backup-env-bad"], "", { env: { VERSION_CONTROL: "bad" } }));
  expect(await run(["install", "--mode", "bad", "source"])).toMatchObject(await systemRun(["install", "--mode", "bad", "source"]));
  expect(await run(["install", "--mode", "bad\nmode", "source", "installed-bad-mode-newline"])).toMatchObject({ code: 1, stderr: `install: invalid mode ${diagnosticQuote("bad\\nmode")}\n` });
  expect(await run(["install", "--group", "definitely-missing-group", "source"])).toMatchObject(await systemRun(["install", "--group", "definitely-missing-group", "source"]));
  expect(await run(["install", "-d", "--mode", "bad"])).toMatchObject(await systemRun(["install", "-d", "--mode", "bad"]));
  expect(await run(["install", "-d", "--mode", "bad", "install-bad-mode-dir"])).toMatchObject(await systemRun(["install", "-d", "--mode", "bad", "install-bad-mode-dir"]));
  expect(await run(["install", "-d", "--mode", "bad\nmode", "install-bad-mode-newline"])).toMatchObject({ code: 1, stderr: `install: invalid mode ${diagnosticQuote("bad\\nmode")}\n` });
  expect(await run(["install", "-C", "-s", "source", "installed-compare-strip"])).toMatchObject({
    code: 1,
    stderr: "install: options --compare (-C) and --strip are mutually exclusive\nTry 'install --help' for more information.\n",
  });
  expect(await run(["install", "/dev/null", "installed-null"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "installed-null"))).size).toBe(0);
  expect((await stat(join(dir, "installed-null"))).mode & 0o777).toBe(0o755);
  expect(await run(["install", "--context=system_u:object_r:tmp_t:s0", "source", "installed-context"])).toMatchObject({
    code: 0,
    stderr: "install: warning: ignoring --context; it requires an SELinux-enabled kernel\n",
  });
  expect(await readFile(join(dir, "installed-context"), "utf8")).toBe("abcdef");
  expect(await run(["install", "--preserve-context", "source", "installed-preserve-context"])).toMatchObject({
    code: 0,
    stderr: "install: WARNING: ignoring --preserve-context; this kernel is not SELinux-enabled\n",
  });
  expect(await readFile(join(dir, "installed-preserve-context"), "utf8")).toBe("abcdef");
  const currentUid = process.getuid?.() ?? (await stat(join(dir, "installed"))).uid;
  const currentGid = process.getgid?.() ?? (await stat(join(dir, "installed"))).gid;
  const installDebug = await run(["install", "--debug", "-o", String(currentUid), "-g", String(currentGid), "source", "installed-owned"]);
  expect(installDebug.stdout).toStartWith("'source' -> 'installed-owned'\n");
  expect(installDebug.stdout).toMatch(/copy offload: (unknown|avoided), reflink: (yes|no), sparse detection: (unknown|no)\n$/);
  expect(await readFile(join(dir, "installed-owned"), "utf8")).toBe("abcdef");
  expect((await stat(join(dir, "installed-owned"))).uid).toBe(currentUid);
  expect((await stat(join(dir, "installed-owned"))).gid).toBe(currentGid);
  expect(await run(["install", "-m", "u=rw,go=r", "source", "installed-symbolic"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "installed-symbolic"))).mode & 0o777).toBe(0o644);
  expect(await run(["install", "-d", "nested/dir"])).toMatchObject({ code: 0 });
  await writeFile(join(dir, "install-existing-file-a"), "");
  await writeFile(join(dir, "install-existing-file-b"), "");
  expect(await run(["install", "-d", "install-existing-file-a", "install-existing-file-b"])).toMatchObject({
    code: 1,
    stderr: "install: cannot create directory 'install-existing-file-a': File exists\ninstall: cannot create directory 'install-existing-file-b': File exists\n",
  });
  expect(await run(["install", "-D", "source", "install-leading/parents/installed"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "install-leading/parents/installed"), "utf8")).toBe("abcdef");
  expect(await run(["install", "-d", "--preserve-context", "-o", String(currentUid), "-g", String(currentGid), "nested/owned-dir"])).toMatchObject({
    code: 0,
    stderr: "install: WARNING: ignoring --preserve-context; this kernel is not SELinux-enabled\n",
  });
  expect((await stat(join(dir, "nested/owned-dir"))).uid).toBe(currentUid);
  expect((await stat(join(dir, "nested/owned-dir"))).gid).toBe(currentGid);
  expect(await run(["install", "-d", "-m", "u=rwx,go=", "private/install-dir"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "private/install-dir"))).mode & 0o777).toBe(0o700);
  expect(await run(["install", "missing\ninstall-source", "install-missing-dest"])).toMatchObject(await systemRun(["install", "missing\ninstall-source", "install-missing-dest"]));
  expect(await run(["install", "missing'install-source", "install-missing-dest"])).toMatchObject(await systemRun(["install", "missing'install-source", "install-missing-dest"]));
  expect(await run(["install", "-t", "missing\ninstall-target", "source"])).toMatchObject(await systemRun(["install", "-t", "missing\ninstall-target", "source"]));
  expect(await run(["install", "-t", "missing'install-target", "source"])).toMatchObject(await systemRun(["install", "-t", "missing'install-target", "source"]));
  await mkdir(join(dir, "install'directory-source"));
  expect(await run(["install", "install'directory-source", "install-dir-source-dest"])).toMatchObject(await systemRun(["install", "install'directory-source", "install-dir-source-dest"]));
  expect(await run(["install", "-d", "-v", "install-dir\nnewline"])).toMatchObject({
    code: 0,
    stdout: "install: creating directory 'install-dir'$'\\n''newline'\n",
  });
  expect(await run(["install", "-d", "-v", "install-dir'quote"])).toMatchObject({
    code: 0,
    stdout: "install: creating directory \"install-dir'quote\"\n",
  });
  expect(await run(["install", "-Dv", "source", "install-parent\nnewline/file'quote"])).toMatchObject({
    code: 0,
    stdout: "install: creating directory 'install-parent'$'\\n''newline'\n'source' -> 'install-parent'$'\\n''newline/file'\\''quote'\n",
  });
  await writeFile(join(dir, "install-replace'quote"), "old");
  expect(await run(["install", "-v", "source", "install-replace'quote"])).toMatchObject({
    code: 0,
    stdout: "removed \"install-replace'quote\"\n'source' -> \"install-replace'quote\"\n",
  });
  expect(await run(["install", "-Dv", "source", "deep/a/b/installed"])).toMatchObject({ code: 0, stdout: "install: creating directory 'deep'\ninstall: creating directory 'deep/a'\ninstall: creating directory 'deep/a/b'\n'source' -> 'deep/a/b/installed'\n" });
  expect(await readFile(join(dir, "deep/a/b/installed"), "utf8")).toBe("abcdef");
  expect(await run(["install", "-t", "target/install/dir", "-Dv", "source"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "target/install/dir/source"), "utf8")).toBe("abcdef");
  expect(await run(["install", "-t", "missing-install-target", "source"])).toMatchObject(await systemRun(["install", "-t", "missing-install-target", "source"]));
  expect(await run(["install", "--target-directory=missing-install-target", "source"])).toMatchObject(await systemRun(["install", "--target-directory=missing-install-target", "source"]));
  expect(await run(["install", "-t", ".", "source"])).toMatchObject({ code: 1, stderr: "install: 'source' and './source' are the same file\n" });
  await writeFile(join(dir, "install\nsame-file"), "same");
  expect(await run(["install", "-t", ".", "install\nsame-file"])).toMatchObject({
    code: 1,
    stderr: "install: 'install'$'\\n''same-file' and './install'$'\\n''same-file' are the same file\n",
  });
  expect(await readFile(join(dir, "source"), "utf8")).toBe("abcdef");
  expect(await run(["install", "--target-directory=target/install/dir", "/dev/null"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "target/install/dir/null"))).size).toBe(0);
  await writeFile(join(dir, "target/install/dir/exact"), "old");
  expect(await run(["install", "--no-target-directory", "source", "target/install/dir/exact"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "target/install/dir/exact"), "utf8")).toBe("abcdef");
  expect(await run(["install", "-T", "source", "target/install/dir"])).toMatchObject({
    code: 1,
    stderr: "install: cannot overwrite directory 'target/install/dir' with non-directory 'source'\n",
  });
  expect(await run(["install", "-T", "source", "target/install/dir/exact", "extra"])).toMatchObject({
    code: 1,
    stderr: "install: extra operand 'extra'\nTry 'install --help' for more information.\n",
  });
  expect(await run(["install", "-T", "source", "target/install/dir/exact", "extra\narg"])).toMatchObject({
    code: 1,
    stderr: "install: extra operand 'extra'$'\\n''arg'\nTry 'install --help' for more information.\n",
  });
  expect(await run(["install", "-Cv", "-m", "755", "source", "target/install/dir/source"])).toMatchObject({ code: 0, stdout: "" });
  await writeFile(join(dir, "timestamp-source"), "same\n");
  await writeFile(join(dir, "timestamp-dest"), "same\n");
  expect(await run(["touch", "-d", "2026-01-01", "timestamp-source"])).toMatchObject({ code: 0 });
  expect(await run(["install", "-C", "--preserve-timestamps", "timestamp-source", "timestamp-dest"])).toMatchObject({ code: 0 });
  expect((await run(["stat", "--format=%y", "timestamp-dest"])).stdout).toStartWith("2026-01-01 ");
  await writeFile(join(dir, "timestamp-short-dest"), "old\n");
  expect(await run(["install", "-p", "timestamp-source", "timestamp-short-dest"])).toMatchObject({ code: 0 });
  expect((await run(["stat", "--format=%y", "timestamp-short-dest"])).stdout).toStartWith("2026-01-01 ");
  await writeFile(join(dir, "install-ns-source"), "ns\n");
  await systemRun(["/usr/bin/touch", "-a", "-d", "2026-01-01 01:02:03.111111111 +0000", "install-ns-source"]);
  await systemRun(["/usr/bin/touch", "-m", "-d", "2026-01-02 03:04:05.222222222 +0000", "install-ns-source"]);
  expect(await run(["install", "-p", "install-ns-source", "install-ns-dest"])).toMatchObject({ code: 0 });
  expect(await run(["stat", "-c", "%x|%y", "install-ns-dest"], "", { env: { TZ: "UTC0" } })).toMatchObject({
    code: 0,
    stdout: "2026-01-01 01:02:03.111111111 +0000|2026-01-02 03:04:05.222222222 +0000\n",
  });
  await writeFile(join(dir, "stripper"), "#!/bin/sh\nsed s/b/B/ \"$1\" > \"$1.t\" && mv \"$1.t\" \"$1\"\n");
  await run(["chmod", "755", "stripper"]);
  expect(await run(["install", "-s", "--strip-program=./stripper", "source", "stripped"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "stripped"), "utf8")).toBe("aBcdef");
  expect(await run(["install", "-s", "--strip-program=./missing'stripper", "source", "missing-stripper"])).toMatchObject(await systemRun(["install", "-s", "--strip-program=./missing'stripper", "source", "missing-stripper"]));
  await writeFile(join(dir, "not-a-dir"), "");
  expect(await run(["ginstall", "-t", "not-a-dir", "-Dv", "source"])).toMatchObject({ code: 1, stderr: "ginstall: failed to access 'not-a-dir': Not a directory\n" });
  const ddCopy = await run(["dd", "if=source", "of=copy", "bs=2", "count=2"]);
  expect(ddCopy).toMatchObject({ code: 0 });
  expect(ddCopy.stderr).toContain("records in");
  expect(await readFile(join(dir, "copy"), "utf8")).toBe("abcd");
  expect(await run(["dd", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: dd [OPERAND]...\n  or:  dd OPTION\n") });
  expect(await run(["dd", "--bad=4"])).toMatchObject({ code: 1, stderr: "dd: unrecognized option '--bad=4'\nTry 'dd --help' for more information.\n" });
  expect(await run(["dd", "foo=bar"])).toMatchObject({ code: 1, stdout: "", stderr: "dd: unrecognized operand 'foo=bar'\nTry 'dd --help' for more information.\n" });
  expect(await run(["dd", "foo\nbar=baz"])).toMatchObject({ code: 1, stdout: "", stderr: "dd: unrecognized operand 'foo'$'\\n''bar=baz'\nTry 'dd --help' for more information.\n" });
  expect(await run(["dd", "if=source", "of=bad-conv", "conv=bad", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: `dd: invalid conversion: ${diagnosticQuote("bad")}\nTry 'dd --help' for more information.\n` });
  expect(await run(["dd", "if=source", "of=bad-conv-newline", "conv=bad\nmode", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: `dd: invalid conversion: ${diagnosticQuote("bad\\nmode")}\nTry 'dd --help' for more information.\n` });
  expect(await run(["dd", "if=source", "of=bad-iflag", "iflag=bad", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: `dd: invalid input flag: ${diagnosticQuote("bad")}\nTry 'dd --help' for more information.\n` });
  expect(await run(["dd", "if=source", "of=bad-oflag", "oflag=bad", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: `dd: invalid output flag: ${diagnosticQuote("bad")}\nTry 'dd --help' for more information.\n` });
  expect(await run(["dd", "if=source", "of=bad-iflag-nolinks", "iflag=nolinks", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: `dd: invalid input flag: ${diagnosticQuote("nolinks")}\nTry 'dd --help' for more information.\n` });
  expect(await run(["dd", "if=source", "of=bad-oflag-nolinks", "oflag=nolinks", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: `dd: invalid output flag: ${diagnosticQuote("nolinks")}\nTry 'dd --help' for more information.\n` });
  expect(await run(["dd", "if=source", "of=quiet-copy", "oflag=directory", "status=none"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "dd: failed to open 'quiet-copy': Invalid argument\n",
  });
  expect(await run(["dd", "oflag=directory", "status=none"], "x")).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "dd: setting flags for 'standard output': Not a directory\n",
  });
  await symlink("source", join(dir, "dd-oflag-link"));
  expect(await run(["dd", "if=source", "of=dd-oflag-link", "oflag=nofollow", "status=none"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "dd: failed to open 'dd-oflag-link': Too many levels of symbolic links\n",
  });
  expect(await run(["dd", "if=source", "of=quiet-copy", "bs=2", "count=1", "status=none"])).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(join(dir, "quiet-copy"), "utf8")).toBe("ab");
  expect(await run(["dd", "if=source", "of=sync-copy", "bs=2", "count=1", "oflag=sync", "status=none"])).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(join(dir, "sync-copy"), "utf8")).toBe("ab");
  expect(await run(["dd", "if=source", "of=dsync-copy", "bs=2", "count=1", "oflag=dsync", "status=none"])).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(join(dir, "dsync-copy"), "utf8")).toBe("ab");
  expect(await run(["dd", "if=source", "of=/dev/null", "count=0", "conv=fdatasync", "status=none"])).toMatchObject({
    code: 1,
    stderr: "dd: fsync failed for '/dev/null': Invalid argument\n",
  });
  expect(await run(["dd", "if=source", "of=/dev/null", "count=0", "conv=fsync", "status=none"])).toMatchObject({
    code: 1,
    stderr: "dd: fsync failed for '/dev/null': Invalid argument\n",
  });
  expect(await run(["dd", "if=missing", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: "dd: failed to open 'missing': No such file or directory\n" });
  await mkdir(join(dir, "dd-dir"));
  expect(await run(["dd", "if=source", "of=dd-dir", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: "dd: failed to open 'dd-dir': Is a directory\n" });
  expect(await run(["dd", "if=dd-dir", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: "dd: error reading 'dd-dir': Is a directory\n" });
  const progressCopy = await run(["dd", "if=source", "of=progress-copy", "bs=2", "count=1", "status=progress"]);
  expect(progressCopy).toMatchObject({ code: 0 });
  expect(progressCopy.stderr).toContain("2 bytes copied");
  expect(progressCopy.stderr).toContain("records out");
  expect(await shell(`mkfifo dd-signal-fifo; (for n in $(seq 1 100); do dd if=/dev/zero bs=64K count=1 status=none; sleep 0.02; done) >dd-signal-fifo & writer=$!; "$BUN" "$BNU" dd if=dd-signal-fifo of=/dev/null bs=64K status=progress 2>dd-signal.err & copier=$!; sleep 0.5; kill -USR1 "$copier"; wait "$copier"; code=$?; wait "$writer"; exit "$code"`)).toMatchObject({ code: 0, stderr: "" });
  const ddSignalStats = await readFile(join(dir, "dd-signal.err"), "utf8");
  expect(ddSignalStats.match(/records in/g)?.length).toBe(2);
  expect(ddSignalStats.match(/records out/g)?.length).toBe(2);
  expect(ddSignalStats).toContain("\r");
  expect(await run(["dd", "if=source", "of=bad-status", "status=bad"])).toMatchObject({ code: 1, stderr: `dd: invalid status level: ${diagnosticQuote("bad")}\nTry 'dd --help' for more information.\n` });
  expect(await run(["dd", "if=source", "of=bad-status-newline", "status=bad\nmode"])).toMatchObject({ code: 1, stderr: `dd: invalid status level: ${diagnosticQuote("bad\\nmode")}\nTry 'dd --help' for more information.\n` });
  expect(await run(["dd", "if=source", "of=bad-bs", "bs=0", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: "dd: invalid number: '0'\n" });
  expect(await run(["dd", "if=source", "of=/dev/null", "bs=1\n2", "status=none"])).toMatchObject(await systemRun(["/usr/bin/dd", "if=source", "of=/dev/null", "bs=1\n2", "status=none"]));
  expect(await run(["dd", "if=source", "of=/dev/null", "bs=bad", "bs=1", "count=0", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: "dd: invalid number: 'bad'\n" });
  expect(await run(["dd", "if=source", "of=/dev/null", "count=9223372036854775808", "count=0", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: "dd: invalid number: '9223372036854775808': Value too large for defined data type\n" });
  expect(await run(["dd", "if=source", "of=/dev/null", "conv=bad", "conv=sync", "count=0"])).toMatchObject({ code: 1, stdout: "", stderr: `dd: invalid conversion: ${diagnosticQuote("bad")}\nTry 'dd --help' for more information.\n` });
  expect(await run(["dd", "if=source", "of=/dev/null", "status=bad", "status=none", "count=0"])).toMatchObject({ code: 1, stdout: "", stderr: `dd: invalid status level: ${diagnosticQuote("bad")}\nTry 'dd --help' for more information.\n` });
  expect(await run(["dd", "if=source", "of=/dev/null", "skip=0x1", "skip=0", "count=0", "status=none"])).toMatchObject({ code: 0, stdout: "", stderr: `dd: warning: ${diagnosticQuote("0x")} is a zero multiplier; use ${diagnosticQuote("00x")} if that is intended\n` });
  await writeFile(join(dir, "patch-target"), "XXXXXX");
  expect(await run(["dd", "if=source", "of=patch-target", "bs=2", "count=1", "seek=1", "conv=notrunc"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "patch-target"), "utf8")).toBe("XXabXX");
  await writeFile(join(dir, "truncate-before-copy"), "XXXXXX");
  expect(await run(["dd", "if=source", "of=truncate-before-copy", "bs=2", "count=1", "seek=1", "status=none"])).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(join(dir, "truncate-before-copy"), "utf8")).toBe("XXab");
  expect(await run(["dd", "if=source", "iflag=nocache", "count=0", "status=none"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["dd", "if=source", "of=count-bytes", "bs=2", "count=3", "iflag=count_bytes"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "count-bytes"), "utf8")).toBe("abc");
  expect(await run(["dd", "if=source", "of=count-word", "bs=1", "count=2w", "status=none"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "count-word"), "utf8")).toBe("abcd");
  expect(await run(["dd", "if=source", "of=count-decimal-kb", "bs=1", "count=1KB", "status=none"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "count-decimal-kb"), "utf8")).toBe("abcdef");
  expect(await run(["dd", "if=source", "of=/dev/null", "bs=1P", "count=0", "status=none"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["dd", "if=source", "of=/dev/null", "bs=1EB", "count=0", "status=none"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["dd", "if=source", "of=/dev/null", "bs=1Z", "count=0", "status=none"])).toMatchObject(await systemRun(["/usr/bin/dd", "if=source", "of=/dev/null", "bs=1Z", "count=0", "status=none"]));
  expect(await run(["dd", "if=source", "of=/dev/null", "bs=1R", "count=0", "status=none"])).toMatchObject(await systemRun(["/usr/bin/dd", "if=source", "of=/dev/null", "bs=1R", "count=0", "status=none"]));
  expect(await run(["dd", "if=source", "of=/dev/null", "bs=1Q", "count=0", "status=none"])).toMatchObject(await systemRun(["/usr/bin/dd", "if=source", "of=/dev/null", "bs=1Q", "count=0", "status=none"]));
  expect(await run(["dd", "if=source", "of=skip-bytes", "bs=2", "skip=1", "count=2", "iflag=skip_bytes,count_bytes"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "skip-bytes"), "utf8")).toBe("bc");
  await writeFile(join(dir, "seek-bytes"), "XXXX");
  expect(await run(["dd", "if=source", "of=seek-bytes", "bs=2", "count=1", "seek=1", "oflag=seek_bytes", "conv=notrunc"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "seek-bytes"), "utf8")).toBe("XabX");
  expect(await run(["dd", "if=source", "of=append-created", "bs=2", "count=1", "oflag=append", "conv=notrunc", "status=none"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "append-created"), "utf8")).toBe("ab");
  await writeFile(join(dir, "append-existing"), "XX");
  expect(await run(["dd", "if=source", "of=append-existing", "bs=2", "count=1", "oflag=append", "conv=notrunc", "status=none"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "append-existing"), "utf8")).toBe("XXab");
  await writeFile(join(dir, "dd-excl-existing"), "keep");
  expect(await run(["dd", "if=source", "of=dd-excl-existing", "conv=excl", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: "dd: failed to open 'dd-excl-existing': File exists\n" });
  expect(await readFile(join(dir, "dd-excl-existing"), "utf8")).toBe("keep");
  expect(await run(["dd", "if=source", "of=dd-nocreat-missing", "conv=nocreat", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: "dd: failed to open 'dd-nocreat-missing': No such file or directory\n" });
  expect(await run(["dd", "if=source", "of=dd-nocreat-excl", "conv=nocreat,excl", "status=none"])).toMatchObject({ code: 1, stdout: "", stderr: "dd: cannot combine excl and nocreat\n" });
  expect(await run(["dd", "if=source", "of=ibs-copy", "ibs=3", "count=1"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "ibs-copy"), "utf8")).toBe("abc");
  await writeFile(join(dir, "obs-target"), "XXXXXXXX");
  expect(await run(["dd", "if=source", "of=obs-target", "ibs=2", "obs=3", "count=1", "seek=1", "conv=notrunc"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "obs-target"), "utf8")).toBe("XXXabXXX");
  expect(await run(["dd", "of=sync-pad", "bs=8", "conv=sync", "status=none"], "abc")).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "sync-pad"))).size).toBe(8);
  await writeFile(join(dir, "sparse-input"), Buffer.from([0x61, 0, 0, 0x62]));
  expect(await run(["dd", "if=sparse-input", "of=sparse-copy", "bs=1", "conv=sparse", "status=none"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "sparse-copy"))).toEqual(Buffer.from([0x61, 0, 0, 0x62]));
  await writeFile(join(dir, "sparse-patch"), "____");
  expect(await run(["dd", "if=sparse-input", "of=sparse-patch", "bs=1", "conv=sparse,notrunc", "status=none"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "sparse-patch"), "utf8")).toBe("a__b");
  expect(await shell(`$BUN "$BNU" dd if=sparse-input bs=1 conv=sparse oflag=append status=none > sparse-append`)).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "sparse-append"), "utf8")).toBe("ab");
  expect((await run(["dircolors", "-p"])).stdout).toContain("DIR 01;34");
  expect((await run(["dircolors", "-p"])).stdout).toContain(".tar 01;31");
  expect((await run(["dircolors", "-p"])).stdout).toContain(".jpg 01;35");
  expect((await run(["dircolors", "-p"])).stdout).toContain("*~ 00;90");
  expect((await run(["dircolors", "--bourne-shell"])).stdout).toContain("LS_COLORS='rs=0:di=01;34");
  expect((await run(["dircolors", "--bourne-shell"])).stdout).toContain("*.tar=01;31");
  expect((await run(["dircolors", "--bourne-shell"])).stdout).toContain("*.jpg=01;35");
  expect((await run(["dircolors", "--bourne-shell"])).stdout).toContain("*~=00;90:*#=00;90");
  expect((await run(["dircolors", "--c-shell"])).stdout).toContain("setenv LS_COLORS 'rs=0:di=01;34");
  expect((await run(["dircolors", "--c-shell"])).stdout).toContain("*.mp3=00;36");
  await writeFile(join(dir, "colors.db"), "DIR 01;35\nEXEC 01;32\n");
  expect((await run(["dircolors", "colors.db"])).stdout).toContain("LS_COLORS='di=01;35:ex=01;32:'");
  expect(await run(["dircolors", "-b", "-"], "exec 'echo Hello;:'\n")).toMatchObject({ code: 0, stdout: "LS_COLORS='ex='\\''echo Hello;\\:'\\'':';\nexport LS_COLORS\n" });
  expect(await run(["dircolors", "-b", "-"], "TERM nomatch\nowt 40;33\n")).toMatchObject({ code: 0, stdout: "LS_COLORS='';\nexport LS_COLORS\n" });
  expect(await run(["dircolors", "-b", "-"], "TERM non*\nowt 40;33\n", { env: { TERM: "none" } })).toMatchObject({ code: 0, stdout: "LS_COLORS='tw=40;33:';\nexport LS_COLORS\n" });
  expect((await run(["dircolors", "-b"], "DIR 01;35\n")).stdout).toContain("di=01;34");
  expect(await run(["dircolors", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: dircolors [OPTION]... [FILE]\n") });
  expect(await run(["dircolors", "-b", "-"], "COLORTERM ?*\nowt 40;33\n", { env: { COLORTERM: "any" } })).toMatchObject({ code: 0, stdout: "LS_COLORS='tw=40;33:';\nexport LS_COLORS\n" });
  expect(await run(["dircolors", "-b", "-"], ".tar 01;31\n*.zip 01;31\n")).toMatchObject({ code: 0, stdout: "LS_COLORS='*.tar=01;31:*.zip=01;31:';\nexport LS_COLORS\n" });
  expect(await run(["dircolors", "-b", "-"], ".FOO 01;31\n*.BAR 01;32\n")).toMatchObject({ code: 0, stdout: "LS_COLORS='*.FOO=01;31:*.BAR=01;32:';\nexport LS_COLORS\n" });
  expect(await run(["dircolors", "-c", "-"], "LEFTCODE \x1b[\nRIGHTCODE m\nENDCODE \x1b[0m\n")).toMatchObject({ code: 0, stdout: "setenv LS_COLORS 'lc=\x1b[:rc=m:ec=\x1b[0m:'\n" });
  expect(await run(["dircolors", "-b", "-"], ".foo 01\\:31\n")).toMatchObject({ code: 0, stdout: "LS_COLORS='*.foo=01\\:31:';\nexport LS_COLORS\n" });
  await writeFile(join(dir, "color-colon.foo"), "x");
  expect((await run(["ls", "-1", "--color=always", "color-colon.foo"], "", { env: { LS_COLORS: "*.foo=01\\:31:" } })).stdout).toBe("\x1b[0m\x1b[01:31mcolor-colon.foo\x1b[0m\n");
  expect(await run(["dircolors", "--print-ls-colors", "-"], "OWT 40;33\n")).toMatchObject({ code: 0, stdout: "\x1B[40;33mtw\t40;33\x1B[0m\n" });
  expect((await run(["dircolors", "--print-ls-colors"])).stdout).toContain("\x1B[01;31m*.tar\t01;31\x1B[0m\n");
  expect((await run(["dircolors", "--print-ls-colors"])).stdout).toContain("\x1B[00;90m*~\t00;90\x1B[0m\n");
  expect(await run(["dircolors", "--print-ls", "-"], "OWT 40;33\n")).toMatchObject({ code: 0, stdout: "\x1B[40;33mtw\t40;33\x1B[0m\n" });
  expect((await run(["dircolors", "--print", "--help"])).stderr).toContain("option '--print' is ambiguous");
  expect((await run(["dircolors", "--print-d=foo", "--help"])).stderr).toContain("option '--print-database' doesn't allow an argument");
  expect((await run(["dircolors", "--bad", "--help"])).stderr).toContain("unrecognized option '--bad'");
  expect((await run(["dircolors", "-x", "--help"])).stderr).toContain("invalid option -- 'x'");
  expect((await run(["dircolors", "colors.db", "--b"])).stdout).toContain("LS_COLORS='di=01;35:ex=01;32:'");
  expect(await run(["dircolors", "colors.db", "colors.db"])).toMatchObject({ code: 1, stdout: "", stderr: `dircolors: extra operand ${diagnosticQuote("colors.db")}\nTry 'dircolors --help' for more information.\n` });
  expect(await run(["dircolors", "colors.db", "extra\narg"])).toMatchObject({ code: 1, stdout: "", stderr: `dircolors: extra operand ${diagnosticQuote("extra\\narg")}\nTry 'dircolors --help' for more information.\n` });
  expect((await run(["dircolors", "-p", "--print-ls-colors"])).stderr).toContain("mutually exclusive");
  expect(await run(["dircolors", "-p", "colors.db"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `dircolors: extra operand ${diagnosticQuote("colors.db")}\nfile operands cannot be combined with --print-database (-p)\nTry 'dircolors --help' for more information.\n`,
  });
  expect(await run(["dircolors", "-p", "extra\narg"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `dircolors: extra operand ${diagnosticQuote("extra\\narg")}\nfile operands cannot be combined with --print-database (-p)\nTry 'dircolors --help' for more information.\n`,
  });
  expect(await run(["dircolors", "-p", "--bourne-shell", "colors.db"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "dircolors: the options to output non shell syntax,\nand to select a shell syntax are mutually exclusive\nTry 'dircolors --help' for more information.\n",
  });
  expect(await run(["dircolors", "--bourne-shell", "missing-colors"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "dircolors: missing-colors: No such file or directory\n",
  });
  expect(await run(["dircolors", "missing'dircolors"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "dircolors: \"missing'dircolors\": No such file or directory\n",
  });
  expect(await run(["dircolors", "missing\ndircolors"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "dircolors: 'missing'$'\\n''dircolors': No such file or directory\n",
  });
  await mkdir(join(dir, "dir'dircolors"));
  expect(await run(["dircolors", "dir'dircolors"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "dircolors: \"dir'dircolors\": read error: Is a directory\n",
  });
  await symlink("loop'dircolors", join(dir, "loop'dircolors"));
  expect(await run(["dircolors", "loop'dircolors"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "dircolors: \"loop'dircolors\": Too many levels of symbolic links\n",
  });
  expect(await run(["dircolors", "--print-ls-colors", "missing-colors"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "dircolors: missing-colors: No such file or directory\n",
  });
  expect(await run(["dircolors", "one", "two"])).toMatchObject({ code: 1 });
  await writeFile(join(dir, "secret"), "topsecret");
  expect(await run(["shred", "-n", "1", "-z", "secret"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "secret"))).toEqual(new Uint8Array(9));
  expect(await run(["shred", "--random-source=missing-random", "-n1", "secret"])).toMatchObject({ code: 1, stdout: "", stderr: "shred: missing-random: No such file or directory\n" });
  await writeFile(join(dir, "shred-random"), new Uint8Array([0, 0, 0, 0, 0, 0]));
  await writeFile(join(dir, "shred-random-target"), "abcdef");
  expect(await run(["shred", "--random-source=shred-random", "-n1", "--exact", "shred-random-target"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "shred-random-target"))).toEqual(new Uint8Array(6));
  await writeFile(join(dir, "shred-short-random"), new Uint8Array([0, 0, 0, 0]));
  await writeFile(join(dir, "shred-short-target"), "abcdef");
  expect(await run(["shred", "--random-source=shred-short-random", "-n1", "--exact", "shred-short-target"])).toMatchObject({ code: 1, stdout: "", stderr: `shred: ${diagnosticQuote("shred-short-random")}: end of file\n` });
  expect(await readFile(join(dir, "shred-short-target"), "utf8")).toBe("abcdef");
  expect(await run(["shred", "-x", "-n0", "secret"])).toMatchObject({ code: 0 });
  expect(await run(["shred", "--iter=0", "secret"])).toMatchObject({ code: 0 });
  expect((await run(["shred", "--ex", "--help"])).stdout).toContain("Usage: shred [OPTION]... FILE...\n");
  expect((await run(["shred", "-x", "--help"])).stdout).toContain("Usage: shred [OPTION]... FILE...\n");
  expect((await run(["shred", "--r", "--help"])).stderr).toContain("option '--r' is ambiguous; possibilities: '--random-source' '--remove'");
  expect(await run(["shred", "--random", "--help", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["shred", "--remove", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: shred [OPTION]... FILE...\n") });
  expect(await run(["shred", "secret", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: shred [OPTION]... FILE...\n"), stderr: "" });
  expect(await run(["shred", "--size", "--help", "--version"])).toMatchObject({ code: 1, stderr: `shred: invalid file size: ${diagnosticQuote("--help")}\n` });
  expect(await run(["shred", "--iterations", "--help", "--version"])).toMatchObject(await systemRun(["shred", "--iterations", "--help", "--version"]));
  expect(await run(["shred", "-vsbad", "--help"])).toMatchObject({ code: 1, stderr: `shred: invalid file size: ${diagnosticQuote("bad")}\n` });
  expect(await run(["shred", "-vnbad", "--help"])).toMatchObject({ code: 1, stderr: `shred: invalid number of passes: ${diagnosticQuote("bad")}\n` });
  expect(await run(["shred", "--remove=", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `shred: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--remove")}\nValid arguments are:\n  - ${diagnosticQuote("unlink")}\n  - ${diagnosticQuote("wipe")}\n  - ${diagnosticQuote("wipesync")}\nTry 'shred --help' for more information.\n`,
  });
  expect(await run(["shred", "--remove=bad", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `shred: invalid argument ${diagnosticQuote("bad")} for ${diagnosticQuote("--remove")}\nValid arguments are:\n  - ${diagnosticQuote("unlink")}\n  - ${diagnosticQuote("wipe")}\n  - ${diagnosticQuote("wipesync")}\nTry 'shred --help' for more information.\n`,
  });
  expect(await run(["shred", "--remove=bad\nmode", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `shred: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--remove")}\nValid arguments are:\n  - ${diagnosticQuote("unlink")}\n  - ${diagnosticQuote("wipe")}\n  - ${diagnosticQuote("wipesync")}\nTry 'shred --help' for more information.\n`,
  });
  expect(await run(["shred", "--remove=w", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `shred: ambiguous argument ${diagnosticQuote("w")} for ${diagnosticQuote("--remove")}\nValid arguments are:\n  - ${diagnosticQuote("unlink")}\n  - ${diagnosticQuote("wipe")}\n  - ${diagnosticQuote("wipesync")}\nTry 'shred --help' for more information.\n`,
  });
  await writeFile(join(dir, "shred-remove-prefix"), "");
  expect(await run(["shred", "--remove=u", "-n0", "-s0", "shred-remove-prefix"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "shred-remove-prefix"))).rejects.toThrow();
  await writeFile(join(dir, "shred-remove-wipesync-prefix"), "");
  expect(await run(["shred", "--remove=wipes", "-n0", "-s0", "shred-remove-wipesync-prefix"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "shred-remove-wipesync-prefix"))).rejects.toThrow();
  expect((await run(["shred", "--zero=bad", "--help"])).stderr).toContain("option '--zero' doesn't allow an argument");
  expect(await run(["shred", "-n", "+0", "secret"])).toMatchObject({ code: 0 });
  expect(await run(["shred", "-n", "1\n2", "secret"])).toMatchObject({ code: 1, stdout: "", stderr: `shred: invalid number of passes: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["shred", "-n", "0x1", "secret"])).toMatchObject(await systemRun(["shred", "-n", "0x1", "secret"]));
  expect(await run(["shred", "-n", "1.5", "secret"])).toMatchObject(await systemRun(["shred", "-n", "1.5", "secret"]));
  expect(await run(["shred", "-n", "-1", "secret"])).toMatchObject(await systemRun(["shred", "-n", "-1", "secret"]));
  expect(await run(["shred", "-s", "bad", "secret"])).toMatchObject({ code: 1, stderr: `shred: invalid file size: ${diagnosticQuote("bad")}\n` });
  expect(await run(["shred", "-s", "1\n2", "secret"])).toMatchObject({ code: 1, stdout: "", stderr: `shred: invalid file size: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["shred", "--size=bad", "secret"])).toMatchObject({ code: 1, stderr: `shred: invalid file size: ${diagnosticQuote("bad")}\n` });
  await writeFile(join(dir, "shred-size-byte"), "abcdef");
  expect(await run(["shred", "-n1", "--size=1B", "shred-size-byte"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "shred-size-byte"))).size).toBe(1);
  expect(await run(["shred", "--size=0x10", "secret"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "secret"))).size).toBe(16);
  expect(await run(["shred", "missing'shred"])).toMatchObject({ code: 1, stdout: "", stderr: "shred: \"missing'shred\": failed to open for writing: No such file or directory\n" });
  expect(await run(["shred", "missing\nshred"])).toMatchObject({ code: 1, stdout: "", stderr: "shred: 'missing'$'\\n''shred': failed to open for writing: No such file or directory\n" });
  await mkdir(join(dir, "dir'shred"));
  expect(await run(["shred", "dir'shred"])).toMatchObject({ code: 1, stdout: "", stderr: "shred: \"dir'shred\": failed to open for writing: Is a directory\n" });
  await symlink("loop'shred", join(dir, "loop'shred"));
  expect(await run(["shred", "loop'shred"])).toMatchObject({ code: 1, stdout: "", stderr: "shred: \"loop'shred\": failed to open for writing: Too many levels of symbolic links\n" });
  await writeFile(join(dir, "remove-secret"), "hidden");
  const shredVerbose = await run(["shred", "-f", "-v", "-n", "1", "--remove=unlink", "remove-secret"]);
  expect(shredVerbose).toMatchObject({ code: 0 });
  expect(shredVerbose.stderr).toContain("shred: remove-secret: pass 1/1 (random)...");
  expect(shredVerbose.stderr).toContain("shred: remove-secret: removed");
  await expect(stat(join(dir, "remove-secret"))).rejects.toThrow();
  await writeFile(join(dir, "remove'shred"), "hidden");
  expect(await run(["shred", "-v", "-n", "0", "--remove=unlink", "remove'shred"])).toMatchObject({
    code: 0,
    stdout: "",
    stderr: "shred: \"remove'shred\": removing\nshred: \"remove'shred\": removed\n",
  });
  await expect(stat(join(dir, "remove'shred"))).rejects.toThrow();
});

test("ownership and passthrough command surfaces", async () => {
  expect(await run(["chown"])).toMatchObject({
    code: 1,
    stderr: "chown: missing operand\nTry 'chown --help' for more information.\n",
  });
  expect(await run(["chown", "root"])).toMatchObject({
    code: 1,
    stderr: "chown: missing operand after 'root'\nTry 'chown --help' for more information.\n",
  });
  expect(await run(["chgrp"])).toMatchObject({
    code: 1,
    stderr: "chgrp: missing operand\nTry 'chgrp --help' for more information.\n",
  });
  expect(await run(["chgrp", "root"])).toMatchObject({
    code: 1,
    stderr: "chgrp: missing operand after 'root'\nTry 'chgrp --help' for more information.\n",
  });
  const currentUid = process.getuid?.() ?? (await stat(dir)).uid;
  const currentGid = process.getgid?.() ?? (await stat(dir)).gid;
  const absentUid = currentUid + 12345;
  const currentUserName = (await systemRun(["id", "-un"])).stdout.trim();
  const currentGroupName = (await systemRun(["id", "-gn"])).stdout.trim();
  await writeFile(join(dir, "owner-ref"), "ref");
  await writeFile(join(dir, "owner-target"), "target");
  await symlink("missing-owner-target", join(dir, "owner-dangling"));
  await mkdir(join(dir, "owner-post"));
  await writeFile(join(dir, "owner-post/file"), "child");
  await mkdir(join(dir, "owner-real"));
  await writeFile(join(dir, "owner-real/file"), "linked");
  await mkdir(join(dir, "owner-links"));
  await symlink("../owner-real", join(dir, "owner-links/linkdir"));
  await writeFile(join(dir, "owner-chown-fail"), "target");
  await writeFile(join(dir, "owner-chgrp-fail"), "target");
  expect(await run(["chown", "-v", ":", "owner-target"])).toMatchObject({
    code: 0,
    stdout: "ownership of 'owner-target' retained\n",
  });
  expect(await run(["chown", "-R", "-v", String(currentUid), "owner-post"])).toMatchObject({
    code: 0,
    stdout: `ownership of 'owner-post/file' retained as ${currentUserName}\nownership of 'owner-post' retained as ${currentUserName}\n`,
  });
  expect(await run(["chown", "-R", "-v", String(currentUid), "owner-links/linkdir"])).toMatchObject({
    code: 0,
    stdout: `ownership of 'owner-links/linkdir' retained as ${currentUserName}\n`,
  });
  expect(await run(["chown", "-RH", "-v", String(currentUid), "owner-links/linkdir"])).toMatchObject({
    code: 0,
    stdout: `ownership of 'owner-links/linkdir/file' retained as ${currentUserName}\nownership of 'owner-links/linkdir' retained as ${currentUserName}\n`,
  });
  expect(await run(["chown", "-v", ":", "owner-dangling"])).toMatchObject({
    code: 1,
    stdout: "failed to change ownership of 'owner-dangling'\n",
    stderr: "chown: cannot dereference 'owner-dangling': No such file or directory\n",
  });
  expect(await run(["chown", "-v", String(currentUid), "owner-missing-verbose"])).toMatchObject({
    code: 1,
    stdout: `failed to change ownership of 'owner-missing-verbose' to ${currentUid}\n`,
    stderr: "chown: cannot access 'owner-missing-verbose': No such file or directory\n",
  });
  expect(await run(["chown", "-v", `:${currentGid}`, "owner-missing-group-verbose"])).toMatchObject({
    code: 1,
    stdout: `failed to change group of 'owner-missing-group-verbose' to ${currentGid}\n`,
    stderr: "chown: cannot access 'owner-missing-group-verbose': No such file or directory\n",
  });
  await symlink("missing-owner-target", join(dir, "owner\nlink"));
  expect(await run(["chown", "-v", ":", "owner\nlink"])).toMatchObject({
    code: 1,
    stdout: "failed to change ownership of 'owner'$'\\n''link'\n",
    stderr: "chown: cannot dereference 'owner'$'\\n''link': No such file or directory\n",
  });
  expect(await run(["chown", "-v", String(currentUid), "owner-target"])).toMatchObject({
    code: 0,
    stdout: `ownership of 'owner-target' retained as ${currentUserName}\n`,
  });
  expect(await run(["chown", "-v", `${currentUid}:${currentGid}`, "owner-target"])).toMatchObject({
    code: 0,
    stdout: `ownership of 'owner-target' retained as ${currentUserName}:${currentGroupName}\n`,
  });
  expect(await run(["chown", "-c", `${currentUid}:${currentGid}`, "owner-target"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["chown", `+${currentUid}:+${currentGid}`, "owner-target"])).toMatchObject({ code: 0 });
  expect(await run(["chown", `${currentUid}.${currentGid}`, "owner-target"])).toMatchObject({
    code: 0,
    stderr: `chown: warning: '.' should be ':': '${currentUid}.${currentGid}'\n`,
  });
  expect(await run(["chown", "root", "owner-chown-fail"])).toMatchObject(await systemRun(["/usr/bin/chown", "root", "owner-chown-fail"]));
  expect(await run(["chown", `no-such-bnu-user.${currentGroupName}`, "owner-target"])).toMatchObject(await systemRun(["/usr/bin/chown", `no-such-bnu-user.${currentGroupName}`, "owner-target"]));
  expect(await run(["chown", "no-such\nuser", "owner-target"])).toMatchObject({
    code: 1,
    stderr: `chown: invalid user: ${diagnosticQuote("no-such\\nuser")}\n`,
  });
  expect(await run(["chown", `${currentUid}.`, "owner-target"])).toMatchObject(await systemRun(["/usr/bin/chown", `${currentUid}.`, "owner-target"]));
  expect(await run(["chown", ":no-such-bnu-group", "owner-target"])).toMatchObject(await systemRun(["/usr/bin/chown", ":no-such-bnu-group", "owner-target"]));
  expect(await run(["chown", `${currentUid}:no-such-bnu-group`, "owner-target"])).toMatchObject(await systemRun(["/usr/bin/chown", `${currentUid}:no-such-bnu-group`, "owner-target"]));
  expect(await run(["chown", "no-such-bnu-user:", "owner-target"])).toMatchObject({
    code: 1,
    stderr: `chown: invalid spec: ${diagnosticQuote("no-such-bnu-user:")}\n`,
  });
  expect(await run(["chown", "123\n:", "owner-target"])).toMatchObject({
    code: 1,
    stderr: `chown: invalid spec: ${diagnosticQuote("123\\n:")}\n`,
  });
  expect(await run(["chown", `--from=${currentUid}:no-such-bnu-group`, String(currentUid), "owner-target"])).toMatchObject(await systemRun(["/usr/bin/chown", `--from=${currentUid}:no-such-bnu-group`, String(currentUid), "owner-target"]));
  expect(await run(["chown", "--changes", String(currentUid), "owner-target"])).toMatchObject({ code: 0 });
  expect(await run(["chown", `--from=${absentUid}`, "-v", String(currentUid), "owner-target"])).toMatchObject({
    code: 0,
    stdout: `ownership of 'owner-target' retained as ${currentUserName}\n`,
  });
  expect(await run(["chown", `--from=${absentUid}`, "-c", String(currentUid), "owner-target"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["chown", `--from=${currentUid}`, String(currentUid), "owner-target"])).toMatchObject({ code: 0 });
  expect(await run(["chown", "--from", "--help", "--version"])).toMatchObject(await systemRun(["/usr/bin/chown", "--from", "--help", "--version"]));
  expect(await run(["chown", `--from=${currentUid}`, "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: chown [OPTION]... [OWNER][:[GROUP]] FILE...\n  or:  chown [OPTION]... --reference=RFILE FILE...\n") });
  expect(await run(["chown", "--reference=owner-ref", "owner-target"])).toMatchObject({ code: 0 });
  expect(await run(["chown", "--ref=owner-ref", "owner-target"])).toMatchObject({ code: 0 });
  expect((await run(["chown", "--ref=missing-ref", "--help"])).stdout).toContain("Usage: chown");
  expect(await run(["chown", "--r", "--help"])).toMatchObject({ code: 1, stderr: "chown: option '--r' is ambiguous; possibilities: '--recursive' '--reference'\nTry 'chown --help' for more information.\n" });
  expect(await run(["chown", "--changes=bad", "--help"])).toMatchObject({ code: 1, stderr: "chown: option '--changes' doesn't allow an argument\nTry 'chown --help' for more information.\n" });
  expect(await run(["chown", "--bad", "--help"])).toMatchObject({ code: 1, stderr: "chown: unrecognized option '--bad'\nTry 'chown --help' for more information.\n" });
  expect(await run(["chown", "-Rbad", "--help"])).toMatchObject({ code: 1, stderr: "chown: invalid option -- 'b'\nTry 'chown --help' for more information.\n" });
  expect((await stat(join(dir, "owner-target"))).uid).toBe((await stat(join(dir, "owner-ref"))).uid);
  expect(await run(["chown", "--reference=missing-ref", "owner-target"])).toMatchObject({
    code: 1,
    stderr: "chown: failed to get attributes of 'missing-ref': No such file or directory\n",
  });
  expect(await run(["chown", "--reference", "owner-ref"])).toMatchObject({
    code: 1,
    stderr: "chown: missing operand\nTry 'chown --help' for more information.\n",
  });
  expect(await run(["chown", "--reference=owner-ref", "missing-owner"])).toMatchObject({
    code: 1,
    stderr: "chown: cannot access 'missing-owner': No such file or directory\n",
  });
  expect(await run(["chown", String(currentUid), "missing\nowner"])).toMatchObject({
    code: 1,
    stderr: "chown: cannot access 'missing'$'\\n''owner': No such file or directory\n",
  });
  expect(await run(["chown", String(currentUid), "missing'owner"])).toMatchObject({
    code: 1,
    stderr: "chown: cannot access \"missing'owner\": No such file or directory\n",
  });
  await writeFile(join(dir, "owner\nverbose"), "target");
  expect(await run(["chown", "-v", String(currentUid), "owner\nverbose"])).toMatchObject({
    code: 0,
    stdout: `ownership of 'owner'$'\\n''verbose' retained as ${currentUserName}\n`,
  });
  await writeFile(join(dir, "owner'verbose"), "target");
  expect(await run(["chown", "-v", String(currentUid), "owner'verbose"])).toMatchObject({
    code: 0,
    stdout: `ownership of "owner'verbose" retained as ${currentUserName}\n`,
  });
  expect(await run(["chgrp", "--changes", String(currentGid), "owner-target"])).toMatchObject({ code: 0 });
  expect(await run(["chgrp", `+${currentGid}`, "owner-target"])).toMatchObject({ code: 0 });
  expect(await run(["chgrp", `--from=${currentGid}`, String(currentGid), "owner-target"])).toMatchObject({ code: 0 });
  expect(await run(["chgrp", `--from=${currentUid}:${currentGid}`, String(currentGid), "owner-target"])).toMatchObject({ code: 0 });
  expect(await run(["chgrp", `--from=${currentUid}.${currentGid}`, String(currentGid), "owner-target"])).toMatchObject({
    code: 0,
    stderr: `chgrp: warning: '.' should be ':': '${currentUid}.${currentGid}'\n`,
  });
  expect(await run(["chgrp", "-R", "root", "owner-chgrp-fail"])).toMatchObject(await systemRun(["/usr/bin/chgrp", "-R", "root", "owner-chgrp-fail"]));
  expect(await run(["chgrp", "no-such-bnu-group", "owner-target"])).toMatchObject(await systemRun(["/usr/bin/chgrp", "no-such-bnu-group", "owner-target"]));
  expect(await run(["chgrp", "no-such\ngroup", "owner-target"])).toMatchObject({
    code: 1,
    stderr: `chgrp: invalid group: ${diagnosticQuote("no-such\\ngroup")}\n`,
  });
  expect(await run(["chgrp", "--from=no-such-bnu-user", String(currentGid), "owner-target"])).toMatchObject(await systemRun(["/usr/bin/chgrp", "--from=no-such-bnu-user", String(currentGid), "owner-target"]));
  expect(await run(["chgrp", `--from=${currentUid}:no-such-bnu-group`, String(currentGid), "owner-target"])).toMatchObject(await systemRun(["/usr/bin/chgrp", `--from=${currentUid}:no-such-bnu-group`, String(currentGid), "owner-target"]));
  expect(await run(["chgrp", "-v", String(currentGid), "owner-target"])).toMatchObject({
    code: 0,
    stdout: `group of 'owner-target' retained as ${currentGroupName}\n`,
  });
  expect(await run(["chgrp", "-v", String(currentGid), "group-missing-verbose"])).toMatchObject({
    code: 1,
    stdout: `failed to change group of 'group-missing-verbose' to ${currentGid}\n`,
    stderr: "chgrp: cannot access 'group-missing-verbose': No such file or directory\n",
  });
  expect(await run(["chgrp", "-R", "-v", String(currentGid), "owner-links/linkdir"])).toMatchObject({
    code: 0,
    stdout: `group of 'owner-links/linkdir' retained as ${currentGroupName}\n`,
  });
  expect(await run(["chgrp", `--from=${absentUid}`, "-v", String(currentGid), "owner-target"])).toMatchObject({
    code: 0,
    stdout: `group of 'owner-target' retained as ${currentGroupName}\n`,
  });
  expect(await run(["chgrp", `--from=${absentUid}`, "-c", String(currentGid), "owner-target"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["chgrp", "-c", String(currentGid), "owner-target"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["chgrp", "--from", "--help", "--version"])).toMatchObject(await systemRun(["/usr/bin/chgrp", "--from", "--help", "--version"]));
  expect(await run(["chgrp", `--from=${currentUid}`, "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: chgrp [OPTION]... GROUP FILE...\n  or:  chgrp [OPTION]... --reference=RFILE FILE...\n") });
  expect(await run(["chgrp", "--reference=owner-ref", "owner-target"])).toMatchObject({ code: 0 });
  expect(await run(["chgrp", "--ref=owner-ref", "owner-target"])).toMatchObject({ code: 0 });
  expect((await run(["chgrp", "--ref=missing-ref", "--help"])).stdout).toContain("Usage: chgrp");
  expect(await run(["chgrp", "--r", "--help"])).toMatchObject({ code: 1, stderr: "chgrp: option '--r' is ambiguous; possibilities: '--recursive' '--reference'\nTry 'chgrp --help' for more information.\n" });
  expect(await run(["chgrp", "--changes=bad", "--help"])).toMatchObject({ code: 1, stderr: "chgrp: option '--changes' doesn't allow an argument\nTry 'chgrp --help' for more information.\n" });
  expect(await run(["chgrp", "--bad", "--help"])).toMatchObject({ code: 1, stderr: "chgrp: unrecognized option '--bad'\nTry 'chgrp --help' for more information.\n" });
  expect(await run(["chgrp", "-Rbad", "--help"])).toMatchObject({ code: 1, stderr: "chgrp: invalid option -- 'b'\nTry 'chgrp --help' for more information.\n" });
  expect((await stat(join(dir, "owner-target"))).gid).toBe((await stat(join(dir, "owner-ref"))).gid);
  expect(await run(["chgrp", "--reference=missing-ref", "owner-target"])).toMatchObject({
    code: 1,
    stderr: "chgrp: failed to get attributes of 'missing-ref': No such file or directory\n",
  });
  expect(await run(["chgrp", "--reference", "owner-ref"])).toMatchObject({
    code: 1,
    stderr: "chgrp: missing operand\nTry 'chgrp --help' for more information.\n",
  });
  expect(await run(["chgrp", "--reference=owner-ref", "missing-group"])).toMatchObject({
    code: 1,
    stderr: "chgrp: cannot access 'missing-group': No such file or directory\n",
  });
  expect(await run(["chgrp", String(currentGid), "missing\ngroup"])).toMatchObject({
    code: 1,
    stderr: "chgrp: cannot access 'missing'$'\\n''group': No such file or directory\n",
  });
  expect(await run(["chgrp", String(currentGid), "missing'group"])).toMatchObject({
    code: 1,
    stderr: "chgrp: cannot access \"missing'group\": No such file or directory\n",
  });
  await writeFile(join(dir, "group'verbose"), "target");
  expect(await run(["chgrp", "-v", String(currentGid), "group'verbose"])).toMatchObject({
    code: 0,
    stdout: `group of "group'verbose" retained as ${currentGroupName}\n`,
  });
  expect(await run(["chown", "-R", "--preserve-root", String(process.getuid?.() ?? 0), "/"])).toMatchObject({
    code: 1,
    stderr: "chown: it is dangerous to operate recursively on '/'\nchown: use --no-preserve-root to override this failsafe\n",
  });
  expect(await run(["chgrp", "-R", "--preserve-root", "0", "/"])).toMatchObject({
    code: 1,
    stderr: "chgrp: it is dangerous to operate recursively on '/'\nchgrp: use --no-preserve-root to override this failsafe\n",
  });
  await mkdir(join(dir, "owner-preserve-root"));
  await symlink("/", join(dir, "owner-preserve-root/root-link"));
  expect(await run(["chown", "-RLh", "--preserve-root", String(currentUid), "owner-preserve-root"])).toMatchObject({
    code: 1,
    stderr: "chown: it is dangerous to operate recursively on 'owner-preserve-root/root-link' (same as '/')\nchown: use --no-preserve-root to override this failsafe\n",
  });
  expect(await run(["chgrp", "-RLh", "--preserve-root", String(currentGid), "owner-preserve-root"])).toMatchObject({
    code: 1,
    stderr: "chgrp: it is dangerous to operate recursively on 'owner-preserve-root/root-link' (same as '/')\nchgrp: use --no-preserve-root to override this failsafe\n",
  });
  expect(await run(["chmod", "-R", "--preserve-root", "u+r", "/"])).toMatchObject({
    code: 1,
    stderr: "chmod: it is dangerous to operate recursively on '/'\nchmod: use --no-preserve-root to override this failsafe\n",
  });
  expect(await run(["stdbuf", process.execPath, "-e", "console.log('stdbuf')"])).toMatchObject({ code: 125 });
  expect(await run(["stdbuf", "-oL", process.execPath, "-e", "console.log('line')"])).toMatchObject({ code: 0, stdout: "line\n" });
  expect(await run(["stdbuf", "--output=L", process.execPath, "-e", "console.log('long')"])).toMatchObject({ code: 0, stdout: "long\n" });
  expect(await run(["stdbuf", "--o=L", process.execPath, "-e", "console.log('abbr')"])).toMatchObject({ code: 0, stdout: "abbr\n" });
  expect((await run(["stdbuf", "--out=L", "--help"])).stdout).toContain("Usage: stdbuf OPTION... COMMAND\n");
  expect(await run(["stdbuf", "--bad", "--help"])).toMatchObject({ code: 125, stderr: "stdbuf: unrecognized option '--bad'\nTry 'stdbuf --help' for more information.\n" });
  expect(await run(["stdbuf", "-oL", "."])).toMatchObject({ code: 126, stderr: "stdbuf: failed to run command '.': Permission denied\n" });
  expect(await run(["stdbuf", "-oL", "--", "--bad", "--help"])).toMatchObject({ code: 127, stderr: "stdbuf: failed to run command '--bad': No such file or directory\n" });
  const stdbufHelp = (await run(["stdbuf", "--help"])).stdout;
  expect(stdbufHelp).toContain("Mandatory arguments to long options are mandatory for short options too.\n");
  expect(stdbufHelp).toContain("-o, --output=MODE  adjust standard output stream buffering\n");
  expect(stdbufHelp).toContain("If MODE is 'L' the corresponding stream will be line buffered.\n");
  expect(stdbufHelp).toContain("  125  if the stdbuf command itself fails\n");
  expect(await run(["stdbuf", "-o0", "/bin/sh", "-c", "printf '%s\\n' \"$1\"", "sh", "--version"])).toMatchObject({ code: 0, stdout: "--version\n" });
  const stdbufEnv = await run(["stdbuf", "-i0", "-oL", "-eK", "env"]);
  expect(stdbufEnv).toMatchObject({ code: 0 });
  expect(stdbufEnv.stdout).toContain("_STDBUF_I=0\n");
  expect(stdbufEnv.stdout).toContain("_STDBUF_O=L\n");
  expect(stdbufEnv.stdout).toContain("_STDBUF_E=1024\n");
  expect(stdbufEnv.stdout).toContain("LD_PRELOAD=");
  const stdbufLargeEnv = await run(["stdbuf", "-o1EB", "env"]);
  expect(stdbufLargeEnv).toMatchObject({ code: 0 });
  expect(stdbufLargeEnv.stdout).toContain("_STDBUF_O=1000000000000000000\n");
  expect(await shell(`
    set -eu
    mkfifo fifo
    (printf '1\\n'; sleep .1; printf '2\\n') | "$BUN" "$BNU" stdbuf -oL uniq > fifo &
    pid=$!
    IFS= read -r line < fifo
    test "$line" = 1
    wait "$pid" || test "$?" = 141
  `)).toMatchObject({ code: 0 });
  expect(await run(["stdbuf"])).toMatchObject({ code: 125, stderr: "stdbuf: missing operand\nTry 'stdbuf --help' for more information.\n" });
  expect(await run(["stdbuf", "--"])).toMatchObject({ code: 125, stderr: "stdbuf: missing operand\nTry 'stdbuf --help' for more information.\n" });
  expect(await run(["stdbuf", "-oL"])).toMatchObject({ code: 125, stderr: "stdbuf: missing operand\nTry 'stdbuf --help' for more information.\n" });
  expect(await run(["stdbuf", "-oL", "--"])).toMatchObject({ code: 125, stderr: "stdbuf: missing operand\nTry 'stdbuf --help' for more information.\n" });
  expect(await run(["stdbuf", "--input=L", "true"])).toMatchObject({ code: 125, stderr: "stdbuf: line buffering standard input is meaningless\nTry 'stdbuf --help' for more information.\n" });
  expect(await run(["stdbuf", "--input=bad", "--help"])).toMatchObject(await systemRun(["stdbuf", "--input=bad", "--help"]));
  expect(await run(["stdbuf", "--output=bad\nmode", "true"])).toMatchObject({ code: 125, stderr: `stdbuf: invalid mode ${diagnosticQuote("bad\\nmode")}\n` });
  expect(await run(["stdbuf", "--output=", "true"])).toMatchObject(await systemRun(["stdbuf", "--output=", "true"]));
  expect(await run(["stdbuf", "-o1b", "true"])).toMatchObject(await systemRun(["stdbuf", "-o1b", "true"]));
  expect(await run(["stdbuf", "--help=bad"])).toMatchObject({ code: 125, stderr: "stdbuf: option '--help' doesn't allow an argument\nTry 'stdbuf --help' for more information.\n" });
  expect(await run(["stdbuf", "--version=bad"])).toMatchObject({ code: 125, stderr: "stdbuf: option '--version' doesn't allow an argument\nTry 'stdbuf --help' for more information.\n" });
  expect(await run(["stdbuf", "-o18446744073709551616", "true"])).toMatchObject(await systemRun(["stdbuf", "-o18446744073709551616", "true"]));
  for (const option of ["-i", "-o", "-e"]) {
    expect(await run(["stdbuf", option])).toMatchObject({ code: 125, stderr: `stdbuf: option requires an argument -- '${option.slice(1)}'\nTry 'stdbuf --help' for more information.\n` });
  }
  for (const option of ["--input", "--output", "--error"]) {
    expect(await run(["stdbuf", option])).toMatchObject({ code: 125, stderr: `stdbuf: option '${option}' requires an argument\nTry 'stdbuf --help' for more information.\n` });
  }
  const noSelinuxRuncon = { code: 125, stderr: "runcon: runcon may be used only on a SELinux kernel\n" };
  expect(await run(["runcon", "system_u:system_r:bin_t", process.execPath, "-e", "console.log('runcon')"])).toMatchObject(noSelinuxRuncon);
  expect(await run(["runcon", "system_u:system_r:bin_t", "/bin/sh", "-c", "printf '%s\\n' \"$1\"", "sh", "--version"])).toMatchObject(noSelinuxRuncon);
  expect((await run(["runcon", "--compute", "--help"])).stdout).toContain("Usage: runcon CONTEXT COMMAND [args]\n  or:  runcon [ -c ] [-u USER] [-r ROLE] [-t TYPE] [-l RANGE] COMMAND [args]\n");
  expect(await run(["runcon", "-u", "user_u", "/bin/sh", "-c", "printf '%s\\n' \"$1\"", "sh", "--version"])).toMatchObject(noSelinuxRuncon);
  expect(await run(["runcon", "--u", "user_u", "/bin/sh", "-c", "printf '%s\\n' \"$1\"", "sh", "abbr"])).toMatchObject(noSelinuxRuncon);
  expect(await run(["runcon", "--ro", "role_r", "/bin/sh", "-c", "printf '%s\\n' \"$1\"", "sh", "role"])).toMatchObject(noSelinuxRuncon);
  expect(await run(["runcon", "--user", "--help", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["runcon", "--r", "--help"])).toMatchObject({ code: 125, stderr: "runcon: option '--r' is ambiguous; possibilities: '--role' '--range'\nTry 'runcon --help' for more information.\n" });
  expect(await run(["runcon", "--comp=bad", "--help"])).toMatchObject({ code: 125, stderr: "runcon: option '--compute' doesn't allow an argument\nTry 'runcon --help' for more information.\n" });
  expect(await run(["runcon", "--help=bad"])).toMatchObject({ code: 125, stderr: "runcon: option '--help' doesn't allow an argument\nTry 'runcon --help' for more information.\n" });
  expect(await run(["runcon", "--bad", "--help"])).toMatchObject({ code: 125, stderr: "runcon: unrecognized option '--bad'\nTry 'runcon --help' for more information.\n" });
  expect(await run(["runcon", "-c", "true"])).toMatchObject({ code: 125, stderr: "runcon: runcon may be used only on a SELinux kernel\n" });
  expect(await run(["runcon"])).toMatchObject({ code: 125, stderr: "runcon: failed to get current context\n" });
  expect(await run(["runcon", "system_u:system_r:bin_t"])).toMatchObject({ code: 125, stderr: "runcon: no command specified\nTry 'runcon --help' for more information.\n" });
  expect(await run(["runcon", "-u", "one", "-u", "two", "true"])).toMatchObject({ code: 125, stderr: "runcon: multiple users\nTry 'runcon --help' for more information.\n" });
  for (const option of ["-u", "-r", "-t", "-l"]) {
    expect(await run(["runcon", option])).toMatchObject({ code: 125, stderr: `runcon: option requires an argument -- '${option.slice(1)}'\nTry 'runcon --help' for more information.\n` });
  }
  for (const option of ["--user", "--role", "--type", "--range"]) {
    expect(await run(["runcon", option])).toMatchObject({ code: 125, stderr: `runcon: option '${option}' requires an argument\nTry 'runcon --help' for more information.\n` });
  }
  expect(await run(["who"])).toMatchObject(await systemRun(["/usr/bin/who"]));
  expect(await run(["who", "-q"])).toMatchObject(await systemRun(["/usr/bin/who", "-q"]));
  expect(await run(["who", "-b"])).toMatchObject(await systemRun(["/usr/bin/who", "-b"]));
  const whoHeading = await run(["who", "-H"]);
  expect(whoHeading).toMatchObject({ code: 0 });
  expect(whoHeading.stdout).toStartWith("NAME     LINE         TIME             COMMENT\n");
  expect(await run(["who", "am", "i"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["who", "missing-a", "missing-b"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["who", "-m"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["who", "-q", "am", "i"])).toMatchObject({ code: 0, stdout: "\n# users=0\n" });
  expect(await run(["who", "-H", "am", "i"])).toMatchObject({ code: 0, stdout: "NAME     LINE         TIME             COMMENT\n" });
  expect(await run(["who", "-s"])).toMatchObject({ code: 0 });
  expect(await run(["who", "-T"])).toMatchObject({ code: 0 });
  expect(await run(["who", "--lookup"])).toMatchObject({ code: 0 });
  expect(await run(["who", "--loo"])).toMatchObject({ code: 0 });
  const whoAbbrevHeading = await run(["who", "--hea"]);
  expect(whoAbbrevHeading).toMatchObject({ code: 0 });
  expect(whoAbbrevHeading.stdout).toStartWith("NAME     LINE         TIME             COMMENT\n");
  expect((await run(["who", "--he"])).stderr).toContain("option '--he' is ambiguous; possibilities: '--heading' '--help'");
  const whoHelp = await run(["who", "--help"]);
  const whoHelpStdout = whoHelp.stdout;
  expect(whoHelp).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: who [OPTION]... [ FILE | ARG1 ARG2 ]\n") });
  expect(whoHelpStdout).toContain("  -m\n");
  expect(whoHelpStdout).toContain("  -w\n");
  expect((await run(["who", "--heading=bad", "--help"])).stderr).toContain("option '--heading' doesn't allow an argument");
  expect((await run(["who", "--bad", "--help"])).stderr).toContain("unrecognized option '--bad'");
  expect((await run(["who", "-x", "--help"])).stderr).toContain("invalid option -- 'x'");
  expect(await run(["who", "--m"])).toMatchObject({ code: 0 });
  expect((await run(["who", "--mes=bad"])).stderr).toContain("option '--message' doesn't allow an argument");
  expect((await run(["who", "--mesg=bad"])).stderr).toContain("option '--mesg' doesn't allow an argument");
  expect(await run(["who", "--all"])).toMatchObject({ code: 0 });
  expect(await run(["who", "extra"])).toMatchObject({ code: 0 });
  await writeFile(join(dir, "empty-utmp"), "");
  expect(await run(["who", "empty-utmp"])).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["who", "-q", "empty-utmp"])).toMatchObject({ code: 0, stdout: "\n# users=0\n" });
  const whoUtmp = Buffer.alloc(384);
  whoUtmp.writeInt16LE(7, 0);
  whoUtmp.writeInt32LE(1234, 4);
  // Use a deliberately impossible PTY number so -T/-w cannot observe a
  // coincidentally live host terminal and turn the expected '?' into '+'/'-'.
  whoUtmp.write("pts/999999", 8, "utf8");
  whoUtmp.write("alice", 44, "utf8");
  whoUtmp.write("example.test", 76, "utf8");
  whoUtmp.writeInt32LE(1577934245, 340);
  await writeFile(join(dir, "who-utmp"), whoUtmp);
  expect(await run(["who", "who-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "alice    pts/999999   2020-01-02 03:04 (example.test)\n" });
  expect(await run(["who", "-H", "who-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "NAME     LINE         TIME             COMMENT\nalice    pts/999999   2020-01-02 03:04 (example.test)\n" });
  expect(await run(["who", "-T", "who-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "alice    ? pts/999999   2020-01-02 03:04 (example.test)\n" });
  expect(await run(["who", "-w", "who-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "alice    ? pts/999999   2020-01-02 03:04 (example.test)\n" });
  expect(await run(["who", "-u", "who-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "alice    pts/999999   2020-01-02 03:04   ?          1234 (example.test)\n" });
  expect(await run(["who", "-T", "-u", "who-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "alice    ? pts/999999   2020-01-02 03:04   ?          1234 (example.test)\n" });
  expect(await run(["who", "-a", "who-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "alice    ? pts/999999   2020-01-02 03:04   ?          1234 (example.test)\n" });
  expect(await run(["who", "-H", "-T", "-u", "who-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "NAME       LINE         TIME             IDLE          PID COMMENT\nalice    ? pts/999999   2020-01-02 03:04   ?          1234 (example.test)\n" });
  expect(await run(["who", "who-utmp"], "", { env: { TZ: "UTC0", LC_ALL: "C" } })).toMatchObject({ code: 0, stdout: "alice    pts/999999   Jan  2 03:04 (example.test)\n" });
  expect(await run(["who", "-H", "who-utmp"], "", { env: { TZ: "UTC0", LC_ALL: "C" } })).toMatchObject({ code: 0, stdout: "NAME     LINE         TIME         COMMENT\nalice    pts/999999   Jan  2 03:04 (example.test)\n" });
  expect(await run(["who", "-H", "-T", "-u", "who-utmp"], "", { env: { TZ: "UTC0", LC_ALL: "C" } })).toMatchObject({ code: 0, stdout: "NAME       LINE         TIME         IDLE          PID COMMENT\nalice    ? pts/999999   Jan  2 03:04   ?          1234 (example.test)\n" });
  expect(await run(["who", "-q", "who-utmp"])).toMatchObject({ code: 0, stdout: "alice\n# users=1\n" });
  const whoProcessUtmp = Buffer.alloc(384);
  whoProcessUtmp.writeInt16LE(5, 0);
  whoProcessUtmp.writeInt32LE(4321, 4);
  whoProcessUtmp.write("tty5", 8, "utf8");
  whoProcessUtmp.write("id5", 40, "utf8");
  whoProcessUtmp.writeInt32LE(1577934245, 340);
  await writeFile(join(dir, "who-process-utmp"), whoProcessUtmp);
  expect(await run(["who", "-p", "who-process-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "         tty5         2020-01-02 03:04       4321 id=id5\n" });
  expect(await run(["who", "--process", "who-process-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "         tty5         2020-01-02 03:04       4321 id=id5\n" });
  expect(await run(["who", "-a", "who-process-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "           tty5         2020-01-02 03:04              4321 id=id5\n" });
  const whoSpecialUtmp = Buffer.alloc(384 * 2);
  whoSpecialUtmp.writeInt16LE(3, 0);
  whoSpecialUtmp.writeInt32LE(1577934245, 340);
  whoSpecialUtmp.writeInt16LE(8, 384);
  whoSpecialUtmp.writeInt32LE(333, 384 + 4);
  whoSpecialUtmp.write("tty8", 384 + 8, "utf8");
  whoSpecialUtmp.write("id8", 384 + 40, "utf8");
  whoSpecialUtmp.writeInt16LE(9, 384 + 332);
  whoSpecialUtmp.writeInt16LE(2, 384 + 334);
  whoSpecialUtmp.writeInt32LE(1577934246, 384 + 340);
  await writeFile(join(dir, "who-special-utmp"), whoSpecialUtmp);
  expect(await run(["who", "-t", "who-special-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "         clock change 2020-01-02 03:04\n" });
  expect(await run(["who", "--time", "who-special-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "         clock change 2020-01-02 03:04\n" });
  expect(await run(["who", "-d", "who-special-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "         tty8         2020-01-02 03:04               333 id=id8   term=9 exit=2\n" });
  expect(await run(["who", "-a", "who-special-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "           clock change 2020-01-02 03:04\n           tty8         2020-01-02 03:04               333 id=id8   term=9 exit=2\n" });
  expect(await run(["who", "-H", "-t", "who-special-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "NAME     LINE         TIME                    PID COMMENT\n         clock change 2020-01-02 03:04\n" });
  expect(await run(["who", "-H", "-d", "who-special-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "NAME     LINE         TIME             IDLE          PID COMMENT  EXIT\n         tty8         2020-01-02 03:04               333 id=id8   term=9 exit=2\n" });
  const whoMixedUtmp = Buffer.alloc(384 * 3);
  whoMixedUtmp.writeInt16LE(3, 0);
  whoMixedUtmp.writeInt32LE(1577934245, 340);
  whoMixedUtmp.writeInt16LE(7, 384);
  whoMixedUtmp.writeInt32LE(1234, 384 + 4);
  whoMixedUtmp.write("pts/999999", 384 + 8, "utf8");
  whoMixedUtmp.write("alice", 384 + 44, "utf8");
  whoMixedUtmp.writeInt32LE(1577934246, 384 + 340);
  whoMixedUtmp.writeInt16LE(5, 768);
  whoMixedUtmp.writeInt32LE(4321, 768 + 4);
  whoMixedUtmp.write("tty5", 768 + 8, "utf8");
  whoMixedUtmp.write("id5", 768 + 40, "utf8");
  whoMixedUtmp.writeInt32LE(1577934247, 768 + 340);
  await writeFile(join(dir, "who-mixed-utmp"), whoMixedUtmp);
  expect(await run(["who", "-a", "who-mixed-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "           clock change 2020-01-02 03:04\nalice    ? pts/999999   2020-01-02 03:04   ?          1234\n           tty5         2020-01-02 03:04              4321 id=id5\n" });
  expect(await run(["who", "-H", "-a", "who-mixed-utmp"], "", { env: { TZ: "UTC0" } })).toMatchObject({ code: 0, stdout: "NAME       LINE         TIME             IDLE          PID COMMENT  EXIT\n           clock change 2020-01-02 03:04\nalice    ? pts/999999   2020-01-02 03:04   ?          1234\n           tty5         2020-01-02 03:04              4321 id=id5\n" });
  expect(await run(["who", "one", "two", "three"])).toMatchObject({ code: 1, stderr: `who: extra operand ${diagnosticQuote("three")}\nTry 'who --help' for more information.\n` });
  expect(await run(["tty", "extra"])).toMatchObject(await systemRun(["tty", "extra"]));
});

test("remaining formatting and identity command surfaces", async () => {
  await writeFile(join(dir, "alpha"), "one\ntwo\nthree\n");
  await writeFile(join(dir, "beta"), "four\n");
  expect(await run(["dir"])).toMatchObject({ code: 0 });
  expect((await run(["dir", "alpha", "beta"])).stdout).toBe("alpha  beta\n");
  expect((await run(["dir", "-1", "alpha", "beta"])).stdout).toBe("alpha\nbeta\n");
  expect((await run(["dir", "--format=single-column", "alpha", "beta"])).stdout).toBe("alpha\nbeta\n");
  const dirHelp = await run(["dir", "--help"]);
  expect(dirHelp.code).toBe(0);
  expect(dirHelp.stdout).toContain("List information about the FILEs (the current directory by default).\n");
  for (const option of ["-1", "-C", "-S", "-U", "-X", "-c", "-g", "-l", "-m", "-o", "-p", "-t", "-u", "-v", "-x"]) expect(dirHelp.stdout).toContain(`  ${option}\n`);
  expect((await run(["vdir", "alpha"])).stdout).toContain("alpha");
  const vdirHelp = await run(["vdir", "--help"]);
  expect(vdirHelp.code).toBe(0);
  expect(vdirHelp.stdout).toContain("List information about the FILEs (the current directory by default).\n");
  for (const option of ["-1", "-C", "-S", "-U", "-X", "-c", "-g", "-l", "-m", "-o", "-p", "-t", "-u", "-v", "-x"]) expect(vdirHelp.stdout).toContain(`  ${option}\n`);
  expect(await run(["chroot", ".", process.execPath, "-e", "console.log('root')"])).toMatchObject({ code: 125 });
  expect(await run(["chroot", "--userspec=0:0", "--groups=0", ".", process.execPath, "-e", "console.log('userspec')"])).toMatchObject({ code: 125 });
  expect(await run(["chroot", "--u=0:0", "--g=0", ".", process.execPath, "-e", "console.log('abbr')"])).toMatchObject({ code: 125 });
  expect((await run(["chroot", "--user=0:0", "--help"])).stdout).toContain("Usage: chroot [OPTION]... NEWROOT [COMMAND [ARG]...]\n");
  expect(await run(["chroot", "--user", "--help", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["chroot", ".", "/bin/sh", "-c", "printf '%s\\n' \"$1\"", "sh", "--version"])).toMatchObject({ code: 125 });
  expect(await run(["chroot", "--skip-chdir", ".", process.execPath, "-e", "console.log(process.cwd())"])).toMatchObject({
    code: 125,
    stdout: "",
    stderr: "chroot: option --skip-chdir only permitted if NEWROOT is old '/'\nTry 'chroot --help' for more information.\n",
  });
  expect((await run(["chroot", "--sk", "--help"])).stdout).toContain("Usage: chroot [OPTION]... NEWROOT [COMMAND [ARG]...]\n");
  expect(await run(["chroot", "--s=bad", "--help"])).toMatchObject({ code: 125, stderr: "chroot: option '--skip-chdir' doesn't allow an argument\nTry 'chroot --help' for more information.\n" });
  expect(await run(["chroot", "--help=bad"])).toMatchObject({ code: 125, stderr: "chroot: option '--help' doesn't allow an argument\nTry 'chroot --help' for more information.\n" });
  expect(await run(["chroot", "--bad", "--help"])).toMatchObject({ code: 125, stderr: "chroot: unrecognized option '--bad'\nTry 'chroot --help' for more information.\n" });
  expect(await run(["chroot", "--userspec"])).toMatchObject({ code: 125, stderr: "chroot: option '--userspec' requires an argument\nTry 'chroot --help' for more information.\n" });
  expect(await run(["chroot", "--groups"])).toMatchObject({ code: 125, stderr: "chroot: option '--groups' requires an argument\nTry 'chroot --help' for more information.\n" });
  expect(await run(["chroot", "missing-chroot-root", "/bin/true"])).toMatchObject({ code: 125, stdout: "", stderr: "chroot: cannot change root directory to 'missing-chroot-root': No such file or directory\n" });
  await writeFile(join(dir, "chroot-not-dir"), "");
  expect(await run(["chroot", "chroot-not-dir", "/bin/true"])).toMatchObject({ code: 125, stdout: "", stderr: "chroot: cannot change root directory to 'chroot-not-dir': Not a directory\n" });
  expect(await run(["chroot"])).toMatchObject({ code: 125, stderr: "chroot: missing operand\nTry 'chroot --help' for more information.\n" });
  expect(await run(["chroot", "--userspec=0:0"])).toMatchObject({ code: 125, stderr: "chroot: missing operand\nTry 'chroot --help' for more information.\n" });
  expect(await run(["chcon", "system_u:object_r:tmp_t:s0", "alpha"])).toMatchObject({ code: 1, stderr: "chcon: failed to change context of 'alpha' to 'system_u:object_r:tmp_t:s0'\n" });
  expect(await run(["chcon", "-u", "system_u", "-r", "object_r", "-t", "tmp_t", "-l", "s0", "alpha"])).toMatchObject({ code: 1, stderr: "chcon: can't apply partial context to unlabeled file 'alpha'\n" });
  expect(await run(["chcon", "--u", "system_u", "--ty", "tmp_t", "alpha"])).toMatchObject({ code: 1, stderr: "chcon: can't apply partial context to unlabeled file 'alpha'\n" });
  await mkdir(join(dir, "context-dir"));
  await writeFile(join(dir, "context-dir/file"), "ctx\n");
  expect(await run(["chcon", "-R", "--user=system_u", "--role=object_r", "--type=tmp_t", "--range=s0", "context-dir"])).toMatchObject({ code: 1 });
  expect((await run(["chcon", "--rec", "--help"])).stdout).toContain("Usage: chcon [OPTION]... CONTEXT FILE...\n  or:  chcon [OPTION]... [-u USER] [-r ROLE] [-l RANGE] [-t TYPE] FILE...\n  or:  chcon [OPTION]... --reference=RFILE FILE...\n");
  expect(await run(["chcon", "--user", "--help", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["chcon", "--r", "role_r", "alpha"])).toMatchObject({ code: 1, stderr: "chcon: option '--r' is ambiguous; possibilities: '--recursive' '--reference' '--role' '--range'\nTry 'chcon --help' for more information.\n" });
  expect(await run(["chcon", "--recursive=bad", "--help"])).toMatchObject({ code: 1, stderr: "chcon: option '--recursive' doesn't allow an argument\nTry 'chcon --help' for more information.\n" });
  expect(await run(["chcon", "--help=bad"])).toMatchObject({ code: 1, stderr: "chcon: option '--help' doesn't allow an argument\nTry 'chcon --help' for more information.\n" });
  expect(await run(["chcon", "--bad", "--help"])).toMatchObject({ code: 1, stderr: "chcon: unrecognized option '--bad'\nTry 'chcon --help' for more information.\n" });
  expect(await run(["chcon", "-u", "system_u"])).toMatchObject({ code: 1, stderr: "chcon: missing operand\nTry 'chcon --help' for more information.\n" });
  await writeFile(join(dir, "context-ref"), "ref\n");
  expect(await run(["chcon", "--reference=context-ref", "alpha"])).toMatchObject({ code: 1, stderr: "chcon: failed to get security context of 'context-ref'\n" });
  expect(await run(["chcon", "--ref=context-ref", "alpha"])).toMatchObject({ code: 1, stderr: "chcon: failed to get security context of 'context-ref'\n" });
  expect(await run(["chcon", "--reference=context-ref"])).toMatchObject({ code: 1 });
  expect(await run(["tsort", "tsort-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "tsort: tsort-missing: No such file or directory\n" });
  expect(await run(["tsort", "missing'tsort"])).toMatchObject({ code: 1, stdout: "", stderr: "tsort: \"missing'tsort\": No such file or directory\n" });
  expect(await run(["tsort", "missing\ntsort"])).toMatchObject({ code: 1, stdout: "", stderr: "tsort: 'missing'$'\\n''tsort': No such file or directory\n" });
  await mkdir(join(dir, "tsort-dir"));
  expect(await run(["tsort", "tsort-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "tsort: tsort-dir: read error: Is a directory\n" });
  await mkdir(join(dir, "dir'tsort"));
  expect(await run(["tsort", "dir'tsort"])).toMatchObject({ code: 1, stdout: "", stderr: "tsort: \"dir'tsort\": read error: Is a directory\n" });
  await symlink("tsort-loop", join(dir, "tsort-loop"));
  expect(await run(["tsort", "tsort-loop"])).toMatchObject({ code: 1, stdout: "", stderr: "tsort: tsort-loop: Too many levels of symbolic links\n" });
  await symlink("loop'tsort", join(dir, "loop'tsort"));
  expect(await run(["tsort", "loop'tsort"])).toMatchObject({ code: 1, stdout: "", stderr: "tsort: \"loop'tsort\": Too many levels of symbolic links\n" });
  expect(await run(["tsort", "alpha", "extra\narg"])).toMatchObject({ code: 1, stdout: "", stderr: `tsort: extra operand ${diagnosticQuote("extra\\narg")}\nTry 'tsort --help' for more information.\n` });
  expect(await run(["pr", "-t", "alpha"])).toMatchObject({ code: 0, stdout: "one\ntwo\nthree\n" });
  await writeFile(join(dir, "pr-raw"), Uint8Array.of(0xff, 0x0a, 0x61, 0x20, 0x62, 0x0a));
  const prRaw = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "pr", "-t", "pr-raw"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "pr-raw-out")),
    stderr: "pipe",
  });
  expect(await prRaw.exited).toBe(0);
  expect(await new Response(prRaw.stderr).text()).toBe("");
  expect([...await readFile(join(dir, "pr-raw-out"))]).toEqual([0xff, 0x0a, 0x61, 0x20, 0x62, 0x0a]);
  expect(await run(["pr", "-t", "pr-missing-a", "alpha", "pr-missing-b"])).toMatchObject({ code: 1, stdout: "one\ntwo\nthree\n", stderr: "pr: pr-missing-a: No such file or directory\npr: pr-missing-b: No such file or directory\n" });
  expect(await run(["pr", "-t", "missing'pr", "alpha", "missing\npr"])).toMatchObject({ code: 1, stdout: "one\ntwo\nthree\n", stderr: "pr: \"missing'pr\": No such file or directory\npr: 'missing'$'\\n''pr': No such file or directory\n" });
  await mkdir(join(dir, "pr-dir"));
  expect(await run(["pr", "-t", "pr-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "pr: pr-dir: Is a directory\n" });
  await mkdir(join(dir, "dir'pr"));
  expect(await run(["pr", "-t", "dir'pr"])).toMatchObject({ code: 1, stdout: "", stderr: "pr: \"dir'pr\": Is a directory\n" });
  await symlink("loop'pr", join(dir, "loop'pr"));
  expect(await run(["pr", "-t", "loop'pr"])).toMatchObject({ code: 1, stdout: "", stderr: "pr: \"loop'pr\": Too many levels of symbolic links\n" });
  expect(await run(["pr", "-t", "-r", "pr-missing-a", "alpha", "pr-missing-b"])).toMatchObject({ code: 1, stdout: "one\ntwo\nthree\n", stderr: "" });
  await writeFile(join(dir, "pr-default"), "one\ntwo\nthree\n");
  await lutimes(join(dir, "pr-default"), new Date(2001, 1, 3, 4, 5, 6), new Date(2001, 1, 3, 4, 5, 6));
  const prDefault = await run(["pr", "pr-default"]);
  expect(prDefault).toMatchObject({ code: 0, stderr: "" });
  expect(prDefault.stdout).toMatch(/^(\n\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+pr-default\s+Page 1\n\n\none\ntwo\nthree\n)\n{58}$/);
  const prStdin = await run(["pr"], "one\n");
  expect(prStdin).toMatchObject({ code: 0, stderr: "" });
  expect(prStdin.stdout).toMatch(/^\n\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+Page 1\n\n\none\n/);
  expect(prStdin.stdout).not.toContain("Sun ");
  const prLongLine = "x".repeat(65537);
  const prLongStdin = await run(["pr"], prLongLine);
  expect(prLongStdin).toMatchObject({ code: 0, stderr: "", stdout: expect.stringContaining(`${prLongLine}\n`) });
  const prResponsive = await shell(`
    rm -f pr-in pr-hold pr-out
    mkfifo pr-in pr-hold
    cleanup() {
      kill "$reader" "$writer" 2>/dev/null || :
      wait "$reader" "$writer" 2>/dev/null || :
    }
    trap cleanup EXIT
    "$BUN" "$BNU" pr <pr-in >pr-out &
    reader=$!
    { printf '1\\n'; read x <pr-hold || :; } >pr-in &
    writer=$!
    seen=1
    for i in 1 2 3 4 5 6; do
      test -s pr-out && { seen=0; break; }
      sleep .1
    done
    printf release >pr-hold
    wait "$writer"
    wait "$reader"
    exit "$seen"
  `);
  expect(prResponsive).toMatchObject({ code: 0, stderr: "" });
  expect((await run(["pr", "-h", "Custom", "alpha"])).stdout).toContain("Custom");
  expect((await run(["pr", "--header=Long", "alpha"])).stdout).toContain("Long");
  const prHelp = await run(["pr", "--help"]);
  expect(prHelp.code).toBe(0);
  expect(prHelp.stdout).toContain("Paginate or columnate FILE(s) for printing.\n");
  expect(prHelp.stdout).toContain("  -F\n");
  expect(await run(["pr", "-b", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: pr [OPTION]... [FILE]...\n"), stderr: "" });
  expect(await run(["pr", "-b", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n", stderr: "" });
  expect(await run(["pr", "--columns=bad", "--help"])).toMatchObject(await systemRun(["pr", "--columns=bad", "--help"]));
  expect(await run(["pr", "--columns", "--help"])).toMatchObject(await systemRun(["pr", "--columns", "--help"]));
  expect(await run(["pr", "--indent=bad", "--help"])).toMatchObject(await systemRun(["pr", "--indent=bad", "--help"]));
  expect(await run(["pr", "--page-width=bad", "--help"])).toMatchObject(await systemRun(["pr", "--page-width=bad", "--help"]));
  expect(await run(["pr", "--length=bad", "--help"])).toMatchObject(await systemRun(["pr", "--length=bad", "--help"]));
  expect(await run(["pr", "--omit-header", "alpha"])).toMatchObject({ code: 0, stdout: "one\ntwo\nthree\n" });
  expect(await run(["pr", "--pages=2", "alpha"])).toMatchObject({ code: 0, stdout: "", stderr: "pr: starting page number 2 exceeds page count 1\n" });
  expect(await run(["pr", "-t", "-n", "alpha"])).toMatchObject({ code: 0, stdout: "    1\tone\n    2\ttwo\n    3\tthree\n" });
  expect(await run(["pr", "-t", "-n:3", "-N", "7", "alpha"])).toMatchObject({ code: 0, stdout: "  7:one\n  8:two\n  9:three\n" });
  expect(await run(["pr", "-t", "-n:2", "-N", "98"], "y\ny\ny\ny\ny\n")).toMatchObject({ code: 0, stdout: "98:y\n99:y\n00:y\n01:y\n02:y\n" });
  expect(await run(["pr", "-t", "-n,1", "-N", "1000000"], "1\n")).toMatchObject({ code: 0, stdout: "0,1\n" });
  expect(await run(["pr", "-t", "--indent=3", "alpha"])).toMatchObject({ code: 0, stdout: "   one\n   two\n   three\n" });
  expect(await run(["pr", "-t", "-02"], "a\nb\nc\n")).toMatchObject({ code: 0, stdout: `a${"\t".repeat(4)}${" ".repeat(4)}c\nb\n` });
  expect(await run(["pr", "-t", "-a", "-2"], "a\nb\nc\n")).toMatchObject({ code: 0, stdout: `a${"\t".repeat(4)}${" ".repeat(4)}b\nc\n` });
  expect(await run(["pr", "-t", "-a", "-3"], "1\n2\n3\n4\n5\n6\n")).toMatchObject({ code: 0, stdout: `1${"\t".repeat(3)}2${"\t".repeat(3)}3\n4${"\t".repeat(3)}5${"\t".repeat(3)}6\n` });
  expect(await run(["pr", "-t", "-a", "-3"], "1\f\n2\n3\n4\n")).toMatchObject({ code: 0, stdout: `1\n\f2${"\t".repeat(3)}3${"\t".repeat(3)}4\n` });
  expect(await run(["pr", "-T", "-a", "-3"], "1\f\n2\n3\n4\n")).toMatchObject({ code: 0, stdout: `1\n2${"\t".repeat(3)}3${"\t".repeat(3)}4\n` });
  expect(await run(["pr", "-W3", "-t", "-02"], "a\nb\nc\n")).toMatchObject({ code: 0, stdout: "a c\nb\n" });
  expect(await run(["pr", "-W3", "-t2"], "a\nb\nc\n")).toMatchObject({ code: 0, stdout: "a c\nb\n" });
  expect(await run(["pr", "-W3", "-t", "-4", "--columns=1", "-2"], "a\nb\nc\n")).toMatchObject({ code: 0, stdout: "a c\nb\n" });
  expect(await run(["pr", "-W1", "-t"], "12345\n")).toMatchObject({ code: 0, stdout: "1\n" });
  expect(await run(["pr", "-d", "-t"], "1\n2\n")).toMatchObject({ code: 0, stdout: "1\n\n2\n\n" });
  expect(await run(["pr", "-T"], "a\fb\n")).toMatchObject({ code: 0, stdout: "a\nb\n" });
  expect(await run(["pr", "-o", "0"], "")).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["pr", "-t", "-e"], "\b\b\b\b\b\b\tx\n")).toMatchObject({ code: 0, stdout: "        x\n" });
  expect(await run(["pr", "-t", "-e"], "abc\b\b\b\b\tx")).toMatchObject({ code: 0, stdout: "abc\b\b\b        x\n" });
  expect(await run(["pr", "-t", "-e300"], `a${"\b".repeat(50)}\t`)).toMatchObject({ code: 0, stdout: `a\b${" ".repeat(300)}\n` });
  expect(await run(["pr", "-t", "-n", "-i5", "-h", ""], "a        b\n")).toMatchObject({ code: 0, stdout: "    1\ta\t    b\n" });
  expect(await run(["pr", "-t", "-n", "-i5", "-o9", "-h", ""], "a        b\n")).toMatchObject({ code: 0, stdout: "\t\t   1\ta\t    b\n" });
  expect(await run(["pr", "-t", "-n", "-2"], "a\tb\ncccc\n")).toMatchObject({ code: 0, stdout: "    1\ta\tb\t\t    \t2   cccc\n" });
  expect(await run(["pr", "+1:1", "-2", "-l1", "-s "], "a\nb\nc\n")).toMatchObject({ code: 0, stdout: "a b\n" });
  await writeFile(join(dir, "pr-merge-a"), "a\tb\tc\n");
  await writeFile(join(dir, "pr-merge-b"), "m\tn\to\n");
  await writeFile(join(dir, "pr-merge-c"), "x\ty\tz\n");
  expect(await run(["pr", "-m", "-s", "-t", "pr-merge-a", "pr-merge-b", "pr-merge-c"])).toMatchObject(await systemRun(["/usr/bin/pr", "-m", "-s", "-t", "pr-merge-a", "pr-merge-b", "pr-merge-c"]));
  expect(await run(["pr", "-m", "-t", "pr-merge-a", "pr-merge-b", "pr-merge-c"])).toMatchObject(await systemRun(["/usr/bin/pr", "-m", "-t", "pr-merge-a", "pr-merge-b", "pr-merge-c"]));
  expect(await run(["pr", "-m", "-t", "-s,", "pr-merge-a", "pr-merge-b"])).toMatchObject(await systemRun(["/usr/bin/pr", "-m", "-t", "-s,", "pr-merge-a", "pr-merge-b"]));
  expect(await run(["pr", "-m", "-t", "-S,", "pr-merge-a", "pr-merge-b"])).toMatchObject(await systemRun(["/usr/bin/pr", "-m", "-t", "-S,", "pr-merge-a", "pr-merge-b"]));
  expect(await run(["pr", "-m", "-J", "-t", "pr-merge-a", "pr-merge-b"])).toMatchObject(await systemRun(["/usr/bin/pr", "-m", "-J", "-t", "pr-merge-a", "pr-merge-b"]));
  await writeFile(join(dir, "pr-merge-plain-a"), "abc\n");
  await writeFile(join(dir, "pr-merge-plain-b"), "def\n");
  expect(await run(["pr", "-m", "-t", "pr-missing-a", "pr-merge-plain-a", "pr-missing-b", "pr-merge-plain-b"])).toMatchObject({ code: 1, stdout: "abc\t\t  def\n", stderr: "pr: pr-missing-a: No such file or directory\npr: pr-missing-b: No such file or directory\n" });
  expect(await run(["pr", "-m", "-s\t", "-t", "pr-merge-a", "pr-merge-b"])).toMatchObject({ code: 0, stdout: "a\tb\tc\tm\tn\to\n" });
  await writeFile(join(dir, "pr-asan-a"), "a\n");
  await writeFile(join(dir, "pr-asan-b"), "a\n");
  expect(await run(["pr", "-m", "-S\t\t\t", "-t", "pr-asan-a", "pr-asan-b"])).toMatchObject({ code: 0, stdout: "a\t\t\t\t  \t\t\ta\n" });
  expect(await run(["pr", "-t", "-2"], "x\tx\tx\tx\tx\nx\tx\tx\tx\tx\n")).toMatchObject({ code: 0, stdout: "x\tx\tx\tx\tx   x\t    x\t    x\t    x\t    x\n" });
  const prTabInput = "aaa\tabcde\t\tfghijklmnopqrstuvw\nbbb\tabcde\t\tfghijklmnopqrstuvw\nccc\tabcde\t\tfghijklmnopqrstuvw\nddd\tabcde\t\tfghijklmnopqrstuvw\n";
  expect(await run(["pr", "-t", "-n", "-2", "-e8"], prTabInput)).toMatchObject({ code: 0, stdout: "    1\taaa\tabcde\t\tfgh \t3   ccc\t    abcde\t    fgh\n    2\tbbb\tabcde\t\tfgh \t4   ddd\t    abcde\t    fgh\n" });
  expect(await run(["pr", "-t", "-n:", "-2", "-e8"], prTabInput)).toMatchObject({ code: 0, stdout: "    1:aaa\tabcde\t\tfgh \t3:ccc\t    abcde\t    fgh\n    2:bbb\tabcde\t\tfgh \t4:ddd\t    abcde\t    fgh\n" });
  expect(await run(["pr", "-t", "-n:", "-2", "-e8", "-S----"], prTabInput)).toMatchObject({ code: 0, stdout: "    1:aaa\tabcde\t\tfg----\t  3:ccc\t      abcde\t      fg\n    2:bbb\tabcde\t\tfg----\t  4:ddd\t      abcde\t      fg\n" });
  expect(await run(["pr", "-t", "-S::", "-2"], "1\n2\n3\n4\n5\n6\n7\n8\n")).toMatchObject(await systemRun(["/usr/bin/pr", "-t", "-S::", "-2"], "1\n2\n3\n4\n5\n6\n7\n8\n"));
  expect(await run(["pr", "-t", "-s,", "-2"], "1\n2\n3\n4\n5\n6\n7\n8\n")).toMatchObject(await systemRun(["/usr/bin/pr", "-t", "-s,", "-2"], "1\n2\n3\n4\n5\n6\n7\n8\n"));
  const prColonTabInput = prTabInput.replace("aaa\t", "aaa:").replace("bbb\t", "bbb:");
  expect(await run(["pr", "-t", "-n", "-2", "-e:8"], prColonTabInput)).toMatchObject({ code: 0, stdout: "    1\taaa\tabcde\t\tfgh \t3   ccc\t    abcde\t    fgh\n    2\tbbb\tabcde\t\tfgh \t4   ddd\t    abcde\t    fgh\n" });
  expect(await run(["pr", "-t", "-e:4"], "a:b\na\tb\n")).toMatchObject(await systemRun(["/usr/bin/pr", "-t", "-e:4"], "a:b\na\tb\n"));
  expect(await run(["pr", "-t", "-e:"], "a:b\na\tb\n")).toMatchObject(await systemRun(["/usr/bin/pr", "-t", "-e:"], "a:b\na\tb\n"));
  expect(await run(["pr", "-t", "-n", "-2", "-e8", "-o3"], prTabInput)).toMatchObject({ code: 0, stdout: "       1   aaa\t   abcde\t   fgh \t   3   ccc     abcde\t       fgh\n       2   bbb\t   abcde\t   fgh \t   4   ddd     abcde\t       fgh\n" });
  expect(await run(["pr", "-t", "-n", "-2", "-e5", "-o3"], prTabInput)).toMatchObject({ code: 0, stdout: "       1   aaa\t  abcde\t\t fghij \t   3   ccc    abcde\t     fghij\n       2   bbb\t  abcde\t\t fghij \t   4   ddd    abcde\t     fghij\n" });
  expect(await run(["pr", "--date-format=-- Date/Time --", "-h", "x", "-f"], "a\n")).toMatchObject({ code: 0, stdout: "\n\n-- Date/Time --                         x                         Page 1\n\n\na\n\f" });
  expect(await run(["pr", "--date-format=-- Date/Time --", "-h", "x", "-n.3", "-l", "11", "-f"], "a\f\nb\n")).toMatchObject({ code: 0, stdout: "\n\n-- Date/Time --                         x                         Page 1\n\n\n  1.a\n\f\n\n-- Date/Time --                         x                         Page 2\n\n\n  2.b\n\f" });
  expect(await run(["pr", "--date-format=-- Date/Time --", "-h", "x", "-a", "-3", "-l", "12", "-f"], "1\n2\n3\n4\n5\n6\n")).toMatchObject({ code: 0, stdout: `\n\n-- Date/Time --                         x                         Page 1\n\n\n1${"\t".repeat(3)}2${"\t".repeat(3)}3\n4${"\t".repeat(3)}5${"\t".repeat(3)}6\n\f` });
  expect(await run(["pr", "--date-format=-- Date/Time --", "-h", "x", "-b", "-3", "-l", "12", "-f"], "1\n2\n3\n4\n5\n6\n")).toMatchObject({ code: 0, stdout: `\n\n-- Date/Time --                         x                         Page 1\n\n\n1${"\t".repeat(3)}3${"\t".repeat(3)}5\n2${"\t".repeat(3)}4${"\t".repeat(3)}6\n\f` });
  expect(await run(["pr", "--date-format=-- Date/Time --", "-h", "x", "-a", "-3", "-l", "12", "-f"], "abcdefghijklmnopqrstuvw\n12345678901234567890123\nXYZXYZXYZXYZXYZXYZXYZ\n")).toMatchObject({ code: 0, stdout: "\n\n-- Date/Time --                         x                         Page 1\n\n\nabcdefghijklmnopqrstuvw 12345678901234567890123 XYZXYZXYZXYZXYZXYZXYZ\n\f" });
  const prPagedTabInput = "1   FF-Test: FFs in Text\n2\tOptions -b -3 / -a -3 / ...\n3   -------------------------------\n4 3456789 123456789 123456789 12345\n5   3 Columns downwards ..., <= 5 l\n6\tFF-Arangements: One Empty Page\n";
  expect(await run(["pr", "--date-format=-- Date/Time --", "-h", "x", "-a", "-2", "-l", "17"], prPagedTabInput)).toMatchObject({ code: 0, stdout: "\n\n-- Date/Time --                         x                         Page 1\n\n\n1   FF-Test: FFs in Text\t    2\t    Options -b -3 / -a -3 / ...\n3   ------------------------------- 4 3456789 123456789 123456789 12345\n5   3 Columns downwards ..., <= 5 l 6\t    FF-Arangements: One Empty P\n\n\n\n\n\n\n\n\n\n" });
  expect(await run(["pr", "-0"])).toMatchObject(await systemRun(["pr", "-0"]));
  expect(await run(["pr", `-${"9".repeat(100)}`])).toMatchObject(await systemRun(["pr", `-${"9".repeat(100)}`]));
  expect(await run(["pr", "-3x"])).toMatchObject(await systemRun(["pr", "-3x"]));
  expect(await run(["pr", "-x", "--help"])).toMatchObject(await systemRun(["pr", "-x", "--help"]));
  expect(await run(["pr", "-w", "0"])).toMatchObject(await systemRun(["pr", "-w", "0"]));
  expect(await run(["pr", "-w", "-1"])).toMatchObject(await systemRun(["pr", "-w", "-1"]));
  expect(await run(["pr", "-w", "x"])).toMatchObject(await systemRun(["pr", "-w", "x"]));
  expect(await run(["pr", "-w", "x", "--help"])).toMatchObject(await systemRun(["pr", "-w", "x", "--help"]));
  expect(await run(["pr", "-wx", "--help"])).toMatchObject(await systemRun(["pr", "-wx", "--help"]));
  expect(await run(["pr", "-w", "10", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: pr [OPTION]... [FILE]...\n") });
  expect(await run(["pr", "-w", "1\n2"])).toMatchObject({ code: 1, stdout: "", stderr: `pr: '-w PAGE_WIDTH' invalid number of characters: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["pr", "-W", "0"])).toMatchObject(await systemRun(["pr", "-W", "0"]));
  expect(await run(["pr", "-W", "x", "--help"])).toMatchObject(await systemRun(["pr", "-W", "x", "--help"]));
  expect(await run(["pr", "--page-width=0"])).toMatchObject(await systemRun(["pr", "--page-width=0"]));
  expect(await run(["pr", "-l", "0"])).toMatchObject(await systemRun(["pr", "-l", "0"]));
  expect(await run(["pr", "-l", "-1"])).toMatchObject(await systemRun(["pr", "-l", "-1"]));
  expect(await run(["pr", "-l", "x"])).toMatchObject(await systemRun(["pr", "-l", "x"]));
  expect(await run(["pr", "-l", "x", "--help"])).toMatchObject(await systemRun(["pr", "-l", "x", "--help"]));
  expect(await run(["pr", "-N", "x"])).toMatchObject(await systemRun(["pr", "-N", "x"]));
  expect(await run(["pr", "-N", "2147483648"])).toMatchObject(await systemRun(["pr", "-N", "2147483648"]));
  expect(await run(["pr", "--first-line-number=x"])).toMatchObject(await systemRun(["pr", "--first-line-number=x"]));
  expect(await run(["pr", "-o", "-1"])).toMatchObject(await systemRun(["pr", "-o", "-1"]));
  expect(await run(["pr", "-o", "+1"], "x\n")).toMatchObject(await systemRun(["pr", "-o", "+1"], "x\n"));
  expect(await run(["pr", "-o", "x", "--help"])).toMatchObject(await systemRun(["pr", "-o", "x", "--help"]));
  expect(await run(["pr", "-n", "bad", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: pr [OPTION]... [FILE]...\n") });
  expect(await run(["pr", "-nbad", "--help"])).toMatchObject(await systemRun(["pr", "-nbad", "--help"]));
  expect(await run(["pr", "-e", "bad", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: pr [OPTION]... [FILE]...\n") });
  expect(await run(["pr", "-ebad", "--help"])).toMatchObject(await systemRun(["pr", "-ebad", "--help"]));
  expect(await run(["pr", "--columns=x"])).toMatchObject({ code: 1, stdout: "", stderr: `pr: invalid number of columns: ${diagnosticQuote("x")}\n` });
  expect(await run(["pr", "--columns=1\n2"])).toMatchObject({ code: 1, stdout: "", stderr: `pr: invalid number of columns: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["pr", "--columns=0"])).toMatchObject({ code: 1, stdout: "", stderr: `pr: invalid number of columns: ${diagnosticQuote("0")}: Numerical result out of range\n` });
  expect(await run(["pr", "--columns=999999999999999999999999999999"])).toMatchObject({ code: 1, stdout: "", stderr: `pr: invalid number of columns: ${diagnosticQuote("999999999999999999999999999999")}: Value too large for defined data type\n` });
  expect(await run(["pr", "--pages=x"])).toMatchObject({ code: 1, stderr: "pr: invalid --pages argument 'x'\n" });
  expect(await run(["pr", "--pages=bad", "--help"])).toMatchObject(await systemRun(["pr", "--pages=bad", "--help"]));
  expect(await run(["pr", "--pages=9x", "--help"])).toMatchObject(await systemRun(["pr", "--pages=9x", "--help"]));
  expect(await run(["pr", "--pages=9x"])).toMatchObject({ code: 1, stderr: `pr: invalid page range ${diagnosticQuote("9x")}\n` });
  expect(await run(["pr", "--pages=9x\ny"])).toMatchObject({ code: 1, stderr: `pr: invalid page range ${diagnosticQuote("9x\\ny")}\n` });
  expect(await run(["pr", "--pages=9\nx"])).toMatchObject({ code: 1, stderr: `pr: invalid page range ${diagnosticQuote("9\\nx")}\n` });
  expect(await run(["pr", "--pages=1:-1"])).toMatchObject({ code: 1, stderr: "pr: invalid --pages argument '1:-1'\n" });
  expect(await run(["pr", "--expand-tabs=bad", "--help"])).toMatchObject(await systemRun(["pr", "--expand-tabs=bad", "--help"]));
  expect(await run(["pr", "--number-lines=bad", "--help"])).toMatchObject(await systemRun(["pr", "--number-lines=bad", "--help"]));
  expect(await run(["pr", "--output-tabs=bad", "--help"])).toMatchObject(await systemRun(["pr", "--output-tabs=bad", "--help"]));
  expect(await run(["pr", "--expand-tabs=", "--help"])).toMatchObject(await systemRun(["pr", "--expand-tabs=", "--help"]));
  await writeFile(join(dir, "pr-control"), Uint8Array.of(0x61, 0x01, 0x62, 0x7f, 0x09, 0x63, 0x0a, 0x80, 0xff, 0x0a));
  expect(await run(["pr", "-t", "-c", "pr-control"], "", { env: { LC_ALL: "C" } })).toMatchObject({ code: 0, stdout: "a^Ab^?\tc\n\\200\\377\n" });
  expect(await run(["pr", "-t", "--show-nonprinting", "pr-control"], "", { env: { LC_ALL: "C" } })).toMatchObject({ code: 0, stdout: "a\\001b\\177\tc\n\\200\\377\n" });
  expect((await run(["pinky"])).stdout).toStartWith("Login    Name");
  const pinkyShort = (await run(["pinky", "-s"])).stdout;
  expect(pinkyShort).toStartWith("Login    Name");
  expect(pinkyShort).toMatch(/ \?tty\d* +\?{5}  /);
  expect(await run(["pinky", "--lookup"])).toMatchObject({ code: 0 });
  expect(await run(["pinky", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: pinky [OPTION]... [USER]...\n") });
  expect(await run(["pinky", "--l"])).toMatchObject({ code: 0 });
  expect(await run(["pinky", "--lo"])).toMatchObject({ code: 0 });
  expect((await run(["pinky", "--short"])).stderr).toContain("unrecognized option '--short'");
  expect((await run(["pinky", "--long", "root"])).stderr).toContain("unrecognized option '--long'");
  expect((await run(["pinky", "--look=bad", "--help"])).stderr).toContain("option '--lookup' doesn't allow an argument");
  expect((await run(["pinky", "--bad", "--help"])).stderr).toContain("unrecognized option '--bad'");
  expect((await run(["pinky", "-x", "--help"])).stderr).toContain("invalid option -- 'x'");
  const pinkyLiteralHelp = await run(["pinky", "--", "--help"]);
  expect(pinkyLiteralHelp).toMatchObject({ code: 0 });
  expect(pinkyLiteralHelp.stdout).toStartWith("Login    Name");
  expect(await run(["pinky", "-l"])).toMatchObject({ code: 1, stderr: "pinky: no username specified; at least one must be specified when using -l\nTry 'pinky --help' for more information.\n" });
  expect((await run(["pinky", "-l", "root"])).stdout).toContain("Directory: /root");
  expect(await run(["pinky", "-l", "-h", "-p", "root"], "", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/pinky", "-l", "-h", "-p", "root"], "", { env: { LC_ALL: "C" } }));
  expect(await run(["pinky", "-ls", "root"], "", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/pinky", "-ls", "root"], "", { env: { LC_ALL: "C" } }));
  expect(await run(["pinky", "-sl", "root"], "", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/pinky", "-sl", "root"], "", { env: { LC_ALL: "C" } }));
  expect(await run(["pinky", "definitely-missing-user"])).toMatchObject({ code: 0, stdout: "Login    Name                 TTY      Idle   When             Where\n" });
  expect(await run(["pinky", "definitely-missing-user"], "", { env: { LC_ALL: "C" } })).toMatchObject({ code: 0, stdout: "Login    Name                 TTY      Idle   When         Where\n" });
  expect((await run(["pinky", "-l", "definitely-missing-user"])).stdout).toContain("In real life:  ???");
  expect(await run(["pinky", "-l", "definitely-missing-user", "root"], "", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/pinky", "-l", "definitely-missing-user", "root"], "", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx"], "Beta alpha beta\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx"], "Beta alpha beta\n", { env: { LC_ALL: "C" } }));
  const ptxWrapInput = "the quick brown fox\nthe quick blue hare\n";
  expect(await run(["ptx"], ptxWrapInput, { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx"], ptxWrapInput, { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "-g", "1"], ptxWrapInput, { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "-g", "1"], ptxWrapInput, { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--format=tex"], ptxWrapInput, { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--format=tex"], ptxWrapInput, { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--format=roff"], ptxWrapInput, { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--format=roff"], ptxWrapInput, { env: { LC_ALL: "C" } }));
  await writeFile(join(dir, "ptx-raw"), Uint8Array.of(0x61, 0xff, 0x20, 0x62, 0x0a));
  const ptxRaw = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/bnu.js"), "ptx", "ptx-raw"], {
    cwd: dir,
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: Bun.file(join(dir, "ptx-raw-out")),
    stderr: "pipe",
  });
  expect(await ptxRaw.exited).toBe(0);
  expect(await new Response(ptxRaw.stderr).text()).toBe("");
  expect(Buffer.from(await readFile(join(dir, "ptx-raw-out")))).toEqual(Buffer.concat([
    Buffer.from("                                       a"),
    Buffer.from([0xff, 0x20, 0x62, 0x0a]),
    Buffer.from("                                  a"),
    Buffer.from([0xff, 0x20, 0x20, 0x20, 0x62, 0x0a]),
  ]));
  expect((await run(["ptx", "--ign", "--help"])).stderr).toContain("option '--ign' is ambiguous; possibilities: '--ignore-case' '--ignore-file'");
  expect((await run(["ptx", "--r", "--help"])).stderr).toContain("option '--r' is ambiguous; possibilities: '--references' '--right-side-refs'");
  expect((await run(["ptx", "--f", "--help"])).stderr).toContain("option '--f' is ambiguous; possibilities: '--flag-truncation' '--format'");
  expect((await run(["ptx", "--right=bad", "--help"])).stderr).toContain("option '--right-side-refs' doesn't allow an argument");
  expect((await run(["ptx", "--auto=bad", "--help"])).stderr).toContain("option '--auto-reference' doesn't allow an argument");
  expect(await run(["ptx", "--format", "--help"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `ptx: invalid argument ${diagnosticQuote("--help")} for ${diagnosticQuote("--format")}\nValid arguments are:\n  - ${diagnosticQuote("roff")}\n  - ${diagnosticQuote("tex")}\nTry 'ptx --help' for more information.\n`,
  });
  expect(await run(["ptx", "--format="])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `ptx: ambiguous argument ${diagnosticQuote("")} for ${diagnosticQuote("--format")}\nValid arguments are:\n  - ${diagnosticQuote("roff")}\n  - ${diagnosticQuote("tex")}\nTry 'ptx --help' for more information.\n`,
  });
  expect(await run(["ptx", "--format=bad"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `ptx: invalid argument ${diagnosticQuote("bad")} for ${diagnosticQuote("--format")}\nValid arguments are:\n  - ${diagnosticQuote("roff")}\n  - ${diagnosticQuote("tex")}\nTry 'ptx --help' for more information.\n`,
  });
  expect(await run(["ptx", "--format=bad\nmode"])).toMatchObject({
    code: 1,
    stdout: "",
    stderr: `ptx: invalid argument ${diagnosticQuote("bad\\nmode")} for ${diagnosticQuote("--format")}\nValid arguments are:\n  - ${diagnosticQuote("roff")}\n  - ${diagnosticQuote("tex")}\nTry 'ptx --help' for more information.\n`,
  });
  expect(await run(["ptx", "--format=bad", "--help"])).toMatchObject(await systemRun(["ptx", "--format=bad", "--help"]));
  expect(await run(["ptx", "--format=", "--help"])).toMatchObject(await systemRun(["ptx", "--format=", "--help"]));
  expect(await run(["ptx", "--format=r"], "alpha beta\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--format=r"], "alpha beta\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--format=t"], "alpha beta\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--format=t"], "alpha beta\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--format=te", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: ptx [OPTION]... [INPUT]...   (without -G)\n") });
  expect(await run(["ptx", "--ignore-f", "--help", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["ptx", "--gap=3", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: ptx [OPTION]... [INPUT]...   (without -G)\n  or:  ptx -G [OPTION]... [INPUT [OUTPUT]]\n") });
  expect(await run(["ptx", "ptx-raw", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: ptx [OPTION]... [INPUT]...   (without -G)\n"), stderr: "" });
  expect(await run(["ptx", "--", "--help"])).toMatchObject({ code: 1, stderr: "ptx: --help: No such file or directory\n" });
  expect(await run(["ptx", "ptx-missing"])).toMatchObject({ code: 1, stdout: "", stderr: "ptx: ptx-missing: No such file or directory\n" });
  expect(await run(["ptx", "missing'ptx"])).toMatchObject({ code: 1, stdout: "", stderr: "ptx: \"missing'ptx\": No such file or directory\n" });
  expect(await run(["ptx", "missing\nptx"])).toMatchObject({ code: 1, stdout: "", stderr: "ptx: 'missing'$'\\n''ptx': No such file or directory\n" });
  await mkdir(join(dir, "ptx-dir"));
  expect(await run(["ptx", "ptx-dir"])).toMatchObject({ code: 1, stdout: "", stderr: "ptx: ptx-dir: Is a directory\n" });
  await mkdir(join(dir, "dir'ptx"));
  expect(await run(["ptx", "dir'ptx"])).toMatchObject({ code: 1, stdout: "", stderr: "ptx: \"dir'ptx\": Is a directory\n" });
  expect(await run(["ptx", "-f"], "Beta alpha beta\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "-f"], "Beta alpha beta\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--ignore-case"], "Beta alpha beta\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--ignore-case"], "Beta alpha beta\n", { env: { LC_ALL: "C" } }));
  await writeFile(join(dir, "ignore-words"), "beta\n");
  await writeFile(join(dir, "only-words"), "alpha\n");
  expect(await run(["ptx", "-i", "ptx-ignore-missing"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: "ptx: ptx-ignore-missing: No such file or directory\n" });
  expect(await run(["ptx", "-i", "missing'ptx-list"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: "ptx: \"missing'ptx-list\": No such file or directory\n" });
  expect(await run(["ptx", "-i", "missing\nptx-list"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: "ptx: 'missing'$'\\n''ptx-list': No such file or directory\n" });
  expect(await run(["ptx", "--only-file=ptx-only-missing"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: "ptx: ptx-only-missing: No such file or directory\n" });
  expect(await run(["ptx", "-i", "ptx-dir"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: "ptx: ptx-dir: Is a directory\n" });
  await mkdir(join(dir, "dir'ptx-list"));
  expect(await run(["ptx", "-i", "dir'ptx-list"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: "ptx: \"dir'ptx-list\": Is a directory\n" });
  await symlink("ptx-loop", join(dir, "ptx-loop"));
  expect(await run(["ptx", "--only-file=ptx-loop"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: "ptx: ptx-loop: Too many levels of symbolic links\n" });
  await symlink("loop'ptx", join(dir, "loop'ptx"));
  expect(await run(["ptx", "loop'ptx"])).toMatchObject({ code: 1, stdout: "", stderr: "ptx: \"loop'ptx\": Too many levels of symbolic links\n" });
  await symlink("loop'ptx-list", join(dir, "loop'ptx-list"));
  expect(await run(["ptx", "--only-file=loop'ptx-list"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: "ptx: \"loop'ptx-list\": Too many levels of symbolic links\n" });
  expect(await run(["ptx", "-i", "ignore-words"], "alpha beta gamma\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "-i", "ignore-words"], "alpha beta gamma\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--only-file=only-words"], "alpha beta gamma\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--only-file=only-words"], "alpha beta gamma\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "-W", "[0-9]+"], "abc 123 def 45\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "-W", "[0-9]+"], "abc 123 def 45\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "-w", "10"], "foo bar\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "-w", "10"], "foo bar\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "-w", "20"], "alpha beta gamma delta\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "-w", "20"], "alpha beta gamma delta\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--auto-reference"], "alpha beta\n")).toMatchObject({ code: 0 });
  expect(await run(["ptx", "--break-file=/dev/null"], "alpha beta\n")).toMatchObject({ code: 0 });
  expect(await run(["ptx", "--flag-truncation=X"], "alpha beta\n")).toMatchObject({ code: 0 });
  expect(await run(["ptx", "--gap-size=3"], "alpha beta\n")).toMatchObject({ code: 0 });
  expect(await run(["ptx", "--width=0"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: `ptx: invalid line width: ${diagnosticQuote("0")}\n` });
  expect(await run(["ptx", "-w", "bad"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: `ptx: invalid line width: ${diagnosticQuote("bad")}\n` });
  expect(await run(["ptx", "-w", "1\n2"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: `ptx: invalid line width: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["ptx", "--gap-size=0"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: `ptx: invalid gap width: ${diagnosticQuote("0")}\n` });
  expect(await run(["ptx", "-g", "bad"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: `ptx: invalid gap width: ${diagnosticQuote("bad")}\n` });
  expect(await run(["ptx", "-g", "1\n2"], "alpha beta\n")).toMatchObject({ code: 1, stdout: "", stderr: `ptx: invalid gap width: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["ptx", "--width=bad", "--help"])).toMatchObject(await systemRun(["ptx", "--width=bad", "--help"]));
  expect(await run(["ptx", "--width", "bad", "--help"])).toMatchObject(await systemRun(["ptx", "--width", "bad", "--help"]));
  expect(await run(["ptx", "-w", "bad", "--help"])).toMatchObject(await systemRun(["ptx", "-w", "bad", "--help"]));
  expect(await run(["ptx", "-wbad", "--help"])).toMatchObject(await systemRun(["ptx", "-wbad", "--help"]));
  expect(await run(["ptx", "--width", "10", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: ptx [OPTION]... [INPUT]...   (without -G)\n") });
  expect(await run(["ptx", "--gap-size=bad", "--help"])).toMatchObject(await systemRun(["ptx", "--gap-size=bad", "--help"]));
  expect(await run(["ptx", "--gap-size", "bad", "--help"])).toMatchObject(await systemRun(["ptx", "--gap-size", "bad", "--help"]));
  expect(await run(["ptx", "-g", "bad", "--help"])).toMatchObject(await systemRun(["ptx", "-g", "bad", "--help"]));
  expect(await run(["ptx", "-gbad", "--help"])).toMatchObject(await systemRun(["ptx", "-gbad", "--help"]));
  expect(await run(["ptx", "-g", "3", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: ptx [OPTION]... [INPUT]...   (without -G)\n") });
  expect(await run(["ptx", "--right-side-refs"], "alpha beta\n")).toMatchObject({ code: 0 });
  expect(await run(["ptx", "--typeset-mode"], "alpha beta\n")).toMatchObject({ code: 0 });
  expect(await run(["ptx", "-T"], "Beta alpha beta\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "-T"], "Beta alpha beta\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--format=roff", "--macro-name=yy"], "Beta alpha beta\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--format=roff", "--macro-name=yy"], "Beta alpha beta\n", { env: { LC_ALL: "C" } }));
  await writeFile(join(dir, "ptx-traditional-in"), "alpha beta\n");
  expect(await run(["ptx", "-G", "ptx-traditional-in", "ptx-traditional-out"], "", { env: { LC_ALL: "C" } })).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await readFile(join(dir, "ptx-traditional-out"), "utf8")).toBe((await systemRun(["/usr/bin/ptx", "-G", "ptx-traditional-in"], "", { env: { LC_ALL: "C" } })).stdout);
  expect(await run(["ptx", "-G", "ptx-traditional-in", "ptx-traditional-out", "extra"])).toMatchObject({ code: 1, stdout: "", stderr: `ptx: extra operand ${diagnosticQuote("extra")}\nTry 'ptx --help' for more information.\n` });
  expect(await run(["ptx", "-G", "ptx-traditional-in", "ptx-traditional-out", "extra\narg"])).toMatchObject({ code: 1, stdout: "", stderr: `ptx: extra operand ${diagnosticQuote("extra\\narg")}\nTry 'ptx --help' for more information.\n` });
  expect(await run(["stty", "-a"])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "-g"])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "--save"])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "--sa"])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: stty [-F DEVICE | --file=DEVICE] [SETTING]...\n  or:  stty [-F DEVICE | --file=DEVICE] [-a|--all]\n  or:  stty [-F DEVICE | --file=DEVICE] [-g|--save]\n") });
  expect(await run(["stty", "--a", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: stty") });
  expect(await run(["stty", "-x", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: stty") });
  expect(await run(["stty", "--bad", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: stty") });
  expect(await run(["stty", "--all=bad"])).toMatchObject(await systemRun(["stty", "--all=bad"]));
  expect(await run(["stty", "--file"])).toMatchObject(await systemRun(["stty", "--file"]));
  expect(await run(["stty", "--file", "--help"])).toMatchObject({ code: 1, stderr: "stty: --help: No such file or directory\n" });
  expect(await run(["stty", "--file", "--help", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect(await run(["stty", "--file=/dev/null", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: stty") });
  expect(await run(["stty", "--file=", "--all"])).toMatchObject({ code: 1, stderr: "stty: '': No such file or directory\n" });
  expect(await run(["stty", "--", "--help"])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "--", "raw"])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "-ag"])).toMatchObject({ code: 1, stderr: "stty: the options for verbose and stty-readable output styles are\nmutually exclusive\n" });
  expect(await run(["stty", "-a", "-g"])).toMatchObject({ code: 1, stderr: "stty: the options for verbose and stty-readable output styles are\nmutually exclusive\n" });
  expect(await run(["stty", "-a", "rows", "1"])).toMatchObject({ code: 1, stderr: "stty: when specifying an output style, modes may not be set\n" });
  expect(await run(["stty", "-aF/dev/null"])).toMatchObject({ code: 1, stderr: "stty: /dev/null: Inappropriate ioctl for device\n" });
  expect(await run(["stty", "speed"])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "size"])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "rows"])).toMatchObject({ code: 1, stderr: "stty: missing argument to 'rows'\nTry 'stty --help' for more information.\n" });
  expect(await run(["stty", "intr"])).toMatchObject({ code: 1, stderr: "stty: missing argument to 'intr'\nTry 'stty --help' for more information.\n" });
  expect(await run(["stty", "rows", "x"])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "min", "-1"])).toMatchObject({ code: 1, stderr: `stty: invalid integer argument: ${diagnosticQuote("-1")}\n` });
  expect(await run(["stty", "min", "1\n2"])).toMatchObject({ code: 1, stderr: `stty: invalid integer argument: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["stty", "time", "1x"])).toMatchObject({ code: 1, stderr: `stty: invalid integer argument: ${diagnosticQuote("1x")}\n` });
  expect(await run(["stty", "ispeed", "x"])).toMatchObject({ code: 1, stderr: `stty: invalid ispeed ${diagnosticQuote("x")}\nTry 'stty --help' for more information.\n` });
  expect(await run(["stty", "ispeed", "1\n2"])).toMatchObject({ code: 1, stderr: `stty: invalid ispeed ${diagnosticQuote("1\\n2")}\nTry 'stty --help' for more information.\n` });
  expect(await run(["stty", "ispeed", "9600.0 "])).toMatchObject({ code: 1, stderr: `stty: invalid ispeed ${diagnosticQuote("9600.0 ")}\nTry 'stty --help' for more information.\n` });
  expect(await run(["stty", "intr", "M-^?"])).toMatchObject({ code: 1, stderr: `stty: invalid integer argument: ${diagnosticQuote("M-^?")}\n` });
  expect(await run(["stty", "intr", "bad\nvalue"])).toMatchObject({ code: 1, stderr: `stty: invalid integer argument: ${diagnosticQuote("bad\\nvalue")}\n` });
  expect(await run(["stty", "intr", ""])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "line", "1x"])).toMatchObject({ code: 1, stderr: `stty: invalid integer argument: ${diagnosticQuote("1x")}\n` });
  expect(await run(["stty", "1:2"])).toMatchObject({ code: 1, stderr: `stty: invalid argument ${diagnosticQuote("1:2")}\nTry 'stty --help' for more information.\n` });
  expect(await run(["stty", "status"])).toMatchObject({ code: 1, stderr: `stty: invalid argument ${diagnosticQuote("status")}\nTry 'stty --help' for more information.\n` });
  expect(await run(["stty", "bad\nsetting"])).toMatchObject({ code: 1, stderr: `stty: invalid argument ${diagnosticQuote("bad\\nsetting")}\nTry 'stty --help' for more information.\n` });
  expect(await run(["stty", "parenb"])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "-parenb"])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "intr", "^C"])).toMatchObject({ code: 1, stderr: "stty: 'standard input': Inappropriate ioctl for device\n" });
  expect(await run(["stty", "-F", "/dev/null", "rows", "24", "cols", "80", "sane"])).toMatchObject({ code: 1, stderr: "stty: /dev/null: Inappropriate ioctl for device\n" });
  expect(await run(["stty", "definitely-not-a-setting"])).toMatchObject({ code: 1 });
  if ((await shell("command -v script >/dev/null")).code === 0) {
    const sttyPty = await shell(`script -qfec '"$BUN" "$BNU" stty; "$BUN" "$BNU" stty -g; "$BUN" "$BNU" stty -a' /dev/null`);
    expect(sttyPty).toMatchObject({ code: 0, stderr: "" });
    const sttyStdout = sttyPty.stdout.replaceAll("\r\n", "\n");
    expect(sttyStdout).toContain("speed 38400 baud; line = 0;\n-brkint -imaxbel\n");
    expect(sttyStdout).toContain("500:5:f00bf:8a3b:");
    expect(sttyStdout).toContain("intr = ^C; quit =");
    expect(sttyStdout).toContain("erase = ^?; kill = ^U;");
    expect(sttyStdout).toContain("opost -olcuc -ocrnl onlcr");
    const sttyRaw = await shell(`script -qfec 'orig=$("$BUN" "$BNU" stty -g); "$BUN" "$BNU" stty raw -echo; "$BUN" "$BNU" stty -g; "$BUN" "$BNU" stty "$orig"; "$BUN" "$BNU" stty -g' /dev/null`);
    expect(sttyRaw).toMatchObject({ code: 0, stderr: "" });
    const sttyRawLines = sttyRaw.stdout.replaceAll("\r\n", "\n").trim().split("\n");
    expect(sttyRawLines).toEqual([
      "0:4:f00bf:8a30:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "500:5:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
    ]);
    const sttyDrain = await shell(`script -qfec '"$BUN" "$BNU" stty drain; "$BUN" "$BNU" stty -drain echo; "$BUN" "$BNU" stty drain echo' /dev/null`);
    expect(sttyDrain).toMatchObject({ code: 0, stderr: "" });
    expect(sttyDrain.stdout.replaceAll("\r\n", "\n")).toContain("speed 38400 baud; line = 0;\n");
    const sttyWindow = await shell(`script -qfec '"$BUN" "$BNU" stty rows 24 cols 80; "$BUN" "$BNU" stty size; "$BUN" "$BNU" stty -a | sed -n "1p"; stty rows 0 cols 0' /dev/null`);
    expect(sttyWindow).toMatchObject({ code: 0, stderr: "" });
    expect(sttyWindow.stdout.replaceAll("\r\n", "\n").trim().split("\n")).toEqual([
      "24 80",
      "speed 38400 baud; rows 24; columns 80; line = 0;",
    ]);
    const sttyOctalWindow = await shell(`script -qfec '"$BUN" "$BNU" stty rows 036 cols 0; "$BUN" "$BNU" stty size; stty rows 0 cols 0' /dev/null`);
    expect(sttyOctalWindow).toMatchObject({ code: 0, stderr: "" });
    expect(sttyOctalWindow.stdout.replaceAll("\r\n", "\n").trim()).toBe("30 0");
    const sttyFile = await shell(`script -qfec 'orig=$("$BUN" "$BNU" stty -F /dev/tty -g); "$BUN" "$BNU" stty --file=/dev/tty size; "$BUN" "$BNU" stty --file=/dev/tty raw -echo; "$BUN" "$BNU" stty -F /dev/tty -g; "$BUN" "$BNU" stty --file=/dev/tty "$orig"; "$BUN" "$BNU" stty -F /dev/tty -g' /dev/null`);
    expect(sttyFile).toMatchObject({ code: 0, stderr: "" });
    const sttyFileLines = sttyFile.stdout.replaceAll("\r\n", "\n").trim().split("\n");
    expect(sttyFileLines).toEqual([
      "0 0",
      "0:4:f00bf:8a30:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "500:5:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
    ]);
    const sttyFileWindow = await shell(`script -qfec '"$BUN" "$BNU" stty -F /dev/tty rows 33 cols 101; "$BUN" "$BNU" stty -F /dev/tty size; "$BUN" "$BNU" stty -F /dev/tty -a | sed -n "1p"; stty rows 0 cols 0' /dev/null`);
    expect(sttyFileWindow).toMatchObject({ code: 0, stderr: "" });
    expect(sttyFileWindow.stdout.replaceAll("\r\n", "\n").trim().split("\n")).toEqual([
      "33 101",
      "speed 38400 baud; rows 33; columns 101; line = 0;",
    ]);
    const sttyAliases = await shell(`script -qfec 'for mode in cbreak -cbreak cooked pass8 -pass8 litout -litout nl -nl; do stty sane; "$BUN" "$BNU" stty "$mode"; printf "%s " "$mode"; stty -g; done; stty sane' /dev/null`);
    expect(sttyAliases.code).toBe(0);
    expect(sttyAliases.stdout.replaceAll("\r\n", "\n").trim().split("\n")).toEqual([
      "cbreak 2502:5:f00bf:8a39:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "-cbreak 2502:5:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "cooked 2526:5:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "pass8 2506:5:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "-pass8 2526:5:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "litout 2506:4:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "-litout 2526:5:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "nl 2426:1:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "-nl 2526:5:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
    ]);
    const sttySpeeds = await shell(`script -qfec 'stty sane; "$BUN" "$BNU" stty 9600; "$BUN" "$BNU" stty speed; "$BUN" "$BNU" stty -g; "$BUN" "$BNU" stty ispeed 4800 ospeed 19200; "$BUN" "$BNU" stty speed; "$BUN" "$BNU" stty -a | sed -n "1p"; "$BUN" "$BNU" stty -g; "$BUN" "$BNU" stty 123; "$BUN" "$BNU" stty speed; "$BUN" "$BNU" stty -g; stty sane' /dev/null`);
    expect(sttySpeeds).toMatchObject({ code: 0, stderr: "" });
    expect(sttySpeeds.stdout.replaceAll("\r\n", "\n").trim().split("\n")).toEqual([
      "9600",
      "2502:5:d00bd:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "4800 19200",
      "ispeed 4800 baud; ospeed 19200 baud; rows 0; columns 0; line = 0;",
      "2502:5:c00be:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "123",
      "2502:5:100010b0:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
    ]);
    const sttyFractionalSpeed = await shell(`script -qfec 'stty sane; "$BUN" "$BNU" stty ispeed 9600.50; "$BUN" "$BNU" stty speed; "$BUN" "$BNU" stty ispeed 135.5; "$BUN" "$BNU" stty speed; "$BUN" "$BNU" stty ispeed exta; "$BUN" "$BNU" stty speed; stty sane' /dev/null`);
    expect(sttyFractionalSpeed).toMatchObject({ code: 0, stderr: "" });
    expect(sttyFractionalSpeed.stdout.replaceAll("\r\n", "\n").trim().split("\n")).toEqual(["9600 38400", "136 38400", "19200 38400"]);
    const sttyNumericControls = await shell(`script -qfec 'stty sane; for value in 010 0x3 ^- 8; do "$BUN" "$BNU" stty intr "$value"; "$BUN" "$BNU" stty -g; done; stty sane' /dev/null`);
    expect(sttyNumericControls).toMatchObject({ code: 0, stderr: "" });
    expect(sttyNumericControls.stdout.replaceAll("\r\n", "\n").trim().split("\n").map((line) => line.split(":")[4])).toEqual(["8", "3", "0", "38"]);
    const sttyControls = await shell(`script -qfec 'stty sane; "$BUN" "$BNU" stty intr ^A erase ^H min 3 time 7; "$BUN" "$BNU" stty -g; "$BUN" "$BNU" stty -a | sed -n "2,4p"; "$BUN" "$BNU" stty swtch ^B eol ^E eol2 ^F; "$BUN" "$BNU" stty -g; "$BUN" "$BNU" stty -a | sed -n "2,3p"; stty sane' /dev/null`);
    expect(sttyControls).toMatchObject({ code: 0, stderr: "" });
    expect(sttyControls.stdout.replaceAll("\r\n", "\n").trim().split("\n")).toEqual([
      "2502:5:f00bf:8a3b:1:1c:8:15:4:7:3:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "intr = ^A; quit = ^\\; erase = ^H; kill = ^U; eof = ^D; eol = <undef>;",
      "eol2 = <undef>; swtch = <undef>; start = ^Q; stop = ^S; susp = ^Z; rprnt = ^R;",
      "werase = ^W; lnext = ^V; discard = ^O; min = 3; time = 7;",
      "2502:5:f00bf:8a3b:1:1c:8:15:4:7:3:2:11:13:1a:5:12:f:17:16:6:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "intr = ^A; quit = ^\\; erase = ^H; kill = ^U; eof = ^D; eol = ^E;",
      "eol2 = ^F; swtch = ^B; start = ^Q; stop = ^S; susp = ^Z; rprnt = ^R;",
    ]);
    const sttyEmptyControl = await shell(`script -qfec 'stty sane; "$BUN" "$BNU" stty intr ""; "$BUN" "$BNU" stty -a | sed -n "2p"; stty sane' /dev/null`);
    expect(sttyEmptyControl).toMatchObject({ code: 0, stderr: "" });
    expect(sttyEmptyControl.stdout.replaceAll("\r\n", "\n").trim()).toBe("intr = <undef>; quit = ^\\; erase = ^?; kill = ^U; eof = ^D; eol = <undef>;");
    const sttyCflags = await shell(`script -qfec 'stty sane ignpar istrip parodd; "$BUN" "$BNU" stty sane; "$BUN" "$BNU" stty -g; "$BUN" "$BNU" stty hup; "$BUN" "$BNU" stty -g; "$BUN" "$BNU" stty -hup; "$BUN" "$BNU" stty -g; stty -ignpar -istrip -parodd; "$BUN" "$BNU" stty cmspar; "$BUN" "$BNU" stty -g; stty sane' /dev/null`);
    expect(sttyCflags).toMatchObject({ code: 0, stderr: "" });
    expect(sttyCflags.stdout.replaceAll("\r\n", "\n").trim().split("\n")).toEqual([
      "2526:5:f02bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "2526:5:f06bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "2526:5:f02bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "2502:5:400f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
    ]);
    const sttyDelays = await shell(`script -qfec 'for mode in nl1 cr2 tab3 bs1 vt1 ff1; do stty sane; "$BUN" "$BNU" stty "$mode"; printf "%s " "$mode"; "$BUN" "$BNU" stty -g; "$BUN" "$BNU" stty -a | sed -n "8p"; done; stty sane' /dev/null`);
    expect(sttyDelays).toMatchObject({ code: 0, stderr: "" });
    expect(sttyDelays.stdout.replaceAll("\r\n", "\n").trim().split("\n")).toEqual([
      "nl1 2502:105:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl1 cr0 tab0 bs0 vt0 ff0",
      "cr2 2502:405:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl0 cr2 tab0 bs0 vt0 ff0",
      "tab3 2502:1805:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl0 cr0 tab3 bs0 vt0 ff0",
      "bs1 2502:2005:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl0 cr0 tab0 bs1 vt0 ff0",
      "vt1 2502:4005:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl0 cr0 tab0 bs0 vt1 ff0",
      "ff1 2502:8005:f00bf:8a3b:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl0 cr0 tab0 bs0 vt0 ff1",
    ]);
    const sttyLocalModes = await shell(`script -qfec 'stty sane; "$BUN" "$BNU" stty xcase; printf "xcase "; "$BUN" "$BNU" stty -g; "$BUN" "$BNU" stty flusho; printf "flusho "; "$BUN" "$BNU" stty -g; "$BUN" "$BNU" stty extproc; printf "extproc "; "$BUN" "$BNU" stty -g; "$BUN" "$BNU" stty -a | sed -n "9,10p"; stty sane' /dev/null`);
    expect(sttyLocalModes).toMatchObject({ code: 0, stderr: "" });
    expect(sttyLocalModes.stdout.replaceAll("\r\n", "\n").trim().split("\n")).toEqual([
      "xcase 2502:5:f00bf:8a3f:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "flusho 2502:5:f00bf:9a3f:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "extproc 2502:5:f00bf:19a3f:3:1c:7f:15:4:0:1:0:11:13:1a:0:12:f:17:16:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0:0",
      "isig icanon iexten echo echoe echok -echonl -noflsh xcase -tostop -echoprt",
      "echoctl echoke flusho extproc",
    ]);
  }
  expect(await run(["coreutils", "echo", "nested"])).toMatchObject({ code: 0, stdout: "nested\n" });
  const namedGroups = await run(["id", "-Gn"]);
  expect(namedGroups.code).toBe(0);
  expect(await run(["id", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: id [OPTION]... [USER]...\n") });
  expect(await run(["groups"])).toMatchObject({ code: 0, stdout: namedGroups.stdout });
  expect(await run(["link", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: link FILE1 FILE2\n  or:  link OPTION\n") });
  expect(await run(["unlink", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: unlink FILE\n  or:  unlink OPTION\n") });
  const linkedCommands = join(dir, "linked-commands");
  const linkResult = await systemRun([process.execPath, join(import.meta.dir, "../scripts/link-commands.js"), linkedCommands]);
  expect(linkResult).toMatchObject({ code: 0, stderr: "" });
  expect(linkResult.stdout).toContain(" command wrappers");
  expect(await systemRun([join(linkedCommands, "echo"), "linked"], "", { env: { PATH: "" } })).toMatchObject({ code: 0, stdout: "linked\n", stderr: "" });
  await writeFile(join(dir, "linked-tail-input"), "a\nb\n");
  expect(await systemRun([join(linkedCommands, "tail"), "-n", "1", "linked-tail-input"], "", { env: { PATH: "" } })).toMatchObject({ code: 0, stdout: "b\n", stderr: "" });
  expect(await systemRun([join(linkedCommands, "timeout"), "1", join(linkedCommands, "echo"), "linked-timeout"], "", { env: { PATH: "" } })).toMatchObject({ code: 0, stdout: "linked-timeout\n", stderr: "" });
  expect(await shell(`PATH= "${linkedCommands}/tac" - <&-`)).toMatchObject({ code: 1, stdout: "", stderr: "tac: 'standard input': read error: Bad file descriptor\n" });
  expect(await systemRun([join(linkedCommands, "test"), "1", "=", "1"])).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await systemRun([join(linkedCommands, "["), "1", "=", "1", "]"], "", { env: { PATH: "" } })).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(await run(["logname", "extra"])).toMatchObject(await systemRun(["logname", "extra"]));
  expect(await run(["whoami", "extra"])).toMatchObject(await systemRun(["whoami", "extra"]));
  expect(await run(["arch", "extra"])).toMatchObject(await systemRun(["arch", "extra"]));
});

test("ptx emits automatic input references", async () => {
  await writeFile(join(dir, "ptx-breaks"), "-");
  expect(await run(["ptx", "--auto-reference"], "Beta alpha beta\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--auto-reference"], "Beta alpha beta\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "-A", "--right-side-refs"], "Beta alpha beta\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "-A", "--right-side-refs"], "Beta alpha beta\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--references"], "ref alpha beta gamma\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--references"], "ref alpha beta gamma\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "-rR"], "ref alpha beta gamma\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "-rR"], "ref alpha beta gamma\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "-r"], "r1 alpha beta\nr2 gamma delta\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "-r"], "r1 alpha beta\nr2 gamma delta\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--width=20", "--flag-truncation=!"], "alpha beta gamma delta epsilon\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--width=20", "--flag-truncation=!"], "alpha beta gamma delta epsilon\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--width=20", "--flag-truncation=XYZ"], "alpha beta gamma delta epsilon\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--width=20", "--flag-truncation=XYZ"], "alpha beta gamma delta epsilon\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--width=20", "--flag-truncation="], "alpha beta gamma delta epsilon\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--width=20", "--flag-truncation="], "alpha beta gamma delta epsilon\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--sentence-regexp=[.]"], "alpha beta. gamma delta.\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--sentence-regexp=[.]"], "alpha beta. gamma delta.\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "--break-file=ptx-breaks"], "alpha-beta gamma\n", { env: { LC_ALL: "C" } })).toMatchObject(await systemRun(["/usr/bin/ptx", "--break-file=ptx-breaks"], "alpha-beta gamma\n", { env: { LC_ALL: "C" } }));
  expect(await run(["ptx", "-p"])).toMatchObject({ code: 1, stdout: "", stderr: "ptx: invalid option -- 'p'\nTry 'ptx --help' for more information.\n" });
});

test("csplit creates numbered chunks", async () => {
  expect(await run(["csplit"])).toMatchObject({ code: 1, stderr: "csplit: missing operand\nTry 'csplit --help' for more information.\n" });
  expect(await run(["csplit", "--pre", "pref", "--suf", "%d", "-s", "-", "2"], "a\nb\n")).toMatchObject({ code: 0, stdout: "" });
  expect(await run(["csplit", "--digits=bad", "--help"])).toMatchObject(await systemRun(["csplit", "--digits=bad", "--help"]));
  expect(await run(["csplit", "--digits=", "--help"])).toMatchObject(await systemRun(["csplit", "--digits=", "--help"]));
  expect(await run(["csplit", "--digits", "--help"])).toMatchObject(await systemRun(["csplit", "--digits", "--help"]));
  expect(await run(["csplit", "-n", "bad", "--help"])).toMatchObject(await systemRun(["csplit", "-n", "bad", "--help"]));
  expect(await run(["csplit", "-nbad", "--help"])).toMatchObject(await systemRun(["csplit", "-nbad", "--help"]));
  expect(await run(["csplit", "-n", "2", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: csplit [OPTION]... FILE PATTERN...\n") });
  expect(await readFile(join(dir, "pref0"), "utf8")).toBe("a\n");
  expect(await readFile(join(dir, "pref1"), "utf8")).toBe("b\n");
  expect((await run(["csplit", "--s", "--help"])).stderr).toContain("option '--s' is ambiguous; possibilities: '--silent' '--suffix-format' '--suppress-matched'");
  expect(await run(["csplit", "--prefix", "--help"])).toMatchObject({ code: 1, stderr: "csplit: missing operand\nTry 'csplit --help' for more information.\n" });
  const csplitHelp = await run(["csplit", "--help"]);
  expect(csplitHelp.code).toBe(0);
  expect(csplitHelp.stdout).toContain("Usage: csplit [OPTION]... FILE PATTERN...\n");
  expect(csplitHelp.stdout).toContain("  --quiet\n");
  expect(await run(["csplit", "--prefix", "--help", "--version"])).toMatchObject({ code: 0, stdout: "bnu 9.11\n" });
  expect((await run(["csplit", "--keep=bad", "--help"])).stderr).toContain("option '--keep-files' doesn't allow an argument");
  expect((await run(["csplit", "--bad", "--help"])).stderr).toContain("unrecognized option '--bad'");
  expect(await run(["csplit", "chapters"])).toMatchObject({ code: 1, stderr: "csplit: missing operand after 'chapters'\nTry 'csplit --help' for more information.\n" });
  expect(await run(["csplit", "csplit-missing", "1"])).toMatchObject({ code: 1, stdout: "", stderr: "csplit: cannot open 'csplit-missing' for reading: No such file or directory\n" });
  expect(await run(["csplit", "missing'csplit", "1"])).toMatchObject({ code: 1, stdout: "", stderr: "csplit: cannot open \"missing'csplit\" for reading: No such file or directory\n" });
  expect(await run(["csplit", "missing\ncsplit", "1"])).toMatchObject({ code: 1, stdout: "", stderr: "csplit: cannot open 'missing'$'\\n''csplit' for reading: No such file or directory\n" });
  await symlink("csplit-loop", join(dir, "csplit-loop"));
  expect(await run(["csplit", "csplit-loop", "1"])).toMatchObject({ code: 1, stdout: "", stderr: "csplit: cannot open 'csplit-loop' for reading: Too many levels of symbolic links\n" });
  await symlink("loop'csplit", join(dir, "loop'csplit"));
  expect(await run(["csplit", "loop'csplit", "1"])).toMatchObject({ code: 1, stdout: "", stderr: "csplit: cannot open \"loop'csplit\" for reading: Too many levels of symbolic links\n" });
  await mkdir(join(dir, "csplit-dir"));
  expect(await run(["csplit", "csplit-dir", "1"])).toMatchObject({ code: 1, stdout: "0\n", stderr: "csplit: read error: Is a directory\n" });
  await expect(stat(join(dir, "xx00"))).rejects.toThrow();
  expect(await run(["csplit", "-k", "-f", "kept", "csplit-dir", "1"])).toMatchObject({ code: 1, stdout: "0\n", stderr: "csplit: read error: Is a directory\n" });
  expect(await readFile(join(dir, "kept00"), "utf8")).toBe("");
  await writeFile(join(dir, "chapters"), "one\ntwo\nthree\nfour\n");
  expect(await run(["csplit", "chapters", "bad"])).toMatchObject(await systemRun(["csplit", "chapters", "bad"]));
  expect(await run(["csplit", "-n", "bad", "chapters", "1"])).toMatchObject(await systemRun(["csplit", "-n", "bad", "chapters", "1"]));
  expect(await run(["csplit", "-n", "1\n2", "chapters", "1"])).toMatchObject({ code: 1, stdout: "", stderr: `csplit: invalid number: ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["csplit", "chapters", "/unterminated\nX"])).toMatchObject({ code: 1, stdout: "", stderr: "csplit: /unterminated\nX: closing delimiter '/' missing\n" });
  expect(await run(["csplit", "chapters", "/one/+x"])).toMatchObject({ code: 1, stdout: "", stderr: `csplit: ${diagnosticQuote("/one/+x")}: integer expected after delimiter\n` });
  expect(await run(["csplit", "chapters", "/one/+1\nx"])).toMatchObject({ code: 1, stdout: "", stderr: `csplit: ${diagnosticQuote("/one/+1\\nx")}: integer expected after delimiter\n` });
  expect(await run(["csplit", "chapters", "/[/"])).toMatchObject({ code: 1, stdout: "", stderr: `csplit: ${diagnosticQuote("/[/")}: invalid regular expression: Invalid regular expression\n` });
  const result = await run(["csplit", "-f", "chunk", "chapters", "3"]);
  expect(result.code).toBe(0);
  expect(await readFile(join(dir, "chunk00"), "utf8")).toBe("one\ntwo\n");
  expect(await readFile(join(dir, "chunk01"), "utf8")).toBe("three\nfour\n");

  await writeFile(join(dir, "sections"), "A\nMARK\nB\nCUT\nC\n");
  expect(await run(["csplit", "-s", "-f", "quiet", "-n", "3", "sections", "/MARK/+1"])).toMatchObject({ code: 0, stdout: "" });
  expect(await readFile(join(dir, "quiet000"), "utf8")).toBe("A\nMARK\n");
  expect(await readFile(join(dir, "quiet001"), "utf8")).toBe("B\nCUT\nC\n");
  expect(await run(["csplit", "-s", "sections", "/MISSING/"])).toMatchObject({ code: 1, stdout: "", stderr: `csplit: ${diagnosticQuote("/MISSING/")}: match not found\n` });
  expect(await run(["csplit", "-s", "sections", "/MISSING\nX/"])).toMatchObject({ code: 1, stdout: "", stderr: `csplit: ${diagnosticQuote("/MISSING\\nX/")}: match not found\n` });
  expect(await run(["csplit", "-s", "--suppress-matched", "-f", "drop", "sections", "/MARK/"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "drop00"), "utf8")).toBe("A\n");
  expect(await readFile(join(dir, "drop01"), "utf8")).toBe("B\nCUT\nC\n");
  expect(await run(["csplit", "-s", "-b", "part%02d.txt", "-f", "named", "sections", "%MARK%", "/CUT/"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "namedpart00.txt"), "utf8")).toBe("MARK\nB\n");
  expect(await readFile(join(dir, "namedpart01.txt"), "utf8")).toBe("CUT\nC\n");
  expect(await run(["csplit", "-z", "-f", "stream", "-", "%n%1"], "y\nn\nz\n")).toMatchObject({ code: 0, stdout: "2\n" });
  expect(await readFile(join(dir, "stream00"), "utf8")).toBe("z\n");
  await writeFile(join(dir, "repeat"), "1\n2\n3\n");
  expect(await run(["csplit", "-s", "-f", "rep", "repeat", "/./", "{*}"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "rep00"), "utf8")).toBe("");
  expect(await readFile(join(dir, "rep01"), "utf8")).toBe("1\n");
  expect(await readFile(join(dir, "rep03"), "utf8")).toBe("3\n");
  expect(await run(["csplit", "-s", "--suppress-matched", "-f", "intsup", "repeat", "2", "3"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "intsup00"), "utf8")).toBe("1\n");
  expect(await readFile(join(dir, "intsup01"), "utf8")).toBe("");
  expect(await run(["csplit", "-s", "-z", "-f", "nonempty", "sections", "1"])).toMatchObject({ code: 0 });
  await expect(stat(join(dir, "nonempty00"))).resolves.toBeTruthy();
  await expect(stat(join(dir, "nonempty01"))).rejects.toThrow();
  await mkdir(join(dir, "csplit-out00"));
  expect(await run(["csplit", "-f", "csplit-out", "sections", "1"])).toMatchObject({ code: 1, stderr: "csplit: csplit-out00: Is a directory\n" });
  await symlink("/dev/full", join(dir, "xx01"));
  const full = await run(["csplit", "-", "1"], "1\n2\n");
  expect(full).toMatchObject({ code: 1, stderr: "csplit: xx01: No space left on device\n" });
  await expect(lstat(join(dir, "xx01"))).rejects.toThrow();
  await mkdir(join(dir, "xx01"));
  expect(await run(["csplit", "-", "1"], "1\n2\n")).toMatchObject({ code: 1 });
  expect((await lstat(join(dir, "xx01"))).isDirectory()).toBe(true);
});

test("mkfifo and mknod create fifo special files", async () => {
  expect(await run(["mkfifo"])).toMatchObject({ code: 1, stderr: "mkfifo: missing operand\nTry 'mkfifo --help' for more information.\n" });
  expect(await run(["mkfifo", "-m", "600", "pipe1"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "pipe1"))).isFIFO()).toBe(true);
  expect((await lstat(join(dir, "pipe1"))).mode & 0o777).toBe(0o600);
  expect(await run(["mkfifo", "pipe1"])).toMatchObject({ code: 1, stderr: "mkfifo: cannot create fifo 'pipe1': File exists\n" });
  expect(await run(["mkfifo", "pipe\nnewline"])).toMatchObject({ code: 0 });
  expect(await run(["mkfifo", "pipe\nnewline"])).toMatchObject({ code: 1, stderr: "mkfifo: cannot create fifo 'pipe'$'\\n''newline': File exists\n" });
  expect(await run(["mkfifo", "pipe'quote"])).toMatchObject({ code: 0 });
  expect(await run(["mkfifo", "pipe'quote"])).toMatchObject({ code: 1, stderr: "mkfifo: cannot create fifo \"pipe'quote\": File exists\n" });
  expect(await run(["mkfifo", "missing-parent/pipe"])).toMatchObject({ code: 1, stderr: "mkfifo: cannot create fifo 'missing-parent/pipe': No such file or directory\n" });
  await writeFile(join(dir, "special-parent-file"), "parent");
  expect(await run(["mkfifo", "special-parent-file/pipe"])).toMatchObject({ code: 1, stderr: "mkfifo: cannot create fifo 'special-parent-file/pipe': Not a directory\n" });
  await writeFile(join(dir, "special-parent\nfile"), "parent");
  expect(await run(["mkfifo", "special-parent\nfile/pipe"])).toMatchObject({ code: 1, stderr: "mkfifo: cannot create fifo 'special-parent'$'\\n''file/pipe': Not a directory\n" });
  await writeFile(join(dir, "special-parent'file"), "parent");
  expect(await run(["mkfifo", "special-parent'file/pipe"])).toMatchObject({ code: 1, stderr: "mkfifo: cannot create fifo \"special-parent'file/pipe\": Not a directory\n" });
  await writeFile(join(dir, "fifo-copy"), "regular");
  expect(await run(["cp", "-R", "pipe1", "fifo-copy"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "fifo-copy"))).isFIFO()).toBe(true);
  expect(await run(["cp", "-R", "pipe1", "fifo-copy"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "fifo-copy"))).isFIFO()).toBe(true);
  expect(await run(["mkfifo", "--mode=u=rw,go=", "pipe-symbolic"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "pipe-symbolic"))).mode & 0o777).toBe(0o600);
  expect(await run(["mkfifo", "--m=640", "pipe-mode-prefix"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "pipe-mode-prefix"))).mode & 0o777).toBe(0o640);
  expect(await run(["mkfifo", "--mo", "620", "pipe-mode-next-prefix"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "pipe-mode-next-prefix"))).mode & 0o777).toBe(0o620);
  const mkfifoHelp = (await run(["mkfifo", "--h"])).stdout;
  expect(mkfifoHelp).toContain("Usage: mkfifo [OPTION]... NAME...\n");
  expect(mkfifoHelp).toContain("Mandatory arguments to long options are mandatory for short options too.\n");
  expect(mkfifoHelp).toContain("-m, --mode=MODE   set file permission bits to MODE, not a=rw - umask\n");
  expect(mkfifoHelp).toContain("--context[=CTX]   like -Z, or if CTX is specified then set the\n");
  expect(await run(["mkfifo", "--m"])).toMatchObject({ code: 1, stderr: "mkfifo: option '--mode' requires an argument\nTry 'mkfifo --help' for more information.\n" });
  expect(await run(["mkfifo", "--m", "--h"])).toMatchObject({ code: 1, stderr: "mkfifo: missing operand\nTry 'mkfifo --help' for more information.\n" });
  expect(await run(["mkfifo", "--m", "--h", "pipe-bad-mode-prefix"])).toMatchObject({ code: 1, stderr: "mkfifo: invalid mode\n" });
  expect(await run(["mkfifo", "--mode=bad", "pipe-bad-mode"])).toMatchObject({ code: 1, stderr: "mkfifo: invalid mode\n" });
  expect(await run(["mkfifo", "-Z", "pipe-context"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "pipe-context"))).isFIFO()).toBe(true);
  expect(await run(["mkfifo", "--context=system_u:object_r:tmp_t:s0"])).toMatchObject({
    code: 1,
    stderr: "mkfifo: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\nmkfifo: missing operand\nTry 'mkfifo --help' for more information.\n",
  });
  expect(await run(["mkfifo", "--context=system_u:object_r:tmp_t:s0", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: mkfifo [OPTION]... NAME...\n"), stderr: "mkfifo: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\n" });
  expect(await run(["mkfifo", "--c", "pipe-context-prefix"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "pipe-context-prefix"))).isFIFO()).toBe(true);
  expect(await run(["mkfifo", "--context=system_u:object_r:tmp_t:s0", "pipe-context-2"])).toMatchObject({ code: 0, stderr: "mkfifo: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\n" });
  expect((await lstat(join(dir, "pipe-context-2"))).isFIFO()).toBe(true);
  expect(await run(["mkfifo", "--c=system_u:object_r:tmp_t:s0", "pipe-context-2-prefix"])).toMatchObject({ code: 0, stderr: "mkfifo: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\n" });
  expect((await lstat(join(dir, "pipe-context-2-prefix"))).isFIFO()).toBe(true);
  expect(await run(["mknod"])).toMatchObject({ code: 1, stderr: "mknod: missing operand\nTry 'mknod --help' for more information.\n" });
  expect(await run(["mknod", "node-name"])).toMatchObject({ code: 1, stderr: "mknod: missing operand after 'node-name'\nTry 'mknod --help' for more information.\n" });
  expect(await run(["mknod", "node-name", "b"])).toMatchObject({ code: 1, stderr: "mknod: missing operand after 'b'\nSpecial files require major and minor device numbers.\nTry 'mknod --help' for more information.\n" });
  expect(await run(["mknod", "node-name", "b", "1"])).toMatchObject({ code: 1, stderr: "mknod: missing operand after '1'\nTry 'mknod --help' for more information.\n" });
  expect(await run(["mknod", "node-name", "p", "extra"])).toMatchObject(await systemRun(["mknod", "node-name", "p", "extra"]));
  expect(await run(["mknod", "node-name", "p", "extra\narg"])).toMatchObject({ code: 1, stdout: "", stderr: `mknod: extra operand ${diagnosticQuote("extra\\narg")}\nTry 'mknod --help' for more information.\n` });
  expect(await run(["mknod", "node-name", "x"])).toMatchObject({ code: 1, stderr: "mknod: missing operand after 'x'\nSpecial files require major and minor device numbers.\nTry 'mknod --help' for more information.\n" });
  expect(await run(["mknod", "node-name", "x", "1"])).toMatchObject({ code: 1, stderr: "mknod: missing operand after '1'\nTry 'mknod --help' for more information.\n" });
  expect(await run(["mknod", "node-name", "x", "1", "2"])).toMatchObject(await systemRun(["mknod", "node-name", "x", "1", "2"]));
  expect(await run(["mknod", "node-name", "x\ny", "1", "2"])).toMatchObject({ code: 1, stdout: "", stderr: `mknod: invalid device type ${diagnosticQuote("x\\ny")}\nTry 'mknod --help' for more information.\n` });
  expect(await run(["mknod", "node-name", "x", "1", "2", "3"])).toMatchObject(await systemRun(["mknod", "node-name", "x", "1", "2", "3"]));
  expect(await run(["mknod", "node-name", "x", "1", "2", "extra\narg"])).toMatchObject({ code: 1, stdout: "", stderr: `mknod: extra operand ${diagnosticQuote("extra\\narg")}\nTry 'mknod --help' for more information.\n` });
  expect(await run(["mknod", "node-name", "c", "1x", "3"])).toMatchObject({ code: 1, stdout: "", stderr: `mknod: invalid major device number ${diagnosticQuote("1x")}\n` });
  expect(await run(["mknod", "node-name", "c", "1\n2", "3"])).toMatchObject({ code: 1, stdout: "", stderr: `mknod: invalid major device number ${diagnosticQuote("1\\n2")}\n` });
  expect(await run(["mknod", "node-name", "c", "1", "3x"])).toMatchObject({ code: 1, stdout: "", stderr: `mknod: invalid minor device number ${diagnosticQuote("3x")}\n` });
  expect(await run(["mknod", "node-name", "c", "1", "3\n4"])).toMatchObject({ code: 1, stdout: "", stderr: `mknod: invalid minor device number ${diagnosticQuote("3\\n4")}\n` });
  expect(await run(["mknod", "node-name", "c", "08", "3"])).toMatchObject({ code: 1, stdout: "", stderr: `mknod: invalid major device number ${diagnosticQuote("08")}\n` });
  expect(await run(["mknod", "node-name", "c", "1", "08"])).toMatchObject({ code: 1, stdout: "", stderr: `mknod: invalid minor device number ${diagnosticQuote("08")}\n` });
  expect(await run(["mknod", "node-name", "b", "4294967296", "1"])).toMatchObject({ code: 1, stdout: "", stderr: `mknod: invalid major device number ${diagnosticQuote("4294967296")}\n` });
  expect(await run(["mknod", "-m", "u=rw,go=", "pipe2", "p"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "pipe2"))).isFIFO()).toBe(true);
  expect((await lstat(join(dir, "pipe2"))).mode & 0o777).toBe(0o600);
  expect(await run(["mknod", "--m=640", "pipe2-mode-prefix", "p"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "pipe2-mode-prefix"))).mode & 0o777).toBe(0o640);
  expect(await run(["mknod", "--mo", "620", "pipe2-mode-next-prefix", "p"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "pipe2-mode-next-prefix"))).mode & 0o777).toBe(0o620);
  const mknodHelp = (await run(["mknod", "--h"])).stdout;
  expect(mknodHelp).toContain("Usage: mknod [OPTION]... NAME TYPE [MAJOR MINOR]\n");
  expect(mknodHelp).toContain("-m, --mode=MODE   set file permission bits to MODE, not a=rw - umask\n");
  expect(mknodHelp).toContain("Both MAJOR and MINOR must be specified when TYPE is b, c, or u, and they\n");
  expect(mknodHelp).toContain("  c, u   create a character (unbuffered) special file\n");
  expect(await run(["mknod", "--m"])).toMatchObject({ code: 1, stderr: "mknod: option '--mode' requires an argument\nTry 'mknod --help' for more information.\n" });
  expect(await run(["mknod", "--m", "--h"])).toMatchObject({ code: 1, stderr: "mknod: invalid mode\n" });
  expect(await run(["mknod", "--mode=bad", "pipe2-bad-mode", "p"])).toMatchObject({ code: 1, stderr: "mknod: invalid mode\n" });
  expect(await run(["mknod", "pipe2", "p"])).toMatchObject({ code: 1, stderr: "mknod: pipe2: File exists\n" });
  expect(await run(["mkfifo", "pipe2\nnewline"])).toMatchObject({ code: 0 });
  expect(await run(["mknod", "pipe2\nnewline", "p"])).toMatchObject({ code: 1, stderr: "mknod: 'pipe2'$'\\n''newline': File exists\n" });
  expect(await run(["mkfifo", "pipe2'quote"])).toMatchObject({ code: 0 });
  expect(await run(["mknod", "pipe2'quote", "p"])).toMatchObject({ code: 1, stderr: "mknod: \"pipe2'quote\": File exists\n" });
  expect(await run(["mknod", "missing-parent/pipe", "p"])).toMatchObject({ code: 1, stderr: "mknod: missing-parent/pipe: No such file or directory\n" });
  expect(await run(["mknod", "special-parent-file/pipe", "p"])).toMatchObject({ code: 1, stderr: "mknod: special-parent-file/pipe: Not a directory\n" });
  expect(await run(["mknod", "special-parent-file/node", "c", "1", "3"])).toMatchObject({ code: 1, stderr: "mknod: special-parent-file/node: Not a directory\n" });
  expect(await run(["mknod", "special-parent\nfile/pipe", "p"])).toMatchObject({ code: 1, stderr: "mknod: 'special-parent'$'\\n''file/pipe': Not a directory\n" });
  expect(await run(["mknod", "special-parent'file/pipe", "p"])).toMatchObject({ code: 1, stderr: "mknod: \"special-parent'file/pipe\": Not a directory\n" });
  const unbufferedNode = await run(["mknod", "unbuffered-node", "u", "0x1", "03"]);
  if (unbufferedNode.code !== 0) expect(unbufferedNode).toMatchObject(await systemRun(["/usr/bin/mknod", "unbuffered-node", "u", "0x1", "03"]));
  const charNode = await run(["mknod", "char-node", "c", "1", "3"]);
  if (charNode.code !== 0) expect(charNode).toMatchObject(await systemRun(["/usr/bin/mknod", "char-node", "c", "1", "3"]));
  expect(await run(["mknod", "-Z", "pipe-context-3", "p"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "pipe-context-3"))).isFIFO()).toBe(true);
  expect(await run(["mknod", "--c", "pipe-context-3-prefix", "p"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "pipe-context-3-prefix"))).isFIFO()).toBe(true);
  expect(await run(["mknod", "--context=system_u:object_r:tmp_t:s0", "pipe-context-4", "p"])).toMatchObject({ code: 0, stderr: "mknod: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\n" });
  expect((await lstat(join(dir, "pipe-context-4"))).isFIFO()).toBe(true);
  expect(await run(["mknod", "--context=system_u:object_r:tmp_t:s0", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: mknod [OPTION]... NAME TYPE [MAJOR MINOR]\n"), stderr: "mknod: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\n" });
  expect(await run(["mknod", "--c=system_u:object_r:tmp_t:s0", "pipe-context-4-prefix", "p"])).toMatchObject({ code: 0, stderr: "mknod: warning: ignoring --context; it requires an SELinux/SMACK-enabled kernel\n" });
  expect((await lstat(join(dir, "pipe-context-4-prefix"))).isFIFO()).toBe(true);
  const strictFifo = Bun.spawn(["/bin/sh", "-c", `umask 777; ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} mkfifo -m 734 pipe3 && ${process.execPath} ${join(import.meta.dir, "../bin/bnu.js")} mknod --mode=ug+rw,o+r pipe4 p`], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  expect(await strictFifo.exited).toBe(0);
  expect((await lstat(join(dir, "pipe3"))).mode & 0o777).toBe(0o734);
  expect((await lstat(join(dir, "pipe4"))).mode & 0o777).toBe(0o666);
});

test("recursive cp, directory targets, symbolic chmod and signed head/tail counts", async () => {
  await mkdir(join(dir, "src/sub"), { recursive: true });
  await writeFile(join(dir, "src/file"), "one\ntwo\nthree\n");
  await writeFile(join(dir, "src/sub/nested"), "nested");
  expect(await run(["cp", "-r", "src", "dst"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "dst/sub/nested"), "utf8")).toBe("nested");
  await mkdir(join(dir, "onefs-src"));
  await writeFile(join(dir, "onefs-src/local"), "local");
  await symlink("/dev/shm", join(dir, "onefs-src/other-fs"));
  expect(await run(["cp", "-RLx", "onefs-src", "onefs-dst"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "onefs-dst/local"), "utf8")).toBe("local");
  expect((await lstat(join(dir, "onefs-dst/other-fs"))).isDirectory()).toBe(true);
  expect(await readdir(join(dir, "onefs-dst/other-fs"))).toEqual([]);
  await mkdir(join(dir, "keep-link-src/d/e"), { recursive: true });
  await mkdir(join(dir, "keep-link-dst/b"), { recursive: true });
  await symlink("b", join(dir, "keep-link-dst/d"));
  expect(await run(["cp", "-RT", "--copy-contents", "keep-link-src", "keep-link-dst"])).toMatchObject({
    code: 1,
    stderr: "cp: cannot overwrite non-directory 'keep-link-dst/d' with directory 'keep-link-src/d'\n",
  });
  expect(await run(["cp", "-RT", "--copy-contents", "--keep-directory-symlink", "keep-link-src", "keep-link-dst"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "keep-link-dst/d"))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(dir, "keep-link-dst/b/e"))).isDirectory()).toBe(true);
  await mkdir(join(dir, "dir-time-src/sub"), { recursive: true });
  await writeFile(join(dir, "dir-time-src/sub/file"), "dir time");
  expect(await systemRun(["/usr/bin/touch", "-a", "-d", "2026-01-01 01:02:03.111111111 +0000", "dir-time-src/sub"])).toMatchObject({ code: 0 });
  expect(await systemRun(["/usr/bin/touch", "-m", "-d", "2026-01-02 03:04:05.222222222 +0000", "dir-time-src/sub"])).toMatchObject({ code: 0 });
  expect(await run(["cp", "-a", "dir-time-src", "dir-time-dst"])).toMatchObject({ code: 0 });
  expect(await systemRun(["/usr/bin/stat", "-c", "%x|%y", "dir-time-dst/sub"], "", { env: { TZ: "UTC0" } })).toMatchObject({
    code: 0,
    stdout: "2026-01-01 01:02:03.111111111 +0000|2026-01-02 03:04:05.222222222 +0000\n",
  });
  await mkdir(join(dir, "target"));
  expect(await run(["cp", "src/file", "target"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "target/file"), "utf8")).toBe("one\ntwo\nthree\n");
  expect(await run(["cp", "-l", "src/file", "target/hard-file"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "target/hard-file"))).ino).toBe((await stat(join(dir, "src/file"))).ino);
  expect(await run(["ln", "-s", "file", "src/link-file"])).toMatchObject({ code: 0 });
  expect(await run(["cp", "--link", "src/link-file", "target/hard-from-link"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "target/hard-from-link"))).ino).toBe((await stat(join(dir, "src/file"))).ino);
  expect(await run(["cp", "--link", "-P", "src/link-file", "target/hard-link-entry"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "target/hard-link-entry"))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(dir, "target/hard-link-entry"))).ino).toBe((await lstat(join(dir, "src/link-file"))).ino);
  await link(join(dir, "src/file"), join(dir, "src/file-hard"));
  expect(await run(["cp", "-d", "src/file", "src/file-hard", "target"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "target/file"))).ino).toBe((await stat(join(dir, "target/file-hard"))).ino);
  await mkdir(join(dir, "target/no-preserve-links"));
  expect(await run(["cp", "-d", "--no-preserve=links", "src/file", "src/file-hard", "target/no-preserve-links"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "target/no-preserve-links/file"))).ino).not.toBe((await stat(join(dir, "target/no-preserve-links/file-hard"))).ino);
  await mkdir(join(dir, "target/update-dir/src"), { recursive: true });
  await link(join(dir, "src/file"), join(dir, "src/update-link"));
  await writeFile(join(dir, "target/update-dir/src/file"), "old");
  await link(join(dir, "target/update-dir/src/file"), join(dir, "target/update-dir/src/update-link"));
  await writeFile(join(dir, "target/update-dir/src/older"), "old");
  await run(["touch", "-d", "-1 hour", "target/update-dir/src/older"]);
  await link(join(dir, "src/file"), join(dir, "src/older"));
  await writeFile(join(dir, "target/update-dir/src/newer"), "new");
  await run(["touch", "-d", "+1 hour", "target/update-dir/src/newer"]);
  await link(join(dir, "src/file"), join(dir, "src/newer"));
  expect(await run(["cp", "-au", "src", "target/update-dir"])).toMatchObject({ code: 0 });
  const preservedIno = (await stat(join(dir, "target/update-dir/src/file"))).ino;
  expect((await stat(join(dir, "target/update-dir/src/update-link"))).ino).toBe(preservedIno);
  expect((await stat(join(dir, "target/update-dir/src/older"))).ino).toBe(preservedIno);
  expect((await stat(join(dir, "target/update-dir/src/newer"))).ino).toBe(preservedIno);
  expect(await run(["ln", "-s", "sub", "src/sub-link"])).toMatchObject({ code: 0 });
  expect(await run(["cp", "--link", "-R", "src/sub-link", "target/sub-hard-copy"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "target/sub-hard-copy/nested"))).ino).toBe((await stat(join(dir, "src/sub/nested"))).ino);
  expect(await run(["ln", "-s", "missing", "src/dangling"])).toMatchObject({ code: 0 });
  expect(await run(["cp", "-r", "src/dangling", "target/dangling-r"])).toMatchObject({ code: 0, stderr: "" });
  expect((await lstat(join(dir, "target/dangling-r"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(dir, "target/dangling-r"), "utf8").catch((error) => error.code)).toBe("ENOENT");
  expect(await run(["cp", "-R", "src/dangling", "target/dangling-R"])).toMatchObject({ code: 0, stderr: "" });
  expect((await lstat(join(dir, "target/dangling-R"))).isSymbolicLink()).toBe(true);
  expect(await run(["cp", "--link", "src/dangling", "target/dangling-hard"])).toMatchObject({ code: 1, stderr: "cp: cannot stat 'src/dangling': No such file or directory\n" });
  await mkdir(join(dir, "parents-dest"));
  expect(await run(["cp", "--parents", "src/sub/nested", "parents-dest"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "parents-dest/src/sub/nested"), "utf8")).toBe("nested");
  expect(await run(["cp", "-R", "src", "src"])).toMatchObject({ code: 1, stderr: "cp: cannot copy a directory, 'src', into itself, 'src/src'\n" });
  expect(await run(["cp", "-d", "src/link-file", "target/link-copy"])).toMatchObject({ code: 0 });
  expect(await readFile(join(dir, "target/link-copy"), "utf8")).toBe("one\ntwo\nthree\n");
  expect((await lstat(join(dir, "target/link-copy"))).isSymbolicLink()).toBe(true);
  expect(await run(["ln", "-s", "file", "target/update-link"])).toMatchObject({ code: 0 });
  expect(await run(["cp", "--update", "--no-dereference", "src/link-file", "target/update-link"])).toMatchObject({ code: 0 });
  expect(await run(["ln", "-s", "file", "target/remove-dest"])).toMatchObject({ code: 0 });
  expect(await run(["cp", "--remove-destination", "src/file", "target/remove-dest"])).toMatchObject({ code: 0 });
  expect((await lstat(join(dir, "target/remove-dest"))).isSymbolicLink()).toBe(false);
  expect(await run(["chmod", "u+x,g-w,o=", "target/file"])).toMatchObject({ code: 0 });
  const mode = (await stat(join(dir, "target/file"))).mode & 0o777;
  expect(mode & 0o100).toBe(0o100);
  expect(mode & 0o020).toBe(0);
  expect(mode & 0o007).toBe(0);
  await writeFile(join(dir, "chmod-verbose"), "mode");
  await run(["chmod", "600", "chmod-verbose"]);
  expect(await run(["chmod", "-v", "600", "chmod-verbose"])).toMatchObject({
    code: 0,
    stdout: "mode of 'chmod-verbose' retained as 0600 (rw-------)\n",
  });
  expect(await run(["chmod", "-v", "644", "chmod-verbose"])).toMatchObject({
    code: 0,
    stdout: "mode of 'chmod-verbose' changed from 0600 (rw-------) to 0644 (rw-r--r--)\n",
  });
  expect(await run(["chmod", "-c", "600", "chmod-verbose"])).toMatchObject({
    code: 0,
    stdout: "mode of 'chmod-verbose' changed from 0644 (rw-r--r--) to 0600 (rw-------)\n",
  });
  expect(await run(["chmod", "-c", "600", "chmod-verbose"])).toMatchObject({ code: 0, stdout: "" });
  await writeFile(join(dir, "chmod-reference"), "ref");
  await writeFile(join(dir, "chmod-reference-target"), "target");
  await run(["chmod", "640", "chmod-reference"]);
  expect(await run(["chmod", "--reference=chmod-reference", "chmod-reference-target"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "chmod-reference-target"))).mode & 0o777).toBe(0o640);
  await run(["chmod", "600", "chmod-reference-target"]);
  expect(await run(["chmod", "--ref=chmod-reference", "chmod-reference-target"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "chmod-reference-target"))).mode & 0o777).toBe(0o640);
  const chmodInlineReferenceHelp = await run(["chmod", "--ref=missing-ref", "--help"]);
  expect(chmodInlineReferenceHelp).toMatchObject({ code: 0 });
  expect(chmodInlineReferenceHelp.stdout).toContain("Usage: chmod [OPTION]... MODE[,MODE]... FILE...\n  or:  chmod [OPTION]... OCTAL-MODE FILE...\n  or:  chmod [OPTION]... --reference=RFILE FILE...\n");
  expect(await run(["chmod", "640", "--help"])).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: chmod [OPTION]... MODE[,MODE]... FILE...\n"), stderr: "" });
  expect(await run(["chmod", "--r", "--help"])).toMatchObject({
    code: 1,
    stderr: "chmod: option '--r' is ambiguous; possibilities: '--recursive' '--reference'\nTry 'chmod --help' for more information.\n",
  });
  expect(await run(["chmod", "--changes=bad", "--help"])).toMatchObject({
    code: 1,
    stderr: "chmod: option '--changes' doesn't allow an argument\nTry 'chmod --help' for more information.\n",
  });
  expect(await run(["chmod", "--bad", "--help"])).toMatchObject({
    code: 1,
    stderr: "chmod: unrecognized option '--bad'\nTry 'chmod --help' for more information.\n",
  });
  expect(await run(["chmod", "-Rbad", "--help"])).toMatchObject({
    code: 1,
    stderr: "chmod: invalid option -- 'b'\nTry 'chmod --help' for more information.\n",
  });
  expect(await run(["chmod", "--preserve=bad", "--help"])).toMatchObject({
    code: 1,
    stderr: "chmod: option '--preserve-root' doesn't allow an argument\nTry 'chmod --help' for more information.\n",
  });
  expect(await run(["chmod", "--reference", "--help", "--version"])).toMatchObject({
    code: 0,
    stdout: "bnu 9.11\n",
  });
  expect(await run(["chmod", "--reference=missing-ref", "chmod-reference-target"])).toMatchObject({
    code: 1,
    stderr: "chmod: failed to get attributes of 'missing-ref': No such file or directory\n",
  });
  expect(await run(["chmod", "--reference=missing\nref", "chmod-reference-target"])).toMatchObject({
    code: 1,
    stderr: "chmod: failed to get attributes of 'missing'$'\\n''ref': No such file or directory\n",
  });
  expect(await run(["chmod", "--reference", "chmod-reference"])).toMatchObject({
    code: 1,
    stderr: "chmod: missing operand\nTry 'chmod --help' for more information.\n",
  });
  expect(await run(["chmod", "640", "missing-mode"])).toMatchObject({
    code: 1,
    stderr: "chmod: cannot access 'missing-mode': No such file or directory\n",
  });
  expect(await run(["chmod", "640", "missing\nmode"])).toMatchObject({
    code: 1,
    stderr: "chmod: cannot access 'missing'$'\\n''mode': No such file or directory\n",
  });
  expect(await run(["chmod", "640", "missing'mode"])).toMatchObject({
    code: 1,
    stderr: "chmod: cannot access \"missing'mode\": No such file or directory\n",
  });
  expect(await run(["chmod", "bad", "chmod-reference-target"])).toMatchObject({
    code: 1,
    stderr: `chmod: invalid mode: ${diagnosticQuote("bad")}\nTry 'chmod --help' for more information.\n`,
  });
  expect(await run(["chmod", "a+z", "chmod-reference-target"])).toMatchObject({
    code: 1,
    stderr: `chmod: invalid mode: ${diagnosticQuote("a+z")}\nTry 'chmod --help' for more information.\n`,
  });
  expect(await run(["chmod", "bad\nmode", "chmod-reference-target"])).toMatchObject({
    code: 1,
    stderr: `chmod: invalid mode: ${diagnosticQuote("bad\\nmode")}\nTry 'chmod --help' for more information.\n`,
  });
  expect(await run(["chmod", "888", "chmod-reference-target"])).toMatchObject({
    code: 1,
    stderr: `chmod: invalid mode: ${diagnosticQuote("888")}\nTry 'chmod --help' for more information.\n`,
  });
  expect(await run(["chmod", "bad"])).toMatchObject({
    code: 1,
    stderr: "chmod: missing operand after 'bad'\nTry 'chmod --help' for more information.\n",
  });
  await mkdir(join(dir, "chmod-setgid-dir"));
  expect(await run(["chmod", "g+s", "chmod-setgid-dir"])).toMatchObject({ code: 0 });
  expect(await run(["chmod", "755", "chmod-setgid-dir"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "chmod-setgid-dir"))).mode & 0o7777).toBe(0o2755);
  expect(await run(["chmod", "=7777,-5022", "chmod-setgid-dir"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "chmod-setgid-dir"))).mode & 0o7777).toBe(0o2755);
  expect(await run(["chmod", "-R", "a+rX", "dst"])).toMatchObject({ code: 0 });
  expect((await stat(join(dir, "dst"))).mode & 0o111).toBeGreaterThan(0);
  await writeFile(join(dir, "chmod\nverbose"), "x");
  expect(await run(["chmod", "-v", "600", "chmod\nverbose"])).toMatchObject({
    code: 0,
    stdout: "mode of 'chmod'$'\\n''verbose' changed from 0644 (rw-r--r--) to 0600 (rw-------)\n",
  });
  await writeFile(join(dir, "chmod'verbose"), "x");
  expect(await run(["chmod", "-v", "600", "chmod'verbose"])).toMatchObject({
    code: 0,
    stdout: "mode of \"chmod'verbose\" changed from 0644 (rw-r--r--) to 0600 (rw-------)\n",
  });
  await symlink("missing-chmod-target", join(dir, "chmod\nlink"));
  expect(await run(["chmod", "600", "chmod\nlink"])).toMatchObject({
    code: 1,
    stderr: "chmod: cannot operate on dangling symlink 'chmod'$'\\n''link'\n",
  });
  await symlink("missing-chmod-target", join(dir, "chmod'link"));
  expect(await run(["chmod", "600", "chmod'link"])).toMatchObject({
    code: 1,
    stderr: "chmod: cannot operate on dangling symlink \"chmod'link\"\n",
  });
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    const chmodRoot = await run(["chmod", "+", "/"]);
    expect(chmodRoot.code).toBe(1);
    expect(chmodRoot.stderr).toMatch(/^chmod: changing permissions of '\/': (Operation not permitted|Read-only file system)\n$/);
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0 && typeof process.getgid === "function") {
    await mkdir(join(dir, "chgrp-no-x/y"), { recursive: true });
    try {
      await chmod(join(dir, "chgrp-no-x"), 0o600);
      expect(await run(["chgrp", "-R", String(process.getgid()), "chgrp-no-x"])).toMatchObject({
        code: 1,
        stderr: "chgrp: cannot access 'chgrp-no-x/y': Permission denied\n",
      });
    } finally {
      await chmod(join(dir, "chgrp-no-x"), 0o700);
    }
  }
  expect((await stat(join(dir, "dst/sub/nested"))).mode & 0o444).toBe(0o444);
  expect(await run(["head", "-n", "-1", "src/file"])).toMatchObject({ code: 0, stdout: "one\ntwo\n" });
  expect(await run(["tail", "-n", "+2", "src/file"])).toMatchObject({ code: 0, stdout: "two\nthree\n" });
});

test("cp and mv preserve user xattrs only when requested", async () => {
  const result = await shell(`
    set -eu
    command -v getfattr >/dev/null 2>&1 || exit 0
    command -v setfattr >/dev/null 2>&1 || exit 0
    touch src
    setfattr -n user.foo -v bar src
    "$BUN" "$BNU" cp src plain
    if getfattr -d plain 2>/dev/null | grep -F 'user.foo="bar"'; then
      echo plain-preserved
      exit 1
    fi
    "$BUN" "$BNU" cp --preserve=xattr src preserved
    getfattr -d preserved 2>/dev/null | grep -F 'user.foo="bar"' >/dev/null
    chmod a-w src
    "$BUN" "$BNU" cp --preserve=xattr src readonly-copy
    getfattr -d readonly-copy 2>/dev/null | grep -F 'user.foo="bar"' >/dev/null
    test "$(stat -c %a src)" = "$(stat -c %a readonly-copy)"
    chmod u+w src
    "$BUN" "$BNU" ginstall src installed
    if getfattr -d installed 2>/dev/null | grep -F 'user.foo="bar"'; then
      echo install-preserved
      exit 1
    fi
    "$BUN" "$BNU" mv src moved
    getfattr -d moved 2>/dev/null | grep -F 'user.foo="bar"' >/dev/null
    mkdir fake-xattr-bin
    printf '%s\n' '#!/bin/sh' 'last=' 'for last do :; done' 'echo "setfattr: $last: Operation not supported" >&2' 'exit 1' > fake-xattr-bin/setfattr
    chmod +x fake-xattr-bin/setfattr
    PATH="$PWD/fake-xattr-bin:$PATH" "$BUN" "$BNU" cp --preserve=all moved xattr-best-effort 2>best-effort.err
    test ! -s best-effort.err
    if PATH="$PWD/fake-xattr-bin:$PATH" "$BUN" "$BNU" cp --preserve=xattr moved xattr-required 2>required.err; then
      echo explicit-xattr-succeeded
      exit 1
    fi
    printf '%s\n' "cp: setting attributes for 'xattr-required': Operation not supported" >required.exp
    cmp required.exp required.err
  `);
  expect(result).toMatchObject({ code: 0, stdout: "" });
});

test("ls marks extended POSIX ACLs and cp -p preserves them when ACL tools are available", async () => {
  const result = await shell(`
    set -eu
    command -v getfacl >/dev/null 2>&1 || exit 0
    command -v setfacl >/dev/null 2>&1 || exit 0
    touch source
    # Some CI tmpfs mounts expose the ACL tools but deliberately reject ACLs.
    setfacl -m u:65534:r-- source 2>/dev/null || exit 0
    "$BUN" "$BNU" ls -log source | grep '^-[r-][w-][x-][r-][w-][x-][r-][w-][x-]+ ' >/dev/null
    "$BUN" "$BNU" cp -p source copied
    getfacl --omit-header copied | grep '^user:nobody:r--$' >/dev/null
    mkdir source-dir
    setfacl -d -m u:65534:r-- source-dir
    "$BUN" "$BNU" cp -pR source-dir copied-dir
    getfacl --omit-header copied-dir | grep '^default:user:nobody:r--$' >/dev/null
  `);
  expect(result).toMatchObject({ code: 0, stdout: "" });
});

test("ls, stat, and chcon use SELinux contexts when the xattr tools provide one", async () => {
  const getfattr = join(dir, "getfattr");
  const setfattr = join(dir, "setfattr");
  const getenforce = join(dir, "getenforce");
  const restorecon = join(dir, "restorecon");
  const contextLog = join(dir, "context.log");
  const restoreLog = join(dir, "restore.log");
  await writeFile(getfattr, "#!/bin/sh\nlast=\nfor last do :; done\ncase $last in\n  *beta) printf 'system_u:object_r:var_t:s0\\0' ;;\n  *) printf 'system_u:object_r:tmp_t:s0\\0' ;;\nesac\n");
  await writeFile(setfattr, "#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = -v ]; then shift; printf '%s' \"$1\" >\"$BNU_SELINUX_LOG\"; exit 0; fi\n  shift\ndone\nexit 1\n");
  await writeFile(getenforce, "#!/bin/sh\nprintf '%s\\n' Permissive\n");
  await writeFile(restorecon, "#!/bin/sh\nlast=\nfor last do :; done\nprintf '%s' \"$last\" >\"$BNU_RESTORECON_LOG\"\n");
  await chmod(getfattr, 0o755);
  await chmod(setfattr, 0o755);
  await chmod(getenforce, 0o755);
  await chmod(restorecon, 0o755);
  await writeFile(join(dir, "alpha"), "");
  await writeFile(join(dir, "beta"), "");
  await symlink("alpha", join(dir, "alpha-link"));
  const env = { PATH: `${dir}:${process.env.PATH}`, BNU_SELINUX_LOG: contextLog, BNU_RESTORECON_LOG: restoreLog };
  expect(await run(["ls", "-Z", "alpha"], "", { env })).toMatchObject({ code: 0, stdout: "system_u:object_r:tmp_t:s0 alpha\n" });
  expect(await run(["ls", "-l", "alpha"], "", { env })).toMatchObject({ code: 0, stdout: expect.stringMatching(/^-rw-r--r--\./) });
  expect(await run(["ls", "-l", "alpha-link"], "", { env })).toMatchObject({ code: 0, stdout: expect.stringMatching(/^lrwxrwxrwx\./) });
  expect(await run(["ls", "-lnZ", "alpha-link"], "", { env })).toMatchObject({
    code: 0,
    stdout: expect.stringContaining(" system_u:object_r:tmp_t:s0 "),
  });
  expect(await run(["stat", "--printf=%C", "alpha"], "", { env })).toMatchObject({ code: 0, stdout: "system_u:object_r:tmp_t:s0" });
  expect(await run(["chcon", "--user=user_u", "alpha"], "", { env })).toMatchObject({ code: 0 });
  expect(await readFile(contextLog, "utf8")).toBe("user_u:object_r:tmp_t:s0");
  expect(await run(["chcon", "system_u:object_r:var_t:s0", "alpha"], "", { env })).toMatchObject({ code: 0 });
  expect(await readFile(contextLog, "utf8")).toBe("system_u:object_r:var_t:s0");
  expect(await run(["chcon", "--reference=alpha", "beta"], "", { env })).toMatchObject({ code: 0 });
  expect(await readFile(contextLog, "utf8")).toBe("system_u:object_r:tmp_t:s0");
  expect(await run(["cp", "--preserve=context", "alpha", "preserved-context"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(contextLog, "utf8")).toBe("system_u:object_r:tmp_t:s0");
  expect(await run(["cp", "--context=system_u:object_r:var_t:s0", "alpha", "explicit-context"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(contextLog, "utf8")).toBe("system_u:object_r:var_t:s0");
  expect(await run(["cp", "-Z", "alpha", "restored-context"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(contextLog, "utf8")).toBe("system_u:object_r:tmp_t:s0");
  expect(await readFile(restoreLog, "utf8")).toBe("restored-context");
  await writeFile(join(dir, "move-source"), "");
  expect(await run(["mv", "-Z", "move-source", "move-restored"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(restoreLog, "utf8")).toBe("move-restored");
  await mkdir(join(dir, "move-tree"));
  await writeFile(join(dir, "move-tree", "child"), "");
  expect(await run(["mv", "--context", "move-tree", "move-tree-restored"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(restoreLog, "utf8")).toBe("move-tree-restored");
  expect(await run(["mkdir", "--context=system_u:object_r:var_t:s0", "context-directory"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(contextLog, "utf8")).toBe("system_u:object_r:var_t:s0");
  expect(await run(["mkdir", "-Zp", "restored-parent/child"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(restoreLog, "utf8")).toBe("restored-parent/child");
  expect(await run(["mkfifo", "--context=system_u:object_r:tmp_t:s0", "context-fifo"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(contextLog, "utf8")).toBe("system_u:object_r:tmp_t:s0");
  expect(await run(["mknod", "-Z", "restored-fifo", "p"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(restoreLog, "utf8")).toBe("restored-fifo");
  expect(await run(["install", "--preserve-context", "alpha", "installed-preserved"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(contextLog, "utf8")).toBe("system_u:object_r:tmp_t:s0");
  expect(await run(["install", "--context=system_u:object_r:var_t:s0", "alpha", "installed-explicit"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(contextLog, "utf8")).toBe("system_u:object_r:var_t:s0");
  expect(await run(["install", "-Z", "alpha", "installed-restored"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(restoreLog, "utf8")).toBe("installed-restored");
  expect(await run(["install", "-ZD", "alpha", "installed-parent/child/file"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(restoreLog, "utf8")).toBe("installed-parent/child/file");
  expect(await run(["install", "-Zd", "installed-directory/child"], "", { env })).toMatchObject({ code: 0, stderr: "" });
  expect(await readFile(restoreLog, "utf8")).toBe("installed-directory/child");
}, 30000);

test("id reports the current SELinux process context", async () => {
  const getenforce = join(dir, "getenforce");
  const ps = join(dir, "ps");
  const context = "system_u:system_r:local_login_t:s0";
  await writeFile(getenforce, "#!/bin/sh\nprintf '%s\\n' Permissive\n");
  await writeFile(ps, `#!/bin/sh\nprintf '%s\\n' '${context}'\n`);
  await chmod(getenforce, 0o755);
  await chmod(ps, 0o755);
  const env = { PATH: `${dir}:${process.env.PATH}` };
  expect(await run(["id", "-Z"], "", { env })).toMatchObject({ code: 0, stdout: `${context}\n`, stderr: "" });
  expect(await run(["runcon"], "", { env })).toMatchObject({ code: 0, stdout: `${context}\n`, stderr: "" });
  expect(await run(["id", "--context", "--zero"], "", { env })).toMatchObject({ code: 0, stdout: `${context}\0`, stderr: "" });
  expect(await run(["id", "-Zn"], "", { env })).toMatchObject({ code: 0, stdout: `${context}\n`, stderr: "" });
  expect(await run(["id"], "", { env })).toMatchObject({ code: 0, stdout: expect.stringContaining(` context=${context}\n`) });
  expect((await run(["id"], "", { env: { ...env, POSIXLY_CORRECT: "1" } })).stdout).not.toContain(" context=");
  expect(await run(["id", "-Z", "some-user"], "", { env })).toMatchObject({ code: 1, stderr: "id: cannot print security context when user specified\n" });
  expect((await run(["id", "-Zu"], "", { env })).stderr).toContain('cannot print "only" of more than one choice');
  expect(await run(["id", "-Z", "--version"], "", { env })).toMatchObject({ code: 0, stdout: "bnu 9.11\n", stderr: "" });
  expect(await run(["id", "--context", "--help"], "", { env })).toMatchObject({ code: 0, stdout: expect.stringContaining("Usage: id") });
});

test("stdin filters emit a complete record before EOF", async () => {
  const result = await shell(`
    set -eu
    for spec in 'cut -b1' 'cut -c1' 'cut -f1' 'date -f -' 'expand' 'fold' 'nl' 'numfmt' 'paste' 'pr' 'tail -n+1' 'tail -c+1' 'tr 1 1' 'unexpand' 'uniq'; do
      rm -f in hold out err status
      mkfifo in hold
      (eval "\\"$BUN\\" \\"$BNU\\" $spec <in >out 2>err"; echo $? >status) &
      cpid=$!
      (printf '1\\n'; cat hold >/dev/null) >in &
      wpid=$!
      i=0
      while [ ! -s out ] && [ "$i" -lt 60 ]; do
        sleep 0.05
        i=$((i + 1))
      done
      if [ ! -s out ]; then
        echo "not responsive: $spec"
        cat err
        : >hold || true
        kill "$cpid" "$wpid" 2>/dev/null || true
        wait "$cpid" 2>/dev/null || true
        wait "$wpid" 2>/dev/null || true
        exit 1
      fi
      : >hold
      wait "$wpid"
      wait "$cpid"
    done
  `);
  expect(result).toMatchObject({ code: 0, stdout: "" });
});
