import { readFileSync, statSync } from "node:fs";
import { InvocationError } from "./diagnostics.js";

export function trouble(message) { throw new InvocationError(message, 2, false); }
export function numberOption(value, name, fallback) {
  if (value == null || value === true) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) trouble(`invalid ${name}: '${value}'`);
  return Number(value);
}
export function lines(text) { return text.match(/[^\n]*\n|[^\n]+$/g) ?? []; }
export function readBytes(path) {
  if (path !== "-" && statSync(path).isDirectory()) trouble(`${path}: Is a directory`);
  return readFileSync(path === "-" ? 0 : path);
}
export function lineKey(line, opts = {}) {
  let value = line;
  if (opts["strip-trailing-cr"]) value = value.replace(/\r(?=\n?$)/, "");
  if (opts.w || opts["ignore-all-space"]) value = value.replace(/[ \t\v\f\r]+/g, "");
  else if (opts.b || opts["ignore-space-change"]) value = value.replace(/[ \t\v\f\r]+(?=\n?$)/, "").replace(/[ \t\v\f\r]+/g, " ");
  else if (opts["ignore-trailing-space"]) value = value.replace(/[ \t\v\f\r]+(?=\n?$)/, "");
  if (opts.E || opts["ignore-tab-expansion"]) value = value.replace(/[^\n]*\t/g, (chunk) => {
    let expanded = "";
    for (const char of chunk) expanded += char === "\t" ? " ".repeat(8 - expanded.length % 8) : char;
    return expanded;
  });
  if (opts.i || opts["ignore-case"]) value = value.toLowerCase();
  return value;
}

// Myers' shortest edit path. Trim identical ends first, keeping ordinary
// small edits in large files cheap. A linear-memory LCS fallback bounds trace
// storage for unrelated inputs, without changing the minimum-edit guarantee.
export function editScript(a, b, opts = {}) {
  const ak = a.map((s) => lineKey(s, opts)), bk = b.map((s) => lineKey(s, opts));
  let start = 0, ae = a.length, be = b.length;
  while (start < ae && start < be && ak[start] === bk[start]) start++;
  while (ae > start && be > start && ak[ae - 1] === bk[be - 1]) { ae--; be--; }
  const prefix = a.slice(0, start).map((line, i) => ({ type: " ", line, other: b[i] }));
  const suffix = a.slice(ae).map((line, i) => ({ type: " ", line, other: b[be + i] }));
  const left = ak.slice(start, ae), right = bk.slice(start, be);
  const n = left.length, m = right.length, trace = [];
  let v = new Map([[1, 0]]), found = false;
  for (let d = 0; d <= n + m && d < 1024; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && left[x] === right[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) { found = true; break; }
    }
    if (found) break;
  }
  let middle = [];
  if (found) {
    let x = n, y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
      v = trace[d];
      const k = x - y;
      const prevK = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? k + 1 : k - 1;
      const prevX = v.get(prevK) ?? 0, prevY = prevX - prevK;
      while (x > prevX && y > prevY) { x--; y--; middle.push({ type: " ", line: a[start + x], other: b[start + y] }); }
      if (d > 0) {
        if (x === prevX) { y--; middle.push({ type: "+", line: b[start + y] }); }
        else { x--; middle.push({ type: "-", line: a[start + x] }); }
      }
    }
    middle.reverse();
  } else {
    const matches = lcsMatches(left, right, 0, n, 0, m);
    let x = 0, y = 0;
    for (const [mx, my] of [...matches, [n, m]]) {
      while (x < mx) middle.push({ type: "-", line: a[start + x++] });
      while (y < my) middle.push({ type: "+", line: b[start + y++] });
      if (x < n && y < m) middle.push({ type: " ", line: a[start + x++], other: b[start + y++] });
    }
  }
  // Group replacements in conventional delete-then-insert order.
  const result = [...prefix];
  for (let i = 0; i < middle.length;) {
    if (middle[i].type === " ") { result.push(middle[i++]); continue; }
    const block = [];
    while (i < middle.length && middle[i].type !== " ") block.push(middle[i++]);
    result.push(...block.filter((o) => o.type === "-"), ...block.filter((o) => o.type === "+"));
  }
  return [...result, ...suffix];
}
function lcsMatches(a, b, as, ae, bs, be) {
  if (as === ae || bs === be) return [];
  if (ae - as === 1) { for (let j = bs; j < be; j++) if (a[as] === b[j]) return [[as, j]]; return []; }
  const mid = (as + ae) >> 1, m = be - bs;
  const row = (start, end, step, reverse) => {
    const r = new Uint32Array(m + 1);
    for (let i = start; i !== end; i += step) {
      let previous = 0;
      for (let j = 1; j <= m; j++) {
        const old = r[j];
        r[j] = a[i] === b[reverse ? be - j : bs + j - 1] ? previous + 1 : Math.max(r[j], r[j - 1]);
        previous = old;
      }
    }
    return r;
  };
  const f = row(as, mid, 1, false), r = row(ae - 1, mid - 1, -1, true);
  let split = 0;
  for (let j = 1; j <= m; j++) if (f[j] + r[m - j] > f[split] + r[m - split]) split = j;
  return [...lcsMatches(a, b, as, mid, bs, bs + split), ...lcsMatches(a, b, mid, ae, bs + split, be)];
}
export function changes(script) {
  const result = [];
  let a = 0, b = 0;
  for (let i = 0; i < script.length;) {
    if (script[i].type === " ") { a++; b++; i++; continue; }
    const change = { a, b, index: i, removed: [], added: [] };
    while (i < script.length && script[i].type !== " ") {
      const op = script[i++];
      if (op.type === "-") { change.removed.push(op.line); a++; }
      else { change.added.push(op.line); b++; }
    }
    change.end = i;
    result.push(change);
  }
  return result;
}
export function printLine(prefix, line) { return prefix + line + (line.endsWith("\n") ? "" : "\n\\ No newline at end of file\n"); }
export function unifiedRange(start, count) { return count === 1 ? String(start + 1) : `${count ? start + 1 : start},${count}`; }
export function normalRange(start, count) { return count <= 1 ? String(count ? start + 1 : start) : `${start + 1},${start + count}`; }
export function hunkGroups(script, context, selected = changes(script)) {
  const groups = [];
  for (const change of selected) {
    const start = Math.max(0, change.index - context), end = Math.min(script.length, change.end + context);
    if (groups.length && start <= groups.at(-1).end) groups.at(-1).end = end;
    else groups.push({ start, end });
  }
  let ai = 0, bi = 0, at = 0;
  return groups.map(({ start, end }) => {
    while (at < start) { const op = script[at++]; if (op.type !== "+") ai++; if (op.type !== "-") bi++; }
    const ops = script.slice(start, end);
    return { a: ai, b: bi, ops, na: ops.filter((o) => o.type !== "+").length, nb: ops.filter((o) => o.type !== "-").length };
  });
}
export function renderUnified(script, first, second, context = 3, selected) {
  let out = `--- ${first}\n+++ ${second}\n`;
  for (const h of hunkGroups(script, context, selected)) {
    out += `@@ -${unifiedRange(h.a, h.na)} +${unifiedRange(h.b, h.nb)} @@\n`;
    for (const op of h.ops) out += printLine(op.type, op.line);
  }
  return out;
}

export function renderSide(script, cfg) {
  const half = Math.floor((cfg.width - 3) / 2), o = cfg.opts;
  const expand = (s) => { let result = ""; for (const c of s.replace(/\n$/, "")) result += c === "\t" ? " ".repeat(8 - result.length % 8) : c; return result.slice(0, half); };
  const row = (left, middle, right) => `${expand(left).padEnd(half)} ${middle} ${expand(right)}`.replace(/ +$/, "") + "\n";
  let out = "";
  for (let i = 0; i < script.length;) {
    if (script[i].type === " ") {
      const op = script[i++];
      if (!o["suppress-common-lines"]) out += o["left-column"] ? row(op.line, "(", "") : row(op.line, " ", op.other ?? op.line);
      continue;
    }
    const removed = [], added = [];
    while (i < script.length && script[i].type !== " ") { const op = script[i++]; (op.type === "-" ? removed : added).push(op.line); }
    for (let j = 0; j < Math.max(removed.length, added.length); j++) out += row(removed[j] ?? "", removed[j] == null ? ">" : added[j] == null ? "<" : "|", added[j] ?? "");
  }
  return out;
}
