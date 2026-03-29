import { describe, it, expect, afterEach } from 'vitest';
import { LspClient } from '../../src/lsp/client.js';

// Track clients to clean up after tests
const clients: LspClient[] = [];
afterEach(async () => {
  for (const client of clients) {
    try { await client.close(); } catch { /* ignore */ }
  }
  clients.length = 0;
});

describe('LspClient', () => {
  describe('constructor', () => {
    it('creates an instance with server command', () => {
      const client = new LspClient({ command: 'typescript-language-server', args: ['--stdio'] });
      expect(client).toBeInstanceOf(LspClient);
    });

    it('creates an instance with all options', () => {
      const client = new LspClient(
        { command: 'test-lsp', args: ['--flag'] },
        {
          rootUri: 'file:///workspace',
          processCwd: '/tmp',
          processEnv: { PATH: '/usr/bin' },
          requestTimeoutMs: 10_000,
          clientName: 'test-client',
          clientVersion: '1.0.0',
        },
      );
      expect(client).toBeDefined();
    });
  });

  describe('pre-start method calls', () => {
    it('throws when calling didOpen before start', () => {
      const client = new LspClient({ command: 'fake-lsp' });
      expect(() =>
        client.didOpen({ uri: 'file:///test.ts', languageId: 'typescript', version: 1, text: '' }),
      ).toThrow('not active');
    });

    it('throws when calling hover before start', async () => {
      const client = new LspClient({ command: 'fake-lsp' });
      await expect(
        client.hover({ uri: 'file:///test.ts' }, { line: 0, character: 0 }),
      ).rejects.toThrow('not active');
    });

    it('throws when calling definition before start', async () => {
      const client = new LspClient({ command: 'fake-lsp' });
      await expect(
        client.definition({ uri: 'file:///test.ts' }, { line: 0, character: 0 }),
      ).rejects.toThrow('not active');
    });

    it('throws when calling didChange before start', () => {
      const client = new LspClient({ command: 'fake-lsp' });
      expect(() =>
        client.didChange({ uri: 'file:///test.ts', version: 2 }, [{ text: 'new content' }]),
      ).toThrow('not active');
    });

    it('throws when calling didClose before start', () => {
      const client = new LspClient({ command: 'fake-lsp' });
      expect(() => client.didClose({ uri: 'file:///test.ts' })).toThrow('not active');
    });
  });

  describe('close before start', () => {
    it('close is a no-op when not started', async () => {
      const client = new LspClient({ command: 'fake-lsp' });
      await expect(client.close()).resolves.not.toThrow();
    });
  });

  describe('start with invalid command', () => {
    it('rejects when server command does not exist', async () => {
      const client = new LspClient(
        { command: 'definitely-not-a-real-lsp-binary-xzy-999' },
        { requestTimeoutMs: 500 },
      );
      clients.push(client);
      await expect(client.start()).rejects.toThrow();
    });
  });

  describe('start with empty command', () => {
    it('rejects when server command is empty', async () => {
      const client = new LspClient(
        { command: '' },
        { requestTimeoutMs: 500 },
      );
      clients.push(client);
      await expect(client.start()).rejects.toThrow('LSP server command is required');
    });
  });

  describe('start with non-LSP process', () => {
    it('start rejects when server does not speak LSP', async () => {
      // 'cat' echoes stdin back but doesn't speak LSP protocol properly
      const client = new LspClient(
        { command: 'cat' },
        { requestTimeoutMs: 300 },
      );
      clients.push(client);
      // cat will echo back the initialize request, which gets parsed as a
      // server-initiated request rather than a response, so it fails
      await expect(client.start()).rejects.toThrow();
    });

    it('close after failed start is safe', async () => {
      const client = new LspClient(
        { command: 'cat' },
        { requestTimeoutMs: 300 },
      );
      clients.push(client);
      try { await client.start(); } catch { /* expected */ }
      // Should not throw
      await expect(client.close()).resolves.not.toThrow();
    });
  });

  describe('double close and double start', () => {
    it('double close is safe', async () => {
      const client = new LspClient({ command: 'fake-lsp' });
      await client.close();
      await expect(client.close()).resolves.not.toThrow();
    });
  });

  describe('SIGKILL fallback', () => {
    it('kills process via SIGKILL if SIGTERM is ignored', async () => {
      // Use a script that traps SIGTERM and ignores it
      const client = new LspClient(
        { command: 'bash', args: ['-c', 'trap "" TERM; read'] },
        { requestTimeoutMs: 200 },
      );
      clients.push(client);
      // start will fail because bash doesn't speak LSP, but the process will be spawned
      try { await client.start(); } catch { /* expected */ }
      // close should still complete (via SIGKILL fallback)
      await expect(client.close()).resolves.not.toThrow();
    });
  });
});
