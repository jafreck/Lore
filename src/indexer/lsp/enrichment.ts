import { fileURLToPath, pathToFileURL } from 'node:url';
import { LspClient, type LspClientOptions, type LspPosition, type LspServerCommand } from './client.js';
import type { EffectiveLspSettings } from './config.js';
import { resolveLspServerRegistry, type ResolvedLspServerCommand } from './registry.js';

export interface ResolvedTypeMetadata {
  resolvedTypeSignature: string | null;
  resolvedReturnType: string | null;
  definitionUri: string | null;
  definitionPath: string | null;
}

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
  didClose(document: { uri: string }): void;
  hover(document: { uri: string }, position: LspPosition): Promise<unknown>;
  definition(document: { uri: string }, position: LspPosition): Promise<unknown>;
}

export type LspClientFactory = (server: LspServerCommand, options: LspClientOptions) => LspClientLike;

const defaultClientFactory: LspClientFactory = (server, options) => new LspClient(server, options);

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
      const results: Array<ResolvedTypeMetadata | null> = [];
      for (const target of request.targets) {
        const position = {
          line: Math.max(0, target.line),
          character: Math.max(0, target.character),
        };
        let hoverResult: unknown;
        let definitionResult: unknown;

        try {
          hoverResult = await client.hover(document, position);
        } catch {
          hoverResult = undefined;
        }

        try {
          definitionResult = await client.definition(document, position);
        } catch {
          definitionResult = undefined;
        }

        const metadata = toResolvedTypeMetadata(hoverResult, definitionResult);
        results.push(hasResolvedTypeMetadata(metadata) ? metadata : null);
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
      || metadata.definitionPath,
  );
}

function toResolvedTypeMetadata(hoverResult: unknown, definitionResult: unknown): ResolvedTypeMetadata {
  const resolvedTypeSignature = extractHoverText(hoverResult);
  const resolvedReturnType = extractReturnType(resolvedTypeSignature);
  const definitionUri = extractDefinitionUri(definitionResult);
  return {
    resolvedTypeSignature,
    resolvedReturnType,
    definitionUri,
    definitionPath: definitionUriToPath(definitionUri),
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

function extractReturnType(signature: string | null): string | null {
  if (!signature) return null;
  const lines = signature.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const firstLine = lines[0]!;

  const functionStyle = firstLine.match(/\)\s*:\s*([^={]+)$/u);
  if (functionStyle?.[1]) return functionStyle[1].trim();

  const arrowStyle = firstLine.match(/->\s*([^={]+)$/u);
  if (arrowStyle?.[1]) return arrowStyle[1].trim();

  const colonStyle = firstLine.match(/:\s*([^={]+)$/u);
  if (colonStyle?.[1]) return colonStyle[1].trim();

  return null;
}

function extractDefinitionUri(definitionResult: unknown): string | null {
  if (!definitionResult) return null;

  if (Array.isArray(definitionResult)) {
    for (const entry of definitionResult) {
      const uri = extractDefinitionUri(entry);
      if (uri) return uri;
    }
    return null;
  }

  if (!isRecord(definitionResult)) return null;
  if (typeof definitionResult.uri === 'string') return definitionResult.uri;
  if (typeof definitionResult.targetUri === 'string') return definitionResult.targetUri;
  return null;
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
