import { describe, it, expect } from 'vitest';

/**
 * Smoke tests verifying that the public entry point exports all symbols
 * added in the file-watcher / file-poller feature.
 *
 * We intentionally test only the shape of the exports (class constructors,
 * type-level checks) without exercising I/O behaviour — that is covered in
 * the dedicated watcher.test.ts and poller.test.ts suites.
 */

describe('src/index.ts — public exports', () => {
  it('should export FileWatcher as a constructor', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.FileWatcher).toBe('function');
  });

  it('should export FilePoller as a constructor', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.FilePoller).toBe('function');
  });

  it('should not have removed any pre-existing exports', async () => {
    const mod = await import('../src/index.js');
    // Spot-check a few of the originally-present symbols
    expect(typeof mod.IndexBuilder).toBe('function');
    expect(typeof mod.walkFiles).toBe('function');
    expect(typeof mod.openDb).toBe('function');
  });
});
