import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  walkFiles,
  detectLanguageForPath,
  buildCFamilyLanguageEvidence,
  shouldIndexFile,
  isExcludedPath,
  EXT_TO_LANG,
  DEFAULT_EXCLUDES,
  SUPPORTED_WALKER_LANGUAGES,
  type WalkerConfig,
} from '../../src/discovery/walker.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

function mkFile(relativePath: string, content = ''): void {
  const abs = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-walker-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── EXT_TO_LANG ──────────────────────────────────────────────────────────────

describe('EXT_TO_LANG', () => {
  it('maps common extensions to languages', () => {
    expect(EXT_TO_LANG['.ts']).toBe('typescript');
    expect(EXT_TO_LANG['.py']).toBe('python');
    expect(EXT_TO_LANG['.java']).toBe('java');
    expect(EXT_TO_LANG['.rs']).toBe('rust');
    expect(EXT_TO_LANG['.go']).toBe('go');
    expect(EXT_TO_LANG['.c']).toBe('c');
    expect(EXT_TO_LANG['.C']).toBe('cpp');
    expect(EXT_TO_LANG['.cpp']).toBe('cpp');
    expect(EXT_TO_LANG['.rb']).toBe('ruby');
    expect(EXT_TO_LANG['.js']).toBe('javascript');
    expect(EXT_TO_LANG['.jsx']).toBe('javascript');
    expect(EXT_TO_LANG['.tsx']).toBe('typescript');
  });

  it('has no undefined values', () => {
    for (const [ext, lang] of Object.entries(EXT_TO_LANG)) {
      expect(lang).toBeDefined();
      expect(typeof lang).toBe('string');
      expect(ext.startsWith('.')).toBe(true);
    }
  });
});

// ─── SUPPORTED_WALKER_LANGUAGES ───────────────────────────────────────────────

describe('SUPPORTED_WALKER_LANGUAGES', () => {
  it('is a sorted frozen array', () => {
    expect(Object.isFrozen(SUPPORTED_WALKER_LANGUAGES)).toBe(true);
    const sorted = [...SUPPORTED_WALKER_LANGUAGES].sort();
    expect([...SUPPORTED_WALKER_LANGUAGES]).toEqual(sorted);
  });

  it('contains all distinct languages from EXT_TO_LANG', () => {
    const unique = [...new Set(Object.values(EXT_TO_LANG))].sort();
    expect([...SUPPORTED_WALKER_LANGUAGES]).toEqual(unique);
  });
});

// ─── DEFAULT_EXCLUDES ─────────────────────────────────────────────────────────

describe('DEFAULT_EXCLUDES', () => {
  it('excludes node_modules and .git', () => {
    expect(DEFAULT_EXCLUDES).toContain('**/node_modules/**');
    expect(DEFAULT_EXCLUDES).toContain('**/.git/**');
  });
});

// ─── detectLanguageForPath ────────────────────────────────────────────────────

describe('detectLanguageForPath', () => {
  it('returns the correct language for known extensions', () => {
    expect(detectLanguageForPath('src/main.ts')).toBe('typescript');
    expect(detectLanguageForPath('lib/server.py')).toBe('python');
    expect(detectLanguageForPath('hello.java')).toBe('java');
    expect(detectLanguageForPath('file.rs')).toBe('rust');
  });

  it('returns undefined for unknown extensions', () => {
    expect(detectLanguageForPath('readme.md')).toBeUndefined();
    expect(detectLanguageForPath('config.json')).toBeUndefined();
    expect(detectLanguageForPath('Makefile')).toBeUndefined();
  });

  it('respects extension filter', () => {
    expect(detectLanguageForPath('main.ts', { extensions: ['.ts'] })).toBe('typescript');
    expect(detectLanguageForPath('main.ts', { extensions: ['.py'] })).toBeUndefined();
  });

  it('is case-insensitive on extension', () => {
    expect(detectLanguageForPath('FILE.TS')).toBe('typescript');
    expect(detectLanguageForPath('Main.PY')).toBe('python');
  });

  it('preserves the case-sensitive .C convention for C++', () => {
    expect(detectLanguageForPath('legacy.C')).toBe('cpp');
    expect(detectLanguageForPath('legacy.c')).toBe('c');
  });

  it('uses project evidence for ambiguous .h files', () => {
    const cppEvidence = buildCFamilyLanguageEvidence(['src/main.cpp']);
    const cEvidence = buildCFamilyLanguageEvidence(['src/main.c']);
    expect(detectLanguageForPath('include/api.h', undefined, { cFamilyEvidence: cppEvidence }))
      .toBe('cpp');
    expect(detectLanguageForPath('include/api.h', undefined, { cFamilyEvidence: cEvidence }))
      .toBe('c');
  });

  it('uses compilation-unit includes and represents mixed or ambiguous headers explicitly', () => {
    const cSource = path.join(tmpDir, 'components/c/src/main.c');
    const cHeader = path.join(tmpDir, 'components/c/include/api.h');
    const cppSource = path.join(tmpDir, 'components/cpp/src/main.cpp');
    const cppHeader = path.join(tmpDir, 'components/cpp/include/api.h');
    const sharedHeader = path.join(tmpDir, 'shared/include/shared.h');
    const ambiguousHeader = path.join(tmpDir, 'components/mixed/include/unused.h');
    const mixedCSource = path.join(tmpDir, 'components/mixed/src/a.c');
    const mixedCppSource = path.join(tmpDir, 'components/mixed/src/b.cpp');

    const sources = new Map<string, string>([
      [cSource, '#include "api.h"\n#include "shared.h"\n'],
      [cHeader, 'int c_api(void);\n'],
      [cppSource, '#include "api.h"\n#include "shared.h"\n'],
      [cppHeader, 'class CppApi {};\n'],
      [sharedHeader, 'void shared(void);\n'],
      [ambiguousHeader, 'void unused(void);\n'],
      [mixedCSource, 'int c_only(void);\n'],
      [mixedCppSource, 'int cpp_only();\n'],
    ]);
    const entries = [
      {
        filePath: cSource,
        workingDirectory: tmpDir,
        arguments: ['clang', '-c', cSource],
        includePaths: [path.dirname(cHeader), path.dirname(sharedHeader)],
        language: 'c' as const,
        responseFiles: { status: 'complete' as const, filesRead: 0, bytesRead: 0, expandedTokens: 0, expandedBytes: 0, diagnostics: [] },
      },
      {
        filePath: cppSource,
        workingDirectory: tmpDir,
        arguments: ['clang++', '-c', cppSource],
        includePaths: [path.dirname(cppHeader), path.dirname(sharedHeader)],
        language: 'cpp' as const,
        responseFiles: { status: 'complete' as const, filesRead: 0, bytesRead: 0, expandedTokens: 0, expandedBytes: 0, diagnostics: [] },
      },
      {
        filePath: mixedCSource,
        workingDirectory: tmpDir,
        arguments: ['clang', '-c', mixedCSource],
        includePaths: [],
        language: 'c' as const,
        responseFiles: { status: 'complete' as const, filesRead: 0, bytesRead: 0, expandedTokens: 0, expandedBytes: 0, diagnostics: [] },
      },
      {
        filePath: mixedCppSource,
        workingDirectory: tmpDir,
        arguments: ['clang++', '-c', mixedCppSource],
        includePaths: [],
        language: 'cpp' as const,
        responseFiles: { status: 'complete' as const, filesRead: 0, bytesRead: 0, expandedTokens: 0, expandedBytes: 0, diagnostics: [] },
      },
    ];
    const evidence = buildCFamilyLanguageEvidence(sources.keys(), {
      rootDir: tmpDir,
      compilationDatabase: { entries },
      sourceCache: sources,
    });

    expect(evidence.classifyHeaderLanguage(cHeader)).toBe('c');
    expect(evidence.classifyHeaderLanguage(cppHeader)).toBe('cpp');
    expect(evidence.classifyHeaderLanguage(sharedHeader)).toBe('mixed');
    expect(evidence.classifyHeaderLanguage(ambiguousHeader)).toBe('ambiguous');
    expect(evidence.inferHeaderLanguage(sharedHeader, 'c')).toBe('c');
    expect(evidence.inferHeaderLanguage(sharedHeader, 'cpp')).toBe('cpp');
    expect(evidence.inferHeaderLanguage(sharedHeader)).toBeUndefined();
  });

  it('does not classify an unreferenced header by a repository-wide 2:1 ratio', () => {
    const files = [
      ...Array.from({ length: 10 }, (_, index) => `src/c-${index}.c`),
      'src/only.cpp',
      'include/unknown.h',
    ];
    const evidence = buildCFamilyLanguageEvidence(files, { rootDir: tmpDir });

    expect(evidence.classifyHeaderLanguage('include/unknown.h')).toBe('ambiguous');
    expect(evidence.inferHeaderLanguage('include/unknown.h', 'cpp')).toBe('cpp');
  });
});

// ─── shouldIndexFile ──────────────────────────────────────────────────────────

describe('shouldIndexFile', () => {
  it('returns true for source files in normal directories', () => {
    expect(shouldIndexFile('src/index.ts', {})).toBe(true);
    expect(shouldIndexFile('lib/main.py', {})).toBe(true);
  });

  it('returns false for files in excluded directories', () => {
    expect(shouldIndexFile('node_modules/foo/index.js', {})).toBe(false);
    expect(shouldIndexFile('.git/objects/abc', {})).toBe(false);
    expect(shouldIndexFile('dist/bundle.js', {})).toBe(false);
  });

  it('returns false for unsupported file extensions', () => {
    expect(shouldIndexFile('README.md', {})).toBe(false);
    expect(shouldIndexFile('package.json', {})).toBe(false);
  });

  it('respects custom excludeGlobs', () => {
    expect(shouldIndexFile('vendor/lib.js', { excludeGlobs: ['**/vendor/**'] })).toBe(false);
    expect(shouldIndexFile('src/lib.js', { excludeGlobs: ['**/vendor/**'] })).toBe(true);
  });

  it('respects extension filter', () => {
    expect(shouldIndexFile('src/main.ts', { extensions: ['.ts'] })).toBe(true);
    expect(shouldIndexFile('src/main.js', { extensions: ['.ts'] })).toBe(false);
  });
});

// ─── isExcludedPath ───────────────────────────────────────────────────────────

describe('isExcludedPath', () => {
  it('returns true for default excluded dirs', () => {
    expect(isExcludedPath('node_modules/foo/bar.ts', {})).toBe(true);
    expect(isExcludedPath('.git/config', {})).toBe(true);
    expect(isExcludedPath('build/output.js', {})).toBe(true);
    expect(isExcludedPath('__pycache__/mod.pyc', {})).toBe(true);
    expect(isExcludedPath('target/debug/main', {})).toBe(true);
  });

  it('returns false for non-excluded paths', () => {
    expect(isExcludedPath('src/index.ts', {})).toBe(false);
    expect(isExcludedPath('lib/utils.py', {})).toBe(false);
  });

  it('respects custom excludeGlobs', () => {
    expect(isExcludedPath('vendor/lib.ts', { excludeGlobs: ['**/vendor/**'] })).toBe(true);
    expect(isExcludedPath('src/lib.ts', { excludeGlobs: ['**/vendor/**'] })).toBe(false);
  });

  it('handles backslash paths', () => {
    expect(isExcludedPath('node_modules\\foo\\bar.ts', {})).toBe(true);
  });
});

// ─── walkFiles ────────────────────────────────────────────────────────────────

describe('walkFiles', () => {
  it('discovers source files with correct languages', async () => {
    mkFile('src/index.ts', 'export const x = 1;');
    mkFile('src/main.py', 'x = 1');
    mkFile('src/App.java', 'class App {}');

    const files = await walkFiles({ rootDir: tmpDir });
    expect(files.length).toBe(3);

    const byLang = new Map(files.map((f) => [f.language, f.path]));
    expect(byLang.has('typescript')).toBe(true);
    expect(byLang.has('python')).toBe(true);
    expect(byLang.has('java')).toBe(true);
  });

  it('returns absolute paths', async () => {
    mkFile('src/index.ts', '');
    const files = await walkFiles({ rootDir: tmpDir });
    expect(files.length).toBe(1);
    expect(path.isAbsolute(files[0]!.path)).toBe(true);
  });

  it('classifies plain headers from nearby C++ and C projects independently', async () => {
    mkFile('packages/native/src/main.c');
    mkFile('packages/native/include/api.h');
    mkFile('packages/ui/src/widget.cpp');
    mkFile('packages/ui/include/widget.h');

    const files = await walkFiles({ rootDir: tmpDir });
    expect(files.find(file => file.path.endsWith('/packages/native/include/api.h'))?.language).toBe('c');
    expect(files.find(file => file.path.endsWith('/packages/ui/include/widget.h'))?.language).toBe('cpp');
  });

  it('classifies headers from their compilation-database translation units', async () => {
    mkFile('native/src/main.c', '#include "native.h"');
    mkFile('native/include/native.h');
    mkFile('ui/src/main.cpp', '#include "ui.h"');
    mkFile('ui/include/ui.h');
    const nativeSource = path.join(tmpDir, 'native/src/main.c');
    const uiSource = path.join(tmpDir, 'ui/src/main.cpp');

    const files = await walkFiles({ rootDir: tmpDir }, {
      compilationDatabase: {
        entries: [
          {
            filePath: nativeSource,
            workingDirectory: tmpDir,
            arguments: ['clang', '-c', nativeSource],
            includePaths: [path.join(tmpDir, 'native/include')],
            language: 'c',
            responseFiles: { status: 'complete', filesRead: 0, bytesRead: 0, expandedTokens: 0, expandedBytes: 0, diagnostics: [] },
          },
          {
            filePath: uiSource,
            workingDirectory: tmpDir,
            arguments: ['clang++', '-c', uiSource],
            includePaths: [path.join(tmpDir, 'ui/include')],
            language: 'cpp',
            responseFiles: { status: 'complete', filesRead: 0, bytesRead: 0, expandedTokens: 0, expandedBytes: 0, diagnostics: [] },
          },
        ],
      },
    });

    expect(files.find(file => file.path.endsWith('/native/include/native.h'))?.language).toBe('c');
    expect(files.find(file => file.path.endsWith('/ui/include/ui.h'))?.language).toBe('cpp');
  });

  it('skips files in node_modules', async () => {
    mkFile('node_modules/foo/index.js', '');
    mkFile('src/index.ts', '');

    const files = await walkFiles({ rootDir: tmpDir });
    expect(files.length).toBe(1);
    expect(files[0]!.path).toContain('src');
  });

  it('skips unsupported file extensions', async () => {
    mkFile('README.md', '# Hello');
    mkFile('config.json', '{}');
    mkFile('src/index.ts', '');

    const files = await walkFiles({ rootDir: tmpDir });
    expect(files.length).toBe(1);
    expect(files[0]!.language).toBe('typescript');
  });

  it('respects explicit extensions filter', async () => {
    mkFile('src/index.ts', '');
    mkFile('src/main.py', '');
    mkFile('src/app.js', '');

    const files = await walkFiles({ rootDir: tmpDir, extensions: ['.ts'] });
    expect(files.length).toBe(1);
    expect(files[0]!.language).toBe('typescript');
  });

  it('respects custom excludeGlobs', async () => {
    mkFile('src/index.ts', '');
    mkFile('vendor/lib.ts', '');

    const files = await walkFiles({ rootDir: tmpDir, excludeGlobs: ['**/vendor/**'] });
    expect(files.length).toBe(1);
    expect(files[0]!.path).toContain('src');
  });

  it('respects includeGlobs', async () => {
    mkFile('src/index.ts', '');
    mkFile('lib/main.ts', '');

    const files = await walkFiles({ rootDir: tmpDir, includeGlobs: ['src/**/*'] });
    expect(files.length).toBe(1);
    expect(files[0]!.path).toContain('src');
  });

  it('returns empty array for empty directory', async () => {
    const files = await walkFiles({ rootDir: tmpDir });
    expect(files).toEqual([]);
  });

  it('deduplicates symlinked files', async () => {
    mkFile('src/index.ts', 'const a = 1;');
    fs.mkdirSync(path.join(tmpDir, 'link_dir'), { recursive: true });
    try {
      fs.symlinkSync(path.join(tmpDir, 'src', 'index.ts'), path.join(tmpDir, 'link_dir', 'index.ts'));
    } catch {
      // Symlink may not be supported on all platforms
      return;
    }

    const files = await walkFiles({ rootDir: tmpDir });
    expect(files.length).toBe(1);
  });

  it('uses default include pattern when includeGlobs is empty', async () => {
    mkFile('src/index.ts', '');
    const files = await walkFiles({ rootDir: tmpDir, includeGlobs: [] });
    expect(files.length).toBe(1);
  });
});
