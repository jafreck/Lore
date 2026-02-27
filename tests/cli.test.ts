import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = resolve(__dirname, '../dist/cli.js');

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describe('cli — no arguments', () => {
  it('should print usage and exit non-zero when called with no arguments', () => {
    const { stderr, status } = runCli([]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('lore index');
    expect(stderr).toContain('lore mcp');
  });
});

describe('cli — --help / -h flag', () => {
  it('should print usage and exit when --help is passed', () => {
    const { stderr, status } = runCli(['--help']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('lore index --root <dir> --db <path>');
    expect(stderr).toContain('lore mcp --db <path>');
    expect(stderr).toContain('--embedding-model');
  });

  it('should print usage and exit when -h is passed', () => {
    const { stderr, status } = runCli(['-h']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('lore index');
  });
});

describe('cli — unknown subcommand', () => {
  it('should print an error and exit non-zero for an unknown subcommand', () => {
    const { stderr, status } = runCli(['unknown']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('Unknown subcommand: unknown');
  });
});

describe('cli — index subcommand argument validation', () => {
  it('should exit non-zero and report missing --root when only --db is provided', () => {
    const { stderr, status } = runCli(['index', '--db', '/tmp/test.db']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--root');
  });

  it('should exit non-zero and report missing --db when only --root is provided', () => {
    const { stderr, status } = runCli(['index', '--root', '/tmp']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--db');
  });

  it('should exit non-zero when neither --root nor --db is provided for index', () => {
    const { stderr, status } = runCli(['index']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--root');
  });
});

describe('cli — mcp subcommand argument validation', () => {
  it('should exit non-zero and report missing --db for mcp subcommand', () => {
    const { stderr, status } = runCli(['mcp']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('--db');
  });
});

describe('cli — usage text content', () => {
  it('should list --embedding-model flag in usage', () => {
    const { stderr } = runCli([]);
    expect(stderr).toContain('--embedding-model');
  });

  it('should list --root flag description in usage', () => {
    const { stderr } = runCli([]);
    expect(stderr).toContain('--root');
  });

  it('should not contain the word "Future" in usage (legacy comment removed)', () => {
    const { stderr } = runCli([]);
    expect(stderr).not.toContain('Future');
  });

  it('should list --include flag in usage', () => {
    const { stderr } = runCli([]);
    expect(stderr).toContain('--include');
  });

  it('should list --exclude flag in usage', () => {
    const { stderr } = runCli([]);
    expect(stderr).toContain('--exclude');
  });

  it('should list --language flag in usage', () => {
    const { stderr } = runCli([]);
    expect(stderr).toContain('--language');
  });
});

describe('cli — --language flag validation', () => {
  it('should exit non-zero and print error for unknown language name', () => {
    const { stderr, status } = runCli(['index', '--root', '/tmp', '--db', '/tmp/test.db', '--language', 'cobol']);
    expect(status).not.toBe(0);
    expect(stderr).toContain('unknown language');
    expect(stderr).toContain('cobol');
  });
});
