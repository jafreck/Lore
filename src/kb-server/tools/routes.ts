/**
 * @module kb-server/tools/routes
 *
 * MCP tool: query extracted API routes/endpoints.
 */

import type { Database } from '../db.js';
import { listApiRoutes, type ApiRouteRow } from '../db.js';

export const toolDef = {
  name: 'lore_routes',
  description:
    'Query extracted API routes/endpoints from the knowledge-base index. ' +
    'Optional filters: `method`, `path_prefix`, and `framework`.',
  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        description: 'Optional HTTP method filter (for example GET, POST).',
      },
      path_prefix: {
        type: 'string',
        description: 'Optional route path prefix filter.',
      },
      framework: {
        type: 'string',
        description: 'Optional framework filter (for example express, fastapi, gin).',
      },
    },
  },
} as const;

export interface RoutesArgs {
  method?: string;
  path_prefix?: string;
  framework?: string;
}

export interface RoutesResult {
  results: ApiRouteRow[];
}

export function handler(db: Database.Database, args: RoutesArgs): RoutesResult {
  return {
    results: listApiRoutes(db, {
      method: args.method,
      pathPrefix: args.path_prefix,
      framework: args.framework,
    }),
  };
}
