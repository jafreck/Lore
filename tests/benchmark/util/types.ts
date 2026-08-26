/**
 * @module benchmark/types
 *
 * Core type definitions for the Lore benchmark framework.
 */

// ─── Repo panel ───────────────────────────────────────────────────────────────

/** Specification for a repository used in benchmark runs. */
export interface BenchmarkPrepCommand {
  /** Executable to run inside the prepared repo. */
  command: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /** Optional environment overrides. */
  env?: Record<string, string>;
  /** Optional timeout in milliseconds. */
  timeoutMs?: number;
}

export interface RepoCoverageConfig {
  /** Commands to run before ingesting coverage artifacts. */
  commands?: BenchmarkPrepCommand[];
  /** Repo-relative path to the aggregate coverage report. */
  reportPath: string;
  /** Report format understood by Lore. */
  format: 'lcov' | 'cobertura';
  /** Optional repo-relative directory containing per-test coverage reports. */
  perTestReportsDir?: string;
  /** Optional per-test report format. Defaults to `format`. */
  perTestFormat?: 'lcov' | 'cobertura';
  /** Filename separator used when deriving test paths from per-test reports. */
  perTestSeparator?: string;
}

export interface RepoSpec {
  /** Human-readable identifier, e.g. "express" or "fastapi". */
  name: string;
  /** Git clone URL (HTTPS). */
  url: string;
  /** Exact commit SHA to pin. */
  sha: string;
  /** Primary language(s). */
  languages: string[];
  /** Estimated LOC tier. */
  size: 'small' | 'medium' | 'large' | 'very-large';
  /** Structural archetype. */
  structure: 'service' | 'web-app' | 'cli' | 'sdk' | 'monorepo';
  /** Optional benchmark-time coverage generation + ingestion settings. */
  coverage?: RepoCoverageConfig;
}

/** Runtime information about a downloaded repo. */
export interface RepoInstance {
  spec: RepoSpec;
  /** Absolute path to the local checkout. */
  localPath: string;
  /** Absolute path to the Lore DB (only present after indexing). */
  dbPath?: string;
  /** Whether the Lore index was built successfully. */
  indexed: boolean;
  /** Index build time in milliseconds. */
  indexTimeMs?: number;
  /** Indexing mode used to build the DB. */
  indexMode?: IndexMode;
}

// ─── Indexing configuration ───────────────────────────────────────────────────

/**
 * Indexing mode controls which parsing/enrichment stages run during `indexRepo`.
 *
 * Lore's pipeline runs SCIP first (primary source), then tree-sitter for
 * languages SCIP doesn't cover, then optional LSP enrichment on top.
 *
 * - `tree-sitter`:  Tree-sitter only — no SCIP, no LSP, no embeddings.
 *                   Fastest mode, suitable for quick iteration.
 * - `scip`:         SCIP (primary) + tree-sitter (fallback) — no LSP.
 *                   Standard production indexing.
 * - `full`:         SCIP + tree-sitter + LSP enrichment.
 *                   Maximum structural quality: resolved types.
 *
 * Embeddings are controlled separately via `embeddingModel`.
 * Pass a model name to enable, or omit/set to `undefined` to disable.
 */
export type IndexMode = 'tree-sitter' | 'scip' | 'full';

/** Options for `indexRepo`. */
export interface IndexOptions {
  /** Indexing mode (default: 'tree-sitter'). */
  mode?: IndexMode;
  /** Git history depth for blame/ownership (default: 100). */
  historyDepth?: number;
  /**
   * Embedding model identifier, or `undefined` to disable embeddings.
   * Examples: 'onnx-community/Qwen3-Embedding-0.6B-ONNX', 'nomic-ai/nomic-embed-text-v1.5'.
   * Default: `undefined` (no embeddings).
   */
  embeddingModel?: string;
  /** Enable LSP enrichment independently of index mode (default: only when mode='full'). */
  lsp?: boolean;
  /**
   * Directory containing pre-computed SCIP index files.
   * If set, Lore reads `<dir>/<language>.scip` instead of running indexers.
   */
  scipIndexDir?: string;
  /** Override the per-indexer SCIP timeout in ms (default: 120_000). */
  scipTimeoutMs?: number;
}

// ─── Comparison arms ──────────────────────────────────────────────────────────

/**
 * The arm under which a benchmark run executes.
 *
 * - `control`:          Standard tools only (file read, grep, directory listing).
 * - `semantic-baseline`: Control + generic embedding search over file chunks.
 * - `lore-enabled`:     Control + all Lore MCP tools.
 */
export type BenchmarkArm = 'control' | 'semantic-baseline' | 'lore-enabled';

// ─── Task types ───────────────────────────────────────────────────────────────

export type TaskFamily =
  | 'localization'
  | 'explanation'
  | 'modification'
  | 'refactoring'
  | 'testing'
  | 'history'

/** A single benchmark task (question/instruction) for an agent. */
export interface BenchmarkTask {
  /** Unique task identifier. */
  id: string;
  /** Which repo this task targets. */
  repoName: string;
  /** Task family classification. */
  family: TaskFamily;
  /** The prompt given verbatim to the agent. */
  prompt: string;
  /** Category from the benchmark-questions catalog, e.g. "1.1", "11.3". */
  questionId?: string;
  /**
   * Canonical expected answer (newline-separated lines).
   * Each line is a case-insensitive substring that must appear in the
   * agent's response. All lines are equally important.
   */
  expectedAnswer: string;
  /**
   * Optional: files that the correct answer should reference.
   */
  expectedFiles?: string[];
  /**
   * Optional: symbols that the correct answer should reference.
   */
  expectedSymbols?: string[];
  /** Time budget in seconds (default from family). */
  timeBudgetSeconds?: number;
  /** Max tool calls allowed (default from family). */
  maxToolCalls?: number;
}

// ─── Tool definitions for arms ────────────────────────────────────────────────

/** A tool made available to the agent during a benchmark run. */
export interface AgentTool {
  name: string;
  description: string;
  /** The function the agent calls. Returns a string result. */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

// ─── Agent interface ──────────────────────────────────────────────────────────

/** A single tool invocation recorded during a run. */
export interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
  timestamp: number;
}

/** The complete trace of an agent's work on a task. */
export interface AgentTrace {
  toolCalls: ToolCallRecord[];
  filesRead: string[];
  finalAnswer: string;
  totalTokensEstimate: number;
  /** Names of Lore tools that were actually called during the run. */
  loreToolsCalled: string[];
  /** Raw NDJSON output from the copilot CLI (only present for copilot runs). */
  rawOutput?: string;
  /** True if the run was terminated by the process timeout. */
  timedOut?: boolean;
}

/** Interface that agent implementations must satisfy. */
export interface BenchmarkAgent {
  /**
   * Run the agent on a single task with the given tools.
   * Returns the agent's trace including its final answer.
   */
  run(
    task: BenchmarkTask,
    tools: AgentTool[],
    repoPath: string,
  ): Promise<AgentTrace>;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

export interface RunScore {
  /** 0 = at least one coverage metric failed, 1 = all passed. */
  taskSuccess: 0 | 1;
  /**
   * Correctness score (0–1): fraction of expectedAnswer lines found in
   * the agent's response. 1 means all expected parts were present.
   */
  correctness: number;
  /** Whether the first referenced file/symbol was correct. */
  firstPassAccurate: boolean;
  /** Count of tool calls. */
  toolCallCount: number;
  /** Count of unique files read. */
  uniqueFilesRead: number;
  /** Wall-clock time in milliseconds. */
  wallTimeMs: number;
  /** Estimated token usage. */
  tokensUsed: number;
  /** Matched expected files (fraction 0–1). */
  fileCoverage: number;
  /** Matched expected symbols (fraction 0–1). */
  symbolCoverage: number;
  /** Number of Lore-specific tool calls made. */
  loreToolCallCount: number;
  /** Distinct Lore tools invoked. */
  loreToolsUsed: string[];
  /** Call count per tool name (all tools, not just Lore). */
  toolCallCounts: Record<string, number>;
}

// ─── Run result ───────────────────────────────────────────────────────────────

/** Full result of a single benchmark run. */
export interface BenchmarkRunResult {
  /** Unique run identifier. */
  runId: string;
  repoName: string;
  taskId: string;
  taskFamily: TaskFamily;
  arm: BenchmarkArm;
  seed: number;
  /** Pinned commit SHA. */
  repoSha: string;
  trace: AgentTrace;
  score: RunScore;
  startedAt: number;
  completedAt: number;
  /** Any error that occurred. */
  error?: string;
}

// ─── Suite configuration ──────────────────────────────────────────────────────

export interface BenchmarkSuiteConfig {
  /** Arms to run. */
  arms: BenchmarkArm[];
  /** Seeds for randomization. */
  seeds: number[];
  /** Maximum concurrent repo downloads. */
  downloadConcurrency: number;
  /** Directory for repo checkouts. */
  workDir: string;
  /** Directory for result output. */
  outputDir: string;
}
