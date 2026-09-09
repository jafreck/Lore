import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseCliArgs,
  type CliSubcommand,
} from '../src/cli/args.js';
import { buildToolModules } from '../src/server/tool-registry.js';
import {
  CURRENT_LORE_SCHEMA_VERSION,
  LORE_SCHEMA_MIGRATION_VERSIONS,
} from '../src/db/schema.js';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const readmePath = resolve(rootDir, 'README.md');
const architecturePath = resolve(rootDir, 'docs/architecture.md');
const executionTrustPath = resolve(rootDir, 'docs/execution-trust.md');
const readme = readFileSync(readmePath, 'utf8');
const architecture = readFileSync(architecturePath, 'utf8');
const executionTrust = readFileSync(executionTrustPath, 'utf8');

const CLI_COMMANDS: ReadonlyArray<{
  command: CliSubcommand;
  requiredArgs: string[];
}> = [
  { command: 'index', requiredArgs: ['--root', '/repo', '--db', '/tmp/lore.db'] },
  { command: 'refresh', requiredArgs: ['--root', '/repo', '--db', '/tmp/lore.db'] },
  { command: 'mcp', requiredArgs: ['--db', '/tmp/lore.db'] },
  { command: 'doctor', requiredArgs: ['--db', '/tmp/lore.db'] },
  { command: 'validate', requiredArgs: ['--db', '/tmp/lore.db'] },
  { command: 'migrate', requiredArgs: ['--db', '/tmp/lore.db'] },
  { command: 'hooks', requiredArgs: ['--root', '/repo', '--db', '/tmp/lore.db'] },
  { command: 'analyze', requiredArgs: ['--db', '/tmp/lore.db'] },
  { command: 'install-scip', requiredArgs: [] },
];

const IMPORTANT_OPTIONS: ReadonlyArray<{
  command: CliSubcommand;
  option: string;
  value?: string;
}> = [
  { command: 'index', option: '--include', value: 'src/**' },
  { command: 'index', option: '--exclude', value: '**/*.generated.ts' },
  { command: 'index', option: '--language', value: 'typescript' },
  { command: 'index', option: '--embeddings' },
  { command: 'index', option: '--no-embeddings' },
  { command: 'index', option: '--embedding-model', value: 'model' },
  { command: 'index', option: '--history' },
  { command: 'index', option: '--history-depth', value: '100' },
  { command: 'index', option: '--history-all' },
  { command: 'index', option: '--lsp' },
  { command: 'index', option: '--no-lsp' },
  { command: 'index', option: '--scip' },
  { command: 'index', option: '--scip-scope-language', value: 'c' },
  { command: 'index', option: '--scip-scope-include', value: 'lib/**/*.{c,h}' },
  { command: 'index', option: '--scip-scope-exclude', value: '**/generated/**' },
  { command: 'index', option: '--no-scip' },
  { command: 'index', option: '--allow-subprocess-execution' },
  { command: 'index', option: '--allow-build-execution' },
  { command: 'index', option: '--allow-custom-indexer-commands' },
  { command: 'index', option: '--allow-custom-lsp-commands' },
  { command: 'index', option: '--allow-auto-install' },
  { command: 'index', option: '--allow-command-cwd', value: '/trusted/commands' },
  { command: 'index', option: '--allow-external-build-root', value: '/trusted/build' },
  { command: 'index', option: '--validation-profile', value: 'strict' },
  { command: 'index', option: '--required', value: 'src/core/**' },
  { command: 'index', option: '--index-deps' },
  { command: 'index', option: '--max-workers', value: '2' },
  { command: 'refresh', option: '--watch' },
  { command: 'refresh', option: '--poll' },
  { command: 'refresh', option: '--embeddings' },
  { command: 'refresh', option: '--no-embeddings' },
  { command: 'refresh', option: '--embedding-model', value: 'model' },
  { command: 'refresh', option: '--history-depth', value: '100' },
  { command: 'refresh', option: '--history-all' },
  { command: 'refresh', option: '--index-deps' },
  { command: 'hooks', option: '--history' },
  { command: 'hooks', option: '--history-depth', value: '100' },
  { command: 'hooks', option: '--history-all' },
  { command: 'doctor', option: '--json' },
  { command: 'doctor', option: '--min-symbol-coverage', value: '0.9' },
  { command: 'doctor', option: '--max-baseline-age-seconds', value: '60' },
  { command: 'doctor', option: '--max-dirty-files', value: '0' },
  { command: 'analyze', option: '--mode', value: 'summary' },
  { command: 'analyze', option: '--edge-kinds', value: 'both' },
  { command: 'install-scip', option: '--list' },
  { command: 'migrate', option: '--json' },
  { command: 'index', option: '--log-level', value: 'info' },
  { command: 'index', option: '--log-file', value: '/tmp/lore.log' },
];

const MCP_TOOL_NAMES = [
  'lore_lookup',
  'lore_graph',
  'lore_search',
  'lore_snippet',
  'lore_blame',
  'lore_history',
  'lore_trace',
  'lore_diff',
  'lore_cohesion',
  'lore_structure',
  'lore_dependents',
] as const;

describe('documentation contracts', () => {
  it('retains only current public docs and excludes historical audit artifacts', () => {
    expect(readdirSync(resolve(rootDir, 'docs')).sort()).toEqual([
      'architecture.md',
      'execution-trust.md',
    ]);

    for (const historicalPath of [
      'docs/benchmark-results.md',
      'docs/benchmark-results',
      'docs/comparative-analysis.md',
      'docs/complex-codebase-questions.md',
      'docs/correctness-audit.md',
      'docs/correctness-fixes.md',
      'docs/incremental-index-design.md',
      'docs/pipeline-simplification.md',
      'docs/restore-q6.1-complexity-question.md',
      'docs/scip-lsp-architecture.md',
    ]) {
      expect(existsSync(resolve(rootDir, historicalPath)), historicalPath).toBe(false);
    }
  });

  it.each([
    ['README.md', readmePath, readme],
    ['docs/architecture.md', architecturePath, architecture],
    ['docs/execution-trust.md', executionTrustPath, executionTrust],
  ])('keeps every local Markdown link in %s valid', (_name, documentPath, content) => {
    const targets = [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)]
      .map((match) => match[1]!)
      .filter((target) => !target.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/iu.test(target));

    for (const target of targets) {
      const pathOnly = decodeURIComponent(target.split('#', 1)[0]!);
      expect(existsSync(resolve(dirname(documentPath), pathOnly)), target).toBe(true);
    }
  });

  it.each(CLI_COMMANDS)('documents the accepted $command command', ({ command, requiredArgs }) => {
    expect(parseCliArgs([command, ...requiredArgs]).command).toBe(command);
    expect(readme).toContain(`| \`lore ${command}\` |`);
  });

  it.each(IMPORTANT_OPTIONS)(
    'documents the accepted $command $option option',
    ({ command, option, value }) => {
      const argv = value === undefined ? [command, option] : [command, option, value];
      expect(() => parseCliArgs(argv)).not.toThrow();
      expect(readme).toContain(option);
    },
  );

  it('keeps the README and architecture aligned with the production MCP registry', async () => {
    const registered = (await buildToolModules()).map((module) => module.def.name);

    expect(registered).toHaveLength(MCP_TOOL_NAMES.length);
    expect(new Set(registered)).toEqual(new Set(MCP_TOOL_NAMES));
    for (const name of MCP_TOOL_NAMES) {
      expect(readme).toContain(`| \`${name}\` |`);
      expect(architecture).toContain(`| \`${name}\` |`);
    }
    expect(registered).not.toContain('lore_metrics');
  });

  it('documents the current schema markers and complete migration chain', () => {
    expect(CURRENT_LORE_SCHEMA_VERSION).toBe(3);
    expect(LORE_SCHEMA_MIGRATION_VERSIONS).toEqual([1, 2, 3]);
    for (const content of [readme, architecture]) {
      expect(content).toContain('schema v3');
      expect(content).toContain('`lore_meta.schema_version`');
      expect(content).toContain('`user_version`');
      expect(content).toContain('[1, 2, 3]');
      expect(content).toMatch(/both[\s\S]{0,60}present[\s\S]{0,30}agree/iu);
    }
  });

  it('keeps key MCP input and limitation docs aligned with tool definitions', async () => {
    const modules = await buildToolModules();
    const definitions = new Map(modules.map((module) => [module.def.name, module.def]));
    const snippet = definitions.get('lore_snippet')!;
    const lookup = definitions.get('lore_lookup')!;
    const dependents = definitions.get('lore_dependents')!;
    const diff = definitions.get('lore_diff')!;

    expect(snippet.inputSchema.required).toEqual(['path']);
    expect(Object.keys(lookup.inputSchema.properties)).toEqual(expect.arrayContaining([
      'mode', 'symbol_kind', 'path_prefix', 'language',
    ]));
    expect(dependents.description).toMatch(/type references are direct/iu);
    expect(diff.description).toContain('is_exported = 1');
    expect(readme).toMatch(/required indexed path/iu);
    expect(readme).toMatch(/direct type references/iu);
    expect(readme).toMatch(/do not currently populate that flag/iu);
    expect(executionTrust).toMatch(/not a universal Git, network, or\s+filesystem-read sandbox/iu);
  });
});
