/**
 * @module lore-server/tools/annotations
 *
 * MCP tool: return indexed source-code annotations by kind.
 */

import type { Database } from '../db.js';
import { listAnnotations } from '../db.js';

export const toolDef = {
  name: 'lore_annotations',
  description:
    'Return indexed annotations (TODO/FIXME/etc.) by kind, with optional file path filter and result limit.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['TODO', 'FIXME', 'HACK', 'XXX', 'NOTE', 'BUG', 'OPTIMIZE'],
        description: 'Annotation kind/tag to filter by.',
      },
      path: {
        type: 'string',
        description: 'Optional exact file path filter.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default 20).',
      },
    },
    required: ['kind'],
  },
} as const;

export interface AnnotationsArgs {
  kind: 'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'NOTE' | 'BUG' | 'OPTIMIZE';
  path?: string;
  limit?: number;
}

export interface AnnotationsResult {
  results: ReturnType<typeof listAnnotations>;
}

export function handler(db: Database.Database, args: AnnotationsArgs): AnnotationsResult {
  return {
    results: listAnnotations(db, args.kind, args.path, args.limit ?? 20),
  };
}
