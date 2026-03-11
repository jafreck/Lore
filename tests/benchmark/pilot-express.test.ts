/**
 * Integration test: Clones Express, indexes it with Lore, and runs
 * benchmark tasks across control and lore-enabled arms.
 *
 * This test makes real git clone calls and takes ~1-2 minutes.
 * Set env `BENCHMARK_PILOT=1` to run (skipped by default to keep CI fast).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { existsSync, unlinkSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { RepoManager } from '../../src/benchmark/repo-manager.js';
import { indexRepo } from '../../src/benchmark/indexer.js';
import { buildToolsForArm } from '../../src/benchmark/tool-providers.js';
import { runScriptedAgent, runProgrammaticAgent } from '../../src/benchmark/agent.js';
import { buildControlStrategy, buildLoreStrategy, buildDynamicLoreStrategy } from '../../src/benchmark/strategies.js';
import { scoreRun, aggregateScores, formatReport, compareReports } from '../../src/benchmark/scorer.js';
import { EXPRESS_TASKS } from '../../src/benchmark/tasks.js';
import { PILOT_REPOS } from '../../src/benchmark/repos.js';
import type { RunScore } from '../../src/benchmark/types.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const SKIP = !process.env['BENCHMARK_PILOT'];
const WORK_DIR = mkdtempSync(join(tmpdir(), 'lore-pilot-bench-'));

describe.skipIf(SKIP)('Pilot repo benchmark: Express', () => {
  const repoManager = new RepoManager(WORK_DIR);
  let repoPath: string;
  let dbPath: string;

  const expressSpec = PILOT_REPOS.find((r) => r.name === 'express')!;

  beforeAll(async () => {
    // Clone Express at pinned SHA
    let instance = await repoManager.prepare(expressSpec);
    repoPath = instance.localPath;

    // Index with Lore
    instance = await indexRepo(instance);
    dbPath = instance.dbPath!;

    expect(instance.indexed).toBe(true);
    expect(instance.indexTimeMs).toBeGreaterThan(0);
    console.log(`Express indexed in ${instance.indexTimeMs}ms`);
  }, 300_000); // 5 min for clone + index

  afterAll(async () => {
    await repoManager.removeAll();
  });

  // ─── Per-task tests ─────────────────────────────────────────────────────

  for (const task of EXPRESS_TASKS) {
    describe(`Task ${task.id} (${task.family})`, () => {
      it('control arm produces a result', async () => {
        const tools = await buildToolsForArm('control', repoPath);
        const strategy = buildControlStrategy(task);
        const trace = await runScriptedAgent(strategy, tools);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);
        // Control arm should NOT use Lore tools
        expect(trace.loreToolsCalled).toHaveLength(0);
      });

      it('lore-enabled arm produces a result and uses Lore tools', async () => {
        const tools = await buildToolsForArm('lore-enabled', repoPath, dbPath);
        const strategy = buildDynamicLoreStrategy(task);
        const trace = await runProgrammaticAgent(strategy, task, tools);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);
        // Lore arm MUST use Lore tools
        expect(trace.loreToolsCalled.length).toBeGreaterThan(0);
      });
    });
  }

  // ─── Aggregate comparison ───────────────────────────────────────────────

  it('aggregate: control vs lore-enabled', async () => {
    const controlScores: RunScore[] = [];
    const loreScores: RunScore[] = [];

    for (const task of EXPRESS_TASKS) {
      // Control
      const controlTools = await buildToolsForArm('control', repoPath);
      const controlStrategy = buildControlStrategy(task);
      const ctrlStart = performance.now();
      const controlTrace = await runScriptedAgent(controlStrategy, controlTools);
      controlScores.push(scoreRun(task, controlTrace, Math.round(performance.now() - ctrlStart)));

      // Lore
      const loreTools = await buildToolsForArm('lore-enabled', repoPath, dbPath);
      const loreStrategy = buildDynamicLoreStrategy(task);
      const loreStart = performance.now();
      const loreTrace = await runProgrammaticAgent(loreStrategy, task, loreTools);
      loreScores.push(scoreRun(task, loreTrace, Math.round(performance.now() - loreStart)));
    }

    const controlReport = aggregateScores('control', controlScores);
    const loreReport = aggregateScores('lore-enabled', loreScores);

    console.log('\n' + formatReport(controlReport));
    console.log('\n' + formatReport(loreReport));
    console.log('\n' + compareReports(controlReport, loreReport));

    // Both arms should complete all tasks
    expect(controlReport.totalRuns).toBe(EXPRESS_TASKS.length);
    expect(loreReport.totalRuns).toBe(EXPRESS_TASKS.length);

    // Lore arm should actually use Lore tools
    expect(loreReport.loreToolUsageRate).toBeGreaterThan(0);
    expect(loreReport.allLoreToolsUsed.length).toBeGreaterThan(0);

    // Control arm should NOT use Lore tools
    expect(controlReport.loreToolUsageRate).toBe(0);
  }, 120_000);
});
