#!/usr/bin/env bun

import { localeQuotedEscapedDiagnostic, nodeErrorMessage, normalizeHelpVersionOnlyLongOption, normalizeHelpVersionOnlyLongOptions, parseOptions, readAll, systemErrorMessage, textInputDiagnosticName } from "../shared/common.js";
import { UsageError, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export function tsortMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (arg.startsWith("--")) {
      const option = normalizeHelpVersionOnlyLongOption(arg);
      if (option.includes("=") || !["--help", "--version"].includes(option)) return null;
      return option;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) if (arg[j] !== "w") return null;
  }
  return null;
}

export async function tsort(args) {
  const { operands } = parseOptions(normalizeHelpVersionOnlyLongOptions(args), { short: { w: false }, long: { help: false, version: false } });
  if (operands.length > 1) throw new UsageError(`extra operand ${localeQuotedEscapedDiagnostic(operands[1])}`, true);
  const file = operands[0] ?? "-";
  let input;
  try {
    input = await readAll(file);
  } catch (error) {
    const message = error?.code === "EISDIR" ? `${textInputDiagnosticName(file)}: read error: ${systemErrorMessage(error)}` : file === "-" ? nodeErrorMessage(error) : `${textInputDiagnosticName(file)}: ${systemErrorMessage(error)}`;
    stderr(`tsort: ${message}\n`);
    return 1;
  }
  const text = new TextDecoder().decode(input);
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length % 2) throw new UsageError(`${file}: input contains an odd number of tokens`);
  const nodes = new Map();
  const getNode = (name) => {
    if (!nodes.has(name)) nodes.set(name, { name, count: 0, printed: false, qlink: null, succ: [] });
    return nodes.get(name);
  };
  for (let i = 0; i < tokens.length; i += 2) {
    const from = getNode(tokens[i]);
    const to = getNode(tokens[i + 1]);
    if (from !== to) {
      to.count++;
      from.succ.unshift(to);
    }
  }
  const sortedNodes = [...nodes.values()].sort((a, b) => a.name.localeCompare(b.name));
  let remaining = sortedNodes.length;
  let ok = true;
  while (remaining > 0) {
    const queue = tsortScanZeros(sortedNodes);
    for (let head = queue.head, tail = queue.tail; head;) {
      const node = head;
      stdout(`${node.name}\n`);
      node.printed = true;
      remaining--;
      for (const next of node.succ) {
        next.count--;
        if (next.count === 0) {
          tail.qlink = next;
          tail = next;
        }
      }
      head = node.qlink;
      node.qlink = null;
    }
    if (remaining > 0) {
      stderr(`tsort: ${file}: input contains a loop:\n`);
      ok = false;
      tsortBreakLoop(sortedNodes);
    }
  }
  return ok ? 0 : 1;
}

export function tsortScanZeros(nodes) {
  let head = null;
  let tail = null;
  for (const node of nodes) {
    if (node.count === 0 && !node.printed) {
      if (!head) head = node;
      else tail.qlink = node;
      tail = node;
      node.qlink = null;
    }
  }
  return { head, tail };
}

export function tsortBreakLoop(nodes) {
  let loop = null;
  do {
    for (const node of nodes) {
      if (node.count <= 0 || node.printed) continue;
      if (!loop) {
        loop = node;
        continue;
      }
      const idx = node.succ.findIndex((next) => next === loop);
      if (idx === -1) continue;
      if (!node.qlink) {
        node.qlink = loop;
        loop = node;
        continue;
      }
      while (loop) {
        stderr(`tsort: ${loop.name}\n`);
        if (loop === node) {
          node.succ[idx].count--;
          node.succ.splice(idx, 1);
          break;
        }
        const next = loop.qlink;
        loop.qlink = null;
        loop = next;
      }
      while (loop) {
        const next = loop.qlink;
        loop.qlink = null;
        loop = next;
      }
      return;
    }
  } while (loop);
}

const singleCall = defineCommand("tsort", tsort, tsortMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
