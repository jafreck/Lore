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
  type DocRow,
  type DocSectionRow,
} from '../db.js';

export const toolDef = {
  name: 'lore_docs',
  description:
    'Query indexed documentation. ' +
    'Use action="list" to list docs, action="get" to fetch a document and optional sections, ' +
    'or action="search" to search section/chunk content.',
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
  docs?: DocRow[];
  doc?: DocRow | null;
  sections?: DocSectionRow[];
  results?: DocSectionRow[];
}

export function handler(db: Database.Database, args: DocsArgs): DocsResult {
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
  if (!query) {
    return {
      action: 'search',
      results: [],
      count: 0,
    };
  }

  let results = searchDocSections(db, {
    query,
    path: args.path,
    branch: args.branch,
    kind: args.kind,
    kinds: args.kinds,
    limit: args.limit ?? 20,
  });
  if (args.section_index !== undefined) {
    results = results.filter((section) => section.section_index === args.section_index);
  }

  return {
    action: 'search',
    results,
    count: results.length,
  };
}
