import { describe, it, expect } from 'vitest';
import { parseConfigFile } from '../../src/parsing/config-parser.js';

describe('parseConfigFile', () => {
  describe('JSON configs', () => {
    it('parses simple JSON object', () => {
      const entries = parseConfigFile('config.json', '{"port": 3000, "host": "localhost"}');
      expect(entries).toHaveLength(2);
      expect(entries.find(e => e.key === 'port')).toMatchObject({
        key: 'port',
        value: '3000',
        inferredType: 'number',
      });
      expect(entries.find(e => e.key === 'host')).toMatchObject({
        key: 'host',
        value: 'localhost',
        inferredType: 'string',
      });
    });

    it('flattens nested JSON objects', () => {
      const content = JSON.stringify({
        database: { host: 'localhost', port: 5432 },
      });
      const entries = parseConfigFile('config.json', content);
      expect(entries.find(e => e.key === 'database.host')).toMatchObject({
        value: 'localhost',
        inferredType: 'string',
      });
      expect(entries.find(e => e.key === 'database.port')).toMatchObject({
        value: '5432',
        inferredType: 'number',
      });
    });

    it('handles boolean values', () => {
      const entries = parseConfigFile('config.json', '{"debug": true, "verbose": false}');
      expect(entries.find(e => e.key === 'debug')).toMatchObject({
        value: 'true',
        inferredType: 'boolean',
      });
      expect(entries.find(e => e.key === 'verbose')).toMatchObject({
        value: 'false',
        inferredType: 'boolean',
      });
    });

    it('handles null values', () => {
      const entries = parseConfigFile('config.json', '{"optional": null}');
      expect(entries.find(e => e.key === 'optional')).toMatchObject({
        value: null,
        inferredType: 'null',
        required: true,
      });
    });

    it('handles array values', () => {
      const entries = parseConfigFile('config.json', '{"tags": ["a", "b"]}');
      const entry = entries.find(e => e.key === 'tags')!;
      expect(entry.inferredType).toBe('array');
    });

    it('parses package.json with dependencies', () => {
      const pkg = JSON.stringify({
        name: 'my-app',
        version: '1.0.0',
        dependencies: { lodash: '^4.17.0' },
      });
      const entries = parseConfigFile('package.json', pkg);
      expect(entries.find(e => e.key === 'name')).toMatchObject({ value: 'my-app' });
      expect(entries.find(e => e.key === 'version')).toMatchObject({ value: '1.0.0' });
      expect(entries.find(e => e.key === 'dependencies.lodash')).toMatchObject({
        value: '^4.17.0',
      });
    });

    it('parses tsconfig.json', () => {
      const content = JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          strict: true,
        },
      });
      const entries = parseConfigFile('tsconfig.json', content);
      expect(entries.find(e => e.key === 'compilerOptions.target')).toMatchObject({
        value: 'ES2022',
      });
      expect(entries.find(e => e.key === 'compilerOptions.strict')).toMatchObject({
        value: 'true',
        inferredType: 'boolean',
      });
    });

    it('throws on invalid JSON', () => {
      expect(() => parseConfigFile('config.json', '{ invalid json')).toThrow('Invalid JSON');
    });

    it('throws when JSON root is not an object', () => {
      expect(() => parseConfigFile('config.json', '"just a string"')).toThrow('must be an object');
    });

    it('handles metadata objects with value/default/type/description', () => {
      const content = JSON.stringify({
        port: { value: 3000, default: 8080, type: 'number', description: 'Listen port' },
      });
      const entries = parseConfigFile('config.json', content);
      const entry = entries.find(e => e.key === 'port')!;
      expect(entry.value).toBe('3000');
      expect(entry.defaultValue).toBe('8080');
      expect(entry.inferredType).toBe('number');
      expect(entry.description).toBe('Listen port');
    });
  });

  describe('.env configs', () => {
    it('parses simple env file', () => {
      const content = 'DATABASE_URL=postgres://localhost/db\nPORT=3000\n';
      const entries = parseConfigFile('.env', content);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        key: 'DATABASE_URL',
        value: 'postgres://localhost/db',
        inferredType: 'string',
      });
      expect(entries[1]).toMatchObject({
        key: 'PORT',
        value: '3000',
        inferredType: 'string',
      });
    });

    it('handles quoted values', () => {
      const entries = parseConfigFile('.env', 'SECRET="my-secret"\n');
      expect(entries[0]).toMatchObject({ key: 'SECRET', value: 'my-secret' });
    });

    it('handles empty values as null', () => {
      const entries = parseConfigFile('.env', 'EMPTY=\n');
      expect(entries[0]).toMatchObject({ key: 'EMPTY', value: null, required: true });
    });

    it('handles comments as descriptions', () => {
      const content = '# Database connection string\nDB_URL=postgres://localhost\n';
      const entries = parseConfigFile('.env', content);
      expect(entries[0].description).toBe('Database connection string');
    });

    it('handles export prefix', () => {
      const entries = parseConfigFile('.env', 'export MY_VAR=hello\n');
      expect(entries[0]).toMatchObject({ key: 'MY_VAR', value: 'hello' });
    });

    it('handles .env.local variant', () => {
      const entries = parseConfigFile('.env.local', 'KEY=value\n');
      expect(entries).toHaveLength(1);
    });

    it('skips blank lines and resets pending description', () => {
      const content = '# first comment\n\nKEY=value\n';
      const entries = parseConfigFile('.env', content);
      // Blank line resets pending description
      expect(entries[0].description).toBeUndefined();
    });

    it('throws on invalid env entry', () => {
      expect(() => parseConfigFile('.env', 'INVALID LINE WITHOUT EQUALS\n')).toThrow('Invalid .env entry');
    });
  });

  describe('YAML configs', () => {
    it('parses simple YAML', () => {
      const content = 'host: localhost\nport: 3000\n';
      const entries = parseConfigFile('config.yaml', content);
      expect(entries.find(e => e.key === 'host')).toMatchObject({ value: 'localhost' });
      expect(entries.find(e => e.key === 'port')).toMatchObject({ value: '3000' });
    });

    it('parses nested YAML', () => {
      const content = 'database:\n  host: localhost\n  port: 5432\n';
      const entries = parseConfigFile('config.yml', content);
      expect(entries.find(e => e.key === 'database.host')).toMatchObject({ value: 'localhost' });
      expect(entries.find(e => e.key === 'database.port')).toMatchObject({ value: '5432' });
    });

    it('handles boolean values', () => {
      const entries = parseConfigFile('config.yaml', 'debug: true\n');
      expect(entries[0]).toMatchObject({ value: 'true', inferredType: 'boolean' });
    });

    it('handles null values', () => {
      const entries = parseConfigFile('config.yaml', 'nothing: null\n');
      expect(entries[0]).toMatchObject({ value: null, inferredType: 'null' });
    });

    it('skips comments', () => {
      const content = '# This is a comment\nkey: value\n';
      const entries = parseConfigFile('config.yaml', content);
      expect(entries).toHaveLength(1);
    });

    it('throws on tabs', () => {
      expect(() => parseConfigFile('config.yaml', 'key:\n\tvalue: bad\n')).toThrow('tabs');
    });

    it('throws on missing colon', () => {
      expect(() => parseConfigFile('config.yaml', 'no colon here\n')).toThrow('Invalid YAML');
    });
  });

  describe('TOML configs', () => {
    it('parses simple TOML', () => {
      const content = 'name = "my-app"\nport = 3000\n';
      const entries = parseConfigFile('config.toml', content);
      expect(entries.find(e => e.key === 'name')).toMatchObject({ value: 'my-app' });
      expect(entries.find(e => e.key === 'port')).toMatchObject({ value: '3000' });
    });

    it('parses TOML sections', () => {
      const content = '[database]\nhost = "localhost"\nport = 5432\n';
      const entries = parseConfigFile('config.toml', content);
      expect(entries.find(e => e.key === 'database.host')).toMatchObject({ value: 'localhost' });
      expect(entries.find(e => e.key === 'database.port')).toMatchObject({ value: '5432' });
    });

    it('handles boolean values', () => {
      const entries = parseConfigFile('config.toml', 'debug = true\n');
      expect(entries[0]).toMatchObject({ value: 'true', inferredType: 'boolean' });
    });

    it('handles array values', () => {
      const entries = parseConfigFile('config.toml', 'tags = ["a", "b"]\n');
      expect(entries[0].inferredType).toBe('array');
    });

    it('skips comments', () => {
      const content = '# comment\nkey = "value"\n';
      const entries = parseConfigFile('config.toml', content);
      expect(entries).toHaveLength(1);
    });

    it('throws on invalid TOML line', () => {
      expect(() => parseConfigFile('config.toml', 'invalid line\n')).toThrow('Invalid TOML');
    });

    it('handles dotted keys', () => {
      const content = 'database.host = "localhost"\n';
      const entries = parseConfigFile('config.toml', content);
      expect(entries.find(e => e.key === 'database.host')).toMatchObject({ value: 'localhost' });
    });
  });

  describe('unsupported formats', () => {
    it('throws for unsupported extension', () => {
      expect(() => parseConfigFile('config.xml', '<root/>')).toThrow('Unsupported config format');
    });
  });
});
