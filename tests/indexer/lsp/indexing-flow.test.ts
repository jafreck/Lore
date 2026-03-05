import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingProvider } from '../../../src/indexer/embedder.js';

function createTmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-lsp-indexing-flow-db-'));
  return join(dir, 'test.db');
}

describe('IndexBuilder LSP indexing flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('starts one enrichment coordinator per run, reuses it across files, and persists enriched metadata', async () => {
    const srcDir = mkdtempSync(join(tmpdir(), 'lore-lsp-indexing-flow-src-'));
    const dbPath = createTmpDbPath();
    const defsPath = join(srcDir, 'defs.ts');
    const fileA = join(srcDir, 'a.ts');
    const fileB = join(srcDir, 'b.ts');
    const depDir = join(srcDir, 'node_modules', 'dep-one');

    writeFileSync(
      fileA,
      'export function target(name: string): string { return name; }\nexport function caller(): string { return target("ok"); }\n',
      'utf8',
    );
    writeFileSync(
      fileB,
      'import { target } from "./a";\nexport function second(): string { return target("two"); }\n',
      'utf8',
    );
    writeFileSync(defsPath, 'export type Def = string;\n', 'utf8');
    writeFileSync(
      join(srcDir, 'package.json'),
      JSON.stringify({
        name: 'fixture-app',
        version: '1.0.0',
        dependencies: { 'dep-one': '^1.0.0' },
      }),
      'utf8',
    );
    mkdirSync(depDir, { recursive: true });
    writeFileSync(
      join(depDir, 'package.json'),
      JSON.stringify({ name: 'dep-one', version: '1.2.3' }),
      'utf8',
    );
    writeFileSync(
      join(depDir, 'index.d.ts'),
      'export declare function depPublic(input: string): string;\n',
      'utf8',
    );

    const coordinatorInstances: Array<{
      start: ReturnType<typeof vi.fn>;
      dispose: ReturnType<typeof vi.fn>;
      enrich: ReturnType<typeof vi.fn>;
    }> = [];

    vi.doMock('../../../src/indexer/lsp/enrichment.js', () => {
      class MockLspEnrichmentCoordinator {
        start = vi.fn(async () => undefined);
        dispose = vi.fn(async () => undefined);
        enrich = vi.fn(async (request: { targets: Array<{ line: number }>; }) => {
          return request.targets.map((target) => ({
            resolvedTypeSignature: `ResolvedTypeSignature_${target.line}`,
            resolvedReturnType: 'ResolvedReturnType',
            definitionUri: `file://${defsPath}`,
            definitionPath: defsPath,
          }));
        });

        constructor() {
          coordinatorInstances.push(this);
        }
      }

      return { LspEnrichmentCoordinator: MockLspEnrichmentCoordinator };
    });

    const embeddedTexts: string[] = [];
    const embedder: EmbeddingProvider = {
      modelName: 'mock-embedder',
      dims: 3,
      async init(): Promise<void> {},
      async embed(texts: string[]): Promise<number[][]> {
        embeddedTexts.push(...texts);
        return texts.map(() => [1, 2, 3]);
      },
      async dispose(): Promise<void> {},
    };

    const { IndexBuilder } = await import('../../../src/indexer/index.js');
    const buildBuilder = new IndexBuilder(
      dbPath,
      { rootDir: srcDir, branch: 'main' },
      embedder,
      {
        indexDependencies: true,
        lsp: {
          enabled: true,
          requestTimeoutMs: 1200,
          servers: {
            typescript: { command: 'typescript-language-server', args: ['--stdio'] },
          },
        },
      },
    );

    await buildBuilder.build();
    writeFileSync(
      fileB,
      'import { target } from "./a";\nexport function second(): string { return target("updated"); }\n',
      'utf8',
    );
    const updateBuilder = new IndexBuilder(
      dbPath,
      { rootDir: srcDir, branch: 'main' },
      undefined,
      {
        indexDependencies: true,
        lsp: {
          enabled: true,
          requestTimeoutMs: 1200,
          servers: {
            typescript: { command: 'typescript-language-server', args: ['--stdio'] },
          },
        },
      },
    );
    await updateBuilder.update([fileA, fileB]);

    expect(coordinatorInstances).toHaveLength(2);
    expect(coordinatorInstances[0]?.start).toHaveBeenCalledTimes(1);
    expect(coordinatorInstances[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(coordinatorInstances[0]?.enrich.mock.calls.length).toBeGreaterThan(1);
    expect(coordinatorInstances[1]?.start).toHaveBeenCalledTimes(1);
    expect(coordinatorInstances[1]?.dispose).toHaveBeenCalledTimes(1);
    expect(coordinatorInstances[1]?.enrich.mock.calls.length).toBeGreaterThan(0);

    const db = new Database(dbPath, { readonly: true });
    const enrichedSymbolCount = db.prepare(
      `SELECT COUNT(*) AS count
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.branch = 'main'
         AND s.resolved_type_signature IS NOT NULL
         AND s.resolved_return_type = 'ResolvedReturnType'`,
    ).get() as { count: number };
    const enrichedExternalCount = db.prepare(
      `SELECT COUNT(*) AS count
       FROM external_symbols
       WHERE package_name = 'dep-one'
         AND resolved_type_signature IS NOT NULL
         AND resolved_return_type = 'ResolvedReturnType'`,
    ).get() as { count: number };
    const ftsResolvedCount = db.prepare(
      `SELECT COUNT(*) AS count
       FROM symbols_fts
       WHERE symbols_fts MATCH 'ResolvedReturnType'`,
    ).get() as { count: number };
    db.close();

    expect(enrichedSymbolCount.count).toBeGreaterThan(0);
    expect(enrichedExternalCount.count).toBeGreaterThan(0);
    expect(ftsResolvedCount.count).toBeGreaterThan(0);
    expect(embeddedTexts.some((text) => text.includes('ResolvedReturnType'))).toBe(true);

    rmSync(srcDir, { recursive: true, force: true });
    rmSync(join(dbPath, '..'), { recursive: true, force: true });
  });
});
