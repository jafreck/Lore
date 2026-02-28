import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const {
  mockTool,
  listCommitCadence,
  listCommitSizes,
  listCommitChurnByFile,
  listCommitAuthorStats,
  listCommitMessagePrefixes,
  listCommitSchedule,
  listCommitBranchActivity,
} = vi.hoisted(() => ({
  mockTool: vi.fn(),
  listCommitCadence: vi.fn(),
  listCommitSizes: vi.fn(),
  listCommitChurnByFile: vi.fn(),
  listCommitAuthorStats: vi.fn(),
  listCommitMessagePrefixes: vi.fn(),
  listCommitSchedule: vi.fn(),
  listCommitBranchActivity: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool = mockTool;
  },
}));

vi.mock('../../src/kb-server/db.js', () => ({
  listCommitCadence,
  listCommitSizes,
  listCommitChurnByFile,
  listCommitAuthorStats,
  listCommitMessagePrefixes,
  listCommitSchedule,
  listCommitBranchActivity,
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

  it('should register kb_commit_stats schema with expected metric and optional filters', () => {
    const db = new Database(':memory:');

    createKbMcpServer(db, '/tmp/test.db');

    const commitStatsCall = mockTool.mock.calls.find((call) => call[0] === 'kb_commit_stats');
    expect(commitStatsCall).toBeDefined();

    const schema = commitStatsCall?.[2] as {
      metric: { safeParse: (v: unknown) => { success: boolean } };
      limit: { safeParse: (v: unknown) => { success: boolean } };
      since: { safeParse: (v: unknown) => { success: boolean } };
      until: { safeParse: (v: unknown) => { success: boolean } };
      author: { safeParse: (v: unknown) => { success: boolean } };
    };

    expect(schema.metric.safeParse('cadence').success).toBe(true);
    expect(schema.metric.safeParse('size').success).toBe(true);
    expect(schema.metric.safeParse('churn').success).toBe(true);
    expect(schema.metric.safeParse('authors').success).toBe(true);
    expect(schema.metric.safeParse('messages').success).toBe(true);
    expect(schema.metric.safeParse('schedule').success).toBe(true);
    expect(schema.metric.safeParse('branches').success).toBe(true);
    expect(schema.metric.safeParse('recent').success).toBe(false);

    expect(schema.limit.safeParse(20).success).toBe(true);
    expect(schema.limit.safeParse('20').success).toBe(false);
    expect(schema.since.safeParse('2026-01-01').success).toBe(true);
    expect(schema.until.safeParse('2026-01-31').success).toBe(true);
    expect(schema.author.safeParse('alice@example.com').success).toBe(true);
  });

  it('should return cadence analytics and forward optional filters for kb_commit_stats', async () => {
    const db = new Database(':memory:');
    const filters = {
      limit: 25,
      since: '2026-01-01',
      until: '2026-01-31',
      author: 'alice',
    };
    listCommitCadence
      .mockReturnValueOnce([{ bucket: '2026-01-01', commits: 2 }])
      .mockReturnValueOnce([{ bucket: '2026-W01', commits: 4 }])
      .mockReturnValueOnce([{ bucket: '2026-01', commits: 8 }]);

    createKbMcpServer(db, '/tmp/test.db');
    const commitStatsCall = mockTool.mock.calls.find((call) => call[0] === 'kb_commit_stats');
    const handler = commitStatsCall?.[3] as (args: unknown) => Promise<{ content: Array<{ text: string }> }>;

    const result = await handler({ metric: 'cadence', ...filters });
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload).toEqual({
      metric: 'cadence',
      day: [{ bucket: '2026-01-01', commits: 2 }],
      week: [{ bucket: '2026-W01', commits: 4 }],
      month: [{ bucket: '2026-01', commits: 8 }],
    });
    expect(listCommitCadence).toHaveBeenNthCalledWith(1, db, 'day', filters);
    expect(listCommitCadence).toHaveBeenNthCalledWith(2, db, 'week', filters);
    expect(listCommitCadence).toHaveBeenNthCalledWith(3, db, 'month', filters);
  });

  it('should return size analytics without optional filters for kb_commit_stats', async () => {
    const db = new Database(':memory:');
    listCommitSizes.mockReturnValue([{ sha: 'abc', additions: 3, deletions: 1 }]);

    createKbMcpServer(db, '/tmp/test.db');
    const commitStatsCall = mockTool.mock.calls.find((call) => call[0] === 'kb_commit_stats');
    const handler = commitStatsCall?.[3] as (args: unknown) => Promise<{ content: Array<{ text: string }> }>;

    const result = await handler({ metric: 'size' });
    const payload = JSON.parse(result.content[0]!.text);

    expect(payload).toEqual({
      metric: 'size',
      commits: [{ sha: 'abc', additions: 3, deletions: 1 }],
    });
    expect(listCommitSizes).toHaveBeenCalledWith(db, {
      limit: undefined,
      since: undefined,
      until: undefined,
      author: undefined,
    });
  });
});
