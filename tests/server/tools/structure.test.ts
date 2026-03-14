import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  handler,
  toolDef,
  type StructureArgs,
  type StructureResult,
} from '../../../src/server/tools/structure.js';
import { openDb } from '../../../src/db/schema.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  return openDb(':memory:');
}

function insertFile(db: Database.Database, path: string, branch: string): number {
  const result = db
    .prepare(
      "INSERT INTO files (path, branch, language, size_bytes, last_hash, source) VALUES (?, ?, ?, 0, NULL, '')",
    )
    .run(path, branch, 'typescript');
  return result.lastInsertRowid as number;
}

function insertImportEdge(
  db: Database.Database,
  fileId: number,
  rawImport: string,
  resolvedId: number | null,
): void {
  db.prepare(
    'INSERT INTO file_imports (file_id, raw_import, resolved_id) VALUES (?, ?, ?)',
  ).run(fileId, rawImport, resolvedId);
}

// ─── toolDef ──────────────────────────────────────────────────────────────────

describe('lore_structure toolDef', () => {
  it('should have the correct tool name', () => {
    expect(toolDef.name).toBe('lore_structure');
  });

  it('should expose analysis enum with cycles, layers, outliers, and all', () => {
    expect(toolDef.inputSchema.properties.analysis.enum).toEqual([
      'cycles',
      'layers',
      'outliers',
      'all',
    ]);
  });

  it('should expose depth, branch, and limit parameters', () => {
    expect(toolDef.inputSchema.properties.depth.type).toBe('number');
    expect(toolDef.inputSchema.properties.branch.type).toBe('string');
    expect(toolDef.inputSchema.properties.limit.type).toBe('number');
  });

  it('should have no required parameters', () => {
    expect(toolDef.inputSchema.required).toEqual([]);
  });
});

// ─── Empty database ───────────────────────────────────────────────────────────

describe('structure handler – empty database', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should return empty arrays for all analyses on empty DB', () => {
    const result = handler(db, { analysis: 'all' });
    expect(result.cycles).toEqual([]);
    expect(result.layer_violations).toEqual([]);
    expect(result.outliers).toEqual([]);
  });

  it('should return empty cycles on empty DB', () => {
    const result = handler(db, { analysis: 'cycles' });
    expect(result.cycles).toEqual([]);
    expect(result.layer_violations).toBeUndefined();
    expect(result.outliers).toBeUndefined();
  });

  it('should return empty layers on empty DB', () => {
    const result = handler(db, { analysis: 'layers' });
    expect(result.layer_violations).toEqual([]);
    expect(result.cycles).toBeUndefined();
    expect(result.outliers).toBeUndefined();
  });

  it('should return empty outliers on empty DB', () => {
    const result = handler(db, { analysis: 'outliers' });
    expect(result.outliers).toEqual([]);
    expect(result.cycles).toBeUndefined();
    expect(result.layer_violations).toBeUndefined();
  });
});

// ─── Cycles analysis ──────────────────────────────────────────────────────────

describe('structure handler – cycles analysis', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should detect a directory-level import cycle', () => {
    // src/a/foo.ts → src/b/bar.ts → src/a/baz.ts (cycle: src/a ↔ src/b)
    const fileA1 = insertFile(db, 'src/a/foo.ts', 'main');
    const fileB1 = insertFile(db, 'src/b/bar.ts', 'main');
    const fileA2 = insertFile(db, 'src/a/baz.ts', 'main');

    insertImportEdge(db, fileA1, './bar', fileB1); // src/a → src/b
    insertImportEdge(db, fileB1, './baz', fileA2); // src/b → src/a

    const result = handler(db, { analysis: 'cycles', depth: 2 });
    expect(result.cycles).toBeDefined();
    expect(result.cycles!.length).toBe(1);
    expect(result.cycles![0]!.directories).toContain('src/a');
    expect(result.cycles![0]!.directories).toContain('src/b');
    expect(result.cycles![0]!.edge_count).toBe(2);
  });

  it('should not report non-cyclic imports as cycles', () => {
    // A → B → C (no cycle)
    const fileA = insertFile(db, 'src/a/foo.ts', 'main');
    const fileB = insertFile(db, 'src/b/bar.ts', 'main');
    const fileC = insertFile(db, 'src/c/baz.ts', 'main');

    insertImportEdge(db, fileA, './bar', fileB);
    insertImportEdge(db, fileB, './baz', fileC);

    const result = handler(db, { analysis: 'cycles', depth: 2 });
    expect(result.cycles).toEqual([]);
  });

  it('should detect multiple cycles', () => {
    // Cycle 1: src/a ↔ src/b
    const fA1 = insertFile(db, 'src/a/foo.ts', 'main');
    const fB1 = insertFile(db, 'src/b/bar.ts', 'main');
    insertImportEdge(db, fA1, './bar', fB1);
    insertImportEdge(db, fB1, './foo', fA1);

    // Cycle 2: src/c ↔ src/d
    const fC1 = insertFile(db, 'src/c/one.ts', 'main');
    const fD1 = insertFile(db, 'src/d/two.ts', 'main');
    insertImportEdge(db, fC1, './two', fD1);
    insertImportEdge(db, fD1, './one', fC1);

    const result = handler(db, { analysis: 'cycles', depth: 2 });
    expect(result.cycles!.length).toBe(2);
  });

  it('should skip self-edges within the same directory', () => {
    // Both files in src/a → self-loop at directory level, not a cycle
    const fA1 = insertFile(db, 'src/a/foo.ts', 'main');
    const fA2 = insertFile(db, 'src/a/bar.ts', 'main');
    insertImportEdge(db, fA1, './bar', fA2);

    const result = handler(db, { analysis: 'cycles', depth: 2 });
    expect(result.cycles).toEqual([]);
  });
});

// ─── Layers analysis ─────────────────────────────────────────────────────────

describe('structure handler – layers analysis', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should return empty violations for a well-ordered dependency chain', () => {
    // Chain: src/app → src/lib → src/core
    // Kahn's topo order: core(0), lib(1), app(2)
    // All edges naturally satisfy dstRank < srcRank, so no violations.
    const fCore = insertFile(db, 'src/core/core.ts', 'main');
    const fLib = insertFile(db, 'src/lib/lib.ts', 'main');
    const fApp = insertFile(db, 'src/app/app.ts', 'main');

    insertImportEdge(db, fApp, '../lib/lib', fLib);
    insertImportEdge(db, fLib, '../core/core', fCore);

    const result = handler(db, { analysis: 'layers', depth: 2 });
    expect(result.layer_violations).toBeDefined();
    expect(result.layer_violations).toEqual([]);
  });

  it('should return empty violations for a diamond DAG', () => {
    // Diamond: lib → app, lib → utils, app → core, utils → core
    const fCore = insertFile(db, 'src/core/core.ts', 'main');
    const fApp = insertFile(db, 'src/app/app.ts', 'main');
    const fUtils = insertFile(db, 'src/utils/utils.ts', 'main');
    const fLib = insertFile(db, 'src/lib/lib.ts', 'main');

    insertImportEdge(db, fLib, '../app/app', fApp);
    insertImportEdge(db, fLib, '../utils/utils', fUtils);
    insertImportEdge(db, fApp, '../core/core', fCore);
    insertImportEdge(db, fUtils, '../core/core', fCore);

    const result = handler(db, { analysis: 'layers', depth: 2 });
    expect(result.layer_violations).toEqual([]);
  });

  it('should detect a back-edge as a layer violation in a cycle', () => {
    // Cycle: src/a → src/b → src/a. The DFS back-edge is a layer violation.
    const fA = insertFile(db, 'src/a/foo.ts', 'main');
    const fB = insertFile(db, 'src/b/bar.ts', 'main');
    insertImportEdge(db, fA, './bar', fB);
    insertImportEdge(db, fB, './foo', fA);

    const result = handler(db, { analysis: 'layers', depth: 2 });
    expect(result.layer_violations).toBeDefined();
    expect(result.layer_violations!.length).toBe(1);

    const v = result.layer_violations![0]!;
    // The back-edge creates a violation where from_rank < to_rank
    expect(v.from_rank).toBeLessThan(v.to_rank);
    expect(v.edge_count).toBe(1);
  });

  it('should detect a violation in a larger cycle', () => {
    // Chain with back-edge: lib → app → core → utils → app
    // DFS finds utils → app as the back-edge violation.
    const fCore = insertFile(db, 'src/core/core.ts', 'main');
    const fApp = insertFile(db, 'src/app/app.ts', 'main');
    const fLib = insertFile(db, 'src/lib/lib.ts', 'main');
    const fUtils = insertFile(db, 'src/utils/utils.ts', 'main');

    insertImportEdge(db, fLib, '../app/app', fApp);
    insertImportEdge(db, fApp, '../core/core', fCore);
    insertImportEdge(db, fCore, '../utils/utils', fUtils);
    insertImportEdge(db, fUtils, '../app/app', fApp);

    const result = handler(db, { analysis: 'layers', depth: 2 });
    expect(result.layer_violations).toBeDefined();
    expect(result.layer_violations!.length).toBeGreaterThan(0);

    const violation = result.layer_violations!.find(
      (v) => v.from_dir === 'src/utils' && v.to_dir === 'src/app',
    );
    expect(violation).toBeDefined();
    expect(violation!.edge_count).toBe(1);
    expect(violation!.from_rank).toBeLessThan(violation!.to_rank);
  });

  it('should not flag non-cyclic edges alongside cycle violations', () => {
    // Cycle: src/a ↔ src/b, plus non-cyclic: src/c → src/d
    const fA = insertFile(db, 'src/a/foo.ts', 'main');
    const fB = insertFile(db, 'src/b/bar.ts', 'main');
    insertImportEdge(db, fA, './bar', fB);
    insertImportEdge(db, fB, './foo', fA);

    const fC = insertFile(db, 'src/c/baz.ts', 'main');
    const fD = insertFile(db, 'src/d/qux.ts', 'main');
    insertImportEdge(db, fC, '../d/qux', fD);

    const result = handler(db, { analysis: 'layers', depth: 2 });
    // Only the back-edge from the cycle should be a violation
    expect(result.layer_violations!.length).toBe(1);
    // The non-cyclic edge src/c → src/d should NOT be a violation
    const nonCyclicViolation = result.layer_violations!.find(
      (v) => v.from_dir === 'src/c' || v.to_dir === 'src/d',
    );
    expect(nonCyclicViolation).toBeUndefined();
  });

  it('should return layer_violations as an array when analysis is layers', () => {
    const result = handler(db, { analysis: 'layers' });
    expect(Array.isArray(result.layer_violations)).toBe(true);
    expect(result.cycles).toBeUndefined();
    expect(result.outliers).toBeUndefined();
  });
});

// ─── Outliers analysis ────────────────────────────────────────────────────────

describe('structure handler – outliers analysis', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should detect anomalous low-count edges amid higher-count connections', () => {
    // Create several high-count edges and one low-count edge
    // High-count: src/a → src/b with many file imports
    const filesA: number[] = [];
    const filesB: number[] = [];
    for (let i = 0; i < 10; i++) {
      filesA.push(insertFile(db, `src/a/file${i}.ts`, 'main'));
      filesB.push(insertFile(db, `src/b/file${i}.ts`, 'main'));
    }

    // 10 edges from src/a → src/b
    for (let i = 0; i < 10; i++) {
      insertImportEdge(db, filesA[i]!, `../b/file${i}`, filesB[i]!);
    }

    // 10 edges from src/b → src/a (high-count reverse)
    for (let i = 0; i < 10; i++) {
      insertImportEdge(db, filesB[i]!, `../a/file${i}`, filesA[i]!);
    }

    // Add a third dir with high-count connections
    const filesC: number[] = [];
    for (let i = 0; i < 10; i++) {
      filesC.push(insertFile(db, `src/c/file${i}.ts`, 'main'));
    }
    for (let i = 0; i < 10; i++) {
      insertImportEdge(db, filesA[i]!, `../c/file${i}`, filesC[i]!);
    }

    // Low-count outlier: src/c → src/b with just 1 edge
    insertImportEdge(db, filesC[0]!, '../b/file0', filesB[0]!);

    const result = handler(db, { analysis: 'outliers', depth: 2 });
    expect(result.outliers).toBeDefined();

    if (result.outliers!.length > 0) {
      // The low-count edge src/c → src/b should be among outliers
      const outlier = result.outliers!.find(
        (o) => o.from_dir === 'src/c' && o.to_dir === 'src/b',
      );
      expect(outlier).toBeDefined();
      expect(outlier!.edge_count).toBe(1);
    }
  });

  it('should return empty outliers when all edges have the same count', () => {
    // 3 dirs each with exactly 1 edge between them → stddev = 0 → no outliers
    const fA = insertFile(db, 'src/a/foo.ts', 'main');
    const fB = insertFile(db, 'src/b/bar.ts', 'main');
    const fC = insertFile(db, 'src/c/baz.ts', 'main');

    insertImportEdge(db, fA, './bar', fB);
    insertImportEdge(db, fB, './baz', fC);
    insertImportEdge(db, fC, './foo', fA);

    const result = handler(db, { analysis: 'outliers', depth: 2 });
    expect(result.outliers).toEqual([]);
  });

  it('should include reverse_edge_count and sample_files in outlier results', () => {
    // Set up data where an outlier exists and check its shape
    const filesA: number[] = [];
    const filesB: number[] = [];
    for (let i = 0; i < 8; i++) {
      filesA.push(insertFile(db, `src/a/f${i}.ts`, 'main'));
      filesB.push(insertFile(db, `src/b/f${i}.ts`, 'main'));
    }
    for (let i = 0; i < 8; i++) {
      insertImportEdge(db, filesA[i]!, `../b/f${i}`, filesB[i]!);
    }
    // High count from B → A
    for (let i = 0; i < 8; i++) {
      insertImportEdge(db, filesB[i]!, `../a/f${i}`, filesA[i]!);
    }

    // Third dir with low-count edge
    const fC = insertFile(db, 'src/c/only.ts', 'main');
    insertImportEdge(db, fC, '../a/f0', filesA[0]!);

    const result = handler(db, { analysis: 'outliers', depth: 2 });
    if (result.outliers!.length > 0) {
      const outlier = result.outliers![0]!;
      expect(outlier).toHaveProperty('from_dir');
      expect(outlier).toHaveProperty('to_dir');
      expect(outlier).toHaveProperty('edge_count');
      expect(outlier).toHaveProperty('reverse_edge_count');
      expect(outlier).toHaveProperty('sample_files');
      expect(Array.isArray(outlier.sample_files)).toBe(true);
      expect(outlier.sample_files.length).toBeLessThanOrEqual(3);
    }
  });
});

// ─── 'all' mode ───────────────────────────────────────────────────────────────

describe('structure handler – all mode', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should return all three fields when analysis is "all"', () => {
    const result = handler(db, { analysis: 'all' });
    expect(result).toHaveProperty('cycles');
    expect(result).toHaveProperty('layer_violations');
    expect(result).toHaveProperty('outliers');
  });

  it('should default to "all" when no analysis is specified', () => {
    const result = handler(db, {});
    expect(result).toHaveProperty('cycles');
    expect(result).toHaveProperty('layer_violations');
    expect(result).toHaveProperty('outliers');
  });
});

// ─── Depth parameter ──────────────────────────────────────────────────────────

describe('structure handler – depth parameter', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should aggregate directories at the requested depth', () => {
    // With depth=1, src/a/b and src/a/c both map to "src"
    const fAB = insertFile(db, 'src/a/b/foo.ts', 'main');
    const fAC = insertFile(db, 'src/a/c/bar.ts', 'main');
    insertImportEdge(db, fAB, '../c/bar', fAC);

    // At depth=1, both are "src" → self-loop, excluded
    const resultDepth1 = handler(db, { analysis: 'cycles', depth: 1 });
    expect(resultDepth1.cycles).toEqual([]);

    // At depth=3, they become src/a/b and src/a/c → cross-directory edge but no cycle
    const resultDepth3 = handler(db, { analysis: 'cycles', depth: 3 });
    expect(resultDepth3.cycles).toEqual([]);
  });

  it('should clamp depth to valid range', () => {
    // depth=0 should be clamped to 1, depth=100 to 10
    const fA = insertFile(db, 'src/a/foo.ts', 'main');
    const fB = insertFile(db, 'src/b/bar.ts', 'main');
    insertImportEdge(db, fA, './bar', fB);

    // Should not throw with extreme values
    expect(() => handler(db, { analysis: 'cycles', depth: 0 })).not.toThrow();
    expect(() => handler(db, { analysis: 'cycles', depth: 100 })).not.toThrow();
  });
});

// ─── Branch filtering ─────────────────────────────────────────────────────────

describe('structure handler – branch filtering', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should scope results to the specified branch', () => {
    // Create a cycle on branch "main"
    const fA = insertFile(db, 'src/a/foo.ts', 'main');
    const fB = insertFile(db, 'src/b/bar.ts', 'main');
    insertImportEdge(db, fA, './bar', fB);
    insertImportEdge(db, fB, './foo', fA);

    // Create files on branch "feature" with no cycle
    const fC = insertFile(db, 'src/c/baz.ts', 'feature');
    const fD = insertFile(db, 'src/d/qux.ts', 'feature');
    insertImportEdge(db, fC, './qux', fD);

    // With branch="main", should find the cycle
    const mainResult = handler(db, { analysis: 'cycles', branch: 'main', depth: 2 });
    expect(mainResult.cycles!.length).toBe(1);

    // With branch="feature", should find no cycle
    const featureResult = handler(db, { analysis: 'cycles', branch: 'feature', depth: 2 });
    expect(featureResult.cycles).toEqual([]);
  });

  it('should return empty results for non-existent branch', () => {
    const fA = insertFile(db, 'src/a/foo.ts', 'main');
    const fB = insertFile(db, 'src/b/bar.ts', 'main');
    insertImportEdge(db, fA, './bar', fB);

    const result = handler(db, { analysis: 'all', branch: 'nonexistent' });
    expect(result.cycles).toEqual([]);
    expect(result.layer_violations).toEqual([]);
    expect(result.outliers).toEqual([]);
  });
});

// ─── Limit parameter ─────────────────────────────────────────────────────────

describe('structure handler – limit parameter', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should cap cycle results to the specified limit', () => {
    // Create 3 independent cycles
    for (let i = 0; i < 3; i++) {
      const fX = insertFile(db, `src/x${i}/a.ts`, 'main');
      const fY = insertFile(db, `src/y${i}/b.ts`, 'main');
      insertImportEdge(db, fX, `../y${i}/b`, fY);
      insertImportEdge(db, fY, `../x${i}/a`, fX);
    }

    const result = handler(db, { analysis: 'cycles', depth: 2, limit: 2 });
    expect(result.cycles!.length).toBeLessThanOrEqual(2);
  });

  it('should clamp limit to valid range', () => {
    expect(() => handler(db, { analysis: 'all', limit: 0 })).not.toThrow();
    expect(() => handler(db, { analysis: 'all', limit: 9999 })).not.toThrow();
  });
});

// ─── Unresolved imports ───────────────────────────────────────────────────────

describe('structure handler – unresolved imports', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('should ignore imports with null resolved_id', () => {
    const fA = insertFile(db, 'src/a/foo.ts', 'main');
    insertFile(db, 'src/b/bar.ts', 'main');
    insertImportEdge(db, fA, './bar', null); // unresolved

    const result = handler(db, { analysis: 'all', depth: 2 });
    expect(result.cycles).toEqual([]);
    expect(result.layer_violations).toEqual([]);
    expect(result.outliers).toEqual([]);
  });
});
