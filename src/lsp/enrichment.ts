import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LspClient,
  type LspClientOptions,
  type LspPosition,
  type LspServerCommand,
  type DocumentSymbol,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type CallHierarchyIncomingCall,
  type SemanticTokensResult,
  type ServerCapabilities,
} from './client.js';
import type { EffectiveLspSettings } from './config.js';
import { resolveLspServerRegistry, type ResolvedLspServerCommand } from './registry.js';
import { extractReturnType, type ResolvedTypeMetadata } from '../enrichment-types.js';

export type { ResolvedTypeMetadata } from '../enrichment-types.js';
export type {
  DocumentSymbol,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CallHierarchyIncomingCall,
  SemanticTokensResult,
  ServerCapabilities,
} from './client.js';

export interface LspEnrichmentTarget {
  line: number;
  character: number;
}

export interface LspEnrichmentRequest {
  filePath: string;
  language: string;
  source: string;
  targets: readonly LspEnrichmentTarget[];
}

export interface LspClientLike {
  start(): Promise<void>;
  close(): Promise<void>;
  didOpen(document: { uri: string; languageId: string; version: number; text: string }): void;
  didChange?(document: { uri: string; version: number }, changes: Array<{ text: string }>): void;
  didClose(document: { uri: string }): void;
  hover(document: { uri: string }, position: LspPosition): Promise<unknown>;
  definition(document: { uri: string }, position: LspPosition): Promise<unknown>;
  documentSymbol?(document: { uri: string }): Promise<DocumentSymbol[]>;
  prepareCallHierarchy?(document: { uri: string }, position: LspPosition): Promise<CallHierarchyItem[]>;
  callHierarchyOutgoing?(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]>;
  callHierarchyIncoming?(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]>;
  semanticTokensFull?(document: { uri: string }): Promise<SemanticTokensResult | null>;
  readonly serverCapabilities?: ServerCapabilities;
}

export type LspClientFactory = (server: LspServerCommand, options: LspClientOptions) => LspClientLike;

const defaultClientFactory: LspClientFactory = (server, options) => new LspClient(server, options);

/**
 * Maximum number of LSP hover+definition request pairs to keep in-flight
 * concurrently.  The LSP JSON-RPC protocol supports pipelining, so the
 * server can process many requests in parallel.  A moderate cap avoids
 * flooding servers that serialize internally.
 */
const LSP_CONCURRENCY_LIMIT = 30;

export class LspEnrichmentCoordinator {
  private readonly rootUri: string;
  private readonly resolvedServers: Record<string, ResolvedLspServerCommand>;
  private readonly clientFactory: LspClientFactory;
  private readonly processEnv: NodeJS.ProcessEnv;
  private readonly clients = new Map<string, Promise<LspClientLike | null>>();
  private readonly startedClients = new Set<LspClientLike>();

  constructor(
    private readonly settings: EffectiveLspSettings,
    rootDir: string,
    clientFactory: LspClientFactory = defaultClientFactory,
    processEnv: NodeJS.ProcessEnv = process.env,
  ) {
    this.rootUri = pathToFileURL(rootDir).toString();
    this.clientFactory = clientFactory;
    this.processEnv = processEnv;
    this.resolvedServers = resolveLspServerRegistry(settings.servers, processEnv);
  }

  async start(languages: Iterable<string>): Promise<void> {
    if (!this.settings.enabled) return;
    const uniqueLanguages = new Set(languages);
    for (const language of uniqueLanguages) {
      await this.getClient(language);
    }
  }

  async dispose(): Promise<void> {
    const closeTasks = [...this.startedClients].map((client) => client.close());
    await Promise.allSettled(closeTasks);
    this.startedClients.clear();
    this.clients.clear();
  }

  async enrich(request: LspEnrichmentRequest): Promise<Array<ResolvedTypeMetadata | null>> {
    const empty = request.targets.map(() => null);
    if (!this.settings.enabled || request.targets.length === 0) {
      return empty;
    }

    const client = await this.getClient(request.language);
    if (!client) {
      return empty;
    }

    const uri = pathToFileURL(request.filePath).toString();
    try {
      client.didOpen({
        uri,
        languageId: request.language,
        version: 1,
        text: request.source,
      });
    } catch {
      return empty;
    }

    const document = { uri };
    try {
      // Batch-pipeline all targets: fire hover+definition for each target
      // concurrently (up to LSP_CONCURRENCY_LIMIT in-flight requests) to
      // maximise throughput instead of waiting for each round-trip serially.
      const enrichOne = async (target: LspEnrichmentTarget): Promise<ResolvedTypeMetadata | null> => {
        const position = {
          line: Math.max(0, target.line),
          character: Math.max(0, target.character),
        };
        // Fire hover and definition in parallel for the same position.
        const [hoverSettled, defSettled] = await Promise.allSettled([
          client.hover(document, position),
          client.definition(document, position),
        ]);
        const hoverResult = hoverSettled.status === 'fulfilled' ? hoverSettled.value : undefined;
        const definitionResult = defSettled.status === 'fulfilled' ? defSettled.value : undefined;
        const metadata = toResolvedTypeMetadata(hoverResult, definitionResult);
        return hasResolvedTypeMetadata(metadata) ? metadata : null;
      };

      // Process targets in concurrent batches to avoid overwhelming the server.
      const results: Array<ResolvedTypeMetadata | null> = new Array(request.targets.length).fill(null);
      for (let start = 0; start < request.targets.length; start += LSP_CONCURRENCY_LIMIT) {
        const end = Math.min(start + LSP_CONCURRENCY_LIMIT, request.targets.length);
        const batch = request.targets.slice(start, end);
        const batchResults = await Promise.all(batch.map(enrichOne));
        for (let j = 0; j < batchResults.length; j++) {
          results[start + j] = batchResults[j]!;
        }
      }
      return results;
    } finally {
      try {
        client.didClose(document);
      } catch {
        // Ignore didClose transport failures so indexing can continue.
      }
    }
  }

  private async getClient(language: string): Promise<LspClientLike | null> {
    const existing = this.clients.get(language);
    if (existing) {
      return existing;
    }

    const server = this.resolvedServers[language];
    if (!server || !server.available) {
      this.clients.set(language, Promise.resolve(null));
      return null;
    }

    const clientPromise = this.createAndStartClient(server).catch(() => null);
    this.clients.set(language, clientPromise);
    return clientPromise;
  }

  /**
   * Get the symbol tree for a file via `textDocument/documentSymbol`.
   * Returns empty array if the server doesn't support documentSymbol.
   */
  async documentSymbol(
    filePath: string,
    language: string,
    source: string,
  ): Promise<DocumentSymbol[]> {
    if (!this.settings.enabled) return [];
    const client = await this.getClient(language);
    if (!client?.documentSymbol) return [];

    const uri = pathToFileURL(filePath).toString();
    try {
      client.didOpen({ uri, languageId: language, version: 1, text: source });
      return await client.documentSymbol({ uri });
    } catch {
      return [];
    } finally {
      try { client.didClose({ uri }); } catch { /* ignore */ }
    }
  }

  /**
   * Get outgoing calls from a symbol at a given position.
   * Two-step: prepareCallHierarchy → callHierarchyOutgoing.
   */
  async outgoingCalls(
    filePath: string,
    language: string,
    source: string,
    position: LspPosition,
  ): Promise<CallHierarchyOutgoingCall[]> {
    if (!this.settings.enabled) return [];
    const client = await this.getClient(language);
    if (!client?.prepareCallHierarchy || !client?.callHierarchyOutgoing) return [];

    const uri = pathToFileURL(filePath).toString();
    try {
      client.didOpen({ uri, languageId: language, version: 1, text: source });
      const items = await client.prepareCallHierarchy({ uri }, position);
      if (items.length === 0) return [];
      // Get outgoing calls from the first (primary) item
      return await client.callHierarchyOutgoing(items[0]!);
    } catch {
      return [];
    } finally {
      try { client.didClose({ uri }); } catch { /* ignore */ }
    }
  }

  /**
   * Get full semantic tokens for a file.
   */
  async semanticTokens(
    filePath: string,
    language: string,
    source: string,
  ): Promise<SemanticTokensResult | null> {
    if (!this.settings.enabled) return null;
    const client = await this.getClient(language);
    if (!client?.semanticTokensFull) return null;

    const uri = pathToFileURL(filePath).toString();
    try {
      client.didOpen({ uri, languageId: language, version: 1, text: source });
      return await client.semanticTokensFull({ uri });
    } catch {
      return null;
    } finally {
      try { client.didClose({ uri }); } catch { /* ignore */ }
    }
  }

  /**
   * Get the server capabilities for a language.
   * Returns null if no client is available for the language.
   */
  async getServerCapabilities(language: string): Promise<ServerCapabilities | null> {
    const client = await this.getClient(language);
    return client?.serverCapabilities ?? null;
  }

  private async createAndStartClient(server: ResolvedLspServerCommand): Promise<LspClientLike> {
    const client = this.clientFactory(
      {
        command: server.command,
        args: [...server.args],
      },
      {
        rootUri: this.rootUri,
        requestTimeoutMs: this.settings.requestTimeoutMs,
        processEnv: this.processEnv,
      },
    );
    await client.start();
    this.startedClients.add(client);
    return client;
  }
}

export function hasResolvedTypeMetadata(metadata: ResolvedTypeMetadata): boolean {
  return Boolean(
    metadata.resolvedTypeSignature
      || metadata.resolvedReturnType
      || metadata.definitionUri
      || metadata.definitionPath
      || metadata.definitionLine !== null,
  );
}

interface DefinitionLocation {
  uri: string | null;
  line: number | null;
  character: number | null;
}

function toResolvedTypeMetadata(hoverResult: unknown, definitionResult: unknown): ResolvedTypeMetadata {
  const resolvedTypeSignature = extractHoverText(hoverResult);
  const resolvedReturnType = extractReturnType(resolvedTypeSignature);
  const location = extractDefinitionLocation(definitionResult);
  return {
    resolvedTypeSignature,
    resolvedReturnType,
    definitionUri: location.uri,
    definitionPath: definitionUriToPath(location.uri),
    definitionLine: location.line,
    definitionCharacter: location.character,
  };
}

function extractHoverText(hoverResult: unknown): string | null {
  if (!isRecord(hoverResult)) return null;
  const contents = hoverResult.contents;
  const collected = extractHoverContentValue(contents);
  if (!collected) return null;
  const normalized = collected.replace(/```[a-z0-9_+-]*\n/giu, '').replace(/```/gu, '').trim();
  return normalized.length > 0 ? normalized : null;
}

function extractHoverContentValue(contents: unknown): string | null {
  if (typeof contents === 'string') {
    return contents;
  }
  if (Array.isArray(contents)) {
    const entries = contents
      .map((entry) => extractHoverContentValue(entry))
      .filter((entry): entry is string => Boolean(entry && entry.trim().length > 0));
    return entries.length > 0 ? entries.join('\n') : null;
  }
  if (isRecord(contents) && typeof contents.value === 'string') {
    return contents.value;
  }
  return null;
}

function extractDefinitionLocation(definitionResult: unknown): DefinitionLocation {
  const empty: DefinitionLocation = { uri: null, line: null, character: null };
  if (!definitionResult) return empty;

  if (Array.isArray(definitionResult)) {
    for (const entry of definitionResult) {
      const loc = extractDefinitionLocation(entry);
      if (loc.uri) return loc;
    }
    return empty;
  }

  if (!isRecord(definitionResult)) return empty;

  // LSP Location: { uri, range: { start: { line, character } } }
  if (typeof definitionResult.uri === 'string') {
    const pos = extractRangeStart(definitionResult.range);
    return { uri: definitionResult.uri, line: pos.line, character: pos.character };
  }

  // LSP LocationLink: { targetUri, targetRange / targetSelectionRange }
  if (typeof definitionResult.targetUri === 'string') {
    const range = definitionResult.targetSelectionRange ?? definitionResult.targetRange;
    const pos = extractRangeStart(range);
    return { uri: definitionResult.targetUri, line: pos.line, character: pos.character };
  }

  return empty;
}

function extractRangeStart(range: unknown): { line: number | null; character: number | null } {
  if (!isRecord(range)) return { line: null, character: null };
  const start = range.start;
  if (!isRecord(start)) return { line: null, character: null };
  return {
    line: typeof start.line === 'number' ? start.line : null,
    character: typeof start.character === 'number' ? start.character : null,
  };
}

function definitionUriToPath(uri: string | null): string | null {
  if (!uri || !uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
