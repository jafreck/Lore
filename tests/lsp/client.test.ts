import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { LspClient } from '../../src/lsp/client.js';

const SERVER_SCRIPT = `
const fs = require('node:fs');
const mode = process.argv[1] || 'normal';
const reportPath = process.argv[2];
let buffer = Buffer.alloc(0);
const state = {
  initialized: false,
  didOpen: 0,
  didChange: 0,
  didClose: 0,
  hover: 0,
  definition: 0,
  shutdown: false,
  exit: false,
};

function writeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write('Content-Length: ' + payload.length + '\\r\\n\\r\\n');
  process.stdout.write(payload);
}

function sendResponse(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function flushReportAndExit() {
  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify(state), 'utf8');
  }
  process.exit(0);
}

function handleMessage(message) {
  if (message.method === 'initialize') {
    state.initialized = true;
    sendResponse(message.id, { capabilities: { hoverProvider: true, definitionProvider: true } });
    return;
  }

  if (message.method === 'textDocument/didOpen') {
    state.didOpen += 1;
    return;
  }

  if (message.method === 'textDocument/didChange') {
    state.didChange += 1;
    return;
  }

  if (message.method === 'textDocument/didClose') {
    state.didClose += 1;
    return;
  }

  if (message.method === 'textDocument/hover') {
    state.hover += 1;
    if (mode === 'timeout-hover') {
      return;
    }
    if (mode === 'error-hover') {
      sendError(message.id, -32000, 'hover failed');
      return;
    }
    sendResponse(message.id, {
      contents: {
        kind: 'plaintext',
        value: 'hover info',
      },
    });
    return;
  }

  if (message.method === 'textDocument/definition') {
    state.definition += 1;
    sendResponse(message.id, [
      {
        uri: 'file:///workspace/target.ts',
        range: {
          start: { line: 10, character: 2 },
          end: { line: 10, character: 14 },
        },
      },
    ]);
    return;
  }

  if (message.method === 'shutdown') {
    state.shutdown = true;
    sendResponse(message.id, null);
    return;
  }

  if (message.method === 'exit') {
    state.exit = true;
    flushReportAndExit();
    return;
  }

  if (message.id !== undefined) {
    sendError(message.id, -32601, 'Method not found');
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) {
      process.exit(2);
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const messageEnd = bodyStart + length;
    if (buffer.length < messageEnd) break;
    const body = buffer.slice(bodyStart, messageEnd).toString('utf8');
    buffer = buffer.slice(messageEnd);
    handleMessage(JSON.parse(body));
  }
});
`;

describe('LspClient', () => {
  it('should reject start when the server command is missing', async () => {
    const client = new LspClient({ command: '' });
    await expect(client.start()).rejects.toThrow('LSP server command is required');
  });

  it('should throw when document lifecycle and request APIs are used before start', async () => {
    const client = new LspClient({
      command: process.execPath,
      args: ['-e', SERVER_SCRIPT, 'normal'],
    });

    expect(() => client.didOpen({
      uri: 'file:///workspace/main.ts',
      languageId: 'typescript',
      version: 1,
      text: 'const value = 1;',
    })).toThrow('LSP client is not active');
    expect(() => client.didChange(
      { uri: 'file:///workspace/main.ts', version: 2 },
      [{ text: 'const value = 2;' }],
    )).toThrow('LSP client is not active');
    expect(() => client.didClose({ uri: 'file:///workspace/main.ts' })).toThrow('LSP client is not active');
    await expect(client.hover({ uri: 'file:///workspace/main.ts' }, { line: 0, character: 0 }))
      .rejects.toThrow('LSP client is not active');
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('supports initialize plus didOpen/didChange/didClose notifications and hover/definition requests', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lore-lsp-client-'));
    const reportPath = join(tmp, 'report.json');
    const client = new LspClient(
      {
        command: process.execPath,
        args: ['-e', SERVER_SCRIPT, 'normal', reportPath],
      },
      {
        rootUri: 'file:///workspace',
        requestTimeoutMs: 2000,
      },
    );

    await client.start();
    client.didOpen({
      uri: 'file:///workspace/main.ts',
      languageId: 'typescript',
      version: 1,
      text: 'const value = 1;',
    });
    client.didChange(
      {
        uri: 'file:///workspace/main.ts',
        version: 2,
      },
      [{ text: 'const value = 2;' }],
    );
    const hover = await client.hover(
      { uri: 'file:///workspace/main.ts' },
      { line: 0, character: 6 },
    );
    const definition = await client.definition(
      { uri: 'file:///workspace/main.ts' },
      { line: 0, character: 6 },
    );
    client.didClose({ uri: 'file:///workspace/main.ts' });
    await client.close();

    expect(hover).toEqual({
      contents: {
        kind: 'plaintext',
        value: 'hover info',
      },
    });
    expect(definition).toEqual([
      {
        uri: 'file:///workspace/target.ts',
        range: {
          start: { line: 10, character: 2 },
          end: { line: 10, character: 14 },
        },
      },
    ]);

    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    expect(report.initialized).toBe(true);
    expect(report.didOpen).toBe(1);
    expect(report.didChange).toBe(1);
    expect(report.didClose).toBe(1);
    expect(report.hover).toBe(1);
    expect(report.definition).toBe(1);
    expect(report.shutdown).toBe(true);
    expect(report.exit).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });

  it('applies request timeout handling for hover/definition helpers', async () => {
    const client = new LspClient(
      {
        command: process.execPath,
        args: ['-e', SERVER_SCRIPT, 'timeout-hover'],
      },
      {
        rootUri: 'file:///workspace',
        requestTimeoutMs: 1000,
      },
    );

    await client.start();
    await expect(
      client.hover({ uri: 'file:///workspace/main.ts' }, { line: 0, character: 0 }),
    ).rejects.toThrow(/timed out/u);
    await client.close();
  });

  it('rejects requests when the language server returns a JSON-RPC error response', async () => {
    const client = new LspClient(
      {
        command: process.execPath,
        args: ['-e', SERVER_SCRIPT, 'error-hover'],
      },
      {
        rootUri: 'file:///workspace',
        requestTimeoutMs: 1000,
      },
    );

    await client.start();
    await expect(
      client.hover({ uri: 'file:///workspace/main.ts' }, { line: 0, character: 0 }),
    ).rejects.toThrow(/LSP request failed for textDocument\/hover: hover failed/u);
    await client.close();
  });
});
