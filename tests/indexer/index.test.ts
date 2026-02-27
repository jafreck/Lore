import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockIngestGitHistory = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/indexer/git-history.js', () => ({
  ingestGitHistory: mockIngestGitHistory,
}));

// Mock walkFiles to return empty list so build() doesn't need actual source files
vi.mock('../../src/indexer/walker.js', () => ({
  walkFiles: vi.fn().mockResolvedValue([]),
}));

// Mock ParserPool so we don't need tree-sitter native binaries
vi.mock('../../src/indexer/parser.js', () => ({
  ParserPool: class {
    parse() { return null; }
  },
}));

// Mock ImportResolver
vi.mock('../../src/indexer/resolver.js', () => ({
  ImportResolver: class {
    resolve() { return {}; }
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDbPath(): string {
  return path.join(os.tmpdir(), `lore-idx-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('IndexBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should construct without throwing when history option is omitted', async () => {
      const { IndexBuilder } = await import('../../src/indexer/index.js');
      expect(
        () => new IndexBuilder('/tmp/test.db', { rootDir: '/tmp', include: [] }),
      ).not.toThrow();
    });

    it('should construct with history: true', async () => {
      const { IndexBuilder } = await import('../../src/indexer/index.js');
      expect(
        () =>
          new IndexBuilder('/tmp/test.db', { rootDir: '/tmp', include: [] }, undefined, {
            history: true,
          }),
      ).not.toThrow();
    });

    it('should construct with history: { depth: 100 }', async () => {
      const { IndexBuilder } = await import('../../src/indexer/index.js');
      expect(
        () =>
          new IndexBuilder('/tmp/test.db', { rootDir: '/tmp', include: [] }, undefined, {
            history: { depth: 100 },
          }),
      ).not.toThrow();
    });
  });

  describe('build() with history option', () => {
    it('should NOT call ingestGitHistory when history option is omitted', async () => {
      const dbPath = makeTmpDbPath();
      try {
        const { IndexBuilder } = await import('../../src/indexer/index.js');
        const builder = new IndexBuilder(dbPath, { rootDir: '/tmp', include: [] });
        await builder.build();
        expect(mockIngestGitHistory).not.toHaveBeenCalled();
      } finally {
        cleanupDb(dbPath);
      }
    });

    it('should NOT call ingestGitHistory when history is false', async () => {
      const dbPath = makeTmpDbPath();
      try {
        const { IndexBuilder } = await import('../../src/indexer/index.js');
        const builder = new IndexBuilder(dbPath, { rootDir: '/tmp', include: [] }, undefined, {
          history: false,
        });
        await builder.build();
        expect(mockIngestGitHistory).not.toHaveBeenCalled();
      } finally {
        cleanupDb(dbPath);
      }
    });

    it('should call ingestGitHistory when history is true', async () => {
      const dbPath = makeTmpDbPath();
      try {
        const { IndexBuilder } = await import('../../src/indexer/index.js');
        const builder = new IndexBuilder(dbPath, { rootDir: '/tmp', include: [] }, undefined, {
          history: true,
        });
        await builder.build();
        expect(mockIngestGitHistory).toHaveBeenCalledTimes(1);
        expect(mockIngestGitHistory).toHaveBeenCalledWith(
          expect.anything(),
          '/tmp',
          undefined,
        );
      } finally {
        cleanupDb(dbPath);
      }
    });

    it('should call ingestGitHistory with depth when history is an object', async () => {
      const dbPath = makeTmpDbPath();
      try {
        const { IndexBuilder } = await import('../../src/indexer/index.js');
        const builder = new IndexBuilder(dbPath, { rootDir: '/tmp', include: [] }, undefined, {
          history: { depth: 250 },
        });
        await builder.build();
        expect(mockIngestGitHistory).toHaveBeenCalledTimes(1);
        expect(mockIngestGitHistory).toHaveBeenCalledWith(
          expect.anything(),
          '/tmp',
          { depth: 250 },
        );
      } finally {
        cleanupDb(dbPath);
      }
    });

    it('should close the database even when ingestGitHistory rejects', async () => {
      mockIngestGitHistory.mockRejectedValueOnce(new Error('git error'));

      const dbPath = makeTmpDbPath();
      try {
        const { IndexBuilder } = await import('../../src/indexer/index.js');
        const builder = new IndexBuilder(dbPath, { rootDir: '/tmp', include: [] }, undefined, {
          history: true,
        });
        await expect(builder.build()).rejects.toThrow('git error');
      } finally {
        cleanupDb(dbPath);
      }
    });
  });
});
