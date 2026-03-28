import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  LspEnrichmentCoordinator,
  hasResolvedTypeMetadata,
  type LspClientFactory,
  type LspEnrichmentRequest,
} from '../../src/lsp/enrichment.js';
import type { EffectiveLspSettings } from '../../src/lsp/config.js';
import type { ResolvedTypeMetadata } from '../../src/enrichment-types.js';
import { FakeLspClient } from '../helpers/fakeLspClient.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function nullMetadata(): ResolvedTypeMetadata {
  return {
    resolvedTypeSignature: null,
    resolvedReturnType: null,
    definitionUri: null,
    definitionPath: null,
    definitionLine: null,
    definitionCharacter: null,
  };
}

/** Create a temp bin dir containing a fake executable so resolveLspServerRegistry considers it available. */
function makeFakeBinDir(commandName: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-test-bin-'));
  writeFileSync(join(dir, commandName), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
}

function makeSettings(overrides: Partial<EffectiveLspSettings> = {}): EffectiveLspSettings {
  return {
    enabled: true,
    requestTimeoutMs: 1000,
    servers: { typescript: { command: 'fake-ts-server', args: [] } },
    ...overrides,
  };
}

function makeRequest(overrides: Partial<LspEnrichmentRequest> = {}): LspEnrichmentRequest {
  return {
    filePath: '/tmp/test-file.ts',
    language: 'typescript',
    source: 'const x = 1;',
    targets: [{ line: 0, character: 6 }],
    ...overrides,
  };
}

// ─── hasResolvedTypeMetadata ──────────────────────────────────────────────────

describe('hasResolvedTypeMetadata', () => {
  it('returns false when all fields are null', () => {
    expect(hasResolvedTypeMetadata(nullMetadata())).toBe(false);
  });

  it('returns true when resolvedTypeSignature is set', () => {
    expect(hasResolvedTypeMetadata({ ...nullMetadata(), resolvedTypeSignature: 'string' })).toBe(true);
  });

  it('returns true when definitionUri is set', () => {
    expect(hasResolvedTypeMetadata({ ...nullMetadata(), definitionUri: 'file:///a.ts' })).toBe(true);
  });

  it('returns true when definitionLine is set', () => {
    expect(hasResolvedTypeMetadata({ ...nullMetadata(), definitionLine: 0 })).toBe(true);
  });

  it('returns true when definitionPath is set', () => {
    expect(hasResolvedTypeMetadata({ ...nullMetadata(), definitionPath: '/a.ts' })).toBe(true);
  });

  it('returns true when resolvedReturnType is set', () => {
    expect(hasResolvedTypeMetadata({ ...nullMetadata(), resolvedReturnType: 'number' })).toBe(true);
  });
});

// ─── LspEnrichmentCoordinator ─────────────────────────────────────────────────

describe('LspEnrichmentCoordinator', () => {
  let fakeClient: FakeLspClient;
  let fakeBinDir: string;
  let processEnv: NodeJS.ProcessEnv;
  let factory: LspClientFactory;

  beforeEach(() => {
    fakeClient = new FakeLspClient();
    fakeBinDir = makeFakeBinDir('fake-ts-server');
    processEnv = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` };
    factory = () => fakeClient;
  });

  afterEach(() => {
    try {
      rmSync(fakeBinDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function createCoordinator(settingsOverrides: Partial<EffectiveLspSettings> = {}): LspEnrichmentCoordinator {
    return new LspEnrichmentCoordinator(makeSettings(settingsOverrides), '/tmp', factory, processEnv);
  }

  // ── enrich: early return paths ────────────────────────────────────────────

  describe('enrich()', () => {
    it('returns empty array when settings.enabled is false', async () => {
      const coord = createCoordinator({ enabled: false });
      const results = await coord.enrich(makeRequest());
      expect(results).toEqual([null]);
    });

    it('returns empty array when targets is empty', async () => {
      const coord = createCoordinator();
      const results = await coord.enrich(makeRequest({ targets: [] }));
      expect(results).toEqual([]);
    });

    it('returns null for each target when no server configured for language', async () => {
      const coord = createCoordinator();
      const results = await coord.enrich(makeRequest({ language: 'haskell' }));
      expect(results).toEqual([null]);
      // Should not have started the client
      expect(fakeClient.started).toBe(false);
    });

    // ── hover result formats ──────────────────────────────────────────────

    it('processes hover result with MarkupContent format', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        hover: { contents: { value: '```ts\nfunction greet(): string\n```' } },
      });

      const results = await coord.enrich(makeRequest());
      expect(results).toHaveLength(1);
      expect(results[0]?.resolvedTypeSignature).toBe('function greet(): string');
      expect(results[0]?.resolvedReturnType).toBe('string');
    });

    it('processes hover result with plain string contents', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        hover: { contents: 'const x: number' },
      });

      const results = await coord.enrich(makeRequest());
      expect(results).toHaveLength(1);
      expect(results[0]?.resolvedTypeSignature).toBe('const x: number');
    });

    it('processes hover result with array-of-MarkedString format', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        hover: { contents: [{ value: '```ts\nlet y: boolean\n```' }, { value: 'Documentation text' }] },
      });

      const results = await coord.enrich(makeRequest());
      expect(results).toHaveLength(1);
      expect(results[0]?.resolvedTypeSignature).toContain('let y: boolean');
    });

    it('returns null for hover with empty string contents', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        hover: { contents: '' },
      });

      const results = await coord.enrich(makeRequest());
      expect(results).toEqual([null]);
    });

    it('returns null when hover result is not a record', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        hover: 'just a string',
      });

      const results = await coord.enrich(makeRequest());
      expect(results).toEqual([null]);
    });

    // ── definition result formats ─────────────────────────────────────────

    it('processes definition result in LSP Location format', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        definition: {
          uri: 'file:///path/to/file.ts',
          range: { start: { line: 5, character: 0 } },
        },
      });

      const results = await coord.enrich(makeRequest());
      expect(results).toHaveLength(1);
      expect(results[0]?.definitionUri).toBe('file:///path/to/file.ts');
      expect(results[0]?.definitionPath).toBe('/path/to/file.ts');
      expect(results[0]?.definitionLine).toBe(5);
      expect(results[0]?.definitionCharacter).toBe(0);
    });

    it('processes definition result in LSP LocationLink format', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        definition: {
          targetUri: 'file:///other/file.ts',
          targetSelectionRange: { start: { line: 3, character: 4 } },
        },
      });

      const results = await coord.enrich(makeRequest());
      expect(results).toHaveLength(1);
      expect(results[0]?.definitionUri).toBe('file:///other/file.ts');
      expect(results[0]?.definitionPath).toBe('/other/file.ts');
      expect(results[0]?.definitionLine).toBe(3);
      expect(results[0]?.definitionCharacter).toBe(4);
    });

    it('processes definition result in LocationLink format with targetRange fallback', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        definition: {
          targetUri: 'file:///fallback.ts',
          targetRange: { start: { line: 10, character: 2 } },
        },
      });

      const results = await coord.enrich(makeRequest());
      expect(results[0]?.definitionUri).toBe('file:///fallback.ts');
      expect(results[0]?.definitionLine).toBe(10);
    });

    it('processes definition result as array (picks first valid)', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        definition: [
          { uri: 'file:///first.ts', range: { start: { line: 1, character: 0 } } },
          { uri: 'file:///second.ts', range: { start: { line: 2, character: 0 } } },
        ],
      });

      const results = await coord.enrich(makeRequest());
      expect(results[0]?.definitionUri).toBe('file:///first.ts');
      expect(results[0]?.definitionLine).toBe(1);
    });

    it('returns null for definition with non-file URI', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        definition: {
          uri: 'untitled:Untitled-1',
          range: { start: { line: 0, character: 0 } },
        },
      });

      const results = await coord.enrich(makeRequest());
      // Has definitionUri but no definitionPath for non-file URIs
      expect(results[0]?.definitionUri).toBe('untitled:Untitled-1');
      expect(results[0]?.definitionPath).toBeNull();
    });

    it('returns null when both hover and definition return nothing', async () => {
      const coord = createCoordinator();
      // Defaults return null

      const results = await coord.enrich(makeRequest());
      expect(results).toEqual([null]);
    });

    // ── combined hover + definition ───────────────────────────────────────

    it('returns combined hover and definition metadata', async () => {
      const coord = createCoordinator();
      fakeClient.setResponse(0, 6, {
        hover: { contents: { value: '```ts\nconst x: number\n```' } },
        definition: { uri: 'file:///src/index.ts', range: { start: { line: 10, character: 4 } } },
      });

      const results = await coord.enrich(makeRequest({ targets: [{ line: 0, character: 6 }] }));
      expect(results).toHaveLength(1);
      expect(results[0]?.resolvedTypeSignature).toBe('const x: number');
      expect(results[0]?.definitionUri).toBe('file:///src/index.ts');
      expect(results[0]?.definitionLine).toBe(10);
    });

    // ── per-position responses ────────────────────────────────────────────

    it('uses per-position responses for multiple targets', async () => {
      const coord = createCoordinator();
      fakeClient.setResponse(0, 0, {
        hover: { contents: 'type A' },
      });
      fakeClient.setResponse(1, 5, {
        hover: { contents: 'type B' },
      });

      const results = await coord.enrich(makeRequest({
        targets: [{ line: 0, character: 0 }, { line: 1, character: 5 }, { line: 2, character: 0 }],
      }));
      expect(results).toHaveLength(3);
      expect(results[0]?.resolvedTypeSignature).toBe('type A');
      expect(results[1]?.resolvedTypeSignature).toBe('type B');
      expect(results[2]).toBeNull();
    });

    // ── error handling ────────────────────────────────────────────────────

    it('handles didOpen throwing — returns empty results', async () => {
      const coord = createCoordinator();
      fakeClient.didOpenError = new Error('transport failure');

      const results = await coord.enrich(makeRequest());
      expect(results).toEqual([null]);
    });

    it('handles hover rejection gracefully', async () => {
      const coord = createCoordinator();
      fakeClient.hoverError = new Error('hover failed');
      fakeClient.setDefaultResponse({
        definition: { uri: 'file:///def.ts', range: { start: { line: 0, character: 0 } } },
      });

      const results = await coord.enrich(makeRequest());
      // hover fails but definition succeeds — should still get definition data
      expect(results[0]?.definitionUri).toBe('file:///def.ts');
      expect(results[0]?.resolvedTypeSignature).toBeNull();
    });

    it('handles definition rejection gracefully', async () => {
      const coord = createCoordinator();
      fakeClient.definitionError = new Error('definition failed');
      fakeClient.setDefaultResponse({
        hover: { contents: 'const z: string' },
      });

      const results = await coord.enrich(makeRequest());
      // definition fails but hover succeeds
      expect(results[0]?.resolvedTypeSignature).toBe('const z: string');
      expect(results[0]?.definitionUri).toBeNull();
    });

    it('handles both hover and definition rejecting gracefully', async () => {
      const coord = createCoordinator();
      fakeClient.hoverError = new Error('hover failed');
      fakeClient.definitionError = new Error('definition failed');

      const results = await coord.enrich(makeRequest());
      expect(results).toEqual([null]);
    });

    it('calls didClose even when enrichment fails', async () => {
      const coord = createCoordinator();
      fakeClient.hoverError = new Error('boom');
      fakeClient.definitionError = new Error('boom');

      await coord.enrich(makeRequest());
      expect(fakeClient.closedDocuments.length).toBeGreaterThan(0);
    });

    // ── batching ──────────────────────────────────────────────────────────

    it('batches targets exceeding LSP_CONCURRENCY_LIMIT', async () => {
      const coord = createCoordinator();
      // Create 65 targets to cause multiple batches (limit is 30)
      const targets = Array.from({ length: 65 }, (_, i) => ({ line: i, character: 0 }));
      fakeClient.setDefaultResponse({
        hover: { contents: 'type T' },
      });

      const results = await coord.enrich(makeRequest({ targets }));
      expect(results).toHaveLength(65);
      // All should have resolved metadata
      for (const r of results) {
        expect(r?.resolvedTypeSignature).toBe('type T');
      }
      // Should have fired hover+definition for each target
      const hoverRequests = fakeClient.requests.filter((r) => r.type === 'hover');
      const defRequests = fakeClient.requests.filter((r) => r.type === 'definition');
      expect(hoverRequests).toHaveLength(65);
      expect(defRequests).toHaveLength(65);
    });

    // ── didOpen & didClose protocol ───────────────────────────────────────

    it('sends didOpen and didClose with correct parameters', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({ hover: { contents: 'ok' } });

      await coord.enrich(makeRequest({
        filePath: '/tmp/hello.ts',
        language: 'typescript',
        source: 'hello world',
      }));

      expect(fakeClient.openedDocuments).toHaveLength(1);
      expect(fakeClient.openedDocuments[0]!.languageId).toBe('typescript');
      expect(fakeClient.openedDocuments[0]!.uri).toBe(pathToFileURL('/tmp/hello.ts').toString());
      expect(fakeClient.closedDocuments).toHaveLength(1);
      expect(fakeClient.closedDocuments[0]).toBe(pathToFileURL('/tmp/hello.ts').toString());
    });

    // ── definition array with empty entries ───────────────────────────────

    it('skips invalid entries in definition array', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        definition: [
          null,
          42,
          { uri: 'file:///valid.ts', range: { start: { line: 7, character: 2 } } },
        ],
      });

      const results = await coord.enrich(makeRequest());
      expect(results[0]?.definitionUri).toBe('file:///valid.ts');
      expect(results[0]?.definitionLine).toBe(7);
    });

    // ── definition with missing range ─────────────────────────────────────

    it('handles definition Location with no range', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        definition: { uri: 'file:///no-range.ts' },
      });

      const results = await coord.enrich(makeRequest());
      expect(results[0]?.definitionUri).toBe('file:///no-range.ts');
      expect(results[0]?.definitionLine).toBeNull();
      expect(results[0]?.definitionCharacter).toBeNull();
    });

    // ── hover with nested array contents ──────────────────────────────────

    it('processes hover with array containing strings and objects', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({
        hover: { contents: ['plain text', { value: 'object text' }] },
      });

      const results = await coord.enrich(makeRequest());
      expect(results[0]?.resolvedTypeSignature).toContain('plain text');
      expect(results[0]?.resolvedTypeSignature).toContain('object text');
    });

    // ── negative line/character clamping ──────────────────────────────────

    it('clamps negative line/character to 0', async () => {
      const coord = createCoordinator();
      fakeClient.setDefaultResponse({ hover: { contents: 'ok' } });

      await coord.enrich(makeRequest({ targets: [{ line: -1, character: -5 }] }));

      const hoverReq = fakeClient.requests.find((r) => r.type === 'hover');
      expect(hoverReq?.position.line).toBe(0);
      expect(hoverReq?.position.character).toBe(0);
    });
  });

  // ── start() and dispose() ───────────────────────────────────────────────

  describe('start()', () => {
    it('creates clients for each requested language', async () => {
      const coord = createCoordinator();
      await coord.start(['typescript']);
      expect(fakeClient.started).toBe(true);
    });

    it('is a no-op when settings.enabled is false', async () => {
      const coord = createCoordinator({ enabled: false });
      await coord.start(['typescript']);
      expect(fakeClient.started).toBe(false);
    });

    it('deduplicates languages', async () => {
      let createCount = 0;
      const dedupeFactory: LspClientFactory = () => {
        createCount++;
        return fakeClient;
      };
      const coord = new LspEnrichmentCoordinator(
        makeSettings(),
        '/tmp',
        dedupeFactory,
        processEnv,
      );

      await coord.start(['typescript', 'typescript', 'typescript']);
      // Factory should only be called once for repeated language
      expect(createCount).toBe(1);
    });
  });

  describe('dispose()', () => {
    it('calls close() on all started clients', async () => {
      const coord = createCoordinator();
      await coord.start(['typescript']);
      expect(fakeClient.started).toBe(true);

      await coord.dispose();
      expect(fakeClient.closed).toBe(true);
    });

    it('handles close() failures gracefully via allSettled', async () => {
      const failingClient = new FakeLspClient();
      failingClient.close = async () => { throw new Error('close failed'); };
      const failFactory: LspClientFactory = () => failingClient;

      const coord = new LspEnrichmentCoordinator(makeSettings(), '/tmp', failFactory, processEnv);
      await coord.start(['typescript']);

      // Should not throw
      await coord.dispose();
    });
  });

  // ── client creation failure ─────────────────────────────────────────────

  describe('client creation failure', () => {
    it('returns null when factory-created client fails to start', async () => {
      const failClient = new FakeLspClient();
      failClient.startError = new Error('start failed');
      const failFactory: LspClientFactory = () => failClient;

      const coord = new LspEnrichmentCoordinator(makeSettings(), '/tmp', failFactory, processEnv);
      const results = await coord.enrich(makeRequest());
      expect(results).toEqual([null]);
    });
  });

  // ── server registry integration ─────────────────────────────────────────

  describe('server registry resolution', () => {
    it('returns null for language with unavailable server command', async () => {
      // Use a command that doesn't exist on PATH
      const coord = new LspEnrichmentCoordinator(
        makeSettings({ servers: { typescript: { command: 'nonexistent-server-xyz', args: [] } } }),
        '/tmp',
        factory,
        { PATH: '/empty' },
      );

      const results = await coord.enrich(makeRequest());
      expect(results).toEqual([null]);
      expect(fakeClient.started).toBe(false);
    });

    it('returns null for language not in server registry', async () => {
      const coord = createCoordinator();
      const results = await coord.enrich(makeRequest({ language: 'brainfuck' }));
      expect(results).toEqual([null]);
    });
  });
});
