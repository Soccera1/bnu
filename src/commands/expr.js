#!/usr/bin/env bun

import { decodeSurrogateEscapedBytes, isUtf8Locale, localeQuotedDiagnostic, rawCommandArgs } from "../shared/common.js";
import { InvocationError, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export async function exprCmd(args) {
  const rawArgs = rawCommandArgs("expr");
  if (rawArgs?.length === args.length) args = rawArgs.map(decodeExprArgument);
  if (args[0] === "--") args = args.slice(1);
  if (!args.length) throw new InvocationError("missing operand", 2);
  const parser = new ExprParser(args);
  const result = parser.parse();
  stdout(`${formatExprValue(result)}\n`);
  return exprTruthy(result) ? 0 : 1;
}

export function decodeExprArgument(bytes) {
  if (isUtf8Locale()) return decodeSurrogateEscapedBytes(bytes);
  let text = "";
  for (const byte of bytes) text += byte < 0x80 ? String.fromCharCode(byte) : String.fromCharCode(0xdc00 + byte);
  return text;
}

export class ExprParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  parse() {
    const value = this.parseOr();
    if (this.peek() != null) throw new InvocationError(`syntax error: unexpected argument ${localeQuotedDiagnostic(this.peek())}`, 2, false);
    return value;
  }

  peek() {
    return this.tokens[this.index];
  }

  take() {
    return this.tokens[this.index++];
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek() === "|") {
      const op = this.take();
      this.requireArgumentAfter(op);
      if (exprTruthy(left)) {
        this.skipExpression(1);
        left = formatExprValue(left);
      } else {
        const right = this.parseAnd();
        left = exprTruthy(right) ? right : 0n;
      }
    }
    return left;
  }

  parseAnd() {
    let left = this.parseCompare();
    while (this.peek() === "&") {
      const op = this.take();
      this.requireArgumentAfter(op);
      if (!exprTruthy(left)) {
        this.skipExpression(2);
        left = 0n;
      } else {
        const right = this.parseCompare();
        left = exprTruthy(right) ? left : 0n;
      }
    }
    return left;
  }

  parseCompare() {
    let left = this.parseAdd();
    while (["=", "!=", "<", "<=", ">", ">="].includes(this.peek())) {
      const op = this.take();
      this.requireArgumentAfter(op);
      const right = this.parseAdd();
      left = exprCompare(left, right, op) ? 1n : 0n;
    }
    return left;
  }

  parseAdd() {
    let left = this.parseMul();
    while (this.peek() === "+" || this.peek() === "-") {
      const op = this.take();
      this.requireArgumentAfter(op);
      const right = this.parseMul();
      left = op === "+" ? exprInteger(left) + exprInteger(right) : exprInteger(left) - exprInteger(right);
    }
    return left;
  }

  parseMul() {
    let left = this.parseMatch();
    while (this.peek() === "*" || this.peek() === "/" || this.peek() === "%") {
      const op = this.take();
      this.requireArgumentAfter(op);
      const right = this.parseMatch();
      const a = exprInteger(left);
      const b = exprInteger(right);
      if ((op === "/" || op === "%") && b === 0n) throw new InvocationError("division by zero", 2, false);
      left = op === "*" ? a * b : op === "/" ? a / b : a % b;
    }
    return left;
  }

  parseMatch() {
    let left = this.parsePrimary();
    while (this.peek() === ":") {
      this.take();
      this.requireArgumentAfter(":");
      left = exprRegexMatch(formatExprValue(left), formatExprValue(this.parsePrimary()));
    }
    return left;
  }

  parsePrimary() {
    const token = this.take();
    if (token == null) throw new InvocationError("syntax error: missing argument", 2, false);
    if (token === "+") {
      this.requireArgumentAfter(token);
      return this.take();
    }
    if (token === "(") {
      const value = this.parseOr();
      if (this.peek() !== ")") {
        const previous = this.tokens[this.index - 1];
        throw new InvocationError(`syntax error: expecting ')' ${this.peek() == null ? `after ${localeQuotedDiagnostic(previous)}` : `instead of ${localeQuotedDiagnostic(this.peek())}`}`, 2, false);
      }
      this.take();
      return value;
    }
    if (token === "length") {
      this.requireArgumentAfter(token);
      return BigInt([...formatExprValue(this.parsePrimary())].length);
    }
    if (token === "index") {
      this.requireArgumentAfter(token);
      const text = formatExprValue(this.parsePrimary());
      this.requireArgumentAfter(text);
      return BigInt(exprIndex(text, formatExprValue(this.parsePrimary())));
    }
    if (token === "substr") {
      this.requireArgumentAfter(token);
      const text = formatExprValue(this.parsePrimary());
      this.requireArgumentAfter(text);
      const startValue = this.parsePrimary();
      this.requireArgumentAfter(formatExprValue(startValue));
      const start = exprSubstrInteger(startValue);
      const length = exprSubstrInteger(this.parsePrimary());
      if (start == null || length == null || start <= 0 || length <= 0) return "";
      return [...text].slice(start - 1, start - 1 + length).join("");
    }
    if (token === "match") {
      this.requireArgumentAfter(token);
      const text = formatExprValue(this.parsePrimary());
      this.requireArgumentAfter(text);
      return exprRegexMatch(text, formatExprValue(this.parsePrimary()));
    }
    if (token === ")") throw new InvocationError("syntax error: unexpected ')'", 2, false);
    return token;
  }

  requireArgumentAfter(token) {
    if (this.peek() == null) throw new InvocationError(`syntax error: missing argument after ${localeQuotedDiagnostic(token)}`, 2, false);
  }

  skipExpression(minPrecedence = 0) {
    let depth = 0;
    while (this.peek() != null) {
      const token = this.peek();
      if (token === "(") depth++;
      else if (token === ")") {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && exprOperatorPrecedence(token) < minPrecedence) {
        break;
      }
      this.take();
    }
  }
}

export function exprOperatorPrecedence(token) {
  return token === "|" ? 1 : token === "&" ? 2 : ["=", "!=", "<", "<=", ">", ">="].includes(token) ? 3 : ["+", "-"].includes(token) ? 4 : ["*", "/", "%"].includes(token) ? 5 : token === ":" ? 6 : 99;
}

export function exprInteger(value) {
  const text = formatExprValue(value);
  if (!/^-?\d+$/.test(text)) throw new InvocationError("non-integer argument", 2, false);
  return BigInt(text);
}

export function exprSubstrInteger(value) {
  const text = formatExprValue(value);
  return /^-?\d+$/.test(text) ? Number(BigInt(text)) : null;
}

export function exprCompare(left, right, op) {
  const a = formatExprValue(left);
  const b = formatExprValue(right);
  const ai = /^-?\d+$/.test(a) ? BigInt(a) : null;
  const bi = /^-?\d+$/.test(b) ? BigInt(b) : null;
  const cmp = ai != null && bi != null ? (ai < bi ? -1 : ai > bi ? 1 : 0) : a < b ? -1 : a > b ? 1 : 0;
  return op === "=" ? cmp === 0 : op === "!=" ? cmp !== 0 : op === "<" ? cmp < 0 : op === "<=" ? cmp <= 0 : op === ">" ? cmp > 0 : cmp >= 0;
}

export function exprTruthy(value) {
  const text = formatExprValue(value);
  return text !== "" && !/^-?0+$/.test(text);
}

export function formatExprValue(value) {
  return typeof value === "bigint" ? String(value) : String(value);
}

export function exprIndex(text, chars) {
  const haystack = [...text];
  const needles = new Set([...chars]);
  const index = haystack.findIndex((ch) => needles.has(ch));
  return index === -1 ? 0 : index + 1;
}

export function exprRegexMatch(text, pattern) {
  if (isUtf8Locale() && /[\uDC80-\uDCFF]/u.test(text)) return pattern.includes("\\(") ? "" : 0;
  let regex;
  try {
    regex = new RegExp(`^(?:${exprBasicRegex(pattern)})`, "s");
  } catch (error) {
    if (error instanceof InvocationError) throw error;
    throw new InvocationError(regexErrorMessage(error), 2, false);
  }
  const match = String(text).match(regex);
  if (!match) return pattern.includes("\\(") ? "" : 0;
  return match.length > 1 ? match[1] ?? "" : match[0].length;
}

export function exprBasicRegex(pattern) {
  let out = "";
  let groups = 0;
  let inBracket = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch !== "\\") {
      if (ch === "[") {
        inBracket = true;
        out += ch;
        continue;
      }
      if (ch === "]") {
        inBracket = false;
        out += ch;
        continue;
      }
      if (inBracket) {
        out += ch;
        continue;
      }
      if ("()+?|{}".includes(ch)) out += `\\${ch}`;
      else if (ch === "^" && i !== 0 && !out.endsWith("(")) out += "\\^";
      else if (ch === "$" && i !== pattern.length - 1 && pattern.slice(i + 1, i + 3) !== "\\)") out += "\\$";
      else if (ch === "*" && i === 0 && pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
      }
      else if (ch === "*" && (out === "" || out.endsWith("(") || out.endsWith("|") || out.endsWith("^"))) out += "\\*";
      else if (ch === "*" && pattern[i + 1] === "*") {
        out += "*";
        while (pattern[i + 1] === "*") i++;
      }
      else out += ch;
      continue;
    }
    const next = pattern[++i];
    if (next == null) throw new InvocationError("Trailing backslash", 2, false);
    else if (inBracket && next === "-") out += "\\\\-";
    else if (next === "(") {
      groups++;
      out += "(";
    } else if (next === ")") {
      if (groups === 0) throw new InvocationError("Unmatched ) or \\)", 2, false);
      groups--;
      out += ")";
    }
    else if (next === "{") {
      if (!exprCanApplyInterval(out)) {
        out += "\\{";
      } else {
        const parsed = parseExprInterval(pattern, i + 1);
        out += parsed.interval;
        i = parsed.end;
      }
    } else if (next === "}") out += "\\}";
    else if (next === "|") out += "|";
    else if ("+?".includes(next)) out += `\\${next}`;
    else out += `\\${next}`;
  }
  if (groups > 0) throw new InvocationError("Unmatched ( or \\(", 2, false);
  return normalizeExprQuantifiers(exprNormalizePosixClasses(out));
}

export const EXPR_POSIX_CLASSES = {
  alnum: "A-Za-z0-9",
  alpha: "A-Za-z",
  blank: " \\t",
  cntrl: "\\x00-\\x1F\\x7F",
  digit: "0-9",
  graph: "\\x21-\\x7E",
  lower: "a-z",
  print: "\\x20-\\x7E",
  punct: "!\"#$%&'()*+,\\-./:;<=>?@[\\\\\\]^_`{|}~",
  space: " \\t\\n\\r\\f\\v",
  upper: "A-Z",
  xdigit: "A-Fa-f0-9",
};

export function exprNormalizePosixClasses(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "[") {
      out += pattern[i];
      continue;
    }
    const end = exprBracketEnd(pattern, i);
    if (end == null) {
      out += pattern.slice(i);
      break;
    }
    const body = pattern.slice(i + 1, end)
      .replace(/\[([=.])(.+?)\1\]/g, (_, _kind, value) => {
        if ([...value].length !== 1) throw new InvocationError("Invalid collation character", 2, false);
        return value.replace(/[\\\]\^-]/g, "\\$&");
      })
      .replace(/\[:([A-Za-z]+):\]/g, (_, name) => {
      const normalized = EXPR_POSIX_CLASSES[name];
      if (normalized == null) throw new InvocationError("Invalid character class name", 2, false);
      return normalized;
    });
    out += exprNormalizeBracketBody(body);
    i = end;
  }
  return out;
}

export function exprNormalizeBracketBody(body) {
  const negated = body.startsWith("^");
  const prefix = negated ? "^" : "";
  const text = negated ? body.slice(1) : body;
  let normalized = "";
  for (let i = 0; i < text.length; i++) {
    if (i + 2 < text.length && text[i + 1] === "-" && text.charCodeAt(i) > text.charCodeAt(i + 2)) {
      i += 2;
      continue;
    }
    normalized += text[i];
  }
  if (normalized.startsWith("]")) normalized = `\\${normalized}`;
  if (normalized.endsWith("\\")) normalized += "\\";
  if (normalized === "") return negated ? "[\\s\\S]" : "[^\\s\\S]";
  return `[${prefix}${normalized}]`;
}

export function exprBracketEnd(pattern, start) {
  for (let i = start + 1; i < pattern.length; i++) {
    if (i === start + 1 && pattern[i] === "]") continue;
    if (i === start + 2 && pattern[start + 1] === "^" && pattern[i] === "]") continue;
    if (pattern[i] === "[" && pattern[i + 1] === ":") {
      const end = pattern.indexOf(":]", i + 2);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    if (pattern[i] === "[" && (pattern[i + 1] === "=" || pattern[i + 1] === ".")) {
      const end = pattern.indexOf(`${pattern[i + 1]}]`, i + 2);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    if (pattern[i] === "]") return i;
  }
  return null;
}

export function exprCanApplyInterval(out) {
  return out !== "" && !out.endsWith("(") && !out.endsWith("|") && !out.endsWith("^");
}

export function parseExprInterval(pattern, start) {
  const end = pattern.indexOf("\\}", start);
  if (end === -1) throw new InvocationError("Unmatched \\{", 2, false);
  const body = pattern.slice(start, end);
  const match = body.match(/^(\d*)(?:,(\d*))?$/);
  if (!match || (match[1] === "" && match[2] == null)) throw new InvocationError("Invalid content of \\{\\}", 2, false);
  const min = match[1] === "" ? 0 : Number(match[1]);
  const max = match[2] == null || match[2] === "" ? null : Number(match[2]);
  if (min > 32767 || (max != null && max > 32767) || (max != null && min > max)) throw new InvocationError("Invalid content of \\{\\}", 2, false);
  const interval = match[2] == null
    ? `{${match[1]}}`
    : match[1] === "" && match[2] === ""
      ? "*"
      : `{${match[1] === "" ? "0" : match[1]},${match[2]}}`;
  return { interval, end: end + 1 };
}

export function normalizeExprQuantifiers(pattern) {
  let out = pattern.replace(/\*\{1\}/g, "*");
  out = out.replace(/\{1\}\*/g, "*");
  out = out.replace(/\{0,1\}\*/g, "*");
  out = out.replace(/\{1\}\{1\}/g, "{1}");
  out = out.replace(/\*\*\*/g, "*").replace(/\*\*/g, "*");
  return out;
}

export function regexErrorMessage(error) {
  const message = String(error?.message ?? "");
  if (/missing terminating \] for character class/i.test(message)) return "Invalid regular expression";
  if (/unterminated group|unmatched/i.test(message)) return "Unmatched ( or \\(";
  if (/lone quantifier brackets|numbers out of order|incomplete quantifier/i.test(message)) return "Invalid content of \\{\\}";
  return message.replace(/^Invalid regular expression: \/\^\(\?:.*?\)\/s: /, "Invalid regular expression: ");
}

const singleCall = defineCommand("expr", exprCmd, (args) => args.length === 1 && (args[0] === "--help" || args[0] === "--version") ? args[0] : null);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
