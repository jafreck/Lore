/**
 * @module integration/lore-self
 *
 * Deterministic integration tests against the Lore repository itself (TypeScript).
 * Validates indexing of Lore's own codebase — tests symbol lookups, call graphs,
 * dependents, search, and structural analysis against known architectural facts.
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

// Pinned lore-self spec — matches tests/benchmark/util/repos.ts
const LORE_SELF_SPEC = {
  name: 'lore-self',
  url: 'https://github.com/jafreck/Lore.git',
  sha: '660be2bf23889f8191d726c77bc39f5b25313095',
  languages: ['typescript'] as string[],
  size: 'medium' as const,
  structure: 'cli' as const,
};

describe.skipIf(!INTEGRATION_ENABLED)('integration: lore-self', () => {
  let repo: IndexedRepo;

  beforeAll(async () => {
    repo = await prepareRepo(LORE_SELF_SPEC);
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
    it('finds openDb by exact name', async () => {
      const result = await lookupSymbol(repo.db, 'openDb');
      expect(result.results.length).toBeGreaterThan(0);
      const names = result.results.map((r: any) => r.name);
      expect(names).toContain('openDb');
    });

    it('finds build method by exact name', async () => {
      const result = await lookupSymbol(repo.db, 'build');
      expect(result.results.length).toBeGreaterThan(0);
      const names = result.results.map((r: any) => r.name);
      expect(names).toContain('build');
    });

    it('finds resolveSymbolEdges by exact name', async () => {
      const result = await lookupSymbol(repo.db, 'resolveSymbolEdges');
      expect(result.results.length).toBeGreaterThan(0);
    });

    it('finds symbols by prefix match', async () => {
      const result = await lookupSymbol(repo.db, 'Index', { match_mode: 'prefix' });
      expect(result.results.length).toBeGreaterThan(0);
      for (const r of result.results as any[]) {
        expect(r.name.toLowerCase()).toMatch(/^index/i);
      }
    });

    it('returns empty for a non-existent symbol', async () => {
      const result = await lookupSymbol(repo.db, 'thisSymbolDoesNotExist12345');
      expect(result.results).toHaveLength(0);
    });
  });

  // ─── File lookups ──────────────────────────────────────────────────────

  describe('lore_lookup (files)', () => {
    it('finds src/db/schema.ts', async () => {
      const result = await lookupFile(repo.db, absPath(repo.repoRoot, 'src/db/schema.ts'));
      expect(result.results.length).toBeGreaterThan(0);
    });

    it('finds src/indexer/index.ts', async () => {
      const result = await lookupFile(repo.db, absPath(repo.repoRoot, 'src/indexer/index.ts'));
      expect(result.results.length).toBeGreaterThan(0);
    });

    it('returns empty for a non-existent file', async () => {
      const result = await lookupFile(repo.db, absPath(repo.repoRoot, 'does/not/exist.ts'));
      expect(result.results).toHaveLength(0);
    });
  });

  // ─── Structural search ────────────────────────────────────────────────

  describe('lore_search', () => {
    it('structural search for "openDb" returns relevant results', async () => {
      const result = await searchSymbols(repo.db, 'openDb');
      expect(result.results.length).toBeGreaterThan(0);
      const names = result.results.map((r: any) => r.name);
      expect(names).toContain('openDb');
    });

    it('structural search with language filter', async () => {
      const result = await searchSymbols(repo.db, 'handler', { language: 'typescript' });
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.mode_used).toBe('structural');
    });

    it('structural search with path_prefix filter', async () => {
      const prefix = absPath(repo.repoRoot, 'src/server/');
      const result = await searchSymbols(repo.db, 'handler', {
        path_prefix: prefix,
      });
      expect(result.results.length).toBeGreaterThan(0);
      for (const r of result.results as any[]) {
        expect(r.file_path).toContain('src/server/');
      }
    });
  });

  // ─── Call graph ────────────────────────────────────────────────────────

  describe('lore_graph', () => {
    it('openDb has callers', async () => {
      const lookup = await lookupSymbol(repo.db, 'openDb');
      const sym = (lookup.results as any[]).find(
        (r) => r.name === 'openDb',
      );
      expect(sym).toBeDefined();

      const callers = await queryCallers(repo.db, sym.id);
      expect(callers.edges.length).toBeGreaterThan(0);
    });

    it('build has outbound call edges', async () => {
      const lookup = await lookupSymbol(repo.db, 'build', { symbol_kind: 'method' });
      const sym = (lookup.results as any[]).find(
        (r) => r.name === 'build',
      );
      expect(sym).toBeDefined();

      const callees = await queryCallees(repo.db, sym.id);
      expect(callees.edges.length).toBeGreaterThan(0);
    });
  });

  // ─── Dependents ────────────────────────────────────────────────────────

  describe('lore_dependents', () => {
    it('finds dependents of openDb', async () => {
      const result = await findDependents(repo.db, 'openDb');
      expect(result.target).toBeDefined();
      expect(result.target.name).toBe('openDb');
      expect(result.total_count).toBeGreaterThan(0);
    });
  });

  // ─── Structure ─────────────────────────────────────────────────────────

  describe('lore_structure', () => {
    it('all analysis returns without errors', async () => {
      const result = await analyzeStructure(repo.db, 'all');
      expect(result).toBeDefined();
    });

    it('layer analysis runs without error', async () => {
      const result = await analyzeStructure(repo.db, 'layers');
      expect(result).toBeDefined();
    });
  });

  // ─── Snippets ──────────────────────────────────────────────────────────

  describe('lore_snippet', () => {
    it('returns source code for src/db/schema.ts', async () => {
      const fullPath = absPath(repo.repoRoot, 'src/db/schema.ts');
      const result = await getSnippet(repo.db, fullPath, 1, 30);
      expect(result.path).toContain('schema.ts');
      expect(result.text).toBeDefined();
      expect(result.text.length).toBeGreaterThan(0);
    });
  });
});
