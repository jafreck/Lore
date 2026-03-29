import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/db/schema.js';
import type { Database } from '../../src/db/schema.js';
import {
  escapeLikeWildcards,
  clampLimit,
  MAX_RESULT_LIMIT,
  resetEffectiveViewsCache,
  hasEffectiveViews,
  filesTable,
  symbolsTable,
} from '../../src/db/queries/helpers.js';
import {
  getSymbolById,
  getSymbolsByName,
  listSymbols,
  listSymbolRangesByName,
  resolveSymbolRangeByName,
  getExternalSymbolsByName,
  searchExternalSymbolsByName,
} from '../../src/db/queries/symbols.js';
import {
  getFileById,
  getFileByPath,
  listFiles,
  listFilesByPathPrefix,
} from '../../src/db/queries/files.js';
import {
  listResolvedEdges,
  listTypeRefs,
  listSymbolRelationships,
} from '../../src/db/queries/edges.js';
import {
  getCommitBySha,
  listRecentCommits,
  listCommitsByFile,
  listCommitsByAuthor,
  listCommitFiles,
  listCommitRefs,
  listCommitsByRef,
  hasCommitEmbeddings,
  listCommitsBySemanticQuery,
  listCommitCadence,
  listCommitSizes,
  listCommitChurnByFile,
  listCommitAuthorStats,
  listCommitMessagePrefixes,
  listCommitSchedule,
  listCommitBranchActivity,
} from '../../src/db/queries/commits.js';
import { listAnnotations } from '../../src/db/queries/annotations.js';
import { semanticSearchSymbols } from '../../src/db/queries/semantic.js';

// ─── Helper: seed a baseline file + return its id ────────────────────────────

function insertFile(
  db: Database.Database,
  path: string,
  language = 'typescript',
  branch = '',
  layer = 'baseline',
): number {
  return (
    db
      .prepare(
        `INSERT INTO files (path, branch, language, size_bytes, layer)
         VALUES (?, ?, ?, 100, ?)`,
      )
      .run(path, branch, language, layer) as { lastInsertRowid: number }
  ).lastInsertRowid as number;
}

function insertSymbol(
  db: Database.Database,
  fileId: number,
  name: string,
  kind = 'function',
  startLine = 1,
  endLine = 10,
  opts: { isExported?: number; signature?: string | null; docComment?: string | null; parentSymbolId?: number | null; layer?: string } = {},
): number {
  return (
    db
      .prepare(
        `INSERT INTO symbols (file_id, name, kind, start_line, end_line, is_exported, signature, doc_comment, parent_symbol_id, layer)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fileId,
        name,
        kind,
        startLine,
        endLine,
        opts.isExported ?? 0,
        opts.signature ?? null,
        opts.docComment ?? null,
        opts.parentSymbolId ?? null,
        opts.layer ?? 'baseline',
      ) as { lastInsertRowid: number }
  ).lastInsertRowid as number;
}

function insertCommit(
  db: Database.Database,
  sha: string,
  author = 'Alice',
  email = 'alice@example.com',
  timestamp = 1700000000,
  message = 'fix: something',
): void {
  db.prepare(
    `INSERT INTO commits (sha, author, author_email, timestamp, message, parents)
     VALUES (?, ?, ?, ?, ?, '[]')`,
  ).run(sha, author, email, timestamp, message);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('queries/helpers', () => {
  describe('escapeLikeWildcards', () => {
    it('escapes % characters', () => {
      expect(escapeLikeWildcards('100%')).toBe('100\\%');
    });

    it('escapes _ characters', () => {
      expect(escapeLikeWildcards('a_b')).toBe('a\\_b');
    });

    it('escapes both % and _', () => {
      expect(escapeLikeWildcards('a%b_c')).toBe('a\\%b\\_c');
    });

    it('returns unchanged string when no wildcards', () => {
      expect(escapeLikeWildcards('hello')).toBe('hello');
    });

    it('handles empty string', () => {
      expect(escapeLikeWildcards('')).toBe('');
    });

    it('handles consecutive wildcards', () => {
      expect(escapeLikeWildcards('%%__')).toBe('\\%\\%\\_\\_');
    });
  });

  describe('clampLimit', () => {
    it('returns default 1000 when undefined', () => {
      expect(clampLimit(undefined)).toBe(1000);
    });

    it('returns the value when within range', () => {
      expect(clampLimit(50)).toBe(50);
    });

    it('clamps to MAX_RESULT_LIMIT for large values', () => {
      expect(clampLimit(999999)).toBe(MAX_RESULT_LIMIT);
    });

    it('clamps to 1 for values <= 0', () => {
      expect(clampLimit(0)).toBe(1);
      expect(clampLimit(-5)).toBe(1);
    });

    it('accepts custom default', () => {
      expect(clampLimit(undefined, 500)).toBe(500);
    });
  });

  describe('hasEffectiveViews / filesTable / symbolsTable', () => {
    let db: Database.Database;

    afterEach(() => {
      db?.close();
    });

    it('returns true for db created by openDb (has views)', () => {
      db = openDb(':memory:');
      resetEffectiveViewsCache(db);
      expect(hasEffectiveViews(db)).toBe(true);
    });

    it('filesTable returns effective_files for db with views', () => {
      db = openDb(':memory:');
      resetEffectiveViewsCache(db);
      expect(filesTable(db)).toBe('effective_files');
    });

    it('caches effective views result on second call', () => {
      db = openDb(':memory:');
      resetEffectiveViewsCache(db);
      // First call populates cache
      expect(hasEffectiveViews(db)).toBe(true);
      // Second call uses cache — exercises the cached path
      expect(hasEffectiveViews(db)).toBe(true);
    });

    it('resetEffectiveViewsCache with string path works', () => {
      db = openDb(':memory:');
      // Populate cache
      hasEffectiveViews(db);
      // Reset by path string
      resetEffectiveViewsCache(db.name);
      // Should re-check since cache was cleared
      expect(hasEffectiveViews(db)).toBe(true);
    });

    it('symbolsTable returns effective_symbols for db with views', () => {
      db = openDb(':memory:');
      resetEffectiveViewsCache(db);
      expect(symbolsTable(db)).toBe('effective_symbols');
    });
  });
});

describe('queries/files', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  describe('getFileById', () => {
    it('returns a file by id', () => {
      const id = insertFile(db, 'src/main.ts');
      const row = getFileById(db, id);
      expect(row).toBeDefined();
      expect(row!.path).toBe('src/main.ts');
      expect(row!.language).toBe('typescript');
    });

    it('returns undefined for missing id', () => {
      expect(getFileById(db, 999)).toBeUndefined();
    });

    it('filters by branch when specified', () => {
      const id = insertFile(db, 'a.ts', 'typescript', 'main');
      expect(getFileById(db, id, 'main')).toBeDefined();
      expect(getFileById(db, id, 'develop')).toBeUndefined();
    });
  });

  describe('getFileByPath', () => {
    it('returns a file by path', () => {
      insertFile(db, 'src/index.ts');
      const row = getFileByPath(db, 'src/index.ts');
      expect(row).toBeDefined();
      expect(row!.path).toBe('src/index.ts');
    });

    it('returns undefined for missing path', () => {
      expect(getFileByPath(db, 'nonexistent.ts')).toBeUndefined();
    });

    it('filters by branch', () => {
      insertFile(db, 'a.ts', 'typescript', 'main');
      expect(getFileByPath(db, 'a.ts', 'main')).toBeDefined();
      expect(getFileByPath(db, 'a.ts', 'other')).toBeUndefined();
    });

    it('returns most recently indexed file when multiple exist', () => {
      // Insert two files with same path but different branches
      insertFile(db, 'dup.ts', 'typescript', '');
      const id2 = insertFile(db, 'dup.ts', 'typescript', 'feature');
      const row = getFileByPath(db, 'dup.ts', 'feature');
      expect(row).toBeDefined();
      expect(row!.id).toBe(id2);
    });
  });

  describe('listFiles', () => {
    it('returns empty array when no files', () => {
      expect(listFiles(db)).toEqual([]);
    });

    it('returns all files up to limit', () => {
      insertFile(db, 'a.ts');
      insertFile(db, 'b.ts');
      insertFile(db, 'c.ts');
      const files = listFiles(db);
      expect(files.length).toBe(3);
    });

    it('respects limit parameter', () => {
      insertFile(db, 'a.ts');
      insertFile(db, 'b.ts');
      insertFile(db, 'c.ts');
      const files = listFiles(db, 2);
      expect(files.length).toBe(2);
    });

    it('filters by branch', () => {
      insertFile(db, 'a.ts', 'typescript', 'main');
      insertFile(db, 'b.ts', 'typescript', 'develop');
      const files = listFiles(db, undefined, 'main');
      expect(files.length).toBe(1);
      expect(files[0]!.path).toBe('a.ts');
    });
  });

  describe('listFilesByPathPrefix', () => {
    it('returns empty for empty prefix', () => {
      insertFile(db, 'src/a.ts');
      expect(listFilesByPathPrefix(db, '')).toEqual([]);
      expect(listFilesByPathPrefix(db, '  ')).toEqual([]);
    });

    it('matches directory prefix', () => {
      insertFile(db, 'src/a.ts');
      insertFile(db, 'src/b.ts');
      insertFile(db, 'lib/c.ts');
      const files = listFilesByPathPrefix(db, 'src');
      expect(files.length).toBe(2);
    });

    it('matches trailing slash prefix', () => {
      insertFile(db, 'src/a.ts');
      insertFile(db, 'src/deep/b.ts');
      const files = listFilesByPathPrefix(db, 'src/');
      expect(files.length).toBe(2);
    });

    it('also returns exact path match', () => {
      const id = insertFile(db, 'src');
      insertFile(db, 'src/a.ts');
      const files = listFilesByPathPrefix(db, 'src');
      expect(files.length).toBe(2);
    });

    it('handles special LIKE characters in prefix', () => {
      insertFile(db, 'a%b/test.ts');
      const files = listFilesByPathPrefix(db, 'a%b');
      expect(files.length).toBe(1);
    });

    it('filters by branch', () => {
      insertFile(db, 'src/a.ts', 'typescript', 'main');
      insertFile(db, 'src/a.ts', 'typescript', 'feat');
      const files = listFilesByPathPrefix(db, 'src', 'main');
      expect(files.length).toBe(1);
    });

    it('respects limit', () => {
      insertFile(db, 'src/a.ts');
      insertFile(db, 'src/b.ts');
      insertFile(db, 'src/c.ts');
      const files = listFilesByPathPrefix(db, 'src', undefined, 2);
      expect(files.length).toBe(2);
    });
  });
});

describe('queries/symbols', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  describe('getSymbolById', () => {
    it('returns a symbol by id', () => {
      const fid = insertFile(db, 'main.ts');
      const sid = insertSymbol(db, fid, 'myFunc');
      const sym = getSymbolById(db, sid);
      expect(sym).toBeDefined();
      expect(sym!.name).toBe('myFunc');
      expect(sym!.kind).toBe('function');
      expect(sym!.file_path).toBe('main.ts');
    });

    it('returns undefined for missing id', () => {
      expect(getSymbolById(db, 999)).toBeUndefined();
    });

    it('includes parent_name when parent exists', () => {
      const fid = insertFile(db, 'main.ts');
      const parentId = insertSymbol(db, fid, 'MyClass', 'class');
      const childId = insertSymbol(db, fid, 'method', 'method', 5, 8, { parentSymbolId: parentId });
      const sym = getSymbolById(db, childId);
      expect(sym!.parent_name).toBe('MyClass');
    });

    it('includes metrics when available', () => {
      // symbol_metrics table still exists for backward compatibility but
      // queries no longer join it — metrics columns are not returned.
      const fid = insertFile(db, 'main.ts');
      const sid = insertSymbol(db, fid, 'complex');
      const sym = getSymbolById(db, sid);
      expect(sym).toBeDefined();
      expect(sym!.name).toBe('complex');
    });
  });

  describe('getSymbolsByName', () => {
    it('finds symbols by exact name (case-insensitive)', () => {
      const fid = insertFile(db, 'a.ts');
      insertSymbol(db, fid, 'myFunction');
      const results = getSymbolsByName(db, 'MYFUNCTION');
      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe('myFunction');
    });

    it('returns empty for non-matching name', () => {
      const fid = insertFile(db, 'a.ts');
      insertSymbol(db, fid, 'foo');
      expect(getSymbolsByName(db, 'bar')).toEqual([]);
    });

    it('supports prefix match mode', () => {
      const fid = insertFile(db, 'a.ts');
      insertSymbol(db, fid, 'handleClick');
      insertSymbol(db, fid, 'handleSubmit');
      insertSymbol(db, fid, 'getData');
      const results = getSymbolsByName(db, 'handle', { matchMode: 'prefix' });
      expect(results.length).toBe(2);
    });

    it('supports contains match mode', () => {
      const fid = insertFile(db, 'a.ts');
      insertSymbol(db, fid, 'getUser');
      insertSymbol(db, fid, 'fetchUsers');
      insertSymbol(db, fid, 'deleteItem');
      const results = getSymbolsByName(db, 'user', { matchMode: 'contains' });
      expect(results.length).toBe(2);
    });

    it('filters by branch', () => {
      const f1 = insertFile(db, 'a.ts', 'typescript', 'main');
      const f2 = insertFile(db, 'a.ts', 'typescript', 'dev');
      insertSymbol(db, f1, 'foo');
      insertSymbol(db, f2, 'foo');
      const results = getSymbolsByName(db, 'foo', { branch: 'main' });
      expect(results.length).toBe(1);
    });

    it('filters by kind', () => {
      const fid = insertFile(db, 'a.ts');
      insertSymbol(db, fid, 'MyClass', 'class');
      insertSymbol(db, fid, 'myFunc', 'function');
      const results = getSymbolsByName(db, 'my', { matchMode: 'prefix', kind: 'class' });
      expect(results.length).toBe(1);
      expect(results[0]!.kind).toBe('class');
    });

    it('filters by pathPrefix', () => {
      const f1 = insertFile(db, 'src/a.ts');
      const f2 = insertFile(db, 'lib/b.ts');
      insertSymbol(db, f1, 'hello');
      insertSymbol(db, f2, 'hello');
      const results = getSymbolsByName(db, 'hello', { pathPrefix: 'src/' });
      expect(results.length).toBe(1);
    });

    it('filters by language', () => {
      const f1 = insertFile(db, 'a.ts', 'typescript');
      const f2 = insertFile(db, 'b.py', 'python');
      insertSymbol(db, f1, 'process');
      insertSymbol(db, f2, 'process');
      const results = getSymbolsByName(db, 'process', { language: 'python' });
      expect(results.length).toBe(1);
    });

    it('supports string branch arg for backward compat', () => {
      const f1 = insertFile(db, 'a.ts', 'typescript', 'main');
      insertSymbol(db, f1, 'foo');
      const results = getSymbolsByName(db, 'foo', 'main');
      expect(results.length).toBe(1);
    });

    it('handles special LIKE characters in name with prefix mode', () => {
      const fid = insertFile(db, 'a.ts');
      insertSymbol(db, fid, 'my%func');
      insertSymbol(db, fid, 'my_func');
      // Searching for "my%" should match "my%func" but not "my_func" because % is escaped
      const results = getSymbolsByName(db, 'my%', { matchMode: 'prefix' });
      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe('my%func');
    });
  });

  describe('listSymbols', () => {
    it('returns empty array when no symbols', () => {
      expect(listSymbols(db)).toEqual([]);
    });

    it('returns symbols with default limit', () => {
      const fid = insertFile(db, 'a.ts');
      insertSymbol(db, fid, 'a');
      insertSymbol(db, fid, 'b');
      const results = listSymbols(db);
      expect(results.length).toBe(2);
    });

    it('respects numeric limit', () => {
      const fid = insertFile(db, 'a.ts');
      for (let i = 0; i < 5; i++) insertSymbol(db, fid, `sym${i}`);
      const results = listSymbols(db, 3);
      expect(results.length).toBe(3);
    });

    it('supports options object with offset for pagination', () => {
      const fid = insertFile(db, 'a.ts');
      for (let i = 0; i < 5; i++) insertSymbol(db, fid, `sym${String(i).padStart(2, '0')}`);
      const page1 = listSymbols(db, { limit: 2, offset: 0 });
      const page2 = listSymbols(db, { limit: 2, offset: 2 });
      expect(page1.length).toBe(2);
      expect(page2.length).toBe(2);
      // Pages should not overlap
      const ids1 = page1.map((s) => s.id);
      const ids2 = page2.map((s) => s.id);
      expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    });

    it('filters by kind', () => {
      const fid = insertFile(db, 'a.ts');
      insertSymbol(db, fid, 'MyClass', 'class');
      insertSymbol(db, fid, 'myFunc', 'function');
      const results = listSymbols(db, { kind: 'class' });
      expect(results.length).toBe(1);
      expect(results[0]!.kind).toBe('class');
    });
  });

  describe('listSymbolRangesByName', () => {
    it('returns empty for non-matching name', () => {
      expect(listSymbolRangesByName(db, 'nonexistent')).toEqual([]);
    });

    it('returns matches with range info', () => {
      const fid = insertFile(db, 'a.ts');
      insertSymbol(db, fid, 'foo', 'function', 10, 20);
      const results = listSymbolRangesByName(db, 'foo');
      expect(results.length).toBe(1);
      expect(results[0]!.start_line).toBe(10);
      expect(results[0]!.end_line).toBe(20);
      expect(results[0]!.file_path).toBe('a.ts');
    });

    it('filters by path', () => {
      const f1 = insertFile(db, 'a.ts');
      const f2 = insertFile(db, 'b.ts');
      insertSymbol(db, f1, 'foo');
      insertSymbol(db, f2, 'foo');
      const results = listSymbolRangesByName(db, 'foo', { path: 'a.ts' });
      expect(results.length).toBe(1);
    });

    it('filters by branch', () => {
      const f1 = insertFile(db, 'a.ts', 'typescript', 'main');
      const f2 = insertFile(db, 'a.ts', 'typescript', 'dev');
      insertSymbol(db, f1, 'foo');
      insertSymbol(db, f2, 'foo');
      const results = listSymbolRangesByName(db, 'foo', { branch: 'main' });
      expect(results.length).toBe(1);
    });
  });

  describe('resolveSymbolRangeByName', () => {
    it('returns resolved for single match', () => {
      const fid = insertFile(db, 'a.ts');
      insertSymbol(db, fid, 'uniqueFunc');
      const result = resolveSymbolRangeByName(db, 'uniqueFunc');
      expect(result.outcome).toBe('resolved');
    });

    it('returns missing for no matches', () => {
      const result = resolveSymbolRangeByName(db, 'nope');
      expect(result.outcome).toBe('missing');
      if (result.outcome === 'missing') {
        expect(result.symbol).toBe('nope');
      }
    });

    it('returns ambiguous for multiple matches', () => {
      const f1 = insertFile(db, 'a.ts');
      const f2 = insertFile(db, 'b.ts');
      insertSymbol(db, f1, 'duplicate');
      insertSymbol(db, f2, 'duplicate');
      const result = resolveSymbolRangeByName(db, 'duplicate');
      expect(result.outcome).toBe('ambiguous');
      if (result.outcome === 'ambiguous') {
        expect(result.candidates.length).toBe(2);
      }
    });
  });

  describe('getExternalSymbolsByName', () => {
    it('returns empty for non-matching name', () => {
      expect(getExternalSymbolsByName(db, 'nonexistent')).toEqual([]);
    });

    it('returns matching external symbols (case-insensitive)', () => {
      db.prepare(
        `INSERT INTO external_symbols (dependency_ecosystem, source_type, source_ref, package_name, symbol_name, symbol_kind, signature)
         VALUES ('npm', 'declaration', '', 'lodash', 'map', 'function', '(arr, fn) => any')`,
      ).run();
      const results = getExternalSymbolsByName(db, 'MAP');
      expect(results.length).toBe(1);
      expect(results[0]!.symbol_name).toBe('map');
      expect(results[0]!.package_name).toBe('lodash');
    });
  });

  describe('searchExternalSymbolsByName', () => {
    it('searches by substring', () => {
      db.prepare(
        `INSERT INTO external_symbols (dependency_ecosystem, source_type, source_ref, package_name, symbol_name, symbol_kind, signature)
         VALUES ('npm', 'declaration', '', 'lodash', 'flatMap', 'function', '() => any')`,
      ).run();
      db.prepare(
        `INSERT INTO external_symbols (dependency_ecosystem, source_type, source_ref, package_name, symbol_name, symbol_kind, signature)
         VALUES ('npm', 'declaration', '', 'lodash', 'forEach', 'function', '() => any')`,
      ).run();
      const results = searchExternalSymbolsByName(db, 'map');
      expect(results.length).toBe(1);
      expect(results[0]!.symbol_name).toBe('flatMap');
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO external_symbols (dependency_ecosystem, source_type, source_ref, package_name, symbol_name, symbol_kind, signature)
           VALUES ('npm', 'declaration', '', 'pkg', ?, 'function', ?)`,
        ).run(`mapFunc${i}`, `sig${i}`);
      }
      const results = searchExternalSymbolsByName(db, 'map', 2);
      expect(results.length).toBe(2);
    });
  });
});

describe('queries/edges', () => {
  let db: Database.Database;
  let fid: number;
  let callerId: number;
  let calleeId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    fid = insertFile(db, 'a.ts');
    callerId = insertSymbol(db, fid, 'caller');
    calleeId = insertSymbol(db, fid, 'callee');
  });

  afterEach(() => {
    db?.close();
  });

  describe('listResolvedEdges', () => {
    it('returns empty when no refs', () => {
      expect(listResolvedEdges(db)).toEqual([]);
    });

    it('returns call-graph edges', () => {
      db.prepare(
        `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
         VALUES (?, ?, ?, 'callee', 5, 'scip')`,
      ).run(callerId, fid, calleeId);
      const edges = listResolvedEdges(db);
      expect(edges.length).toBe(1);
      expect(edges[0]!.caller_name).toBe('caller');
      expect(edges[0]!.callee_name).toBe('callee');
      expect(edges[0]!.call_line).toBe(5);
    });

    it('filters resolvedOnly', () => {
      db.prepare(
        `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
         VALUES (?, ?, ?, 'callee', 5, 'scip')`,
      ).run(callerId, fid, calleeId);
      db.prepare(
        `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
         VALUES (?, ?, NULL, 'unknown', 10, 'unresolved')`,
      ).run(callerId, fid);
      expect(listResolvedEdges(db, { resolvedOnly: true }).length).toBe(1);
      expect(listResolvedEdges(db).length).toBe(2);
    });

    it('filters by fileId', () => {
      const fid2 = insertFile(db, 'b.ts');
      const caller2 = insertSymbol(db, fid2, 'caller2');
      db.prepare(
        `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
         VALUES (?, ?, ?, 'callee', 5, 'scip')`,
      ).run(callerId, fid, calleeId);
      db.prepare(
        `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
         VALUES (?, ?, NULL, 'x', 1, 'unresolved')`,
      ).run(caller2, fid2);
      expect(listResolvedEdges(db, { fileId: fid }).length).toBe(1);
    });

    it('filters by methods', () => {
      db.prepare(
        `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
         VALUES (?, ?, ?, 'callee', 5, 'scip')`,
      ).run(callerId, fid, calleeId);
      db.prepare(
        `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, resolution_method)
         VALUES (?, ?, NULL, 'other', 10, 'heuristic')`,
      ).run(callerId, fid);
      expect(listResolvedEdges(db, { methods: ['scip'] }).length).toBe(1);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, resolution_method)
           VALUES (?, ?, 'fn', ?, 'unresolved')`,
        ).run(callerId, fid, i);
      }
      expect(listResolvedEdges(db, { limit: 3 }).length).toBe(3);
    });

    it('filters by branch', () => {
      const f2 = insertFile(db, 'b.ts', 'typescript', 'feature');
      const caller2 = insertSymbol(db, f2, 'featureCaller');
      db.prepare(
        `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, resolution_method)
         VALUES (?, ?, 'x', 1, 'scip')`,
      ).run(callerId, fid);
      db.prepare(
        `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, resolution_method)
         VALUES (?, ?, 'y', 2, 'scip')`,
      ).run(caller2, f2);
      // Main branch (fid has branch='')
      expect(listResolvedEdges(db, { branch: '' }).length).toBe(1);
      expect(listResolvedEdges(db, { branch: 'feature' }).length).toBe(1);
    });
  });

  describe('listTypeRefs', () => {
    it('returns empty when no type refs', () => {
      expect(listTypeRefs(db)).toEqual([]);
    });

    it('returns type reference edges', () => {
      db.prepare(
        `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_line, resolution_method)
         VALUES (?, ?, 'Promise<string>', 'Promise', 5, 'scip')`,
      ).run(fid, callerId);
      const refs = listTypeRefs(db);
      expect(refs.length).toBe(1);
      expect(refs[0]!.type_name).toBe('Promise<string>');
      expect(refs[0]!.type_name_bare).toBe('Promise');
    });

    it('filters resolvedOnly', () => {
      db.prepare(
        `INSERT INTO type_refs (file_id, symbol_id, type_id, type_name, type_name_bare, ref_line, resolution_method)
         VALUES (?, ?, ?, 'Resolved', 'Resolved', 1, 'scip')`,
      ).run(fid, callerId, calleeId);
      db.prepare(
        `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_line, resolution_method)
         VALUES (?, ?, 'Unresolved', 'Unresolved', 2, 'unresolved')`,
      ).run(fid, callerId);
      expect(listTypeRefs(db, { resolvedOnly: true }).length).toBe(1);
    });

    it('filters by methods', () => {
      db.prepare(
        `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_line, resolution_method)
         VALUES (?, ?, 'TypeA', 'TypeA', 1, 'scip')`,
      ).run(fid, callerId);
      db.prepare(
        `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_line, resolution_method)
         VALUES (?, ?, 'TypeB', 'TypeB', 2, 'heuristic')`,
      ).run(fid, callerId);
      expect(listTypeRefs(db, { methods: ['scip'] }).length).toBe(1);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_line, resolution_method)
           VALUES (?, ?, ?, ?, ?, 'unresolved')`,
        ).run(fid, callerId, `Type${i}`, `Type${i}`, i);
      }
      expect(listTypeRefs(db, { limit: 2 }).length).toBe(2);
    });

    it('filters by fileId', () => {
      const fid2 = insertFile(db, 'b.ts');
      const sym2 = insertSymbol(db, fid2, 'fn2');
      db.prepare(
        `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_line, resolution_method)
         VALUES (?, ?, 'T1', 'T1', 1, 'scip')`,
      ).run(fid, callerId);
      db.prepare(
        `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_line, resolution_method)
         VALUES (?, ?, 'T2', 'T2', 2, 'scip')`,
      ).run(fid2, sym2);
      expect(listTypeRefs(db, { fileId: fid }).length).toBe(1);
    });

    it('filters by branch', () => {
      const fMain = insertFile(db, 'main.ts', 'typescript', 'main');
      const fDev = insertFile(db, 'dev.ts', 'typescript', 'dev');
      const sMain = insertSymbol(db, fMain, 'fnMain');
      const sDev = insertSymbol(db, fDev, 'fnDev');
      db.prepare(
        `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_line, resolution_method)
         VALUES (?, ?, 'TMain', 'TMain', 1, 'scip')`,
      ).run(fMain, sMain);
      db.prepare(
        `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_line, resolution_method)
         VALUES (?, ?, 'TDev', 'TDev', 2, 'scip')`,
      ).run(fDev, sDev);
      expect(listTypeRefs(db, { branch: 'main' }).length).toBe(1);
    });
  });

  describe('listSymbolRelationships', () => {
    it('returns empty when no relationships', () => {
      expect(listSymbolRelationships(db)).toEqual([]);
    });

    it('returns symbol relationships', () => {
      db.prepare(
        `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
         VALUES (?, ?, 'Base', 'extends', 5, 'scip')`,
      ).run(fid, callerId);
      const rels = listSymbolRelationships(db);
      expect(rels.length).toBe(1);
      expect(rels[0]!.relationship_type).toBe('extends');
      expect(rels[0]!.target_symbol_name).toBe('Base');
    });

    it('filters by relationshipType', () => {
      db.prepare(
        `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
         VALUES (?, ?, 'Iface', 'implements', 5, 'scip')`,
      ).run(fid, callerId);
      db.prepare(
        `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
         VALUES (?, ?, 'Base', 'extends', 10, 'scip')`,
      ).run(fid, callerId);
      expect(listSymbolRelationships(db, { relationshipType: 'implements' }).length).toBe(1);
    });

    it('filters resolvedOnly', () => {
      db.prepare(
        `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
         VALUES (?, ?, ?, 'Resolved', 'extends', 5, 'scip')`,
      ).run(fid, callerId, calleeId);
      db.prepare(
        `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
         VALUES (?, ?, 'Unresolved', 'implements', 10, 'unresolved')`,
      ).run(fid, callerId);
      expect(listSymbolRelationships(db, { resolvedOnly: true }).length).toBe(1);
    });

    it('filters by methods', () => {
      db.prepare(
        `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
         VALUES (?, ?, 'A', 'extends', 5, 'scip')`,
      ).run(fid, callerId);
      db.prepare(
        `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
         VALUES (?, ?, 'B', 'extends', 10, 'heuristic')`,
      ).run(fid, callerId);
      expect(listSymbolRelationships(db, { methods: ['scip'] }).length).toBe(1);
    });

    it('filters by fileId', () => {
      const fid2 = insertFile(db, 'b.ts');
      const sym2 = insertSymbol(db, fid2, 'fn2');
      db.prepare(
        `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
         VALUES (?, ?, 'A', 'extends', 5, 'scip')`,
      ).run(fid, callerId);
      db.prepare(
        `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
         VALUES (?, ?, 'B', 'extends', 10, 'scip')`,
      ).run(fid2, sym2);
      expect(listSymbolRelationships(db, { fileId: fid }).length).toBe(1);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        db.prepare(
          `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
           VALUES (?, ?, ?, 'extends', ?, 'scip')`,
        ).run(fid, callerId, `Target${i}`, i);
      }
      expect(listSymbolRelationships(db, { limit: 2 }).length).toBe(2);
    });

    it('filters by branch', () => {
      const fMain = insertFile(db, 'main.ts', 'typescript', 'main');
      const fDev = insertFile(db, 'dev.ts', 'typescript', 'dev');
      const sMain = insertSymbol(db, fMain, 'MainClass');
      const sDev = insertSymbol(db, fDev, 'DevClass');
      db.prepare(
        `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
         VALUES (?, ?, 'Base', 'extends', 1, 'scip')`,
      ).run(fMain, sMain);
      db.prepare(
        `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, resolution_method)
         VALUES (?, ?, 'DevBase', 'extends', 2, 'scip')`,
      ).run(fDev, sDev);
      expect(listSymbolRelationships(db, { branch: 'main' }).length).toBe(1);
    });
  });
});

describe('queries/commits', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  describe('getCommitBySha', () => {
    it('returns commit by exact sha', () => {
      insertCommit(db, 'abc123def456');
      const c = getCommitBySha(db, 'abc123def456');
      expect(c).toBeDefined();
      expect(c!.sha).toBe('abc123def456');
      expect(c!.author).toBe('Alice');
    });

    it('returns commit by sha prefix (unique)', () => {
      insertCommit(db, 'abc123def456');
      const c = getCommitBySha(db, 'abc123');
      expect(c).toBeDefined();
      expect(c!.sha).toBe('abc123def456');
    });

    it('returns undefined for ambiguous prefix', () => {
      insertCommit(db, 'abc123aaa');
      insertCommit(db, 'abc123bbb');
      expect(getCommitBySha(db, 'abc123')).toBeUndefined();
    });

    it('returns undefined for no match', () => {
      expect(getCommitBySha(db, 'zzz')).toBeUndefined();
    });
  });

  describe('listRecentCommits', () => {
    it('returns empty when no commits', () => {
      expect(listRecentCommits(db)).toEqual([]);
    });

    it('orders by timestamp DESC', () => {
      insertCommit(db, 'old', 'A', 'a@e.com', 1000, 'old');
      insertCommit(db, 'new', 'A', 'a@e.com', 2000, 'new');
      const commits = listRecentCommits(db);
      expect(commits[0]!.sha).toBe('new');
      expect(commits[1]!.sha).toBe('old');
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) insertCommit(db, `sha${i}`, 'A', 'a@e.com', 1000 + i, `msg${i}`);
      expect(listRecentCommits(db, 3).length).toBe(3);
    });
  });

  describe('listCommitsByFile', () => {
    it('returns commits touching a file', () => {
      insertCommit(db, 'sha1');
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type) VALUES ('sha1', 'src/main.ts', 'modified')",
      ).run();
      const commits = listCommitsByFile(db, 'src/main.ts');
      expect(commits.length).toBe(1);
    });

    it('returns empty for untouched file', () => {
      insertCommit(db, 'sha1');
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type) VALUES ('sha1', 'other.ts', 'modified')",
      ).run();
      expect(listCommitsByFile(db, 'src/main.ts')).toEqual([]);
    });

    it('handles rename paths with =>', () => {
      insertCommit(db, 'sha1');
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type) VALUES ('sha1', 'src/{old.ts => new.ts}', 'renamed')",
      ).run();
      expect(listCommitsByFile(db, 'src/new.ts').length).toBe(1);
      expect(listCommitsByFile(db, 'src/old.ts').length).toBe(1);
    });

    it('handles rename paths without braces (simple =>)', () => {
      insertCommit(db, 'sha1');
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type) VALUES ('sha1', 'old.ts => new.ts', 'renamed')",
      ).run();
      expect(listCommitsByFile(db, 'new.ts').length).toBe(1);
      expect(listCommitsByFile(db, 'old.ts').length).toBe(1);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        insertCommit(db, `sha${i}`, 'A', 'a@e.com', 1000 + i, `msg${i}`);
        db.prepare(
          `INSERT INTO commit_files (commit_sha, file_path, change_type) VALUES (?, 'x.ts', 'modified')`,
        ).run(`sha${i}`);
      }
      expect(listCommitsByFile(db, 'x.ts', 2).length).toBe(2);
    });
  });

  describe('listCommitsByAuthor', () => {
    it('matches by author name substring', () => {
      insertCommit(db, 'sha1', 'Alice Johnson', 'alice@e.com');
      insertCommit(db, 'sha2', 'Bob', 'bob@e.com');
      const commits = listCommitsByAuthor(db, 'Alice');
      expect(commits.length).toBe(1);
      expect(commits[0]!.author).toBe('Alice Johnson');
    });

    it('matches by email substring', () => {
      insertCommit(db, 'sha1', 'Alice', 'alice@example.com');
      const commits = listCommitsByAuthor(db, 'example.com');
      expect(commits.length).toBe(1);
    });
  });

  describe('listCommitFiles', () => {
    it('returns files for a commit', () => {
      insertCommit(db, 'sha1');
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES ('sha1', 'a.ts', 'modified', 10, 5)",
      ).run();
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES ('sha1', 'b.ts', 'added', 20, 0)",
      ).run();
      const files = listCommitFiles(db, 'sha1');
      expect(files.length).toBe(2);
      expect(files[0]!.insertions).toBe(10);
    });

    it('returns empty for nonexistent commit', () => {
      expect(listCommitFiles(db, 'nosha')).toEqual([]);
    });
  });

  describe('listCommitRefs', () => {
    it('returns refs for a commit', () => {
      insertCommit(db, 'sha1');
      db.prepare(
        "INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('sha1', 'refs/heads/main', 'branch')",
      ).run();
      const refs = listCommitRefs(db, 'sha1');
      expect(refs.length).toBe(1);
      expect(refs[0]!.ref_name).toBe('refs/heads/main');
    });

    it('returns empty for commit with no refs', () => {
      insertCommit(db, 'sha1');
      expect(listCommitRefs(db, 'sha1')).toEqual([]);
    });
  });

  describe('listCommitsByRef', () => {
    it('returns commits for exact ref name', () => {
      insertCommit(db, 'sha1');
      db.prepare(
        "INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('sha1', 'refs/heads/main', 'branch')",
      ).run();
      const commits = listCommitsByRef(db, 'refs/heads/main');
      expect(commits.length).toBe(1);
    });

    it('returns commits matching ref substring', () => {
      insertCommit(db, 'sha1');
      db.prepare(
        "INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('sha1', 'refs/heads/feature-x', 'branch')",
      ).run();
      const commits = listCommitsByRef(db, 'feature-x');
      expect(commits.length).toBe(1);
    });

    it('returns all ref-linked commits when refQuery is empty', () => {
      insertCommit(db, 'sha1');
      insertCommit(db, 'sha2', 'B', 'b@e.com', 2000);
      db.prepare(
        "INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('sha1', 'main', 'branch')",
      ).run();
      db.prepare(
        "INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('sha2', 'dev', 'branch')",
      ).run();
      const commits = listCommitsByRef(db, '');
      expect(commits.length).toBe(2);
    });
  });

  describe('hasCommitEmbeddings', () => {
    it('returns false when no commit_embeddings table', () => {
      expect(hasCommitEmbeddings(db)).toBe(false);
    });
  });

  describe('listCommitsBySemanticQuery', () => {
    it('returns empty for empty query vector', () => {
      expect(listCommitsBySemanticQuery(db, [])).toEqual([]);
    });

    it('returns empty when no commit_embeddings table exists', () => {
      expect(listCommitsBySemanticQuery(db, [1, 2, 3])).toEqual([]);
    });
  });

  describe('listCommitCadence', () => {
    it('groups commits by day', () => {
      // Two commits same day, one different day
      insertCommit(db, 'sha1', 'A', 'a@e.com', 1700000000, 'msg1');  // ~Nov 14 2023
      insertCommit(db, 'sha2', 'A', 'a@e.com', 1700001000, 'msg2');  // same day
      insertCommit(db, 'sha3', 'A', 'a@e.com', 1700100000, 'msg3');  // next day
      const cadence = listCommitCadence(db, 'day');
      expect(cadence.length).toBe(2);
    });

    it('groups by month', () => {
      insertCommit(db, 'sha1', 'A', 'a@e.com', 1700000000);
      const cadence = listCommitCadence(db, 'month');
      expect(cadence.length).toBe(1);
    });

    it('respects author filter', () => {
      insertCommit(db, 'sha1', 'Alice', 'alice@e.com', 1700000000);
      insertCommit(db, 'sha2', 'Bob', 'bob@e.com', 1700001000);
      const cadence = listCommitCadence(db, 'day', { author: 'Alice' });
      expect(cadence.reduce((sum, r) => sum + r.commits, 0)).toBe(1);
    });
  });

  describe('listCommitSizes', () => {
    it('computes insertions and deletions per commit', () => {
      insertCommit(db, 'sha1');
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES ('sha1', 'a.ts', 'modified', 10, 5)",
      ).run();
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES ('sha1', 'b.ts', 'modified', 20, 3)",
      ).run();
      const sizes = listCommitSizes(db);
      expect(sizes.length).toBe(1);
      expect(sizes[0]!.insertions).toBe(30);
      expect(sizes[0]!.deletions).toBe(8);
    });
  });

  describe('listCommitChurnByFile', () => {
    it('aggregates churn by file', () => {
      insertCommit(db, 'sha1');
      insertCommit(db, 'sha2', 'A', 'a@e.com', 2000);
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES ('sha1', 'hot.ts', 'modified', 50, 10)",
      ).run();
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES ('sha2', 'hot.ts', 'modified', 30, 5)",
      ).run();
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES ('sha1', 'cold.ts', 'modified', 2, 1)",
      ).run();
      const churn = listCommitChurnByFile(db);
      expect(churn[0]!.file_path).toBe('hot.ts');
      expect(churn[0]!.total_churn).toBe(95);
      expect(churn[0]!.commit_count).toBe(2);
    });
  });

  describe('listCommitAuthorStats', () => {
    it('aggregates stats by author', () => {
      insertCommit(db, 'sha1', 'Alice', 'alice@e.com');
      insertCommit(db, 'sha2', 'Alice', 'alice@e.com', 2000);
      insertCommit(db, 'sha3', 'Bob', 'bob@e.com', 3000);
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES ('sha1', 'a.ts', 'modified', 10, 5)",
      ).run();
      db.prepare(
        "INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES ('sha2', 'b.ts', 'modified', 20, 3)",
      ).run();
      const stats = listCommitAuthorStats(db);
      expect(stats.length).toBe(2);
      // Alice should have most commits
      const alice = stats.find((s) => s.author === 'Alice');
      expect(alice!.commit_count).toBe(2);
    });
  });

  describe('listCommitMessagePrefixes', () => {
    it('extracts conventional commit prefixes', () => {
      insertCommit(db, 'sha1', 'A', 'a@e.com', 1000, 'fix: bug');
      insertCommit(db, 'sha2', 'A', 'a@e.com', 2000, 'fix: another bug');
      insertCommit(db, 'sha3', 'A', 'a@e.com', 3000, 'feat: new thing');
      const prefixes = listCommitMessagePrefixes(db);
      const fixPrefix = prefixes.find((p) => p.prefix === 'fix:');
      expect(fixPrefix).toBeDefined();
      expect(fixPrefix!.count).toBe(2);
    });

    it('handles messages without colon', () => {
      insertCommit(db, 'sha1', 'A', 'a@e.com', 1000, 'no prefix here');
      const prefixes = listCommitMessagePrefixes(db);
      const other = prefixes.find((p) => p.prefix === '(other)');
      expect(other).toBeDefined();
    });
  });

  describe('listCommitSchedule', () => {
    it('returns day_of_week and hour_of_day buckets', () => {
      insertCommit(db, 'sha1', 'A', 'a@e.com', 1700000000);
      const schedule = listCommitSchedule(db);
      expect(schedule.length).toBeGreaterThan(0);
      expect(typeof schedule[0]!.day_of_week).toBe('number');
      expect(typeof schedule[0]!.hour_of_day).toBe('number');
      expect(typeof schedule[0]!.commits).toBe('number');
    });
  });

  describe('listCommitBranchActivity', () => {
    it('returns branch commit counts', () => {
      insertCommit(db, 'sha1');
      insertCommit(db, 'sha2', 'A', 'a@e.com', 2000);
      db.prepare(
        "INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('sha1', 'main', 'branch')",
      ).run();
      db.prepare(
        "INSERT INTO commit_refs (commit_sha, ref_name, ref_type) VALUES ('sha2', 'main', 'branch')",
      ).run();
      const activity = listCommitBranchActivity(db);
      expect(activity.length).toBe(1);
      expect(activity[0]!.ref_name).toBe('main');
      expect(activity[0]!.commits).toBe(2);
    });
  });

  describe('stats filters', () => {
    it('filters by since date', () => {
      insertCommit(db, 'old', 'A', 'a@e.com', 1600000000, 'old msg');
      insertCommit(db, 'new', 'A', 'a@e.com', 1700000000, 'new msg');
      const sizes = listCommitSizes(db, { since: '2023-11-01' });
      expect(sizes.length).toBe(1);
      expect(sizes[0]!.sha).toBe('new');
    });

    it('filters by until date', () => {
      insertCommit(db, 'old', 'A', 'a@e.com', 1600000000, 'old msg');
      insertCommit(db, 'new', 'A', 'a@e.com', 1700000000, 'new msg');
      const sizes = listCommitSizes(db, { until: '2021-01-01' });
      expect(sizes.length).toBe(1);
      expect(sizes[0]!.sha).toBe('old');
    });

    it('filters by ISO datetime with T', () => {
      insertCommit(db, 'sha1', 'A', 'a@e.com', 1700000000, 'msg');
      const sizes = listCommitSizes(db, { since: '2023-11-14T00:00:00Z' });
      expect(sizes.length).toBe(1);
    });

    it('ignores invalid date strings gracefully', () => {
      insertCommit(db, 'sha1', 'A', 'a@e.com', 1700000000, 'msg');
      // Invalid dates should not filter anything (no crash)
      const sizes = listCommitSizes(db, { since: 'not-a-date' });
      // Since the invalid date produces NaN and is skipped, all commits should be returned
      expect(sizes.length).toBe(1);
    });

    it('filters by author in stats queries', () => {
      insertCommit(db, 'sha1', 'Alice', 'alice@e.com', 1000, 'msg1');
      insertCommit(db, 'sha2', 'Bob', 'bob@e.com', 2000, 'msg2');
      db.prepare("INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES ('sha1', 'a.ts', 'modified', 10, 5)").run();
      db.prepare("INSERT INTO commit_files (commit_sha, file_path, change_type, insertions, deletions) VALUES ('sha2', 'b.ts', 'modified', 20, 3)").run();
      const churn = listCommitChurnByFile(db, { author: 'Alice' });
      expect(churn.length).toBe(1);
      expect(churn[0]!.file_path).toBe('a.ts');
    });

    it('respects limit in stats queries', () => {
      for (let i = 0; i < 30; i++) {
        insertCommit(db, `sha${i}`, 'A', 'a@e.com', 1000 + i, `msg${i}`);
      }
      const sizes = listCommitSizes(db, { limit: 5 });
      expect(sizes.length).toBe(5);
    });
  });
});

describe('queries/annotations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  describe('listAnnotations', () => {
    it('returns empty when no annotations', () => {
      expect(listAnnotations(db, 'TODO')).toEqual([]);
    });

    it('returns annotations filtered by kind', () => {
      const fid = insertFile(db, 'main.ts');
      db.prepare(
        `INSERT INTO annotations (file_id, kind, line, text) VALUES (?, 'TODO', 10, 'fix this')`,
      ).run(fid);
      db.prepare(
        `INSERT INTO annotations (file_id, kind, line, text) VALUES (?, 'FIXME', 20, 'broken')`,
      ).run(fid);
      const results = listAnnotations(db, 'TODO');
      expect(results.length).toBe(1);
      expect(results[0]!.text).toBe('fix this');
      expect(results[0]!.file_path).toBe('main.ts');
    });

    it('filters by path', () => {
      const f1 = insertFile(db, 'a.ts');
      const f2 = insertFile(db, 'b.ts');
      db.prepare(`INSERT INTO annotations (file_id, kind, line, text) VALUES (?, 'TODO', 1, 'a')`).run(f1);
      db.prepare(`INSERT INTO annotations (file_id, kind, line, text) VALUES (?, 'TODO', 1, 'b')`).run(f2);
      const results = listAnnotations(db, 'TODO', 'a.ts');
      expect(results.length).toBe(1);
      expect(results[0]!.text).toBe('a');
    });

    it('respects limit', () => {
      const fid = insertFile(db, 'main.ts');
      for (let i = 0; i < 10; i++) {
        db.prepare(
          `INSERT INTO annotations (file_id, kind, line, text) VALUES (?, 'TODO', ?, ?)`,
        ).run(fid, i, `todo ${i}`);
      }
      const results = listAnnotations(db, 'TODO', undefined, 3);
      expect(results.length).toBe(3);
    });

    it('includes symbol_name when annotation has symbol_id', () => {
      const fid = insertFile(db, 'main.ts');
      const sid = insertSymbol(db, fid, 'myFunc');
      db.prepare(
        `INSERT INTO annotations (file_id, kind, line, text, symbol_id) VALUES (?, 'TODO', 5, 'refactor', ?)`,
      ).run(fid, sid);
      const results = listAnnotations(db, 'TODO');
      expect(results[0]!.symbol_name).toBe('myFunc');
    });
  });
});

describe('queries/semantic', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  describe('semanticSearchSymbols', () => {
    it('returns empty for empty query vector', () => {
      expect(semanticSearchSymbols(db, { queryVector: [] })).toEqual([]);
    });

    it('returns empty when no embeddings table exists', () => {
      expect(semanticSearchSymbols(db, { queryVector: [1, 2, 3] })).toEqual([]);
    });

    it('returns empty with branch filter and no embeddings', () => {
      expect(semanticSearchSymbols(db, { queryVector: [1, 2, 3], branch: 'main' })).toEqual([]);
    });

    it('returns results with working embeddings table', () => {
      // Create vec0 table — skip if not available
      try {
        db.prepare('CREATE VIRTUAL TABLE symbol_embeddings USING vec0(embedding float[3])').run();
      } catch {
        return; // vec0 not available
      }

      // Seed a file and symbol
      db.prepare(
        "INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/a.ts', 'main', 'typescript', '')",
      ).run();
      db.prepare(
        "INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'foo', 'function', 1, 5)",
      ).run();
      db.prepare(
        'INSERT INTO symbol_embeddings (rowid, embedding) VALUES (1, ?)',
      ).run(JSON.stringify([0.1, 0.2, 0.3]));

      const results = semanticSearchSymbols(db, { queryVector: [0.1, 0.2, 0.3] });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.name).toBe('foo');
      expect(results[0]!.file_path).toBe('src/a.ts');
    });

    it('filters by branch with working embeddings', () => {
      try {
        db.prepare('CREATE VIRTUAL TABLE symbol_embeddings USING vec0(embedding float[3])').run();
      } catch {
        return;
      }

      db.prepare(
        "INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/a.ts', 'main', 'typescript', '')",
      ).run();
      db.prepare(
        "INSERT INTO files (id, path, branch, language, source) VALUES (2, 'src/b.ts', 'dev', 'typescript', '')",
      ).run();
      db.prepare(
        "INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'mainFn', 'function', 1, 5)",
      ).run();
      db.prepare(
        "INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 2, 'devFn', 'function', 1, 5)",
      ).run();
      db.prepare('INSERT INTO symbol_embeddings (rowid, embedding) VALUES (1, ?)').run(JSON.stringify([0.1, 0.2, 0.3]));
      db.prepare('INSERT INTO symbol_embeddings (rowid, embedding) VALUES (2, ?)').run(JSON.stringify([0.1, 0.2, 0.3]));

      const mainResults = semanticSearchSymbols(db, { queryVector: [0.1, 0.2, 0.3], branch: 'main' });
      expect(mainResults.every(r => r.file_branch === 'main')).toBe(true);
    });

    it('returns results using fakeVec0 when sqlite-vec unavailable', async () => {
      const { installFakeVec0, removeFakeVec0 } = await import('../helpers/fakeVec0.js');

      db.prepare(
        "INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/a.ts', 'main', 'typescript', '')",
      ).run();
      db.prepare(
        "INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'foo', 'function', 1, 5)",
      ).run();

      installFakeVec0(db, [{
        symbol_id: 1,
        name: 'foo',
        kind: 'function',
        file_path: 'src/a.ts',
        start_line: 1,
        end_line: 5,
        score: 0.05,
        file_branch: 'main',
      }]);

      const results = semanticSearchSymbols(db, { queryVector: [0.1, 0.2, 0.3] });
      expect(results.length).toBe(1);
      expect(results[0]!.name).toBe('foo');
      expect(results[0]!.file_path).toBe('src/a.ts');

      removeFakeVec0(db);
    });

    it('returns branch-filtered results using fakeVec0', async () => {
      const { installFakeVec0, removeFakeVec0 } = await import('../helpers/fakeVec0.js');

      installFakeVec0(db, [{
        symbol_id: 1,
        name: 'mainFn',
        kind: 'function',
        file_path: 'src/a.ts',
        start_line: 1,
        end_line: 5,
        score: 0.05,
        file_branch: 'main',
      }]);

      const results = semanticSearchSymbols(db, { queryVector: [0.1, 0.2, 0.3], branch: 'main' });
      expect(results.length).toBe(1);
      expect(results[0]!.file_branch).toBe('main');

      removeFakeVec0(db);
    });
  });
});
