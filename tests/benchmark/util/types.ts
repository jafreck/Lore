/**
 * @module benchmark/types
 *
 * Core type definitions for the Lore benchmark framework.
 */

// ─── Repo panel ───────────────────────────────────────────────────────────────

/** Specification for a repository used in benchmark runs. */
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
 * Indexing mode controls which enrichment stages run during `indexRepo`.
 *
 * Lore's pipeline runs SCIP first (primary source), then tree-sitter for
 * languages SCIP doesn't cover, then optional LSP enrichment on top.
 *
 * - `tree-sitter`:  Tree-sitter only — no SCIP, no LSP, no embeddings.
 *                   Fastest mode, suitable for quick iteration.
 * - `scip`:         SCIP (primary) + tree-sitter (fallback) — no LSP,
 *                   no embeddings. Standard production indexing.
 * - `full`:         SCIP + tree-sitter + LSP enrichment + embeddings.
 *                   Maximum quality: resolved types, semantic search.
 */
export type IndexMode = 'tree-sitter' | 'scip' | 'full';

/** Options for `indexRepo`. */
export interface IndexOptions {
  /** Indexing mode (default: 'tree-sitter'). */
  mode?: IndexMode;
  /** Git history depth for blame/ownership (default: 100). */
  historyDepth?: number;
  /** Embedding model identifier (default: Lore's default model). */
  embeddingModel?: string;
  /**
   * Directory containing pre-computed SCIP index files.
   * If set, Lore reads `<dir>/<language>.scip` instead of running indexers.
   */
  scipIndexDir?: string;
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
  | 'coverage';

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
   * Expected answer components for automatic scoring.
   * Each entry is a string that should appear in the agent's output.
   */
  expectedAnswerParts: string[];
  /**
   * The canonical correct answer for exact-match correctness scoring.
   * Prompts should instruct the agent to respond in this exact format
   * (e.g., "Answer with only the count as a single integer").
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
  /** 0 = failed, 0.5 = partial, 1 = success. */
  taskSuccess: 0 | 0.5 | 1;
  /**
   * Exact-match correctness score (0–1).
   * 1 when the agent's normalised answer matches the canonical expected answer.
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
  /** Matched expected answer parts (fraction 0–1). */
  answerCoverage: number;
  /** Matched expected files (fraction 0–1). */
  fileCoverage: number;
  /** Matched expected symbols (fraction 0–1). */
  symbolCoverage: number;
  /** Number of Lore-specific tool calls made. */
  loreToolCallCount: number;
  /** Distinct Lore tools invoked. */
  loreToolsUsed: string[];
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
