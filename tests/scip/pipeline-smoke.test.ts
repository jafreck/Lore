/**
 * @module tests/scip/pipeline-smoke
 *
 * Pipeline smoke tests that verify SCIP index ingestion end-to-end.
 *
 * Each test uses a small multi-file fixture project with a pre-built
 * `.scip` file (committed in tests/fixtures/scip-projects/scip-indexes/).
 * This avoids installing real SCIP indexer binaries in CI while
 * exercising the full ingestion path: protobuf parsing → symbol
 * extraction → call ref resolution → DB writes → query verification.
 *
 * To regenerate `.scip` files after schema changes, run the real
 * indexer locally:
 *   cd tests/fixtures/scip-projects/typescript
 *   scip-typescript index --output ../scip-indexes/typescript.scip
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { openDb } from '../../src/db/schema.js';
import { IndexBuilder } from '../../src/indexer/index.js';
import { initLogger, LogLevel, resetLogger } from '../../src/logger.js';
import type { EffectiveScipSettings } from '../../src/scip/config.js';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/scip-projects');
const SCIP_INDEXES_DIR = path.join(FIXTURES_DIR, 'scip-indexes');

/** Languages with committed .scip fixture files. */
const AVAILABLE_LANGUAGES = fs.readdirSync(SCIP_INDEXES_DIR)
  .filter(f => f.endsWith('.scip'))
  .map(f => f.replace('.scip', ''));

function makeScipSettings(indexDir: string): EffectiveScipSettings {
  return {
    enabled: true,
    timeoutMs: 5000,
    indexers: {},		// not needed — we use indexDir
    indexDir,
  };
}

describe('SCIP pipeline smoke', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetLogger();
    initLogger({ level: LogLevel.SILENT });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-scip-smoke-'));
  });

  afterEach(() => {
    resetLogger();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const lang of AVAILABLE_LANGUAGES) {
    const projectDir = path.join(FIXTURES_DIR, lang);

    // Skip if no project directory exists for this language
    if (!fs.existsSync(projectDir)) continue;

    describe(lang, () => {
      it('ingests SCIP index and produces symbols in DB', async () => {
        const dbPath = path.join(tmpDir, `${lang}.db`);

        // indexDir is relative to rootDir; ../scip-indexes from the project dir
        const builder = new IndexBuilder(dbPath, { rootDir: projectDir } as any, undefined, {
          scip: makeScipSettings('../scip-indexes'),
          maxWorkers: 0,
        });

        await builder.build();

        const db = openDb(dbPath);
        try {
          // ── Files were indexed ──
          const files = db.prepare('SELECT path, language FROM files').all() as Array<{ path: string; language: string }>;
          expect(files.length).toBeGreaterThanOrEqual(1);

          // ── Symbols were extracted from SCIP ──
          const symbols = db.prepare('SELECT name, kind FROM symbols').all() as Array<{ name: string; kind: string }>;
          expect(symbols.length).toBeGreaterThanOrEqual(2);

          // ── At least one function or method exists ──
          const fns = symbols.filter(s => s.kind === 'function' || s.kind === 'method');
          expect(fns.length).toBeGreaterThanOrEqual(1);
        } finally {
          db.close();
        }
      });

      it('resolves cross-file call references', async () => {
        const dbPath = path.join(tmpDir, `${lang}-refs.db`);

        const builder = new IndexBuilder(dbPath, { rootDir: projectDir } as any, undefined, {
          scip: makeScipSettings('../scip-indexes'),
          maxWorkers: 0,
        });

        await builder.build();

        const db = openDb(dbPath);
        try {
          // ── SCIP produced some form of cross-file edges ──
          // Different indexers may emit call refs, type refs, or relationships.
          const callRefs = db.prepare('SELECT count(*) as c FROM symbol_refs').get() as { c: number };
          const typeRefs = db.prepare('SELECT count(*) as c FROM type_refs').get() as { c: number };
          const relationships = db.prepare('SELECT count(*) as c FROM symbol_relationships').get() as { c: number };
          const totalEdges = callRefs.c + typeRefs.c + relationships.c;
          expect(totalEdges).toBeGreaterThanOrEqual(1);
        } finally {
          db.close();
        }
      });

      it('produces type references', async () => {
        const dbPath = path.join(tmpDir, `${lang}-types.db`);

        const builder = new IndexBuilder(dbPath, { rootDir: projectDir } as any, undefined, {
          scip: makeScipSettings('../scip-indexes'),
          maxWorkers: 0,
        });

        await builder.build();

        const db = openDb(dbPath);
        try {
          // ── Type refs exist (parameter types, return types, field types) ──
          const typeRefs = db.prepare('SELECT * FROM type_refs').all();
          expect(typeRefs.length).toBeGreaterThanOrEqual(1);
        } finally {
          db.close();
        }
      });

      it('MCP tools return results for SCIP-indexed symbols', async () => {
        const dbPath = path.join(tmpDir, `${lang}-mcp.db`);

        const builder = new IndexBuilder(dbPath, { rootDir: projectDir } as any, undefined, {
          scip: makeScipSettings('../scip-indexes'),
          maxWorkers: 0,
        });

        await builder.build();

        const db = openDb(dbPath);
        try {
          // Import handler lazily to avoid circular init issues
          const { handler: searchHandler } = await import('../../src/server/tools/search.js');
          const { handler: lookupHandler } = await import('../../src/server/tools/lookup.js');

          // ── lore_search finds symbols (use 'add' which exists in all fixtures) ──
          const searchResult = await searchHandler(db, { query: 'add' });
          expect(searchResult.results.length).toBeGreaterThanOrEqual(1);

          // ── lore_lookup finds symbols ──
          const lookupResult = await lookupHandler(db, { kind: 'symbol', query: '' });
          expect(lookupResult.results.length).toBeGreaterThanOrEqual(1);

          // ── lore_lookup finds files ──
          const fileResult = await lookupHandler(db, { kind: 'file', query: '' });
          expect(fileResult.results.length).toBeGreaterThanOrEqual(1);
        } finally {
          db.close();
        }
      });
    });
  }
});
