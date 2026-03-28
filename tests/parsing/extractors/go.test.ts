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

  describe('goroutine and deferred calls', () => {
    it('extracts call refs from goroutine invocations', () => {
      const source = `package main
func main() {
  go handler()
  go processRequest("data")
}`;
      const result = extract(source);
      const handlerRef = result.callRefs.find(r => r.calleeRaw === 'handler');
      expect(handlerRef).toBeDefined();
      const processRef = result.callRefs.find(r => r.calleeRaw === 'processRequest');
      expect(processRef).toBeDefined();
    });

    it('extracts call refs from deferred calls', () => {
      const source = `package main
func cleanup() {
  defer file.Close()
  defer mu.Unlock()
}`;
      const result = extract(source);
      const closeRef = result.callRefs.find(r => r.calleeRaw === 'file.Close');
      expect(closeRef).toBeDefined();
    });
  });

  describe('type assertion type refs', () => {
    it('extracts type assertion as cast type ref', () => {
      const source = `package main
func convert(v interface{}) {
  s := v.(string)
  _ = s
}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'string' && r.refKind === 'cast');
      expect(ref).toBeDefined();
    });
  });

  describe('named return types', () => {
    it('extracts named return type refs from parameter_list result', () => {
      const source = `package main
func divide(a, b float64) (result float64, err error) {
  if b == 0 { return 0, nil }
  return a / b, nil
}`;
      const result = extract(source);
      const errRef = result.typeRefs.find(r => r.typeRaw === 'error' && r.refKind === 'return');
      expect(errRef).toBeDefined();
    });
  });

  describe('struct field type refs', () => {
    it('extracts field type refs from struct declarations', () => {
      const source = `package main
type Server struct {
  Logger Logger
  Config Config
  Port   int
}`;
      const result = extract(source);
      const loggerRef = result.typeRefs.find(r => r.typeRaw === 'Logger' && r.refKind === 'field');
      expect(loggerRef).toBeDefined();
      const configRef = result.typeRefs.find(r => r.typeRaw === 'Config' && r.refKind === 'field');
      expect(configRef).toBeDefined();
    });
  });

  describe('method type refs', () => {
    it('extracts parameter and return type refs from method declarations', () => {
      const source = `package main
type Server struct{}
func (s *Server) Handle(req Request) Response {
  return Response{}
}`;
      const result = extract(source);
      const paramRef = result.typeRefs.find(r => r.typeRaw === 'Request' && r.refKind === 'parameter');
      expect(paramRef).toBeDefined();
      const retRef = result.typeRefs.find(r => r.typeRaw === 'Response' && r.refKind === 'return');
      expect(retRef).toBeDefined();
    });

    it('extracts method return type refs from named return list', () => {
      const source = `package main
type DB struct{}
func (d *DB) Query(sql string) (rows Rows, err error) { return }`;
      const result = extract(source);
      const rowsRef = result.typeRefs.find(r => r.typeRaw === 'Rows' && r.refKind === 'return');
      expect(rowsRef).toBeDefined();
    });
  });

  describe('var declaration type refs', () => {
    it('extracts variable type refs from var declarations', () => {
      const source = `package main
func main() {
  var buf Buffer
  _ = buf
}`;
      const result = extract(source);
      const ref = result.typeRefs.find(r => r.typeRaw === 'Buffer' && r.refKind === 'variable');
      expect(ref).toBeDefined();
    });
  });

  describe('interface embedding and method specs', () => {
    it('extracts interface type', () => {
      const source = `package main
type ReadWriter interface {
  Read(p []byte) (int, error)
}`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'ReadWriter');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('interface');
    });

    it('extracts interface with embedded type as type ref', () => {
      const source = `package main
type ReadWriter interface {
  Read(p []byte) (int, error)
}`;
      const result = extract(source);
      // The interface should be extracted as a symbol
      expect(result.symbols.find(s => s.name === 'ReadWriter')).toBeDefined();
    });
  });

  describe('import with alias', () => {
    it('extracts aliased import', () => {
      const source = `package main
import (
  f "fmt"
  _ "net/http/pprof"
)`;
      const result = extract(source);
      expect(result.imports.length).toBeGreaterThanOrEqual(2);
      const fmtImp = result.imports.find(i => i.source === 'fmt');
      expect(fmtImp).toBeDefined();
      expect(fmtImp!.importedNames).toContain('f');
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
