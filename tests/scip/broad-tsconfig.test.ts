import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createLoreScipTsconfig } from '../../src/indexer/stages/scip-indexer.js';

describe('createLoreScipTsconfig', () => {
  it('returns null when no tsconfig.json exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-broad-tsconfig-'));
    try {
      expect(createLoreScipTsconfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates a broad tsconfig that strips build-only fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-broad-tsconfig-'));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          outDir: './dist',
          rootDir: './src',
          declaration: true,
          declarationMap: true,
          sourceMap: true,
          composite: true,
          target: 'ES2022',
          module: 'Node16',
        },
        include: ['src/**/*.ts'],
        exclude: ['node_modules', 'dist'],
      }),
    );

    try {
      const outPath = createLoreScipTsconfig(dir);
      expect(outPath).not.toBeNull();

      const generated = JSON.parse(readFileSync(outPath!, 'utf8'));

      // Build-only fields should be stripped
      expect(generated.compilerOptions.outDir).toBeUndefined();
      expect(generated.compilerOptions.rootDir).toBeUndefined();
      expect(generated.compilerOptions.declaration).toBeUndefined();
      expect(generated.compilerOptions.declarationMap).toBeUndefined();
      expect(generated.compilerOptions.sourceMap).toBeUndefined();
      expect(generated.compilerOptions.composite).toBeUndefined();

      // Type-checking options should be preserved
      expect(generated.compilerOptions.strict).toBe(true);
      expect(generated.compilerOptions.target).toBe('ES2022');
      expect(generated.compilerOptions.module).toBe('Node16');

      // Include should be broad (all .ts/.tsx)
      expect(generated.include).toHaveLength(2);
      expect(generated.include[0]).toContain('**/*.ts');
      expect(generated.include[1]).toContain('**/*.tsx');

      // Exclude should use absolute paths from original exclude
      expect(generated.exclude).toHaveLength(2);
      expect(generated.exclude[0]).toContain('node_modules');
      expect(generated.exclude[1]).toContain('dist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults exclude to node_modules when not specified', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-broad-tsconfig-'));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );

    try {
      const outPath = createLoreScipTsconfig(dir);
      expect(outPath).not.toBeNull();

      const generated = JSON.parse(readFileSync(outPath!, 'utf8'));
      expect(generated.exclude).toHaveLength(1);
      expect(generated.exclude[0]).toContain('node_modules');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for invalid JSON in tsconfig', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-broad-tsconfig-'));
    writeFileSync(join(dir, 'tsconfig.json'), '{ invalid json }');

    try {
      expect(createLoreScipTsconfig(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
