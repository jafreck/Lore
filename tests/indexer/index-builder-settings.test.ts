import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IndexBuilder } from '../../src/indexer/index.js';
import {
  loadScipIndexes,
  type ScipProcessIO,
} from '../../src/indexer/stages/scip-helpers/process.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-builder-settings-'));
  tempDirs.push(root);
  return root;
}

describe('IndexBuilder default settings', () => {
  it('enables SCIP/LSP requests but denies execution for programmatic callers by default', async () => {
    const root = createRoot();
    const builder = new IndexBuilder(path.join(root, 'lore.db'), { rootDir: root });
    const configuration = await builder.resolveConfiguration();
    expect(configuration.scip?.enabled).toBe(true);
    expect(configuration.scip?.allowIndexerExecution).toBe(false);
    expect(configuration.scip?.allowBuildExecution).toBe(false);
    expect(configuration.scip?.allowAutoInstall).toBe(false);
    expect(configuration.lsp?.enabled).toBe(true);
    expect(configuration.lsp?.allowServerExecution).toBe(false);
  });

  it('honors non-executable repository settings without granting requested capabilities', async () => {
    const root = createRoot();
    fs.writeFileSync(
      path.join(root, '.lore.config'),
      JSON.stringify({
        scip: {
          enabled: true,
          timeoutMs: 1234,
          allowBuildExecution: true,
          autoInstall: true,
          indexers: {
            typescript: { command: 'malicious-indexer', args: ['--run-payload'], cwd: '..' },
          },
        },
        lsp: {
          enabled: true,
          timeoutMs: 4321,
          servers: {
            typescript: { command: 'malicious-lsp', args: ['--run-payload'], cwd: '..' },
          },
        },
      }),
    );
    const builder = new IndexBuilder(path.join(root, 'lore.db'), { rootDir: root });
    const configuration = await builder.resolveConfiguration();
    expect(configuration.scip?.timeoutMs).toBe(1234);
    expect(configuration.scip?.allowIndexerExecution).toBe(false);
    expect(configuration.scip?.allowBuildExecution).toBe(false);
    expect(configuration.scip?.allowAutoInstall).toBe(false);
    expect(configuration.scip?.indexers.typescript?.command).toBe('scip-typescript');
    expect(configuration.lsp?.requestTimeoutMs).toBe(4321);
    expect(configuration.lsp?.allowServerExecution).toBe(false);
    expect(configuration.lsp?.servers.typescript?.command).toBe('typescript-language-server');

    const calls = { indexer: 0, install: 0, build: 0 };
    const io: ScipProcessIO = {
      existsSync: () => false,
      realpathSync: (value) => value,
      readFileSync: () => new Uint8Array(),
      unlinkSync: () => {},
      execFile: async () => { calls.indexer++; },
      installScipIndexer: async () => {
        calls.install++;
        return { installed: true };
      },
      ensureCompilationDatabase: async () => {
        calls.build++;
        return { path: null };
      },
    };
    await loadScipIndexes(configuration.scip!, root, new Set(['c']), io);
    expect(calls).toEqual({ indexer: 0, install: 0, build: 0 });
  });

  it('supports simple scip:false and lsp:false options', async () => {
    const root = createRoot();
    const builder = new IndexBuilder(path.join(root, 'lore.db'), { rootDir: root }, undefined, {
      scip: false,
      lsp: false,
    });
    const configuration = await builder.resolveConfiguration();
    expect(configuration.scip).toBeNull();
    expect(configuration.lsp).toBeNull();
  });

  it('preserves default C/C++ timeout provenance when effective settings are reused', async () => {
    const root = createRoot();
    const first = await new IndexBuilder(
      path.join(root, 'first.db'),
      { rootDir: root },
    ).resolveConfiguration();
    expect(first.scip?.timeoutMsExplicit).toBe(false);

    const reused = await new IndexBuilder(
      path.join(root, 'second.db'),
      { rootDir: root },
      undefined,
      { scip: first.scip! },
    ).resolveConfiguration();
    expect(reused.scip?.timeoutMsExplicit).toBe(false);

    const explicit = await new IndexBuilder(
      path.join(root, 'third.db'),
      { rootDir: root },
      undefined,
      { scip: { timeoutMs: 1_234 } },
    ).resolveConfiguration();
    expect(explicit.scip?.timeoutMsExplicit).toBe(true);
  });

  it('applies partial overrides when the host explicitly grants their capabilities', async () => {
    const root = createRoot();
    const builder = new IndexBuilder(path.join(root, 'lore.db'), { rootDir: root }, undefined, {
      scip: {
        timeoutMs: 9000,
        allowBuildExecution: true,
        autoInstall: true,
        indexers: { typescript: { command: 'trusted-indexer', args: [] } },
      },
      lsp: {
        requestTimeoutMs: 8000,
        servers: { typescript: { command: 'trusted-lsp', args: [] } },
      },
      execution: {
        allowBuildExecution: true,
        allowAutoInstall: true,
        allowCustomIndexerCommands: true,
        allowCustomLspCommands: true,
      },
    });
    const configuration = await builder.resolveConfiguration();
    expect(configuration.scip?.timeoutMs).toBe(9000);
    expect(configuration.scip?.allowBuildExecution).toBe(true);
    expect(configuration.scip?.allowAutoInstall).toBe(true);
    expect(configuration.scip?.indexers.typescript?.command).toBe('trusted-indexer');
    expect(configuration.lsp?.requestTimeoutMs).toBe(8000);
    expect(configuration.lsp?.allowServerExecution).toBe(true);
    expect(configuration.lsp?.servers.typescript?.command).toBe('trusted-lsp');
  });

  it('defers malformed repository config errors until configuration/build time', async () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, '.lore.config'), '{not-json');
    let builder: IndexBuilder | undefined;
    expect(() => {
      builder = new IndexBuilder(path.join(root, 'lore.db'), { rootDir: root });
    }).not.toThrow();
    await expect(builder!.resolveConfiguration()).rejects.toThrow('Invalid .lore.config');
  });
});
