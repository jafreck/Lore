import { describe, it, expect } from 'vitest';
import {
  RESOLUTION_METHODS,
  RESOLVED_METHODS,
  UNRESOLVED_METHODS,
  type ResolutionMethod,
} from '../../src/resolution/resolution-method.js';

describe('resolution-method constants', () => {
  it('RESOLUTION_METHODS contains all expected methods', () => {
    const expected = [
      'scip_definition',
      'lsp_definition',
      'name_same_file',
      'name_single_file',
      'name_unique',
      'external_definition',
      'ambiguous_definition',
      'overlay_stale',
      'unresolved',
    ];
    expect([...RESOLUTION_METHODS]).toEqual(expected);
  });

  it('RESOLVED_METHODS contains only high-confidence methods', () => {
    expect(RESOLVED_METHODS.has('scip_definition')).toBe(true);
    expect(RESOLVED_METHODS.has('lsp_definition')).toBe(true);
    expect(RESOLVED_METHODS.has('name_same_file')).toBe(true);
    expect(RESOLVED_METHODS.has('name_single_file')).toBe(true);
    expect(RESOLVED_METHODS.has('name_unique')).toBe(true);
    expect(RESOLVED_METHODS.size).toBe(5);
  });

  it('UNRESOLVED_METHODS contains only unresolved-class methods', () => {
    expect(UNRESOLVED_METHODS.has('external_definition')).toBe(true);
    expect(UNRESOLVED_METHODS.has('ambiguous_definition')).toBe(true);
    expect(UNRESOLVED_METHODS.has('overlay_stale')).toBe(true);
    expect(UNRESOLVED_METHODS.has('unresolved')).toBe(true);
    expect(UNRESOLVED_METHODS.size).toBe(4);
  });

  it('RESOLVED and UNRESOLVED are disjoint', () => {
    for (const m of RESOLVED_METHODS) {
      expect(UNRESOLVED_METHODS.has(m)).toBe(false);
    }
    for (const m of UNRESOLVED_METHODS) {
      expect(RESOLVED_METHODS.has(m as any)).toBe(false);
    }
  });

  it('RESOLVED + UNRESOLVED covers all RESOLUTION_METHODS', () => {
    for (const m of RESOLUTION_METHODS) {
      const inResolved = RESOLVED_METHODS.has(m);
      const inUnresolved = UNRESOLVED_METHODS.has(m);
      expect(inResolved || inUnresolved).toBe(true);
    }
  });

  it('ResolutionMethod type matches array values', () => {
    // Ensure the type is correctly derived from the const array
    const first: ResolutionMethod = RESOLUTION_METHODS[0];
    expect(first).toBe('scip_definition');
  });
});
