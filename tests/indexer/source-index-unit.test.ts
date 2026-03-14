/**
 * Unit tests covering the new features in the source-index stage:
 * - sourceCache population during processFile
 * - symbol_metrics insertion during processFile
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../../src/db/schema.js';
import { ParserPool } from '../../src/parsing/parser.js';
import { processFile } from '../../src/indexer/stages/source-index.js';
import type Database from 'better-sqlite3';

function createTempFile(content: string, filename = 'test.ts'): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-srcidx-'));
  const filePath = join(dir, filename);
  writeFileSync(filePath, content);
  return filePath;
}

describe('processFile — sourceCache', () => {
  let db: Database.Database;
  let pool: ParserPool;

  afterEach(() => {
    db?.close();
  });

  it('should populate sourceCache with file contents', () => {
    const content = 'export function hello(): string { return "hi"; }\n';
    const filePath = createTempFile(content);
    db = openDb(':memory:');
    pool = new ParserPool();
    const cache = new Map<string, string>();

    processFile(db, pool, filePath, 'typescript', 'main', cache);

    expect(cache.has(filePath)).toBe(true);
    expect(cache.get(filePath)).toBe(content);
  });

  it('should not error when sourceCache is undefined', () => {
    const filePath = createTempFile('export const x = 1;\n');
    db = openDb(':memory:');
    pool = new ParserPool();

    expect(() => processFile(db, pool, filePath, 'typescript', 'main')).not.toThrow();
  });
});

describe('processFile — symbol_metrics insertion', () => {
  let db: Database.Database;
  let pool: ParserPool;

  afterEach(() => {
    db?.close();
  });

  it('should insert symbol_metrics for each extracted symbol', () => {
    const content = `export function simple(): void {}
export function branchy(x: number): string {
  if (x > 0) {
    return "positive";
  } else if (x < 0) {
    return "negative";
  }
  return "zero";
}
`;
    const filePath = createTempFile(content);
    db = openDb(':memory:');
    pool = new ParserPool();

    processFile(db, pool, filePath, 'typescript', 'main');

    const metrics = db
      .prepare(
        `SELECT sm.cyclomatic, sm.line_count, s.name
         FROM symbol_metrics sm
         JOIN symbols s ON s.id = sm.symbol_id
         ORDER BY s.name`,
      )
      .all() as Array<{ cyclomatic: number; line_count: number; name: string }>;

    expect(metrics.length).toBeGreaterThanOrEqual(2);
    const branchy = metrics.find(m => m.name === 'branchy');
    const simple = metrics.find(m => m.name === 'simple');
    expect(branchy).toBeDefined();
    expect(simple).toBeDefined();
    // branchy has if/else branches — higher cyclomatic
    expect(branchy!.cyclomatic).toBeGreaterThan(simple!.cyclomatic);
  });

  it('should update symbol_metrics on re-index of changed file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-srcidx-'));
    const filePath = join(dir, 'evolve.ts');
    writeFileSync(filePath, 'export function f(): void {}\n');
    db = openDb(':memory:');
    pool = new ParserPool();

    processFile(db, pool, filePath, 'typescript', 'main');

    let metrics = db
      .prepare(
        `SELECT sm.cyclomatic, s.name FROM symbol_metrics sm JOIN symbols s ON s.id = sm.symbol_id WHERE s.name = 'f'`,
      )
      .get() as { cyclomatic: number; name: string } | undefined;
    expect(metrics).toBeDefined();
    const origCyclomatic = metrics!.cyclomatic;

    // Rewrite with more branches
    writeFileSync(filePath, `export function f(x: number): string {
  if (x > 0) return "a";
  if (x < 0) return "b";
  return "c";
}
`);
    processFile(db, pool, filePath, 'typescript', 'main');

    metrics = db
      .prepare(
        `SELECT sm.cyclomatic, s.name FROM symbol_metrics sm JOIN symbols s ON s.id = sm.symbol_id WHERE s.name = 'f'`,
      )
      .get() as { cyclomatic: number; name: string } | undefined;
    expect(metrics).toBeDefined();
    expect(metrics!.cyclomatic).toBeGreaterThanOrEqual(origCyclomatic);
  });
});

describe('processFile — is_exported persistence', () => {
  let db: Database.Database;
  let pool: ParserPool;

  afterEach(() => {
    db?.close();
  });

  it('should set is_exported = 1 for exported symbols', () => {
    const content = 'export function hello(): string { return "hi"; }\n';
    const filePath = createTempFile(content);
    db = openDb(':memory:');
    pool = new ParserPool();

    processFile(db, pool, filePath, 'typescript', 'main');

    const row = db.prepare(
      `SELECT s.name, s.is_exported FROM symbols s WHERE s.name = 'hello'`,
    ).get() as { name: string; is_exported: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.is_exported).toBe(1);
  });

  it('should set is_exported = 0 for non-exported symbols', () => {
    const content = 'function internal(): void {}\nexport function pub(): void {}\n';
    const filePath = createTempFile(content);
    db = openDb(':memory:');
    pool = new ParserPool();

    processFile(db, pool, filePath, 'typescript', 'main');

    const rows = db.prepare(
      `SELECT s.name, s.is_exported FROM symbols s ORDER BY s.name`,
    ).all() as Array<{ name: string; is_exported: number }>;

    const internal = rows.find(r => r.name === 'internal');
    const pub = rows.find(r => r.name === 'pub');
    expect(internal).toBeDefined();
    expect(internal!.is_exported).toBe(0);
    expect(pub).toBeDefined();
    expect(pub!.is_exported).toBe(1);
  });
});
