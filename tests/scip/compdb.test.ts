import { describe, it, expect } from 'vitest';
import {
  findExistingCompdb,
  detectBuildSystem,
  ensureCompilationDatabase,
  generateCompdb,
  type CompdbIO,
} from '../../src/scip/compdb.js';

// ─── Mock IO ──────────────────────────────────────────────────────────────────

function mockIO(existingFiles: Set<string> = new Set()): CompdbIO {
  return {
    existsSync: (p) => existingFiles.has(p),
    mkdirSync: () => {},
    execFileAsync: async () => ({ stdout: '', stderr: '' }),
  };
}

// ─── findExistingCompdb ───────────────────────────────────────────────────────

describe('findExistingCompdb', () => {
  it('finds compile_commands.json in root dir', () => {
    const io = { existsSync: (p: string) => p.endsWith('compile_commands.json') && !p.includes('build') && !p.includes('builddir') && !p.includes('.lore-compdb') };
    const result = findExistingCompdb('/project', io);
    expect(result).toBe('/project/compile_commands.json');
  });

  it('finds compile_commands.json in build/ subdir', () => {
    const files = new Set(['/project/build/compile_commands.json']);
    const result = findExistingCompdb('/project', { existsSync: (p) => files.has(p) });
    expect(result).toBe('/project/build/compile_commands.json');
  });

  it('finds compile_commands.json in builddir/ subdir', () => {
    const files = new Set(['/project/builddir/compile_commands.json']);
    const result = findExistingCompdb('/project', { existsSync: (p) => files.has(p) });
    expect(result).toBe('/project/builddir/compile_commands.json');
  });

  it('finds compile_commands.json in .lore-compdb/ subdir', () => {
    const files = new Set(['/project/.lore-compdb/compile_commands.json']);
    const result = findExistingCompdb('/project', { existsSync: (p) => files.has(p) });
    expect(result).toBe('/project/.lore-compdb/compile_commands.json');
  });

  it('returns null when no compile_commands.json found', () => {
    const result = findExistingCompdb('/project', { existsSync: () => false });
    expect(result).toBeNull();
  });
});

// ─── detectBuildSystem ────────────────────────────────────────────────────────

describe('detectBuildSystem', () => {
  it('detects CMake', () => {
    const io = { existsSync: (p: string) => p.endsWith('CMakeLists.txt') };
    expect(detectBuildSystem('/project', io)).toBe('cmake');
  });

  it('detects Meson', () => {
    const io = { existsSync: (p: string) => p.endsWith('meson.build') };
    expect(detectBuildSystem('/project', io)).toBe('meson');
  });

  it('detects Make via Makefile', () => {
    const io = { existsSync: (p: string) => p.endsWith('Makefile') };
    expect(detectBuildSystem('/project', io)).toBe('make');
  });

  it('detects Make via configure script', () => {
    const io = { existsSync: (p: string) => p.endsWith('/configure') };
    expect(detectBuildSystem('/project', io)).toBe('make');
  });

  it('returns none when no build system detected', () => {
    expect(detectBuildSystem('/project', { existsSync: () => false })).toBe('none');
  });

  it('prefers CMake over Meson when both exist', () => {
    const io = { existsSync: () => true };
    expect(detectBuildSystem('/project', io)).toBe('cmake');
  });
});

// ─── ensureCompilationDatabase ────────────────────────────────────────────────

describe('ensureCompilationDatabase', () => {
  it('returns existing compile_commands.json without generating', async () => {
    const files = new Set(['/project/compile_commands.json']);
    const io = mockIO(files);

    const result = await ensureCompilationDatabase('/project', 300_000, io);
    expect(result.preExisting).toBe(true);
    expect(result.path).toBe('/project/compile_commands.json');
  });

  it('returns null path and none for no build system and no compdb', async () => {
    const io = mockIO();
    const result = await ensureCompilationDatabase('/project', 300_000, io);
    expect(result.path).toBeNull();
    expect(result.buildSystem).toBe('none');
    expect(result.preExisting).toBe(false);
  });

  it('generates compdb for cmake projects', async () => {
    const generated = new Set<string>();
    const io: CompdbIO = {
      existsSync: (p) => {
        if (p.endsWith('CMakeLists.txt')) return true;
        if (generated.has(p)) return true;
        return false;
      },
      mkdirSync: () => {},
      execFileAsync: async () => {
        generated.add('/project/.lore-compdb/compile_commands.json');
        return { stdout: '', stderr: '' };
      },
    };

    const result = await ensureCompilationDatabase('/project', 300_000, io);
    expect(result.buildSystem).toBe('cmake');
    expect(result.path).toContain('compile_commands.json');
  });

  it('handles generation failure gracefully', async () => {
    const io: CompdbIO = {
      existsSync: (p) => p.endsWith('CMakeLists.txt'),
      mkdirSync: () => {},
      execFileAsync: async () => { throw new Error('cmake failed'); },
    };

    const result = await ensureCompilationDatabase('/project', 300_000, io);
    expect(result.path).toBeNull();
    expect(result.buildSystem).toBe('cmake');
  });
});

// ─── generateCompdb ───────────────────────────────────────────────────────────

describe('generateCompdb', () => {
  it('returns null for "none" build system', async () => {
    const result = await generateCompdb('/project', 'none', 300_000, mockIO());
    expect(result).toBeNull();
  });

  it('generates cmake compdb', async () => {
    const generated = new Set<string>();
    const io: CompdbIO = {
      existsSync: (p) => generated.has(p),
      mkdirSync: () => {},
      execFileAsync: async () => {
        generated.add('/project/.lore-compdb/compile_commands.json');
        return { stdout: '', stderr: '' };
      },
    };

    const result = await generateCompdb('/project', 'cmake', 300_000, io);
    expect(result).toContain('compile_commands.json');
  });

  it('generates meson compdb', async () => {
    const generated = new Set<string>();
    const io: CompdbIO = {
      existsSync: (p) => generated.has(p),
      mkdirSync: () => {},
      execFileAsync: async () => {
        generated.add('/project/.lore-compdb/compile_commands.json');
        return { stdout: '', stderr: '' };
      },
    };

    const result = await generateCompdb('/project', 'meson', 300_000, io);
    expect(result).toContain('compile_commands.json');
  });
});
