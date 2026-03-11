import { describe, it, expect } from 'vitest';

/**
 * Smoke tests verifying that the public entry point exports all symbols
 * added in the file-watcher / file-poller feature.
 *
 * We intentionally test only the shape of the exports (class constructors,
 * type-level checks) without exercising I/O behaviour — that is covered in
 * the dedicated watcher.test.ts and poller.test.ts suites.
 */

describe('src/index.ts — public exports', () => {
  it('should export FileWatcher as a constructor', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.FileWatcher).toBe('function');
  });

  it('should export FilePoller as a constructor', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.FilePoller).toBe('function');
  });

  it('should not have removed any pre-existing exports', async () => {
    const mod = await import('../src/index.js');
    // Spot-check a few of the originally-present symbols
    expect(typeof mod.IndexBuilder).toBe('function');
    expect(typeof mod.walkFiles).toBe('function');
    expect(typeof mod.openDb).toBe('function');
  });

  it('should export resolution utilities', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.resolveSymbolEdges).toBe('function');
    expect(typeof mod.topoSort).toBe('function');
    expect(typeof mod.detectCycles).toBe('function');
  });

  it('should export graph-analysis utilities', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.detectSymbolCycles).toBe('function');
    expect(typeof mod.findConnectedComponents).toBe('function');
    expect(typeof mod.clusterSymbols).toBe('function');
    expect(typeof mod.buildCodebaseSummary).toBe('function');
  });

  it('should export embedding utilities', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.TransformersJsProvider).toBe('function');
    expect(typeof mod.LazyEmbeddingProvider).toBe('function');
    expect(typeof mod.tokenAwareBatch).toBe('function');
    expect(typeof mod.hashEmbeddingText).toBe('function');
    expect(typeof mod.DEFAULT_EMBEDDING_MODEL).toBe('string');
  });

  it('should export pipeline and stages', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.IndexPipeline).toBe('function');
    expect(typeof mod.ScipSourceStage).toBe('function');
    expect(typeof mod.SourceIndexStage).toBe('function');
    expect(typeof mod.DocsIndexStage).toBe('function');
    expect(typeof mod.ImportResolutionStage).toBe('function');
    expect(typeof mod.DependencyApiStage).toBe('function');
    expect(typeof mod.ScipEnrichmentStage).toBe('function');
    expect(typeof mod.LspEnrichmentStage).toBe('function');
    expect(typeof mod.EmbeddingStage).toBe('function');
  });

  it('should export LoreRuntime', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.LoreRuntime).toBe('function');
  });

  it('should export MCP server factories', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.createLoreMcpServer).toBe('function');
    expect(typeof mod.createLoreMcpServerAsync).toBe('function');
  });

  it('should export git hooks installer', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.installGitHooks).toBe('function');
  });

  it('should export resolution method constants', async () => {
    const mod = await import('../src/index.js');
    expect(Array.isArray(mod.RESOLUTION_METHODS)).toBe(true);
    expect(mod.RESOLVED_METHODS instanceof Set).toBe(true);
    expect(mod.UNRESOLVED_METHODS instanceof Set).toBe(true);
  });

  it('should export ImportResolver', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.ImportResolver).toBe('function');
  });

  it('should export detectLanguageForPath', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.detectLanguageForPath).toBe('function');
  });
});

describe('src/indexer/stages/index.ts — re-exports', () => {
  it('should export all stage constructors', async () => {
    const mod = await import('../src/indexer/stages/index.js');
    expect(typeof mod.SourceIndexStage).toBe('function');
    expect(typeof mod.DocsIndexStage).toBe('function');
    expect(typeof mod.ImportResolutionStage).toBe('function');
    expect(typeof mod.DependencyApiStage).toBe('function');
    expect(typeof mod.LspEnrichmentStage).toBe('function');
    expect(typeof mod.EmbeddingStage).toBe('function');
    expect(typeof mod.ScipEnrichmentStage).toBe('function');
    expect(typeof mod.ScipSourceStage).toBe('function');
  });
});
