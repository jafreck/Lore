/**
 * Host-controlled execution permissions for indexing untrusted repositories.
 *
 * Repository configuration is never accepted as an authority for these
 * capabilities. Callers must provide them directly (or through explicit CLI
 * flags) for each Lore process they trust to execute code.
 */

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Explicit permissions supplied by the host running Lore. */
export interface IndexExecutionOptions {
  /** Allow built-in SCIP indexers and LSP servers to start. */
  allowSubprocessExecution?: boolean;
  /** Allow configure/build tools to generate a compilation database. */
  allowBuildExecution?: boolean;
  /** Honor repository/programmatic SCIP command, argument, and cwd overrides. */
  allowCustomIndexerCommands?: boolean;
  /** Honor repository/programmatic LSP command, argument, and cwd overrides. */
  allowCustomLspCommands?: boolean;
  /** Allow automatic SCIP indexer downloads or package installation. */
  allowAutoInstall?: boolean;
  /** Additional roots under which a custom command cwd may reside. */
  allowedCwdRoots?: readonly string[];
}

/** Fully resolved, immutable-by-convention execution policy. */
export interface ResolvedIndexExecutionPolicy {
  allowSubprocessExecution: boolean;
  allowBuildExecution: boolean;
  allowCustomIndexerCommands: boolean;
  allowCustomLspCommands: boolean;
  allowAutoInstall: boolean;
  /** Whether a SCIP indexer may be started under this policy. */
  allowIndexerExecution: boolean;
  /** Whether an LSP server may be started under this policy. */
  allowLspExecution: boolean;
  allowedCwdRoots: readonly string[];
}

/** Resolve host permissions. Specific permissions only imply their own process category. */
export function resolveIndexExecutionPolicy(
  options: IndexExecutionOptions = {},
): ResolvedIndexExecutionPolicy {
  const allowSubprocessExecution = options.allowSubprocessExecution === true;
  const allowBuildExecution = options.allowBuildExecution === true;
  const allowCustomIndexerCommands = options.allowCustomIndexerCommands === true;
  const allowCustomLspCommands = options.allowCustomLspCommands === true;
  const allowAutoInstall = options.allowAutoInstall === true;

  return {
    allowSubprocessExecution,
    allowBuildExecution,
    allowCustomIndexerCommands,
    allowCustomLspCommands,
    allowAutoInstall,
    allowIndexerExecution:
      allowSubprocessExecution
      || allowBuildExecution
      || allowCustomIndexerCommands
      || allowAutoInstall,
    allowLspExecution: allowSubprocessExecution || allowCustomLspCommands,
    allowedCwdRoots: [...(options.allowedCwdRoots ?? [])],
  };
}

/**
 * Resolve and validate a subprocess working directory.
 *
 * The indexed project root is always approved. Additional roots must come
 * from host-trusted execution options. Real paths are compared so a symlink
 * inside an approved root cannot redirect a command outside it.
 */
export function resolveApprovedCommandCwd(
  projectRoot: string,
  requestedCwd: string | undefined,
  additionalApprovedRoots: readonly string[] = [],
): string {
  const absoluteProjectRoot = resolve(projectRoot);
  const candidate = requestedCwd === undefined || requestedCwd.trim() === ''
    ? absoluteProjectRoot
    : isAbsolute(requestedCwd)
      ? resolve(requestedCwd)
      : resolve(absoluteProjectRoot, requestedCwd);

  const canonicalCandidate = canonicalDirectory(candidate, 'command cwd');
  const approvedRoots = [absoluteProjectRoot, ...additionalApprovedRoots]
    .map((root) => {
      try {
        return canonicalDirectory(root, 'approved cwd root');
      } catch {
        return null;
      }
    })
    .filter((root): root is string => root !== null);

  if (!approvedRoots.some((root) => isWithin(root, canonicalCandidate))) {
    throw new Error(
      `Command cwd is outside the approved roots: ${candidate}. `
      + 'Use a host-trusted allowedCwdRoots entry to permit it.',
    );
  }

  return canonicalCandidate;
}

function canonicalDirectory(path: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new Error(`${label} does not exist or cannot be resolved: ${path}`);
  }
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
  return canonical;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
