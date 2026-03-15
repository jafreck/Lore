#!/usr/bin/env node

import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RepoManager } from '../../dist/benchmark/repo-manager.js';
import { indexRepo } from '../../dist/benchmark/indexer.js';
import { PILOT_REPOS } from '../../dist/benchmark/repos.js';
import { openReadOnly } from '../../dist/db/read-only.js';

const ROOT = process.cwd();
const WORK_DIR = join(ROOT, '.benchmark');

const REPO_SPECS = new Map(PILOT_REPOS.map((spec) => [spec.name, spec]));

const TOOL_MODULES = new Map([
  ['lookup', '../../dist/server/tools/lookup.js'],
  ['search', '../../dist/server/tools/search.js'],
  ['graph', '../../dist/server/tools/graph.js'],
  ['docs', '../../dist/server/tools/docs.js'],
  ['test-map', '../../dist/server/tools/test-map.js'],
  ['snippet', '../../dist/server/tools/snippet.js'],
  ['blame', '../../dist/server/tools/blame.js'],
  ['metrics', '../../dist/server/tools/metrics.js'],
  ['history', '../../dist/server/tools/history.js'],
  ['dependents', '../../dist/server/tools/dependents.js'],
  ['trace', '../../dist/server/tools/trace.js'],
  ['structure', '../../dist/server/tools/structure.js'],
  ['cohesion', '../../dist/server/tools/cohesion.js'],
  ['diff', '../../dist/server/tools/diff.js'],
]);

function usage() {
  console.error([
    'Usage:',
    '  node scripts/benchmark/lore-benchmark.mjs prepare [repo ...]',
    '  node scripts/benchmark/lore-benchmark.mjs status [repo ...]',
    '  node scripts/benchmark/lore-benchmark.mjs query <repo> <tool> <json-args>',
  ].join('\n'));
}

function resolveRepos(repoNames) {
  if (!repoNames.length) {
    return [...REPO_SPECS.values()];
  }

  return repoNames.map((name) => {
    const spec = REPO_SPECS.get(name);
    if (!spec) {
      throw new Error(`Unknown repo: ${name}`);
    }
    return spec;
  });
}

async function prepareRepos(repoNames) {
  mkdirSync(WORK_DIR, { recursive: true });
  const manager = new RepoManager(WORK_DIR);
  const specs = resolveRepos(repoNames);

  for (const spec of specs) {
    const instance = await manager.prepare(spec);
    const indexed = await indexRepo(instance, {
      mode: 'scip',
      historyDepth: 200,
    });
    console.log(JSON.stringify({
      name: spec.name,
      sha: spec.sha,
      localPath: indexed.localPath,
      dbPath: indexed.dbPath,
      indexed: indexed.indexed,
      indexMode: indexed.indexMode,
      indexTimeMs: indexed.indexTimeMs,
    }));
  }
}

function statusRepos(repoNames) {
  const specs = resolveRepos(repoNames);
  for (const spec of specs) {
    const localPath = join(WORK_DIR, spec.name);
    const dbPath = join(localPath, '.lore.db');
    console.log(JSON.stringify({
      name: spec.name,
      sha: spec.sha,
      localPath,
      exists: existsSync(localPath),
      dbPath,
      indexed: existsSync(dbPath),
    }));
  }
}

async function runQuery(repoName, toolName, jsonArgs) {
  const spec = REPO_SPECS.get(repoName);
  if (!spec) {
    throw new Error(`Unknown repo: ${repoName}`);
  }

  const modulePath = TOOL_MODULES.get(toolName);
  if (!modulePath) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const repoPath = join(WORK_DIR, repoName);
  const dbPath = join(repoPath, '.lore.db');
  if (!existsSync(dbPath)) {
    throw new Error(`Lore DB not found for ${repoName}: ${dbPath}`);
  }

  const db = openReadOnly(dbPath);
  try {
    const mod = await import(modulePath);
    const args = JSON.parse(jsonArgs);
    const result = await mod.handler(db, args);
    if (typeof result === 'string') {
      console.log(result);
      return;
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

const [, , command, ...args] = process.argv;

try {
  switch (command) {
    case 'prepare':
      await prepareRepos(args);
      break;
    case 'status':
      statusRepos(args);
      break;
    case 'query': {
      if (args.length < 3) {
        usage();
        process.exitCode = 1;
        break;
      }
      const [repoName, toolName, ...rest] = args;
      await runQuery(repoName, toolName, rest.join(' '));
      break;
    }
    default:
      usage();
      process.exitCode = 1;
      break;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}