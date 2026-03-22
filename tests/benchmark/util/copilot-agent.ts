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
  /** Whether the Lore MCP server successfully initialized (tools were listed). */
  loreMcpHealthy: boolean;
  /** Any MCP server error messages observed in the stream. */
  mcpErrors: string[];
}

// ─── MCP config generation ────────────────────────────────────────────────

/**
 * Build a temporary MCP config JSON file that registers the Lore MCP server
 * for a specific DB path.
 */
function writeLoreMcpConfig(dbPath: string, repoPath: string): string {
  const configPath = join(tmpdir(), `lore-mcp-${randomUUID()}.json`);
  const config = {
    mcpServers: {
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
  let loreMcpHealthy = false;
  const mcpErrors: string[] = [];

  // Track pending tool starts: toolCallId → { timestamp, toolName, args }
  const toolStarts = new Map<string, { ts: number; toolName: string; args: Record<string, unknown> }>();

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
          // Prefer mcpToolName (e.g. "lore_search") over the prefixed toolName (e.g. "lore-lore_search")
          const name = d.mcpToolName ?? d.toolName ?? '';
          toolStarts.set(d.toolCallId, {
            ts: Date.parse(ev.timestamp) || Date.now(),
            toolName: name,
            args: typeof d.arguments === 'object' ? d.arguments : {},
          });
        }
        break;
      }

      case 'tool.execution_complete': {
        const d = ev.data;
        if (!d) break;
        const start = toolStarts.get(d.toolCallId);
        const startTs = start?.ts ?? Date.now();
        const endTs = Date.parse(ev.timestamp) || Date.now();
        const resultContent = d.result?.content ?? d.result?.detailedContent ?? '';
        const toolName = start?.toolName ?? d.toolName ?? '';
        const args = start?.args ?? (typeof d.arguments === 'object' ? d.arguments : {});

        toolCalls.push({
          toolName,
          args,
          result: typeof resultContent === 'string' ? resultContent : JSON.stringify(resultContent),
          durationMs: endTs - startTs,
          timestamp: endTs,
        });

        // Track file reads
        if (toolName === 'view' || toolName === 'read_file') {
          const path = args?.path ?? d.result?.path;
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
              toolStarts.set(req.toolCallId, {
                ts: Date.parse(ev.timestamp) || Date.now(),
                toolName: req.name,
                args: typeof req.arguments === 'object' ? req.arguments : {},
              });
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

      default: {
        // Detect MCP server health signals
        const evType = ev.type ?? '';
        const evData = ev.data ?? {};

        // Copilot CLI emits tool listings; if any lore_* tool appears, the server is alive
        if (evType === 'tools.list' || evType === 'mcp.tools_listed') {
          const tools = evData.tools ?? evData.toolNames ?? [];
          if (Array.isArray(tools) && tools.some((t: any) => {
            const name = typeof t === 'string' ? t : t?.name ?? '';
            return name.startsWith('lore_') || name.includes('lore-');
          })) {
            loreMcpHealthy = true;
          }
        }

        // Detect lore tool calls as proof the MCP server is working
        if (evType === 'tool.execution_start' || evType === 'tool.execution_complete') {
          const toolName = evData.mcpToolName ?? evData.toolName ?? '';
          if (typeof toolName === 'string' && (toolName.startsWith('lore_') || toolName.includes('lore-'))) {
            loreMcpHealthy = true;
          }
        }

        // Capture MCP server errors
        if (evType.includes('mcp') && evType.includes('error')) {
          mcpErrors.push(JSON.stringify(evData));
        }
        if (evType === 'error' && typeof evData.message === 'string' && evData.message.toLowerCase().includes('mcp')) {
          mcpErrors.push(evData.message);
        }
        break;
      }
    }
  }

  // Also check tool calls we already parsed — if any lore tool was called, server is healthy
  if (!loreMcpHealthy && toolCalls.some(tc => tc.toolName.startsWith('lore_') || tc.toolName.includes('lore-'))) {
    loreMcpHealthy = true;
  }

  return {
    answer,
    toolCalls,
    filesRead: [...filesRead],
    sessionDurationMs,
    totalApiDurationMs,
    outputTokens,
    loreMcpHealthy,
    mcpErrors,
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
    // Always use the current Lore build, not the cloned repo's (which may
    // be at an older SHA without recent fixes like the realpathSync guard).
    const loreProjectRoot = findLoreProjectRoot();
    mcpConfigPath = writeLoreMcpConfig(dbPath, loreProjectRoot);
    args.push('--additional-mcp-config', `@${mcpConfigPath}`);
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

    // ── MCP health check for lore-enabled arm ─────────────────────────
    if (arm === 'lore-enabled' && dbPath) {
      if (result.mcpErrors.length > 0) {
        throw new Error(
          `Lore MCP server reported errors: ${result.mcpErrors.join('; ')}`,
        );
      }
      if (!result.loreMcpHealthy && result.outputTokens === 0 && !result.answer) {
        throw new Error(
          'Lore MCP server appears to have failed: copilot CLI produced no output ' +
          '(0 tokens, empty answer). The MCP server may have crashed on startup. ' +
          'Check that dist/server/server.js exists and the DB path is valid.',
        );
      }
    }

    // ── General CLI crash detection ───────────────────────────────────
    if (result.outputTokens === 0 && !result.answer) {
      throw new Error(
        `Copilot CLI produced no output (0 tokens, empty answer) for ${arm} arm. ` +
        'The CLI may have crashed or timed out silently.',
      );
    }

    return {
      toolCalls: result.toolCalls,
      filesRead: result.filesRead,
      finalAnswer: result.answer,
      totalTokensEstimate: result.outputTokens,
      loreToolsCalled: extractLoreToolsCalled(result.toolCalls),
      rawOutput: output,
    };
  } catch (e: any) {
    // Detect if this was a timeout (Node child_process sets e.killed on SIGTERM from timeout)
    const isTimeout = !!(e.killed || (e.code === null && e.signal === 'SIGTERM'));

    // If the process timed out or failed, still try to parse partial output
    const partialOutput = (e.stdout ?? '') + '\n' + (e.stderr ?? '');
    if (partialOutput.trim()) {
      const result = parseCopilotOutput(partialOutput);

      // Even for partial output, throw on MCP errors instead of silently returning bad data
      if (arm === 'lore-enabled' && result.mcpErrors.length > 0) {
        throw new Error(
          `Lore MCP server reported errors: ${result.mcpErrors.join('; ')} ` +
          `(original error: ${e.message})`,
        );
      }

      // If partial output has actual content, return it
      if (result.answer || result.outputTokens > 0) {
        return {
          toolCalls: result.toolCalls,
          filesRead: result.filesRead,
          finalAnswer: result.answer || `Error: ${e.message}`,
          totalTokensEstimate: result.outputTokens,
          loreToolsCalled: extractLoreToolsCalled(result.toolCalls),
          rawOutput: partialOutput,
          timedOut: isTimeout,
        };
      }
    }

    // No usable output at all — throw instead of returning zeros silently
    throw new Error(
      `Copilot CLI failed with no usable output for ${arm} arm: ${e.message}`,
    );
  } finally {
    if (mcpConfigPath && existsSync(mcpConfigPath)) {
      unlinkSync(mcpConfigPath);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the Lore project root that contains `dist/server/server.js`.
 *
 * The MCP server must always come from the **current checkout** — never from
 * a cloned target repo, even when that target is Lore itself.  A pinned-SHA
 * clone may lack fixes present in the running build (e.g. the realpathSync
 * entry-guard fix), which would cause the server to silently fail.
 */
function findLoreProjectRoot(): string {
  // Relative to this file: tests/benchmark/util/ → project root
  const root = join(import.meta.dirname, '..', '..', '..');
  if (!existsSync(join(root, 'dist', 'server', 'server.js'))) {
    throw new Error(
      'Cannot find dist/server/server.js — run `npm run build` before the benchmark.',
    );
  }
  return root;
}


