/**
 * @module benchmark/questions
 *
 * Centralized benchmark question catalog.
 *
 * This is the **single source of truth** for every benchmark question.
 * Each question is a language- and repo-agnostic template that can be
 * applied to any codebase by supplying per-repo parameters (symbol name,
 * file path, expected answer, etc.).
 *
 * ## Adding a new question
 *
 * 1. Append a `QuestionTemplate` to {@link QUESTION_CATALOG} below.
 * 2. Add per-repo answer data for the new question ID in `tasks.ts`.
 * 3. If necessary, add a Lore and control strategy in `strategies.ts`.
 *
 * ## Template placeholders
 *
 * Prompts use `{{placeholder}}` tokens that are filled in at runtime:
 *
 * | Placeholder         | Source                      | Example            |
 * |---------------------|-----------------------------|--------------------|
 * | `{{symbol}}`        | `QuestionParams.symbol`     | `openDb`           |
 * | `{{file}}`          | `QuestionParams.file`       | `src/db/schema.ts` |
 * | `{{languageLabel}}` | `RepoContext.languageLabel` | `TypeScript`       |
 * | `{{sourceRoot}}`    | `RepoContext.sourceRoot`    | `src/`             |
 *
 * Questions that don't reference a specific symbol or file simply omit
 * those placeholders (e.g. "top 5 most complex functions").
 */

import type { TaskFamily } from './types.js';

// ─── Template types ─────────────────────────────────────────────────────────

/** A single benchmark question template. */
export interface QuestionTemplate {
  /** Unique identifier matching the benchmark-questions catalog (e.g. '1.1'). */
  questionId: string;

  /** Human-readable category name. */
  category: string;

  /** Task family used for scoring and strategy selection. */
  family: TaskFamily;

  /** One-line description of what this question tests. */
  description: string;

  /**
   * Prompt template with `{{placeholder}}` tokens.
   *
   * Placeholders are replaced at runtime by {@link renderPrompt}:
   * - `{{symbol}}` — target symbol/function name
   * - `{{file}}`   — target file path
   * - `{{languageLabel}}` — primary language (e.g. "TypeScript")
   * - `{{sourceRoot}}`   — source root directory (e.g. "src/")
   */
  promptTemplate: string;

  /** Which Lore MCP tools answer this question. */
  loreTools: string[];

  /** Brief note on why Lore has an advantage over grep/semantic search. */
  loreAdvantage: string;
}

/** Parameters that specialize a question for one repo. */
export interface QuestionParams {
  /** The symbol / function name referenced in the prompt. */
  symbol: string;
  /** The file path referenced in the prompt. */
  file: string;
  /** Canonical expected answer (newline-separated lines). */
  expectedAnswer: string;
  /** Key fragments that MUST appear in a correct response. */
  expectedAnswerParts: string[];
  /** Files a correct response should reference (optional). */
  expectedFiles?: string[];
  /** Symbols a correct response should reference (optional). */
  expectedSymbols?: string[];
}

/** Per-repo metadata used when rendering prompt templates. */
export interface RepoContext {
  /** Primary source language extension used for prompts. */
  languageLabel: string;
  /** Source root directory used for prompts. */
  sourceRoot: string;
}

// ─── Question catalog ───────────────────────────────────────────────────────

/**
 * The complete catalog of benchmark questions.
 *
 * Organized by category so they're easy to scan. Each entry is repo- and
 * language-agnostic — only the `promptTemplate` placeholders tie a question
 * to a specific codebase at runtime.
 */
export const QUESTION_CATALOG: QuestionTemplate[] = [
  // ── Category 1: Call Graph & Impact Analysis ────────────────────────────
  {
    questionId: '1.1',
    category: 'Call Graph',
    family: 'localization',
    description: 'Direct callers of a function',
    loreTools: ['lore_lookup', 'lore_graph(kind=call, direction=incoming)'],
    loreAdvantage: 'Resolved symbol_refs distinguish real call sites from comments/strings/imports.',
    promptTemplate:
      'What functions or methods directly call `{{symbol}}`? ' +
      'Answer with ONLY a newline-separated list of function/method names, nothing else. ' +
      'Example format:\nfoo\nbar\nbaz',
  },
  {
    questionId: '1.2',
    category: 'Call Graph',
    family: 'localization',
    description: 'Direct callees of a function',
    loreTools: ['lore_lookup', 'lore_graph(kind=call, direction=outgoing)'],
    loreAdvantage: 'Nested calls inside closures are invisible to text search.',
    promptTemplate:
      'What does the function/method `{{symbol}}` call? ' +
      'Answer with ONLY a newline-separated list of the direct callee function/method names, nothing else.',
  },
  {
    questionId: '1.4',
    category: 'Call Graph',
    family: 'modification',
    description: 'Blast radius of a change (transitive callers)',
    loreTools: ['lore_lookup', 'lore_graph(kind=call, depth=3)'],
    loreAdvantage: 'Transitive closure in 1 call; grep only finds direct mentions.',
    promptTemplate:
      'If I change the function `{{symbol}}` in `{{file}}`, what is the blast radius? ' +
      'Use transitive dependency analysis if available (follow callers of callers, up to 3 hops). ' +
      'Answer with ONLY a newline-separated list of files and functions that transitively depend on it, nothing else.',
  },
  {
    questionId: '1.6',
    category: 'Call Graph',
    family: 'coverage',
    description: 'Functions that are never called (dead code)',
    loreTools: ['lore_lookup', 'lore_graph(kind=call, direction=incoming)'],
    loreAdvantage: 'LEFT JOIN on resolved symbol_refs finds zero-inbound symbols; grep cannot prove absence of calls.',
    promptTemplate:
      'Which exported functions in `{{file}}` are never called from anywhere else in the codebase? ' +
      'Answer with ONLY a newline-separated list of function names, nothing else. ' +
      'If all exported functions are called somewhere, answer "None".',
  },

  // ── Category 2: Type Hierarchy & Inheritance ────────────────────────────
  {
    questionId: '2.1',
    category: 'Type Hierarchy',
    family: 'localization',
    description: 'Implementations of an interface',
    loreTools: ['lore_lookup', 'lore_graph(kind=inheritance)'],
    loreAdvantage: 'Grep finds "implements X" textually but misses transitive/re-exported implementations.',
    promptTemplate:
      'What classes or types implement the interface `{{symbol}}`? ' +
      'Answer with ONLY a newline-separated list of class/type names, nothing else.',
  },

  // ── Category 3: Module Dependencies ─────────────────────────────────────
  {
    questionId: '3.3',
    category: 'Module Dependencies',
    family: 'explanation',
    description: 'Top-level module dependency map',
    loreTools: ['lore_graph(kind=import)'],
    loreAdvantage: 'Resolved import graph with path resolution; grep cannot resolve aliases or barrel files.',
    promptTemplate:
      'What are the top-level modules/packages in this codebase and how do they depend on each other? ' +
      'Answer with ONLY a newline-separated list, one module per line, in the exact format below. ' +
      'Use module paths relative to the repo root (e.g. src/indexer, lib/router, pkg/api). ' +
      'List dependencies as comma-separated paths, or (none) if there are no internal dependencies. ' +
      'Include every module, even those with no dependencies. Nothing else in the answer.\n' +
      'Example format:\nsrc/module_a → src/module_b, src/module_c\nsrc/module_b → (none)',
  },
  {
    questionId: '3.5',
    category: 'Module Dependencies',
    family: 'explanation',
    description: 'External packages used by only a single module',
    loreTools: ['lore_lookup'],
    loreAdvantage: 'Aggregation over external_deps table gives per-package file counts; grep finds import statements but cannot aggregate.',
    promptTemplate:
      'Which external (third-party) packages in this codebase are only imported by files in a single directory? ' +
      'Answer with ONLY a newline-separated list in the format "package → directory", nothing else. ' +
      'Example format:\nlodash → src/utils\naxios → src/api',
  },

  // ── Category 4: Test Mapping & Coverage ─────────────────────────────────
  {
    questionId: '4.1',
    category: 'Test Mapping',
    family: 'testing',
    description: 'Test files to run after modifying a source file',
    loreTools: ['lore_test_map'],
    loreAdvantage: 'Structural test mapping with confidence scores; grep relies on fragile name heuristics.',
    promptTemplate:
      'What test files should I run after modifying `{{file}}`? ' +
      'Answer with ONLY a newline-separated list of test file paths relative to the repo root, nothing else.',
  },
  // DISABLED: requires per-test coverage data (test_coverage_lines) which is not
  // populated during standard benchmark indexing.  Re-enable once coverage
  // ingestion is wired into the benchmark preparation pipeline.
  // {
  //   questionId: '4.2',
  //   category: 'Test Mapping',
  //   family: 'coverage',
  //   description: 'Which tests exercise a specific line of code',
  //   loreTools: ['lore_test_map(source_path, line)'],
  //   loreAdvantage: 'Per-test line coverage attribution from test_coverage_lines; no grep or manual tracing possible.',
  //   promptTemplate:
  //     'Which individual tests exercise line 1 of `{{file}}`? ' +
  //     'Use per-test coverage data if available. ' +
  //     'Answer with ONLY a newline-separated list of test names, nothing else.',
  // },

  // ── Category 5: Semantic Similarity ─────────────────────────────────────
  {
    questionId: '5.1',
    category: 'Semantic Similarity',
    family: 'localization',
    description: 'Functions with similar logic (clone detection candidates)',
    loreTools: ['lore_search(mode=semantic)'],
    loreAdvantage: 'Embedding cosine similarity finds structurally similar code regardless of naming; grep matches text only.',
    promptTemplate:
      'What functions in this codebase have very similar logic to `{{symbol}}`? ' +
      'Use embedding similarity search if available rather than text matching. ' +
      'Answer with ONLY a newline-separated list of function names, nothing else. ' +
      'Exclude the target function itself.',
  },

  // ── Category 6: Complexity & Code Health ────────────────────────────────
  {
    questionId: '6.1',
    category: 'Complexity',
    family: 'coverage',
    description: 'Top 5 most complex functions by cyclomatic complexity',
    loreTools: ['lore_metrics(mode=complexity, limit=5)'],
    loreAdvantage: 'Pre-indexed cyclomatic complexity; no source scanning needed.',
    promptTemplate:
      'What are the 5 most complex functions in this codebase, ranked by cyclomatic complexity? ' +
      'Use pre-indexed complexity metrics if available rather than scanning source files. ' +
      'Answer with ONLY a numbered list of function names, one per line, in descending order. ' +
      'Example format:\n1. foo\n2. bar\n3. baz\n4. qux\n5. quux',
  },

  // ── Category 7: Cross-file Consumer Trace ──────────────────────────────
  {
    questionId: '7.2',
    category: 'Cross-file Consumers',
    family: 'localization',
    description: 'Functions in other files that reference a type/interface',
    loreTools: ['lore_lookup', 'lore_graph(kind=call)'],
    loreAdvantage: '2–3 calls to enumerate cross-file consumers; control must grep imports then trace type usage.',
    promptTemplate:
      'What functions across the codebase directly consume or reference the type/interface `{{symbol}}` defined in `{{file}}`? ' +
      'List only functions in OTHER files (not the file where it is defined). ' +
      'Answer with ONLY a newline-separated list in the format "function → file", nothing else. ' +
      'Example format:\nfoo → src/bar.ts\nbaz → src/qux.ts',
  },

  // ── Category 8: Graph Analysis ──────────────────────────────────────────
  {
    questionId: '8.1',
    category: 'Graph Analysis',
    family: 'explanation',
    description: 'Circular dependency detection',
    loreTools: ['lore_graph(kind=import)'],
    loreAdvantage: 'Tarjan SCC on import graph; no text operation can detect cycles.',
    promptTemplate:
      'Are there any circular dependencies (import cycles) between source files in this codebase? ' +
      'Answer with ONLY a list of the cycle(s), each on its own line showing the file loop ' +
      '(e.g. "a.ts → b.ts → a.ts"), or "None" if the codebase is acyclic.',
  },

  // ── Category 9: API Surface ─────────────────────────────────────────────
  {
    questionId: '9.1',
    category: 'API Surface',
    family: 'history',
    description: 'Public API surface changes between branches',
    loreTools: ['lore_diff(old_branch, new_branch)'],
    loreAdvantage: 'Compares exported symbols between indexed branches; grep cannot diff symbol visibility across branches.',
    promptTemplate:
      'What exported symbols have been added, removed, or changed between the oldest indexed branch and the current branch? ' +
      'Answer with ONLY three sections: "Added:", "Removed:", "Changed:", each followed by a newline-separated list of symbol names. ' +
      'If a section is empty, write "None".',
  },

  // ── Category 10: Cross-module Fan-in ────────────────────────────────────
  {
    questionId: '10.2',
    category: 'Cross-module Fan-in',
    family: 'explanation',
    description: 'Functions in a file ranked by number of distinct calling files',
    loreTools: ['lore_lookup', 'lore_graph(kind=call)'],
    loreAdvantage: '3–5 calls to aggregate callers by file; control must parse exports + grep each across codebase.',
    promptTemplate:
      'Which functions in `{{file}}` are called from the most distinct source files? ' +
      'Rank the top 3 by number of unique calling files (exclude test files). ' +
      'Answer with ONLY a numbered list in the format "name — N files: file1, file2, ...", nothing else. ' +
      'Example format:\n1. foo — 4 files: src/a.ts, src/b.ts, src/c.ts, src/d.ts\n' +
      '2. bar — 3 files: src/a.ts, src/e.ts, src/f.ts\n' +
      '3. baz — 2 files: src/a.ts, src/g.ts',
  },

  // ── Category 11: Composite / Multi-Hop ──────────────────────────────────
  // DISABLED: the prompt asks for coverage percentage which requires ingested
  // coverage data not available during standard benchmark indexing.  Re-enable
  // once coverage ingestion is wired into the benchmark preparation pipeline.
  // {
  //   questionId: '11.1',
  //   category: 'Composite',
  //   family: 'modification',
  //   description: 'Modify a symbol: find tests, coverage, and reviewer',
  //   loreTools: ['lore_lookup', 'lore_test_map', 'lore_blame'],
  //   loreAdvantage: 'Chains test mapping + blame in 2 calls vs. manual multi-step process.',
  //   promptTemplate:
  //     'I need to modify `{{symbol}}` in `{{file}}`. ' +
  //     'What test files should I run, what is the coverage of those test paths, and who should review the change? ' +
  //     'Answer with ONLY three lines:\n1. Test files (comma-separated paths)\n2. Coverage percentage\n3. Reviewer name',
  // },
  {
    questionId: '11.4',
    category: 'Composite',
    family: 'modification',
    description: 'Deletion impact: exported symbols and their consumers',
    loreTools: ['lore_lookup', 'lore_graph(kind=call)'],
    loreAdvantage: '2–4 calls to find all exports + their consumers; control needs read + parse + grep per export.',
    promptTemplate:
      'If I deleted `{{file}}`, what exported symbols from that file are used elsewhere in the codebase, ' +
      'and which source files (not test files) use each one? ' +
      'Answer with ONLY a newline-separated list in the exact format below, nothing else. ' +
      'Use file paths relative to the repo root. ' +
      'Only include symbols that are actually imported or referenced by other source files.\n' +
      'Example format:\nMyFunction → path/to/consumer1.ts, path/to/consumer2.ts\nMyType → path/to/consumer3.ts',
  },

  // ── Category 12: Architecture ───────────────────────────────────────────
  {
    questionId: '12.1',
    category: 'Architecture',
    family: 'explanation',
    description: 'Architectural layer violations (back-edges in import DAG)',
    loreTools: ['lore_structure(analysis=layers)'],
    loreAdvantage: "Kahn's topological sort on directory-level import DAG flags back-edges; no text search can infer layers.",
    promptTemplate:
      'Are there any architectural layering violations in this codebase — directories that import from directories ' +
      'that should be in a higher layer? Use topological analysis of the import graph if available. ' +
      'Answer with ONLY a newline-separated list of violations in the format "from_dir → to_dir", ' +
      'or "None" if no violations are detected.',
  },

  // ── Category 14: Module Cohesion ────────────────────────────────────────
  {
    questionId: '14.1',
    category: 'Architecture',
    family: 'explanation',
    description: 'Module cohesion ranking (worst-bounded first)',
    loreTools: ['lore_cohesion(depth=2)'],
    loreAdvantage: 'Computes internal/external edge ratio per directory from resolved symbol_refs; no text search can measure coupling.',
    promptTemplate:
      'Which directories in this codebase have the lowest cohesion ' +
      '(highest ratio of external coupling to internal coupling)? ' +
      'Use pre-indexed module cohesion metrics if available. ' +
      'Answer with ONLY a numbered list of the 3 least cohesive directories, ' +
      'each with their cohesion score. Example format:\n' +
      '1. src/server — cohesion: 0.32\n2. src/utils — cohesion: 0.45\n3. src/api — cohesion: 0.51',
  },
];

// ─── Lookup helpers ─────────────────────────────────────────────────────────

const CATALOG_MAP = new Map(QUESTION_CATALOG.map((q) => [q.questionId, q]));

/** Look up a question template by ID. */
export function getQuestion(questionId: string): QuestionTemplate | undefined {
  return CATALOG_MAP.get(questionId);
}

/** Get all question IDs in catalog order. */
export function getQuestionIds(): string[] {
  return QUESTION_CATALOG.map((q) => q.questionId);
}

/** Get all unique category names in catalog order. */
export function getCategories(): string[] {
  const seen = new Set<string>();
  return QUESTION_CATALOG.filter((q) => {
    if (seen.has(q.category)) return false;
    seen.add(q.category);
    return true;
  }).map((q) => q.category);
}

// ─── Prompt rendering ───────────────────────────────────────────────────────

/**
 * Render a question's prompt template into a concrete prompt string.
 *
 * Replaces `{{symbol}}`, `{{file}}`, `{{languageLabel}}`, and
 * `{{sourceRoot}}` with the supplied values. Unmatched placeholders
 * are left as-is (which is fine for questions that don't use them).
 */
export function renderPrompt(
  template: QuestionTemplate,
  params: QuestionParams,
  repo: RepoContext,
): string {
  return template.promptTemplate
    .replace(/\{\{symbol\}\}/g, params.symbol)
    .replace(/\{\{file\}\}/g, params.file)
    .replace(/\{\{languageLabel\}\}/g, repo.languageLabel)
    .replace(/\{\{sourceRoot\}\}/g, repo.sourceRoot);
}
