import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { LspEnrichmentCoordinator, hasResolvedTypeMetadata } from '../../../src/indexer/lsp/enrichment.js';
import type { EffectiveLspSettings } from '../../../src/indexer/lsp/config.js';

const RUN_LSP_SMOKE = process.env.LORE_RUN_LSP_SMOKE === '1';

function commandExists(command: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], { stdio: 'ignore' });
  return result.status === 0;
}

interface SmokeFixture {
  rootDir: string;
  filePath: string;
  language: string;
  source: string;
  definitionPath: string;
  target: { line: number; character: number };
}

interface SmokeCase {
  name: string;
  command: string;
  settings: EffectiveLspSettings;
  createFixture: () => SmokeFixture;
  assertMetadata: (metadata: NonNullable<Awaited<ReturnType<LspEnrichmentCoordinator['enrich']>>[number]>, fixture: SmokeFixture) => void;
}

function createTypeScriptFixture(): SmokeFixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'lore-lsp-smoke-ts-'));
  const definitionPath = join(rootDir, 'defs.ts');
  const filePath = join(rootDir, 'main.ts');
  writeFileSync(
    definitionPath,
    [
      'export function greet(name: string): string {',
      '  return `hello ${name}`;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  const source = [
    "import { greet } from './defs';",
    '',
    'export const value = greet("world");',
    '',
  ].join('\n');
  writeFileSync(filePath, source, 'utf8');
  return {
    rootDir,
    filePath,
    language: 'typescript',
    source,
    definitionPath,
    target: { line: 2, character: 21 },
  };
}

function createPythonFixture(): SmokeFixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'lore-lsp-smoke-py-'));
  const definitionPath = join(rootDir, 'defs.py');
  const filePath = join(rootDir, 'main.py');
  writeFileSync(
    definitionPath,
    [
      'def greet(name: str) -> str:',
      '    return f"hello {name}"',
      '',
    ].join('\n'),
    'utf8',
  );
  const source = [
    'from defs import greet',
    '',
    'value = greet("world")',
    '',
  ].join('\n');
  writeFileSync(filePath, source, 'utf8');
  return {
    rootDir,
    filePath,
    language: 'python',
    source,
    definitionPath,
    target: { line: 2, character: 10 },
  };
}

const smokeCases: SmokeCase[] = [
  {
    name: 'TypeScript language server',
    command: 'typescript-language-server',
    settings: {
      enabled: true,
      requestTimeoutMs: 3000,
      servers: {
        typescript: { command: 'typescript-language-server', args: ['--stdio'] },
      },
    },
    createFixture: createTypeScriptFixture,
    assertMetadata: (metadata, fixture) => {
      expect([fixture.definitionPath, fixture.filePath]).toContain(metadata.definitionPath);
      expect(metadata.definitionUri?.startsWith('file://')).toBe(true);
      expect(
        Boolean(metadata.resolvedTypeSignature)
          || Boolean(metadata.resolvedReturnType)
          || Boolean(metadata.definitionPath),
      ).toBe(true);
    },
  },
  {
    name: 'Pyright language server',
    command: 'pyright-langserver',
    settings: {
      enabled: true,
      requestTimeoutMs: 3000,
      servers: {
        python: { command: 'pyright-langserver', args: ['--stdio'] },
      },
    },
    createFixture: createPythonFixture,
    assertMetadata: (metadata, fixture) => {
      expect(metadata.definitionPath).toBe(fixture.definitionPath);
      expect(metadata.definitionUri?.startsWith('file://')).toBe(true);
      expect(metadata.resolvedTypeSignature?.includes('greet')).toBe(true);
      expect(metadata.resolvedReturnType).toBe('str');
    },
  },
];

describe.runIf(RUN_LSP_SMOKE).sequential('LSP smoke tests', () => {
  for (const smokeCase of smokeCases) {
    it.skipIf(!commandExists(smokeCase.command))(
      `starts ${smokeCase.name} and resolves hover/definition metadata`,
      async () => {
        const fixture = smokeCase.createFixture();
        const coordinator = new LspEnrichmentCoordinator(smokeCase.settings, fixture.rootDir);

        try {
          await coordinator.start([fixture.language]);
          const [metadata] = await coordinator.enrich({
            filePath: fixture.filePath,
            language: fixture.language,
            source: fixture.source,
            targets: [fixture.target],
          });

          expect(metadata).not.toBeNull();
          expect(hasResolvedTypeMetadata(metadata!)).toBe(true);
          smokeCase.assertMetadata(metadata!, fixture);
        } finally {
          await coordinator.dispose();
          rmSync(fixture.rootDir, { recursive: true, force: true });
        }
      },
    );
  }
});