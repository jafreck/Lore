/**
 * @module indexer/stages/lsp-enrichment
 *
 * Pipeline stage: enrich symbols, symbol_refs, type_refs, and
 * symbol_relationships with LSP-derived metadata (definition_path,
 * definition_line, resolved_type_signature, etc.).
 *
 * ## Data written
 *
 * - `symbols.resolved_type_signature`, `resolved_return_type`,
 *   `definition_uri`, `definition_path`
 * - `symbol_refs.resolved_type_signature`, `resolved_return_type`,
 *   `definition_uri`, `definition_path`, `definition_line`, `definition_character`
 * - `type_refs.resolved_type_signature`, `definition_uri`,
 *   `definition_path`, `definition_line`, `definition_character`
 * - `symbol_relationships.definition_uri`, `definition_path`,
 *   `definition_line`, `definition_character`
 *
 * ## Data dependency
 *
 * **Must run before `ResolutionStage`.**  The resolution stage reads
 * `definition_path` / `definition_line` columns populated here to perform
 * LSP-based containment resolution.
 */

import * as fs from 'node:fs';
import type { PipelineContext, PipelineStage } from '../pipeline.js';
import { LspEnrichmentCoordinator } from '../lsp/enrichment.js';
import { buildStructuralEmbeddingText } from '../embedder.js';

/**
 * Enriches indexed artefacts with LSP-derived metadata.
 *
 * Manages the lifecycle of an `LspEnrichmentCoordinator` per pipeline run.
 * The coordinator is started during `execute()` and disposed in `dispose()`.
 */
export class LspEnrichmentStage implements PipelineStage {
  readonly name = 'lsp-enrichment';

  private coordinator: LspEnrichmentCoordinator | null = null;

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    if (!context.lsp?.enabled || context.files.length === 0) return;

    this.coordinator = new LspEnrichmentCoordinator(context.lsp, context.walkerConfig.rootDir);

    // Start language servers for all languages seen in the file list.
    const languages = new Set(context.files.map(f => f.language));
    if (context.indexDependencies) languages.add('typescript');
    await this.coordinator.start(languages);

    await enrichProjectRefs(context, this.coordinator);
  }

  async dispose(): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.dispose();
      this.coordinator = null;
    }
  }
}

// ─── Enrichment logic (extracted from IndexBuilder.enrichProjectRefs) ─────────

/**
 * Enrich symbols, call refs, type refs, and relationships for every file in
 * the context with LSP-derived metadata.
 *
 * This is a direct extraction of `IndexBuilder.enrichProjectRefs()`.
 */
async function enrichProjectRefs(
  context: PipelineContext,
  coordinator: LspEnrichmentCoordinator,
): Promise<void> {
  const { db, branch, files, log } = context;

  const selectSymbols = db.prepare(
    `SELECT s.id, s.name, s.signature, s.start_line
     FROM symbols s
     JOIN files f ON f.id = s.file_id
     WHERE f.path = ? AND f.branch = ?
     ORDER BY s.id`,
  );
  const selectCallRefs = db.prepare(
    `SELECT sr.id, sr.call_line, sr.call_character
     FROM symbol_refs sr
     JOIN symbols s ON s.id = sr.caller_id
     JOIN files f ON f.id = s.file_id
     WHERE f.path = ? AND f.branch = ?
     ORDER BY sr.id`,
  );
  const selectTypeRefs = db.prepare(
    `SELECT tr.id, tr.ref_line, tr.ref_character
     FROM type_refs tr
     JOIN files f ON f.id = tr.file_id
     WHERE f.path = ? AND f.branch = ?
     ORDER BY tr.id`,
  );
  const selectRelationships = db.prepare(
    `SELECT sr.id, sr.line, sr.character
     FROM symbol_relationships sr
     JOIN files f ON f.id = sr.file_id
     WHERE f.path = ? AND f.branch = ? AND sr.line IS NOT NULL
     ORDER BY sr.id`,
  );
  const updateSymbol = db.prepare(
    `UPDATE symbols
     SET resolved_type_signature = ?, resolved_return_type = ?, definition_uri = ?, definition_path = ?
     WHERE id = ?`,
  );
  const updateSymbolFts = db.prepare(
    'UPDATE symbols_fts SET signature = ? WHERE rowid = ?',
  );
  const updateCallRef = db.prepare(
    `UPDATE symbol_refs
     SET resolved_type_signature = ?, resolved_return_type = ?, definition_uri = ?, definition_path = ?, definition_line = ?, definition_character = ?
     WHERE id = ?`,
  );
  const updateTypeRef = db.prepare(
    `UPDATE type_refs
     SET resolved_type_signature = ?, definition_uri = ?, definition_path = ?, definition_line = ?, definition_character = ?
     WHERE id = ?`,
  );
  const updateRelationship = db.prepare(
    `UPDATE symbol_relationships
     SET definition_uri = ?, definition_path = ?, definition_line = ?, definition_character = ?
     WHERE id = ?`,
  );

  interface TaggedTarget {
    table: 'symbol' | 'callRef' | 'typeRef' | 'relationship';
    rowId: number;
    line: number;
    character: number;
    name?: string;
    signature?: string | null;
  }

  for (const file of files) {
    if (!file || !fs.existsSync(file.path)) continue;
    let source: string;
    try {
      source = fs.readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }

    const tagged: TaggedTarget[] = [];

    const symbols = selectSymbols.all(file.path, branch) as Array<{
      id: number;
      name: string;
      signature: string | null;
      start_line: number;
    }>;
    for (const s of symbols) {
      tagged.push({ table: 'symbol', rowId: s.id, line: s.start_line, character: 0, name: s.name, signature: s.signature });
    }

    const callRefs = selectCallRefs.all(file.path, branch) as Array<{
      id: number;
      call_line: number;
      call_character: number | null;
    }>;
    for (const cr of callRefs) {
      tagged.push({ table: 'callRef', rowId: cr.id, line: cr.call_line, character: cr.call_character ?? 0 });
    }

    const typeRefs = selectTypeRefs.all(file.path, branch) as Array<{
      id: number;
      ref_line: number;
      ref_character: number | null;
    }>;
    for (const tr of typeRefs) {
      tagged.push({ table: 'typeRef', rowId: tr.id, line: tr.ref_line, character: tr.ref_character ?? 0 });
    }

    const relationships = selectRelationships.all(file.path, branch) as Array<{
      id: number;
      line: number;
      character: number | null;
    }>;
    for (const r of relationships) {
      tagged.push({ table: 'relationship', rowId: r.id, line: r.line, character: r.character ?? 0 });
    }

    if (tagged.length === 0) continue;

    const metadata = await coordinator.enrich({
      filePath: file.path,
      language: file.language,
      source,
      targets: tagged.map(t => ({ line: t.line, character: t.character })),
    });

    for (let i = 0; i < tagged.length; i++) {
      const tag = tagged[i]!;
      const m = metadata[i];
      if (!m) continue;
      switch (tag.table) {
        case 'symbol':
          updateSymbol.run(
            m.resolvedTypeSignature,
            m.resolvedReturnType,
            m.definitionUri,
            m.definitionPath,
            tag.rowId,
          );
          updateSymbolFts.run(
            buildStructuralEmbeddingText({
              name: tag.name!,
              signature: tag.signature ?? null,
              resolvedTypeSignature: m.resolvedTypeSignature,
              resolvedReturnType: m.resolvedReturnType,
            }),
            tag.rowId,
          );
          break;
        case 'callRef':
          updateCallRef.run(
            m.resolvedTypeSignature,
            m.resolvedReturnType,
            m.definitionUri,
            m.definitionPath,
            m.definitionLine,
            m.definitionCharacter,
            tag.rowId,
          );
          break;
        case 'typeRef':
          updateTypeRef.run(
            m.resolvedTypeSignature,
            m.definitionUri,
            m.definitionPath,
            m.definitionLine,
            m.definitionCharacter,
            tag.rowId,
          );
          break;
        case 'relationship':
          updateRelationship.run(
            m.definitionUri,
            m.definitionPath,
            m.definitionLine,
            m.definitionCharacter,
            tag.rowId,
          );
          break;
      }
    }
  }
}
