/**
 * Helpers for building synthetic SCIP index binary buffers for testing.
 *
 * Uses `@bufbuild/protobuf` create + toBinary to produce valid SCIP Index
 * protobufs that can be fed to ScipIndexerStage via mocked loadScipIndexes.
 */

import { create, toBinary } from '@bufbuild/protobuf';
import {
  IndexSchema,
  DocumentSchema,
  OccurrenceSchema,
  SymbolInformationSchema,
  RelationshipSchema,
  SymbolRole,
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
  relationships?: RelationshipInit[];
}

export interface DocumentInit {
  relativePath: string;
  language?: string;
  occurrences?: OccurrenceInit[];
  symbols?: SymbolInfoInit[];
}

function buildOccurrence(init: OccurrenceInit): Occurrence {
  return create(OccurrenceSchema, {
    range: init.range,
    symbol: init.symbol,
    symbolRoles: init.symbolRoles ?? 0,
    enclosingRange: init.enclosingRange ?? [],
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
    relationships: (init.relationships ?? []).map(buildRelationship),
  });
}

function buildDocument(init: DocumentInit): Document {
  return create(DocumentSchema, {
    relativePath: init.relativePath,
    language: init.language ?? '',
    occurrences: (init.occurrences ?? []).map(buildOccurrence),
    symbols: (init.symbols ?? []).map(buildSymbolInfo),
  });
}

/**
 * Build a SCIP Index protobuf binary buffer from document descriptors.
 */
export function buildScipIndexBuffer(documents: DocumentInit[]): Uint8Array {
  const index: Index = create(IndexSchema, {
    documents: documents.map(buildDocument),
  });
  return toBinary(IndexSchema, index);
}
