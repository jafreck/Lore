/**
 * Unit tests for the benchmark strategies.
 */

import { describe, it, expect } from 'vitest';
import { buildControlStrategy, buildLoreStrategy } from '../../src/benchmark/strategies.js';
import type { BenchmarkTask } from '../../src/benchmark/types.js';

function makeTask(overrides?: Partial<BenchmarkTask>): BenchmarkTask {
  return {
    id: 'test-task',
    repoName: 'lore-self',
    family: 'localization',
    prompt: 'What functions directly call `openDb`?',
    expectedAnswer: 'openDb',
    expectedAnswerParts: ['openDb'],
    expectedFiles: ['src/indexer/db.ts'],
    expectedSymbols: ['openDb'],
    questionId: '1.1',
    ...overrides,
  };
}

describe('buildControlStrategy', () => {
  it('should produce grep-based steps for localization tasks', () => {
    const strategy = buildControlStrategy(makeTask());
    expect(strategy.steps.length).toBeGreaterThan(0);

    // Should include grep for the symbol
    const grepSteps = strategy.steps.filter((s) => s.toolName === 'grep_search');
    expect(grepSteps.length).toBeGreaterThan(0);

    // Should include directory listing
    const listSteps = strategy.steps.filter((s) => s.toolName === 'list_directory');
    expect(listSteps.length).toBeGreaterThan(0);
  });

  it('should produce directory exploration for explanation tasks', () => {
    const strategy = buildControlStrategy(
      makeTask({
        family: 'explanation',
        prompt: 'What are the high-level components?',
        questionId: '9.1',
      }),
    );

    const listSteps = strategy.steps.filter((s) => s.toolName === 'list_directory');
    expect(listSteps.length).toBeGreaterThanOrEqual(2);
  });

  it('should produce test-searching steps for testing tasks', () => {
    const strategy = buildControlStrategy(
      makeTask({
        family: 'testing',
        prompt: 'What test files cover `parser.ts`?',
        questionId: '4.1',
      }),
    );

    const grepSteps = strategy.steps.filter((s) => s.toolName === 'grep_search');
    expect(grepSteps.length).toBeGreaterThan(0);
  });

  it('should synthesize answer from results', () => {
    const strategy = buildControlStrategy(makeTask());
    const answer = strategy.synthesizeAnswer([
      {
        toolName: 'grep_search',
        args: { pattern: 'openDb' },
        result: 'src/indexer/index.ts:42:  const db = openDb(this.dbPath);',
        durationMs: 10,
        timestamp: Date.now(),
      },
    ]);
    expect(answer).toContain('openDb');
    expect(answer).toContain('grep_search');
  });

  it('should filter out error results in synthesis', () => {
    const strategy = buildControlStrategy(makeTask());
    const answer = strategy.synthesizeAnswer([
      {
        toolName: 'lore_lookup',
        args: {},
        result: 'not available in this configuration',
        durationMs: 0,
        timestamp: Date.now(),
      },
      {
        toolName: 'grep_search',
        args: { pattern: 'openDb' },
        result: 'found it',
        durationMs: 10,
        timestamp: Date.now(),
      },
    ]);
    expect(answer).not.toContain('not available');
    expect(answer).toContain('found it');
  });
});

describe('buildLoreStrategy', () => {
  it('should use lore_lookup + lore_graph for callers questions (1.1)', () => {
    const strategy = buildLoreStrategy(makeTask({ questionId: '1.1' }));
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_lookup');
    expect(toolNames).toContain('lore_graph');
  });

  it('should use lore_lookup + lore_graph for callees questions (1.2)', () => {
    const task = makeTask({
      questionId: '1.2',
      prompt: 'What does `build` call?',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_lookup');
    expect(toolNames).toContain('lore_graph');
  });

  it('should use lore_test_map for test mapping questions (4.1)', () => {
    const task = makeTask({
      questionId: '4.1',
      prompt: 'What test files should I run after modifying `src/indexer/parser.ts`?',
      family: 'testing',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_test_map');
  });

  it('should use lore_metrics for complexity questions (6.1)', () => {
    const task = makeTask({
      questionId: '6.1',
      prompt: 'What are the most complex functions?',
      family: 'coverage',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_metrics');
  });

  it('should use lore_architecture for architecture questions (9.1)', () => {
    const task = makeTask({
      questionId: '9.1',
      prompt: 'What are the high-level components?',
      family: 'explanation',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_architecture');
  });

  it('should chain multiple Lore tools for composite questions (11.1)', () => {
    const task = makeTask({
      questionId: '11.1',
      prompt: 'I need to modify `resolveSymbolEdges`. What tests, coverage, and reviewer?',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_lookup');
    expect(toolNames).toContain('lore_test_map');
    expect(toolNames).toContain('lore_coverage');
    expect(toolNames).toContain('lore_blame');
  });

  it('should use import graph for deletion questions (11.4)', () => {
    const task = makeTask({
      questionId: '11.4',
      prompt: 'What would break if I deleted `src/indexer/walker.ts`?',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_lookup');
    expect(toolNames).toContain('lore_graph');
  });
});
