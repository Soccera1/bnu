#!/usr/bin/env bun
import { open, lstat, mkdir, utimes, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { defineCommand, runAsMain } from "../shared/command.js";
import { InvocationError, UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { last, metaOption, options, positiveNumber } from "../shared/utility.js";

const short = { O:["output",true], P:["directory",true], q:"quiet", v:"verbose", c:"continue", N:"timestamp", S:"response", t:["tries",true], T:["timeout",true], U:["agent",true], i:["input",true], o:["log",true], a:["appendLog",true], h:"help", V:"version" };
const long = { "output-document":["output",true], "directory-prefix":["directory",true], quiet:"quiet", verbose:"verbose", "no-verbose":"quiet", continue:"continue", timestamping:"timestamp", "server-response":"response", tries:["tries",true], timeout:["timeout",true], "read-timeout":["timeout",true], "connect-timeout":["timeout",true], "user-agent":["agent",true], "input-file":["input",true], "output-file":["log",true], "append-output":["appendLog",true], header:["header",true], "post-data":["post",true], "post-file":["postFile",true], method:["method",true], "body-data":["body",true], "body-file":["bodyFile",true], "http-user":["user",true], "http-password":["password",true], user:["user",true], password:["password",true], "no-check-certificate":"insecure", "max-redirect":["redirects",true], "no-clobber":"noclobber", spider:"spider", "content-disposition":"disposition", "trust-server-names":"serverNames", "no-cache":"noCache", "no-proxy":"noProxy", "waitretry":["waitretry",true], "retry-connrefused":"retryRefused", "save-headers":"saveHeaders", "no-http-keep-alive":"noKeepAlive", "referer":["referer",true] };

export async function wget(args) {
  const { opts, operands } = options(args, short, long);
  if (opts.help || opts.version) return (await import("../shared/runtime.js")).executeCommand("wget", () => 0, () => opts.help ? "--help" : "--version", []);
  if (opts.input) for (const file of opts.input) operands.push(...(await readFile(file === "-" ? "/dev/stdin" : file,"utf8")).split(/\r?\n/).map(s=>s.trim()).filter(s=>s && !s.startsWith("#")));
  if (!operands.length) throw new UsageError("missing URL", true);
  const tries = positiveNumber(last(opts,"tries",20),"number of tries",true);
  if (!Number.isInteger(tries)) throw new UsageError("number of tries must be an integer");
  const timeout = positiveNumber(last(opts,"timeout",900),"timeout",true) * 1000;
  const redirects = positiveNumber(last(opts,"redirects",20),"redirect count",true);
  if (!Number.isInteger(redirects)) throw new UsageError("redirect count must be an integer");
  const waitretry = positiveNumber(last(opts,"waitretry",10),"retry wait",true);
  let log;
  const logPath = last(opts,"log",last(opts,"appendLog"));
  if (logPath) log = await open(logPath,opts.appendLog ? "a" : "w");
  const report = async message => { if (opts.quiet) return; if(log) await log.write(message); else stderr(message); };
  let output, result = 0;
  try {
    if (opts.directory) await mkdir(last(opts,"directory"),{recursive:true});
    for (const operand of operands) {
      let original;
      try { original = new URL(/^[a-z][a-z\d+.-]*:/i.test(operand) ? operand : `http://${operand}`); } catch { await report(`wget: invalid URL '${operand}'\n`); result=Math.max(result,1); continue; }
      if (!["http:","https:"].includes(original.protocol)) { await report(`wget: unsupported scheme '${original.protocol}'\n`); result=Math.max(result,1); continue; }
      const headers = new Headers({"user-agent":last(opts,"agent","Wget/1.0 (BNU)"),"accept":"*/*","accept-encoding":"identity"});
      if (opts.referer) headers.set("referer",last(opts,"referer"));
      if (opts.noCache) headers.set("cache-control","no-cache");
      if (opts.noKeepAlive) headers.set("connection","close");
      if (opts.user || original.username) headers.set("authorization",`Basic ${Buffer.from(`${last(opts,"user",decodeURIComponent(original.username))}:${last(opts,"password",decodeURIComponent(original.password))}`).toString("base64")}`);
      original.username=""; original.password="";
      for (const value of opts.header ?? []) { const colon=value.indexOf(":"); if(colon<1) throw new UsageError(`invalid header '${value}'`); headers.set(value.slice(0,colon),value.slice(colon+1).trim()); }
      let body = last(opts,"post",last(opts,"body"));
      if (opts.postFile || opts.bodyFile) body=await readFile(last(opts,"postFile",last(opts,"bodyFile")));
      if (body!=null && !headers.has("content-type")) headers.set("content-type","application/x-www-form-urlencoded");
      const method=last(opts,"method",opts.spider ? "HEAD" : body!=null ? "POST" : "GET");
      let filename=last(opts,"output",join(last(opts,"directory","."),urlFilename(original)));
      if (!opts.output && (opts.disposition || opts.serverNames) && (opts.continue || opts.timestamp || opts.noclobber)) {
        // Header-derived names must be known before deciding which local file
        // supplies a Range or If-Modified-Since header.
        const probeController=new AbortController(), probeTimer=timeout ? setTimeout(()=>probeController.abort(),timeout) : null;
        let probe;
        try {
          let probeUrl=new URL(original); const probeHeaders=new Headers(headers);
          for(let hop=0;;hop++) {
            probe=await fetch(probeUrl,{method:"HEAD",headers:probeHeaders,redirect:"manual",signal:probeController.signal,...(opts.insecure ? {tls:{rejectUnauthorized:false}}:{}),...(opts.noProxy ? {proxy:""}:{})});
            if(![301,302,303,307,308].includes(probe.status) || !probe.headers.has("location")) break;
            await probe.body?.cancel();
            if(hop>=redirects) throw new InvocationError("maximum redirections exceeded",8,false);
            const next=new URL(probe.headers.get("location"),probeUrl);
            if(!["http:","https:"].includes(next.protocol)) throw new InvocationError("redirect to unsupported protocol",8,false);
            if(next.origin!==probeUrl.origin) { probeHeaders.delete("authorization"); probeHeaders.delete("cookie"); }
            probeUrl=next;
          }
          if (probe.ok) filename=join(last(opts,"directory","."),responseFilename(probe,opts.serverNames ? probeUrl : original,opts.disposition));
          await probe.body?.cancel();
        } catch(error) { await probe?.body?.cancel().catch(()=>{}); await report(`wget: ${error.message}\n`); result=Math.max(result,error instanceof InvocationError ? error.code : networkStatus(error)); continue; }
        finally { if(probeTimer)clearTimeout(probeTimer); }
      }
      const existing=filename!=="-" ? await lstat(filename).catch(()=>null) : null;
      if(opts.noclobber && existing) { await report(`File '${filename}' already there; not retrieving.\n`); continue; }
      if ((opts.continue || opts.timestamp) && existing && !existing.isFile()) { await report(`wget: '${filename}' is not a regular file\n`); result=Math.max(result,3); continue; }
      const offset=opts.continue && existing ? existing.size : 0;
      if(offset) headers.set("range",`bytes=${offset}-`);
      if(opts.timestamp && existing) headers.set("if-modified-since",existing.mtime.toUTCString());
      let response, url, requestError, controller;
      for(let attempt=0; tries===0 || attempt<tries; attempt++) {
        controller=new AbortController(); const timer=timeout ? setTimeout(()=>controller.abort(),timeout) : null;
        try {
          url=new URL(original); let reqMethod=method,reqBody=body; const requestHeaders=new Headers(headers);
          for(let hop=0;;hop++) {
            response=await fetch(url,{method:reqMethod,body:reqBody,headers:requestHeaders,redirect:"manual",signal:controller.signal,decompress:false, ...(opts.insecure ? {tls:{rejectUnauthorized:false}}:{}), ...(opts.noProxy ? {proxy:""}:{})});
            if(opts.response) { await report(`  HTTP/1.1 ${response.status} ${response.statusText}\n`); for(const [k,v] of response.headers) await report(`  ${k}: ${v}\n`); }
            if(![301,302,303,307,308].includes(response.status) || !response.headers.has("location")) break;
            await response.body?.cancel();
            if(hop>=redirects) throw new InvocationError("maximum redirections exceeded",8,false);
            const next=new URL(response.headers.get("location"),url);
            if(!["http:","https:"].includes(next.protocol)) throw new InvocationError("redirect to unsupported protocol",8,false);
            if(next.origin!==url.origin) { requestHeaders.delete("authorization"); requestHeaders.delete("cookie"); }
            if(response.status===303 || ([301,302].includes(response.status) && reqMethod==="POST")) { reqMethod="GET"; reqBody=undefined; requestHeaders.delete("content-type"); }
            url=next;
          }
          if([500,502,503,504].includes(response.status) && (tries===0 || attempt+1<tries)) { await response.body?.cancel(); if(timer)clearTimeout(timer); await new Promise(r=>setTimeout(r,Math.min(attempt+1,waitretry)*1000)); continue; }
          // Keep the timeout active until the response body has been consumed.
          response.bnuTimer=timer; requestError=null; break;
        } catch(error) {
          if(timer)clearTimeout(timer); requestError=error;
          if(error instanceof InvocationError || (error.code==="ECONNREFUSED" && !opts.retryRefused) || (tries!==0 && attempt+1>=tries)) break;
          await new Promise(r=>setTimeout(r,Math.min(attempt+1,waitretry)*1000));
        }
      }
      if(requestError) { await report(`wget: ${requestError.message}\n`); result=Math.max(result,requestError instanceof InvocationError ? requestError.code : networkStatus(requestError)); continue; }
      try {
        if(response.status===304 || (offset && response.status===416 && response.headers.get("content-range")===`bytes */${offset}`)) { await response.body?.cancel(); continue; }
        if(!response.ok) { await report(`wget: server returned ${response.status} ${response.statusText}\n`); await response.body?.cancel(); result=Math.max(result,response.status===401||response.status===403 ? 6:8); continue; }
        if(opts.spider) { await response.body?.cancel(); continue; }
        if(offset && response.status!==206) throw new InvocationError("server does not support resuming this download",4,false);
        const partial=response.status===206 ? response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/) : null;
        if(response.status===206 && (!offset || !partial || Number(partial[1])!==offset || Number(partial[2])<offset || (partial[3]!=="*" && Number(partial[2])>=Number(partial[3])))) throw new InvocationError("invalid partial response",4,false);
        if(!opts.output && (opts.serverNames || opts.disposition)) {
          const name=responseFilename(response,opts.serverNames ? url : original,opts.disposition);
          if (offset && filename!==join(last(opts,"directory","."),name)) throw new InvocationError("server changed the filename of a resumed download; specify --output-document",4,false);
          filename=join(last(opts,"directory","."),name);
        }
        if(opts.noclobber && filename!=="-" && await lstat(filename).catch(()=>null)) { await response.body?.cancel(); await report(`File '${filename}' already there; not retrieving.\n`); continue; }
        if(!opts.output && !opts.continue && !opts.timestamp && !opts.noclobber) { const base=filename; let n=0; while(await lstat(filename).catch(()=>null)) filename=`${base}.${++n}`; }
        if(filename!=="-") {
          if(opts.output && output) {} else output=await open(filename,offset ? "a":opts.noclobber || (!opts.output && !opts.continue && !opts.timestamp) ? "wx":"w");
        }
        if(opts.saveHeaders) { const text=`HTTP/1.1 ${response.status} ${response.statusText}\r\n${[...response.headers].map(([k,v])=>`${k}: ${v}`).join("\r\n")}\r\n\r\n`; if(filename==="-")stdout(text);else await output.write(text); }
        let size=0;
        try {
          for await(const chunk of response.body) {
            if(filename==="-")stdout(chunk);
            else {
              let written=0;
              while(written<chunk.length) {
                let count;
                try { count=(await output.write(chunk,written,chunk.length-written)).bytesWritten; }
                catch(error) { throw new InvocationError(error.message,3,false); }
                if (!count) throw new InvocationError("write failed: zero bytes written",3,false);
                written+=count;
              }
            }
            size+=chunk.length;
          }
        } catch(error) { if(error instanceof InvocationError) throw error; throw new InvocationError(error.message,networkStatus(error),false); }
        if(partial && size!==Number(partial[2])-Number(partial[1])+1) throw new InvocationError("partial response length does not match Content-Range",4,false);
        if(!opts.output && output) { await output.close(); output=null; }
        if(opts.timestamp && filename!=="-" && response.headers.has("last-modified")) { const date=new Date(response.headers.get("last-modified")); if(Number.isFinite(date.getTime()))await utimes(filename,date,date); }
        await report(`Saved '${filename}' [${size} bytes]\n`);
      } catch(error) { await response.body?.cancel().catch(()=>{}); await report(`wget: ${error.message}\n`); result=Math.max(result,error instanceof InvocationError ? error.code : error.name==="AbortError" ? 4 : 3); }
      finally { if(response.bnuTimer)clearTimeout(response.bnuTimer); if(!opts.output && output) { await output.close(); output=null; } }
    }
  } finally { if(output)await output.close(); if(log)await log.close(); }
  return result;
}
function networkStatus(error) { return /CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(`${error.code??""} ${error.message??""}`) ? 5 : 4; }
function responseFilename(response,url,disposition) {
  let name=urlFilename(url);
  if(disposition) {
    const value=response.headers.get("content-disposition")??"";
    const extended=value.match(/filename\*=UTF-8''([^;]+)/i), plain=value.match(/filename="((?:[^"\\]|\\.)*)"|filename=([^;]+)/i);
    if(extended) { try { name=safeFilename(decodeURIComponent(extended[1].trim())); } catch { name=safeFilename(extended[1].trim()); } }
    else if(plain) name=safeFilename((plain[1]??plain[2]).trim().replace(/\\(["\\])/g,"$1"));
  }
  return name;
}
function safeFilename(name) { const clean=basename(name.replaceAll("\\","/")).replace(/[\x00-\x1f\x7f]/g,"_"); return !clean || clean==="." || clean===".." ? "index.html" : clean; }
function urlFilename(url) { try { return safeFilename(decodeURIComponent(url.pathname.split("/").at(-1)||"index.html")); } catch { return safeFilename(url.pathname.split("/").at(-1)||"index.html"); } }
const singleCall=defineCommand("wget",wget,metaOption);
export default singleCall;
if(import.meta.main) await runAsMain(singleCall);
