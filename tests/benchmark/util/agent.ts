/**
 * @module benchmark/agent
 *
 * Agent harness for benchmark runs.
 *
 * Provides a `ToolLoopAgent` that simulates agent behavior by iteratively
 * calling tools based on a prompt and recording the full trace.
 *
 * For real LLM-backed agents, implement the `BenchmarkAgent` interface
 * with your preferred model provider.
 */

import type {
  AgentTool,
  AgentTrace,
  BenchmarkTask,
  ToolCallRecord,
} from './types.js';

// ─── System prompt template ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a code analysis agent. You have access to tools for reading files, searching code, and querying a knowledge base. Use these tools to answer the question accurately.

When answering:
- Be specific about file paths, symbol names, and line numbers
- Use the available tools to verify your claims
- Consider architecture, test coverage, and history when relevant
- If a tool is not available, work with the tools you have

Respond with a clear, structured answer.`;

// ─── Tool execution helpers ───────────────────────────────────────────────────

export interface ToolCallRequest {
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Execute a tool call and record timing.
 */
export async function executeToolCall(
  tools: AgentTool[],
  request: ToolCallRequest,
): Promise<ToolCallRecord> {
  const tool = tools.find((t) => t.name === request.toolName);
  const start = performance.now();

  if (!tool) {
    return {
      toolName: request.toolName,
      args: request.args,
      result: `Error: tool "${request.toolName}" not found`,
      durationMs: 0,
      timestamp: Date.now(),
    };
  }

  try {
    const result = await tool.execute(request.args);
    return {
      toolName: request.toolName,
      args: request.args,
      result,
      durationMs: Math.round(performance.now() - start),
      timestamp: Date.now(),
    };
  } catch (e: any) {
    return {
      toolName: request.toolName,
      args: request.args,
      result: `Error: ${e.message}`,
      durationMs: Math.round(performance.now() - start),
      timestamp: Date.now(),
    };
  }
}

// ─── Scripted agent (for deterministic benchmark scenarios) ──────────────────

/**
 * A scripted agent that executes a predefined sequence of tool calls.
 * Used for deterministic benchmark evaluation where we control the
 * exact sequence of queries the agent makes.
 */
export interface ScriptedStep {
  toolName: string;
  args: Record<string, unknown>;
  /** Optional: callback to derive the next step's args from this step's result. */
  deriveNextArgs?: (result: string) => Record<string, unknown> | null;
}

export interface ScriptedAgentConfig {
  steps: ScriptedStep[];
  /** Function that produces the final answer from accumulated tool results. */
  synthesizeAnswer: (results: ToolCallRecord[]) => string;
}

/**
 * Run a scripted agent: executes tool calls in sequence, then synthesizes
 * an answer from the accumulated results.
 */
export async function runScriptedAgent(
  config: ScriptedAgentConfig,
  tools: AgentTool[],
): Promise<AgentTrace> {
  const toolCalls: ToolCallRecord[] = [];
  const filesRead = new Set<string>();

  for (const step of config.steps) {
    const record = await executeToolCall(tools, {
      toolName: step.toolName,
      args: step.args,
    });
    toolCalls.push(record);

    // Track file reads
    if (step.toolName === 'read_file' && step.args['path']) {
      filesRead.add(String(step.args['path']));
    }

    // If the step can derive args for a dynamic follow-up, allow it
    // (but the follow-up must be defined in the next step)
  }

  const finalAnswer = config.synthesizeAnswer(toolCalls);

  return {
    toolCalls,
    filesRead: [...filesRead],
    finalAnswer,
    totalTokensEstimate: estimateTokens(toolCalls, finalAnswer),
    loreToolsCalled: extractLoreToolsCalled(toolCalls),
  };
}

// ─── Programmatic agent (for benchmark test harness) ────────────────────────

/**
 * A programmatic agent that follows a strategy function.
 * The strategy function receives the current state and returns the next
 * tool call or null to finish.
 */
export type AgentStrategy = (
  task: BenchmarkTask,
  tools: AgentTool[],
  history: ToolCallRecord[],
) => Promise<ToolCallRequest | null>;

export interface ProgrammaticAgentConfig {
  strategy: AgentStrategy;
  /** Maximum tool calls before forced termination. */
  maxSteps: number;
  /** Function to synthesize the final answer from tool results. */
  synthesizeAnswer: (task: BenchmarkTask, results: ToolCallRecord[]) => string;
}

/**
 * Run a programmatic agent that uses a strategy function to decide
 * each tool call dynamically based on prior results.
 */
export async function runProgrammaticAgent(
  config: ProgrammaticAgentConfig,
  task: BenchmarkTask,
  tools: AgentTool[],
): Promise<AgentTrace> {
  const toolCalls: ToolCallRecord[] = [];
  const filesRead = new Set<string>();

  for (let i = 0; i < config.maxSteps; i++) {
    const nextCall = await config.strategy(task, tools, toolCalls);
    if (!nextCall) break;

    const record = await executeToolCall(tools, nextCall);
    toolCalls.push(record);

    if (nextCall.toolName === 'read_file' && nextCall.args['path']) {
      filesRead.add(String(nextCall.args['path']));
    }
  }

  const finalAnswer = config.synthesizeAnswer(task, toolCalls);

  return {
    toolCalls,
    filesRead: [...filesRead],
    finalAnswer,
    totalTokensEstimate: estimateTokens(toolCalls, finalAnswer),
    loreToolsCalled: extractLoreToolsCalled(toolCalls),
  };
}

// ─── Token estimation ──────────────────────────────────────────────────────────

function estimateTokens(calls: ToolCallRecord[], answer: string): number {
  let totalChars = answer.length;
  for (const call of calls) {
    totalChars += JSON.stringify(call.args).length;
    totalChars += call.result.length;
  }
  // Rough estimate: ~4 chars per token
  return Math.ceil(totalChars / 4);
}

/** Extract unique Lore tool names from a set of tool call records. */
export function extractLoreToolsCalled(toolCalls: ToolCallRecord[]): string[] {
  const loreNames = new Set<string>();
  for (const call of toolCalls) {
    if (call.toolName.startsWith('lore_') && call.result !== 'not available in this configuration') {
      loreNames.add(call.toolName);
    }
  }
  return [...loreNames];
}
