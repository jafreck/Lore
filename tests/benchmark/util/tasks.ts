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
    '1.1': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build\nupdate\ningestSummary\ningestCoverage', expectedAnswerParts: ['build', 'update', 'ingestSummary', 'ingestCoverage'], expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/indexer/index.ts', 'src/cli.ts'] },
    '1.2': { symbol: 'build', file: 'src/indexer/index.ts', expectedAnswer: 'getLogger\nopenDb\nresolveBranch\n<constructor>\nresolutionStage\ntestMapStage\nhistoryStage\npipeline.run\nsaveLastKnownHead\ngatherDbStats', expectedAnswerParts: ['openDb', 'resolutionStage', 'pipeline.run', 'saveLastKnownHead'], expectedSymbols: ['build', 'openDb'], expectedFiles: ['src/indexer/index.ts'] },
    '1.4': { symbol: 'resolveSymbolEdges', file: 'src/resolution/call-graph.ts', expectedAnswer: 'resolutionStage\nbuild\nupdate', expectedAnswerParts: ['resolutionStage', 'build', 'update'], expectedSymbols: ['resolveSymbolEdges'], expectedFiles: ['src/resolution/call-graph.ts', 'src/indexer/index.ts'] },
    // ── New: call-graph + snippet ──
    '1.3': { symbol: 'build', file: 'src/indexer/index.ts', expectedAnswer: 'openDb\nresolveBranch\nresolutionStage\ntestMapStage\nhistoryStage\npipeline.run', expectedAnswerParts: ['openDb', 'resolveBranch', 'resolutionStage', 'pipeline.run'], expectedSymbols: ['build', 'openDb', 'resolveBranch', 'resolutionStage'], expectedFiles: ['src/indexer/index.ts'] },
    '1.5': { symbol: 'openDb', symbol2: 'resolveBranch', file: 'src/db/schema.ts', expectedAnswer: 'build\nupdate', expectedAnswerParts: ['build', 'update', 'openDb', 'resolveBranch'], expectedSymbols: ['openDb', 'resolveBranch', 'build', 'update'], expectedFiles: ['src/indexer/index.ts'] },
    '1.7': { symbol: 'build', symbol2: 'resolveSymbolEdges', file: 'src/indexer/index.ts', expectedAnswer: 'build\nresolutionStage\nresolveSymbolEdges', expectedAnswerParts: ['build', 'resolutionStage', 'resolveSymbolEdges'], expectedSymbols: ['build', 'resolutionStage', 'resolveSymbolEdges'], expectedFiles: ['src/indexer/index.ts', 'src/resolution/call-graph.ts'] },
    '1.8': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'Handle:\nNone\nPropagate:\nbuild\nupdate\ningestSummary\ningestCoverage', expectedAnswerParts: ['Propagate', 'build', 'update'], expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/indexer/index.ts'] },
    '7.2': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build → src/indexer/index.ts\nupdate → src/indexer/index.ts\ningestSummary → src/cli.ts\ningestCoverage → src/cli.ts', expectedAnswerParts: ['build', 'update', 'ingestSummary', 'src/indexer/index.ts', 'src/cli.ts'], expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/db/schema.ts', 'src/indexer/index.ts', 'src/cli.ts'] },
    '7.3': { symbol: 'resolutionStage', file: 'src/indexer/index.ts', expectedAnswer: 'resolveSymbolEdges → src/resolution/call-graph.ts', expectedAnswerParts: ['resolveSymbolEdges', 'call-graph.ts'], expectedSymbols: ['resolutionStage', 'resolveSymbolEdges'], expectedFiles: ['src/indexer/index.ts', 'src/resolution/call-graph.ts'] },
    '10.1': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build → src/indexer/index.ts\nupdate → src/indexer/index.ts\ningestSummary → src/indexer/index.ts\ningestCoverage → src/indexer/index.ts\nbaselineRebuild → src/indexer/index.ts\nmain → src/cli.ts', expectedAnswerParts: ['build', 'update', 'src/indexer/index.ts'], expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/db/schema.ts', 'src/indexer/index.ts'] },
    '10.3': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build\nupdate\ningestSummary\ningestCoverage\nsrc/indexer/index.ts\nsrc/cli.ts', expectedAnswerParts: ['build', 'update', 'ingestSummary', 'ingestCoverage', 'src/indexer/index.ts', 'src/cli.ts'], expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/db/schema.ts', 'src/indexer/index.ts', 'src/cli.ts'] },
    '11.2': { symbol: 'openDb', file: 'src/db/schema.ts', expectedAnswer: 'build → src/indexer/index.ts\nupdate → src/indexer/index.ts\ningestSummary → src/cli.ts\ningestCoverage → src/cli.ts', expectedAnswerParts: ['build', 'update', 'ingestSummary', 'ingestCoverage', 'src/indexer/index.ts', 'src/cli.ts', 'openDb'], expectedSymbols: ['openDb', 'build', 'update'], expectedFiles: ['src/db/schema.ts', 'src/indexer/index.ts', 'src/cli.ts'] },
    '11.3': { symbol: 'resolveSymbolEdges', file: 'src/resolution/call-graph.ts', expectedAnswer: 'no\nresolutionStage → src/indexer/index.ts', expectedAnswerParts: ['no', 'resolutionStage', 'src/indexer/index.ts', 'resolveSymbolEdges'], expectedSymbols: ['resolveSymbolEdges', 'resolutionStage'], expectedFiles: ['src/resolution/call-graph.ts', 'src/indexer/index.ts'] },
  },
};

const JACKSON_DATABIND_ANSWERS: RepoAnswers = {
  repoName: 'jackson-databind',
  languageLabel: 'Java',
  sourceRoot: 'src/main/java/',
  questions: {
    // ── Kept: pure call-graph ──
    '1.1': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: 'deserialize\n_deserializeEmbedded\n_deserializeFromEmptyString\nhandleUnresolvedReference\n_parseQNameObject\ngetNullValue\n_checkFromStringCoercion\n_verifyNullForPrimitive\n_reportFailedNullCoerce\n_verifyStringForScalarCoercion\n_verifyNumberForScalarCoercion', expectedAnswerParts: ['deserialize', '_checkFromStringCoercion', '_verifyNullForPrimitive', 'getNullValue'], expectedSymbols: ['reportInputMismatch'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/NumberDeserializers.java'] },
    '1.2': { symbol: 'createCollectionDeserializer', file: 'src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java', expectedAnswer: 'getContentType\ngetValueHandler\ngetConfig\ngetTypeHandler\nfindTypeDeserializer\n_findCustomCollectionDeserializer\ngetRawClass\nisInterface\nisAbstract\n_mapAbstractCollectionType\nintrospectForCreation\nfindValueInstantiator\ncanCreateUsingDefault\nfindForCollection\nhasDeserializerModifiers\nmodifyCollectionDeserializer', expectedAnswerParts: ['findTypeDeserializer', '_findCustomCollectionDeserializer', 'findValueInstantiator', 'modifyCollectionDeserializer'], expectedSymbols: ['createCollectionDeserializer'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java'] },
    '1.4': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java\nsrc/main/java/com/fasterxml/jackson/databind/deser/std/NumberDeserializers.java\nsrc/main/java/com/fasterxml/jackson/databind/deser/std/FromStringDeserializer.java\nsrc/main/java/com/fasterxml/jackson/databind/deser/std/MapDeserializer.java\nsrc/main/java/com/fasterxml/jackson/databind/deser/std/UUIDDeserializer.java\nsrc/main/java/com/fasterxml/jackson/databind/ext/CoreXMLDeserializers.java', expectedAnswerParts: ['StdDeserializer', 'NumberDeserializers', 'FromStringDeserializer', 'MapDeserializer'], expectedSymbols: ['reportInputMismatch'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
    // ── New: call-graph + snippet ──
    '1.3': { symbol: 'createCollectionDeserializer', file: 'src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java', expectedAnswer: 'getContentType\ngetValueHandler\ngetConfig\nfindTypeDeserializer\n_findCustomCollectionDeserializer\nfindValueInstantiator', expectedAnswerParts: ['getContentType', 'getConfig', 'findTypeDeserializer', '_findCustomCollectionDeserializer', 'findValueInstantiator'], expectedSymbols: ['createCollectionDeserializer', 'findTypeDeserializer', 'findValueInstantiator'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java'] },
    '1.5': { symbol: 'reportInputMismatch', symbol2: 'handleUnexpectedToken', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: '_deserializeFromEmptyString\ndeserialize', expectedAnswerParts: ['_deserializeFromEmptyString', 'deserialize', 'reportInputMismatch', 'handleUnexpectedToken'], expectedSymbols: ['reportInputMismatch', 'handleUnexpectedToken'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
    '1.7': { symbol: 'createCollectionDeserializer', symbol2: 'findValueInstantiator', file: 'src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java', expectedAnswer: 'createCollectionDeserializer\nfindValueInstantiator', expectedAnswerParts: ['createCollectionDeserializer', 'findValueInstantiator'], expectedSymbols: ['createCollectionDeserializer', 'findValueInstantiator'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java'] },
    '1.8': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: 'Handle:\nNone\nPropagate:\ndeserialize\n_checkFromStringCoercion\n_verifyNullForPrimitive\ngetNullValue\n_deserializeFromEmptyString', expectedAnswerParts: ['Propagate', 'deserialize', '_checkFromStringCoercion', '_verifyNullForPrimitive'], expectedSymbols: ['reportInputMismatch', 'deserialize'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
    '7.2': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: '_checkFromStringCoercion → StdDeserializer.java\n_verifyNullForPrimitive → StdDeserializer.java\ndeserialize → NumberDeserializers.java', expectedAnswerParts: ['_checkFromStringCoercion', '_verifyNullForPrimitive', 'deserialize', 'StdDeserializer', 'NumberDeserializers'], expectedSymbols: ['reportInputMismatch', '_checkFromStringCoercion'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/NumberDeserializers.java'] },
    '7.3': { symbol: 'createCollectionDeserializer', file: 'src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java', expectedAnswer: 'findTypeDeserializer → BasicDeserializerFactory.java\n_findCustomCollectionDeserializer → BasicDeserializerFactory.java\nfindValueInstantiator → BasicDeserializerFactory.java', expectedAnswerParts: ['findTypeDeserializer', '_findCustomCollectionDeserializer', 'findValueInstantiator', 'BasicDeserializerFactory'], expectedSymbols: ['createCollectionDeserializer', 'findTypeDeserializer', 'findValueInstantiator'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/deser/BasicDeserializerFactory.java'] },
    '10.1': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: '_checkFromStringCoercion → StdDeserializer.java\n_verifyNullForPrimitive → StdDeserializer.java\ndeserialize → NumberDeserializers.java\n_deserializeFromEmptyString → StdDeserializer.java\ngetNullValue → StdDeserializer.java', expectedAnswerParts: ['_checkFromStringCoercion', '_verifyNullForPrimitive', 'deserialize', 'StdDeserializer'], expectedSymbols: ['reportInputMismatch'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
    '10.3': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: '_checkFromStringCoercion\n_verifyNullForPrimitive\ndeserialize\nNumberDeserializers\nStdDeserializer', expectedAnswerParts: ['_checkFromStringCoercion', '_verifyNullForPrimitive', 'deserialize', 'NumberDeserializers', 'StdDeserializer'], expectedSymbols: ['reportInputMismatch'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
    '11.2': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: '_checkFromStringCoercion → StdDeserializer.java\n_verifyNullForPrimitive → StdDeserializer.java\ndeserialize → NumberDeserializers.java', expectedAnswerParts: ['_checkFromStringCoercion', '_verifyNullForPrimitive', 'deserialize', 'StdDeserializer', 'NumberDeserializers', 'reportInputMismatch'], expectedSymbols: ['reportInputMismatch'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
    '11.3': { symbol: 'reportInputMismatch', file: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', expectedAnswer: 'no\nreportInputMismatch\nStdDeserializer\nNumberDeserializers\n_checkFromStringCoercion', expectedAnswerParts: ['no', 'reportInputMismatch', 'StdDeserializer', 'NumberDeserializers', '_checkFromStringCoercion'], expectedSymbols: ['reportInputMismatch'], expectedFiles: ['src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java', 'src/main/java/com/fasterxml/jackson/databind/deser/std/StdDeserializer.java'] },
  },
};

const ZOD_ANSWERS: RepoAnswers = {
  repoName: 'zod',
  languageLabel: 'TypeScript',
  sourceRoot: 'packages/zod/src/',
  questions: {
    // ── Kept: pure call-graph ──
    '1.1': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse', expectedAnswerParts: ['parse'], expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.2': { symbol: 'parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: '_parse\n_zod_output\naddIssueToContext', expectedAnswerParts: ['_parse'], expectedSymbols: ['parse', '_parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.4': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'core.ts\nparse.ts\nschemas.ts\napi.ts', expectedAnswerParts: ['core.ts', 'parse.ts', 'schemas.ts'], expectedSymbols: ['_parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    // ── New: call-graph + snippet ──
    '1.3': { symbol: 'parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: '_parse\naddIssueToContext\nschema\nvalue\nctx', expectedAnswerParts: ['_parse', 'addIssueToContext', 'schema', 'value', 'ctx'], expectedSymbols: ['parse', '_parse', 'addIssueToContext'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.5': { symbol: '_parse', symbol2: 'addIssueToContext', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse', expectedAnswerParts: ['parse', '_parse', 'addIssueToContext'], expectedSymbols: ['_parse', 'addIssueToContext', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.7': { symbol: 'parse', symbol2: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse\n_parse', expectedAnswerParts: ['parse', '_parse'], expectedSymbols: ['parse', '_parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '1.8': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'Handle:\nparse\nPropagate:\nNone', expectedAnswerParts: ['Handle', 'parse', 'Propagate'], expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '7.2': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse → parse.ts', expectedAnswerParts: ['parse', '_parse', 'parse.ts'], expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '7.3': { symbol: 'parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: '_parse → packages/zod/src/v4/core/parse.ts', expectedAnswerParts: ['_parse', 'parse.ts'], expectedSymbols: ['parse', '_parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '10.1': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse → parse.ts', expectedAnswerParts: ['parse', '_parse', 'parse.ts'], expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '10.3': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse\n_parse\nparse.ts', expectedAnswerParts: ['parse', '_parse', 'parse.ts'], expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '11.2': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'parse → parse.ts', expectedAnswerParts: ['parse', '_parse', 'parse.ts'], expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
    '11.3': { symbol: '_parse', file: 'packages/zod/src/v4/core/parse.ts', expectedAnswer: 'no\n_parse\nparse\nrecursive', expectedAnswerParts: ['no', '_parse', 'parse', 'recursive'], expectedSymbols: ['_parse', 'parse'], expectedFiles: ['packages/zod/src/v4/core/parse.ts'] },
  },
};

const FASTAPI_ANSWERS: RepoAnswers = {
  repoName: 'fastapi',
  languageLabel: 'Python',
  sourceRoot: 'fastapi/',
  questions: {
    // ── Kept: pure call-graph ──
    '1.1': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'get_request_handler\nsolve_dependencies', expectedAnswerParts: ['get_request_handler', 'solve_dependencies'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '1.2': { symbol: 'add_api_route', file: 'fastapi/routing.py', expectedAnswer: 'get_value_or_default\nAPIRoute\ngenerate_unique_id\nroutes.append', expectedAnswerParts: ['get_value_or_default', 'APIRoute', 'generate_unique_id'], expectedSymbols: ['add_api_route'], expectedFiles: ['fastapi/routing.py'] },
    '1.4': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'dependencies/utils.py\nrouting.py\napplications.py', expectedAnswerParts: ['routing.py', 'applications.py', 'solve_dependencies'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    // ── New: call-graph + snippet ──
    '1.3': { symbol: 'add_api_route', file: 'fastapi/routing.py', expectedAnswer: 'get_value_or_default\nAPIRoute\ngenerate_unique_id\nroute_class\npath\nendpoint', expectedAnswerParts: ['get_value_or_default', 'APIRoute', 'generate_unique_id'], expectedSymbols: ['add_api_route', 'APIRoute', 'generate_unique_id'], expectedFiles: ['fastapi/routing.py'] },
    '1.5': { symbol: 'solve_dependencies', symbol2: 'get_request_handler', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'app\nsolve_dependencies\nget_request_handler', expectedAnswerParts: ['app', 'solve_dependencies', 'get_request_handler'], expectedSymbols: ['solve_dependencies', 'get_request_handler'], expectedFiles: ['fastapi/routing.py'] },
    '1.7': { symbol: 'add_api_route', symbol2: 'solve_dependencies', file: 'fastapi/routing.py', expectedAnswer: 'add_api_route\nAPIRoute\nget_route_handler\nget_request_handler\nsolve_dependencies', expectedAnswerParts: ['add_api_route', 'APIRoute', 'solve_dependencies'], expectedSymbols: ['add_api_route', 'APIRoute', 'solve_dependencies'], expectedFiles: ['fastapi/routing.py', 'fastapi/dependencies/utils.py'] },
    '1.8': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'Handle:\napp\nPropagate:\nget_request_handler', expectedAnswerParts: ['Handle', 'app', 'Propagate', 'get_request_handler'], expectedSymbols: ['solve_dependencies', 'get_request_handler'], expectedFiles: ['fastapi/routing.py'] },
    '7.2': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'app → routing.py\nget_websocket_app → routing.py', expectedAnswerParts: ['app', 'get_websocket_app', 'routing.py', 'solve_dependencies'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '7.3': { symbol: 'add_api_route', file: 'fastapi/routing.py', expectedAnswer: 'APIRoute → fastapi/routing.py\nget_value_or_default → fastapi/routing.py\ngenerate_unique_id → fastapi/utils.py', expectedAnswerParts: ['APIRoute', 'get_value_or_default', 'generate_unique_id', 'routing.py'], expectedSymbols: ['add_api_route', 'APIRoute'], expectedFiles: ['fastapi/routing.py'] },
    '10.1': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'app → routing.py\nget_websocket_app → routing.py\nsolve_dependencies → dependencies/utils.py', expectedAnswerParts: ['app', 'routing.py', 'solve_dependencies'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '10.3': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'app\nrouting.py\nget_websocket_app\nrecursive', expectedAnswerParts: ['app', 'routing.py', 'get_websocket_app', 'recursive'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '11.2': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'app → routing.py\nsolve_dependencies\ndependant', expectedAnswerParts: ['app', 'routing.py', 'solve_dependencies', 'dependant'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
    '11.3': { symbol: 'solve_dependencies', file: 'fastapi/dependencies/utils.py', expectedAnswer: 'no\nsolve_dependencies\nrouting.py\nrecursive\ndependant', expectedAnswerParts: ['no', 'solve_dependencies', 'routing.py', 'recursive'], expectedSymbols: ['solve_dependencies'], expectedFiles: ['fastapi/dependencies/utils.py', 'fastapi/routing.py'] },
  },
};

const ESBUILD_ANSWERS: RepoAnswers = {
  repoName: 'esbuild',
  languageLabel: 'Go',
  sourceRoot: 'pkg/',
  questions: {
    // ── Kept: pure call-graph ──
    '1.1': { symbol: 'Build', file: 'pkg/api/api.go', expectedAnswer: 'runImpl\nhandleBuildRequest', expectedAnswerParts: ['runImpl', 'handleBuildRequest'], expectedSymbols: ['Build'], expectedFiles: ['pkg/api/api.go', 'pkg/cli/cli_impl.go', 'cmd/esbuild/service.go'] },
    '1.2': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'buildImpl\nscanBundle\ncompileResult', expectedAnswerParts: ['buildImpl'], expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go'] },
    '1.4': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'pkg/api/api_impl.go\npkg/api/api.go\nBuild\nServe', expectedAnswerParts: ['api_impl.go', 'api.go', 'Build'], expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go', 'pkg/api/api.go'] },
    // ── New: call-graph + snippet ──
    '1.3': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'NewStderrLog\nRealFS\nScanBundle\nCompile\nLink', expectedAnswerParts: ['NewStderrLog', 'RealFS', 'ScanBundle', 'Compile', 'Link'], expectedSymbols: ['rebuildImpl'], expectedFiles: ['pkg/api/api_impl.go'] },
    '1.5': { symbol: 'Build', symbol2: 'Serve', file: 'pkg/api/api.go', expectedAnswer: 'main\nBuild\nServe', expectedAnswerParts: ['main', 'Build', 'Serve'], expectedSymbols: ['Build', 'Serve'], expectedFiles: ['pkg/api/api.go', 'cmd/esbuild/main.go'] },
    '1.7': { symbol: 'Build', symbol2: 'ScanBundle', file: 'pkg/api/api.go', expectedAnswer: 'Build\nrebuildImpl\nScanBundle', expectedAnswerParts: ['Build', 'rebuildImpl', 'ScanBundle'], expectedSymbols: ['Build', 'rebuildImpl', 'ScanBundle'], expectedFiles: ['pkg/api/api.go', 'pkg/api/api_impl.go'] },
    '1.8': { symbol: 'Build', file: 'pkg/api/api.go', expectedAnswer: 'Handle:\nmain\nPropagate:\nrebuildImpl', expectedAnswerParts: ['Handle', 'main', 'Propagate', 'rebuildImpl'], expectedSymbols: ['Build', 'rebuildImpl'], expectedFiles: ['pkg/api/api.go', 'pkg/api/api_impl.go'] },
    '7.2': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'Build → api.go\nrebuild → api_impl.go', expectedAnswerParts: ['Build', 'rebuild', 'api.go', 'api_impl.go', 'rebuildImpl'], expectedSymbols: ['rebuildImpl', 'Build'], expectedFiles: ['pkg/api/api_impl.go', 'pkg/api/api.go'] },
    '7.3': { symbol: 'Build', file: 'pkg/api/api.go', expectedAnswer: 'rebuildImpl → pkg/api/api_impl.go', expectedAnswerParts: ['rebuildImpl', 'api_impl.go'], expectedSymbols: ['Build', 'rebuildImpl'], expectedFiles: ['pkg/api/api.go', 'pkg/api/api_impl.go'] },
    '10.1': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'Build → api.go\nrebuild → api_impl.go', expectedAnswerParts: ['Build', 'rebuild', 'api.go', 'api_impl.go', 'rebuildImpl'], expectedSymbols: ['rebuildImpl', 'Build'], expectedFiles: ['pkg/api/api_impl.go', 'pkg/api/api.go'] },
    '10.3': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'Build\nrebuild\nactiveBuildOrRecentBuildOrRebuild\napi.go\napi_impl.go', expectedAnswerParts: ['Build', 'rebuild', 'activeBuildOrRecentBuildOrRebuild', 'api.go', 'api_impl.go'], expectedSymbols: ['rebuildImpl', 'Build'], expectedFiles: ['pkg/api/api_impl.go', 'pkg/api/api.go'] },
    '11.2': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'Build → api.go\nrebuild → api_impl.go', expectedAnswerParts: ['Build', 'rebuild', 'api.go', 'api_impl.go', 'rebuildImpl'], expectedSymbols: ['rebuildImpl', 'Build'], expectedFiles: ['pkg/api/api_impl.go', 'pkg/api/api.go'] },
    '11.3': { symbol: 'rebuildImpl', file: 'pkg/api/api_impl.go', expectedAnswer: 'no\nrebuildImpl\nBuild\napi.go\nrebuild\napi_impl.go', expectedAnswerParts: ['no', 'rebuildImpl', 'Build', 'api.go', 'rebuild', 'api_impl.go'], expectedSymbols: ['rebuildImpl', 'Build'], expectedFiles: ['pkg/api/api_impl.go', 'pkg/api/api.go'] },
  },
};

const POSTGRES_ANSWERS: RepoAnswers = {
  repoName: 'postgres',
  languageLabel: 'C',
  sourceRoot: 'src/',
  questions: {
    // ── Kept: pure call-graph ──
    '1.1': { symbol: 'parse_analyze_fixedparams', file: 'src/backend/parser/analyze.c', expectedAnswer: 'pg_analyze_and_rewrite_fixedparams', expectedAnswerParts: ['pg_analyze_and_rewrite_fixedparams'], expectedSymbols: ['parse_analyze_fixedparams', 'pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/parser/analyze.c', 'src/backend/tcop/postgres.c'] },
    '1.2': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'parse_analyze_fixedparams\npg_rewrite_query', expectedAnswerParts: ['parse_analyze_fixedparams', 'pg_rewrite_query'], expectedSymbols: ['pg_analyze_and_rewrite_fixedparams', 'parse_analyze_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/parser/analyze.c'] },
    '1.4': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'src/backend/tcop/postgres.c\nsrc/backend/commands/extension.c\nsrc/backend/commands/copyto.c\nsrc/backend/executor/spi.c\nsrc/backend/utils/cache/plancache.c', expectedAnswerParts: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/commands/copyto.c', 'src/backend/executor/spi.c', 'src/backend/utils/cache/plancache.c'], expectedSymbols: ['pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/commands/copyto.c', 'src/backend/executor/spi.c', 'src/backend/utils/cache/plancache.c'] },
    // ── New: call-graph + snippet ──
    '1.3': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'parse_analyze_fixedparams\npg_rewrite_query\npstate\nparseTree\nparamTypes', expectedAnswerParts: ['parse_analyze_fixedparams', 'pg_rewrite_query', 'pstate', 'parseTree', 'paramTypes'], expectedSymbols: ['pg_analyze_and_rewrite_fixedparams', 'parse_analyze_fixedparams', 'pg_rewrite_query'], expectedFiles: ['src/backend/tcop/postgres.c'] },
    '1.5': { symbol: 'parse_analyze_fixedparams', symbol2: 'pg_rewrite_query', file: 'src/backend/parser/analyze.c', expectedAnswer: 'pg_analyze_and_rewrite_fixedparams\nparse_analyze_fixedparams\npg_rewrite_query', expectedAnswerParts: ['pg_analyze_and_rewrite_fixedparams', 'parse_analyze_fixedparams', 'pg_rewrite_query'], expectedSymbols: ['parse_analyze_fixedparams', 'pg_rewrite_query', 'pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c'] },
    '1.7': { symbol: 'pg_analyze_and_rewrite_fixedparams', symbol2: 'transformStmt', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'pg_analyze_and_rewrite_fixedparams\nparse_analyze_fixedparams\ntransformStmt', expectedAnswerParts: ['pg_analyze_and_rewrite_fixedparams', 'parse_analyze_fixedparams', 'transformStmt'], expectedSymbols: ['pg_analyze_and_rewrite_fixedparams', 'parse_analyze_fixedparams', 'transformStmt'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/parser/analyze.c'] },
    '1.8': { symbol: 'parse_analyze_fixedparams', file: 'src/backend/parser/analyze.c', expectedAnswer: 'Handle:\nNone\nPropagate:\npg_analyze_and_rewrite_fixedparams\nexec_simple_query\nSPI_execute', expectedAnswerParts: ['Propagate', 'pg_analyze_and_rewrite_fixedparams', 'exec_simple_query'], expectedSymbols: ['parse_analyze_fixedparams', 'pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/parser/analyze.c'] },
    '7.2': { symbol: 'parse_analyze_fixedparams', file: 'src/backend/parser/analyze.c', expectedAnswer: 'pg_analyze_and_rewrite_fixedparams → postgres.c\nexec_simple_query → postgres.c', expectedAnswerParts: ['pg_analyze_and_rewrite_fixedparams', 'exec_simple_query', 'postgres.c', 'parse_analyze_fixedparams'], expectedSymbols: ['parse_analyze_fixedparams', 'pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/parser/analyze.c', 'src/backend/tcop/postgres.c'] },
    '7.3': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'parse_analyze_fixedparams → src/backend/parser/analyze.c\npg_rewrite_query → src/backend/rewrite/rewriteHandler.c', expectedAnswerParts: ['parse_analyze_fixedparams', 'pg_rewrite_query', 'analyze.c', 'rewriteHandler.c'], expectedSymbols: ['pg_analyze_and_rewrite_fixedparams', 'parse_analyze_fixedparams', 'pg_rewrite_query'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/parser/analyze.c'] },
    '10.1': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'exec_simple_query → postgres.c\nexecute_sql_string → extension.c\nSPI_execute → spi.c', expectedAnswerParts: ['exec_simple_query', 'execute_sql_string', 'SPI_execute', 'postgres.c', 'extension.c', 'spi.c'], expectedSymbols: ['pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/executor/spi.c'] },
    '10.3': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'exec_simple_query\nexecute_sql_string\nSPI_execute\nRevalidateCachedQuery\npostgres.c\nextension.c\nspi.c\nplancache.c', expectedAnswerParts: ['exec_simple_query', 'execute_sql_string', 'SPI_execute', 'RevalidateCachedQuery', 'postgres.c', 'extension.c', 'spi.c', 'plancache.c'], expectedSymbols: ['pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/executor/spi.c'] },
    '11.2': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'exec_simple_query → postgres.c\nexecute_sql_string → extension.c\nSPI_execute → spi.c', expectedAnswerParts: ['exec_simple_query', 'execute_sql_string', 'SPI_execute', 'postgres.c', 'extension.c', 'spi.c', 'pg_analyze_and_rewrite_fixedparams'], expectedSymbols: ['pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/executor/spi.c'] },
    '11.3': { symbol: 'pg_analyze_and_rewrite_fixedparams', file: 'src/backend/tcop/postgres.c', expectedAnswer: 'no\npg_analyze_and_rewrite_fixedparams\nexec_simple_query\npostgres.c\nextension.c\nspi.c', expectedAnswerParts: ['no', 'pg_analyze_and_rewrite_fixedparams', 'exec_simple_query', 'postgres.c', 'extension.c', 'spi.c'], expectedSymbols: ['pg_analyze_and_rewrite_fixedparams'], expectedFiles: ['src/backend/tcop/postgres.c', 'src/backend/commands/extension.c', 'src/backend/executor/spi.c'] },
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


