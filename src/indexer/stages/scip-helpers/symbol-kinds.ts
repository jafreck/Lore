/**
 * @module indexer/stages/scip-helpers/symbol-kinds
 *
 * SCIP symbol string → Lore kind mapping, symbol string parsing,
 * and reference classification helpers.
 */

// ─── SymbolInformation.kind → Lore kind mapping ──────────────────────────────

/**
 * Map SCIP `SymbolInformation.kind` (87 enum values) to a Lore kind string.
 * Returns `null` when `kind` is 0 (UnspecifiedKind), signalling fallback to
 * descriptor-suffix inference.
 *
 * Values from the `SymbolInformation_Kind` enum in scip_pb.ts.
 */
function mapScipKindToLore(kind: number): string | null {
  switch (kind) {
    // Method family
    case 26: // Method
    case 66: // AbstractMethod
    case 67: // MethodSpecification
    case 68: // ProtocolMethod
    case 69: // PureVirtualMethod
    case 70: // TraitMethod
    case 71: // TypeClassMethod
    case 74: // MethodAlias
    case 76: // SingletonMethod
    case 80: // StaticMethod
      return 'method';

    // Function family
    case 17: // Function
      return 'function';

    // Constructor
    case 9:  // Constructor
      return 'constructor';

    // Class / Struct family
    case 7:  // Class
    case 49: // Struct
    case 75: // SingletonClass
      return 'class';

    // Interface / Protocol / Trait family
    case 21: // Interface
    case 42: // Protocol
    case 53: // Trait
      return 'interface';

    // Enum
    case 11: // Enum
      return 'enum';

    // Enum member
    case 12: // EnumMember
      return 'enum_member';

    // Type alias family
    case 54: // Type
    case 55: // TypeAlias
    case 56: // TypeClass
    case 57: // TypeFamily
      return 'type_alias';

    // Constant / static value
    case 8:  // Constant
      return 'constant';

    // Property / field family
    case 15: // Field
    case 41: // Property
    case 79: // StaticField
    case 81: // StaticProperty
      return 'property';

    // Variable
    case 61: // Variable
    case 82: // StaticVariable
    case 77: // StaticDataMember
    case 60: // Value
      return 'variable';

    // Module / namespace / package family
    case 29: // Module
    case 30: // Namespace
    case 35: // Package
    case 36: // PackageObject
    case 64: // Library
      return 'module';

    // Parameter
    case 37: // Parameter
    case 38: // ParameterLabel
    case 44: // SelfParameter
    case 52: // ThisParameter
    case 27: // MethodReceiver
      return 'parameter';

    // Getter / setter / accessor
    case 18: // Getter
    case 45: // Setter
    case 72: // Accessor
      return 'method';

    // Macro
    case 25: // Macro
      return 'function';

    // Type parameter
    case 58: // TypeParameter
      return 'parameter';

    // 0 = UnspecifiedKind → fall through to suffix-based inference
    default:
      return null;
  }
}

// ─── SCIP symbol string → Lore kind mapping ──────────────────────────────────

/**
 * Infer a Lore symbol `kind` from a SCIP symbol string.
 *
 * Uses a two-tier strategy:
 * 1. `SymbolInformation.kind` — authoritative when non-zero. Provides
 *    compiler-accurate kind classification (87 distinct values).
 * 2. Descriptor suffix + doc hint — fallback when kind is unspecified.
 *
 * SCIP symbol syntax:  `<scheme> <package> (<descriptor>)+`
 * Descriptor suffixes:
 *   - `/`  → Namespace (module/package)
 *   - `#`  → Type (class, interface, enum)
 *   - `.`  → Term (variable, constant, property, enum member)
 *   - `().` → Method/Function
 *   - `(name)` → Parameter
 *   - `[name]` → Type parameter
 *   - `name:` → Meta (object property)
 */
export function inferKindFromScipSymbol(
  scipSymbol: string,
  docHint: string,
  symbolInfoKind: number = 0,
): string {
  // Tier 1: Use SymbolInformation.kind when available
  const mapped = mapScipKindToLore(symbolInfoKind);
  if (mapped !== null) {
    // Refine class → interface using doc hint when SymbolInformation.kind
    // reports generic "Class" but documentation says interface/trait
    if (mapped === 'class') {
      if (docHint.includes('interface ')) return 'interface';
      if (docHint.includes('trait ')) return 'interface';
    }
    return mapped;
  }

  // Tier 2: Descriptor suffix + doc hint fallback
  // Method/function: ends with ().<any> or just ().
  if (/\(\+?\d*\)\.$/.test(scipSymbol)) {
    // Use doc hint to distinguish constructor
    if (docHint.includes('constructor')) return 'constructor';
    // Check if inside a type — method vs function
    const parts = scipSymbol.split(/(?<=[#/.])/);
    const hasType = parts.some(p => p.endsWith('#'));
    return hasType ? 'method' : 'function';
  }

  // Type: ends with #
  if (scipSymbol.endsWith('#')) {
    if (docHint.includes('interface ')) return 'interface';
    if (docHint.includes('trait ')) return 'interface';
    if (docHint.includes('enum ')) return 'enum';
    if (docHint.includes('type ')) return 'type_alias';
    return 'class';
  }

  // Namespace: ends with /
  if (scipSymbol.endsWith('/')) return 'module';

  // Term: ends with .
  if (scipSymbol.endsWith('.')) {
    if (docHint.includes('(enum member)')) return 'enum_member';
    if (docHint.includes('const ')) return 'constant';
    if (docHint.includes('(property)')) return 'property';
    // scip-clang uses term descriptors for C/C++ functions:
    //   ` $ funcName(hexhash).` — the (hash) indicates a function, not a variable.
    if (/\([0-9a-f]{8,}\)\.$/.test(scipSymbol)) return 'function';
    return 'variable';
  }

  // Meta: ends with :
  if (scipSymbol.endsWith(':')) return 'property';

  // Parameter
  if (scipSymbol.endsWith(')') && !scipSymbol.endsWith(').')) return 'parameter';

  return 'variable';
}

/**
 * Extract the parent SCIP symbol string by stripping the last descriptor.
 *
 * SCIP symbols are formed by chaining descriptors: `scheme package desc1 desc2 desc3`
 * The parent of `desc3` is `scheme package desc1 desc2`.
 *
 * E.g. `scip-java maven pkg 1.0 com/fasterxml/jackson/BeanSerializer#serialize().`
 * → `scip-java maven pkg 1.0 com/fasterxml/jackson/BeanSerializer#`
 *
 * Returns `null` if the symbol has no parent (top-level or unparseable).
 */
export function extractParentScipSymbol(scipSymbol: string): string | null {
  if (!scipSymbol || scipSymbol.startsWith('local ')) return null;

  // Find the end of the package section (3 space-separated segments after scheme)
  // Format: <scheme> ' ' <manager> ' ' <package-name> ' ' <version> ' ' <descriptors>
  let spaceCount = 0;
  let packageEnd = 0;
  for (let i = 0; i < scipSymbol.length; i++) {
    if (scipSymbol[i] === ' ' && (i === 0 || scipSymbol[i - 1] !== ' ')) {
      spaceCount++;
      if (spaceCount === 4) {
        packageEnd = i + 1;
        break;
      }
    }
  }
  if (packageEnd === 0) return null;

  const descriptorPart = scipSymbol.slice(packageEnd);
  if (!descriptorPart) return null;

  // Split descriptors by suffix characters (/, #, ., :, !), keeping delimiters
  // Method descriptors end with '().' or '(+N).'
  // We need to find the start of the last descriptor

  // Strategy: tokenize from the end. The last descriptor ends at the string end
  // and starts after the previous descriptor's suffix.
  // Descriptor suffixes: / # . : ! and method pattern ().

  // Strip the last descriptor by finding where it starts
  let lastDescStart = descriptorPart.length;

  // Walk backward to find the start of the last descriptor
  // A method descriptor ends with `().` — check for that pattern first
  if (descriptorPart.endsWith('.')) {
    // Could be a method `name().` or a term `name.`
    const beforeDot = descriptorPart.slice(0, -1);
    const parenClose = beforeDot.lastIndexOf(')');
    if (parenClose >= 0) {
      // Find matching open paren
      const parenOpen = beforeDot.lastIndexOf('(', parenClose);
      if (parenOpen >= 0) {
        // Method descriptor: everything from start-of-name to end
        // Find where the name starts (after previous suffix)
        lastDescStart = findDescriptorNameStart(beforeDot, parenOpen);
      }
    }
    if (lastDescStart === descriptorPart.length) {
      // Simple term: name.
      const nameEnd = descriptorPart.length - 1; // position of '.'
      lastDescStart = findDescriptorNameStart(descriptorPart, nameEnd);
    }
  } else if (descriptorPart.endsWith('#') || descriptorPart.endsWith('/') ||
             descriptorPart.endsWith(':') || descriptorPart.endsWith('!')) {
    const nameEnd = descriptorPart.length - 1;
    lastDescStart = findDescriptorNameStart(descriptorPart, nameEnd);
  } else {
    // Unknown suffix pattern
    return null;
  }

  if (lastDescStart <= 0) return null;

  const parentDescriptors = descriptorPart.slice(0, lastDescStart);
  if (!parentDescriptors) return null;

  return scipSymbol.slice(0, packageEnd) + parentDescriptors;
}

/**
 * Find where a descriptor name starts, given the position of its suffix.
 * Walks backward past the name (possibly backtick-escaped) to the previous
 * descriptor's suffix character.
 */
function findDescriptorNameStart(s: string, suffixPos: number): number {
  let i = suffixPos - 1;
  // Handle backtick-escaped identifiers
  if (i >= 0 && s[i] === '`') {
    // Walk back to the opening backtick
    i--;
    while (i >= 0 && s[i] !== '`') i--;
    return i;
  }
  // Walk back through simple identifier characters
  while (i >= 0 && /[_+\-$a-zA-Z0-9]/.test(s[i]!)) i--;
  return i + 1;
}

/**
 * Count the number of descriptors in a SCIP symbol string.
 *
 * Used to sort symbols shallowest-first so parents are inserted before
 * children.  Counts descriptor-ending characters (`/`, `#`, `.`, `:`, `!`)
 * after the package prefix.
 */
export function descriptorDepth(scipSymbol: string): number {
  // Skip past the 4-space-separated package header
  let spaceCount = 0;
  let start = 0;
  for (let i = 0; i < scipSymbol.length; i++) {
    if (scipSymbol[i] === ' ' && (i === 0 || scipSymbol[i - 1] !== ' ')) {
      spaceCount++;
      if (spaceCount === 4) { start = i + 1; break; }
    }
  }
  // Count descriptor suffix characters in the descriptor portion
  let depth = 0;
  for (let i = start; i < scipSymbol.length; i++) {
    const ch = scipSymbol[i];
    if (ch === '/' || ch === '#' || ch === '.' || ch === ':' || ch === '!') depth++;
  }
  return depth;
}

/**
 * Extract a human-readable name from a SCIP symbol string.
 *
 * E.g. `scip-typescript npm pkg 1.0 src/\`file.ts\`/MyClass#myMethod().`
 * → `myMethod`
 */
export function extractNameFromScipSymbol(scipSymbol: string): string {
  // Strip trailing descriptor suffix (., #, /, :, etc.)
  let cleaned = scipSymbol.replace(/[.#/:]$/, '');

  // For methods, strip the disambiguator: `name(+1).` → `name`
  cleaned = cleaned.replace(/\(\+?\d*\)$/, '');

  // scip-clang uses ` $ name(hash)` for C/C++ symbols — strip the hash.
  // E.g., ` $ parse_analyze_fixedparams(39d222e79bbfb7c0)` → `parse_analyze_fixedparams`
  cleaned = cleaned.replace(/\([0-9a-f]{8,}\)$/, '');

  // Get the last descriptor's name
  // Descriptors are separated by ., #, /, :, or ()
  const parts = cleaned.split(/[.#/:]/);
  let name = parts[parts.length - 1] || '';

  // Remove backtick escaping
  name = name.replace(/`/g, '');

  // Strip leading ` $ ` prefix used by scip-clang
  name = name.replace(/^\s*\$\s*/, '');

  // Handle parameter descriptors like `(paramName)`
  if (name.startsWith('(') && name.endsWith(')')) {
    name = name.slice(1, -1);
  }

  return name || scipSymbol;
}

/**
 * Extract a signature from SCIP SymbolInformation documentation.
 *
 * scip-typescript puts the TypeScript type signature in the first
 * documentation entry wrapped in a markdown code fence.
 */
export function extractSignatureFromDoc(doc: string): string {
  const cleaned = doc
    .replace(/```[a-z0-9_+-]*\n/gi, '')
    .replace(/```/g, '')
    .trim();
  return cleaned || '';
}

// ─── SCIP reference classification ──────────────────────────────────────────

/**
 * Classify a SCIP symbol reference into the graph edge type it represents.
 *
 * Uses a two-tier strategy:
 * 1. SCIP `syntaxKind` (from `Occurrence.syntaxKind`) — authoritative when
 *    populated (non-zero). Maps function/macro identifiers to 'call' and
 *    type identifiers to 'type'.
 * 2. SCIP descriptor suffix — fallback when `syntaxKind` is unspecified (0).
 *
 * This allows term-suffix `.` symbols (arrow functions, const-assigned
 * functions) to be correctly classified as calls when the indexer provides
 * `syntaxKind = IdentifierFunction`.
 */
export function classifyScipReference(
  scipSymbol: string,
  syntaxKind: number = 0,
): 'call' | 'type' | 'skip' {
  // ── Tier 1: syntaxKind (authoritative when populated) ───────────────────
  if (syntaxKind !== 0) {
    // SyntaxKind enum values from SCIP spec:
    //   IdentifierFunction = 15, IdentifierFunctionDefinition = 16,
    //   IdentifierMacro = 17, IdentifierMacroDefinition = 18
    if (syntaxKind >= 15 && syntaxKind <= 18) return 'call';
    //   IdentifierType = 19, IdentifierBuiltinType = 20
    if (syntaxKind === 19 || syntaxKind === 20) return 'type';
    //   IdentifierNamespace = 14, IdentifierParameter = 11,
    //   IdentifierLocal = 12, etc. → skip
  }

  // ── Tier 2: descriptor suffix (fallback) ────────────────────────────────

  // Method/function: ends with ().  or (+N).  (with disambiguator)
  if (/\(\+?\d*\)\.$/.test(scipSymbol)) return 'call';

  // scip-clang C/C++ functions: term descriptors ending with `(hexhash).`
  // E.g., `$ parse_analyze_fixedparams(39d222e79bbfb7c0).`
  if (/\([0-9a-f]{8,}\)\.$/.test(scipSymbol)) return 'call';

  // Type: ends with #
  if (scipSymbol.endsWith('#')) return 'type';

  // Type parameter: ends with ]
  if (scipSymbol.endsWith(']')) return 'type';

  // Term (variable, property, constant, enum member): ends with .
  // Namespace: ends with /
  // Meta (object property): ends with :
  // Parameter: ends with )
  // All of these are reads/imports/structural — not call or type edges.
  return 'skip';
}

// ─── Virtual dispatch symbol helpers ────────────────────────────────────────

/**
 * Extract the parent type's SCIP symbol from a method's SCIP symbol.
 *
 * SCIP method symbols look like: `<scheme> <package> <...>TypeName#MethodName().`
 * The parent type symbol is the prefix up to and including the `#`.
 *
 * Returns `null` if the symbol doesn't appear to be a method inside a type.
 */
export function extractParentTypeSymbol(scipSymbol: string): string | null {
  // Match everything up to the last `#` followed by a method descriptor
  const hashIdx = scipSymbol.lastIndexOf('#');
  if (hashIdx < 0) return null;
  // Verify what follows the # looks like a method: `MethodName().`
  const afterHash = scipSymbol.slice(hashIdx + 1);
  if (!/\w/.test(afterHash)) return null;
  return scipSymbol.slice(0, hashIdx + 1);
}

/**
 * Extract the method descriptor portion after the type's `#`.
 *
 * E.g., `...contextImpl#Build().` → `Build().`
 */
export function extractMethodDescriptor(scipSymbol: string): string | null {
  const hashIdx = scipSymbol.lastIndexOf('#');
  if (hashIdx < 0) return null;
  return scipSymbol.slice(hashIdx + 1);
}
