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
import type { Database } from '../../db/schema.js';
import { LspEnrichmentCoordinator } from '../../lsp/enrichment.js';

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
    if (!context.lsp?.enabled || context.files.length === 0) {
      context.sourceCache.clear();
      return;
    }

    // In baseline builds, SCIP is the sole resolution authority.
    // LSP enrichment is only used in overlay mode for cross-file resolution.
    if (context.layer === 'baseline') {
      // Still run for non-SCIP languages in baseline builds (legacy behavior)
      const scipSourced = context.scipSourcedLanguages;
      const scipCovered = context.scipCoveredLanguages;
      const nonScipFiles = context.files.filter(f =>
        !(scipSourced?.has(f.language) || scipCovered?.has(f.language)),
      );
      if (nonScipFiles.length === 0) {
        context.sourceCache.clear();
        return;
      }

      const languages = new Set(nonScipFiles.map(f => f.language));
      if (context.indexDependencies) languages.add('typescript');

      this.coordinator = new LspEnrichmentCoordinator(context.lsp, context.walkerConfig.rootDir);
      await this.coordinator.start(languages);

      if (nonScipFiles.length > 0) {
        await enrichProjectRefs(context.db, context.branch, nonScipFiles, this.coordinator, context.sourceCache);
      }
      // sourceCache is no longer needed — release memory.
      context.sourceCache.clear();
      return;
    }

    const scipSourced = context.scipSourcedLanguages;
    const scipCovered = context.scipCoveredLanguages;

    // Split files into two groups:
    // 1. Non-SCIP files: full enrichment (all symbols, refs, type_refs)
    // 2. SCIP-sourced files: targeted enrichment (only unresolved refs)
    const fullEnrichFiles: Array<{ path: string; language: string }> = [];
    const scipFiles: Array<{ path: string; language: string }> = [];

    for (const f of context.files) {
      if (scipSourced?.has(f.language) || scipCovered?.has(f.language)) {
        scipFiles.push(f);
      } else {
        fullEnrichFiles.push(f);
      }
    }

    if (fullEnrichFiles.length === 0 && scipFiles.length === 0) {
      context.log.indexing('lsp-enrichment: no files to enrich');
      context.sourceCache.clear();
      return;
    }

    // Start language servers for all languages that need enrichment.
    const languages = new Set([
      ...fullEnrichFiles.map(f => f.language),
      ...scipFiles.map(f => f.language),
    ]);
    if (context.indexDependencies) languages.add('typescript');

    this.coordinator = new LspEnrichmentCoordinator(context.lsp, context.walkerConfig.rootDir);
    await this.coordinator.start(languages);

    // Full enrichment for non-SCIP files (all targets).
    if (fullEnrichFiles.length > 0) {
      await enrichProjectRefs(context.db, context.branch, fullEnrichFiles, this.coordinator, context.sourceCache);
    }

    // Targeted enrichment for SCIP-sourced files (only unresolved refs).
    if (scipFiles.length > 0) {
      context.log.indexing('lsp-enrichment: enriching unresolved SCIP refs', {
        files: scipFiles.length,
      });
      await enrichUnresolvedScipRefs(context.db, context.branch, scipFiles, this.coordinator, context.sourceCache);
    }

    // sourceCache is no longer needed — release memory.
    // Later stages (Resolution, TestMap, History, Embedding) are DB-only.
    context.sourceCache.clear();
  }

  async dispose(): Promise<void> {
    if (this.coordinator) {
      await this.coordinator.dispose();
      this.coordinator = null;
    }
  }
}

// ─── Enrichment logic ─────────────────────────────────────────────────────────────────

/**
 * Enrich symbols, call refs, type refs, and relationships for every file in
 * the context with LSP-derived metadata.
 */
export async function enrichProjectRefs(
  db: Database.Database,
  branch: string,
  files: Array<{ path: string; language: string }>,
  coordinator: LspEnrichmentCoordinator,
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

    const metadata = await coordinator.enrich({
      filePath: file.path,
      language: file.language,
      source,
      targets: tagged.map(t => ({ line: t.line, character: t.character })),
    });

    // Batch all per-file writes in a single transaction.
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

// ─── Targeted LSP enrichment for SCIP-sourced files ───────────────────────────

/**
 * For SCIP-sourced files, only enrich refs that are still `unresolved`.
 *
 * SCIP pre-resolves most refs during `ScipIndexerStage`, but some refs
 * (notably member-access calls like `db.prepare(...)`) remain unresolved
 * because SCIP tracks the receiver and method as separate occurrences.
 *
 * LSP can resolve these by querying `textDocument/definition` at the
 * call-site position.  We write `definition_path` / `definition_line`
 * so the downstream resolution stage can map them to a `callee_id`.
 */
async function enrichUnresolvedScipRefs(
  db: Database.Database,
  branch: string,
  files: Array<{ path: string; language: string }>,
  coordinator: LspEnrichmentCoordinator,
  sourceCache?: Map<string, string>,
): Promise<void> {

  // Only select refs that SCIP left unresolved.
  const selectUnresolvedCallRefs = db.prepare(
    `SELECT sr.id, sr.call_line, sr.call_character
     FROM symbol_refs sr
     JOIN symbols s ON s.id = sr.caller_id
     JOIN files f ON f.id = s.file_id
     WHERE f.path = ? AND f.branch = ?
       AND sr.resolution_method = 'unresolved'
       AND sr.definition_path IS NULL
     ORDER BY sr.id`,
  );
  const selectUnresolvedTypeRefs = db.prepare(
    `SELECT tr.id, tr.ref_line, tr.ref_character
     FROM type_refs tr
     JOIN files f ON f.id = tr.file_id
     WHERE f.path = ? AND f.branch = ?
       AND tr.resolution_method = 'unresolved'
       AND tr.definition_path IS NULL
     ORDER BY tr.id`,
  );
  const updateCallRef = db.prepare(
    `UPDATE symbol_refs
     SET resolved_type_signature = ?, resolved_return_type = ?,
         definition_uri = ?, definition_path = ?, definition_line = ?, definition_character = ?,
         resolution_method = 'unresolved'
     WHERE id = ?`,
  );
  const updateTypeRef = db.prepare(
    `UPDATE type_refs
     SET resolved_type_signature = ?,
         definition_uri = ?, definition_path = ?, definition_line = ?, definition_character = ?,
         resolution_method = 'unresolved'
     WHERE id = ?`,
  );

  interface TaggedTarget {
    table: 'callRef' | 'typeRef';
    rowId: number;
    line: number;
    character: number;
  }

  const runInTransaction = db.transaction((updates: Array<() => void>) => {
    for (const fn of updates) fn();
  });

  for (const file of files) {
    if (!file || !fs.existsSync(file.path)) continue;
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

    const callRefs = selectUnresolvedCallRefs.all(file.path, branch) as Array<{
      id: number;
      call_line: number;
      call_character: number | null;
    }>;
    for (const cr of callRefs) {
      tagged.push({ table: 'callRef', rowId: cr.id, line: cr.call_line, character: cr.call_character ?? 0 });
    }

    const typeRefs = selectUnresolvedTypeRefs.all(file.path, branch) as Array<{
      id: number;
      ref_line: number;
      ref_character: number | null;
    }>;
    for (const tr of typeRefs) {
      tagged.push({ table: 'typeRef', rowId: tr.id, line: tr.ref_line, character: tr.ref_character ?? 0 });
    }

    if (tagged.length === 0) continue;

    const metadata = await coordinator.enrich({
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
      }
    }
    if (updates.length > 0) runInTransaction(updates);
  }
}
