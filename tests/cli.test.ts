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

  describe('mcp startup stat queries', () => {
    it('should query symbol_refs and docs tables without error against a real schema', async () => {
      // Regression: cli.ts previously used non-existent table names
      // "call_graph" and "documentation", silently reporting 0 edges/docs.
      const { openDb } = await import('../../src/db/schema.js');
      const dbPath = freshDb();
      const db = openDb(dbPath);

      // These are the exact queries from the MCP startup path in cli.ts.
      // They must not throw against the real schema.
      const totalFiles = (db.prepare('SELECT COUNT(*) AS cnt FROM files').get() as { cnt: number }).cnt;
      const totalSymbols = (db.prepare('SELECT COUNT(*) AS cnt FROM symbols').get() as { cnt: number }).cnt;
      const totalEdges = (db.prepare('SELECT COUNT(*) AS cnt FROM symbol_refs').get() as { cnt: number }).cnt;
      const totalDocs = (db.prepare('SELECT COUNT(*) AS cnt FROM docs').get() as { cnt: number }).cnt;

      expect(totalFiles).toBe(0);
      expect(totalSymbols).toBe(0);
      expect(totalEdges).toBe(0);
      expect(totalDocs).toBe(0);

      db.close();
    });
  });

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
    it('should print an error and exit with code 1 when --db is missing', async () => {
      await loadCli(['mcp']);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--db'),
      );
    });
  });

  // ── index subcommand — docs config flags ───────────────────────────────────

  describe('index subcommand — docs config flags', () => {
    it('should apply docs filters and persist explicit auto-notes disable in index mode', async () => {
      const dbPath = freshDb();
      const docsDir = nodePath.join(tmpDir, 'docs');
      nodeFs.mkdirSync(nodePath.join(docsDir, 'skip'), { recursive: true });
      const includedDoc = nodePath.join(docsDir, 'README.md');
      const excludedByPath = nodePath.join(docsDir, 'skip', 'ignored.md');
      const excludedByExtension = nodePath.join(docsDir, 'design.rst');
      nodeFs.writeFileSync(includedDoc, '# Guide\n\n## Intro\nhello\n', 'utf8');
      nodeFs.writeFileSync(excludedByPath, '# Ignored\n', 'utf8');
      nodeFs.writeFileSync(excludedByExtension, 'Guide\n=====\n', 'utf8');

      await loadCli([
        'index',
        '--db', dbPath,
        '--root', tmpDir,
        '--docs-include', 'docs/**/*',
        '--docs-exclude', '**/draft/**',
        '--docs-exclude', '**/skip/**',
        '--docs-extension', '.md',
      ]);

      await waitForFile(dbPath);
      await waitForCondition(
        () => readDocsPaths(dbPath).length === 1,
        'index docs ingestion to complete',
      );
      expect(readDocsPaths(dbPath)).toEqual([includedDoc]);
    });

    it('should index documentation files by default', async () => {
      const dbPath = freshDb();
      const readmePath = nodePath.join(tmpDir, 'README.md');
      nodeFs.writeFileSync(readmePath, '# Lore\n', 'utf8');

      await loadCli(['index', '--db', dbPath, '--root', tmpDir]);
      await waitForFile(dbPath);
      await waitForCondition(
        () => readDocsPaths(dbPath).length >= 1,
        'index docs ingestion to complete',
      );

      expect(readDocsPaths(dbPath).length).toBeGreaterThanOrEqual(1);
    });
  });

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

  describe('ingest-coverage subcommand', () => {
    it('should print an error and exit with code 1 when required flags are missing', async () => {
      await loadCli(['ingest-coverage', '--db', freshDb(), '--root', tmpDir]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('--file'),
      );
    });

    it('should print an error and exit with code 1 for an unsupported format', async () => {
      const reportPath = nodePath.join(tmpDir, 'coverage.info');
      nodeFs.writeFileSync(reportPath, '', 'utf8');
      await loadCli([
        'ingest-coverage',
        '--db', freshDb(),
        '--root', tmpDir,
        '--file', reportPath,
        '--format', 'json',
      ]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('unsupported coverage format'),
      );
    });

    it('should ingest an explicit LCOV report with a commit override', async () => {
      const dbPath = freshDb();
      const reportPath = nodePath.join(tmpDir, 'lcov.info');
      nodeFs.writeFileSync(
        reportPath,
        ['TN:', 'SF:src/a.ts', 'DA:1,1', 'DA:2,0', 'end_of_record', ''].join('\n'),
        'utf8',
      );

      await loadCli([
        'ingest-coverage',
        '--db', dbPath,
        '--root', tmpDir,
        '--file', reportPath,
        '--format', 'lcov',
        '--commit', 'deadbeef',
      ]);
      await waitForFile(dbPath);

      const db = new Database(dbPath, { readonly: true });
      const run = db
        .prepare('SELECT commit_sha, format, source_path FROM coverage_runs ORDER BY id DESC LIMIT 1')
        .get() as { commit_sha: string; format: string; source_path: string } | undefined;
      db.close();

      expect(run).toBeDefined();
      expect(run?.commit_sha).toBe('deadbeef');
      expect(run?.format).toBe('lcov');
      expect(run?.source_path).toBe(reportPath);
    });

    it('should default commit SHA to HEAD when --commit is omitted', async () => {
      const dbPath = freshDb();
      const reportPath = nodePath.join(tmpDir, 'coverage.xml');
      nodeFs.writeFileSync(
        reportPath,
        [
          '<coverage>',
          '  <packages>',
          '    <package name="x">',
          '      <classes>',
          '        <class name="A" filename="src/a.ts">',
          '          <lines>',
          '            <line number="1" hits="1"/>',
          '          </lines>',
          '        </class>',
          '      </classes>',
          '    </package>',
          '  </packages>',
          '</coverage>',
          '',
        ].join('\n'),
        'utf8',
      );

      await loadCli([
        'ingest-coverage',
        '--db', dbPath,
        '--root', tmpDir,
        '--file', reportPath,
        '--format', 'cobertura',
      ]);
      await waitForFile(dbPath);

      const db = new Database(dbPath, { readonly: true });
      const run = db
        .prepare('SELECT commit_sha, format FROM coverage_runs ORDER BY id DESC LIMIT 1')
        .get() as { commit_sha: string; format: string } | undefined;
      db.close();

      expect(run).toBeDefined();
      expect(run?.commit_sha).toBe('HEAD');
      expect(run?.format).toBe('cobertura');
    });
  });

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
    it('should apply docs filters and explicit auto-notes enable in manual refresh mode', async () => {
      const dbPath = freshDb();
      const docsDir = nodePath.join(tmpDir, 'docs');
      nodeFs.mkdirSync(nodePath.join(docsDir, 'skip'), { recursive: true });
      const includedDoc = nodePath.join(docsDir, 'README.md');
      const excludedByPath = nodePath.join(docsDir, 'skip', 'ignored.md');
      const excludedByExtension = nodePath.join(docsDir, 'refresh.txt');
      nodeFs.writeFileSync(includedDoc, '# Refresh\n', 'utf8');
      nodeFs.writeFileSync(excludedByPath, '# Ignored\n', 'utf8');
      nodeFs.writeFileSync(excludedByExtension, 'ignored text', 'utf8');

      await loadCli([
        'refresh',
        '--db', dbPath,
        '--root', tmpDir,
        '--docs-include', 'docs/**/*',
        '--docs-exclude', '**/draft/**',
        '--docs-exclude', '**/skip/**',
        '--docs-extension', '.md',
      ]);
      await waitForStderr(stderrSpy, 'refresh complete');
      await waitForFile(dbPath);
      expect(readDocsPaths(dbPath)).toEqual([includedDoc]);
    });

    it('should default docs to enabled in manual refresh when unspecified', async () => {
      const dbPath = freshDb();
      const readmePath = nodePath.join(tmpDir, 'README.md');
      nodeFs.writeFileSync(readmePath, '# Lore\n', 'utf8');
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir]);
      await waitForStderr(stderrSpy, 'refresh complete');
      await waitForFile(dbPath);
      expect(readDocsPaths(dbPath).length).toBeGreaterThanOrEqual(1);
    });

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
      row = db.prepare('SELECT path FROM files WHERE path = ?').get(filePath) as { path: string } | undefined;
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
});
