#!/usr/bin/env node
/**
 * Benchmark: index Lore (TypeScript) against itself WITH LSP enabled.
 *
 * This exercises the LSP batching optimization (P0a/P0b) which is the
 * highest-impact change, since typescript-language-server + Lore's
 * ~1000 symbols / ~5000 refs creates thousands of LSP targets.
 *
 * Usage:
 *   node bench/index-lsp.mjs [--runs N] [--label LABEL]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = resolve(ROOT, 'dist/cli.js');
const DB_PATH = resolve(ROOT, '.bench-lsp.db');
const LOG_PATH = resolve(ROOT, '.bench-lsp.log');

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const RUNS = Number(flag('--runs') ?? 3);
const LABEL = flag('--label') ?? 'default';

function cleanup() {
  for (const p of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm', LOG_PATH]) {
    if (existsSync(p)) try { unlinkSync(p); } catch {}
  }
}

function runIndex(withLsp) {
  const lspFlag = withLsp ? '--lsp' : '--no-lsp';
  const start = performance.now();
  execFileSync('node', [
    CLI, 'index', '--root', ROOT, '--db', DB_PATH,
    '--log-level', 'info', '--log-file', LOG_PATH,
    lspFlag,
  ], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
  const elapsed = performance.now() - start;
  const dbSize = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;

  // Extract stage timings from structured log
  let lspMs = null;
  let sourceMs = null;
  let resolutionMs = null;
  try {
    const log = readFileSync(LOG_PATH, 'utf8');
    for (const line of log.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.message === 'stage:lsp-enrichment complete') lspMs = entry.durationMs;
        if (entry.message === 'stage:source-index complete') sourceMs = entry.durationMs;
        if (entry.message === 'stage:symbol-resolution complete') resolutionMs = entry.durationMs;
      } catch {}
    }
  } catch {}

  return { elapsed, dbSize, lspMs, sourceMs, resolutionMs };
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

console.error(`\n${'='.repeat(60)}`);
console.error(`Benchmark: Lore self-index WITH LSP (${LABEL})`);
console.error(`Target: ${ROOT} (~70 TS files, ~1000 symbols, ~5000 refs)`);
console.error(`Runs: ${RUNS}`);
console.error(`${'='.repeat(60)}`);

// ── Full index WITHOUT LSP (control) ─────────────────────────────────────────

console.error(`\n--- Full index, NO LSP ---`);
const noLspResults = [];
for (let i = 0; i < RUNS; i++) {
  cleanup();
  console.error(`  Run ${i + 1}/${RUNS}...`);
  const r = runIndex(false);
  console.error(`    ${Math.round(r.elapsed)}ms total | source: ${r.sourceMs}ms`);
  noLspResults.push({ total: Math.round(r.elapsed), source: r.sourceMs });
}

// ── Full index WITH LSP ──────────────────────────────────────────────────────

console.error(`\n--- Full index, WITH LSP (typescript-language-server) ---`);
const withLspResults = [];
for (let i = 0; i < RUNS; i++) {
  cleanup();
  console.error(`  Run ${i + 1}/${RUNS}...`);
  const r = runIndex(true);
  console.error(`    ${Math.round(r.elapsed)}ms total | lsp: ${r.lspMs}ms | source: ${r.sourceMs}ms | resolution: ${r.resolutionMs}ms`);
  withLspResults.push({
    total: Math.round(r.elapsed),
    lsp: r.lspMs,
    source: r.sourceMs,
    resolution: r.resolutionMs,
  });
}

cleanup();

const output = {
  label: LABEL,
  runs: RUNS,
  noLsp: {
    totals: noLspResults.map(r => r.total),
    ...summarise(noLspResults.map(r => r.total)),
  },
  withLsp: {
    totals: withLspResults.map(r => r.total),
    ...summarise(withLspResults.map(r => r.total)),
    lspPhase: {
      times: withLspResults.map(r => r.lsp),
      ...summarise(withLspResults.map(r => r.lsp).filter(Boolean)),
    },
    resolutionPhase: {
      times: withLspResults.map(r => r.resolution),
      ...summarise(withLspResults.map(r => r.resolution).filter(Boolean)),
    },
  },
};

console.log(JSON.stringify(output, null, 2));
