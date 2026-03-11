/**
 * @module benchmark/scorer
 *
 * Automatic scoring of benchmark run results.
 * Computes task success, first-pass accuracy, and coverage metrics.
 */

import type {
  AgentTrace,
  BenchmarkTask,
  RunScore,
} from './types.js';

/**
 * Score a completed agent trace against the expected answers in a task.
 */
export function scoreRun(
  task: BenchmarkTask,
  trace: AgentTrace,
  wallTimeMs: number,
): RunScore {
  const answer = trace.finalAnswer.toLowerCase();

  // ── Answer coverage: fraction of expected answer parts found ──────────
  const answerCoverage = computeCoverage(
    task.expectedAnswerParts,
    (part) => answer.includes(part.toLowerCase()),
  );

  // ── File coverage: fraction of expected files referenced ──────────────
  const fileCoverage = computeCoverage(
    task.expectedFiles ?? [],
    (file) => {
      const normalizedFile = file.toLowerCase();
      // Check both the trace's files read and the final answer
      return (
        trace.filesRead.some((f) => f.toLowerCase().includes(normalizedFile)) ||
        answer.includes(normalizedFile)
      );
    },
  );

  // ── Symbol coverage: fraction of expected symbols mentioned ───────────
  const symbolCoverage = computeCoverage(
    task.expectedSymbols ?? [],
    (symbol) => answer.includes(symbol.toLowerCase()),
  );

  // ── Task success: composite score ─────────────────────────────────────
  const taskSuccess = computeTaskSuccess(answerCoverage, fileCoverage, symbolCoverage);

  // ── First-pass accuracy ───────────────────────────────────────────────
  const firstPassAccurate = computeFirstPassAccuracy(task, trace);

  // ── Lore tool usage ────────────────────────────────────────────────────
  const loreToolCalls = trace.toolCalls.filter(
    (c) => c.toolName.startsWith('lore_') && c.result !== 'not available in this configuration',
  );
  const loreToolsUsed = [...new Set(loreToolCalls.map((c) => c.toolName))];

  return {
    taskSuccess,
    firstPassAccurate,
    toolCallCount: trace.toolCalls.length,
    uniqueFilesRead: new Set(trace.filesRead).size,
    wallTimeMs,
    tokensUsed: trace.totalTokensEstimate,
    answerCoverage,
    fileCoverage,
    symbolCoverage,
    loreToolCallCount: loreToolCalls.length,
    loreToolsUsed,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeCoverage(
  expected: string[],
  check: (item: string) => boolean,
): number {
  if (expected.length === 0) return 1; // No expectations = full coverage
  const matched = expected.filter(check).length;
  return matched / expected.length;
}

function computeTaskSuccess(
  answerCoverage: number,
  fileCoverage: number,
  symbolCoverage: number,
): 0 | 0.5 | 1 {
  // Weighted composite: answer parts matter most
  const composite = answerCoverage * 0.5 + fileCoverage * 0.25 + symbolCoverage * 0.25;

  if (composite >= 0.8) return 1;
  if (composite >= 0.4) return 0.5;
  return 0;
}

/**
 * Check if the first tool call that targeted a specific file/symbol was correct.
 */
function computeFirstPassAccuracy(
  task: BenchmarkTask,
  trace: AgentTrace,
): boolean {
  if (!task.expectedFiles?.length && !task.expectedSymbols?.length) {
    return true; // No specific file/symbol expectations
  }

  // Find first file read
  const firstFileRead = trace.toolCalls.find(
    (c) => c.toolName === 'read_file' && c.args['path'],
  );

  if (firstFileRead && task.expectedFiles?.length) {
    const readPath = String(firstFileRead.args['path']).toLowerCase();
    return task.expectedFiles.some((f) => readPath.includes(f.toLowerCase()));
  }

  // Check first lookup result
  const firstLookup = trace.toolCalls.find(
    (c) => c.toolName === 'lore_lookup' || c.toolName === 'lore_search',
  );

  if (firstLookup && task.expectedSymbols?.length) {
    const result = firstLookup.result.toLowerCase();
    return task.expectedSymbols.some((s) => result.includes(s.toLowerCase()));
  }

  return false;
}

// ─── Aggregate reporting ────────────────────────────────────────────────────

export interface AggregateReport {
  arm: string;
  totalRuns: number;
  successRate: number;
  partialRate: number;
  failRate: number;
  meanToolCalls: number;
  meanUniqueFiles: number;
  meanWallTimeMs: number;
  meanTokens: number;
  meanAnswerCoverage: number;
  meanFileCoverage: number;
  meanSymbolCoverage: number;
  firstPassAccuracyRate: number;
  /** Mean number of Lore tool calls per run. */
  meanLoreToolCalls: number;
  /** Fraction of runs that used at least one Lore tool. */
  loreToolUsageRate: number;
  /** All distinct Lore tools observed across runs. */
  allLoreToolsUsed: string[];
}

/**
 * Aggregate scores across multiple runs for a single arm.
 */
export function aggregateScores(arm: string, scores: RunScore[]): AggregateReport {
  const n = scores.length;
  if (n === 0) {
    return {
      arm,
      totalRuns: 0,
      successRate: 0,
      partialRate: 0,
      failRate: 0,
      meanToolCalls: 0,
      meanUniqueFiles: 0,
      meanWallTimeMs: 0,
      meanTokens: 0,
      meanAnswerCoverage: 0,
      meanFileCoverage: 0,
      meanSymbolCoverage: 0,
      firstPassAccuracyRate: 0,
      meanLoreToolCalls: 0,
      loreToolUsageRate: 0,
      allLoreToolsUsed: [],
    };
  }

  const successes = scores.filter((s) => s.taskSuccess === 1).length;
  const partials = scores.filter((s) => s.taskSuccess === 0.5).length;
  const failures = scores.filter((s) => s.taskSuccess === 0).length;
  const allLoreTools = new Set<string>();
  for (const s of scores) {
    for (const t of s.loreToolsUsed) allLoreTools.add(t);
  }

  return {
    arm,
    totalRuns: n,
    successRate: successes / n,
    partialRate: partials / n,
    failRate: failures / n,
    meanToolCalls: mean(scores.map((s) => s.toolCallCount)),
    meanUniqueFiles: mean(scores.map((s) => s.uniqueFilesRead)),
    meanWallTimeMs: mean(scores.map((s) => s.wallTimeMs)),
    meanTokens: mean(scores.map((s) => s.tokensUsed)),
    meanAnswerCoverage: mean(scores.map((s) => s.answerCoverage)),
    meanFileCoverage: mean(scores.map((s) => s.fileCoverage)),
    meanSymbolCoverage: mean(scores.map((s) => s.symbolCoverage)),
    firstPassAccuracyRate: scores.filter((s) => s.firstPassAccurate).length / n,
    meanLoreToolCalls: mean(scores.map((s) => s.loreToolCallCount)),
    loreToolUsageRate: scores.filter((s) => s.loreToolCallCount > 0).length / n,
    allLoreToolsUsed: [...allLoreTools],
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Format an aggregate report as a human-readable table row.
 */
export function formatReport(report: AggregateReport): string {
  return [
    `Arm: ${report.arm}`,
    `  Runs: ${report.totalRuns}`,
    `  Success: ${(report.successRate * 100).toFixed(1)}%`,
    `  Partial: ${(report.partialRate * 100).toFixed(1)}%`,
    `  Failed:  ${(report.failRate * 100).toFixed(1)}%`,
    `  First-pass accuracy: ${(report.firstPassAccuracyRate * 100).toFixed(1)}%`,
    `  Mean tool calls: ${report.meanToolCalls.toFixed(1)}`,
    `  Mean unique files: ${report.meanUniqueFiles.toFixed(1)}`,
    `  Mean wall time: ${(report.meanWallTimeMs / 1000).toFixed(1)}s`,
    `  Mean tokens: ${report.meanTokens.toFixed(0)}`,
    `  Answer coverage: ${(report.meanAnswerCoverage * 100).toFixed(1)}%`,
    `  File coverage: ${(report.meanFileCoverage * 100).toFixed(1)}%`,
    `  Symbol coverage: ${(report.meanSymbolCoverage * 100).toFixed(1)}%`,
    `  Lore tool calls: ${report.meanLoreToolCalls.toFixed(1)} (${(report.loreToolUsageRate * 100).toFixed(0)}% of runs)`,
    report.allLoreToolsUsed.length > 0 ? `  Lore tools used: ${report.allLoreToolsUsed.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Compare two aggregate reports and produce a diff summary.
 */
export function compareReports(baseline: AggregateReport, treatment: AggregateReport): string {
  const diff = (a: number, b: number) => {
    const d = b - a;
    const sign = d >= 0 ? '+' : '';
    return `${sign}${(d * 100).toFixed(1)}pp`;
  };

  return [
    `Comparison: ${treatment.arm} vs ${baseline.arm}`,
    `  Success rate: ${diff(baseline.successRate, treatment.successRate)}`,
    `  First-pass accuracy: ${diff(baseline.firstPassAccuracyRate, treatment.firstPassAccuracyRate)}`,
    `  Answer coverage: ${diff(baseline.meanAnswerCoverage, treatment.meanAnswerCoverage)}`,
    `  Tool calls: ${(treatment.meanToolCalls - baseline.meanToolCalls).toFixed(1)} (${treatment.meanToolCalls.toFixed(1)} vs ${baseline.meanToolCalls.toFixed(1)})`,
    `  Wall time: ${((treatment.meanWallTimeMs - baseline.meanWallTimeMs) / 1000).toFixed(1)}s`,
    `  Tokens: ${(treatment.meanTokens - baseline.meanTokens).toFixed(0)}`,
  ].join('\n');
}
