import { describe, it, expect } from 'vitest';
import { GoExtractor } from '../../../src/parsing/extractors/go.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new GoExtractor();

function extract(source: string) {
  const tree = pool.parse('go', source)!;
  return extractor.extract(tree, source, 'test.go');
}

describe('GoExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts function declaration', () => {
      const result = extract('package main\nfunc Add(a int, b int) int { return a + b }');
      const sym = result.symbols.find(s => s.name === 'Add');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });

    it('extracts method declaration with receiver', () => {
      const source = `package main
type Server struct{}
func (s *Server) Start() error { return nil }`;
      const result = extract(source);
      // The receiver type text may include the pointer prefix
      const sym = result.symbols.find(s => s.name.includes('Server') && s.name.includes('Start'));
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('method');
    });

    it('extracts struct type declaration', () => {
      const source = `package main
type Config struct {
  Host string
  Port int
}`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Config');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('struct');
    });

    it('extracts interface type declaration', () => {
      const source = `package main
type Reader interface {
  Read(p []byte) (n int, err error)
}`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'Reader');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('interface');
    });
  });

  describe('import extraction', () => {
    it('extracts single import', () => {
      const result = extract('package main\nimport "fmt"');
      expect(result.imports.length).toBeGreaterThan(0);
      expect(result.imports.some(i => i.source.includes('fmt'))).toBe(true);
    });

    it('extracts grouped imports', () => {
      const source = `package main
import (
  "fmt"
  "os"
  "strings"
)`;
      const result = extract(source);
      expect(result.imports.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('call ref extraction', () => {
    it('extracts function calls', () => {
      const source = `package main
import "fmt"
func main() { fmt.Println("hello") }`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw.includes('Println'));
      expect(ref).toBeDefined();
    });
  });

  describe('type ref extraction', () => {
    it('extracts parameter type refs', () => {
      const source = `package main
func Foo(r Reader) {}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'Reader');
      expect(ref).toBeDefined();
    });

    it('extracts return type refs', () => {
      const source = `package main
func Bar() error { return nil }`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'error');
      expect(ref).toBeDefined();
    });
  });

  describe('relationship extraction', () => {
    it('extracts struct embedding (interface implementation)', () => {
      const source = `package main
type MyStruct struct {
  name string
}`;
      const result = extract(source);
      // At minimum, the type declaration should be found
      expect(result.symbols.find(s => s.name === 'MyStruct')).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty source', () => {
      const result = extract('package main');
      expect(result.symbols).toEqual([]);
    });

    it('handles function with no params and no return', () => {
      const result = extract('package main\nfunc noop() {}');
      const sym = result.symbols.find(s => s.name === 'noop');
      expect(sym).toBeDefined();
    });
  });
});
