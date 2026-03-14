import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  handler,
  toolDef,
  type CohesionArgs,
  type CohesionResult,
  type DirectoryCohesion,
} from '../../../src/server/tools/cohesion.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT    NOT NULL,
      branch      TEXT    NOT NULL DEFAULT '',
      language    TEXT    NOT NULL DEFAULT 'typescript',
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      last_hash   TEXT,
      indexed_at  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(path, branch)
    );
    CREATE TABLE symbols (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL DEFAULT 'function',
      start_line  INTEGER NOT NULL DEFAULT 1,
      end_line    INTEGER NOT NULL DEFAULT 10,
      signature   TEXT,
      doc_comment TEXT
    );
    CREATE TABLE symbol_refs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
      callee_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
      kind        TEXT    NOT NULL DEFAULT 'call',
      ref_line    INTEGER NOT NULL DEFAULT 1,
      ref_column  INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function insertFile(db: Database.Database, path: string): number {
  return db
    .prepare('INSERT INTO files (path, branch, language) VALUES (?, ?, ?)')
    .run(path, '', 'typescript').lastInsertRowid as number;
}

function insertSymbol(db: Database.Database, fileId: number, name: string): number {
  return db
    .prepare('INSERT INTO symbols (file_id, name, kind) VALUES (?, ?, ?)')
    .run(fileId, name, 'function').lastInsertRowid as number;
}

function insertResolvedRef(db: Database.Database, callerId: number, calleeId: number): void {
  db.prepare('INSERT INTO symbol_refs (caller_id, callee_id) VALUES (?, ?)').run(
    callerId,
    calleeId,
  );
}

function insertUnresolvedRef(db: Database.Database, callerId: number): void {
  db.prepare('INSERT INTO symbol_refs (caller_id, callee_id) VALUES (?, NULL)').run(callerId);
}

// ─── toolDef ──────────────────────────────────────────────────────────────────

describe('lore_cohesion toolDef', () => {
  it('should have the correct tool name', () => {
    expect(toolDef.name).toBe('lore_cohesion');
  });

  it('should define depth as an optional integer with minimum 1', () => {
    const depth = toolDef.inputSchema.properties.depth;
    expect(depth.type).toBe('integer');
    expect(depth.minimum).toBe(1);
  });

  it('should define limit as an optional number', () => {
    const limit = toolDef.inputSchema.properties.limit;
    expect(limit.type).toBe('number');
  });

  it('should have no required properties', () => {
    expect(toolDef.inputSchema.required).toEqual([]);
  });
});

// ─── handler — basic behavior ─────────────────────────────────────────────────

describe('cohesion handler', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.open && db.close();
  });

  it('should return empty directories array when no symbol_refs exist', () => {
    db = createTestDb();
    const result = handler(db, {});
    expect(result.directories).toEqual([]);
  });

  it('should exclude unresolved symbol_refs (callee_id IS NULL)', () => {
    db = createTestDb();
    const f1 = insertFile(db, 'src/server/a.ts');
    const s1 = insertSymbol(db, f1, 'funcA');
    insertUnresolvedRef(db, s1);

    const result = handler(db, {});
    expect(result.directories).toEqual([]);
  });

  describe('single-directory (internal edges only)', () => {
    beforeEach(() => {
      db = createTestDb();
      const f1 = insertFile(db, 'src/server/a.ts');
      const f2 = insertFile(db, 'src/server/b.ts');
      const s1 = insertSymbol(db, f1, 'funcA');
      const s2 = insertSymbol(db, f2, 'funcB');
      // Both files share the "src/server" directory at depth 2.
      insertResolvedRef(db, s1, s2);
      insertResolvedRef(db, s2, s1);
    });

    it('should compute cohesion=1 when all edges are internal', () => {
      const result = handler(db, { depth: 2 });
      expect(result.directories).toHaveLength(1);
      const dir = result.directories[0]!;
      expect(dir.directory).toBe('src/server');
      expect(dir.internal_edges).toBe(2);
      expect(dir.external_inbound).toBe(0);
      expect(dir.external_outbound).toBe(0);
      expect(dir.cohesion).toBe(1);
      expect(dir.instability).toBe(0);
      expect(dir.file_count).toBe(2);
    });
  });

  describe('cross-directory edges', () => {
    beforeEach(() => {
      db = createTestDb();
      // Directory A: src/alpha
      const fA1 = insertFile(db, 'src/alpha/a1.ts');
      const sA1 = insertSymbol(db, fA1, 'alphaFunc');
      // Directory B: src/beta
      const fB1 = insertFile(db, 'src/beta/b1.ts');
      const sB1 = insertSymbol(db, fB1, 'betaFunc');

      // A calls B (cross-directory: outbound for alpha, inbound for beta)
      insertResolvedRef(db, sA1, sB1);
    });

    it('should compute cohesion=0 for a directory with only outbound edges', () => {
      const result = handler(db, { depth: 2 });
      const alpha = result.directories.find((d) => d.directory === 'src/alpha')!;
      expect(alpha).toBeDefined();
      expect(alpha.internal_edges).toBe(0);
      expect(alpha.external_outbound).toBe(1);
      expect(alpha.cohesion).toBe(0);
      expect(alpha.instability).toBe(1);
    });

    it('should compute cohesion=0 and instability=0 for a directory with only inbound edges', () => {
      const result = handler(db, { depth: 2 });
      const beta = result.directories.find((d) => d.directory === 'src/beta')!;
      expect(beta).toBeDefined();
      expect(beta.internal_edges).toBe(0);
      expect(beta.external_inbound).toBe(1);
      expect(beta.external_outbound).toBe(0);
      expect(beta.cohesion).toBe(0);
      expect(beta.instability).toBe(0);
    });

    it('should sort by cohesion ascending (worst first)', () => {
      // Add internal edges to beta so it has better cohesion
      const fB2 = insertFile(db, 'src/beta/b2.ts');
      const sB2 = insertSymbol(db, fB2, 'betaFunc2');
      const fB1 = db.prepare("SELECT id FROM files WHERE path = 'src/beta/b1.ts'").get() as {
        id: number;
      };
      const sB1 = db.prepare(`SELECT id FROM symbols WHERE file_id = ?`).get(fB1.id) as {
        id: number;
      };
      insertResolvedRef(db, sB1.id, sB2);

      const result = handler(db, { depth: 2 });
      // alpha: cohesion=0 (only outbound), beta: cohesion = 1/(1+0)=1 internal / (internal + outbound)
      // alpha should come first
      expect(result.directories[0]!.directory).toBe('src/alpha');
    });
  });

  describe('mixed internal and external edges', () => {
    it('should compute correct cohesion and instability ratios', () => {
      db = createTestDb();
      const fA = insertFile(db, 'src/core/a.ts');
      const fB = insertFile(db, 'src/core/b.ts');
      const fC = insertFile(db, 'src/utils/c.ts');
      const sA = insertSymbol(db, fA, 'coreA');
      const sB = insertSymbol(db, fB, 'coreB');
      const sC = insertSymbol(db, fC, 'utilC');

      // 2 internal edges in src/core
      insertResolvedRef(db, sA, sB);
      insertResolvedRef(db, sB, sA);
      // 1 outbound edge from src/core to src/utils
      insertResolvedRef(db, sA, sC);

      const result = handler(db, { depth: 2 });
      const core = result.directories.find((d) => d.directory === 'src/core')!;
      // cohesion = internal / (internal + outbound) = 2 / (2 + 1) ≈ 0.6667
      expect(core.cohesion).toBeCloseTo(2 / 3, 5);
      // instability = outbound / (inbound + outbound) = 1 / (0 + 1) = 1
      expect(core.instability).toBe(1);
      expect(core.file_count).toBe(2);
    });
  });

  describe('depth parameter', () => {
    it('should group by 1 path segment when depth=1', () => {
      db = createTestDb();
      const f1 = insertFile(db, 'src/alpha/a.ts');
      const f2 = insertFile(db, 'src/beta/b.ts');
      const s1 = insertSymbol(db, f1, 'funcA');
      const s2 = insertSymbol(db, f2, 'funcB');
      insertResolvedRef(db, s1, s2);

      const result = handler(db, { depth: 1 });
      // Both files are under "src" at depth 1 — this should be an internal edge
      expect(result.directories).toHaveLength(1);
      expect(result.directories[0]!.directory).toBe('src');
      expect(result.directories[0]!.internal_edges).toBe(1);
    });

    it('should default depth to 2', () => {
      db = createTestDb();
      const f1 = insertFile(db, 'src/alpha/a.ts');
      const f2 = insertFile(db, 'src/beta/b.ts');
      const s1 = insertSymbol(db, f1, 'funcA');
      const s2 = insertSymbol(db, f2, 'funcB');
      insertResolvedRef(db, s1, s2);

      const result = handler(db, {});
      // At depth 2: "src/alpha" vs "src/beta" — cross-directory
      expect(result.directories).toHaveLength(2);
      const dirs = result.directories.map((d) => d.directory).sort();
      expect(dirs).toEqual(['src/alpha', 'src/beta']);
    });

    it('should clamp depth to minimum of 1', () => {
      db = createTestDb();
      const f1 = insertFile(db, 'src/a.ts');
      const f2 = insertFile(db, 'lib/b.ts');
      const s1 = insertSymbol(db, f1, 'funcA');
      const s2 = insertSymbol(db, f2, 'funcB');
      insertResolvedRef(db, s1, s2);

      // depth=0 should be clamped to 1
      const result = handler(db, { depth: 0 });
      expect(result.directories.length).toBeGreaterThanOrEqual(1);
      // At depth=1, dirs are "src" and "lib"
      const dirs = result.directories.map((d) => d.directory).sort();
      expect(dirs).toEqual(['lib', 'src']);
    });

    it('should handle depth greater than path segments', () => {
      db = createTestDb();
      const f1 = insertFile(db, 'a.ts');
      const f2 = insertFile(db, 'b.ts');
      const s1 = insertSymbol(db, f1, 'funcA');
      const s2 = insertSymbol(db, f2, 'funcB');
      insertResolvedRef(db, s1, s2);

      // depth=5 but files are at root level — truncation gives "a.ts" and "b.ts"
      const result = handler(db, { depth: 5 });
      expect(result.directories).toHaveLength(2);
    });
  });

  describe('limit parameter', () => {
    it('should default limit to 20', () => {
      db = createTestDb();
      // Create 25 different directories
      for (let i = 0; i < 25; i++) {
        const fSrc = insertFile(db, `dir${i}/mod/src.ts`);
        const fDst = insertFile(db, `dir${i}/mod/dst.ts`);
        const sSrc = insertSymbol(db, fSrc, `func${i}a`);
        const sDst = insertSymbol(db, fDst, `func${i}b`);
        insertResolvedRef(db, sSrc, sDst);
      }
      const result = handler(db, {});
      expect(result.directories.length).toBeLessThanOrEqual(20);
    });

    it('should respect explicit limit', () => {
      db = createTestDb();
      for (let i = 0; i < 5; i++) {
        const f = insertFile(db, `pkg${i}/mod/a.ts`);
        const g = insertFile(db, `pkg${i}/mod/b.ts`);
        const s1 = insertSymbol(db, f, `fn${i}a`);
        const s2 = insertSymbol(db, g, `fn${i}b`);
        insertResolvedRef(db, s1, s2);
      }
      const result = handler(db, { limit: 3 });
      expect(result.directories.length).toBeLessThanOrEqual(3);
    });

    it('should clamp limit to maximum of 200', () => {
      db = createTestDb();
      const f1 = insertFile(db, 'src/a/x.ts');
      const f2 = insertFile(db, 'src/a/y.ts');
      const s1 = insertSymbol(db, f1, 'funcA');
      const s2 = insertSymbol(db, f2, 'funcB');
      insertResolvedRef(db, s1, s2);

      // Should not throw; limit is clamped
      const result = handler(db, { limit: 999 });
      expect(result.directories.length).toBeGreaterThanOrEqual(1);
    });

    it('should clamp limit to minimum of 1', () => {
      db = createTestDb();
      const f1 = insertFile(db, 'src/a/x.ts');
      const f2 = insertFile(db, 'src/a/y.ts');
      const s1 = insertSymbol(db, f1, 'funcA');
      const s2 = insertSymbol(db, f2, 'funcB');
      insertResolvedRef(db, s1, s2);

      const result = handler(db, { limit: -5 });
      // Clamped to 1 — should return at most 1 directory
      expect(result.directories.length).toBeLessThanOrEqual(1);
    });
  });

  describe('file_count tracking', () => {
    it('should count distinct files per directory', () => {
      db = createTestDb();
      const f1 = insertFile(db, 'src/core/a.ts');
      const f2 = insertFile(db, 'src/core/b.ts');
      const f3 = insertFile(db, 'src/core/c.ts');
      const s1 = insertSymbol(db, f1, 'fn1');
      const s2 = insertSymbol(db, f2, 'fn2');
      const s3 = insertSymbol(db, f3, 'fn3');
      insertResolvedRef(db, s1, s2);
      insertResolvedRef(db, s2, s3);
      insertResolvedRef(db, s3, s1);

      const result = handler(db, { depth: 2 });
      const core = result.directories.find((d) => d.directory === 'src/core')!;
      expect(core.file_count).toBe(3);
    });
  });

  describe('edge cases', () => {
    it('should handle self-referencing edges within the same file', () => {
      db = createTestDb();
      const f1 = insertFile(db, 'src/core/a.ts');
      const s1 = insertSymbol(db, f1, 'funcA');
      const s2 = insertSymbol(db, f1, 'funcB');
      insertResolvedRef(db, s1, s2);

      const result = handler(db, { depth: 2 });
      expect(result.directories).toHaveLength(1);
      expect(result.directories[0]!.internal_edges).toBe(1);
      expect(result.directories[0]!.cohesion).toBe(1);
    });

    it('should return CohesionResult type shape', () => {
      db = createTestDb();
      const result: CohesionResult = handler(db, {});
      expect(result).toHaveProperty('directories');
      expect(Array.isArray(result.directories)).toBe(true);
    });

    it('should handle directories with zero denominator for cohesion and instability', () => {
      // This edge case is hard to hit since we skip zero-total-edge dirs,
      // but verify the formula handles it defensively if internal=0 and outbound=0
      // (which would mean inbound-only). Check instability = 0 when inbound-only.
      db = createTestDb();
      const fA = insertFile(db, 'src/alpha/a.ts');
      const fB = insertFile(db, 'src/beta/b.ts');
      const sA = insertSymbol(db, fA, 'alphaFn');
      const sB = insertSymbol(db, fB, 'betaFn');
      // beta -> alpha (alpha only has inbound, no outbound or internal)
      insertResolvedRef(db, sB, sA);

      const result = handler(db, { depth: 2 });
      const alpha = result.directories.find((d) => d.directory === 'src/alpha')!;
      // cohesion = 0 / (0 + 0) => default 0
      expect(alpha.cohesion).toBe(0);
      // instability = 0 / (1 + 0) => 0
      expect(alpha.instability).toBe(0);
    });
  });
});
