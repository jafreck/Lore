import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { z } from 'zod';
import * as docs from '../../src/lore-server/tools/docs.js';
import * as history from '../../src/lore-server/tools/history.js';
import * as lookup from '../../src/lore-server/tools/lookup.js';
import * as graph from '../../src/lore-server/tools/graph.js';
import type { EmbeddingProvider } from '../../src/indexer/embedder.js';
import * as routes from '../../src/lore-server/tools/routes.js';
import * as notes from '../../src/lore-server/tools/notes.js';
import * as architecture from '../../src/lore-server/tools/architecture.js';
import * as search from '../../src/lore-server/tools/search.js';
import * as metrics from '../../src/lore-server/tools/metrics.js';

const {
  mockTool,
} = vi.hoisted(() => ({
  mockTool: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool = mockTool;
  },
}));

import { createLoreMcpServer, createLoreMcpServerAsync, type LoreServerOptions } from '../../src/lore-server/server.js';

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

function getToolCall(name: string): unknown[] {
  const toolCall = mockTool.mock.calls.find((call) => call[0] === name);
  expect(toolCall).toBeDefined();
  return toolCall!;
}

describe('createLoreMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should accept an options parameter with searchObserver', () => {
    const db = new Database(':memory:');
    const observer = vi.fn();
    const options: LoreServerOptions = { searchObserver: observer };

    // Should not throw when options are provided.
    createLoreMcpServer(db, '/tmp/test.db', undefined, options);

    // All standard tools should still be registered.
    const toolNames = mockTool.mock.calls.map((call) => call[0]);
    expect(toolNames).toContain('lore_search');
    expect(toolNames).toContain('lore_lookup');
  });

  it('should register newly exposed MCP tools', () => {
    const db = new Database(':memory:');
    createLoreMcpServer(db, '/tmp/test.db');

    const toolNames = mockTool.mock.calls.map((call) => call[0]);
    expect(toolNames).toContain('lore_routes');
    expect(toolNames).toContain('lore_notes_write');
    expect(toolNames).toContain('lore_notes_read');
    expect(toolNames).toContain('lore_architecture');
  });

  it('should register newly exposed tools with expected schema fields', () => {
    const db = new Database(':memory:');
    createLoreMcpServer(db, '/tmp/test.db');

    const routesSchema = getToolCall('lore_routes')[2] as {
      method: { safeParse: (v: unknown) => { success: boolean } };
      path_prefix: { safeParse: (v: unknown) => { success: boolean } };
      framework: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(routesSchema.method.safeParse('GET').success).toBe(true);
    expect(routesSchema.path_prefix.safeParse('/api').success).toBe(true);
    expect(routesSchema.framework.safeParse('express').success).toBe(true);
    expect(routesSchema.method.safeParse(123).success).toBe(false);

    const notesWriteSchema = getToolCall('lore_notes_write')[2] as {
      key: { safeParse: (v: unknown) => { success: boolean } };
      scope: { safeParse: (v: unknown) => { success: boolean } };
      content: { safeParse: (v: unknown) => { success: boolean } };
      model: { safeParse: (v: unknown) => { success: boolean } };
      source_hash: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(notesWriteSchema.key.safeParse('architecture/overview').success).toBe(true);
    expect(notesWriteSchema.scope.safeParse('file:src/index.ts').success).toBe(true);
    expect(notesWriteSchema.content.safeParse('note').success).toBe(true);
    expect(notesWriteSchema.model.safeParse('gpt').success).toBe(true);
    expect(notesWriteSchema.source_hash.safeParse('abc123').success).toBe(true);
    expect(notesWriteSchema.content.safeParse(42).success).toBe(false);

    const notesReadSchema = getToolCall('lore_notes_read')[2] as {
      key: { safeParse: (v: unknown) => { success: boolean } };
      key_prefix: { safeParse: (v: unknown) => { success: boolean } };
      scope: { safeParse: (v: unknown) => { success: boolean } };
      limit: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(notesReadSchema.key.safeParse('architecture/overview').success).toBe(true);
    expect(notesReadSchema.key_prefix.safeParse('architecture/').success).toBe(true);
    expect(notesReadSchema.scope.safeParse('global').success).toBe(true);
    expect(notesReadSchema.limit.safeParse(20).success).toBe(true);
    expect(notesReadSchema.limit.safeParse('20').success).toBe(false);

    const architectureSchema = getToolCall('lore_architecture')[2] as {
      depth: { safeParse: (v: unknown) => { success: boolean } };
      branch: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(architectureSchema.depth.safeParse(2).success).toBe(true);
    expect(architectureSchema.branch.safeParse('main').success).toBe(true);
    expect(architectureSchema.depth.safeParse('2').success).toBe(false);
  });

  it('should register lore_graph kind schema with module and inheritance values', () => {
    const db = new Database(':memory:');

    createLoreMcpServer(db, '/tmp/test.db');

    const graphToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_graph');
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

  it('should register lore_coverage with expected schema fields', () => {
    const db = new Database(':memory:');

    createLoreMcpServer(db, '/tmp/test.db');

    const coverageToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_coverage');
    expect(coverageToolCall).toBeDefined();

    const coverageSchema = coverageToolCall?.[2] as {
      symbol_id: { safeParse: (v: unknown) => { success: boolean } };
      symbol_name: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(coverageSchema.symbol_id.safeParse(1).success).toBe(true);
    expect(coverageSchema.symbol_name.safeParse('render').success).toBe(true);
    expect(coverageSchema.symbol_id.safeParse('1').success).toBe(false);
  });

  it('should register lore_test_map with expected schema fields', () => {
    const db = new Database(':memory:');

    createLoreMcpServer(db, '/tmp/test.db');

    const testMapToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_test_map');
    expect(testMapToolCall).toBeDefined();

    const testMapSchema = testMapToolCall?.[2] as {
      source_path: { safeParse: (v: unknown) => { success: boolean } };
      branch: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(testMapSchema.source_path.safeParse('src/main.ts').success).toBe(true);
    expect(testMapSchema.branch.safeParse('feat').success).toBe(true);
    expect(testMapSchema.source_path.safeParse(42).success).toBe(false);
  });

  it('should register lore_docs with list/get/search schema fields', () => {
    const db = new Database(':memory:');

    createLoreMcpServer(db, '/tmp/test.db');

    const docsToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_docs');
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

  it('should route lore_docs tool calls through docs.handler', async () => {
    const db = new Database(':memory:');
    const embedder = createStubEmbedder();
    const docsResult = { action: 'list', docs: [], count: 0 };
    const docsHandlerSpy = vi.spyOn(docs, 'handler').mockResolvedValue(docsResult);
    createLoreMcpServer(db, '/tmp/test.db', embedder);

    const docsToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_docs');
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

  it('should reject lore_docs tool calls when docs.handler fails', async () => {
    const db = new Database(':memory:');
    const docsHandlerSpy = vi.spyOn(docs, 'handler').mockRejectedValue(new Error('docs failed'));
    createLoreMcpServer(db, '/tmp/test.db');

    const docsToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_docs');
    expect(docsToolCall).toBeDefined();
    const docsCallback = docsToolCall?.[3] as (args: unknown) => Promise<unknown>;

    await expect(docsCallback({ action: 'search', query: 'architecture' })).rejects.toThrow('docs failed');
    expect(docsHandlerSpy).toHaveBeenCalledWith(db, { action: 'search', query: 'architecture' }, undefined);
  });

  it('should route lore_routes tool calls through routes.handler', async () => {
    const db = new Database(':memory:');
    const routesResult = { results: [{ method: 'GET', path: '/api/health', framework: 'express' }] };
    const routesHandlerSpy = vi.spyOn(routes, 'handler').mockReturnValue(routesResult);

    createLoreMcpServer(db, '/tmp/test.db');

    const callback = getToolCall('lore_routes')[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { method: 'GET', path_prefix: '/api', framework: 'express' };
    const response = await callback(args);

    expect(routesHandlerSpy).toHaveBeenCalledWith(db, args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(routesResult) }],
    });
  });

  it('should route lore_notes_write tool calls through notes.writeHandler', async () => {
    const db = new Database(':memory:');
    const notesWriteResult = { ok: true, key: 'architecture/overview', scope: 'global', updated_at: 123 };
    const notesWriteHandlerSpy = vi.spyOn(notes, 'writeHandler').mockReturnValue(notesWriteResult);

    createLoreMcpServer(db, '/tmp/test.db');

    const callback = getToolCall('lore_notes_write')[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { key: 'architecture/overview', content: 'note body', model: 'test-model' };
    const response = await callback(args);

    expect(notesWriteHandlerSpy).toHaveBeenCalledWith('/tmp/test.db', args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(notesWriteResult) }],
    });
  });

  it('should route lore_notes_read tool calls through notes.readHandler', async () => {
    const db = new Database(':memory:');
    const notesReadResult = { notes: [], count: 0 };
    const notesReadHandlerSpy = vi.spyOn(notes, 'readHandler').mockReturnValue(notesReadResult);

    createLoreMcpServer(db, '/tmp/test.db');

    const callback = getToolCall('lore_notes_read')[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { key_prefix: 'architecture/', limit: 5 };
    const response = await callback(args);

    expect(notesReadHandlerSpy).toHaveBeenCalledWith(db, args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(notesReadResult) }],
    });
  });

  it('should route lore_architecture tool calls through architecture.handler', async () => {
    const db = new Database(':memory:');
    const architectureResult = {
      components: [],
      edges: [],
      entry_points: [],
      leaf_nodes: [],
      external_deps: [],
    };
    const architectureHandlerSpy = vi.spyOn(architecture, 'handler').mockReturnValue(architectureResult);

    createLoreMcpServer(db, '/tmp/test.db');

    const callback = getToolCall('lore_architecture')[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { depth: 3, branch: 'main' };
    const response = await callback(args);

    expect(architectureHandlerSpy).toHaveBeenCalledWith(db, args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(architectureResult) }],
    });
  });

  it('should route lore_search tool calls through search.handler with filter args and observer', async () => {
    const db = new Database(':memory:');
    const observer = vi.fn();
    const embedder = {
      modelName: 'mock-embedder',
      dims: 3,
      embed: vi.fn(async () => [[0.1, 0.2, 0.3]]),
      init: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const searchResult = { results: [], mode_used: 'structural' };
    const searchHandlerSpy = vi.spyOn(search, 'handler').mockResolvedValue(searchResult);

    try {
      createLoreMcpServer(db, '/tmp/test.db', embedder, { searchObserver: observer });

      const searchToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_search');
      expect(searchToolCall).toBeDefined();

      const searchCallback = searchToolCall?.[3] as (args: unknown) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
      const args = {
        query: 'parseConfig',
        mode: 'semantic',
        path_prefix: 'src/',
        language: 'typescript',
        kind: 'function',
        doc_path_prefix: 'docs/',
        doc_kind: 'guide',
        branch: 'main',
      };
      const response = await searchCallback(args);

      expect(searchHandlerSpy).toHaveBeenCalledWith(db, args, embedder, observer);
      expect(response).toEqual({
        content: [{ type: 'text', text: JSON.stringify(searchResult) }],
      });
    } finally {
      searchHandlerSpy.mockRestore();
    }
  });

  it('should propagate errors from newly exposed tool handlers', async () => {
    const db = new Database(':memory:');
    const callbackArgs = {
      routes: { method: 'GET' },
      notesWrite: { key: 'architecture/overview', content: 'note body' },
      notesRead: { key_prefix: 'architecture/' },
      architecture: { depth: 2 },
    };
    const routeError = new Error('routes failed');
    const notesWriteError = new Error('notes write failed');
    const notesReadError = new Error('notes read failed');
    const architectureError = new Error('architecture failed');

    vi.spyOn(routes, 'handler').mockImplementation(() => {
      throw routeError;
    });
    vi.spyOn(notes, 'writeHandler').mockImplementation(() => {
      throw notesWriteError;
    });
    vi.spyOn(notes, 'readHandler').mockImplementation(() => {
      throw notesReadError;
    });
    vi.spyOn(architecture, 'handler').mockImplementation(() => {
      throw architectureError;
    });

    createLoreMcpServer(db, '/tmp/test.db');

    const routesCallback = getToolCall('lore_routes')[3] as (args: unknown) => Promise<unknown>;
    const notesWriteCallback = getToolCall('lore_notes_write')[3] as (args: unknown) => Promise<unknown>;
    const notesReadCallback = getToolCall('lore_notes_read')[3] as (args: unknown) => Promise<unknown>;
    const architectureCallback = getToolCall('lore_architecture')[3] as (args: unknown) => Promise<unknown>;

    await expect(routesCallback(callbackArgs.routes)).rejects.toThrow(routeError);
    await expect(notesWriteCallback(callbackArgs.notesWrite)).rejects.toThrow(notesWriteError);
    await expect(notesReadCallback(callbackArgs.notesRead)).rejects.toThrow(notesReadError);
    await expect(architectureCallback(callbackArgs.architecture)).rejects.toThrow(architectureError);
  });

  it('should register lore_metrics with expected complexity schema fields', () => {
    const db = new Database(':memory:');

    createLoreMcpServer(db, '/tmp/test.db');

    const metricsToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_metrics');
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

  it('should route lore_metrics tool calls through metrics.handler with parsed args', async () => {
    const db = new Database(':memory:');
    const metricsResult = { symbols: [] };
    const metricsHandlerSpy = vi.spyOn(metrics, 'handler').mockReturnValue(metricsResult);

    createLoreMcpServer(db, '/tmp/test.db');

    const metricsToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_metrics');
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

  it('should route lore_metrics with no args to aggregate behavior', async () => {
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

    createLoreMcpServer(db, '/tmp/test.db');

    const metricsToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_metrics');
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

  it('should register lore_lookup semantic mode schema and describe query metadata', () => {
    const db = new Database(':memory:');
    createLoreMcpServer(db, '/tmp/test.db');

    const lookupToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_lookup');
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

  it('should route lore_lookup tool calls through lookup.handler with embedder', async () => {
    const db = new Database(':memory:');
    const embedder = createStubEmbedder();
    const lookupResult = { results: [], mode_used: 'exact' };
    const lookupHandlerSpy = vi.spyOn(lookup, 'handler').mockResolvedValue(lookupResult);

    createLoreMcpServer(db, '/tmp/test.db', embedder);

    const lookupToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_lookup');
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

  it('should reject lore_lookup tool calls when lookup.handler fails', async () => {
    const db = new Database(':memory:');
    const lookupHandlerSpy = vi.spyOn(lookup, 'handler').mockRejectedValue(new Error('lookup failed'));
    createLoreMcpServer(db, '/tmp/test.db');

    const lookupToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_lookup');
    expect(lookupToolCall).toBeDefined();
    const lookupCallback = lookupToolCall?.[3] as (args: unknown) => Promise<unknown>;

    await expect(lookupCallback({ kind: 'symbol', query: 'Parser' })).rejects.toThrow('lookup failed');
    expect(lookupHandlerSpy).toHaveBeenCalledWith(
      db,
      { kind: 'symbol', query: 'Parser' },
      undefined,
    );
  });

  it('should route lore_graph tool calls through graph.handler with semantic args', async () => {
    const db = new Database(':memory:');
    const graphResult = { edges: [], semantic_nodes: [], mode_used: 'semantic' };
    const graphHandlerSpy = vi.spyOn(graph, 'handler').mockReturnValue(graphResult);

    createLoreMcpServer(db, '/tmp/test.db');

    const graphToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_graph');
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

  it('should register lore_lookup with optional match/filter/pagination fields', () => {
    const db = new Database(':memory:');
    createLoreMcpServer(db, '/tmp/test.db');

    const lookupToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_lookup');
    expect(lookupToolCall).toBeDefined();

    const lookupSchema = lookupToolCall?.[2] as {
      kind: { safeParse: (v: unknown) => { success: boolean } };
      query: { safeParse: (v: unknown) => { success: boolean } };
      match_mode: { safeParse: (v: unknown) => { success: boolean } };
      symbol_kind: { safeParse: (v: unknown) => { success: boolean } };
      path_prefix: { safeParse: (v: unknown) => { success: boolean } };
      language: { safeParse: (v: unknown) => { success: boolean } };
      limit: { safeParse: (v: unknown) => { success: boolean } };
      offset: { safeParse: (v: unknown) => { success: boolean } };
    };

    expect(lookupSchema.kind.safeParse('symbol').success).toBe(true);
    expect(lookupSchema.kind.safeParse(undefined).success).toBe(false);
    expect(lookupSchema.query.safeParse('parseConfig').success).toBe(true);
    expect(lookupSchema.query.safeParse(undefined).success).toBe(false);
    expect(lookupSchema.match_mode.safeParse('exact').success).toBe(true);
    expect(lookupSchema.match_mode.safeParse('prefix').success).toBe(true);
    expect(lookupSchema.match_mode.safeParse('contains').success).toBe(true);
    expect(lookupSchema.match_mode.safeParse('fuzzy').success).toBe(false);
    expect(lookupSchema.symbol_kind.safeParse('function').success).toBe(true);
    expect(lookupSchema.path_prefix.safeParse('src/').success).toBe(true);
    expect(lookupSchema.language.safeParse('typescript').success).toBe(true);
    expect(lookupSchema.limit.safeParse(10).success).toBe(true);
    expect(lookupSchema.limit.safeParse(-1).success).toBe(false);
    expect(lookupSchema.limit.safeParse(1.5).success).toBe(false);
    expect(lookupSchema.offset.safeParse(5).success).toBe(true);
    expect(lookupSchema.offset.safeParse(-1).success).toBe(false);
    expect(lookupSchema.offset.safeParse(0.5).success).toBe(false);
  });

  it('should describe lore_search branch as SQLite-only query-time retrieval', () => {
    const db = new Database(':memory:');
    createLoreMcpServer(db, '/tmp/test.db');

    const searchToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_search');
    expect(searchToolCall).toBeDefined();
    const searchSchema = searchToolCall?.[2] as { branch: { description?: string; _def?: { description?: string } } };
    expect(schemaDescription(searchSchema.branch)).toContain('Query-time retrieval uses SQLite-only persisted data');
  });

  it('should route lore_history tool calls through history.handler with embedder', async () => {
    const db = new Database(':memory:');
    const embedder: EmbeddingProvider = {
      modelName: 'test-model',
      get dims() { return 3; },
      embed: vi.fn(async () => [[1, 0, 0]]),
      init: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const historyResult = { mode: 'semantic', results: [], count: 0 };
    const historyHandlerSpy = vi.spyOn(history, 'handler').mockResolvedValue(historyResult);

    createLoreMcpServer(db, '/tmp/test.db', embedder);

    const historyToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_history');
    expect(historyToolCall).toBeDefined();

    const historyCallback = historyToolCall?.[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { mode: 'semantic', query: 'cache bug', limit: 5 };
    const response = await historyCallback(args);

    expect(historyHandlerSpy).toHaveBeenCalledWith(db, args, embedder);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(historyResult) }],
    });
  });

  it('should register lore_history with semantic mode support', () => {
    const db = new Database(':memory:');
    createLoreMcpServer(db, '/tmp/test.db');

    const historyToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_history');
    expect(historyToolCall).toBeDefined();

    const historySchema = historyToolCall?.[2] as {
      mode: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(historySchema.mode.safeParse('file').success).toBe(true);
    expect(historySchema.mode.safeParse('semantic').success).toBe(true);
    expect(historySchema.mode.safeParse('invalid').success).toBe(false);
  });

  it('should register lore_blame schema with extended modes while preserving legacy line/range payloads', () => {
    const db = new Database(':memory:');
    createLoreMcpServer(db, '/tmp/test.db');

    const blameToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_blame');
    expect(blameToolCall).toBeDefined();

    const blameSchema = blameToolCall?.[2] as {
      path: z.ZodTypeAny;
      line: z.ZodTypeAny;
      start_line: z.ZodTypeAny;
      end_line: z.ZodTypeAny;
      ref: z.ZodTypeAny;
      branch: z.ZodTypeAny;
      mode: z.ZodTypeAny;
      symbol: z.ZodTypeAny;
      scope: z.ZodTypeAny;
    };
    const argsSchema = z.object(blameSchema).strict();

    expect(argsSchema.safeParse({ path: '/repo/src/main.ts', line: 7 }).success).toBe(true);
    expect(
      argsSchema.safeParse({ path: '/repo/src/main.ts', start_line: 10, end_line: 20, ref: 'HEAD' }).success,
    ).toBe(true);
    expect(argsSchema.safeParse({ symbol: 'handleAuth', mode: 'history', branch: 'HEAD' }).success).toBe(true);
    expect(argsSchema.safeParse({ mode: 'ownership', path: '/repo/src', scope: 'directory' }).success).toBe(true);
    expect(argsSchema.safeParse({ mode: 'blame', scope: 'repo' }).success).toBe(false);
    expect(argsSchema.safeParse({ mode: 'timeline', path: '/repo/src/main.ts' }).success).toBe(false);
    expect(argsSchema.safeParse({ path: '/repo/src/main.ts', line: '7' }).success).toBe(false);
  });



  it('should register lore_search schema fields for symbol and doc filters', () => {
    const db = new Database(':memory:');
    createLoreMcpServer(db, '/tmp/test.db');

    const searchToolCall = mockTool.mock.calls.find((call) => call[0] === 'lore_search');
    expect(searchToolCall).toBeDefined();

    const searchSchema = searchToolCall?.[2] as {
      path_prefix: { safeParse: (v: unknown) => { success: boolean } };
      language: { safeParse: (v: unknown) => { success: boolean } };
      kind: { safeParse: (v: unknown) => { success: boolean } };
      doc_path_prefix: { safeParse: (v: unknown) => { success: boolean } };
      doc_kind: { safeParse: (v: unknown) => { success: boolean } };
    };

    expect(searchSchema.path_prefix.safeParse('src/lore-server').success).toBe(true);
    expect(searchSchema.language.safeParse('typescript').success).toBe(true);
    expect(searchSchema.kind.safeParse('function').success).toBe(true);
    expect(searchSchema.doc_path_prefix.safeParse('docs/').success).toBe(true);
    expect(searchSchema.doc_kind.safeParse('guide').success).toBe(true);

    expect(searchSchema.path_prefix.safeParse(1).success).toBe(false);
    expect(searchSchema.language.safeParse(false).success).toBe(false);
    expect(searchSchema.kind.safeParse({}).success).toBe(false);
    expect(searchSchema.doc_path_prefix.safeParse([]).success).toBe(false);
    expect(searchSchema.doc_kind.safeParse(5).success).toBe(false);
  });

  it('should route lore_history tool calls through history.handler', async () => {
    const db = new Database(':memory:');
    const embedder = createStubEmbedder();
    const historyResult = { commits: [], count: 0 };
    const historyHandlerSpy = vi.spyOn(history, 'handler').mockResolvedValue(historyResult);

    createLoreMcpServer(db, '/tmp/test.db', embedder);

    const callback = getToolCall('lore_history')[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { mode: 'recent', limit: 5 };
    const response = await callback(args);

    expect(historyHandlerSpy).toHaveBeenCalledWith(db, args, embedder);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(historyResult) }],
    });
    historyHandlerSpy.mockRestore();
  });

  it('should route lore_lookup tool calls through lookup.handler', async () => {
    const db = new Database(':memory:');
    const embedder = createStubEmbedder();
    const lookupResult = { kind: 'symbol', results: [] };
    const lookupHandlerSpy = vi.spyOn(lookup, 'handler').mockResolvedValue(lookupResult);

    createLoreMcpServer(db, '/tmp/test.db', embedder);

    const callback = getToolCall('lore_lookup')[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { kind: 'symbol', query: 'parseConfig' };
    const response = await callback(args);

    expect(lookupHandlerSpy).toHaveBeenCalledWith(db, args, embedder);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(lookupResult) }],
    });
    lookupHandlerSpy.mockRestore();
  });

  it('should route lore_graph tool calls through graph.handler', async () => {
    const db = new Database(':memory:');
    const graphResult = { edges: [], count: 0 };
    const graphHandlerSpy = vi.spyOn(graph, 'handler').mockReturnValue(graphResult);

    createLoreMcpServer(db, '/tmp/test.db');

    const callback = getToolCall('lore_graph')[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { kind: 'call', limit: 10 };
    const response = await callback(args);

    expect(graphHandlerSpy).toHaveBeenCalledWith(db, args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(graphResult) }],
    });
    graphHandlerSpy.mockRestore();
  });

  it('should log error via loggedHandler when underlying handler throws', async () => {
    const db = new Database(':memory:');
    const metricsHandlerSpy = vi.spyOn(metrics, 'handler').mockImplementation(() => {
      throw new Error('metrics exploded');
    });

    createLoreMcpServer(db, '/tmp/test.db');

    const callback = getToolCall('lore_metrics')[3] as (args: unknown) => Promise<unknown>;

    await expect(callback({})).rejects.toThrow('metrics exploded');
    expect(metricsHandlerSpy).toHaveBeenCalled();
    metricsHandlerSpy.mockRestore();
  });

  it('should pass options.logger to loggedHandler', () => {
    const db = new Database(':memory:');
    const customLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      toolCall: vi.fn(),
      startup: vi.fn(),
    };

    // Should not throw
    createLoreMcpServer(db, '/tmp/test.db', undefined, { logger: customLogger as any });

    const toolNames = mockTool.mock.calls.map((call) => call[0]);
    expect(toolNames.length).toBeGreaterThan(0);
  });
});

describe('createLoreMcpServerAsync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should register all tools via async factory', async () => {
    const db = new Database(':memory:');
    await createLoreMcpServerAsync(db, '/tmp/test.db');

    const toolNames = mockTool.mock.calls.map((call: unknown[]) => call[0]);
    expect(toolNames).toContain('lore_lookup');
    expect(toolNames).toContain('lore_graph');
    expect(toolNames).toContain('lore_search');
    expect(toolNames).toContain('lore_analyze');
    expect(toolNames).toContain('lore_history');
    expect(toolNames).toContain('lore_annotations');
  });

  it('should accept embedder and options in async factory', async () => {
    const db = new Database(':memory:');
    const embedder = createStubEmbedder();
    const observer = vi.fn();

    await createLoreMcpServerAsync(db, '/tmp/test.db', embedder, { searchObserver: observer });

    const toolNames = mockTool.mock.calls.map((call: unknown[]) => call[0]);
    expect(toolNames.length).toBeGreaterThan(0);
  });
});