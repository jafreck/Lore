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
    // ── Kept: pure call-graph ──
    '1.1': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build\nupdate\ningestSummary\nmain', expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/indexer/index.ts', 'src/cli.ts'] },
    '1.2': { symbol: 'build', file: 'src/indexer/index.ts', expectedAnswer: 'getLogger\nopenDb\nresolveBranch\n<constructor>\nresolutionStage\ntestMapStage\nhistoryStage\npipeline.run\nsaveLastKnownHead\ngatherDbStats', expectedSymbols: ['build', 'openDb'], expectedFiles: ['src/indexer/index.ts'] },
    '1.4': { symbol: 'resolveSymbolEdges', file: 'src/resolution/call-graph.ts', expectedAnswer: 'resolutionStage\nbuild\nupdate', expectedSymbols: ['resolveSymbolEdges'], expectedFiles: ['src/resolution/call-graph.ts', 'src/indexer/index.ts'] },
    // ── New: call-graph + snippet ──
    '1.3': { symbol: 'build', file: 'src/indexer/index.ts', expectedAnswer: 'openDb\nresolveBranch\nresolutionStage\ntestMapStage\nhistoryStage\npipeline.run', expectedSymbols: ['build', 'openDb', 'resolveBranch', 'resolutionStage'], expectedFiles: ['src/indexer/index.ts'] },
    '1.5': { symbol: 'openDb', symbol2: 'resolveBranch', file: 'src/db/schema.ts', expectedAnswer: 'build\nupdate', expectedSymbols: ['openDb', 'resolveBranch', 'build', 'update'], expectedFiles: ['src/indexer/index.ts'] },
    '1.7': { symbol: 'build', symbol2: 'resolveSymbolEdges', file: 'src/indexer/index.ts', expectedAnswer: 'build\nresolutionStage\nresolveSymbolEdges', expectedSymbols: ['build', 'resolutionStage', 'resolveSymbolEdges'], expectedFiles: ['src/indexer/index.ts', 'src/resolution/call-graph.ts'] },
    '1.8': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'Handle:\nNone\nPropagate:\nbuild\nupdate\ningestSummary\nmain', expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/indexer/index.ts', 'src/cli.ts'] },
    '7.2': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build → src/indexer/index.ts\nupdate → src/indexer/index.ts\ningestSummary → src/indexer/index.ts → src/indexer/index.ts\nmain → src/cli.ts', expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/db/schema.ts', 'src/indexer/index.ts', 'src/cli.ts'] },
    '7.3': { symbol: 'resolutionStage', file: 'src/indexer/index.ts', expectedAnswer: 'resolveSymbolEdges → src/resolution/call-graph.ts', expectedSymbols: ['resolutionStage', 'resolveSymbolEdges'], expectedFiles: ['src/indexer/index.ts', 'src/resolution/call-graph.ts'] },
    '10.1': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build → src/indexer/index.ts\nupdate → src/indexer/index.ts\ningestSummary → src/indexer/index.ts → src/indexer/index.ts\nmain → src/cli.ts', expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/db/schema.ts', 'src/indexer/index.ts', 'src/cli.ts'] },
    '10.3': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build\nupdate\ningestSummary\nmain\nsrc/indexer/index.ts\nsrc/cli.ts', expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/db/schema.ts', 'src/indexer/index.ts', 'src/cli.ts'] },
    '11.2': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build → src/indexer/index.ts\nupdate → src/indexer/index.ts\ningestSummary → src/indexer/index.ts → src/indexer/index.ts\nmain → src/cli.ts', expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/db/schema.ts', 'src/indexer/index.ts', 'src/cli.ts'] },
    '11.3': { symbol: 'resolveSymbolEdges', file: 'src/resolution/call-graph.ts', expectedAnswer: 'no\nresolutionStage → src/indexer/index.ts', expectedSymbols: ['resolveSymbolEdges', 'resolutionStage'], expectedFiles: ['src/resolution/call-graph.ts', 'src/indexer/index.ts'] },
  },
};

const JACKSON_DATABIND_ANSWERS: RepoAnswers = {
  repoName: 'jackson-databind',
  languageLabel: 'Java',
  sourceRoot: 'src/main/java/',
  questions: {
    // ── Kept: pure call-graph ──
    '1.1': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: 'deserialize\n_deserializeEmbedded\n_deserializeFromEmptyString\nhandleUnresolvedReference\n_parseQNameObject\ngetNullValue\n_checkFromStringCoercion\n_verifyNullForPrimitive\n_reportFailedNullCoerce\n_verifyStringForScalarCoercion\n_verifyNumberForScalarCoercion', expectedSymbols: ['reportInputMismatch'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/NumberDeserializers.java'] },
    '1.2': { symbol: 'createCollectionDeserializer', file: 'src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java', expectedAnswer: 'getContentType\ngetValueHandler\ngetConfig\ngetTypeHandler\nfindTypeDeserializer\n_findCustomCollectionDeserializer\ngetRawClass\nisInterface\nisAbstract\n_mapAbstractCollectionType\nintrospectForCreation\nfindValueInstantiator\ncanCreateUsingDefault\nfindForCollection\nhasDeserializerModifiers\nmodifyCollectionDeserializer', expectedSymbols: ['createCollectionDeserializer'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java'] },
    '1.4': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java\nsrc/main/java/com/fasterxml/jackson/databind/deser/std/NumberDeserializers.java\nsrc/main/java/com/fasterxml/jackson/databind/deser/std/FromStringDeserializer.java\nsrc/main/java/com/fasterxml/jackson/databind/deser/std/MapDeserializer.java\nsrc/main/java/com/fasterxml/jackson/databind/deser/std/UUIDDeserializer.java\nsrc/main/java/com/fasterxml/jackson/databind/ext/CoreXMLDeserializers.java', expectedSymbols: ['reportInputMismatch'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
    // ── New: call-graph + snippet ──
    '1.3': { symbol: 'createCollectionDeserializer', file: 'src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java', expectedAnswer: 'getContentType\ngetValueHandler\ngetConfig\nfindTypeDeserializer\n_findCustomCollectionDeserializer\nfindValueInstantiator', expectedSymbols: ['createCollectionDeserializer', 'findTypeDeserializer', 'findValueInstantiator'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java'] },
    '1.5': { symbol: 'reportInputMismatch', symbol2: 'handleUnexpectedToken', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: 'deserialize', expectedSymbols: ['reportInputMismatch', 'handleUnexpectedToken'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
    '1.7': { symbol: 'createCollectionDeserializer', symbol2: 'findValueInstantiator', file: 'src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java', expectedAnswer: 'createCollectionDeserializer\nfindValueInstantiator', expectedSymbols: ['createCollectionDeserializer', 'findValueInstantiator'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java'] },
    '1.8': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: 'Handle:\nNone\nPropagate:\ndeserialize\n_checkFromStringCoercion\n_verifyNullForPrimitive\ngetNullValue\n_deserializeFromEmptyString', expectedSymbols: ['reportInputMismatch', 'deserialize'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
    '7.2': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: '_checkFromStringCoercion → StdDeserializer.java\n_verifyNullForPrimitive → StdDeserializer.java\ndeserialize → NumberDeserializers.java', expectedSymbols: ['reportInputMismatch', '_checkFromStringCoercion'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/NumberDeserializers.java'] },
    '7.3': { symbol: 'createCollectionDeserializer', file: 'src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java', expectedAnswer: 'findTypeDeserializer → BasicDeserializerFactory.java\n_findCustomCollectionDeserializer → BasicDeserializerFactory.java\nfindValueInstantiator → BasicDeserializerFactory.java', expectedSymbols: ['createCollectionDeserializer', 'findTypeDeserializer', 'findValueInstantiator'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java'] },
    '10.1': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: '_checkFromStringCoercion → StdDeserializer.java\n_verifyNullForPrimitive → StdDeserializer.java\ndeserialize → NumberDeserializers.java\n_deserializeFromEmptyString → StdDeserializer.java\ngetNullValue → StdDeserializer.java', expectedSymbols: ['reportInputMismatch'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
    '10.3': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: '_checkFromStringCoercion\n_verifyNullForPrimitive\ndeserialize\nNumberDeserializers\nStdDeserializer', expectedSymbols: ['reportInputMismatch'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
    '11.2': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: '_checkFromStringCoercion → StdDeserializer.java\n_verifyNullForPrimitive → StdDeserializer.java\ndeserialize → NumberDeserializers.java', expectedSymbols: ['reportInputMismatch'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
    '11.3': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: 'no\nreportInputMismatch\nStdDeserializer\nNumberDeserializers\n_checkFromStringCoercion', expectedSymbols: ['reportInputMismatch'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
  },
};

const ZOD_ANSWERS: RepoAnswers = {
  repoName: 'zod',
  languageLabel: 'TypeScript',
  sourceRoot: 'packages/zod/src/',
  questions: {
    // ── Kept: pure call-graph ──
    '1.1': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse', expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.2': { symbol: 'parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: '_parse', expectedSymbols: ['parse', '_parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.4': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse.ts', expectedSymbols: ['_parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    // ── New: call-graph + snippet ──
    '1.3': { symbol: 'parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: '_parse\nschema\nvalue\nctx', expectedSymbols: ['parse', '_parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.5': { symbol: '_parse', symbol2: 'addIssueToContext', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse', expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.7': { symbol: 'parse', symbol2: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse\n_parse', expectedSymbols: ['parse', '_parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.8': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'Handle:\nparse\nPropagate:\nNone', expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '7.2': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse → parse.ts', expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '7.3': { symbol: 'parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: '_parse → packages/zod/src/v4/core/parse.ts', expectedSymbols: ['parse', '_parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '10.1': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse → parse.ts', expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '10.3': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse\n_parse\nparse.ts', expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '11.2': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse → parse.ts', expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '11.3': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'no\n_parse\nparse\n_encode\n_decode', expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
  },
};

const FASTAPI_ANSWERS: RepoAnswers = {
  repoName: 'fastapi',
  languageLabel: 'Python',
  sourceRoot: 'fastapi/',
  questions: {
    // ── Kept: pure call-graph ──
    '1.1': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'app\nsolve_dependencies', expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '1.2': { symbol: 'add_api_route', file: 'fastapi/routing.py', expectedAnswer: 'get_value_or_default\nDefault\ngenerate_unique_id', expectedSymbols: ['add_api_route'], expectedFiles: ['fastapi/routing.py'] },
    '1.4': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'dependencies/utils.py\nrouting.py\nget_request_handler\nget_route_handler', expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    // ── New: call-graph + snippet ──
    '1.3': { symbol: 'add_api_route', file: 'fastapi/routing.py', expectedAnswer: 'get_value_or_default\ngenerate_unique_id\nDefault\npath\nendpoint', expectedSymbols: ['add_api_route', 'generate_unique_id'], expectedFiles: ['fastapi/routing.py'] },
    '1.5': { symbol: 'solve_dependencies', symbol2: 'get_request_handler', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'app\nsolve_dependencies\nget_request_handler', expectedSymbols: ['solve_dependencies', 'get_request_handler'], expectedFiles: ['fastapi/routing.py'] },
    '1.7': { symbol: 'add_api_route', symbol2: 'solve_dependencies', file: 'fastapi/routing.py', expectedAnswer: 'add_api_route\nget_route_handler\nget_request_handler\nsolve_dependencies', expectedSymbols: ['add_api_route', 'solve_dependencies'], expectedFiles: ['fastapi/routing.py', 'fastapi/dependencies/utils.py'] },
    '1.8': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'Handle:\napp\nPropagate:\nget_request_handler', expectedSymbols: ['solve_dependencies', 'get_request_handler'], expectedFiles: ['fastapi/routing.py'] },
    '7.2': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'app → routing.py', expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '7.3': { symbol: 'add_api_route', file: 'fastapi/routing.py', expectedAnswer: 'Default → fastapi/routing.py\nget_value_or_default → fastapi/routing.py\ngenerate_unique_id → fastapi/utils.py', expectedSymbols: ['add_api_route'], expectedFiles: ['fastapi/routing.py'] },
    '10.1': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'app → routing.py\nsolve_dependencies → dependencies/utils.py', expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '10.3': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'app\nrouting.py\nrecursive', expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '11.2': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'app → routing.py\nsolve_dependencies\nawait solve_dependencies', expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '11.3': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'no\nsolve_dependencies\nrouting.py\nrecursive\ndependant', expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
  },
};

const ESBUILD_ANSWERS: RepoAnswers = {
  repoName: 'esbuild',
  languageLabel: 'Go',
  sourceRoot: 'pkg/',
  questions: {
    // ── Kept: pure call-graph ──
    '1.1': { symbol: 'Build', file: 'pkg/api/api.go', expectedAnswer: 'runImpl\nhandleBuildRequest', expectedSymbols: ['Build'], expectedFiles: ['pkg/api/api.go', 'pkg/cli/cli_impl.go', 'cmd/esbuild/service.go'] },
    '1.2': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'NewStderrLog\nRealFS\nScanBundle\nCompile\nLink', expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go'] },
    '1.4': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'pkg/api/api_impl.go\npkg/api/api.go\nBuild\nServe', expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go', 'pkg/api/api.go'] },
    // ── New: call-graph + snippet ──
    '1.3': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'NewStderrLog\nRealFS\nScanBundle\nCompile\nLink', expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go'] },
    '1.5': { symbol: 'Build', symbol2: 'Serve', file: 'pkg/api/api.go', expectedAnswer: 'runImpl\nBuild\nServe', expectedSymbols: ['Build', 'Serve'], expectedFiles: ['pkg/api/api.go', 'pkg/cli/cli_impl.go'] },
    '1.7': { symbol: 'Build', symbol2: 'ScanBundle', file: 'pkg/api/api.go', expectedAnswer: 'Build\nrebuildImpl\nScanBundle', expectedSymbols: ['Build', 'rebuildImpl', 'ScanBundle'], expectedFiles: ['pkg/api/api.go', 'pkg/api/api_impl.go'] },
    '1.8': { symbol: 'Build', file: 'pkg/api/api.go', expectedAnswer: 'Handle:\nrunImpl\nPropagate:\nhandleBuildRequest', expectedSymbols: ['Build', 'runImpl'], expectedFiles: ['pkg/api/api.go', 'pkg/cli/cli_impl.go', 'cmd/esbuild/service.go'] },
    '7.2': { symbol: 'MakeLineColumnTracker', file: 'internal/logger/logger.go', expectedAnswer: 'parseFile → internal/bundler/bundler.go\nTokenize → internal/css_lexer/css_lexer.go\nParse → internal/css_parser/css_parser.go\nNewLexer → internal/js_lexer/js_lexer.go\nnewParser → internal/js_parser/js_parser.go\nParseJSON → internal/js_parser/json_parser.go\nParseSourceMap → internal/js_parser/sourcemap_parser.go\nparseImportsExportsMap → internal/resolver/package_json.go\nParseTSConfigJSON → internal/resolver/tsconfig_json.go\ncompileYarnPnPData → internal/resolver/yarnpnp.go\nparseMangleCache → pkg/cli/mangle_cache.go', expectedSymbols: ['MakeLineColumnTracker', 'parseFile', 'NewLexer', 'ParseJSON'], expectedFiles: ['internal/logger/logger.go', 'internal/bundler/bundler.go', 'internal/js_lexer/js_lexer.go', 'internal/js_parser/json_parser.go'] },
    '7.3': { symbol: 'Build', file: 'pkg/api/api.go', expectedAnswer: 'contextImpl → pkg/api/api_impl.go\nRebuild → pkg/api/api_impl.go\nDispose → pkg/api/api_impl.go', expectedSymbols: ['Build', 'contextImpl', 'Rebuild'], expectedFiles: ['pkg/api/api.go', 'pkg/api/api_impl.go'] },
    '10.1': { symbol: 'MakeLineColumnTracker', file: 'internal/logger/logger.go', expectedAnswer: '15\nparseFile → internal/bundler/bundler.go\nTokenize → internal/css_lexer/css_lexer.go\nParse → internal/css_parser/css_parser.go\nNewLexer → internal/js_lexer/js_lexer.go\nnewParser → internal/js_parser/js_parser.go\nParseJSON → internal/js_parser/json_parser.go\nParseSourceMap → internal/js_parser/sourcemap_parser.go\nparseImportsExportsMap → internal/resolver/package_json.go\nParseTSConfigJSON → internal/resolver/tsconfig_json.go\ncompileYarnPnPData → internal/resolver/yarnpnp.go\nparseMangleCache → pkg/cli/mangle_cache.go', expectedSymbols: ['MakeLineColumnTracker', 'parseFile', 'NewLexer', 'ParseJSON'], expectedFiles: ['internal/logger/logger.go', 'internal/bundler/bundler.go', 'internal/js_lexer/js_lexer.go', 'internal/js_parser/json_parser.go', 'internal/js_parser/sourcemap_parser.go'] },
    '10.3': { symbol: 'MakeLineColumnTracker', file: 'internal/logger/logger.go', expectedAnswer: 'parseFile\nNewLexer\nnewParser\nTokenize\nParse\nParseJSON\nParseTSConfigJSON\nparseImportsExportsMap\nParseSourceMap\ncompileYarnPnPData\nparseMangleCache', expectedSymbols: ['MakeLineColumnTracker', 'parseFile', 'ParseJSON'], expectedFiles: ['internal/logger/logger.go', 'internal/bundler/bundler.go', 'internal/js_parser/json_parser.go'] },
    '11.2': { symbol: 'ParseJSON', file: 'internal/js_parser/json_parser.go', expectedAnswer: 'ParseDefineExpr in internal/js_parser/js_parser.go\nParseSourceMap in internal/js_parser/sourcemap_parser.go\nanalyzeMetafileImpl in pkg/api/api_impl.go\nparseMangleCache in pkg/cli/mangle_cache.go', expectedSymbols: ['ParseJSON', 'ParseDefineExpr', 'ParseSourceMap', 'analyzeMetafileImpl', 'parseMangleCache'], expectedFiles: ['internal/js_parser/json_parser.go', 'internal/js_parser/js_parser.go', 'internal/js_parser/sourcemap_parser.go', 'pkg/api/api_impl.go', 'pkg/cli/mangle_cache.go'] },
    '11.3': { symbol: 'ParseJSON', file: 'internal/js_parser/json_parser.go', expectedAnswer: 'no\n4\nParseJSON\nParseDefineExpr\nParseSourceMap\nanalyzeMetafileImpl\nparseMangleCache\njs_parser.go\nsourcemap_parser.go\napi_impl.go\nmangle_cache.go', expectedSymbols: ['ParseJSON', 'ParseDefineExpr', 'ParseSourceMap'], expectedFiles: ['internal/js_parser/json_parser.go', 'internal/js_parser/js_parser.go', 'internal/js_parser/sourcemap_parser.go', 'pkg/api/api_impl.go', 'pkg/cli/mangle_cache.go'] },
  },
};

const POSTGRES_ANSWERS: RepoAnswers = {
  repoName: 'postgres',
  languageLabel: 'C',
  sourceRoot: 'src/',
  questions: {
    // ── Kept: pure call-graph ──
    '1.1': { symbol: 'parse_analyze_fixedparams', file: 'src/backend/parser/analyze.c', expectedAnswer: 'pg_analyze_and_rewrite_fixedparams\nDefineView', expectedSymbols: ['parse_analyze_fixedparams', 'pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/parser/analyze.c', 'src/backend/tcop/postgres.c'] },
    '1.2': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'parse_analyze_fixedparams\npg_rewrite_query', expectedSymbols: ['pg_analyze_and_rewrite_fixedparams', 'parse_analyze_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/parser/analyze.c'] },
    '1.4': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'src/backend/tcop/postgres.c\nsrc/backend/commands/extension.c\nsrc/backend/commands/copyto.c\nsrc/backend/executor/spi.c\nsrc/backend/utils/cache/plancache.c', expectedSymbols: ['pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/commands/copyto.c', 'src/backend/executor/spi.c', 'src/backend/utils/cache/plancache.c'] },
    // ── New: call-graph + snippet ──
    '1.3': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'parse_analyze_fixedparams\npg_rewrite_query\nparseTree\nparamTypes\nquery_string', expectedSymbols: ['pg_analyze_and_rewrite_fixedparams', 'parse_analyze_fixedparams', 'pg_rewrite_query'], expectedFiles: ['src/backend/tcop/postgres.c'] },
    '1.5': { symbol: 'parse_analyze_fixedparams', symbol2: 'pg_rewrite_query', file: 'src/backend/parser/analyze.c', expectedAnswer: 'pg_analyze_and_rewrite_fixedparams\nparse_analyze_fixedparams\npg_rewrite_query', expectedSymbols: ['parse_analyze_fixedparams', 'pg_rewrite_query', 'pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c'] },
    '1.7': { symbol: 'pg_analyze_and_rewrite_fixedparams', symbol2: 'transformStmt', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'pg_analyze_and_rewrite_fixedparams\nparse_analyze_fixedparams\ntransformStmt', expectedSymbols: ['pg_analyze_and_rewrite_fixedparams', 'parse_analyze_fixedparams', 'transformStmt'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/parser/analyze.c'] },
    '1.8': { symbol: 'parse_analyze_fixedparams', file: 'src/backend/parser/analyze.c', expectedAnswer: 'Handle:\nNone\nPropagate:\npg_analyze_and_rewrite_fixedparams', expectedSymbols: ['parse_analyze_fixedparams', 'pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/parser/analyze.c'] },
    '7.2': { symbol: 'parse_analyze_fixedparams', file: 'src/backend/parser/analyze.c', expectedAnswer: 'pg_analyze_and_rewrite_fixedparams → postgres.c', expectedSymbols: ['parse_analyze_fixedparams', 'pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/parser/analyze.c', 'src/backend/tcop/postgres.c'] },
    '7.3': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'parse_analyze_fixedparams → src/backend/parser/analyze.c\npg_rewrite_query → src/backend/tcop/postgres.c', expectedSymbols: ['pg_analyze_and_rewrite_fixedparams', 'parse_analyze_fixedparams', 'pg_rewrite_query'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/parser/analyze.c'] },
    '10.1': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'exec_simple_query → postgres.c\nexecute_sql_string → extension.c\nSPI_execute → spi.c', expectedSymbols: ['pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/executor/spi.c'] },
    '10.3': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'exec_simple_query\nexecute_sql_string\nSPI_execute\nRevalidateCachedQuery\npostgres.c\nextension.c\nspi.c\nplancache.c', expectedSymbols: ['pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/executor/spi.c'] },
    '11.2': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'execute_sql_string → extension.c\nSPI_execute → spi.c', expectedSymbols: ['pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/executor/spi.c'] },
    '11.3': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'no\npg_analyze_and_rewrite_fixedparams\nexec_simple_query\npostgres.c\nextension.c\nspi.c', expectedSymbols: ['pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/executor/spi.c'] },
  },
};

// ─── Registry ───────────────────────────────────────────────────────────────

const ALL_REPO_ANSWERS: RepoAnswers[] = [
  LORE_SELF_ANSWERS,
  JACKSON_DATABIND_ANSWERS,
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


