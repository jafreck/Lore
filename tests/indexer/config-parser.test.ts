import { describe, expect, it } from 'vitest';
import { parseConfigFile } from '../../src/indexer/config-parser.js';

describe('parseConfigFile', () => {
  it('parses .env files into normalized entries', () => {
    const entries = parseConfigFile('.env', '# public API URL\nAPI_URL=https://example.com\nEMPTY=\n');

    expect(entries).toEqual([
      {
        key: 'API_URL',
        value: 'https://example.com',
        defaultValue: 'https://example.com',
        inferredType: 'string',
        required: false,
        description: 'public API URL',
      },
      {
        key: 'EMPTY',
        value: null,
        defaultValue: null,
        inferredType: 'null',
        required: true,
      },
    ]);
  });

  it('parses quoted and exported .env entries', () => {
    const entries = parseConfigFile('.env.local', '# auth\nexport TOKEN="abc123"\nFLAG=\'true\'\n');

    expect(entries).toEqual([
      {
        key: 'TOKEN',
        value: 'abc123',
        defaultValue: 'abc123',
        inferredType: 'string',
        required: false,
        description: 'auth',
      },
      {
        key: 'FLAG',
        value: 'true',
        defaultValue: 'true',
        inferredType: 'string',
        required: false,
      },
    ]);
  });

  it('parses JSON config files with metadata and nested keys', () => {
    const entries = parseConfigFile(
      'app.config.json',
      JSON.stringify({
        port: 3000,
        featureFlag: {
          default: true,
          description: 'Enable feature',
        },
        db: {
          host: 'localhost',
        },
      }),
    );

    expect(entries).toEqual([
      {
        key: 'port',
        value: '3000',
        defaultValue: '3000',
        inferredType: 'number',
        required: false,
      },
      {
        key: 'featureFlag',
        value: 'true',
        defaultValue: 'true',
        inferredType: 'boolean',
        required: false,
        description: 'Enable feature',
      },
      {
        key: 'db.host',
        value: 'localhost',
        defaultValue: 'localhost',
        inferredType: 'string',
        required: false,
      },
    ]);
  });

  it('parses YAML config files', () => {
    const entries = parseConfigFile(
      'service.yaml',
      'apiUrl: https://example.com\ncache:\n  ttl: 60\n',
    );

    expect(entries).toEqual([
      {
        key: 'apiUrl',
        value: 'https://example.com',
        defaultValue: 'https://example.com',
        inferredType: 'string',
        required: false,
      },
      {
        key: 'cache.ttl',
        value: '60',
        defaultValue: '60',
        inferredType: 'number',
        required: false,
      },
    ]);
  });

  it('parses TOML config files', () => {
    const entries = parseConfigFile(
      'service.toml',
      'title = "Demo"\n[server]\nport = 8080\nenabled = true\n',
    );

    expect(entries).toEqual([
      {
        key: 'title',
        value: 'Demo',
        defaultValue: 'Demo',
        inferredType: 'string',
        required: false,
      },
      {
        key: 'server.port',
        value: '8080',
        defaultValue: '8080',
        inferredType: 'number',
        required: false,
      },
      {
        key: 'server.enabled',
        value: 'true',
        defaultValue: 'true',
        inferredType: 'boolean',
        required: false,
      },
    ]);
  });

  it('throws for malformed config input', () => {
    expect(() => parseConfigFile('broken.json', '{"foo":')).toThrow(/Invalid JSON config/u);
  });

  it('throws for unsupported config formats', () => {
    expect(() => parseConfigFile('config.ini', 'a=b')).toThrow(/Unsupported config format/u);
  });

  it('throws for malformed YAML input', () => {
    expect(() => parseConfigFile('broken.yaml', 'root:\n\tchild: 1\n')).toThrow(/Invalid YAML config/u);
  });

  it('throws for malformed TOML input', () => {
    expect(() => parseConfigFile('broken.toml', 'invalid line')).toThrow(/Invalid TOML config/u);
  });
});
