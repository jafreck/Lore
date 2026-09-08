import type { Database } from '../../db/schema.js';
import type { DocumentSymbol } from '../../lsp/client.js';

const SCIP_SPAN_LANGUAGES = new Set(['c', 'cpp']);
const MULTILINE_SYMBOL_KINDS = new Set([
  'class',
  'constructor',
  'enum',
  'function',
  'interface',
  'method',
  'struct',
]);

export type BaselineSupplementationReason =
  | 'unsourced'
  | 'zero-symbols'
  | 'degenerate-spans';

export interface BaselineSupplementationOptions {
  maxFiles: number;
  fileConcurrency: number;
  strict: boolean;
}

export interface BaselineSupplementationFile {
  fileId: number;
  path: string;
  language: string;
  reasons: BaselineSupplementationReason[];
  symbolCount: number;
  degenerateSymbolCount: number;
  scipSourced: boolean;
}

export interface BaselineSupplementationPlan {
  files: BaselineSupplementationFile[];
  skippedFiles: BaselineSupplementationFile[];
  eligibleFiles: number;
  skippedByCap: number;
  skippedScipFiles: number;
  unsourcedFiles: number;
  zeroSymbolFiles: number;
  degenerateSpanFiles: number;
  complete: boolean;
  options: BaselineSupplementationOptions;
}

interface PlannerRow {
  file_id: number;
  path: string;
  language: string;
  symbol_id: number | null;
  kind: string | null;
  start_line: number | null;
  end_line: number | null;
}

/**
 * Select the small, explicit set of baseline files for which LSP can add
 * structural information. SCIP-sourced files outside the C family are never
 * reconsidered: their indexer is authoritative and does not need the
 * scip-clang span workaround.
 */
export function planBaselineLspSupplementation(
  db: Database.Database,
  branch: string,
  files: ReadonlyArray<{ path: string; language: string }>,
  scipSourcedFiles: ReadonlySet<string> | undefined,
  options: BaselineSupplementationOptions,
): BaselineSupplementationPlan {
  const normalizedOptions: BaselineSupplementationOptions = {
    maxFiles: Math.max(1, Math.floor(options.maxFiles)),
    fileConcurrency: Math.max(1, Math.floor(options.fileConcurrency)),
    strict: options.strict,
  };
  const uniqueFiles = new Map(files.map((file) => [file.path, file]));
  const rows = db.prepare(
    `SELECT f.id AS file_id, f.path, f.language,
            s.id AS symbol_id, s.kind, s.start_line, s.end_line
    FROM effective_files f
    LEFT JOIN effective_symbols s ON s.file_id = f.id
     WHERE f.branch = ? AND f.layer = 'baseline'
     ORDER BY f.path, s.id`,
  ).all(branch) as PlannerRow[];

  const rowsByPath = new Map<string, PlannerRow[]>();
  for (const row of rows) {
    if (!uniqueFiles.has(row.path)) continue;
    const grouped = rowsByPath.get(row.path) ?? [];
    grouped.push(row);
    rowsByPath.set(row.path, grouped);
  }

  const eligible: BaselineSupplementationFile[] = [];
  let skippedScipFiles = 0;
  let unsourcedFiles = 0;
  let zeroSymbolFiles = 0;
  let degenerateSpanFiles = 0;

  for (const file of uniqueFiles.values()) {
    const fileRows = rowsByPath.get(file.path) ?? [];
    const fileId = fileRows[0]?.file_id;
    if (fileId === undefined) continue;

    const scipSourced = scipSourcedFiles?.has(file.path) === true;
    const symbolRows = fileRows.filter((row) => row.symbol_id !== null);
    const reasons: BaselineSupplementationReason[] = [];
    let degenerateSymbolCount = 0;

    if (!scipSourced) {
      reasons.push('unsourced');
      unsourcedFiles++;
    } else if (SCIP_SPAN_LANGUAGES.has(file.language)) {
      if (symbolRows.length === 0) {
        reasons.push('zero-symbols');
        zeroSymbolFiles++;
      } else {
        degenerateSymbolCount = symbolRows.filter(spanNeedsRepair).length;
        if (degenerateSymbolCount > 0) {
          reasons.push('degenerate-spans');
          degenerateSpanFiles++;
        }
      }
    } else {
      skippedScipFiles++;
    }

    if (reasons.length === 0) continue;
    eligible.push({
      fileId,
      path: file.path,
      language: file.language,
      reasons,
      symbolCount: symbolRows.length,
      degenerateSymbolCount,
      scipSourced,
    });
  }

  eligible.sort((a, b) => {
    const priority = reasonPriority(a.reasons[0]!) - reasonPriority(b.reasons[0]!);
    return priority || a.path.localeCompare(b.path);
  });

  const selected = eligible.slice(0, normalizedOptions.maxFiles);
  const skippedFiles = eligible.slice(normalizedOptions.maxFiles);
  const skippedByCap = eligible.length - selected.length;
  return {
    files: selected,
    skippedFiles,
    eligibleFiles: eligible.length,
    skippedByCap,
    skippedScipFiles,
    unsourcedFiles,
    zeroSymbolFiles,
    degenerateSpanFiles,
    complete: skippedByCap === 0,
    options: normalizedOptions,
  };
}

function reasonPriority(reason: BaselineSupplementationReason): number {
  switch (reason) {
    case 'unsourced': return 0;
    case 'zero-symbols': return 1;
    case 'degenerate-spans': return 2;
  }
}

export function spanNeedsRepair(symbol: {
  kind: string | null;
  start_line: number | null;
  end_line: number | null;
}): boolean {
  if (symbol.start_line === null || symbol.end_line === null) return true;
  if (symbol.start_line < 0 || symbol.end_line < symbol.start_line) return true;
  return symbol.end_line === symbol.start_line
    && MULTILINE_SYMBOL_KINDS.has(symbol.kind ?? '');
}

export interface SymbolPosition {
  startLine: number;
  startCharacter: number | null;
  endLine: number;
  endCharacter: number | null;
}

export interface MatchableSymbol {
  path: string;
  name: string;
  kind: string;
  parentChain: readonly string[];
  signature: string | null;
  range: SymbolPosition;
  selectionLine: number | null;
  selectionCharacter: number | null;
}

export interface ExistingSupplementSymbol extends MatchableSymbol {
  id: number;
  parentId: number | null;
}

export interface IncomingSupplementSymbol extends MatchableSymbol {
  index: number;
  parentIndex: number | null;
  detail: string | null;
  docComment: string | null;
  documentSymbol: DocumentSymbol | null;
  provenance: 'lsp' | 'raw-source-unconditional' | 'lsp-visible-conditional';
}

export interface StableSymbolMatches {
  /** Incoming candidate index -> existing database symbol ID. */
  matches: Map<number, number>;
  unmatchedIncoming: number[];
  ambiguousIncoming: number[];
}

interface MatchEdge {
  incomingIndex: number;
  existingId: number;
  score: number;
}

/**
 * Deterministic one-to-one deferred-acceptance matching. Candidate edges use
 * exact source identity rather than nearest-line guesses. Overload groups must
 * have an exact selection point or signature discriminator.
 */
export function stableMatchSymbols(
  existing: readonly ExistingSupplementSymbol[],
  incoming: readonly IncomingSupplementSymbol[],
): StableSymbolMatches {
  const existingGroupSizes = countIdentityGroups(existing);
  const incomingGroupSizes = countIdentityGroups(incoming);
  const existingSignatureSizes = countSignatureGroups(existing);
  const incomingSignatureSizes = countSignatureGroups(incoming);
  const preferences = new Map<number, MatchEdge[]>();
  const ambiguousIncoming = new Set<number>();

  for (const candidate of incoming) {
    const edges: MatchEdge[] = [];
    const groupKey = identityGroupKey(candidate);
    const collisionGroup = (existingGroupSizes.get(groupKey) ?? 0) > 1
      || (incomingGroupSizes.get(groupKey) ?? 0) > 1;

    for (const current of existing) {
      if (!sameBaseIdentity(candidate, current)) continue;
      const selectionExact = exactSelection(candidate, current);
      const startExact = exactStart(candidate.range, current.range);
      const signatureExact = signaturesEqual(candidate.signature, current.signature);
      const signatureKey = signatureGroupKey(candidate);
      const signatureDiscriminator = signatureExact
        && (existingSignatureSizes.get(signatureKey) ?? 0) === 1
        && (incomingSignatureSizes.get(signatureKey) ?? 0) === 1;
      const rangeExact = exactRange(candidate.range, current.range);
      const overlap = rangesOverlap(candidate.range, current.range);
      const lineExact = candidate.selectionLine !== null
        && current.selectionLine !== null
        && candidate.selectionLine === current.selectionLine;

      // Same-name overloads and siblings are unsafe without a discriminator.
      if (collisionGroup && !selectionExact && !startExact && !signatureDiscriminator) {
        ambiguousIncoming.add(candidate.index);
        continue;
      }
      // Never match merely because a line is nearby.
      if (!selectionExact && !startExact && !signatureExact && !rangeExact && !overlap && !lineExact) continue;

      let score = 0;
      if (selectionExact) score += 10_000;
      if (startExact) score += 6_000;
      if (signatureExact) score += 4_000;
      if (rangeExact) score += 1_000;
      else if (overlap) score += 500;
      if (lineExact) score += 200;
      if (candidate.parentChain.length > 0) score += 100;
      edges.push({ incomingIndex: candidate.index, existingId: current.id, score });
    }

    edges.sort((a, b) => b.score - a.score || a.existingId - b.existingId);
    preferences.set(candidate.index, edges);
  }

  const incomingByIndex = new Map(incoming.map((symbol) => [symbol.index, symbol]));
  const queue = incoming
    .map((symbol) => symbol.index)
    .sort((a, b) => stableIncomingKey(incomingByIndex.get(a)!)
      .localeCompare(stableIncomingKey(incomingByIndex.get(b)!)));
  const nextPreference = new Map<number, number>();
  const heldByExisting = new Map<number, MatchEdge>();

  while (queue.length > 0) {
    const incomingIndex = queue.shift()!;
    const choices = preferences.get(incomingIndex) ?? [];
    const choiceIndex = nextPreference.get(incomingIndex) ?? 0;
    if (choiceIndex >= choices.length) continue;
    const proposal = choices[choiceIndex]!;
    nextPreference.set(incomingIndex, choiceIndex + 1);

    const held = heldByExisting.get(proposal.existingId);
    if (!held || compareForExisting(proposal, held, incomingByIndex) < 0) {
      heldByExisting.set(proposal.existingId, proposal);
      if (held) queue.push(held.incomingIndex);
    } else {
      queue.push(incomingIndex);
    }
  }

  const matches = new Map<number, number>();
  const accepted = [...heldByExisting.entries()]
    .sort((left, right) => left[1].incomingIndex - right[1].incomingIndex);
  for (const [existingId, edge] of accepted) {
    matches.set(edge.incomingIndex, existingId);
    ambiguousIncoming.delete(edge.incomingIndex);
  }
  const unmatchedIncoming = incoming
    .map((symbol) => symbol.index)
    .filter((index) => !matches.has(index));
  return {
    matches,
    unmatchedIncoming,
    ambiguousIncoming: unmatchedIncoming.filter((index) => ambiguousIncoming.has(index)),
  };
}

function compareForExisting(
  left: MatchEdge,
  right: MatchEdge,
  incomingByIndex: ReadonlyMap<number, IncomingSupplementSymbol>,
): number {
  if (left.score !== right.score) return right.score - left.score;
  return stableIncomingKey(incomingByIndex.get(left.incomingIndex)!)
    .localeCompare(stableIncomingKey(incomingByIndex.get(right.incomingIndex)!));
}

function stableIncomingKey(symbol: IncomingSupplementSymbol): string {
  const line = symbol.selectionLine ?? symbol.range.startLine;
  const character = symbol.selectionCharacter ?? symbol.range.startCharacter ?? -1;
  return `${symbol.path}\0${line.toString().padStart(10, '0')}\0${character.toString().padStart(10, '0')}\0${symbol.kind}\0${symbol.name}\0${normalizeSignature(symbol.signature)}`;
}

function countIdentityGroups<T extends MatchableSymbol>(symbols: readonly T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const symbol of symbols) {
    const key = identityGroupKey(symbol);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function countSignatureGroups<T extends MatchableSymbol>(symbols: readonly T[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const symbol of symbols) {
    const key = signatureGroupKey(symbol);
    if (!normalizeSignature(symbol.signature)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function identityGroupKey(symbol: MatchableSymbol): string {
  return [symbol.path, symbol.kind, symbol.name, ...symbol.parentChain].join('\0');
}

function signatureGroupKey(symbol: MatchableSymbol): string {
  return `${identityGroupKey(symbol)}\0${normalizeSignature(symbol.signature)}`;
}

function sameBaseIdentity(left: MatchableSymbol, right: MatchableSymbol): boolean {
  return left.path === right.path
    && left.name === right.name
    && left.kind === right.kind
    && chainsEqual(left.parentChain, right.parentChain);
}

function chainsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactSelection(left: MatchableSymbol, right: MatchableSymbol): boolean {
  return left.selectionLine !== null
    && left.selectionCharacter !== null
    && right.selectionLine !== null
    && right.selectionCharacter !== null
    && left.selectionLine === right.selectionLine
    && left.selectionCharacter === right.selectionCharacter;
}

function signaturesEqual(left: string | null, right: string | null): boolean {
  const normalizedLeft = normalizeSignature(left);
  return normalizedLeft.length > 0 && normalizedLeft === normalizeSignature(right);
}

export function normalizeSignature(signature: string | null | undefined): string {
  return (signature ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/;$/u, '');
}

export function exactRange(left: SymbolPosition, right: SymbolPosition): boolean {
  return left.startLine === right.startLine
    && left.startCharacter === right.startCharacter
    && left.endLine === right.endLine
    && left.endCharacter === right.endCharacter;
}

function exactStart(left: SymbolPosition, right: SymbolPosition): boolean {
  return left.startCharacter !== null
    && right.startCharacter !== null
    && left.startLine === right.startLine
    && left.startCharacter === right.startCharacter;
}

/** Compare half-open source ranges, retaining character precision on shared lines. */
export function rangesOverlap(left: SymbolPosition, right: SymbolPosition): boolean {
  const leftStart = positionValue(left.startLine, left.startCharacter, false);
  const leftEnd = positionValue(left.endLine, left.endCharacter, true);
  const rightStart = positionValue(right.startLine, right.startCharacter, false);
  const rightEnd = positionValue(right.endLine, right.endCharacter, true);
  return leftStart < rightEnd && rightStart < leftEnd;
}

function positionValue(line: number, character: number | null, end: boolean): number {
  // LSP characters are bounded well below this stride. Null end characters
  // conservatively cover the whole line; null starts begin at column zero.
  const stride = 10_000_000;
  return line * stride + (character ?? (end ? stride : 0));
}

/**
 * Find a semantically duplicate symbol before insertion. Distinct selection
 * points or signatures protect same-line C++ overloads from being collapsed.
 */
export function findDuplicateSupplement(
  candidate: IncomingSupplementSymbol,
  parentId: number | null,
  existing: readonly ExistingSupplementSymbol[],
): ExistingSupplementSymbol | undefined {
  return existing.find((current) => {
    if (current.name !== candidate.name
      || current.kind !== candidate.kind
      || current.parentId !== parentId
      || current.path !== candidate.path) return false;

    if (candidate.selectionLine !== null && candidate.selectionCharacter !== null
      && current.selectionLine !== null && current.selectionCharacter !== null) {
      if (candidate.selectionLine !== current.selectionLine
        || candidate.selectionCharacter !== current.selectionCharacter) return false;
      return true;
    }

    // If either side lacks a precise selection point, an overlapping symbol
    // is conservatively treated as already present. This prevents old
    // databases without character columns from gaining duplicate overloads.
    return exactRange(candidate.range, current.range) || rangesOverlap(candidate.range, current.range);
  });
}

/** Map LSP SymbolKind enum values to Lore kind strings. */
export function mapLspSymbolKind(kind: number): string {
  switch (kind) {
    case 5: return 'class';
    case 6: return 'method';
    case 9: return 'constructor';
    case 10: return 'enum';
    case 11: return 'interface';
    case 12: return 'function';
    case 13: return 'variable';
    case 14: return 'constant';
    case 7:
    case 8: return 'property';
    case 22: return 'enum_member';
    case 23: return 'class';
    case 15:
    case 26: return 'type_alias';
    case 2:
    case 3:
    case 4: return 'module';
    case 25: return 'method';
    default: return 'variable';
  }
}

/** Flatten the LSP hierarchy while retaining persisted parent identity. */
export function flattenDocumentSymbols(
  filePath: string,
  symbols: readonly DocumentSymbol[],
  consumed: ReadonlySet<DocumentSymbol> = new Set(),
): IncomingSupplementSymbol[] {
  const flattened: IncomingSupplementSymbol[] = [];

  const visit = (
    entries: readonly DocumentSymbol[],
    parentIndex: number | null,
    parentChain: readonly string[],
  ): void => {
    for (const symbol of entries) {
      const kind = mapLspSymbolKind(symbol.kind);
      if (consumed.has(symbol) || kind === 'module') {
        if (symbol.children?.length) visit(symbol.children, parentIndex, parentChain);
        continue;
      }

      const index = flattened.length;
      const detail = symbol.detail?.trim() || null;
      flattened.push({
        index,
        parentIndex,
        path: filePath,
        name: symbol.name,
        kind,
        parentChain: [...parentChain],
        signature: detail,
        detail,
        docComment: null,
        documentSymbol: symbol,
        provenance: 'lsp',
        range: {
          startLine: symbol.range.start.line,
          startCharacter: symbol.range.start.character,
          endLine: symbol.range.end.line,
          endCharacter: symbol.range.end.character,
        },
        selectionLine: symbol.selectionRange.start.line,
        selectionCharacter: symbol.selectionRange.start.character,
      });

      if (symbol.children?.length) {
        visit(symbol.children, index, [...parentChain, `${kind}:${symbol.name}`]);
      }
    }
  };

  visit(symbols, null, []);
  return flattened;
}
