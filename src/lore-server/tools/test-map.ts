/**
 * @module lore-server/tools/test-map
 *
 * MCP tool: query mapped tests for a source file.
 */

import type { Database } from '../db.js';
import { listTestMappingsBySourcePath } from '../db.js';

export const toolDef = {
  name: 'lore_test_map',
  description:
    'Return mapped test files (with confidence values) for a given source file path.',
  inputSchema: {
    type: 'object',
    properties: {
      source_path: {
        type: 'string',
        description: 'Source file path to resolve mapped test files for.',
      },
      branch: {
        type: 'string',
        description: 'Optional branch to constrain mappings.',
      },
    },
    required: ['source_path'],
  },
} as const;

export interface TestMapArgs {
  source_path: string;
  branch?: string;
}

export interface TestMapResult {
  source_path: string;
  branch: string | null;
  mappings: Array<{ test_path: string; confidence: string }>;
}

export function handler(db: Database.Database, args: TestMapArgs): TestMapResult {
  return {
    source_path: args.source_path,
    branch: args.branch ?? null,
    mappings: listTestMappingsBySourcePath(db, args.source_path, args.branch),
  };
}
