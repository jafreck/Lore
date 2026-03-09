import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensurePythonDeps } from '../../src/indexer/ensure-python-deps.js';

// Mock child_process so we never actually run python/pip
vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  return { execFile };
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// We need to get the promisified version that the module uses
// Since the module uses promisify(execFile), we need to mock execFile itself
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

describe('ensurePythonDeps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should do nothing when all packages are already installed', async () => {
    const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
    // Both checks succeed (packages importable)
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(null);
      },
    );

    await ensurePythonDeps('python3', 5000);

    // Should only call twice for the two import checks
    expect(mockExecFile).toHaveBeenCalledTimes(2);
   });

  it('should install packages when the first import check fails', async () => {
    const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
    let callCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        callCount++;
        if (callCount <= 2) {
          // First two calls are import checks — first fails
          if (callCount === 1) {
            cb(new Error('ModuleNotFoundError'));
          } else {
            cb(null);
          }
        } else {
          // pip install + verify calls
          cb(null);
        }
      },
    );

    await ensurePythonDeps('python3', 5000);

    // Check + check + install + verify + verify = 5 calls
    expect(mockExecFile.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('should throw when pip install fails', async () => {
    const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
    let callCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        callCount++;
        if (callCount <= 2) {
          cb(new Error('ModuleNotFoundError'));
        } else {
          cb(new Error('pip install failed'));
        }
      },
    );

    await expect(ensurePythonDeps('python3', 5000)).rejects.toThrow();
  });

  it('should use provided pythonBin argument', async () => {
    const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
    mockExecFile.mockImplementation(
      (cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
        cb(null);
      },
    );

    await ensurePythonDeps('/usr/bin/python3.11', 5000);

    expect(mockExecFile.mock.calls[0]?.[0]).toBe('/usr/bin/python3.11');
  });
});
