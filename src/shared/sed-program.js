import { TextRegex, textUnescape } from "./text-tools.js";
import { InvocationError } from "./diagnostics.js";

export function parseSed(script, extended = false) {
  let pos = 0, lastRegex = null;
  const commands = [], groups = [], regexes = [];
  const error = (message) => { throw new InvocationError(`-e expression #1, char ${pos + 1}: ${message}`, 1, false); };
  const spaces = () => { while (/[ \t\r]/.test(script[pos] ?? "") && pos < script.length) pos++; };
  const delimited = (delimiter) => {
    let text = "";
    while (pos < script.length) {
      const ch = script[pos++];
      if (ch === delimiter) return text;
      if (ch === "\n") error("unterminated regular expression");
      if (ch === "\\" && pos < script.length) {
        const next = script[pos++];
        text += next === delimiter ? next : next === "\n" ? "\n" : "\\" + next;
      } else text += ch;
    }
    error("unterminated regular expression");
  };
  const compile = (pattern, flags = "") => {
    if (!pattern) return { previous: true, flags };
    const regex = new TextRegex(pattern.replace(/\\([ntr])/g, (_, c) => ({n:"\n",t:"\t",r:"\r"})[c]), { extended, ignoreCase: /i/i.test(flags), newline: /m/i.test(flags) });
    regexes.push(regex); return regex;
  };
  const address = () => {
    spaces();
    const ch = script[pos];
    if (ch === "$" ) { pos++; return { last: true }; }
    if (ch === "/" || ch === "\\") {
      pos++; const delimiter = ch === "\\" ? script[pos++] : "/";
      const pattern = delimited(delimiter);
      let flags = "";
      while (/[IM]/.test(script[pos] ?? "") && pos < script.length) flags += script[pos++];
      return { regex: compile(pattern, flags) };
    }
    const number = script.slice(pos).match(/^\d+/);
    if (number) {
      pos += number[0].length;
      const out = { number: Number(number[0]) };
      if (script[pos] === "~") { pos++; const step = script.slice(pos).match(/^\d+/); if (!step) error("missing step"); out.step = Number(step[0]); pos += step[0].length; }
      return out;
    }
    return null;
  };
  while (pos < script.length) {
    spaces();
    if (script[pos] === ";" || script[pos] === "\n") { pos++; continue; }
    if (script[pos] === "#") { while (pos < script.length && script[pos] !== "\n") pos++; continue; }
    if (pos >= script.length) break;
    const first = address(); spaces(); let second = null;
    if (script[pos] === ",") {
      pos++; spaces();
      if (script[pos] === "+" || script[pos] === "~") {
        const kind = script[pos++], value = script.slice(pos).match(/^\d+/);
        if (!value) error("missing range address");
        second = { [kind === "+" ? "relative" : "multiple"]: Number(value[0]) }; pos += value[0].length;
      } else second = address();
      if (!first || !second) error("unexpected ','");
    }
    spaces(); let invert = false;
    if (script[pos] === "!") { invert = true; pos++; spaces(); }
    const op = script[pos++];
    if (!op) error("missing command");
    const cmd = { op, first, second, invert, active: first?.number === 0 && !!second, rangeEnd: 0 };
    if (first?.number === 0 && !second && first.step == null) error("invalid usage of line address 0");
    if (op === "s" || op === "y") {
      const delimiter = script[pos++];
      if (!delimiter || delimiter === "\n" || delimiter === "\\") error("invalid delimiter");
      const pattern = delimited(delimiter), replacement = delimited(delimiter);
      if (op === "y") {
        cmd.from = [...textUnescape(pattern)]; cmd.to = [...textUnescape(replacement)];
        if (cmd.from.length !== cmd.to.length) error("strings for 'y' command are different lengths");
      } else {
        let flags = "";
        while (pos < script.length && !/[;\n}]/.test(script[pos])) flags += script[pos++];
        const write = flags.match(/w\s+(.+)$/);
        if (write) { cmd.file = write[1]; flags = flags.slice(0, write.index); }
        if (/[^gpIiMm\d \t]/.test(flags)) error("unknown option to 's'");
        cmd.regex = compile(pattern, flags); cmd.replacement = replacement; cmd.global = flags.includes("g"); cmd.print = flags.includes("p"); cmd.nth = Number(flags.match(/\d+/)?.[0] ?? 1);
        if (!cmd.nth) error("number option to 's' command may not be zero");
      }
    } else if ("aic".includes(op)) {
      spaces(); if (script[pos] === "\\") { pos++; if (script[pos] === "\n") pos++; }
      let text = "";
      while (pos < script.length) { const ch = script[pos++]; if (ch === "\n") break; if (ch === "\\" && script[pos] === "\n") { text += "\n"; pos++; } else text += ch; }
      cmd.text = textUnescape(text);
    } else if ("rRwW".includes(op)) {
      spaces(); const start = pos;
      while (pos < script.length && script[pos] !== "\n") pos++;
      cmd.file = script.slice(start, pos).trimEnd(); if (!cmd.file) error("missing filename");
    } else if (":btT".includes(op)) {
      spaces(); const start = pos;
      while (pos < script.length && !/[;\n}]/.test(script[pos])) pos++;
      cmd.label = script.slice(start, pos).trim();
    } else if ("qQl".includes(op)) {
      spaces(); const value = script.slice(pos).match(/^\d+/);
      if (value) { cmd.number = Number(value[0]); pos += value[0].length; }
    } else if (op === "{") { groups.push(commands.length); }
    else if (op === "}") {
      if (first || !groups.length) error("unexpected '}'");
      const begin = groups.pop(); commands[begin].end = commands.length;
    } else if (!"dDpPnNhHgGxz=F".includes(op)) error(`unknown command: '${op}'`);
    commands.push(cmd);
  }
  if (groups.length) error("unmatched '{'");
  const labels = new Map(commands.flatMap((cmd, i) => cmd.op === ":" ? [[cmd.label, i]] : []));
  for (const cmd of commands) if ("btT".includes(cmd.op)) { if (cmd.label && !labels.has(cmd.label)) error(`can't find label for jump to '${cmd.label}'`); cmd.target = cmd.label ? labels.get(cmd.label) : commands.length; }
  return { commands, regexes, getRegex(regex) { if (regex.previous) { if (!lastRegex) error("no previous regular expression"); return lastRegex; } lastRegex = regex; return regex; } };
}

export function sedReplacement(template, match) {
  let result = "", mode = null, nextMode = null;
  const append = (value) => {
    if (mode === "U") value = value.toUpperCase(); else if (mode === "L") value = value.toLowerCase();
    if (nextMode && value) { value = (nextMode === "u" ? value[0].toUpperCase() : value[0].toLowerCase()) + value.slice(1); nextMode = null; }
    result += value;
  };
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === "&") append(match[0]);
    else if (ch !== "\\") append(ch);
    else {
      const next = template[++i] ?? "\\";
      if (/\d/.test(next)) append(match[Number(next)] ?? "");
      else if ("UL".includes(next)) mode = next;
      else if ("ul".includes(next)) nextMode = next;
      else if (next === "E") { mode = null; nextMode = null; }
      else append(textUnescape("\\" + next));
    }
  }
  return result;
}
