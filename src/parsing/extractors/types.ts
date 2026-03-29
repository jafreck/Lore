/**
 * @module parsing/extractors/types
 *
 * Minimal type stubs retained after tree-sitter removal.
 * These types are still referenced by the SCIP ref pipeline and
 * will be removed once tree-sitter references are fully cleaned up.
 */

/** A call-site reference found in a source file. */
export interface RawCallRef {
  /** Name of the enclosing symbol that contains the call. */
  callerSymbol: string;
  /** Raw callee expression text as it appears in source. */
  calleeRaw: string;
  /** 0-indexed line of the call expression. */
  line: number;
  /** 0-indexed character in the call line. */
  character?: number;
  /** How the callee is invoked. */
  callKind?: 'direct' | 'indirect' | 'macro' | 'virtual';
}

/** A type reference found in a source file. */
export type TypeRefKind = 'return' | 'parameter' | 'field' | 'variable' | 'bound' | 'generic_arg' | 'other';

export interface RawTypeRef {
  /** Name of the enclosing symbol that contains the type reference. */
  enclosingSymbol: string;
  /** Raw type name as it appears in the source. */
  typeRaw: string;
  /** Classification of the type reference position. */
  refKind: TypeRefKind;
  /** 0-indexed line in the source file. */
  line: number;
  /** 0-indexed character in the line. */
  character?: number;
}
