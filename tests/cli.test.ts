import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli.js');

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  };
}

function createTmpSrcDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-cli-test-src-'));
  writeFileSync(join(dir, 'hello.ts'), 'export function hello(): string { return "hi"; }\n');
  return dir;
}

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lore-cli-test-db-'));
  return join(dir, 'test.db');
}

// ─── Usage / help ─────────────────────────────────────────────────────────────

describe('CLI – usage / help', () => {
  it('should exit with code 1 and print usage when no arguments', () => {
    const { status, stderr } = runCli([]);
    expect(status).toBe(1);
    expect(stderr).toContain('lore index');
    expect(stderr).toContain('lore mcp');
  });

  it('should exit with code 1 and print usage for --help', () => {
    const { status, stderr } = runCli(['--help']);
    expect(status).toBe(1);
    expect(stderr).toContain('--root');
    expect(stderr).toContain('--db');
    expect(stderr).toContain('--branch');
  });

  it('should exit with code 1 and print usage for -h', () => {
    const { status, stderr } = runCli(['-h']);
    expect(status).toBe(1);
    expect(stderr).toContain('Usage:');
  });

  it('should exit with code 1 and print error for unknown subcommand', () => {
    const { status, stderr } = runCli(['unknown']);
    expect(status).toBe(1);
    expect(stderr).toContain('Unknown subcommand: unknown');
  });
});

// ─── index subcommand – validation ────────────────────────────────────────────

describe('CLI – index subcommand validation', () => {
  it('should exit with code 1 when --root is missing', () => {
    const { status, stderr } = runCli(['index', '--db', '/tmp/ignored.db']);
    expect(status).toBe(1);
    expect(stderr).toContain('--root');
  });

  it('should exit with code 1 when --db is missing', () => {
    const { status, stderr } = runCli(['index', '--root', '/tmp']);
    expect(status).toBe(1);
    expect(stderr).toContain('--db');
  });

  it('should exit with code 1 when both --root and --db are missing', () => {
    const { status, stderr } = runCli(['index']);
    expect(status).toBe(1);
    expect(stderr).toContain('--root');
  });
});

// ─── index subcommand – happy path ────────────────────────────────────────────

describe('CLI – index subcommand success', () => {
  let srcDir: string;
  let dbPath: string;

  beforeEach(() => {
    srcDir = createTmpSrcDir();
    dbPath = tmpDbPath();
  });

  afterEach(() => {
    try { rmSync(srcDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(dbPath); } catch { /* ignore */ }
    try { rmSync(join(dbPath, '..'), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should exit with code 0 when --root and --db are provided', () => {
    const { status } = runCli(['index', '--root', srcDir, '--db', dbPath]);
    expect(status).toBe(0);
  });

  it('should print indexed message on stderr', () => {
    const { stderr } = runCli(['index', '--root', srcDir, '--db', dbPath]);
    expect(stderr).toContain('lore: indexed');
    expect(stderr).toContain(srcDir);
    expect(stderr).toContain(dbPath);
  });

  it('should create the database file after indexing', () => {
    runCli(['index', '--root', srcDir, '--db', dbPath]);
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT COUNT(*) as count FROM files').get() as { count: number };
    db.close();
    expect(rows.count).toBeGreaterThan(0);
  });

  it('should use the provided --branch value', () => {
    const { status } = runCli(['index', '--root', srcDir, '--db', dbPath, '--branch', 'my-branch']);
    expect(status).toBe(0);

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare('SELECT DISTINCT branch FROM files')
      .all() as { branch: string }[];
    db.close();
    expect(rows.map(r => r.branch)).toContain('my-branch');
  });

  it('should default branch to HEAD when --branch is omitted', () => {
    runCli(['index', '--root', srcDir, '--db', dbPath]);

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare('SELECT DISTINCT branch FROM files')
      .all() as { branch: string }[];
    db.close();
    // Branch should be a non-empty string (either current HEAD branch or 'HEAD' fallback)
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0]!.branch).toBe('string');
    expect(rows[0]!.branch.length).toBeGreaterThan(0);
  });
});
