import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as docs from '../../src/kb-server/tools/docs.js';

const { mockTool } = vi.hoisted(() => ({
  mockTool: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool = mockTool;
  },
}));

import { createKbMcpServer, type KbServerOptions } from '../../src/kb-server/server.js';

describe('createKbMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should accept an options parameter with searchObserver', () => {
    const db = new Database(':memory:');
    const observer = vi.fn();
    const options: KbServerOptions = { searchObserver: observer };

    // Should not throw when options are provided.
    createKbMcpServer(db, '/tmp/test.db', undefined, options);

    // All standard tools should still be registered.
    const toolNames = mockTool.mock.calls.map((call) => call[0]);
    expect(toolNames).toContain('kb_search');
    expect(toolNames).toContain('kb_lookup');
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

  it('should register kb_coverage with expected schema fields', () => {
    const db = new Database(':memory:');

    createKbMcpServer(db, '/tmp/test.db');

    const coverageToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_coverage');
    expect(coverageToolCall).toBeDefined();

    const coverageSchema = coverageToolCall?.[2] as {
      symbol_id: { safeParse: (v: unknown) => { success: boolean } };
      symbol_name: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(coverageSchema.symbol_id.safeParse(1).success).toBe(true);
    expect(coverageSchema.symbol_name.safeParse('render').success).toBe(true);
    expect(coverageSchema.symbol_id.safeParse('1').success).toBe(false);
  });

  it('should register kb_test_map with expected schema fields', () => {
    const db = new Database(':memory:');

    createKbMcpServer(db, '/tmp/test.db');

    const testMapToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_test_map');
    expect(testMapToolCall).toBeDefined();

    const testMapSchema = testMapToolCall?.[2] as {
      source_path: { safeParse: (v: unknown) => { success: boolean } };
      branch: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(testMapSchema.source_path.safeParse('src/main.ts').success).toBe(true);
    expect(testMapSchema.branch.safeParse('feat').success).toBe(true);
    expect(testMapSchema.source_path.safeParse(42).success).toBe(false);
  });

  it('should register kb_docs with list/get/search schema fields', () => {
    const db = new Database(':memory:');

    createKbMcpServer(db, '/tmp/test.db');

    const docsToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_docs');
    expect(docsToolCall).toBeDefined();

    const docsSchema = docsToolCall?.[2] as {
      action: { safeParse: (v: unknown) => { success: boolean } };
      path: { safeParse: (v: unknown) => { success: boolean } };
      query: { safeParse: (v: unknown) => { success: boolean } };
      section_index: { safeParse: (v: unknown) => { success: boolean } };
      include_sections: { safeParse: (v: unknown) => { success: boolean } };
      kinds: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(docsSchema.action.safeParse('list').success).toBe(true);
    expect(docsSchema.action.safeParse('get').success).toBe(true);
    expect(docsSchema.action.safeParse('search').success).toBe(true);
    expect(docsSchema.path.safeParse('README.md').success).toBe(true);
    expect(docsSchema.query.safeParse('install').success).toBe(true);
    expect(docsSchema.section_index.safeParse(1).success).toBe(true);
    expect(docsSchema.include_sections.safeParse(true).success).toBe(true);
    expect(docsSchema.kinds.safeParse(['readme', 'guide']).success).toBe(true);
    expect(docsSchema.action.safeParse('invalid').success).toBe(false);
  });

  it('should route kb_docs tool calls through docs.handler', async () => {
    const db = new Database(':memory:');
    const docsResult = { action: 'list', docs: [], count: 0 };
    const docsHandlerSpy = vi.spyOn(docs, 'handler').mockReturnValue(docsResult);

    createKbMcpServer(db, '/tmp/test.db');

    const docsToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_docs');
    expect(docsToolCall).toBeDefined();

    const docsCallback = docsToolCall?.[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { action: 'list', limit: 5 };
    const response = await docsCallback(args);

    expect(docsHandlerSpy).toHaveBeenCalledWith(db, args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(docsResult) }],
    });
  });
});
