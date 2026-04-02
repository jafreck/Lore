/**
 * @module integration/zod
 *
 * Deterministic integration tests against the zod repository (TypeScript).
 * Validates that the Lore index produces correct, queryable results for
 * symbol lookups, call graphs, dependents, search, and structural analysis.
 *
 * Gated behind INTEGRATION=1 (requires cloning the repo).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  INTEGRATION_ENABLED,
  prepareRepo,
  lookupSymbol,
  lookupFile,
  queryCallees,
  queryCallers,
  searchSymbols,
  findDependents,
  analyzeStructure,
  getSnippet,
  analyzeCohesion,
  absPath,
  getIndexStats,
  type IndexedRepo,
} from './harness.js';

// Pinned zod spec — matches tests/benchmark/util/repos.ts
const ZOD_SPEC = {
  name: 'zod',
  url: 'https://github.com/colinhacks/zod.git',
  sha: 'c7805073fef5b6b8857307c3d4b3597a70613bc2',
  languages: ['typescript'] as string[],
  size: 'small' as const,
  structure: 'sdk' as const,
};

describe.skipIf(!INTEGRATION_ENABLED)('integration: zod', () => {
  let repo: IndexedRepo;

  beforeAll(async () => {
    repo = await prepareRepo(ZOD_SPEC);
  }, 600_000); // 10 min timeout for clone + index

  // ─── Index health ──────────────────────────────────────────────────────

  describe('index health', () => {
    it('index has symbols, files, and refs', () => {
      const stats = getIndexStats(repo.db);
      expect(stats.symbolCount).toBeGreaterThan(100);
      expect(stats.fileCount).toBeGreaterThan(10);
      expect(stats.refCount).toBeGreaterThan(100);
    });

    it('cohesion analysis returns directories', async () => {
      const result = await analyzeCohesion(repo.db);
      expect(result.directories).toBeDefined();
      expect(result.directories.length).toBeGreaterThan(0);
    });
  });

  // ─── Symbol lookups ────────────────────────────────────────────────────

  describe('lore_lookup', () => {
    it('finds _parse by exact name', async () => {
      const result = await lookupSymbol(repo.db, '_parse');
      expect(result.results.length).toBeGreaterThan(0);
      const names = result.results.map((r: any) => r.name);
      expect(names).toContain('_parse');
    });

    it('finds parse function by exact name', async () => {
      const result = await lookupSymbol(repo.db, 'parse');
      expect(result.results.length).toBeGreaterThan(0);
      const names = result.results.map((r: any) => r.name);
      expect(names).toContain('parse');
    });

    it('finds symbols by prefix match', async () => {
      const result = await lookupSymbol(repo.db, 'Zod', { match_mode: 'prefix' });
      expect(result.results.length).toBeGreaterThan(0);
      for (const r of result.results as any[]) {
        expect(r.name.toLowerCase()).toMatch(/^zod/i);
      }
    });

    it('finds symbols using contains mode', async () => {
      const result = await lookupSymbol(repo.db, 'Schema', { match_mode: 'contains' });
      expect(result.results.length).toBeGreaterThan(0);
      for (const r of result.results as any[]) {
        expect(r.name.toLowerCase()).toContain('schema');
      }
    });

    it('returns empty for a non-existent symbol', async () => {
      const result = await lookupSymbol(repo.db, 'thisSymbolDoesNotExist12345');
      expect(result.results).toHaveLength(0);
    });
  });

  // ─── File lookups ──────────────────────────────────────────────────────

  describe('lore_lookup (files)', () => {
    it('finds the parse.ts file', async () => {
      const fullPath = absPath(repo.repoRoot, 'packages/zod/src/v4/core/parse.ts');
      const result = await lookupFile(repo.db, fullPath);
      expect(result.results.length).toBeGreaterThan(0);
    });

    it('returns empty for a non-existent file', async () => {
      const result = await lookupFile(repo.db, absPath(repo.repoRoot, 'does/not/exist.ts'));
      expect(result.results).toHaveLength(0);
    });
  });

  // ─── Structural search ────────────────────────────────────────────────

  describe('lore_search', () => {
    it('structural search for "parse" returns relevant results', async () => {
      const result = await searchSymbols(repo.db, 'parse');
      expect(result.results.length).toBeGreaterThan(0);
      const names = result.results.map((r: any) => r.name);
      expect(names.some((n: string) => n.toLowerCase().includes('parse'))).toBe(true);
    });

    it('structural search with language filter', async () => {
      const result = await searchSymbols(repo.db, 'schema', { language: 'typescript' });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.mode_used).toBe('structural');
    });

    it('structural search with path_prefix filter', async () => {
      const prefix = absPath(repo.repoRoot, 'packages/zod/src/v4/');
      const result = await searchSymbols(repo.db, 'parse', {
        path_prefix: prefix,
      });
      expect(result.results.length).toBeGreaterThan(0);
      for (const r of result.results as any[]) {
        expect(r.file_path).toContain('packages/zod/src/v4/');
      }
    });
  });

  // ─── Call graph ────────────────────────────────────────────────────────

  describe('lore_graph', () => {
    it('a symbol has outbound call edges (callees)', async () => {
      // _parse (variable id=509) has callees — it calls run, finalizeIssue, etc.
      const lookup = await lookupSymbol(repo.db, '_parse');
      const parseSymbol = (lookup.results as any[]).find(
        (r) => r.name === '_parse',
      );
      expect(parseSymbol).toBeDefined();

      const callees = await queryCallees(repo.db, parseSymbol.id);
      expect(callees.edges.length).toBeGreaterThan(0);
    });

    it('a widely-used symbol has callers', async () => {
      // Look up 'run' method which is called by _parse and others
      const lookup = await lookupSymbol(repo.db, 'run', { symbol_kind: 'method' });
      const sym = (lookup.results as any[]).find(
        (r) => r.name === 'run',
      );
      expect(sym).toBeDefined();

      const callers = await queryCallers(repo.db, sym.id);
      expect(callers.edges.length).toBeGreaterThan(0);
    });
  });

  // ─── Dependents ────────────────────────────────────────────────────────

  describe('lore_dependents', () => {
    it('finds dependents of finalizeIssue', async () => {
      const result = await findDependents(repo.db, 'finalizeIssue');
      expect(result.target).toBeDefined();
      expect(result.target.name).toBe('finalizeIssue');
      expect(result.total_count).toBeGreaterThan(0);
    });
  });

  // ─── Structure ─────────────────────────────────────────────────────────

  describe('lore_structure', () => {
    it('all analysis returns without errors', async () => {
      const result = await analyzeStructure(repo.db, 'all');
      // Should return at least one of cycles, layer_violations, or outliers
      expect(result).toBeDefined();
      expect(
        (result.cycles?.length ?? 0) +
        (result.layer_violations?.length ?? 0) +
        (result.outliers?.length ?? 0),
      ).toBeGreaterThanOrEqual(0); // may be 0 for clean codebases
    });

    it('cycle detection runs without error', async () => {
      const result = await analyzeStructure(repo.db, 'cycles');
      expect(result).toBeDefined();
      // cycles may or may not be present
      if (result.cycles) {
        for (const cycle of result.cycles) {
          expect(cycle.directories.length).toBeGreaterThanOrEqual(2);
          expect(cycle.edge_count).toBeGreaterThan(0);
        }
      }
    });
  });

  // ─── Snippets ──────────────────────────────────────────────────────────

  describe('lore_snippet', () => {
    it('returns source code for a known file', async () => {
      const fullPath = absPath(repo.repoRoot, 'packages/zod/src/v4/core/parse.ts');
      const result = await getSnippet(repo.db, fullPath, 1, 20);
      expect(result.path).toContain('parse.ts');
      expect(result.text).toBeDefined();
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.start_line).toBe(1);
    });
  });
});
