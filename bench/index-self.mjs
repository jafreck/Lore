#!/usr/bin/env node
/**
 * Benchmark script: indexes the Lore project against itself and reports timing.
 *
 * Tests both full (cold) indexing and incremental (warm) re-indexing to
 * measure the impact of optimisations like stat-based skip, bulk lookups, etc.
 *
 * Usage:
 *   node bench/index-self.mjs [--runs N] [--label LABEL]
 *
 * Outputs JSON with per-run and aggregate timing for each scenario.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(ROOT, 'dist/cli.js');
const DB_PATH = resolve(ROOT, '.bench-lore.db');

// Parse args
const args = process.argv.slice(2);
const runsIdx = args.indexOf('--runs');
const RUNS = runsIdx !== -1 ? Number(args[runsIdx + 1]) : 3;
const labelIdx = args.indexOf('--label');
const LABEL = labelIdx !== -1 ? args[labelIdx + 1] : 'default';

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

function runIndex() {
  const start = performance.now();
  execFileSync('node', [CLI, 'index', '--root', ROOT, '--db', DB_PATH, '--log-level', 'silent'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  const elapsed = performance.now() - start;
  const dbSize = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;
  return { elapsed, dbSize };
}

function runRefresh() {
  const start = performance.now();
  execFileSync('node', [CLI, 'refresh', '--root', ROOT, '--db', DB_PATH, '--log-level', 'silent'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  return performance.now() - start;
}

function summarise(times) {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    avgMs: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    medianMs: sorted[Math.floor(sorted.length / 2)],
    minMs: Math.min(...sorted),
    maxMs: Math.max(...sorted),
  };
}

// ── Full (cold) index ─────────────────────────────────────────────────────────

console.error(`\n=== ${LABEL}: Full index (${RUNS} runs) ===`);
const fullResults = [];
for (let i = 0; i < RUNS; i++) {
  cleanup();
  console.error(`  Run ${i + 1}/${RUNS}...`);
  const { elapsed, dbSize } = runIndex();
  const ms = Math.round(elapsed);
  console.error(`    ${ms}ms (db: ${(dbSize / 1024).toFixed(0)} KB)`);
  fullResults.push(ms);
}

// ── Incremental re-index (no changes) ─────────────────────────────────────────

console.error(`\n=== ${LABEL}: Incremental re-index, no changes (${RUNS} runs) ===`);
// Leave the DB from the last full run in place.
cleanup();
runIndex(); // fresh DB for re-index
const incrNoChangeResults = [];
for (let i = 0; i < RUNS; i++) {
  console.error(`  Run ${i + 1}/${RUNS}...`);
  const elapsed = runRefresh();
  const ms = Math.round(elapsed);
  console.error(`    ${ms}ms`);
  incrNoChangeResults.push(ms);
}

// ── Incremental re-index (1 file touched) ─────────────────────────────────────

console.error(`\n=== ${LABEL}: Incremental re-index, 1 file touched (${RUNS} runs) ===`);
const touchTarget = resolve(ROOT, 'src/indexer/index.ts');
const incrOneFileResults = [];
for (let i = 0; i < RUNS; i++) {
  // Touch one file to force re-processing
  const content = readFileSync(touchTarget, 'utf8');
  writeFileSync(touchTarget, content + ' ', 'utf8');
  console.error(`  Run ${i + 1}/${RUNS}...`);
  const elapsed = runRefresh();
  const ms = Math.round(elapsed);
  console.error(`    ${ms}ms`);
  incrOneFileResults.push(ms);
  // Restore original
  writeFileSync(touchTarget, content, 'utf8');
  runRefresh(); // re-index with original to reset DB
}

cleanup();

const output = {
  label: LABEL,
  runs: RUNS,
  fullIndex: { times: fullResults, ...summarise(fullResults) },
  incrNoChange: { times: incrNoChangeResults, ...summarise(incrNoChangeResults) },
  incrOneFile: { times: incrOneFileResults, ...summarise(incrOneFileResults) },
};

console.log(JSON.stringify(output, null, 2));
