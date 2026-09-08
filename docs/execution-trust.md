# Repository configuration and execution trust

Lore treats every checked-out `.lore.config` file as untrusted repository data.
Configuration can request indexing behavior, but it cannot grant the host an
execution capability.

## Default behavior

Without host trust options, Lore can:

- walk and snapshot recognized source files;
- read and ingest valid precomputed SCIP files selected by `scip.indexDir`;
- discover, validate, and use an existing `compile_commands.json` for include
  resolution; and
- perform database-only resolution and validation stages.

Without host trust options, Lore does not:

- start a SCIP indexer or LSP server;
- run CMake, Meson, configure, Bear, or Make;
- honor repository-provided command, argument, or cwd overrides; or
- automatically download or install a SCIP indexer.

Stage enablement is separate from execution permission. For example,
`{"lsp":{"enabled":true}}` requests LSP work, but no server starts unless the
host grants the appropriate capability.

## Host capabilities

| Capability | CLI | `IndexBuilderOptions.execution` |
|------------|-----|---------------------------------|
| Built-in SCIP/LSP processes | `--allow-subprocess-execution` | `allowSubprocessExecution: true` |
| Custom SCIP command/args/cwd | `--allow-custom-indexer-commands` | `allowCustomIndexerCommands: true` |
| Custom LSP command/args/cwd | `--allow-custom-lsp-commands` | `allowCustomLspCommands: true` |
| Compilation-database build | `--allow-build-execution` | `allowBuildExecution: true` |
| SCIP auto-install/download | `--allow-auto-install` | `allowAutoInstall: true` |
| Additional command cwd root | `--allow-command-cwd <dir>` | `allowedCwdRoots: [dir]` |

The broad subprocess option allows only built-in registry entries. It does not
trust custom repository commands, build execution, or auto-installation.
Specific custom/build/install permissions allow the subprocesses required by
that category, without granting unrelated categories.

Repository `scip.allowBuildExecution` and `scip.autoInstall` values are requests:
`false` can suppress an operation the host otherwise permits, but `true` cannot
turn permission on. The same rule applies to custom `scip.indexers` and
`lsp.servers`: they are ignored unless the host explicitly trusts that category.

## Programmatic use

The fourth `IndexBuilder` constructor argument accepts booleans or partial
settings, so callers do not need to construct effective registry objects:

```ts
import { IndexBuilder } from '@jafreck/lore';

const builder = new IndexBuilder('lore.db', { rootDir: checkout }, undefined, {
  scip: { indexDir: '.ci/scip', timeoutMs: 120_000 },
  lsp: false,
});

await builder.build(); // reads precomputed SCIP; starts no process
```

A host that has established trust can opt into narrowly scoped execution:

```ts
const builder = new IndexBuilder('lore.db', { rootDir: checkout }, undefined, {
  scip: true,
  lsp: true,
  execution: {
    allowSubprocessExecution: true,
    allowAutoInstall: false,
    allowBuildExecution: false,
  },
});

await builder.build();
```

The constructor stores values only. It does not read or parse repository config.
Call `await builder.resolveConfiguration()` to validate and inspect the effective
settings without opening the database, or let `build()`, `refresh()`, or
`baselineRebuild()` resolve them on first use.

## Working-directory containment

The indexed root is always an approved command cwd. Relative cwd values resolve
from that root. Absolute paths and `..` traversal are allowed only when the final
real path remains inside an approved root. Symlinks are resolved before the
containment check.

Additional cwd roots are host-only inputs. A repository cannot add one to its
own allowlist. Keep allowlists narrow and avoid approving a mutable parent such
as `/tmp` or a user home directory.

## Explicit installer command

`lore install-scip` is itself an explicit host action and does not consult
`.lore.config`. The `--allow-auto-install` policy controls only installation
triggered as a side effect of indexing.
