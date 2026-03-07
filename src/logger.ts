/**
 * @module logger
 *
 * Structured JSON logger for the Lore MCP server and indexer.
 *
 * Writes newline-delimited JSON (NDJSON) log entries to a file on disk.
 * Each entry includes a timestamp, level, component, message, and optional
 * structured fields (tool name, request/response bodies, latency, status).
 *
 * Usage:
 *   import { LoreLogger, LogLevel } from './logger.js';
 *   const log = new LoreLogger({ level: LogLevel.DEBUG, logFile: '/tmp/lore.log' });
 *   log.info('server', 'Server started', { dbPath: '/path/to/db' });
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Log levels ───────────────────────────────────────────────────────────────

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

/** Map from lowercase string to `LogLevel` for CLI parsing. */
export const LOG_LEVEL_NAMES: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
  silent: LogLevel.SILENT,
};

function levelName(level: LogLevel): string {
  switch (level) {
    case LogLevel.DEBUG:
      return 'debug';
    case LogLevel.INFO:
      return 'info';
    case LogLevel.WARN:
      return 'warn';
    case LogLevel.ERROR:
      return 'error';
    case LogLevel.SILENT:
      return 'silent';
  }
}

// ─── Log entry types ──────────────────────────────────────────────────────────

/** Base fields present on every log entry. */
export interface LogEntry {
  timestamp: string;
  level: string;
  component: string;
  message: string;
  [key: string]: unknown;
}

/** Extra fields for MCP tool-call logs. */
export interface ToolCallFields {
  tool: string;
  requestBody: unknown;
  responseBody?: unknown;
  status: 'success' | 'error';
  durationMs: number;
  error?: string;
}

/** Extra fields for startup / indexing logs. */
export interface StartupFields {
  dbPath?: string;
  dbSizeBytes?: number;
  embeddingModel?: string | null;
  embeddingReady?: boolean;
  totalFiles?: number;
  totalSymbols?: number;
  totalDocs?: number;
  totalEdges?: number;
  commitCount?: number;
  indexDurationMs?: number;
  [key: string]: unknown;
}

// ─── Logger options ───────────────────────────────────────────────────────────

export interface LoreLoggerOptions {
  /** Minimum level to emit (default: INFO). */
  level?: LogLevel;
  /** Absolute or relative path to the log file. Parent directories are created. */
  logFile?: string;
  /**
   * Maximum size of serialised request/response bodies in characters.
   * Larger payloads are truncated with a "(truncated)" marker.
   * Default: 8192.
   */
  maxBodySize?: number;
}

// ─── Logger implementation ────────────────────────────────────────────────────

export class LoreLogger {
  readonly level: LogLevel;
  readonly logFile: string | undefined;
  private fd: number | undefined;
  private readonly maxBodySize: number;

  constructor(options: LoreLoggerOptions = {}) {
    this.level = options.level ?? LogLevel.INFO;
    this.logFile = options.logFile;
    this.maxBodySize = options.maxBodySize ?? 8192;

    if (this.logFile) {
      const dir = path.dirname(this.logFile);
      fs.mkdirSync(dir, { recursive: true });
      this.fd = fs.openSync(this.logFile, 'a');
    }
  }

  // ── Core log methods ─────────────────────────────────────────────────────

  debug(component: string, message: string, extra?: Record<string, unknown>): void {
    this.write(LogLevel.DEBUG, component, message, extra);
  }

  info(component: string, message: string, extra?: Record<string, unknown>): void {
    this.write(LogLevel.INFO, component, message, extra);
  }

  warn(component: string, message: string, extra?: Record<string, unknown>): void {
    this.write(LogLevel.WARN, component, message, extra);
  }

  error(component: string, message: string, extra?: Record<string, unknown>): void {
    this.write(LogLevel.ERROR, component, message, extra);
  }

  // ── Specialised helpers ──────────────────────────────────────────────────

  /**
   * Log an MCP tool invocation with request/response, status, and timing.
   */
  toolCall(fields: ToolCallFields): void {
    const extra: Record<string, unknown> = {
      tool: fields.tool,
      requestBody: this.truncateBody(fields.requestBody),
      status: fields.status,
      durationMs: fields.durationMs,
    };
    if (fields.responseBody !== undefined) {
      extra.responseBody = this.truncateBody(fields.responseBody);
    }
    if (fields.error) {
      extra.error = fields.error;
    }
    const level = fields.status === 'error' ? LogLevel.ERROR : LogLevel.INFO;
    this.write(level, 'mcp-tool', `${fields.tool} ${fields.status}`, extra);
  }

  /**
   * Log a startup event with optional DB / embedding stats.
   */
  startup(message: string, fields?: StartupFields): void {
    this.write(LogLevel.INFO, 'startup', message, fields as Record<string, unknown> | undefined);
  }

  /**
   * Log indexing progress or completion.
   */
  indexing(message: string, fields?: Record<string, unknown>): void {
    this.write(LogLevel.INFO, 'indexer', message, fields);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Flush and close the log file descriptor. */
  close(): void {
    if (this.fd !== undefined) {
      fs.closeSync(this.fd);
      this.fd = undefined;
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private write(
    level: LogLevel,
    component: string,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    if (level < this.level) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: levelName(level),
      component,
      message,
      ...extra,
    };

    const line = JSON.stringify(entry) + '\n';

    if (this.fd !== undefined) {
      fs.writeSync(this.fd, line);
    }
  }

  /**
   * Truncate large payloads to keep log files manageable.
   * Returns the original value if within limits, otherwise a truncated string.
   */
  private truncateBody(body: unknown): unknown {
    if (body === undefined || body === null) return body;
    const serialised = typeof body === 'string' ? body : JSON.stringify(body);
    if (serialised.length <= this.maxBodySize) return body;
    return serialised.slice(0, this.maxBodySize) + '...(truncated)';
  }
}

// ─── Singleton / global logger ────────────────────────────────────────────────

let _globalLogger: LoreLogger | undefined;

/** Retrieve the global logger instance (creates a no-op SILENT logger if not initialised). */
export function getLogger(): LoreLogger {
  if (!_globalLogger) {
    _globalLogger = new LoreLogger({ level: LogLevel.SILENT });
  }
  return _globalLogger;
}

/** Initialise the global logger. Should be called once at process startup. */
export function initLogger(options: LoreLoggerOptions): LoreLogger {
  if (_globalLogger) {
    _globalLogger.close();
  }
  _globalLogger = new LoreLogger(options);
  return _globalLogger;
}

/** Reset the global logger (primarily for tests). */
export function resetLogger(): void {
  if (_globalLogger) {
    _globalLogger.close();
    _globalLogger = undefined;
  }
}
