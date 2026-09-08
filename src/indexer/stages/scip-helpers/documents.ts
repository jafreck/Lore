import { existsSync, readFileSync, realpathSync } from 'node:fs';
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PositionEncoding,
  type Document as ScipDocument,
  type SymbolInformation,
} from '../../../scip/scip_pb.js';
import { ScipSourcePositionConverter } from '../../../scip/source-position.js';

export interface ScipIndexLike {
  metadata?: {
    projectRoot?: string;
    toolInfo?: {
      name?: string;
      version?: string;
      arguments?: readonly string[];
    };
  };
  documents: ReadonlyArray<ScipDocument>;
}

export interface ScipDocumentOrigin {
  index: number;
  document: number;
  projectRoot: string | null;
  effectiveProjectRoot: string;
  toolName: string | null;
  toolVersion: string | null;
  toolArguments: readonly string[];
}

export interface ScipDocumentMergeGroup {
  relativePath: string;
  inputDocuments: number;
  origins: readonly ScipDocumentOrigin[];
}

export interface ScipDocumentMergeStats {
  inputDocuments: number;
  uniqueDocuments: number;
  duplicateDocuments: number;
  mergedFiles: number;
  skippedDocuments: number;
  fastPath: boolean;
  semantics: 'none' | 'deterministic-union';
  provenance: readonly ScipDocumentMergeGroup[];
}

export interface ScipDocumentMergeResult {
  documents: ScipDocument[];
  stats: ScipDocumentMergeStats;
}

interface ResolvedDocument {
  key: string;
  relativePath: string;
  document: ScipDocument;
  index: ScipIndexLike;
  indexOrdinal: number;
  documentOrdinal: number;
  effectiveProjectRoot: string;
}

/**
 * Resolve and merge SCIP documents by canonical physical path.
 *
 * `Document.relativePath` is relative to its own index's
 * `Metadata.projectRoot`, not necessarily the Lore workspace. The normalized
 * documents returned here use paths relative to `workspaceRoot`, allowing the
 * rest of ingestion to use one root without collapsing same-named files from
 * different monorepo projects.
 */
export function mergeScipDocumentsDetailed(
  parsedIndexes: ReadonlyArray<ScipIndexLike>,
  workspaceRoot: string,
): ScipDocumentMergeResult {
  const canonicalWorkspace = canonicalPath(resolve(workspaceRoot));
  const records: ResolvedDocument[] = [];
  const seenKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  const declaredProjectRoots = new Set(
    parsedIndexes
      .map(index => index.metadata?.projectRoot)
      .filter((root): root is string => Boolean(root))
      .map(root => decodeProjectRoot(root) ?? root),
  );
  const preserveExternalProjectName = declaredProjectRoots.size > 1;
  let inputDocuments = 0;
  let skippedDocuments = 0;

  parsedIndexes.forEach((index, indexOrdinal) => {
    const effectiveProjectRoot = resolveProjectRoot(
      index.metadata?.projectRoot ?? '',
      canonicalWorkspace,
      preserveExternalProjectName,
    );
    index.documents.forEach((document, documentOrdinal) => {
      inputDocuments++;
      const resolvedDocument = resolveDocument(
        document,
        canonicalWorkspace,
        effectiveProjectRoot,
        index,
        indexOrdinal,
        documentOrdinal,
      );
      if (!resolvedDocument) {
        skippedDocuments++;
        return;
      }
      records.push(resolvedDocument);
      if (seenKeys.has(resolvedDocument.key)) duplicateKeys.add(resolvedDocument.key);
      else seenKeys.add(resolvedDocument.key);
    });
  });

  // Common case: no duplicate documents. Return the original protobuf
  // documents (except inexpensive path-normalization clones when needed) and
  // avoid per-document occurrence/symbol maps entirely.
  if (duplicateKeys.size === 0) {
    return {
      documents: records.map(record => record.document),
      stats: {
        inputDocuments,
        uniqueDocuments: records.length,
        duplicateDocuments: 0,
        mergedFiles: 0,
        skippedDocuments,
        fastPath: true,
        semantics: 'none',
        provenance: [],
      },
    };
  }

  const duplicateGroups = new Map<string, ResolvedDocument[]>();
  const output: Array<{ key: string; document: ScipDocument }> = [];
  for (const record of records) {
    if (!duplicateKeys.has(record.key)) {
      output.push({ key: record.key, document: record.document });
      continue;
    }
    let group = duplicateGroups.get(record.key);
    if (!group) {
      group = [];
      duplicateGroups.set(record.key, group);
    }
    group.push(record);
  }

  const provenance: ScipDocumentMergeGroup[] = [];
  for (const [key, group] of duplicateGroups) {
    const merged = mergeDuplicateGroup(key, group);
    output.push({ key, document: merged });
    provenance.push({
      relativePath: merged.relativePath,
      inputDocuments: group.length,
      origins: group.map(materializeOrigin).sort(compareOrigins),
    });
  }

  // A canonical path sort makes union output deterministic even when index
  // discovery order changes between runs.
  output.sort((a, b) => compareStableText(a.key, b.key));
  provenance.sort((a, b) => compareStableText(a.relativePath, b.relativePath));

  return {
    documents: output.map(entry => entry.document),
    stats: {
      inputDocuments,
      uniqueDocuments: output.length,
      duplicateDocuments: records.length - output.length,
      mergedFiles: duplicateGroups.size,
      skippedDocuments,
      fastPath: false,
      semantics: 'deterministic-union',
      provenance,
    },
  };
}

export function mergeScipDocuments(
  parsedIndexes: ReadonlyArray<ScipIndexLike>,
  workspaceRoot: string,
): ScipDocument[] {
  return mergeScipDocumentsDetailed(parsedIndexes, workspaceRoot).documents;
}

function resolveDocument(
  document: ScipDocument,
  workspaceRoot: string,
  projectRoot: string,
  index: ScipIndexLike,
  indexOrdinal: number,
  documentOrdinal: number,
): ResolvedDocument | null {
  const portablePath = document.relativePath.replace(/\\/gu, '/');
  const components = portablePath.split('/');
  if (
    !portablePath || isAbsolute(portablePath)
    || components.some(component => !component || component === '.' || component === '..')
  ) {
    return null;
  }

  const lexicalPath = resolve(projectRoot, ...components);
  if (!isPathInside(projectRoot, lexicalPath)) return null;
  const key = canonicalPath(lexicalPath);
  if (!isPathInside(workspaceRoot, key)) return null;

  const workspaceRelativePath = relative(workspaceRoot, key).split(sep).join('/');
  if (!workspaceRelativePath || workspaceRelativePath.startsWith('../')) return null;
  const normalizedDocument = workspaceRelativePath === document.relativePath
    ? document
    : { ...document, relativePath: workspaceRelativePath };

  return {
    key,
    relativePath: workspaceRelativePath,
    document: normalizedDocument,
    index,
    indexOrdinal,
    documentOrdinal,
    effectiveProjectRoot: projectRoot,
  };
}

function materializeOrigin(record: ResolvedDocument): ScipDocumentOrigin {
  const metadata = record.index.metadata;
  return {
    index: record.indexOrdinal,
    document: record.documentOrdinal,
    projectRoot: metadata?.projectRoot || null,
    effectiveProjectRoot: record.effectiveProjectRoot,
    toolName: metadata?.toolInfo?.name || null,
    toolVersion: metadata?.toolInfo?.version || null,
    toolArguments: metadata?.toolInfo?.arguments ?? [],
  };
}

function resolveProjectRoot(
  metadataRoot: string,
  workspaceRoot: string,
  preserveExternalProjectName: boolean,
): string {
  if (!metadataRoot) return workspaceRoot;
  const decoded = decodeProjectRoot(metadataRoot);
  if (!decoded) return workspaceRoot;

  const absoluteMetadataRoot = canonicalPath(
    isAbsolute(decoded) ? decoded : resolve(workspaceRoot, decoded),
  );
  if (isPathInside(workspaceRoot, absoluteMetadataRoot)) return absoluteMetadataRoot;

  // Precomputed indexes are frequently moved with the checkout. Rebase an
  // old absolute path at the current workspace-name component while retaining
  // any monorepo subproject suffix.
  const workspaceName = basename(workspaceRoot);
  const metadataComponents = absoluteMetadataRoot.split(sep).filter(Boolean);
  const workspaceAnchor = metadataComponents.lastIndexOf(workspaceName);
  if (workspaceAnchor >= 0) {
    const suffix = metadataComponents.slice(workspaceAnchor + 1);
    return canonicalPath(resolve(workspaceRoot, ...suffix));
  }
  if (basename(absoluteMetadataRoot) === workspaceName) return workspaceRoot;

  // Multiple independently generated project indexes may be assembled under
  // a monorepo root. Preserve the project basename when that child exists, or
  // whenever multiple declared roots must remain distinct for embedded text.
  const projectChild = resolve(workspaceRoot, basename(absoluteMetadataRoot));
  if (existsSync(projectChild) || preserveExternalProjectName) return canonicalPath(projectChild);

  // Metadata-less and relocated legacy fixtures historically resolved from
  // the requested workspace root; retain that compatibility fallback.
  return workspaceRoot;
}

function decodeProjectRoot(projectRoot: string): string | null {
  try {
    if (/^file:/iu.test(projectRoot)) return fileURLToPath(projectRoot);
    return decodeURIComponent(projectRoot);
  } catch {
    return null;
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function mergeDuplicateGroup(key: string, group: readonly ResolvedDocument[]): ScipDocument {
  const ordered = [...group].sort(compareResolvedDocuments);
  const documents = ordered.map(record => record.document);
  const effectiveEncodings = new Set(documents.map(doc => effectiveEncoding(doc.positionEncoding)));
  const targetEncoding = effectiveEncodings.size === 1
    ? selectEquivalentEncoding(documents)
    : PositionEncoding.UTF16CodeUnitOffsetFromLineStart;

  let converter: ScipSourcePositionConverter | null = null;
  const preferredText = selectPreferredText(documents);
  if (effectiveEncodings.size > 1) {
    let source = preferredText;
    if (!source) {
      try {
        source = readFileSync(key, 'utf8');
      } catch {
        throw new Error(`Cannot merge SCIP documents with different position encodings without source text: ${key}`);
      }
    }
    converter = new ScipSourcePositionConverter(source);
  }

  const occurrences = new Map<string, ScipDocument['occurrences'][number]>();
  const symbols = new Map<string, SymbolInformation[]>();

  for (const document of documents) {
    for (const original of document.occurrences) {
      const occurrence = converter && effectiveEncoding(document.positionEncoding) !== targetEncoding
        ? {
            ...original,
            range: converter.rangeToUtf16(original.range, document.positionEncoding),
            enclosingRange: converter.rangeToUtf16(original.enclosingRange, document.positionEncoding),
          }
        : original;
      const occurrenceKey = occurrenceIdentity(occurrence);
      const existing = occurrences.get(occurrenceKey);
      occurrences.set(
        occurrenceKey,
        existing ? mergeOccurrences(existing, occurrence) : occurrence,
      );
    }

    for (const symbol of document.symbols) {
      if (!symbol.symbol) continue;
      let candidates = symbols.get(symbol.symbol);
      if (!candidates) {
        candidates = [];
        symbols.set(symbol.symbol, candidates);
      }
      candidates.push(symbol);
    }
  }

  const base = documents[0]!;
  const languages = documents.map(document => document.language).filter(Boolean).sort();
  return {
    ...base,
    relativePath: ordered[0]!.relativePath,
    language: languages[0] ?? '',
    text: preferredText || base.text,
    positionEncoding: targetEncoding,
    occurrences: [...occurrences.values()].sort(compareOccurrences),
    symbols: [...symbols.values()].map(mergeSymbolInformation)
      .sort((a, b) => compareStableText(a.symbol, b.symbol)),
  };
}

function selectPreferredText(documents: readonly ScipDocument[]): string {
  let preferred = '';
  for (const document of documents) {
    const candidate = document.text;
    if (
      candidate.length > preferred.length
      || (candidate.length === preferred.length && compareStableText(candidate, preferred) < 0)
    ) {
      preferred = candidate;
    }
  }
  return preferred;
}

function effectiveEncoding(encoding: PositionEncoding): PositionEncoding {
  return encoding === PositionEncoding.UnspecifiedPositionEncoding
    ? PositionEncoding.UTF16CodeUnitOffsetFromLineStart
    : encoding;
}

function selectEquivalentEncoding(documents: readonly ScipDocument[]): PositionEncoding {
  const explicit = documents.map(document => document.positionEncoding)
    .filter(encoding => encoding !== PositionEncoding.UnspecifiedPositionEncoding)
    .sort((a, b) => a - b)[0];
  return explicit ?? PositionEncoding.UnspecifiedPositionEncoding;
}

function occurrenceIdentity(occurrence: ScipDocument['occurrences'][number]): string {
  return [
    occurrence.range.join(','),
    occurrence.symbol,
    occurrence.symbolRoles,
    occurrence.syntaxKind,
  ].join('\0');
}

function mergeOccurrences(
  left: ScipDocument['occurrences'][number],
  right: ScipDocument['occurrences'][number],
): ScipDocument['occurrences'][number] {
  const preferred = compareOccurrenceRichness(left, right) <= 0 ? left : right;
  const other = preferred === left ? right : left;
  return {
    ...preferred,
    enclosingRange: compareRanges(preferred.enclosingRange, other.enclosingRange) >= 0
      ? preferred.enclosingRange : other.enclosingRange,
    overrideDocumentation: unionStrings(
      preferred.overrideDocumentation,
      other.overrideDocumentation,
    ),
    diagnostics: unionByJson(preferred.diagnostics, other.diagnostics),
  };
}

function compareOccurrenceRichness(
  left: ScipDocument['occurrences'][number],
  right: ScipDocument['occurrences'][number],
): number {
  const leftScore = left.enclosingRange.length * 100
    + left.overrideDocumentation.length * 10 + left.diagnostics.length;
  const rightScore = right.enclosingRange.length * 100
    + right.overrideDocumentation.length * 10 + right.diagnostics.length;
  if (leftScore !== rightScore) return rightScore - leftScore;
  return compareStableText(occurrenceStableKey(left), occurrenceStableKey(right));
}

function occurrenceStableKey(occurrence: ScipDocument['occurrences'][number]): string {
  return [
    occurrence.enclosingRange.join(','),
    occurrence.overrideDocumentation.join('\0'),
    JSON.stringify(occurrence.diagnostics),
  ].join('\x01');
}

function compareRanges(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return left.length - right.length;
  return compareNumberArrays(left, right);
}

function compareOccurrences(
  left: ScipDocument['occurrences'][number],
  right: ScipDocument['occurrences'][number],
): number {
  return compareNumberArrays(left.range, right.range)
    || compareStableText(left.symbol, right.symbol)
    || left.symbolRoles - right.symbolRoles
    || left.syntaxKind - right.syntaxKind;
}

function compareNumberArrays(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const difference = left[i]! - right[i]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function mergeSymbolInformation(candidates: SymbolInformation[]): SymbolInformation {
  const ordered = [...candidates].sort((a, b) => {
    const scoreA = symbolInformationScore(a);
    const scoreB = symbolInformationScore(b);
    return scoreB - scoreA || compareStableText(symbolInformationStableKey(a), symbolInformationStableKey(b));
  });
  const primary = ordered[0]!;
  const documentation = [...primary.documentation];
  const seenDocumentation = new Set(documentation);
  const additions = ordered.flatMap(symbol => symbol.documentation)
    .filter(entry => !seenDocumentation.has(entry))
    .sort();
  for (const entry of additions) {
    if (!seenDocumentation.has(entry)) {
      documentation.push(entry);
      seenDocumentation.add(entry);
    }
  }

  const relationships = new Map<string, SymbolInformation['relationships'][number]>();
  for (const relationship of ordered.flatMap(symbol => symbol.relationships)) {
    relationships.set(relationshipIdentity(relationship), relationship);
  }

  const signatureDocumentation = ordered
    .map(symbol => symbol.signatureDocumentation)
    .filter(document => document !== undefined)
    .sort((a, b) => (b!.text.length - a!.text.length) || compareStableText(a!.text, b!.text))[0];
  const nonzeroKind = ordered.map(symbol => symbol.kind).filter(Boolean).sort((a, b) => a - b)[0];
  const displayName = ordered.map(symbol => symbol.displayName).filter(Boolean).sort()[0] ?? '';
  const enclosingSymbol = ordered.map(symbol => symbol.enclosingSymbol).filter(Boolean).sort()[0] ?? '';

  return {
    ...primary,
    documentation,
    relationships: [...relationships].sort(([a], [b]) => compareStableText(a, b)).map(([, value]) => value),
    kind: nonzeroKind ?? primary.kind,
    displayName,
    signatureDocumentation,
    enclosingSymbol,
  };
}

function symbolInformationScore(symbol: SymbolInformation): number {
  return (symbol.kind ? 1_000 : 0)
    + (symbol.signatureDocumentation?.text.length ?? 0)
    + symbol.documentation.length * 10
    + symbol.relationships.length * 5
    + (symbol.displayName ? 1 : 0);
}

function symbolInformationStableKey(symbol: SymbolInformation): string {
  return [
    symbol.symbol,
    symbol.displayName,
    symbol.kind,
    symbol.documentation.join('\0'),
    symbol.signatureDocumentation?.text ?? '',
    symbol.enclosingSymbol,
  ].join('\x01');
}

function relationshipIdentity(relationship: SymbolInformation['relationships'][number]): string {
  return [
    relationship.symbol,
    relationship.isReference,
    relationship.isImplementation,
    relationship.isTypeDefinition,
    relationship.isDefinition,
  ].join('\0');
}

function unionStrings(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort();
}

function unionByJson<T>(left: readonly T[], right: readonly T[]): T[] {
  const values = new Map<string, T>();
  for (const value of [...left, ...right]) values.set(JSON.stringify(value), value);
  return [...values].sort(([a], [b]) => compareStableText(a, b)).map(([, value]) => value);
}

function compareResolvedDocuments(left: ResolvedDocument, right: ResolvedDocument): number {
  return compareStableText(documentStableKey(left.document), documentStableKey(right.document))
    || compareOrigins(materializeOrigin(left), materializeOrigin(right));
}

function documentStableKey(document: ScipDocument): string {
  return [
    document.language,
    effectiveEncoding(document.positionEncoding),
    document.text.length,
    document.occurrences.length,
    document.symbols.length,
    document.occurrences[0]?.range.join(',') ?? '',
    document.symbols[0]?.symbol ?? '',
  ].join('\0');
}

function compareOrigins(left: ScipDocumentOrigin, right: ScipDocumentOrigin): number {
  return compareStableText(left.projectRoot ?? '', right.projectRoot ?? '')
    || compareStableText(left.toolName ?? '', right.toolName ?? '')
    || compareStableText(left.toolVersion ?? '', right.toolVersion ?? '')
    || compareStableText(left.toolArguments.join('\0'), right.toolArguments.join('\0'))
    || left.index - right.index
    || left.document - right.document;
}

/** ECMAScript code-unit order is deterministic and does not consult locale data. */
function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
