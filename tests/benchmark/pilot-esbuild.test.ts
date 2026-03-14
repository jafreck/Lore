/**
 * Integration test: Clones esbuild, indexes it with Lore, and runs
 * benchmark tasks across control and lore-enabled arms.
 *
 * This test makes real git clone calls and takes several minutes.
 * Set env `BENCHMARK_PILOT=1` to run (skipped by default to keep CI fast).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { RepoManager } from './util/repo-manager.js';
import { indexRepo } from './util/indexer.js';
import { buildToolsForArm } from './util/tool-providers.js';
import { runScriptedAgent, runProgrammaticAgent } from './util/agent.js';
import { buildControlStrategy, buildDynamicLoreStrategy } from './util/strategies.js';
import { scoreRun, aggregateScores, formatReport, compareReports } from './util/scorer.js';
import { getTasksForRepo } from './util/tasks.js';
import { PILOT_REPOS } from './util/repos.js';
import type { RunScore } from './util/types.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const SKIP = !process.env['BENCHMARK_PILOT'];
const WORK_DIR = mkdtempSync(join(tmpdir(), 'lore-pilot-esbuild-'));
const ESBUILD_TASKS = getTasksForRepo('esbuild');

describe.skipIf(SKIP)('Pilot repo benchmark: esbuild', () => {
  const repoManager = new RepoManager(WORK_DIR);
  let repoPath: string;
  let dbPath: string;

  const controlScores: RunScore[] = [];
  const loreScores: RunScore[] = [];

  const esbuildSpec = PILOT_REPOS.find((r) => r.name === 'esbuild')!;

  beforeAll(async () => {
    // Clone esbuild at pinned SHA
    let instance = await repoManager.prepare(esbuildSpec);
    repoPath = instance.localPath;

    // Index with Lore
    instance = await indexRepo(instance);
    dbPath = instance.dbPath!;

    expect(instance.indexed).toBe(true);
    expect(instance.indexTimeMs).toBeGreaterThan(0);
    console.log(`esbuild indexed in ${instance.indexTimeMs}ms`);
  }, 600_000); // 10 min for clone + index (esbuild is large)

  afterAll(async () => {
    await repoManager.removeAll();
  });

  // ─── Per-task tests ─────────────────────────────────────────────────────

  for (const task of ESBUILD_TASKS) {
    describe(`Task ${task.id} (${task.family})`, () => {
      it('control arm produces a result', async () => {
        const tools = await buildToolsForArm('control', repoPath);
        const strategy = buildControlStrategy(task);
        const ctrlStart = performance.now();
        const trace = await runScriptedAgent(strategy, tools);
        const ctrlWall = Math.round(performance.now() - ctrlStart);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);
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
        expect(trace.loreToolsCalled.length).toBeGreaterThan(0);

        loreScores.push(scoreRun(task, trace, loreWall));
      });
    });
  }

  // ─── Aggregate comparison ───────────────────────────────────────────────

  it('aggregate: control vs lore-enabled', () => {
    expect(controlScores.length).toBe(ESBUILD_TASKS.length);
    expect(loreScores.length).toBe(ESBUILD_TASKS.length);

    const controlReport = aggregateScores('control', controlScores);
    const loreReport = aggregateScores('lore-enabled', loreScores);

    console.log('\n' + formatReport(controlReport));
    console.log('\n' + formatReport(loreReport));
    console.log('\n' + compareReports(controlReport, loreReport));

    expect(controlReport.totalRuns).toBe(ESBUILD_TASKS.length);
    expect(loreReport.totalRuns).toBe(ESBUILD_TASKS.length);

    expect(loreReport.loreToolUsageRate).toBeGreaterThan(0);
    expect(loreReport.allLoreToolsUsed.length).toBeGreaterThan(0);

    expect(controlReport.loreToolUsageRate).toBe(0);
  });
});
