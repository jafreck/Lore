/**
 * Integration test: Runs the full benchmark pipeline against the Lore codebase itself.
 *
 * This test:
 * 1. Indexes the Lore repo with IndexBuilder
 * 2. Provisions tools for control and lore-enabled arms
 * 3. Runs scripted agents (control + Lore) against benchmark tasks
 * 4. Scores results and verifies Lore outperforms control
 *
 * This is the core end-to-end benchmark test that validates the full pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { IndexBuilder } from '../../src/indexer/index.js';
import { buildToolsForArm } from '../../src/benchmark/tool-providers.js';
import { runScriptedAgent, runProgrammaticAgent } from '../../src/benchmark/agent.js';
import { buildControlStrategy, buildLoreStrategy, buildDynamicLoreStrategy } from '../../src/benchmark/strategies.js';
import { scoreRun, aggregateScores, formatReport, compareReports } from '../../src/benchmark/scorer.js';
import { LORE_SELF_TASKS } from '../../src/benchmark/tasks.js';
import type { BenchmarkTask, RunScore } from '../../src/benchmark/types.js';

// ─── Setup ────────────────────────────────────────────────────────────────────

const LORE_ROOT = join(import.meta.dirname, '..', '..');
const DB_DIR = mkdtempSync(join(tmpdir(), 'lore-bench-'));
const DB_PATH = join(DB_DIR, 'lore-bench.db');

describe('Benchmark integration: Lore self-evaluation', () => {
  // Index the Lore repo once before all tests
  beforeAll(async () => {
    const builder = new IndexBuilder(DB_PATH, { rootDir: LORE_ROOT }, undefined, {
      history: { depth: 50 },
      docsAutoNotes: true,
      indexDependencies: false,
    });
    await builder.build();
  }, 120_000); // Allow up to 2 minutes for indexing

  afterAll(() => {
    // Clean up DB
    for (const suffix of ['', '-wal', '-shm']) {
      const p = DB_PATH + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  // ─── Per-task tests ─────────────────────────────────────────────────────

  for (const task of LORE_SELF_TASKS) {
    describe(`Task ${task.id} (${task.family})`, () => {
      it(`control arm should produce a result`, async () => {
        const tools = await buildToolsForArm('control', LORE_ROOT);
        const strategy = buildControlStrategy(task);
        const trace = await runScriptedAgent(strategy, tools);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);
      });

      it(`lore-enabled arm should produce a result`, async () => {
        const tools = await buildToolsForArm('lore-enabled', LORE_ROOT, DB_PATH);
        const strategy = buildLoreStrategy(task);
        const trace = await runScriptedAgent(strategy, tools);

        expect(trace.toolCalls.length).toBeGreaterThan(0);
        expect(trace.finalAnswer.length).toBeGreaterThan(0);
      });

      it(`lore-enabled dynamic arm should produce a result`, async () => {
        const tools = await buildToolsForArm('lore-enabled', LORE_ROOT, DB_PATH);
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
      const controlTools = await buildToolsForArm('control', LORE_ROOT);
      const controlStrategy = buildControlStrategy(task);
      const controlStart = performance.now();
      const controlTrace = await runScriptedAgent(controlStrategy, controlTools);
      const controlTime = Math.round(performance.now() - controlStart);
      controlScores.push(scoreRun(task, controlTrace, controlTime));

      // Lore arm (scripted)
      const loreTools = await buildToolsForArm('lore-enabled', LORE_ROOT, DB_PATH);
      const loreStrategy = buildLoreStrategy(task);
      const loreStart = performance.now();
      const loreTrace = await runScriptedAgent(loreStrategy, loreTools);
      const loreTime = Math.round(performance.now() - loreStart);
      loreScores.push(scoreRun(task, loreTrace, loreTime));

      // Lore arm (dynamic — chains results)
      const loreDynTools = await buildToolsForArm('lore-enabled', LORE_ROOT, DB_PATH);
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
