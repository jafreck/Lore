import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { z } from 'zod';
import * as docs from '../../src/kb-server/tools/docs.js';
import * as lookup from '../../src/kb-server/tools/lookup.js';
import * as graph from '../../src/kb-server/tools/graph.js';
import type { EmbeddingProvider } from '../../src/indexer/embedder.js';
import * as history from '../../src/kb-server/tools/history.js';
import type { EmbeddingProvider } from '../../src/indexer/embedder.js';
import * as annotations from '../../src/kb-server/tools/annotations.js';
import * as routes from '../../src/kb-server/tools/routes.js';
import * as notes from '../../src/kb-server/tools/notes.js';
import * as architecture from '../../src/kb-server/tools/architecture.js';
import * as search from '../../src/kb-server/tools/search.js';
import * as metrics from '../../src/kb-server/tools/metrics.js';

const {
  mockTool,
  mockListCommitCadence,
  mockListCommitSizes,
  mockListCommitChurnByFile,
  mockListCommitAuthorStats,
  mockListCommitMessagePrefixes,
  mockListCommitSchedule,
  mockListCommitBranchActivity,
} = vi.hoisted(() => ({
  mockTool: vi.fn(),
  mockListCommitCadence: vi.fn(),
  mockListCommitSizes: vi.fn(),
  mockListCommitChurnByFile: vi.fn(),
  mockListCommitAuthorStats: vi.fn(),
  mockListCommitMessagePrefixes: vi.fn(),
  mockListCommitSchedule: vi.fn(),
  mockListCommitBranchActivity: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool = mockTool;
  },
}));

vi.mock('../../src/kb-server/db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/kb-server/db.js')>('../../src/kb-server/db.js');
  return {
    ...actual,
    listCommitCadence: mockListCommitCadence,
    listCommitSizes: mockListCommitSizes,
    listCommitChurnByFile: mockListCommitChurnByFile,
    listCommitAuthorStats: mockListCommitAuthorStats,
    listCommitMessagePrefixes: mockListCommitMessagePrefixes,
    listCommitSchedule: mockListCommitSchedule,
    listCommitBranchActivity: mockListCommitBranchActivity,
  };
});

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

function getToolCall(name: string): unknown[] {
  const toolCall = mockTool.mock.calls.find((call) => call[0] === name);
  expect(toolCall).toBeDefined();
  return toolCall!;
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

  it('should register newly exposed MCP tools', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const toolNames = mockTool.mock.calls.map((call) => call[0]);
    expect(toolNames).toContain('kb_annotations');
    expect(toolNames).toContain('kb_routes');
    expect(toolNames).toContain('kb_notes_write');
    expect(toolNames).toContain('kb_notes_read');
    expect(toolNames).toContain('kb_architecture');
  });

  it('should register newly exposed tools with expected schema fields', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const annotationsSchema = getToolCall('kb_annotations')[2] as {
      kind: { safeParse: (v: unknown) => { success: boolean } };
      path: { safeParse: (v: unknown) => { success: boolean } };
      limit: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(annotationsSchema.kind.safeParse('TODO').success).toBe(true);
    expect(annotationsSchema.path.safeParse('src/server.ts').success).toBe(true);
    expect(annotationsSchema.limit.safeParse(10).success).toBe(true);
    expect(annotationsSchema.kind.safeParse('INVALID').success).toBe(false);

    const routesSchema = getToolCall('kb_routes')[2] as {
      method: { safeParse: (v: unknown) => { success: boolean } };
      path_prefix: { safeParse: (v: unknown) => { success: boolean } };
      framework: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(routesSchema.method.safeParse('GET').success).toBe(true);
    expect(routesSchema.path_prefix.safeParse('/api').success).toBe(true);
    expect(routesSchema.framework.safeParse('express').success).toBe(true);
    expect(routesSchema.method.safeParse(123).success).toBe(false);

    const notesWriteSchema = getToolCall('kb_notes_write')[2] as {
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

    const notesReadSchema = getToolCall('kb_notes_read')[2] as {
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

    const architectureSchema = getToolCall('kb_architecture')[2] as {
      depth: { safeParse: (v: unknown) => { success: boolean } };
      branch: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(architectureSchema.depth.safeParse(2).success).toBe(true);
    expect(architectureSchema.branch.safeParse('main').success).toBe(true);
    expect(architectureSchema.depth.safeParse('2').success).toBe(false);
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

  it('should route kb_annotations tool calls through annotations.handler', async () => {
    const db = new Database(':memory:');
    const annotationsResult = { results: [{ kind: 'TODO', text: 'todo', path: 'src/a.ts', line: 1 }] };
    const annotationsHandlerSpy = vi.spyOn(annotations, 'handler').mockReturnValue(annotationsResult);

    createKbMcpServer(db, '/tmp/test.db');

    const callback = getToolCall('kb_annotations')[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { kind: 'TODO', limit: 5 };
    const response = await callback(args);

    expect(annotationsHandlerSpy).toHaveBeenCalledWith(db, args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(annotationsResult) }],
    });
  });

  it('should route kb_routes tool calls through routes.handler', async () => {
    const db = new Database(':memory:');
    const routesResult = { results: [{ method: 'GET', path: '/api/health', framework: 'express' }] };
    const routesHandlerSpy = vi.spyOn(routes, 'handler').mockReturnValue(routesResult);

    createKbMcpServer(db, '/tmp/test.db');

    const callback = getToolCall('kb_routes')[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { method: 'GET', path_prefix: '/api', framework: 'express' };
    const response = await callback(args);

    expect(routesHandlerSpy).toHaveBeenCalledWith(db, args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(routesResult) }],
    });
  });

  it('should route kb_notes_write tool calls through notes.writeHandler', async () => {
    const db = new Database(':memory:');
    const notesWriteResult = { ok: true, key: 'architecture/overview', scope: 'global', updated_at: 123 };
    const notesWriteHandlerSpy = vi.spyOn(notes, 'writeHandler').mockReturnValue(notesWriteResult);

    createKbMcpServer(db, '/tmp/test.db');

    const callback = getToolCall('kb_notes_write')[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { key: 'architecture/overview', content: 'note body', model: 'test-model' };
    const response = await callback(args);

    expect(notesWriteHandlerSpy).toHaveBeenCalledWith('/tmp/test.db', args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(notesWriteResult) }],
    });
  });

  it('should route kb_notes_read tool calls through notes.readHandler', async () => {
    const db = new Database(':memory:');
    const notesReadResult = { notes: [], count: 0 };
    const notesReadHandlerSpy = vi.spyOn(notes, 'readHandler').mockReturnValue(notesReadResult);

    createKbMcpServer(db, '/tmp/test.db');

    const callback = getToolCall('kb_notes_read')[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { key_prefix: 'architecture/', limit: 5 };
    const response = await callback(args);

    expect(notesReadHandlerSpy).toHaveBeenCalledWith(db, args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(notesReadResult) }],
    });
  });

  it('should route kb_architecture tool calls through architecture.handler', async () => {
    const db = new Database(':memory:');
    const architectureResult = {
      components: [],
      edges: [],
      entry_points: [],
      leaf_nodes: [],
      external_deps: [],
    };
    const architectureHandlerSpy = vi.spyOn(architecture, 'handler').mockReturnValue(architectureResult);

    createKbMcpServer(db, '/tmp/test.db');

    const callback = getToolCall('kb_architecture')[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const args = { depth: 3, branch: 'main' };
    const response = await callback(args);

    expect(architectureHandlerSpy).toHaveBeenCalledWith(db, args);
    expect(response).toEqual({
      content: [{ type: 'text', text: JSON.stringify(architectureResult) }],
    });
  });

  it('should route kb_search tool calls through search.handler with filter args and observer', async () => {
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
      createKbMcpServer(db, '/tmp/test.db', embedder, { searchObserver: observer });

      const searchToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_search');
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
      annotations: { kind: 'TODO' },
      routes: { method: 'GET' },
      notesWrite: { key: 'architecture/overview', content: 'note body' },
      notesRead: { key_prefix: 'architecture/' },
      architecture: { depth: 2 },
    };
    const annotationError = new Error('annotations failed');
    const routeError = new Error('routes failed');
    const notesWriteError = new Error('notes write failed');
    const notesReadError = new Error('notes read failed');
    const architectureError = new Error('architecture failed');

    vi.spyOn(annotations, 'handler').mockImplementation(() => {
      throw annotationError;
    });
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

    createKbMcpServer(db, '/tmp/test.db');

    const annotationsCallback = getToolCall('kb_annotations')[3] as (args: unknown) => Promise<unknown>;
    const routesCallback = getToolCall('kb_routes')[3] as (args: unknown) => Promise<unknown>;
    const notesWriteCallback = getToolCall('kb_notes_write')[3] as (args: unknown) => Promise<unknown>;
    const notesReadCallback = getToolCall('kb_notes_read')[3] as (args: unknown) => Promise<unknown>;
    const architectureCallback = getToolCall('kb_architecture')[3] as (args: unknown) => Promise<unknown>;

    await expect(annotationsCallback(callbackArgs.annotations)).rejects.toThrow(annotationError);
    await expect(routesCallback(callbackArgs.routes)).rejects.toThrow(routeError);
    await expect(notesWriteCallback(callbackArgs.notesWrite)).rejects.toThrow(notesWriteError);
    await expect(notesReadCallback(callbackArgs.notesRead)).rejects.toThrow(notesReadError);
    await expect(architectureCallback(callbackArgs.architecture)).rejects.toThrow(architectureError);
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

  it('should register kb_lookup with optional match/filter/pagination fields', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const lookupToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_lookup');
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

  it('should describe kb_search branch as SQLite-only query-time retrieval', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const searchToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_search');
    expect(searchToolCall).toBeDefined();
    const searchSchema = searchToolCall?.[2] as { branch: { description?: string; _def?: { description?: string } } };
    expect(schemaDescription(searchSchema.branch)).toContain('Query-time retrieval uses SQLite-only persisted data');
  });

  it('should route kb_history tool calls through history.handler with embedder', async () => {
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

    createKbMcpServer(db, '/tmp/test.db', embedder);

    const historyToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_history');
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

  it('should register kb_history with semantic mode support', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const historyToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_history');
    expect(historyToolCall).toBeDefined();

    const historySchema = historyToolCall?.[2] as {
      mode: { safeParse: (v: unknown) => { success: boolean } };
    };
    expect(historySchema.mode.safeParse('file').success).toBe(true);
    expect(historySchema.mode.safeParse('semantic').success).toBe(true);
    expect(historySchema.mode.safeParse('invalid').success).toBe(false);
  });

  it('should register kb_blame schema with extended modes while preserving legacy line/range payloads', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const blameToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_blame');
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

  it('should register kb_commit_stats with expected metric and filter schema fields', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const commitStatsToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_commit_stats');
    expect(commitStatsToolCall).toBeDefined();

    const commitStatsSchema = commitStatsToolCall?.[2] as {
      metric: z.ZodTypeAny;
      limit: z.ZodTypeAny;
      since: z.ZodTypeAny;
      until: z.ZodTypeAny;
      author: z.ZodTypeAny;
    };
    expect(commitStatsSchema.metric.safeParse('cadence').success).toBe(true);
    expect(commitStatsSchema.metric.safeParse('size').success).toBe(true);
    expect(commitStatsSchema.metric.safeParse('churn').success).toBe(true);
    expect(commitStatsSchema.metric.safeParse('authors').success).toBe(true);
    expect(commitStatsSchema.metric.safeParse('messages').success).toBe(true);
    expect(commitStatsSchema.metric.safeParse('schedule').success).toBe(true);
    expect(commitStatsSchema.metric.safeParse('branches').success).toBe(true);
    expect(commitStatsSchema.limit.safeParse(25).success).toBe(true);
    expect(commitStatsSchema.since.safeParse('2025-01-01').success).toBe(true);
    expect(commitStatsSchema.until.safeParse('2025-01-31').success).toBe(true);
    expect(commitStatsSchema.author.safeParse('jane').success).toBe(true);
    expect(commitStatsSchema.metric.safeParse('invalid').success).toBe(false);
    expect(commitStatsSchema.limit.safeParse('25').success).toBe(false);
  });

  it('should route kb_commit_stats cadence metric to day, week, and month cadence queries', async () => {
    const db = new Database(':memory:');
    const filters = {
      limit: 10,
      since: '2025-01-01',
      until: '2025-01-31',
      author: 'jane',
    };
    mockListCommitCadence.mockImplementation((_db, granularity) => [{ bucket: String(granularity), commits: 1 }]);

    createKbMcpServer(db, '/tmp/test.db');

    const commitStatsToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_commit_stats');
    expect(commitStatsToolCall).toBeDefined();

    const commitStatsCallback = commitStatsToolCall?.[3] as (args: unknown) => Promise<{
      content: Array<{ type: string; text: string }>;
    }>;
    const response = await commitStatsCallback({ metric: 'cadence', ...filters });
    const payload = JSON.parse(response.content[0]!.text);

    expect(mockListCommitCadence).toHaveBeenCalledTimes(3);
    expect(mockListCommitCadence).toHaveBeenNthCalledWith(1, db, 'day', filters);
    expect(mockListCommitCadence).toHaveBeenNthCalledWith(2, db, 'week', filters);
    expect(mockListCommitCadence).toHaveBeenNthCalledWith(3, db, 'month', filters);
    expect(payload).toEqual({
      metric: 'cadence',
      day: [{ bucket: 'day', commits: 1 }],
      week: [{ bucket: 'week', commits: 1 }],
      month: [{ bucket: 'month', commits: 1 }],
    });
  });

  it.each([
    ['size', mockListCommitSizes, 'commits'],
    ['churn', mockListCommitChurnByFile, 'files'],
    ['authors', mockListCommitAuthorStats, 'authors'],
    ['messages', mockListCommitMessagePrefixes, 'prefixes'],
    ['schedule', mockListCommitSchedule, 'buckets'],
    ['branches', mockListCommitBranchActivity, 'refs'],
  ] as const)(
    'should route kb_commit_stats %s metric through its metric query',
    async (metric, metricQueryMock, responseKey) => {
      const db = new Database(':memory:');
      const filters = {
        limit: 15,
        since: '2025-02-01',
        until: '2025-02-28',
        author: 'alex',
      };
      const metricRows = [{ id: `${metric}-row` }];
      metricQueryMock.mockReturnValue(metricRows);

      createKbMcpServer(db, '/tmp/test.db');

      const commitStatsToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_commit_stats');
      expect(commitStatsToolCall).toBeDefined();

      const commitStatsCallback = commitStatsToolCall?.[3] as (args: unknown) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
      const response = await commitStatsCallback({ metric, ...filters });
      const payload = JSON.parse(response.content[0]!.text);

      expect(metricQueryMock).toHaveBeenCalledTimes(1);
      expect(metricQueryMock).toHaveBeenCalledWith(db, filters);
      expect(payload).toEqual({
        metric,
        [responseKey]: metricRows,
      });
    },
  );

  it('should register kb_search schema fields for symbol and doc filters', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const searchToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_search');
    expect(searchToolCall).toBeDefined();

    const searchSchema = searchToolCall?.[2] as {
      path_prefix: { safeParse: (v: unknown) => { success: boolean } };
      language: { safeParse: (v: unknown) => { success: boolean } };
      kind: { safeParse: (v: unknown) => { success: boolean } };
      doc_path_prefix: { safeParse: (v: unknown) => { success: boolean } };
      doc_kind: { safeParse: (v: unknown) => { success: boolean } };
    };

    expect(searchSchema.path_prefix.safeParse('src/kb-server').success).toBe(true);
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
});
