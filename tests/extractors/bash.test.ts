import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { BashExtractor } from '../../src/indexer/extractors/bash.js';

const fixtureDir = path.join(import.meta.dirname, '../fixtures');
const result = parseAndExtractStrict('bash', path.join(fixtureDir, 'bash/sample.sh'), new BashExtractor());

describe('Bash symbols', () => {
  test('extracts functions', () => {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'clamp', kind: 'function' }));
    expect(result.symbols).toContainEqual(expect.objectContaining({ name: 'main', kind: 'function' }));
  });
});

describe('Bash imports', () => {
  test('extracts source/dot imports', () => {
    expect(result.imports.length).toBeGreaterThan(0);
  });
});

describe('Bash call refs', () => {
  test('produces non-empty call refs', () => {
    expect(result.callRefs.length).toBeGreaterThan(0);
  });
});
