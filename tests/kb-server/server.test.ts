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

  it('should register kb_routes with optional method, path_prefix, and framework filters', () => {
    const db = new Database(':memory:');

    createKbMcpServer(db, '/tmp/test.db');

    const routesToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_routes');
    expect(routesToolCall).toBeDefined();

    const routesSchema = routesToolCall?.[2] as {
      method: { safeParse: (v: unknown) => { success: boolean } };
      path_prefix: { safeParse: (v: unknown) => { success: boolean } };
      framework: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(routesSchema.method.safeParse(undefined).success).toBe(true);
    expect(routesSchema.method.safeParse('GET').success).toBe(true);
    expect(routesSchema.path_prefix.safeParse('/api').success).toBe(true);
    expect(routesSchema.framework.safeParse('express').success).toBe(true);
    expect(routesSchema.framework.safeParse(42).success).toBe(false);
  });
});
