import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  trackProcess,
  untrackProcess,
  killAllTracked,
  trackedCount,
} from '../src/process-tracker.js';

describe('process-tracker', () => {
  // Clean slate before each test so leaked tracked processes in one test
  // don't affect another.
  beforeEach(() => {
    killAllTracked();
  });

  it('trackProcess increases the tracked count', () => {
    const child = spawn('sleep', ['60']);
    expect(trackedCount()).toBe(0);
    trackProcess(child);
    expect(trackedCount()).toBe(1);
    child.kill();
  });

  it('untrackProcess removes a tracked process', () => {
    const child = spawn('sleep', ['60']);
    trackProcess(child);
    expect(trackedCount()).toBe(1);
    untrackProcess(child);
    expect(trackedCount()).toBe(0);
    child.kill();
  });

  it('auto-untrack on exit removes the process from the set', async () => {
    // Spawn a short-lived command so we can wait for exit.
    const child = spawn('true');
    trackProcess(child);
    expect(trackedCount()).toBe(1);

    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(trackedCount()).toBe(0);
  });

  it('killAllTracked sends SIGTERM to all tracked processes', async () => {
    const a = spawn('sleep', ['60']);
    const b = spawn('sleep', ['60']);
    trackProcess(a);
    trackProcess(b);
    expect(trackedCount()).toBe(2);

    killAllTracked();
    expect(trackedCount()).toBe(0);

    // Both should eventually exit.
    await Promise.all([
      new Promise<void>((resolve) => a.once('exit', () => resolve())),
      new Promise<void>((resolve) => b.once('exit', () => resolve())),
    ]);
  });

  it('killAllTracked is safe to call with no tracked processes', () => {
    expect(trackedCount()).toBe(0);
    killAllTracked(); // should not throw
    expect(trackedCount()).toBe(0);
  });

  it('killAllTracked is safe to call when a process already exited', async () => {
    const child = spawn('true');
    trackProcess(child);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // Process already exited and auto-untracked.
    expect(trackedCount()).toBe(0);
    killAllTracked(); // should not throw
  });
});
