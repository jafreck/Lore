import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EffectiveLspSettings,
  InstallGitHooksOptions,
  LspSettingsOverrides,
  PollerOptions,
  WatcherOptions,
} from '../../src/index.js';

const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockIndexBuilder = vi.hoisted(() =>
  vi.fn(function (this: Record<string, unknown>) {
    this.update = mockUpdate;
  }),
);
const mockWatch = vi.hoisted(() => vi.fn());
const mockStat = vi.hoisted(() => vi.fn());
const mockWalkFiles = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  watch: mockWatch,
  promises: {
    stat: mockStat,
  },
}));

vi.mock('../../src/indexer/index.js', () => ({
  IndexBuilder: mockIndexBuilder,
}));

vi.mock('../../src/discovery/walker.js', () => ({
  walkFiles: mockWalkFiles,
}));

const walkerConfig = { rootDir: '/tmp/testroot' };

const lspSettings: EffectiveLspSettings = {
  enabled: true,
  requestTimeoutMs: 3456,
  servers: {},
};

describe('refresh option propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockUpdate.mockResolvedValue(undefined);
    mockWalkFiles.mockResolvedValue([]);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards effective LSP and dependency options in FileWatcher updates', async () => {
    const { FileWatcher } = await import('../../src/discovery/watcher.js');
    mockWatch.mockReturnValue({ on: vi.fn(), close: vi.fn() });

    const options: WatcherOptions = {
      debounceMs: 25,
      history: { depth: 2, all: true },
      indexDependencies: true,
      lsp: lspSettings,
    };
    const watcher = new FileWatcher('/db.sqlite', walkerConfig, options);

    watcher.start();
    const onFsEvent = mockWatch.mock.calls[0]?.[2] as (event: string, filename: string) => void;
    onFsEvent('change', 'a.ts');
    await vi.advanceTimersByTimeAsync(25);
    watcher.stop();

    expect(mockIndexBuilder).toHaveBeenCalledWith('/db.sqlite', walkerConfig, undefined, {
      history: options.history,
      indexDependencies: true,
      lsp: lspSettings,
    });
  });

  it('forwards effective LSP and dependency options in FilePoller updates', async () => {
    const { FilePoller } = await import('../../src/discovery/poller.js');
    mockWalkFiles.mockResolvedValue([{ path: '/tmp/testroot/a.ts' }]);
    mockStat.mockResolvedValue({ mtimeMs: 2000 });

    const options: PollerOptions = {
      intervalMs: 25,
      history: { depth: 3 },
      indexDependencies: true,
      lsp: lspSettings,
    };
    const poller = new FilePoller('/db.sqlite', walkerConfig, options);

    poller.start();
    await vi.advanceTimersByTimeAsync(25);
    poller.stop();

    expect(mockIndexBuilder).toHaveBeenCalledWith('/db.sqlite', walkerConfig, undefined, {
      history: options.history,
      indexDependencies: true,
      lsp: lspSettings,
    });
  });

  it('exposes LSP option types from the public entrypoint', () => {
    const watcherOptions: WatcherOptions = { lsp: lspSettings, indexDependencies: true };
    const pollerOptions: PollerOptions = { lsp: lspSettings, indexDependencies: true };
    const lspOverrides: LspSettingsOverrides = { enabled: false, requestTimeoutMs: 1200 };
    const hookOptions: InstallGitHooksOptions = {
      repoRoot: '/tmp/repo',
      rootDir: '/tmp/repo',
      dbPath: '/tmp/repo/lore.db',
      lspEnabled: false,
    };

    expect(watcherOptions.lsp?.enabled).toBe(true);
    expect(pollerOptions.lsp?.requestTimeoutMs).toBe(3456);
    expect(lspOverrides.enabled).toBe(false);
    expect(lspOverrides.requestTimeoutMs).toBe(1200);
    expect(hookOptions.lspEnabled).toBe(false);
  });
});
