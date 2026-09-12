import { InvocationError } from "./diagnostics.js";
import { textUnescape } from "./text-tools.js";

function syntax(message) { throw new InvocationError(`syntax error: ${message}`, 2, false); }

export function tokenizeAwk(source) {
  const tokens = []; let i = 0, operand = true;
  const push = (type, value) => { tokens.push({ type, value }); operand = type === "op" ? ![")","]","++","--"].includes(value) : type === "name" && ["print","printf","return","exit","delete","in"].includes(value); };
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\" && source[i + 1] === "\n") { i += 2; continue; }
    if (/[ \t\r]/.test(ch)) { i++; continue; }
    if (ch === "#") { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (ch === "\n") { if (![",","?",":","&&","||","+","-","*","/","%","^","=","+=","-=","*=","/=","%=","^="].includes(tokens.at(-1)?.value)) push("op",";"); i++; continue; }
    if (ch === '"' || ch === "/" && operand && source[i + 1] !== "=") {
      const delimiter = ch, regex = ch === "/"; i++; let text = "", closed = false, bracket = false;
      while (i < source.length) {
        const c = source[i++];
        if (c === "\\" && i < source.length) { const next = source[i++]; text += regex && next === "/" ? "/" : "\\" + next; continue; }
        if (regex && c === "[") bracket = true;
        if (regex && c === "]") bracket = false;
        if (c === delimiter && !bracket) { closed = true; break; }
        if (c === "\n") syntax(`unterminated ${regex ? "regular expression" : "string"}`);
        text += c;
      }
      if (!closed) syntax(`unterminated ${regex ? "regular expression" : "string"}`);
      push(regex ? "regex" : "string", regex ? text.replace(/\\([ntrbfv])/g, (_, c) => textUnescape("\\" + c)) : textUnescape(text)); continue;
    }
    const number = source.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) { push("number",Number(number[0])); i += number[0].length; continue; }
    const name = source.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/);
    if (name) { push("name",name[0]); i += name[0].length; continue; }
    const op = source.slice(i).match(/^(?:\+\+|--|\+=|-=|\*=|\/=|%=|\^=|==|!=|<=|>=|!~|&&|\|\||>>|\*\*|[{}()[\];,?:$+\-*\/%^<>=!~|])/);
    if (!op) syntax(`unexpected character '${ch}'`);
    push("op",op[0] === "**" ? "^" : op[0]); i += op[0].length;
  }
  tokens.push({type:"eof",value:"<end>"}); return tokens;
}

const precedence = { "=":1,"+=":1,"-=":1,"*=":1,"/=":1,"%=":1,"^=":1,"?":2,"||":3,"&&":4,in:5,"~":6,"!~":6,"<":7,">":7,"<=":7,">=":7,"==":7,"!=":7,"+":9,"-":9,"*":10,"/":10,"%":10,"^":12 };
const statementWords = new Set(["if","else","while","do","for","break","continue","next","nextfile","exit","return","print","printf","delete","function","BEGIN","END"]);

export class AwkParser {
  constructor(source) { this.tokens = tokenizeAwk(source); this.index = 0; }
  peek(n = 0) { return this.tokens[this.index + n] ?? this.tokens.at(-1); }
  is(value) { return this.peek().value === value; }
  take() { return this.tokens[this.index++]; }
  eat(value) { if (!this.is(value)) return false; this.take(); return true; }
  need(value) { if (!this.eat(value)) syntax(`expected '${value}', got '${this.peek().value}'`); }
  separators() { while (this.eat(";")) {} }
  program() {
    const rules = [], functions = new Map();
    this.separators();
    while (this.peek().type !== "eof") {
      if (this.eat("function") || this.eat("func")) {
        const name = this.take(); if (name.type !== "name") syntax("expected function name");
        this.need("("); const parameters = [];
        if (!this.is(")")) do { const param = this.take(); if (param.type !== "name") syntax("expected parameter"); parameters.push(param.value); } while (this.eat(","));
        this.need(")"); this.separators(); functions.set(name.value,{parameters,body:this.block()});
      } else {
        let pattern = null, endPattern = null, phase = "record";
        if (this.is("BEGIN") || this.is("END") || this.is("BEGINFILE") || this.is("ENDFILE")) phase = this.take().value;
        else if (!this.is("{")) { pattern = this.expr(); if (this.eat(",")) endPattern = this.expr(); }
        if (this.is(";")) { const saved = this.index; this.separators(); if (!this.is("{")) this.index = saved; }
        const action = this.is("{") ? this.block() : { kind:"print", values:[], printf:false };
        if (phase !== "record" && action.kind !== "block") syntax(`${phase} requires an action`);
        rules.push({pattern,endPattern,phase,action,active:false});
      }
      if (!this.is(";") && this.peek().type !== "eof" && this.tokens[this.index-1]?.value !== "}") syntax(`unexpected '${this.peek().value}'`);
      this.separators();
    }
    return {rules,functions};
  }
  block() {
    this.need("{"); const body = []; this.separators();
    while (!this.eat("}")) {
      if (this.peek().type === "eof") syntax("missing '}'");
      body.push(this.statement());
      if (!this.is("}") && !this.is(";") && this.tokens[this.index-1]?.value !== "}") syntax(`unexpected '${this.peek().value}'`);
      this.separators();
    }
    return {kind:"block",body};
  }
  statement() {
    if (this.is("{")) return this.block();
    if (this.eat(";")) return {kind:"block",body:[]};
    if (this.eat("if")) {
      this.need("("); const condition = this.expr(); this.need(")"); this.separators(); const yes = this.statement();
      const saved = this.index; this.separators(); let no = null;
      if (this.eat("else")) { this.separators(); no = this.statement(); } else this.index = saved;
      return {kind:"if",condition,yes,no};
    }
    if (this.eat("while")) { this.need("("); const condition = this.expr(); this.need(")"); this.separators(); return {kind:"while",condition,body:this.statement()}; }
    if (this.eat("do")) { this.separators(); const body = this.statement(); this.separators(); this.need("while"); this.need("("); const condition = this.expr(); this.need(")"); return {kind:"do",condition,body}; }
    if (this.eat("for")) {
      this.need("(");
      if (this.peek().type === "name" && this.peek(1).value === "in") {
        const name = this.take().value; this.take(); const array = this.take(); if (array.type !== "name") syntax("expected array name"); this.need(")"); this.separators(); return {kind:"forin",name,array:array.value,body:this.statement()};
      }
      const init = this.is(";") ? null : this.expr(); this.need(";"); const condition = this.is(";") ? null : this.expr(); this.need(";"); const step = this.is(")") ? null : this.expr(); this.need(")"); this.separators(); return {kind:"for",init,condition,step,body:this.statement()};
    }
    if (["break","continue","next","nextfile"].includes(this.peek().value)) return {kind:this.take().value};
    if (this.is("exit") || this.is("return")) { const kind = this.take().value; return {kind,value:this.is(";") || this.is("}") || this.peek().type === "eof" ? null : this.expr()}; }
    if (this.eat("delete")) { const target = this.expr(); if (!["var","index"].includes(target.kind)) syntax("invalid delete target"); return {kind:"delete",target}; }
    if (this.is("print") || this.is("printf")) {
      const printf = this.take().value === "printf", values = [];
      if (!this.is(";") && !this.is("}") && ![">",">>","|"].includes(this.peek().value)) {
        do { values.push(this.expr(0,true)); } while (this.eat(","));
      }
      let redirect = null, destination = null;
      if ([">",">>","|"].includes(this.peek().value)) { redirect = this.take().value; destination = this.expr(); }
      return {kind:"print",printf,values,redirect,destination};
    }
    return {kind:"expr",value:this.expr()};
  }
  startsExpression(token) {
    return ["number","string","regex"].includes(token.type) || token.type === "name" && !statementWords.has(token.value) && token.value !== "in" || ["(","$"].includes(token.value);
  }
  expr(min = 0, printing = false) {
    let node = this.prefix();
    while (true) {
      const token = this.peek(), op = token.value;
      if (printing && [">",">>","|"].includes(op)) break;
      if (op === "++" || op === "--") { if (14 < min) break; this.take(); node = {kind:"increment",op,target:node,post:true}; continue; }
      if (op === "|" && this.peek(1).value === "getline") {
        if (0 < min) break; this.take(); this.take(); const target = this.peek().type === "name" ? {kind:"var",name:this.take().value} : null; node = {kind:"getline",target,source:node,pipe:true}; continue;
      }
      const implicit = this.startsExpression(token);
      const p = implicit ? 8 : precedence[op];
      if (p == null || p < min) break;
      if (implicit) { node = {kind:"binary",op:"concat",left:node,right:this.expr(p + 1,printing)}; continue; }
      this.take();
      if (op === "?") { const yes = this.expr(); this.need(":"); node = {kind:"ternary",condition:node,yes,no:this.expr(p,printing)}; }
      else {
        const assignment = p === 1;
        if (assignment && !["var","field","index"].includes(node.kind)) syntax("invalid assignment target");
        node = {kind:assignment ? "assign" : "binary",op,left:node,right:this.expr(assignment || op === "^" ? p : p + 1,printing)};
      }
    }
    return node;
  }
  prefix() {
    const token = this.take(), value = token.value;
    if (token.type === "number" || token.type === "string") return {kind:"literal",value};
    if (token.type === "regex") return {kind:"regex",value};
    if (value === "(") {
      const values = [this.expr()]; while (this.eat(",")) values.push(this.expr()); this.need(")");
      return values.length === 1 ? values[0] : {kind:"tuple",values};
    }
    if (["!","+","-"].includes(value)) return {kind:"unary",op:value,value:this.expr(11)};
    if (["++","--"].includes(value)) return {kind:"increment",op:value,target:this.expr(13),post:false};
    if (value === "$") return {kind:"field",index:this.expr(15)};
    if (value === "getline") {
      let target = null, source = null;
      if (this.peek().type === "name" || this.is("$")) target = this.prefix();
      if (this.eat("<")) source = this.expr(8);
      return {kind:"getline",target,source,pipe:false};
    }
    if (token.type === "name" && !statementWords.has(value)) {
      if (this.eat("(")) {
        const args = []; if (!this.is(")")) do { args.push(this.expr()); } while (this.eat(",")); this.need(")");
        return {kind:"call",name:value,args};
      }
      if (this.eat("[")) { const indices = [this.expr()]; while (this.eat(",")) indices.push(this.expr()); this.need("]"); return {kind:"index",name:value,indices}; }
      return {kind:"var",name:value};
    }
    syntax(`unexpected '${value}'`);
  }
}
