/**
 * @module indexer/stages/lsp-extraction
 *
 * Pipeline stage: LSP-driven extraction for overlay (incremental) updates.
 *
 * For each changed file, uses the persistent LSP coordinator to:
 * 1. Discover symbols via `textDocument/documentSymbol`
 * 2. Extract call graph via `callHierarchy/outgoingCalls`
 * 3. Resolve type signatures via `textDocument/hover`
 * 4. Resolve cross-file definitions via `textDocument/definition`
 * 5. Enrich symbols + refs with hover/definition metadata (merged
 *    from `LspEnrichmentStage` for overlay mode)
 *
 * ## Symbol Identity
 *
 * LSP `documentSymbol` returns names, kinds, and ranges — not SCIP-style
 * globally unique symbol strings. Overlay-discovered symbols use synthetic
 * IDs of the form `lsp:<file_path>/<parent>.<name>(<kind>)`.
 *
 * On baseline rebuild, SCIP produces authoritative symbol strings.
 * Reconciliation matches by `(file_path, start_line, start_column)`.
 */

import { pathToFileURL } from 'node:url';
import type { PipelineContext, PipelineStage } from '../pipeline.js';
import { LspEnrichmentCoordinator } from '../../lsp/enrichment.js';
import { enrichProjectRefs } from './lsp-enrichment.js';
import type { DocumentSymbol, CallHierarchyOutgoingCall } from '../../lsp/client.js';
import { extractReturnType } from '../../enrichment-types.js';

// ─── LSP SymbolKind → Lore kind mapping ──────────────────────────────────────

/** Map LSP SymbolKind enum values to Lore kind strings. */
export function mapLspSymbolKind(kind: number): string {
  switch (kind) {
    case 5:  return 'class';       // Class
    case 6:  return 'method';      // Method
    case 9:  return 'constructor'; // Constructor
    case 10: return 'enum';        // Enum
    case 11: return 'interface';   // Interface
    case 12: return 'function';    // Function
    case 13: return 'variable';    // Variable
    case 14: return 'constant';    // Constant
    case 7:  return 'property';    // Property
    case 8:  return 'property';    // Field
    case 22: return 'enum_member'; // EnumMember
    case 23: return 'class';      // Struct
    case 15: return 'type_alias'; // TypeParameter (approximate)
    case 2:  return 'module';     // Module
    case 3:  return 'module';     // Namespace
    case 4:  return 'module';     // Package
    case 25: return 'method';     // Operator
    default: return 'variable';
  }
}

// ─── Synthetic symbol ID construction ─────────────────────────────────────────

/**
 * Build a deterministic synthetic symbol ID from a DocumentSymbol hierarchy.
 *
 * Format: `lsp:<file_path>/<parent_chain>.<name>(<kind>)`
 *
 * The parent chain ensures uniqueness for nested symbols (e.g., methods
 * inside classes). The kind suffix disambiguates overloaded names.
 */
export function buildSyntheticId(
  filePath: string,
  parentChain: string[],
  name: string,
  kind: number,
): string {
  const prefix = parentChain.length > 0
    ? parentChain.join('.') + '.'
    : '';
  return `lsp:${filePath}/${prefix}${name}(${kind})`;
}

// ─── Stage implementation ────────────────────────────────────────────────────

export class LspExtractionStage implements PipelineStage {
  readonly name = 'lsp-extraction';

  async execute(context: PipelineContext, mode: 'build' | 'update'): Promise<void> {
    // Only runs during overlay (incremental) updates
    if (context.layer !== 'overlay') return;

    const lspSettings = context.lsp;
    if (!lspSettings?.enabled) return;

    const changedFiles = context.changedFiles;
    if (!changedFiles || changedFiles.length === 0) return;

    const log = context.log;
    const db = context.db;
    const rootDir = context.walkerConfig.rootDir;
    const branch = context.branch;
    const layer = context.layer;
    const generation = context.generation;

    // Create a coordinator for this extraction pass
    const coordinator = new LspEnrichmentCoordinator(lspSettings, rootDir);

    const insertSymbol = db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, end_line, signature, doc_comment, resolved_type_signature, resolved_return_type, definition_uri, definition_path, parent_symbol_id, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCallRef = db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, call_character, call_kind, resolution_method, resolved_type_signature, resolved_return_type, definition_uri, definition_path, definition_line, definition_character, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    let symbolsInserted = 0;
    let callRefsInserted = 0;
    const processedFiles: Array<{ path: string; language: string }> = [];
    let extractionError: unknown = null;

    try {
      for (const absPath of changedFiles) {
        const source = context.sourceCache?.get(absPath);
        if (!source) continue;

        // Determine language from file list
        const fileEntry = context.files.find(f => f.path === absPath);
        if (!fileEntry) continue;
        const language = fileEntry.language;

        // Look up file_id
        const fileRow = db.prepare(
          'SELECT id FROM files WHERE path = ? AND branch = ? AND layer = ?',
        ).get(absPath, branch, layer) as { id: number } | undefined;
        if (!fileRow) continue;
        const fileId = fileRow.id;

        // Step 1: Symbol discovery via documentSymbol
        const docSymbols = await coordinator.documentSymbol(absPath, language, source);
        if (docSymbols.length === 0) continue;

        // Flatten the symbol tree and insert, tracking synthetic ID → DB ID
        const syntheticToDbId = new Map<string, number>();

        const flattenAndInsert = (
          symbols: DocumentSymbol[],
          parentChain: string[],
          parentDbId: number | null,
        ) => {
          for (const sym of symbols) {
            const loreKind = mapLspSymbolKind(sym.kind);

            // Skip parameters and modules
            if (loreKind === 'parameter' || loreKind === 'module') continue;

            const syntheticId = buildSyntheticId(absPath, parentChain, sym.name, sym.kind);
            const startLine = sym.range.start.line;
            const endLine = sym.range.end.line;
            const signature = sym.detail ?? null;
            const resolvedReturnType = signature ? extractReturnType(signature) : null;
            const definitionUri = pathToFileURL(absPath).toString();

            const info = insertSymbol.run(
              fileId, sym.name, loreKind,
              startLine, endLine,
              signature, null, // doc_comment
              signature, resolvedReturnType, definitionUri, absPath,
              parentDbId,
              layer, generation,
            ) as { lastInsertRowid: number | bigint };
            const dbId = Number(info.lastInsertRowid);
            syntheticToDbId.set(syntheticId, dbId);
            symbolsInserted++;

            // Recurse into children
            if (sym.children && sym.children.length > 0) {
              flattenAndInsert(sym.children, [...parentChain, sym.name], dbId);
            }
          }
        };

        db.transaction(() => {
          flattenAndInsert(docSymbols, [], null);
        })();

        processedFiles.push({ path: absPath, language });

        // Step 2: Call graph via callHierarchy/outgoingCalls
        // For each function/method symbol, get outgoing calls
        const collectCallable = (sym: DocumentSymbol): DocumentSymbol[] => {
          const kind = mapLspSymbolKind(sym.kind);
          const result: DocumentSymbol[] = [];
          if (kind === 'function' || kind === 'method' || kind === 'constructor') {
            result.push(sym);
          }
          if (sym.children) {
            for (const child of sym.children) {
              result.push(...collectCallable(child));
            }
          }
          return result;
        };
        const callableSymbols = docSymbols.flatMap(collectCallable);

        for (const sym of callableSymbols) {
          const position = {
            line: sym.selectionRange.start.line,
            character: sym.selectionRange.start.character,
          };

          const outgoing = await coordinator.outgoingCalls(
            absPath, language, source, position,
          );

          if (outgoing.length === 0) continue;

          // Find the caller's DB ID
          const callerSyntheticId = buildSyntheticId(
            absPath, [], sym.name, sym.kind,
          );
          // Walk up the tree - for top-level symbols the chain is []
          // For nested ones we need the parent chain, but we already
          // inserted them, so look up by position
          const callerRow = db.prepare(
            `SELECT id FROM symbols WHERE file_id = ? AND name = ? AND start_line = ? AND layer = ?`,
          ).get(fileId, sym.name, sym.selectionRange.start.line, layer) as { id: number } | undefined;
          const callerId = callerRow?.id ?? syntheticToDbId.get(callerSyntheticId);
          if (!callerId) continue;

          db.transaction(() => {
            for (const call of outgoing) {
              const calleeName = call.to.name;
              const calleeUri = call.to.uri;
              const calleeDefLine = call.to.selectionRange.start.line;
              const calleeDefChar = call.to.selectionRange.start.character;

              // Try to find existing callee in DB by position
              let calleeId: number | null = null;
              if (calleeUri) {
                const calleePath = calleeUri.startsWith('file://')
                  ? new URL(calleeUri).pathname
                  : null;
                if (calleePath) {
                  const row = db.prepare(
                    `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
                     WHERE f.path = ? AND s.layer = ?
                     ORDER BY ABS(s.start_line - ?) ASC LIMIT 1`,
                  ).get(calleePath, layer, calleeDefLine) as { id: number } | undefined;
                  calleeId = row?.id ?? null;
                }
              }

              // Insert call refs for each call site
              for (const fromRange of call.fromRanges) {
                try {
                  insertCallRef.run(
                    callerId, fileId, calleeId, calleeName,
                    fromRange.start.line, fromRange.start.character,
                    'direct', 'lsp_call_hierarchy',
                    null, null, // type sig, return type
                    calleeUri, call.to.uri ? new URL(call.to.uri).pathname : null,
                    calleeDefLine, calleeDefChar,
                    layer, generation,
                  );
                  callRefsInserted++;
                } catch (e: unknown) {
                  // Skip UNIQUE constraint violations (duplicate call refs);
                  // rethrow anything else (disk-full, schema corruption, etc.)
                  if (!(e instanceof Error && e.message.includes('UNIQUE constraint'))) throw e;
                }
              }
            }
          })();
        }
      }
    } catch (err) {
      extractionError = err;
    }

    // ── Overlay enrichment pass ──────────────────────────────────────────
    // After extracting symbols and call refs, enrich them with hover +
    // definition metadata using the same LSP coordinator (one open/close
    // per file instead of two separate passes).
    if (processedFiles.length > 0) {
      try {
        await enrichProjectRefs(db, branch, processedFiles, coordinator, context.sourceCache);
        log.indexing('lsp-extraction: overlay enrichment complete', {
          filesEnriched: processedFiles.length,
        });
      } catch (enrichErr) {
        log.indexing('lsp-extraction: overlay enrichment failed', { error: String(enrichErr) });
      }
    }

    await coordinator.dispose();

    if (extractionError) throw extractionError;

    if (symbolsInserted > 0 || callRefsInserted > 0) {
      log.indexing('lsp-extraction: overlay extraction complete', {
        symbolsInserted,
        callRefsInserted,
        filesProcessed: changedFiles.length,
      });
    }
  }

  async dispose(): Promise<void> {}
}
