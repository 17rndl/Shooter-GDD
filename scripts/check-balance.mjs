#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Balance regression gate (CI). Runs scripts/balance-sim.mjs and compares its
// report with scripts/balance-golden.txt, so a tuning or mechanic change can
// never shift the §15 numbers silently. On drift it prints a line diff and
// exits 1. When the change is intended, refresh the golden and commit it:
//   node scripts/check-balance.mjs --update
// ---------------------------------------------------------------------------
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIM = join(HERE, 'balance-sim.mjs');
const GOLDEN = join(HERE, 'balance-golden.txt');
const CONTEXT = 2; // unchanged lines shown around each change

// Windows checkouts (core.autocrlf) hand the golden over with CRLF; the sim prints LF.
const normalise = (s) => s.replace(/\r\n?/g, '\n');

// The sim calls process.exit() on a §15 failure, so it runs in a child rather than in-process.
const run = spawnSync(process.execPath, [SIM], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
if (run.error) {
  console.error(`check-balance: could not run balance-sim: ${run.error.message}`);
  process.exit(1);
}
if (run.stderr) process.stderr.write(run.stderr);
const actual = normalise(run.stdout);
const simFailed = run.status !== 0;

if (process.argv.includes('--update')) {
  if (simFailed) {
    process.stdout.write(actual);
    console.error(`check-balance: balance-sim exited with ${run.status}; refusing to bless a failing run.`);
    process.exit(1);
  }
  writeFileSync(GOLDEN, actual);
  console.log(`check-balance: wrote ${actual.split('\n').length} lines to scripts/balance-golden.txt`);
  process.exit(0);
}

let golden;
try {
  golden = normalise(readFileSync(GOLDEN, 'utf8'));
} catch (err) {
  console.error(`check-balance: cannot read scripts/balance-golden.txt (${err.message}).`);
  console.error('Create it with: node scripts/check-balance.mjs --update');
  process.exit(1);
}

if (actual === golden && !simFailed) {
  console.log(`check-balance: balance-sim output matches scripts/balance-golden.txt (${golden.split('\n').length} lines).`);
  process.exit(0);
}

if (actual !== golden) {
  const a = golden.split('\n');
  const b = actual.split('\n');
  console.log('check-balance: balance-sim output differs from scripts/balance-golden.txt');
  console.log('--- golden (scripts/balance-golden.txt)');
  console.log('+++ actual (node scripts/balance-sim.mjs)');
  for (const line of diffLines(a, b)) console.log(line);
  const loose = (lines) => lines.map((l) => l.trimEnd()).join('\n').trim();
  if (loose(a) === loose(b)) console.log('\n(the difference is whitespace only: trailing spaces or blank lines)');
  console.log('\nIf this change is intended, run `node scripts/check-balance.mjs --update` and commit the golden.');
}
if (simFailed) {
  if (actual === golden) process.stdout.write(actual);
  console.log(`check-balance: balance-sim itself failed (exit ${run.status}): the §15 rule no longer holds.`);
}
process.exitCode = 1;

/**
 * Unified-style diff of two line arrays (LCS over the full table: the report is a few dozen
 * lines, so O(n*m) is nothing). Returns printable lines: hunk headers, ' ', '-' and '+'.
 */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = []; // { t: ' ' | '-' | '+', text, ai, bi } with 1-based line numbers
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: ' ', text: a[i], ai: ++i, bi: ++j });
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ops.push({ t: '-', text: a[i], ai: ++i, bi: j });
    } else {
      ops.push({ t: '+', text: b[j], ai: i, bi: ++j });
    }
  }
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') {
      k++;
      continue;
    }
    // Grow the hunk while the next change is within 2*CONTEXT unchanged lines.
    let end = k;
    for (let p = k; p < ops.length; p++) {
      if (ops[p].t !== ' ') end = p;
      else if (p - end > 2 * CONTEXT) break;
    }
    const from = Math.max(0, k - CONTEXT);
    const to = Math.min(ops.length - 1, end + CONTEXT);
    out.push(`@@ golden line ${Math.max(1, ops[from].ai)} / actual line ${Math.max(1, ops[from].bi)} @@`);
    for (let p = from; p <= to; p++) out.push(`${ops[p].t} ${ops[p].text}`);
    k = to + 1;
  }
  return out;
}
