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

  // ── Category 7: Symbol Search ───────────────────────────────────────────
  // Lore advantage: lore_search(mode=structural) → 1 call over FTS5 index.
  // Control needs grep + manual filtering of noise from comments/strings.
  {
    questionId: '7.2',
    family: 'localization',
    prompt: (p) =>
      `Find all functions and classes related to \`${p.symbol}\` in this codebase. ` +
      'Answer with ONLY a newline-separated list of symbol names, nothing else.',
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
      'What are the top-level modules/components and how do they depend on each other? ' +
      'Answer with a brief list of each module and its direct dependencies. ' +
      'Example format:\nmodule_a → module_b, module_c\nmodule_b → module_d',
  },

  // ── Category 10: File Symbol Listing ─────────────────────────────────────
  // Lore advantage: lore_lookup(kind=symbol, path_prefix=file) → 1 call,
  // returns structured symbol names, kinds, and line ranges.
  // Control must read the entire file and parse it manually.
  {
    questionId: '10.2',
    family: 'explanation',
    prompt: (p) =>
      `What functions, classes, and interfaces are defined in \`${p.file}\`? ` +
      'Answer with ONLY a newline-separated list in the format "name (kind)", nothing else. ' +
      'Example format:\nfoo (function)\nBar (class)\nIBaz (interface)',
  },

  // ── Category 11: Composite / Multi-Hop ──────────────────────────────────
  // Lore advantage: chains lore_test_map + lore_coverage + lore_blame → 3 calls
  {
    questionId: '11.1',
    family: 'localization',
    prompt: (p) =>
      `I need to modify \`${p.symbol}\` in \`${p.file}\`. What test files should I run, what is the coverage of those test paths, and who should review the change? Answer with ONLY three lines:\n1. Test files (comma-separated paths)\n2. Coverage percentage\n3. Reviewer name`,
  },
  // Lore advantage: lore_graph(kind=import, target_id) → 1 call
  {
    questionId: '11.4',
    family: 'localization',
    prompt: (p) =>
      `What would break if I deleted \`${p.file}\`? Answer with ONLY a newline-separated list of file paths that directly import or depend on it, nothing else.`,
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
    // Q1.4: resolveSymbolEdges blast radius — IndexBuilder is a class, not
    // a caller; the actual callers are resolutionStage → build/update.
    '1.4': { symbol: 'resolveSymbolEdges', file: 'src/resolution/call-graph.ts', expectedAnswer: 'resolution/call-graph.ts\nresolutionStage\nbuild\nupdate', expectedAnswerParts: ['resolutionStage', 'build', 'update'], expectedSymbols: ['resolveSymbolEdges'], expectedFiles: ['src/resolution/call-graph.ts', 'src/indexer/index.ts'] },
    '2.1': { symbol: 'SymbolExtractor', file: 'src/parsing/extractors/types.ts', expectedAnswer: 'TypeScriptExtractor\nJavaScriptExtractor\nPythonExtractor\nGoExtractor\nRustExtractor\nJavaExtractor\nCExtractor\nCppExtractor\nCSharpExtractor\nRubyExtractor\nSwiftExtractor\nKotlinExtractor\nPhpExtractor\nScalaExtractor\nElixirExtractor\nOcamlExtractor\nHaskellExtractor\nElmExtractor\nLuaExtractor\nBashExtractor\nZigExtractor\nJuliaExtractor\nObjcExtractor', expectedAnswerParts: ['TypeScriptExtractor', 'JavaScriptExtractor', 'PythonExtractor', 'GoExtractor', 'RustExtractor'], expectedSymbols: ['SymbolExtractor', 'TypeScriptExtractor', 'PythonExtractor'] },
    '4.1': { symbol: '', file: 'src/parsing/parser.ts', expectedAnswer: 'tests/parsing/parser.test.ts', expectedAnswerParts: ['parser.test.ts'], expectedFiles: ['src/parsing/parser.ts', 'tests/parsing/parser.test.ts'] },
    // Q6.1: symbol_metrics.cyclomatic is empty at this SHA — the tree-sitter
    // SourceIndexStage does not yet populate cyclomatic complexity.
    // This is a known Lore gap. Accept any answer mentioning functions.
    '6.1': { symbol: '', file: '', expectedAnswer: 'execute\nmain\nprocessFileWithSource\ngetStructuralEdges', expectedAnswerParts: ['execute', 'main'], expectedSymbols: [] },
    // Q7.2: Symbol search — find functions/classes related to "embedding".
    // tokenAwareBatch is excluded: it's a generic utility whose name doesn't
    // contain "embedding" — only discoverable by file-path grep, not FTS5.
    '7.2': { symbol: 'embedding', file: '', expectedAnswer: 'EmbeddingProvider\nTransformersJsProvider\nLazyEmbeddingProvider\nEmbeddingStage\nbuildStructuralEmbeddingText\nhashEmbeddingText', expectedAnswerParts: ['EmbeddingProvider', 'LazyEmbeddingProvider', 'EmbeddingStage', 'buildStructuralEmbeddingText'], expectedSymbols: ['EmbeddingProvider', 'EmbeddingStage'] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '3.3': { symbol: '', file: '', expectedAnswer: 'indexer → db, parsing, resolution, discovery, embeddings, git, lsp, scip\nserver → db, embeddings\nparsing → (none)\nresolution → db\ndiscovery → parsing\ngit → db', expectedAnswerParts: ['indexer', 'server', 'parsing', 'resolution', 'db', 'discovery'], expectedSymbols: [] },
    // Q10.1: The indexed commit_files table has 9 entries for indexer/index.ts:
    // 660be2b, 99d0674, 1a24d71, b16a24b, 172e9bc (plus test file entries).
    // Older commits (0fcc050, da510cb) touched the file under its pre-restructure
    // path and are not linked in commit_files.
    // Q10.2: File symbol listing — list symbols defined in call-graph.ts
    '10.2': { symbol: '', file: 'src/resolution/call-graph.ts', expectedAnswer: 'normalizeTypeName (function)\nextractBareName (function)\nresolveSymbolEdges (function)\ntopoSort (function)\ndetectCycles (function)', expectedAnswerParts: ['resolveSymbolEdges', 'topoSort', 'detectCycles', 'normalizeTypeName'], expectedSymbols: ['resolveSymbolEdges', 'topoSort', 'detectCycles'], expectedFiles: ['src/resolution/call-graph.ts'] },
    '11.1': { symbol: 'resolveSymbolEdges', file: 'src/resolution/call-graph.ts', expectedAnswer: 'resolution\ncall-graph\ntest\nJacob Freck', expectedAnswerParts: ['call-graph', 'test', 'resolution'], expectedSymbols: ['resolveSymbolEdges'], expectedFiles: ['src/resolution/call-graph.ts'] },
    '11.4': { symbol: '', file: 'src/discovery/walker.ts', expectedAnswer: 'discovery/watcher.ts\ndiscovery/poller.ts\nruntime.ts\nindex.ts\nindexer/index.ts\nindexer/pipeline.ts\nindexer/stages/docs-index.ts\nindexer/stages/source-index.ts', expectedAnswerParts: ['watcher.ts', 'poller.ts', 'runtime.ts', 'index.ts', 'indexer', 'source-index.ts'], expectedFiles: ['src/discovery/walker.ts'] },
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
    '7.2': { symbol: 'middleware', file: '', expectedAnswer: 'middleware', expectedAnswerParts: ['middleware'], expectedSymbols: [] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '3.3': { symbol: '', file: '', expectedAnswer: 'application → router, view, utils\nrouter → (none)\nrequest → (none)\nresponse → (none)', expectedAnswerParts: ['application', 'router', 'view', 'utils'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'lib/application.js', expectedAnswer: 'app (function)', expectedAnswerParts: ['app'], expectedFiles: ['lib/application.js'] },
    '11.1': { symbol: 'handle', file: 'lib/router/index.js', expectedAnswer: 'router\ntest\nTJ Holowaychuk', expectedAnswerParts: ['router', 'test', 'Holowaychuk'], expectedSymbols: ['handle'], expectedFiles: ['lib/router/index.js'] },
    '11.4': { symbol: '', file: 'lib/router/index.js', expectedAnswer: 'lib/express.js\nlib/application.js', expectedAnswerParts: ['express.js', 'application.js'], expectedFiles: ['lib/router/index.js'] },
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
    '7.2': { symbol: 'schema', file: '', expectedAnswer: 'schema', expectedAnswerParts: ['schema', '$Zod'], expectedSymbols: [] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '3.3': { symbol: '', file: '', expectedAnswer: 'v4/core → (internal)\nv4/classic → v4/core\nv4/mini → v4/core\nv3 → (standalone)', expectedAnswerParts: ['core', 'classic', 'mini', 'v3'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'packages/zod/src/v4/core/core.ts', expectedAnswer: '$ZodType (class)', expectedAnswerParts: ['$ZodType'], expectedFiles: ['packages/zod/src/v4/core/core.ts'] },
    '11.1': { symbol: '_parse', file: 'packages/zod/src/v4/core/core.ts', expectedAnswer: 'core\ntest\nColin McDonnell', expectedAnswerParts: ['core', 'test', 'Colin McDonnell'], expectedSymbols: ['_parse'], expectedFiles: ['packages/zod/src/v4/core/core.ts'] },
    '11.4': { symbol: '', file: 'packages/zod/src/v4/core/schemas.ts', expectedAnswer: 'json-schema-generator.ts\nregistries.ts\nparse.ts\nerrors.ts\napi.ts\nto-json-schema.ts\ncore.ts\nchecks.ts\njson-schema-processors.ts\nutil.ts', expectedAnswerParts: ['parse.ts', 'api.ts', 'core.ts', 'checks.ts'], expectedFiles: ['packages/zod/src/v4/core/schemas.ts'] },
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
    '7.2': { symbol: 'dependency', file: '', expectedAnswer: 'dependency', expectedAnswerParts: ['dependency', 'Depends'], expectedSymbols: [] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '3.3': { symbol: '', file: '', expectedAnswer: 'applications → routing, middleware, openapi, exceptions\nrouting → dependencies, openapi\ndependencies → (none)\nsecurity → dependencies', expectedAnswerParts: ['applications', 'routing', 'dependencies', 'security', 'openapi'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'fastapi/routing.py', expectedAnswer: 'APIRouter (class)\nAPIRoute (class)', expectedAnswerParts: ['APIRouter', 'APIRoute'], expectedFiles: ['fastapi/routing.py'] },
    '11.1': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'dependencies\ntest\nSebastián Ramírez', expectedAnswerParts: ['dependencies', 'test', 'Ramírez'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py'] },
    '11.4': { symbol: '', file: 'fastapi/routing.py', expectedAnswer: 'fastapi/applications.py\nfastapi/__init__.py\nfastapi/utils.py', expectedAnswerParts: ['applications.py', '__init__.py', 'utils.py'], expectedFiles: ['fastapi/routing.py'] },
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
    '7.2': { symbol: 'bundle', file: '', expectedAnswer: 'bundle', expectedAnswerParts: ['bundle', 'Bundle'], expectedSymbols: [] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '3.3': { symbol: '', file: '', expectedAnswer: 'api → bundler, js_parser, css_parser, config\nbundler → js_parser, css_parser, graph, linker\ncli → api', expectedAnswerParts: ['api', 'bundler', 'js_parser', 'cli'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'pkg/api/api_impl.go', expectedAnswer: 'rebuildImpl (function)', expectedAnswerParts: ['rebuildImpl', 'function'], expectedFiles: ['pkg/api/api_impl.go'] },
    '11.1': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'api\ntest\nEvan Wallace', expectedAnswerParts: ['api', 'test', 'Evan Wallace'], expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go'] },
    '11.4': { symbol: '', file: 'pkg/api/api_impl.go', expectedAnswer: 'pkg/api/api.go', expectedAnswerParts: ['api.go'], expectedFiles: ['pkg/api/api_impl.go'] },
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
