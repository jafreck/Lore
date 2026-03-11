import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  inputSchemaToZodShape,
  registerTools,
  buildToolModules,
  type ToolDefinition,
  type ToolModule,
  type ToolDependencies,
} from '../../src/server/tool-registry.js';

describe('tool-registry', () => {
  describe('inputSchemaToZodShape', () => {
    it('should convert string properties', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'The name' },
        },
        required: ['name'],
      };
      const shape = inputSchemaToZodShape(schema);
      expect(shape.name).toBeDefined();

      const result = shape.name!.safeParse('hello');
      expect(result.success).toBe(true);

      const failResult = shape.name!.safeParse(123);
      expect(failResult.success).toBe(false);
    });

    it('should convert enum properties', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          mode: { type: 'string', enum: ['a', 'b', 'c'] as const, description: 'Mode' },
        },
        required: ['mode'],
      };
      const shape = inputSchemaToZodShape(schema);
      expect(shape.mode!.safeParse('a').success).toBe(true);
      expect(shape.mode!.safeParse('d').success).toBe(false);
    });

    it('should convert integer properties with minimum', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          limit: { type: 'integer', minimum: 0, description: 'Max results' },
        },
      };
      const shape = inputSchemaToZodShape(schema);
      expect(shape.limit!.safeParse(10).success).toBe(true);
      expect(shape.limit!.safeParse(-1).success).toBe(false);
      expect(shape.limit!.safeParse(1.5).success).toBe(false);
    });

    it('should convert number properties', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          score: { type: 'number', description: 'Relevance score' },
        },
      };
      const shape = inputSchemaToZodShape(schema);
      expect(shape.score!.safeParse(3.14).success).toBe(true);
      expect(shape.score!.safeParse('abc').success).toBe(false);
    });

    it('should make non-required properties optional', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Required' },
          age: { type: 'number', description: 'Optional' },
        },
        required: ['name'] as const,
      };
      const shape = inputSchemaToZodShape(schema);
      // Optional field should accept undefined
      expect(shape.age!.safeParse(undefined).success).toBe(true);
      // Required field should reject undefined
      expect(shape.name!.safeParse(undefined).success).toBe(false);
    });

    it('should convert boolean properties', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          enabled: { type: 'boolean', description: 'Enable feature' },
        },
      };
      const shape = inputSchemaToZodShape(schema);
      expect(shape.enabled!.safeParse(true).success).toBe(true);
      expect(shape.enabled!.safeParse('yes').success).toBe(false);
    });

    it('should convert array properties', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
          scores: { type: 'array', items: { type: 'number' }, description: 'Scores' },
        },
      };
      const shape = inputSchemaToZodShape(schema);
      expect(shape.tags!.safeParse(['a', 'b']).success).toBe(true);
      expect(shape.scores!.safeParse([1, 2, 3]).success).toBe(true);
    });

    it('should preserve descriptions on optional properties', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          branch: { type: 'string', description: 'Optional branch filter' },
        },
      };
      const shape = inputSchemaToZodShape(schema);
      // In Zod v4, optional().describe() preserves description
      expect(shape.branch).toBeDefined();
      expect((shape.branch as any).description).toBe('Optional branch filter');
    });

    it('should handle number properties with min and max', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          score: { type: 'number', minimum: 0, maximum: 1, description: 'Score between 0-1' },
        },
        required: ['score'] as const,
      };
      const shape = inputSchemaToZodShape(schema);
      expect(shape.score!.safeParse(0.5).success).toBe(true);
      expect(shape.score!.safeParse(-0.1).success).toBe(false);
      expect(shape.score!.safeParse(1.1).success).toBe(false);
    });

    it('should handle integer properties with max', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 100, description: 'Count' },
        },
        required: ['count'] as const,
      };
      const shape = inputSchemaToZodShape(schema);
      expect(shape.count!.safeParse(50).success).toBe(true);
      expect(shape.count!.safeParse(101).success).toBe(false);
    });

    it('should fall back to z.any() for unknown types', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          data: { type: 'unknown_type' as any, description: 'Arbitrary data' },
        },
      };
      const shape = inputSchemaToZodShape(schema);
      expect(shape.data!.safeParse('anything').success).toBe(true);
      expect(shape.data!.safeParse(42).success).toBe(true);
    });

    it('should handle enum without description', () => {
      const schema = {
        type: 'object' as const,
        properties: {
          mode: { type: 'string', enum: ['a', 'b'] as const },
        },
      };
      const shape = inputSchemaToZodShape(schema);
      expect(shape.mode!.safeParse('a').success).toBe(true);
      expect(shape.mode!.safeParse('c').success).toBe(false);
    });
  });

  describe('registerTools', () => {
    it('should register all provided tool modules on the server', () => {
      const mockServer = { tool: vi.fn() };
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        toolCall: vi.fn(),
        startup: vi.fn(),
        indexing: vi.fn(),
      };
      const deps: ToolDependencies = {
        db: {} as any,
        dbPath: '/tmp/test.db',
        logger: mockLogger as any,
      };
      const modules: ToolModule[] = [
        {
          def: {
            name: 'test_tool',
            description: 'A test tool',
            inputSchema: {
              type: 'object',
              properties: { name: { type: 'string', description: 'Name' } },
              required: ['name'],
            },
          },
          handlerFactory: () => (args: any) => ({ result: args.name }),
        },
      ];

      registerTools(mockServer as any, modules, deps);

      expect(mockServer.tool).toHaveBeenCalledTimes(1);
      expect(mockServer.tool.mock.calls[0][0]).toBe('test_tool');
      expect(mockServer.tool.mock.calls[0][1]).toBe('A test tool');
    });

    it('should wrap handlers with logging that logs success', async () => {
      const mockServer = { tool: vi.fn() };
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        toolCall: vi.fn(),
        startup: vi.fn(),
        indexing: vi.fn(),
      };
      const deps: ToolDependencies = {
        db: {} as any,
        dbPath: '/tmp/test.db',
        logger: mockLogger as any,
      };
      const modules: ToolModule[] = [
        {
          def: {
            name: 'test_tool',
            description: 'A test tool',
            inputSchema: { type: 'object', properties: {}, required: [] },
          },
          handlerFactory: () => () => ({ answer: 42 }),
        },
      ];

      registerTools(mockServer as any, modules, deps);

      const registeredHandler = mockServer.tool.mock.calls[0][3] as (args: any) => Promise<any>;
      const result = await registeredHandler({});

      expect(result).toEqual({ content: [{ type: 'text', text: '{"answer":42}' }] });
      expect(mockLogger.toolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'test_tool',
          status: 'success',
        }),
      );
    });

    it('should wrap handlers with logging that logs errors and re-throws', async () => {
      const mockServer = { tool: vi.fn() };
      const mockLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        toolCall: vi.fn(),
        startup: vi.fn(),
        indexing: vi.fn(),
      };
      const deps: ToolDependencies = {
        db: {} as any,
        dbPath: '/tmp/test.db',
        logger: mockLogger as any,
      };
      const modules: ToolModule[] = [
        {
          def: {
            name: 'fail_tool',
            description: 'A tool that fails',
            inputSchema: { type: 'object', properties: {}, required: [] },
          },
          handlerFactory: () => () => { throw new Error('boom'); },
        },
      ];

      registerTools(mockServer as any, modules, deps);

      const registeredHandler = mockServer.tool.mock.calls[0][3] as (args: any) => Promise<any>;
      await expect(registeredHandler({})).rejects.toThrow('boom');
      expect(mockLogger.toolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'fail_tool',
          status: 'error',
          error: 'boom',
        }),
      );
    });
  });

  describe('buildToolModules', () => {
    it('should return an array of tool modules with expected tool names', async () => {
      const modules = await buildToolModules();
      expect(modules.length).toBeGreaterThan(10);
      const names = modules.map(m => m.def.name);
      expect(names).toContain('lore_lookup');
      expect(names).toContain('lore_graph');
      expect(names).toContain('lore_analyze');
      expect(names).toContain('lore_search');
      expect(names).toContain('lore_docs');
      expect(names).toContain('lore_routes');
      expect(names).toContain('lore_notes_write');
      expect(names).toContain('lore_notes_read');
      expect(names).toContain('lore_architecture');
      expect(names).toContain('lore_snippet');
      expect(names).toContain('lore_blame');
      expect(names).toContain('lore_metrics');
      expect(names).toContain('lore_coverage');
      expect(names).toContain('lore_writeback');
      expect(names).toContain('lore_history');
      expect(names).toContain('lore_annotations');
    });

    it('should return modules with callable handlerFactory', async () => {
      const modules = await buildToolModules();
      for (const mod of modules) {
        expect(typeof mod.handlerFactory).toBe('function');
        expect(typeof mod.def.name).toBe('string');
        expect(typeof mod.def.description).toBe('string');
        expect(mod.def.inputSchema.type).toBe('object');
      }
    });
  });
});
