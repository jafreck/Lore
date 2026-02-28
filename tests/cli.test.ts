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
async function loadCli(args: string[]): Promise<void> {
  process.argv = ['node', 'lore', ...args];
  vi.resetModules();
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
    // Remove any SIGINT / SIGTERM listeners registered by the CLI during the
    // test so they do not accumulate across tests.
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    // Clean up temp dir
    nodeFs.rmSync(tmpDir, { recursive: true, force: true });
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
      expect(exitSpy).toHaveBeenCalledWith(0);
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
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('should call process.exit(0) when SIGTERM is received', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir, '--watch']);
      await waitForStderr(stderrSpy, 'watch mode started');

      process.emit('SIGTERM');
      expect(exitSpy).toHaveBeenCalledWith(0);
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
      expect(exitSpy).toHaveBeenCalledWith(0);
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
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('should call process.exit(0) when SIGTERM is received', async () => {
      const dbPath = freshDb();
      await loadCli(['refresh', '--db', dbPath, '--root', tmpDir, '--poll']);
      await waitForStderr(stderrSpy, 'poll mode started');

      process.emit('SIGTERM');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });
});
