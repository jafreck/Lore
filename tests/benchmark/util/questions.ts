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
  /** Optional second symbol for questions referencing two symbols (e.g. Q1.5). */
  symbol2?: string;
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
  // ── Call Graph: Pure graph traversal ────────────────────────────────────

  {
    questionId: '1.1',
    category: 'Call Graph',
    family: 'localization',
    description: 'Direct callers of a function',
    loreTools: ['lore_dependents'],
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
    loreTools: ['lore_graph(kind=call)'],
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
    loreTools: ['lore_dependents(depth=3)'],
    loreAdvantage: 'Transitive closure in 1 call; grep only finds direct mentions.',
    promptTemplate:
      'If I change the function `{{symbol}}` in `{{file}}`, what is the blast radius? ' +
      'Use transitive dependency analysis if available (follow callers of callers, up to 3 hops). ' +
      'Answer with ONLY a newline-separated list of files and functions that transitively depend on it, nothing else.',
  },

  // ── Call Graph + Snippet: graph for navigation, snippet for understanding

  {
    questionId: '1.3',
    category: 'Call Graph',
    family: 'explanation',
    description: 'Callee parameter flow — what arguments are passed to each callee',
    loreTools: ['lore_graph(kind=call)', 'lore_snippet'],
    loreAdvantage: 'Graph identifies callees; snippet shows the actual call expressions and argument passing — impossible from graph alone.',
    promptTemplate:
      'What arguments does `{{symbol}}` pass to each of its direct callees? ' +
      'For each callee, show the callee name and the argument expressions passed to it. ' +
      'Answer with ONLY a newline-separated list in the format "callee(arg1, arg2, ...)", nothing else. ' +
      'Example format:\nfoo(config, options)\nbar(result.data)\nbaz()',
  },
  {
    questionId: '1.5',
    category: 'Call Graph',
    family: 'localization',
    description: 'Shared callers — functions that call both symbol and symbol2',
    loreTools: ['lore_dependents', 'lore_snippet'],
    loreAdvantage: 'Graph gives caller-set intersection in 2 calls; control must grep twice and cross-reference manually.',
    promptTemplate:
      'What functions call BOTH `{{symbol}}` and `{{symbol2}}`? ' +
      'For each shared caller, briefly describe what it does with the results of both calls. ' +
      'Answer with ONLY a newline-separated list in the format "caller — description", nothing else. ' +
      'Example format:\nmain — calls foo() to get config, then bar(config) to apply it',
  },
  {
    questionId: '1.7',
    category: 'Call Graph',
    family: 'explanation',
    description: 'Call chain trace — find the path between two specific functions',
    loreTools: ['lore_graph(kind=call, depth=5)', 'lore_snippet'],
    loreAdvantage: 'Graph gives transitive call chain between two known endpoints; snippet retrieves each function body to summarize behavior.',
    promptTemplate:
      'Trace the call chain from `{{symbol}}` to `{{symbol2}}`. ' +
      'Show every intermediate function on the path. ' +
      'For each function in the chain, show its name and a one-line summary of what it does. ' +
      'Answer with ONLY a numbered chain, one function per line, nothing else. ' +
      'Example format:\n1. foo — orchestrates the build pipeline\n2. bar — opens the database connection\n3. baz — runs SQL migrations',
  },
  {
    questionId: '1.8',
    category: 'Call Graph',
    family: 'modification',
    description: 'Error propagation — which callers handle vs propagate errors',
    loreTools: ['lore_dependents', 'lore_snippet'],
    loreAdvantage: 'Graph gives callers; snippet reveals error-handling patterns at each call site.',
    promptTemplate:
      'If `{{symbol}}` throws an error or returns an error value, which of its direct callers handle the error ' +
      '(try/catch, error check, etc.) and which propagate it to their own callers? ' +
      'Answer with ONLY two sections: "Handle:" and "Propagate:", each followed by a newline-separated list of caller names. ' +
      'If a section is empty, write "None".\n' +
      'Example format:\nHandle:\nfoo\nbar\nPropagate:\nbaz\nqux',
  },

  // ── Cross-file consumers + snippet context ─────────────────────────────

  {
    questionId: '7.2',
    category: 'Cross-file Consumers',
    family: 'localization',
    description: 'Cross-file callers with calling context',
    loreTools: ['lore_dependents', 'lore_snippet'],
    loreAdvantage: 'Graph identifies callers across files; snippet shows calling context — control must grep + read each file.',
    promptTemplate:
      'What functions in OTHER files call `{{symbol}}` defined in `{{file}}`? ' +
      'For each caller, show the function name, the file it lives in, and what it does with the return value. ' +
      'Answer with ONLY a newline-separated list in the format "function → file — description", nothing else. ' +
      'Example format:\nbuildIndex → src/indexer.ts — stores the result in a local variable and passes it to pipeline.run()',
  },
  {
    questionId: '7.3',
    category: 'Cross-file Consumers',
    family: 'localization',
    description: 'Interface dispatch — concrete implementations called through an abstraction',
    loreTools: ['lore_graph(kind=call)', 'lore_graph(kind=inheritance)', 'lore_snippet'],
    loreAdvantage: 'Call graph + type hierarchy finds dispatched implementations; snippet shows each concrete body.',
    promptTemplate:
      'What concrete functions or methods get called when `{{symbol}}` is invoked? ' +
      'If it is an interface/abstract method, list the concrete implementations. ' +
      'If it is a wrapper/dispatch function, list what it delegates to. ' +
      'For each, show the function name and file. ' +
      'Answer with ONLY a newline-separated list in the format "function → file", nothing else.',
  },

  // ── Fan-in analysis + snippet ──────────────────────────────────────────

  {
    questionId: '10.1',
    category: 'Cross-module Fan-in',
    family: 'explanation',
    description: 'Fan-in count — how many distinct files call a specific function',
    loreTools: ['lore_dependents', 'lore_snippet'],
    loreAdvantage: 'One lore_dependents call gives the complete caller list with file info; control must grep the entire codebase.',
    promptTemplate:
      'How many distinct source files (not test files) call `{{symbol}}` defined in `{{file}}`? ' +
      'List every calling function and its file. ' +
      'Answer with ONLY a count on the first line, then a newline-separated list of "function → file" entries, nothing else. ' +
      'Example format:\n3\nfoo → src/a.ts\nbar → src/b.ts\nbaz → src/c.ts',
  },
  {
    questionId: '10.3',
    category: 'Cross-module Fan-in',
    family: 'explanation',
    description: 'Call-site pattern diff — how different callers invoke the same function',
    loreTools: ['lore_dependents', 'lore_snippet'],
    loreAdvantage: 'Graph gives callers; snippet reveals divergent calling patterns across files.',
    promptTemplate:
      'How do the different callers of `{{symbol}}` invoke it? Group the callers by calling pattern ' +
      '(e.g. different arguments, with/without error handling, inside loops vs one-shot, etc.). ' +
      'Answer with ONLY named groups, each followed by the callers that use that pattern. ' +
      'Example format:\nWith error handling:\n  foo in src/a.ts\n  bar in src/b.ts\nFire-and-forget:\n  baz in src/c.ts',
  },

  // ── Modification safety + snippet ──────────────────────────────────────

  {
    questionId: '11.2',
    category: 'Modification Safety',
    family: 'modification',
    description: 'Safe deletion check — which callers break and where',
    loreTools: ['lore_dependents(depth=2)', 'lore_snippet'],
    loreAdvantage: 'Graph gives transitive dependents; snippet shows the exact breaking call site in each.',
    promptTemplate:
      'If I delete `{{symbol}}` from `{{file}}`, which functions in other files would break? ' +
      'For each broken caller, show the function name, file, and the line of code that calls `{{symbol}}`. ' +
      'Answer with ONLY a newline-separated list in the format "function in file — code", nothing else. ' +
      'Example format:\nbuildIndex in src/indexer.ts — const db = openDb(path)\nmain in src/cli.ts — await openDb(config.dbPath)',
  },
  {
    questionId: '11.3',
    category: 'Modification Safety',
    family: 'refactoring',
    description: 'Inline refactoring feasibility — can a function be safely inlined',
    loreTools: ['lore_dependents', 'lore_graph(kind=call)', 'lore_snippet'],
    loreAdvantage: 'Graph gives callers + callees; snippet shows function body and each call site to judge inlinability.',
    promptTemplate:
      'Could `{{symbol}}` be safely inlined into its callers? ' +
      'Consider: how many callers exist, whether it has side effects, whether it is called more than once per caller, ' +
      'and whether inlining would duplicate complex logic. ' +
      'Answer with: 1) The number of callers, 2) A yes/no verdict with reasoning, ' +
      '3) For each caller, one line showing the call site. ' +
      'Example format:\nCallers: 3\nVerdict: No — function has 15 lines with side effects (database write), inlining would duplicate logic\nCall sites:\n  foo in src/a.ts — openDb(path)\n  bar in src/b.ts — openDb(config.dbPath)',
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
    .replace(/\{\{symbol2\}\}/g, params.symbol2 ?? '')
    .replace(/\{\{file\}\}/g, params.file)
    .replace(/\{\{languageLabel\}\}/g, repo.languageLabel)
    .replace(/\{\{sourceRoot\}\}/g, repo.sourceRoot);
}
