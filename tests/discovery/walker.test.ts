import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  walkFiles,
  detectLanguageForPath,
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
