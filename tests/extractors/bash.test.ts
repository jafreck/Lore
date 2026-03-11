import { describe, test, expect } from 'vitest';
import path from 'node:path';
import { parseAndExtractStrict } from '../helpers/extractorHelper.js';
import { BashExtractor } from '../../src/indexer/extractors/bash.js';

const ext = new BashExtractor();
const fixture = (name: string) => parseAndExtractStrict('bash', path.join(import.meta.dirname, '../fixtures/bash', name), ext);

describe('Bash function extraction', () => {
  const r = fixture('functions.sh');
  test('extracts functions', () => {
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function' }));
    expect(r.symbols).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function' }));
  });
});

describe('Bash source/dot import', () => {
  const r = fixture('imports.sh');
  test('extracts source imports', () => {
    expect(r.imports).toHaveLength(2);
    expect(r.imports).toContainEqual(expect.objectContaining({ source: './utils.sh' }));
    expect(r.imports).toContainEqual(expect.objectContaining({ source: './config.sh' }));
  });
});

describe('Bash call-ref extraction', () => {
  const r = fixture('callref.sh');
  test('extracts call refs with callerSymbol', () => {
    const greetRef = r.callRefs.find(c => c.calleeRaw === 'greet');
    expect(greetRef).toBeDefined();
    expect(greetRef!.callerSymbol).toBe('main');
  });
});

describe('Bash env-ref extraction', () => {
  const r = fixture('envref.sh');
  test('parses file with env variables', () => {
    // Bash extractor env-ref extraction requires $VAR in variable_name context
    expect(r.symbols).toHaveLength(0);
  });
});
