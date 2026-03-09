/**
 * @module indexer/stages/docs-index
 *
 * Pipeline stage: walk documentation files, chunk by headings, insert into
 * the database, and optionally seed notes from documentation content.
 */

import * as fs from 'node:fs';
import type { PipelineContext, PipelineStage } from '../pipeline.js';
import type { Database } from '../db.js';
import { walkDocumentationFiles } from '../walker.js';
import type { DocumentationFile } from '../docs.js';
import { inferSeededDocNoteKey, buildDocNoteScope } from '../docs.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocumentationRow {
  id: number;
  content_hash: string;
}

interface SeededNoteRow {
  content: string;
  source_hash: string | null;
}

// ─── Stage ────────────────────────────────────────────────────────────────────

/**
 * Walk documentation files, chunk by headings, and persist to the database.
 * Optionally seeds notes from documentation content.
 */
export class DocsIndexStage implements PipelineStage {
  readonly name = 'docs-index';

  async execute(context: PipelineContext, mode: 'build' | 'update'): Promise<void> {
    const docs = await walkDocumentationFiles(context.walkerConfig);
    context.log.indexing('docs walk complete', { docCount: docs.length });

    const { db, branch } = context;

    if (mode === 'build') {
      db.transaction(() => {
        const seenDocPaths = new Set<string>();
        for (const doc of docs) {
          seenDocPaths.add(doc.path);
          processDocumentationFile(db, doc, branch);
          if (context.docsAutoNotes) {
            upsertSeededDocumentationNote(db, doc, branch);
          }
        }
        removeStaleDocumentation(db, branch, seenDocPaths);
      })();
    } else {
      // Update mode: only process docs that are in the changed-file list
      const changedFiles = context.changedFiles ?? [];
      const changedSet = new Set(changedFiles);
      const docsByPath = new Map(docs.map(doc => [doc.path, doc]));

      db.transaction(() => {
        for (const filePath of changedFiles) {
          const changedDoc = docsByPath.get(filePath);
          if (changedDoc) {
            processDocumentationFile(db, changedDoc, branch);
            if (context.docsAutoNotes) upsertSeededDocumentationNote(db, changedDoc, branch);
            context.changedDocPaths.push(filePath);
          } else {
            deleteDocumentationByPath(db, filePath, branch);
          }
        }
      })();
    }
  }
}

// ─── Documentation file processing ───────────────────────────────────────────

export function processDocumentationFile(
  db: Database.Database,
  doc: DocumentationFile,
  branch: string,
): void {
  const existing = db.prepare(
    'SELECT id, content_hash FROM docs WHERE path = ? AND branch = ?',
  ).get(doc.path, branch) as DocumentationRow | undefined;
  if (existing?.content_hash === doc.hash) {
    return;
  }

  let docId: number;
  if (existing) {
    db.prepare(
      `UPDATE docs
       SET kind = ?, title = ?, content = ?, content_hash = ?, indexed_at = unixepoch()
       WHERE id = ?`,
    ).run(doc.kind, doc.title, doc.content, doc.hash, existing.id);
    docId = existing.id;
  } else {
    const info = db.prepare(
      `INSERT INTO docs (path, branch, kind, title, content, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(doc.path, branch, doc.kind, doc.title, doc.content, doc.hash) as {
      lastInsertRowid: number | bigint;
    };
    docId = Number(info.lastInsertRowid);
  }

  const existingSections = db.prepare(
    'SELECT id, section_index FROM doc_sections WHERE doc_id = ?',
  ).all(docId) as Array<{ id: number; section_index: number }>;

  const insertSection = db.prepare(
    `INSERT INTO doc_sections (
       doc_id, section_index, title, depth, heading_path, line_start, line_end, content, content_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_id, section_index) DO UPDATE SET
       title = excluded.title,
       depth = excluded.depth,
       heading_path = excluded.heading_path,
       line_start = excluded.line_start,
       line_end = excluded.line_end,
       content = excluded.content,
       content_hash = excluded.content_hash`,
  );

  const activeSectionIndexes = new Set<number>();
  for (const chunk of doc.chunks) {
    activeSectionIndexes.add(chunk.sectionIndex);
    insertSection.run(
      docId,
      chunk.sectionIndex,
      chunk.title,
      chunk.depth,
      JSON.stringify(chunk.headingPath),
      chunk.lineStart,
      chunk.lineEnd,
      chunk.content,
      chunk.hash,
    );
  }

  const staleSectionIds = existingSections
    .filter(section => !activeSectionIndexes.has(section.section_index))
    .map(section => section.id);
  deleteDocSectionEmbeddings(db, staleSectionIds);
  if (staleSectionIds.length > 0) {
    db.prepare(
      `DELETE FROM doc_sections
       WHERE id IN (${staleSectionIds.map(() => '?').join(', ')})`,
    ).run(...staleSectionIds);
  }
}

export function upsertSeededDocumentationNote(
  db: Database.Database,
  doc: DocumentationFile,
  branch: string,
): void {
  const key = inferSeededDocNoteKey(doc);
  if (!key) return;

  const scope = buildDocNoteScope(doc.path, branch);
  const existing = db.prepare(
    'SELECT content, source_hash FROM notes WHERE key = ? AND scope = ?',
  ).get(key, scope) as SeededNoteRow | undefined;

  if (existing?.content === doc.content && existing.source_hash === doc.hash) {
    return;
  }

  db.prepare(
    `INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
     ON CONFLICT(key, scope) DO UPDATE SET
       content = excluded.content,
       model = excluded.model,
       source_hash = excluded.source_hash,
       updated_at = unixepoch()`,
  ).run(key, scope, doc.content, 'system:auto-doc-seed', doc.hash);
}

export function deleteDocumentationByPath(db: Database.Database, docPath: string, branch: string): void {
  const row = db.prepare('SELECT id FROM docs WHERE path = ? AND branch = ?')
    .get(docPath, branch) as { id: number } | undefined;
  if (!row) return;
  deleteDocumentationById(db, row.id);
}

function removeStaleDocumentation(db: Database.Database, branch: string, retainedPaths: Set<string>): void {
  const docs = db.prepare('SELECT id, path FROM docs WHERE branch = ?').all(branch) as Array<{ id: number; path: string }>;
  for (const doc of docs) {
    if (!retainedPaths.has(doc.path)) {
      deleteDocumentationById(db, doc.id);
    }
  }
}

function deleteDocumentationById(db: Database.Database, docId: number): void {
  const sectionIds = db.prepare('SELECT id FROM doc_sections WHERE doc_id = ?').all(docId) as Array<{ id: number }>;
  deleteDocSectionEmbeddings(db, sectionIds.map(row => row.id));
  db.prepare('DELETE FROM docs WHERE id = ?').run(docId);
}

function deleteDocSectionEmbeddings(db: Database.Database, sectionIds: number[]): void {
  if (sectionIds.length === 0) return;
  const hasEmbeddingsTable = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = 'doc_section_embeddings'",
  ).get() as { present: number } | undefined;
  if (!hasEmbeddingsTable) return;
  db.prepare(
    `DELETE FROM doc_section_embeddings WHERE rowid IN (${sectionIds.map(() => '?').join(', ')})`,
  ).run(...sectionIds);
}
