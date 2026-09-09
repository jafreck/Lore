# Execution trust

Lore indexes checkouts that may be untrusted. A checked-in `.lore.config` can
request indexing work, but only the process owner can grant permission to run
code. Provider enablement and execution authority are separate decisions.

For example, `{"lsp":{"enabled":true}}` asks Lore to use LSP. It does not
authorize a language-server process. Likewise, repository values such as
`scip.allowBuildExecution: true`, `scip.autoInstall: true`, custom
`scip.indexers`, and custom `lsp.servers` do not create host permissions.

## Behavior without host grants

Lore may:

- walk recognized files and store source snapshots;
- read precomputed SCIP files selected by `scip.indexDir` when their canonical
  targets remain inside the indexed root or a host-approved root;
- discover, parse, validate, and use an existing `compile_commands.json`;
- perform SQLite-only import, edge, FTS, validation, and promotion work; and
- read Git data when the process owner explicitly selected history ingestion.

Lore does not:

- start a SCIP indexer or language server;
- run CMake, Meson, `configure`, Bear, or Make;
- apply repository-provided command, argument, or cwd overrides; or
- download or install a missing SCIP indexer as an indexing side effect.

An enabled provider that cannot run is skipped and recorded in index-run
provenance. Source discovery still proceeds, so provider enablement alone does
not guarantee structural symbols.

## Host grants

| Capability | CLI grant | `IndexBuilderOptions.execution` |
|---|---|---|
| Built-in SCIP indexers and LSP servers | `--allow-subprocess-execution` | `allowSubprocessExecution: true` |
| Custom SCIP command, arguments, or cwd | `--allow-custom-indexer-commands` | `allowCustomIndexerCommands: true` |
| Custom LSP command, arguments, or cwd | `--allow-custom-lsp-commands` | `allowCustomLspCommands: true` |
| C/C++ compilation-database generation | `--allow-build-execution` | `allowBuildExecution: true` |
| Automatic SCIP installation | `--allow-auto-install` | `allowAutoInstall: true` |
| Additional approved command cwd | `--allow-command-cwd <dir>` | `allowedCwdRoots: [dir]` |
| Out-of-tree compdb source/cwd root | `--allow-external-build-root <dir>` | `allowedCwdRoots: [dir]` |

`--allow-subprocess-execution` applies only to built-in registries. It does not
authorize custom commands, builds, or installation. A category-specific grant
also enables the process needed by that category: build, custom-indexer, and
auto-install grants permit SCIP indexer execution; a custom-LSP grant permits
LSP execution. None grants an unrelated category.

Repository booleans can narrow a host grant. For example,
`scip.allowBuildExecution: false` suppresses generation even when the host used
`--allow-build-execution`. A repository value of `true` cannot widen host
authority. Custom registry entries are ignored unless their corresponding
custom-command grant is present.

`IndexBuilderOptions.scipScope` is a separate host-owned coverage boundary.
Only programmatic options or explicit `--scip-scope-language`,
`--scip-scope-include`, and `--scip-scope-exclude` flags supply it. Repository
fields cannot broaden, narrow, or supply this scope, and repository validation
policies are ignored for explicitly scoped certification. Scope intersects
`WalkerConfig` after canonical root/symlink checks. It grants none of the
capabilities in the table: `lsp: false` still disables LSP, and missing execution
permission still produces skipped providers and failed migration-grade coverage.
Repository provider settings can still prevent execution, but cannot turn
missing required scoped coverage into a successful certification.

Scoped C/C++ indexers receive a private filtered compdb containing only selected
translation units. Authorized compilers may still read headers or other inputs
outside the selected set under their normal OS permissions. Scope controls
launch selection, imported documents, and coverage certification, not process
filesystem access. Out-of-root source symlinks cannot enter the effective scope
even when the host has separately approved an external command/build cwd.

Both cwd-related CLI options currently feed the same programmatic
`allowedCwdRoots` list. Consequently, either option approves that directory for
custom command cwd containment and for compilation-database source/working-
directory validation. Use the more descriptive flag for operator clarity, but
do not assume it is a narrower technical capability.

## Working-directory and path containment

The indexed project root is always an approved command cwd. A relative custom
cwd is resolved from that root. A requested cwd must exist and be a directory;
only additional roots that resolve to existing directories become approved.
Lore compares canonical real paths, so `..` and symlinks cannot escape the
approved roots.

`scip.indexDir` is repository-selected data input: the directory must be
lexically inside the project root or a host-approved root, and every existing
`.scip` candidate is canonicalized before reading. An unapproved out-of-root
directory or a symlink whose target leaves all approved roots is rejected.
Because both cwd-related CLI flags feed `allowedCwdRoots`, either one can widen
this precomputed-input boundary; keep those grants narrow.

Compilation-database entries are accepted only when both their translation unit
and working directory are inside the project root or a host-approved external
root. Without explicit scope, a database with any well-formed entry outside
those roots is classified as relocated and is not passed to `scip-clang`.
With host scope, membership filters raw entries first and these checks apply
to every selected entry; only the validated filtered database is passed to the
indexer. Missing files/directories and
unexpanded response files produce partial or stale diagnostics; response-file
budgets retain the original `@file` argument instead of silently discarding
compiler flags.

Keep approved roots narrow. Approving a mutable parent directory, a home
directory, or a shared temporary directory gives repository-controlled commands
more places from which they may run and broadens accepted compdb paths.

## Output and build rules

Generated SCIP output never falls back to a path in the checkout. Every indexer
argument template must contain `{output}`. Lore replaces it with a random file
inside a private mode-`0700` temporary directory, rejects symlinks and multiply
linked output files, opens with no-follow semantics when available, verifies
the inode after opening, reads the bytes, and removes the directory.

Compiler diagnostic collection adds no execution capability. Once a native
scip-clang invocation is authorized, Lore forces its diagnostic-output flag and
captures bounded stdout/stderr. Reported compiler errors or incomplete capture
reject the generated index, including after process exit zero. This runs no
second compiler or language server, does not grant build/install permission,
and does not override `lsp: false`. Custom-command hosts are responsible for
enabling their compiler's diagnostics; an arbitrary wrapper that suppresses
errors is not made trustworthy by output capture.

These controls are capability checks, not a universal Git, network, or
filesystem-read sandbox. Lore still reads in-scope source, configuration, Git,
database, compilation-database, and contained SCIP data needed for the selected
operation. An explicit install action may use the network, and any authorized
indexer, language server, or build process retains the operating-system user's
network and filesystem permissions. The output checks protect the file Lore
ingests; they do not sandbox that process. Treat custom-command grants as
code-execution grants and use an external OS/container sandbox when the
checkout, executable, or ambient credentials are not trusted.

Precomputed `.scip` files are data inputs and require no process grant. Their
contents are parsed, but they are not executed. Original compiler diagnostics
cannot be reconstructed from them, so C/C++ validation reports an unverified
compilation warning. Neither accepting a precomputed file nor passing file and
symbol coverage thresholds proves complete references or a clean compilation.

Compilation-database generation is different: build-system configuration can
execute arbitrary repository-controlled build logic. Lore invokes programs
without a shell and directs generated compdb output to
`<root>/.lore-compdb/compile_commands.json`, but CMake, Meson, `configure`, and
Make can still perform any action available to the operating-system user.
Grant `--allow-build-execution` only for a trusted checkout or inside an
appropriate sandbox. `--allow-external-build-root` validates out-of-tree paths;
it does not relocate Lore's generated `.lore-compdb` directory.

## Programmatic hosts

The fourth `IndexBuilder` constructor argument accepts provider requests and a
separate host-owned execution object:

```ts
import { IndexBuilder } from '@jafreck/lore';

const builder = new IndexBuilder('lore.db', { rootDir: checkout }, undefined, {
  scip: { indexDir: '.ci/scip', timeoutMs: 120_000 },
  lsp: false,
  execution: {},
});

await builder.build(); // reads precomputed data and starts no provider process
```

A trusted host can grant only what it needs:

```ts
const builder = new IndexBuilder('lore.db', { rootDir: checkout }, undefined, {
  scip: true,
  lsp: true,
  execution: {
    allowSubprocessExecution: true,
    allowBuildExecution: false,
    allowAutoInstall: false,
    allowedCwdRoots: ['/opt/trusted-build'],
  },
});

await builder.build();
```

Constructing `IndexBuilder` does not parse repository configuration or open the
database. `resolveConfiguration()` validates and returns effective settings;
`build()`, `refresh()`, and `baselineRebuild()` resolve them on first use.

## Installer command

Running `lore install-scip` is itself an explicit operator action and does not
consult `.lore.config`. `--allow-auto-install` controls only installation
triggered while indexing.
