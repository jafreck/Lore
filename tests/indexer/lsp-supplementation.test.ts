import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Database } from '../../src/db/schema.js';
import {
  findDuplicateSupplement,
  planBaselineLspSupplementation,
  stableMatchSymbols,
  type ExistingSupplementSymbol,
  type IncomingSupplementSymbol,
} from '../../src/indexer/stages/lsp-supplementation.js';

function insertFile(db: Database.Database, id: number, path: string, language: string): void {
  db.prepare(
    `INSERT INTO files (id, path, branch, language, source, layer, generation)
     VALUES (?, ?, 'main', ?, '', 'baseline', 1)`,
  ).run(id, path, language);
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind: string,
  startLine: number,
  endLine: number,
): void {
  db.prepare(
    `INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation)
     VALUES (?, ?, ?, ?, ?, 'baseline', 1)`,
  ).run(fileId, name, kind, startLine, endLine);
}

function existing(overrides: Partial<ExistingSupplementSymbol>): ExistingSupplementSymbol {
  return {
    id: 1,
    parentId: null,
    path: '/repo/a.cpp',
    name: 'run',
    kind: 'function',
    parentChain: [],
    signature: 'void run()',
    range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 10 },
    selectionLine: 1,
    selectionCharacter: 5,
    ...overrides,
  };
}

function incoming(overrides: Partial<IncomingSupplementSymbol>): IncomingSupplementSymbol {
  return {
    index: 0,
    parentIndex: null,
    path: '/repo/a.cpp',
    name: 'run',
    kind: 'function',
    parentChain: [],
    signature: 'void run()',
    detail: 'void run()',
    docComment: null,
    documentSymbol: null,
    provenance: 'lsp',
    range: { startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 10 },
    selectionLine: 1,
    selectionCharacter: 5,
    ...overrides,
  };
}

describe('planBaselineLspSupplementation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(
      "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  it('selects unsourced, zero-symbol, and degenerate C files without rescanning healthy or non-C SCIP files', () => {
    insertFile(db, 1, '/repo/healthy.cpp', 'cpp');
    insertSymbol(db, 1, 'healthy', 'function', 1, 8);
    insertFile(db, 2, '/repo/empty.h', 'c');
    insertFile(db, 3, '/repo/degenerate.c', 'c');
    insertSymbol(db, 3, 'broken', 'function', 4, 4);
    insertFile(db, 4, '/repo/covered.ts', 'typescript');
    insertSymbol(db, 4, 'covered', 'function', 2, 2);
    insertFile(db, 5, '/repo/fallback.py', 'python');

    const files = [
      { path: '/repo/healthy.cpp', language: 'cpp' },
      { path: '/repo/empty.h', language: 'c' },
      { path: '/repo/degenerate.c', language: 'c' },
      { path: '/repo/covered.ts', language: 'typescript' },
      { path: '/repo/fallback.py', language: 'python' },
    ];
    const sourced = new Set(files.slice(0, 4).map((file) => file.path));
    const plan = planBaselineLspSupplementation(db, 'main', files, sourced, {
      maxFiles: 20,
      fileConcurrency: 3,
      strict: false,
    });

    expect(plan.files.map((file) => [file.path, file.reasons])).toEqual([
      ['/repo/fallback.py', ['unsourced']],
      ['/repo/empty.h', ['zero-symbols']],
      ['/repo/degenerate.c', ['degenerate-spans']],
    ]);
    expect(plan.skippedScipFiles).toBe(1);
    expect(plan.complete).toBe(true);
  });

  it('caps deterministically and reports an incomplete plan', () => {
    insertFile(db, 1, '/repo/b.py', 'python');
    insertFile(db, 2, '/repo/a.py', 'python');
    const files = [
      { path: '/repo/b.py', language: 'python' },
      { path: '/repo/a.py', language: 'python' },
    ];

    const plan = planBaselineLspSupplementation(db, 'main', files, new Set(), {
      maxFiles: 1,
      fileConcurrency: 2,
      strict: false,
    });

    expect(plan.files.map((file) => file.path)).toEqual(['/repo/a.py']);
    expect(plan.skippedByCap).toBe(1);
    expect(plan.complete).toBe(false);
  });
});

describe('stableMatchSymbols', () => {
  it('matches C++ overloads by exact character and signature independent of input order', () => {
    const current = [
      existing({ id: 10, signature: 'void run(int)', selectionLine: 7, selectionCharacter: 5 }),
      existing({ id: 11, signature: 'void run(double)', selectionLine: 7, selectionCharacter: 24 }),
    ];
    const proposed = [
      incoming({ index: 0, signature: 'void run(double)', selectionLine: 7, selectionCharacter: 24 }),
      incoming({ index: 1, signature: 'void run(int)', selectionLine: 7, selectionCharacter: 5 }),
    ];

    expect([...stableMatchSymbols(current, proposed).matches]).toEqual([[0, 11], [1, 10]]);
  });

  it('uses the parent chain to separate nested same-name methods', () => {
    const current = [
      existing({ id: 20, kind: 'method', parentId: 2, parentChain: ['class:Alpha'] }),
      existing({ id: 21, kind: 'method', parentId: 3, parentChain: ['class:Beta'] }),
    ];
    const proposed = [
      incoming({ index: 0, kind: 'method', parentIndex: 1, parentChain: ['class:Beta'] }),
      incoming({ index: 1, kind: 'method', parentIndex: 0, parentChain: ['class:Alpha'] }),
    ];

    expect([...stableMatchSymbols(current, proposed).matches]).toEqual([[0, 21], [1, 20]]);
  });

  it('does not guess between colliding overloads without a signature or exact character', () => {
    const current = [
      existing({
        id: 30, signature: null, selectionCharacter: null,
        range: { startLine: 1, startCharacter: null, endLine: 1, endCharacter: 10 },
      }),
      existing({
        id: 31, signature: null, selectionCharacter: null,
        range: { startLine: 1, startCharacter: null, endLine: 1, endCharacter: 10 },
      }),
    ];
    const proposed = [incoming({ signature: null, selectionCharacter: 6 })];
    const result = stableMatchSymbols(current, proposed);

    expect(result.matches.size).toBe(0);
    expect(result.ambiguousIncoming).toEqual([0]);
  });

  it('uses exact start characters when legacy selection coordinates are absent', () => {
    const current = [
      existing({
        id: 32, signature: null, selectionLine: null, selectionCharacter: null,
        range: { startLine: 7, startCharacter: 0, endLine: 7, endCharacter: 15 },
      }),
      existing({
        id: 33, signature: null, selectionLine: null, selectionCharacter: null,
        range: { startLine: 7, startCharacter: 20, endLine: 7, endCharacter: 40 },
      }),
    ];
    const proposed = [incoming({
      signature: null,
      selectionLine: 7,
      selectionCharacter: 25,
      range: { startLine: 7, startCharacter: 20, endLine: 7, endCharacter: 40 },
    })];
    expect([...stableMatchSymbols(current, proposed).matches]).toEqual([[0, 33]]);
  });
});

describe('findDuplicateSupplement', () => {
  it('detects same-kind, same-parent overlapping symbols', () => {
    const current = existing({ id: 40, parentId: 7, selectionLine: null, selectionCharacter: null });
    const proposed = incoming({ parentIndex: 1, selectionLine: null, selectionCharacter: null });
    expect(findDuplicateSupplement(proposed, 7, [current])?.id).toBe(40);
  });

  it('preserves overloads with distinct selection points', () => {
    const current = existing({ id: 41, parentId: 7, selectionCharacter: 5 });
    const proposed = incoming({ parentIndex: 1, selectionCharacter: 20 });
    expect(findDuplicateSupplement(proposed, 7, [current])).toBeUndefined();
  });

  it('conservatively deduplicates overlapping legacy rows without selection points', () => {
    const current = existing({
      id: 42,
      parentId: 7,
      signature: 'void run(int)',
      selectionLine: null,
      selectionCharacter: null,
    });
    const proposed = incoming({
      parentIndex: 1,
      signature: 'void run(double)',
      selectionLine: 1,
      selectionCharacter: 20,
    });
    expect(findDuplicateSupplement(proposed, 7, [current])?.id).toBe(42);
  });
});
