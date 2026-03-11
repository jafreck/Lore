/**
 * Integration test: Runs the Copilot CLI agent against a pinned clone of the
 * Lore codebase.
 *
 * The repo is cloned at the exact SHA specified in `PILOT_REPOS` so that
 * expected answers never diverge as the codebase evolves.
 *
 * Requires:
 * - `copilot` CLI installed and authenticated
 * - Lore built (`npm run build`)
 * - Set env `BENCHMARK_COPILOT=1` to run these tests (skipped by default)
 *
 * These tests make real API calls and cost real tokens.
 *
 * Env vars:
 * - BENCHMARK_COPILOT=1      Enable the test suite
 * - BENCHMARK_MODEL=<model>  Model to use (default: claude-opus-4.6)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { RepoManager } from '../../src/benchmark/repo-manager.js';
import { indexRepo } from '../../src/benchmark/indexer.js';
import { runCopilotAgent, type CopilotAgentOptions } from '../../src/benchmark/copilot-agent.js';
import { scoreRun, aggregateScores, formatReport, compareReports } from '../../src/benchmark/scorer.js';
import { getTasksForRepo } from '../../src/benchmark/tasks.js';
import { PILOT_REPOS } from '../../src/benchmark/repos.js';
import type { RunScore } from '../../src/benchmark/types.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const SKIP = !process.env['BENCHMARK_COPILOT'];
const LORE_BUILD_ROOT = join(import.meta.dirname, '..', '..');
const WORK_DIR = mkdtempSync(join(tmpdir(), 'lore-copilot-bench-'));

const COPILOT_OPTIONS: CopilotAgentOptions = {
  model: process.env['BENCHMARK_MODEL'] ?? 'claude-opus-4.6',
  timeoutMs: 180_000,
};

// Target repo: override with BENCHMARK_REPO=esbuild (etc.), default lore-self
const TARGET_REPO = process.env['BENCHMARK_REPO'] ?? 'lore-self';
const repoSpec = PILOT_REPOS.find((r) => r.name === TARGET_REPO)!;
const COPILOT_TASKS = getTasksForRepo(TARGET_REPO);
const INDEX_MODE = (process.env['BENCHMARK_INDEX_MODE'] ?? 'scip') as 'tree-sitter' | 'scip' | 'full';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(SKIP)(`Copilot agent benchmark: ${TARGET_REPO}`, () => {
  const repoManager = new RepoManager(WORK_DIR);
  let repoPath: string;
  let dbPath: string;

  beforeAll(async () => {
    // Ensure Lore MCP server is built (used by lore-enabled arm)
    try {
      execFileSync('npm', ['run', 'build'], { cwd: LORE_BUILD_ROOT, stdio: 'pipe' });
    } catch {
      // Build may already be up-to-date
    }

    // Clone target repo at pinned SHA
    const instance = await repoManager.prepare(repoSpec);
    repoPath = instance.localPath;

    // Index the cloned repo
    const indexed = await indexRepo(instance, { mode: INDEX_MODE });
    dbPath = indexed.dbPath!;

    expect(indexed.indexed).toBe(true);
    console.log(`\n${TARGET_REPO} cloned at ${repoSpec.sha.slice(0, 8)}, indexed in ${indexed.indexTimeMs}ms`);
    console.log(`DB: ${dbPath}\nModel: ${COPILOT_OPTIONS.model}\nTasks: ${COPILOT_TASKS.length}\n`);
  }, 300_000);

  afterAll(async () => {
    await repoManager.removeAll();
  });

  // ─── Per-task tests ─────────────────────────────────────────────────────

  for (const task of COPILOT_TASKS) {
    describe(`Task: ${task.id}`, () => {
      it('control arm should produce an answer with measurable metrics', async () => {
        const startPerf = performance.now();
        const trace = await runCopilotAgent(task, 'control', repoPath, undefined, COPILOT_OPTIONS);
        const wallTimeMs = Math.round(performance.now() - startPerf);

        expect(trace.finalAnswer.length).toBeGreaterThan(0);
        expect(trace.loreToolsCalled).toHaveLength(0);

        const score = scoreRun(task, trace, wallTimeMs);

        // Wallclock time must be captured (non-zero)
        expect(score.wallTimeMs).toBeGreaterThan(0);
        // Token usage must be captured
        expect(score.tokensUsed).toBeGreaterThan(0);
        // Correctness must be computed (0–1)
        expect(score.correctness).toBeGreaterThanOrEqual(0);
        expect(score.correctness).toBeLessThanOrEqual(1);

        console.log(`[control] ${task.id}: success=${score.taskSuccess} correctness=${score.correctness.toFixed(2)} ans_cov=${score.answerCoverage.toFixed(2)} file_cov=${score.fileCoverage.toFixed(2)} sym_cov=${score.symbolCoverage.toFixed(2)} tools=${score.toolCallCount} tokens=${score.tokensUsed} wall=${(score.wallTimeMs / 1000).toFixed(1)}s`);
      }, 300_000);

      it('lore-enabled arm should produce an answer AND use Lore tools with measurable metrics', async () => {
        const startPerf = performance.now();
        const trace = await runCopilotAgent(task, 'lore-enabled', repoPath, dbPath, COPILOT_OPTIONS);
        const wallTimeMs = Math.round(performance.now() - startPerf);

        expect(trace.finalAnswer.length).toBeGreaterThan(0);
        // KEY ASSERTION: the Lore-enabled agent must actually call Lore tools
        expect(trace.loreToolsCalled.length).toBeGreaterThan(0);

        const score = scoreRun(task, trace, wallTimeMs);

        // Wallclock time must be captured (non-zero)
        expect(score.wallTimeMs).toBeGreaterThan(0);
        // Token usage must be captured
        expect(score.tokensUsed).toBeGreaterThan(0);
        // Correctness must be computed (0–1)
        expect(score.correctness).toBeGreaterThanOrEqual(0);
        expect(score.correctness).toBeLessThanOrEqual(1);

        expect(score.loreToolCallCount).toBeGreaterThan(0);

        console.log(`[lore]    ${task.id}: success=${score.taskSuccess} correctness=${score.correctness.toFixed(2)} ans_cov=${score.answerCoverage.toFixed(2)} file_cov=${score.fileCoverage.toFixed(2)} sym_cov=${score.symbolCoverage.toFixed(2)} tools=${score.toolCallCount} tokens=${score.tokensUsed} wall=${(score.wallTimeMs / 1000).toFixed(1)}s lore=[${score.loreToolsUsed.join(',')}]`);
      }, 300_000);
    });
  }

  // ─── Aggregate comparison ───────────────────────────────────────────────

  it('aggregate: full report — control vs lore-enabled', async () => {
    const controlScores: RunScore[] = [];
    const loreScores: RunScore[] = [];

    for (const task of COPILOT_TASKS) {
      // Control arm
      const ctrlStart = performance.now();
      const ctrlTrace = await runCopilotAgent(task, 'control', repoPath, undefined, COPILOT_OPTIONS);
      const ctrlWall = Math.round(performance.now() - ctrlStart);
      controlScores.push(scoreRun(task, ctrlTrace, ctrlWall));

      // Lore arm
      const loreStart = performance.now();
      const loreTrace = await runCopilotAgent(task, 'lore-enabled', repoPath, dbPath, COPILOT_OPTIONS);
      const loreWall = Math.round(performance.now() - loreStart);
      loreScores.push(scoreRun(task, loreTrace, loreWall));

      // Per-task detail
      const cs = controlScores[controlScores.length - 1]!;
      const ls = loreScores[loreScores.length - 1]!;
      console.log(`\n── ${task.id} (${task.family}) ──`);
      console.log(`  CONTROL: success=${cs.taskSuccess} correctness=${cs.correctness.toFixed(2)} ans=${cs.answerCoverage.toFixed(2)} file=${cs.fileCoverage.toFixed(2)} sym=${cs.symbolCoverage.toFixed(2)} tools=${cs.toolCallCount} tokens=${cs.tokensUsed} wall=${(cs.wallTimeMs / 1000).toFixed(1)}s`);
      console.log(`  LORE:    success=${ls.taskSuccess} correctness=${ls.correctness.toFixed(2)} ans=${ls.answerCoverage.toFixed(2)} file=${ls.fileCoverage.toFixed(2)} sym=${ls.symbolCoverage.toFixed(2)} tools=${ls.toolCallCount} tokens=${ls.tokensUsed} wall=${(ls.wallTimeMs / 1000).toFixed(1)}s lore=[${ls.loreToolsUsed.join(',')}]`);
    }

    const controlReport = aggregateScores('control', controlScores);
    const loreReport = aggregateScores('lore-enabled', loreScores);

    console.log('\n\n═══════════════════════════════════════');
    console.log('         BENCHMARK RESULTS');
    console.log('═══════════════════════════════════════\n');
    console.log(`Model: ${COPILOT_OPTIONS.model}`);
    console.log(`Tasks: ${COPILOT_TASKS.length}\n`);
    console.log(formatReport(controlReport));
    console.log('\n' + formatReport(loreReport));
    console.log('\n' + compareReports(controlReport, loreReport));

    // Both arms should complete all tasks
    expect(controlReport.totalRuns).toBe(COPILOT_TASKS.length);
    expect(loreReport.totalRuns).toBe(COPILOT_TASKS.length);

    // Lore arm should use Lore tools
    expect(loreReport.loreToolUsageRate).toBeGreaterThan(0);

    // Wallclock time and tokens should be non-zero across all runs
    expect(controlReport.meanWallTimeMs).toBeGreaterThan(0);
    expect(loreReport.meanWallTimeMs).toBeGreaterThan(0);
    expect(controlReport.meanTokens).toBeGreaterThan(0);
    expect(loreReport.meanTokens).toBeGreaterThan(0);

    // Correctness should be computed for both arms
    expect(controlReport.meanCorrectness).toBeGreaterThanOrEqual(0);
    expect(loreReport.meanCorrectness).toBeGreaterThanOrEqual(0);
  }, 600_000);
});
