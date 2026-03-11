import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { IndexBuilder } from '../../src/indexer/index.js';
import { handler as lookupHandler } from '../../src/server/tools/lookup.js';
import { handler as searchHandler } from '../../src/server/tools/search.js';

function commandExists(command: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function createFixtureRoot(prefix: string): string {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(rootDir, 'main.ts'),
    [
      'export function greet(name: string): string {',
      '  return `hello ${name}`;',
      '}',
      '',
      'export function run(): string {',
      '  return greet("world");',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  return rootDir;
}

describe('LSP integration', () => {
  it('indexes successfully when configured language server is unavailable and leaves enrichment metadata empty', async () => {
    const rootDir = createFixtureRoot('lore-lsp-missing-server-');
    const dbPath = join(rootDir, 'lore.db');
    try {
      const builder = new IndexBuilder(dbPath, { rootDir }, undefined, {
        lsp: {
          enabled: true,
          requestTimeoutMs: 600,
          servers: {
            typescript: { command: 'definitely-missing-language-server', args: ['--stdio'] },
          },
        },
      });

      await builder.build();

      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare(
          `SELECT resolved_type_signature, resolved_return_type, definition_uri, definition_path
           FROM symbols
           WHERE name = 'greet'
           LIMIT 1`,
        )
        .get() as
        | {
          resolved_type_signature: string | null;
          resolved_return_type: string | null;
          definition_uri: string | null;
          definition_path: string | null;
        }
        | undefined;
      db.close();

      expect(row).toBeDefined();
      expect(row).toEqual({
        resolved_type_signature: null,
        resolved_return_type: null,
        definition_uri: null,
        definition_path: null,
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it.runIf(commandExists('typescript-language-server'))(
    'persists LSP-enriched metadata and exposes it through lookup/search query tooling',
    async () => {
      const rootDir = createFixtureRoot('lore-lsp-live-server-');
      const dbPath = join(rootDir, 'lore.db');
      try {
        const builder = new IndexBuilder(dbPath, { rootDir }, undefined, {
          lsp: {
            enabled: true,
            requestTimeoutMs: 1500,
            servers: {
              typescript: { command: 'typescript-language-server', args: ['--stdio'] },
            },
          },
        });

        await builder.build();

        const db = new Database(dbPath, { readonly: true });
        const lookupResult = await lookupHandler(db, { kind: 'symbol', query: 'greet' });
        const lookupSymbol = lookupResult.results.find((row) =>
          Object.prototype.hasOwnProperty.call(row, 'name'),
        ) as
          | {
            resolved_type_signature?: string | null;
            resolved_return_type?: string | null;
            definition_uri?: string | null;
            definition_path?: string | null;
          }
          | undefined;
        expect(lookupSymbol).toBeDefined();
        expect(
          Boolean(
            lookupSymbol?.resolved_type_signature
              || lookupSymbol?.resolved_return_type
              || lookupSymbol?.definition_uri
              || lookupSymbol?.definition_path,
          ),
        ).toBe(true);

        const searchResult = await searchHandler(db, { query: 'greet', mode: 'structural' });
        expect(searchResult.results.length).toBeGreaterThan(0);
        expect(
          searchResult.results.some(
            (row) => Boolean(
              row.resolved_type_signature
                || row.resolved_return_type
                || row.definition_uri
                || row.definition_path,
            ),
          ),
        ).toBe(true);
        db.close();
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    },
  );
});
