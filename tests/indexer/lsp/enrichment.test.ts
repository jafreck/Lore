import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { EffectiveLspSettings } from '../../../src/indexer/lsp/config.js';
import { LspEnrichmentCoordinator, hasResolvedTypeMetadata } from '../../../src/indexer/lsp/enrichment.js';

function createExecutableDir(commandName: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-lsp-enrichment-'));
  const executablePath = join(dir, commandName);
  writeFileSync(executablePath, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(executablePath, 0o755);
  return dir;
}

describe('LspEnrichmentCoordinator', () => {
  it('resolves metadata for symbol and call-site targets when hover/definition responses are available', async () => {
    const executableDir = createExecutableDir('fake-ls');
    const rootDir = mkdtempSync(join(tmpdir(), 'lore-lsp-root-'));
    const definitionUri = pathToFileURL(join(rootDir, 'defs.ts')).toString();

    let startCalls = 0;
    let closeCalls = 0;
    let openCalls = 0;
    let closeDocCalls = 0;
    const client = {
      async start(): Promise<void> { startCalls += 1; },
      async close(): Promise<void> { closeCalls += 1; },
      didOpen(): void { openCalls += 1; },
      didClose(): void { closeDocCalls += 1; },
      async hover(): Promise<unknown> {
        return {
          contents: {
            kind: 'markdown',
            value: '```ts\nfunction greet(name: string): string\n```',
          },
        };
      },
      async definition(): Promise<unknown> {
        return [{ uri: definitionUri }];
      },
    };

    const settings: EffectiveLspSettings = {
      enabled: true,
      requestTimeoutMs: 1500,
      servers: {
        typescript: { command: 'fake-ls', args: ['--stdio'] },
      },
    };
    const coordinator = new LspEnrichmentCoordinator(
      settings,
      rootDir,
      () => client,
      { ...process.env, PATH: executableDir },
    );

    await coordinator.start(['typescript']);
    const metadata = await coordinator.enrich({
      filePath: join(rootDir, 'main.ts'),
      language: 'typescript',
      source: 'export function greet(name: string): string { return name; }',
      targets: [{ line: 0, character: 0 }, { line: 1, character: 4 }],
    });
    await coordinator.dispose();

    expect(startCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(openCalls).toBe(1);
    expect(closeDocCalls).toBe(1);
    expect(metadata).toHaveLength(2);
    expect(metadata[0]).toEqual({
      resolvedTypeSignature: 'function greet(name: string): string',
      resolvedReturnType: 'string',
      definitionUri,
      definitionPath: join(rootDir, 'defs.ts'),
      definitionLine: null,
      definitionCharacter: null,
    });
    expect(metadata[1]).toEqual(metadata[0]);

    rmSync(executableDir, { recursive: true, force: true });
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('treats per-request hover/definition failures as non-fatal skips', async () => {
    const executableDir = createExecutableDir('flaky-ls');
    const rootDir = mkdtempSync(join(tmpdir(), 'lore-lsp-flaky-'));
    const firstUri = pathToFileURL(join(rootDir, 'first.ts')).toString();

    const client = {
      async start(): Promise<void> {},
      async close(): Promise<void> {},
      didOpen(): void {},
      didClose(): void {},
      async hover(_document: { uri: string }, position: { line: number }): Promise<unknown> {
        if (position.line === 0) throw new Error('timeout');
        return { contents: { kind: 'plaintext', value: 'const value: number' } };
      },
      async definition(_document: { uri: string }, position: { line: number }): Promise<unknown> {
        if (position.line === 1) throw new Error('request failed');
        return { uri: firstUri };
      },
    };

    const settings: EffectiveLspSettings = {
      enabled: true,
      requestTimeoutMs: 1200,
      servers: {
        typescript: { command: 'flaky-ls', args: ['--stdio'] },
      },
    };
    const coordinator = new LspEnrichmentCoordinator(
      settings,
      rootDir,
      () => client,
      { ...process.env, PATH: executableDir },
    );

    const metadata = await coordinator.enrich({
      filePath: join(rootDir, 'main.ts'),
      language: 'typescript',
      source: 'const value = 1;',
      targets: [{ line: 0, character: 0 }, { line: 1, character: 0 }],
    });
    await coordinator.dispose();

    expect(metadata[0]).toEqual({
      resolvedTypeSignature: null,
      resolvedReturnType: null,
      definitionUri: firstUri,
      definitionPath: join(rootDir, 'first.ts'),
      definitionLine: null,
      definitionCharacter: null,
    });
    expect(metadata[1]).toEqual({
      resolvedTypeSignature: 'const value: number',
      resolvedReturnType: 'number',
      definitionUri: null,
      definitionPath: null,
      definitionLine: null,
      definitionCharacter: null,
    });

    rmSync(executableDir, { recursive: true, force: true });
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('returns null entries when no available language server can be resolved', async () => {
    let factoryCalls = 0;
    const settings: EffectiveLspSettings = {
      enabled: true,
      requestTimeoutMs: 1000,
      servers: {
        typescript: { command: 'missing-server', args: ['--stdio'] },
      },
    };
    const rootDir = mkdtempSync(join(tmpdir(), 'lore-lsp-missing-'));
    const coordinator = new LspEnrichmentCoordinator(
      settings,
      rootDir,
      () => {
        factoryCalls += 1;
        throw new Error('should not be called');
      },
      { ...process.env, PATH: '' },
    );

    const metadata = await coordinator.enrich({
      filePath: join(rootDir, 'main.ts'),
      language: 'typescript',
      source: 'const value = 1;',
      targets: [{ line: 0, character: 0 }],
    });
    await coordinator.dispose();

    expect(factoryCalls).toBe(0);
    expect(metadata).toEqual([null]);
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('should skip client creation and return null metadata when enrichment is disabled', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'lore-lsp-disabled-'));
    let factoryCalls = 0;
    const settings: EffectiveLspSettings = {
      enabled: false,
      requestTimeoutMs: 1000,
      servers: {
        typescript: { command: 'unused-server', args: ['--stdio'] },
      },
    };
    const coordinator = new LspEnrichmentCoordinator(
      settings,
      rootDir,
      () => {
        factoryCalls += 1;
        return {
          start: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
          didOpen: vi.fn(),
          didClose: vi.fn(),
          hover: vi.fn(async () => undefined),
          definition: vi.fn(async () => undefined),
        };
      },
      { ...process.env, PATH: '' },
    );

    await coordinator.start(['typescript']);
    const metadata = await coordinator.enrich({
      filePath: join(rootDir, 'main.ts'),
      language: 'typescript',
      source: 'const value = 1;',
      targets: [{ line: 0, character: 0 }],
    });
    await coordinator.dispose();

    expect(factoryCalls).toBe(0);
    expect(metadata).toEqual([null]);
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('should reuse one started client per language across repeated start calls', async () => {
    const executableDir = createExecutableDir('reuse-ls');
    const rootDir = mkdtempSync(join(tmpdir(), 'lore-lsp-reuse-'));
    let factoryCalls = 0;
    let startCalls = 0;
    let closeCalls = 0;

    const client = {
      async start(): Promise<void> { startCalls += 1; },
      async close(): Promise<void> { closeCalls += 1; },
      didOpen(): void {},
      didClose(): void {},
      async hover(): Promise<unknown> { return undefined; },
      async definition(): Promise<unknown> { return undefined; },
    };
    const settings: EffectiveLspSettings = {
      enabled: true,
      requestTimeoutMs: 1000,
      servers: {
        typescript: { command: 'reuse-ls', args: ['--stdio'] },
      },
    };
    const coordinator = new LspEnrichmentCoordinator(
      settings,
      rootDir,
      () => {
        factoryCalls += 1;
        return client;
      },
      { ...process.env, PATH: executableDir },
    );

    await coordinator.start(['typescript', 'typescript']);
    await coordinator.start(['typescript']);
    await coordinator.dispose();

    expect(factoryCalls).toBe(1);
    expect(startCalls).toBe(1);
    expect(closeCalls).toBe(1);
    rmSync(executableDir, { recursive: true, force: true });
    rmSync(rootDir, { recursive: true, force: true });
  });
});

describe('hasResolvedTypeMetadata', () => {
  it('should return false when every metadata field is null', () => {
    expect(
      hasResolvedTypeMetadata({
        resolvedTypeSignature: null,
        resolvedReturnType: null,
        definitionUri: null,
        definitionPath: null,
        definitionLine: null,
        definitionCharacter: null,
      }),
    ).toBe(false);
  });

  it('should return true when any metadata field is populated', () => {
    expect(
      hasResolvedTypeMetadata({
        resolvedTypeSignature: 'value: string',
        resolvedReturnType: null,
        definitionUri: null,
        definitionPath: null,
        definitionLine: null,
        definitionCharacter: null,
      }),
    ).toBe(true);
    expect(
      hasResolvedTypeMetadata({
        resolvedTypeSignature: null,
        resolvedReturnType: 'string',
        definitionUri: null,
        definitionPath: null,
        definitionLine: null,
        definitionCharacter: null,
      }),
    ).toBe(true);
    expect(
      hasResolvedTypeMetadata({
        resolvedTypeSignature: null,
        resolvedReturnType: null,
        definitionUri: 'file:///tmp/file.ts',
        definitionPath: null,
        definitionLine: null,
        definitionCharacter: null,
      }),
    ).toBe(true);
    expect(
      hasResolvedTypeMetadata({
        resolvedTypeSignature: null,
        resolvedReturnType: null,
        definitionUri: null,
        definitionPath: '/tmp/file.ts',
        definitionLine: null,
        definitionCharacter: null,
      }),
    ).toBe(true);
    expect(
      hasResolvedTypeMetadata({
        resolvedTypeSignature: null,
        resolvedReturnType: null,
        definitionUri: null,
        definitionPath: null,
        definitionLine: 5,
        definitionCharacter: null,
      }),
    ).toBe(true);
  });
});
