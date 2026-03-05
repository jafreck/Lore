import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EffectiveLspSettings,
  InstallGitHooksOptions,
  LspSettingsOverrides,
  PollerOptions,
  WatcherOptions,
} from '../../../src/index.js';

const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockIndexBuilder = vi.hoisted(() =>
  vi.fn(function (this: Record<string, unknown>) {
    this.update = mockUpdate;
  }),
);
const mockWatch = vi.hoisted(() => vi.fn());
const mockStatSync = vi.hoisted(() => vi.fn());
const mockWalkFiles = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  watch: mockWatch,
  statSync: mockStatSync,
}));

vi.mock('../../../src/indexer/index.js', () => ({
  IndexBuilder: mockIndexBuilder,
}));

vi.mock('../../../src/indexer/walker.js', () => ({
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
    mockStatSync.mockReturnValue({ mtimeMs: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards effective LSP and dependency options in FileWatcher updates', async () => {
    const { FileWatcher } = await import('../../../src/indexer/watcher.js');
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
    const { FilePoller } = await import('../../../src/indexer/poller.js');
    mockWalkFiles.mockResolvedValue([{ path: '/tmp/testroot/a.ts' }]);
    mockStatSync.mockReturnValue({ mtimeMs: 2000 });

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
      dbPath: '/tmp/repo/kb.db',
      lspEnabled: false,
    };

    expect(watcherOptions.lsp?.enabled).toBe(true);
    expect(pollerOptions.lsp?.requestTimeoutMs).toBe(3456);
    expect(lspOverrides.enabled).toBe(false);
    expect(lspOverrides.requestTimeoutMs).toBe(1200);
    expect(hookOptions.lspEnabled).toBe(false);
  });
});
