/**
 * @module kb-server/tools/architecture
 *
 * MCP tool: return a high-level architecture view grouped by path depth.
 */

import type { Database } from '../db.js';

export const toolDef = {
  name: 'kb_architecture',
  description:
    'Return an architecture overview grouped by path prefix, including component summaries, ' +
    'inter-component edges, entry points, leaf nodes, and external dependency usage.',
  inputSchema: {
    type: 'object',
    properties: {
      depth: {
        type: 'number',
        description: 'Optional path depth used to group files into components (default 2).',
      },
      branch: {
        type: 'string',
        description: 'Optional branch name to filter architecture output.',
      },
    },
    required: [],
  },
} as const;

export interface ArchitectureArgs {
  depth?: number;
  branch?: string;
}

export interface ArchitectureComponent {
  component: string;
  branch: string;
  file_count: number;
  symbol_count: number;
  module_count: number;
}

export interface ArchitectureEdge {
  source_component: string;
  target_component: string;
  branch: string;
  edge_count: number;
}

export interface ArchitectureNode {
  component: string;
  branch: string;
}

export interface ArchitectureExternalDep {
  component: string;
  branch: string;
  package: string;
  file_count: number;
}

export interface ArchitectureResult {
  components: ArchitectureComponent[];
  edges: ArchitectureEdge[];
  entry_points: ArchitectureNode[];
  leaf_nodes: ArchitectureNode[];
  external_deps: ArchitectureExternalDep[];
}

function toComponent(path: string, depth: number): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) {
    return '.';
  }
  return parts.slice(0, depth).join('/');
}

export function handler(db: Database.Database, args: ArchitectureArgs): ArchitectureResult {
  const depth = Math.max(1, Math.floor(args.depth ?? 2));

  const fileRows = (
    args.branch !== undefined
      ? db
          .prepare(
            `SELECT f.id,
                    f.path,
                    f.branch,
                    COUNT(DISTINCT s.id) AS symbol_count,
                    COUNT(DISTINCT m.id) AS module_count
               FROM files f
               LEFT JOIN symbols s ON s.file_id = f.id
               LEFT JOIN file_modules fm ON fm.file_id = f.id
               LEFT JOIN modules m ON m.id = fm.module_id
              WHERE f.branch = ?
              GROUP BY f.id, f.path, f.branch`,
          )
          .all(args.branch)
      : db
          .prepare(
            `SELECT f.id,
                    f.path,
                    f.branch,
                    COUNT(DISTINCT s.id) AS symbol_count,
                    COUNT(DISTINCT m.id) AS module_count
               FROM files f
               LEFT JOIN symbols s ON s.file_id = f.id
               LEFT JOIN file_modules fm ON fm.file_id = f.id
               LEFT JOIN modules m ON m.id = fm.module_id
              GROUP BY f.id, f.path, f.branch`,
          )
          .all()
  ) as Array<{ id: number; path: string; branch: string; symbol_count: number; module_count: number }>;

  const filesById = new Map(fileRows.map((row) => [row.id, row]));
  const componentsMap = new Map<string, ArchitectureComponent>();
  for (const row of fileRows) {
    const component = toComponent(row.path, depth);
    const key = `${row.branch}\u0000${component}`;
    const existing = componentsMap.get(key);
    if (existing !== undefined) {
      existing.file_count += 1;
      existing.symbol_count += row.symbol_count;
      existing.module_count += row.module_count;
      continue;
    }
    componentsMap.set(key, {
      component,
      branch: row.branch,
      file_count: 1,
      symbol_count: row.symbol_count,
      module_count: row.module_count,
    });
  }

  const importRows = (
    args.branch !== undefined
      ? db
          .prepare(
            `SELECT fi.file_id, fi.resolved_id, f_src.branch
               FROM file_imports fi
               JOIN files f_src ON f_src.id = fi.file_id
              WHERE f_src.branch = ?`,
          )
          .all(args.branch)
      : db
          .prepare(
            `SELECT fi.file_id, fi.resolved_id, f_src.branch
               FROM file_imports fi
               JOIN files f_src ON f_src.id = fi.file_id`,
          )
          .all()
  ) as Array<{ file_id: number; resolved_id: number | null; branch: string }>;

  const edgesMap = new Map<string, ArchitectureEdge>();
  const inboundByNode = new Map<string, number>();
  const outboundByNode = new Map<string, number>();
  for (const row of importRows) {
    if (row.resolved_id === null) {
      continue;
    }
    const srcFile = filesById.get(row.file_id);
    const dstFile = filesById.get(row.resolved_id);
    if (srcFile === undefined || dstFile === undefined || srcFile.branch !== dstFile.branch) {
      continue;
    }
    const sourceComponent = toComponent(srcFile.path, depth);
    const targetComponent = toComponent(dstFile.path, depth);
    const edgeKey = `${row.branch}\u0000${sourceComponent}\u0000${targetComponent}`;
    const existing = edgesMap.get(edgeKey);
    if (existing !== undefined) {
      existing.edge_count += 1;
    } else {
      edgesMap.set(edgeKey, {
        source_component: sourceComponent,
        target_component: targetComponent,
        branch: row.branch,
        edge_count: 1,
      });
    }

    const sourceNodeKey = `${row.branch}\u0000${sourceComponent}`;
    const targetNodeKey = `${row.branch}\u0000${targetComponent}`;
    outboundByNode.set(sourceNodeKey, (outboundByNode.get(sourceNodeKey) ?? 0) + 1);
    inboundByNode.set(targetNodeKey, (inboundByNode.get(targetNodeKey) ?? 0) + 1);
  }

  const entryPoints: ArchitectureNode[] = [];
  const leafNodes: ArchitectureNode[] = [];
  for (const component of componentsMap.values()) {
    const nodeKey = `${component.branch}\u0000${component.component}`;
    if ((inboundByNode.get(nodeKey) ?? 0) === 0) {
      entryPoints.push({ branch: component.branch, component: component.component });
    }
    if ((outboundByNode.get(nodeKey) ?? 0) === 0) {
      leafNodes.push({ branch: component.branch, component: component.component });
    }
  }

  const externalDepsRows = (
    args.branch !== undefined
      ? db
          .prepare(
            `SELECT f.path, f.branch, ed.package, COUNT(DISTINCT f.id) AS file_count
               FROM external_deps ed
               JOIN files f ON f.id = ed.file_id
              WHERE f.branch = ?
              GROUP BY f.path, f.branch, ed.package`,
          )
          .all(args.branch)
      : db
          .prepare(
            `SELECT f.path, f.branch, ed.package, COUNT(DISTINCT f.id) AS file_count
               FROM external_deps ed
               JOIN files f ON f.id = ed.file_id
              GROUP BY f.path, f.branch, ed.package`,
          )
          .all()
  ) as Array<{ path: string; branch: string; package: string; file_count: number }>;

  const externalDepsMap = new Map<string, ArchitectureExternalDep>();
  for (const row of externalDepsRows) {
    const component = toComponent(row.path, depth);
    const depKey = `${row.branch}\u0000${component}\u0000${row.package}`;
    const existing = externalDepsMap.get(depKey);
    if (existing !== undefined) {
      existing.file_count += row.file_count;
    } else {
      externalDepsMap.set(depKey, {
        component,
        branch: row.branch,
        package: row.package,
        file_count: row.file_count,
      });
    }
  }

  return {
    components: Array.from(componentsMap.values()),
    edges: Array.from(edgesMap.values()),
    entry_points: entryPoints,
    leaf_nodes: leafNodes,
    external_deps: Array.from(externalDepsMap.values()),
  };
}
