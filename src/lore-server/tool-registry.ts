/**
 * @module lore-server/tool-registry
 *
 * Single-source tool registration. Each MCP tool module exports a `toolDef`
 * (or `writeToolDef` / `readToolDef`) object with its name, description, and
 * JSON-schema.  The registry converts those to Zod schemas and wires them into
 * the `McpServer` automatically — no duplicate Zod definitions in server.ts.
 *
 * ## ToolModule contract
 *
 * Every tool file must export **at least**:
 *   - `toolDef` (or `writeToolDef` / `readToolDef`) containing `name`, `description`, and `inputSchema`
 *   - `handler(db, args, ...)` (or `writeHandler` / `readHandler` for notes)
 *
 * The registry iterates over a list of declared `ToolModule` descriptors and
 * calls `server.tool()` for each, using a standard `loggedHandler` wrapper.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodType } from 'zod';
import type { Database } from './db.js';
import type { EmbeddingProvider } from '../indexer/embedder.js';
import type { LoreLogger } from '../logger.js';
import type { SearchObserver } from './tools/search.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * JSON-schema → Zod bridge.
 *
 * We convert the plain JSON-schema style `inputSchema` that every tool file
 * already declares into Zod objects that `McpServer.tool()` expects.  This is
 * the single authoritative conversion point — server.ts no longer needs its
 * own Zod literals.
 */

/** Shape of a single property in a toolDef.inputSchema. */
interface JsonSchemaProperty {
  type: string;
  enum?: readonly string[];
  description?: string;
  items?: { type: string };
  /** JSON-Schema minimum (inclusive). */
  minimum?: number;
  /** JSON-Schema maximum (inclusive). */
  maximum?: number;
}

/** The fragment of inputSchema that every toolDef carries. */
interface ToolInputSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
}

/** The shape that every tool file exports as `toolDef`. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

/**
 * Descriptor registered with the tool registry.
 *
 * `handlerFactory` is a function that produces the concrete handler from the
 * shared session dependencies (db, dbPath, embedder, etc.).
 */
export interface ToolModule {
  def: ToolDefinition;
  /**
   * Build and return the handler function for this tool.
   * Receives session-level dependencies.
   */
  handlerFactory: (deps: ToolDependencies) => (args: any) => unknown | Promise<unknown>;
}

/** Dependencies that handler factories may draw from. */
export interface ToolDependencies {
  db: Database.Database;
  dbPath: string;
  embedder?: EmbeddingProvider;
  searchObserver?: SearchObserver;
  logger: LoreLogger;
}

// ─── JSON-Schema → Zod conversion ────────────────────────────────────────────

/**
 * Converts a single JSON-schema property definition into the corresponding Zod
 * type.  Handles the subset of JSON-Schema we actually use in tool definitions.
 */
function propertyToZod(prop: JsonSchemaProperty): ZodType {
  if (prop.enum && prop.enum.length > 0) {
    const enumSchema = z.enum(prop.enum as [string, ...string[]]);
    return prop.description ? enumSchema.describe(prop.description) : enumSchema;
  }

  let base: ZodType;
  switch (prop.type) {
    case 'string':
      base = z.string();
      break;
    case 'number': {
      let num = z.number();
      if (prop.minimum !== undefined) num = num.min(prop.minimum);
      if (prop.maximum !== undefined) num = num.max(prop.maximum);
      base = num;
      break;
    }
    case 'integer': {
      let num = z.number().int();
      if (prop.minimum !== undefined) num = num.min(prop.minimum);
      if (prop.maximum !== undefined) num = num.max(prop.maximum);
      base = num;
      break;
    }
    case 'boolean':
      base = z.boolean();
      break;
    case 'array':
      base = z.array(
        prop.items?.type === 'number' ? z.number() : z.string(),
      );
      break;
    default:
      base = z.any();
  }

  return prop.description ? base.describe(prop.description) : base;
}

/**
 * Convert an entire `toolDef.inputSchema` into a Zod shape suitable for
 * passing to `server.tool()`.
 */
export function inputSchemaToZodShape(schema: ToolInputSchema): Record<string, ZodType> {
  const shape: Record<string, ZodType> = {};
  const requiredSet = new Set(schema.required ?? []);

  for (const [key, prop] of Object.entries(schema.properties)) {
    const zodProp = propertyToZod(prop);
    if (!requiredSet.has(key)) {
      // In zod v4, .describe() before .optional() loses the description.
      // We apply .optional() first then re-describe if needed.
      const optProp = zodProp.optional();
      shape[key] = prop.description ? optProp.describe(prop.description) : optProp;
    } else {
      shape[key] = zodProp;
    }
  }

  return shape;
}

// ─── Logged handler wrapper ───────────────────────────────────────────────────

/**
 * Wrap an MCP tool handler with structured logging.
 * Captures request args, response, timing, and success/error status.
 */
function loggedHandler<A>(
  toolName: string,
  fn: (args: A) => unknown | Promise<unknown>,
  log: LoreLogger,
): (args: A) => Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return async (args: A) => {
    const start = performance.now();
    try {
      const result = await fn(args);
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      log.toolCall({
        tool: toolName,
        requestBody: args,
        responseBody: result,
        status: 'success',
        durationMs,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err) {
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.toolCall({
        tool: toolName,
        requestBody: args,
        status: 'error',
        durationMs,
        error: errorMessage,
      });
      throw err;
    }
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

/**
 * Register all tool modules onto the MCP server.
 *
 * This replaces the long hand-coded `server.tool(...)` block in
 * `createLoreMcpServer()` with a data-driven loop.
 */
export function registerTools(
  server: McpServer,
  modules: ToolModule[],
  deps: ToolDependencies,
): void {
  for (const mod of modules) {
    const zodShape = inputSchemaToZodShape(mod.def.inputSchema);
    const handler = mod.handlerFactory(deps);
    server.tool(
      mod.def.name,
      mod.def.description,
      zodShape,
      loggedHandler(mod.def.name, handler, deps.logger),
    );
  }
}

// ─── Tool module declarations (importers) ─────────────────────────────────────

/**
 * Builds the complete list of tool modules to register.
 *
 * Each entry pairs the existing `toolDef` with a handler factory that
 * receives session dependencies.  The handler factory closures mirror the
 * existing `server.ts` call‐sites exactly — this is a lift-and-shift, not a
 * rewrite.
 */
export async function buildToolModules(): Promise<ToolModule[]> {
  // Dynamic imports so the registry can be tree-shaken independently.
  const [
    lookup,
    graph,
    search,
    docsMod,
    routes,
    notes,
    architecture,
    testMap,
    snippet,
    blame,
    metrics,
    coverage,
    writeback,
    history,
    annotationsMod,
  ] = await Promise.all([
    import('./tools/lookup.js'),
    import('./tools/graph.js'),
    import('./tools/search.js'),
    import('./tools/docs.js'),
    import('./tools/routes.js'),
    import('./tools/notes.js'),
    import('./tools/architecture.js'),
    import('./tools/test-map.js'),
    import('./tools/snippet.js'),
    import('./tools/blame.js'),
    import('./tools/metrics.js'),
    import('./tools/coverage.js'),
    import('./tools/writeback.js'),
    import('./tools/history.js'),
    import('./tools/annotations.js'),
  ]);

  return [
    {
      def: lookup.toolDef,
      handlerFactory: (deps) => (args) => lookup.handler(deps.db, args, deps.embedder),
    },
    {
      def: graph.toolDef,
      handlerFactory: (deps) => (args) => graph.handler(deps.db, args),
    },
    {
      def: search.toolDef,
      handlerFactory: (deps) => (args) => search.handler(deps.db, args, deps.embedder, deps.searchObserver),
    },
    {
      def: docsMod.toolDef,
      handlerFactory: (deps) => (args) => docsMod.handler(deps.db, args, deps.embedder),
    },
    {
      def: routes.toolDef,
      handlerFactory: (deps) => (args) => routes.handler(deps.db, args),
    },
    {
      def: notes.writeToolDef,
      handlerFactory: (deps) => (args) => notes.writeHandler(deps.dbPath, args),
    },
    {
      def: notes.readToolDef,
      handlerFactory: (deps) => (args) => notes.readHandler(deps.db, args),
    },
    {
      def: architecture.toolDef,
      handlerFactory: (deps) => (args) => architecture.handler(deps.db, args),
    },
    {
      def: testMap.toolDef,
      handlerFactory: (deps) => (args) => testMap.handler(deps.db, args),
    },
    {
      def: snippet.toolDef,
      handlerFactory: (deps) => (args) => snippet.handler(deps.db, args),
    },
    {
      def: blame.toolDef,
      handlerFactory: (deps) => (args) => blame.handler(deps.db, args),
    },
    {
      def: metrics.toolDef,
      handlerFactory: (deps) => (args) => metrics.handler(deps.db, args ?? {}),
    },
    {
      def: coverage.toolDef,
      handlerFactory: (deps) => (args) => coverage.handler(deps.db, args),
    },
    {
      def: writeback.toolDef,
      handlerFactory: (deps) => (args) => writeback.handler(deps.dbPath, args),
    },
    {
      def: history.toolDef,
      handlerFactory: (deps) => (args) => history.handler(deps.db, args, deps.embedder),
    },
    {
      def: annotationsMod.toolDef,
      handlerFactory: (deps) => (args) => annotationsMod.handler(deps.db, args),
    },
  ];
}
