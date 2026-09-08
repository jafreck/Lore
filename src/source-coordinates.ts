/**
 * Source-coordinate conventions shared by storage and public APIs.
 *
 * SQLite stores zero-based UTF-16 positions so values can be passed directly
 * to LSP clients and compared with normalized SCIP positions. Public Lore APIs
 * present both lines and characters as one-based UTF-16 positions. Keeping the
 * two shapes distinct prevents responses such as a one-based line paired with
 * a zero-based character.
 */

/** Zero-based UTF-16 position persisted in SQLite. */
export interface StoragePosition {
  line: number;
  character: number;
}

/** One-based UTF-16 position returned by public Lore APIs. */
export interface PresentationPosition {
  line: number;
  character: number;
}

/** Half-open range represented in the zero-based storage coordinate system. */
export interface StorageRange {
  start: StoragePosition;
  end: StoragePosition;
}

/** Half-open range represented in the one-based presentation coordinate system. */
export interface PresentationRange {
  start: PresentationPosition;
  end: PresentationPosition;
}

/** Convert a zero-based stored line to a one-based public line. */
export function storageLineToPresentation(line: number): number {
  return line + 1;
}

/** Convert a one-based public line to a zero-based stored line. */
export function presentationLineToStorage(line: number): number {
  return line - 1;
}

/** Convert a zero-based stored UTF-16 character to a one-based public character. */
export function storageCharacterToPresentation(character: number): number {
  return character + 1;
}

/** Convert a one-based public UTF-16 character to a zero-based stored character. */
export function presentationCharacterToStorage(character: number): number {
  return character - 1;
}

/** Convert a nullable stored line while preserving missing coordinates. */
export function nullableStorageLineToPresentation(line: number | null): number | null {
  return line === null ? null : storageLineToPresentation(line);
}

/** Convert a nullable stored character while preserving missing coordinates. */
export function nullableStorageCharacterToPresentation(character: number | null): number | null {
  return character === null ? null : storageCharacterToPresentation(character);
}

/** Convert a complete stored position to its public representation. */
export function storagePositionToPresentation(position: StoragePosition): PresentationPosition {
  return {
    line: storageLineToPresentation(position.line),
    character: storageCharacterToPresentation(position.character),
  };
}

/** Convert a complete public position to its storage representation. */
export function presentationPositionToStorage(position: PresentationPosition): StoragePosition {
  return {
    line: presentationLineToStorage(position.line),
    character: presentationCharacterToStorage(position.character),
  };
}

/** Convert a stored half-open range to its public representation. */
export function storageRangeToPresentation(range: StorageRange): PresentationRange {
  return {
    start: storagePositionToPresentation(range.start),
    end: storagePositionToPresentation(range.end),
  };
}

/** Convert a public half-open range to its storage representation. */
export function presentationRangeToStorage(range: PresentationRange): StorageRange {
  return {
    start: presentationPositionToStorage(range.start),
    end: presentationPositionToStorage(range.end),
  };
}
