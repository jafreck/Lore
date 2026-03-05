import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { z } from 'zod';
import * as docs from '../../src/kb-server/tools/docs.js';

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

  it('should describe kb_lookup query as including persisted enrichment metadata', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const lookupToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_lookup');
    expect(lookupToolCall).toBeDefined();
    const lookupSchema = lookupToolCall?.[2] as { query: { description?: string; _def?: { description?: string } } };
    expect(schemaDescription(lookupSchema.query)).toContain('persisted enrichment metadata');
  });

  it('should describe kb_search branch as SQLite-only query-time retrieval', () => {
    const db = new Database(':memory:');
    createKbMcpServer(db, '/tmp/test.db');

    const searchToolCall = mockTool.mock.calls.find((call) => call[0] === 'kb_search');
    expect(searchToolCall).toBeDefined();
    const searchSchema = searchToolCall?.[2] as { branch: { description?: string; _def?: { description?: string } } };
    expect(schemaDescription(searchSchema.branch)).toContain('Query-time retrieval uses SQLite-only persisted data');
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
});
