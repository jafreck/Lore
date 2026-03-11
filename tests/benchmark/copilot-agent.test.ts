/**
 * Integration test: Runs the Copilot CLI agent against the Lore codebase.
 *
 * Requires:
 * - `copilot` CLI installed and authenticated
 * - Lore built (`npm run build`)
 * - Set env `BENCHMARK_COPILOT=1` to run these tests (skipped by default)
 *
 * These tests make real API calls and cost real tokens.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { IndexBuilder } from '../../src/indexer/index.js';
import { runCopilotAgent, type CopilotAgentOptions } from '../../src/benchmark/copilot-agent.js';
import { scoreRun } from '../../src/benchmark/scorer.js';
import { LORE_SELF_TASKS } from '../../src/benchmark/tasks.js';
import type { BenchmarkTask } from '../../src/benchmark/types.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const SKIP = !process.env['BENCHMARK_COPILOT'];
const LORE_ROOT = join(import.meta.dirname, '..', '..');
const DB_DIR = mkdtempSync(join(tmpdir(), 'lore-copilot-bench-'));
const DB_PATH = join(DB_DIR, 'lore-bench.db');

const COPILOT_OPTIONS: CopilotAgentOptions = {
  model: process.env['BENCHMARK_MODEL'] ?? 'gpt-5-mini',
  timeoutMs: 120_000,
};

// Pick a subset of tasks for the copilot test (to limit API cost)
const COPILOT_TASKS = LORE_SELF_TASKS.filter((t) =>
  ['lore-1.1-callers-of-openDb', 'lore-3.2-reverse-deps-of-db', 'lore-9.1-architecture-overview'].includes(t.id),
);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('Copilot agent benchmark', () => {
  beforeAll(async () => {
    // Ensure Lore is built
    try {
      execFileSync('npm', ['run', 'build'], { cwd: LORE_ROOT, stdio: 'pipe' });
    } catch {
      // Build may already be up-to-date
    }

    // Index the Lore repo
    const builder = new IndexBuilder(DB_PATH, { rootDir: LORE_ROOT }, undefined, {
      history: { depth: 50 },
      docsAutoNotes: true,
      indexDependencies: false,
    });
    await builder.build();
  }, 180_000);

  afterAll(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      const p = DB_PATH + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  for (const task of COPILOT_TASKS) {
    describe(`Task: ${task.id}`, () => {
      it('control arm (no Lore tools) should produce an answer', async () => {
        const trace = await runCopilotAgent(task, 'control', LORE_ROOT, undefined, COPILOT_OPTIONS);

        expect(trace.finalAnswer.length).toBeGreaterThan(0);
        expect(trace.loreToolsCalled).toHaveLength(0);

        const score = scoreRun(task, trace, 0);
        console.log(`[control] ${task.id}: success=${score.taskSuccess} answer_cov=${score.answerCoverage.toFixed(2)} lore_calls=${score.loreToolCallCount}`);
      }, 180_000);

      it('lore-enabled arm should produce an answer AND use Lore tools', async () => {
        const trace = await runCopilotAgent(task, 'lore-enabled', LORE_ROOT, DB_PATH, COPILOT_OPTIONS);

        expect(trace.finalAnswer.length).toBeGreaterThan(0);
        // KEY ASSERTION: the Lore-enabled agent must actually call Lore tools
        expect(trace.loreToolsCalled.length).toBeGreaterThan(0);

        const score = scoreRun(task, trace, 0);
        console.log(`[lore]    ${task.id}: success=${score.taskSuccess} answer_cov=${score.answerCoverage.toFixed(2)} lore_calls=${score.loreToolCallCount} lore_tools=[${score.loreToolsUsed.join(',')}]`);

        expect(score.loreToolCallCount).toBeGreaterThan(0);
        expect(score.loreToolsUsed.length).toBeGreaterThan(0);
      }, 180_000);
    });
  }
});
