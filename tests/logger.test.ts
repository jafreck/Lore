import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  LoreLogger,
  LogLevel,
  LOG_LEVEL_NAMES,
  initLogger,
  getLogger,
  resetLogger,
} from '../src/logger.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-logger-'));
  resetLogger();
});

afterEach(() => {
  resetLogger();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('LogLevel', () => {
  it('has expected ordering', () => {
    expect(LogLevel.DEBUG).toBeLessThan(LogLevel.INFO);
    expect(LogLevel.INFO).toBeLessThan(LogLevel.WARN);
    expect(LogLevel.WARN).toBeLessThan(LogLevel.ERROR);
    expect(LogLevel.ERROR).toBeLessThan(LogLevel.SILENT);
  });
});

describe('LOG_LEVEL_NAMES', () => {
  it('maps string names to levels', () => {
    expect(LOG_LEVEL_NAMES.debug).toBe(LogLevel.DEBUG);
    expect(LOG_LEVEL_NAMES.info).toBe(LogLevel.INFO);
    expect(LOG_LEVEL_NAMES.warn).toBe(LogLevel.WARN);
    expect(LOG_LEVEL_NAMES.error).toBe(LogLevel.ERROR);
    expect(LOG_LEVEL_NAMES.silent).toBe(LogLevel.SILENT);
  });
});

describe('LoreLogger', () => {
  it('defaults to INFO level with no log file', () => {
    const logger = new LoreLogger();
    expect(logger.level).toBe(LogLevel.INFO);
    expect(logger.logFile).toBeUndefined();
  });

  it('accepts custom level', () => {
    const logger = new LoreLogger({ level: LogLevel.DEBUG });
    expect(logger.level).toBe(LogLevel.DEBUG);
  });

  it('writes NDJSON to log file', () => {
    const logFile = path.join(tmpDir, 'test.log');
    const logger = new LoreLogger({ level: LogLevel.DEBUG, logFile });

    logger.info('test', 'hello world');
    logger.close();

    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.component).toBe('test');
    expect(parsed.message).toBe('hello world');
    expect(parsed.timestamp).toBeDefined();
  });

  it('respects log level filtering', () => {
    const logFile = path.join(tmpDir, 'filter.log');
    const logger = new LoreLogger({ level: LogLevel.WARN, logFile });

    logger.debug('test', 'should not appear');
    logger.info('test', 'should not appear');
    logger.warn('test', 'should appear');
    logger.error('test', 'should also appear');
    logger.close();

    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('includes extra fields', () => {
    const logFile = path.join(tmpDir, 'extra.log');
    const logger = new LoreLogger({ level: LogLevel.DEBUG, logFile });

    logger.info('test', 'with extras', { count: 42, flag: true });
    logger.close();

    const parsed = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    expect(parsed.count).toBe(42);
    expect(parsed.flag).toBe(true);
  });

  it('SILENT level suppresses all output', () => {
    const logFile = path.join(tmpDir, 'silent.log');
    const logger = new LoreLogger({ level: LogLevel.SILENT, logFile });

    logger.debug('t', 'a');
    logger.info('t', 'b');
    logger.warn('t', 'c');
    logger.error('t', 'd');
    logger.close();

    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toBe('');
  });

  describe('specialised helpers', () => {
    it('toolCall logs MCP tool invocation', () => {
      const logFile = path.join(tmpDir, 'tool.log');
      const logger = new LoreLogger({ level: LogLevel.DEBUG, logFile });

      logger.toolCall({
        tool: 'lore_search',
        requestBody: { query: 'test' },
        responseBody: { results: [] },
        status: 'success',
        durationMs: 42,
      });
      logger.close();

      const parsed = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
      expect(parsed.tool).toBe('lore_search');
      expect(parsed.status).toBe('success');
      expect(parsed.durationMs).toBe(42);
    });

    it('toolCall with error status logs at ERROR level', () => {
      const logFile = path.join(tmpDir, 'tool-err.log');
      const logger = new LoreLogger({ level: LogLevel.DEBUG, logFile });

      logger.toolCall({
        tool: 'lore_search',
        requestBody: {},
        status: 'error',
        durationMs: 10,
        error: 'something failed',
      });
      logger.close();

      const parsed = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
      expect(parsed.level).toBe('error');
      expect(parsed.error).toBe('something failed');
    });

    it('startup logs at INFO level', () => {
      const logFile = path.join(tmpDir, 'startup.log');
      const logger = new LoreLogger({ level: LogLevel.DEBUG, logFile });

      logger.startup('server started', { dbPath: '/tmp/lore.db' });
      logger.close();

      const parsed = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
      expect(parsed.level).toBe('info');
      expect(parsed.component).toBe('startup');
      expect(parsed.message).toBe('server started');
      expect(parsed.dbPath).toBe('/tmp/lore.db');
    });

    it('indexing logs at INFO level', () => {
      const logFile = path.join(tmpDir, 'indexing.log');
      const logger = new LoreLogger({ level: LogLevel.DEBUG, logFile });

      logger.indexing('files indexed', { count: 100 });
      logger.close();

      const parsed = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
      expect(parsed.level).toBe('info');
      expect(parsed.component).toBe('indexer');
      expect(parsed.message).toBe('files indexed');
      expect(parsed.count).toBe(100);
    });
  });

  describe('body truncation', () => {
    it('truncates large request/response bodies', () => {
      const logFile = path.join(tmpDir, 'trunc.log');
      const logger = new LoreLogger({ level: LogLevel.DEBUG, logFile, maxBodySize: 50 });

      logger.toolCall({
        tool: 'test',
        requestBody: 'x'.repeat(100),
        status: 'success',
        durationMs: 1,
      });
      logger.close();

      const parsed = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
      expect(String(parsed.requestBody).length).toBeLessThanOrEqual(65);
      expect(String(parsed.requestBody)).toContain('(truncated)');
    });
  });

  describe('close', () => {
    it('is safe to call multiple times', () => {
      const logFile = path.join(tmpDir, 'close.log');
      const logger = new LoreLogger({ level: LogLevel.DEBUG, logFile });
      logger.close();
      expect(() => logger.close()).not.toThrow();
    });
  });

  describe('creates parent directory', () => {
    it('creates nested directory for log file', () => {
      const logFile = path.join(tmpDir, 'sub', 'dir', 'test.log');
      const logger = new LoreLogger({ level: LogLevel.DEBUG, logFile });
      logger.info('test', 'nested');
      logger.close();

      expect(fs.existsSync(logFile)).toBe(true);
    });
  });
});

describe('global logger', () => {
  it('getLogger returns SILENT logger when not initialized', () => {
    const logger = getLogger();
    expect(logger.level).toBe(LogLevel.SILENT);
  });

  it('initLogger sets the global logger', () => {
    const logger = initLogger({ level: LogLevel.DEBUG });
    expect(getLogger()).toBe(logger);
    expect(getLogger().level).toBe(LogLevel.DEBUG);
  });

  it('resetLogger clears the global logger', () => {
    initLogger({ level: LogLevel.DEBUG });
    resetLogger();
    const logger = getLogger();
    expect(logger.level).toBe(LogLevel.SILENT);
  });

  it('initLogger replaces previous global logger', () => {
    const first = initLogger({ level: LogLevel.DEBUG });
    const second = initLogger({ level: LogLevel.WARN });
    expect(getLogger()).toBe(second);
    expect(getLogger()).not.toBe(first);
  });
});
