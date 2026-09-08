import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  assertWriterGeneration,
  claimWriterGeneration,
  openDb,
  type Database,
} from '../db/schema.js';

interface WriterQueue {
  tail: Promise<void>;
  pending: number;
}

interface WriterLeaseOwner {
  token: string;
  pid: number;
  acquiredAt: number;
  dbPath: string;
}

export interface WriterLeaseOptions {
  /** A lease with no successful heartbeat for this long may be recovered. */
  staleMs?: number;
  /** Frequency at which the owner renews the lease directory mtime. */
  heartbeatMs?: number;
  /** Delay between acquisition attempts while another process owns the lease. */
  retryMs?: number;
  /** Maximum acquisition wait. Defaults to thirty minutes. */
  acquireTimeoutMs?: number;
}

/** Database-backed fencing token held by one logical writer operation. */
export interface DbWriterLease {
  readonly generation: number;
  readonly token: string;
  assertCurrent(db: Database.Database): void;
}

const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_RETRY_MS = 50;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30 * 60_000;
const OWNER_FILE = 'owner.json';

/**
 * Process-wide advisory queues keyed by canonical SQLite path.
 *
 * SQLite serializes individual writes, but an index run spans many statements
 * and asynchronous stages. Keeping the queue outside `IndexBuilder` prevents
 * separate builders (watcher, poller, deferred SCIP flush, and API callers)
 * from interleaving logical runs against the same database.
 */
const writerQueues = new Map<string, WriterQueue>();

export function canonicalDbPath(dbPath: string): string {
  if (dbPath === ':memory:' || dbPath.startsWith('file:')) return dbPath;
  const absolute = path.resolve(dbPath);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/** Return the filesystem lease path used to coordinate independent processes. */
export function dbWriterLeasePath(dbPath: string): string | null {
  const canonical = canonicalDbPath(dbPath);
  if (canonical === ':memory:') return null;
  if (canonical.startsWith('file:')) {
    const digest = createHash('sha256').update(canonical).digest('hex');
    return path.join(tmpdir(), `lore-${digest}.writer.lock`);
  }
  return `${canonical}.writer.lock`;
}

/** Enqueue one complete logical writer operation for a database path. */
export function withDbWriter<T>(
  dbPath: string,
  operation: (lease: DbWriterLease | null) => Promise<T>,
  leaseOptions: WriterLeaseOptions = {},
): Promise<T> {
  const key = canonicalDbPath(dbPath);
  let queue = writerQueues.get(key);
  if (!queue) {
    queue = { tail: Promise.resolve(), pending: 0 };
    writerQueues.set(key, queue);
  }

  queue.pending++;
  const run = () => withInterprocessWriterLease(key, operation, leaseOptions);
  const result = queue.tail.then(run, run);
  queue.tail = result.then(
    () => undefined,
    () => undefined,
  );
  void queue.tail.finally(() => {
    const current = writerQueues.get(key);
    if (!current) return;
    current.pending--;
    if (current.pending === 0) writerQueues.delete(key);
  });
  return result;
}

async function withInterprocessWriterLease<T>(
  canonicalPath: string,
  operation: (lease: DbWriterLease | null) => Promise<T>,
  options: WriterLeaseOptions,
): Promise<T> {
  const leasePath = dbWriterLeasePath(canonicalPath);
  if (!leasePath) return operation(null);

  const staleMs = positiveDuration(options.staleMs, DEFAULT_STALE_MS, 'staleMs');
  const heartbeatMs = positiveDuration(
    options.heartbeatMs,
    Math.min(DEFAULT_HEARTBEAT_MS, Math.max(10, Math.floor(staleMs / 3))),
    'heartbeatMs',
  );
  if (heartbeatMs >= staleMs) {
    throw new Error('Writer lease heartbeatMs must be smaller than staleMs');
  }
  const retryMs = positiveDuration(options.retryMs, DEFAULT_RETRY_MS, 'retryMs');
  const acquireTimeoutMs = positiveDuration(
    options.acquireTimeoutMs,
    DEFAULT_ACQUIRE_TIMEOUT_MS,
    'acquireTimeoutMs',
  );
  const owner: WriterLeaseOwner = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: Date.now(),
    dbPath: canonicalPath,
  };

  await acquireLease(leasePath, owner, staleMs, retryMs, acquireTimeoutMs);
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    try {
      const current = readOwner(leasePath);
      if (current?.token !== owner.token) {
        leaseLost = true;
        clearInterval(heartbeat);
        return;
      }
      const now = new Date();
      fs.utimesSync(leasePath, now, now);
    } catch {
      leaseLost = true;
      clearInterval(heartbeat);
    }
  }, heartbeatMs);
  heartbeat.unref();

  try {
    const generation = claimDatabaseWriterGeneration(canonicalPath);
    const lease: DbWriterLease = {
      generation,
      token: owner.token,
      assertCurrent: (db) => assertWriterGeneration(db, generation),
    };
    const result = await operation(lease);
    const verificationDb = openDb(canonicalPath);
    try {
      lease.assertCurrent(verificationDb);
    } finally {
      verificationDb.close();
    }
    if (leaseLost) {
      throw new Error(`Lost interprocess writer lease for ${canonicalPath}`);
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    releaseLease(leasePath, owner.token);
  }
}

function claimDatabaseWriterGeneration(dbPath: string): number {
  const db = openDb(dbPath);
  try {
    return claimWriterGeneration(db);
  } finally {
    db.close();
  }
}

async function acquireLease(
  leasePath: string,
  owner: WriterLeaseOwner,
  staleMs: number,
  retryMs: number,
  acquireTimeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(leasePath, { mode: 0o700 });
      try {
        fs.writeFileSync(
          path.join(leasePath, OWNER_FILE),
          `${JSON.stringify(owner)}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
      } catch (error) {
        fs.rmSync(leasePath, { recursive: true, force: true });
        throw error;
      }
      return;
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
    }

    if (recoverStaleLease(leasePath, staleMs)) continue;
    if (Date.now() - startedAt >= acquireTimeoutMs) {
      const ownerDescription = readOwner(leasePath);
      throw new Error(
        `Timed out waiting for Lore database writer lease ${leasePath}`
        + (ownerDescription ? ` (held by pid ${ownerDescription.pid})` : ''),
      );
    }
    await delay(retryMs);
  }
}

function recoverStaleLease(leasePath: string, staleMs: number): boolean {
  let first: fs.Stats;
  try {
    first = fs.statSync(leasePath);
  } catch {
    return true;
  }
  if (Date.now() - first.mtimeMs < staleMs) return false;

  // Re-read immediately before the rename. The inode/mtime check avoids
  // reclaiming a lease that renewed while stale diagnostics were inspected.
  let current: fs.Stats;
  try {
    current = fs.statSync(leasePath);
  } catch {
    return true;
  }
  if (current.ino !== first.ino || current.mtimeMs !== first.mtimeMs
    || Date.now() - current.mtimeMs < staleMs) return false;

  const quarantine = `${leasePath}.stale-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(leasePath, quarantine);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT') || isErrorCode(error, 'EEXIST')) return true;
    return false;
  }
  fs.rmSync(quarantine, { recursive: true, force: true });
  return true;
}

function releaseLease(leasePath: string, token: string): void {
  try {
    if (readOwner(leasePath)?.token !== token) return;
    fs.rmSync(leasePath, { recursive: true, force: true });
  } catch {
    // The lease may already have been recovered after this process stalled.
  }
}

function readOwner(leasePath: string): WriterLeaseOwner | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(leasePath, OWNER_FILE), 'utf8'),
    ) as Partial<WriterLeaseOwner>;
    return typeof parsed.token === 'string'
      && Number.isSafeInteger(parsed.pid)
      && typeof parsed.acquiredAt === 'number'
      && typeof parsed.dbPath === 'string'
      ? parsed as WriterLeaseOwner
      : null;
  } catch {
    return null;
  }
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`Writer lease ${name} must be a positive number`);
  }
  return resolved;
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
