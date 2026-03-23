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
    name: 'jackson-databind',
    url: 'https://github.com/FasterXML/jackson-databind.git',
    sha: '331c4a8ef8616a9f2581dd990bd6b9e9d8bca68b',
    languages: ['java'],
    size: 'medium',
    structure: 'sdk',
  },
  {
    name: 'fastapi',
    url: 'https://github.com/fastapi/fastapi.git',
    sha: '11614be9021aa4ac078d4d0693a8b5250a1010d8',
    languages: ['python'],
    size: 'medium',
    structure: 'sdk',
  },
  {
    name: 'esbuild',
    url: 'https://github.com/evanw/esbuild.git',
    sha: 'd50e88c00aaa424712eddda2f28aae299db4e0de',
    languages: ['go', 'typescript'],
    size: 'large',
    structure: 'cli',
  },
  {
    name: 'zod',
    url: 'https://github.com/colinhacks/zod.git',
    sha: 'c7805073fef5b6b8857307c3d4b3597a70613bc2',
    languages: ['typescript'],
    size: 'small',
    structure: 'sdk',
  },
  {
    name: 'lore-self',
    url: 'https://github.com/jafreck/Lore.git',
    sha: '660be2bf23889f8191d726c77bc39f5b25313095',
    languages: ['typescript'],
    size: 'medium',
    structure: 'cli',
    coverage: {
      commands: [
        {
          command: 'npm',
          args: ['install', '--legacy-peer-deps'],
          timeoutMs: 900_000,
        },
        {
          command: 'npx',
          args: [
            'vitest',
            'run',
            '--coverage.enabled=true',
            '--coverage.reporter=lcov',
            '--coverage.reporter=json',
            '--coverage.reporter=json-summary',
          ],
          timeoutMs: 900_000,
        },
      ],
      reportPath: 'coverage/lcov.info',
      format: 'lcov',
    },
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
