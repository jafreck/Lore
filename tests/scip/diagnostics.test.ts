import { describe, expect, it } from 'vitest';
import { hasCompilerErrors, MAX_COMPILER_DIAGNOSTIC_SAMPLES, parseCompilerDiagnostics } from '../../src/scip/diagnostics.js';

describe('compiler diagnostics', () => {
  it('detects fatal compiler errors even when scip-clang reports zero errored TUs', () => {
    const summary = parseCompilerDiagnostics({
      stdout: 'Finished indexing 118 translation units in 1.4s (num errored TUs: 0).\n',
      stderr: "/repo/lib/header.h:41:10: fatal error: 'string.h' file not found\n1 error generated.\n",
    });
    expect(hasCompilerErrors(summary)).toBe(true);
    expect(summary).toMatchObject({ errors: 1, fatalErrors: 1, failedTranslationUnits: 0 });
    expect(summary.samples).toEqual([{
      severity: 'fatal error', message: "'string.h' file not found", stream: 'stderr',
      file: '/repo/lib/header.h', line: 41, column: 10,
    }]);
  });

  it('handles colored diagnostics, stdout, driver errors, and paths containing spaces or drive letters', () => {
    const summary = parseCompilerDiagnostics({
      stdout: '\u001b[31mC:\\source files\\main.c:12:3: error: unknown type name\u001b[0m\n',
      stderr: 'clang: error: unsupported argument\nerror: failed analysis\n',
    });
    expect(summary.errors).toBe(3);
    expect(summary.samples[0]).toMatchObject({ file: 'C:\\source files\\main.c', line: 12, column: 3 });
  });

  it('records warnings and notes without treating them as errors', () => {
    const summary = parseCompilerDiagnostics({
      stdout: '', stderr: 'main.c:2: warning: unused variable\nmain.c:1:1: note: declared here\n1 warning generated.\n',
    });
    expect(hasCompilerErrors(summary)).toBe(false);
    expect(summary).toMatchObject({ errors: 0, warnings: 1, notes: 1 });
  });

  it('recognizes summary-only failures and skipped compilation entries', () => {
    expect(parseCompilerDiagnostics({ stdout: '', stderr: '2 warnings and 3 errors generated.\n' }))
      .toMatchObject({ errors: 3, warnings: 2 });
    expect(hasCompilerErrors(parseCompilerDiagnostics({ stdout: 'Finished indexing (num errored TUs: 2).', stderr: '' })))
      .toBe(true);
    expect(hasCompilerErrors(parseCompilerDiagnostics({ stdout: 'Skipped: 1 compilation database entries (not found on disk: 1).', stderr: '' })))
      .toBe(true);
  });

  it('ignores diagnostic words in source excerpts and successful summaries', () => {
    const summary = parseCompilerDiagnostics({
      stdout: 'Finished indexing 10 translation units (num errored TUs: 0).\n0 errors generated.\n',
      stderr: '10 | label: error: source excerpt\n | error: source excerpt\nThis output mentions error: without a diagnostic.\n',
    });
    expect(hasCompilerErrors(summary)).toBe(false);
    expect(summary.samples).toEqual([]);
  });

  it('counts all errors while bounding persisted samples and preserving output identities', () => {
    const output = { stdout: '', stderr: Array.from({ length: 100 }, () => `main.c:1:1: error: ${'x'.repeat(3000)}\n`).join('') };
    const summary = parseCompilerDiagnostics(output);
    expect(summary.errors).toBe(100);
    expect(summary.samples).toHaveLength(MAX_COMPILER_DIAGNOSTIC_SAMPLES);
    expect(summary.samples.every(sample => sample.message.length <= 2000)).toBe(true);
    expect(summary.truncated).toBe(true);
    expect(summary.stderr.bytes).toBe(Buffer.byteLength(output.stderr));
    expect(summary.stderr.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(parseCompilerDiagnostics(output)).toEqual(summary);
  });
});