/**
 * @module kb-server/tools/notes
 *
 * MCP tools:
 * - lore_notes_write: upsert notes by (key, scope)
 * - lore_notes_read: retrieve notes with staleness/recency metadata
 */

import Database from 'better-sqlite3';
import type { Database as KbDatabase } from '../db.js';

const DEFAULT_SCOPE = 'global';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export const kbNotesWriteToolDef = {
  name: 'lore_notes_write',
  description:
    'Upsert an LLM-authored note in the knowledge base by key and scope. ' +
    'Defaults scope to "global" and updates updated_at on existing notes.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Topic identifier, e.g. "architecture/overview".' },
      scope: {
        type: 'string',
        description: 'Optional scope (default "global"), e.g. file:<path>, module:<name>.',
      },
      content: { type: 'string', description: 'The note text.' },
      model: { type: 'string', description: 'Model identifier that authored the note.' },
      source_hash: {
        type: 'string',
        description: 'Optional source hash used for staleness detection.',
      },
    },
    required: ['key', 'content'],
  },
} as const;

export const kbNotesReadToolDef = {
  name: 'lore_notes_read',
  description:
    'Read notes by exact key and/or key prefix, optionally filtered by scope. ' +
    'Returns staleness metadata for file-scoped notes and recency metadata for global notes.',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Exact key match.' },
      key_prefix: { type: 'string', description: 'Prefix match (e.g. "architecture/").' },
      scope: { type: 'string', description: 'Optional scope filter.' },
      limit: { type: 'number', description: 'Max notes to return (default 20, max 200).' },
    },
    required: [],
  },
} as const;

export interface NotesWriteArgs {
  key: string;
  scope?: string;
  content: string;
  model?: string;
  source_hash?: string;
}

export interface NotesWriteResult {
  ok: boolean;
  key: string;
  scope: string;
  updated_at: number;
}

interface NoteRow {
  key: string;
  scope: string;
  content: string;
  model: string;
  source_hash: string | null;
  created_at: number;
  updated_at: number;
}

interface FileRecencyRow {
  last_hash: string | null;
  indexed_at: number;
}

export interface NotesReadArgs {
  key?: string;
  key_prefix?: string;
  scope?: string;
  limit?: number;
}

export interface NoteWithMetadata extends NoteRow {
  stale: boolean;
  stale_reason:
    | 'source_hash_mismatch'
    | 'file_missing'
    | 'indexed_after_note'
    | 'kb_reindexed_since_note'
    | null;
  file_last_hash: string | null;
  file_indexed_at: number | null;
  kb_indexed_at: number | null;
}

export interface NotesReadResult {
  notes: NoteWithMetadata[];
  count: number;
}

function normalizeScope(scope?: string): string {
  const normalized = scope?.trim();
  return normalized ? normalized : DEFAULT_SCOPE;
}

function clampLimit(limit?: number): number {
  if (limit == null) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_LIMIT);
}

export function kbNotesWriteHandler(dbPath: string, args: NotesWriteArgs): NotesWriteResult {
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');

    const scope = normalizeScope(args.scope);
    const model = args.model ?? '';
    const sourceHash = args.source_hash ?? null;

    db.prepare(
      `INSERT INTO notes (key, scope, content, model, source_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
       ON CONFLICT(key, scope) DO UPDATE SET
         content = excluded.content,
         model = excluded.model,
         source_hash = excluded.source_hash,
         updated_at = unixepoch()`,
    ).run(args.key, scope, args.content, model, sourceHash);

    const row = db
      .prepare('SELECT updated_at FROM notes WHERE key = ? AND scope = ?')
      .get(args.key, scope) as { updated_at: number };

    return {
      ok: true,
      key: args.key,
      scope,
      updated_at: row.updated_at,
    };
  } finally {
    db.close();
  }
}

export function kbNotesReadHandler(db: KbDatabase.Database, args: NotesReadArgs): NotesReadResult {
  const limit = clampLimit(args.limit);
  const where: string[] = [];
  const params: Array<string | number> = [];

  const key = args.key?.trim();
  if (key) {
    where.push('key = ?');
    params.push(key);
  }

  const keyPrefix = args.key_prefix?.trim();
  if (keyPrefix) {
    where.push('key LIKE ?');
    params.push(`${keyPrefix}%`);
  }

  const scope = args.scope?.trim();
  if (scope) {
    where.push('scope = ?');
    params.push(scope);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT key, scope, content, model, source_hash, created_at, updated_at
       FROM notes
       ${whereSql}
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params, limit) as NoteRow[];

  const kbIndexedAtRow = db
    .prepare('SELECT MAX(indexed_at) AS indexed_at FROM files')
    .get() as { indexed_at: number | null };
  const kbIndexedAt = kbIndexedAtRow.indexed_at;

  const getFileRecency = db.prepare(
    `SELECT last_hash, indexed_at
     FROM files
     WHERE path = ?
     ORDER BY indexed_at DESC
     LIMIT 1`,
  );

  const notes = rows.map((row): NoteWithMetadata => {
    if (row.scope.startsWith('file:')) {
      const filePath = row.scope.slice('file:'.length);
      const fileRow = getFileRecency.get(filePath) as FileRecencyRow | undefined;

      let stale = false;
      let staleReason: NoteWithMetadata['stale_reason'] = null;
      if (!fileRow) {
        stale = true;
        staleReason = 'file_missing';
      } else if (row.source_hash && fileRow.last_hash && row.source_hash !== fileRow.last_hash) {
        stale = true;
        staleReason = 'source_hash_mismatch';
      } else if (fileRow.indexed_at > row.updated_at) {
        stale = true;
        staleReason = 'indexed_after_note';
      }

      return {
        ...row,
        stale,
        stale_reason: staleReason,
        file_last_hash: fileRow?.last_hash ?? null,
        file_indexed_at: fileRow?.indexed_at ?? null,
        kb_indexed_at: null,
      };
    }

    if (row.scope === DEFAULT_SCOPE) {
      const stale = kbIndexedAt != null ? row.updated_at < kbIndexedAt : false;
      return {
        ...row,
        stale,
        stale_reason: stale ? 'kb_reindexed_since_note' : null,
        file_last_hash: null,
        file_indexed_at: null,
        kb_indexed_at: kbIndexedAt,
      };
    }

    return {
      ...row,
      stale: false,
      stale_reason: null,
      file_last_hash: null,
      file_indexed_at: null,
      kb_indexed_at: null,
    };
  });

  return { notes, count: notes.length };
}

export const writeToolDef = kbNotesWriteToolDef;
export const readToolDef = kbNotesReadToolDef;
export const writeHandler = kbNotesWriteHandler;
export const readHandler = kbNotesReadHandler;
