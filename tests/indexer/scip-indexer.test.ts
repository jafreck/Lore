import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { openDb, type Database } from '../../src/db/schema.js';
import { ScipIndexerStage, ScipRefStage, createLoreScipTsconfig } from '../../src/indexer/stages/scip-indexer.js';
import type { PipelineContext } from '../../src/indexer/pipeline.js';
import { getLogger } from '../../src/logger.js';

function makeMinimalContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const db = openDb(':memory:');
  return {
    db,
    dbPath: ':memory:',
    walkerConfig: {
      rootDir: '/tmp/fake-project',
      include: ['**/*'],
      exclude: [],
    } as any,
    branch: 'main',
    lsp: null,
    scip: null,
    embedder: null,
    log: getLogger(),
    files: [],
    indexDependencies: false,
    history: false,
    staleSymbolIds: [],
    changedSourcePaths: [],
    sourceCache: new Map(),
    layer: 'baseline',
    generation: 1,
    ...overrides,
  };
}

describe('ScipIndexerStage', () => {
  it('returns early when scip is null', async () => {
    const stage = new ScipIndexerStage();
    const ctx = makeMinimalContext({ scip: null });
    // Should not throw
    await stage.execute(ctx, 'build');
    ctx.db.close();
  });

  it('returns early when scip is disabled', async () => {
    const stage = new ScipIndexerStage();
    const ctx = makeMinimalContext({ scip: { enabled: false } as any });
    await stage.execute(ctx, 'build');
    ctx.db.close();
  });

  it('returns early when layer is overlay', async () => {
    const stage = new ScipIndexerStage();
    const ctx = makeMinimalContext({
      scip: { enabled: true } as any,
      layer: 'overlay',
    });
    await stage.execute(ctx, 'build');
    ctx.db.close();
  });

  it('has correct stage name', () => {
    const stage = new ScipIndexerStage();
    expect(stage.name).toBe('scip-indexer');
  });
});

describe('ScipRefStage', () => {
  it('returns early when scipRefData is undefined', async () => {
    const stage = new ScipRefStage();
    const ctx = makeMinimalContext();
    // Should not throw
    await stage.execute(ctx, 'build');
    ctx.db.close();
  });

  it('has correct stage name', () => {
    const stage = new ScipRefStage();
    expect(stage.name).toBe('ScipRefStage');
  });
});

describe('createLoreScipTsconfig', () => {
  const tmpDir = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'lore-scip-test-')));

  afterEach(() => {
    // Clean up any generated files
    try {
      const files = fs.readdirSync(tmpDir);
      for (const f of files) {
        fs.unlinkSync(path.join(tmpDir, f));
      }
    } catch { /* ignore */ }
  });

  it('returns null when no tsconfig.json exists', () => {
    const result = createLoreScipTsconfig('/tmp/nonexistent-' + Date.now());
    expect(result).toBeNull();
  });

  it('generates a temp tsconfig when tsconfig.json exists', () => {
    // Create a minimal tsconfig.json
    const tsconfig = {
      compilerOptions: {
        strict: true,
        outDir: './dist',
        rootDir: './src',
        declaration: true,
        target: 'es2020',
      },
      exclude: ['node_modules', 'dist'],
    };
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify(tsconfig));

    const result = createLoreScipTsconfig(tmpDir);
    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);

    // Verify the generated tsconfig
    const generated = JSON.parse(fs.readFileSync(result!, 'utf8'));
    // Build-only fields should be stripped
    expect(generated.compilerOptions.outDir).toBeUndefined();
    expect(generated.compilerOptions.rootDir).toBeUndefined();
    expect(generated.compilerOptions.declaration).toBeUndefined();
    // Type-checking options should be preserved
    expect(generated.compilerOptions.strict).toBe(true);
    expect(generated.compilerOptions.target).toBe('es2020');
    // Include should have absolute paths
    expect(generated.include).toBeDefined();
    expect(generated.include.length).toBeGreaterThan(0);
    expect(generated.include[0]).toMatch(/\*\*\/\*\.ts$/);
    // Exclude should preserve original entries as absolute paths
    expect(generated.exclude).toBeDefined();
    expect(generated.exclude.length).toBeGreaterThan(0);

    // Clean up the generated temp file
    fs.unlinkSync(result!);
  });

  it('handles tsconfig.json with no compilerOptions', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({}));
    const result = createLoreScipTsconfig(tmpDir);
    expect(result).not.toBeNull();
    const generated = JSON.parse(fs.readFileSync(result!, 'utf8'));
    expect(generated.compilerOptions).toBeDefined();
    fs.unlinkSync(result!);
  });

  it('returns null for malformed tsconfig.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), 'not json!!!');
    const result = createLoreScipTsconfig(tmpDir);
    expect(result).toBeNull();
  });
});
