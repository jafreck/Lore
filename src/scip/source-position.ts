import {
  PositionEncoding,
  type Document as ScipDocument,
} from './scip_pb.js';

/**
 * Convert every occurrence range in a SCIP document to UTF-16 columns.
 *
 * `sourceEncoding` may differ from `document.positionEncoding` for indexers
 * that omit the protobuf field despite using a documented native encoding.
 * scip-clang 0.4, for example, emits UTF-8 byte offsets with an unspecified
 * position encoding.
 */
export function normalizeScipDocumentPositions(
  document: ScipDocument,
  source: string,
  sourceEncoding: PositionEncoding = document.positionEncoding,
): ScipDocument {
  if (
    sourceEncoding === PositionEncoding.UnspecifiedPositionEncoding
    || sourceEncoding === PositionEncoding.UTF16CodeUnitOffsetFromLineStart
  ) {
    return document;
  }

  // ASCII dominates generated C/C++ indexes, and all SCIP position encodings
  // are identical for ASCII. Preserve the occurrence arrays instead of
  // cloning every occurrence merely to update the document-level encoding.
  if (!/[^\x00-\x7f]/u.test(source)) {
    return {
      ...document,
      positionEncoding: PositionEncoding.UTF16CodeUnitOffsetFromLineStart,
    };
  }

  const converter = new ScipSourcePositionConverter(source);
  return {
    ...document,
    positionEncoding: PositionEncoding.UTF16CodeUnitOffsetFromLineStart,
    occurrences: document.occurrences.map((occurrence) => ({
      ...occurrence,
      range: converter.rangeToUtf16(occurrence.range, sourceEncoding),
      enclosingRange: converter.rangeToUtf16(occurrence.enclosingRange, sourceEncoding),
    })),
  };
}

/**
 * Converts SCIP line/character positions into JavaScript UTF-16 string offsets.
 *
 * SCIP documents may measure characters as UTF-8 bytes, UTF-16 code units, or
 * UTF-32 code points. JavaScript string indexing always uses UTF-16 code units,
 * so source slicing must pass through this converter instead of using SCIP
 * character values directly.
 */
export class ScipSourcePositionConverter {
  private lineStarts: number[] | null = null;

  constructor(private readonly source: string) {}

  /** Start offset of a physical line in the JavaScript source string. */
  lineStart(line: number): number | null {
    if (!Number.isInteger(line) || line < 0) return null;
    const starts = this.getLineStarts();
    return starts[line] ?? null;
  }

  /** End offset of a physical line, excluding CR/LF line terminators. */
  lineEnd(line: number): number | null {
    const start = this.lineStart(line);
    if (start === null) return null;
    const starts = this.getLineStarts();
    let end = line + 1 < starts.length ? starts[line + 1]! - 1 : this.source.length;
    if (end > start && this.source.charCodeAt(end - 1) === 13) end--;
    return end;
  }

  /** Return one physical source line without its line terminator. */
  lineText(line: number): string | null {
    const start = this.lineStart(line);
    const end = this.lineEnd(line);
    return start === null || end === null ? null : this.source.slice(start, end);
  }

  /**
   * Convert a SCIP character offset on `line` to a JavaScript UTF-16 column.
   * Invalid and out-of-range offsets are safely clamped to the source line.
   * Unspecified encoding retains Lore's historical UTF-16 interpretation.
   */
  toUtf16Column(
    line: number,
    character: number,
    encoding: PositionEncoding,
  ): number | null {
    const start = this.lineStart(line);
    const end = this.lineEnd(line);
    if (start === null || end === null) return null;

    const requested = Number.isFinite(character) ? Math.max(0, Math.trunc(character)) : 0;
    const text = this.source.slice(start, end);

    if (encoding === PositionEncoding.UTF8CodeUnitOffsetFromLineStart) {
      return utf8OffsetToUtf16(text, requested);
    }
    if (encoding === PositionEncoding.UTF32CodeUnitOffsetFromLineStart) {
      return utf32OffsetToUtf16(text, requested);
    }

    // UTF-16 and UnspecifiedPositionEncoding. Treating unspecified positions
    // as UTF-16 preserves compatibility with older/precomputed SCIP fixtures.
    return Math.min(requested, text.length);
  }

  /** Convert a SCIP position to an absolute JavaScript string offset. */
  toSourceOffset(
    line: number,
    character: number,
    encoding: PositionEncoding,
  ): number | null {
    const start = this.lineStart(line);
    const column = this.toUtf16Column(line, character, encoding);
    return start === null || column === null ? null : start + column;
  }

  /** Convert a compact SCIP range to UTF-16 character offsets. */
  rangeToUtf16(range: readonly number[], encoding: PositionEncoding): number[] {
    if (range.length === 3) {
      const line = range[0] ?? 0;
      return [
        line,
        this.toUtf16Column(line, range[1] ?? 0, encoding) ?? 0,
        this.toUtf16Column(line, range[2] ?? 0, encoding) ?? 0,
      ];
    }
    if (range.length >= 4) {
      const startLine = range[0] ?? 0;
      const endLine = range[2] ?? startLine;
      return [
        startLine,
        this.toUtf16Column(startLine, range[1] ?? 0, encoding) ?? 0,
        endLine,
        this.toUtf16Column(endLine, range[3] ?? 0, encoding) ?? 0,
      ];
    }
    return [...range];
  }

  /** Slice source text using a compact SCIP range. */
  sliceRange(range: readonly number[], encoding: PositionEncoding): string {
    if (range.length < 3) return '';
    const startLine = range[0] ?? 0;
    const endLine = range.length >= 4 ? (range[2] ?? startLine) : startLine;
    const endCharacter = range.length >= 4 ? (range[3] ?? 0) : (range[2] ?? 0);
    const start = this.toSourceOffset(startLine, range[1] ?? 0, encoding);
    const end = this.toSourceOffset(endLine, endCharacter, encoding);
    if (start === null || end === null || end < start) return '';
    return this.source.slice(start, end);
  }

  private getLineStarts(): number[] {
    if (this.lineStarts) return this.lineStarts;
    const starts = [0];
    for (let i = 0; i < this.source.length; i++) {
      if (this.source.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.lineStarts = starts;
    return starts;
  }
}

function utf8OffsetToUtf16(text: string, requested: number): number {
  let utf8Offset = 0;
  let utf16Offset = 0;
  while (utf16Offset < text.length && utf8Offset < requested) {
    const codePoint = text.codePointAt(utf16Offset)!;
    const utf16Width = codePoint > 0xffff ? 2 : 1;
    const utf8Width = codePoint <= 0x7f ? 1
      : codePoint <= 0x7ff ? 2
        : codePoint <= 0xffff ? 3 : 4;
    if (utf8Offset + utf8Width > requested) break;
    utf8Offset += utf8Width;
    utf16Offset += utf16Width;
  }
  return utf16Offset;
}

function utf32OffsetToUtf16(text: string, requested: number): number {
  let codePoints = 0;
  let utf16Offset = 0;
  while (utf16Offset < text.length && codePoints < requested) {
    const codePoint = text.codePointAt(utf16Offset)!;
    utf16Offset += codePoint > 0xffff ? 2 : 1;
    codePoints++;
  }
  return utf16Offset;
}
