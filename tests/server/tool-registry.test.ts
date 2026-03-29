import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../src/db/schema.js';
import { inputSchemaToZodShape, buildToolModules, registerTools, type ToolModule, type ToolDefinition, type ToolDependencies } from '../../src/server/tool-registry.js';
import { z } from 'zod';

// ─── inputSchemaToZodShape ────────────────────────────────────────────────────

describe('inputSchemaToZodShape', () => {
  it('converts string properties', () => {
    const shape = inputSchemaToZodShape({
      type: 'object',
      properties: { name: { type: 'string', description: 'A name' } },
      required: ['name'],
    });
    expect(shape.name).toBeDefined();
    const parsed = z.object(shape).parse({ name: 'hello' });
    expect(parsed.name).toBe('hello');
  });

  it('converts number properties with min/max', () => {
    const shape = inputSchemaToZodShape({
      type: 'object',
      properties: {
        count: { type: 'number', description: 'A count', minimum: 1, maximum: 100 },
      },
      required: ['count'],
    });
    const schema = z.object(shape);
    expect(schema.parse({ count: 50 }).count).toBe(50);
    expect(() => schema.parse({ count: 0 })).toThrow();
    expect(() => schema.parse({ count: 101 })).toThrow();
  });

  it('converts integer properties', () => {
    const shape = inputSchemaToZodShape({
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Limit', minimum: 0 },
      },
      required: ['limit'],
    });
    const schema = z.object(shape);
    expect(schema.parse({ limit: 10 }).limit).toBe(10);
    expect(() => schema.parse({ limit: 1.5 })).toThrow();
  });

  it('converts boolean properties', () => {
    const shape = inputSchemaToZodShape({
      type: 'object',
      properties: { flag: { type: 'boolean' } },
      required: ['flag'],
    });
    expect(z.object(shape).parse({ flag: true }).flag).toBe(true);
  });

  it('converts enum properties', () => {
    const shape = inputSchemaToZodShape({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['a', 'b', 'c'] } },
      required: ['mode'],
    });
    const schema = z.object(shape);
    expect(schema.parse({ mode: 'a' }).mode).toBe('a');
    expect(() => schema.parse({ mode: 'x' })).toThrow();
  });

  it('converts array properties', () => {
    const shape = inputSchemaToZodShape({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['tags'],
    });
    expect(z.object(shape).parse({ tags: ['a', 'b'] }).tags).toEqual(['a', 'b']);
  });

  it('converts number array properties', () => {
    const shape = inputSchemaToZodShape({
      type: 'object',
      properties: {
        vec: { type: 'array', items: { type: 'number' } },
      },
      required: ['vec'],
    });
    expect(z.object(shape).parse({ vec: [1.0, 2.0] }).vec).toEqual([1.0, 2.0]);
  });

  it('makes non-required properties optional', () => {
    const shape = inputSchemaToZodShape({
      type: 'object',
      properties: {
        required_field: { type: 'string' },
        optional_field: { type: 'string' },
      },
      required: ['required_field'],
    });
    const schema = z.object(shape);
    expect(schema.parse({ required_field: 'yes' })).toEqual({ required_field: 'yes' });
    expect(() => schema.parse({})).toThrow();
  });

  it('handles unknown types as z.any()', () => {
    const shape = inputSchemaToZodShape({
      type: 'object',
      properties: {
        mystery: { type: 'unknown_type' as any },
      },
      required: ['mystery'],
    });
    const schema = z.object(shape);
    expect(schema.parse({ mystery: 42 }).mystery).toBe(42);
  });

  it('handles empty properties', () => {
    const shape = inputSchemaToZodShape({
      type: 'object',
      properties: {},
      required: [],
    });
    expect(Object.keys(shape)).toHaveLength(0);
  });
});

// ─── buildToolModules ─────────────────────────────────────────────────────────

describe('buildToolModules', () => {
  it('returns all expected tool modules', async () => {
    const modules = await buildToolModules();
  expect(modules.length).toBeGreaterThanOrEqual(11);

  const names = modules.map((m) => m.def.name);
  expect(names).toContain('lore_lookup');
  expect(names).toContain('lore_graph');
  expect(names).toContain('lore_search');
  expect(names).toContain('lore_snippet');
  expect(names).toContain('lore_blame');
    expect(names).toContain('lore_history');
    expect(names).toContain('lore_trace');
    expect(names).toContain('lore_diff');
    expect(names).toContain('lore_cohesion');
    expect(names).toContain('lore_structure');
    expect(names).toContain('lore_dependents');
  });

  it('each module has def with name, description, and inputSchema', async () => {
    const modules = await buildToolModules();
    for (const mod of modules) {
      expect(mod.def.name.length).toBeGreaterThan(0);
      expect(mod.def.description.length).toBeGreaterThan(0);
      expect(mod.def.inputSchema).toBeDefined();
      expect(mod.def.inputSchema.type).toBe('object');
      expect(mod.def.inputSchema.properties).toBeDefined();
    }
  });

  it('each module has a handlerFactory that returns a function', async () => {
    const modules = await buildToolModules();
    const db = openDb(':memory:');
    try {
      const deps = {
        db,
        dbPath: ':memory:',
        logger: {
          toolCall: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
          close: () => {},
        } as any,
      };
      for (const mod of modules) {
        const handler = mod.handlerFactory(deps);
        expect(typeof handler).toBe('function');
      }
    } finally {
      db.close();
    }
  });
});

// ─── registerTools ────────────────────────────────────────────────────────────

describe('registerTools', () => {
  it('registers tool modules on a mock MCP server', async () => {
    const db = openDb(':memory:');
    const registered: Array<{ name: string; description: string }> = [];
    const mockServer = {
      tool: (name: string, description: string, _zodShape: any, _handler: any) => {
        registered.push({ name, description });
      },
    } as any;

    const testModule: ToolModule = {
      def: {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'test query' },
          },
          required: ['query'],
        },
      },
      handlerFactory: () => async (args: any) => ({ result: args.query }),
    };

    const deps: ToolDependencies = {
      db,
      dbPath: ':memory:',
      logger: {
        toolCall: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        close: () => {},
        indexing: () => {},
      } as any,
    };

    registerTools(mockServer, [testModule], deps);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe('test_tool');
    expect(registered[0]!.description).toBe('A test tool');
    db.close();
  });

  it('loggedHandler wrapper returns JSON content on success', async () => {
    const db = openDb(':memory:');
    const toolCalls: any[] = [];
    const mockServer = {
      tool: (_name: string, _desc: string, _zodShape: any, handler: any) => {
        // Store the wrapped handler so we can call it
        toolCalls.push(handler);
      },
    } as any;

    const testModule: ToolModule = {
      def: {
        name: 'test_logged',
        description: 'Test logged handler',
        inputSchema: {
          type: 'object',
          properties: { msg: { type: 'string' } },
          required: ['msg'],
        },
      },
      handlerFactory: () => async (args: any) => ({ echo: args.msg }),
    };

    const deps: ToolDependencies = {
      db,
      dbPath: ':memory:',
      logger: {
        toolCall: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        close: () => {},
        indexing: () => {},
      } as any,
    };

    registerTools(mockServer, [testModule], deps);
    expect(toolCalls).toHaveLength(1);

    const wrappedHandler = toolCalls[0];
    const result = await wrappedHandler({ msg: 'hello' });
    expect(result.content).toBeDefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.echo).toBe('hello');
    db.close();
  });

  it('loggedHandler wrapper injects freshness metadata', async () => {
    const db = openDb(':memory:');
    const toolCalls: any[] = [];
    const mockServer = {
      tool: (_name: string, _desc: string, _zodShape: any, handler: any) => {
        toolCalls.push(handler);
      },
    } as any;

    const testModule: ToolModule = {
      def: {
        name: 'test_freshness',
        description: 'Test freshness injection',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handlerFactory: () => async () => ({ data: 'test' }),
    };

    const deps: ToolDependencies = {
      db,
      dbPath: ':memory:',
      logger: {
        toolCall: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        close: () => {},
        indexing: () => {},
      } as any,
    };

    registerTools(mockServer, [testModule], deps);
    const result = await toolCalls[0]({});
    const parsed = JSON.parse(result.content[0].text);
    // The handler returns an object, so freshness should be injected
    expect(parsed.data).toBe('test');
    // Freshness should be present as an object with source field
    if (parsed.freshness) {
      expect(typeof parsed.freshness.source).toBe('string');
      expect(typeof parsed.freshness.dirty_file_count).toBe('number');
    }
    db.close();
  });

  it('loggedHandler wrapper propagates errors and logs them', async () => {
    const db = openDb(':memory:');
    const toolCalls: any[] = [];
    const loggedErrors: any[] = [];
    const mockServer = {
      tool: (_name: string, _desc: string, _zodShape: any, handler: any) => {
        toolCalls.push(handler);
      },
    } as any;

    const testModule: ToolModule = {
      def: {
        name: 'test_error',
        description: 'Test error handling',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handlerFactory: () => async () => { throw new Error('boom'); },
    };

    const deps: ToolDependencies = {
      db,
      dbPath: ':memory:',
      logger: {
        toolCall: (entry: any) => { if (entry.status === 'error') loggedErrors.push(entry); },
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        close: () => {},
        indexing: () => {},
      } as any,
    };

    registerTools(mockServer, [testModule], deps);
    await expect(toolCalls[0]({})).rejects.toThrow('boom');
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0].error).toBe('boom');
    db.close();
  });

  it('registers multiple modules at once', async () => {
    const db = openDb(':memory:');
    const registered: string[] = [];
    const mockServer = {
      tool: (name: string) => { registered.push(name); },
    } as any;

    const modules: ToolModule[] = [
      {
        def: { name: 'tool_a', description: 'A', inputSchema: { type: 'object', properties: {} } },
        handlerFactory: () => async () => ({}),
      },
      {
        def: { name: 'tool_b', description: 'B', inputSchema: { type: 'object', properties: {} } },
        handlerFactory: () => async () => ({}),
      },
    ];

    const deps: ToolDependencies = {
      db,
      dbPath: ':memory:',
      logger: { toolCall: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, close: () => {}, indexing: () => {} } as any,
    };

    registerTools(mockServer, modules, deps);
    expect(registered).toEqual(['tool_a', 'tool_b']);
    db.close();
  });
});
