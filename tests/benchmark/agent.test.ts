/**
 * Unit tests for the benchmark agent harness.
 */

import { describe, it, expect } from 'vitest';
import {
  executeToolCall,
  runScriptedAgent,
  runProgrammaticAgent,
} from '../../src/benchmark/agent.js';
import type { AgentTool, BenchmarkTask } from '../../src/benchmark/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeTool(name: string, response: string): AgentTool {
  return {
    name,
    description: `Test tool: ${name}`,
    execute: async () => response,
  };
}

function makeTask(): BenchmarkTask {
  return {
    id: 'test-task',
    repoName: 'test-repo',
    family: 'localization',
    prompt: 'Find the main entry point.',
    expectedAnswer: 'main\nindex.ts',
    expectedAnswerParts: ['main', 'index.ts'],
  };
}

// ─── executeToolCall ──────────────────────────────────────────────────────────

describe('executeToolCall', () => {
  it('should execute a tool and record timing', async () => {
    const tools = [makeTool('read_file', 'file contents')];
    const record = await executeToolCall(tools, {
      toolName: 'read_file',
      args: { path: 'index.ts' },
    });

    expect(record.toolName).toBe('read_file');
    expect(record.result).toBe('file contents');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.timestamp).toBeGreaterThan(0);
  });

  it('should return error for missing tool', async () => {
    const record = await executeToolCall([], {
      toolName: 'nonexistent',
      args: {},
    });

    expect(record.result).toContain('not found');
  });

  it('should catch tool errors', async () => {
    const tools: AgentTool[] = [
      {
        name: 'failing_tool',
        description: 'Always fails',
        execute: async () => {
          throw new Error('tool failure');
        },
      },
    ];

    const record = await executeToolCall(tools, {
      toolName: 'failing_tool',
      args: {},
    });

    expect(record.result).toContain('Error: tool failure');
  });
});

// ─── runScriptedAgent ─────────────────────────────────────────────────────────

describe('runScriptedAgent', () => {
  it('should execute steps in order and synthesize answer', async () => {
    const tools = [
      makeTool('list_directory', 'src/\ntests/\npackage.json'),
      makeTool('read_file', 'export function main() {}'),
      makeTool('grep_search', 'src/index.ts:1:export function main() {}'),
    ];

    const trace = await runScriptedAgent(
      {
        steps: [
          { toolName: 'list_directory', args: { path: '.' } },
          { toolName: 'grep_search', args: { pattern: 'main' } },
          { toolName: 'read_file', args: { path: 'src/index.ts' } },
        ],
        synthesizeAnswer: (results) =>
          results.map((r) => r.result).join('\n'),
      },
      tools,
    );

    expect(trace.toolCalls).toHaveLength(3);
    expect(trace.toolCalls[0]!.toolName).toBe('list_directory');
    expect(trace.toolCalls[1]!.toolName).toBe('grep_search');
    expect(trace.toolCalls[2]!.toolName).toBe('read_file');
    expect(trace.filesRead).toContain('src/index.ts');
    expect(trace.finalAnswer).toContain('export function main');
  });

  it('should handle empty steps', async () => {
    const trace = await runScriptedAgent(
      {
        steps: [],
        synthesizeAnswer: () => 'no results',
      },
      [],
    );

    expect(trace.toolCalls).toHaveLength(0);
    expect(trace.finalAnswer).toBe('no results');
  });
});

// ─── runProgrammaticAgent ─────────────────────────────────────────────────────

describe('runProgrammaticAgent', () => {
  it('should follow strategy until null is returned', async () => {
    const tools = [
      makeTool('grep_search', 'src/index.ts:1:main'),
      makeTool('read_file', 'export function main() {}'),
    ];

    let callCount = 0;
    const trace = await runProgrammaticAgent(
      {
        strategy: async (_task, _tools, history) => {
          callCount++;
          if (history.length === 0) {
            return { toolName: 'grep_search', args: { pattern: 'main' } };
          }
          if (history.length === 1) {
            return { toolName: 'read_file', args: { path: 'src/index.ts' } };
          }
          return null; // Done
        },
        maxSteps: 10,
        synthesizeAnswer: (_task, results) =>
          results.map((r) => r.result).join('\n'),
      },
      makeTask(),
      tools,
    );

    expect(trace.toolCalls).toHaveLength(2);
    expect(callCount).toBe(3); // Two calls + final null check
  });

  it('should respect maxSteps', async () => {
    const tools = [makeTool('grep_search', 'match')];

    const trace = await runProgrammaticAgent(
      {
        strategy: async () => ({
          toolName: 'grep_search',
          args: { pattern: 'infinite' },
        }),
        maxSteps: 3,
        synthesizeAnswer: (_task, results) => `${results.length} calls made`,
      },
      makeTask(),
      tools,
    );

    expect(trace.toolCalls).toHaveLength(3);
    expect(trace.finalAnswer).toBe('3 calls made');
  });
});
