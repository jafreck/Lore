import { describe, it, expect } from 'vitest';
import {
  RESOLUTION_METHODS,
  RESOLVED_METHODS,
  UNRESOLVED_METHODS,
} from '../../src/indexer/resolution-method.js';
import type { ResolutionMethod } from '../../src/indexer/resolution-method.js';

describe('resolution-method taxonomy', () => {
  it('should define all seven resolution method values', () => {
    expect(RESOLUTION_METHODS).toEqual([
      'scip_definition',
      'lsp_definition',
      'name_same_file',
      'name_unique',
      'external_definition',
      'ambiguous_definition',
      'unresolved',
    ]);
  });

  it('should have RESOLVED_METHODS that include only successfully resolved tiers', () => {
    expect(RESOLVED_METHODS.has('scip_definition')).toBe(true);
    expect(RESOLVED_METHODS.has('lsp_definition')).toBe(true);
    expect(RESOLVED_METHODS.has('name_same_file')).toBe(true);
    expect(RESOLVED_METHODS.has('name_unique')).toBe(true);
    expect(RESOLVED_METHODS.has('external_definition' as ResolutionMethod)).toBe(false);
    expect(RESOLVED_METHODS.has('unresolved' as ResolutionMethod)).toBe(false);
  });

  it('should have UNRESOLVED_METHODS that include all non-resolved tiers', () => {
    expect(UNRESOLVED_METHODS.has('external_definition')).toBe(true);
    expect(UNRESOLVED_METHODS.has('ambiguous_definition')).toBe(true);
    expect(UNRESOLVED_METHODS.has('unresolved')).toBe(true);
    expect(UNRESOLVED_METHODS.has('lsp_definition' as ResolutionMethod)).toBe(false);
  });

  it('should partition all methods between resolved and unresolved', () => {
    for (const method of RESOLUTION_METHODS) {
      const inResolved = RESOLVED_METHODS.has(method);
      const inUnresolved = UNRESOLVED_METHODS.has(method);
      expect(inResolved || inUnresolved).toBe(true);
      expect(inResolved && inUnresolved).toBe(false);
    }
  });
});
