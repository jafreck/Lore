import { describe, expect, it } from 'vitest';
import { CSourceSpanResolver } from '../../src/indexer/stages/scip-helpers/source-spans.js';
import { PositionEncoding } from '../../src/scip/scip_pb.js';

describe('CSourceSpanResolver', () => {
  it('recovers bounded declaration spans from compiler-identified C function names', () => {
    const resolver = new CSourceSpanResolver('const char *helper(\n  int value, void (*callback)(int)\n);\n');
    expect(resolver.findFunctionDeclarationSpan(0, 12)).toEqual({ startLine: 0, endLine: 2, endCharacter: 2 });
    const limited = new CSourceSpanResolver('int helper(int value);', undefined, { maxCharacters: 10 });
    expect(limited.findFunctionDeclarationSpan(0, 4)).toBeNull();
  });

  it.each([
    'helper();', 'return helper();', 'int value = helper();', 'object.helper();',
    'sizeof helper();', 'do helper();',
    'int helper(void) { return 1; }', 'MACRO(helper());', '#define RUN helper();',
  ])('does not treat a call or body as a declaration: %s', (source) => {
    expect(new CSourceSpanResolver(source).findFunctionDeclarationSpan(0, source.indexOf('helper'))).toBeNull();
  });

  it('recovers a multiline C function body when SCIP omits enclosingRange', () => {
    const source = [
      'int helper(void);',
      '',
      'int run(int value)',
      '{',
      '  if (value) {',
      '    return helper();',
      '  }',
      '  return 0;',
      '}',
    ].join('\n');

    const resolver = new CSourceSpanResolver(source);
    expect(resolver.findBraceDelimitedSpan(2, 4)).toEqual({ startLine: 2, endLine: 8, endCharacter: 1 });
  });

  it('does not treat a function prototype as a body', () => {
    const resolver = new CSourceSpanResolver('int helper(const char *value);\n');
    expect(resolver.findBraceDelimitedSpan(0, 4)).toBeNull();
  });

  it('ignores braces and semicolons in comments, strings, and macros', () => {
    const source = [
      '#define OPEN_BRACE {',
      'int run(void) {',
      '  const char *text = "};";',
      '  /* } ; { */',
      '  return 1;',
      '}',
    ].join('\n');

    const resolver = new CSourceSpanResolver(source);
    expect(resolver.findBraceDelimitedSpan(1, 4)).toEqual({ startLine: 1, endLine: 5, endCharacter: 1 });
  });

  it('keeps offsets aligned after non-BMP characters', () => {
    const source = [
      '// Unicode comment: 🚀',
      'int run(void) {',
      '  return 1;',
      '}',
    ].join('\n');
    const resolver = new CSourceSpanResolver(source);
    expect(resolver.findBraceDelimitedSpan(1, 4)).toEqual({ startLine: 1, endLine: 3, endCharacter: 1 });
  });

  it('converts a UTF-8 definition column on a line containing Unicode', () => {
    const prefix = '/* é🚀🚀 */ ';
    const source = `${prefix}int run(void) {\n  return 1;\n}`;
    const resolver = new CSourceSpanResolver(
      source,
      PositionEncoding.UTF8CodeUnitOffsetFromLineStart,
    );
    expect(resolver.findBraceDelimitedSpan(0, Buffer.byteLength(prefix, 'utf8') + 4))
      .toEqual({ startLine: 0, endLine: 2, endCharacter: 1 });
  });

  it('ignores quotes and braces inside C++ raw strings', () => {
    const source = [
      'int run() {',
      '  const char *value = R"tag(raw "};{" content)tag";',
      '  return 1;',
      '}',
    ].join('\n');
    const resolver = new CSourceSpanResolver(source);
    expect(resolver.findBraceDelimitedSpan(0, 4)).toEqual({ startLine: 0, endLine: 3, endCharacter: 1 });
  });

  it('does not mistake C++ digit separators for character literals', () => {
    const source = [
      "int run(int value = 1'000) {",
      '  return value;',
      '}',
    ].join('\n');
    const resolver = new CSourceSpanResolver(source);
    expect(resolver.findBraceDelimitedSpan(0, 4)).toEqual({ startLine: 0, endLine: 2, endCharacter: 1 });
  });

  it('skips braced and parenthesized constructor initializers', () => {
    const source = [
      'Widget::Widget()',
      '  : value_{1},',
      '    callback_([] { return 2; })',
      '{',
      '  consume(value_);',
      '}',
    ].join('\n');
    const resolver = new CSourceSpanResolver(source);
    expect(resolver.findBraceDelimitedSpan(0, 8, 'constructor'))
      .toEqual({ startLine: 0, endLine: 5, endCharacter: 1 });
  });

  it('ignores directives and backslash-continued line comments in signatures', () => {
    const source = [
      'int run( // fake }; \\',
      '  still part of the comment {;',
      '#if ENABLE_VALUE',
      '  int value',
      '#endif',
      ') {',
      '  return 1;',
      '}',
    ].join('\n');
    const resolver = new CSourceSpanResolver(source);
    expect(resolver.findBraceDelimitedSpan(0, 4)).toEqual({ startLine: 0, endLine: 7, endCharacter: 1 });
  });

  it('stops recovery at configured scan bounds', () => {
    const source = `int run(void)${' '.repeat(100)}{ return 1; }`;
    const resolver = new CSourceSpanResolver(
      source,
      PositionEncoding.UTF8CodeUnitOffsetFromLineStart,
      { maxCharacters: 32 },
    );
    expect(resolver.findBraceDelimitedSpan(0, 4)).toBeNull();
  });

  it('recovers the full span of a backslash-continued macro', () => {
    const source = [
      '#define CHECK(value) \\',
      '  do { \\',
      '    consume(value); \\',
      '  } while (0)',
    ].join('\n');

    const resolver = new CSourceSpanResolver(source);
    expect(resolver.findMacroSpan(0)).toEqual({ startLine: 0, endLine: 3, endCharacter: 13 });
  });
});
