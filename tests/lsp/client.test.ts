import { describe, it, expect } from 'vitest';
import { LspClient } from '../../src/lsp/client.js';

describe('LspClient', () => {
  describe('constructor', () => {
    it('creates an instance with server command', () => {
      const client = new LspClient({ command: 'typescript-language-server', args: ['--stdio'] });
      expect(client).toBeInstanceOf(LspClient);
    });

    it('creates an instance with default options', () => {
      const client = new LspClient({ command: 'some-lsp' });
      expect(client).toBeDefined();
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
      await expect(client.start()).rejects.toThrow();
    });
  });
});
