import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from '../../src/db/schema.js';
import { runAnalyzeCommand } from '../../src/cli/commands/analyze-cmd.js';
import type { LoreLogger } from '../../src/logger.js';

function readLastJson(log: ReturnType<typeof vi.spyOn>): any {
  const call = log.mock.calls.at(-1);
  if (!call) throw new Error('analyze command did not write a result');
  return JSON.parse(String(call[0]));
}

describe('lore analyze effective overlay state', () => {
  let tempDir: string;
  let dbPath: string;
  let output: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-analyze-'));
    dbPath = path.join(tempDir, 'index.db');
    output = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('analyzes replacement rows and then observes an effective deletion', async () => {
    const db = openDb(dbPath);
    db.prepare(
      `INSERT INTO files (id, path, branch, language, source, layer, generation)
       VALUES (1, 'src/current.ts', 'main', 'typescript', '', 'baseline', 1),
              (2, 'src/current.ts', 'main', 'typescript', '', 'overlay', 0)`,
    ).run();
    db.prepare(
      "INSERT INTO baseline_generations (branch, generation) VALUES ('main', 1)",
    ).run();
    db.prepare(
      `INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, layer, generation)
       VALUES (1, 1, 'hiddenA', 'function', 0, 9, 'baseline', 1),
              (2, 1, 'hiddenB', 'function', 10, 19, 'baseline', 1),
              (3, 2, 'replacement', 'function', 0, 4, 'overlay', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO symbol_refs
        (caller_id, file_id, callee_id, callee_name, call_line, resolution_method, layer, generation)
       VALUES (1, 1, 2, 'hiddenB', 0, 'name_same_file', 'baseline', 1)`,
    ).run();
    db.prepare(
      "INSERT INTO dirty_files (path, branch, overlay_gen) VALUES ('src/current.ts', 'main', 0)",
    ).run();
    db.close();

    await runAnalyzeCommand(
      ['analyze', '--db', dbPath, '--mode', 'summary', '--branch', 'main'],
      {} as LoreLogger,
    );
    expect(readLastJson(output)).toMatchObject({
      totalFiles: 1,
      totalSymbols: 1,
      totalEdges: 0,
    });

    const deletionDb = openDb(dbPath);
    deletionDb.prepare('DELETE FROM files WHERE id = 2').run();
    deletionDb.close();

    await runAnalyzeCommand(
      ['analyze', '--db', dbPath, '--mode', 'summary', '--branch', 'main'],
      {} as LoreLogger,
    );
    expect(readLastJson(output)).toMatchObject({
      totalFiles: 0,
      totalSymbols: 0,
      totalEdges: 0,
    });
  });
});
