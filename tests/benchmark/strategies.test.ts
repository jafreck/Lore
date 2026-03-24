/**
 * Unit tests for the benchmark strategies.
 */

import { describe, it, expect } from 'vitest';
import { buildControlStrategy, buildLoreStrategy } from './util/strategies.js';
import type { BenchmarkTask } from './util/types.js';

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
        prompt: 'What are the top-level modules and how do they depend on each other?',
        questionId: '3.3',
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

  it('should use lore_graph for module summary questions (3.3)', () => {
    const task = makeTask({
      questionId: '3.3',
      prompt: 'What are the top-level modules and how do they depend on each other?',
      family: 'explanation',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_graph');
  });

  it('should use lore_graph inheritance for interface implementation questions (2.1)', () => {
    const task = makeTask({
      questionId: '2.1',
      prompt: 'What classes implement the interface `SymbolExtractor`?',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_lookup');
    expect(toolNames).toContain('lore_graph');
  });

  it('should use lore_cohesion for directory cohesion questions (8.1)', () => {
    const task = makeTask({
      questionId: '8.1',
      prompt: 'Rank the top-level directories by module cohesion.',
      family: 'coverage',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_cohesion');
  });

  it('should use lore_search for symbol search questions (7.2)', () => {
    const task = makeTask({
      questionId: '7.2',
      prompt: 'Find all functions and classes related to `embedding` in this codebase.',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_search');
  });

  it('should use lore_lookup for file symbol listing questions (10.2)', () => {
    const task = makeTask({
      questionId: '10.2',
      prompt: 'What functions, classes, and interfaces are defined in `src/resolution/call-graph.ts`?',
      family: 'explanation',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_lookup');
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

  it('should use lore_dependents for dead code detection questions (1.6)', () => {
    const task = makeTask({
      questionId: '1.6',
      prompt: 'Which exported functions in `src/logger.ts` are never called?',
      family: 'coverage',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_dependents');
  });

  it('should use lore_search semantic mode for clone detection questions (5.1)', () => {
    const task = makeTask({
      questionId: '5.1',
      prompt: 'What functions have similar logic to `buildControlStrategy`?',
      family: 'explanation',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_search');
  });

  it('should use lore_lookup for dependency isolation questions (3.5)', () => {
    const task = makeTask({
      questionId: '3.5',
      prompt: 'Which external packages are only imported by a single directory?',
      family: 'explanation',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_lookup');
  });

  it('should use lore_test_map with line for per-test coverage questions (4.2)', () => {
    const task = makeTask({
      questionId: '4.2',
      prompt: 'Which tests exercise line 1 of `src/parsing/parser.ts`?',
      family: 'testing',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_test_map');
  });

  it('should use lore_diff for API surface diff questions (9.1)', () => {
    const task = makeTask({
      questionId: '9.1',
      prompt: 'What exported symbols have changed between branches?',
      family: 'history',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_diff');
  });

  it('should use lore_structure for layer violation questions (12.1)', () => {
    const task = makeTask({
      questionId: '12.1',
      prompt: 'Are there any architectural layering violations in this codebase?',
      family: 'explanation',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_structure');
  });

  it('should use lore_cohesion for module cohesion questions (14.1)', () => {
    const task = makeTask({
      questionId: '14.1',
      prompt: 'Which directories have the lowest cohesion?',
      family: 'explanation',
    });
    const strategy = buildLoreStrategy(task);
    const toolNames = strategy.steps.map((s) => s.toolName);
    expect(toolNames).toContain('lore_cohesion');
  });
});
