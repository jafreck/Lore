import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  inputSchemaToZodShape,
  type ToolDefinition,
} from '../../src/lore-server/tool-registry.js';

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
  });
});
