/**
 * @module indexer/stages/scip-helpers/ingest
 *
 * SCIP language detection and virtual dispatch materialization.
 *
 * Tree-sitter AST helpers have been removed. Ref classification is now
 * handled by SCIP `syntaxKind` + descriptor suffix in `symbol-kinds.ts`.
 */

import { pathToFileURL } from 'node:url';
import type { Database } from '../../../db/schema.js';
import { getLogger } from '../../../logger.js';
import { EXT_TO_LANG } from '../../../discovery/walker.js';
import type { SymbolInformation as ScipSymbolInformation } from '../../../scip/scip_pb.js';
import {
  extractNameFromScipSymbol,
  extractParentTypeSymbol,
  extractMethodDescriptor,
} from './symbol-kinds.js';

// ─── SCIP language detection ────────────────────────────────────────────────

const SCIP_LANG_MAP: Record<string, string> = {
  typescript: 'typescript',
  typescriptreact: 'typescript',
  javascript: 'javascript',
  javascriptreact: 'javascript',
  python: 'python',
  java: 'java',
  scala: 'scala',
  kotlin: 'kotlin',
  rust: 'rust',
  c: 'c',
  'c++': 'cpp',
  cpp: 'cpp',
  'c#': 'csharp',
  csharp: 'csharp',
  visualbasic: 'csharp',
  ruby: 'ruby',
  php: 'php',
  go: 'go',
  dart: 'dart',
};

/**
 * Determine the Lore language for a SCIP document.
 *
 * Many SCIP indexers (including scip-typescript) leave the `language` field
 * blank.  When that happens, infer from the file extension.
 */
export function inferLoreLanguage(scipLanguage: string, relativePath: string): string | null {
  // Try explicit language first
  if (scipLanguage) {
    const mapped = SCIP_LANG_MAP[scipLanguage.toLowerCase()];
    if (mapped) return mapped;
  }

  // Infer from file extension
  const dotIdx = relativePath.lastIndexOf('.');
  if (dotIdx >= 0) {
    const ext = relativePath.slice(dotIdx).toLowerCase();
    return EXT_TO_LANG[ext] ?? null;
  }

  return null;
}

// ─── Virtual dispatch materialization ─────────────────────────────────────────

/**
 * Materialize virtual dispatch edges in `symbol_refs`.
 *
 * For each `implements` relationship between types (concrete → interface),
 * matches methods by name and inserts `virtual_dispatch` call edges so
 * that callers of interface methods are also recorded as callers of the
 * corresponding concrete implementations.
 *
 * Uses a bulk SQL approach: builds a temp table of (interface_method_id →
 * concrete_method_id) mappings, then does a single INSERT ... SELECT to
 * copy all caller edges at once.
 *
 * Returns the number of edges inserted.
 */
export function materializeVirtualDispatch(
  db: Database.Database,
  scipToLoreId: Map<string, number>,
  symbolInfoMap: Map<string, ScipSymbolInformation>,
  symbolDefinitions: Map<string, { filePath: string; line: number; character: number }>,
  layer: string,
  generation: number,
  log: ReturnType<typeof getLogger>,
): number {
  // Step 1: Build a map from type SCIP symbol → method SCIP symbols
  const typeToMethods = new Map<string, string[]>();
  for (const scipSymbol of scipToLoreId.keys()) {
    // Only methods (symbols ending with `().` that live inside a type `#`)
    if (!/\(\+?\d*\)\.$/.test(scipSymbol)) continue;
    const parentType = extractParentTypeSymbol(scipSymbol);
    if (!parentType) continue;
    let methods = typeToMethods.get(parentType);
    if (!methods) { methods = []; typeToMethods.set(parentType, methods); }
    methods.push(scipSymbol);
  }

  // Step 2: Collect implements relationships from SCIP SymbolInformation
  const implementsPairs: Array<{ concreteTypeScip: string; interfaceTypeScip: string }> = [];
  for (const [scipSymbol, info] of symbolInfoMap) {
    for (const rel of info.relationships) {
      if (rel.isImplementation && rel.symbol) {
        implementsPairs.push({ concreteTypeScip: scipSymbol, interfaceTypeScip: rel.symbol });
      }
    }
  }

  if (implementsPairs.length === 0) return 0;

  // Step 3: Build the method mapping in-memory
  type MethodMapping = {
    interfaceMethodId: number;
    concreteMethodId: number;
    concreteName: string;
    concreteDefUri: string | null;
    concreteDefPath: string | null;
    concreteDefLine: number | null;
    concreteDefChar: number | null;
  };
  const mappings: MethodMapping[] = [];

  for (const { concreteTypeScip, interfaceTypeScip } of implementsPairs) {
    const interfaceMethods = typeToMethods.get(interfaceTypeScip);
    const concreteMethods = typeToMethods.get(concreteTypeScip);
    if (!interfaceMethods || !concreteMethods) continue;

    const concreteByDescriptor = new Map<string, string>();
    for (const cm of concreteMethods) {
      const desc = extractMethodDescriptor(cm);
      if (desc) concreteByDescriptor.set(desc, cm);
    }

    for (const im of interfaceMethods) {
      const desc = extractMethodDescriptor(im);
      if (!desc) continue;
      const concreteScip = concreteByDescriptor.get(desc);
      if (!concreteScip) continue;

      const interfaceMethodId = scipToLoreId.get(im);
      const concreteMethodId = scipToLoreId.get(concreteScip);
      if (!interfaceMethodId || !concreteMethodId) continue;

      const concreteName = extractNameFromScipSymbol(concreteScip);
      const concreteDef = symbolDefinitions.get(concreteScip);

      mappings.push({
        interfaceMethodId,
        concreteMethodId,
        concreteName,
        concreteDefUri: concreteDef ? pathToFileURL(concreteDef.filePath).toString() : null,
        concreteDefPath: concreteDef?.filePath ?? null,
        concreteDefLine: concreteDef?.line ?? null,
        concreteDefChar: concreteDef?.character ?? null,
      });
    }
  }

  if (mappings.length === 0) return 0;

  // Step 4: Bulk insert using a temp table + INSERT ... SELECT
  const edgesInserted = db.transaction(() => {
    db.exec(`CREATE TEMP TABLE _vdispatch_map (
      iface_method_id INTEGER NOT NULL,
      concrete_method_id INTEGER NOT NULL,
      concrete_name TEXT NOT NULL,
      concrete_def_uri TEXT,
      concrete_def_path TEXT,
      concrete_def_line INTEGER,
      concrete_def_char INTEGER
    )`);

    const insertMapping = db.prepare(
      `INSERT INTO _vdispatch_map VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of mappings) {
      insertMapping.run(
        m.interfaceMethodId, m.concreteMethodId, m.concreteName,
        m.concreteDefUri, m.concreteDefPath, m.concreteDefLine, m.concreteDefChar,
      );
    }

    const result = db.prepare(`
      INSERT INTO symbol_refs (
        caller_id, file_id, callee_id, callee_name,
        call_line, call_character, call_kind, resolution_method,
        resolved_type_signature, resolved_return_type,
        definition_uri, definition_path, definition_line, definition_character,
        layer, generation
      )
      SELECT
        sr.caller_id, sr.file_id, m.concrete_method_id, m.concrete_name,
        sr.call_line, sr.call_character, 'virtual_dispatch', 'scip_definition',
        sr.resolved_type_signature, sr.resolved_return_type,
        m.concrete_def_uri, m.concrete_def_path, m.concrete_def_line, m.concrete_def_char,
        @layer, @gen
      FROM _vdispatch_map m
      JOIN symbol_refs sr ON sr.callee_id = m.iface_method_id
      WHERE NOT EXISTS (
        SELECT 1 FROM symbol_refs ex
        WHERE ex.caller_id = sr.caller_id
          AND ex.callee_id = m.concrete_method_id
          AND ex.call_line = sr.call_line
          AND ex.call_character IS sr.call_character
      )
    `).run({ layer, gen: generation });

    db.exec(`DROP TABLE _vdispatch_map`);

    return result.changes;
  })();

  if (edgesInserted > 0) {
    log.indexing('scip-indexer: virtual dispatch edges materialized', {
      implementsPairs: implementsPairs.length,
      methodMappings: mappings.length,
      edgesInserted,
    });
  }

  return edgesInserted;
}
