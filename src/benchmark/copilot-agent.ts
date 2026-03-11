/**
 * @module benchmark/copilot-agent
 *
 * Real `BenchmarkAgent` implementation that shells out to the GitHub Copilot
 * CLI (`copilot`) in non-interactive prompt mode.
 *
 * For the **lore-enabled** arm the agent is given access to Lore's MCP server.
 * For the **control** arm the Lore MCP server is not configured.
 *
 * The agent's tool calls, final answer, and token usage are parsed from the
 * NDJSON output (`--output-format json`).
 */

import { execFile } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type {
  AgentTrace,
  BenchmarkArm,
  BenchmarkTask,
  ToolCallRecord,
} from './types.js';
import { extractLoreToolsCalled } from './agent.js';

const execFileAsync = promisify(execFile);

// ─── Copilot CLI path ───────────────────────────────────────────────────────

const DEFAULT_COPILOT_PATH = 'copilot';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CopilotAgentOptions {
  /** Model to use (e.g. "gpt-5-mini", "claude-sonnet-4"). */
  model: string;
  /** Path to the copilot CLI binary. Defaults to "copilot". */
  copilotPath?: string;
  /** Maximum wall-clock timeout in milliseconds (default: 5 minutes). */
  timeoutMs?: number;
  /** Additional CLI flags passed verbatim. */
  extraFlags?: string[];
}

/** Parsed result of a single copilot CLI invocation. */
interface CopilotRunResult {
  /** Final assistant message content. */
  answer: string;
  /** Tool calls observed in the JSON stream. */
  toolCalls: ToolCallRecord[];
  /** Files read by view/read_file tool calls. */
  filesRead: string[];
  /** Session duration from the result event (ms). */
  sessionDurationMs: number;
  /** Total API duration from the result event (ms). */
  totalApiDurationMs: number;
  /** Estimated output tokens (sum across assistant.message events). */
  outputTokens: number;
}

// ─── MCP config generation ────────────────────────────────────────────────

/**
 * Build a temporary MCP config JSON file that registers the Lore MCP server
 * for a specific DB path.
 */
function writeLoreMcpConfig(dbPath: string, repoPath: string): string {
  const configPath = join(tmpdir(), `lore-mcp-${randomUUID()}.json`);
  const config = {
    servers: {
      lore: {
        type: 'stdio',
        command: 'node',
        args: [
          join(repoPath, 'dist', 'server', 'server.js'),
          '--db', dbPath,
        ],
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

// ─── NDJSON parser ──────────────────────────────────────────────────────────

function parseCopilotOutput(raw: string): CopilotRunResult {
  const lines = raw.split('\n').filter((l) => l.trim().startsWith('{'));
  const toolCalls: ToolCallRecord[] = [];
  const filesRead = new Set<string>();
  let answer = '';
  let sessionDurationMs = 0;
  let totalApiDurationMs = 0;
  let outputTokens = 0;

  // Track pending tool starts for duration computation
  const toolStarts = new Map<string, number>();

  for (const line of lines) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }

    switch (ev.type) {
      case 'tool.execution_start': {
        const d = ev.data;
        if (d?.toolCallId) {
          toolStarts.set(d.toolCallId, Date.parse(ev.timestamp) || Date.now());
        }
        break;
      }

      case 'tool.execution_complete': {
        const d = ev.data;
        if (!d) break;
        const startTs = toolStarts.get(d.toolCallId) ?? Date.now();
        const endTs = Date.parse(ev.timestamp) || Date.now();
        const resultContent = d.result?.content ?? d.result?.detailedContent ?? '';

        toolCalls.push({
          toolName: d.toolName ?? '',
          args: typeof d.arguments === 'object' ? d.arguments : {},
          result: typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent),
          durationMs: endTs - startTs,
          timestamp: endTs,
        });

        // Track file reads
        const toolName = d.toolName ?? '';
        if (toolName === 'view' || toolName === 'read_file') {
          const path = d.arguments?.path ?? d.result?.path;
          if (path) filesRead.add(String(path));
        }
        break;
      }

      case 'assistant.message': {
        const d = ev.data;
        if (d?.content) {
          // Keep the last assistant message as the final answer
          answer = d.content;
        }
        if (d?.outputTokens) {
          outputTokens += d.outputTokens;
        }
        // Also pick up tool call arguments from toolRequests in the message
        if (d?.toolRequests && Array.isArray(d.toolRequests)) {
          for (const req of d.toolRequests) {
            if (req.name) {
              toolStarts.set(req.toolCallId, Date.parse(ev.timestamp) || Date.now());
            }
          }
        }
        break;
      }

      case 'result': {
        const usage = ev.data?.usage ?? ev.usage;
        if (usage) {
          sessionDurationMs = usage.sessionDurationMs ?? 0;
          totalApiDurationMs = usage.totalApiDurationMs ?? 0;
        }
        break;
      }
    }
  }

  return {
    answer,
    toolCalls,
    filesRead: [...filesRead],
    sessionDurationMs,
    totalApiDurationMs,
    outputTokens,
  };
}

// ─── CopilotAgent ───────────────────────────────────────────────────────────

/**
 * Run the GitHub Copilot CLI as a benchmark agent for a single task.
 *
 * @param task          The benchmark task (prompt + expectations).
 * @param arm           Which arm is being run (determines tool availability).
 * @param repoPath      Absolute path to the repo checkout.
 * @param dbPath        Path to the Lore DB (only for lore-enabled / semantic-baseline).
 * @param options       Copilot CLI configuration.
 */
export async function runCopilotAgent(
  task: BenchmarkTask,
  arm: BenchmarkArm,
  repoPath: string,
  dbPath: string | undefined,
  options: CopilotAgentOptions,
): Promise<AgentTrace> {
  const copilotBin = options.copilotPath ?? DEFAULT_COPILOT_PATH;
  const timeoutMs = options.timeoutMs ?? 300_000;

  const args: string[] = [
    '-p', task.prompt,
    '--model', options.model,
    '--output-format', 'json',
    '--no-color',
    '--allow-all-tools',
    '--add-dir', repoPath,
  ];

  // For lore-enabled arm, register the Lore MCP server
  let mcpConfigPath: string | undefined;
  if (arm === 'lore-enabled' && dbPath) {
    // Find the Lore project root (where dist/ lives)
    // For self-benchmarks this is the Lore repo itself
    const loreProjectRoot = findLoreProjectRoot(repoPath);
    mcpConfigPath = writeLoreMcpConfig(dbPath, loreProjectRoot);
    args.push('--additional-mcp-config', `@${mcpConfigPath}`);
  }

  // For control arm, deny Lore tools explicitly
  if (arm === 'control') {
    args.push(
      '--deny-tool', 'lore_lookup', 'lore_search', 'lore_graph',
      'lore_graph_analysis', 'lore_docs', 'lore_routes', 'lore_notes',
      'lore_architecture', 'lore_test_map', 'lore_snippet', 'lore_blame',
      'lore_metrics', 'lore_coverage', 'lore_writeback', 'lore_history',
      'lore_annotations',
    );
  }

  if (options.extraFlags) {
    args.push(...options.extraFlags);
  }

  try {
    const { stdout, stderr } = await execFileAsync(copilotBin, args, {
      cwd: repoPath,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      env: { ...process.env, NO_COLOR: '1' },
    });

    const output = stdout + '\n' + stderr;
    const result = parseCopilotOutput(output);

    return {
      toolCalls: result.toolCalls,
      filesRead: result.filesRead,
      finalAnswer: result.answer,
      totalTokensEstimate: result.outputTokens || estimateTokensFromCalls(result.toolCalls, result.answer),
      loreToolsCalled: extractLoreToolsCalled(result.toolCalls),
    };
  } catch (e: any) {
    // If the process timed out or failed, still try to parse partial output
    const partialOutput = (e.stdout ?? '') + '\n' + (e.stderr ?? '');
    if (partialOutput.trim()) {
      const result = parseCopilotOutput(partialOutput);
      return {
        toolCalls: result.toolCalls,
        filesRead: result.filesRead,
        finalAnswer: result.answer || `Error: ${e.message}`,
        totalTokensEstimate: result.outputTokens || 0,
        loreToolsCalled: extractLoreToolsCalled(result.toolCalls),
      };
    }
    return {
      toolCalls: [],
      filesRead: [],
      finalAnswer: `Error: ${e.message}`,
      totalTokensEstimate: 0,
      loreToolsCalled: [],
    };
  } finally {
    if (mcpConfigPath && existsSync(mcpConfigPath)) {
      unlinkSync(mcpConfigPath);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function estimateTokensFromCalls(calls: ToolCallRecord[], answer: string): number {
  let totalChars = answer.length;
  for (const call of calls) {
    totalChars += JSON.stringify(call.args).length;
    totalChars += call.result.length;
  }
  return Math.ceil(totalChars / 4);
}

/**
 * Walk up from repoPath to find the Lore project root (directory containing
 * dist/server/server.js). Falls back to __dirname-based resolution.
 */
function findLoreProjectRoot(repoPath: string): string {
  // Check if the repo itself is Lore
  if (existsSync(join(repoPath, 'dist', 'server', 'server.js'))) {
    return repoPath;
  }
  // Fall back to the package's installed location
  const pkgRoot = join(import.meta.dirname, '..', '..');
  if (existsSync(join(pkgRoot, 'dist', 'server', 'server.js'))) {
    return pkgRoot;
  }
  // Last resort: assume Lore is built in the current working directory
  return process.cwd();
}
