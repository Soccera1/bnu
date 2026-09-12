import { appendFileSync, closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { formatPrintf } from "./printf.js";
import { InvocationError, encodeSurrogateEscapedString, stdout } from "./diagnostics.js";
import { systemErrorMessage } from "./common.js";
import { TextRegex, textReadSync, textUnescape } from "./text-tools.js";

// Input fields have awk's strnum attribute; string literals do not. Keeping
// that distinction is essential for comparisons and the truth value of "0".
class InputValue { constructor(text) { this.text = text; } }
const empty = new InputValue("");
const numericText = (text) => /^[ \t\n]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n]*$/.test(text);
function numeric(value) { return typeof value === "number" || value instanceof InputValue && (value.text === "" || numericText(value.text)); }
function number(value) { return typeof value === "number" ? value : parseFloat(value instanceof InputValue ? value.text : value) || 0; }
function truth(value) { return numeric(value) ? number(value) !== 0 : String(value instanceof InputValue ? value.text : value).length !== 0; }
function flow(kind, value) { throw { awkFlow:true, kind, value }; }

export class AwkRuntime {
  constructor(program, operands, assignments = {}, fieldSeparator) {
    this.program = program;
    this.globals = new Map(Object.entries({ FS:fieldSeparator ?? " ",OFS:" ",ORS:"\n",RS:"\n",NR:0,FNR:0,NF:0,FILENAME:"",OFMT:"%.6g",CONVFMT:"%.6g",SUBSEP:"\x1c",RSTART:0,RLENGTH:-1,IGNORECASE:0,ARGC:operands.length + 1,ARGV:new Map([["0","awk"],...operands.map((arg,i) => [String(i+1),arg])]),ENVIRON:new Map(Object.entries(process.env)),...assignments }));
    this.locals = []; this.fields = []; this.record = ""; this.regexes = new Map(); this.outputs = new Map(); this.pipes = new Map(); this.readers = new Map();
    this.argument = 1; this.source = null; this.hadInput = false; this.finished = false; this.status = 0; this.seed = 1; this.random = 1;
    for (const [name,value] of Object.entries(assignments)) this.set(name,new InputValue(value));
    // Arrays are passed by reference, including an as-yet uninitialized caller
    // variable. Infer array parameters from their uses in each function body.
    for (const fn of program.functions.values()) {
      fn.arrayParameters = new Set();
      const inspect = (node) => {
        if (!node || typeof node !== "object") return;
        if (node.kind === "index" && fn.parameters.includes(node.name)) fn.arrayParameters.add(node.name);
        if (node.kind === "forin" && fn.parameters.includes(node.array)) fn.arrayParameters.add(node.array);
        if (node.kind === "binary" && node.op === "in" && fn.parameters.includes(node.right?.name)) fn.arrayParameters.add(node.right.name);
        if (node.kind === "call" && ["split","match"].includes(node.name)) { const arg = node.args[node.name === "split" ? 1 : 2]; if (fn.parameters.includes(arg?.name)) fn.arrayParameters.add(arg.name); }
        for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(inspect); else if (typeof value === "object") inspect(value);
      };
      inspect(fn.body);
    }
  }
  string(value, output = false) {
    if (value instanceof InputValue) return value.text;
    if (value instanceof Map) this.error("attempt to use array in a scalar context");
    if (typeof value !== "number") return String(value ?? "");
    if (Number.isInteger(value)) return String(value);
    return this.format(this.get(output ? "OFMT" : "CONVFMT"),[value]);
  }
  error(message) { throw new InvocationError(message,2,false); }
  scope(name) { const scope = this.locals.at(-1); return scope?.has(name) ? scope : this.globals; }
  get(name) { if (name === "NF") return this.fields.length; return this.scope(name).get(name) ?? empty; }
  set(name,value) {
    if (name === "NF") {
      const size = Math.trunc(number(value)); if (size < 0 || size > 10000000) this.error("invalid field count");
      this.fields = Array.from({length:size},(_,i) => this.fields[i] ?? empty); this.rebuild(); return value;
    }
    this.scope(name).set(name,value); return value;
  }
  array(name) {
    const value = this.get(name);
    if (value instanceof Map) return value;
    if (value !== empty) this.error(`attempt to use scalar '${name}' as an array`);
    const result = new Map(); this.set(name,result); return result;
  }
  key(indices) { return indices.map((node) => this.string(this.eval(node))).join(this.string(this.get("SUBSEP"))); }
  ref(node) {
    if (node.kind === "var") return {get:() => this.get(node.name),set:(value) => this.set(node.name,value)};
    if (node.kind === "field") {
      const index = Math.trunc(number(this.eval(node.index)));
      if (index < 0 || index > 10000000) this.error(`invalid field index ${index}`);
      return {get:() => index === 0 ? new InputValue(this.record) : this.fields[index-1] ?? empty,set:(value) => {
        if (!index) this.setRecord(this.string(value));
        else { while (this.fields.length < index) this.fields.push(empty); this.fields[index-1] = value; this.rebuild(); }
        return value;
      }};
    }
    if (node.kind === "index") {
      const array = this.array(node.name), key = this.key(node.indices);
      return { get:() => { if (!array.has(key)) array.set(key,empty); return array.get(key); },set:(value) => { array.set(key,value); return value; } };
    }
    this.error("invalid assignment target");
  }
  regex(pattern) {
    const ignoreCase = truth(this.get("IGNORECASE")), key = `${ignoreCase ? 1 : 0}\0${pattern}`;
    if (!this.regexes.has(key)) this.regexes.set(key,new TextRegex(pattern,{extended:true,ignoreCase}));
    return this.regexes.get(key);
  }
  pattern(node) { return node?.kind === "regex" ? node.value : this.string(this.eval(node)); }
  split(text, separator) {
    if (separator === " ") return text.replace(/^[ \t\n]+|[ \t\n]+$/g,"").split(/[ \t\n]+/).filter((part) => part !== "");
    if (separator === "") return [...text];
    if (text === "") return [];
    if ([...separator].length === 1) return text.split(separator);
    const regex = this.regex(separator), fields = []; let start = 0, copied = 0;
    while (start <= text.length) {
      const match = regex.exec(text,start); if (!match) break;
      if (!match[0]) { start = match.index + 1; continue; }
      fields.push(text.slice(copied,match.index)); copied = match.index + match[0].length; start = copied;
    }
    fields.push(text.slice(copied)); return fields;
  }
  setRecord(text) { this.record = text; this.fields = this.split(text,this.string(this.get("FS"))).map((field) => new InputValue(field)); }
  rebuild() { this.record = this.fields.map((value) => this.string(value)).join(this.string(this.get("OFS"))); }
  nextSource() {
    while (this.argument < number(this.get("ARGC"))) {
      const index = this.argument++, arg = this.string(this.array("ARGV").get(String(index)) ?? ""); if (!arg) continue;
      const assignment = arg.match(/^([A-Za-z_]\w*)=(.*)$/s);
      if (assignment) { this.set(assignment[1],new InputValue(textUnescape(assignment[2]))); continue; }
      this.hadInput = true; this.openSource(arg,index); return true;
    }
    if (!this.hadInput) { this.hadInput = true; this.openSource("-",0); return true; }
    this.finished = true; return false;
  }
  openSource(file,argind) {
    let text;
    try { text = textReadSync(file); } catch (error) { this.error(`cannot open '${file}' for reading: ${systemErrorMessage(error)}`); }
    this.source = {file,text,offset:0}; this.set("FILENAME",file); this.set("FNR",0); this.set("ARGIND",argind);
    this.runPhase("BEGINFILE");
  }
  readRecord(source) {
    if (source.offset >= source.text.length) return null;
    const rs = this.string(this.get("RS")); let start = source.offset, end, next, rt = "";
    if (rs === "") {
      while (source.text[start] === "\n") start++;
      if (start === source.text.length) { source.offset = start; return null; }
      const match = /\n\n+/.exec(source.text.slice(start));
      end = match ? start + match.index : source.text.length;
      next = match ? end + match[0].length : end;
      rt = match?.[0] ?? "";
      if (!match && source.text[end-1] === "\n") end--;
    } else if ([...rs].length === 1) {
      const found = source.text.indexOf(rs,start); end = found < 0 ? source.text.length : found; next = end + (found < 0 ? 0 : rs.length); rt = found < 0 ? "" : rs;
    } else {
      let match = this.regex(rs).exec(source.text,start);
      let search = start;
      while (match && !match[0]) { search = match.index + 1; if (search > source.text.length) { match = null; break; } match = this.regex(rs).exec(source.text,search); }
      end = match ? match.index : source.text.length; next = match ? end + match[0].length : end; rt = match?.[0] ?? "";
    }
    source.offset = next; this.set("RT",rt); return source.text.slice(start,end);
  }
  nextRecord() {
    while (!this.finished) {
      if (!this.source && !this.nextSource()) return null;
      const record = this.readRecord(this.source);
      if (record != null) { this.set("NR",number(this.get("NR"))+1); this.set("FNR",number(this.get("FNR"))+1); return record; }
      this.runPhase("ENDFILE"); this.source = null;
    }
    return null;
  }
  eval(node) {
    if (!node) return empty;
    switch (node.kind) {
      case "literal": return node.value;
      case "var": if (node.name === "length" && !this.scope("length").has("length")) return [...this.record].length; return this.get(node.name);
      case "field": case "index": return this.ref(node).get();
      case "regex": return this.regex(node.value).test(this.record) ? 1 : 0;
      case "tuple": return node.values.map((value) => this.string(this.eval(value))).join(this.string(this.get("SUBSEP")));
      case "unary": { const value = this.eval(node.value); return node.op === "!" ? +!truth(value) : node.op === "-" ? -number(value) : number(value); }
      case "ternary": return this.eval(truth(this.eval(node.condition)) ? node.yes : node.no);
      case "increment": { const ref = this.ref(node.target), old = number(ref.get()), value = old + (node.op === "++" ? 1 : -1); ref.set(value); return node.post ? old : value; }
      case "assign": { const ref = this.ref(node.left), right = this.eval(node.right); return ref.set(node.op === "=" ? right : this.binary(node.op[0],ref.get(),right)); }
      case "binary": {
        if (node.op === "&&") return +(truth(this.eval(node.left)) && truth(this.eval(node.right)));
        if (node.op === "||") return +(truth(this.eval(node.left)) || truth(this.eval(node.right)));
        if (node.op === "~" || node.op === "!~") { const matched = this.regex(this.pattern(node.right)).test(this.string(this.eval(node.left))); return +(node.op === "~" ? matched : !matched); }
        if (node.op === "in") { if (node.right.kind !== "var") this.error("right operand of 'in' must be an array"); return +this.array(node.right.name).has(this.string(this.eval(node.left))); }
        return this.binary(node.op,this.eval(node.left),this.eval(node.right));
      }
      case "call": return this.call(node.name,node.args);
      case "getline": {
        let record;
        if (node.source) {
          const name = this.string(this.eval(node.source)), key = (node.pipe ? "|" : "<") + name;
          try {
            if (!this.readers.has(key)) {
              const text = node.pipe ? Bun.spawnSync(["/bin/sh","-c",name],{stdout:"pipe",stderr:"inherit"}).stdout.toString() : textReadSync(name);
              this.readers.set(key,{text,offset:0});
            }
            record = this.readRecord(this.readers.get(key));
          } catch (error) { this.set("ERRNO",systemErrorMessage(error)); return -1; }
        } else record = this.nextRecord();
        if (record == null) return 0;
        if (node.target) this.ref(node.target).set(new InputValue(record)); else this.setRecord(record);
        return 1;
      }
    }
    this.error(`unknown expression '${node.kind}'`);
  }
  binary(op,left,right) {
    if (op === "concat") return this.string(left) + this.string(right);
    if (["==","!=","<",">","<=",">="].includes(op)) {
      const a = numeric(left) && numeric(right) ? number(left) : this.string(left), b = numeric(left) && numeric(right) ? number(right) : this.string(right);
      return +(op === "==" ? a === b : op === "!=" ? a !== b : op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b);
    }
    const a = number(left), b = number(right);
    if ((op === "/" || op === "%") && b === 0) this.error("division by zero");
    return op === "+" ? a+b : op === "-" ? a-b : op === "*" ? a*b : op === "/" ? a/b : op === "%" ? a%b : a**b;
  }
  format(format,values) {
    let index = 0;
    // The shell printf formatter provides widths/precisions and numeric formats;
    // escape backslashes here because the awk lexer has already processed them.
    const args = [], template = this.string(format).replace(/%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d+))?([aAcdeEfFgGiosuxX%])/g,(all,flags,width,precision,type) => {
      if (type === "%") return all;
      if (width === "*") args.push(String(number(values[index++])));
      if (precision === "*") args.push(String(number(values[index++])));
      const value = values[index++] ?? empty;
      if (type === "c" && !numeric(value)) args.push("'" + (this.string(value)[0] ?? "\0"));
      else args.push(type === "s" ? this.string(value) : String(number(value)));
      return all;
    });
    return formatPrintf(template.replaceAll("\\","\\\\"),args);
  }
  call(name,args) {
    if (this.program.functions.has(name)) {
      const fn = this.program.functions.get(name), scope = new Map();
      for (let i = 0; i < fn.parameters.length; i++) {
        const parameter = fn.parameters[i], argument = args[i];
        if (fn.arrayParameters.has(parameter)) {
          if (argument && argument.kind !== "var") this.error(`function '${name}': array parameter requires an array variable`);
          scope.set(parameter,argument ? this.array(argument.name) : new Map());
        } else scope.set(parameter,argument ? this.eval(argument) : empty);
      }
      this.locals.push(scope);
      try { this.execute(fn.body); return empty; } catch (signal) { if (signal.awkFlow && signal.kind === "return") return signal.value; throw signal; } finally { this.locals.pop(); }
    }
    if (name === "sub" || name === "gsub") {
      if (args.length < 2) this.error(`${name}: requires at least 2 arguments`);
      const regex = this.regex(this.pattern(args[0])), replacement = this.string(this.eval(args[1])), target = args[2] ? this.ref(args[2]) : {get:() => new InputValue(this.record),set:(value) => this.setRecord(this.string(value))};
      const text = this.string(target.get()); let search = 0, copied = 0, result = "", count = 0, previousEnd = -1;
      while (search <= text.length) {
        const match = regex.exec(text,search); if (!match) break;
        if (!match[0] && match.index === previousEnd) { search = match.index + 1; continue; }
        result += text.slice(copied,match.index) + replacement.replace(/\\([\\&])|&/g,(part,escaped) => escaped ?? match[0]);
        copied = match.index + match[0].length; previousEnd = copied; search = match.index + Math.max(1,match[0].length); count++;
        if (name === "sub") break;
      }
      if (count) target.set(result + text.slice(copied)); return count;
    }
    if (name === "split") {
      if (args.length < 2 || args[1].kind !== "var") this.error("split: second argument must be an array");
      const array = this.array(args[1].name), text = this.string(this.eval(args[0])), sep = args[2] ? this.pattern(args[2]) : this.string(this.get("FS"));
      const fields = this.split(text,sep); array.clear(); fields.forEach((field,i) => array.set(String(i+1),new InputValue(field))); return fields.length;
    }
    if (name === "match") {
      const text = this.string(this.eval(args[0])), match = this.regex(this.pattern(args[1])).exec(text);
      this.set("RSTART",match ? [...text.slice(0,match.index)].length+1 : 0); this.set("RLENGTH",match ? [...match[0]].length : -1);
      if (args[2]) { if (args[2].kind !== "var") this.error("match: third argument must be an array"); const array = this.array(args[2].name); array.clear(); match?.forEach((value,i) => { if (value !== undefined) array.set(String(i),new InputValue(value)); }); }
      return this.get("RSTART");
    }
    const values = args.map((arg) => this.eval(arg)), s = (i) => this.string(values[i]), n = (i) => number(values[i]);
    switch (name) {
      case "length": return !values.length ? [...this.record].length : values[0] instanceof Map ? values[0].size : [...s(0)].length;
      case "substr": { const start = Math.max(0,Math.trunc(n(1))-1); return [...s(0)].slice(start,values.length < 3 ? undefined : start + Math.max(0,Math.trunc(n(2)))).join(""); }
      case "index": { const index = s(0).indexOf(s(1)); return index < 0 ? 0 : [...s(0).slice(0,index)].length + 1; }
      case "tolower": return s(0).toLocaleLowerCase();
      case "toupper": return s(0).toLocaleUpperCase();
      case "sprintf": return this.format(values[0],values.slice(1));
      case "int": return Math.trunc(n(0));
      case "sqrt": return Math.sqrt(n(0)); case "exp": return Math.exp(n(0)); case "log": return Math.log(n(0)); case "sin": return Math.sin(n(0)); case "cos": return Math.cos(n(0)); case "atan2": return Math.atan2(n(0),n(1));
      case "rand": this.random = (Math.imul(this.random,1664525)+1013904223) >>> 0; return this.random / 4294967296;
      case "srand": { const old = this.seed; this.seed = values.length ? n(0) : Math.floor(Date.now()/1000); this.random = this.seed; return old; }
      case "system": return Bun.spawnSync(["/bin/sh","-c",s(0)],{stdin:"inherit",stdout:"inherit",stderr:"inherit"}).exitCode;
      case "close": return this.close(s(0));
      case "fflush": return 0;
      case "systime": return Math.floor(Date.now()/1000);
      case "strtonum": return Number(s(0)) || 0;
      case "and": return (n(0)&n(1))>>>0; case "or": return (n(0)|n(1))>>>0; case "xor": return (n(0)^n(1))>>>0; case "lshift": return (n(0)<<n(1))>>>0; case "rshift": return n(0)>>>n(1); case "compl": return (~n(0))>>>0;
      default: this.error(`function '${name}' not defined`);
    }
  }
  write(text,redirect,destination) {
    if (!redirect) { stdout(text); return; }
    if (redirect === "|") { this.pipes.set(destination,(this.pipes.get(destination) ?? "") + text); return; }
    try {
      if (!this.outputs.has(destination)) this.outputs.set(destination,openSync(destination,redirect === ">>" ? "a" : "w"));
      const bytes = encodeSurrogateEscapedString(text); let start = 0;
      while (start < bytes.length) start += writeSync(this.outputs.get(destination),bytes,start);
    } catch (error) { this.error(`cannot write '${destination}': ${systemErrorMessage(error)}`); }
  }
  close(name) {
    let closed = false, status = 0;
    if (this.outputs.has(name)) { closeSync(this.outputs.get(name)); this.outputs.delete(name); closed = true; }
    if (this.pipes.has(name)) { const text = this.pipes.get(name); this.pipes.delete(name); status = Bun.spawnSync(["/bin/sh","-c",name],{stdin:encodeSurrogateEscapedString(text),stdout:"inherit",stderr:"inherit"}).exitCode; closed = true; }
    for (const prefix of ["<","|"]) if (this.readers.delete(prefix+name)) closed = true;
    return closed ? status : -1;
  }
  execute(node) {
    if (!node) return;
    switch (node.kind) {
      case "block": for (const statement of node.body) this.execute(statement); break;
      case "expr": this.eval(node.value); break;
      case "if": this.execute(truth(this.eval(node.condition)) ? node.yes : node.no); break;
      case "for": case "while": case "do": {
        if (node.init) this.eval(node.init); let first = true;
        while ((node.kind === "do" && first) || !node.condition || truth(this.eval(node.condition))) {
          first = false;
          try { this.execute(node.body); } catch (signal) { if (!signal.awkFlow || !["break","continue"].includes(signal.kind)) throw signal; if (signal.kind === "break") break; }
          if (node.step) this.eval(node.step);
        }
        break;
      }
      case "forin": for (const key of [...this.array(node.array).keys()]) {
        this.set(node.name,new InputValue(key));
        try { this.execute(node.body); } catch (signal) { if (!signal.awkFlow || !["break","continue"].includes(signal.kind)) throw signal; if (signal.kind === "break") break; }
      } break;
      case "delete": if (node.target.kind === "var") this.array(node.target.name).clear(); else this.array(node.target.name).delete(this.key(node.target.indices)); break;
      case "print": {
        const nodes = node.values.length === 1 && node.values[0].kind === "tuple" ? node.values[0].values : node.values;
        const values = nodes.map((value) => this.eval(value));
        const text = node.printf ? this.format(values[0] ?? "",values.slice(1)) : (values.length ? values.map((value) => this.string(value,true)).join(this.string(this.get("OFS"))) : this.record) + this.string(this.get("ORS"));
        this.write(text,node.redirect,node.destination ? this.string(this.eval(node.destination)) : null); break;
      }
      case "exit": flow("exit",node.value ? Math.trunc(number(this.eval(node.value))) : this.status); break;
      case "return": flow("return",this.eval(node.value)); break;
      case "break": case "continue": case "next": case "nextfile": flow(node.kind); break;
    }
  }
  runPhase(phase) { for (const rule of this.program.rules) if (rule.phase === phase) this.execute(rule.action); }
  run() {
    let exited = false;
    try {
      try {
        this.runPhase("BEGIN");
        if (this.program.rules.some((r) => r.phase !== "BEGIN" && r.phase !== "END") || this.program.rules.some((r) => r.phase === "END")) {
          let record;
          while ((record = this.nextRecord()) != null) {
            this.setRecord(record);
            try {
              for (const rule of this.program.rules) {
                if (rule.phase !== "record") continue;
                let selected = !rule.pattern;
                if (rule.endPattern) {
                  if (!rule.active && truth(this.eval(rule.pattern))) rule.active = true;
                  selected = rule.active; if (rule.active && truth(this.eval(rule.endPattern))) rule.active = false;
                } else if (rule.pattern) selected = truth(this.eval(rule.pattern));
                if (selected) this.execute(rule.action);
              }
            } catch (signal) {
              if (signal.awkFlow && signal.kind === "next") continue;
              if (signal.awkFlow && signal.kind === "nextfile") { this.runPhase("ENDFILE"); this.source = null; continue; }
              throw signal;
            }
          }
        }
      } catch (signal) { if (signal.awkFlow && signal.kind === "exit") { this.status = signal.value; exited = true; } else throw signal; }
      try { this.runPhase("END"); } catch (signal) { if (signal.awkFlow && signal.kind === "exit") this.status = signal.value; else throw signal; }
      return this.status;
    } catch (error) {
      if (error.awkFlow) this.error(`'${error.kind}' used outside its valid context`);
      throw error;
    } finally {
      for (const name of [...this.outputs.keys(),...this.pipes.keys()]) this.close(name);
      for (const regex of this.regexes.values()) regex.close();
    }
  }
}
