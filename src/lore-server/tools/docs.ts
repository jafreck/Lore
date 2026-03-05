/**
 * @module lore-server/tools/docs
 *
 * MCP tool: list, fetch, and search indexed documentation.
 */

import type { Database } from '../db.js';
import {
  listDocs,
  getDocByPath,
  listDocSections,
  searchDocSections,
  semanticSearchDocSections,
  type DocRow,
  type DocSectionRow,
  type SemanticDocSectionRow,
} from '../db.js';
import type { EmbeddingProvider } from '../../indexer/embedder.js';

export const toolDef = {
  name: 'lore_docs',
  description:
    'Query indexed documentation. ' +
    'Use action="list" to list docs, action="get" to fetch a document and optional sections, ' +
    'or action="search" to search section/chunk content. ' +
    'For action="search", mode="text" uses LIKE matching, mode="semantic" uses embedding similarity, ' +
    'and mode="fused" combines both.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'search'],
        description: 'Operation to execute.',
      },
      path: {
        type: 'string',
        description: 'Optional doc path filter. Required for precise get/path-scoped search.',
      },
      query: {
        type: 'string',
        description: 'Search query text (used by action="search").',
      },
      mode: {
        type: 'string',
        enum: ['text', 'semantic', 'fused'],
        description: 'Search mode for action="search" (default: "text").',
      },
      kind: {
        type: 'string',
        description: 'Optional single doc kind filter.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of doc kinds to include.',
      },
      include_sections: {
        type: 'boolean',
        description: 'When action="get", include section/chunk rows (default true).',
      },
      section_index: {
        type: 'number',
        description: 'Optional section index filter for get/search results.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of rows to return.',
      },
      branch: {
        type: 'string',
        description: 'Optional branch filter.',
      },
    },
    required: ['action'],
  },
} as const;

export interface DocsArgs {
  action: 'list' | 'get' | 'search';
  path?: string;
  query?: string;
  mode?: 'text' | 'semantic' | 'fused';
  kind?: string;
  kinds?: string[];
  include_sections?: boolean;
  section_index?: number;
  limit?: number;
  branch?: string;
}

export interface DocsResult {
  action: DocsArgs['action'];
  count: number;
  mode_used?: string;
  docs?: DocRow[];
  doc?: DocRow | null;
  sections?: DocSectionRow[];
  results?: DocSectionRow[];
}

function hasVirtualTable(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ? LIMIT 1",
    )
    .get(name) as { present: number } | undefined;
  return row?.present === 1;
}

function filterSectionIndex<T extends DocSectionRow>(
  rows: T[],
  sectionIndex?: number,
): T[] {
  if (sectionIndex === undefined) {
    return rows;
  }
  return rows.filter((row) => row.section_index === sectionIndex);
}

function docSectionKey(row: DocSectionRow): string {
  return `${row.doc_id}:${row.section_index}:${row.id}`;
}

function fuseDocSections(
  textResults: DocSectionRow[],
  semanticResults: SemanticDocSectionRow[],
  limit: number,
): DocSectionRow[] {
  const k = 60;
  const scored = new Map<string, { row: DocSectionRow; score: number }>();

  const addList = (rows: DocSectionRow[]): void => {
    rows.forEach((row, idx) => {
      const key = docSectionKey(row);
      const contribution = 1 / (k + idx + 1);
      const existing = scored.get(key);
      if (existing) {
        existing.score += contribution;
      } else {
        scored.set(key, { row, score: contribution });
      }
    });
  };

  addList(textResults);
  addList(semanticResults);

  return Array.from(scored.values())
    .sort((a, b) =>
      b.score - a.score
      || a.row.doc_path.localeCompare(b.row.doc_path)
      || a.row.doc_branch.localeCompare(b.row.doc_branch)
      || a.row.section_index - b.row.section_index
      || a.row.id - b.row.id)
    .slice(0, limit)
    .map(({ row }) => row);
}

async function semanticDocSearch(
  db: Database.Database,
  args: DocsArgs,
  query: string,
  limit: number,
  embedder: EmbeddingProvider,
): Promise<SemanticDocSectionRow[] | null> {
  if (!hasVirtualTable(db, 'doc_section_embeddings')) {
    return null;
  }

  try {
    const [queryVector] = await embedder.embed([query]);
    if (!queryVector || queryVector.length === 0) {
      return null;
    }

    return semanticSearchDocSections(db, {
      queryVector,
      path: args.path,
      branch: args.branch,
      kind: args.kind,
      kinds: args.kinds,
      limit,
    });
  } catch {
    return null;
  }
}

export async function handler(
  db: Database.Database,
  args: DocsArgs,
  embedder?: EmbeddingProvider,
): Promise<DocsResult> {
  if (args.action === 'list') {
    const docs = listDocs(db, {
      branch: args.branch,
      kind: args.kind,
      kinds: args.kinds,
      limit: args.limit ?? 100,
    });
    return {
      action: 'list',
      docs,
      count: docs.length,
    };
  }

  if (args.action === 'get') {
    const path = args.path?.trim();
    if (!path) {
      return {
        action: 'get',
        doc: null,
        sections: [],
        count: 0,
      };
    }

    const doc = getDocByPath(db, path, args.branch);
    if (!doc) {
      return {
        action: 'get',
        doc: null,
        sections: [],
        count: 0,
      };
    }

    const includeSections = args.include_sections ?? true;
    let sections: DocSectionRow[] = [];
    if (includeSections) {
      sections = listDocSections(db, {
        path: doc.path,
        branch: doc.branch,
        kind: args.kind,
        kinds: args.kinds,
        limit: args.limit ?? 200,
      });
      if (args.section_index !== undefined) {
        sections = sections.filter((section) => section.section_index === args.section_index);
      }
    }

    return {
      action: 'get',
      doc,
      sections,
      count: includeSections ? sections.length : 1,
    };
  }

  const query = args.query?.trim() ?? '';
  const mode = args.mode ?? 'text';
  const limit = args.limit ?? 20;

  if (!query) {
    return {
      action: 'search',
      results: [],
      count: 0,
      mode_used: mode,
    };
  }

  const textResults = filterSectionIndex(searchDocSections(db, {
    query,
    path: args.path,
    branch: args.branch,
    kind: args.kind,
    kinds: args.kinds,
    limit,
  }), args.section_index);

  if (mode === 'text') {
    return {
      action: 'search',
      results: textResults,
      count: textResults.length,
      mode_used: 'text',
    };
  }

  if (!embedder) {
    return {
      action: 'search',
      results: textResults,
      count: textResults.length,
      mode_used: 'text (fallback: no query-time embedder)',
    };
  }

  const semanticResults = await semanticDocSearch(db, args, query, limit, embedder);
  if (!semanticResults) {
    return {
      action: 'search',
      results: textResults,
      count: textResults.length,
      mode_used: 'text (fallback: no embeddings)',
    };
  }
  const filteredSemantic = filterSectionIndex(semanticResults, args.section_index);

  if (mode === 'semantic') {
    return {
      action: 'search',
      results: filteredSemantic,
      count: filteredSemantic.length,
      mode_used: 'semantic',
    };
  }

  const fusedResults = fuseDocSections(textResults, filteredSemantic, limit);
  return {
    action: 'search',
    results: fusedResults,
    count: fusedResults.length,
    mode_used: 'fused',
  };
}
