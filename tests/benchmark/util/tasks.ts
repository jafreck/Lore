/**
 * @module benchmark/tasks
 *
 * Per-repo answer data and task generation.
 *
 * Every repo in the pilot panel gets the **same questions** from the
 * centralized catalog in `questions.ts` — only the concrete parameters
 * (target symbol, target file, expected answer) differ per repo.
 *
 * The question templates (prompt text, category, Lore tools, etc.) live in
 * {@link ./questions.ts}. This file contains only:
 * 1. Per-repo answer tables (`RepoAnswers`)
 * 2. Task generation helpers (`getTasksForRepo`, `getAllTasks`)
 *
 * To add a new repo, add a `RepoAnswers` entry to `ALL_REPO_ANSWERS` below.
 * To add a new question, add it to `QUESTION_CATALOG` in `questions.ts`.
 */

import type { BenchmarkTask } from './types.js';
import { QUESTION_CATALOG, renderPrompt, type QuestionParams, type RepoContext } from './questions.js';

// ─── Per-repo answer data ───────────────────────────────────────────────────

/** Full set of per-question parameters for a single repo. */
interface RepoAnswers extends RepoContext {
  /** Must match the `name` field in `RepoSpec` / `PILOT_REPOS`. */
  repoName: string;
  /** Per-question data keyed by question ID (e.g. '1.1'). */
  questions: Record<string, QuestionParams>;
}

// ─── Per-repo answer tables ─────────────────────────────────────────────────

const LORE_SELF_ANSWERS: RepoAnswers = {
  repoName: 'lore-self',
  languageLabel: 'TypeScript',
  sourceRoot: 'src/',
  questions: {
    '1.1': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build\nupdate\ningestSummary\ningestCoverage', expectedAnswerParts: ['build', 'update', 'ingestSummary', 'ingestCoverage'], expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/indexer/index.ts', 'src/cli.ts'] },
    '1.2': { symbol: 'build', file: 'src/indexer/index.ts', expectedAnswer: 'getLogger\nopenDb\nresolveBranch\n<constructor>\nresolutionStage\ntestMapStage\nhistoryStage\npipeline.run\nsaveLastKnownHead\ngatherDbStats', expectedAnswerParts: ['openDb', 'resolutionStage', 'pipeline.run', 'saveLastKnownHead'], expectedSymbols: ['build', 'openDb'], expectedFiles: ['src/indexer/index.ts'] },
    '1.4': { symbol: 'resolveSymbolEdges', file: 'src/resolution/call-graph.ts', expectedAnswer: 'resolutionStage\nbuild\nupdate', expectedAnswerParts: ['resolutionStage', 'build', 'update'], expectedSymbols: ['resolveSymbolEdges'], expectedFiles: ['src/resolution/call-graph.ts', 'src/indexer/index.ts'] },
    '2.1': { symbol: 'SymbolExtractor', file: 'src/parsing/extractors/types.ts', expectedAnswer: 'TypeScriptExtractor\nJavaScriptExtractor\nPythonExtractor\nGoExtractor\nRustExtractor\nJavaExtractor\nCExtractor\nCppExtractor\nCSharpExtractor\nRubyExtractor\nSwiftExtractor\nKotlinExtractor\nPhpExtractor\nScalaExtractor\nElixirExtractor\nOcamlExtractor\nHaskellExtractor\nElmExtractor\nLuaExtractor\nBashExtractor\nZigExtractor\nJuliaExtractor\nObjcExtractor', expectedAnswerParts: ['TypeScriptExtractor', 'JavaScriptExtractor', 'PythonExtractor', 'GoExtractor', 'RustExtractor'], expectedSymbols: ['SymbolExtractor', 'TypeScriptExtractor', 'PythonExtractor'] },
    '4.1': { symbol: '', file: 'src/parsing/parser.ts', expectedAnswer: 'tests/parsing/parser.test.ts', expectedAnswerParts: ['parser.test.ts'], expectedFiles: ['src/parsing/parser.ts', 'tests/parsing/parser.test.ts'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'ScipIndexerStage\nexecute\nmain\nImportResolver\nclusterSymbols', expectedAnswerParts: ['ScipIndexerStage', 'execute', 'main', 'ImportResolver', 'clusterSymbols'], expectedSymbols: [] },
    '7.2': { symbol: 'EmbeddingProvider', file: 'src/embeddings/embedder.ts', expectedAnswer: 'main → src/cli.ts\nembedStructural → src/indexer/stages/embedding.ts\nembedDocumentation → src/indexer/stages/embedding.ts\nembedCommitMessages → src/indexer/stages/embedding.ts\ncreateLoreMcpServer → src/server/server.ts\nhandler → src/server/tools/search.ts\nsemanticLookup → src/server/tools/lookup.ts\nsemanticDocSearch → src/server/tools/docs.ts', expectedAnswerParts: ['embedStructural', 'createLoreMcpServer', 'main', 'handler'], expectedSymbols: ['EmbeddingProvider', 'embedStructural', 'createLoreMcpServer'], expectedFiles: ['src/embeddings/embedder.ts', 'src/indexer/stages/embedding.ts', 'src/server/server.ts', 'src/cli.ts'] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '3.3': { symbol: '', file: '', expectedAnswer: 'src/indexer → src/db, src/discovery, src/docs, src/embeddings, src/git, src/lsp, src/parsing, src/resolution, src/scip, src/testing\nsrc/server → src/db, src/embeddings, src/resolution\nsrc/discovery → src/docs, src/embeddings, src/indexer, src/lsp\nsrc/resolution → src/db, src/parsing\nsrc/lsp → src/parsing\nsrc/scip → src/lsp\nsrc/git → src/db\nsrc/testing → src/db\nsrc/db → (none)\nsrc/parsing → (none)\nsrc/docs → (none)\nsrc/embeddings → (none)', expectedAnswerParts: ['src/indexer', 'src/server', 'src/resolution', 'src/db', 'src/discovery', 'src/lsp', 'src/scip', 'src/testing'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'src/db/read-only.ts', expectedAnswer: '1. getFileByPath — 3 files: src/server/tools/lookup.ts, src/server/tools/snippet.ts, src/server/tools/blame.ts\n2. getLatestCoverageTotals — 2 files: src/server/tools/metrics.ts, src/server/tools/coverage.ts\n3. openReadOnly — 2 files: src/server/server.ts, src/cli.ts', expectedAnswerParts: ['getFileByPath', 'getLatestCoverageTotals', 'openReadOnly'], expectedSymbols: ['getFileByPath', 'getLatestCoverageTotals', 'openReadOnly'], expectedFiles: ['src/db/read-only.ts', 'src/server/tools/lookup.ts', 'src/server/tools/blame.ts'] },
    '11.4': { symbol: '', file: 'src/discovery/walker.ts', expectedAnswer: 'walkFiles → src/indexer/stages/source-index.ts, src/discovery/poller.ts, src/cli.ts\nwalkDocumentationFiles → src/indexer/stages/docs-index.ts\ndetectLanguageForPath → src/indexer/stages/source-index.ts\nWalkerConfig → src/indexer/index.ts, src/indexer/pipeline.ts, src/runtime.ts, src/discovery/poller.ts, src/discovery/watcher.ts', expectedAnswerParts: ['walkFiles', 'walkDocumentationFiles', 'detectLanguageForPath', 'WalkerConfig', 'source-index.ts', 'docs-index.ts'], expectedSymbols: ['walkFiles', 'WalkerConfig', 'detectLanguageForPath'], expectedFiles: ['src/discovery/walker.ts'] },
    '1.6': { symbol: '', file: 'src/logger.ts', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [], expectedFiles: ['src/logger.ts'] },
    '5.1': { symbol: 'buildControlStrategy', file: 'tests/benchmark/util/strategies.ts', expectedAnswer: 'buildLoreStrategy\nbuildDynamicLoreStrategy', expectedAnswerParts: ['buildLoreStrategy', 'buildDynamicLoreStrategy'], expectedSymbols: ['buildControlStrategy', 'buildLoreStrategy'] },
    '3.5': { symbol: '', file: '', expectedAnswer: 'tree-sitter → src/parsing\nbetter-sqlite3 → src/db\nsqlite-vec → src/db', expectedAnswerParts: ['tree-sitter', 'src/parsing', 'better-sqlite3', 'src/db'], expectedSymbols: [] },
    '9.1': { symbol: '', file: '', expectedAnswer: 'Added: None\nRemoved: None\nChanged: None', expectedAnswerParts: ['Added', 'Removed', 'Changed'], expectedSymbols: [] },
    '12.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
  },
};

// Gson ground truth — placeholder: requires indexing and Lore verification before answers are filled.
const GSON_ANSWERS: RepoAnswers = {
  repoName: 'gson',
  languageLabel: 'Java',
  sourceRoot: 'gson/src/main/java/',
  questions: {
  },
};

const ZOD_ANSWERS: RepoAnswers = {
  repoName: 'zod',
  languageLabel: 'TypeScript',
  sourceRoot: 'packages/zod/src/',
  questions: {
    '1.1': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse', expectedAnswerParts: ['parse'], expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.2': { symbol: 'parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: '_parse\n_zod_output\naddIssueToContext', expectedAnswerParts: ['_parse'], expectedSymbols: ['parse', '_parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.4': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'core.ts\nparse.ts\nschemas.ts\napi.ts', expectedAnswerParts: ['core.ts', 'parse.ts', 'schemas.ts'], expectedSymbols: ['_parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '2.1': { symbol: '$ZodType', file: 'packages/zod/src/v4/core/schemas.ts', expectedAnswer: '$ZodString\n$ZodNumber\n$ZodBoolean\n$ZodArray\n$ZodObject\n$ZodUnion\n$ZodOptional\n$ZodNullable', expectedAnswerParts: ['$ZodString', '$ZodNumber', '$ZodArray', '$ZodObject'], expectedSymbols: ['$ZodType', '$ZodString', '$ZodObject'] },
    '4.1': { symbol: '', file: 'packages/zod/src/v4/core/core.ts', expectedAnswer: 'packages/zod/src/v4/core/tests/index.test.ts', expectedAnswerParts: ['test', 'index.test.ts'], expectedFiles: ['packages/zod/src/v4/core/core.ts'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'complexity', expectedAnswerParts: ['complexity'], expectedSymbols: [] },
    '7.2': { symbol: '$ZodType', file: 'packages/zod/src/v4/core/schemas.ts', expectedAnswer: '$ZodString → packages/zod/src/v4/core/schemas.ts\n$ZodNumber → packages/zod/src/v4/core/schemas.ts\n$ZodObject → packages/zod/src/v4/core/schemas.ts', expectedAnswerParts: ['$ZodString', '$ZodNumber', '$ZodObject', 'schemas.ts'], expectedSymbols: ['$ZodType', '$ZodString'], expectedFiles: ['packages/zod/src/v4/core/schemas.ts'] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '3.3': { symbol: '', file: '', expectedAnswer: 'packages/zod/src/v4/core → (internal)\npackages/zod/src/v4/classic → packages/zod/src/v4/core\npackages/zod/src/v4/mini → packages/zod/src/v4/core\npackages/zod/src/v3 → (standalone)', expectedAnswerParts: ['v4/core', 'v4/classic', 'v4/mini', 'v3'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'packages/zod/src/v4/core/schemas.ts', expectedAnswer: '1. $ZodType — files: packages/zod/src/v4/core/schemas.ts, packages/zod/src/v4/core/api.ts', expectedAnswerParts: ['$ZodType', 'schemas.ts'], expectedSymbols: ['$ZodType'], expectedFiles: ['packages/zod/src/v4/core/schemas.ts'] },
    '11.4': { symbol: '', file: 'packages/zod/src/v4/core/schemas.ts', expectedAnswer: '$ZodString → packages/zod/src/v4/core/core.ts, packages/zod/src/v4/core/api.ts\n$ZodNumber → packages/zod/src/v4/core/core.ts, packages/zod/src/v4/core/api.ts\n$ZodObject → packages/zod/src/v4/core/core.ts, packages/zod/src/v4/core/api.ts\n$ZodArray → packages/zod/src/v4/core/core.ts, packages/zod/src/v4/core/api.ts', expectedAnswerParts: ['$ZodString', '$ZodObject', 'packages/zod/src/v4/core/core.ts', 'packages/zod/src/v4/core/api.ts'], expectedSymbols: ['$ZodString', '$ZodObject'], expectedFiles: ['packages/zod/src/v4/core/schemas.ts'] },
  },
};

const FASTAPI_ANSWERS: RepoAnswers = {
  repoName: 'fastapi',
  languageLabel: 'Python',
  sourceRoot: 'fastapi/',
  questions: {
    '1.1': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'get_request_handler\nsolve_dependencies', expectedAnswerParts: ['get_request_handler', 'solve_dependencies'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '1.2': { symbol: 'add_api_route', file: 'fastapi/routing.py', expectedAnswer: 'get_request_handler\nAPIRoute\ngenerate_unique_id', expectedAnswerParts: ['get_request_handler', 'APIRoute'], expectedSymbols: ['add_api_route'], expectedFiles: ['fastapi/routing.py'] },
    '1.4': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'dependencies/utils.py\nrouting.py\napplications.py', expectedAnswerParts: ['routing.py', 'applications.py', 'solve_dependencies'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '2.1': { symbol: 'APIRouter', file: 'fastapi/routing.py', expectedAnswer: 'FastAPI', expectedAnswerParts: ['FastAPI'], expectedSymbols: ['APIRouter', 'FastAPI'] },
    '4.1': { symbol: '', file: 'fastapi/routing.py', expectedAnswer: 'tests/test_router.py', expectedAnswerParts: ['test', 'router'], expectedFiles: ['fastapi/routing.py'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'complexity', expectedAnswerParts: ['complexity'], expectedSymbols: [] },
    '7.2': { symbol: 'Depends', file: 'fastapi/params.py', expectedAnswer: 'solve_dependencies → fastapi/dependencies/utils.py\nget_dependant → fastapi/dependencies/utils.py', expectedAnswerParts: ['solve_dependencies', 'get_dependant', 'dependencies/utils.py'], expectedSymbols: ['Depends', 'solve_dependencies'], expectedFiles: ['fastapi/params.py', 'fastapi/dependencies/utils.py'] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '3.3': { symbol: '', file: '', expectedAnswer: 'fastapi/applications → fastapi/routing, fastapi/middleware, fastapi/openapi, fastapi/exceptions\nfastapi/routing → fastapi/dependencies, fastapi/openapi\nfastapi/dependencies → (none)\nfastapi/security → fastapi/dependencies', expectedAnswerParts: ['fastapi/applications', 'fastapi/routing', 'fastapi/dependencies', 'fastapi/security', 'fastapi/openapi'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'fastapi/routing.py', expectedAnswer: '1. APIRouter — files: fastapi/applications.py, fastapi/__init__.py\n2. APIRoute — files: fastapi/routing.py\n3. get_request_handler — files: fastapi/routing.py', expectedAnswerParts: ['APIRouter', 'APIRoute', 'get_request_handler'], expectedSymbols: ['APIRouter', 'APIRoute'], expectedFiles: ['fastapi/routing.py', 'fastapi/applications.py'] },
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
    '3.3': { symbol: '', file: '', expectedAnswer: 'pkg/api → (none)\npkg/cli → pkg/api', expectedAnswerParts: ['pkg/api', 'pkg/cli'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'pkg/api/api_impl.go', expectedAnswer: '1. rebuildImpl — files: pkg/api/api.go', expectedAnswerParts: ['rebuildImpl', 'pkg/api/api.go'], expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go', 'pkg/api/api.go'] },
    '11.4': { symbol: '', file: 'pkg/api/api_impl.go', expectedAnswer: 'rebuildImpl → pkg/api/api.go', expectedAnswerParts: ['rebuildImpl', 'pkg/api/api.go'], expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go'] },
  },
};

const POSTGRES_ANSWERS: RepoAnswers = {
  repoName: 'postgres',
  languageLabel: 'C',
  sourceRoot: 'src/',
  questions: {
    '1.1': { symbol: 'parse_analyze_fixedparams', file: 'src/backend/parser/analyze.c', expectedAnswer: 'pg_analyze_and_rewrite_fixedparams', expectedAnswerParts: ['pg_analyze_and_rewrite_fixedparams'], expectedSymbols: ['parse_analyze_fixedparams', 'pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/parser/analyze.c', 'src/backend/tcop/postgres.c'] },
    '1.2': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'parse_analyze_fixedparams\npg_rewrite_query', expectedAnswerParts: ['parse_analyze_fixedparams', 'pg_rewrite_query'], expectedSymbols: ['pg_analyze_and_rewrite_fixedparams', 'parse_analyze_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/parser/analyze.c'] },
    '1.4': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'src/backend/tcop/postgres.c\nsrc/backend/commands/extension.c\nsrc/backend/commands/copyto.c\nsrc/backend/executor/spi.c\nsrc/backend/utils/cache/plancache.c', expectedAnswerParts: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/commands/copyto.c', 'src/backend/executor/spi.c', 'src/backend/utils/cache/plancache.c'], expectedSymbols: ['pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/commands/copyto.c', 'src/backend/executor/spi.c', 'src/backend/utils/cache/plancache.c'] },
    '1.6': { symbol: '', file: 'src/backend/parser/analyze.c', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [], expectedFiles: ['src/backend/parser/analyze.c'] },
    '2.1': { symbol: 'TupleTableSlotOps', file: 'src/include/executor/tuptable.h', expectedAnswer: 'TTSOpsVirtual\nTTSOpsHeapTuple\nTTSOpsMinimalTuple\nTTSOpsBufferHeapTuple', expectedAnswerParts: ['TTSOpsVirtual', 'TTSOpsHeapTuple', 'TTSOpsMinimalTuple', 'TTSOpsBufferHeapTuple'], expectedSymbols: ['TupleTableSlotOps', 'TTSOpsVirtual', 'TTSOpsHeapTuple'] },
    '3.5': { symbol: '', file: '', expectedAnswer: 'libxml2 → src/backend/utils/adt\nlibxslt → contrib/xml2\nuuid → contrib/uuid-ossp', expectedAnswerParts: ['libxml2', 'src/backend/utils/adt', 'libxslt', 'contrib/xml2', 'uuid', 'contrib/uuid-ossp'], expectedSymbols: [] },
    '4.1': { symbol: '', file: 'contrib/pg_stat_statements/pg_stat_statements.c', expectedAnswer: 'contrib/pg_stat_statements/sql/utility.sql\ncontrib/pg_stat_statements/sql/select.sql\ncontrib/pg_stat_statements/sql/dml.sql', expectedAnswerParts: ['contrib/pg_stat_statements/sql/utility.sql', 'contrib/pg_stat_statements/sql/select.sql', 'contrib/pg_stat_statements/sql/dml.sql'], expectedFiles: ['contrib/pg_stat_statements/pg_stat_statements.c', 'contrib/pg_stat_statements/sql/utility.sql'] },
    '5.1': { symbol: 'heap_insert', file: 'src/backend/access/heap/heapam.c', expectedAnswer: 'heap_update\nheap_delete\nheap_multi_insert\nsimple_heap_insert', expectedAnswerParts: ['heap_update', 'heap_delete', 'heap_multi_insert'], expectedSymbols: ['heap_insert', 'heap_update', 'heap_delete'] },
    '6.1': { symbol: '', file: '', expectedAnswer: 'complexity', expectedAnswerParts: ['complexity'], expectedSymbols: [] },
    '7.2': { symbol: 'Portal', file: 'src/include/utils/portal.h', expectedAnswer: 'PortalStart → src/backend/tcop/pquery.c\nPortalRun → src/backend/tcop/pquery.c\nPortalRunFetch → src/backend/tcop/pquery.c\nPerformPortalFetch → src/backend/commands/portalcmds.c\npg_cursor → src/backend/utils/mmgr/portalmem.c', expectedAnswerParts: ['PortalStart', 'PortalRun', 'PortalRunFetch', 'PerformPortalFetch', 'pg_cursor'], expectedSymbols: ['Portal', 'PortalRun', 'PortalRunFetch'], expectedFiles: ['src/include/utils/portal.h', 'src/backend/tcop/pquery.c', 'src/backend/commands/portalcmds.c'] },
    '8.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
    '9.1': { symbol: '', file: '', expectedAnswer: 'Added: None\nRemoved: None\nChanged: None', expectedAnswerParts: ['Added', 'Removed', 'Changed'], expectedSymbols: [] },
    '10.2': { symbol: '', file: 'src/backend/tcop/utility.c', expectedAnswer: '1. CreateCommandTag — 3 files: src/backend/commands/extension.c, src/backend/executor/spi.c, src/backend/tcop/postgres.c\n2. standard_ProcessUtility — 2 files: contrib/pg_stat_statements/pg_stat_statements.c, src/backend/tcop/utility.c\n3. ProcessUtility — 2 files: src/backend/commands/extension.c, src/backend/tcop/pquery.c', expectedAnswerParts: ['CreateCommandTag', 'standard_ProcessUtility', 'ProcessUtility'], expectedSymbols: ['CreateCommandTag', 'standard_ProcessUtility', 'ProcessUtility'], expectedFiles: ['src/backend/tcop/utility.c', 'src/backend/commands/extension.c', 'src/backend/tcop/pquery.c'] },
    '11.4': { symbol: '', file: 'src/backend/tcop/pquery.c', expectedAnswer: 'PortalStart → src/backend/commands/portalcmds.c, src/backend/executor/spi.c\nPortalRun → src/backend/tcop/postgres.c\nPortalRunFetch → src/backend/commands/portalcmds.c', expectedAnswerParts: ['PortalStart', 'PortalRun', 'PortalRunFetch', 'src/backend/commands/portalcmds.c', 'src/backend/tcop/postgres.c'], expectedSymbols: ['PortalStart', 'PortalRun', 'PortalRunFetch'], expectedFiles: ['src/backend/tcop/pquery.c', 'src/backend/commands/portalcmds.c', 'src/backend/executor/spi.c'] },
    '12.1': { symbol: '', file: '', expectedAnswer: 'None', expectedAnswerParts: ['none'], expectedSymbols: [] },
  },
};

// ─── Registry ───────────────────────────────────────────────────────────────

const ALL_REPO_ANSWERS: RepoAnswers[] = [
  LORE_SELF_ANSWERS,
  GSON_ANSWERS,
  ZOD_ANSWERS,
  FASTAPI_ANSWERS,
  ESBUILD_ANSWERS,
  POSTGRES_ANSWERS,
];

const REPO_ANSWERS_MAP = new Map(ALL_REPO_ANSWERS.map((r) => [r.repoName, r]));

// ─── Task generation ────────────────────────────────────────────────────────

/**
 * Build concrete `BenchmarkTask[]` for a given repo by applying the
 * universal question catalog to that repo's answer table.
 */
export function getTasksForRepo(repoName: string): BenchmarkTask[] {
  const answers = REPO_ANSWERS_MAP.get(repoName);
  if (!answers) return [];

  const tasks: BenchmarkTask[] = [];

  for (const template of QUESTION_CATALOG) {
    const params = answers.questions[template.questionId];
    if (!params) continue;

    const suffix = params.symbol || params.file.split('/').pop()?.replace(/\.[^.]+$/, '') || template.questionId;
    tasks.push({
      id: `${repoName}-${template.questionId}-${suffix}`,
      repoName,
      family: template.family,
      questionId: template.questionId,
      prompt: renderPrompt(template, params, answers),
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


