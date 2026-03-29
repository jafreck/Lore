import type { LspClientLike } from '../../src/lsp/enrichment.js';
import type {
  LspPosition,
  DocumentSymbol,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CallHierarchyIncomingCall,
  SemanticTokensResult,
  ServerCapabilities,
} from '../../src/lsp/client.js';

export interface FakeLspResponse {
  hover?: unknown;
  definition?: unknown;
}

export class FakeLspClient implements LspClientLike {
  public started = false;
  public closed = false;
  public openedDocuments: Array<{ uri: string; languageId: string }> = [];
  public closedDocuments: string[] = [];
  public requests: Array<{ type: string; uri: string; position?: LspPosition }> = [];

  private responses: Map<string, FakeLspResponse> = new Map();
  private defaultResponse: FakeLspResponse = {};
  public startError: Error | null = null;
  public didOpenError: Error | null = null;
  public hoverError: Error | null = null;
  public definitionError: Error | null = null;

  // ─── New LSP method stubs ───────────────────────────────────────────────────
  public documentSymbolResult: DocumentSymbol[] = [];
  public prepareCallHierarchyResult: CallHierarchyItem[] = [];
  public callHierarchyOutgoingResult: CallHierarchyOutgoingCall[] = [];
  public callHierarchyIncomingResult: CallHierarchyIncomingCall[] = [];
  public semanticTokensResult: SemanticTokensResult | null = null;
  public serverCapabilities: ServerCapabilities = {
    documentSymbol: true,
    callHierarchy: true,
    semanticTokensFull: true,
  };

  /** Set response for a specific line,character position */
  setResponse(line: number, character: number, response: FakeLspResponse): void {
    this.responses.set(`${line}:${character}`, response);
  }

  setDefaultResponse(response: FakeLspResponse): void {
    this.defaultResponse = response;
  }

  async start(): Promise<void> {
    if (this.startError) throw this.startError;
    this.started = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  didOpen(document: { uri: string; languageId: string; version: number; text: string }): void {
    if (this.didOpenError) throw this.didOpenError;
    this.openedDocuments.push({ uri: document.uri, languageId: document.languageId });
  }

  didClose(document: { uri: string }): void {
    this.closedDocuments.push(document.uri);
  }

  async hover(document: { uri: string }, position: LspPosition): Promise<unknown> {
    if (this.hoverError) throw this.hoverError;
    this.requests.push({ type: 'hover', uri: document.uri, position });
    const key = `${position.line}:${position.character}`;
    return this.responses.get(key)?.hover ?? this.defaultResponse.hover ?? null;
  }

  async definition(document: { uri: string }, position: LspPosition): Promise<unknown> {
    if (this.definitionError) throw this.definitionError;
    this.requests.push({ type: 'definition', uri: document.uri, position });
    const key = `${position.line}:${position.character}`;
    return this.responses.get(key)?.definition ?? this.defaultResponse.definition ?? null;
  }

  // ─── New LSP method implementations ─────────────────────────────────────────

  async documentSymbol(document: { uri: string }): Promise<DocumentSymbol[]> {
    this.requests.push({ type: 'documentSymbol', uri: document.uri });
    return this.documentSymbolResult;
  }

  async prepareCallHierarchy(
    document: { uri: string },
    position: LspPosition,
  ): Promise<CallHierarchyItem[]> {
    this.requests.push({ type: 'prepareCallHierarchy', uri: document.uri, position });
    return this.prepareCallHierarchyResult;
  }

  async callHierarchyOutgoing(
    _item: CallHierarchyItem,
  ): Promise<CallHierarchyOutgoingCall[]> {
    return this.callHierarchyOutgoingResult;
  }

  async callHierarchyIncoming(
    _item: CallHierarchyItem,
  ): Promise<CallHierarchyIncomingCall[]> {
    return this.callHierarchyIncomingResult;
  }

  async semanticTokensFull(
    document: { uri: string },
  ): Promise<SemanticTokensResult | null> {
    this.requests.push({ type: 'semanticTokensFull', uri: document.uri });
    return this.semanticTokensResult;
  }
}
