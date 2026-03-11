/**
 * @module benchmark/tasks
 *
 * Benchmark task definitions mapped to the question catalog.
 *
 * Each task targets a specific repo and maps to one or more questions
 * from docs/benchmark-questions.md. Expected answer parts are grounded
 * in real code structure.
 */

import type { BenchmarkTask } from './types.js';

// ─── Task builder helper ────────────────────────────────────────────────────

let taskCounter = 0;

function task(
  partial: Omit<BenchmarkTask, 'id'> & { id?: string },
): BenchmarkTask {
  return {
    ...partial,
    id: partial.id ?? `task-${++taskCounter}`,
  };
}

// ─── Lore self-benchmark tasks ──────────────────────────────────────────────
// These tasks target the Lore codebase itself, which is always available
// locally. They exercise a representative cross-section of the question catalog.

export const LORE_SELF_TASKS: BenchmarkTask[] = [
  // ── Category 1: Call Graph ───────────────────────────────────────────────

  task({
    id: 'lore-1.1-callers-of-openDb',
    repoName: 'lore-self',
    family: 'localization',
    questionId: '1.1',
    prompt: 'What functions directly call `openDb`? List each caller with its file path.',
    expectedAnswerParts: ['indexer/index.ts', 'openDb'],
    expectedSymbols: ['openDb', 'IndexBuilder'],
    expectedFiles: ['src/indexer/index.ts', 'src/indexer/db.ts'],
  }),

  task({
    id: 'lore-1.2-callees-of-build',
    repoName: 'lore-self',
    family: 'localization',
    questionId: '1.2',
    prompt: 'What does the `build` method of IndexBuilder call? List its direct callees.',
    expectedAnswerParts: ['pipeline', 'run', 'openDb'],
    expectedSymbols: ['build', 'IndexPipeline'],
    expectedFiles: ['src/indexer/index.ts'],
  }),

  task({
    id: 'lore-1.4-blast-radius-resolveSymbolEdges',
    repoName: 'lore-self',
    family: 'localization',
    questionId: '1.4',
    prompt: 'If I change `resolveSymbolEdges`, what is the blast radius? List all transitive callers.',
    expectedAnswerParts: ['resolveSymbolEdges', 'call-graph'],
    expectedSymbols: ['resolveSymbolEdges'],
    expectedFiles: ['src/indexer/call-graph.ts'],
  }),

  // ── Category 3: Import Graph ─────────────────────────────────────────────

  task({
    id: 'lore-3.1-imports-of-server',
    repoName: 'lore-self',
    family: 'localization',
    questionId: '3.1',
    prompt: 'What files does `src/lore-server/server.ts` import? List the resolved file paths.',
    expectedAnswerParts: ['db.js', 'tool-registry', 'logger'],
    expectedFiles: ['src/lore-server/server.ts', 'src/lore-server/db.ts'],
  }),

  task({
    id: 'lore-3.2-reverse-deps-of-db',
    repoName: 'lore-self',
    family: 'localization',
    questionId: '3.2',
    prompt: 'What files import `src/lore-server/db.ts`? List all reverse dependencies.',
    expectedAnswerParts: ['server.ts', 'tools'],
    expectedFiles: ['src/lore-server/db.ts'],
  }),

  // ── Category 4: Test Mapping ─────────────────────────────────────────────

  task({
    id: 'lore-4.1-test-map-for-parser',
    repoName: 'lore-self',
    family: 'testing',
    questionId: '4.1',
    prompt: 'What test files should I run after modifying `src/indexer/parser.ts`?',
    expectedAnswerParts: ['parser.test.ts'],
    expectedFiles: ['src/indexer/parser.ts', 'tests/indexer/parser.test.ts'],
  }),

  // ── Category 6: Complexity ───────────────────────────────────────────────

  task({
    id: 'lore-6.1-most-complex',
    repoName: 'lore-self',
    family: 'coverage',
    questionId: '6.1',
    prompt: 'What are the 5 most complex functions in the Lore codebase, ranked by cyclomatic complexity?',
    expectedAnswerParts: ['cyclomatic', 'complexity'],
    expectedSymbols: [],
  }),

  // ── Category 7: History ──────────────────────────────────────────────────

  task({
    id: 'lore-7.1-domain-expert-for-parser',
    repoName: 'lore-self',
    family: 'history',
    questionId: '7.1',
    prompt: 'Who is the likely domain expert for `src/indexer/parser.ts`?',
    expectedAnswerParts: ['author', 'commit'],
    expectedFiles: ['src/indexer/parser.ts'],
  }),

  // ── Category 9: Architecture ─────────────────────────────────────────────

  task({
    id: 'lore-9.1-architecture-overview',
    repoName: 'lore-self',
    family: 'explanation',
    questionId: '9.1',
    prompt: 'What are the high-level components of this codebase and how do they relate?',
    expectedAnswerParts: ['indexer', 'lore-server', 'cli'],
    expectedFiles: [],
  }),

  task({
    id: 'lore-9.5-codebase-size',
    repoName: 'lore-self',
    family: 'explanation',
    questionId: '9.5',
    prompt: 'How large is this codebase? Provide file count, symbol count, and per-language breakdown.',
    expectedAnswerParts: ['typescript', 'files', 'symbols'],
  }),

  // ── Category 11: Composite / Multi-Hop ───────────────────────────────────

  task({
    id: 'lore-11.1-modify-workflow',
    repoName: 'lore-self',
    family: 'localization',
    questionId: '11.1',
    prompt:
      'I need to modify `resolveSymbolEdges`. What test files should I run, what is the coverage of those test paths, and who should review the change?',
    expectedAnswerParts: ['call-graph', 'test', 'coverage'],
    expectedSymbols: ['resolveSymbolEdges'],
    expectedFiles: ['src/indexer/call-graph.ts'],
  }),

  task({
    id: 'lore-11.4-deletion-impact',
    repoName: 'lore-self',
    family: 'localization',
    questionId: '11.4',
    prompt: 'What would break if I deleted `src/indexer/walker.ts`?',
    expectedAnswerParts: ['walker', 'import', 'depend'],
    expectedFiles: ['src/indexer/walker.ts'],
  }),
];

/**
 * Get all benchmark tasks for a given repo.
 */
export function getTasksForRepo(repoName: string): BenchmarkTask[] {
  switch (repoName) {
    case 'lore-self':
      return LORE_SELF_TASKS;
    default:
      return [];
  }
}

/**
 * Get all available benchmark tasks.
 */
export function getAllTasks(): BenchmarkTask[] {
  return [...LORE_SELF_TASKS];
}
