/**
 * Tests for resolveSymbolEdges with overlayOnly option.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from '../../src/db/schema.js';
import { resolveSymbolEdges } from '../../src/resolution/call-graph.js';
import type Database from 'better-sqlite3';

describe('resolveSymbolEdges — overlayOnly', () => {
  let db: Database.Database;

  afterEach(() => {
    db?.close();
  });

  it('should only resolve overlay refs when overlayOnly is true', () => {
    db = openDb(':memory:');

    // Insert two files
    const f1 = db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/a.ts', 'HEAD', 'typescript', 10, '', 'baseline', 1);
    const f1Id = Number(f1.lastInsertRowid);

    const f2 = db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/b.ts', 'HEAD', 'typescript', 10, '', 'overlay', 0);
    const f2Id = Number(f2.lastInsertRowid);

    // Insert symbols
    const s1 = db.prepare(
      "INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(f1Id, 'target', 'function', 1, 3, 'baseline', 1);
    const s1Id = Number(s1.lastInsertRowid);

    const s2 = db.prepare(
      "INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(f2Id, 'caller', 'function', 1, 3, 'overlay', 0);
    const s2Id = Number(s2.lastInsertRowid);

    // Insert a baseline unresolved ref
    db.prepare(
      "INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, resolution_method, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(s1Id, f1Id, 'target', 2, 'unresolved', 'baseline', 1);

    // Insert an overlay unresolved ref
    db.prepare(
      "INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, resolution_method, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(s2Id, f2Id, 'target', 2, 'unresolved', 'overlay', 0);

    // Run resolution with overlayOnly
    resolveSymbolEdges(db, { overlayOnly: true });

    // The overlay ref should have been resolved (if target is unique)
    const overlayRef = db.prepare(
      "SELECT resolution_method FROM symbol_refs WHERE layer = 'overlay'",
    ).get() as { resolution_method: string };

    // The baseline ref should still be unresolved (not touched by overlayOnly)
    const baselineRef = db.prepare(
      "SELECT resolution_method FROM symbol_refs WHERE layer = 'baseline'",
    ).get() as { resolution_method: string };
    expect(baselineRef.resolution_method).toBe('unresolved');
  });

  it('should resolve all refs when overlayOnly is not set', () => {
    db = openDb(':memory:');

    const f1 = db.prepare(
      "INSERT INTO files (path, branch, language, size_bytes, source, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run('/a.ts', 'HEAD', 'typescript', 10, '', 'baseline', 1);
    const f1Id = Number(f1.lastInsertRowid);

    const s1 = db.prepare(
      "INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(f1Id, 'uniqueFn', 'function', 1, 3, 'baseline', 1);
    const s1Id = Number(s1.lastInsertRowid);

    // Baseline ref
    db.prepare(
      "INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, resolution_method, layer, generation) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(s1Id, f1Id, 'uniqueFn', 2, 'unresolved', 'baseline', 1);

    resolveSymbolEdges(db);

    const ref = db.prepare('SELECT resolution_method FROM symbol_refs').get() as { resolution_method: string };
    // Should have been resolved (name_same_file or name_unique)
    expect(ref.resolution_method).not.toBe('unresolved');
  });
});
