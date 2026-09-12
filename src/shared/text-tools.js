import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { readFileSync } from "node:fs";
import { decodeSurrogateEscapedBytes, libc, readAll } from "./common.js";
import { InvocationError, encodeSurrogateEscapedString } from "./diagnostics.js";

// Use the platform POSIX engine, including leftmost-longest matching, BRE
// backreferences, character classes and the active locale. regex_t is opaque;
// this deliberately overallocates suitably aligned storage on supported Linux.
const regexApi = dlopen("libc.so.6", {
  regcomp: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  regexec: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  regerror: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
  regfree: { args: [FFIType.ptr], returns: FFIType.void },
}).symbols;
const finalizer = new FinalizationRegistry((storage) => regexApi.regfree(ptr(storage)));

let pcreApi;
function getPcreApi() {
  if (pcreApi) return pcreApi;
  try {
    pcreApi = dlopen("libpcre2-8.so.0", {
      pcre2_compile_8:{args:[FFIType.ptr,FFIType.u64,FFIType.u32,FFIType.ptr,FFIType.ptr,FFIType.ptr],returns:FFIType.ptr},
      pcre2_match_data_create_from_pattern_8:{args:[FFIType.ptr,FFIType.ptr],returns:FFIType.ptr},
      pcre2_match_8:{args:[FFIType.ptr,FFIType.ptr,FFIType.u64,FFIType.u64,FFIType.u32,FFIType.ptr,FFIType.ptr],returns:FFIType.i32},
      pcre2_get_ovector_pointer_8:{args:[FFIType.ptr],returns:FFIType.ptr},
      pcre2_get_error_message_8:{args:[FFIType.i32,FFIType.ptr,FFIType.u64],returns:FFIType.i32},
      pcre2_code_free_8:{args:[FFIType.ptr],returns:FFIType.void},
      pcre2_match_data_free_8:{args:[FFIType.ptr],returns:FFIType.void},
    }).symbols;
  } catch { throw new InvocationError("Perl matching requires libpcre2-8",2,false); }
  return pcreApi;
}
export class PerlRegex {
  constructor(pattern,{ignoreCase = false} = {}) {
    const api = getPcreApi(), bytes = encodeSurrogateEscapedString(pattern), error = new Int32Array(1), offset = new BigUint64Array(1);
    const locale = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
    const flags = (ignoreCase ? 8 : 0) | (/utf-?8/i.test(locale) ? 0x04080000 : 0);
    this.code = api.pcre2_compile_8(ptr(Buffer.concat([bytes,Buffer.from([0])])),bytes.length,flags,ptr(error),ptr(offset),null);
    if (!this.code) { const message = Buffer.alloc(512); api.pcre2_get_error_message_8(error[0],ptr(message),message.length); throw new InvocationError(message.toString().split("\0",1)[0],2,false); }
    this.data = api.pcre2_match_data_create_from_pattern_8(this.code,null);
  }
  exec(text,start = 0) {
    const api = getPcreApi(), bytes = encodeSurrogateEscapedString(text), offset = encodeSurrogateEscapedString(text.slice(0,start)).length;
    const count = api.pcre2_match_8(this.code,ptr(Buffer.concat([bytes,Buffer.from([0])])),bytes.length,offset,0,this.data,null);
    if (count === -1) return null;
    if (count < 0) throw new InvocationError(`PCRE2 matching failed (${count})`,2,false);
    const vector = api.pcre2_get_ovector_pointer_8(this.data), result = [];
    for (let i = 0; i < count; i++) {
      const begin = Number(read.u64(vector,16*i)), end = Number(read.u64(vector,16*i+8));
      result.push(begin > bytes.length ? undefined : decodeSurrogateEscapedBytes(bytes.subarray(begin,end)));
    }
    result.byteIndex = Number(read.u64(vector,0)); result.index = decodeSurrogateEscapedBytes(bytes.subarray(0,result.byteIndex)).length;
    return result;
  }
  close() { if (!this.code) return; const api = getPcreApi(); api.pcre2_match_data_free_8(this.data); api.pcre2_code_free_8(this.code); this.code = null; }
}

export class TextRegex {
  constructor(pattern, { extended = false, ignoreCase = false, newline = false } = {}) {
    libc.symbols.setlocale(0, Buffer.from([0]));
    this.storage = Buffer.alloc(4096);
    const code = regexApi.regcomp(ptr(this.storage), ptr(Buffer.concat([encodeSurrogateEscapedString(pattern), Buffer.from([0])])), (extended ? 1 : 0) | (ignoreCase ? 2 : 0) | (newline ? 4 : 0));
    if (code) {
      const message = Buffer.alloc(1024);
      regexApi.regerror(code, ptr(this.storage), ptr(message), message.length);
      throw new InvocationError(message.toString().split("\0", 1)[0], 2, false);
    }
    finalizer.register(this, this.storage, this);
  }
  exec(text, start = 0) {
    const bytes = encodeSurrogateEscapedString(text);
    const matches = new Int32Array(64);
    matches[0] = encodeSurrogateEscapedString(text.slice(0, start)).length;
    matches[1] = bytes.length;
    const input = Buffer.concat([bytes, Buffer.from([0])]);
    // REG_STARTEND permits embedded NUL and preserves anchors after a prior match.
    const code = regexApi.regexec(ptr(this.storage), ptr(input), 32, ptr(matches), 4 | (start > 0 ? 1 : 0));
    if (code === 1) return null;
    if (code) throw new InvocationError("regular expression matching failed", 2, false);
    const result = [];
    for (let i = 0; i < 32; i++) result.push(matches[2 * i] < 0 ? undefined : decodeSurrogateEscapedBytes(bytes.subarray(matches[2 * i], matches[2 * i + 1])));
    result.index = decodeSurrogateEscapedBytes(bytes.subarray(0, matches[0])).length;
    result.byteIndex = matches[0];
    return result;
  }
  test(text) { return this.exec(text) !== null; }
  close() {
    if (!this.storage) return;
    finalizer.unregister(this);
    regexApi.regfree(ptr(this.storage));
    this.storage = null;
  }
}

export async function textRead(file) { return decodeSurrogateEscapedBytes(await readAll(file)); }
export function textReadSync(file) { return decodeSurrogateEscapedBytes(readFileSync(file === "-" ? 0 : file)); }
export function textRecords(text, delimiter = "\n") {
  if (!text) return [];
  const terminated = text.endsWith(delimiter);
  const parts = text.split(delimiter);
  if (terminated) parts.pop();
  return parts.map((text, i) => ({ text, terminated: i < parts.length - 1 || terminated }));
}
export function textMeta(args, { valueShort = "", valueLong = [], stopAtOperand = false } = {}) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "--help" || arg === "--version") return arg;
    if (arg.startsWith("--")) { if (!arg.includes("=") && valueLong.includes(arg.slice(2))) i++; continue; }
    if (arg.startsWith("-") && arg !== "-") {
      for (let j = 1; j < arg.length; j++) if (valueShort.includes(arg[j])) { if (j === arg.length - 1) i++; break; }
    } else if (stopAtOperand) break;
  }
  return null;
}
export function textUnescape(text) {
  return text.replace(/\\(x[\da-fA-F]{1,2}|[0-7]{1,3}|.)/gs, (_, value) => {
    if (value[0] === "x" && value.length > 1) return String.fromCharCode(parseInt(value.slice(1), 16));
    if (/^[0-7]+$/.test(value)) return String.fromCharCode(parseInt(value, 8));
    return ({ a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" })[value] ?? value;
  });
}
