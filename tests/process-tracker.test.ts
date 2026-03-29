import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  trackProcess,
  untrackProcess,
  killAllTracked,
  trackedCount,
} from '../src/process-tracker.js';

describe('process-tracker', () => {
  beforeEach(() => {
    // Ensure a clean state
    killAllTracked();
  });

  afterEach(() => {
    killAllTracked();
  });

  it('starts with zero tracked processes', () => {
    expect(trackedCount()).toBe(0);
  });

  it('trackProcess increments count', () => {
    const child = spawn('sleep', ['60']);
    trackProcess(child);
    expect(trackedCount()).toBe(1);
    child.kill();
  });

  it('untrackProcess decrements count', () => {
    const child = spawn('sleep', ['60']);
    trackProcess(child);
    expect(trackedCount()).toBe(1);
    untrackProcess(child);
    expect(trackedCount()).toBe(0);
    child.kill();
  });

  it('killAllTracked kills children and clears set', () => {
    const child1 = spawn('sleep', ['60']);
    const child2 = spawn('sleep', ['60']);
    const kill1 = vi.spyOn(child1, 'kill');
    const kill2 = vi.spyOn(child2, 'kill');
    trackProcess(child1);
    trackProcess(child2);
    expect(trackedCount()).toBe(2);

    killAllTracked();
    expect(trackedCount()).toBe(0);
    expect(kill1).toHaveBeenCalled();
    expect(kill2).toHaveBeenCalled();
  });

  it('auto-removes on child exit', async () => {
    const child = spawn('echo', ['hello']);
    trackProcess(child);

    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    expect(trackedCount()).toBe(0);
  });

  it('untrack is idempotent for already-removed process', () => {
    const child = spawn('sleep', ['60']);
    trackProcess(child);
    untrackProcess(child);
    expect(() => untrackProcess(child)).not.toThrow();
    expect(trackedCount()).toBe(0);
    child.kill();
  });


});
