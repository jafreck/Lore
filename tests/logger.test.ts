import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import {
  LoreLogger,
  LogLevel,
  LOG_LEVEL_NAMES,
  initLogger,
  getLogger,
  resetLogger,
  type LogEntry,
  type ToolCallFields,
} from '../src/logger.js';

function readLogLines(filePath: string): LogEntry[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

describe('LoreLogger', () => {
  let logPath: string;

  beforeEach(() => {
    logPath = join(tmpdir(), `lore-logger-test-${Date.now()}-${Math.random()}.log`);
    resetLogger();
  });

  afterEach(() => {
    resetLogger();
    if (existsSync(logPath)) unlinkSync(logPath);
  });

  // ── Basic logging ───────────────────────────────────────────────────────

  it('should write NDJSON log entries to a file', () => {
    const log = new LoreLogger({ level: LogLevel.DEBUG, logFile: logPath });
    log.info('test', 'hello world');
    log.close();

    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('info');
    expect(lines[0]!.component).toBe('test');
    expect(lines[0]!.message).toBe('hello world');
    expect(lines[0]!.timestamp).toBeDefined();
  });

  it('should respect the minimum log level', () => {
    const log = new LoreLogger({ level: LogLevel.WARN, logFile: logPath });
    log.debug('test', 'ignored');
    log.info('test', 'also ignored');
    log.warn('test', 'included');
    log.error('test', 'also included');
    log.close();

    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.level).toBe('warn');
    expect(lines[1]!.level).toBe('error');
  });

  it('should emit nothing for SILENT level', () => {
    const log = new LoreLogger({ level: LogLevel.SILENT, logFile: logPath });
    log.debug('test', 'nope');
    log.info('test', 'nope');
    log.warn('test', 'nope');
    log.error('test', 'nope');
    log.close();

    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(0);
  });

  it('should include extra fields in the log entry', () => {
    const log = new LoreLogger({ level: LogLevel.DEBUG, logFile: logPath });
    log.info('test', 'with extras', { foo: 'bar', count: 42 });
    log.close();

    const lines = readLogLines(logPath);
    expect(lines[0]!.foo).toBe('bar');
    expect(lines[0]!.count).toBe(42);
  });

  // ── Tool call logging ──────────────────────────────────────────────────

  it('should log tool calls with request/response and timing', () => {
    const log = new LoreLogger({ level: LogLevel.DEBUG, logFile: logPath });
    log.toolCall({
      tool: 'lore_lookup',
      requestBody: { kind: 'symbol', query: 'MyClass' },
      responseBody: { symbols: [] },
      status: 'success',
      durationMs: 12.34,
    });
    log.close();

    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(1);
    const entry = lines[0]!;
    expect(entry.component).toBe('mcp-tool');
    expect(entry.tool).toBe('lore_lookup');
    expect(entry.status).toBe('success');
    expect(entry.durationMs).toBe(12.34);
    expect(entry.requestBody).toEqual({ kind: 'symbol', query: 'MyClass' });
    expect(entry.responseBody).toEqual({ symbols: [] });
  });

  it('should log tool call errors at error level', () => {
    const log = new LoreLogger({ level: LogLevel.DEBUG, logFile: logPath });
    log.toolCall({
      tool: 'lore_search',
      requestBody: { query: 'test' },
      status: 'error',
      durationMs: 5.0,
      error: 'table not found',
    });
    log.close();

    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('error');
    expect(lines[0]!.error).toBe('table not found');
  });

  // ── Startup / indexing helpers ─────────────────────────────────────────

  it('should log startup events with fields', () => {
    const log = new LoreLogger({ level: LogLevel.DEBUG, logFile: logPath });
    log.startup('server ready', {
      dbPath: '/tmp/test.db',
      dbSizeBytes: 1024,
      embeddingModel: 'test-model',
      embeddingReady: true,
      totalFiles: 100,
      totalSymbols: 500,
      totalDocs: 10,
      totalEdges: 200,
    });
    log.close();

    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.component).toBe('startup');
    expect(lines[0]!.totalSymbols).toBe(500);
    expect(lines[0]!.dbSizeBytes).toBe(1024);
  });

  it('should log indexing events', () => {
    const log = new LoreLogger({ level: LogLevel.DEBUG, logFile: logPath });
    log.indexing('walk complete', { fileCount: 50, docCount: 5 });
    log.close();

    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.component).toBe('indexer');
    expect(lines[0]!.fileCount).toBe(50);
  });

  // ── Body truncation ────────────────────────────────────────────────────

  it('should truncate large bodies', () => {
    const log = new LoreLogger({ level: LogLevel.DEBUG, logFile: logPath, maxBodySize: 32 });
    log.toolCall({
      tool: 'lore_search',
      requestBody: { query: 'a'.repeat(100) },
      responseBody: { results: 'x'.repeat(100) },
      status: 'success',
      durationMs: 1,
    });
    log.close();

    const lines = readLogLines(logPath);
    const entry = lines[0]!;
    expect(typeof entry.requestBody).toBe('string');
    expect((entry.requestBody as string).endsWith('...(truncated)')).toBe(true);
    expect(typeof entry.responseBody).toBe('string');
    expect((entry.responseBody as string).endsWith('...(truncated)')).toBe(true);
  });

  // ── Global logger ─────────────────────────────────────────────────────

  it('getLogger returns a SILENT no-op logger by default', () => {
    const log = getLogger();
    expect(log.level).toBe(LogLevel.SILENT);
  });

  it('initLogger sets the global logger', () => {
    const log = initLogger({ level: LogLevel.DEBUG, logFile: logPath });
    expect(getLogger()).toBe(log);
    log.info('global', 'test');
    log.close();

    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(1);
  });

  it('resetLogger clears the global logger', () => {
    initLogger({ level: LogLevel.DEBUG, logFile: logPath });
    resetLogger();
    // After reset, getLogger returns a new silent logger
    expect(getLogger().level).toBe(LogLevel.SILENT);
  });

  // ── LOG_LEVEL_NAMES ────────────────────────────────────────────────────

  it('should map level name strings to LogLevel values', () => {
    expect(LOG_LEVEL_NAMES['debug']).toBe(LogLevel.DEBUG);
    expect(LOG_LEVEL_NAMES['info']).toBe(LogLevel.INFO);
    expect(LOG_LEVEL_NAMES['warn']).toBe(LogLevel.WARN);
    expect(LOG_LEVEL_NAMES['error']).toBe(LogLevel.ERROR);
    expect(LOG_LEVEL_NAMES['silent']).toBe(LogLevel.SILENT);
  });
});
