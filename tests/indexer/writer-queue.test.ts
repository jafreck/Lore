import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalDbPath,
  dbWriterLeasePath,
  withDbWriter,
} from '../../src/indexer/writer-queue.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-writer-lease-'));
  tempDirs.push(directory);
  return path.join(directory, 'index.db');
}

describe('database writer lease', () => {
  it('creates an interprocess lease for the duration of a logical writer', async () => {
    const dbPath = tempDbPath();
    const leasePath = dbWriterLeasePath(dbPath)!;

    await withDbWriter(dbPath, async () => {
      expect(fs.statSync(leasePath).isDirectory()).toBe(true);
      const owner = JSON.parse(fs.readFileSync(path.join(leasePath, 'owner.json'), 'utf8'));
      expect(owner).toMatchObject({ pid: process.pid, dbPath: canonicalDbPath(dbPath) });
    });

    expect(fs.existsSync(leasePath)).toBe(false);
  });

  it('recovers an abandoned stale lease before running the writer', async () => {
    const dbPath = tempDbPath();
    const leasePath = dbWriterLeasePath(dbPath)!;
    fs.mkdirSync(leasePath);
    fs.writeFileSync(path.join(leasePath, 'owner.json'), JSON.stringify({
      token: 'abandoned',
      pid: 999_999_999,
      acquiredAt: 1,
      dbPath: path.resolve(dbPath),
    }));
    const stale = new Date(Date.now() - 10_000);
    fs.utimesSync(leasePath, stale, stale);

    let ran = false;
    await withDbWriter(dbPath, async () => { ran = true; }, {
      staleMs: 50,
      heartbeatMs: 10,
      retryMs: 5,
      acquireTimeoutMs: 500,
    });

    expect(ran).toBe(true);
    expect(fs.existsSync(leasePath)).toBe(false);
  });

  it('serializes separate builders in the current process before leasing', async () => {
    const dbPath = tempDbPath();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withDbWriter(dbPath, async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
    });
    const second = withDbWriter(dbPath, async () => {
      order.push('second');
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});
