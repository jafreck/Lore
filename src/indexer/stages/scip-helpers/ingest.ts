/**
 * @module indexer/stages/scip-helpers/ingest
 *
 * Tree-sitter AST helpers for SCIP ref classification, SCIP language
 * detection, ref matching, and virtual dispatch materialization.
 */

import { pathToFileURL } from 'node:url';
import type Parser from 'tree-sitter';
import type { Database } from '../../../db/schema.js';
import { normalizeTypeName } from '../../../resolution/call-graph.js';
import { getLogger } from '../../../logger.js';
import { EXT_TO_LANG } from '../../../discovery/walker.js';
import { extractReturnType } from '../../../scip/index-reader.js';
import type { RawCallRef, RawTypeRef } from '../../../parsing/extractors/types.js';
import type { ScipTreeSitterFileData } from '../../pipeline.js';
import type { SymbolInformation as ScipSymbolInformation } from '../../../scip/scip_pb.js';
import {
  inferKindFromScipSymbol,
  extractNameFromScipSymbol,
  extractSignatureFromDoc,
  extractParentTypeSymbol,
  extractMethodDescriptor,
} from './symbol-kinds.js';

// ─── Tree-sitter AST helpers ────────────────────────────────────────────────

/** Node types that represent import statements across languages. */
const IMPORT_NODE_TYPES = new Set([
  'import_statement', 'import_declaration', 'preproc_include',
  'use_declaration', 'require_call', 'import_from_statement',
  'using_directive', 'call_expression',
]);

/** Node types that represent call expressions across languages. */
const CALL_NODE_TYPES = new Set([
  'call_expression', 'function_call', 'invocation_expression',
  'method_invocation', 'call', 'new_expression',
]);

/** Node types that represent member access across languages. */
const MEMBER_NODE_TYPES = new Set([
  'member_expression', 'field_expression', 'attribute',
  'member_access_expression', 'qualified_identifier',
  'selector_expression',
]);

export function inferTypeRefKindFromTree(
  tree: Parser.Tree, refLine: number, refChar: number,
): string | null {
  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition({ row: refLine, column: refChar });
  if (!node) return null;

  for (let depth = 0; depth < 6 && node; depth++) {
    const t = node.type;
    if (t === 'return_type' || (t === 'type_annotation' && node.parent?.type === 'function_declaration')) return 'return';
    if (t === 'type_parameter_constraint' || t === 'constraint') return 'bound';
    if (t === 'type_arguments' || t === 'generic_type' || t === 'type_argument_list') return 'generic_arg';
    if (t === 'required_parameter' || t === 'formal_parameter' || t === 'parameter_declaration' || t === 'typed_parameter') return 'parameter';
    if (t === 'field_declaration' || t === 'property_declaration' || t === 'field_definition') return 'field';
    if (t === 'variable_declarator' || t === 'lexical_declaration' || t === 'variable_declaration') return 'variable';
    node = node.parent;
  }
  return null;
}

export function isCallExpression(
  tree: Parser.Tree, line: number, char: number,
): boolean {
  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition({ row: line, column: char });
  for (let depth = 0; depth < 4 && node; depth++) {
    if (CALL_NODE_TYPES.has(node.type)) return true;
    node = node.parent;
  }
  return false;
}

export function extractReceiverName(
  tree: Parser.Tree, line: number, char: number,
): string | null {
  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition({ row: line, column: char });
  for (let depth = 0; depth < 4 && node; depth++) {
    if (MEMBER_NODE_TYPES.has(node.type)) {
      const obj = node.childForFieldName('object') ?? node.childForFieldName('operand') ?? node.firstChild;
      if (obj && obj.type !== node.type) {
        return obj.text;
      }
    }
    node = node.parent;
  }
  return null;
}

/**
 * Extract an import path from the tree-sitter AST at `importLine`.
 * Returns `null` if no import node is found, signalling regex fallback.
 */
export function extractImportPathFromTree(
  tree: Parser.Tree, importLine: number,
): string | null {
  // Find any node on the import line
  const node = tree.rootNode.descendantForPosition({ row: importLine, column: 0 });
  if (!node) return null;

  // Walk up to find the import statement node
  let importNode: Parser.SyntaxNode | null = node;
  for (let depth = 0; depth < 6 && importNode; depth++) {
    if (IMPORT_NODE_TYPES.has(importNode.type)) break;
    importNode = importNode.parent;
  }
  if (!importNode || !IMPORT_NODE_TYPES.has(importNode.type)) return null;

  // Look for string literal or dotted-name children (recurse one level
  // for languages like Go where the path is nested inside an import_spec).
  const candidates: Parser.SyntaxNode[] = [];
  for (let i = 0; i < importNode.childCount; i++) {
    const child = importNode.child(i)!;
    candidates.push(child);
    // Recurse into wrapper nodes (e.g. Go's import_spec)
    for (let j = 0; j < child.childCount; j++) {
      candidates.push(child.child(j)!);
    }
  }
  for (const child of candidates) {
    if (child.type === 'string' || child.type === 'string_literal' ||
        child.type === 'interpreted_string_literal' || child.type === 'system_lib_string') {
      // Strip surrounding quotes
      const text = child.text;
      if ((text.startsWith('"') && text.endsWith('"')) ||
          (text.startsWith("'") && text.endsWith("'")) ||
          (text.startsWith('<') && text.endsWith('>'))) {
        return text.slice(1, -1);
      }
      return text;
    }
    // Dotted import path (Java/Python/Kotlin): `import foo.bar.Baz`
    if (child.type === 'dotted_name' || child.type === 'scoped_identifier' ||
        child.type === 'qualified_identifier') {
      return child.text;
    }
  }
  return null;
}

// ─── Ref matching helpers ───────────────────────────────────────────────────

export function findMatchingCallRef(
  treeData: ScipTreeSitterFileData | undefined,
  line: number,
  character: number,
  calleeName: string,
): RawCallRef | null {
  const candidates = treeData?.callRefsByLine.get(line);
  if (!candidates || candidates.length === 0) return null;

  let best: RawCallRef | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const raw = candidate.calleeRaw.replace(/^new\s+/, '');
    const suffix = raw.split(/[.:>#-]/).filter(Boolean).at(-1) ?? raw;
    if (raw !== calleeName && suffix !== calleeName && !raw.endsWith(`.${calleeName}`)) {
      continue;
    }

    const distance = candidate.character === undefined
      ? bestDistance
      : Math.abs(candidate.character - character);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

export function findMatchingTypeRefKind(
  treeData: ScipTreeSitterFileData | undefined,
  line: number,
  character: number,
  calleeName: string,
): RawTypeRef['refKind'] | null {
  const candidates = treeData?.typeRefsByLine.get(line);
  if (!candidates || candidates.length === 0) return null;

  let best: RawTypeRef | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  const normalizedName = normalizeTypeName(calleeName);
  for (const candidate of candidates) {
    if (normalizeTypeName(candidate.typeRaw) !== normalizedName) continue;
    const distance = candidate.character === undefined
      ? bestDistance
      : Math.abs(candidate.character - character);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best?.refKind ?? null;
}

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

  // Step 3: Build the method mapping in-memory: interface_method_id → (concrete_method_id, concrete_name, concrete_def)
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

    // Build descriptor → concrete SCIP symbol map
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
    // Create temp table with the interface→concrete method mappings
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

    // Single bulk INSERT: for each mapping, copy all callers of the
    // interface method as new virtual_dispatch edges to the concrete method,
    // skipping rows that already exist at the same call site.
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
