#!/usr/bin/env bun

import { stat } from "node:fs/promises";
import { basename as pathBasename } from "node:path";
import { BNU_SIGPIPE_DEFAULT_ENV, changeDirectory, invalidOptionMessage, libc, localeQuotedEscapedDiagnostic, pathDisplayName, resolveEnvCommand, shellEscapeLsName, writeEnvironment } from "../shared/common.js";
import { InvocationError, stderr } from "../shared/diagnostics.js";
import { SIGNAL_NAMES, SIG_IGN, execCommand, isDirectCommandInvocation, normalizeInvocationLongOptionByPrefix, signalDisplayName, signalNumberFromOperand } from "../shared/process.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const SIG_DFL = 0;

export const ENV_LONG_OPTIONS = ["argv0", "block-signal", "chdir", "debug", "default-signal", "help", "ignore-environment", "ignore-signal", "list-signal-handling", "null", "split-string", "unset", "version"];

export function envMetaOption(args) {
  let sawAssignment = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    const normalized = arg.startsWith("--") ? normalizeInvocationLongOptionByPrefix(arg, ENV_LONG_OPTIONS) : arg;
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (sawAssignment) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
      return null;
    }
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new InvocationError(`option '--${name}' doesn't allow an argument`);
      return normalized;
    }
    if (arg === "-") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
      sawAssignment = true;
      continue;
    }
    if (normalized.startsWith("--") && ["--ignore-environment", "--null", "--debug", "--list-signal-handling"].includes(`--${name}`)) {
      if (inlineValue !== undefined) throw new InvocationError(`option '--${name}' doesn't allow an argument`);
      continue;
    }
    if (["-i", "-0", "-v"].includes(normalized)) continue;
    if (["--default-signal", "--ignore-signal", "--block-signal"].includes(normalized)) continue;
    if (["-a", "--argv0", "-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(normalized)) {
      i++;
      continue;
    }
    if (/^-(a|u|C|S).+/.test(arg) || /^--(argv0|unset|chdir|split-string|default-signal|ignore-signal|block-signal)=/.test(normalized)) continue;
    if (arg.startsWith("-v") && /\s/.test(arg[2] ?? "")) throw new InvocationError(`invalid option -- '${arg[2]}'\nenv: use -[v]S to pass options in shebang lines`);
    if (arg.startsWith("-")) throw new InvocationError(invalidOptionMessage(arg));
    return null;
  }
  return null;
}

export async function env(args) {
  const originalEnv = { ...process.env };
  const childEnv = { ...process.env };
  const command = [];
  let cwd = process.cwd();
  let sep = "\n";
  let argv0;
  let verbose = false;
  let nullOutput = false;
  let sawChdir = false;
  let sawAssignment = false;
  let parseEnvOptions = true;
  let listSignalHandling = false;
  const signalActions = new Map();
  const requireValue = (index, option) => {
    if (index + 1 < args.length) return args[index + 1];
    if (option.startsWith("--")) throw new InvocationError(`option '${option}' requires an argument`);
    throw new InvocationError(`option requires an argument -- '${option.slice(1)}'`);
  };
  for (let i = 0; i < args.length; i++) {
    const rawArg = args[i];
    const arg = parseEnvOptions && rawArg !== "--" && rawArg.startsWith("--") ? normalizeInvocationLongOptionByPrefix(rawArg, ENV_LONG_OPTIONS) : rawArg;
    if (parseEnvOptions && sawAssignment && !arg.includes("=")) {
      command.push(...args.slice(i));
      break;
    } else if (parseEnvOptions && (arg === "-" || arg === "-i" || arg === "--ignore-environment")) {
      for (const key of Object.keys(childEnv)) delete childEnv[key];
    } else if (parseEnvOptions && arg === "--") {
      if (sawAssignment) {
        command.push(...args.slice(i));
        break;
      }
      parseEnvOptions = false;
    } else if (parseEnvOptions && (arg === "-a" || arg === "--argv0")) {
      argv0 = requireValue(i, arg);
      i++;
    } else if (parseEnvOptions && arg.startsWith("-a") && arg !== "-a") {
      argv0 = arg.slice(2);
    } else if (parseEnvOptions && arg.startsWith("--argv0=")) {
      argv0 = arg.slice("--argv0=".length);
    } else if (parseEnvOptions && (arg === "-0" || arg === "--null")) {
      sep = "\0";
      nullOutput = true;
    } else if (parseEnvOptions && (arg === "-v" || arg === "--debug")) {
      verbose = true;
    } else if (parseEnvOptions && (arg === "-u" || arg === "--unset")) {
      const name = requireValue(i, arg);
      i++;
      validateEnvUnsetName(name);
      delete childEnv[name];
    } else if (parseEnvOptions && arg.startsWith("-u") && arg !== "-u") {
      const name = arg.slice(2);
      validateEnvUnsetName(name);
      delete childEnv[name];
    } else if (parseEnvOptions && arg.startsWith("--unset=")) {
      const name = arg.slice("--unset=".length);
      validateEnvUnsetName(name);
      delete childEnv[name];
    } else if (parseEnvOptions && (arg === "-C" || arg === "--chdir")) {
      cwd = requireValue(i, arg);
      i++;
      sawChdir = true;
    } else if (parseEnvOptions && arg.startsWith("-C") && arg !== "-C") {
      cwd = arg.slice(2);
      sawChdir = true;
    } else if (parseEnvOptions && arg.startsWith("--chdir=")) {
      cwd = arg.slice("--chdir=".length);
      sawChdir = true;
    } else if (parseEnvOptions && (arg === "-S" || arg === "--split-string")) {
      args.splice(i + 1, 1, ...splitEnvString(requireValue(i, arg), originalEnv));
    } else if (parseEnvOptions && arg.startsWith("-S") && arg !== "-S") {
      args.splice(i, 1, ...splitEnvString(arg.slice(2), originalEnv));
      i--;
    } else if (parseEnvOptions && arg.startsWith("-vS")) {
      verbose = true;
      args.splice(i, 1, ...splitEnvString(arg.slice(3), originalEnv));
      i--;
    } else if (parseEnvOptions && arg.startsWith("-v") && /\s/.test(arg[2] ?? "")) {
      throw new InvocationError(`invalid option -- '${arg[2]}'\nenv: use -[v]S to pass options in shebang lines`);
    } else if (parseEnvOptions && arg.startsWith("--split-string=")) {
      args.splice(i, 1, ...splitEnvString(arg.slice("--split-string=".length), originalEnv));
      i--;
    } else if (parseEnvOptions && (arg === "--default-signal" || arg === "--ignore-signal" || arg === "--block-signal")) {
      applyEnvSignalOption(signalActions, arg.slice(2), "");
    } else if (parseEnvOptions && arg.startsWith("--default-signal=")) {
      applyEnvSignalOption(signalActions, "default-signal", arg.slice("--default-signal=".length));
    } else if (parseEnvOptions && arg.startsWith("--ignore-signal=")) {
      applyEnvSignalOption(signalActions, "ignore-signal", arg.slice("--ignore-signal=".length));
    } else if (parseEnvOptions && arg.startsWith("--block-signal=")) {
      applyEnvSignalOption(signalActions, "block-signal", arg.slice("--block-signal=".length));
    } else if (parseEnvOptions && arg === "--list-signal-handling") {
      listSignalHandling = true;
    } else if (parseEnvOptions && arg.startsWith("-")) {
      throw new InvocationError(invalidOptionMessage(arg));
    } else if (arg.includes("=") && command.length === 0) {
      const idx = arg.indexOf("=");
      childEnv[arg.slice(0, idx)] = arg.slice(idx + 1);
      sawAssignment = true;
    } else {
      command.push(...args.slice(i));
      break;
    }
  }
  if (!command.length) {
    if (sawChdir) throw new InvocationError("must specify command with --chdir (-C)");
    writeEnvironment(childEnv, sep);
    return 0;
  }
  if (nullOutput) throw new InvocationError("cannot specify --null (-0) with command");
  if (sawChdir && !(await stat(cwd).catch(() => null))?.isDirectory()) throw new InvocationError(`cannot change directory to ${shellEscapeLsName(pathDisplayName(cwd), true)}: No such file or directory`, 125, false);
  if (command.length === 1 && pathBasename(command[0]) === "env") {
    writeEnvironment(childEnv, "\n");
    return 0;
  }
  if (verbose) {
    try {
      if (argv0 != null) stderr(`argv0:     '${argv0}'\n`);
      stderr(`executing: ${command[0]}\n`);
      if (argv0 != null) stderr(`   arg[0]= '${argv0}'\n`);
    } catch {}
  }
  if (listSignalHandling) writeEnvSignalHandling(signalActions);
  applyEnvSignalEnvironment(childEnv, signalActions);
  const signalRestorers = applyEnvSignalActions(signalActions);
  try {
    const executable = await resolveEnvCommand(command[0], childEnv, cwd);
    if (isDirectCommandInvocation()) {
      if (sawChdir) changeDirectory(cwd);
      const execError = execCommand(command, { executable, env: childEnv, argv0 });
      const error = new Error(execError.message);
      error.code = execError.errno === 2 ? "ENOENT" : execError.errno === 13 ? "EACCES" : "EIO";
      throw error;
    }
    const proc = Bun.spawn([executable, ...command.slice(1)], { cwd, env: childEnv, stdin: "inherit", stdout: "inherit", stderr: "inherit", ...(argv0 != null ? { argv0 } : {}) });
    const signalHandlers = installChildSignalForwarders(proc, signalActions);
    try {
      return await proc.exited;
    } finally {
      removeChildSignalForwarders(signalHandlers);
      restoreEnvSignalActions(signalRestorers);
    }
  } catch (error) {
    restoreEnvSignalActions(signalRestorers);
    const message = error?.code === "ENOENT" ? `No such file or directory` : error?.code === "EACCES" ? "Permission denied" : error?.message || String(error);
    const needsShebangHint = /\s/.test(command[0]);
    stderr(`env: '${command[0]}': ${message}\n`);
    if (needsShebangHint) stderr("env: use -[v]S to pass options in shebang lines\n");
    return error?.code === "ENOENT" ? 127 : 126;
  }
}

export function applyEnvSignalOption(actions, option, value) {
  const action = option === "ignore-signal" ? "ignore" : option === "default-signal" ? "default" : "block";
  for (const signum of expandEnvSignalOperand(value)) actions.set(signum, action);
}

export function expandEnvSignalOperand(value) {
  if (value == null || value === "") return envSignalNumbers();
  const signals = [];
  for (const part of String(value).split(",")) {
    const signum = signalNumberFromOperand(part);
    if (signum <= 0) throw new InvocationError(`'${part}': invalid signal`, 125, true);
    signals.push(signum);
  }
  return signals;
}

export function envSignalNumbers() {
  const signals = [];
  for (let i = 1; i < SIGNAL_NAMES.length; i++) {
    if (i !== 9 && i !== 19 && i !== 30) signals.push(i);
  }
  signals.push(34, 64);
  return signals;
}

export function writeEnvSignalHandling(actions) {
  for (const [signum, action] of actions) {
    if (action === "ignore") stderr(`${signalDisplayName(signum)}: IGNORE\n`);
  }
}

export function applyEnvSignalEnvironment(childEnv, actions) {
  if (actions.get(signalNumberFromOperand("PIPE")) === "default") childEnv[BNU_SIGPIPE_DEFAULT_ENV] = "1";
}

export function applyEnvSignalActions(actions) {
  const restorers = [];
  for (const [signum, action] of actions) {
    if (action === "block") continue;
    const handler = action === "ignore" ? SIG_IGN : SIG_DFL;
    const previous = libc.symbols.signal(signum, handler);
    restorers.push([signum, previous]);
  }
  return restorers;
}

export function restoreEnvSignalActions(restorers) {
  for (let i = restorers.length - 1; i >= 0; i--) {
    const [signum, previous] = restorers[i];
    libc.symbols.signal(signum, previous);
  }
}

export function installChildSignalForwarders(proc, signalActions = new Map()) {
  const handlers = [];
  const forwardSignals = [
    "SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM", "SIGALRM", "SIGUSR1", "SIGUSR2",
    "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGIO", "SIGPWR", "SIGSYS",
  ];
  for (const signal of forwardSignals) {
    const signum = signalNumber(signal);
    if (signalActions.get(signum) === "ignore") continue;
    const handler = () => {
      proc.kill(signal);
    };
    try {
      process.on(signal, handler);
      handlers.push([signal, handler]);
    } catch {}
  }
  return handlers;
}

export function removeChildSignalForwarders(handlers) {
  for (const [signal, handler] of handlers) process.off(signal, handler);
}

export function signalNumber(signal) {
  return signalNumberFromOperand(signal);
}

export function validateEnvUnsetName(name) {
  if (name == null) throw new InvocationError("option requires an argument -- 'u'");
  if (name === "" || name.includes("=")) throw new InvocationError(`cannot unset ${localeQuotedEscapedDiagnostic(name)}: Invalid argument`, 125, false);
}

export function splitEnvString(value, env = process.env) {
  const out = [];
  let current = "";
  let started = false;
  let quote = null;
  const text = String(value);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else if (ch === "\\" && (text[i + 1] === "\\" || text[i + 1] === "'")) current += text[++i];
      else current += ch;
      started = true;
    } else if (quote === "\"") {
      if (ch === "\"") {
        quote = null;
        started = true;
      } else if (ch === "\\") {
        const parsed = parseEnvEscape(text, i, true);
        if (parsed.stop) throw new InvocationError("'\\c' must not appear in double-quoted -S string", 125, false);
        current += parsed.value;
        started = true;
        i = parsed.index;
      } else if (ch === "$") {
        const expanded = expandEnvSplitVariable(text, i, env);
        current += expanded.value;
        started = true;
        i = expanded.index;
      } else {
        current += ch;
        started = true;
      }
    } else if (ch === "'" || ch === "\"") {
      quote = ch;
      started = true;
    } else if (ch === "#") {
      if (!started) break;
      current += ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        out.push(current);
        current = "";
        started = false;
      }
    } else if (ch === "\\") {
      const parsed = parseEnvEscape(text, i, false);
      if (parsed.stop) break;
      if (parsed.separator) {
        if (started) {
          out.push(current);
          current = "";
          started = false;
        }
      } else {
        current += parsed.value;
        started = true;
      }
      i = parsed.index;
    } else if (ch === "$") {
      const expanded = expandEnvSplitVariable(text, i, env);
      current += expanded.value;
      started = true;
      i = expanded.index;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new InvocationError("no terminating quote in -S string", 125, false);
  if (started) out.push(current);
  return out;
}

export function parseEnvEscape(text, index, doubleQuoted) {
  if (index + 1 >= text.length) throw new InvocationError("invalid backslash at end of string in -S", 125, false);
  const ch = text[index + 1];
  if (ch === "c") return { stop: true, index: index + 1 };
  if (ch === "_") return doubleQuoted ? { value: " ", index: index + 1 } : { separator: true, index: index + 1 };
  const escapes = { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v", "\\": "\\", "\"": "\"", "'": "'", "$": "$", "#": "#" };
  if (escapes[ch] == null) throw new InvocationError(`invalid sequence '\\${ch}' in -S`, 125, false);
  return { value: escapes[ch], index: index + 1 };
}

export function expandEnvSplitVariable(text, index, env) {
  if (text[index + 1] !== "{") throw new InvocationError(`only \${VARNAME} expansion is supported, error at: ${text.slice(index)}`, 125, false);
  const end = text.indexOf("}", index + 2);
  if (end === -1) throw new InvocationError(`only \${VARNAME} expansion is supported, error at: ${text.slice(index)}`, 125, false);
  const name = text.slice(index + 2, end);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new InvocationError(`only \${VARNAME} expansion is supported, error at: ${text.slice(index, end + 1)}`, 125, false);
  return { value: env[name] ?? "", index: end };
}

const singleCall = defineCommand("env", env, envMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
