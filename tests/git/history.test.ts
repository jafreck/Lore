import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { openDb } from '../../src/db/schema.js';
import { ingestGitHistory } from '../../src/git/history.js';

let tmpDir: string;

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: tmpDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function mkFile(relativePath: string, content: string): void {
  const abs = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-git-hist-'));
  git('init');
  git('config user.email "test@example.com"');
  git('config user.name "Test User"');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ingestGitHistory', () => {
  it('ingests commits into the database', async () => {
    mkFile('hello.txt', 'hello');
    git('add .');
    git('commit -m "initial commit"');

    mkFile('hello.txt', 'hello world');
    git('add .');
    git('commit -m "update hello"');

    const db = openDb(':memory:');
    await ingestGitHistory(db, tmpDir);

    const commits = db.prepare('SELECT * FROM commits').all() as Array<Record<string, unknown>>;
    expect(commits.length).toBe(2);

    const messages = commits.map((c) => c.message as string);
    expect(messages).toContain('initial commit');
    expect(messages).toContain('update hello');

    db.close();
  });

  it('ingests commit_files with diff stats', async () => {
    mkFile('src/main.ts', 'const a = 1;\n');
    git('add .');
    git('commit -m "add main"');

    const db = openDb(':memory:');
    await ingestGitHistory(db, tmpDir);

    const files = db.prepare('SELECT * FROM commit_files').all() as Array<Record<string, unknown>>;
    expect(files.length).toBeGreaterThanOrEqual(1);

    const mainFile = files.find((f) => (f.file_path as string).includes('main.ts'));
    expect(mainFile).toBeDefined();
    expect(mainFile!.insertions).toBeGreaterThanOrEqual(1);

    db.close();
  });

  it('ingests commit_refs for branches', async () => {
    mkFile('file.txt', 'content');
    git('add .');
    git('commit -m "first"');

    const db = openDb(':memory:');
    await ingestGitHistory(db, tmpDir);

    const refs = db.prepare('SELECT * FROM commit_refs').all() as Array<Record<string, unknown>>;
    expect(refs.length).toBeGreaterThanOrEqual(1);

    const branchRef = refs.find((r) => (r.ref_type as string) === 'branch');
    expect(branchRef).toBeDefined();

    db.close();
  });

  it('is idempotent: re-running does not duplicate rows', async () => {
    mkFile('a.txt', 'a');
    git('add .');
    git('commit -m "first"');

    const db = openDb(':memory:');
    await ingestGitHistory(db, tmpDir);
    await ingestGitHistory(db, tmpDir);

    const commits = db.prepare('SELECT * FROM commits').all();
    expect(commits.length).toBe(1);

    db.close();
  });

  it('respects depth option', async () => {
    mkFile('a.txt', 'a');
    git('add .');
    git('commit -m "first"');

    mkFile('a.txt', 'b');
    git('add .');
    git('commit -m "second"');

    mkFile('a.txt', 'c');
    git('add .');
    git('commit -m "third"');

    const db = openDb(':memory:');
    await ingestGitHistory(db, tmpDir, { depth: 2 });

    const commits = db.prepare('SELECT * FROM commits').all();
    expect(commits.length).toBe(2);

    db.close();
  });

  it('handles empty repos gracefully', async () => {
    const db = openDb(':memory:');
    // Empty repo has no commits — should not throw
    await expect(ingestGitHistory(db, tmpDir)).resolves.toBeUndefined();
    db.close();
  });

  it('stores parent SHAs as JSON array', async () => {
    mkFile('a.txt', 'a');
    git('add .');
    git('commit -m "first"');

    mkFile('a.txt', 'b');
    git('add .');
    git('commit -m "second"');

    const db = openDb(':memory:');
    await ingestGitHistory(db, tmpDir);

    const commits = db.prepare('SELECT * FROM commits ORDER BY timestamp ASC').all() as Array<Record<string, unknown>>;
    // Find the initial commit (the one whose message is "first")
    const first = commits.find((c) => c.message === 'first')!;
    const second = commits.find((c) => c.message === 'second')!;

    const firstParents = JSON.parse(first.parents as string) as string[];
    expect(firstParents.length).toBe(0);

    const secondParents = JSON.parse(second.parents as string) as string[];
    expect(secondParents.length).toBe(1);

    db.close();
  });

  it('uses watermark to only fetch new commits on re-run', async () => {
    mkFile('a.txt', 'a');
    git('add .');
    git('commit -m "first"');

    const db = openDb(':memory:');
    await ingestGitHistory(db, tmpDir);

    const commitsBefore = db.prepare('SELECT count(*) as c FROM commits').get() as { c: number };
    expect(commitsBefore.c).toBe(1);

    mkFile('a.txt', 'b');
    git('add .');
    git('commit -m "second"');

    await ingestGitHistory(db, tmpDir);

    const commitsAfter = db.prepare('SELECT count(*) as c FROM commits').get() as { c: number };
    expect(commitsAfter.c).toBe(2);

    db.close();
  });
});
