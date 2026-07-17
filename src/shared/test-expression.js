import { constants as fsConstants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { fdStat, localeQuotedDiagnostic, localeQuotedEscapedDiagnostic } from "./common.js";
import { fail } from "./diagnostics.js";

export async function testExpressionStatus(args, program = "test") {
  if (args[0] === "[") args = args.slice(1);
  if (args.at(-1) === "]") args = args.slice(0, -1);
  if (args.length === 0) return 1;
  try {
    const arity = await testByArity(args);
    if (arity != null) return arity ? 0 : 1;
    const parsed = await parseTestOr(args, 0);
    if (parsed.index !== args.length) throw new TestExpressionError(`extra argument ${localeQuotedDiagnostic(args[parsed.index])}`);
    return parsed.value ? 0 : 1;
  } catch (error) {
    if (error instanceof TestExpressionError) return fail(program, error.message, 2);
    throw error;
  }
}

export class TestExpressionError extends Error {}

export async function parseTestOr(args, index) {
  let left = await parseTestAnd(args, index);
  while (args[left.index] === "-o") {
    const right = await parseTestAnd(args, left.index + 1);
    left = { value: left.value || right.value, index: right.index };
  }
  return left;
}

export async function parseTestAnd(args, index) {
  let left = await parseTestNot(args, index);
  while (args[left.index] === "-a") {
    const right = await parseTestNot(args, left.index + 1);
    left = { value: left.value && right.value, index: right.index };
  }
  return left;
}

export async function parseTestNot(args, index) {
  if (args[index] === "!") {
    const value = await parseTestOr(args, index + 1);
    return { value: !value.value, index: value.index };
  }
  return parseTestPrimary(args, index);
}

export async function testByArity(args) {
  if (args.length === 1) return args[0].length > 0;
  if (args.length === 2) {
    if (args[0] === "!") return args[1].length === 0;
    if (args[0] === "-o") throw new TestExpressionError(`${localeQuotedDiagnostic("-o")}: unary operator expected`);
    if (isTestUnaryOperator(args[0])) return testUnaryExpression(args[0], args[1]);
    return null;
  }
  if (args.length === 3) {
    if (isTestBinaryOperator(args[1])) return testBinaryExpression(args[0], args[1], args[2]);
    if (args[0] === "!") {
      const value = await testByArity(args.slice(1));
      if (value != null) return !value;
    }
    if (args[0] === "(" && args[2] === ")") return args[1].length > 0;
    return null;
  }
  if (args.length === 4) {
    if (args[0] === "!") {
      const value = await testByArity(args.slice(1));
      if (value != null) return !value;
    }
    if (args[0] === "(" && args[3] === ")") {
      const value = await testByArity(args.slice(1, 3));
      if (value != null) return value;
    }
  }
  return null;
}

export async function parseTestPrimary(args, index) {
  if (index >= args.length) throw new TestExpressionError("missing argument after operator");
  if (args[index] === "(") {
    const close = args.at(-1) === ")" ? args.length - 1 : findTestClosingParen(args, index);
    if (close !== -1) {
      const arity = await testByArity(args.slice(index + 1, close));
      if (arity != null) return { value: arity, index: close + 1 };
    }
    const value = await parseTestOr(args, index + 1);
    if (args[value.index] !== ")") throw new TestExpressionError(`missing ${localeQuotedDiagnostic(")")}`);
    return { value: value.value, index: value.index + 1 };
  }
  if (args[index + 1] && isTestBinaryOperator(args[index + 1])) {
    return { value: await testBinaryExpression(args[index], args[index + 1], args[index + 2]), index: index + 3 };
  }
  if (isTestUnaryOperator(args[index])) {
    if (args[index + 1] == null) return { value: String(args[index]).length > 0, index: index + 1 };
    return { value: await testUnaryExpression(args[index], args[index + 1]), index: index + 2 };
  }
  if (args[index] === ")") throw new TestExpressionError(`unexpected ${localeQuotedDiagnostic(")")}`);
  return { value: String(args[index]).length > 0, index: index + 1 };
}

export function findTestClosingParen(args, index) {
  let depth = 0;
  for (let i = index; i < args.length; i++) {
    if (args[i] === "(") depth++;
    else if (args[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function isTestUnaryOperator(op) {
  return ["-a", "-b", "-c", "-d", "-e", "-f", "-g", "-G", "-h", "-k", "-L", "-N", "-n", "-O", "-p", "-r", "-S", "-s", "-t", "-u", "-w", "-x", "-z"].includes(op);
}

export function isTestBinaryOperator(op) {
  return ["=", "==", "!=", "<", ">", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-ef", "-nt", "-ot"].includes(op);
}

export async function testUnaryExpression(op, value) {
  if (op === "-a" || op === "-e") return await access(value).then(() => true, () => false);
  if (op === "-n") return value.length > 0;
  if (op === "-z") return value.length === 0;
  if (op === "-t") return testFdIsTerminal(value);
  return await testUnaryFile(op, value) === 0;
}

export async function testBinaryExpression(a, op, b) {
  if (b == null) throw new TestExpressionError(`missing argument after ${localeQuotedDiagnostic(op)}`);
  if (op === "=" || op === "==") return a === b;
  if (op === "!=") return a !== b;
  if (op === "<") return a < b;
  if (op === ">") return a > b;
  if (["-eq", "-ne", "-lt", "-le", "-gt", "-ge"].includes(op)) {
    const left = parseTestInteger(a);
    const right = parseTestInteger(b);
    return ({ "-eq": left === right, "-ne": left !== right, "-lt": left < right, "-le": left <= right, "-gt": left > right, "-ge": left >= right })[op];
  }
  if (["-ef", "-nt", "-ot"].includes(op)) return await testBinaryFile(a, op, b) === 0;
  throw new TestExpressionError(`${localeQuotedDiagnostic(op)}: binary operator expected`);
}

export function parseTestInteger(value) {
  const text = String(value);
  if (!/^\s*[+-]?\d+\s*$/.test(text)) throw new TestExpressionError(`invalid integer ${localeQuotedEscapedDiagnostic(text)}`);
  return BigInt(text.trim());
}

export function testFdIsTerminal(value) {
  const fd = Number(value);
  if (!Number.isInteger(fd) || fd < 0) return false;
  const s = fdStat(fd);
  return Boolean(s?.isCharacterDevice());
}

export async function testUnaryFile(op, path) {
  try {
    if (op === "-r") return await access(path, fsConstants.R_OK).then(() => 0, () => 1);
    if (op === "-w") return await access(path, fsConstants.W_OK).then(() => 0, () => 1);
    if (op === "-x") return await access(path, fsConstants.X_OK).then(() => 0, () => 1);
    if (op === "-N") {
      const s = await stat(path, { bigint: true });
      return testStatTimeNs(s, "mtime") > testStatTimeNs(s, "atime") ? 0 : 1;
    }
    const s = op === "-h" || op === "-L" ? await lstat(path) : await stat(path);
    const mode = s.mode;
    if (op === "-b") return s.isBlockDevice() ? 0 : 1;
    if (op === "-c") return s.isCharacterDevice() ? 0 : 1;
    if (op === "-d") return s.isDirectory() ? 0 : 1;
    if (op === "-f") return s.isFile() ? 0 : 1;
    if (op === "-g") return (mode & 0o2000) ? 0 : 1;
    if (op === "-G") return process.getgid && s.gid === process.getgid() ? 0 : 1;
    if (op === "-h" || op === "-L") return s.isSymbolicLink() ? 0 : 1;
    if (op === "-k") return (mode & 0o1000) ? 0 : 1;
    if (op === "-O") return process.getuid && s.uid === process.getuid() ? 0 : 1;
    if (op === "-p") return s.isFIFO() ? 0 : 1;
    if (op === "-S") return s.isSocket() ? 0 : 1;
    if (op === "-s") return s.size > 0 ? 0 : 1;
    if (op === "-u") return (mode & 0o4000) ? 0 : 1;
    return 1;
  } catch {
    return 1;
  }
}

export async function testBinaryFile(left, op, right) {
  const [a, b] = await Promise.all([stat(left, { bigint: true }).catch(() => null), stat(right, { bigint: true }).catch(() => null)]);
  if (!a || !b) {
    if (op === "-nt") return a && !b ? 0 : 1;
    if (op === "-ot") return !a && b ? 0 : 1;
    return 1;
  }
  if (op === "-ef") return a.dev === b.dev && a.ino === b.ino ? 0 : 1;
  if (op === "-nt") return testStatTimeNs(a, "mtime") > testStatTimeNs(b, "mtime") ? 0 : 1;
  if (op === "-ot") return testStatTimeNs(a, "mtime") < testStatTimeNs(b, "mtime") ? 0 : 1;
  return 1;
}

export function testStatTimeNs(statInfo, name) {
  const value = statInfo[`${name}Ns`];
  if (value != null) return BigInt(value);
  return BigInt(statInfo[`${name}Ms`]) * 1_000_000n;
}
