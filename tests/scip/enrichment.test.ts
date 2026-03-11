/**
 * Tests for the SCIP enrichment coordinator.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import {
  IndexSchema,
  DocumentSchema,
  OccurrenceSchema,
  SymbolInformationSchema,
  SymbolRole,
} from '../../src/scip/scip_pb.js';
import type { EffectiveScipSettings } from '../../src/scip/config.js';
import { ScipEnrichmentCoordinator } from '../../src/scip/enrichment.js';

// ─── Helper: build SCIP index protobuf bytes ──────────────────────────────────

function buildIndexBytes(docs: Array<{
  relativePath: string;
  language: string;
  occurrences: Array<{ range: number[]; symbol: string; symbolRoles: number }>;
  symbols?: Array<{ symbol: string; documentation?: string[]; displayName?: string }>;
}>): Uint8Array {
  const index = create(IndexSchema, {
    documents: docs.map(d => create(DocumentSchema, {
      relativePath: d.relativePath,
      language: d.language,
      occurrences: d.occurrences.map(o => create(OccurrenceSchema, {
        range: o.range,
        symbol: o.symbol,
        symbolRoles: o.symbolRoles,
      })),
      symbols: (d.symbols ?? []).map(s => create(SymbolInformationSchema, {
        symbol: s.symbol,
        documentation: s.documentation ?? [],
        displayName: s.displayName ?? '',
      })),
    })),
  });
  return toBinary(IndexSchema, index);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ScipEnrichmentCoordinator', () => {
  it('enriches targets from a precomputed SCIP index', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'lore-scip-enrich-'));
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    const defSymbol = 'npm . project 1.0 `src/`/greet().';
    const indexBytes = buildIndexBytes([{
      relativePath: 'src/main.ts',
      language: 'TypeScript',
      occurrences: [
        { range: [5, 16, 5, 21], symbol: defSymbol, symbolRoles: SymbolRole.Definition },
        { range: [20, 4, 20, 9], symbol: defSymbol, symbolRoles: 0 },
      ],
      symbols: [{
        symbol: defSymbol,
        documentation: ['function greet(name: string): string'],
        displayName: 'greet',
      }],
    }]);
    writeFileSync(join(indexDir, 'typescript.scip'), indexBytes);

    mkdirSync(join(rootDir, 'src'), { recursive: true });
    writeFileSync(join(rootDir, 'src', 'main.ts'), 'export function greet(name: string): string { return name; }');

    const settings: EffectiveScipSettings = {
      enabled: true,
      timeoutMs: 5000,
      indexers: {},
      indexDir: '.scip-indexes',
    };

    const coordinator = new ScipEnrichmentCoordinator(settings, rootDir);
    const covered = await coordinator.start(['typescript']);

    expect(covered.has('typescript')).toBe(true);

    const results = coordinator.enrich({
      filePath: join(rootDir, 'src/main.ts'),
      language: 'typescript',
      source: 'greet("world")',
      targets: [{ line: 20, character: 4 }],
    });

    expect(results).toHaveLength(1);
    const m = results[0];
    expect(m).not.toBeNull();
    expect(m!.definitionPath).toBe(join(rootDir, 'src/main.ts'));
    expect(m!.definitionLine).toBe(5);
    expect(m!.definitionCharacter).toBe(16);
    expect(m!.resolvedTypeSignature).toBe('function greet(name: string): string');
    expect(m!.resolvedReturnType).toBe('string');

    await coordinator.dispose();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns null for targets not found in SCIP data', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'lore-scip-empty-'));
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    writeFileSync(join(indexDir, 'typescript.scip'), buildIndexBytes([]));

    const settings: EffectiveScipSettings = {
      enabled: true,
      timeoutMs: 5000,
      indexers: {},
      indexDir: '.scip-indexes',
    };

    const coordinator = new ScipEnrichmentCoordinator(settings, rootDir);
    await coordinator.start(['typescript']);

    const results = coordinator.enrich({
      filePath: join(rootDir, 'nonexistent.ts'),
      language: 'typescript',
      source: '',
      targets: [{ line: 0, character: 0 }],
    });

    expect(results).toEqual([null]);

    await coordinator.dispose();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns empty results when SCIP is disabled', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'lore-scip-disabled-'));

    const settings: EffectiveScipSettings = {
      enabled: false,
      timeoutMs: 5000,
      indexers: {},
      indexDir: null,
    };

    const coordinator = new ScipEnrichmentCoordinator(settings, rootDir);
    const covered = await coordinator.start(['typescript']);
    expect(covered.size).toBe(0);

    const results = coordinator.enrich({
      filePath: join(rootDir, 'test.ts'),
      language: 'typescript',
      source: '',
      targets: [{ line: 0, character: 0 }],
    });
    expect(results).toEqual([null]);

    await coordinator.dispose();
    rmSync(rootDir, { recursive: true, force: true });
  });
});
