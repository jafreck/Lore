/**
 * @module benchmark/strategies
 *
 * Agent strategies for benchmark evaluation.
 *
 * Each strategy defines a repeatable sequence of tool calls that an agent
 * would use to answer a benchmark question. Two strategies are provided
 * per question type:
 *
 * 1. **Grep strategy**: uses only file read, grep, and directory listing
 *    (the control arm approach).
 * 2. **Lore strategy**: uses Lore tools to answer the same question
 *    (the lore-enabled arm approach).
 *
 * Both strategies produce comparable output so the scorer can evaluate
 * them against the same expected answer parts.
 */

import type { BenchmarkTask, ToolCallRecord } from './types.js';
import type { ScriptedAgentConfig, ScriptedStep, ProgrammaticAgentConfig } from './agent.js';

// ─── Strategy builders ──────────────────────────────────────────────────────

/**
 * Build a control-arm strategy for a task.
 * Uses grep/read_file/list_directory to approximate the answer.
 */
export function buildControlStrategy(task: BenchmarkTask): ScriptedAgentConfig {
  const steps: ScriptedStep[] = [];

  switch (task.family) {
    case 'localization':
      steps.push(...localizationGrepSteps(task));
      break;
    case 'explanation':
      steps.push(...explanationGrepSteps(task));
      break;
    case 'testing':
      steps.push(...testingGrepSteps(task));
      break;
    case 'history':
      steps.push(...historyGrepSteps(task));
      break;
    case 'coverage':
      steps.push(...coverageGrepSteps(task));
      break;
    default:
      steps.push(...genericGrepSteps(task));
      break;
  }

  return {
    steps,
    synthesizeAnswer: (results) => synthesizeFromResults(task, results),
  };
}

/**
 * Build a lore-enabled strategy for a task.
 * Uses Lore MCP tools to answer the question directly.
 */
export function buildLoreStrategy(task: BenchmarkTask): ScriptedAgentConfig {
  const steps: ScriptedStep[] = [];

  switch (task.questionId) {
    // Category 1: Call Graph
    case '1.1':
      steps.push(...callersLoreSteps(task));
      break;
    case '1.2':
      steps.push(...calleesLoreSteps(task));
      break;
    case '1.4':
      steps.push(...blastRadiusLoreSteps(task));
      break;

    // Category 3: Import Graph
    case '3.1':
      steps.push(...importGraphLoreSteps(task, 'outgoing'));
      break;
    case '3.2':
      steps.push(...importGraphLoreSteps(task, 'incoming'));
      break;

    // Category 4: Test Mapping
    case '4.1':
      steps.push(...testMapLoreSteps(task));
      break;

    // Category 6: Complexity
    case '6.1':
      steps.push(...complexityLoreSteps(task));
      break;

    // Category 7: History
    case '7.1':
      steps.push(...ownershipLoreSteps(task));
      break;

    // Category 9: Architecture
    case '9.1':
      steps.push(...architectureLoreSteps(task));
      break;
    case '9.5':
      steps.push(...metricsLoreSteps(task));
      break;

    // Category 11: Composite
    case '11.1':
      steps.push(...compositeModifyLoreSteps(task));
      break;
    case '11.4':
      steps.push(...compositeDeletionLoreSteps(task));
      break;

    default:
      steps.push(...genericLoreSteps(task));
      break;
  }

  return {
    steps,
    synthesizeAnswer: (results) => synthesizeFromResults(task, results),
  };
}

// ─── Control arm step builders ──────────────────────────────────────────────

function localizationGrepSteps(task: BenchmarkTask): ScriptedStep[] {
  // Extract symbol names from the prompt for grep patterns
  const symbols = extractSymbolsFromPrompt(task.prompt);
  const steps: ScriptedStep[] = [];

  // Start with directory listing to understand structure
  steps.push({ toolName: 'list_directory', args: { path: 'src' } });

  // Grep for each symbol
  for (const sym of symbols) {
    steps.push({
      toolName: 'grep_search',
      args: { pattern: sym, include: '*.ts' },
    });
  }

  // Read expected files if known
  for (const file of task.expectedFiles ?? []) {
    steps.push({ toolName: 'read_file', args: { path: file } });
  }

  return steps;
}

function explanationGrepSteps(task: BenchmarkTask): ScriptedStep[] {
  return [
    { toolName: 'list_directory', args: { path: 'src' } },
    { toolName: 'list_directory', args: { path: 'src/indexer' } },
    { toolName: 'list_directory', args: { path: 'src/lore-server' } },
    { toolName: 'grep_search', args: { pattern: 'export|import', include: 'src/index.ts' } },
    ...(task.expectedFiles ?? []).map((f) => ({
      toolName: 'read_file' as const,
      args: { path: f },
    })),
  ];
}

function testingGrepSteps(task: BenchmarkTask): ScriptedStep[] {
  const symbols = extractSymbolsFromPrompt(task.prompt);
  const steps: ScriptedStep[] = [
    { toolName: 'list_directory', args: { path: 'tests' } },
    { toolName: 'list_directory', args: { path: 'tests/indexer' } },
  ];

  for (const sym of symbols) {
    steps.push({
      toolName: 'grep_search',
      args: { pattern: sym, include: '*.test.ts' },
    });
  }

  return steps;
}

function historyGrepSteps(task: BenchmarkTask): ScriptedStep[] {
  // Limited: grep can't really do git history
  const files = task.expectedFiles ?? [];
  const steps: ScriptedStep[] = [];

  for (const file of files) {
    steps.push({ toolName: 'read_file', args: { path: file } });
  }

  return steps;
}

function coverageGrepSteps(task: BenchmarkTask): ScriptedStep[] {
  return [
    { toolName: 'grep_search', args: { pattern: 'function|class|export', include: '*.ts' } },
    ...(task.expectedFiles ?? []).map((f) => ({
      toolName: 'read_file' as const,
      args: { path: f },
    })),
  ];
}

function genericGrepSteps(task: BenchmarkTask): ScriptedStep[] {
  const symbols = extractSymbolsFromPrompt(task.prompt);
  return symbols.map((sym) => ({
    toolName: 'grep_search' as const,
    args: { pattern: sym, include: '*.ts' },
  }));
}

// ─── Lore arm step builders ─────────────────────────────────────────────────

function callersLoreSteps(task: BenchmarkTask): ScriptedStep[] {
  const symbols = extractSymbolsFromPrompt(task.prompt);
  const steps: ScriptedStep[] = [];

  for (const sym of symbols) {
    steps.push({
      toolName: 'lore_lookup',
      args: { kind: 'symbol', query: sym, mode: 'exact' },
    });
    steps.push({
      toolName: 'lore_graph',
      args: { symbol_id: 0, direction: 'incoming', edge_kind: 'call' },
    });
  }

  return steps;
}

function calleesLoreSteps(task: BenchmarkTask): ScriptedStep[] {
  const symbols = extractSymbolsFromPrompt(task.prompt);
  const steps: ScriptedStep[] = [];

  for (const sym of symbols) {
    steps.push({
      toolName: 'lore_lookup',
      args: { kind: 'symbol', query: sym, mode: 'exact' },
    });
    steps.push({
      toolName: 'lore_graph',
      args: { symbol_id: 0, direction: 'outgoing', edge_kind: 'call' },
    });
  }

  return steps;
}

function blastRadiusLoreSteps(task: BenchmarkTask): ScriptedStep[] {
  const symbols = extractSymbolsFromPrompt(task.prompt);
  const steps: ScriptedStep[] = [];

  for (const sym of symbols) {
    steps.push({
      toolName: 'lore_lookup',
      args: { kind: 'symbol', query: sym, mode: 'exact' },
    });
    // Get incoming callers (direct)
    steps.push({
      toolName: 'lore_graph',
      args: { symbol_id: 0, direction: 'incoming', edge_kind: 'call' },
    });
    // Second hop: callers of callers
    steps.push({
      toolName: 'lore_graph',
      args: { symbol_id: 0, direction: 'incoming', edge_kind: 'call' },
    });
  }

  return steps;
}

function importGraphLoreSteps(
  task: BenchmarkTask,
  direction: 'incoming' | 'outgoing',
): ScriptedStep[] {
  const files = extractFilesFromPrompt(task.prompt);
  const steps: ScriptedStep[] = [];

  for (const file of files) {
    steps.push({
      toolName: 'lore_lookup',
      args: { kind: 'file', query: file },
    });
    steps.push({
      toolName: 'lore_graph',
      args: { symbol_id: 0, direction, edge_kind: 'both' },
    });
  }

  return steps;
}

function testMapLoreSteps(task: BenchmarkTask): ScriptedStep[] {
  const files = extractFilesFromPrompt(task.prompt);
  return files.map((file) => ({
    toolName: 'lore_test_map' as const,
    args: { file_path: file },
  }));
}

function complexityLoreSteps(_task: BenchmarkTask): ScriptedStep[] {
  return [
    {
      toolName: 'lore_metrics',
      args: { mode: 'complexity', limit: 5 },
    },
  ];
}

function ownershipLoreSteps(task: BenchmarkTask): ScriptedStep[] {
  const files = extractFilesFromPrompt(task.prompt);
  return files.map((file) => ({
    toolName: 'lore_blame' as const,
    args: { file_path: file, mode: 'ownership' },
  }));
}

function architectureLoreSteps(_task: BenchmarkTask): ScriptedStep[] {
  return [
    { toolName: 'lore_architecture', args: {} },
  ];
}

function metricsLoreSteps(_task: BenchmarkTask): ScriptedStep[] {
  return [
    { toolName: 'lore_metrics', args: { mode: 'aggregate' } },
  ];
}

function compositeModifyLoreSteps(task: BenchmarkTask): ScriptedStep[] {
  const symbols = extractSymbolsFromPrompt(task.prompt);
  const steps: ScriptedStep[] = [];

  for (const sym of symbols) {
    // Step 1: Lookup the symbol
    steps.push({
      toolName: 'lore_lookup',
      args: { kind: 'symbol', query: sym, mode: 'exact' },
    });
    // Step 2: Find test mapping
    steps.push({
      toolName: 'lore_test_map',
      args: { file_path: '' }, // Would be filled from step 1
    });
    // Step 3: Check coverage
    steps.push({
      toolName: 'lore_coverage',
      args: { file_path: '' },
    });
    // Step 4: Check ownership
    steps.push({
      toolName: 'lore_blame',
      args: { file_path: '', mode: 'ownership' },
    });
  }

  return steps;
}

function compositeDeletionLoreSteps(task: BenchmarkTask): ScriptedStep[] {
  const files = extractFilesFromPrompt(task.prompt);
  const steps: ScriptedStep[] = [];

  for (const file of files) {
    // Check what imports this file
    steps.push({
      toolName: 'lore_lookup',
      args: { kind: 'file', query: file },
    });
    steps.push({
      toolName: 'lore_graph',
      args: { symbol_id: 0, direction: 'incoming', edge_kind: 'both' },
    });
  }

  return steps;
}

function genericLoreSteps(task: BenchmarkTask): ScriptedStep[] {
  const symbols = extractSymbolsFromPrompt(task.prompt);
  return symbols.map((sym) => ({
    toolName: 'lore_search' as const,
    args: { query: sym, mode: 'fused' },
  }));
}

// ─── Prompt parsing helpers ─────────────────────────────────────────────────

/** Extract backtick-quoted symbol names from a prompt. */
function extractSymbolsFromPrompt(prompt: string): string[] {
  const matches = prompt.match(/`([^`]+)`/g);
  if (!matches) return [];
  return matches.map((m) => m.replace(/`/g, ''));
}

/** Extract file paths (containing / or .) from backtick-quoted segments. */
function extractFilesFromPrompt(prompt: string): string[] {
  const symbols = extractSymbolsFromPrompt(prompt);
  return symbols.filter((s) => s.includes('/') || s.includes('.'));
}

// ─── Answer synthesis ───────────────────────────────────────────────────────

/**
 * Synthesize a final answer from accumulated tool call results.
 * This aggregates all non-error results into a structured response.
 */
function synthesizeFromResults(task: BenchmarkTask, results: ToolCallRecord[]): string {
  const parts: string[] = [];
  parts.push(`Question: ${task.prompt}\n`);

  for (const record of results) {
    if (record.result.startsWith('Error:') || record.result === 'not available in this configuration') {
      continue;
    }
    parts.push(`[${record.toolName}] ${truncate(record.result, 2000)}`);
  }

  if (parts.length === 1) {
    parts.push('No relevant information found.');
  }

  return parts.join('\n\n');
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '... (truncated)';
}

// ─── Dynamic Lore strategies (programmatic) ────────────────────────────────

/**
 * Extract the first symbol ID from a lore_lookup result.
 */
function extractSymbolId(result: string): number | null {
  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].id) {
      return parsed[0].id;
    }
    if (parsed?.id) return parsed.id;
    if (parsed?.results && Array.isArray(parsed.results) && parsed.results.length > 0) {
      return parsed.results[0].id;
    }
  } catch {
    // Try regex fallback for non-JSON formatted results
    const match = result.match(/"id"\s*:\s*(\d+)/);
    if (match) return parseInt(match[1]!, 10);
  }
  return null;
}

/**
 * Extract a file path from a lore_lookup file result.
 */
function extractFilePath(result: string): string | null {
  try {
    const parsed = JSON.parse(result);
    if (parsed?.path) return parsed.path;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].path) {
      return parsed[0].path;
    }
  } catch {
    const match = result.match(/"path"\s*:\s*"([^"]+)"/);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * Build a dynamic Lore strategy that chains tool calls based on results.
 * This is needed for questions where symbol_id must be resolved from a lookup.
 */
export function buildDynamicLoreStrategy(task: BenchmarkTask): ProgrammaticAgentConfig {
  const symbols = extractSymbolsFromPrompt(task.prompt);
  const files = extractFilesFromPrompt(task.prompt);

  return {
    maxSteps: 20,
    strategy: async (_task, _tools, history) => {
      // Phase 1: Lookup symbols/files
      if (history.length === 0) {
        if (symbols.length > 0) {
          return { toolName: 'lore_lookup', args: { kind: 'symbol', query: symbols[0]!, mode: 'exact' } };
        }
        if (files.length > 0) {
          return { toolName: 'lore_lookup', args: { kind: 'file', query: files[0]! } };
        }
        return { toolName: 'lore_search', args: { query: task.prompt, mode: 'fused' } };
      }

      // Phase 2: Use results from lookup to make graph/test-map/etc calls
      const lastResult = history[history.length - 1]!;

      // After lookup, pick question-specific follow-up
      if (lastResult.toolName === 'lore_lookup' || lastResult.toolName === 'lore_search') {
        const symbolId = extractSymbolId(lastResult.result);
        const filePath = extractFilePath(lastResult.result);

        switch (task.questionId) {
          case '1.1':
            if (symbolId != null) return { toolName: 'lore_graph', args: { symbol_id: symbolId, direction: 'incoming', edge_kind: 'call' } };
            break;
          case '1.2':
            if (symbolId != null) return { toolName: 'lore_graph', args: { symbol_id: symbolId, direction: 'outgoing', edge_kind: 'call' } };
            break;
          case '1.4':
            if (symbolId != null) return { toolName: 'lore_graph', args: { symbol_id: symbolId, direction: 'incoming', edge_kind: 'call' } };
            break;
          case '3.1':
          case '3.2': {
            const dir = task.questionId === '3.1' ? 'outgoing' : 'incoming';
            if (symbolId != null) return { toolName: 'lore_graph', args: { symbol_id: symbolId, direction: dir, edge_kind: 'both' } };
            break;
          }
          case '4.1':
            if (filePath) return { toolName: 'lore_test_map', args: { file_path: filePath } };
            break;
          case '6.1':
            return { toolName: 'lore_metrics', args: { mode: 'complexity', limit: 5 } };
          case '7.1':
            if (filePath) return { toolName: 'lore_blame', args: { file_path: filePath, mode: 'ownership' } };
            break;
          case '9.1':
            return { toolName: 'lore_architecture', args: {} };
          case '9.5':
            return { toolName: 'lore_metrics', args: { mode: 'aggregate' } };
          case '11.1':
            if (filePath) return { toolName: 'lore_test_map', args: { file_path: filePath } };
            if (symbolId != null) return { toolName: 'lore_graph', args: { symbol_id: symbolId, direction: 'incoming', edge_kind: 'call' } };
            break;
          case '11.4':
            if (symbolId != null) return { toolName: 'lore_graph', args: { symbol_id: symbolId, direction: 'incoming', edge_kind: 'both' } };
            break;
          default:
            break;
        }
      }

      // Phase 3: Additional chain steps for composite questions
      if (task.questionId === '11.1') {
        const testMapDone = history.some((h) => h.toolName === 'lore_test_map');
        const coverageDone = history.some((h) => h.toolName === 'lore_coverage');
        const blameDone = history.some((h) => h.toolName === 'lore_blame');

        // Get file path from any previous result
        let filePath: string | null = null;
        for (const h of history) {
          filePath = extractFilePath(h.result);
          if (filePath) break;
        }

        if (!testMapDone && filePath) {
          return { toolName: 'lore_test_map', args: { file_path: filePath } };
        }
        if (!coverageDone && filePath) {
          return { toolName: 'lore_coverage', args: { file_path: filePath } };
        }
        if (!blameDone && filePath) {
          return { toolName: 'lore_blame', args: { file_path: filePath, mode: 'ownership' } };
        }
      }

      if (task.questionId === '1.4') {
        // Multi-hop: get callers of callers
        const graphCalls = history.filter((h) => h.toolName === 'lore_graph');
        if (graphCalls.length < 2) {
          const symbolId = extractSymbolId(lastResult.result);
          if (symbolId != null) {
            return { toolName: 'lore_graph', args: { symbol_id: symbolId, direction: 'incoming', edge_kind: 'call' } };
          }
        }
      }

      // Lookup remaining symbols
      const lookedUp = new Set(
        history.filter((h) => h.toolName === 'lore_lookup').map((h) => String(h.args['query'])),
      );
      for (const sym of symbols) {
        if (!lookedUp.has(sym)) {
          return { toolName: 'lore_lookup', args: { kind: 'symbol', query: sym, mode: 'exact' } };
        }
      }

      return null; // Done
    },
    synthesizeAnswer: (_task, results) => synthesizeFromResults(task, results),
  };
}
