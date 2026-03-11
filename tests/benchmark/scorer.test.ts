/**
 * Unit tests for the benchmark scorer.
 */

import { describe, it, expect } from 'vitest';
import {
  scoreRun,
  aggregateScores,
  formatReport,
  compareReports,
} from '../../src/benchmark/scorer.js';
import type { BenchmarkTask, AgentTrace, RunScore } from '../../src/benchmark/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<BenchmarkTask>): BenchmarkTask {
  return {
    id: 'test-task-1',
    repoName: 'test-repo',
    family: 'localization',
    prompt: 'Find the function that handles user login.',
    expectedAnswer: 'handleLogin\nauth.ts',
    expectedAnswerParts: ['handleLogin', 'auth.ts'],
    expectedFiles: ['src/auth.ts'],
    expectedSymbols: ['handleLogin'],
    ...overrides,
  };
}

function makeTrace(overrides?: Partial<AgentTrace>): AgentTrace {
  return {
    toolCalls: [],
    filesRead: [],
    finalAnswer: '',
    totalTokensEstimate: 0,
    ...overrides,
  };
}

// ─── scoreRun ─────────────────────────────────────────────────────────────────

describe('scoreRun', () => {
  it('should score a perfect answer as success', () => {
    const task = makeTask();
    const trace = makeTrace({
      finalAnswer: 'The handleLogin function is in src/auth.ts on line 42.',
      filesRead: ['src/auth.ts'],
      toolCalls: [
        {
          toolName: 'read_file',
          args: { path: 'src/auth.ts' },
          result: 'function handleLogin() { ... }',
          durationMs: 10,
          timestamp: Date.now(),
        },
      ],
    });

    const score = scoreRun(task, trace, 1000);
    expect(score.taskSuccess).toBe(1);
    expect(score.correctness).toBe(1);
    expect(score.answerCoverage).toBe(1);
    expect(score.fileCoverage).toBe(1);
    expect(score.symbolCoverage).toBe(1);
    expect(score.firstPassAccurate).toBe(true);
    expect(score.toolCallCount).toBe(1);
    expect(score.wallTimeMs).toBe(1000);
  });

  it('should score a partial answer as 0.5', () => {
    const task = makeTask();
    const trace = makeTrace({
      finalAnswer: 'The handleLogin function appears to be in the auth module.',
      filesRead: ['src/utils.ts'], // Wrong file
    });

    const score = scoreRun(task, trace, 2000);
    // "handleLogin" matched but "auth.ts" didn't match exactly in answer
    expect(score.taskSuccess).toBe(0.5);
    expect(score.answerCoverage).toBe(0.5); // Only handleLogin matched
  });

  it('should score a completely wrong answer as 0', () => {
    const task = makeTask();
    const trace = makeTrace({
      finalAnswer: 'I could not find any relevant information.',
    });

    const score = scoreRun(task, trace, 3000);
    expect(score.taskSuccess).toBe(0);
    expect(score.answerCoverage).toBe(0);
  });

  it('should compute correctness from expectedAnswer', () => {
    const task = makeTask({ expectedAnswer: 'handleLogin' });
    const trace = makeTrace({
      finalAnswer: 'The answer is handleLogin in auth.ts.',
    });

    const score = scoreRun(task, trace, 100);
    expect(score.correctness).toBe(1);
  });

  it('should score correctness as 0 when no expected parts match', () => {
    const task = makeTask({ expectedAnswer: 'handleLogin\nauth.ts' });
    const trace = makeTrace({
      finalAnswer: 'I have no idea what the answer is.',
    });

    const score = scoreRun(task, trace, 100);
    expect(score.correctness).toBe(0);
  });

  it('should score partial correctness', () => {
    const task = makeTask({ expectedAnswer: 'handleLogin\nauth.ts' });
    const trace = makeTrace({
      finalAnswer: 'The function is handleLogin.',
    });

    const score = scoreRun(task, trace, 100);
    expect(score.correctness).toBe(0.5);
  });

  it('should handle tasks with no expected files or symbols', () => {
    const task = makeTask({
      expectedFiles: undefined,
      expectedSymbols: undefined,
    });
    const trace = makeTrace({
      finalAnswer: 'The handleLogin function is in auth.ts.',
    });

    const score = scoreRun(task, trace, 500);
    // With no file/symbol expectations, those coverages default to 1
    expect(score.fileCoverage).toBe(1);
    expect(score.symbolCoverage).toBe(1);
  });

  it('should count unique files read', () => {
    const trace = makeTrace({
      finalAnswer: 'result',
      filesRead: ['a.ts', 'b.ts', 'a.ts', 'c.ts'],
    });

    const score = scoreRun(makeTask({ expectedAnswerParts: [] }), trace, 100);
    expect(score.uniqueFilesRead).toBe(3);
  });

  it('should detect first-pass accuracy from file reads', () => {
    const task = makeTask({ expectedFiles: ['src/auth.ts'] });
    const trace = makeTrace({
      finalAnswer: 'found it',
      toolCalls: [
        {
          toolName: 'read_file',
          args: { path: 'src/auth.ts' },
          result: 'content',
          durationMs: 5,
          timestamp: Date.now(),
        },
      ],
    });

    const score = scoreRun(task, trace, 100);
    expect(score.firstPassAccurate).toBe(true);
  });

  it('should detect first-pass inaccuracy', () => {
    const task = makeTask({ expectedFiles: ['src/auth.ts'] });
    const trace = makeTrace({
      finalAnswer: 'found it in auth.ts',
      toolCalls: [
        {
          toolName: 'read_file',
          args: { path: 'src/utils.ts' }, // Wrong first file
          result: 'content',
          durationMs: 5,
          timestamp: Date.now(),
        },
      ],
    });

    const score = scoreRun(task, trace, 100);
    expect(score.firstPassAccurate).toBe(false);
  });
});

// ─── aggregateScores ──────────────────────────────────────────────────────────

describe('aggregateScores', () => {
  it('should aggregate empty scores', () => {
    const report = aggregateScores('control', []);
    expect(report.totalRuns).toBe(0);
    expect(report.successRate).toBe(0);
  });

  it('should correctly compute rates from mixed scores', () => {
    const scores: RunScore[] = [
      {
        taskSuccess: 1,
        correctness: 1,
        firstPassAccurate: true,
        toolCallCount: 3,
        uniqueFilesRead: 2,
        wallTimeMs: 1000,
        tokensUsed: 500,
        answerCoverage: 1,
        fileCoverage: 1,
        symbolCoverage: 1,
        loreToolCallCount: 0,
        loreToolsUsed: [],
      },
      {
        taskSuccess: 0.5,
        correctness: 0.5,
        firstPassAccurate: false,
        toolCallCount: 5,
        uniqueFilesRead: 4,
        wallTimeMs: 2000,
        tokensUsed: 800,
        answerCoverage: 0.5,
        fileCoverage: 0.5,
        symbolCoverage: 0.5,
        loreToolCallCount: 0,
        loreToolsUsed: [],
      },
      {
        taskSuccess: 0,
        correctness: 0,
        firstPassAccurate: false,
        toolCallCount: 10,
        uniqueFilesRead: 8,
        wallTimeMs: 5000,
        tokensUsed: 2000,
        answerCoverage: 0,
        fileCoverage: 0,
        symbolCoverage: 0,
        loreToolCallCount: 0,
        loreToolsUsed: [],
      },
    ];

    const report = aggregateScores('lore-enabled', scores);
    expect(report.totalRuns).toBe(3);
    expect(report.successRate).toBeCloseTo(1 / 3);
    expect(report.partialRate).toBeCloseTo(1 / 3);
    expect(report.failRate).toBeCloseTo(1 / 3);
    expect(report.firstPassAccuracyRate).toBeCloseTo(1 / 3);
    expect(report.meanToolCalls).toBe(6);
    expect(report.meanWallTimeMs).toBeCloseTo(2666.67, 0);
  });
});

// ─── formatReport ─────────────────────────────────────────────────────────────

describe('formatReport', () => {
  it('should produce readable output', () => {
    const report = aggregateScores('control', [
      {
        taskSuccess: 1,
        correctness: 1,
        firstPassAccurate: true,
        toolCallCount: 3,
        uniqueFilesRead: 2,
        wallTimeMs: 1000,
        tokensUsed: 500,
        answerCoverage: 1,
        fileCoverage: 1,
        symbolCoverage: 1,
        loreToolCallCount: 0,
        loreToolsUsed: [],
      },
    ]);

    const output = formatReport(report);
    expect(output).toContain('Arm: control');
    expect(output).toContain('Success: 100.0%');
    expect(output).toContain('Correctness: 100.0%');
    expect(output).toContain('Runs: 1');
  });
});

// ─── compareReports ───────────────────────────────────────────────────────────

describe('compareReports', () => {
  it('should compare two reports', () => {
    const baseline = aggregateScores('control', [
      {
        taskSuccess: 0,
        correctness: 0,
        firstPassAccurate: false,
        toolCallCount: 10,
        uniqueFilesRead: 8,
        wallTimeMs: 5000,
        tokensUsed: 2000,
        answerCoverage: 0.2,
        fileCoverage: 0,
        symbolCoverage: 0,
        loreToolCallCount: 0,
        loreToolsUsed: [],
      },
    ]);

    const treatment = aggregateScores('lore-enabled', [
      {
        taskSuccess: 1,
        correctness: 1,
        firstPassAccurate: true,
        toolCallCount: 3,
        uniqueFilesRead: 2,
        wallTimeMs: 1000,
        tokensUsed: 500,
        answerCoverage: 1,
        fileCoverage: 1,
        symbolCoverage: 1,
        loreToolCallCount: 2,
        loreToolsUsed: ['lore_lookup', 'lore_graph'],
      },
    ]);

    const output = compareReports(baseline, treatment);
    expect(output).toContain('lore-enabled vs control');
    expect(output).toContain('Success rate:');
  });
});
