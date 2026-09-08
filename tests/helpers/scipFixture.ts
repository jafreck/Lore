/**
 * Helpers for building synthetic SCIP index binary buffers for testing.
 *
 * Uses `@bufbuild/protobuf` create + toBinary to produce valid SCIP Index
 * protobufs that can be fed to ScipIndexerStage via mocked loadScipIndexes.
 */

import { create, toBinary } from '@bufbuild/protobuf';
import {
  IndexSchema,
  MetadataSchema,
  ToolInfoSchema,
  DocumentSchema,
  OccurrenceSchema,
  SymbolInformationSchema,
  RelationshipSchema,
  SymbolRole,
  PositionEncoding,
  type Index,
  type Document,
  type Occurrence,
  type SymbolInformation,
  type Relationship,
} from '../../src/scip/scip_pb.js';

// Re-export SymbolRole for test convenience
export { SymbolRole };

export interface OccurrenceInit {
  range: number[];
  symbol: string;
  symbolRoles?: number;
  enclosingRange?: number[];
  syntaxKind?: number;
}

export interface RelationshipInit {
  symbol: string;
  isImplementation?: boolean;
  isTypeDefinition?: boolean;
  isDefinition?: boolean;
  isReference?: boolean;
}

export interface SymbolInfoInit {
  symbol: string;
  documentation?: string[];
  displayName?: string;
  kind?: number;
  relationships?: RelationshipInit[];
}

export interface DocumentInit {
  relativePath: string;
  language?: string;
  text?: string;
  positionEncoding?: PositionEncoding;
  occurrences?: OccurrenceInit[];
  symbols?: SymbolInfoInit[];
}

export interface IndexMetadataInit {
  projectRoot: string;
  toolInfo?: {
    name?: string;
    version?: string;
    arguments?: string[];
  };
}

function buildOccurrence(init: OccurrenceInit): Occurrence {
  return create(OccurrenceSchema, {
    range: init.range,
    symbol: init.symbol,
    symbolRoles: init.symbolRoles ?? 0,
    enclosingRange: init.enclosingRange ?? [],
    syntaxKind: init.syntaxKind ?? 0,
  });
}

function buildRelationship(init: RelationshipInit): Relationship {
  return create(RelationshipSchema, {
    symbol: init.symbol,
    isImplementation: init.isImplementation ?? false,
    isTypeDefinition: init.isTypeDefinition ?? false,
    isDefinition: init.isDefinition ?? false,
    isReference: init.isReference ?? false,
  });
}

function buildSymbolInfo(init: SymbolInfoInit): SymbolInformation {
  return create(SymbolInformationSchema, {
    symbol: init.symbol,
    documentation: init.documentation ?? [],
    displayName: init.displayName ?? '',
    kind: init.kind ?? 0,
    relationships: (init.relationships ?? []).map(buildRelationship),
  });
}

function buildDocument(init: DocumentInit): Document {
  return create(DocumentSchema, {
    relativePath: init.relativePath,
    language: init.language ?? '',
    text: init.text ?? '',
    positionEncoding: init.positionEncoding ?? PositionEncoding.UnspecifiedPositionEncoding,
    occurrences: (init.occurrences ?? []).map(buildOccurrence),
    symbols: (init.symbols ?? []).map(buildSymbolInfo),
  });
}

/**
 * Build a SCIP Index protobuf binary buffer from document descriptors.
 */
export function buildScipIndexBuffer(
  documents: DocumentInit[],
  metadataInit?: IndexMetadataInit,
): Uint8Array {
  const metadata = metadataInit
    ? create(MetadataSchema, {
        projectRoot: metadataInit.projectRoot,
        toolInfo: metadataInit.toolInfo
          ? create(ToolInfoSchema, {
              name: metadataInit.toolInfo.name ?? '',
              version: metadataInit.toolInfo.version ?? '',
              arguments: metadataInit.toolInfo.arguments ?? [],
            })
          : undefined,
      })
    : undefined;
  const index: Index = create(IndexSchema, {
    metadata,
    documents: documents.map(buildDocument),
  });
  return toBinary(IndexSchema, index);
}
