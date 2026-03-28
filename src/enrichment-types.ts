/**
 * @module enrichment-types
 *
 * Shared types and utilities used by both LSP and SCIP enrichment
 * coordinators.  Extracted here to avoid bidirectional imports between
 * the `lsp/` and `scip/` modules.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResolvedTypeMetadata {
  resolvedTypeSignature: string | null;
  resolvedReturnType: string | null;
  definitionUri: string | null;
  definitionPath: string | null;
  definitionLine: number | null;
  definitionCharacter: number | null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Extract a return type from a type signature string.
 * Reuses the same heuristics as LSP enrichment.
 */
export function extractReturnType(signature: string | null): string | null {
  if (!signature) return null;
  const lines = signature.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const firstLine = lines[0]!;

  const functionStyle = firstLine.match(/\)\s*:\s*([^={]+)$/u);
  if (functionStyle?.[1]) return functionStyle[1].trim();

  const arrowStyle = firstLine.match(/->\s*([^={]+)$/u);
  if (arrowStyle?.[1]) return arrowStyle[1].trim();

  const colonStyle = firstLine.match(/:\s*([^={]+)$/u);
  if (colonStyle?.[1]) return colonStyle[1].trim();

  return null;
}
