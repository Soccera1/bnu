#!/usr/bin/env bun

import { invalidOptionMessage, libc, localeQuotedEscapedDiagnostic, resolveEnvCommand } from "../shared/common.js";
import { InvocationError, stderr } from "../shared/diagnostics.js";
import { normalizeInvocationLongOptionByPrefix, parseDuration, signalDisplayName, signalNumberFromOperand } from "../shared/process.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export function timeoutMetaOption(args) {
  const longOptions = ["foreground", "kill-after", "preserve-status", "signal", "verbose", "help", "version"];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return null;
    const normalized = arg.startsWith("--") ? normalizeInvocationLongOptionByPrefix(arg, longOptions) : arg;
    const [name, inlineValue] = normalized.startsWith("--") ? normalized.slice(2).split(/=(.*)/s, 2) : [null, undefined];
    if (name === "help" || name === "version") {
      if (inlineValue !== undefined) throw new InvocationError(`option '--${name}' doesn't allow an argument`);
      return normalized;
    }
    if (normalized.startsWith("--foreground=")) throw new InvocationError("option '--foreground' doesn't allow an argument");
    if (normalized.startsWith("--preserve-status=")) throw new InvocationError("option '--preserve-status' doesn't allow an argument");
    if (normalized.startsWith("--verbose=")) throw new InvocationError("option '--verbose' doesn't allow an argument");
    if (arg === "-p" || arg === "--preserve-status" || arg === "-v" || arg === "--verbose" || arg === "-f" || arg === "--foreground") continue;
    if (arg === "-s" || arg === "--signal") {
      if (i + 1 >= args.length) throw new InvocationError(arg.startsWith("--") ? `option '${arg}' requires an argument` : `option requires an argument -- '${arg.slice(1)}'`);
      normalizeTimeoutSignalOption(args[i + 1]);
      i++;
      continue;
    }
    if (arg === "-k" || arg === "--kill-after") {
      if (i + 1 >= args.length) throw new InvocationError(arg.startsWith("--") ? `option '${arg}' requires an argument` : `option requires an argument -- '${arg.slice(1)}'`);
      parseDuration(args[i + 1]);
      i++;
      continue;
    }
    if (/^-s.+/.test(arg)) {
      normalizeTimeoutSignalOption(arg.slice(2));
      continue;
    }
    if (/^-k.+/.test(arg)) {
      parseDuration(arg.slice(2));
      continue;
    }
    if (normalized.startsWith("--signal=")) {
      normalizeTimeoutSignalOption(inlineValue);
      continue;
    }
    if (normalized.startsWith("--kill-after=")) {
      parseDuration(inlineValue);
      continue;
    }
    if (arg.startsWith("-")) throw new InvocationError(invalidOptionMessage(arg));
    return null;
  }
  return null;
}

export async function timeoutCmd(args) {
  const { opts, operands } = parseTimeoutOptions(args);
  const killAfter = opts.k ?? opts["kill-after"];
  if (killAfter != null) parseDuration(killAfter);
  const signal = normalizeTimeoutSignalOption(opts.s ?? opts.signal ?? "TERM");
  if (operands.length < 2) throw new InvocationError("", 125, true);
  const duration = parseDuration(operands[0]);
  const command = operands.slice(1);
  let proc;
  try {
    await resolveEnvCommand(command[0], process.env, process.cwd());
    const spawnCommand = await timeoutSpawnCommand(command, signal);
    proc = Bun.spawn(spawnCommand, { stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: !opts.foreground });
  } catch (error) {
    const code = error?.code === "ENOENT" ? 127 : 126;
    const message = error?.code === "ENOENT"
      ? `failed to run command '${command[0]}': No such file or directory`
      : error?.code === "EACCES"
        ? `failed to run command '${command[0]}': Permission denied`
        : `failed to run command '${command[0]}': ${error?.message || String(error)}`;
    throw new InvocationError(message, code, false);
  }
  let timedOut = false;
  let killedByFollowUp = false;
  let killer = null;
  const expire = () => {
    if (timedOut) return;
    timedOut = true;
    if (opts.v || opts.verbose) stderr(`timeout: sending signal ${timeoutSignalDisplay(signal)} to command '${command[0]}'\n`);
    sendTimeoutSignal(proc, timeoutKillSignal(signal), !opts.foreground);
    if (killAfter) {
      const scheduleKillAfter = timeoutTimerDuration(parseDuration(killAfter));
      if (scheduleKillAfter != null) killer = setTimeout(() => {
        killedByFollowUp = true;
        if (opts.v || opts.verbose) stderr(`timeout: sending signal KILL to command '${command[0]}'\n`);
        sendTimeoutSignal(proc, "SIGKILL", !opts.foreground);
      }, scheduleKillAfter);
    }
  };
  const forwardedSignals = [...new Set([
    "SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM", "SIGALRM", "SIGUSR1", "SIGUSR2",
    "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGIO", "SIGPWR", "SIGSYS", signal,
  ])]
    .filter((name) => typeof name === "string" && !["0", "SIGKILL", "SIGSTOP"].includes(name));
  const signalHandlers = forwardedSignals.map((forwardedSignal) => {
    const handler = () => {
      if (forwardedSignal === "SIGALRM") expire();
      else sendTimeoutSignal(proc, forwardedSignal, !opts.foreground);
    };
    process.on(forwardedSignal, handler);
    return [forwardedSignal, handler];
  });
  const scheduleDuration = timeoutTimerDuration(duration);
  const timer = scheduleDuration == null ? null : setTimeout(expire, scheduleDuration);
  const code = await proc.exited;
  for (const [forwardedSignal, handler] of signalHandlers) process.off(forwardedSignal, handler);
  if (timer) clearTimeout(timer);
  if (killer) clearTimeout(killer);
  if (!timedOut || opts.p || opts["preserve-status"]) return code;
  if (killedByFollowUp) return 137;
  return signal === "SIGKILL" ? 137 : 124;
}

export async function timeoutSpawnCommand(command, signal) {
  if (process.platform !== "linux") return command;
  // util-linux setpriv does not accept the RTMIN/RTMAX names (or their
  // numeric values) for --pdeathsig.  The timeout monitor can still deliver
  // those signals itself, so avoid turning a valid timeout invocation into a
  // setpriv usage error merely to install the parent-death safeguard.
  if (signalNumberFromOperand(signal) > 31) return command;
  try {
    const setpriv = await resolveEnvCommand("setpriv", process.env, process.cwd());
    const parentDeathSignal = signalNumberFromOperand(signal) === 0 ? "clear" : signal;
    return [setpriv, "--pdeathsig", parentDeathSignal, "--", ...command];
  } catch {
    return command;
  }
}

export function parseTimeoutOptions(args) {
  const opts = {};
  const operands = [];
  const requireValue = (index, option) => {
    if (index + 1 < args.length) return args[index + 1];
    if (option.startsWith("--")) throw new InvocationError(`option '${option}' requires an argument`);
    throw new InvocationError(`option requires an argument -- '${option.slice(1)}'`);
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith("--foreground=")) {
      throw new InvocationError("option '--foreground' doesn't allow an argument");
    } else if (arg.startsWith("--preserve-status=")) {
      throw new InvocationError("option '--preserve-status' doesn't allow an argument");
    } else if (arg.startsWith("--verbose=")) {
      throw new InvocationError("option '--verbose' doesn't allow an argument");
    } else if (arg === "-p" || arg === "--preserve-status") {
      opts.p = true;
    } else if (arg === "-v" || arg === "--verbose") {
      opts.v = true;
    } else if (arg === "-f" || arg === "--foreground") {
      opts.foreground = true;
    } else if (arg === "-s" || arg === "--signal") {
      opts.s = requireValue(i, arg);
      i++;
    } else if (/^-s.+/.test(arg)) {
      opts.s = arg.slice(2);
    } else if (arg.startsWith("--signal=")) {
      opts.signal = arg.slice("--signal=".length);
    } else if (arg === "-k" || arg === "--kill-after") {
      opts.k = requireValue(i, arg);
      i++;
    } else if (/^-k.+/.test(arg)) {
      opts.k = arg.slice(2);
    } else if (arg.startsWith("--kill-after=")) {
      opts["kill-after"] = arg.slice("--kill-after=".length);
    } else if (arg.startsWith("-")) {
      throw new InvocationError(invalidOptionMessage(arg));
    } else {
      operands.push(...args.slice(i));
      break;
    }
  }
  return { opts, operands };
}

export function timeoutTimerDuration(duration) {
  if (duration === 0 || duration > 2147483647 || !Number.isFinite(duration)) return null;
  return Math.max(1, Math.ceil(duration));
}

export function normalizeTimeoutSignalOption(signal) {
  const normalized = normalizeSignal(signal);
  const valid = new Set(["SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE", "SIGALRM", "SIGTERM", "SIGCHLD", "SIGCONT", "SIGSTOP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGSYS"]);
  if (normalized === "0" || valid.has(normalized) || signalNumberFromOperand(normalized) >= 0) return normalized;
  throw new InvocationError(`${localeQuotedEscapedDiagnostic(signal)}: invalid signal`, 125, true);
}

export function timeoutKillSignal(signal) {
  const signum = signalNumberFromOperand(signal);
  return signum > 31 ? signum : signal === "0" ? 0 : signal;
}

export function timeoutSignalDisplay(signal) {
  const signum = signalNumberFromOperand(signal);
  if (signum === 0) return "0";
  return signalDisplayName(signum).replace(/^SIG/, "");
}

export function normalizeSignal(signal) {
  const text = String(signal).toUpperCase().replace(/^SIG/, "");
  if (text === "RTMIN") return "SIGRTMIN";
  if (text === "RTMAX") return "SIGRTMAX";
  if (/^\d+$/.test(text)) {
    if (Number(text) === 0) return "0";
    const map = { 1: "SIGHUP", 2: "SIGINT", 9: "SIGKILL", 15: "SIGTERM" };
    return map[Number(text)] ?? `SIG${text}`;
  }
  return `SIG${text}`;
}

export function sendTimeoutSignal(proc, signal, processGroup = false) {
  const normalized = signal === "0" ? 0 : signal;
  const signum = typeof normalized === "number" ? normalized : signalNumberFromOperand(normalized);
  const send = (pid) => {
    // Bun's process.kill accepts the usual Node signal names but does not
    // reliably deliver Linux real-time signals.  libc.kill handles the full
    // numeric signal range used by GNU timeout.
    if (signum > 31) libc.symbols.kill(pid, signum);
    else process.kill(pid, normalized);
  };
  try {
    send(proc.pid);
  } catch {}
  if (processGroup) {
    try {
      send(-proc.pid);
    } catch {}
  }
  if (normalized !== 0 && normalized !== 9 && normalized !== "SIGKILL" && normalized !== "SIGCONT") {
    try {
      process.kill(proc.pid, "SIGCONT");
    } catch {}
    if (processGroup) {
      try {
        process.kill(-proc.pid, "SIGCONT");
      } catch {}
    }
  }
}

const singleCall = defineCommand("timeout", timeoutCmd, timeoutMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
