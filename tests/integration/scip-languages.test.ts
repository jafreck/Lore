/**
 * @module integration/scip-languages
 *
 * Integration tests for every language with an SCIP indexer.
 *
 * Each language is tested against a small-to-medium pinned open-source repo:
 * - Clone (or reuse cached) → SCIP index → query via tool handlers
 * - Validates: symbol extraction, file indexing, call refs, search, snippets
 *
 * Languages covered (13 entries in src/scip/registry.ts, 10 unique indexers):
 *
 * | Language   | Indexer          | Repo                          |
 * |------------|------------------|-------------------------------|
 * | typescript | scip-typescript  | (covered by zod + lore-self)  |
 * | python     | scip-python      | (covered by fastapi)          |
 * | java       | scip-java        | jackson-databind              |
 * | kotlin     | scip-java        | moshi                         |
 * | scala      | scip-java        | playframework                 |
 * | go         | scip-go          | gin                           |
 * | rust       | rust-analyzer    | once_cell                     |
 * | c          | scip-clang       | cJSON                         |
 * | cpp        | scip-clang       | nlohmann-json                 |
 * | csharp     | scip-dotnet      | Humanizer                     |
 * | ruby       | scip-ruby        | jekyll                        |
 * | php        | scip-php         | phpmailer                     |
 *
 * Note: Dart is omitted because .dart is not yet in EXT_TO_LANG.
 *
 * Gated behind INTEGRATION=1 (requires cloning repos + SCIP indexers).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  INTEGRATION_ENABLED,
  prepareRepo,
  lookupSymbol,
  lookupFile,
  queryCallees,
  searchSymbols,
  analyzeStructure,
  getSnippet,
  absPath,
  getIndexStats,
  type IndexedRepo,
  type BuildCommand,
} from './harness.js';
import type { RepoSpec } from '../benchmark/util/types.js';

// ─── Repo specs ──────────────────────────────────────────────────────────────

const REPOS: Record<string, {
  spec: RepoSpec;
  /** Commands to compile/build the project before SCIP indexing. */
  buildCommands?: BuildCommand[];
  /** Override SCIP per-indexer timeout in ms (default: 120_000). */
  scipTimeoutMs?: number;
  /** A well-known symbol name to look up. */
  knownSymbol: string;
  /** Optional symbol_kind filter for the known symbol. */
  knownSymbolKind?: string;
  /** A known file path relative to repo root. */
  knownFile: string;
  /** A search query that should return results. */
  searchQuery: string;
  /** Set to false for indexers that don't emit call references (e.g., scip-php). */
  expectCallRefs?: boolean;
}> = {
  // ── Java (scip-java via coursier) ───────────────────────────────────────
  java: {
    spec: {
      name: 'jackson-databind',
      url: 'https://github.com/FasterXML/jackson-databind.git',
      sha: '331c4a8ef8616a9f2581dd990bd6b9e9d8bca68b',
      languages: ['java'],
      size: 'medium',
      structure: 'sdk',
    },
    buildCommands: [
      { command: 'chmod', args: ['+x', './mvnw'] },
      { command: './mvnw', args: ['compile', '-DskipTests', '-q', '-B'], timeoutMs: 600_000 },
    ],
    scipTimeoutMs: 600_000,
    knownSymbol: 'reportInputMismatch',
    knownFile: 'src/main/java/com/fasterxml/jackson/databind/DeserializationContext.java',
    searchQuery: 'deserialize',
  },

  // ── Go (scip-go) ───────────────────────────────────────────────────────
  // No build needed — scip-go works directly on source.
  go: {
    spec: {
      name: 'gin',
      url: 'https://github.com/gin-gonic/gin.git',
      sha: 'd3ffc9985281dcf4d3bef604cce4e662b1a327a6',
      languages: ['go'],
      size: 'small',
      structure: 'sdk',
    },
    knownSymbol: 'Default',
    knownFile: 'gin.go',
    searchQuery: 'router',
  },

  // ── Rust (rust-analyzer scip) ──────────────────────────────────────────
  rust: {
    spec: {
      name: 'once_cell',
      url: 'https://github.com/matklad/once_cell.git',
      sha: '80fe900b21f6d76c1a2ed74d3343e8a3a88c46d0',
      languages: ['rust'],
      size: 'small',
      structure: 'sdk',
    },
    buildCommands: [
      { command: 'cargo', args: ['check'], timeoutMs: 300_000 },
    ],
    knownSymbol: 'OnceCell',
    knownFile: 'src/lib.rs',
    searchQuery: 'OnceCell',
  },

  // ── C (scip-clang + CMake compdb) ─────────────────────────────────────
  // Explicit cmake build generates compile_commands.json for scip-clang.
  c: {
    spec: {
      name: 'cjson',
      url: 'https://github.com/DaveGamble/cJSON.git',
      sha: 'b2890c8d76bbb64e710585ebc0a917196b9c67e7',
      languages: ['c'],
      size: 'small',
      structure: 'sdk',
    },
    buildCommands: [
      { command: 'cmake', args: ['-B', 'build', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'], timeoutMs: 120_000 },
    ],
    knownSymbol: 'cJSON_Parse',
    knownFile: 'cJSON.c',
    searchQuery: 'cJSON_Parse',
  },

  // ── C++ (scip-clang + CMake compdb) ───────────────────────────────────
  // Lore auto-generates compile_commands.json via cmake for this project.
  cpp: {
    spec: {
      name: 'nlohmann-json',
      url: 'https://github.com/nlohmann/json.git',
      sha: '9a737481aed085fd289f82dff1fa8c3c66627a7e',
      languages: ['cpp'],
      size: 'medium',
      structure: 'sdk',
    },
    knownSymbol: 'parse',
    knownFile: 'include/nlohmann/json.hpp',
    searchQuery: 'parse',
  },

  // ── C# (scip-dotnet) ─────────────────────────────────────────────────
  // Pinned to v2.14.1 (targets net6.0; later main requires .NET 10 SDK).
  csharp: {
    spec: {
      name: 'humanizer',
      url: 'https://github.com/Humanizr/Humanizer.git',
      sha: '3ebc38de585fc641a04b0e78ed69468453b0f8a1',
      languages: ['csharp'],
      size: 'medium',
      structure: 'sdk',
    },
    buildCommands: [
      { command: 'dotnet', args: ['build', 'src/Humanizer/Humanizer.csproj', '-v', 'q', '--nologo'], timeoutMs: 600_000 },
    ],
    knownSymbol: 'Humanize',
    knownFile: 'src/Humanizer/StringHumanizeExtensions.cs',
    searchQuery: 'Humanize',
  },

  // ── Ruby (scip-ruby) ─────────────────────────────────────────────────
  // scip-ruby parses source directly; no build needed.
  ruby: {
    spec: {
      name: 'jekyll',
      url: 'https://github.com/jekyll/jekyll.git',
      sha: 'ff0d4dd78d939d8596f5ded57f3b2b321eb66b5a',
      languages: ['ruby'],
      size: 'medium',
      structure: 'cli',
    },
    knownSymbol: 'build',
    knownFile: 'lib/jekyll/site.rb',
    searchQuery: 'build',
  },

  // ── PHP (scip-php) ───────────────────────────────────────────────────
  // scip-php needs composer vendor autoload + lock file.
  php: {
    spec: {
      name: 'phpmailer',
      url: 'https://github.com/PHPMailer/PHPMailer.git',
      sha: 'cce0438c9bf8ae3285059e5715c78d89ccc10c9c',
      languages: ['php'],
      size: 'small',
      structure: 'sdk',
    },
    buildCommands: [
      { command: 'composer', args: ['config', 'lock', 'true'] },
      { command: 'composer', args: ['update', '--no-interaction', '-q'], timeoutMs: 120_000 },
    ],
    knownSymbol: 'send',
    knownFile: 'src/PHPMailer.php',
    searchQuery: 'mail',
    expectCallRefs: false, // scip-php emits definitions but not call references
  },

  // ── Kotlin (scip-java via Gradle wrapper) ─────────────────────────────
  kotlin: {
    spec: {
      name: 'moshi',
      url: 'https://github.com/square/moshi.git',
      sha: '17eb411d097c364563b8f6478efbcc22035197e4',
      languages: ['kotlin'],
      size: 'medium',
      structure: 'sdk',
    },
    scipTimeoutMs: 600_000,
    knownSymbol: 'fromJson',
    knownFile: 'moshi/src/main/java/com/squareup/moshi/JsonAdapter.kt',
    searchQuery: 'fromJson',
  },

  // ── Scala (scip-java via sbt) ─────────────────────────────────────────
  scala: {
    spec: {
      name: 'playframework',
      url: 'https://github.com/playframework/playframework.git',
      sha: '6c14473a4a581b24b12121dee4952cf9615065d0',
      languages: ['scala'],
      size: 'medium',
      structure: 'sdk',
    },
    buildCommands: [
      { command: 'sbt', args: ['compile'], timeoutMs: 900_000 },
    ],
    scipTimeoutMs: 600_000,
    knownSymbol: 'Action',
    knownFile: 'core/play/src/main/scala/play/api/mvc/Action.scala',
    searchQuery: 'Action',
  },

  // Note: Dart (scip-dart) is omitted — .dart is not yet in EXT_TO_LANG
  // so file discovery doesn't pick up Dart source files.
};

// ─── Per-language test suite ─────────────────────────────────────────────────

for (const [language, config] of Object.entries(REPOS)) {
  describe.skipIf(!INTEGRATION_ENABLED)(`integration: ${language} (${config.spec.name})`, () => {
    let repo: IndexedRepo;
    /** True when the SCIP indexer produced symbols (not just file discovery). */
    let hasSymbols = false;

    beforeAll(async () => {
      repo = await prepareRepo(config.spec, 'scip', config.buildCommands, config.scipTimeoutMs);
      const stats = getIndexStats(repo.db);
      hasSymbols = stats.symbolCount > 0;
    }, 900_000); // 15 min timeout for clone + build + index

    // ─── Index health ──────────────────────────────────────────────────

    describe('index health', () => {
      it('files are discovered and indexed', () => {
        const stats = getIndexStats(repo.db);
        expect(stats.fileCount).toBeGreaterThan(0);
      });

      it('SCIP indexer produced symbols', () => {
        const stats = getIndexStats(repo.db);
        expect(stats.symbolCount).toBeGreaterThan(0);
      });

      it('SCIP indexer produced call refs', () => {
        if (config.expectCallRefs === false) return; // indexer doesn't emit refs
        const stats = getIndexStats(repo.db);
        expect(stats.refCount).toBeGreaterThan(0);
      });
    });

    // ─── Symbol lookups ────────────────────────────────────────────────

    describe('lore_lookup', () => {
      it(`finds ${config.knownSymbol} by name`, async () => {
        if (!hasSymbols) return; // indexer not available
        const result = await lookupSymbol(
          repo.db,
          config.knownSymbol,
          config.knownSymbolKind ? { symbol_kind: config.knownSymbolKind } : undefined,
        );
        expect(result.results.length).toBeGreaterThan(0);
        const names = result.results.map((r: any) => r.name);
        expect(names).toContain(config.knownSymbol);
      });

      it('returns empty for a non-existent symbol', async () => {
        const result = await lookupSymbol(repo.db, 'thisSymbolDoesNotExist12345');
        expect(result.results).toHaveLength(0);
      });
    });

    // ─── File lookups ──────────────────────────────────────────────────

    describe('lore_lookup (files)', () => {
      it(`finds ${config.knownFile}`, async () => {
        const fullPath = absPath(repo.repoRoot, config.knownFile);
        const result = await lookupFile(repo.db, fullPath);
        expect(result.results.length).toBeGreaterThan(0);
      });

      it('returns empty for a non-existent file', async () => {
        const result = await lookupFile(repo.db, absPath(repo.repoRoot, 'does/not/exist.xyz'));
        expect(result.results).toHaveLength(0);
      });
    });

    // ─── Search ────────────────────────────────────────────────────────

    describe('lore_search', () => {
      it(`structural search for "${config.searchQuery}" returns results`, async () => {
        if (!hasSymbols) return; // search needs symbols from FTS index
        const result = await searchSymbols(repo.db, config.searchQuery);
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.mode_used).toBe('structural');
      });
    });

    // ─── Call graph ────────────────────────────────────────────────────

    describe('lore_graph', () => {
      it('lore_graph returns edges for a symbol with refs', async () => {
        const row = repo.db.prepare(
          'SELECT caller_id FROM symbol_refs LIMIT 1',
        ).get() as { caller_id: number } | undefined;
        if (!row) return; // no refs — indexer may not be installed
        const callees = await queryCallees(repo.db, row.caller_id);
        expect(callees.edges.length).toBeGreaterThan(0);
      });
    });

    // ─── Structure ─────────────────────────────────────────────────────

    describe('lore_structure', () => {
      it('structure analysis runs without error', async () => {
        const result = await analyzeStructure(repo.db, 'all');
        expect(result).toBeDefined();
      });
    });

    // ─── Snippets ──────────────────────────────────────────────────────

    describe('lore_snippet', () => {
      it(`returns source for ${config.knownFile}`, async () => {
        const fullPath = absPath(repo.repoRoot, config.knownFile);
        const result = await getSnippet(repo.db, fullPath, 1, 20);
        expect(result.text).toBeDefined();
        expect(result.text.length).toBeGreaterThan(0);
      });
    });
  });
}
