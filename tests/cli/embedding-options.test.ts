import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runIndexCommand } from '../../src/cli/commands/index-cmd.js';
import { runRefreshCommand } from '../../src/cli/commands/refresh-cmd.js';
import type { LoreLogger } from '../../src/logger.js';

const mocks = vi.hoisted(() => ({
  constructorArgs: [] as unknown[][],
  build: vi.fn().mockResolvedValue(undefined),
  refresh: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/indexer/index.js', () => ({
  IndexBuilder: vi.fn().mockImplementation(function (this: Record<string, unknown>, ...args: unknown[]) {
    mocks.constructorArgs.push(args);
    this.build = mocks.build;
    this.refresh = mocks.refresh;
  }),
}));

const logger = {} as LoreLogger;

describe('CLI embedding policy forwarding', () => {
  beforeEach(() => {
    mocks.constructorArgs.length = 0;
    vi.clearAllMocks();
  });

  it.each([
    ['default', []],
    ['explicit --no-embeddings', ['--no-embeddings']],
  ] as const)('makes index %s suppress persisted model reuse', async (_label, embeddingArgs) => {
    await runIndexCommand([
      'index', '--root', '/repo', '--db', '/tmp/lore.db', ...embeddingArgs,
    ], logger);

    expect(mocks.build).toHaveBeenCalledOnce();
    expect(mocks.constructorArgs[0]?.[2]).toBeUndefined();
    expect(mocks.constructorArgs[0]?.[3]).toMatchObject({ embeddings: false });
  });

  it('forwards --no-embeddings to one-shot refresh', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runRefreshCommand([
        'refresh', '--root', '/repo', '--db', '/tmp/lore.db', '--no-embeddings',
      ], logger);
    } finally {
      stderr.mockRestore();
    }

    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.constructorArgs[0]?.[3]).toMatchObject({ embeddings: false });
  });

  it('leaves refresh embedding policy unset when no embedding flag is supplied', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await runRefreshCommand([
        'refresh', '--root', '/repo', '--db', '/tmp/lore.db',
      ], logger);
    } finally {
      stderr.mockRestore();
    }

    expect(mocks.constructorArgs[0]?.[3]).not.toHaveProperty('embeddings');
  });
});
