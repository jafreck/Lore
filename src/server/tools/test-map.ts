/**
 * @module lore-server/tools/test-map
 *
 * MCP tool: query mapped tests for a source file.
 */

import type { Database } from '../../db/read-only.js';
import { listTestMappingsBySourcePath, listTestsByLine } from '../../db/read-only.js';

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
      line: {
        type: 'number',
        description:
          'Optional source line number. When provided, returns per-test coverage mappings for that line.',
      },
    },
    required: ['source_path'],
  },
} as const;

export interface TestMapArgs {
  source_path: string;
  branch?: string;
  line?: number;
}

export interface TestMapResult {
  source_path: string;
  branch: string | null;
  mappings: Array<{
    test_path: string;
    confidence: string;
    line?: number;
    test_name?: string | null;
  }>;
}

export function handler(db: Database.Database, args: TestMapArgs): TestMapResult {
  if (args.line != null) {
    const rows = listTestsByLine(db, args.source_path, args.line);
    return {
      source_path: args.source_path,
      branch: args.branch ?? null,
      mappings: rows.map((r) => ({
        test_path: r.test_file,
        confidence: 'per_test_coverage' as const,
        line: args.line,
        test_name: r.test_name,
      })),
    };
  }

  return {
    source_path: args.source_path,
    branch: args.branch ?? null,
    mappings: listTestMappingsBySourcePath(db, args.source_path, args.branch),
  };
}
