import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as docs from '../../src/kb-server/tools/docs.js';
import * as lookup from '../../src/kb-server/tools/lookup.js';
import * as graph from '../../src/kb-server/tools/graph.js';
import type { EmbeddingProvider } from '../../src/indexer/embedder.js';
import * as metrics from '../../src/kb-server/tools/metrics.js';

const { mockTool } = vi.hoisted(() => ({
  mockTool: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool = mockTool;
  },
}));

import { createKbMcpServer, type KbServerOptions } from '../../src/kb-server/server.js';

function schemaDescription(schema: { description?: string; _def?: { description?: string } }): string {
  return schema.description ?? schema._def?.description ?? '';
}

function createStubEmbedder(): EmbeddingProvider {
  return {
    modelName: 'test-embedder',
    dims: 3,
    init: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    embed: vi.fn(async () => [[0.9, 0.1, 0.0]]),
  };
}

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

    const graphSchema = graphToolCall?.[2] as {
      kind: { safeParse: (v: unknown) => { success: boolean } };
      mode: { safeParse: (v: unknown) => { success: boolean } };
      query_vector: { safeParse: (v: unknown) => { success: boolean } };
      semantic_limit: { safeParse: (v: unknown) => { success: boolean } };
      semantic_max_distance: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(graphSchema.kind.safeParse('call').success).toBe(true);
    expect(graphSchema.kind.safeParse('import').success).toBe(true);
    expect(graphSchema.kind.safeParse('module').success).toBe(true);
    expect(graphSchema.kind.safeParse('inheritance').success).toBe(true);
    expect(graphSchema.kind.safeParse('invalid-kind').success).toBe(false);
    expect(graphSchema.mode.safeParse('structural').success).toBe(true);
    expect(graphSchema.mode.safeParse('semantic').success).toBe(true);
    expect(graphSchema.mode.safeParse('invalid-mode').success).toBe(false);
    expect(graphSchema.query_vector.safeParse([0.1, 0.2]).success).toBe(true);
    expect(graphSchema.query_vector.safeParse(['0.1']).success).toBe(false);
    expect(graphSchema.semantic_limit.safeParse(10).success).toBe(true);
    expect(graphSchema.semantic_limit.safeParse('10').success).toBe(false);
    expect(graphSchema.semantic_max_distance.safeParse(0.4).success).toBe(true);
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
      mode: { safeParse: (v: unknown) => { success: boolean } };
      section_index: { safeParse: (v: unknown) => { success: boolean } };
      include_sections: { safeParse: (v: unknown) => { success: boolean } };
      kinds: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(docsSchema.action.safeParse('list').success).toBe(true);
    expect(docsSchema.action.safeParse('get').success).toBe(true);
    expect(docsSchema.action.safeParse('search').success).toBe(true);
    expect(docsSchema.path.safeParse('README.md').success).toBe(true);
    expect(docsSchema.query.safeParse('install').success).toBe(true);
    expect(docsSchema.mode.safeParse('text').success).toBe(true);
    expect(docsSchema.mode.safeParse('semantic').success).toBe(true);
    expect(docsSchema.mode.safeParse('fused').success).toBe(true);
    expect(docsSchema.mode.safeParse('invalid').success).toBe(false);
    expect(docsSchema.section_index.safeParse(1).success).toBe(true);
    expect(docsSchema.include_sections.safeParse(true).success).toBe(true);
    expect(docsSchema.kinds.safeParse(['readme', 'guide']).success).toBe(true);
    expect(docsSchema.action.safeParse('invalid').success).toBe(false);
  });

  it('should route kb_docs tool calls through docs.handler', async () => {
    const db = new Database(':memory:');
    const embedder = createStubEmbedder();
    const docsResult = { action: 'list', docs: [], count: 0 };
    const docsHandlerSpy = vi.spyOn(docs, 'handler').mockResolvedValue(docsResult);

    createKbMcpServer(db, '/tmp/test.db', embedder);

    const docsToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_docs');
    expect(docsToolCall).toBeDefined();

    const docsCallback = docsToolCall?.[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { action: 'list', limit: 5 };
    const response = await docsCallback(args);

    expect(docsHandlerSpy).toHaveBeenCalledWith(db, args, embedder);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(docsResult) }],
    });
  });

  it('should reject kb_docs tool calls when docs.handler fails', async () => {
    const db = new Database(':memory:');
    const docsHandlerSpy = vi.spyOn(docs, 'handler').mockRejectedValue(new Error('docs failed'));
    createKbMcpServer(db, '/tmp/test.db');

    const docsToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_docs');
    expect(docsToolCall).toBeDefined();
    const docsCallback = docsToolCall?.[3] as (args: unknown) => Promise<unknown>;

    await expect(docsCallback({ action: 'search', query: 'architecture' })).rejects.toThrow('docs failed');
    expect(docsHandlerSpy).toHaveBeenCalledWith(db, { action: 'search', query: 'architecture' }, undefined);
  });

  it('should register kb_metrics with expected complexity schema fields', () => {
    const db = new Database(':memory:');

    createKbMcpServer(db, '/tmp/test.db');

    const metricsToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_metrics');
    expect(metricsToolCall).toBeDefined();

    const metricsSchema = metricsToolCall?.[2] as {
      mode: { safeParse: (v: unknown) => { success: boolean } };
      limit: { safeParse: (v: unknown) => { success: boolean } };
      min_cyclomatic: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(metricsSchema.mode.safeParse('aggregate').success).toBe(true);
    expect(metricsSchema.mode.safeParse('complexity').success).toBe(true);
    expect(metricsSchema.limit.safeParse(10).success).toBe(true);
    expect(metricsSchema.min_cyclomatic.safeParse(5).success).toBe(true);
    expect(metricsSchema.mode.safeParse('invalid').success).toBe(false);
    expect(metricsSchema.limit.safeParse('10').success).toBe(false);
    expect(metricsSchema.min_cyclomatic.safeParse('5').success).toBe(false);
  });

  it('should route kb_metrics tool calls through metrics.handler with parsed args', async () => {
    const db = new Database(':memory:');
    const metricsResult = { symbols: [] };
    const metricsHandlerSpy = vi.spyOn(metrics, 'handler').mockReturnValue(metricsResult);

    createKbMcpServer(db, '/tmp/test.db');

    const metricsToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_metrics');
    expect(metricsToolCall).toBeDefined();

    const metricsCallback = metricsToolCall?.[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { mode: 'complexity', limit: 10, min_cyclomatic: 5 };
    const response = await metricsCallback(args);

    expect(metricsHandlerSpy).toHaveBeenCalledWith(db, args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(metricsResult) }],
    });
  });

  it('should route kb_metrics with no args to aggregate behavior', async () => {
    const db = new Database(':memory:');
    const aggregateResult = {
      symbol_count: 0,
      file_count: 0,
      import_edge_count: 0,
      coverage_available: false,
      coverage_commit: null,
      current_commit: null,
      commits_behind: 0,
      stale: false,
      global_lines_found: null,
      global_lines_hit: null,
      global_coverage_percent: null,
      per_branch: [],
    };
    const metricsHandlerSpy = vi.spyOn(metrics, 'handler').mockReturnValue(aggregateResult);

    createKbMcpServer(db, '/tmp/test.db');

    const metricsToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_metrics');
    expect(metricsToolCall).toBeDefined();

    const metricsCallback = metricsToolCall?.[3] as (args?: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const response = await metricsCallback();

    expect(metricsHandlerSpy).toHaveBeenCalledWith(db, {});
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(aggregateResult) }],
    });
  });

  it('should register kb_lookup semantic mode schema and describe query metadata', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const lookupToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_lookup');
    expect(lookupToolCall).toBeDefined();
    const lookupSchema = lookupToolCall?.[2] as {
      query: { description?: string; _def?: { description?: string } };
      mode: { safeParse: (v: unknown) => { success: boolean } };
      branch: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(schemaDescription(lookupSchema.query)).toContain('persisted enrichment metadata');
    expect(lookupSchema.mode.safeParse('exact').success).toBe(true);
    expect(lookupSchema.mode.safeParse('semantic').success).toBe(true);
    expect(lookupSchema.mode.safeParse('fused').success).toBe(true);
    expect(lookupSchema.mode.safeParse('invalid').success).toBe(false);
    expect(lookupSchema.branch.safeParse('main').success).toBe(true);
  });

  it('should route kb_lookup tool calls through lookup.handler with embedder', async () => {
    const db = new Database(':memory:');
    const embedder = createStubEmbedder();
    const lookupResult = { results: [], mode_used: 'exact' };
    const lookupHandlerSpy = vi.spyOn(lookup, 'handler').mockResolvedValue(lookupResult);

    createKbMcpServer(db, '/tmp/test.db', embedder);

    const lookupToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_lookup');
    expect(lookupToolCall).toBeDefined();

    const lookupCallback = lookupToolCall?.[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { kind: 'symbol', query: 'parseConfig', mode: 'semantic' };
    const response = await lookupCallback(args);

    expect(lookupHandlerSpy).toHaveBeenCalledWith(db, args, embedder);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(lookupResult) }],
    });
  });

  it('should reject kb_lookup tool calls when lookup.handler fails', async () => {
    const db = new Database(':memory:');
    const lookupHandlerSpy = vi.spyOn(lookup, 'handler').mockRejectedValue(new Error('lookup failed'));
    createKbMcpServer(db, '/tmp/test.db');

    const lookupToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_lookup');
    expect(lookupToolCall).toBeDefined();
    const lookupCallback = lookupToolCall?.[3] as (args: unknown) => Promise<unknown>;

    await expect(lookupCallback({ kind: 'symbol', query: 'Parser' })).rejects.toThrow('lookup failed');
    expect(lookupHandlerSpy).toHaveBeenCalledWith(
      db,
      { kind: 'symbol', query: 'Parser' },
      undefined,
    );
  });

  it('should route kb_graph tool calls through graph.handler with semantic args', async () => {
    const db = new Database(':memory:');
    const graphResult = { edges: [], semantic_nodes: [], mode_used: 'semantic' };
    const graphHandlerSpy = vi.spyOn(graph, 'handler').mockReturnValue(graphResult);

    createKbMcpServer(db, '/tmp/test.db');

    const graphToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_graph');
    expect(graphToolCall).toBeDefined();

    const graphCallback = graphToolCall?.[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = {
      kind: 'call',
      mode: 'semantic',
      query_vector: [0.1, 0.2, 0.3],
      semantic_limit: 5,
      semantic_max_distance: 0.4,
    };
    const response = await graphCallback(args);

    expect(graphHandlerSpy).toHaveBeenCalledWith(db, args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(graphResult) }],
    });
  });

  it('should describe kb_search branch as SQLite-only query-time retrieval', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const searchToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_search');
    expect(searchToolCall).toBeDefined();
    const searchSchema = searchToolCall?.[2] as { branch: { description?: string; _def?: { description?: string } } };
    expect(schemaDescription(searchSchema.branch)).toContain('Query-time retrieval uses SQLite-only persisted data');
  });
});
