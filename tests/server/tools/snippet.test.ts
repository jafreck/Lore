import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Database } from '../../../src/db/schema.js';
import { handler, toolDef } from '../../../src/server/tools/snippet.js';

function seedSnippetData(db: Database.Database) {
  const source = [
    'import { foo } from "./foo";',
    '',
    'export function greet(name: string): string {',
    '  return `Hello, ${name}!`;',
    '}',
    '',
    'export class Greeter {',
    '  private name: string;',
    '  constructor(name: string) {',
    '    this.name = name;',
    '  }',
    '  greet(): string {',
    '    return `Hello, ${this.name}!`;',
    '  }',
    '}',
  ].join('\n');

  db.prepare(
    `INSERT INTO files (id, path, branch, language, source) VALUES (1, 'src/greet.ts', 'main', 'typescript', ?)`,
  ).run(source);
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (1, 1, 'greet', 'function', 3, 5)`,
  ).run();
  db.prepare(
    `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line) VALUES (2, 1, 'Greeter', 'class', 7, 15)`,
  ).run();
}

describe('lore_snippet toolDef', () => {
  it('has required fields', () => {
    expect(toolDef.name).toBe('lore_snippet');
    expect(toolDef.description).toBeTruthy();
    expect(toolDef.inputSchema.required).toContain('path');
  });
});

describe('lore_snippet handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
    seedSnippetData(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns full file when no range specified', () => {
    const result = handler(db, { path: 'src/greet.ts' });
    expect(result.path).toBe('src/greet.ts');
    expect(result.start_line).toBe(1);
    expect(result.text).toContain('import { foo }');
    expect(result.text).toContain('class Greeter');
  });

  it('returns specific line range', () => {
    const result = handler(db, { path: 'src/greet.ts', start_line: 3, end_line: 5 });
    expect(result.start_line).toBe(3);
    expect(result.end_line).toBe(5);
    expect(result.text).toContain('function greet');
    expect(result.text).not.toContain('import');
  });

  it('resolves snippet by symbol name', () => {
    const result = handler(db, { path: 'src/greet.ts', symbol: 'greet' });
    expect(result.start_line).toBe(3);
    expect(result.end_line).toBe(5);
    expect(result.text).toContain('function greet');
  });

  it('throws for unknown path', () => {
    expect(() => handler(db, { path: 'no/such/file.ts' })).toThrow(/File not found/);
  });

  it('throws for unknown symbol', () => {
    expect(() => handler(db, { path: 'src/greet.ts', symbol: 'nonExistent' })).toThrow(/Symbol not found/);
  });

  it('throws when both symbol and line range are provided', () => {
    expect(() =>
      handler(db, { path: 'src/greet.ts', symbol: 'greet', start_line: 1, end_line: 5 }),
    ).toThrow(/Provide either/);
  });

  it('throws for empty symbol name', () => {
    expect(() => handler(db, { path: 'src/greet.ts', symbol: '  ' })).toThrow();
  });

  it('clamps start_line to minimum of 1', () => {
    const result = handler(db, { path: 'src/greet.ts', start_line: -5 });
    expect(result.start_line).toBe(1);
  });

  it('returns containing_symbol when snippet is within a symbol', () => {
    const result = handler(db, { path: 'src/greet.ts', start_line: 4, end_line: 4 });
    expect(result.containing_symbol).toBeDefined();
    expect(result.containing_symbol!.name).toBe('greet');
  });

  it('handles single-line snippet', () => {
    const result = handler(db, { path: 'src/greet.ts', start_line: 1, end_line: 1 });
    expect(result.text).toContain('import');
    expect(result.text.split('\n')).toHaveLength(1);
  });

  it('handles empty DB', () => {
    const emptyDb = openDb(':memory:');
    try {
      expect(() => handler(emptyDb, { path: 'anything.ts' })).toThrow(/File not found/);
    } finally {
      emptyDb.close();
    }
  });
});
