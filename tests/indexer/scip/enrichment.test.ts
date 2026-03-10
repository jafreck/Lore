/**
 * Tests for the SCIP enrichment coordinator.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { EffectiveScipSettings } from '../../../src/indexer/scip/config.js';
import { ScipEnrichmentCoordinator } from '../../../src/indexer/scip/enrichment.js';

// ─── Protobuf encoding helpers (duplicated from index-reader test) ────────────

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return new Uint8Array(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeLengthDelimited(fieldNumber: number, data: Uint8Array): Uint8Array {
  const tag = encodeTag(fieldNumber, 2);
  const length = encodeVarint(data.length);
  const result = new Uint8Array(tag.length + length.length + data.length);
  result.set(tag, 0);
  result.set(length, tag.length);
  result.set(data, tag.length + length.length);
  return result;
}

function encodeString(fieldNumber: number, value: string): Uint8Array {
  return encodeLengthDelimited(fieldNumber, new TextEncoder().encode(value));
}

function encodeVarintField(fieldNumber: number, value: number): Uint8Array {
  const tag = encodeTag(fieldNumber, 0);
  const val = encodeVarint(value);
  const result = new Uint8Array(tag.length + val.length);
  result.set(tag, 0);
  result.set(val, tag.length);
  return result;
}

function encodePackedInt32(fieldNumber: number, values: number[]): Uint8Array {
  const parts: Uint8Array[] = values.map(v => encodeVarint(v >>> 0));
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const packed = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) { packed.set(p, offset); offset += p.length; }
  return encodeLengthDelimited(fieldNumber, packed);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
}

function buildOccurrence(range: number[], symbol: string, roles: number): Uint8Array {
  return concat(
    encodePackedInt32(1, range),
    encodeString(2, symbol),
    encodeVarintField(3, roles),
  );
}

function buildSymbolInfo(symbol: string, docs: string[] = [], displayName = ''): Uint8Array {
  return concat(
    encodeString(1, symbol),
    ...docs.map(d => encodeString(3, d)),
    ...(displayName ? [encodeString(6, displayName)] : []),
  );
}

function buildDocument(relativePath: string, language: string, occurrences: Uint8Array[], symbols: Uint8Array[] = []): Uint8Array {
  return concat(
    encodeString(1, relativePath),
    ...occurrences.map(o => encodeLengthDelimited(2, o)),
    ...symbols.map(s => encodeLengthDelimited(3, s)),
    encodeString(4, language),
  );
}

function buildIndex(documents: Uint8Array[]): Uint8Array {
  return concat(...documents.map(d => encodeLengthDelimited(2, d)));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ScipEnrichmentCoordinator', () => {
  it('enriches targets from a precomputed SCIP index', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'lore-scip-enrich-'));
    const indexDir = join(rootDir, '.scip-indexes');
    mkdirSync(indexDir, { recursive: true });

    // Create a pre-computed SCIP index.
    const defSymbol = 'npm . project 1.0 `src/`/greet().';
    const doc = buildDocument(
      'src/main.ts',
      'TypeScript',
      [
        // Definition at line 5, char 16
        buildOccurrence([5, 16, 5, 21], defSymbol, 1),
        // Reference at line 20, char 4
        buildOccurrence([20, 4, 20, 9], defSymbol, 0),
      ],
      [
        buildSymbolInfo(defSymbol, ['function greet(name: string): string'], 'greet'),
      ],
    );
    const indexBytes = buildIndex([doc]);
    writeFileSync(join(indexDir, 'typescript.scip'), indexBytes);

    // Also write the source file.
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

    // Enrich the reference at line 20.
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

    // Empty index.
    writeFileSync(join(indexDir, 'typescript.scip'), buildIndex([]));

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
