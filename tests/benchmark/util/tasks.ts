/**
 * @module benchmark/tasks
 *
 * Universal benchmark task definitions.
 *
 * Every repo in the pilot panel gets the **same 12 questions** — only the
 * concrete parameters (target symbol, target file, expected answer) differ.
 * This ensures an apples-to-apples comparison across repos and arms.
 *
 * Each question is designed so that at least one Lore MCP tool can answer it
 * in 1–3 calls, whereas the control arm (grep / read_file only) needs many
 * more calls or cannot answer at all.
 *
 * To add a new repo, add a `RepoAnswers` entry to `ALL_REPO_ANSWERS` below.
 */

import type { BenchmarkTask, TaskFamily } from './types.js';

// ─── Per-repo answer data ───────────────────────────────────────────────────

/** Parameters that specialise a universal question for one repo. */
interface QuestionParams {
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

/** Full set of per-question parameters for a single repo. */
interface RepoAnswers {
  /** Must match the `name` field in `RepoSpec` / `PILOT_REPOS`. */
  repoName: string;
  /** Primary source language extension used for prompts. */
  languageLabel: string;
  /** Source root directory used for prompts. */
  sourceRoot: string;
  /** Per-question data keyed by question ID (e.g. '1.1'). */
  questions: Record<string, QuestionParams>;
}

// ─── Question catalog ───────────────────────────────────────────────────────

interface QuestionTemplate {
  questionId: string;
  family: TaskFamily;
  /** Build the prompt from per-repo params. */
  prompt: (p: QuestionParams, repo: RepoAnswers) => string;
}

const QUESTION_TEMPLATES: QuestionTemplate[] = [
  // ── Category 1: Call Graph ──────────────────────────────────────────────
  // Lore advantage: lore_lookup + lore_graph(kind=call) → 1–2 calls
  {
    questionId: '1.1',
    family: 'localization',
    prompt: (p) =>
      `What functions or methods directly call \`${p.symbol}\`? Answer with ONLY a newline-separated list of function/method names, nothing else. Example format:\nfoo\nbar\nbaz`,
  },
  {
    questionId: '1.2',
    family: 'localization',
    prompt: (p) =>
      `What does the function/method \`${p.symbol}\` call? Answer with ONLY a newline-separated list of the direct callee function/method names, nothing else.`,
  },
  // Lore advantage: lore_graph(kind=call, depth=3) → 1 call for full transitive closure
  {
    questionId: '1.4',
    family: 'localization',
    prompt: (p) =>
      `If I change the function \`${p.symbol}\` in \`${p.file}\`, what is the blast radius? ` +
      'Use transitive dependency analysis if available (follow callers of callers, up to 3 hops). ' +
      'Answer with ONLY a newline-separated list of files and functions that transitively depend on it, nothing else.',
  },

  // ── Category 2: Type / Inheritance Graph ────────────────────────────────
  // Lore advantage: lore_graph(kind=inheritance) in one call; grep can find
  // "implements X" but can't resolve transitive chains or count reliably.
  {
    questionId: '2.1',
    family: 'localization',
    prompt: (p) =>
      `What classes or types implement the interface \`${p.symbol}\`? Answer with ONLY a newline-separated list of class/type names, nothing else.`,
  },

  // ── Category 4: Test Mapping ────────────────────────────────────────────
  // Lore advantage: lore_test_map → 1 call
  {
    questionId: '4.1',
    family: 'testing',
    prompt: (p) =>
      `What test files should I run after modifying \`${p.file}\`? Answer with ONLY a newline-separated list of test file paths relative to the repo root, nothing else.`,
  },

  // ── Category 6: Complexity ──────────────────────────────────────────────
  // Lore advantage: lore_metrics(mode=complexity, limit=5) → 1 call
  {
    questionId: '6.1',
    family: 'coverage',
    prompt: () =>
      'What are the 5 most complex functions in this codebase, ranked by cyclomatic complexity? ' +
      'Use pre-indexed complexity metrics if available rather than scanning source files. ' +
      'Answer with ONLY a numbered list of function names, one per line, in descending order. Example format:\n1. foo\n2. bar\n3. baz\n4. qux\n5. quux',
  },

  // ── Category 7: Cross-file Consumer Trace ──────────────────────────────
  // Lore advantage: lore_lookup(kind=symbol) → lore_graph(kind=call) to
  // enumerate callers/consumers across files in 2–3 calls.
  // Control must grep for imports, then trace type usage across files.
  {
    questionId: '7.2',
    family: 'localization',
    prompt: (p) =>
      `What functions across the codebase directly consume or reference the type/interface \`${p.symbol}\` defined in \`${p.file}\`? ` +
      'List only functions in OTHER files (not the file where it is defined). ' +
      'Answer with ONLY a newline-separated list in the format "function → file", nothing else. ' +
      'Example format:\nfoo → src/bar.ts\nbaz → src/qux.ts',
  },

  // ── Category 8: Graph Analysis ──────────────────────────────────────────
  // Lore advantage: lore_analyze(mode=cycles) → 1 call; impossible with grep
  {
    questionId: '8.1',
    family: 'explanation',
    prompt: () =>
      'Are there any circular dependencies (import cycles) between source files in this codebase? ' +
      'Answer with ONLY a list of the cycle(s), each on its own line showing the file loop ' +
      '(e.g. "a.ts → b.ts → a.ts"), or "None" if the codebase is acyclic.',
  },

  // ── Category 3: Module Dependency Summary ───────────────────────────────
  // Lore advantage: lore_analyze(mode=summary) → 1 call for full module graph
  {
    questionId: '3.3',
    family: 'explanation',
    prompt: () =>
      'What are the top-level modules/packages in this codebase and how do they depend on each other? ' +
      'Answer with ONLY a newline-separated list, one module per line, in the exact format below. ' +
      'Use module paths relative to the repo root (e.g. src/indexer, lib/router, pkg/api). ' +
      'List dependencies as comma-separated paths, or (none) if there are no internal dependencies. ' +
      'Include every module, even those with no dependencies. Nothing else in the answer.\n' +
      'Example format:\nsrc/module_a → src/module_b, src/module_c\nsrc/module_b → (none)',
  },

  // ── Category 10: Cross-module Call Fan-in ────────────────────────────────
  // Lore advantage: lore_lookup(kind=file) to get symbol IDs → lore_graph(kind=call)
  // for each symbol → aggregate callers by file → 3–5 calls.
  // Control must read file, identify exports, grep each across the codebase → 10+ calls.
  {
    questionId: '10.2',
    family: 'explanation',
    prompt: (p) =>
      `Which functions in \`${p.file}\` are called from the most distinct source files? ` +
      'Rank the top 3 by number of unique calling files (exclude test files). ' +
      'Answer with ONLY a numbered list in the format "name — N files: file1, file2, ...", nothing else. ' +
      'Example format:\n1. foo — 4 files: src/a.ts, src/b.ts, src/c.ts, src/d.ts\n2. bar — 3 files: src/a.ts, src/e.ts, src/f.ts\n3. baz — 2 files: src/a.ts, src/g.ts',
  },

  // ── Category 11: Composite / Multi-Hop ──────────────────────────────────
  // Lore advantage: chains lore_test_map + lore_coverage + lore_blame → 3 calls
  {
    questionId: '11.1',
    family: 'localization',
    prompt: (p) =>
      `I need to modify \`${p.symbol}\` in \`${p.file}\`. What test files should I run, what is the coverage of those test paths, and who should review the change? Answer with ONLY three lines:\n1. Test files (comma-separated paths)\n2. Coverage percentage\n3. Reviewer name`,
  },
  // Lore advantage: lore_lookup(kind=symbol, path_prefix=file) to find exports,
  // then lore_graph(kind=call, target_id=<id>) for each → 2–4 calls total.
  // Control needs: read file → parse exports → grep each export name → 6+ calls.
  {
    questionId: '11.4',
    family: 'localization',
    prompt: (p) =>
      `If I deleted \`${p.file}\`, what exported symbols from that file are used elsewhere in the codebase, and which source files (not test files) use each one? ` +
      'Answer with ONLY a newline-separated list in the exact format below, nothing else. ' +
      'Use file paths relative to the repo root. ' +
      'Only include symbols that are actually imported or referenced by other source files.\n' +
      'Example format:\nMyFunction → path/to/consumer1.ts, path/to/consumer2.ts\nMyType → path/to/consumer3.ts',
  },
];

// ─── Per-repo answer tables ─────────────────────────────────────────────────

const LORE_SELF_ANSWERS: RepoAnswers = {
  repoName: 'lore-self',
  languageLabel: 'TypeScript',
  sourceRoot: 'src/',
  questions: {
    // Q1.1: openDb callers — main does NOT directly call openDb (it calls
    // builder.build which internally calls openDb). docsAutoNotes1 is the
    // cli.ts property that calls it directly. Verified against SCIP index.
    '1.1': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build\nupdate\ningestSummary\ningestCoverage\ndocsAutoNotes1', expectedAnswerParts: ['build', 'update', 'ingestSummary', 'ingestCoverage'], expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/indexer/index.ts', 'src/cli.ts'] },
    // Q1.2: build callees — SCIP records `new IndexPipeline(...)` as a call
    // to `<constructor>`, not to `IndexPipeline`. `pipeline.run` is the
    // actual callee name in the graph for IndexPipeline.run().
    '1.2': { symbol: 'build', file: 'src/indexer/index.ts', expectedAnswer: 'getLogger\nopenDb\nresolveBranch\n<constructor>\nresolutionStage\ntestMapStage\nhistoryStage\npipeline.run\nsaveLastKnownHead\ngatherDbStats', expectedAnswerParts: ['openDb', 'resolutionStage', 'pipeline.run', 'saveLastKnownHead'], expectedSymbols: ['build', 'openDb'], expectedFiles: ['src/indexer/index.ts'] },
    // Q1.4: resolveSymbolEdges blast radius — the transitive caller chain is
    // resolveSymbolEdges → resolutionStage → build/update. The source file
    // (call-graph.ts) is implicit in the prompt, so the expected answer only
    // includes the dependent files and functions.
    '1.4': { symbol: 'resolveSymbolEdges', file: 'src/resolution/call-graph.ts', expectedAnswer: 'resolutionStage\nbuild\nupdate', expectedAnswerParts: ['resolutionStage', 'build', 'update'], expectedSymbols: ['resolveSymbolEdges'], expectedFiles: ['src/resolution/call-graph.ts', 'src/indexer/index.ts'] },
    '2.1': { symbol: 'SymbolExtractor', file: 'src/parsing/extractors/types.ts', expectedAnswer: 'TypeScriptExtractor\nJavaScriptExtractor\nPythonExtractor\nGoExtractor\nRustExtractor\nJavaExtractor\nCExtractor\nCppExtractor\nCSharpExtractor\nRubyExtractor\nSwiftExtractor\nKotlinExtractor\nPhpExtractor\nScalaExtractor\nElixirExtractor\nOcamlExtractor\nHaskellExtractor\nElmExtractor\nLuaExtractor\nBashExtractor\nZigExtractor\nJuliaExtractor\nObjcExtractor', expectedAnswerParts: ['TypeScriptExtractor', 'JavaScriptExtractor', 'PythonExtractor', 'GoExtractor', 'RustExtractor'], expectedSymbols: ['SymbolExtractor', 'TypeScriptExtractor', 'PythonExtractor'] },
    '4.1': { symbol: '', file: 'src/parsing/parser.ts', expectedAnswer: 'tests/parsing/parser.test.ts', expectedAnswerParts: ['parser.test.ts'], expectedFiles: ['src/parsing/parser.ts', 'tests/parsing/parser.test.ts'] },
    // Q6.1: Top-5 by cyclomatic complexity — verified against tree-sitter
    // symbol_metrics at SHA 660be2bf (ScipSourceStage=90, execute=77,
    // main=49, ImportResolver=47, clusterSymbols=37).
    '6.1': { symbol: '', file: '', expectedAnswer: 'ScipSourceStage\nexecute\nmain\nImportResolver\nclusterSymbols', expectedAnswerParts: ['ScipSourceStage', 'execute', 'main', 'ImportResolver', 'clusterSymbols'], expectedSymbols: [] },
    // Q7.2: Cross-file consumer trace — find functions in other files that
    // consume/reference the EmbeddingProvider interface. Verified via type_refs
    // at SHA 660be2bf. 25 consuming symbols across 13 source files.
    '7.2': { symbol: 'EmbeddingProvider', file: 'src/embeddings/embedder.ts', expectedAnswer: 'main → src/cli.ts\nembedStructural → src/indexer/stages/embedding.ts\nembedDocumentation → src/indexer/stages/embedding.ts\nembedCommitMessages → src/indexer/stages/embedding.ts\ncreateLoreMcpServer → src/server/server.ts\nhandler → src/server/tools/search.ts\nsemanticLookup → src/server/tools/lookup.ts\nsemanticDocSearch → src/server/tools/docs.ts', expectedAnswerParts: ['embedStructural', 'createLoreMcpServer', 'main', 'handler'], expectedSymbols: ['EmbeddingProvider', 'embedStructural', 'createLoreMcpServer'], expectedFiles: ['src/embeddings/embedder.ts', 'src/indexer/stages/embedding.ts', 'src/server/server.ts', 'src/cli.ts'] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    // Q3.3: Module dependency summary — verified against actual import
    // statements at SHA 660be2bf. Paths relative to repo root.
    '3.3': { symbol: '', file: '', expectedAnswer: 'src/indexer → src/db, src/discovery, src/docs, src/embeddings, src/git, src/lsp, src/parsing, src/resolution, src/scip, src/testing\nsrc/server → src/db, src/embeddings, src/resolution\nsrc/discovery → src/docs, src/embeddings, src/indexer, src/lsp\nsrc/resolution → src/db, src/parsing\nsrc/lsp → src/parsing\nsrc/scip → src/lsp\nsrc/git → src/db\nsrc/testing → src/db\nsrc/db → (none)\nsrc/parsing → (none)\nsrc/docs → (none)\nsrc/embeddings → (none)', expectedAnswerParts: ['src/indexer', 'src/server', 'src/resolution', 'src/db', 'src/discovery', 'src/lsp', 'src/scip', 'src/testing'], expectedSymbols: [] },
    // Q10.2: Cross-module call fan-in — rank functions in read-only.ts by
    // how many distinct source files call them. Verified via symbol_refs
    // at SHA 660be2bf. getFileByPath has 3 callers, several others have 2.
    '10.2': { symbol: '', file: 'src/db/read-only.ts', expectedAnswer: '1. getFileByPath — 3 files: src/server/tools/lookup.ts, src/server/tools/snippet.ts, src/server/tools/blame.ts\n2. getLatestCoverageTotals — 2 files: src/server/tools/metrics.ts, src/server/tools/coverage.ts\n3. openReadOnly — 2 files: src/server/server.ts, src/cli.ts', expectedAnswerParts: ['getFileByPath', 'getLatestCoverageTotals', 'openReadOnly'], expectedSymbols: ['getFileByPath', 'getLatestCoverageTotals', 'openReadOnly'], expectedFiles: ['src/db/read-only.ts', 'src/server/tools/lookup.ts', 'src/server/tools/blame.ts'] },
    '11.1': { symbol: 'resolveSymbolEdges', file: 'src/resolution/call-graph.ts', expectedAnswer: 'resolution\ncall-graph\ntest\nJacob Freck', expectedAnswerParts: ['call-graph', 'test', 'resolution'], expectedSymbols: ['resolveSymbolEdges'], expectedFiles: ['src/resolution/call-graph.ts'] },
    // Q11.4: Deletion impact — which exported symbols from walker.ts are used
    // elsewhere in source files? Verified at SHA 660be2bf. walkFiles is used via
    // dynamic import in cli.ts. WalkerConfig type is used in 5 source files.
    // walkDocumentationFiles and detectLanguageForPath are each used in one stage.
    // Test files excluded per prompt instructions.
    '11.4': { symbol: '', file: 'src/discovery/walker.ts', expectedAnswer: 'walkFiles → src/indexer/stages/source-index.ts, src/discovery/poller.ts, src/cli.ts\nwalkDocumentationFiles → src/indexer/stages/docs-index.ts\ndetectLanguageForPath → src/indexer/stages/source-index.ts\nWalkerConfig → src/indexer/index.ts, src/indexer/pipeline.ts, src/runtime.ts, src/discovery/poller.ts, src/discovery/watcher.ts', expectedAnswerParts: ['walkFiles', 'walkDocumentationFiles', 'detectLanguageForPath', 'WalkerConfig', 'source-index.ts', 'docs-index.ts'], expectedSymbols: ['walkFiles', 'WalkerConfig', 'detectLanguageForPath'], expectedFiles: ['src/discovery/walker.ts'] },
  },
};

const EXPRESS_ANSWERS: RepoAnswers = {
  repoName: 'express',
  languageLabel: 'JavaScript',
  sourceRoot: 'lib/',
  questions: {
    '1.1': { symbol: 'handle', file: 'lib/router/index.js', expectedAnswer: 'createApplication\napp.handle', expectedAnswerParts: ['handle', 'createApplication', 'application'], expectedSymbols: ['handle'], expectedFiles: ['lib/express.js', 'lib/application.js'] },
    '1.2': { symbol: 'createApplication', file: 'lib/express.js', expectedAnswer: 'handle\nmixin\nObject.create\ninit', expectedAnswerParts: ['handle', 'mixin', 'init'], expectedSymbols: ['createApplication', 'mixin'], expectedFiles: ['lib/express.js'] },
    '1.4': { symbol: 'handle', file: 'lib/router/index.js', expectedAnswer: 'lib/router/index.js\nlib/application.js\nlib/express.js', expectedAnswerParts: ['application.js', 'express.js', 'handle'], expectedSymbols: ['handle'], expectedFiles: ['lib/router/index.js', 'lib/application.js'] },
    '2.1': { symbol: 'Router', file: 'lib/router/index.js', expectedAnswer: 'express.Router', expectedAnswerParts: ['Router'], expectedSymbols: ['Router'] },
    '4.1': { symbol: '', file: 'lib/application.js', expectedAnswer: 'test/app.js', expectedAnswerParts: ['test', 'app'], expectedFiles: ['lib/application.js'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'complexity', expectedAnswerParts: ['complexity'], expectedSymbols: [] },
    '7.2': { symbol: 'Router', file: 'lib/router/index.js', expectedAnswer: 'createApplication → lib/express.js\napp.handle → lib/application.js', expectedAnswerParts: ['createApplication', 'app.handle', 'lib/express.js'], expectedSymbols: ['Router'], expectedFiles: ['lib/router/index.js', 'lib/express.js', 'lib/application.js'] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '3.3': { symbol: '', file: '', expectedAnswer: 'lib/application → lib/router, lib/view, lib/utils\nlib/router → (none)\nlib/request → (none)\nlib/response → (none)', expectedAnswerParts: ['lib/application', 'lib/router', 'lib/view', 'lib/utils'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'lib/router/index.js', expectedAnswer: '1. handle — files: lib/application.js\n2. use — files: lib/application.js\n3. route — files: lib/application.js', expectedAnswerParts: ['handle', 'use', 'route'], expectedSymbols: ['handle', 'use'], expectedFiles: ['lib/router/index.js', 'lib/application.js'] },
    '11.1': { symbol: 'handle', file: 'lib/router/index.js', expectedAnswer: 'router\ntest\nTJ Holowaychuk', expectedAnswerParts: ['router', 'test', 'Holowaychuk'], expectedSymbols: ['handle'], expectedFiles: ['lib/router/index.js'] },
    // Q11.4: Deletion impact — which exported symbols from router/index.js
    // are used elsewhere? Key exports: Router (constructor), Route, handle, use.
    '11.4': { symbol: '', file: 'lib/router/index.js', expectedAnswer: 'Router → lib/express.js, lib/application.js\nproto.handle → lib/application.js\nproto.use → lib/application.js', expectedAnswerParts: ['Router', 'handle', 'lib/express.js', 'lib/application.js'], expectedSymbols: ['Router', 'handle'], expectedFiles: ['lib/router/index.js'] },
  },
};

const ZOD_ANSWERS: RepoAnswers = {
  repoName: 'zod',
  languageLabel: 'TypeScript',
  sourceRoot: 'packages/zod/src/',
  questions: {
    '1.1': { symbol: '_parse', file: 'packages/zod/src/v4/core/core.ts', expectedAnswer: 'parse\nsafeParse\nparseAsync', expectedAnswerParts: ['parse', 'safeParse'], expectedSymbols: ['_parse', 'parse', 'safeParse'], expectedFiles: ['packages/zod/src/v4/core/core.ts', 'packages/zod/src/v4/core/parse.ts'] },
    '1.2': { symbol: 'parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: '_parse\n_zod_output\naddIssueToContext', expectedAnswerParts: ['_parse'], expectedSymbols: ['parse', '_parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.4': { symbol: '_parse', file: 'packages/zod/src/v4/core/core.ts', expectedAnswer: 'core.ts\nparse.ts\nschemas.ts\napi.ts', expectedAnswerParts: ['core.ts', 'parse.ts', 'schemas.ts'], expectedSymbols: ['_parse'], expectedFiles: ['packages/zod/src/v4/core/core.ts'] },
    '2.1': { symbol: '$ZodType', file: 'packages/zod/src/v4/core/schemas.ts', expectedAnswer: '$ZodString\n$ZodNumber\n$ZodBoolean\n$ZodArray\n$ZodObject\n$ZodUnion\n$ZodOptional\n$ZodNullable', expectedAnswerParts: ['$ZodString', '$ZodNumber', '$ZodArray', '$ZodObject'], expectedSymbols: ['$ZodType', '$ZodString', '$ZodObject'] },
    '4.1': { symbol: '', file: 'packages/zod/src/v4/core/core.ts', expectedAnswer: 'packages/zod/src/v4/core/tests/index.test.ts', expectedAnswerParts: ['test', 'index.test.ts'], expectedFiles: ['packages/zod/src/v4/core/core.ts'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'complexity', expectedAnswerParts: ['complexity'], expectedSymbols: [] },
    '7.2': { symbol: '$ZodType', file: 'packages/zod/src/v4/core/core.ts', expectedAnswer: '$ZodString → packages/zod/src/v4/core/schemas.ts\n$ZodNumber → packages/zod/src/v4/core/schemas.ts\n$ZodObject → packages/zod/src/v4/core/schemas.ts', expectedAnswerParts: ['$ZodString', '$ZodNumber', '$ZodObject', 'schemas.ts'], expectedSymbols: ['$ZodType', '$ZodString'], expectedFiles: ['packages/zod/src/v4/core/core.ts', 'packages/zod/src/v4/core/schemas.ts'] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '3.3': { symbol: '', file: '', expectedAnswer: 'packages/zod/src/v4/core → (internal)\npackages/zod/src/v4/classic → packages/zod/src/v4/core\npackages/zod/src/v4/mini → packages/zod/src/v4/core\npackages/zod/src/v3 → (standalone)', expectedAnswerParts: ['v4/core', 'v4/classic', 'v4/mini', 'v3'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'packages/zod/src/v4/core/core.ts', expectedAnswer: '1. $ZodType — files: packages/zod/src/v4/core/schemas.ts, packages/zod/src/v4/core/api.ts', expectedAnswerParts: ['$ZodType', 'schemas.ts'], expectedSymbols: ['$ZodType'], expectedFiles: ['packages/zod/src/v4/core/core.ts', 'packages/zod/src/v4/core/schemas.ts'] },
    '11.1': { symbol: '_parse', file: 'packages/zod/src/v4/core/core.ts', expectedAnswer: 'core\ntest\nColin McDonnell', expectedAnswerParts: ['core', 'test', 'Colin McDonnell'], expectedSymbols: ['_parse'], expectedFiles: ['packages/zod/src/v4/core/core.ts'] },
    // Q11.4: Deletion impact — which exported symbols from schemas.ts
    // are used elsewhere? Key exports: all $Zod* schema classes.
    '11.4': { symbol: '', file: 'packages/zod/src/v4/core/schemas.ts', expectedAnswer: '$ZodString → packages/zod/src/v4/core/core.ts, packages/zod/src/v4/core/api.ts\n$ZodNumber → packages/zod/src/v4/core/core.ts, packages/zod/src/v4/core/api.ts\n$ZodObject → packages/zod/src/v4/core/core.ts, packages/zod/src/v4/core/api.ts\n$ZodArray → packages/zod/src/v4/core/core.ts, packages/zod/src/v4/core/api.ts', expectedAnswerParts: ['$ZodString', '$ZodObject', 'packages/zod/src/v4/core/core.ts', 'packages/zod/src/v4/core/api.ts'], expectedSymbols: ['$ZodString', '$ZodObject'], expectedFiles: ['packages/zod/src/v4/core/schemas.ts'] },
  },
};

const FASTAPI_ANSWERS: RepoAnswers = {
  repoName: 'fastapi',
  languageLabel: 'Python',
  sourceRoot: 'fastapi/',
  questions: {
    '1.1': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'get_request_handler\nrun_endpoint_function', expectedAnswerParts: ['get_request_handler', 'solve_dependencies'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '1.2': { symbol: 'add_api_route', file: 'fastapi/routing.py', expectedAnswer: 'get_request_handler\nAPIRoute\ngenerate_unique_id', expectedAnswerParts: ['get_request_handler', 'APIRoute'], expectedSymbols: ['add_api_route'], expectedFiles: ['fastapi/routing.py'] },
    '1.4': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'dependencies/utils.py\nrouting.py\napplications.py', expectedAnswerParts: ['routing.py', 'applications.py', 'solve_dependencies'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '2.1': { symbol: 'APIRouter', file: 'fastapi/routing.py', expectedAnswer: 'FastAPI', expectedAnswerParts: ['FastAPI'], expectedSymbols: ['APIRouter', 'FastAPI'] },
    '4.1': { symbol: '', file: 'fastapi/routing.py', expectedAnswer: 'tests/test_router.py', expectedAnswerParts: ['test', 'router'], expectedFiles: ['fastapi/routing.py'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'complexity', expectedAnswerParts: ['complexity'], expectedSymbols: [] },
    '7.2': { symbol: 'Depends', file: 'fastapi/params.py', expectedAnswer: 'solve_dependencies → fastapi/dependencies/utils.py\nget_dependant → fastapi/dependencies/utils.py', expectedAnswerParts: ['solve_dependencies', 'get_dependant', 'dependencies/utils.py'], expectedSymbols: ['Depends', 'solve_dependencies'], expectedFiles: ['fastapi/params.py', 'fastapi/dependencies/utils.py'] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '3.3': { symbol: '', file: '', expectedAnswer: 'fastapi/applications → fastapi/routing, fastapi/middleware, fastapi/openapi, fastapi/exceptions\nfastapi/routing → fastapi/dependencies, fastapi/openapi\nfastapi/dependencies → (none)\nfastapi/security → fastapi/dependencies', expectedAnswerParts: ['fastapi/applications', 'fastapi/routing', 'fastapi/dependencies', 'fastapi/security', 'fastapi/openapi'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'fastapi/routing.py', expectedAnswer: '1. APIRouter — files: fastapi/applications.py, fastapi/__init__.py\n2. APIRoute — files: fastapi/routing.py\n3. get_request_handler — files: fastapi/routing.py', expectedAnswerParts: ['APIRouter', 'APIRoute', 'get_request_handler'], expectedSymbols: ['APIRouter', 'APIRoute'], expectedFiles: ['fastapi/routing.py', 'fastapi/applications.py'] },
    '11.1': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'dependencies\ntest\nSebastián Ramírez', expectedAnswerParts: ['dependencies', 'test', 'Ramírez'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py'] },
    // Q11.4: Deletion impact — which exported symbols from routing.py
    // are used elsewhere? Key exports: APIRouter, APIRoute, get_request_handler.
    '11.4': { symbol: '', file: 'fastapi/routing.py', expectedAnswer: 'APIRouter → fastapi/applications.py, fastapi/__init__.py\nAPIRoute → fastapi/routing.py\nget_request_handler → fastapi/routing.py', expectedAnswerParts: ['APIRouter', 'APIRoute', 'fastapi/applications.py', 'fastapi/__init__.py'], expectedSymbols: ['APIRouter', 'APIRoute'], expectedFiles: ['fastapi/routing.py'] },
  },
};

const ESBUILD_ANSWERS: RepoAnswers = {
  repoName: 'esbuild',
  languageLabel: 'Go',
  sourceRoot: 'pkg/',
  questions: {
    '1.1': { symbol: 'Build', file: 'pkg/api/api.go', expectedAnswer: 'main\nrebuildImpl', expectedAnswerParts: ['Build', 'rebuildImpl'], expectedSymbols: ['Build'], expectedFiles: ['pkg/api/api.go', 'pkg/api/api_impl.go'] },
    '1.2': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'buildImpl\nscanBundle\ncompileResult', expectedAnswerParts: ['buildImpl'], expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go'] },
    '1.4': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'pkg/api/api_impl.go\npkg/api/api.go\nBuild\nServe', expectedAnswerParts: ['api_impl.go', 'api.go', 'Build'], expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go', 'pkg/api/api.go'] },
    '2.1': { symbol: 'Plugin', file: 'pkg/api/api.go', expectedAnswer: 'Plugin implementations', expectedAnswerParts: ['Plugin'], expectedSymbols: ['Plugin'] },
    '4.1': { symbol: '', file: 'pkg/api/api_impl.go', expectedAnswer: 'pkg/api/api_impl_test.go', expectedAnswerParts: ['test', 'api'], expectedFiles: ['pkg/api/api_impl.go'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'complexity', expectedAnswerParts: ['complexity'], expectedSymbols: [] },
    '7.2': { symbol: 'Plugin', file: 'pkg/api/api.go', expectedAnswer: 'Build → pkg/api/api.go\nrebuildImpl → pkg/api/api_impl.go', expectedAnswerParts: ['Build', 'rebuildImpl', 'api_impl.go'], expectedSymbols: ['Plugin', 'Build'], expectedFiles: ['pkg/api/api.go', 'pkg/api/api_impl.go'] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '3.3': { symbol: '', file: '', expectedAnswer: 'pkg/api → pkg/bundler, pkg/js_parser, pkg/css_parser, pkg/config\npkg/bundler → pkg/js_parser, pkg/css_parser, pkg/graph, pkg/linker\npkg/cli → pkg/api', expectedAnswerParts: ['pkg/api', 'pkg/bundler', 'pkg/js_parser', 'pkg/cli'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'pkg/api/api_impl.go', expectedAnswer: '1. rebuildImpl — files: pkg/api/api.go\n2. serveImpl — files: pkg/api/api.go', expectedAnswerParts: ['rebuildImpl', 'serveImpl', 'pkg/api/api.go'], expectedSymbols: ['rebuildImpl', 'serveImpl'], expectedFiles: ['pkg/api/api_impl.go', 'pkg/api/api.go'] },
    '11.1': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'api\ntest\nEvan Wallace', expectedAnswerParts: ['api', 'test', 'Evan Wallace'], expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go'] },
    // Q11.4: Deletion impact — which exported symbols from api_impl.go
    // are used elsewhere? Key exports: rebuildImpl, serveImpl.
    '11.4': { symbol: '', file: 'pkg/api/api_impl.go', expectedAnswer: 'rebuildImpl → pkg/api/api.go\nserveImpl → pkg/api/api.go', expectedAnswerParts: ['rebuildImpl', 'serveImpl', 'pkg/api/api.go'], expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go'] },
  },
};

// ─── Registry ───────────────────────────────────────────────────────────────

const ALL_REPO_ANSWERS: RepoAnswers[] = [
  LORE_SELF_ANSWERS,
  EXPRESS_ANSWERS,
  ZOD_ANSWERS,
  FASTAPI_ANSWERS,
  ESBUILD_ANSWERS,
];

const REPO_ANSWERS_MAP = new Map(ALL_REPO_ANSWERS.map((r) => [r.repoName, r]));

// ─── Task generation ────────────────────────────────────────────────────────

/**
 * Build concrete `BenchmarkTask[]` for a given repo by applying the
 * universal question templates to that repo's answer table.
 */
export function getTasksForRepo(repoName: string): BenchmarkTask[] {
  const answers = REPO_ANSWERS_MAP.get(repoName);
  if (!answers) return [];

  const tasks: BenchmarkTask[] = [];

  for (const template of QUESTION_TEMPLATES) {
    const params = answers.questions[template.questionId];
    if (!params) continue;

    const suffix = params.symbol || params.file.split('/').pop()?.replace(/\.[^.]+$/, '') || template.questionId;
    tasks.push({
      id: `${repoName}-${template.questionId}-${suffix}`,
      repoName,
      family: template.family,
      questionId: template.questionId,
      prompt: template.prompt(params, answers),
      expectedAnswer: params.expectedAnswer,
      expectedAnswerParts: params.expectedAnswerParts,
      expectedFiles: params.expectedFiles,
      expectedSymbols: params.expectedSymbols,
    });
  }

  return tasks;
}

/**
 * Get all available benchmark tasks across all repos.
 */
export function getAllTasks(): BenchmarkTask[] {
  return ALL_REPO_ANSWERS.flatMap((r) => getTasksForRepo(r.repoName));
}

/**
 * Get the list of repo names that have benchmark answer tables.
 */
export function getBenchmarkRepoNames(): string[] {
  return ALL_REPO_ANSWERS.map((r) => r.repoName);
}

// ─── Backward-compatible exports ────────────────────────────────────────────

/** @deprecated Use `getTasksForRepo('lore-self')` instead. */
export const LORE_SELF_TASKS: BenchmarkTask[] = getTasksForRepo('lore-self');

/** @deprecated Use `getTasksForRepo('express')` instead. */
export const EXPRESS_TASKS: BenchmarkTask[] = getTasksForRepo('express');
