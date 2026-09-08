import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CURRENT_LORE_SCHEMA_VERSION } from '../../src/db/schema-info.js';
import { openReadOnly } from '../../src/db/read-only.js';
import { createLoreMcpServer } from '../../src/server/server.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('MCP schema compatibility gate', () => {
  it('rejects a newer database before constructing a ready server', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mcp-schema-'));
    tempDirs.push(directory);
    const dbPath = path.join(directory, 'newer.db');
    const raw = new Database(dbPath);
    raw.pragma(`user_version = ${CURRENT_LORE_SCHEMA_VERSION + 1}`);
    raw.close();

    const db = openReadOnly(dbPath);
    try {
      await expect(createLoreMcpServer(db, dbPath)).rejects.toThrow(
        /MCP server cannot use this database.*newer than supported/u,
      );
    } finally {
      db.close();
    }
  });
});
