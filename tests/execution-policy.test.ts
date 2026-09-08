import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveApprovedCommandCwd,
  resolveIndexExecutionPolicy,
} from '../src/execution-policy.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-execution-policy-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveIndexExecutionPolicy', () => {
  it('denies every execution capability by default', () => {
    expect(resolveIndexExecutionPolicy()).toEqual({
      allowSubprocessExecution: false,
      allowBuildExecution: false,
      allowCustomIndexerCommands: false,
      allowCustomLspCommands: false,
      allowAutoInstall: false,
      allowIndexerExecution: false,
      allowLspExecution: false,
      allowedCwdRoots: [],
    });
  });

  it('limits specific grants to the required process category', () => {
    expect(resolveIndexExecutionPolicy({ allowBuildExecution: true })).toMatchObject({
      allowBuildExecution: true,
      allowIndexerExecution: true,
      allowLspExecution: false,
    });
    expect(resolveIndexExecutionPolicy({ allowCustomLspCommands: true })).toMatchObject({
      allowCustomLspCommands: true,
      allowIndexerExecution: false,
      allowLspExecution: true,
    });
  });
});

describe('resolveApprovedCommandCwd', () => {
  it('accepts the project root and descendants', () => {
    const root = tempDir();
    const child = path.join(root, 'tools');
    fs.mkdirSync(child);
    expect(resolveApprovedCommandCwd(root, 'tools')).toBe(fs.realpathSync(child));
  });

  it('rejects a cwd outside the project root', () => {
    const root = tempDir();
    const outside = tempDir();
    expect(() => resolveApprovedCommandCwd(root, outside)).toThrow('outside the approved roots');
  });

  it('accepts an outside cwd only when the host approves its root', () => {
    const root = tempDir();
    const outside = tempDir();
    expect(resolveApprovedCommandCwd(root, outside, [outside])).toBe(fs.realpathSync(outside));
  });

  it('rejects a symlink that escapes an approved root', () => {
    const root = tempDir();
    const outside = tempDir();
    fs.symlinkSync(outside, path.join(root, 'escape'));
    expect(() => resolveApprovedCommandCwd(root, 'escape')).toThrow('outside the approved roots');
  });
});
