/**
 * Integration test: Clones jackson-databind, indexes it with Lore, and runs
 * benchmark tasks across control and lore-enabled arms.
 *
 * This test makes real git clone calls and takes ~1-2 minutes.
 * Set env `BENCHMARK_PILOT=1` to run (skipped by default to keep CI fast).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { existsSync, unlinkSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { RepoManager } from './util/repo-manager.js';
import { indexRepo } from './util/indexer.js';
import { buildToolsForArm } from './util/tool-providers.js';
import { runScriptedAgent, runProgrammaticAgent } from './util/agent.js';
import { buildControlStrategy, buildLoreStrategy, buildDynamicLoreStrategy } from './util/strategies.js';
import { scoreRun, aggregateScores, formatReport, compareReports } from './util/scorer.js';
import { getTasksForRepo } from './util/tasks.js';

const JACKSON_TASKS = getTasksForRepo('jackson-databind');
import { PILOT_REPOS } from './util/repos.js';
import type { RunScore } from './util/types.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const SKIP = !process.env['BENCHMARK_PILOT'];
const WORK_DIR = mkdtempSync(join(tmpdir(), 'lore-pilot-bench-'));

describe.skipIf(SKIP)('Pilot repo benchmark: jackson-databind', () => {
  const repoManager = new RepoManager(WORK_DIR);
  let repoPath: string;
  let dbPath: string;

  // Accumulated scores from per-task tests — consumed by the aggregate test
  const controlScores: RunScore[] = [];
  const loreScores: RunScore[] = [];

  const jacksonSpec = PILOT_REPOS.find((r) => r.name === 'jackson-databind')!;

  beforeAll(async () => {
    // Clone jackson-databind at pinned SHA
    let instance = await repoManager.prepare(jacksonSpec);
    repoPath = instance.localPath;

    // Index with Lore
    instance = await indexRepo(instance);
    dbPath = instance.dbPath!;

    expect(instance.indexed).toBe(true);
    expect(instance.indexTimeMs).toBeGreaterThan(0);
    console.log(`jackson-databind indexed in ${instance.indexTimeMs}ms`);
  }, 300_000); // 5 min for clone + index

  afterAll(async () => {
    await repoManager.removeAll();
  });

  // ─── Per-task tests ─────────────────────────────────────────────────────

  for (const task of JACKSON_TASKS) {
    describe(`Task ${task.id} (${task.family})`, () => {
      it('control arm produces a result', async () => {
        const tools = await buildToolsForArm('control', repoPath);
        const strategy = buildControlStrategy(task);
        const ctrlStart = performance.now();
        const trace = await runScriptedAgent(strategy, tools);
        const ctrlWall = Math.round(performance.now() - ctrlStart);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);
        // Control arm should NOT use Lore tools
        expect(trace.loreToolsCalled).toHaveLength(0);

        controlScores.push(scoreRun(task, trace, ctrlWall));
      });

      it('lore-enabled arm produces a result and uses Lore tools', async () => {
        const tools = await buildToolsForArm('lore-enabled', repoPath, dbPath);
        const strategy = buildDynamicLoreStrategy(task);
        const loreStart = performance.now();
        const trace = await runProgrammaticAgent(strategy, task, tools);
        const loreWall = Math.round(performance.now() - loreStart);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);
        // Lore arm MUST use Lore tools
        expect(trace.loreToolsCalled.length).toBeGreaterThan(0);

        loreScores.push(scoreRun(task, trace, loreWall));
      });
    });
  }

  // ─── Aggregate comparison ───────────────────────────────────────────────

  it('aggregate: control vs lore-enabled', () => {
    // Guard: per-task tests must have run first
    expect(controlScores.length).toBe(JACKSON_TASKS.length);
    expect(loreScores.length).toBe(JACKSON_TASKS.length);

    const controlReport = aggregateScores('control', controlScores);
    const loreReport = aggregateScores('lore-enabled', loreScores);

    console.log('\n' + formatReport(controlReport));
    console.log('\n' + formatReport(loreReport));
    console.log('\n' + compareReports(controlReport, loreReport));

    // Both arms should complete all tasks
    expect(controlReport.totalRuns).toBe(JACKSON_TASKS.length);
    expect(loreReport.totalRuns).toBe(JACKSON_TASKS.length);

    // Lore arm should actually use Lore tools
    expect(loreReport.loreToolUsageRate).toBeGreaterThan(0);
    expect(loreReport.allLoreToolsUsed.length).toBeGreaterThan(0);

    // Control arm should NOT use Lore tools
    expect(controlReport.loreToolUsageRate).toBe(0);
  });
});
