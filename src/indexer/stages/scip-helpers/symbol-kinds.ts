/**
 * @module indexer/stages/scip-helpers/symbol-kinds
 *
 * SCIP symbol string → Lore kind mapping, symbol string parsing,
 * and reference classification helpers.
 */

// ─── SCIP symbol string → Lore kind mapping ──────────────────────────────────

/**
 * Infer a Lore symbol `kind` from a SCIP symbol string.
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
export function inferKindFromScipSymbol(scipSymbol: string, docHint: string): string {
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
 * SCIP descriptor suffixes:
 *   `().`  → Method/Function → call edge (symbol_refs)
 *   `#`    → Type            → type edge (type_refs)
 *   `.`    → Term (variable, property, constant, enum member) → skip
 *   `/`    → Namespace (module) → skip
 *   `:`    → Meta (object property) → skip
 *   `)`    → Parameter → skip
 *   `]`    → Type parameter → type edge (type_refs)
 */
export function classifyScipReference(scipSymbol: string): 'call' | 'type' | 'skip' {
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
