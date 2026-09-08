import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import {
  DocumentSchema,
  OccurrenceSchema,
  PositionEncoding,
} from '../../src/scip/scip_pb.js';
import {
  normalizeScipDocumentPositions,
  ScipSourcePositionConverter,
} from '../../src/scip/source-position.js';

describe('ScipSourcePositionConverter', () => {
  const source = 'é🚀 alpha\r\nsecond';
  const converter = new ScipSourcePositionConverter(source);

  it('converts UTF-8 byte offsets containing non-ASCII and non-BMP text', () => {
    expect(converter.toUtf16Column(
      0,
      Buffer.byteLength('é🚀 ', 'utf8'),
      PositionEncoding.UTF8CodeUnitOffsetFromLineStart,
    )).toBe('é🚀 '.length);
    expect(converter.sliceRange(
      [0, 7, 12],
      PositionEncoding.UTF8CodeUnitOffsetFromLineStart,
    )).toBe('alpha');
  });

  it('uses UTF-16 code-unit offsets directly', () => {
    expect(converter.toUtf16Column(
      0,
      4,
      PositionEncoding.UTF16CodeUnitOffsetFromLineStart,
    )).toBe(4);
    expect(converter.sliceRange(
      [0, 4, 9],
      PositionEncoding.UTF16CodeUnitOffsetFromLineStart,
    )).toBe('alpha');
  });

  it('converts UTF-32 code-point offsets containing a non-BMP character', () => {
    expect(converter.toUtf16Column(
      0,
      3,
      PositionEncoding.UTF32CodeUnitOffsetFromLineStart,
    )).toBe(4);
    expect(converter.sliceRange(
      [0, 3, 8],
      PositionEncoding.UTF32CodeUnitOffsetFromLineStart,
    )).toBe('alpha');
  });

  it('treats unspecified legacy positions as UTF-16 and excludes CRLF', () => {
    expect(converter.lineText(0)).toBe('é🚀 alpha');
    expect(converter.lineText(1)).toBe('second');
    expect(converter.sliceRange(
      [0, 4, 9],
      PositionEncoding.UnspecifiedPositionEncoding,
    )).toBe('alpha');
  });

  it('clamps malformed offsets without splitting UTF-8 code points', () => {
    expect(converter.toUtf16Column(
      0,
      1,
      PositionEncoding.UTF8CodeUnitOffsetFromLineStart,
    )).toBe(0);
    expect(converter.toUtf16Column(
      0,
      10_000,
      PositionEncoding.UTF32CodeUnitOffsetFromLineStart,
    )).toBe('é🚀 alpha'.length);
  });

  it('normalizes definition and enclosing ranges from UTF-8 bytes to UTF-16', () => {
    const document = create(DocumentSchema, {
      relativePath: 'unicode.c',
      positionEncoding: PositionEncoding.UnspecifiedPositionEncoding,
      occurrences: [create(OccurrenceSchema, {
        range: [0, 7, 12],
        enclosingRange: [0, 0, 0, 12],
        symbol: 'alpha',
      })],
    });

    const normalized = normalizeScipDocumentPositions(
      document,
      'é🚀 alpha\n',
      PositionEncoding.UTF8CodeUnitOffsetFromLineStart,
    );

    expect(normalized).not.toBe(document);
    expect(normalized.positionEncoding).toBe(PositionEncoding.UTF16CodeUnitOffsetFromLineStart);
    expect(normalized.occurrences[0]?.range).toEqual([0, 4, 9]);
    expect(normalized.occurrences[0]?.enclosingRange).toEqual([0, 0, 0, 9]);
    expect(document.occurrences[0]?.range).toEqual([0, 7, 12]);
  });

  it('reuses occurrence arrays when ASCII makes all position encodings equivalent', () => {
    const document = create(DocumentSchema, {
      relativePath: 'large-generated.c',
      positionEncoding: PositionEncoding.UTF8CodeUnitOffsetFromLineStart,
      occurrences: Array.from({ length: 10_000 }, (_, line) => create(OccurrenceSchema, {
        range: [line, 0, 5],
        symbol: `symbol-${line}`,
      })),
    });

    const normalized = normalizeScipDocumentPositions(
      document,
      Array.from({ length: 10_000 }, () => 'value').join('\n'),
    );

    expect(normalized.positionEncoding).toBe(PositionEncoding.UTF16CodeUnitOffsetFromLineStart);
    expect(normalized.occurrences).toBe(document.occurrences);
  });
});
