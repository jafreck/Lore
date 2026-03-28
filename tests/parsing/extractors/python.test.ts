import { describe, it, expect } from 'vitest';
import { PythonExtractor } from '../../../src/parsing/extractors/python.js';
import { ParserPool } from '../../../src/parsing/parser.js';

const pool = new ParserPool();
const extractor = new PythonExtractor();

function extract(source: string) {
  const tree = pool.parse('python', source)!;
  return extractor.extract(tree, source, 'test.py');
}

describe('PythonExtractor', () => {
  describe('symbol extraction', () => {
    it('extracts function definition', () => {
      const result = extract('def greet(name):\n    return f"Hello {name}"\n');
      const sym = result.symbols.find(s => s.name === 'greet');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
      expect(sym!.startLine).toBe(0);
    });

    it('extracts async function', () => {
      const result = extract('async def fetch_data(url):\n    pass\n');
      const sym = result.symbols.find(s => s.name === 'fetch_data');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('async_function');
    });

    it('extracts class definition', () => {
      const source = `class MyClass:
    def __init__(self):
        pass
    def method(self):
        pass
`;
      const result = extract(source);
      const cls = result.symbols.find(s => s.name === 'MyClass' && s.kind === 'class');
      expect(cls).toBeDefined();
    });

    it('extracts nested method with parentName', () => {
      const source = `class Foo:
    def bar(self):
        pass
`;
      const result = extract(source);
      const method = result.symbols.find(s => s.name === 'bar');
      expect(method).toBeDefined();
      expect(method!.parentName).toBe('Foo');
    });

    it('extracts decorated function', () => {
      const source = `@decorator
def decorated_func():
    pass
`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'decorated_func');
      expect(sym).toBeDefined();
    });

    it('extracts decorated async function', () => {
      const source = `@app.route('/')
async def handler():
    pass
`;
      const result = extract(source);
      const sym = result.symbols.find(s => s.name === 'handler');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('async_function');
    });

    it('extracts decorated class', () => {
      const source = `@dataclass
class Point:
    x: float
    y: float
`;
      const result = extract(source);
      const cls = result.symbols.find(s => s.name === 'Point' && s.kind === 'class');
      expect(cls).toBeDefined();
    });

    it('does not duplicate decorated definitions', () => {
      const source = `@decorator
def func():
    pass
`;
      const result = extract(source);
      const funcs = result.symbols.filter(s => s.name === 'func');
      expect(funcs).toHaveLength(1);
    });
  });

  describe('import extraction', () => {
    it('extracts import statement', () => {
      const result = extract('import os\n');
      expect(result.imports.length).toBeGreaterThan(0);
      expect(result.imports.some(i => i.source === 'os')).toBe(true);
    });

    it('extracts from...import statement', () => {
      const result = extract('from pathlib import Path\n');
      expect(result.imports.length).toBeGreaterThan(0);
      expect(result.imports[0].source).toBe('pathlib');
      expect(result.imports[0].importedNames).toContain('Path');
    });

    it('extracts multiple from...import names', () => {
      const result = extract('from os.path import join, dirname, basename\n');
      expect(result.imports[0].source).toBe('os.path');
      expect(result.imports[0].importedNames).toContain('join');
      expect(result.imports[0].importedNames).toContain('dirname');
      expect(result.imports[0].importedNames).toContain('basename');
    });
  });

  describe('call ref extraction', () => {
    it('extracts direct function calls', () => {
      const source = `def main():\n    print("hello")\n`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'print');
      expect(ref).toBeDefined();
      expect(ref!.callerSymbol).toBe('main');
    });

    it('extracts method calls', () => {
      const source = `def foo():\n    obj.method()\n`;
      const result = extract(source);
      const ref = result.callRefs.find(r => r.calleeRaw === 'obj.method');
      expect(ref).toBeDefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty source', () => {
      const result = extract('');
      expect(result.symbols).toEqual([]);
    });

    it('handles source without definitions', () => {
      const result = extract('x = 42\ny = x + 1\n');
      expect(result.symbols).toEqual([]);
    });

    it('handles nested functions', () => {
      const source = `def outer():
    def inner():
        pass
    inner()
`;
      const result = extract(source);
      expect(result.symbols.find(s => s.name === 'outer')).toBeDefined();
      expect(result.symbols.find(s => s.name === 'inner')).toBeDefined();
      const inner = result.symbols.find(s => s.name === 'inner')!;
      expect(inner.parentName).toBe('outer');
    });
  });
});
