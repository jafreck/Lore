import { describe, it, expect } from 'vitest';
import { handler, toolDef, type AnalyzeArgs } from '../../../src/lore-server/tools/graph-analysis.js';
import { openDb } from '../../../src/indexer/db.js';
import { resolveSymbolEdges } from '../../../src/indexer/call-graph.js';
import type { Database } from '../../../src/indexer/db.js';

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

function insertCallRef(
  db: Database.Database,
  callerId: number,
  fileId: number,
  calleeName: string,
  callLine: number,
): void {
  db.prepare(
    'INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line) VALUES (?, ?, ?, ?)',
  ).run(callerId, fileId, calleeName, callLine);
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

  it('should require mode in the input schema', () => {
    expect(toolDef.inputSchema.required).toContain('mode');
  });

  it('should support all four analysis modes', () => {
    const modeEnum = toolDef.inputSchema.properties.mode.enum;
    expect(modeEnum).toEqual(['cycles', 'components', 'clusters', 'summary']);
  });
});

// ─── handler — cycles ─────────────────────────────────────────────────────────

describe('handler — cycles', () => {
  it('should return empty sccs for an empty database', () => {
    const db = createDb();
    const result = handler(db, { mode: 'cycles' });
    expect(result).toEqual({ mode: 'cycles', sccs: [] });
  });

  it('should detect a mutual recursion cycle', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'a');
    const b = insertSymbol(db, f, 'b');

    insertCallRef(db, a, f, 'b', 1);
    insertCallRef(db, b, f, 'a', 2);
    resolveSymbolEdges(db);

    const result = handler(db, { mode: 'cycles' });
    expect(result.mode).toBe('cycles');
    if (result.mode === 'cycles') {
      expect(result.sccs.length).toBeGreaterThan(0);
    }
  });

  it('should respect edge_kinds filter', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    insertSymbol(db, f, 'x');

    const result = handler(db, { mode: 'cycles', edge_kinds: 'call' });
    expect(result.mode).toBe('cycles');
  });
});

// ─── handler — components ─────────────────────────────────────────────────────

describe('handler — components', () => {
  it('should return empty components for an empty database', () => {
    const db = createDb();
    const result = handler(db, { mode: 'components' });
    expect(result).toEqual({ mode: 'components', components: [] });
  });

  it('should find connected components at symbol scope', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    const a = insertSymbol(db, f, 'a');
    const b = insertSymbol(db, f, 'b');
    insertResolvedCallRef(db, a, b, f);

    const result = handler(db, { mode: 'components', scope: 'symbol' });
    expect(result.mode).toBe('components');
    if (result.mode === 'components') {
      expect(result.components.length).toBeGreaterThan(0);
    }
  });

  it('should find connected components at file scope', () => {
    const db = createDb();
    const f1 = insertFile(db, 'src/a.ts');
    const f2 = insertFile(db, 'src/b.ts');
    const a = insertSymbol(db, f1, 'a');
    const b = insertSymbol(db, f2, 'b');
    insertResolvedCallRef(db, a, b, f1);

    const result = handler(db, { mode: 'components', scope: 'file' });
    expect(result.mode).toBe('components');
  });

  it('should accept a branch filter', () => {
    const db = createDb();
    const result = handler(db, { mode: 'components', branch: 'main' });
    expect(result.mode).toBe('components');
  });
});

// ─── handler — clusters ───────────────────────────────────────────────────────

describe('handler — clusters', () => {
  it('should return empty clusters for an empty database', () => {
    const db = createDb();
    const result = handler(db, { mode: 'clusters' });
    expect(result).toEqual({ mode: 'clusters', clusters: [] });
  });

  it('should cluster symbols with max_lines option', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    insertSymbol(db, f, 'foo', 'function', 1, 50);
    insertSymbol(db, f, 'bar', 'function', 51, 100);

    const result = handler(db, { mode: 'clusters', max_lines: 200 });
    expect(result.mode).toBe('clusters');
    if (result.mode === 'clusters') {
      expect(result.clusters.length).toBeGreaterThan(0);
    }
  });
});

// ─── handler — summary ───────────────────────────────────────────────────────

describe('handler — summary', () => {
  it('should return a summary for an empty database', () => {
    const db = createDb();
    const result = handler(db, { mode: 'summary' });
    expect(result.mode).toBe('summary');
    if (result.mode === 'summary') {
      expect(result.summary).toBeDefined();
    }
  });

  it('should include modules in the summary', () => {
    const db = createDb();
    const f = insertFile(db, 'src/a.ts');
    insertSymbol(db, f, 'main', 'function', 1, 20);

    const result = handler(db, { mode: 'summary', max_lines: 500 });
    expect(result.mode).toBe('summary');
    if (result.mode === 'summary') {
      expect(result.summary).toBeDefined();
    }
  });

  it('should respect branch filter in summary', () => {
    const db = createDb();
    const result = handler(db, { mode: 'summary', branch: 'HEAD', edge_kinds: 'both' });
    expect(result.mode).toBe('summary');
  });
});
