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

  it('should register notes tools with expected schema behavior', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const writeToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_notes_write');
    const readToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_notes_read');
    expect(writeToolCall).toBeDefined();
    expect(readToolCall).toBeDefined();

    const writeSchema = writeToolCall?.[2] as {
      key: { safeParse: (v: unknown) => { success: boolean } };
      content: { safeParse: (v: unknown) => { success: boolean } };
      scope: { safeParse: (v: unknown) => { success: boolean } };
      source_hash: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(writeSchema.key.safeParse('architecture/overview').success).toBe(true);
    expect(writeSchema.content.safeParse('hello').success).toBe(true);
    expect(writeSchema.scope.safeParse('file:/repo/src/index.ts').success).toBe(true);
    expect(writeSchema.source_hash.safeParse('abc123').success).toBe(true);
    expect(writeSchema.scope.safeParse(undefined).success).toBe(true);
    expect(writeSchema.content.safeParse(undefined).success).toBe(false);
    expect(writeSchema.key.safeParse(42).success).toBe(false);

    const readSchema = readToolCall?.[2] as {
      key: { safeParse: (v: unknown) => { success: boolean } };
      key_prefix: { safeParse: (v: unknown) => { success: boolean } };
      scope: { safeParse: (v: unknown) => { success: boolean } };
      limit: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(readSchema.key.safeParse('architecture/overview').success).toBe(true);
    expect(readSchema.key_prefix.safeParse('architecture/').success).toBe(true);
    expect(readSchema.scope.safeParse('global').success).toBe(true);
    expect(readSchema.key.safeParse(undefined).success).toBe(true);
    expect(readSchema.limit.safeParse(20).success).toBe(true);
    expect(readSchema.key_prefix.safeParse(10).success).toBe(false);
    expect(readSchema.limit.safeParse('20').success).toBe(false);
  });
});
