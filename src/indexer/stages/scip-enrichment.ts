/**
 * @module indexer/stages/scip-enrichment
 *
 * Pipeline stage: enrich symbols, symbol_refs, type_refs, and
 * symbol_relationships with SCIP-derived metadata.
 *
 * SCIP enrichment writes to the **same database columns** as LSP
 * enrichment (`definition_path`, `definition_line`, `resolved_type_signature`,
 * etc.) so the downstream resolution stage is agnostic to the data source.
 *
 * ## Pipeline ordering
 *
 * ```
 * ... → DependencyApiStage → ScipEnrichmentStage → LspEnrichmentStage → ResolutionStage → ...
 * ```
 *
 * SCIP runs **before** LSP.  The LSP stage then skips any languages that
 * SCIP already enriched (communicated via `context.scipCoveredLanguages`).
 *
 * ## Data written
 *
 * Identical columns to LSP enrichment — see `lsp-enrichment.ts` for the
 * full list.
 */

import * as fs from 'node:fs';
import type { PipelineContext, PipelineStage } from '../pipeline.js';
import type { Database } from '../../db/schema.js';
import { ScipEnrichmentCoordinator } from '../../scip/enrichment.js';

/**
 * Enriches indexed artefacts with SCIP-derived metadata.
 *
 * Manages the lifecycle of a `ScipEnrichmentCoordinator` per pipeline run.
 */
export class ScipEnrichmentStage implements PipelineStage {
  readonly name = 'scip-enrichment';

  private coordinator: ScipEnrichmentCoordinator | null = null;

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    if (!context.scip?.enabled || context.files.length === 0) return;

    this.coordinator = new ScipEnrichmentCoordinator(context.scip, context.walkerConfig.rootDir);

    // Run SCIP indexers for all languages present in the file list.
    const languages = new Set(context.files.map(f => f.language));
    const coveredLanguages = await this.coordinator.start(languages);

    if (coveredLanguages.size === 0) return;

    // Store which languages SCIP enriched so the LSP stage can skip them.
    context.scipCoveredLanguages = coveredLanguages;

    await enrichProjectRefsWithScip(context.db, context.branch, context.files, this.coordinator, context.sourceCache);
  }

  async dispose(): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.dispose();
      this.coordinator = null;
    }
  }
}

// ─── Enrichment logic (mirrors lsp-enrichment.ts pattern) ─────────────────────

export async function enrichProjectRefsWithScip(
  db: Database.Database,
  branch: string,
  files: Array<{ path: string; language: string }>,
  coordinator: ScipEnrichmentCoordinator,
  sourceCache?: Map<string, string>,
): Promise<void> {

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

  const runInTransaction = db.transaction((updates: Array<() => void>) => {
    for (const fn of updates) fn();
  });

  for (const file of files) {
    if (!file || !fs.existsSync(file.path)) continue;

    // Only process files for languages covered by SCIP.
    if (!coordinator.coveredLanguages.has(file.language)) continue;

    let source: string;
    const cached = sourceCache?.get(file.path);
    if (cached !== undefined) {
      source = cached;
    } else {
      try {
        source = fs.readFileSync(file.path, 'utf8');
      } catch {
        continue;
      }
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

    // SCIP enrichment is synchronous (no network I/O).
    const metadata = coordinator.enrich({
      filePath: file.path,
      language: file.language,
      source,
      targets: tagged.map(t => ({ line: t.line, character: t.character })),
    });

    const updates: Array<() => void> = [];
    for (let i = 0; i < tagged.length; i++) {
      const tag = tagged[i]!;
      const m = metadata[i];
      if (!m) continue;
      switch (tag.table) {
        case 'symbol':
          updates.push(() => {
            updateSymbol.run(
              m.resolvedTypeSignature,
              m.resolvedReturnType,
              m.definitionUri,
              m.definitionPath,
              tag.rowId,
            );
          });
          break;
        case 'callRef':
          updates.push(() => {
            updateCallRef.run(
              m.resolvedTypeSignature,
              m.resolvedReturnType,
              m.definitionUri,
              m.definitionPath,
              m.definitionLine,
              m.definitionCharacter,
              tag.rowId,
            );
          });
          break;
        case 'typeRef':
          updates.push(() => {
            updateTypeRef.run(
              m.resolvedTypeSignature,
              m.definitionUri,
              m.definitionPath,
              m.definitionLine,
              m.definitionCharacter,
              tag.rowId,
            );
          });
          break;
        case 'relationship':
          updates.push(() => {
            updateRelationship.run(
              m.definitionUri,
              m.definitionPath,
              m.definitionLine,
              m.definitionCharacter,
              tag.rowId,
            );
          });
          break;
      }
    }
    if (updates.length > 0) runInTransaction(updates);
  }
}
