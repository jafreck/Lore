import type { DocumentSymbol } from '../../lsp/client.js';
import type { IncomingSupplementSymbol } from './lsp-supplementation.js';

export interface PreprocessorMacro {
  name: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  signature: string;
  conditional: boolean;
  condition: string | null;
  /** Conditional source declarations are heuristic until LSP confirms them. */
  heuristic: boolean;
}

export interface LanguageSupplementRequest {
  filePath: string;
  language: string;
  source: string;
  documentSymbols: readonly DocumentSymbol[];
  nextIndex: number;
}

export interface LanguageSupplementResult {
  symbols: IncomingSupplementSymbol[];
  consumedDocumentSymbols: Set<DocumentSymbol>;
  diagnostics: Record<string, number>;
}

export interface LanguageSupplementProvider {
  collect(request: LanguageSupplementRequest): LanguageSupplementResult;
}

interface ConditionalFrame {
  branches: string[];
  current: string;
}

/**
 * Parse physical `#define` declarations without pretending the raw source is a
 * preprocessed translation unit. Conditional declarations carry their raw
 * condition and remain heuristic until a language server reports them.
 */
export function extractPreprocessorMacros(source: string): PreprocessorMacro[] {
  const lines = source.split('\n');
  const macros: PreprocessorMacro[] = [];
  const conditionStack: ConditionalFrame[] = [];
  let inBlockComment = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const stripped = stripComments(line, inBlockComment);
    inBlockComment = stripped.inBlockComment;
    const visible = stripped.text;
    const directive = /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*?))?\s*$/u.exec(visible);
    if (!directive?.[1]) continue;

    const command = directive[1].toLowerCase();
    const argument = directive[2]?.trim() ?? '';
    if (command === 'if' || command === 'ifdef' || command === 'ifndef') {
      const condition = command === 'if'
        ? argument
        : `${command} ${argument}`.trim();
      conditionStack.push({ branches: [condition], current: condition });
      continue;
    }
    if (command === 'elif' && conditionStack.length > 0) {
      const frame = conditionStack[conditionStack.length - 1]!;
      frame.current = argument;
      frame.branches.push(argument);
      continue;
    }
    if (command === 'else' && conditionStack.length > 0) {
      const frame = conditionStack[conditionStack.length - 1]!;
      frame.current = `else(${frame.branches.join(' || ')})`;
      continue;
    }
    if (command === 'endif') {
      conditionStack.pop();
      continue;
    }
    if (command !== 'define') continue;

    const macroMatch = /^([A-Za-z_][A-Za-z0-9_]*)/u.exec(argument);
    if (!macroMatch?.[1]) continue;
    const name = macroMatch[1];
    const startLine = lineIndex;
    let endLine = lineIndex;
    while (endLine < lines.length - 1 && /\\\s*$/u.test(lines[endLine]!)) endLine++;
    const startCharacter = Math.max(0, line.indexOf(name));
    const conditional = conditionStack.length > 0;
    const condition = conditional
      ? conditionStack.map((frame) => frame.current).join(' && ')
      : null;

    macros.push({
      name,
      startLine,
      startCharacter,
      endLine,
      endCharacter: lines[endLine]!.length,
      signature: lines.slice(startLine, endLine + 1).join('\n').trim(),
      conditional,
      condition,
      heuristic: conditional,
    });
    lineIndex = endLine;
  }

  return macros;
}

function stripComments(line: string, initiallyInBlockComment: boolean): {
  text: string;
  inBlockComment: boolean;
} {
  let inBlockComment = initiallyInBlockComment;
  let text = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    if (inBlockComment) {
      const close = line.indexOf('*/', index);
      if (close < 0) return { text, inBlockComment };
      inBlockComment = false;
      index = close + 1;
      continue;
    }
    const character = line[index]!;
    if (quote) {
      text += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      text += character;
      continue;
    }
    if (line.startsWith('/*', index)) {
      inBlockComment = true;
      index++;
      continue;
    }
    if (line.startsWith('//', index)) break;
    text += character;
  }
  return { text, inBlockComment };
}

class CMacroSupplementProvider implements LanguageSupplementProvider {
  collect(request: LanguageSupplementRequest): LanguageSupplementResult {
    const macros = extractPreprocessorMacros(request.source);
    const visibleSymbols = flattenSymbols(request.documentSymbols);
    const consumedDocumentSymbols = new Set<DocumentSymbol>();
    const symbols: IncomingSupplementSymbol[] = [];
    let conditionalSkipped = 0;
    let conditionalVisible = 0;
    let unconditional = 0;

    for (const macro of macros) {
      const visible = visibleSymbols.find(({ symbol }) =>
        symbol.name === macro.name
        && symbol.selectionRange.start.line >= macro.startLine
        && symbol.selectionRange.start.line <= macro.endLine,
      )?.symbol;

      // A conditional raw declaration can be inactive. Only include it when
      // clangd (or another compiler-backed LSP) exposes that exact declaration.
      if (macro.conditional && !visible) {
        conditionalSkipped++;
        continue;
      }
      if (visible) consumedDocumentSymbols.add(visible);

      const provenance = macro.conditional
        ? 'lsp-visible-conditional' as const
        : 'raw-source-unconditional' as const;
      const conditionTag = macro.condition ? `; condition=${macro.condition}` : '';
      symbols.push({
        index: request.nextIndex + symbols.length,
        parentIndex: null,
        path: request.filePath,
        name: macro.name,
        kind: 'macro',
        parentChain: [],
        signature: macro.signature,
        detail: macro.signature,
        docComment: `[lore:macro-provenance=${provenance}${conditionTag}]`,
        documentSymbol: visible ?? null,
        provenance,
        range: {
          startLine: macro.startLine,
          startCharacter: 0,
          endLine: macro.endLine,
          endCharacter: macro.endCharacter,
        },
        selectionLine: macro.startLine,
        selectionCharacter: macro.startCharacter,
      });
      if (macro.conditional) conditionalVisible++;
      else unconditional++;
    }

    return {
      symbols,
      consumedDocumentSymbols,
      diagnostics: {
        rawMacros: macros.length,
        unconditionalMacros: unconditional,
        lspVisibleConditionalMacros: conditionalVisible,
        heuristicConditionalMacrosSkipped: conditionalSkipped,
      },
    };
  }
}

function flattenSymbols(symbols: readonly DocumentSymbol[]): Array<{ symbol: DocumentSymbol }> {
  const flattened: Array<{ symbol: DocumentSymbol }> = [];
  const visit = (entries: readonly DocumentSymbol[]): void => {
    for (const symbol of entries) {
      flattened.push({ symbol });
      if (symbol.children?.length) visit(symbol.children);
    }
  };
  visit(symbols);
  return flattened;
}

const C_MACRO_PROVIDER = new CMacroSupplementProvider();

/** Language-specific supplements are hooks; generic LSP extraction stays agnostic. */
export function getLanguageSupplementProvider(language: string): LanguageSupplementProvider | null {
  return language === 'c' || language === 'cpp' ? C_MACRO_PROVIDER : null;
}
