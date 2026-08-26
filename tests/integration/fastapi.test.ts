/**
 * @module integration/fastapi
 *
 * Deterministic integration tests against the fastapi repository (Python).
 * Validates that the Lore index produces correct, queryable results across
 * a different language ecosystem.
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

// Pinned fastapi spec — matches tests/benchmark/util/repos.ts
const FASTAPI_SPEC = {
  name: 'fastapi',
  url: 'https://github.com/fastapi/fastapi.git',
  sha: '11614be9021aa4ac078d4d0693a8b5250a1010d8',
  languages: ['python'] as string[],
  size: 'medium' as const,
  structure: 'sdk' as const,
};

describe.skipIf(!INTEGRATION_ENABLED)('integration: fastapi', () => {
  let repo: IndexedRepo;

  beforeAll(async () => {
    repo = await prepareRepo(FASTAPI_SPEC);
  }, 600_000); // 10 min timeout for clone + index

  // ─── Index health ──────────────────────────────────────────────────────

  describe('index health', () => {
    it('index has symbols, files, and refs', () => {
      const stats = getIndexStats(repo.db);
      expect(stats.symbolCount).toBeGreaterThan(50);
      expect(stats.fileCount).toBeGreaterThan(5);
      expect(stats.refCount).toBeGreaterThan(50);
    });

    it('cohesion analysis returns directories', async () => {
      const result = await analyzeCohesion(repo.db);
      expect(result.directories).toBeDefined();
      expect(result.directories.length).toBeGreaterThan(0);
    });
  });

  // ─── Symbol lookups ────────────────────────────────────────────────────

  describe('lore_lookup', () => {
    it('finds solve_dependencies by exact name', async () => {
      const result = await lookupSymbol(repo.db, 'solve_dependencies');
      expect(result.results.length).toBeGreaterThan(0);
      const names = result.results.map((r: any) => r.name);
      expect(names).toContain('solve_dependencies');
    });

    it('finds add_api_route by exact name', async () => {
      const result = await lookupSymbol(repo.db, 'add_api_route');
      expect(result.results.length).toBeGreaterThan(0);
      const names = result.results.map((r: any) => r.name);
      expect(names).toContain('add_api_route');
    });

    it('finds FastAPI class', async () => {
      const result = await lookupSymbol(repo.db, 'FastAPI', { symbol_kind: 'class' });
      expect(result.results.length).toBeGreaterThan(0);
      const fastapi = (result.results as any[]).find((r) => r.name === 'FastAPI');
      expect(fastapi).toBeDefined();
    });

    it('finds symbols by prefix match', async () => {
      const result = await lookupSymbol(repo.db, 'get_', { match_mode: 'prefix' });
      expect(result.results.length).toBeGreaterThan(0);
      for (const r of result.results as any[]) {
        expect(r.name.toLowerCase()).toMatch(/^get_/);
      }
    });

    it('returns empty for a non-existent symbol', async () => {
      const result = await lookupSymbol(repo.db, 'thisSymbolDoesNotExist12345');
      expect(result.results).toHaveLength(0);
    });
  });

  // ─── File lookups ──────────────────────────────────────────────────────

  describe('lore_lookup (files)', () => {
    it('finds fastapi/routing.py', async () => {
      const result = await lookupFile(repo.db, absPath(repo.repoRoot, 'fastapi/routing.py'));
      expect(result.results.length).toBeGreaterThan(0);
    });

    it('finds fastapi/dependencies/utils.py', async () => {
      const result = await lookupFile(repo.db, absPath(repo.repoRoot, 'fastapi/dependencies/utils.py'));
      expect(result.results.length).toBeGreaterThan(0);
    });

    it('returns empty for a non-existent file', async () => {
      const result = await lookupFile(repo.db, absPath(repo.repoRoot, 'does/not/exist.py'));
      expect(result.results).toHaveLength(0);
    });
  });

  // ─── Structural search ────────────────────────────────────────────────

  describe('lore_search', () => {
    it('structural search for "solve_dependencies" returns relevant results', async () => {
      const result = await searchSymbols(repo.db, 'solve_dependencies');
      expect(result.results.length).toBeGreaterThan(0);
      const names = result.results.map((r: any) => r.name);
      expect(names).toContain('solve_dependencies');
    });

    it('structural search with language filter', async () => {
      const result = await searchSymbols(repo.db, 'route', { language: 'python' });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.mode_used).toBe('structural');
    });

    it('structural search with path_prefix filter', async () => {
      const prefix = absPath(repo.repoRoot, 'fastapi/');
      const result = await searchSymbols(repo.db, 'dependencies', {
        path_prefix: prefix,
      });
      expect(result.results.length).toBeGreaterThan(0);
      for (const r of result.results as any[]) {
        expect(r.file_path).toContain('fastapi/');
      }
    });
  });

  // ─── Call graph ────────────────────────────────────────────────────────

  describe('lore_graph', () => {
    it('solve_dependencies has callers', async () => {
      const lookup = await lookupSymbol(repo.db, 'solve_dependencies');
      const sym = (lookup.results as any[]).find(
        (r) => r.name === 'solve_dependencies',
      );
      expect(sym).toBeDefined();

      const callers = await queryCallers(repo.db, sym.id);
      expect(callers.edges.length).toBeGreaterThan(0);
    });

    it('add_api_route has outbound call edges', async () => {
      const lookup = await lookupSymbol(repo.db, 'add_api_route');
      const sym = (lookup.results as any[]).find(
        (r) => r.name === 'add_api_route',
      );
      expect(sym).toBeDefined();

      const callees = await queryCallees(repo.db, sym.id);
      expect(callees.edges.length).toBeGreaterThan(0);
    });
  });

  // ─── Dependents ────────────────────────────────────────────────────────

  describe('lore_dependents', () => {
    it('finds dependents of solve_dependencies', async () => {
      const result = await findDependents(repo.db, 'solve_dependencies');
      expect(result.target).toBeDefined();
      expect(result.target.name).toBe('solve_dependencies');
      expect(result.total_count).toBeGreaterThan(0);
    });

    it('throws on ambiguous symbol without file path', async () => {
      // add_api_route exists in both applications.py and routing.py
      await expect(findDependents(repo.db, 'add_api_route')).rejects.toThrow(
        /ambiguous/i,
      );
    });
  });

  // ─── Structure ─────────────────────────────────────────────────────────

  describe('lore_structure', () => {
    it('all analysis returns without errors', async () => {
      const result = await analyzeStructure(repo.db, 'all');
      expect(result).toBeDefined();
    });

    it('outlier detection runs and returns results', async () => {
      const result = await analyzeStructure(repo.db, 'outliers');
      expect(result).toBeDefined();
      // fastapi has a flat structure so outliers may be few or zero
      if (result.outliers) {
        for (const outlier of result.outliers) {
          expect(outlier.from_dir).toBeDefined();
          expect(outlier.to_dir).toBeDefined();
          expect(outlier.edge_count).toBeGreaterThan(0);
        }
      }
    });
  });

  // ─── Snippets ──────────────────────────────────────────────────────────

  describe('lore_snippet', () => {
    it('returns source code for fastapi/routing.py', async () => {
      const fullPath = absPath(repo.repoRoot, 'fastapi/routing.py');
      const result = await getSnippet(repo.db, fullPath, 1, 30);
      expect(result.path).toContain('routing.py');
      expect(result.text).toBeDefined();
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.start_line).toBe(1);
    });

    it('returns source code for a nested file', async () => {
      const fullPath = absPath(repo.repoRoot, 'fastapi/dependencies/utils.py');
      const result = await getSnippet(repo.db, fullPath, 1, 20);
      expect(result.path).toContain('utils.py');
      expect(result.text.length).toBeGreaterThan(0);
    });
  });
});
