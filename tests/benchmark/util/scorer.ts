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
  ToolCallRecord,
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
  // Check the final answer, files explicitly read by the agent, AND tool
  // call results (e.g. lore_graph returns file paths in edge records without
  // the agent needing to `view` those files).
  const fileCoverage = computeCoverage(
    task.expectedFiles ?? [],
    (file) => {
      const normalizedFile = file.toLowerCase();
      return (
        trace.filesRead.some((f) => f.toLowerCase().includes(normalizedFile)) ||
        answer.includes(normalizedFile) ||
        trace.toolCalls.some((c) => c.result.toLowerCase().includes(normalizedFile))
      );
    },
  );

  // ── Symbol coverage: fraction of expected symbols mentioned ───────────
  // Check both the final answer text AND tool call results — Lore tools
  // return symbol names in structured results without the agent needing to
  // echo them back in the answer.
  const symbolCoverage = computeCoverage(
    task.expectedSymbols ?? [],
    (symbol) => {
      const normalizedSymbol = symbol.toLowerCase();
      return (
        answer.includes(normalizedSymbol) ||
        trace.toolCalls.some((c) => c.result.toLowerCase().includes(normalizedSymbol))
      );
    },
  );

  // ── Correctness: exact-match against canonical expected answer ─────────
  const correctness = computeCorrectness(task.expectedAnswer, trace.finalAnswer);

  // ── Task success: composite score ─────────────────────────────────────
  const taskSuccess = computeTaskSuccess(answerCoverage, fileCoverage, symbolCoverage);

  // ── First-pass accuracy ───────────────────────────────────────────────
  const firstPassAccurate = computeFirstPassAccuracy(task, trace);

  // ── Lore tool usage ────────────────────────────────────────────────────
  const loreToolCalls = trace.toolCalls.filter(
    (c) => c.toolName.startsWith('lore_') && c.result !== 'not available in this configuration',
  );
  const loreToolsUsed = [...new Set(loreToolCalls.map((c) => c.toolName))];

  // Per-tool call counts
  const toolCallCounts: Record<string, number> = {};
  for (const c of trace.toolCalls) {
    toolCallCounts[c.toolName] = (toolCallCounts[c.toolName] ?? 0) + 1;
  }

  return {
    taskSuccess,
    correctness,
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
    toolCallCounts,
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
 * Check whether a single expected-answer line matches the actual response.
 *
 * Lines containing " → " (arrow-delimited key → file-list) are matched
 * set-wise: the key must appear, and every expected file must appear
 * somewhere in the actual text, regardless of ordering or extra files.
 * Plain lines fall back to exact substring matching.
 *
 * Both arguments should already be lower-cased.
 */
function arrowLineMatches(line: string, actual: string): boolean {
  const arrowIdx = line.indexOf(' → ');
  if (arrowIdx === -1) {
    return actual.includes(line);
  }
  const key = line.slice(0, arrowIdx).trim();
  const expectedValues = line
    .slice(arrowIdx + 3)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

  if (!actual.includes(key)) return false;
  return expectedValues.every((v) => actual.includes(v));
}

/**
 * Compute correctness by checking how many expected-answer lines
 * appear in the agent's actual response (case-insensitive, trimmed).
 *
 * Returns a fraction 0–1.
 */
function computeCorrectness(expectedAnswer: string, actualAnswer: string): number {
  const toLines = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean);

  const expectedLines = toLines(expectedAnswer);
  if (expectedLines.length === 0) return 1;

  const actual = actualAnswer.toLowerCase();
  const matched = expectedLines.filter((line) => arrowLineMatches(line, actual)).length;
  return matched / expectedLines.length;
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
  meanCorrectness: number;
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
  /** Total call count per tool name across all runs. */
  toolCallCounts: Record<string, number>;
  // ── Standard deviations (populated when iterations > 1) ──
  stdCorrectness: number;
  stdToolCalls: number;
  stdWallTimeMs: number;
  stdTokens: number;
  stdAnswerCoverage: number;
  stdFileCoverage: number;
  stdSymbolCoverage: number;
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
      meanCorrectness: 0,
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
      toolCallCounts: {},
      stdCorrectness: 0,
      stdToolCalls: 0,
      stdWallTimeMs: 0,
      stdTokens: 0,
      stdAnswerCoverage: 0,
      stdFileCoverage: 0,
      stdSymbolCoverage: 0,
    };
  }

  const successes = scores.filter((s) => s.taskSuccess === 1).length;
  const partials = scores.filter((s) => s.taskSuccess === 0.5).length;
  const failures = scores.filter((s) => s.taskSuccess === 0).length;
  const allLoreTools = new Set<string>();
  const toolCounts: Record<string, number> = {};
  for (const s of scores) {
    for (const t of s.loreToolsUsed) allLoreTools.add(t);
    for (const [tool, count] of Object.entries(s.toolCallCounts ?? {})) {
      toolCounts[tool] = (toolCounts[tool] ?? 0) + count;
    }
  }

  return {
    arm,
    totalRuns: n,
    successRate: successes / n,
    partialRate: partials / n,
    failRate: failures / n,
    meanCorrectness: mean(scores.map((s) => s.correctness)),
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
    toolCallCounts: toolCounts,
    stdCorrectness: stddev(scores.map((s) => s.correctness)),
    stdToolCalls: stddev(scores.map((s) => s.toolCallCount)),
    stdWallTimeMs: stddev(scores.map((s) => s.wallTimeMs)),
    stdTokens: stddev(scores.map((s) => s.tokensUsed)),
    stdAnswerCoverage: stddev(scores.map((s) => s.answerCoverage)),
    stdFileCoverage: stddev(scores.map((s) => s.fileCoverage)),
    stdSymbolCoverage: stddev(scores.map((s) => s.symbolCoverage)),
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const sumSq = values.reduce((acc, v) => acc + (v - avg) ** 2, 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

/**
 * Format an aggregate report as a human-readable table row.
 */
export function formatReport(report: AggregateReport): string {
  const showStd = report.totalRuns > 1;
  const pctStd = (m: number, s: number) => showStd ? ` (σ=${(s * 100).toFixed(1)}pp)` : '';
  const numStd = (s: number, unit = '') => showStd ? ` (σ=${s.toFixed(1)}${unit})` : '';

  return [
    `Arm: ${report.arm}`,
    `  Runs: ${report.totalRuns}`,
    `  Success: ${(report.successRate * 100).toFixed(1)}%`,
    `  Partial: ${(report.partialRate * 100).toFixed(1)}%`,
    `  Failed:  ${(report.failRate * 100).toFixed(1)}%`,
    `  Correctness: ${(report.meanCorrectness * 100).toFixed(1)}%${pctStd(report.meanCorrectness, report.stdCorrectness)}`,
    `  First-pass accuracy: ${(report.firstPassAccuracyRate * 100).toFixed(1)}%`,
    `  Mean tool calls: ${report.meanToolCalls.toFixed(1)}${numStd(report.stdToolCalls)}`,
    `  Mean unique files: ${report.meanUniqueFiles.toFixed(1)}`,
    `  Mean wall time: ${(report.meanWallTimeMs / 1000).toFixed(1)}s${numStd(report.stdWallTimeMs / 1000, 's')}`,
    `  Mean tokens: ${report.meanTokens.toFixed(0)}${numStd(report.stdTokens)}`,
    `  Answer coverage: ${(report.meanAnswerCoverage * 100).toFixed(1)}%${pctStd(report.meanAnswerCoverage, report.stdAnswerCoverage)}`,
    `  File coverage: ${(report.meanFileCoverage * 100).toFixed(1)}%${pctStd(report.meanFileCoverage, report.stdFileCoverage)}`,
    `  Symbol coverage: ${(report.meanSymbolCoverage * 100).toFixed(1)}%${pctStd(report.meanSymbolCoverage, report.stdSymbolCoverage)}`,
    `  Lore tool calls: ${report.meanLoreToolCalls.toFixed(1)} (${(report.loreToolUsageRate * 100).toFixed(0)}% of runs)`,
    report.allLoreToolsUsed.length > 0 ? `  Lore tools used: ${report.allLoreToolsUsed.join(', ')}` : '',
    Object.keys(report.toolCallCounts).length > 0
      ? `  Tool call counts: ${Object.entries(report.toolCallCounts).sort(([, a], [, b]) => b - a).map(([t, c]) => `${t}×${c}`).join(', ')}`
      : '',
  ].filter(Boolean).join('\n');
}

/**
 * Welch's t-test for unequal variances.
 * Returns t-statistic, degrees of freedom, and two-tailed p-value.
 */
function welchTTest(
  mean1: number, std1: number, n1: number,
  mean2: number, std2: number, n2: number,
): { t: number; df: number; p: number } {
  const v1 = std1 ** 2 / n1;
  const v2 = std2 ** 2 / n2;
  const denom = Math.sqrt(v1 + v2);

  if (denom === 0) return { t: 0, df: Math.max(n1 + n2 - 2, 1), p: 1 };

  const t = (mean2 - mean1) / denom;

  // Welch-Satterthwaite degrees of freedom
  const df = (v1 + v2) ** 2 / ((v1 ** 2 / (n1 - 1)) + (v2 ** 2 / (n2 - 1)));

  // Approximate two-tailed p-value using the regularized incomplete beta function
  const p = tDistPValue(Math.abs(t), df);
  return { t, df, p };
}

/**
 * Approximate two-tailed p-value for a t-distribution.
 * Uses the relationship: p = I(df/(df+t²), df/2, 1/2) where I is the
 * regularized incomplete beta function, approximated via a continued-fraction
 * expansion that is accurate to ~4 decimal places for typical benchmark sizes.
 */
function tDistPValue(absT: number, df: number): number {
  const x = df / (df + absT * absT);
  return regularizedBeta(x, df / 2, 0.5);
}

/** Regularized incomplete beta function I_x(a, b) via continued-fraction. */
function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const prefix = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnBeta);

  // Use Lentz's continued fraction for I_x(a, b)
  if (x < (a + 1) / (a + b + 2)) {
    return (prefix * betaCF(x, a, b)) / a;
  }
  return 1 - (prefix * betaCF(1 - x, b, a)) / b;
}

/** Continued fraction for the incomplete beta function. */
function betaCF(x: number, a: number, b: number): number {
  const maxIter = 200;
  const eps = 1e-10;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < eps) d = eps;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < eps) d = eps;
    c = 1 + aa / c;
    if (Math.abs(c) < eps) c = eps;
    d = 1 / d;
    h *= d * c;

    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < eps) d = eps;
    c = 1 + aa / c;
    if (Math.abs(c) < eps) c = eps;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

/** Stirling/Lanczos approximation to ln(Gamma(z)). */
function lnGamma(z: number): number {
  const g = 7;
  const coeff = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  z -= 1;
  let x = coeff[0]!;
  for (let i = 1; i < g + 2; i++) {
    x += coeff[i]! / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
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

  const pctDelta = (a: number, b: number) => {
    if (a === 0) return 'N/A';
    const pct = ((b - a) / a) * 100;
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  };

  const tokenDelta = treatment.meanTokens - baseline.meanTokens;
  const wallDelta = treatment.meanWallTimeMs - baseline.meanWallTimeMs;

  const lines = [
    `Comparison: ${treatment.arm} vs ${baseline.arm}`,
    `  Success rate: ${diff(baseline.successRate, treatment.successRate)}`,
    `  Correctness: ${diff(baseline.meanCorrectness, treatment.meanCorrectness)}`,
    `  First-pass accuracy: ${diff(baseline.firstPassAccuracyRate, treatment.firstPassAccuracyRate)}`,
    `  Answer coverage: ${diff(baseline.meanAnswerCoverage, treatment.meanAnswerCoverage)}`,
    `  Tool calls: ${(treatment.meanToolCalls - baseline.meanToolCalls).toFixed(1)} (${treatment.meanToolCalls.toFixed(1)} vs ${baseline.meanToolCalls.toFixed(1)})`,
    `  Tokens: ${tokenDelta >= 0 ? '+' : ''}${tokenDelta.toFixed(0)} (${pctDelta(baseline.meanTokens, treatment.meanTokens)})`,
    `  Wall time: ${wallDelta >= 0 ? '+' : ''}${(wallDelta / 1000).toFixed(1)}s (${pctDelta(baseline.meanWallTimeMs, treatment.meanWallTimeMs)})`,
  ];

  // Welch's t-test for correctness when both arms have variance data
  if (baseline.totalRuns > 1 && treatment.totalRuns > 1) {
    const tResult = welchTTest(
      baseline.meanCorrectness, baseline.stdCorrectness, baseline.totalRuns,
      treatment.meanCorrectness, treatment.stdCorrectness, treatment.totalRuns,
    );
    lines.push('');
    lines.push(`  Statistical significance (correctness):`);
    lines.push(`    t=${tResult.t.toFixed(3)}, df=${tResult.df.toFixed(1)}, p=${tResult.p.toFixed(4)}`);
    lines.push(`    ${tResult.p < 0.05 ? '✓ Significant at p<0.05' : '✗ Not significant at p<0.05'}`);
  }

  return lines.join('\n');
}

// ─── Diagnostic helpers ─────────────────────────────────────────────────────

/** Summarise tool call frequency: { toolName: count }. */
export function toolCallFrequency(calls: ToolCallRecord[]): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const c of calls) {
    freq[c.toolName] = (freq[c.toolName] ?? 0) + 1;
  }
  return freq;
}

/** Format tool call frequency as a compact string e.g. "grep_search×3, read_file×2". */
export function formatToolFrequency(calls: ToolCallRecord[]): string {
  const freq = toolCallFrequency(calls);
  return Object.entries(freq)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `${name}×${count}`)
    .join(', ');
}

/** Identify which expected parts matched / missed in the final answer. */
export function diagnoseExpectations(
  task: BenchmarkTask,
  trace: AgentTrace,
): { matched: string[]; missed: string[]; correctnessDetail: { matched: string[]; missed: string[] } } {
  const answer = trace.finalAnswer.toLowerCase();

  const matched = task.expectedAnswerParts.filter((p) => answer.includes(p.toLowerCase()));
  const missed = task.expectedAnswerParts.filter((p) => !answer.includes(p.toLowerCase()));

  const expectedLines = task.expectedAnswer
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const correctnessMatched = expectedLines.filter((l) => arrowLineMatches(l.toLowerCase(), answer));
  const correctnessMissed = expectedLines.filter((l) => !arrowLineMatches(l.toLowerCase(), answer));

  return {
    matched,
    missed,
    correctnessDetail: { matched: correctnessMatched, missed: correctnessMissed },
  };
}

/** Truncate a string to maxLen, appending "…" if truncated. */
export function truncate(s: string, maxLen = 200): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

export interface StructuredTaskResult {
  taskId: string;
  family: string;
  iteration?: number;
  control: {
    score: RunScore;
    tools: string;
    loreToolArgs?: string;
    answer: string;
    missedParts: string[];
    missedAnswerLines: string[];
  };
  lore: {
    score: RunScore;
    tools: string;
    loreToolArgs: string;
    answer: string;
    missedParts: string[];
    missedAnswerLines: string[];
  };
  delta: {
    correctness: number;
    tokens: number;
    tokensPct: number | null;
    wallTimeMs: number;
    wallTimePct: number | null;
  };
  warnings: string[];
}

export interface StructuredBenchmarkReport {
  metadata: {
    model: string;
    repo: string;
    indexMode: string;
    embeddingModel: string;
    lsp: boolean;
    tasks: number;
    iterations: number;
    completedRuns: number;
    totalExpectedRuns: number;
    timestamp: string;
  };
  tasks: StructuredTaskResult[];
  aggregate: {
    control: AggregateReport;
    lore: AggregateReport;
    comparison: {
      successRateDelta: number;
      correctnessDelta: number;
      firstPassAccuracyDelta: number;
      answerCoverageDelta: number;
      toolCallsDelta: number;
      tokensDelta: number;
      tokensPct: number | null;
      wallTimeDelta: number;
      wallTimePct: number | null;
    };
    significance?: {
      t: number;
      df: number;
      p: number;
      significant: boolean;
    };
  };
}

export function buildStructuredTaskResult(
  task: BenchmarkTask,
  controlScore: RunScore,
  controlTrace: AgentTrace,
  loreScore: RunScore,
  loreTrace: AgentTrace,
  iteration?: number,
): StructuredTaskResult {
  const controlDiag = diagnoseExpectations(task, controlTrace);
  const loreDiag = diagnoseExpectations(task, loreTrace);

  const tokenDelta = loreScore.tokensUsed - controlScore.tokensUsed;
  const tokensPct = controlScore.tokensUsed ? (tokenDelta / controlScore.tokensUsed) * 100 : null;
  const wallDelta = loreScore.wallTimeMs - controlScore.wallTimeMs;
  const wallPct = controlScore.wallTimeMs ? (wallDelta / controlScore.wallTimeMs) * 100 : null;
  const warnings: string[] = [];
  if (loreScore.correctness < controlScore.correctness) {
    warnings.push(`lore worse on correctness — missed: [${loreDiag.correctnessDetail.missed.join(', ')}]`);
  }
  if (loreScore.tokensUsed > controlScore.tokensUsed * 1.5) {
    warnings.push('lore 50%+ more tokens');
  }
  if (loreScore.wallTimeMs > controlScore.wallTimeMs * 1.5) {
    warnings.push('lore 50%+ slower');
  }

  return {
    taskId: task.id,
    family: task.family,
    ...(iteration !== undefined ? { iteration } : {}),
    control: {
      score: controlScore,
      tools: formatToolFrequency(controlTrace.toolCalls),
      answer: truncate(controlTrace.finalAnswer.replace(/\n/g, ' '), 300),
      missedParts: controlDiag.missed,
      missedAnswerLines: controlDiag.correctnessDetail.missed,
    },
    lore: {
      score: loreScore,
      tools: formatToolFrequency(loreTrace.toolCalls),
      loreToolArgs: formatLoreToolArgs(loreTrace.toolCalls),
      answer: truncate(loreTrace.finalAnswer.replace(/\n/g, ' '), 300),
      missedParts: loreDiag.missed,
      missedAnswerLines: loreDiag.correctnessDetail.missed,
    },
    delta: {
      correctness: loreScore.correctness - controlScore.correctness,
      tokens: tokenDelta,
      tokensPct,
      wallTimeMs: wallDelta,
      wallTimePct: wallPct,
    },
    warnings,
  };
}

export function buildStructuredReport(
  metadata: StructuredBenchmarkReport['metadata'],
  taskResults: StructuredTaskResult[],
  controlReport: AggregateReport,
  loreReport: AggregateReport,
): StructuredBenchmarkReport {
  const tokenDelta = loreReport.meanTokens - controlReport.meanTokens;
  const wallDelta = loreReport.meanWallTimeMs - controlReport.meanWallTimeMs;

  const comparison: StructuredBenchmarkReport['aggregate']['comparison'] = {
    successRateDelta: loreReport.successRate - controlReport.successRate,
    correctnessDelta: loreReport.meanCorrectness - controlReport.meanCorrectness,
    firstPassAccuracyDelta: loreReport.firstPassAccuracyRate - controlReport.firstPassAccuracyRate,
    answerCoverageDelta: loreReport.meanAnswerCoverage - controlReport.meanAnswerCoverage,
    toolCallsDelta: loreReport.meanToolCalls - controlReport.meanToolCalls,
    tokensDelta: tokenDelta,
    tokensPct: controlReport.meanTokens ? (tokenDelta / controlReport.meanTokens) * 100 : null,
    wallTimeDelta: wallDelta,
    wallTimePct: controlReport.meanWallTimeMs ? (wallDelta / controlReport.meanWallTimeMs) * 100 : null,
  };

  let significance: StructuredBenchmarkReport['aggregate']['significance'];
  if (controlReport.totalRuns > 1 && loreReport.totalRuns > 1) {
    const tResult = welchTTest(
      controlReport.meanCorrectness, controlReport.stdCorrectness, controlReport.totalRuns,
      loreReport.meanCorrectness, loreReport.stdCorrectness, loreReport.totalRuns,
    );
    significance = { ...tResult, significant: tResult.p < 0.05 };
  }

  return {
    metadata,
    tasks: taskResults,
    aggregate: {
      control: controlReport,
      lore: loreReport,
      comparison,
      ...(significance ? { significance } : {}),
    },
  };
}

/**
 * Format a compact summary of Lore tool calls with their key arguments.
 * e.g. "lore_graph(kind=call, depth=1, target_id=42), lore_lookup(kind=symbol, query=openDb)"
 */
export function formatLoreToolArgs(calls: ToolCallRecord[]): string {
  const loreCalls = calls.filter(
    (c) => c.toolName.startsWith('lore_') && c.result !== 'not available in this configuration',
  );
  if (loreCalls.length === 0) return '(none)';
  return loreCalls
    .map((c) => {
      const argParts = Object.entries(c.args)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(', ');
      return `${c.toolName}(${argParts})`;
    })
    .join(', ');
}
