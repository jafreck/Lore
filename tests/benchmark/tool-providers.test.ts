/**
 * Unit tests for the benchmark tool providers.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildToolsForArm } from '../../src/benchmark/tool-providers.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bench-test-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.ts'), 'export function main() { console.log("hello"); }\n');
  writeFileSync(join(dir, 'src', 'utils.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  writeFileSync(join(dir, 'README.md'), '# Test Repo\n');
  return dir;
}

// ─── Control arm ──────────────────────────────────────────────────────────────

describe('buildToolsForArm – control', () => {
  it('should provide base tools and stub Lore tools', async () => {
    const repoPath = createTempRepo();
    const tools = await buildToolsForArm('control', repoPath);

    // Base tools
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('grep_search');
    expect(toolNames).toContain('list_directory');
    expect(toolNames).toContain('file_info');

    // Stub Lore tools
    expect(toolNames).toContain('lore_lookup');
    expect(toolNames).toContain('lore_graph');
    expect(toolNames).toContain('lore_search');
    expect(toolNames).toContain('lore_test_map');
    expect(toolNames).toContain('lore_metrics');
    expect(toolNames).toContain('lore_blame');
    expect(toolNames).toContain('lore_coverage');
    expect(toolNames).toContain('lore_history');
    expect(toolNames).toContain('lore_architecture');
    expect(toolNames).toContain('lore_annotations');
  });

  it('stub Lore tools should return "not available"', async () => {
    const repoPath = createTempRepo();
    const tools = await buildToolsForArm('control', repoPath);
    const loreLookup = tools.find((t) => t.name === 'lore_lookup')!;
    const result = await loreLookup.execute({ kind: 'symbol', query: 'test' });
    expect(result).toBe('not available in this configuration');
  });

  it('read_file should read actual files', async () => {
    const repoPath = createTempRepo();
    const tools = await buildToolsForArm('control', repoPath);
    const readFile = tools.find((t) => t.name === 'read_file')!;

    const content = await readFile.execute({ path: 'README.md' });
    expect(content).toContain('# Test Repo');
  });

  it('read_file should prevent path traversal', async () => {
    const repoPath = createTempRepo();
    const tools = await buildToolsForArm('control', repoPath);
    const readFile = tools.find((t) => t.name === 'read_file')!;

    const result = await readFile.execute({ path: '../../../etc/passwd' });
    expect(result).toContain('Error');
  });

  it('list_directory should list directory contents', async () => {
    const repoPath = createTempRepo();
    const tools = await buildToolsForArm('control', repoPath);
    const listDir = tools.find((t) => t.name === 'list_directory')!;

    const result = await listDir.execute({ path: 'src' });
    expect(result).toContain('index.ts');
    expect(result).toContain('utils.ts');
  });

  it('grep_search should find patterns', async () => {
    const repoPath = createTempRepo();
    const tools = await buildToolsForArm('control', repoPath);
    const grep = tools.find((t) => t.name === 'grep_search')!;

    const result = await grep.execute({ pattern: 'function main' });
    expect(result).toContain('index.ts');
  });

  it('file_info should return file metadata', async () => {
    const repoPath = createTempRepo();
    const tools = await buildToolsForArm('control', repoPath);
    const fileInfo = tools.find((t) => t.name === 'file_info')!;

    const result = await fileInfo.execute({ path: 'README.md' });
    const parsed = JSON.parse(result);
    expect(parsed.isFile).toBe(true);
    expect(parsed.size).toBeGreaterThan(0);
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('buildToolsForArm – errors', () => {
  it('should throw for semantic-baseline without dbPath', async () => {
    const repoPath = createTempRepo();
    await expect(
      buildToolsForArm('semantic-baseline', repoPath),
    ).rejects.toThrow('requires a Lore DB');
  });

  it('should throw for lore-enabled without dbPath', async () => {
    const repoPath = createTempRepo();
    await expect(
      buildToolsForArm('lore-enabled', repoPath),
    ).rejects.toThrow('requires a Lore DB');
  });
});
