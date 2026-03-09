/**
 * API surface test: ensures that the public exports from src/index.ts
 * match the intentional set — no accidental internal leaks, no missing
 * exports after refactoring.
 */

import { describe, it, expect } from 'vitest';
import * as publicApi from '../src/index.js';

describe('public API surface', () => {
  it('should export IndexBuilder', () => {
    expect(publicApi.IndexBuilder).toBeDefined();
  });

  it('should export resolveSymbolEdges (sole resolution entry point)', () => {
    expect(publicApi.resolveSymbolEdges).toBeDefined();
  });

  it('should NOT export buildCallGraph (deprecated alias removed)', () => {
    expect((publicApi as any).buildCallGraph).toBeUndefined();
  });

  it('should NOT export normalizeTypeName (internal helper)', () => {
    expect((publicApi as any).normalizeTypeName).toBeUndefined();
  });

  it('should NOT export ParserPool (internal detail)', () => {
    expect((publicApi as any).ParserPool).toBeUndefined();
  });

  it('should export resolution method taxonomy', () => {
    expect(publicApi.RESOLUTION_METHODS).toBeDefined();
    expect(publicApi.RESOLVED_METHODS).toBeDefined();
    expect(publicApi.UNRESOLVED_METHODS).toBeDefined();
  });

  it('should export pipeline infrastructure', () => {
    expect(publicApi.IndexPipeline).toBeDefined();
  });

  it('should export all pipeline stages', () => {
    expect(publicApi.SourceIndexStage).toBeDefined();
    expect(publicApi.DocsIndexStage).toBeDefined();
    expect(publicApi.ImportResolutionStage).toBeDefined();
    expect(publicApi.DependencyApiStage).toBeDefined();
    expect(publicApi.LspEnrichmentStage).toBeDefined();
    expect(publicApi.EmbeddingStage).toBeDefined();
  });

  it('should export runtime', () => {
    expect(publicApi.LoreRuntime).toBeDefined();
  });

  it('should export MCP server factories', () => {
    expect(publicApi.createLoreMcpServer).toBeDefined();
    expect(publicApi.createLoreMcpServerAsync).toBeDefined();
  });

  it('should export tool registry', () => {
    expect(publicApi.registerTools).toBeDefined();
  });

  it('should export database helpers', () => {
    expect(publicApi.openDb).toBeDefined();
    expect(publicApi.openReadOnly).toBeDefined();
  });

  it('should NOT export internal stage helpers', () => {
    expect((publicApi as any).processFile).toBeUndefined();
    expect((publicApi as any).enrichProjectRefs).toBeUndefined();
    expect((publicApi as any).loadBuildCheckpoint).toBeUndefined();
    expect((publicApi as any).saveBuildCheckpoint).toBeUndefined();
  });
});
