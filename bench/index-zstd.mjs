#!/usr/bin/env node
/**
 * Benchmark: index a C codebase (zstd) with and without LSP (clangd).
 *
 * Usage:
 *   node bench/index-zstd.mjs --root <path-to-zstd> [--runs N] [--label LABEL]
 *
 * Runs three scenarios:
 *   1. Full index WITHOUT LSP
 *   2. Full index WITH LSP (clangd)
 *   3. Incremental re-index with no changes (WITH LSP)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const LORE_ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(LORE_ROOT, 'dist/cli.js');

// Parse args
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

const ROOT = flag('--root');
if (!ROOT || !existsSync(ROOT)) {
  console.error('Usage: node bench/index-zstd.mjs --root <path-to-zstd> [--runs N] [--label LABEL]');
  process.exit(1);
}

const RUNS = Number(flag('--runs') ?? 3);
const LABEL = flag('--label') ?? 'default';
const DB_PATH = resolve(LORE_ROOT, '.bench-zstd.db');

function cleanup() {
  for (const suffix of ['', '-wal', '-shm', '.log']) {
    const p = DB_PATH.replace('.db', '') + suffix;
    if (existsSync(p)) unlinkSync(p);
    const p2 = DB_PATH + suffix;
    if (existsSync(p2)) try { unlinkSync(p2); } catch {}
  }
}

function runIndex(extraArgs = []) {
  const start = performance.now();
  execFileSync('node', [
    CLI, 'index',
    '--root', ROOT,
    '--db', DB_PATH,
    '--log-level', 'silent',
    '--language', 'c',
    ...extraArgs,
  ], {
    cwd: LORE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
  const elapsed = performance.now() - start;
  const dbSize = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;
  return { elapsed, dbSize };
}

function runRefresh(extraArgs = []) {
  const start = performance.now();
  execFileSync('node', [
    CLI, 'refresh',
    '--root', ROOT,
    '--db', DB_PATH,
    '--log-level', 'silent',
    ...extraArgs,
  ], {
    cwd: LORE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
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

function runScenario(label, runs, fn) {
  console.error(`\n=== ${LABEL}: ${label} (${runs} runs) ===`);
  const results = [];
  for (let i = 0; i < runs; i++) {
    console.error(`  Run ${i + 1}/${runs}...`);
    const { time, dbSize } = fn(i);
    const ms = Math.round(time);
    const extra = dbSize ? ` (db: ${(dbSize / 1024).toFixed(0)} KB)` : '';
    console.error(`    ${ms}ms${extra}`);
    results.push(ms);
  }
  return results;
}

// ── Scenario 1: Full index, NO LSP ───────────────────────────────────────────

const fullNoLsp = runScenario('Full index, no LSP', RUNS, () => {
  cleanup();
  const { elapsed, dbSize } = runIndex(['--no-lsp']);
  return { time: elapsed, dbSize };
});

// ── Scenario 2: Full index, WITH LSP (clangd) ───────────────────────────────

const fullWithLsp = runScenario('Full index, WITH LSP (clangd)', RUNS, () => {
  cleanup();
  const { elapsed, dbSize } = runIndex(['--lsp']);
  return { time: elapsed, dbSize };
});

// ── Scenario 3: Incremental re-index, no changes, WITH LSP ──────────────────

// Leave DB from last full-with-LSP run; do a fresh one first.
cleanup();
runIndex(['--lsp']);

const incrNoChange = runScenario('Incremental re-index, no changes, WITH LSP', RUNS, () => {
  const time = runRefresh(['--lsp']);
  return { time };
});

cleanup();

const output = {
  label: LABEL,
  target: ROOT,
  runs: RUNS,
  fullNoLsp: { times: fullNoLsp, ...summarise(fullNoLsp) },
  fullWithLsp: { times: fullWithLsp, ...summarise(fullWithLsp) },
  incrNoChange: { times: incrNoChange, ...summarise(incrNoChange) },
};

console.log(JSON.stringify(output, null, 2));
