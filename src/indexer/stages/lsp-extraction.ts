/**
 * @module indexer/stages/lsp-extraction
 *
 * Pipeline stage: LSP-driven extraction for files not structurally covered by
 * SCIP, plus overlay (incremental) updates.
 *
 * For each planned baseline file or changed overlay file, uses one LSP
 * coordinator for the stage pass to:
 * 1. Discover symbols via `textDocument/documentSymbol`
 * 2. Extract call graph via `callHierarchy/outgoingCalls`
 * 3. Resolve type signatures via `textDocument/hover`
 * 4. Resolve cross-file definitions via `textDocument/definition`
 * 5. Enrich symbols + refs with hover/definition metadata (merged
 *    from `LspEnrichmentStage` for overlay mode)
 *
 * ## Symbol Identity
 *
 * Reconciliation uses stable one-to-one matching over source path, exact
 * selection position, kind, persisted parent chain, range, and signature.
 * Authoritative SCIP multiline spans are never replaced by LSP ranges.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PipelineContext, PipelineStage } from '../pipeline.js';
import { recordIndexerRun, type Database } from '../../db/schema.js';
import { LspEnrichmentCoordinator } from '../../lsp/enrichment.js';
import { enrichProjectRefs } from './lsp-enrichment.js';
import type { DocumentSymbol, CallHierarchyOutgoingCall } from '../../lsp/client.js';
import { extractReturnType } from '../../enrichment-types.js';
import {
  DEFAULT_LSP_SUPPLEMENTATION_FILE_CONCURRENCY,
  DEFAULT_LSP_SUPPLEMENTATION_MAX_FILES,
} from '../../lsp/config.js';
import {
  findDuplicateSupplement,
  flattenDocumentSymbols,
  mapLspSymbolKind,
  normalizeSignature,
  planBaselineLspSupplementation,
  spanNeedsRepair,
  stableMatchSymbols,
  type BaselineSupplementationPlan,
  type ExistingSupplementSymbol,
  type IncomingSupplementSymbol,
} from './lsp-supplementation.js';
import {
  extractPreprocessorMacros,
  getLanguageSupplementProvider,
} from './lsp-language-supplements.js';

export { mapLspSymbolKind, extractPreprocessorMacros };

// ─── Synthetic symbol ID construction ─────────────────────────────────────────

/**
 * Build a deterministic synthetic symbol ID from a DocumentSymbol hierarchy.
 *
 * Format: `lsp:<file_path>/<parent_chain>.<name>(<kind>)`
 *
 * The parent chain distinguishes nested symbols. Pass a source discriminator
 * when same-kind overloads are possible.
 */
export function buildSyntheticId(
  filePath: string,
  parentChain: string[],
  name: string,
  kind: number,
  discriminator?: { line: number; character: number; signature?: string | null },
): string {
  const prefix = parentChain.length > 0
    ? parentChain.join('.') + '.'
    : '';
  const suffix = discriminator
    ? `@${discriminator.line}:${discriminator.character}:${encodeURIComponent(normalizeSignature(discriminator.signature))}`
    : '';
  return `lsp:${filePath}/${prefix}${name}(${kind})${suffix}`;
}

// ─── Stage implementation ────────────────────────────────────────────────────

export class LspExtractionStage implements PipelineStage {
  readonly name = 'lsp-extraction';

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    const lspSettings = context.lsp;
    if (!lspSettings?.enabled) {
      if (context.runId) {
        recordIndexerRun(context.db, {
          runId: context.runId,
          provider: 'lsp',
          indexer: 'lsp',
          status: 'disabled',
          attempted: false,
        });
      }
      return;
    }

    const log = context.log;
    const db = context.db;
    const rootDir = context.walkerConfig.rootDir;
    const branch = context.branch;
    const layer = context.layer;
    const generation = context.generation;
    const supplementation = {
      maxFiles: positiveInteger(
        lspSettings.supplementation?.maxFiles,
        DEFAULT_LSP_SUPPLEMENTATION_MAX_FILES,
      ),
      fileConcurrency: positiveInteger(
        lspSettings.supplementation?.fileConcurrency,
        DEFAULT_LSP_SUPPLEMENTATION_FILE_CONCURRENCY,
        64,
      ),
      strict: lspSettings.supplementation?.strict ?? false,
    };

    let filesToProcess: WorkFile[];
    let baselinePlan: BaselineSupplementationPlan | null = null;
    if (layer === 'baseline') {
      const plan = planBaselineLspSupplementation(
        db,
        branch,
        context.files,
        context.scipSourcedFiles,
        supplementation,
      );
      baselinePlan = plan;
      log.indexing('lsp-extraction: baseline supplementation planned', {
        eligibleFiles: plan.eligibleFiles,
        selectedFiles: plan.files.length,
        skippedByCap: plan.skippedByCap,
        skippedScipFiles: plan.skippedScipFiles,
        unsourcedFiles: plan.unsourcedFiles,
        zeroSymbolFiles: plan.zeroSymbolFiles,
        degenerateSpanFiles: plan.degenerateSpanFiles,
        maxFiles: plan.options.maxFiles,
        fileConcurrency: plan.options.fileConcurrency,
        complete: plan.complete,
        strict: plan.options.strict,
      });
      if (!plan.complete) {
        const diagnostics = {
          eligibleFiles: plan.eligibleFiles,
          selectedFiles: plan.files.length,
          skippedByCap: plan.skippedByCap,
          maxFiles: plan.options.maxFiles,
        };
        if (plan.options.strict) {
          log.error('lsp-extraction', 'baseline supplementation cap would make the index incomplete', diagnostics);
          throw new Error(
            `Baseline LSP supplementation requires ${plan.eligibleFiles} files, `
            + `exceeding the strict maxFiles cap of ${plan.options.maxFiles}`,
          );
        }
        log.warn('lsp-extraction', 'baseline supplementation is incomplete because maxFiles was reached', diagnostics);
      }
      filesToProcess = plan.files.map((file) => ({
        fileId: file.fileId,
        path: file.path,
        language: file.language,
        scipSourced: file.scipSourced,
      }));
    } else {
      const unique = new Map(
        context.files
          .map((file) => [file.path, file]),
      );
      filesToProcess = [...unique.values()].map((file) => ({
        fileId: null,
        path: file.path,
        language: file.language,
        scipSourced: false,
      }));
    }
    if (filesToProcess.length === 0) {
      if (context.runId) {
        recordIndexerRun(db, {
          runId: context.runId,
          provider: 'lsp',
          indexer: 'lsp',
          status: 'skipped',
          attempted: false,
          message: 'no files required LSP structural extraction or supplementation',
        });
      }
      return;
    }

    // One coordinator serves symbol collection, call hierarchy, and metadata
    // enrichment. File-level requests are pipelined with a bounded cap.
    const coordinator = new LspEnrichmentCoordinator(lspSettings, rootDir);

    const insertSymbol = db.prepare(
      `INSERT INTO symbols (file_id, name, kind, start_line, start_character, end_line, end_character, selection_line, selection_character, signature, doc_comment, resolved_type_signature, resolved_return_type, definition_uri, definition_path, parent_symbol_id, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertCallRef = db.prepare(
      `INSERT INTO symbol_refs (caller_id, file_id, callee_id, callee_name, call_line, call_character, call_kind, resolution_method, resolved_type_signature, resolved_return_type, definition_uri, definition_path, definition_line, definition_character, layer, generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateScipSpan = db.prepare(
      `UPDATE symbols
       SET start_line = ?, start_character = ?, end_line = ?, end_character = ?,
           selection_line = COALESCE(selection_line, ?),
           selection_character = COALESCE(selection_character, ?)
       WHERE id = ?
         AND (start_line IS NULL OR end_line IS NULL OR start_line < 0
              OR end_line < start_line
              OR (end_line = start_line AND kind IN ('class', 'constructor', 'enum', 'function', 'interface', 'method', 'struct')))`,
    );
    const backfillScipCoordinates = db.prepare(
      `UPDATE symbols
       SET start_character = COALESCE(start_character, ?),
           end_character = COALESCE(end_character, ?),
           selection_line = COALESCE(selection_line, ?),
           selection_character = COALESCE(selection_character, ?)
       WHERE id = ?`,
    );

    let symbolsInserted = 0;
    let callRefsInserted = 0;
    let scipSpansUpdated = 0;
    let scipSymbolsSupplemented = 0;
    let duplicatesPrevented = 0;
    let ambiguousMatches = 0;
    let sourceMissing = 0;
    let fileRowsMissing = 0;
    const sourceMissingByLanguage = new Map<string, number>();
    const fileRowsMissingByLanguage = new Map<string, number>();
    const ambiguousMatchesByLanguage = new Map<string, number>();
    const macroDiagnostics: Record<string, number> = {};
    const fallbackFiles: Array<{ path: string; language: string }> = [];
    const candidateCounts = new Map<string, number>();
    let fallbackEnrichmentFailed = false;

    try {
      await coordinator.start(new Set(filesToProcess.map((file) => file.language)));
      const prepared = await mapWithConcurrency(
        filesToProcess,
        supplementation.fileConcurrency,
        async (file): Promise<PreparedFile | null> => {
          const source = context.sourceCache.get(file.path);
          if (source === undefined) {
            sourceMissing++;
            incrementCount(sourceMissingByLanguage, file.language);
            return null;
          }
          const fileId = file.fileId ?? getFileId(
            db,
            file.path,
            branch,
            layer,
            generation,
          );
          if (fileId === null) {
            fileRowsMissing++;
            incrementCount(fileRowsMissingByLanguage, file.language);
            return null;
          }

          const documentSymbols = await coordinator.documentSymbol(file.path, file.language, source);
          const providerResult = getLanguageSupplementProvider(file.language)?.collect({
            filePath: file.path,
            language: file.language,
            source,
            documentSymbols,
            nextIndex: 0,
          });
          const genericSymbols = flattenDocumentSymbols(
            file.path,
            documentSymbols,
            providerResult?.consumedDocumentSymbols,
          );
          const providerSymbols = (providerResult?.symbols ?? []).map((symbol, offset) => ({
            ...symbol,
            index: genericSymbols.length + offset,
          }));
          for (const [key, value] of Object.entries(providerResult?.diagnostics ?? {})) {
            macroDiagnostics[key] = (macroDiagnostics[key] ?? 0) + value;
          }
          candidateCounts.set(file.path, genericSymbols.length + providerSymbols.length);
          return {
            ...file,
            fileId,
            source,
            candidates: [...genericSymbols, ...providerSymbols],
          };
        },
      );

      const readyFiles = prepared.filter((file): file is PreparedFile => file !== null);
      const callableWork: CallableWork[] = [];
      for (const file of readyFiles) {
        const existing = loadExistingSymbols(db, file.fileId, file.path);
        const matching = stableMatchSymbols(existing, file.candidates);
        ambiguousMatches += matching.ambiguousIncoming.length;
        if (matching.ambiguousIncoming.length > 0) {
          incrementCount(ambiguousMatchesByLanguage, file.language, matching.ambiguousIncoming.length);
        }
        const candidateIds = new Map<number, number>();
        const mutableExisting = [...existing];
        const existingById = new Map(existing.map((symbol) => [symbol.id, symbol]));
        const definitionUri = pathToFileURL(file.path).toString();

        db.transaction(() => {
          for (const candidate of file.candidates) {
            const matchedId = matching.matches.get(candidate.index);
            if (matchedId !== undefined) {
              candidateIds.set(candidate.index, matchedId);
              const matched = existingById.get(matchedId);
              if (file.scipSourced && matched) {
                if (spanNeedsRepair({
                  kind: matched.kind,
                  start_line: matched.range.startLine,
                  end_line: matched.range.endLine,
                })) {
                  const result = updateScipSpan.run(
                    candidate.range.startLine,
                    candidate.range.startCharacter,
                    candidate.range.endLine,
                    candidate.range.endCharacter,
                    candidate.selectionLine,
                    candidate.selectionCharacter,
                    matchedId,
                  );
                  scipSpansUpdated += result.changes;
                } else {
                  backfillScipCoordinates.run(
                    candidate.range.startCharacter,
                    candidate.range.endCharacter,
                    candidate.selectionLine,
                    candidate.selectionCharacter,
                    matchedId,
                  );
                }
              }
              continue;
            }

            const parentId = candidate.parentIndex === null
              ? null
              : candidateIds.get(candidate.parentIndex) ?? null;
            const duplicate = findDuplicateSupplement(candidate, parentId, mutableExisting);
            if (duplicate) {
              candidateIds.set(candidate.index, duplicate.id);
              duplicatesPrevented++;
              continue;
            }

            const signature = candidate.signature;
            const result = insertSymbol.run(
              file.fileId,
              candidate.name,
              candidate.kind,
              candidate.range.startLine,
              candidate.range.startCharacter,
              candidate.range.endLine,
              candidate.range.endCharacter,
              candidate.selectionLine,
              candidate.selectionCharacter,
              signature,
              candidate.docComment,
              signature,
              signature ? extractReturnType(signature) : null,
              definitionUri,
              file.path,
              parentId,
              layer,
              generation,
            ) as { lastInsertRowid: number | bigint };
            const symbolId = Number(result.lastInsertRowid);
            candidateIds.set(candidate.index, symbolId);
            mutableExisting.push(toExistingSymbol(candidate, symbolId, parentId));
            symbolsInserted++;
            if (file.scipSourced) scipSymbolsSupplemented++;
          }
        })();

        if (!file.scipSourced) {
          fallbackFiles.push({ path: file.path, language: file.language });
          for (const candidate of file.candidates) {
            const callerId = candidateIds.get(candidate.index);
            if (callerId !== undefined && candidate.documentSymbol && isCallable(candidate.kind)) {
              callableWork.push({ file, candidate, callerId });
            }
          }
        }
      }

      const outgoingResults = await mapWithConcurrency(
        callableWork,
        supplementation.fileConcurrency,
        async (work) => ({
          work,
          calls: await coordinator.outgoingCalls(
            work.file.path,
            work.file.language,
            work.file.source,
            {
              line: work.candidate.selectionLine ?? work.candidate.range.startLine,
              character: work.candidate.selectionCharacter
                ?? work.candidate.range.startCharacter
                ?? 0,
            },
          ),
        }),
      );

      db.transaction(() => {
        for (const { work, calls } of outgoingResults) {
          for (const call of calls) {
            callRefsInserted += insertOutgoingCallRefs(
              db,
              insertCallRef,
              call,
              work.callerId,
              work.file.fileId,
              branch,
              rootDir,
              layer,
              generation,
            );
          }
        }
      })();

      if (fallbackFiles.length > 0) {
        try {
          await enrichProjectRefs(db, branch, fallbackFiles, coordinator, context.sourceCache);
          context.lspEnrichedFiles ??= new Set();
          for (const file of fallbackFiles) context.lspEnrichedFiles.add(file.path);
          log.indexing('lsp-extraction: fallback enrichment complete', {
            filesEnriched: fallbackFiles.length,
          });
        } catch (enrichErr) {
          fallbackEnrichmentFailed = true;
          log.indexing('lsp-extraction: fallback enrichment failed', { error: String(enrichErr) });
        }
      }
    } finally {
      await coordinator.dispose();
    }

    if (symbolsInserted > 0 || callRefsInserted > 0 || scipSpansUpdated > 0
      || filesToProcess.length > 0) {
      log.indexing('lsp-extraction: extraction complete', {
        symbolsInserted,
        callRefsInserted,
        scipSpansUpdated,
        scipSymbolsSupplemented,
        duplicatesPrevented,
        ambiguousMatches,
        sourceMissing,
        fileRowsMissing,
        filesProcessed: filesToProcess.length,
        fallbackFiles: fallbackFiles.length,
        ...macroDiagnostics,
      });
    }

    if (context.runId) {
      for (const diagnostic of coordinator.getDiagnostics()) {
        const languageFiles = filesToProcess.filter((file) => file.language === diagnostic.language);
        const fallbackLanguageFiles = languageFiles.filter((file) => !file.scipSourced);
        const emptyStructuralResultFiles = languageFiles.filter(
          (file) => (candidateCounts.get(file.path) ?? 0) === 0,
        );
        const symbolLessFallbackFiles = fallbackLanguageFiles.filter(
          (file) => (candidateCounts.get(file.path) ?? 0) === 0,
        );
        const skippedByCapForLanguage = baselinePlan?.skippedFiles.filter(
          (file) => file.language === diagnostic.language,
        ).length ?? 0;
        const supplementationDegraded = skippedByCapForLanguage > 0
          || (sourceMissingByLanguage.get(diagnostic.language) ?? 0) > 0
          || (fileRowsMissingByLanguage.get(diagnostic.language) ?? 0) > 0
          || (ambiguousMatchesByLanguage.get(diagnostic.language) ?? 0) > 0
          || (fallbackEnrichmentFailed && fallbackLanguageFiles.length > 0);
        recordIndexerRun(db, {
          runId: context.runId,
          provider: 'lsp',
          indexer: diagnostic.command,
          languages: [diagnostic.language],
          status: diagnostic.status === 'succeeded'
            && (emptyStructuralResultFiles.length > 0 || supplementationDegraded)
            ? 'degraded'
            : diagnostic.status,
          attempted: diagnostic.attempted,
          fallback: fallbackLanguageFiles.length > 0,
          files: languageFiles.length,
          symbols: sumPaths(candidateCounts, languageFiles),
          message: diagnostic.message,
          details: {
            fallbackFiles: fallbackLanguageFiles.length,
            emptyStructuralResultFiles: emptyStructuralResultFiles.length,
            symbolLessFallbackFiles: symbolLessFallbackFiles.length,
            symbolsInserted,
            callRefsInserted,
            scipSpansUpdated,
            positionEncoding: 'utf16',
            supplementation: {
              eligibleFiles: baselinePlan?.eligibleFiles ?? filesToProcess.length,
              selectedFiles: baselinePlan?.files.length ?? filesToProcess.length,
              skippedByCap: baselinePlan?.skippedByCap ?? 0,
              skippedByCapForLanguage,
              complete: baselinePlan?.complete ?? true,
              sourceMissing: sourceMissingByLanguage.get(diagnostic.language) ?? 0,
              fileRowsMissing: fileRowsMissingByLanguage.get(diagnostic.language) ?? 0,
              ambiguousMatches: ambiguousMatchesByLanguage.get(diagnostic.language) ?? 0,
              fallbackEnrichmentFailed: fallbackEnrichmentFailed
                && fallbackLanguageFiles.length > 0,
              macroDiagnostics,
            },
          },
        });
      }
      if (baselinePlan && baselinePlan.skippedByCap > 0) {
        recordIndexerRun(db, {
          runId: context.runId,
          provider: 'lsp',
          indexer: 'lsp-supplementation-cap',
          languages: [...new Set(baselinePlan.skippedFiles.map((file) => file.language))],
          status: 'degraded',
          attempted: false,
          fallback: true,
          files: baselinePlan.skippedByCap,
          message: 'baseline supplementation file cap omitted required files',
          details: {
            supplementation: {
              eligibleFiles: baselinePlan.eligibleFiles,
              selectedFiles: baselinePlan.files.length,
              skippedByCap: baselinePlan.skippedByCap,
              complete: false,
              skippedPaths: baselinePlan.skippedFiles.map((file) => file.path),
            },
          },
        });
      }
    }
  }

  async dispose(): Promise<void> {}
}

interface WorkFile {
  fileId: number | null;
  path: string;
  language: string;
  scipSourced: boolean;
}

interface PreparedFile extends WorkFile {
  fileId: number;
  source: string;
  candidates: IncomingSupplementSymbol[];
}

interface CallableWork {
  file: PreparedFile;
  candidate: IncomingSupplementSymbol;
  callerId: number;
}

function getFileId(
  db: PipelineContext['db'],
  filePath: string,
  branch: string,
  layer: 'baseline' | 'overlay',
  generation: number,
): number | null {
  const row = db.prepare(
    'SELECT id FROM files WHERE path = ? AND branch = ? AND layer = ? AND generation = ?',
  ).get(filePath, branch, layer, generation) as { id: number } | undefined;
  return row?.id ?? null;
}

interface ExistingSymbolRow {
  id: number;
  name: string;
  kind: string;
  start_line: number;
  start_character: number | null;
  end_line: number;
  end_character: number | null;
  selection_line: number | null;
  selection_character: number | null;
  signature: string | null;
  parent_symbol_id: number | null;
}

function loadExistingSymbols(
  db: PipelineContext['db'],
  fileId: number,
  filePath: string,
): ExistingSupplementSymbol[] {
  const rows = db.prepare(
    `SELECT id, name, kind, start_line, start_character, end_line, end_character,
            selection_line, selection_character, signature, parent_symbol_id
     FROM symbols
     WHERE file_id = ?
     ORDER BY id`,
  ).all(fileId) as ExistingSymbolRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chainCache = new Map<number, string[]>();
  const parentChain = (row: ExistingSymbolRow, visiting = new Set<number>()): string[] => {
    const cached = chainCache.get(row.id);
    if (cached) return cached;
    if (row.parent_symbol_id === null || visiting.has(row.id)) return [];
    const parent = byId.get(row.parent_symbol_id);
    if (!parent) return [];
    const nextVisiting = new Set(visiting).add(row.id);
    const chain = [...parentChain(parent, nextVisiting), `${parent.kind}:${parent.name}`];
    chainCache.set(row.id, chain);
    return chain;
  };

  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_symbol_id,
    path: filePath,
    name: row.name,
    kind: row.kind,
    parentChain: parentChain(row),
    signature: row.signature,
    range: {
      startLine: row.start_line,
      startCharacter: row.start_character,
      endLine: row.end_line,
      endCharacter: row.end_character,
    },
    selectionLine: row.selection_line,
    selectionCharacter: row.selection_character,
  }));
}

function toExistingSymbol(
  candidate: IncomingSupplementSymbol,
  id: number,
  parentId: number | null,
): ExistingSupplementSymbol {
  return {
    id,
    parentId,
    path: candidate.path,
    name: candidate.name,
    kind: candidate.kind,
    parentChain: candidate.parentChain,
    signature: candidate.signature,
    range: candidate.range,
    selectionLine: candidate.selectionLine,
    selectionCharacter: candidate.selectionCharacter,
  };
}

function isCallable(kind: string): boolean {
  return kind === 'function' || kind === 'method' || kind === 'constructor';
}

function insertOutgoingCallRefs(
  db: PipelineContext['db'],
  insertCallRef: Database.Statement,
  call: CallHierarchyOutgoingCall,
  callerId: number,
  fileId: number,
  branch: string,
  rootDir: string,
  layer: 'baseline' | 'overlay',
  generation: number,
): number {
  const calleeUri = call.to.uri;
  const calleePath = calleeUri ? uriToFilePath(calleeUri) : null;
  const calleeDefLine = call.to.selectionRange.start.line;
  const calleeDefChar = call.to.selectionRange.start.character;
  const calleeId = calleePath
    ? findExactCallee(
        db,
        calleePath,
        branch,
        call.to.name,
        mapLspSymbolKind(call.to.kind),
        calleeDefLine,
        calleeDefChar,
      )
    : null;
  const resolutionMethod = calleeId
    ? 'lsp_definition'
    : calleePath && (calleePath === rootDir || calleePath.startsWith(`${rootDir}/`))
      ? 'unresolved'
      : 'external_definition';
  let inserted = 0;
  for (const fromRange of call.fromRanges) {
    try {
      insertCallRef.run(
        callerId,
        fileId,
        calleeId,
        call.to.name,
        fromRange.start.line,
        fromRange.start.character,
        'direct',
        resolutionMethod,
        null,
        null,
        calleeUri,
        calleePath,
        calleeDefLine,
        calleeDefChar,
        layer,
        generation,
      );
      inserted++;
    } catch (error: unknown) {
      if (!(error instanceof Error && error.message.includes('UNIQUE constraint'))) throw error;
    }
  }
  return inserted;
}

function findExactCallee(
  db: PipelineContext['db'],
  filePath: string,
  branch: string,
  name: string,
  kind: string,
  line: number,
  character: number,
): number | null {
  const rows = db.prepare(
    `SELECT s.id
     FROM effective_symbols s
     JOIN effective_files f ON f.id = s.file_id
     WHERE f.path = ? AND f.branch = ? AND s.name = ? AND s.kind = ?
       AND ((s.selection_line = ? AND s.selection_character = ?)
         OR (s.start_line = ? AND s.start_character = ?))
     ORDER BY s.id`,
  ).all(filePath, branch, name, kind, line, character, line, character) as Array<{ id: number }>;
  return rows.length === 1 ? rows[0]!.id : null;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  requestedConcurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const concurrency = Math.max(1, Math.min(Math.floor(requestedConcurrency), values.length));
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function positiveInteger(value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), maximum);
}

function sumPaths(
  counts: ReadonlyMap<string, number>,
  files: ReadonlyArray<{ path: string }>,
): number {
  return files.reduce((total, file) => total + (counts.get(file.path) ?? 0), 0);
}

function incrementCount(counts: Map<string, number>, key: string, amount = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + amount);
}

function uriToFilePath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}
