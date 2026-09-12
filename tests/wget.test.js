import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir, server, other, requests, retryCount;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bnu-wget-")); requests = []; retryCount = 0;
  other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { requests.push({ foreign: true, headers: Object.fromEntries(request.headers) }); return new Response("foreign\n"); } });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const entry = { path: url.pathname, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() }; requests.push(entry);
    if (url.pathname === "/redirect") return Response.redirect(`${server.url}file`, 302);
    if (url.pathname === "/foreign") return Response.redirect(`${other.url}file`, 302);
    if (url.pathname === "/loop") return Response.redirect(`${server.url}loop`, 302);
    if (url.pathname === "/fail") return new Response("not found\n", { status: 404 });
    if (url.pathname === "/auth") return new Response("auth required\n", { status: 401 });
    if (url.pathname === "/retry" && retryCount++ < 1) return new Response("retry\n", { status: 503 });
    if (url.pathname === "/echo") return Response.json(entry);
    if (url.pathname === "/disposition") return new Response("named\n", { headers: { "content-disposition": "attachment; filename=../../outside.txt" } });
    if (url.pathname === "/invalid-range") return new Response("bad", { status: 206, headers: { "content-range": "bytes 4-2/9" } });
    if (url.pathname === "/slow") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("begin")); setTimeout(() => { try { controller.enqueue(new TextEncoder().encode("end")); controller.close(); } catch {} }, 700); } }));
    if (url.pathname === "/range" || url.pathname === "/named-range") {
      const data = "complete download\n", range = request.headers.get("range"), start = range ? Number(range.match(/bytes=(\d+)-/)?.[1]) : 0;
      if (start >= data.length) return new Response(null, { status: 416, headers: { "content-range": `bytes */${data.length}` } });
      return new Response(data.slice(start), { status: range ? 206 : 200, headers: { ...(range ? { "content-range": `bytes ${start}-${data.length - 1}/${data.length}` } : {}), ...(url.pathname==="/named-range" ? { "content-disposition": "attachment; filename=resumed.bin" } : {}) } });
    }
    if (url.pathname === "/timestamp" && request.headers.has("if-modified-since")) return new Response(null, { status: 304 });
    return new Response("downloaded\n", { headers: { "last-modified": "Wed, 01 Jan 2020 00:00:00 GMT", "x-test": "yes" } });
  } });
});
afterEach(async () => { server?.stop(true); other?.stop(true); await rm(dir, { recursive: true, force: true }); });
async function run(args, input = "") {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/commands/wget.js"), "--no-proxy", "--waitretry=0", "-t2", ...args], { cwd: dir, env: { ...process.env, GNULY_CORRECT: "1" }, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}
const url = (path) => new URL(path, server.url).href;

test("wget streams to stdout and files, keeps existing downloads and honors -P/-O", async () => {
  expect(await run(["-qO-", url("file")])).toEqual({ code: 0, stdout: "downloaded\n", stderr: "" });
  expect((await run([url("file")])).code).toBe(0);
  expect((await run([url("file")])).code).toBe(0);
  expect(await readFile(join(dir, "file"), "utf8")).toBe("downloaded\n");
  expect(await readFile(join(dir, "file.1"), "utf8")).toBe("downloaded\n");
  expect((await run(["-P", "nested", url("file")])).code).toBe(0);
  expect(await readFile(join(dir, "nested", "file"), "utf8")).toBe("downloaded\n");
  expect((await run(["-O", "combined", url("file"), url("file")])).code).toBe(0);
  expect(await readFile(join(dir, "combined"), "utf8")).toBe("downloaded\ndownloaded\n");
});

test("wget follows redirects, limits loops, strips credentials across origins", async () => {
  expect((await run(["-qO-", url("redirect")])).stdout).toBe("downloaded\n");
  expect((await run(["-qO-", "--header=Cookie: secret", "--http-user=user", "--http-password=pass", url("foreign")])).stdout).toBe("foreign\n");
  const origin = requests.find((r) => r.path === "/foreign"), foreign = requests.find((r) => r.foreign);
  expect(origin.headers.authorization).toBe("Basic dXNlcjpwYXNz");
  expect(foreign.headers.authorization).toBeUndefined(); expect(foreign.headers.cookie).toBeUndefined();
  expect((await run(["--max-redirect=1", url("loop")])).code).toBe(8);
});

test("wget POST/custom headers, input lists, spider and retry behavior", async () => {
  const posted = await run(["-qO-", "--post-data=a=b", "--header=X-Custom: value", "-U", "agent", url("echo")]);
  expect(posted.code).toBe(0);
  const data = JSON.parse(posted.stdout); expect(data.method).toBe("POST"); expect(data.body).toBe("a=b");
  expect(data.headers["x-custom"]).toBe("value"); expect(data.headers["user-agent"]).toBe("agent");
  expect((await run(["-qO-", "-i", "-"], `# comment\n${url("retry")}\n`)).stdout).toBe("downloaded\n");
  expect(retryCount).toBe(2);
  expect((await run(["--spider", url("file")])).code).toBe(0);
  expect(requests.at(-1).method).toBe("HEAD"); expect(await readdir(dir)).toEqual([]);
});

test("wget resumes with validated ranges and handles complete or unsupported resume", async () => {
  await writeFile(join(dir, "range"), "complete ");
  expect((await run(["-c", url("range")])).code).toBe(0);
  expect(await readFile(join(dir, "range"), "utf8")).toBe("complete download\n");
  expect(requests.at(-1).headers.range).toBe("bytes=9-");
  expect((await run(["-c", url("range")])).code).toBe(0);
  await writeFile(join(dir, "file"), "keep");
  expect((await run(["-c", url("file")])).code).toBe(4);
  expect(await readFile(join(dir, "file"), "utf8")).toBe("keep");
});

test("wget timestamping, no-clobber, safe Content-Disposition and server failures", async () => {
  expect((await run(["-N", url("timestamp")])).code).toBe(0);
  expect((await stat(join(dir, "timestamp"))).mtime.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  expect((await run(["-N", url("timestamp")])).code).toBe(0); expect(requests.at(-1).headers["if-modified-since"]).toBeDefined();
  await writeFile(join(dir, "file"), "keep"); const n = requests.length;
  expect((await run(["--no-clobber", url("file")])).code).toBe(0); expect(requests.length).toBe(n);
  expect((await run(["--content-disposition", url("disposition")])).code).toBe(0);
  expect(await readFile(join(dir, "outside.txt"), "utf8")).toBe("named\n");
  expect((await run([url("fail")])).code).toBe(8); expect((await run([url("auth")])).code).toBe(6);
  expect(await Bun.file(join(dir, "fail")).exists()).toBe(false);
});

test("wget network failures and body timeouts return network status", async () => {
  const refused = other.url.href; other.stop(true);
  expect((await run(["-t1", "-T1", refused])).code).toBe(4);
  expect((await run(["-t1", "-T0.1", "-O", "partial", url("slow")])).code).toBe(4);
});

test("wget protects collision paths and validates range responses before writing", async () => {
  await symlink("missing-target", join(dir,"file"));
  expect((await run([url("file")])).code).toBe(0);
  expect(await Bun.file(join(dir,"missing-target")).exists()).toBe(false);
  expect(await readFile(join(dir,"file.1"),"utf8")).toBe("downloaded\n");
  await writeFile(join(dir,"invalid-range"),"keep");
  expect((await run(["-c",url("invalid-range")])).code).toBe(4);
  expect(await readFile(join(dir,"invalid-range"),"utf8")).toBe("keep");
  await writeFile(join(dir,"resumed.bin"),"complete ");
  expect((await run(["--content-disposition","-c",url("named-range")])).code).toBe(0);
  expect(await readFile(join(dir,"resumed.bin"),"utf8")).toBe("complete download\n");
  expect(requests.at(-1).headers.range).toBe("bytes=9-");
  await writeFile(join(dir,"outside.txt"),"keep");
  expect((await run(["--content-disposition","--no-clobber",url("disposition")])).code).toBe(0);
  expect(await readFile(join(dir,"outside.txt"),"utf8")).toBe("keep");
});

test("wget continues later URLs after a streaming failure and reports disk errors", async () => {
  const result=await run(["-t1","-T0.1",url("slow"),url("file")]);
  expect(result.code).toBe(4);
  expect(await readFile(join(dir,"file"),"utf8")).toBe("downloaded\n");
  if(process.platform==="linux") expect((await run(["-O","/dev/full",url("file")])).code).toBe(3);
});
