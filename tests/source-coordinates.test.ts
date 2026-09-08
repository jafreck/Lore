import { describe, expect, it } from 'vitest';
import {
  nullableStorageCharacterToPresentation,
  nullableStorageLineToPresentation,
  presentationRangeToStorage,
  presentationPositionToStorage,
  storageRangeToPresentation,
  storagePositionToPresentation,
} from '../src/source-coordinates.js';

describe('source coordinate conversion', () => {
  it('converts both line and UTF-16 character axes between storage and presentation', () => {
    const storage = { line: 2, character: 'é🚀 '.length };
    const presentation = storagePositionToPresentation(storage);

    expect(presentation).toEqual({ line: 3, character: 5 });
    expect(presentationPositionToStorage(presentation)).toEqual(storage);
  });

  it('preserves half-open range endpoints while changing coordinate bases', () => {
    const storage = {
      start: { line: 0, character: 2 },
      end: { line: 3, character: 0 },
    };
    const presentation = storageRangeToPresentation(storage);

    expect(presentation).toEqual({
      start: { line: 1, character: 3 },
      end: { line: 4, character: 1 },
    });
    expect(presentationRangeToStorage(presentation)).toEqual(storage);
  });

  it('preserves missing line and character values', () => {
    expect(nullableStorageLineToPresentation(null)).toBeNull();
    expect(nullableStorageCharacterToPresentation(null)).toBeNull();
  });
});
