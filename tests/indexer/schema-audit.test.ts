/**
 * Schema audit test: ensures that the resolution_method taxonomy in
 * resolution-method.ts matches the values used by writers and readers.
 *
 * Also validates that the public API surface is stable.
 */

import { describe, it, expect } from 'vitest';
import {
  RESOLUTION_METHODS,
  RESOLVED_METHODS,
  UNRESOLVED_METHODS,
  type ResolutionMethod,
} from '../../src/indexer/resolution-method.js';

describe('resolution-method taxonomy', () => {
  it('should define exactly 6 resolution methods', () => {
    expect(RESOLUTION_METHODS).toHaveLength(6);
  });

  it('should contain the canonical method names', () => {
    expect(RESOLUTION_METHODS).toContain('lsp_definition');
    expect(RESOLUTION_METHODS).toContain('name_same_file');
    expect(RESOLUTION_METHODS).toContain('name_unique');
    expect(RESOLUTION_METHODS).toContain('external_definition');
    expect(RESOLUTION_METHODS).toContain('ambiguous_definition');
    expect(RESOLUTION_METHODS).toContain('unresolved');
  });

  it('should partition into resolved and unresolved sets', () => {
    const allMethods = new Set<ResolutionMethod>(RESOLUTION_METHODS);
    const union = new Set([...RESOLVED_METHODS, ...UNRESOLVED_METHODS]);
    expect(union.size).toBe(allMethods.size);
    for (const method of allMethods) {
      expect(union.has(method)).toBe(true);
    }
  });

  it('should have no overlap between resolved and unresolved sets', () => {
    for (const method of RESOLVED_METHODS) {
      expect(UNRESOLVED_METHODS.has(method)).toBe(false);
    }
  });

  it('resolved methods should include the high-confidence tiers', () => {
    expect(RESOLVED_METHODS.has('lsp_definition')).toBe(true);
    expect(RESOLVED_METHODS.has('name_same_file')).toBe(true);
    expect(RESOLVED_METHODS.has('name_unique')).toBe(true);
  });

  it('unresolved methods should include the low-confidence tiers', () => {
    expect(UNRESOLVED_METHODS.has('external_definition')).toBe(true);
    expect(UNRESOLVED_METHODS.has('ambiguous_definition')).toBe(true);
    expect(UNRESOLVED_METHODS.has('unresolved')).toBe(true);
  });
});
