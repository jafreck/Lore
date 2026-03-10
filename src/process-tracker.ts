/**
 * @module process-tracker
 *
 * Global registry of spawned child processes.
 *
 * Long-lived subprocess owners (embedder, LSP clients) call `trackProcess()`
 * after spawning, and `untrackProcess()` (or rely on the automatic `exit`
 * listener) when the child terminates.
 *
 * On `SIGINT` / `SIGTERM`, `killAllTracked()` sends `SIGTERM` to every live
 * child so that Python sub-interpreters, language servers, etc. are never
 * orphaned — even if the async `dispose()` paths are interrupted.
 */

import type { ChildProcess } from 'node:child_process';

const tracked = new Set<ChildProcess>();

/**
 * Register a child process for cleanup-on-exit tracking.
 *
 * An `'exit'` listener is installed automatically so the process is removed
 * from the set once it terminates.
 */
export function trackProcess(proc: ChildProcess): void {
  tracked.add(proc);
  proc.once('exit', () => {
    tracked.delete(proc);
  });
}

/** Explicitly remove a process from tracking (e.g. after a graceful close). */
export function untrackProcess(proc: ChildProcess): void {
  tracked.delete(proc);
}

/**
 * Send `SIGTERM` to every tracked child process and clear the set.
 *
 * This is intentionally synchronous so it can be called from signal handlers
 * and the `process.on('exit')` hook.
 */
export function killAllTracked(): void {
  for (const proc of tracked) {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already exited — ignore */
    }
  }
  tracked.clear();
}

/** Number of processes currently tracked (exposed for tests). */
export function trackedCount(): number {
  return tracked.size;
}
