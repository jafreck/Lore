import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkFiles } from '../../src/discovery/walker.js';
import { filterCompilationDatabase, resolveScipScope } from '../../src/scip/scope.js';
import { loadCompilationDatabase } from '../../src/scip/compdb.js';

let directory: string;
let rootDir: string;

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'lore-scope-')));
  rootDir = join(directory, 'repo');
  mkdirSync(join(rootDir, 'lib'), { recursive: true });
  mkdirSync(join(rootDir, 'programs'));
  writeFileSync(join(rootDir, 'lib/main.c'), 'int main(void) { return 0; }\n');
  writeFileSync(join(rootDir, 'lib/main.h'), 'int main(void);\n');
  writeFileSync(join(rootDir, 'programs/other.c'), 'int other(void);\n');
  writeFileSync(join(rootDir, 'ancillary.py'), 'print("hello")\n');
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('host SCIP scope', () => {
  it('filters compilation commands to selected files with deterministic content and identity', async () => {
    const walker = { rootDir };
    const scope = resolveScipScope(walker, {
      languages: ['c'], includeGlobs: ['lib/**/*.{c,h}'],
    }, await walkFiles(walker));
    const compdbPath = join(rootDir, 'compile_commands.json');
    writeFileSync(compdbPath, JSON.stringify(['programs/other.c', 'lib/main.c'].map((file) => ({
      directory: rootDir, file, arguments: ['cc', '-c', file],
    }))));
    const database = loadCompilationDatabase(compdbPath).database!;
    const filtered = filterCompilationDatabase(database, scope);
    const second = filterCompilationDatabase({ ...database, entries: [...database.entries].reverse() }, scope);
    expect(filtered).toEqual(second);
    expect(JSON.parse(filtered.content)).toEqual([{
      directory: rootDir, file: join(rootDir, 'lib/main.c'), arguments: ['cc', '-c', 'lib/main.c'],
    }]);
    expect(filtered.identity).toMatchObject({
      scopeHash: scope.scopeHash, entries: 1, translationUnits: ['lib/main.c'],
    });
    expect(filtered.identity.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('intersects languages and globs with walker selection', async () => {
    const walker = { rootDir, excludeGlobs: ['programs/**'] };
    const scope = resolveScipScope(walker, {
      languages: ['c'],
      includeGlobs: ['lib/**/*.{c,h}', 'programs/**/*.{c,h}'],
      excludeGlobs: ['**/*.h'],
    }, await walkFiles(walker));
    expect(scope.effectiveFiles).toEqual([{ path: 'lib/main.c', language: 'c' }]);
    expect(scope.languageCounts).toEqual({ c: 1 });
  });

  it('canonicalizes ordering and duplicate requests deterministically', async () => {
    const walker = { rootDir };
    const files = await walkFiles(walker);
    const first = resolveScipScope(walker, {
      languages: ['cpp', 'c', 'c'],
      includeGlobs: ['programs/**', './lib/**', 'lib/**'],
    }, files);
    const second = resolveScipScope(walker, {
      languages: ['c', 'cpp'],
      includeGlobs: ['lib/**', 'programs/**'],
    }, files.reverse());
    expect(first).toEqual(second);
    expect(first.scopeHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.languageCounts).toEqual({ c: 3, cpp: 0 });
  });

  it('rejects symlink escapes even though the walker skips them', async () => {
    writeFileSync(join(directory, 'outside.c'), 'int outside;\n');
    symlinkSync(join(directory, 'outside.c'), join(rootDir, 'lib/escape.c'));
    const walker = { rootDir };
    const files = await walkFiles(walker);
    expect(() => resolveScipScope(walker, { languages: ['c'] }, files))
      .toThrow('symlink escapes repository root');
  });

  it('does not let out-of-scope language or walker symlinks degrade the scope', async () => {
    writeFileSync(join(directory, 'outside.py'), 'print("outside")\n');
    writeFileSync(join(directory, 'outside.c'), 'int outside;\n');
    symlinkSync(join(directory, 'outside.py'), join(rootDir, 'lib/ancillary.py'));
    symlinkSync(join(directory, 'outside.c'), join(rootDir, 'programs/escape.c'));
    const walker = { rootDir, includeGlobs: ['lib/**'] };
    const resolved = resolveScipScope(walker, { languages: ['c'] }, await walkFiles(walker));
    expect(resolved.effectiveFiles.map(file => file.path)).toEqual(['lib/main.c', 'lib/main.h']);
  });

  it('does not let an in-root alias bypass a canonical scope exclusion', async () => {
    mkdirSync(join(rootDir, 'lib/generated'));
    writeFileSync(join(rootDir, 'lib/generated/hidden.c'), 'int hidden;\n');
    symlinkSync(join(rootDir, 'lib/generated/hidden.c'), join(rootDir, 'lib/alias.c'));
    const walker = { rootDir };
    const resolved = resolveScipScope(walker, {
      languages: ['c'], includeGlobs: ['lib/**'], excludeGlobs: ['**/generated/**'],
    }, await walkFiles(walker));
    expect(resolved.effectiveFiles.map(file => file.path)).toEqual(['lib/main.c', 'lib/main.h']);
  });

  it('rejects traversal and unknown languages', async () => {
    const walker = { rootDir };
    const files = await walkFiles(walker);
    expect(() => resolveScipScope(walker, { languages: ['c'], includeGlobs: ['../**'] }, files))
      .toThrow('root-relative globs');
    expect(() => resolveScipScope(walker, { languages: ['not-a-language'] }, files))
      .toThrow('Unknown SCIP scope language');
  });
});