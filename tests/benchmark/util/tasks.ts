/**
 * @module benchmark/tasks
 *
 * Universal benchmark task definitions.
 *
 * Every repo in the pilot panel gets the **same 12 questions** — only the
 * concrete parameters (target symbol, target file, expected answer) differ.
 * This ensures an apples-to-apples comparison across repos and arms.
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
  /** Primary source language extension used for the Q9.5 file-count prompt. */
  languageLabel: string;
  /** Source root directory used for the Q9.5 file-count prompt. */
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
  {
    questionId: '1.4',
    family: 'localization',
    prompt: (p) =>
      `If I change the function \`${p.symbol}\` in \`${p.file}\`, what is the blast radius? Answer with ONLY a newline-separated list of files and functions that transitively depend on it, nothing else.`,
  },

  // ── Category 3: Import Graph ────────────────────────────────────────────
  {
    questionId: '3.1',
    family: 'localization',
    prompt: (p) =>
      `What files does \`${p.file}\` import or require? Answer with ONLY a newline-separated list of resolved file paths, nothing else.`,
  },
  {
    questionId: '3.2',
    family: 'localization',
    prompt: (p) =>
      `What files import or require \`${p.file}\`? Answer with ONLY a newline-separated list of dependent file paths, nothing else.`,
  },

  // ── Category 4: Test Mapping ────────────────────────────────────────────
  {
    questionId: '4.1',
    family: 'testing',
    prompt: (p) =>
      `What test files should I run after modifying \`${p.file}\`? Answer with ONLY a newline-separated list of test file paths relative to the repo root, nothing else.`,
  },

  // ── Category 6: Complexity ──────────────────────────────────────────────
  {
    questionId: '6.1',
    family: 'coverage',
    prompt: () =>
      'What are the 5 most complex functions in this codebase, ranked by cyclomatic complexity? Answer with ONLY a numbered list of function names, one per line, in descending order. Example format:\n1. foo\n2. bar\n3. baz\n4. qux\n5. quux',
  },

  // ── Category 7: History ─────────────────────────────────────────────────
  {
    questionId: '7.1',
    family: 'history',
    prompt: (p) =>
      `Who is the likely domain expert (most frequent committer) for \`${p.file}\`? Answer with ONLY the git author name, nothing else.`,
  },

  // ── Category 9: Architecture ────────────────────────────────────────────
  {
    questionId: '9.1',
    family: 'explanation',
    prompt: () =>
      'What are the high-level components of this codebase? Answer with ONLY a newline-separated list of component/module names, nothing else.',
  },
  {
    questionId: '9.5',
    family: 'explanation',
    prompt: (_p, repo) =>
      `How many ${repo.languageLabel} source files are in this codebase under the \`${repo.sourceRoot}\` directory? Answer with ONLY a single integer, nothing else.`,
  },

  // ── Category 11: Composite / Multi-Hop ──────────────────────────────────
  {
    questionId: '11.1',
    family: 'localization',
    prompt: (p) =>
      `I need to modify \`${p.symbol}\` in \`${p.file}\`. What test files should I run, what is the coverage of those test paths, and who should review the change? Answer with ONLY three lines:\n1. Test files (comma-separated paths)\n2. Coverage percentage\n3. Reviewer name`,
  },
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
    '1.1': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build\nupdate\ningestSummary\ningestCoverage', expectedAnswerParts: ['build', 'update', 'openDb'], expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/indexer/index.ts', 'src/db/schema.ts'] },
    '1.2': { symbol: 'build', file: 'src/indexer/index.ts', expectedAnswer: 'getLogger\nopenDb\nresolveBranch\nIndexPipeline\nrun\nsaveLastKnownHead', expectedAnswerParts: ['openDb', 'IndexPipeline', 'run'], expectedSymbols: ['build', 'IndexPipeline', 'openDb'], expectedFiles: ['src/indexer/index.ts'] },
    '1.4': { symbol: 'resolveSymbolEdges', file: 'src/resolution/call-graph.ts', expectedAnswer: 'resolution/call-graph.ts\nresolutionStage\nIndexBuilder\nbuild\nupdate', expectedAnswerParts: ['resolveSymbolEdges', 'call-graph.ts', 'IndexBuilder'], expectedSymbols: ['resolveSymbolEdges'], expectedFiles: ['src/resolution/call-graph.ts', 'src/indexer/index.ts'] },
    '3.1': { symbol: '', file: 'src/server/server.ts', expectedAnswer: 'db/read-only\ndb/schema\ntool-registry\nlogger\nembedder\nlookup\ngraph\nsearch\ndocs\nroutes\nnotes\narchitecture\ntest-map\nsnippet\nblame\nmetrics\ncoverage\nwriteback', expectedAnswerParts: ['tool-registry', 'logger', 'schema', 'read-only'], expectedFiles: ['src/server/server.ts', 'src/db/schema.ts'] },
    '3.2': { symbol: '', file: 'src/db/schema.ts', expectedAnswer: 'server/server.ts\nresolution/call-graph.ts\nresolution/graph-analysis.ts\nindex.ts\nindexer', expectedAnswerParts: ['server.ts', 'call-graph.ts', 'index.ts'], expectedFiles: ['src/db/schema.ts'] },
    '4.1': { symbol: '', file: 'src/parsing/parser.ts', expectedAnswer: 'tests/parsing/parser.test.ts', expectedAnswerParts: ['parser.test.ts'], expectedFiles: ['src/parsing/parser.ts', 'tests/parsing/parser.test.ts'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'complexity', expectedAnswerParts: ['complexity'], expectedSymbols: [] },
    '7.1': { symbol: '', file: 'src/parsing/parser.ts', expectedAnswer: 'Jacob Freck', expectedAnswerParts: ['Jacob Freck'], expectedFiles: ['src/parsing/parser.ts'] },
    '9.1': { symbol: '', file: '', expectedAnswer: 'indexer\nserver\nparsing\nresolution\ndb\ndiscovery\nembeddings\ngit\nlsp\nscip\nbenchmark\ntesting\ncli', expectedAnswerParts: ['indexer', 'server', 'parsing', 'resolution', 'db'], expectedFiles: [] },
    '9.5': { symbol: '', file: '', expectedAnswer: '97', expectedAnswerParts: ['97'] },
    '11.1': { symbol: 'resolveSymbolEdges', file: 'src/resolution/call-graph.ts', expectedAnswer: 'resolution\ncall-graph\ntest\nJacob Freck', expectedAnswerParts: ['call-graph', 'test', 'resolution'], expectedSymbols: ['resolveSymbolEdges'], expectedFiles: ['src/resolution/call-graph.ts'] },
    '11.4': { symbol: '', file: 'src/discovery/walker.ts', expectedAnswer: 'discovery/watcher.ts\ndiscovery/poller.ts\nruntime.ts\nindex.ts\nindexer/index.ts\nindexer/pipeline.ts\ncli.ts', expectedAnswerParts: ['watcher.ts', 'poller.ts', 'runtime.ts', 'index.ts', 'indexer'], expectedFiles: ['src/discovery/walker.ts'] },
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
    '3.1': { symbol: '', file: 'lib/application.js', expectedAnswer: 'finalhandler\nview\nutils\nRouter\nhttp', expectedAnswerParts: ['finalhandler', 'view', 'utils', 'Router'], expectedFiles: ['lib/application.js'] },
    '3.2': { symbol: '', file: 'lib/router/index.js', expectedAnswer: 'lib/express.js\nlib/application.js', expectedAnswerParts: ['express.js', 'application.js'], expectedFiles: ['lib/router/index.js'] },
    '4.1': { symbol: '', file: 'lib/application.js', expectedAnswer: 'test/app.js', expectedAnswerParts: ['test', 'app'], expectedFiles: ['lib/application.js'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'complexity', expectedAnswerParts: ['complexity'], expectedSymbols: [] },
    '7.1': { symbol: '', file: 'lib/application.js', expectedAnswer: 'TJ Holowaychuk', expectedAnswerParts: ['Holowaychuk'], expectedFiles: ['lib/application.js'] },
    '9.1': { symbol: '', file: '', expectedAnswer: 'application\nexpress\nrequest\nresponse\nrouter\nutils\nview', expectedAnswerParts: ['application', 'router', 'request', 'response'], expectedFiles: [] },
    '9.5': { symbol: '', file: '', expectedAnswer: '6', expectedAnswerParts: ['6'] },
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
    '3.1': { symbol: '', file: 'packages/zod/src/v4/index.ts', expectedAnswer: 'classic/index.js', expectedAnswerParts: ['classic', 'index'], expectedFiles: ['packages/zod/src/v4/index.ts'] },
    '3.2': { symbol: '', file: 'packages/zod/src/v4/core/schemas.ts', expectedAnswer: 'json-schema-generator.ts\nregistries.ts\nparse.ts\nerrors.ts\napi.ts\nto-json-schema.ts\ncore.ts\nchecks.ts\njson-schema-processors.ts\nutil.ts', expectedAnswerParts: ['parse.ts', 'api.ts', 'core.ts', 'checks.ts'], expectedFiles: ['packages/zod/src/v4/core/schemas.ts'] },
    '4.1': { symbol: '', file: 'packages/zod/src/v4/core/core.ts', expectedAnswer: 'packages/zod/src/v4/core/tests/index.test.ts', expectedAnswerParts: ['test', 'index.test.ts'], expectedFiles: ['packages/zod/src/v4/core/core.ts'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'complexity', expectedAnswerParts: ['complexity'], expectedSymbols: [] },
    '7.1': { symbol: '', file: 'packages/zod/src/v4/core/core.ts', expectedAnswer: 'Colin McDonnell', expectedAnswerParts: ['Colin McDonnell'], expectedFiles: ['packages/zod/src/v4/core/core.ts'] },
    '9.1': { symbol: '', file: '', expectedAnswer: 'v3\nv4\nv4/core\nv4/mini\nv4/classic\nmini\nlocales', expectedAnswerParts: ['v3', 'v4', 'core', 'mini', 'classic'], expectedFiles: [] },
    '9.5': { symbol: '', file: '', expectedAnswer: '277', expectedAnswerParts: ['277'] },
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
    '3.1': { symbol: '', file: 'fastapi/applications.py', expectedAnswer: 'routing\ndatastructures\nexception_handlers\nexceptions\nlogger\nmiddleware\nopenapi\nparams\ntypes\nutils\nstarlette', expectedAnswerParts: ['routing', 'datastructures', 'exceptions', 'openapi'], expectedFiles: ['fastapi/applications.py'] },
    '3.2': { symbol: '', file: 'fastapi/routing.py', expectedAnswer: 'fastapi/applications.py\nfastapi/__init__.py\nfastapi/openapi/utils.py\nfastapi/utils.py', expectedAnswerParts: ['applications.py', '__init__.py', 'utils.py'], expectedFiles: ['fastapi/routing.py'] },
    '4.1': { symbol: '', file: 'fastapi/routing.py', expectedAnswer: 'tests/test_router.py', expectedAnswerParts: ['test', 'router'], expectedFiles: ['fastapi/routing.py'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'complexity', expectedAnswerParts: ['complexity'], expectedSymbols: [] },
    '7.1': { symbol: '', file: 'fastapi/applications.py', expectedAnswer: 'Sebastián Ramírez', expectedAnswerParts: ['Sebastián Ramírez'], expectedFiles: ['fastapi/applications.py'] },
    '9.1': { symbol: '', file: '', expectedAnswer: 'applications\nrouting\ndependencies\nsecurity\nmiddleware\nopenapi\nparams\nexceptions\nencoders', expectedAnswerParts: ['applications', 'routing', 'dependencies', 'security', 'middleware'], expectedFiles: [] },
    '9.5': { symbol: '', file: '', expectedAnswer: '48', expectedAnswerParts: ['48'] },
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
    '3.1': { symbol: '', file: 'pkg/api/api_impl.go', expectedAnswer: 'api_helpers\nast\nbundler\ncache\ncompat\nconfig\ncss_ast\nfs\ngraph\nhelpers\njs_ast\njs_parser', expectedAnswerParts: ['bundler', 'js_parser', 'config', 'ast'], expectedFiles: ['pkg/api/api_impl.go'] },
    '3.2': { symbol: '', file: 'pkg/js_parser', expectedAnswer: 'pkg/cli/mangle_cache.go\npkg/api/api_impl.go', expectedAnswerParts: ['mangle_cache.go', 'api_impl.go'], expectedFiles: ['pkg/cli/mangle_cache.go', 'pkg/api/api_impl.go'] },
    '4.1': { symbol: '', file: 'pkg/api/api_impl.go', expectedAnswer: 'pkg/api/api_impl_test.go', expectedAnswerParts: ['test', 'api'], expectedFiles: ['pkg/api/api_impl.go'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'complexity', expectedAnswerParts: ['complexity'], expectedSymbols: [] },
    '7.1': { symbol: '', file: 'pkg/api/api_impl.go', expectedAnswer: 'Evan Wallace', expectedAnswerParts: ['Evan Wallace'], expectedFiles: ['pkg/api/api_impl.go'] },
    '9.1': { symbol: '', file: '', expectedAnswer: 'api\ncli', expectedAnswerParts: ['api', 'cli'], expectedFiles: [] },
    '9.5': { symbol: '', file: '', expectedAnswer: '11', expectedAnswerParts: ['11'] },
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
