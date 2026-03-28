import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { openDb, type Database } from '../../src/db/schema.js';
import { enrichProjectRefs, LspEnrichmentStage } from '../../src/indexer/stages/lsp-enrichment.js';
import { LspEnrichmentCoordinator, type LspClientFactory } from '../../src/lsp/enrichment.js';
import type { EffectiveLspSettings } from '../../src/lsp/config.js';
import { FakeLspClient } from '../helpers/fakeLspClient.js';

// Helper: create a minimal LSP-settings-like object
function fakeLspSettings(): EffectiveLspSettings {
  return { enabled: true, requestTimeoutMs: 1000, servers: { typescript: { command: 'fake-ts', args: [] } } };
}

// Helper: create a coordinator with fake client
function fakeCoordinator(fakeClient: FakeLspClient, tmpDir: string): LspEnrichmentCoordinator {
  // Create a fake executable so registry resolves the server as available
  const binDir = mkdtempSync(join(tmpdir(), 'lore-test-bin-'));
  writeFileSync(join(binDir, 'fake-ts'), '#!/bin/sh\n', { mode: 0o755 });
  const processEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  const factory: LspClientFactory = () => fakeClient;
  return new LspEnrichmentCoordinator(
    fakeLspSettings(),
    tmpDir,
    factory,
    processEnv,
  );
}

describe('enrichProjectRefs', () => {
  let db: Database.Database;
  let tmpDir: string;
  let fakeClient: FakeLspClient;
  let coordinator: LspEnrichmentCoordinator;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lore-enrich-'));
    db = openDb(':memory:');
    fakeClient = new FakeLspClient();
    coordinator = fakeCoordinator(fakeClient, tmpDir);
  });

  afterEach(async () => {
    await coordinator.dispose();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: insert test data
  function insertFile(filePath: string, lang = 'typescript'): number {
    const info = db.prepare(
      `INSERT INTO files (path, branch, language, size_bytes, last_hash, source, layer, generation)
       VALUES (?, 'main', ?, 100, 'abc', 'source', 'baseline', 1)`
    ).run(filePath, lang);
    return Number((info as any).lastInsertRowid);
  }

  function insertSymbol(fileId: number, name: string, startLine: number): number {
    const info = db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, layer, generation)
       VALUES (?, ?, 'function', ?, ?, 'baseline', 1)`
    ).run(fileId, name, startLine, startLine + 5);
    return Number((info as any).lastInsertRowid);
  }

  function insertCallRef(callerId: number, fileId: number, calleeName: string, line: number, char: number): number {
    const info = db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_name, call_line, call_character, resolution_method, layer, generation)
       VALUES (?, ?, ?, ?, ?, 'unresolved', 'baseline', 1)`
    ).run(callerId, fileId, calleeName, line, char);
    return Number((info as any).lastInsertRowid);
  }

  function insertTypeRef(fileId: number, symbolId: number, typeName: string, line: number, char: number): number {
    const info = db.prepare(
      `INSERT INTO type_refs (file_id, symbol_id, type_name, type_name_bare, ref_kind, ref_line, ref_character, resolution_method, layer, generation)
       VALUES (?, ?, ?, ?, 'annotation', ?, ?, 'unresolved', 'baseline', 1)`
    ).run(fileId, symbolId, typeName, typeName, line, char);
    return Number((info as any).lastInsertRowid);
  }

  function insertRelationship(fileId: number, sourceSymbolId: number, targetName: string, line: number, char: number): number {
    const info = db.prepare(
      `INSERT INTO symbol_relationships (file_id, source_symbol_id, target_symbol_name, relationship_type, line, character, resolution_method, layer, generation)
       VALUES (?, ?, ?, 'extends', ?, ?, 'unresolved', 'baseline', 1)`
    ).run(fileId, sourceSymbolId, targetName, line, char);
    return Number((info as any).lastInsertRowid);
  }

  it('enriches symbols with hover metadata', async () => {
    const filePath = join(tmpDir, 'test.ts');
    writeFileSync(filePath, 'function greet(): string { return "hi"; }');
    const fileId = insertFile(filePath);
    const symId = insertSymbol(fileId, 'greet', 0);

    // Configure fake client to return hover data at line 0
    fakeClient.setResponse(0, 0, {
      hover: { contents: { value: '```typescript\nfunction greet(): string\n```' } },
      definition: { uri: pathToFileURL(filePath).toString(), range: { start: { line: 0, character: 0 } } },
    });

    const sourceCache = new Map([[filePath, 'function greet(): string { return "hi"; }']]);
    await enrichProjectRefs(db, 'main', [{ path: filePath, language: 'typescript' }], coordinator, sourceCache);

    const row = db.prepare('SELECT resolved_type_signature, definition_path FROM symbols WHERE id = ?').get(symId) as any;
    expect(row.resolved_type_signature).toContain('greet');
    expect(row.definition_path).toBe(filePath);
  });

  it('enriches call refs with definition location', async () => {
    const filePath = join(tmpDir, 'caller.ts');
    writeFileSync(filePath, 'import { foo } from "./foo";\nfoo();');
    const defPath = join(tmpDir, 'foo.ts');
    const fileId = insertFile(filePath);
    const symId = insertSymbol(fileId, 'main', 0);
    const refId = insertCallRef(symId, fileId, 'foo', 1, 0);

    fakeClient.setResponse(1, 0, {
      hover: { contents: { value: 'function foo(): void' } },
      definition: { uri: pathToFileURL(defPath).toString(), range: { start: { line: 5, character: 10 } } },
    });

    const sourceCache = new Map([[filePath, 'import { foo } from "./foo";\nfoo();']]);
    await enrichProjectRefs(db, 'main', [{ path: filePath, language: 'typescript' }], coordinator, sourceCache);

    const row = db.prepare('SELECT definition_path, definition_line, definition_character FROM symbol_refs WHERE id = ?').get(refId) as any;
    expect(row.definition_path).toBe(defPath);
    expect(row.definition_line).toBe(5);
    expect(row.definition_character).toBe(10);
  });

  it('enriches type refs with metadata', async () => {
    const filePath = join(tmpDir, 'types.ts');
    writeFileSync(filePath, 'const x: MyType = {};');
    const fileId = insertFile(filePath);
    const symId = insertSymbol(fileId, 'x', 0);
    const trId = insertTypeRef(fileId, symId, 'MyType', 0, 9);

    fakeClient.setResponse(0, 9, {
      hover: { contents: { value: 'interface MyType' } },
      definition: { uri: pathToFileURL(filePath).toString(), range: { start: { line: 10, character: 0 } } },
    });

    const sourceCache = new Map([[filePath, 'const x: MyType = {};']]);
    await enrichProjectRefs(db, 'main', [{ path: filePath, language: 'typescript' }], coordinator, sourceCache);

    const row = db.prepare('SELECT resolved_type_signature, definition_line FROM type_refs WHERE id = ?').get(trId) as any;
    expect(row.resolved_type_signature).toContain('MyType');
    expect(row.definition_line).toBe(10);
  });

  it('enriches relationships with definition location', async () => {
    const filePath = join(tmpDir, 'rel.ts');
    writeFileSync(filePath, 'class Foo extends Bar {}');
    const fileId = insertFile(filePath);
    const symId = insertSymbol(fileId, 'Foo', 0);
    const relId = insertRelationship(fileId, symId, 'Bar', 0, 16);

    fakeClient.setResponse(0, 16, {
      definition: { uri: pathToFileURL(filePath).toString(), range: { start: { line: 20, character: 5 } } },
    });

    const sourceCache = new Map([[filePath, 'class Foo extends Bar {}']]);
    await enrichProjectRefs(db, 'main', [{ path: filePath, language: 'typescript' }], coordinator, sourceCache);

    const row = db.prepare('SELECT definition_path, definition_line, definition_character FROM symbol_relationships WHERE id = ?').get(relId) as any;
    expect(row.definition_path).toBe(filePath);
    expect(row.definition_line).toBe(20);
    expect(row.definition_character).toBe(5);
  });

  it('handles file not on disk gracefully', async () => {
    const filePath = join(tmpDir, 'missing.ts');
    const fileId = insertFile(filePath);
    insertSymbol(fileId, 'fn', 0);

    // No writeFileSync — file doesn't exist
    await enrichProjectRefs(db, 'main', [{ path: filePath, language: 'typescript' }], coordinator);
    // Should not throw, symbols remain unenriched
    const row = db.prepare('SELECT resolved_type_signature FROM symbols WHERE file_id = ?').get(fileId) as any;
    expect(row.resolved_type_signature).toBeNull();
  });

  it('uses sourceCache instead of reading from disk', async () => {
    const filePath = join(tmpDir, 'cached.ts');
    // File exists on disk (required by existsSync check), but sourceCache provides the content
    writeFileSync(filePath, 'disk content that should not be used');
    const fileId = insertFile(filePath);
    const symId = insertSymbol(fileId, 'cached', 0);

    fakeClient.setDefaultResponse({
      hover: { contents: { value: 'cached function' } },
    });

    const sourceCache = new Map([[filePath, 'cached function content']]);
    await enrichProjectRefs(db, 'main', [{ path: filePath, language: 'typescript' }], coordinator, sourceCache);

    const row = db.prepare('SELECT resolved_type_signature FROM symbols WHERE id = ?').get(symId) as any;
    expect(row.resolved_type_signature).toBe('cached function');
  });

  it('skips files with no enrichable targets', async () => {
    const filePath = join(tmpDir, 'empty.ts');
    writeFileSync(filePath, '');
    insertFile(filePath);
    // No symbols, refs, or relationships inserted

    await enrichProjectRefs(db, 'main', [{ path: filePath, language: 'typescript' }], coordinator);
    expect(fakeClient.requests).toHaveLength(0);
  });

  it('processes multiple files in batches', async () => {
    const files: Array<{ path: string; language: string }> = [];
    const sourceCache = new Map<string, string>();
    
    for (let i = 0; i < 5; i++) {
      const filePath = join(tmpDir, `file${i}.ts`);
      writeFileSync(filePath, `function f${i}() {}`);
      const fileId = insertFile(filePath);
      insertSymbol(fileId, `f${i}`, 0);
      files.push({ path: filePath, language: 'typescript' });
      sourceCache.set(filePath, `function f${i}() {}`);
    }

    fakeClient.setDefaultResponse({
      hover: { contents: { value: 'some type' } },
    });

    await enrichProjectRefs(db, 'main', files, coordinator, sourceCache);
    // All 5 files should have been opened (one didOpen per file)
    expect(fakeClient.openedDocuments).toHaveLength(5);
  });

  it('handles null metadata from coordinator gracefully', async () => {
    const filePath = join(tmpDir, 'null.ts');
    writeFileSync(filePath, 'function nothing() {}');
    const fileId = insertFile(filePath);
    const symId = insertSymbol(fileId, 'nothing', 0);

    // No responses configured — coordinator returns nulls
    const sourceCache = new Map([[filePath, 'function nothing() {}']]);
    await enrichProjectRefs(db, 'main', [{ path: filePath, language: 'typescript' }], coordinator, sourceCache);

    const row = db.prepare('SELECT resolved_type_signature, definition_path FROM symbols WHERE id = ?').get(symId) as any;
    expect(row.resolved_type_signature).toBeNull();
    expect(row.definition_path).toBeNull();
  });
});

describe('LspEnrichmentStage', () => {
  it('has correct name', () => {
    const stage = new LspEnrichmentStage();
    expect(stage.name).toBe('lsp-enrichment');
  });

  it('clears sourceCache and returns early when lsp is null', async () => {
    const stage = new LspEnrichmentStage();
    const sourceCache = new Map([['a', 'b']]);
    const ctx = {
      lsp: null,
      files: [{ path: '/a', language: 'ts' }],
      sourceCache,
    } as any;
    await stage.execute(ctx, 'build');
    expect(sourceCache.size).toBe(0);
  });

  it('clears sourceCache and returns early when files is empty', async () => {
    const stage = new LspEnrichmentStage();
    const sourceCache = new Map([['a', 'b']]);
    const ctx = {
      lsp: { enabled: true },
      files: [],
      sourceCache,
    } as any;
    await stage.execute(ctx, 'build');
    expect(sourceCache.size).toBe(0);
  });

  it('disposes coordinator on dispose', async () => {
    const stage = new LspEnrichmentStage();
    // No coordinator set — dispose should be safe
    await stage.dispose();
  });
});
