/**
 * @module lore-server/db/queries/annotations
 *
 * Annotation queries.
 */

import type Database from 'better-sqlite3';
import { annotationsTable, filesTable, symbolsTable } from './helpers.js';
import { storageLineToPresentation } from '../../source-coordinates.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnnotationRow {
  file_path: string;
  line: number;
  kind: string;
  text: string;
  symbol_name: string | null;
  symbol_kind: string | null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Return annotations filtered by kind, with optional path filter and row limit. */
export function listAnnotations(
  db: Database.Database,
  kind: string,
  path?: string,
  limit = 20,
): AnnotationRow[] {
  if (path !== undefined) {
    const rows = db
      .prepare(
        `SELECT f.path AS file_path,
                a.line,
                a.kind,
                a.text,
                s.name AS symbol_name,
                s.kind AS symbol_kind
           FROM ${annotationsTable(db)} a
           JOIN ${filesTable(db)} f ON f.id = a.file_id
      LEFT JOIN ${symbolsTable(db)} s ON s.id = a.symbol_id
          WHERE a.kind = ? AND f.path = ?
          ORDER BY a.line ASC, a.id ASC
          LIMIT ?`,
      )
      .all(kind, path, limit) as AnnotationRow[];
      return rows.map(presentAnnotationRow);
  }

      const rows = db
    .prepare(
      `SELECT f.path AS file_path,
              a.line,
              a.kind,
              a.text,
              s.name AS symbol_name,
              s.kind AS symbol_kind
         FROM ${annotationsTable(db)} a
         JOIN ${filesTable(db)} f ON f.id = a.file_id
    LEFT JOIN ${symbolsTable(db)} s ON s.id = a.symbol_id
        WHERE a.kind = ?
        ORDER BY f.path ASC, a.line ASC, a.id ASC
        LIMIT ?`,
    )
    .all(kind, limit) as AnnotationRow[];
  return rows.map(presentAnnotationRow);
}

function presentAnnotationRow(row: AnnotationRow): AnnotationRow {
  return { ...row, line: storageLineToPresentation(row.line) };
}
