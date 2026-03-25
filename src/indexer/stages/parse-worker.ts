/**
 * @module indexer/stages/parse-worker
 *
 * Worker thread for parallel source file parsing and extraction.
 *
 * Each worker owns its own tree-sitter `ParserPool` and extractor registry.
 * It receives file paths + language + existing hash info, reads the file,
 * hashes it, skips unchanged files, and runs tree-sitter parse + extract.
 * Results are posted back to the main thread as plain JSON for DB insertion.
 */

import { parentPort } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { ParserPool } from '../../parsing/parser.js';
import type { ExtractionResult } from '../../parsing/extractors/types.js';
import { CExtractor } from '../../parsing/extractors/c.js';
import { RustExtractor } from '../../parsing/extractors/rust.js';
import { PythonExtractor } from '../../parsing/extractors/python.js';
import { CppExtractor } from '../../parsing/extractors/cpp.js';
import { TypeScriptExtractor } from '../../parsing/extractors/typescript.js';
import { JavaScriptExtractor } from '../../parsing/extractors/javascript.js';
import { GoExtractor } from '../../parsing/extractors/go.js';
import { JavaExtractor } from '../../parsing/extractors/java.js';
import { CSharpExtractor } from '../../parsing/extractors/csharp.js';
import { RubyExtractor } from '../../parsing/extractors/ruby.js';
import { PhpExtractor } from '../../parsing/extractors/php.js';
import { SwiftExtractor } from '../../parsing/extractors/swift.js';
import { KotlinExtractor } from '../../parsing/extractors/kotlin.js';
import { ScalaExtractor } from '../../parsing/extractors/scala.js';
import { LuaExtractor } from '../../parsing/extractors/lua.js';
import { BashExtractor } from '../../parsing/extractors/bash.js';
import { ElixirExtractor } from '../../parsing/extractors/elixir.js';
import { ZigExtractor } from '../../parsing/extractors/zig.js';
import { OcamlExtractor } from '../../parsing/extractors/ocaml.js';
import { HaskellExtractor } from '../../parsing/extractors/haskell.js';
import { JuliaExtractor } from '../../parsing/extractors/julia.js';
import { ElmExtractor } from '../../parsing/extractors/elm.js';
import { ObjcExtractor } from '../../parsing/extractors/objc.js';
import type { SymbolExtractor } from '../../parsing/extractors/types.js';

// ─── Types shared between main thread and worker ──────────────────────────────

/** Files larger than this threshold are not transferred back to the main thread to avoid clone overhead. */
const SOURCE_SIZE_THRESHOLD = 1 * 1024 * 1024; // 1 MB

export interface ParseTask {
  filePath: string;
  language: string;
  existingHash: string | null;
  existingSizeBytes: number;
}

export interface ParseResultSkipped {
  kind: 'skipped';
  filePath: string;
}

export interface ParseResultError {
  kind: 'error';
  filePath: string;
}

export interface ParseResultSuccess {
  kind: 'success';
  filePath: string;
  language: string;
  /** Raw source text. Omitted for files larger than SOURCE_SIZE_THRESHOLD to reduce clone overhead. */
  source?: string;
  hash: string;
  sizeBytes: number;
  result: ExtractionResult;
  rootEndRow: number;
}

export type ParseResult = ParseResultSkipped | ParseResultError | ParseResultSuccess;

export interface WorkerBatchMessage {
  type: 'batch';
  tasks: ParseTask[];
}

export interface WorkerDoneMessage {
  type: 'done';
}

export type WorkerMessage = WorkerBatchMessage | WorkerDoneMessage;

// ─── Worker entry point ───────────────────────────────────────────────────────

if (parentPort) {
  const EXTRACTORS: Record<string, SymbolExtractor> = {
    c: new CExtractor(),
    rust: new RustExtractor(),
    python: new PythonExtractor(),
    cpp: new CppExtractor(),
    typescript: new TypeScriptExtractor(),
    javascript: new JavaScriptExtractor(),
    go: new GoExtractor(),
    java: new JavaExtractor(),
    csharp: new CSharpExtractor(),
    ruby: new RubyExtractor(),
    php: new PhpExtractor(),
    swift: new SwiftExtractor(),
    kotlin: new KotlinExtractor(),
    scala: new ScalaExtractor(),
    lua: new LuaExtractor(),
    bash: new BashExtractor(),
    elixir: new ElixirExtractor(),
    zig: new ZigExtractor(),
    ocaml: new OcamlExtractor(),
    haskell: new HaskellExtractor(),
    julia: new JuliaExtractor(),
    elm: new ElmExtractor(),
    objc: new ObjcExtractor(),
  };

  const pool = new ParserPool();
  const port = parentPort;

  port.on('message', (msg: WorkerMessage) => {
    if (msg.type === 'done') {
      process.exit(0);
    }

    const results: ParseResult[] = [];

    for (const task of msg.tasks) {
      // Stat-based fast path: skip unchanged files
      if (task.existingHash !== null) {
        try {
          const stat = fs.statSync(task.filePath);
          if (stat.size === task.existingSizeBytes) {
            let source: string;
            try {
              source = fs.readFileSync(task.filePath, 'utf8');
            } catch {
              results.push({ kind: 'error', filePath: task.filePath });
              continue;
            }
            const hash = crypto.createHash('sha256').update(source).digest('hex');
            if (hash === task.existingHash) {
              results.push({ kind: 'skipped', filePath: task.filePath });
              continue;
            }
            // File changed — parse and extract
            const parseResult = parseAndExtract(pool, EXTRACTORS, task.filePath, task.language, source, hash);
            if (parseResult) {
              results.push(parseResult);
            } else {
              results.push({ kind: 'error', filePath: task.filePath });
            }
            continue;
          }
        } catch {
          // stat failed — fall through to full read
        }
      }

      // No existing hash or size mismatch — read, hash, parse
      let source: string;
      try {
        source = fs.readFileSync(task.filePath, 'utf8');
      } catch {
        results.push({ kind: 'error', filePath: task.filePath });
        continue;
      }
      const hash = crypto.createHash('sha256').update(source).digest('hex');
      if (task.existingHash === hash) {
        results.push({ kind: 'skipped', filePath: task.filePath });
        continue;
      }

      const parseResult = parseAndExtract(pool, EXTRACTORS, task.filePath, task.language, source, hash);
      if (parseResult) {
        results.push(parseResult);
      } else {
        results.push({ kind: 'error', filePath: task.filePath });
      }
    }

    port.postMessage(results);
  });
}

function parseAndExtract(
  pool: ParserPool,
  extractors: Record<string, SymbolExtractor>,
  filePath: string,
  language: string,
  source: string,
  hash: string,
): ParseResultSuccess | null {
  const tree = pool.parse(language, source);
  if (!tree) return null;

  const extractor = extractors[language];
  if (!extractor) return null;

  const result = extractor.extract(tree, source, filePath);
  const sizeBytes = Buffer.byteLength(source, 'utf8');
  return {
    kind: 'success',
    filePath,
    language,
    source: sizeBytes < SOURCE_SIZE_THRESHOLD ? source : undefined,
    hash,
    sizeBytes,
    result,
    rootEndRow: tree.rootNode.endPosition.row,
  };
}
