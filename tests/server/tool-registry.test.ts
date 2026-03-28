import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../src/db/schema.js';
import { inputSchemaToZodShape, buildToolModules, type ToolModule, type ToolDefinition } from '../../src/server/tool-registry.js';
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
    expect(modules.length).toBeGreaterThanOrEqual(12);

    const names = modules.map((m) => m.def.name);
    expect(names).toContain('lore_lookup');
    expect(names).toContain('lore_graph');
    expect(names).toContain('lore_search');
    expect(names).toContain('lore_snippet');
    expect(names).toContain('lore_blame');
    expect(names).toContain('lore_metrics');
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
      expect(mod.def.name).toBeTruthy();
      expect(mod.def.description).toBeTruthy();
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
