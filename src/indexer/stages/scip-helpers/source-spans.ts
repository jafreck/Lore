/**
 * Source-level span recovery for SCIP indexers that omit
 * `Occurrence.enclosing_range` (notably scip-clang).
 *
 * Recovery is deliberately lazy and bounded. It scans only after a missing
 * span is encountered, never allocates a masked copy of the source file, and
 * stops at configurable character/line limits.
 */

import { PositionEncoding } from '../../../scip/scip_pb.js';
import { ScipSourcePositionConverter } from '../../../scip/source-position.js';

export interface SourceSpan {
  startLine: number;
  endLine: number;
  /** Half-open UTF-16 column on endLine. */
  endCharacter: number;
}

export interface CSourceScanLimits {
  maxCharacters: number;
  maxLines: number;
  maxMacroLines: number;
}

export const DEFAULT_C_SOURCE_SCAN_LIMITS: Readonly<CSourceScanLimits> = Object.freeze({
  maxCharacters: 1_048_576,
  maxLines: 20_000,
  maxMacroLines: 4_096,
});

export class CSourceSpanResolver {
  private readonly positions: ScipSourcePositionConverter;
  private readonly limits: CSourceScanLimits;

  constructor(
    private readonly source: string,
    private readonly positionEncoding: PositionEncoding = PositionEncoding.UnspecifiedPositionEncoding,
    limits: Partial<CSourceScanLimits> = {},
  ) {
    this.positions = new ScipSourcePositionConverter(source);
    this.limits = { ...DEFAULT_C_SOURCE_SCAN_LIMITS, ...limits };
  }

  /**
   * Recover the body span for a function, method, class, struct, or enum.
   * Returns `null` for declarations/prototypes or scans exceeding the bounds.
   */
  findBraceDelimitedSpan(
    definitionLine: number,
    definitionCharacter = 0,
    kind = '',
  ): SourceSpan | null {
    const startOffset = this.positions.toSourceOffset(
      definitionLine,
      definitionCharacter,
      this.positionEncoding,
    );
    if (startOffset === null) return null;

    const lineLimit = this.positions.lineStart(definitionLine + this.limits.maxLines);
    const scanEnd = Math.min(
      this.source.length,
      startOffset + this.limits.maxCharacters,
      lineLimit ?? this.source.length,
    );
    const bodyStart = this.findBodyStart(startOffset, scanEnd, kind === 'constructor');
    if (bodyStart === null) return null;

    const bodyEnd = findMatchingBrace(this.source, bodyStart, scanEnd);
    if (bodyEnd === null) return null;
    const endLine = offsetToLine(this.positions, definitionLine, bodyEnd);
    const endLineStart = this.positions.lineStart(endLine);
    if (endLineStart === null) return null;
    return {
      startLine: definitionLine,
      endLine,
      endCharacter: bodyEnd - endLineStart + 1,
    };
  }

  /** Return the last physical line in a bounded backslash-continued macro. */
  findMacroSpan(definitionLine: number): SourceSpan {
    const startLine = Math.max(0, definitionLine);
    const startOffset = this.positions.lineStart(startLine);
    if (startOffset === null) return { startLine, endLine: startLine, endCharacter: 0 };

    let endLine = startLine;
    for (let count = 0; count < this.limits.maxMacroLines; count++) {
      const line = this.positions.lineText(endLine);
      if (line === null || !/\\[ \t]*$/u.test(line)) break;
      const nextStart = this.positions.lineStart(endLine + 1);
      if (nextStart === null || nextStart - startOffset > this.limits.maxCharacters) break;
      endLine++;
    }
    return {
      startLine,
      endLine,
      endCharacter: this.positions.lineText(endLine)?.length ?? 0,
    };
  }

  /** Slice a SCIP range using this document's declared position encoding. */
  sliceRange(range: readonly number[]): string {
    return this.positions.sliceRange(range, this.positionEncoding);
  }

  findFunctionDeclarationSpan(line: number, character: number): SourceSpan | null {
    const startOffset = this.positions.toSourceOffset(line, character, this.positionEncoding);
    const lineStart = this.positions.lineStart(line);
    if (startOffset === null || lineStart === null || startOffset - lineStart > this.limits.maxCharacters) return null;
    let prefix = '';
    for (let cursor = lineStart; cursor < startOffset;) {
      const skipped = skipNonStructural(this.source, cursor, startOffset);
      if (skipped !== cursor) {
        prefix += ' ';
        cursor = skipped;
      } else {
        prefix += this.source[cursor]!;
        cursor++;
      }
    }
    prefix = prefix.trim();
    if (!/^[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*|\s*\*)*\s*$/u.test(prefix)
      || /\b(?:return|throw|co_return|co_await|goto|case|else|do|typedef|new|delete|sizeof|alignof|_Alignof|__alignof__)\b/u.test(prefix)) return null;
    const identifier = /^[A-Za-z_]\w*/u.exec(this.source.slice(startOffset));
    if (!identifier) return null;
    const scanEnd = Math.min(this.source.length, startOffset + this.limits.maxCharacters,
      this.positions.lineStart(line + this.limits.maxLines) ?? this.source.length);
    let parenDepth = 0;
    let sawParameters = false;
    for (let cursor = startOffset + identifier[0].length; cursor < scanEnd;) {
      const skipped = skipNonStructural(this.source, cursor, scanEnd);
      if (skipped !== cursor) {
        cursor = skipped;
        continue;
      }
      const token = this.source[cursor]!;
      if (isWhitespace(token)) { cursor++; continue; }
      if (token === '(' && !sawParameters) parenDepth++;
      else if (token === ')' && parenDepth > 0) {
        parenDepth--;
        if (parenDepth === 0) sawParameters = true;
      } else if (token === ';' && sawParameters) {
        const endLine = offsetToLine(this.positions, line, cursor);
        return { startLine: line, endLine, endCharacter: cursor - this.positions.lineStart(endLine)! + 1 };
      } else if (parenDepth === 0 || token === '{' || token === '}') return null;
      cursor++;
    }
    return null;
  }

  private findBodyStart(startOffset: number, scanEnd: number, constructor: boolean): number | null {
    let parenDepth = 0;
    let bracketDepth = 0;
    let sawParameterList = false;
    let inConstructorInitializers = false;
    let initializerDesignatorSeen = false;
    let initializerParen = false;

    for (let i = startOffset; i < scanEnd;) {
      const skippedTo = skipNonStructural(this.source, i, scanEnd);
      if (skippedTo !== i) {
        i = skippedTo;
        continue;
      }

      const ch = this.source[i]!;
      const atTopLevel = parenDepth === 0 && bracketDepth === 0;

      if (ch === '(') {
        if (constructor && inConstructorInitializers && atTopLevel && initializerDesignatorSeen) {
          initializerParen = true;
        }
        parenDepth++;
      } else if (ch === ')') {
        if (parenDepth > 0) {
          parenDepth--;
          if (parenDepth === 0) {
            if (initializerParen) {
              initializerParen = false;
              initializerDesignatorSeen = false;
            } else {
              sawParameterList = true;
            }
          }
        }
      } else if (ch === '[') {
        bracketDepth++;
      } else if (ch === ']') {
        if (bracketDepth > 0) bracketDepth--;
      } else if (atTopLevel && ch === ';') {
        return null;
      } else if (
        constructor && atTopLevel && ch === ':' && sawParameterList
        && this.source[i - 1] !== ':' && this.source[i + 1] !== ':'
      ) {
        inConstructorInitializers = true;
        initializerDesignatorSeen = false;
      } else if (constructor && inConstructorInitializers && atTopLevel && ch === ',') {
        initializerDesignatorSeen = false;
      } else if (atTopLevel && ch === '{') {
        if (constructor && inConstructorInitializers && initializerDesignatorSeen) {
          const initializerEnd = findMatchingBrace(this.source, i, scanEnd);
          if (initializerEnd === null) return null;
          initializerDesignatorSeen = false;
          i = initializerEnd + 1;
          continue;
        }
        return i;
      } else if (
        constructor && inConstructorInitializers && atTopLevel
        && !isWhitespace(ch)
      ) {
        initializerDesignatorSeen = true;
      }

      i++;
    }
    return null;
  }
}

function offsetToLine(
  positions: ScipSourcePositionConverter,
  minimumLine: number,
  offset: number,
): number {
  let low = Math.max(0, minimumLine);
  let high = low + 1;
  while (positions.lineStart(high) !== null && positions.lineStart(high)! <= offset) {
    low = high;
    high *= 2;
  }
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    const start = positions.lineStart(mid);
    if (start !== null && start <= offset) low = mid;
    else high = mid;
  }
  return low;
}

function findMatchingBrace(source: string, openingBrace: number, scanEnd: number): number | null {
  let depth = 0;
  for (let i = openingBrace; i < scanEnd;) {
    const skippedTo = skipNonStructural(source, i, scanEnd);
    if (skippedTo !== i) {
      i = skippedTo;
      continue;
    }
    const ch = source[i]!;
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return null;
}

/** Return `offset` unchanged when ordinary code starts there. */
function skipNonStructural(source: string, offset: number, limit: number): number {
  const ch = source[offset];
  const next = source[offset + 1];
  if (ch === '/' && next === '/') return skipLineComment(source, offset + 2, limit);
  if (ch === '/' && next === '*') return skipBlockComment(source, offset + 2, limit);
  if (ch === '#' && isDirectiveStart(source, offset)) return skipDirective(source, offset + 1, limit);

  if (ch === 'R' && next === '"') {
    const rawEnd = skipRawString(source, offset, limit);
    if (rawEnd !== null) return rawEnd;
  }
  if (ch === '"') return skipQuotedLiteral(source, offset + 1, '"', limit);
  if (ch === "'" && !isCppDigitSeparator(source, offset)) {
    return skipQuotedLiteral(source, offset + 1, "'", limit);
  }
  return offset;
}

function skipLineComment(source: string, offset: number, limit: number): number {
  let cursor = offset;
  while (cursor < limit) {
    const newline = source.indexOf('\n', cursor);
    if (newline < 0 || newline >= limit) return limit;
    let before = newline - 1;
    if (before >= cursor && source[before] === '\r') before--;
    while (before >= cursor && (source[before] === ' ' || source[before] === '\t')) before--;
    if (before >= cursor && source[before] === '\\') {
      cursor = newline + 1;
      continue;
    }
    return newline + 1;
  }
  return limit;
}

function skipBlockComment(source: string, offset: number, limit: number): number {
  const end = source.indexOf('*/', offset);
  return end < 0 || end + 2 > limit ? limit : end + 2;
}

function skipQuotedLiteral(
  source: string,
  offset: number,
  terminator: '"' | "'",
  limit: number,
): number {
  for (let i = offset; i < limit; i++) {
    const ch = source[i]!;
    if (ch === '\\') {
      if (source[i + 1] === '\r' && source[i + 2] === '\n') i += 2;
      else if (i + 1 < limit) i++;
    } else if (ch === terminator) {
      return i + 1;
    } else if (ch === '\n') {
      // Invalid unescaped newline: stop masking so malformed source cannot
      // hide the remainder of a large file.
      return i + 1;
    }
  }
  return limit;
}

function skipRawString(source: string, offset: number, limit: number): number | null {
  const delimiterStart = offset + 2;
  const openingParen = source.indexOf('(', delimiterStart);
  if (openingParen < 0 || openingParen >= limit || openingParen - delimiterStart > 16) return null;
  const delimiter = source.slice(delimiterStart, openingParen);
  if (/[\s\\()]/u.test(delimiter)) return null;
  const terminator = `)${delimiter}"`;
  const end = source.indexOf(terminator, openingParen + 1);
  return end < 0 || end + terminator.length > limit ? limit : end + terminator.length;
}

function isDirectiveStart(source: string, offset: number): boolean {
  for (let i = offset - 1; i >= 0 && source[i] !== '\n'; i--) {
    if (source[i] !== ' ' && source[i] !== '\t' && source[i] !== '\r') return false;
  }
  return true;
}

function skipDirective(source: string, offset: number, limit: number): number {
  let cursor = offset;
  while (cursor < limit) {
    const newline = source.indexOf('\n', cursor);
    if (newline < 0 || newline >= limit) return limit;
    let before = newline - 1;
    if (source[before] === '\r') before--;
    while (before >= cursor && (source[before] === ' ' || source[before] === '\t')) before--;
    if (source[before] === '\\') {
      cursor = newline + 1;
      continue;
    }
    return newline + 1;
  }
  return limit;
}

function isCppDigitSeparator(source: string, offset: number): boolean {
  const next = source[offset + 1];
  if (!next || !/[A-Za-z0-9]/u.test(next)) return false;
  let start = offset - 1;
  while (start >= 0 && /[A-Za-z0-9_.]/u.test(source[start]!)) start--;
  const numericPrefix = source.slice(start + 1, offset);
  return /^(?:\d|\.\d)/u.test(numericPrefix);
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}
