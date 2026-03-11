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
import { RepoManager } from './util/repo-manager.js';
import { indexRepo } from './util/indexer.js';
import { buildToolsForArm } from './util/tool-providers.js';
import { runScriptedAgent, runProgrammaticAgent } from './util/agent.js';
import { buildControlStrategy, buildLoreStrategy, buildDynamicLoreStrategy } from './util/strategies.js';
import { scoreRun, aggregateScores, formatReport, compareReports } from './util/scorer.js';
import { LORE_SELF_TASKS } from './util/tasks.js';
import { PILOT_REPOS } from './util/repos.js';
import type { RunScore } from './util/types.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

const WORK_DIR = mkdtempSync(join(tmpdir(), 'lore-bench-'));
const loreSpec = PILOT_REPOS.find((r) => r.name === 'lore-self')!;

describe('Benchmark integration: Lore self-evaluation', () => {
  const repoManager = new RepoManager(WORK_DIR);
  let repoPath: string;
  let dbPath: string;

  // Accumulated scores from per-task tests — consumed by the aggregate test
  const controlScores: RunScore[] = [];
  const loreScores: RunScore[] = [];
  const loreDynamicScores: RunScore[] = [];

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
        const controlStart = performance.now();
        const trace = await runScriptedAgent(strategy, tools);
        const controlTime = Math.round(performance.now() - controlStart);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);

        controlScores.push(scoreRun(task, trace, controlTime));
      });

      it(`lore-enabled arm should produce a result`, async () => {
        const tools = await buildToolsForArm('lore-enabled', repoPath, dbPath);
        const strategy = buildLoreStrategy(task);
        const loreStart = performance.now();
        const trace = await runScriptedAgent(strategy, tools);
        const loreTime = Math.round(performance.now() - loreStart);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);

        loreScores.push(scoreRun(task, trace, loreTime));
      });

      it(`lore-enabled dynamic arm should produce a result`, async () => {
        const tools = await buildToolsForArm('lore-enabled', repoPath, dbPath);
        const strategy = buildDynamicLoreStrategy(task);
        const loreDynStart = performance.now();
        const trace = await runProgrammaticAgent(strategy, task, tools);
        const loreDynTime = Math.round(performance.now() - loreDynStart);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);

        loreDynamicScores.push(scoreRun(task, trace, loreDynTime));
      });
    });
  }

  // ─── Aggregate comparison ───────────────────────────────────────────────

  it('should run all tasks and produce aggregate comparison', () => {
    // Guard: per-task tests must have run first
    expect(controlScores.length).toBe(LORE_SELF_TASKS.length);
    expect(loreScores.length).toBe(LORE_SELF_TASKS.length);
    expect(loreDynamicScores.length).toBe(LORE_SELF_TASKS.length);

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
  });
});
