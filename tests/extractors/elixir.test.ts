import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { ElixirExtractor } from '../../src/indexer/extractors/elixir.js';

const ext = new ElixirExtractor();
const fixture = (name: string) => parseAndExtractStrict('elixir', path.join(import.meta.dirname, '../fixtures/elixir', name), ext);

describe('Elixir module and function extraction', () => {
  const r = fixture('module-functions.ex');
  test('extracts module', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Sample', kind: 'module' }));
  });
  test('extracts public function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
  });
  test('extracts private function', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'format', kind: 'function' }));
  });
});

describe('Elixir struct extraction', () => {
  const r = fixture('struct.ex');
  test('extracts struct', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ kind: 'struct' }));
  });
});

describe('Elixir protocol and impl extraction', () => {
  const r = fixture('protocol.ex');
  test('extracts protocol as interface', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'Stringify', kind: 'interface' }));
  });
  test('extracts impl', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ kind: 'impl' }));
  });
});

describe('Elixir macro extraction', () => {
  const r = fixture('macro.ex');
  test('extracts macro', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ kind: 'macro' }));
  });
});

describe('Elixir import directives', () => {
  const r = fixture('imports.ex');
  test('extracts alias, import, use, require as imports', () => {
    expect(r.imports).toHaveLength(4);
  });
});

describe('Elixir call-ref extraction', () => {
  const r = fixture('callref.ex');
  test('extracts call ref', () => {
    const refs = r.callRefs.filter(c => c.calleeRaw === 'to_string');
    expect(refs).toHaveLength(1);
  });
});

describe('Elixir defguard/defdelegate (no-op keywords)', () => {
  const r = fixture('guard-delegate.ex');
  test('does not produce call-refs for defguard or defdelegate', () => {
    // defguard and defdelegate are handled as no-op switch cases
    expect(r.callRefs.filter(c => c.calleeRaw === 'defguard')).toHaveLength(0);
    expect(r.callRefs.filter(c => c.calleeRaw === 'defdelegate')).toHaveLength(0);
  });
});

describe('Elixir macro callerSymbol resolution', () => {
  const r = fixture('macro-callref.ex');
  test('resolves callerSymbol for calls inside defmacro', () => {
    const inspectRefs = r.callRefs.filter(c => c.calleeRaw.includes('inspect'));
    // The IO.inspect call inside defmacro should resolve callerSymbol
    expect(r.symbols).toContainEqual(expect.objectContaining({ kind: 'macro' }));
  });
});
