#!/usr/bin/env bun

import { fstatSync, readSync } from "node:fs";
import { cpus } from "node:os";
import { decodeSurrogateEscapedBytes, isWriteError, localeQuotedDiagnostic, lsEscapedName, parseOptions, readAll, systemErrorMessage } from "../shared/common.js";
import { fail, stderr, stdout } from "../shared/diagnostics.js";
import { defineCommand, runAsMain } from "../shared/command.js";

export const FACTOR_LONG_OPTIONS = ["exponents", "help", "version"];

export function factorMetaOption(args) {
  for (const arg of args) {
    if (arg === "--") return null;
    if (!arg.startsWith("-") || arg === "-") continue;
    if (arg.startsWith("--")) {
      const option = normalizeFactorLongOption(arg);
      const name = option.slice(2).split("=", 1)[0];
      if (!FACTOR_LONG_OPTIONS.includes(name) || option.includes("=")) return null;
      if (option === "--help" || option === "--version") return option;
      continue;
    }
    for (let j = 1; j < arg.length; j++) if (arg[j] !== "h") return null;
  }
  return null;
}

export function factorize(value) {
  let n = BigInt(value);
  if (n < 0n) n = -n;
  if (n <= 1n) return [];
  const factors = [];
  for (const d of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n]) {
    while (n % d === 0n) {
      factors.push(d);
      n /= d;
    }
  }
  if (n > 1n) factorBigInt(n, factors);
  return factors.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

export function factorBigInt(n, factors) {
  if (n === 1n) return;
  if (isProbablePrime(n)) {
    factors.push(n);
    return;
  }
  const nearDouble = factorNearDoubleSemiprime(n);
  if (nearDouble != null) {
    factorBigInt(nearDouble, factors);
    factorBigInt(n / nearDouble, factors);
    return;
  }
  // A high-bound p-1 pass is useful for very large residuals with smooth
  // predecessor factors, but it is disproportionately expensive across a
  // contiguous range of 96-bit values.  Pollard rho is the better first
  // strategy below this threshold.
  const pMinusOne = n >= 1_000_000_000_000_000_000_000_000_000_000n
    ? pollardPMinusOne(n, 500_000)
    : n >= (1n << 72n)
      ? pollardPMinusOne(n, 100_000)
      : null;
  if (pMinusOne != null) {
    factorBigInt(pMinusOne, factors);
    factorBigInt(n / pMinusOne, factors);
    return;
  }
  const divisor = pollardRho(n);
  factorBigInt(divisor, factors);
  factorBigInt(n / divisor, factors);
}

export function bigintGcd(a, b) {
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a < 0n ? -a : a;
}

export function modPow(base, exponent, mod) {
  let result = 1n;
  base %= mod;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exponent >>= 1n;
  }
  return result;
}

export function factorNearDoubleSemiprime(n) {
  if (n < 1_000_000_000_000_000_000n) return null;
  for (let delta = -4096n; delta <= 4096n; delta++) {
    const discriminant = delta * delta + 8n * n;
    const root = bigintSqrt(discriminant);
    if (root * root !== discriminant) continue;
    const numerator = root - delta;
    if (numerator % 4n !== 0n) continue;
    const factor = numerator / 4n;
    if (factor > 1n && factor < n && n % factor === 0n) return factor;
  }
  return null;
}

export function pollardPMinusOne(n, bound) {
  let a = 2n;
  let sinceGcd = 0;
  for (const p of primesUpTo(bound)) {
    let power = p;
    while (power <= Math.floor(bound / p)) power *= p;
    a = modPow(a, BigInt(power), n);
    if (++sinceGcd < 256) continue;
    sinceGcd = 0;
    const d = bigintGcd(a - 1n, n);
    if (d > 1n && d < n) return d;
    if (d === n) return null;
  }
  const d = bigintGcd(a - 1n, n);
  return d > 1n && d < n ? d : null;
}

export function bigintSqrt(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

export function isProbablePrime(n) {
  if (n < 2n) return false;
  for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  let d = n - 1n;
  let s = 0n;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }
  const bases = n < (1n << 128n) ? [2n, 3n, 5n, 7n, 11n, 13n, 17n] : [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
  for (const a of bases) {
    if (a >= n - 2n) continue;
    let x = modPow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let r = 1n; r < s; r++) {
      x = (x * x) % n;
      if (x === n - 1n) {
        composite = false;
        break;
      }
    }
    if (composite) return false;
  }
  return true;
}

export function pollardRho(n) {
  if (n % 2n === 0n) return 2n;
  const preferredConstants = [13n, 3n, 1n, 22n, 11n, 4n, 15n, 5n, 7n, 2n, 17n, 19n, 26n];
  for (let attempt = 0; ; attempt++) {
    const c = attempt < preferredConstants.length ? preferredConstants[attempt] : BigInt(attempt + 1);
    let y = 2n;
    let d = 1n;
    let r = 1;
    let q = 1n;
    let x = 0n;
    let ys = 0n;
    const f = (v) => (v * v + c) % n;
    while (d === 1n) {
      x = y;
      for (let i = 0; i < r; i++) y = f(y);
      let k = 0;
      while (k < r && d === 1n) {
        ys = y;
        const limit = Math.min(256, r - k);
        for (let i = 0; i < limit; i++) {
          y = f(y);
          const diff = x > y ? x - y : y - x;
          q = (q * diff) % n;
        }
        d = bigintGcd(q, n);
        k += 256;
      }
      r *= 2;
      if (r > 2_000_000 && d === 1n) break;
    }
    if (d === n) {
      do {
        ys = f(ys);
        d = bigintGcd(x > ys ? x - ys : ys - x, n);
      } while (d === 1n);
    }
    if (d > 1n && d < n) return d;
    if (attempt === preferredConstants.length - 1 && n > 1_000_000_000_000_000_000_000_000n) {
      const pPlusOne = pollardPPlusOne(n, 11_000_000, 6n);
      if (pPlusOne != null) return pPlusOne;
    }
  }
}

export function pollardPPlusOne(n, bound, parameter) {
  let v = parameter;
  for (const p of primesUpTo(bound)) {
    let power = p;
    while (power <= Math.floor(bound / p)) power *= p;
    v = lucasV(v, BigInt(power), n);
  }
  const d = bigintGcd(v - 2n, n);
  return d > 1n && d < n ? d : null;
}

export function lucasV(parameter, exponent, mod) {
  let vk = 2n % mod;
  let vk1 = parameter % mod;
  for (const bit of exponent.toString(2)) {
    const v2k = positiveMod(vk * vk - 2n, mod);
    const v2k1 = positiveMod(vk * vk1 - parameter, mod);
    if (bit === "0") {
      vk = v2k;
      vk1 = v2k1;
    } else {
      vk = v2k1;
      vk1 = positiveMod(vk1 * vk1 - 2n, mod);
    }
  }
  return vk;
}

export function positiveMod(value, mod) {
  value %= mod;
  return value < 0n ? value + mod : value;
}

export async function factor(args) {
  args = normalizeFactorLongOptions(args);
  const { opts, operands } = parseOptions(args, { short: { h: false }, long: { exponents: false, help: false, version: false } });
  opts.exponents = opts.h || opts.exponents;
  if (!operands.length && !fstatSync(0).isFile()) return streamFactorStdin(opts);
  let values;
  try {
    if (operands.length) values = operands.map((operand) => String(operand).replace(/\0\S*/g, ""));
    else {
      const input = decodeSurrogateEscapedBytes(await readAll("-"));
      const fastStatus = factorFastSmallIntegerInput(input, opts);
      if (fastStatus != null) return fastStatus;
      values = input.replace(/\0\S*/g, "").trim().split(/\s+/).filter(Boolean);
    }
  } catch (error) {
    return fail("factor", `error reading input: ${systemErrorMessage(error)}`);
  }
  const parallel = await factorLargeContiguousRangeInParallel(values, opts);
  if (parallel != null) return parallel;
  const batchFactors = prepareSmallIntegerFactorizer(values) ?? prepareContiguousRangeFactorizer(values);
  let status = 0;
  for (const raw of values) {
    status = factorOneValue(raw, opts, batchFactors) || status;
  }
  return status;
}

export async function streamFactorStdin(opts) {
  let pending = [];
  let pendingLength = 0;
  let values = [];
  let status = 0;
  const flushValues = async () => {
    if (!values.length) return;
    const batch = values;
    values = [];
    const parallelStatus = await factorLargeContiguousRangeInParallel(batch, opts);
    if (parallelStatus != null) {
      status = parallelStatus || status;
      return;
    }
    // Dense small ranges (notably upstream factor/t00: 0..10,000,000)
    // must use the compact Uint32 sieve.  The generic range factorizer keeps
    // one JS array per value and caused JSC heap growth into multiple GiB.
    const batchFactors = prepareSegmentedSmallIntegerFactorizer(batch)
      ?? prepareSmallIntegerFactorizer(batch)
      ?? prepareContiguousRangeFactorizer(batch);
    for (const raw of batch) status = factorOneValue(raw, opts, batchFactors) || status;
  };
  const flushToken = () => {
    if (!pendingLength) return;
    const raw = decodeSurrogateEscapedBytes(Buffer.concat(pending, pendingLength)).replace(/\0\S*/g, "");
    pending = [];
    pendingLength = 0;
    if (raw) values.push(raw);
  };
  try {
    const inputBuffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const bytesRead = readSync(0, inputBuffer, 0, inputBuffer.length, null);
      if (bytesRead === 0) break;
      const chunk = inputBuffer.subarray(0, bytesRead);
      let start = 0;
      for (let index = 0; index < chunk.length; index++) {
        if (![9, 10, 11, 12, 13, 32].includes(chunk[index])) continue;
        if (index > start) {
          const part = Buffer.from(chunk.subarray(start, index));
          pending.push(part);
          pendingLength += part.length;
        }
        flushToken();
        start = index + 1;
      }
      if (start < chunk.length) {
        const part = Buffer.from(chunk.subarray(start));
        pending.push(part);
        pendingLength += part.length;
      }
      // Process four 100k-value child chunks concurrently while applying
      // backpressure to stdin, keeping the range optimization bounded.
      if (values.length >= 400_000) await flushValues();
    }
    flushToken();
    await flushValues();
    return status;
  } catch (error) {
    if (isWriteError(error)) throw error;
    return fail("factor", `error reading input: ${systemErrorMessage(error)}`);
  }
}

export function factorOneValue(raw, opts, batchFactors = null) {
  const value = raw.replace(/^\+/, "");
  if (!/^\d+$/.test(value)) {
    stderr(`factor: ${localeQuotedDiagnostic(factorDiagnosticValue(raw))} is not a valid positive integer\n`);
    return 1;
  }
  const normalizedValue = normalizeFactorValue(value);
  const factors = batchFactors?.get(normalizedValue) ?? factorize(normalizedValue);
  stdout(`${normalizedValue}:${formatFactors(factors, opts).map((n) => ` ${n}`).join("")}\n`);
  return 0;
}

export const FACTOR_FAST_OUTPUT_CHUNK_BYTES = 4096;

export function factorFastSmallIntegerInput(input, opts) {
  if (opts.exponents || input.includes("\0")) return null;
  let count = 0;
  let max = 0;
  for (const token of input.matchAll(/\S+/g)) {
    const raw = token[0];
    const value = raw.replace(/^\+/, "");
    if (!/^\d+$/.test(value) || value.length > 8) return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n)) return null;
    if (n > max) max = n;
    count++;
  }
  if (count < 10000 || max > 100_000_000) return null;

  const spf = smallestPrimeFactors(max);
  let out = "";
  for (const token of input.matchAll(/\S+/g)) {
    const n = Number(token[0].replace(/^\+/, ""));
    const line = `${n}:${formatSmallIntegerFactors(n, spf)}\n`;
    if (out && out.length + line.length > FACTOR_FAST_OUTPUT_CHUNK_BYTES) {
      stdout(out);
      out = "";
    }
    out += line;
  }
  if (out) stdout(out);
  return 0;
}

export function formatSmallIntegerFactors(value, spf) {
  if (value <= 1) return "";
  let n = value;
  let out = "";
  while (n > 1) {
    const p = spf[n] || n;
    out += ` ${p}`;
    n = Math.trunc(n / p);
  }
  return out;
}

export function factorDiagnosticValue(value) {
  return [...String(value)].map((ch) => {
    if (/[\udc80-\udcff]/.test(ch)) return `\\${(ch.charCodeAt(0) - 0xdc00).toString(8).padStart(3, "0")}`;
    return lsEscapedName(ch, { escapeDouble: false });
  }).join("");
}

export function normalizeFactorValue(value) {
  return BigInt(value).toString();
}

export function normalizeFactorLongOptions(args) {
  const out = [];
  let end = false;
  for (const arg of args) {
    if (end || arg === "--" || !arg.startsWith("--")) {
      out.push(arg);
      if (arg === "--") end = true;
      continue;
    }
    out.push(normalizeFactorLongOption(arg));
  }
  return out;
}

export function normalizeFactorLongOption(arg) {
  const body = arg.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);
  if (!name) return arg;
  const match = FACTOR_LONG_OPTIONS.find((option) => option.startsWith(name));
  if (!match) return arg;
  return eq === -1 ? `--${match}` : `--${match}=${body.slice(eq + 1)}`;
}

export async function factorLargeContiguousRangeInParallel(values, opts) {
  if (process.env.BNU_FACTOR_CHILD === "1" || values.length < 2000 || opts.exponents) return null;
  const normalized = [];
  for (const raw of values) {
    const value = raw.replace(/^\+/, "");
    if (!/^\d+$/.test(value)) return null;
    normalized.push(value);
  }
  const lo = BigInt(normalized[0]);
  const hi = BigInt(normalized[normalized.length - 1]);
  if (lo < 1_000_000_000_000_000_000n || hi < lo || hi - lo !== BigInt(normalized.length - 1)) return null;
  for (let i = 1; i < normalized.length; i++) {
    if (BigInt(normalized[i]) !== lo + BigInt(i)) return null;
  }

  // Each Bun worker carries a substantial runtime and JIT footprint.  Keep
  // the default single-process so an ordinary invocation cannot multiply its
  // memory use by the host CPU count.  Controlled benchmarks and audits may
  // opt in to bounded parallelism with BNU_FACTOR_WORKERS.
  const configuredWorkerLimit = /^\d+$/.test(process.env.BNU_FACTOR_WORKERS ?? "")
    ? Number(process.env.BNU_FACTOR_WORKERS)
    : null;
  const workerLimit = configuredWorkerLimit ?? 1;
  const workers = Math.min(workerLimit, Math.max(1, Math.floor(values.length / 100)), cpus().length || 1);
  if (workers < 2) return null;
  const chunkSize = Math.ceil(values.length / workers);
  const chunks = [];
  for (let i = 0; i < values.length; i += chunkSize) chunks.push(values.slice(i, i + chunkSize));
  const results = await Promise.all(chunks.map(async (chunk) => {
    const proc = Bun.spawn([process.execPath, import.meta.path, "factor"], {
      env: { ...process.env, BNU_FACTOR_CHILD: "1" },
      stdin: new Blob([chunk.join("\n") + "\n"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, out, err };
  }));
  let status = 0;
  for (const result of results) {
    if (result.out) stdout(result.out);
    if (result.err) stderr(result.err);
    if (result.code !== 0) status = result.code;
  }
  return status;
}

export function prepareContiguousRangeFactorizer(values) {
  if (values.length < 100 || values.length > 1_000_000) return null;
  const normalized = [];
  for (const raw of values) {
    const value = raw.replace(/^\+/, "");
    if (!/^\d+$/.test(value)) return null;
    normalized.push(value);
  }
  const lo = BigInt(normalized[0]);
  const hi = BigInt(normalized[normalized.length - 1]);
  if (hi < lo || hi - lo !== BigInt(normalized.length - 1)) return null;
  for (let i = 1; i < normalized.length; i++) {
    if (BigInt(normalized[i]) !== lo + BigInt(i)) return null;
  }

  const residues = normalized.map(BigInt);
  const factors = Array.from({ length: normalized.length }, () => []);
  for (const p of primesUpTo(1_000_000)) {
    const bigP = BigInt(p);
    const rem = lo % bigP;
    let index = Number(rem === 0n ? 0n : bigP - rem);
    for (; index < residues.length; index += p) {
      while (residues[index] % bigP === 0n) {
        factors[index].push(bigP);
        residues[index] /= bigP;
      }
    }
  }

  return {
    get(value) {
      const index = Number(BigInt(value) - lo);
      if (index < 0 || index >= residues.length) return null;
      const out = [...factors[index]];
      if (residues[index] > 1n) out.push(...factorize(residues[index]));
      return out.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    },
  };
}

export const primeCache = new Map();

export function primesUpTo(max) {
  const cached = primeCache.get(max);
  if (cached) return cached;
  const composite = new Uint8Array(max + 1);
  const primes = [];
  for (let i = 2; i <= max; i++) {
    if (composite[i]) continue;
    primes.push(i);
    if (i > Math.floor(max / i)) continue;
    for (let j = i * i; j <= max; j += i) composite[j] = 1;
  }
  primeCache.set(max, primes);
  return primes;
}

export function prepareSmallIntegerFactorizer(values) {
  if (values.length < 10000) return null;
  let max = 0;
  for (const raw of values) {
    const value = raw.replace(/^\+/, "");
    if (!/^\d+$/.test(value) || value.length > 8) return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n)) return null;
    if (n > max) max = n;
  }
  if (max > 100_000_000) return null;
  const spf = smallestPrimeFactors(max);
  return {
    get(value) {
      let n = Number(value);
      if (n <= 1) return [];
      const factors = [];
      while (n > 1) {
        const p = spf[n] || n;
        factors.push(BigInt(p));
        n = Math.trunc(n / p);
      }
      return factors;
    },
  };
}

export function prepareSegmentedSmallIntegerFactorizer(values) {
  if (values.length < 10_000) return null;
  const normalized = [];
  for (const raw of values) {
    const value = raw.replace(/^\+/, "");
    if (!/^\d+$/.test(value) || value.length > 8) return null;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n > 100_000_000) return null;
    normalized.push(n);
  }
  const lo = normalized[0];
  const hi = normalized.at(-1);
  if (hi - lo !== normalized.length - 1) return null;
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index] !== lo + index) return null;
  }

  // Keep a compact CSR-style table of every factor in this segment.  Storing
  // only the first divisor forced each residual through the generic Pollard
  // path and made the 80m..90m upstream range take more than 15 minutes.
  // Two sieve passes cost little and keep a 400k-value batch to a few typed
  // arrays rather than one JS array per integer.
  const primes = primesUpTo(Math.floor(Math.sqrt(hi)));
  const residues = new Uint32Array(normalized);
  const counts = new Uint8Array(normalized.length);
  for (const p of primes) {
    let first = Math.ceil(lo / p) * p;
    if (first < p * p) first = p * p;
    for (let value = first; value <= hi; value += p) {
      const index = value - lo;
      while (residues[index] > 1 && residues[index] % p === 0) {
        residues[index] = Math.trunc(residues[index] / p);
        counts[index]++;
      }
    }
  }
  for (let index = 0; index < residues.length; index++) {
    if (residues[index] > 1) counts[index]++;
  }
  const offsets = new Uint32Array(normalized.length + 1);
  for (let index = 0; index < counts.length; index++) offsets[index + 1] = offsets[index] + counts[index];
  const factors = new Uint32Array(offsets.at(-1));
  const positions = new Uint32Array(offsets.subarray(0, normalized.length));
  residues.set(normalized);
  for (const p of primes) {
    let first = Math.ceil(lo / p) * p;
    if (first < p * p) first = p * p;
    for (let value = first; value <= hi; value += p) {
      const index = value - lo;
      while (residues[index] > 1 && residues[index] % p === 0) {
        residues[index] = Math.trunc(residues[index] / p);
        factors[positions[index]++] = p;
      }
    }
  }
  for (let index = 0; index < residues.length; index++) {
    if (residues[index] > 1) factors[positions[index]++] = residues[index];
  }
  return {
    get(value) {
      const original = Number(value);
      const index = original - lo;
      if (index < 0 || index >= normalized.length || original <= 1) return original <= 1 ? [] : null;
      const out = [];
      for (let position = offsets[index]; position < offsets[index + 1]; position++) out.push(BigInt(factors[position]));
      return out;
    },
  };
}

export let smallestPrimeFactorCache = new Uint32Array(0);

export function smallestPrimeFactors(max) {
  if (smallestPrimeFactorCache.length > max) return smallestPrimeFactorCache;
  const spf = new Uint32Array(max + 1);
  for (let i = 2; i <= max; i++) {
    if (spf[i] !== 0) continue;
    spf[i] = i;
    if (i > Math.floor(max / i)) continue;
    for (let j = i * i; j <= max; j += i) {
      if (spf[j] === 0) spf[j] = i;
    }
  }
  smallestPrimeFactorCache = spf;
  return spf;
}

export function formatFactors(factors, opts) {
  if (!opts.exponents) return factors.map(String);
  const out = [];
  for (let i = 0; i < factors.length;) {
    let count = 1;
    while (factors[i + count] === factors[i]) count++;
    out.push(count === 1 ? String(factors[i]) : `${factors[i]}^${count}`);
    i += count;
  }
  return out;
}

const singleCall = defineCommand("factor", factor, factorMetaOption);
export default singleCall;

if (import.meta.main) await runAsMain(singleCall);
