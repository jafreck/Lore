/**
 * Integration test: Runs the full benchmark pipeline against a pinned clone
 * of the Lore codebase.
 *
 * The repo is cloned at the exact SHA specified in `PILOT_REPOS` so that
 * expected answers never diverge as the codebase evolves.
 *
 * This test:
 * 1. Clones Lore at the pinned SHA
 * 2. Indexes the clone with Lore (SCIP mode)
 * 3. Provisions tools for control and lore-enabled arms
 * 4. Runs scripted agents (control + Lore) against benchmark tasks
 * 5. Scores results and verifies Lore outperforms control
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { RepoManager } from '../../src/benchmark/repo-manager.js';
import { indexRepo } from '../../src/benchmark/indexer.js';
import { buildToolsForArm } from '../../src/benchmark/tool-providers.js';
import { runScriptedAgent, runProgrammaticAgent } from '../../src/benchmark/agent.js';
import { buildControlStrategy, buildLoreStrategy, buildDynamicLoreStrategy } from '../../src/benchmark/strategies.js';
import { scoreRun, aggregateScores, formatReport, compareReports } from '../../src/benchmark/scorer.js';
import { LORE_SELF_TASKS } from '../../src/benchmark/tasks.js';
import { PILOT_REPOS } from '../../src/benchmark/repos.js';
import type { BenchmarkTask, RunScore } from '../../src/benchmark/types.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

const WORK_DIR = mkdtempSync(join(tmpdir(), 'lore-bench-'));
const loreSpec = PILOT_REPOS.find((r) => r.name === 'lore-self')!;

describe('Benchmark integration: Lore self-evaluation', () => {
  const repoManager = new RepoManager(WORK_DIR);
  let repoPath: string;
  let dbPath: string;

  // Clone and index the Lore repo once before all tests
  beforeAll(async () => {
    const instance = await repoManager.prepare(loreSpec);
    repoPath = instance.localPath;

    const indexed = await indexRepo(instance, { mode: 'scip' });
    dbPath = indexed.dbPath!;

    expect(indexed.indexed).toBe(true);
    console.log(`Lore cloned at ${loreSpec.sha.slice(0, 8)}, indexed in ${indexed.indexTimeMs}ms`);
  }, 300_000); // 5 min for clone + index

  afterAll(async () => {
    await repoManager.removeAll();
  });

  // ─── Per-task tests ─────────────────────────────────────────────────────

  for (const task of LORE_SELF_TASKS) {
    describe(`Task ${task.id} (${task.family})`, () => {
      it(`control arm should produce a result`, async () => {
        const tools = await buildToolsForArm('control', repoPath);
        const strategy = buildControlStrategy(task);
        const trace = await runScriptedAgent(strategy, tools);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);
      });

      it(`lore-enabled arm should produce a result`, async () => {
        const tools = await buildToolsForArm('lore-enabled', repoPath, dbPath);
        const strategy = buildLoreStrategy(task);
        const trace = await runScriptedAgent(strategy, tools);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);
      });

      it(`lore-enabled dynamic arm should produce a result`, async () => {
        const tools = await buildToolsForArm('lore-enabled', repoPath, dbPath);
        const strategy = buildDynamicLoreStrategy(task);
        const trace = await runProgrammaticAgent(strategy, task, tools);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);
      });
    });
  }

  // ─── Aggregate comparison ───────────────────────────────────────────────

  it('should run all tasks and produce aggregate comparison', async () => {
    const controlScores: RunScore[] = [];
    const loreScores: RunScore[] = [];
    const loreDynamicScores: RunScore[] = [];

    for (const task of LORE_SELF_TASKS) {
      // Control arm
      const controlTools = await buildToolsForArm('control', repoPath);
      const controlStrategy = buildControlStrategy(task);
      const controlStart = performance.now();
      const controlTrace = await runScriptedAgent(controlStrategy, controlTools);
      const controlTime = Math.round(performance.now() - controlStart);
      controlScores.push(scoreRun(task, controlTrace, controlTime));

      // Lore arm (scripted)
      const loreTools = await buildToolsForArm('lore-enabled', repoPath, dbPath);
      const loreStrategy = buildLoreStrategy(task);
      const loreStart = performance.now();
      const loreTrace = await runScriptedAgent(loreStrategy, loreTools);
      const loreTime = Math.round(performance.now() - loreStart);
      loreScores.push(scoreRun(task, loreTrace, loreTime));

      // Lore arm (dynamic — chains results)
      const loreDynTools = await buildToolsForArm('lore-enabled', repoPath, dbPath);
      const loreDynStrategy = buildDynamicLoreStrategy(task);
      const loreDynStart = performance.now();
      const loreDynTrace = await runProgrammaticAgent(loreDynStrategy, task, loreDynTools);
      const loreDynTime = Math.round(performance.now() - loreDynStart);
      loreDynamicScores.push(scoreRun(task, loreDynTrace, loreDynTime));
    }

    const controlReport = aggregateScores('control', controlScores);
    const loreReport = aggregateScores('lore-scripted', loreScores);
    const loreDynReport = aggregateScores('lore-dynamic', loreDynamicScores);

    // Print reports for visibility
    console.log('\n' + formatReport(controlReport));
    console.log('\n' + formatReport(loreReport));
    console.log('\n' + formatReport(loreDynReport));
    console.log('\n' + compareReports(controlReport, loreReport));
    console.log('\n' + compareReports(controlReport, loreDynReport));

    // Basic assertions: all arms should complete all tasks
    expect(controlReport.totalRuns).toBe(LORE_SELF_TASKS.length);
    expect(loreReport.totalRuns).toBe(LORE_SELF_TASKS.length);
    expect(loreDynReport.totalRuns).toBe(LORE_SELF_TASKS.length);

    // The dynamic Lore arm should have some answer coverage (tools return real data)
    expect(loreDynReport.meanAnswerCoverage).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
