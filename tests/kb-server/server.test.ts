import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const { mockTool } = vi.hoisted(() => ({
  mockTool: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool = mockTool;
  },
}));

import { createKbMcpServer } from '../../src/kb-server/server.js';

describe('createKbMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register kb_graph kind schema with module and inheritance values', () => {
    const db = new Database(':memory:');

    createKbMcpServer(db, '/tmp/test.db');

    const graphToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_graph');
    expect(graphToolCall).toBeDefined();

    const graphSchema = graphToolCall?.[2] as { kind: { safeParse: (v: unknown) => { success: boolean } } };
    expect(graphSchema.kind.safeParse('call').success).toBe(true);
    expect(graphSchema.kind.safeParse('import').success).toBe(true);
    expect(graphSchema.kind.safeParse('module').success).toBe(true);
    expect(graphSchema.kind.safeParse('inheritance').success).toBe(true);
    expect(graphSchema.kind.safeParse('invalid-kind').success).toBe(false);
  });

  it('should register kb_annotations with kind, optional path, and optional limit args', () => {
    const db = new Database(':memory:');

    createKbMcpServer(db, '/tmp/test.db');

    const annotationsToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_annotations');
    expect(annotationsToolCall).toBeDefined();

    const annotationsSchema = annotationsToolCall?.[2] as {
      kind: { safeParse: (v: unknown) => { success: boolean } };
      path: { safeParse: (v: unknown) => { success: boolean } };
      limit: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(annotationsSchema.kind.safeParse('TODO').success).toBe(true);
    expect(annotationsSchema.kind.safeParse('invalid-kind').success).toBe(false);
    expect(annotationsSchema.path.safeParse(undefined).success).toBe(true);
    expect(annotationsSchema.limit.safeParse(undefined).success).toBe(true);
  });
});
