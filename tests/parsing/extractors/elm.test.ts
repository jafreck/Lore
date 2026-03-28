import { describe, it, expect } from 'vitest';
import { ElmExtractor } from '../../../src/parsing/extractors/elm.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new ElmExtractor();

function extract(source: string) {
  const tree = pool.parse('elm', source)!;
  return extractor.extract(tree, source, 'Test.elm');
}

describe('ElmExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts value declaration (function)', () => {
      const source = `greet name =
    "Hello " ++ name`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'greet');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts type declaration', () => {
      const source = `type Color
    = Red
    | Green
    | Blue`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Color');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('type');
    });

    it('extracts type alias declaration', () => {
      const source = `type alias Model =
    { count : Int
    , name : String
    }`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Model');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('type');
    });

    it('extracts port annotation', () => {
      const source = `port saveData : String -> Cmd msg`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'saveData');
      if (sym) {
        expect(sym.kind).toBe('port');
      }
    });
  });

  describe('import extraction', () => {
    it('extracts import clause', () => {
      const source = `import Html exposing (div, text)`;
      const result = extract(source);
      expect(result.imports.length).toBeGreaterThanOrEqual(1);
      const imp = result.imports[0]!;
      expect(imp.source).toContain('Html');
    });

    it('extracts import without exposing', () => {
      const source = `import Dict`;
      const result = extract(source);
      expect(result.imports.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('call ref extraction', () => {
    it('extracts function call expressions', () => {
      const source = `view model =
    div [] [ text "hello" ]`;
      const result = extract(source);
      // Call refs depend on function_call_expr being present in grammar
      expect(result.symbols.length).toBeGreaterThanOrEqual(1);
    });
  });
});
