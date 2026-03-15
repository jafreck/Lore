import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import {
  findExistingCompdb,
  detectBuildSystem,
  ensureCompilationDatabase,
  generateCompdb,
  type CompdbIO,
} from '../../src/scip/compdb.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockCompdbIO(overrides: Partial<CompdbIO> = {}): CompdbIO {
  return {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    execFileAsync: vi.fn(async () => ({ stdout: '', stderr: '' })),
    ...overrides,
  };
}

// ─── findExistingCompdb ───────────────────────────────────────────────────────

describe('findExistingCompdb', () => {
  it('returns null when no compile_commands.json found', () => {
    const io = { existsSync: vi.fn(() => false) };
    expect(findExistingCompdb('/project', io)).toBeNull();
  });

  it('finds compile_commands.json at project root', () => {
    const io = { existsSync: vi.fn((p: string) => p === join('/project', 'compile_commands.json')) };
    expect(findExistingCompdb('/project', io)).toBe(join('/project', 'compile_commands.json'));
  });

  it('finds compile_commands.json in build/', () => {
    const io = { existsSync: vi.fn((p: string) => p === join('/project', 'build', 'compile_commands.json')) };
    expect(findExistingCompdb('/project', io)).toBe(join('/project', 'build', 'compile_commands.json'));
  });

  it('finds compile_commands.json in builddir/', () => {
    const io = { existsSync: vi.fn((p: string) => p === join('/project', 'builddir', 'compile_commands.json')) };
    expect(findExistingCompdb('/project', io)).toBe(join('/project', 'builddir', 'compile_commands.json'));
  });

  it('finds compile_commands.json in .lore-compdb/', () => {
    const io = { existsSync: vi.fn((p: string) => p === join('/project', '.lore-compdb', 'compile_commands.json')) };
    expect(findExistingCompdb('/project', io)).toBe(join('/project', '.lore-compdb', 'compile_commands.json'));
  });

  it('returns first match in priority order', () => {
    // Both root and builddir exist — root comes first
    const io = { existsSync: vi.fn((p: string) =>
      p === join('/project', 'compile_commands.json') || p === join('/project', 'builddir', 'compile_commands.json'),
    )};
    expect(findExistingCompdb('/project', io)).toBe(join('/project', 'compile_commands.json'));
  });
});

// ─── detectBuildSystem ────────────────────────────────────────────────────────

describe('detectBuildSystem', () => {
  it('returns cmake when CMakeLists.txt exists', () => {
    const io = { existsSync: vi.fn((p: string) => p === join('/project', 'CMakeLists.txt')) };
    expect(detectBuildSystem('/project', io)).toBe('cmake');
  });

  it('returns meson when meson.build exists', () => {
    const io = { existsSync: vi.fn((p: string) => p === join('/project', 'meson.build')) };
    expect(detectBuildSystem('/project', io)).toBe('meson');
  });

  it('returns make when Makefile exists', () => {
    const io = { existsSync: vi.fn((p: string) => p === join('/project', 'Makefile')) };
    expect(detectBuildSystem('/project', io)).toBe('make');
  });

  it('returns make when configure exists', () => {
    const io = { existsSync: vi.fn((p: string) => p === join('/project', 'configure')) };
    expect(detectBuildSystem('/project', io)).toBe('make');
  });

  it('returns none when no build system detected', () => {
    const io = { existsSync: vi.fn(() => false) };
    expect(detectBuildSystem('/project', io)).toBe('none');
  });

  it('cmake takes priority over meson', () => {
    const io = { existsSync: vi.fn((p: string) =>
      p === join('/project', 'CMakeLists.txt') || p === join('/project', 'meson.build'),
    )};
    expect(detectBuildSystem('/project', io)).toBe('cmake');
  });
});

// ─── generateCompdb ───────────────────────────────────────────────────────────

describe('generateCompdb', () => {
  it('cmake: runs cmake with correct flags', async () => {
    const io = createMockCompdbIO({
      existsSync: vi.fn((p: string) => p.endsWith('compile_commands.json')),
    });
    const result = await generateCompdb('/project', 'cmake', 60000, io);
    expect(result).toBe(join('/project', '.lore-compdb', 'compile_commands.json'));
    expect(io.mkdirSync).toHaveBeenCalled();
    expect(io.execFileAsync).toHaveBeenCalledWith(
      'cmake',
      expect.arrayContaining(['-DCMAKE_EXPORT_COMPILE_COMMANDS=ON']),
      expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('cmake: returns null when output not created', async () => {
    const io = createMockCompdbIO();
    const result = await generateCompdb('/project', 'cmake', 60000, io);
    expect(result).toBeNull();
  });

  it('meson: runs meson setup with builddir', async () => {
    const io = createMockCompdbIO({
      existsSync: vi.fn((p: string) => p.endsWith('compile_commands.json') && p.includes('.lore-compdb')),
    });
    const result = await generateCompdb('/project', 'meson', 60000, io);
    expect(result).toBe(join('/project', '.lore-compdb', 'compile_commands.json'));
    expect(io.execFileAsync).toHaveBeenCalledWith(
      'meson',
      ['setup', join('/project', '.lore-compdb')],
      expect.objectContaining({ cwd: '/project' }),
    );
  });

  it('meson: reuses existing configured build dir', async () => {
    const io = createMockCompdbIO({
      existsSync: vi.fn((p: string) =>
        p.endsWith('meson-private') || (p.endsWith('compile_commands.json') && p.includes('.lore-compdb')),
      ),
    });
    const result = await generateCompdb('/project', 'meson', 60000, io);
    expect(result).toBe(join('/project', '.lore-compdb', 'compile_commands.json'));
    // Should NOT have called meson setup since meson-private exists and compile_commands.json exists
    expect(io.execFileAsync).not.toHaveBeenCalled();
  });

  it('make: checks for bear availability', async () => {
    const io = createMockCompdbIO({
      execFileAsync: vi.fn(async (cmd: string) => {
        if (cmd === 'bear' && arguments[1]?.[0] === '--version') return { stdout: 'bear 4.0', stderr: '' };
        throw new Error('bear not found');
      }),
    });
    // bear --version check will throw, so should return null
    const result = await generateCompdb('/project', 'make', 60000, io);
    expect(result).toBeNull();
  });

  it('make: runs bear when available', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const io = createMockCompdbIO({
      execFileAsync: vi.fn(async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return { stdout: '', stderr: '' };
      }),
      existsSync: vi.fn((p: string) => p.endsWith('compile_commands.json') && !p.includes('.lore-compdb')),
    });
    const result = await generateCompdb('/project', 'make', 60000, io);
    expect(result).toBe(join('/project', 'compile_commands.json'));
    expect(calls.some((c) => c.cmd === 'bear')).toBe(true);
  });

  it('returns null for unknown build system', async () => {
    const io = createMockCompdbIO();
    const result = await generateCompdb('/project', 'none', 60000, io);
    expect(result).toBeNull();
  });
});

// ─── ensureCompilationDatabase ────────────────────────────────────────────────

describe('ensureCompilationDatabase', () => {
  it('returns pre-existing compile_commands.json', async () => {
    const io = createMockCompdbIO({
      existsSync: vi.fn((p: string) => p.endsWith('compile_commands.json') && !p.includes('build')),
    });
    const result = await ensureCompilationDatabase('/project', 60000, io);
    expect(result.preExisting).toBe(true);
    expect(result.path).toBeTruthy();
  });

  it('returns none when no build system detected and no existing compdb', async () => {
    const io = createMockCompdbIO();
    const result = await ensureCompilationDatabase('/project', 60000, io);
    expect(result.buildSystem).toBe('none');
    expect(result.path).toBeNull();
  });

  it('generates compdb for cmake project', async () => {
    let cmakeRan = false;
    const io = createMockCompdbIO({
      existsSync: vi.fn((p: string) => {
        if (p.endsWith('CMakeLists.txt')) return true;
        // Only find compile_commands.json AFTER cmake has run, and only in .lore-compdb
        if (cmakeRan && p.endsWith('compile_commands.json') && p.includes('.lore-compdb')) return true;
        return false;
      }),
      execFileAsync: vi.fn(async () => { cmakeRan = true; return { stdout: '', stderr: '' }; }),
    });
    const result = await ensureCompilationDatabase('/project', 60000, io);
    expect(result.buildSystem).toBe('cmake');
    expect(result.path).toBeTruthy();
    expect(result.preExisting).toBe(false);
  });

  it('handles generation failure gracefully', async () => {
    const io = createMockCompdbIO({
      existsSync: vi.fn((p: string) => p.endsWith('meson.build')),
      execFileAsync: vi.fn(async () => { throw new Error('meson not found'); }),
    });
    const result = await ensureCompilationDatabase('/project', 60000, io);
    expect(result.buildSystem).toBe('meson');
    expect(result.path).toBeNull();
  });
});
