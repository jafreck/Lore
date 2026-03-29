import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { trackProcess } from '../process-tracker.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface LspServerCommand {
  command: string;
  args?: string[];
}

export interface LspClientOptions {
  rootUri?: string;
  processCwd?: string;
  processEnv?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface TextDocumentIdentifier {
  uri: string;
}

export interface TextDocumentItem extends TextDocumentIdentifier {
  languageId: string;
  version: number;
  text: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
  version: number;
}

export interface TextDocumentContentChangeEvent {
  text: string;
}

// ─── DocumentSymbol types ─────────────────────────────────────────────────────

export interface DocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
  children?: DocumentSymbol[];
}

// ─── CallHierarchy types ──────────────────────────────────────────────────────

export interface CallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
  data?: unknown;
}

export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: LspRange[];
}

export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: LspRange[];
}

// ─── SemanticTokens types ─────────────────────────────────────────────────────

export interface SemanticTokensResult {
  resultId?: string;
  data: number[];
}

/** Standard LSP semantic token type legend (index → type name). */
export const SEMANTIC_TOKEN_TYPES = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct',
  'typeParameter', 'parameter', 'variable', 'property', 'enumMember',
  'event', 'function', 'method', 'macro', 'keyword', 'modifier',
  'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
] as const;

export const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated',
  'abstract', 'async', 'modification', 'documentation', 'defaultLibrary',
] as const;

// ─── Server capability tracking ───────────────────────────────────────────────

export interface ServerCapabilities {
  documentSymbol: boolean;
  callHierarchy: boolean;
  semanticTokensFull: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

export class LspClient {
  private readonly server: LspServerCommand;
  private readonly options: LspClientOptions;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private started = false;
  private exited = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  private exitPromise: Promise<number | null> | null = null;
  private _serverCapabilities: ServerCapabilities = {
    documentSymbol: false,
    callHierarchy: false,
    semanticTokensFull: false,
  };

  constructor(server: LspServerCommand, options: LspClientOptions = {}) {
    this.server = server;
    this.options = options;
  }

  /** Capabilities reported by the server after initialization. */
  get serverCapabilities(): ServerCapabilities {
    return this._serverCapabilities;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.server.command) {
      throw new Error('LSP server command is required');
    }

    const child = spawn(this.server.command, this.server.args ?? [], {
      cwd: this.options.processCwd,
      env: this.options.processEnv ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    trackProcess(child);

    this.child = child;
    this.started = true;
    this.exited = false;

    // Drain stderr to prevent the 64 KB pipe buffer from filling up and
    // deadlocking verbose LSP servers.
    child.stderr.resume();

    this.exitPromise = new Promise((resolve) => {
      child.once('exit', (code) => {
        this.exited = true;
        this.rejectPendingRequests(new Error(`LSP server exited with code ${code ?? 'null'}`));
        resolve(code);
      });
    });

    child.once('error', (error) => {
      this.exited = true;
      this.rejectPendingRequests(new Error(`Failed to spawn LSP server: ${error.message}`));
    });

    child.stdout.on('data', (chunk: Buffer) => {
      this.consumeStdout(chunk);
    });

    try {
      const rootUri = this.options.rootUri ?? 'file:///';
      const initResult = await this.request('initialize', {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true,
            },
            callHierarchy: {
              dynamicRegistration: false,
            },
            semanticTokens: {
              requests: { full: true },
              tokenTypes: [...SEMANTIC_TOKEN_TYPES],
              tokenModifiers: [...SEMANTIC_TOKEN_MODIFIERS],
              formats: ['relative'],
            },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { dynamicRegistration: false },
          },
        },
        clientInfo: {
          name: this.options.clientName ?? 'lore-indexer',
          version: this.options.clientVersion ?? '0.0.0',
        },
      });
      this.parseServerCapabilities(initResult);
      this.notify('initialized', {});
    } catch (initErr) {
      // If initialization fails, kill the orphan process and reset state.
      try { child.kill(); } catch { /* ignore */ }
      this.child = null;
      this.started = false;
      this.exited = true;
      throw initErr;
    }
  }

  didOpen(document: TextDocumentItem): void {
    this.ensureActive();
    this.notify('textDocument/didOpen', {
      textDocument: document,
    });
  }

  didChange(document: VersionedTextDocumentIdentifier, changes: TextDocumentContentChangeEvent[]): void {
    this.ensureActive();
    this.notify('textDocument/didChange', {
      textDocument: document,
      contentChanges: changes,
    });
  }

  didClose(document: TextDocumentIdentifier): void {
    this.ensureActive();
    this.notify('textDocument/didClose', {
      textDocument: document,
    });
  }

  async hover(document: TextDocumentIdentifier, position: LspPosition): Promise<unknown> {
    this.ensureActive();
    return this.request('textDocument/hover', {
      textDocument: document,
      position,
    });
  }

  async definition(document: TextDocumentIdentifier, position: LspPosition): Promise<unknown> {
    this.ensureActive();
    return this.request('textDocument/definition', {
      textDocument: document,
      position,
    });
  }

  /**
   * Request the full symbol tree for a document.
   * Returns hierarchical `DocumentSymbol[]` when the server supports it.
   */
  async documentSymbol(document: TextDocumentIdentifier): Promise<DocumentSymbol[]> {
    this.ensureActive();
    const result = await this.request('textDocument/documentSymbol', {
      textDocument: document,
    });
    if (!Array.isArray(result)) return [];
    return result as DocumentSymbol[];
  }

  /**
   * Prepare call hierarchy items at a given position.
   * Returns `CallHierarchyItem[]` that can be passed to `callHierarchyOutgoing`.
   */
  async prepareCallHierarchy(
    document: TextDocumentIdentifier,
    position: LspPosition,
  ): Promise<CallHierarchyItem[]> {
    this.ensureActive();
    const result = await this.request('textDocument/prepareCallHierarchy', {
      textDocument: document,
      position,
    });
    if (!Array.isArray(result)) return [];
    return result as CallHierarchyItem[];
  }

  /**
   * Get outgoing calls from a call hierarchy item.
   */
  async callHierarchyOutgoing(
    item: CallHierarchyItem,
  ): Promise<CallHierarchyOutgoingCall[]> {
    this.ensureActive();
    const result = await this.request('callHierarchy/outgoingCalls', {
      item,
    });
    if (!Array.isArray(result)) return [];
    return result as CallHierarchyOutgoingCall[];
  }

  /**
   * Get incoming calls to a call hierarchy item.
   */
  async callHierarchyIncoming(
    item: CallHierarchyItem,
  ): Promise<CallHierarchyIncomingCall[]> {
    this.ensureActive();
    const result = await this.request('callHierarchy/incomingCalls', {
      item,
    });
    if (!Array.isArray(result)) return [];
    return result as CallHierarchyIncomingCall[];
  }

  /**
   * Request full semantic tokens for a document.
   * Returns encoded token data (relative positions, 5 ints per token).
   */
  async semanticTokensFull(
    document: TextDocumentIdentifier,
  ): Promise<SemanticTokensResult | null> {
    this.ensureActive();
    const result = await this.request('textDocument/semanticTokens/full', {
      textDocument: document,
    });
    if (!result || typeof result !== 'object') return null;
    return result as SemanticTokensResult;
  }

  async close(): Promise<void> {
    if (!this.started || !this.child || !this.exitPromise) return;

    const child = this.child;
    if (!this.exited) {
      try {
        await this.request('shutdown', null);
        this.notify('exit');
      } catch {
        // Server may have already exited after shutdown — legal per LSP spec.
      }
      try { child.stdin.end(); } catch { /* ignore */ }
      await this.waitForExit(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    }

    this.rejectPendingRequests(new Error('LSP client closed'));
    this.buffer = Buffer.alloc(0);
    this.child = null;
    this.exitPromise = null;
    this.started = false;
  }

  /**
   * Parse server capabilities from the InitializeResult to know which
   * features are available.
   */
  private parseServerCapabilities(initResult: unknown): void {
    if (!initResult || typeof initResult !== 'object') return;
    const result = initResult as Record<string, unknown>;
    const caps = result.capabilities;
    if (!caps || typeof caps !== 'object') return;
    const c = caps as Record<string, unknown>;

    this._serverCapabilities = {
      documentSymbol: c.documentSymbolProvider !== undefined && c.documentSymbolProvider !== false,
      callHierarchy: c.callHierarchyProvider !== undefined && c.callHierarchyProvider !== false,
      semanticTokensFull: (() => {
        if (!c.semanticTokensProvider || typeof c.semanticTokensProvider !== 'object') return false;
        const stp = c.semanticTokensProvider as Record<string, unknown>;
        return stp.full !== undefined && stp.full !== false;
      })(),
    };
  }

  private consumeStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/iu);
      if (!match) {
        this.rejectPendingRequests(new Error(`Invalid LSP header: ${header}`));
        this.buffer = Buffer.alloc(0);
        break;
      }

      const contentLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const messageEnd = bodyStart + contentLength;
      if (this.buffer.length < messageEnd) break;

      const payload = this.buffer.subarray(bodyStart, messageEnd).toString('utf8');
      this.buffer = this.buffer.subarray(messageEnd);

      let parsed: JsonRpcResponse & { method?: string; params?: { items?: unknown[] } };
      try {
        parsed = JSON.parse(payload) as JsonRpcResponse & { method?: string; params?: { items?: unknown[] } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.rejectPendingRequests(new Error(`Invalid LSP JSON payload: ${message}`));
        continue;
      }

      if (typeof parsed.id !== 'number' && typeof parsed.id !== 'string') continue;

      // Handle server-initiated requests (messages with both id and method).
      // These are not responses to our requests — they are requests FROM the
      // server that expect a reply. Silently dropping them violates the
      // JSON-RPC protocol and causes servers to hang.
      if (parsed.method) {
        if (parsed.method === 'workspace/configuration') {
          const items: unknown[] = parsed.params?.items ?? [];
          this.sendResponse(parsed.id, items.map(() => ({})));
        } else if (parsed.method === 'window/workDoneProgress/create') {
          this.sendResponse(parsed.id, null);
        } else {
          this.sendResponse(parsed.id, null, {
            code: -32601,
            message: `Method not supported: ${parsed.method}`,
          });
        }
        continue;
      }

      // Coerce string IDs to numbers for pending-map lookup — we always
      // send numeric IDs, but servers may echo them back as strings.
      const lookupId = typeof parsed.id === 'string' ? Number(parsed.id) : parsed.id;
      const pending = this.pending.get(lookupId);
      if (!pending) continue;

      clearTimeout(pending.timeout);
      this.pending.delete(lookupId);
      if (parsed.error) {
        pending.reject(new Error(`LSP request failed for ${pending.method}: ${parsed.error.message}`));
      } else {
        pending.resolve(parsed.result);
      }
    }
  }

  private send(message: JsonRpcRequest): void {
    this.ensureActive();

    const child = this.child;
    if (!child) {
      throw new Error('LSP client is not active');
    }

    const payload = JSON.stringify(message);
    const serialized = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
    try {
      child.stdin.write(serialized, 'utf8');
    } catch {
      this.exited = true;
      this.rejectPendingRequests(new Error('LSP stdin write failed — server exited'));
    }
  }

  private sendResponse(id: number | string, result: unknown, error?: { code: number; message: string }): void {
    const child = this.child;
    if (!child || this.exited) return;

    const message: Record<string, unknown> = { jsonrpc: '2.0', id };
    if (error) {
      message.error = error;
    } else {
      message.result = result;
    }

    const payload = JSON.stringify(message);
    const serialized = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
    try {
      child.stdin.write(serialized, 'utf8');
    } catch {
      this.exited = true;
      this.rejectPendingRequests(new Error('LSP stdin write failed — server exited'));
    }
  }

  private notify(method: string, params?: unknown): void {
    this.send({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    this.ensureActive();

    const requestId = this.nextId++;
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`LSP request timed out for ${method} after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(requestId, {
        method,
        resolve,
        reject,
        timeout,
      });

      this.send({
        jsonrpc: '2.0',
        id: requestId,
        method,
        params,
      });
    });
  }

  private ensureActive(): void {
    if (!this.child || !this.started || this.exited) {
      throw new Error('LSP client is not active');
    }
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    const exitPromise = this.exitPromise;
    if (!exitPromise) return;

    const timedOut = await Promise.race([
      exitPromise.then(() => false),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);

    if (timedOut) {
      this.child?.kill('SIGTERM');

      const sigkillTimeout = 5_000;
      const exited = await Promise.race([
        exitPromise.then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), sigkillTimeout);
          exitPromise.then(() => clearTimeout(timer));
        }),
      ]);

      if (!exited) {
        this.child?.kill('SIGKILL');
        await exitPromise;
      }
    }
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
