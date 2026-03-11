/**
 * @module benchmark/repos
 *
 * Pilot repo panel for benchmarking.
 * These are well-known open-source repos pinned to specific SHAs.
 */

import type { RepoSpec } from './types.js';

/**
 * Pilot panel: 6 repos chosen for diversity across language, size, and structure.
 * SHAs are pinned to ensure reproducibility.
 */
export const PILOT_REPOS: RepoSpec[] = [
  {
    name: 'express',
    url: 'https://github.com/expressjs/express.git',
    sha: '4f773774582090cf8be964. pending',
    languages: ['javascript'],
    size: 'medium',
    structure: 'sdk',
  },
  {
    name: 'fastapi',
    url: 'https://github.com/fastapi/fastapi.git',
    sha: 'pending',
    languages: ['python'],
    size: 'medium',
    structure: 'sdk',
  },
  {
    name: 'esbuild',
    url: 'https://github.com/evanw/esbuild.git',
    sha: 'pending',
    languages: ['go', 'typescript'],
    size: 'large',
    structure: 'cli',
  },
  {
    name: 'vscode-json-languageservice',
    url: 'https://github.com/microsoft/vscode-json-languageservice.git',
    sha: 'pending',
    languages: ['typescript'],
    size: 'small',
    structure: 'sdk',
  },
  {
    name: 'lore-self',
    url: 'https://github.com/jafreck/Lore.git',
    sha: 'pending',
    languages: ['typescript'],
    size: 'medium',
    structure: 'cli',
  },
  {
    name: 'postgres',
    url: 'https://github.com/postgres/postgres.git',
    sha: '62d6c7d3df6287f1bd83199c1a746e50d31571a0',
    languages: ['c'],
    size: 'very-large',
    structure: 'service',
  },
];

/**
 * Resolve SHAs for repos that have "pending" SHA values.
 * This is meant to be called once during initial setup to pin the values.
 *
 * For now, the test harness allows using a local checkout path as an
 * alternative to cloning from a URL when the sha is "pending".
 */
export function isPending(spec: RepoSpec): boolean {
  return spec.sha === 'pending' || spec.sha.includes('pending');
}
