import { describe, it, expect, vi } from 'vitest';
import { handler, toolDef, type AnalyzeArgs } from '../../../src/server/tools/graph-analysis.js';
import { openDb } from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/schema.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createDb(): Database.Database {
  return openDb(':memory:');
}

function insertFile(db: Database.Database, path: string): number {
  return Number(
    db.prepare("INSERT INTO files (path, branch, language, size_bytes, last_hash, source) VALUES (?, 'HEAD', 'typescript', 0, NULL, '')")
      .run(path).lastInsertRowid,
  );
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind = 'function',
  startLine = 1,
  endLine?: number,
): number {
  return Number(
    db.prepare('INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fileId, name, kind, startLine, endLine ?? startLine + 10, `${kind} ${name}`).lastInsertRowid,
  );
}

function insertResolvedCallRef(
  db: Database.Database,
  callerId: number,
  calleeId: number,
  fileId: number,
  callLine = 1,
): void {
  db.prepare(
    `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
     VALUES (?, ?, ?, 'resolved', ?, 'name_unique')`,
  ).run(callerId, fileId, calleeId, callLine);
}

// ─── toolDef ──────────────────────────────────────────────────────────────────

describe('lore_analyze toolDef', () => {
  it('should have the correct tool name', () => {
    expect(toolDef.name).toBe('lore_analyze');
  });

  it('should require mode in inputSchema', () => {
    expect(toolDef.inputSchema.required).toContain('mode');
  });

  it('should declare expected mode enum values', () => {
    const modeEnum = toolDef.inputSchema.properties.mode.enum;
    expect(modeEnum).toContain('cycles');
    expect(modeEnum).toContain('components');
    expect(modeEnum).toContain('clusters');
    expect(modeEnum).toContain('summary');
  });
});

// ─── handler ──────────────────────────────────────────────────────────────────

describe('handler', () => {
  it('should return cycles mode result with empty DB', () => {
    const db = createDb();
    const result = handler(db, { mode: 'cycles' });
    expect(result.mode).toBe('cycles');
    expect((result as any).sccs).toEqual([]);
  });

  it('should return components mode result with empty DB', () => {
    const db = createDb();
    const result = handler(db, { mode: 'components' });
    expect(result.mode).toBe('components');
    expect((result as any).components).toBeDefined();
  });

  it('should return components mode with file scope', () => {
    const db = createDb();
    const result = handler(db, { mode: 'components', scope: 'file' });
    expect(result.mode).toBe('components');
    expect((result as any).components).toBeDefined();
  });

  it('should return clusters mode result', () => {
    const db = createDb();
    const result = handler(db, { mode: 'clusters' });
    expect(result.mode).toBe('clusters');
    expect((result as any).clusters).toBeDefined();
  });

  it('should return clusters with custom max_lines', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    insertSymbol(db, f, 'foo', 'function', 1, 50);
    const result = handler(db, { mode: 'clusters', max_lines: 100 });
    expect(result.mode).toBe('clusters');
    expect((result as any).clusters).toBeDefined();
  });

  it('should return summary mode result', () => {
    const db = createDb();
    const result = handler(db, { mode: 'summary' });
    expect(result.mode).toBe('summary');
    expect((result as any).summary).toBeDefined();
  });

  it('should return summary with custom max_lines', () => {
    const db = createDb();
    const result = handler(db, { mode: 'summary', max_lines: 200 });
    expect(result.mode).toBe('summary');
  });

  it('should respect edge_kinds option', () => {
    const db = createDb();
    const result = handler(db, { mode: 'cycles', edge_kinds: 'call' });
    expect(result.mode).toBe('cycles');
  });

  it('should respect branch option', () => {
    const db = createDb();
    const result = handler(db, { mode: 'cycles', branch: 'main' });
    expect(result.mode).toBe('cycles');
  });

  it('should detect cycles when present', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'a');
    const b = insertSymbol(db, f, 'b');
    // a → b → a (cycle)
    insertResolvedCallRef(db, a, b, f, 5);
    insertResolvedCallRef(db, b, a, f, 15);
    const result = handler(db, { mode: 'cycles' });
    expect(result.mode).toBe('cycles');
    expect((result as any).sccs.length).toBeGreaterThan(0);
  });
});
