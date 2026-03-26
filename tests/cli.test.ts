import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Test-resource helpers ─────────────────────────────────────────────────────

let tmpDir: string;

function freshDb(): string {
  return nodePath.join(tmpDir, `cli-test-${Date.now()}.db`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Set process.argv, reset the module registry, and import cli.ts so that
 * main() re-executes. Returns once the module is evaluated (main() may still
 * be running asynchronously at that point).
 */
async function loadCli(args: string[], applyMocks?: () => void): Promise<void> {
  process.argv = ['node', 'lore', ...args];
  vi.resetModules();
  applyMocks?.();
  await import('../../src/cli.js');
}

/**
 * Poll process.stderr.write spy until the captured text includes `substring`,
 * or throw after `timeoutMs`.
 */
async function waitForStderr(
  stderrSpy: ReturnType<typeof vi.spyOn>,
  substring: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    if (text.includes(substring)) return;
    await new Promise<void>((r) => setTimeout(r, 20));
  }
  const text = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  throw new Error(
    `"${substring}" not found in stderr after ${timeoutMs}ms.\nActual: ${text}`,
  );
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (nodeFs.existsSync(path)) return;
    await new Promise<void>((r) => setTimeout(r, 20));
  }
  throw new Error(`"${path}" was not created within ${timeoutMs}ms`);
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (condition()) return;
    } catch {
      // Ignore transient state while async CLI work is still running.
    }
    await new Promise<void>((r) => setTimeout(r, 20));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms: ${description}`);
}

function readDocsPaths(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT path FROM docs ORDER BY path').all() as { path: string }[];
  db.close();
  return rows.map((row) => row.path);
}

function readKbMeta(dbPath: string, key: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT value FROM lore_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  db.close();
  return row?.value;
}

function mockIndexBuilderWithOptionsCapture(capture: (options: unknown) => void): void {
  const factory = () => ({
    IndexBuilder: class {
      constructor(
        _dbPath: string,
        _walkerConfig: unknown,
        _embedder: unknown,
        options: unknown,
      ) {
        capture(options);
      }

      async build(): Promise<void> {}
    },
  });

  const moduleIds = [
    '../../src/indexer/index.js',
    '../../src/indexer/index.ts',
    nodePath.join(process.cwd(), 'src/indexer/index.js'),
    nodePath.join(process.cwd(), 'src/indexer/index.ts'),
  ];

  for (const moduleId of moduleIds) {
    vi.doMock(moduleId, factory);
  }
}

const INDEXER_MODULE_IDS = [
  '../../src/indexer/index.js',
  '../../src/indexer/index.ts',
  nodePath.join(process.cwd(), 'src/indexer/index.js'),
  nodePath.join(process.cwd(), 'src/indexer/index.ts'),
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cli', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'lore-cli-test-'));

    // process.exit is mocked as a no-op so the test process does not actually
    // exit. This means code after a usage() call may continue, but the spy
    // records all calls so we can assert on exit codes.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const moduleId of INDEXER_MODULE_IDS) {
      vi.doUnmock(moduleId);
    }
    // Remove any SIGINT / SIGTERM listeners registered by the CLI during the
    // test so they do not accumulate across tests.
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    // Clean up temp dir
    nodeFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── MCP startup stat queries — regression for wrong table names ─────────


  // ── Usage / help ───────────────────────────────────────────────────────────

  describe('usage / help', () => {
    it('should print usage and exit with code 1 when no arguments are given', async () => {
      await loadCli([]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should print usage and exit with code 1 for --help', async () => {
      await loadCli(['--help']);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should print usage and exit with code 1 for -h', async () => {
      await loadCli(['-h']);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should print usage and exit with code 1 for an unknown subcommand', async () => {
      await loadCli(['unknown-cmd']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown subcommand'),
      );
    });
  });

  // ── mcp subcommand ─────────────────────────────────────────────────────────

  describe('mcp subcommand', () => {
    it('should print an error and exit with code 1 when neither --db nor --root is given', async () => {
      await loadCli(['mcp']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--root'),
      );
    });
  });

  // ── index subcommand — docs config flags ───────────────────────────────────

  describe('index subcommand — dependency indexing option', () => {
    it('should complete indexing when --index-deps is omitted', async () => {
      const dbPath = freshDb();
      await loadCli(['index', '--db', dbPath, '--root', tmpDir]);
      await waitForFile(dbPath);
      expect(nodeFs.existsSync(dbPath)).toBe(true);
    });

    it('should complete indexing when --index-deps is provided', async () => {
      const dbPath = freshDb();
      await loadCli(['index', '--db', dbPath, '--root', tmpDir, '--index-deps']);
      await waitForFile(dbPath);
      expect(nodeFs.existsSync(dbPath)).toBe(true);
    });
  });

  describe('index subcommand — max-workers option', () => {
    it('should pass maxWorkers to IndexBuilder when --max-workers is provided', async () => {
      const dbPath = freshDb();

      let capturedOptions: unknown;
      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir, '--max-workers', '2'],
        () => {
          mockIndexBuilderWithOptionsCapture((options) => {
            capturedOptions = options;
          });
        },
      );
      await vi.waitFor(() => {
        expect(capturedOptions).toBeDefined();
      });

      expect(capturedOptions).toMatchObject({ maxWorkers: 2 });
    });

    it('should not include maxWorkers in options when --max-workers is omitted', async () => {
      const dbPath = freshDb();

      let capturedOptions: unknown;
      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir],
        () => {
          mockIndexBuilderWithOptionsCapture((options) => {
            capturedOptions = options;
          });
        },
      );
      await vi.waitFor(() => {
        expect(capturedOptions).toBeDefined();
      });

      expect((capturedOptions as Record<string, unknown>).maxWorkers).toBeUndefined();
    });

    it('should print an error and exit with code 1 for non-integer --max-workers', async () => {
      await loadCli(['index', '--db', freshDb(), '--root', tmpDir, '--max-workers', 'abc']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--max-workers must be a positive integer'),
      );
    });

    it('should print an error and exit with code 1 for zero --max-workers', async () => {
      await loadCli(['index', '--db', freshDb(), '--root', tmpDir, '--max-workers', '0']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--max-workers must be a positive integer'),
      );
    });
  });

  describe('index subcommand — LSP config defaults', () => {
    it('should apply .lore.config LSP defaults when explicit flags are not provided', async () => {
      const dbPath = freshDb();
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, '.lore.config'),
        JSON.stringify({
          lsp: {
            enabled: true,
            timeoutMs: 4321,
            servers: {
              typescript: {
                command: 'custom-ts-ls',
                args: ['--stdio'],
              },
            },
          },
        }),
        'utf8',
      );

      let capturedOptions: unknown;
      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir],
        () => {
          mockIndexBuilderWithOptionsCapture((options) => {
            capturedOptions = options;
          });
        },
      );
      await vi.waitFor(() => {
        expect(capturedOptions).toBeDefined();
      });

      expect(capturedOptions).toMatchObject({
        lsp: {
          enabled: true,
          requestTimeoutMs: 4321,
          servers: {
            typescript: {
              command: 'custom-ts-ls',
              args: ['--stdio'],
            },
          },
        },
      });
    });

    it('should report an explicit error for malformed .lore.config LSP settings', async () => {
      const dbPath = freshDb();
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, '.lore.config'),
        JSON.stringify({
          lsp: {
            timeoutMs: 'fast',
          },
        }),
        'utf8',
      );

      await loadCli(['index', '--db', dbPath, '--root', tmpDir]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid .lore.config lsp settings'),
      );
    });

    it('should allow explicit --lsp to override .lore.config defaults', async () => {
      const dbPath = freshDb();
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, '.lore.config'),
        JSON.stringify({
          lsp: {
            enabled: false,
          },
        }),
        'utf8',
      );

      let capturedOptions: unknown;
      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir, '--lsp'],
        () => {
          mockIndexBuilderWithOptionsCapture((options) => {
            capturedOptions = options;
          });
        },
      );
      await vi.waitFor(() => {
        expect(capturedOptions).toBeDefined();
      });

      expect(capturedOptions).toMatchObject({
        lsp: {
          enabled: true,
        },
      });
    });

    it('should keep indexing successful when configured LSP server is unavailable and leave enrichment metadata empty', async () => {
      const dbPath = freshDb();
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, '.lore.config'),
        JSON.stringify({
          lsp: {
            enabled: true,
            timeoutMs: 800,
            servers: {
              typescript: {
                command: 'definitely-missing-language-server',
                args: ['--stdio'],
              },
            },
          },
        }),
        'utf8',
      );
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, 'main.ts'),
        'export function greet(name: string): string { return `hello ${name}`; }\n',
        'utf8',
      );

      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir],
        () => {
          for (const moduleId of INDEXER_MODULE_IDS) {
            vi.doUnmock(moduleId);
          }
        },
      );
      await waitForFile(dbPath);

      expect(exitSpy).not.toHaveBeenCalledWith(1);
      const db = new Database(dbPath, { readonly: true });
      const enrichedCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM symbols
             WHERE resolved_type_signature IS NOT NULL
                OR resolved_return_type IS NOT NULL
                OR definition_uri IS NOT NULL
                OR definition_path IS NOT NULL`,
          )
          .get() as { count: number }
      ).count;
      db.close();

      expect(enrichedCount).toBe(0);
    });
  });

  describe('refresh subcommand — LSP config defaults', () => {
    it('should apply .lore.config LSP defaults when explicit flags are not provided', async () => {
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, '.lore.config'),
        JSON.stringify({
          lsp: {
            enabled: true,
            timeoutMs: 7654,
            servers: {
              typescript: {
                command: 'custom-ts-ls',
              },
            },
          },
        }),
        'utf8',
      );

      let capturedOptions: unknown;
      await loadCli(
        ['refresh', '--db', freshDb(), '--root', tmpDir],
        () => {
          mockIndexBuilderWithOptionsCapture((options) => {
            capturedOptions = options;
          });
        },
      );
      await vi.waitFor(() => {
        expect(capturedOptions).toBeDefined();
      });

      expect(capturedOptions).toMatchObject({
        lsp: {
          enabled: true,
          requestTimeoutMs: 7654,
          servers: {
            typescript: {
              command: 'custom-ts-ls',
              args: ['--stdio'],
            },
          },
        },
      });
    });

    it('should report an explicit error for malformed .lore.config LSP settings', async () => {
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, '.lore.config'),
        JSON.stringify({
          lsp: {
            timeoutMs: 'bad',
          },
        }),
        'utf8',
      );

      await loadCli(['refresh', '--db', freshDb(), '--root', tmpDir]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid .lore.config lsp settings'),
      );
    });

  });

  // ── ingest-coverage subcommand ─────────────────────────────────────────────

  // ── hooks subcommand ───────────────────────────────────────────────────────

  describe('hooks subcommand', () => {
    it('should print an error and exit with code 1 when --db is missing', async () => {
      await loadCli(['hooks', '--root', tmpDir]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--db'),
      );
    });

    it('should print an error and exit with code 1 when --root is missing', async () => {
      await loadCli(['hooks', '--db', freshDb()]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--root'),
      );
    });

    it('should install hooks and emit a structured log line', async () => {
      nodeFs.mkdirSync(nodePath.join(tmpDir, '.git', 'hooks'), { recursive: true });
      const dbPath = freshDb();

      await loadCli(['hooks', '--db', dbPath, '--root', tmpDir]);
      await waitForStderr(stderrSpy, 'git hooks installed');

      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      const jsonLine = text.split('\n').find(
        (l) => l.includes('"git hooks installed"') && l.includes(tmpDir),
      );
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!.trim());
      expect(parsed.level).toBe('info');
      expect(parsed.source).toBe('cli');
      expect(parsed.message).toBe('git hooks installed');
    });

    it('should apply .lore.config LSP defaults to generated hook refresh commands', async () => {
      nodeFs.mkdirSync(nodePath.join(tmpDir, '.git', 'hooks'), { recursive: true });
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, '.lore.config'),
        JSON.stringify({ lsp: { enabled: true } }),
        'utf8',
      );

      const dbPath = freshDb();
      await loadCli(['hooks', '--db', dbPath, '--root', tmpDir]);
      await waitForStderr(stderrSpy, 'git hooks installed');

      const hookPath = nodePath.join(tmpDir, '.git', 'hooks', 'post-commit');
      const hookContent = nodeFs.readFileSync(hookPath, 'utf8');
      expect(hookContent).toContain('--lsp');
      expect(hookContent).not.toContain('--no-lsp');
    });

    it('should allow explicit --lsp to override .lore.config defaults for hook generation', async () => {
      nodeFs.mkdirSync(nodePath.join(tmpDir, '.git', 'hooks'), { recursive: true });
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, '.lore.config'),
        JSON.stringify({ lsp: { enabled: false } }),
        'utf8',
      );

      const dbPath = freshDb();
      await loadCli(['hooks', '--db', dbPath, '--root', tmpDir, '--lsp']);
      await waitForStderr(stderrSpy, 'git hooks installed');

      const hookPath = nodePath.join(tmpDir, '.git', 'hooks', 'post-commit');
      const hookContent = nodeFs.readFileSync(hookPath, 'utf8');
      expect(hookContent).toContain('--lsp');
      expect(hookContent).not.toContain('--no-lsp');
    });

    it('should not emit --no-lsp in hook command when lspEnabled is false (LSP off is the default)', async () => {
      nodeFs.mkdirSync(nodePath.join(tmpDir, '.git', 'hooks'), { recursive: true });
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, '.lore.config'),
        JSON.stringify({ lsp: { enabled: true } }),
        'utf8',
      );

      const dbPath = freshDb();
      await loadCli(['hooks', '--db', dbPath, '--root', tmpDir]);
      await waitForStderr(stderrSpy, 'git hooks installed');

      const hookPath = nodePath.join(tmpDir, '.git', 'hooks', 'post-commit');
      const hookContent = nodeFs.readFileSync(hookPath, 'utf8');
      expect(hookContent).not.toContain('--no-lsp');
    });

    it('should report an explicit error for malformed .lore.config LSP settings', async () => {
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, '.lore.config'),
        JSON.stringify({ lsp: { timeoutMs: 'invalid' } }),
        'utf8',
      );

      await loadCli(['hooks', '--db', freshDb(), '--root', tmpDir]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid .lore.config lsp settings'),
      );
    });

  });

  // ── refresh subcommand — argument validation ───────────────────────────────

  describe('refresh subcommand — argument validation', () => {
    it('should print an error and exit with code 1 when --db is missing', async () => {
      await loadCli(['refresh', '--root', tmpDir]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--db'),
      );
    });

    it('should print an error and exit with code 1 when --root is missing', async () => {
      await loadCli(['refresh', '--db', freshDb()]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--root'),
      );
    });

    it('should print an error and exit with code 1 when both --db and --root are missing', async () => {
      await loadCli(['refresh']);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── refresh subcommand — manual mode ──────────────────────────────────────

  describe('refresh subcommand — manual mode', () => {

    it('should complete refresh when --index-deps is provided', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir, '--index-deps']);
      await waitForStderr(stderrSpy, 'refresh complete');
      expect(nodeFs.existsSync(dbPath)).toBe(true);
    });

    it('should write a structured info log to stderr and exit cleanly when the DB does not yet exist', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir]);
      await waitForStderr(stderrSpy, tmpDir);

      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      const jsonLine = text.split('\n').find(
        (l) => l.includes('"refresh complete"') && l.includes(tmpDir),
      );
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!.trim());
      expect(parsed.level).toBe('info');
      expect(parsed.source).toBe('cli');
      expect(parsed.message).toBe('refresh complete');
      expect(parsed.rootDir).toBe(tmpDir);
    });

    it('should create the DB file on a first-time (build) refresh', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir]);
      await waitForStderr(stderrSpy, 'refresh complete');

      expect(nodeFs.existsSync(dbPath)).toBe(true);
    });

    it('should remove stale DB rows for files deleted before a manual refresh update', async () => {
      const dbPath = freshDb();
      const filePath = nodePath.join(tmpDir, 'deleted.ts');
      nodeFs.writeFileSync(filePath, 'export const x = 1;\n', 'utf8');

      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir]);
      await waitForStderr(stderrSpy, 'refresh complete');

      let db = new Database(dbPath, { readonly: true });
      let row = db.prepare('SELECT path FROM files WHERE path = ?').get(filePath) as { path: string } | undefined;
      db.close();
      expect(row?.path).toBe(filePath);

      nodeFs.unlinkSync(filePath);
      stderrSpy.mockClear();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir]);
      await waitForStderr(stderrSpy, 'refresh complete');

      db = new Database(dbPath, { readonly: true });
      // In the overlay model, deleted files are marked dirty and excluded
      // from effective_files, even though the baseline row still exists.
      const viewExists = (db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'view' AND name = 'effective_files' LIMIT 1").get() as { ok: number } | undefined)?.ok === 1;
      const table = viewExists ? 'effective_files' : 'files';
      row = db.prepare(`SELECT path FROM ${table} WHERE path = ?`).get(filePath) as { path: string } | undefined;
      db.close();
      expect(row).toBeUndefined();
    });
  });

  // ── refresh subcommand — watch mode ───────────────────────────────────────

  describe('refresh subcommand — watch mode (--watch)', () => {
    it('should write a structured info log to stderr when watch mode starts', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir, '--watch']);
      await waitForStderr(stderrSpy, tmpDir);

      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      const jsonLine = text.split('\n').find(
        (l) => l.includes('"watch mode started"') && l.includes(tmpDir),
      );
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!.trim());
      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('watch mode started');
      expect(parsed.rootDir).toBe(tmpDir);

      // Clean up: trigger the registered SIGINT handler to stop the watcher.
      process.emit('SIGINT');
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    });

    it('should NOT immediately exit when watch mode starts (process stays alive)', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir, '--watch']);
      await waitForStderr(stderrSpy, 'watch mode started');

      // exitSpy should not have been called yet (watch mode keeps running)
      expect(exitSpy).not.toHaveBeenCalled();

      // Clean up
      process.emit('SIGINT');
    });

    it('should call process.exit(0) when SIGINT is received', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir, '--watch']);
      await waitForStderr(stderrSpy, 'watch mode started');

      process.emit('SIGINT');
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    });

    it('should call process.exit(0) when SIGTERM is received', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir, '--watch']);
      await waitForStderr(stderrSpy, 'watch mode started');

      process.emit('SIGTERM');
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    });
  });

  // ── refresh subcommand — poll mode ────────────────────────────────────────

  describe('refresh subcommand — poll mode (--poll)', () => {
    it('should write a structured info log to stderr when poll mode starts', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir, '--poll']);
      await waitForStderr(stderrSpy, tmpDir);

      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      const jsonLine = text.split('\n').find(
        (l) => l.includes('"poll mode started"') && l.includes(tmpDir),
      );
      expect(jsonLine).toBeDefined();
      const parsed = JSON.parse(jsonLine!.trim());
      expect(parsed.level).toBe('info');
      expect(parsed.message).toBe('poll mode started');
      expect(parsed.rootDir).toBe(tmpDir);

      process.emit('SIGINT');
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    });

    it('should NOT immediately exit when poll mode starts (process stays alive)', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir, '--poll']);
      await waitForStderr(stderrSpy, 'poll mode started');

      expect(exitSpy).not.toHaveBeenCalled();

      process.emit('SIGINT');
    });

    it('should call process.exit(0) when SIGINT is received', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir, '--poll']);
      await waitForStderr(stderrSpy, 'poll mode started');

      process.emit('SIGINT');
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    });

    it('should call process.exit(0) when SIGTERM is received', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir, '--poll']);
      await waitForStderr(stderrSpy, 'poll mode started');

      process.emit('SIGTERM');
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    });
  });

  // ── index subcommand — error paths ─────────────────────────────────────────

  describe('index subcommand — error paths', () => {
    it('should error when --root is missing', async () => {
      await loadCli(['index', '--db', freshDb()]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--root'),
      );
    });

    it('should error when --db is missing', async () => {
      await loadCli(['index', '--root', tmpDir]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--db'),
      );
    });

    it('should error when --embeddings and --no-embeddings are both specified', async () => {
      await loadCli(['index', '--db', freshDb(), '--root', tmpDir, '--embeddings', '--no-embeddings']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--embeddings and --no-embeddings cannot be used together'),
      );
    });

    it('should error when --history-depth has an invalid value', async () => {
      await loadCli(['index', '--db', freshDb(), '--root', tmpDir, '--history-depth', 'abc']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--history-depth must be a positive number'),
      );
    });

    it('should error when --history-depth is zero', async () => {
      await loadCli(['index', '--db', freshDb(), '--root', tmpDir, '--history-depth', '0']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--history-depth must be a positive number'),
      );
    });

    it('should error when --history-depth is negative', async () => {
      await loadCli(['index', '--db', freshDb(), '--root', tmpDir, '--history-depth', '-5']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--history-depth must be a positive number'),
      );
    });

    it('should error when --language specifies an unknown language', async () => {
      await loadCli(['index', '--db', freshDb(), '--root', tmpDir, '--language', 'brainfuck']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('unknown language "brainfuck"'),
      );
    });

    it('should pass language extensions when --language is valid', async () => {
      const dbPath = freshDb();
      let capturedWalker: unknown;
      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir, '--language', 'typescript'],
        () => {
          const factory = () => ({
            IndexBuilder: class {
              constructor(_dbPath: string, walkerConfig: unknown) {
                capturedWalker = walkerConfig;
              }
              async build(): Promise<void> {}
            },
          });
          for (const moduleId of INDEXER_MODULE_IDS) {
            vi.doMock(moduleId, factory);
          }
        },
      );
      await vi.waitFor(() => {
        expect(capturedWalker).toBeDefined();
      });
      expect((capturedWalker as Record<string, unknown>).extensions).toEqual(['.ts', '.tsx']);
    });

    it('should pass history options when --history and --history-depth are provided', async () => {
      const dbPath = freshDb();
      let capturedOptions: unknown;
      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir, '--history', '--history-depth', '10'],
        () => {
          mockIndexBuilderWithOptionsCapture((options) => {
            capturedOptions = options;
          });
        },
      );
      await vi.waitFor(() => {
        expect(capturedOptions).toBeDefined();
      });
      expect(capturedOptions).toMatchObject({
        history: { depth: 10 },
      });
    });

    it('should pass history.all when --history-all is provided', async () => {
      const dbPath = freshDb();
      let capturedOptions: unknown;
      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir, '--history-all'],
        () => {
          mockIndexBuilderWithOptionsCapture((options) => {
            capturedOptions = options;
          });
        },
      );
      await vi.waitFor(() => {
        expect(capturedOptions).toBeDefined();
      });
      expect(capturedOptions).toMatchObject({
        history: { all: true },
      });
    });

    it('should pass include and exclude globs', async () => {
      const dbPath = freshDb();
      let capturedWalker: unknown;
      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir, '--include', 'src/**', '--exclude', 'node_modules/**'],
        () => {
          const factory = () => ({
            IndexBuilder: class {
              constructor(_dbPath: string, walkerConfig: unknown) {
                capturedWalker = walkerConfig;
              }
              async build(): Promise<void> {}
            },
          });
          for (const moduleId of INDEXER_MODULE_IDS) {
            vi.doMock(moduleId, factory);
          }
        },
      );
      await vi.waitFor(() => {
        expect(capturedWalker).toBeDefined();
      });
      expect((capturedWalker as Record<string, unknown>).includeGlobs).toEqual(['src/**']);
      expect((capturedWalker as Record<string, unknown>).excludeGlobs).toEqual(['node_modules/**']);
    });

    it('should pass embeddingsEnabled when --embeddings is provided', async () => {
      const dbPath = freshDb();
      let capturedEmbedder: unknown;
      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir, '--embeddings'],
        () => {
          const factory = () => ({
            IndexBuilder: class {
              constructor(_dbPath: string, _walkerConfig: unknown, embedder: unknown) {
                capturedEmbedder = embedder;
              }
              async build(): Promise<void> {}
            },
          });
          for (const moduleId of INDEXER_MODULE_IDS) {
            vi.doMock(moduleId, factory);
          }
        },
      );
      await vi.waitFor(() => {
        expect(capturedEmbedder).toBeDefined();
      });
    });

    it('should pass scip disabled when --no-scip is provided', async () => {
      const dbPath = freshDb();
      let capturedOptions: unknown;
      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir, '--no-scip'],
        () => {
          mockIndexBuilderWithOptionsCapture((options) => {
            capturedOptions = options;
          });
        },
      );
      await vi.waitFor(() => {
        expect(capturedOptions).toBeDefined();
      });
      expect((capturedOptions as Record<string, unknown>).scip).toMatchObject({
        enabled: false,
      });
    });

    it('should pass history options when only --history is provided', async () => {
      const dbPath = freshDb();
      let capturedOptions: unknown;
      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir, '--history'],
        () => {
          mockIndexBuilderWithOptionsCapture((options) => {
            capturedOptions = options;
          });
        },
      );
      await vi.waitFor(() => {
        expect(capturedOptions).toBeDefined();
      });
      expect(capturedOptions).toHaveProperty('history');
    });

    it('should report an explicit error for malformed .lore.config SCIP settings', async () => {
      const dbPath = freshDb();
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, '.lore.config'),
        JSON.stringify({
          scip: {
            timeoutMs: 'fast',
          },
        }),
        'utf8',
      );

      await loadCli(['index', '--db', dbPath, '--root', tmpDir]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error'),
      );
    });

    it('should set embedding model from --embedding-model flag', async () => {
      const dbPath = freshDb();
      let capturedOptions: unknown;
      await loadCli(
        ['index', '--db', dbPath, '--root', tmpDir, '--embedding-model', 'test-model'],
        () => {
          mockIndexBuilderWithOptionsCapture((options) => {
            capturedOptions = options;
          });
        },
      );
      await vi.waitFor(() => {
        expect(capturedOptions).toBeDefined();
      });
      expect(capturedOptions).toMatchObject({
        embeddingModel: 'test-model',
      });
    });
  });

  // ── analyze subcommand ─────────────────────────────────────────────────────

  describe('analyze subcommand', () => {
    it('should error when --db is missing', async () => {
      await loadCli(['analyze']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--db'),
      );
    });

    it('should error with invalid --mode', async () => {
      const dbPath = freshDb();
      await loadCli(['analyze', '--db', dbPath, '--mode', 'invalid']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--mode must be one of'),
      );
    });

    it('should error with invalid --edge-kinds', async () => {
      const dbPath = freshDb();
      await loadCli(['analyze', '--db', dbPath, '--edge-kinds', 'invalid']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--edge-kinds must be one of'),
      );
    });

    it('should error with invalid --max-lines', async () => {
      const dbPath = freshDb();
      await loadCli(['analyze', '--db', dbPath, '--max-lines', 'abc']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--max-lines must be a positive number'),
      );
    });

    it('should error when --max-lines is zero', async () => {
      const dbPath = freshDb();
      await loadCli(['analyze', '--db', dbPath, '--max-lines', '0']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--max-lines must be a positive number'),
      );
    });

    it('should run cycles mode on a pre-indexed DB', async () => {
      // Create a minimal indexed DB
      const dbPath = freshDb();
      await loadCli(['index', '--db', dbPath, '--root', tmpDir]);
      await waitForFile(dbPath);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      stderrSpy.mockClear();
      consoleErrorSpy.mockClear();
      exitSpy.mockClear();

      await loadCli(['analyze', '--db', dbPath, '--mode', 'cycles']);

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled();
      });
      const output = consoleSpy.mock.calls[0]?.[0] as string;
      expect(() => JSON.parse(output)).not.toThrow();
      consoleSpy.mockRestore();
    });

    it('should run summary mode by default on a pre-indexed DB', async () => {
      const dbPath = freshDb();
      await loadCli(['index', '--db', dbPath, '--root', tmpDir]);
      await waitForFile(dbPath);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      stderrSpy.mockClear();
      consoleErrorSpy.mockClear();
      exitSpy.mockClear();

      await loadCli(['analyze', '--db', dbPath]);

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled();
      });
      const output = consoleSpy.mock.calls[0]?.[0] as string;
      expect(() => JSON.parse(output)).not.toThrow();
      consoleSpy.mockRestore();
    });

    it('should run components mode on a pre-indexed DB', async () => {
      const dbPath = freshDb();
      await loadCli(['index', '--db', dbPath, '--root', tmpDir]);
      await waitForFile(dbPath);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      stderrSpy.mockClear();
      consoleErrorSpy.mockClear();
      exitSpy.mockClear();

      await loadCli(['analyze', '--db', dbPath, '--mode', 'components']);

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled();
      });
      consoleSpy.mockRestore();
    });

    it('should run clusters mode with --max-lines on a pre-indexed DB', async () => {
      const dbPath = freshDb();
      await loadCli(['index', '--db', dbPath, '--root', tmpDir]);
      await waitForFile(dbPath);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      stderrSpy.mockClear();
      consoleErrorSpy.mockClear();
      exitSpy.mockClear();

      await loadCli(['analyze', '--db', dbPath, '--mode', 'clusters', '--max-lines', '100']);

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled();
      });
      consoleSpy.mockRestore();
    });
  });

  // ── install-scip subcommand ────────────────────────────────────────────────

  describe('install-scip subcommand', () => {
    it('should list available indexers with --list flag', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await loadCli(['install-scip', '--list']);
      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled();
      });
      // Should have printed at least one indexer line
      expect(consoleSpy.mock.calls.length).toBeGreaterThan(0);
      consoleSpy.mockRestore();
    });

    it('should attempt installation and report results', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await loadCli(['install-scip', '--language', 'typescript']);
      await vi.waitFor(() => {
        const allOutput = consoleSpy.mock.calls.map(c => String(c[0])).join('\n');
        expect(allOutput).toMatch(/\d+ installed, \d+ unavailable/u);
      }, { timeout: 30_000 });
      consoleSpy.mockRestore();
    });
  });

  // ── mcp subcommand — extended paths ────────────────────────────────────────

  describe('mcp subcommand — extended paths', () => {
    it('should error when --db points to a non-existent file without --root', async () => {
      const nonExistent = nodePath.join(tmpDir, 'nonexistent-test.db');
      await loadCli(['mcp', '--db', nonExistent]);
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(1);
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('database file not found'),
      );
    });
  });

  // ── refresh subcommand — history-depth error paths ─────────────────────────

  describe('refresh subcommand — history-depth errors', () => {
    it('should error when refresh --history-depth is invalid', async () => {
      await loadCli(['refresh', '--db', freshDb(), '--root', tmpDir, '--history-depth', 'abc']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--history-depth must be a positive number'),
      );
    });

    it('should error when refresh --history-depth is zero', async () => {
      await loadCli(['refresh', '--db', freshDb(), '--root', tmpDir, '--history-depth', '0']);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
