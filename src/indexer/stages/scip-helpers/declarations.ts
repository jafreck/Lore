import { SymbolRole, type Document, type SymbolInformation } from '../../../scip/scip_pb.js';
import { CSourceSpanResolver } from './source-spans.js';
import { inferKindFromScipSymbol, extractNameFromScipSymbol } from './symbol-kinds.js';

export interface DeclarationRecoveryDiagnostics {
  files: number;
  declarations: number;
}

export function recoverCHeaderDeclarations(
  documents: readonly Document[],
  readSource: (document: Document) => string | undefined,
  languageForDocument: (document: Document) => string | null,
): DeclarationRecoveryDiagnostics {
  const symbols = new Map<string, SymbolInformation>();
  for (const document of documents) {
    for (const symbol of document.symbols) symbols.set(symbol.symbol, symbol);
  }
  const diagnostics = { files: 0, declarations: 0 };
  for (const document of documents) {
    if (languageForDocument(document) !== 'c' || !document.relativePath.endsWith('.h')) continue;
    const source = readSource(document);
    if (source === undefined) continue;
    const resolver = new CSourceSpanResolver(source, document.positionEncoding);
    const isFunction = (symbol: string): boolean => {
      const info = symbols.get(symbol);
      return info !== undefined && inferKindFromScipSymbol(symbol, '', info.kind) === 'function';
    };
    const bodies = document.occurrences.filter(occurrence =>
      (occurrence.symbolRoles & SymbolRole.Definition) !== 0 && isFunction(occurrence.symbol))
      .flatMap(occurrence => {
        const span = resolver.findBraceDelimitedSpan(occurrence.range[0]!, occurrence.range[1]!);
        return span ? [span] : [];
      });
    const localSymbols = new Set(document.symbols.map(symbol => symbol.symbol));
    let recovered = 0;
    for (const occurrence of document.occurrences) {
      if ((occurrence.symbolRoles & SymbolRole.Definition) !== 0 || !isFunction(occurrence.symbol)) continue;
      const line = occurrence.range[0]!;
      if (bodies.some(body => line >= body.startLine && line <= body.endLine)) continue;
      if (resolver.sliceRange(occurrence.range) !== extractNameFromScipSymbol(occurrence.symbol)) continue;
      const declaration = resolver.findFunctionDeclarationSpan(line, occurrence.range[1]!);
      if (!declaration) continue;
      occurrence.symbolRoles |= SymbolRole.Definition | SymbolRole.ForwardDefinition;
      occurrence.enclosingRange = [line, occurrence.range[1]!, declaration.endLine, declaration.endCharacter];
      if (!localSymbols.has(occurrence.symbol)) {
        document.symbols.push(symbols.get(occurrence.symbol)!);
        localSymbols.add(occurrence.symbol);
      }
      recovered++;
    }
    if (recovered > 0) diagnostics.files++;
    diagnostics.declarations += recovered;
  }
  return diagnostics;
}