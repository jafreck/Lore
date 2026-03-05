/**
 * @module lore-server/tools/snippet
 *
 * MCP tool: extract source-code snippets for a given file path and
 * optional line range directly from indexed source snapshots.
 */

import type { Database } from '../db.js';
import { getFileByPath } from '../db.js';

// ─── Tool definition ──────────────────────────────────────────────────────────

export const toolDef = {
  name: 'lore_snippet',
  description:
    'Return source lines from indexed snapshots for a file path recorded in the index. ' +
    'Optionally provide `symbol` to resolve snippet bounds from indexed symbols, or ' +
    'provide `start_line`/`end_line` (1-based, inclusive).',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute file path as stored in the knowledge-base index.',
      },
      start_line: {
        type: 'number',
        description: 'First line to include (1-based, inclusive).  Defaults to 1.',
      },
      end_line: {
        type: 'number',
        description: 'Last line to include (1-based, inclusive).  Defaults to end-of-file.',
      },
      symbol: {
        type: 'string',
        description: 'Optional symbol name to resolve snippet bounds from indexed symbol metadata.',
      },
      branch: {
        type: 'string',
        description: 'Optional branch to disambiguate the file path.',
      },
    },
    required: ['path'],
  },
} as const;

// ─── Handler ──────────────────────────────────────────────────────────────────

export interface SnippetArgs {
  path: string;
  start_line?: number;
  end_line?: number;
  symbol?: string;
  branch?: string;
}

export interface SnippetContainingSymbol {
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
}

export interface SnippetResult {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  containing_symbol?: SnippetContainingSymbol;
}

interface SourceRow {
  source: string;
}

interface SymbolBounds {
  start_line: number;
  end_line: number;
}

function getIndexedSource(db: Database.Database, fileId: number, path: string): string {
  const row = db.prepare('SELECT source FROM files WHERE id = ?').get(fileId) as SourceRow | undefined;
  if (!row) {
    throw new Error(`File not found in index: ${path}`);
  }
  return row.source;
}

function resolveSymbolBounds(
  db: Database.Database,
  fileId: number,
  path: string,
  symbol: string,
): SymbolBounds {
  const matches = db
    .prepare(
      'SELECT start_line, end_line FROM symbols WHERE file_id = ? AND name = ? COLLATE NOCASE ORDER BY start_line ASC, end_line ASC',
    )
    .all(fileId, symbol) as SymbolBounds[];

  if (matches.length === 0) {
    throw new Error(`Symbol not found in indexed file: ${symbol} (${path})`);
  }
  if (matches.length > 1) {
    throw new Error(`Symbol is ambiguous in indexed file: ${symbol} (${path})`);
  }
  const [match] = matches;
  if (!match) {
    throw new Error(`Symbol not found in indexed file: ${symbol} (${path})`);
  }
  return match;
}

function findContainingSymbol(
  db: Database.Database,
  fileId: number,
  startLine: number,
  endLine: number,
): SnippetContainingSymbol | undefined {
  return db
    .prepare(
      `SELECT name, kind, start_line, end_line
         FROM symbols
        WHERE file_id = ?
          AND start_line <= ?
          AND end_line >= ?
        ORDER BY (end_line - start_line) ASC, start_line DESC
        LIMIT 1`,
    )
    .get(fileId, startLine, endLine) as SnippetContainingSymbol | undefined;
}

/** Read source lines from indexed source snapshots for the given indexed file path. */
export function handler(db: Database.Database, args: SnippetArgs): SnippetResult {
  // Confirm the path is known to the index; use branch to disambiguate if provided.
  const fileRow = getFileByPath(db, args.path, args.branch);
  if (!fileRow) {
    throw new Error(`File not found in index: ${args.path}`);
  }

  if (args.symbol !== undefined && (args.start_line !== undefined || args.end_line !== undefined)) {
    throw new Error('Provide either `symbol` or `start_line`/`end_line`, not both.');
  }

  const raw = getIndexedSource(db, fileRow.id, args.path);
  const lines = raw.split('\n');
  const lineCount = lines.length;

  let startLine: number;
  let endLine: number;

  if (args.symbol !== undefined) {
    const symbolName = args.symbol.trim();
    if (symbolName.length === 0) {
      throw new Error('`symbol` must be a non-empty string.');
    }
    const bounds = resolveSymbolBounds(db, fileRow.id, args.path, symbolName);
    startLine = Math.min(lineCount, Math.max(1, Math.floor(bounds.start_line)));
    endLine = Math.min(lineCount, Math.max(startLine, Math.floor(bounds.end_line)));
  } else {
    startLine = Math.min(lineCount, Math.max(1, Math.floor(args.start_line ?? 1)));
    endLine = Math.min(lineCount, Math.max(startLine, Math.floor(args.end_line ?? lineCount)));
  }

  const text = lines.slice(startLine - 1, endLine).join('\n');
  const containingSymbol = findContainingSymbol(db, fileRow.id, startLine, endLine);

  if (containingSymbol) {
    return {
      path: args.path,
      start_line: startLine,
      end_line: endLine,
      text,
      containing_symbol: containingSymbol,
    };
  }

  return { path: args.path, start_line: startLine, end_line: endLine, text };
}
