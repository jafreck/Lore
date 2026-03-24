/**
 * Integration test: Runs the Copilot CLI agent against a pinned clone of the
 * Lore codebase.
 *
 * The repo is cloned at the exact SHA specified in `PILOT_REPOS` so that
 * expected answers never diverge as the codebase evolves.
 *
 * Per-task arms (control vs lore-enabled) run concurrently to reduce
 * end-to-end wall-clock time.
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
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { RepoManager } from './util/repo-manager.js';
import { indexRepo } from './util/indexer.js';
import { runCopilotAgent, type CopilotAgentOptions } from './util/copilot-agent.js';
import { scoreRun, aggregateScores, formatReport, compareReports, formatToolFrequency, diagnoseExpectations, truncate, formatLoreToolArgs, buildStructuredTaskResult, buildStructuredReport } from './util/scorer.js';
import type { StructuredTaskResult } from './util/scorer.js';
import { getTasksForRepo } from './util/tasks.js';
import { PILOT_REPOS } from './util/repos.js';
import type { RunScore, AgentTrace, BenchmarkTask } from './util/types.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const SKIP = !process.env['BENCHMARK_COPILOT'];
const LORE_BUILD_ROOT = join(import.meta.dirname, '..', '..');
const WORK_DIR = mkdtempSync(join(tmpdir(), 'lore-copilot-bench-'));

// Per-repo timeout: large Java repos need more time for the agent to
// work through deep inheritance hierarchies.
const ARM_TIMEOUT_MS = (() => {
  const repo = process.env['BENCHMARK_REPO'] ?? 'lore-self';
  if (repo === 'jackson-databind') return 720_000; // 12 min — deep Java inheritance
  return 360_000; // 6 min default
})();

const COPILOT_OPTIONS: CopilotAgentOptions = {
  model: process.env['BENCHMARK_MODEL'] ?? 'claude-opus-4.6',
  timeoutMs: ARM_TIMEOUT_MS,
};

// Number of times to run each task (for statistical significance)
const ITERATIONS = Math.max(1, parseInt(process.env['BENCHMARK_ITERATIONS'] ?? '1', 10));

// Target repo: override with BENCHMARK_REPO=esbuild (etc.), default lore-self
const TARGET_REPO = process.env['BENCHMARK_REPO'] ?? 'lore-self';
const repoSpec = PILOT_REPOS.find((r) => r.name === TARGET_REPO)!;

// Optional question filter: BENCHMARK_QUESTION=6.1 or BENCHMARK_QUESTION=1.1,1.2
const QUESTION_FILTER = process.env['BENCHMARK_QUESTION']?.split(',').map((q) => q.trim()).filter(Boolean) ?? [];
const COPILOT_TASKS = (() => {
  const all = getTasksForRepo(TARGET_REPO);
  if (QUESTION_FILTER.length === 0) return all;
  const filtered = all.filter((t) => t.questionId && QUESTION_FILTER.includes(t.questionId));
  if (filtered.length === 0) {
    console.warn(`⚠ BENCHMARK_QUESTION=${process.env['BENCHMARK_QUESTION']} matched no tasks for ${TARGET_REPO}`);
  }
  return filtered;
})();

const INDEX_MODE = (process.env['BENCHMARK_INDEX_MODE'] ?? 'scip') as 'tree-sitter' | 'scip' | 'full';
const EMBEDDING_MODEL = process.env['BENCHMARK_EMBEDDING_MODEL'] ?? '';
const ENABLE_LSP = process.env['BENCHMARK_LSP'] === '1';

// Arm filter: BENCHMARK_ARM=control or BENCHMARK_ARM=lore to run only one arm
const ARM_FILTER = process.env['BENCHMARK_ARM'] as 'control' | 'lore' | undefined;

// ─── Per-task result storage (Map-based for concurrent safety) ────────────────

interface TaskResult {
  score: RunScore;
  trace: AgentTrace;
}
// Each key is `${taskId}:${iteration}` for multi-iteration support
const controlResults = new Map<string, TaskResult>();
const loreResults = new Map<string, TaskResult>();

// ─── Logging helpers ──────────────────────────────────────────────────────────

function logArmResult(arm: string, task: BenchmarkTask, score: RunScore, trace: AgentTrace): void {
  const diag = diagnoseExpectations(task, trace);
  const prefix = arm === 'control' ? '[control]' : '[lore]   ';
  console.log(`${prefix} ${task.id}: success=${score.taskSuccess} correctness=${score.correctness.toFixed(2)} file_cov=${score.fileCoverage.toFixed(2)} sym_cov=${score.symbolCoverage.toFixed(2)} tokens=${score.tokensUsed} wall=${(score.wallTimeMs / 1000).toFixed(1)}s`);
  console.log(`  tools: ${formatToolFrequency(trace.toolCalls)}`);
  if (arm === 'lore-enabled') {
    console.log(`  lore calls: ${formatLoreToolArgs(trace.toolCalls)}`);
  }
  console.log(`  answer: ${truncate(trace.finalAnswer.replace(/\n/g, ' '), 300)}`);
  if (diag.missed.length > 0) console.log(`  MISSED parts: [${diag.missed.join(', ')}]`);
}

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
    const indexed = await indexRepo(instance, {
      mode: INDEX_MODE,
      embeddingModel: EMBEDDING_MODEL || undefined,
      lsp: ENABLE_LSP,
    });
    dbPath = indexed.dbPath!;

    expect(indexed.indexed).toBe(true);
    console.log(`\n${TARGET_REPO} cloned at ${repoSpec.sha.slice(0, 8)}, indexed in ${indexed.indexTimeMs}ms`);
    console.log(`DB: ${dbPath}\nModel: ${COPILOT_OPTIONS.model}\nIndex: ${INDEX_MODE} | Embeddings: ${EMBEDDING_MODEL || 'none'} | LSP: ${ENABLE_LSP}\nTasks: ${COPILOT_TASKS.length} | Iterations: ${ITERATIONS}\n`);
  }, 1_800_000);

  afterAll(async () => {
    await repoManager.removeAll();
  });

  // ─── Per-task tests (control + lore run concurrently) ───────────────────

  for (const task of COPILOT_TASKS) {
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const iterLabel = ITERATIONS > 1 ? ` [iter ${iter + 1}]` : '';
      const resultKey = `${task.id}:${iter}`;

      it.concurrent(`${task.id}${iterLabel}: ${ARM_FILTER ?? 'control + lore-enabled'} arms`, async () => {
        const runControl = !ARM_FILTER || ARM_FILTER === 'control';
        const runLore = !ARM_FILTER || ARM_FILTER === 'lore';

        const runArm = async (arm: 'control' | 'lore-enabled', db?: string) => {
          const startPerf = performance.now();
          const trace = await runCopilotAgent(task, arm, repoPath, db, COPILOT_OPTIONS);
          const wallTimeMs = Math.round(performance.now() - startPerf);
          return { trace, wallTimeMs };
        };

        const controlResult = runControl ? await runArm('control') : undefined;
        const loreResult = runLore ? await runArm('lore-enabled', dbPath) : undefined;

        if (controlResult) {
          const controlScore = scoreRun(task, controlResult.trace, controlResult.wallTimeMs);
          controlResults.set(resultKey, { score: controlScore, trace: controlResult.trace });
          logArmResult('control', task, controlScore, controlResult.trace);

          expect(controlResult.trace.finalAnswer.length).toBeGreaterThan(0);
          expect(controlResult.trace.loreToolsCalled).toHaveLength(0);
          expect(controlScore.wallTimeMs).toBeGreaterThan(0);
          expect(controlScore.tokensUsed).toBeGreaterThan(0);
          expect(controlScore.correctness).toBeGreaterThanOrEqual(0);
          expect(controlScore.correctness).toBeLessThanOrEqual(1);
        }

        if (loreResult) {
          const loreScore = scoreRun(task, loreResult.trace, loreResult.wallTimeMs);
          loreResults.set(resultKey, { score: loreScore, trace: loreResult.trace });
          logArmResult('lore-enabled', task, loreScore, loreResult.trace);

          expect(loreResult.trace.finalAnswer.length).toBeGreaterThan(0);
          expect(loreResult.trace.loreToolsCalled.length).toBeGreaterThan(0);
          expect(loreScore.wallTimeMs).toBeGreaterThan(0);
          expect(loreScore.tokensUsed).toBeGreaterThan(0);
          expect(loreScore.correctness).toBeGreaterThanOrEqual(0);
          expect(loreScore.correctness).toBeLessThanOrEqual(1);
          expect(loreScore.loreToolCallCount).toBeGreaterThan(0);
        }
      }, ARM_TIMEOUT_MS * 2 + 60_000); // vitest timeout: both arms + 1 min buffer
    }
  }

  // ─── Aggregate comparison ───────────────────────────────────────────────

  it('aggregate: full report — control vs lore-enabled', () => {
    const totalExpectedRuns = COPILOT_TASKS.length * ITERATIONS;

    // Collect scores for whichever tasks completed (report is always printed)
    const controlScores: RunScore[] = [];
    const loreScores: RunScore[] = [];
    const structuredTasks: StructuredTaskResult[] = [];

    for (const task of COPILOT_TASKS) {
      for (let iter = 0; iter < ITERATIONS; iter++) {
        const key = `${task.id}:${iter}`;
        const cr = controlResults.get(key);
        const lr = loreResults.get(key);
        const iterLabel = ITERATIONS > 1 ? ` [iter ${iter + 1}]` : '';

        // In single-arm mode, only require that arm's result
        if (ARM_FILTER === 'control') {
          if (!cr) {
            console.log(`\n── ${task.id}${iterLabel} (${task.family}) ── SKIPPED (no result captured)`);
            continue;
          }
          controlScores.push(cr.score);
          console.log(`\n── ${task.id}${iterLabel} (${task.family}) ──`);
          console.log(`  CONTROL: success=${cr.score.taskSuccess} correctness=${cr.score.correctness.toFixed(2)} file=${cr.score.fileCoverage.toFixed(2)} sym=${cr.score.symbolCoverage.toFixed(2)} tokens=${cr.score.tokensUsed} wall=${(cr.score.wallTimeMs / 1000).toFixed(1)}s`);
          console.log(`    tools: ${formatToolFrequency(cr.trace.toolCalls)}`);
          continue;
        }

        if (ARM_FILTER === 'lore') {
          if (!lr) {
            console.log(`\n── ${task.id}${iterLabel} (${task.family}) ── SKIPPED (no result captured)`);
            continue;
          }
          loreScores.push(lr.score);
          console.log(`\n── ${task.id}${iterLabel} (${task.family}) ──`);
          console.log(`  LORE:    success=${lr.score.taskSuccess} correctness=${lr.score.correctness.toFixed(2)} file=${lr.score.fileCoverage.toFixed(2)} sym=${lr.score.symbolCoverage.toFixed(2)} tokens=${lr.score.tokensUsed} wall=${(lr.score.wallTimeMs / 1000).toFixed(1)}s`);
          console.log(`    tools: ${formatToolFrequency(lr.trace.toolCalls)}`);
          continue;
        }

        // Both-arm mode
        if (!cr || !lr) {
          console.log(`\n── ${task.id}${iterLabel} (${task.family}) ── SKIPPED (no result captured)`);
          continue;
        }
        controlScores.push(cr.score);
        loreScores.push(lr.score);

        const structuredTask = buildStructuredTaskResult(
          task, cr.score, cr.trace, lr.score, lr.trace,
          ITERATIONS > 1 ? iter + 1 : undefined,
        );
        structuredTasks.push(structuredTask);

        const tokenDelta = lr.score.tokensUsed - cr.score.tokensUsed;
        const tokenPct = cr.score.tokensUsed ? ((tokenDelta / cr.score.tokensUsed) * 100).toFixed(0) : 'N/A';
        const wallDelta = lr.score.wallTimeMs - cr.score.wallTimeMs;
        const wallPct = cr.score.wallTimeMs ? ((wallDelta / cr.score.wallTimeMs) * 100).toFixed(0) : 'N/A';
        const correctDelta = lr.score.correctness - cr.score.correctness;
        console.log(`\n── ${task.id}${iterLabel} (${task.family}) ──`);
        console.log(`  CONTROL: success=${cr.score.taskSuccess} correctness=${cr.score.correctness.toFixed(2)} file=${cr.score.fileCoverage.toFixed(2)} sym=${cr.score.symbolCoverage.toFixed(2)} tokens=${cr.score.tokensUsed} wall=${(cr.score.wallTimeMs / 1000).toFixed(1)}s`);
        console.log(`    tools: ${formatToolFrequency(cr.trace.toolCalls)}`);
        console.log(`  LORE:    success=${lr.score.taskSuccess} correctness=${lr.score.correctness.toFixed(2)} file=${lr.score.fileCoverage.toFixed(2)} sym=${lr.score.symbolCoverage.toFixed(2)} tokens=${lr.score.tokensUsed} wall=${(lr.score.wallTimeMs / 1000).toFixed(1)}s`);
        console.log(`    tools: ${formatToolFrequency(lr.trace.toolCalls)}`);
        console.log(`  DELTA:   correctness=${correctDelta >= 0 ? '+' : ''}${correctDelta.toFixed(2)}  tokens=${tokenDelta > 0 ? '+' : ''}${tokenDelta} (${tokenDelta > 0 ? '+' : ''}${tokenPct}%)  wall=${wallDelta > 0 ? '+' : ''}${(wallDelta / 1000).toFixed(1)}s (${wallDelta > 0 ? '+' : ''}${wallPct}%)`);
        if (lr.score.correctness < cr.score.correctness) {
          const loreDiag = diagnoseExpectations(task, lr.trace);
          console.log(`  ⚠ LORE WORSE on correctness — missed: [${loreDiag.missed.join(', ')}]`);
        }
        if (lr.score.tokensUsed > cr.score.tokensUsed * 1.5) {
          console.log(`  ⚠ LORE 50%+ MORE TOKENS — review tool strategy`);
        }
        if (lr.score.wallTimeMs > cr.score.wallTimeMs * 1.5) {
          console.log(`  ⚠ LORE 50%+ SLOWER — review tool strategy`);
        }
      }
    }

    console.log('\n\n═══════════════════════════════════════');
    console.log('         BENCHMARK RESULTS');
    console.log('═══════════════════════════════════════\n');
    console.log(`Model: ${COPILOT_OPTIONS.model}`);
    console.log(`Tasks: ${COPILOT_TASKS.length}`);
    console.log(`Iterations: ${ITERATIONS}`);
    console.log(`Arm filter: ${ARM_FILTER ?? 'both'}`);

    // Single-arm mode: report only the requested arm
    if (ARM_FILTER === 'control' && controlScores.length > 0) {
      const controlReport = aggregateScores('control', controlScores);
      console.log(`Completed runs: ${controlScores.length}/${totalExpectedRuns}\n`);
      console.log(formatReport(controlReport));
      expect(controlReport.totalRuns).toBe(totalExpectedRuns);
      expect(controlReport.meanWallTimeMs).toBeGreaterThan(0);
      expect(controlReport.meanTokens).toBeGreaterThan(0);
    } else if (ARM_FILTER === 'lore' && loreScores.length > 0) {
      const loreReport = aggregateScores('lore-enabled', loreScores);
      console.log(`Completed runs: ${loreScores.length}/${totalExpectedRuns}\n`);
      console.log(formatReport(loreReport));
      expect(loreReport.totalRuns).toBe(totalExpectedRuns);
      expect(loreReport.loreToolUsageRate).toBeGreaterThan(0);
      expect(loreReport.meanWallTimeMs).toBeGreaterThan(0);
      expect(loreReport.meanTokens).toBeGreaterThan(0);
    } else if (controlScores.length > 0 && loreScores.length > 0) {
      // Both-arm comparison mode
      const controlReport = aggregateScores('control', controlScores);
      const loreReport = aggregateScores('lore-enabled', loreScores);

      console.log(`Completed runs: ${controlScores.length}/${totalExpectedRuns}\n`);
      console.log(formatReport(controlReport));
      console.log('\n' + formatReport(loreReport));
      console.log('\n' + compareReports(controlReport, loreReport));

      const structuredReport = buildStructuredReport(
        {
          model: COPILOT_OPTIONS.model!,
          repo: TARGET_REPO,
          indexMode: INDEX_MODE,
          embeddingModel: EMBEDDING_MODEL || 'none',
          lsp: ENABLE_LSP,
          tasks: COPILOT_TASKS.length,
          iterations: ITERATIONS,
          completedRuns: controlScores.length,
          totalExpectedRuns,
          timestamp: new Date().toISOString(),
        },
        structuredTasks,
        controlReport,
        loreReport,
      );

      const outDir = join(LORE_BUILD_ROOT, '.benchmark-results');
      mkdirSync(outDir, { recursive: true });
      const jsonPath = join(outDir, `${TARGET_REPO}.json`);
      writeFileSync(jsonPath, JSON.stringify(structuredReport, null, 2) + '\n');
      console.log(`\nStructured report written to: ${jsonPath}`);

      // Assertions come AFTER the report is printed
      expect(controlReport.totalRuns).toBe(totalExpectedRuns);
      expect(loreReport.totalRuns).toBe(totalExpectedRuns);
      expect(loreReport.loreToolUsageRate).toBeGreaterThan(0);
      expect(controlReport.meanWallTimeMs).toBeGreaterThan(0);
      expect(loreReport.meanWallTimeMs).toBeGreaterThan(0);
      expect(controlReport.meanTokens).toBeGreaterThan(0);
      expect(loreReport.meanTokens).toBeGreaterThan(0);
      expect(controlReport.meanCorrectness).toBeGreaterThanOrEqual(0);
      expect(loreReport.meanCorrectness).toBeGreaterThanOrEqual(0);
    } else {
      console.log('\n⚠ No completed runs to report on.\n');
      expect(controlScores.length + loreScores.length).toBeGreaterThan(0);
    }
  });
});
