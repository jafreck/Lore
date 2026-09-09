import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';

export interface ScipProcessOutput {
  stdout: string;
  stderr: string;
}

export interface CompilerDiagnostic {
  severity: 'fatal error' | 'error' | 'warning' | 'note';
  message: string;
  stream: 'stdout' | 'stderr';
  file?: string;
  line?: number;
  column?: number;
}

export interface CompilerDiagnosticSummary {
  schemaVersion: 1;
  errors: number;
  fatalErrors: number;
  warnings: number;
  notes: number;
  failedTranslationUnits: number;
  skippedTranslationUnits: number;
  samples: CompilerDiagnostic[];
  truncated: boolean;
  stdout: { bytes: number; sha256: string };
  stderr: { bytes: number; sha256: string };
}

export interface CompilerDiagnosticEvidence {
  requested: boolean;
  complete: boolean;
  summary: CompilerDiagnosticSummary;
}

export const MAX_COMPILER_DIAGNOSTIC_SAMPLES = 20;
const MAX_SAMPLE_CHARACTERS = 2_000;

const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const OutputIdentitySchema = z.object({ bytes: CountSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const EvidenceSchema = z.object({
  requested: z.boolean(),
  complete: z.boolean(),
  summary: z.object({
    schemaVersion: z.literal(1),
    errors: CountSchema,
    fatalErrors: CountSchema,
    warnings: CountSchema,
    notes: CountSchema,
    failedTranslationUnits: CountSchema,
    skippedTranslationUnits: CountSchema,
    samples: z.array(z.object({
      severity: z.enum(['fatal error', 'error', 'warning', 'note']),
      message: z.string().max(MAX_SAMPLE_CHARACTERS),
      stream: z.enum(['stdout', 'stderr']),
      file: z.string().optional(),
      line: CountSchema.optional(),
      column: CountSchema.optional(),
    })).max(MAX_COMPILER_DIAGNOSTIC_SAMPLES),
    truncated: z.boolean(),
    stdout: OutputIdentitySchema,
    stderr: OutputIdentitySchema,
  }).refine(summary => summary.errors >= summary.fatalErrors),
});

export function readCompilerDiagnosticEvidence(details: unknown): CompilerDiagnosticEvidence | null {
  const parsed = z.object({ compilerDiagnostics: EvidenceSchema }).safeParse(details);
  return parsed.success ? parsed.data.compilerDiagnostics : null;
}

export function isScipClangCommand(command: string): boolean {
  return /^scip-clang(?:$|[.-])/iu.test(basename(command));
}

export function parseCompilerDiagnostics(output: ScipProcessOutput): CompilerDiagnosticSummary {
  const identity = (text: string): { bytes: number; sha256: string } => ({
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  const summary: CompilerDiagnosticSummary = {
    schemaVersion: 1,
    errors: 0,
    fatalErrors: 0,
    warnings: 0,
    notes: 0,
    failedTranslationUnits: 0,
    skippedTranslationUnits: 0,
    samples: [],
    truncated: false,
    stdout: identity(output.stdout),
    stderr: identity(output.stderr),
  };
  let summarizedErrors = 0;
  let summarizedWarnings = 0;
  for (const stream of ['stdout', 'stderr'] as const) {
    for (const rawLine of stripVTControlCharacters(output[stream]).split(/\r\n|[\r\n]/u)) {
      const line = rawLine.trim();
      if (/^(?:\d+\s*\||\||[\^~])/u.test(line)) continue;
      const failed = /\bnum errored TUs:\s*(\d+)\b/iu.exec(line);
      if (failed) summary.failedTranslationUnits += Number(failed[1]);
      const skipped = /^Skipped:\s*(\d+)\s+compilation database entries\b/iu.exec(line);
      if (skipped) summary.skippedTranslationUnits += Number(skipped[1]);
      if (/^\d+ (?:warnings?|errors?)(?: and \d+ (?:warnings?|errors?))? generated\.$/iu.test(line)) {
        for (const match of line.matchAll(/(\d+) (warnings?|errors?)/giu)) {
          if (match[2]!.toLowerCase().startsWith('error')) summarizedErrors += Number(match[1]);
          else summarizedWarnings += Number(match[1]);
        }
        continue;
      }
      const located = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.+)$/iu.exec(line);
      const plain = located ? null : /^(?:([^\s:]+):\s*)?(fatal error|error|warning|note):\s*(.+)$/iu.exec(line);
      if (!located && !plain) continue;
      const severity = (located?.[4] ?? plain![2]!).toLowerCase() as CompilerDiagnostic['severity'];
      const message = located?.[5] ?? plain![3]!;
      if (severity === 'fatal error') { summary.fatalErrors++; summary.errors++; }
      else if (severity === 'error') summary.errors++;
      else if (severity === 'warning') summary.warnings++;
      else summary.notes++;
      if (summary.samples.length >= MAX_COMPILER_DIAGNOSTIC_SAMPLES) {
        summary.truncated = true;
        continue;
      }
      summary.truncated ||= message.length > MAX_SAMPLE_CHARACTERS;
      summary.samples.push({
        severity,
        message: message.slice(0, MAX_SAMPLE_CHARACTERS),
        stream,
        ...(located && {
          file: located[1]!,
          line: Number(located[2]),
          ...(located[3] && { column: Number(located[3]) }),
        }),
      });
    }
  }
  summary.errors = Math.max(summary.errors, summarizedErrors);
  summary.warnings = Math.max(summary.warnings, summarizedWarnings);
  return summary;
}

export function hasCompilerErrors(summary: CompilerDiagnosticSummary): boolean {
  return summary.errors > 0 || summary.failedTranslationUnits > 0 || summary.skippedTranslationUnits > 0;
}