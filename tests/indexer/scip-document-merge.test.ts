import { create } from '@bufbuild/protobuf';
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DocumentSchema,
  IndexSchema,
  OccurrenceSchema,
  PositionEncoding,
  SymbolInformationSchema,
  SymbolRole,
  type Document,
  type Index,
} from '../../src/scip/scip_pb.js';
import {
  mergeScipDocuments,
  mergeScipDocumentsDetailed,
} from '../../src/indexer/stages/scip-indexer.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeWorkspace(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-scip-merge-'));
  temporaryDirectories.push(directory);
  return directory;
}

function write(workspace: string, relativePath: string, source = ''): string {
  const absolutePath = path.join(workspace, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, source);
  return absolutePath;
}

function makeDocument(
  relativePath: string,
  symbol: string,
  options: {
    range?: number[];
    encoding?: PositionEncoding;
    text?: string;
    language?: string;
  } = {},
): Document {
  return create(DocumentSchema, {
    relativePath,
    language: options.language ?? 'CPP',
    text: options.text ?? '',
    positionEncoding: options.encoding ?? PositionEncoding.UnspecifiedPositionEncoding,
    occurrences: [create(OccurrenceSchema, {
      range: options.range ?? [0, 0, 1],
      symbol,
      symbolRoles: SymbolRole.Definition,
    })],
    symbols: [create(SymbolInformationSchema, { symbol, displayName: symbol })],
  });
}

function makeIndex(
  documents: Document[],
  projectRoot?: string,
  toolArguments: string[] = [],
): Index {
  return create(IndexSchema, {
    metadata: projectRoot
      ? {
          projectRoot: pathToFileURL(projectRoot).href,
          toolInfo: { name: 'scip-clang', version: 'test', arguments: toolArguments },
        }
      : undefined,
    documents,
  });
}

describe('mergeScipDocuments', () => {
  it('resolves each index against its own metadata projectRoot in a monorepo', () => {
    const workspace = makeWorkspace();
    const projectA = path.join(workspace, 'packages/a');
    const projectB = path.join(workspace, 'packages/b');
    write(projectA, 'src/shared.h');
    write(projectB, 'src/shared.h');

    const documents = mergeScipDocuments([
      makeIndex([makeDocument('src/shared.h', 'a')], projectA),
      makeIndex([makeDocument('src/shared.h', 'b')], projectB),
    ], workspace);

    expect(documents.map(document => document.relativePath).sort()).toEqual([
      'packages/a/src/shared.h',
      'packages/b/src/shared.h',
    ]);
  });

  it('keeps distinct relocated project roots for virtual documents', () => {
    const workspace = makeWorkspace();
    const documents = mergeScipDocuments([
      makeIndex([makeDocument('src/shared.h', 'a', { text: 'int a;' })], '/old/project-a'),
      makeIndex([makeDocument('src/shared.h', 'b', { text: 'int b;' })], '/old/project-b'),
    ], workspace);

    expect(documents.map(document => document.relativePath).sort()).toEqual([
      'project-a/src/shared.h',
      'project-b/src/shared.h',
    ]);
  });

  it('merges different index paths that canonicalize to the same file', () => {
    const workspace = makeWorkspace();
    const project = path.join(workspace, 'packages/a');
    write(project, 'src/shared.h');

    const documents = mergeScipDocuments([
      makeIndex([makeDocument('src/shared.h', 'alpha')], project),
      makeIndex([makeDocument('packages/a/src/shared.h', 'beta')], workspace),
    ], workspace);

    expect(documents).toHaveLength(1);
    expect(documents[0]!.relativePath).toBe('packages/a/src/shared.h');
    expect(documents[0]!.symbols.map(symbol => symbol.symbol).sort()).toEqual(['alpha', 'beta']);
  });

  it('retains metadata-less fixture compatibility and avoids merge allocations on unique paths', () => {
    const workspace = makeWorkspace();
    write(workspace, 'src/a.c');
    write(workspace, 'src/b.c');
    const first = makeDocument('src/a.c', 'a');
    const second = makeDocument('src/b.c', 'b');

    const result = mergeScipDocumentsDetailed([
      makeIndex([first, second]),
    ], workspace);

    expect(result.stats).toMatchObject({ fastPath: true, semantics: 'none', duplicateDocuments: 0 });
    expect(result.documents[0]).toBe(first);
    expect(result.documents[1]).toBe(second);
  });

  it('keeps a large unique document set on the allocation-light fast path', () => {
    const workspace = makeWorkspace();
    const documentCount = 5_000;
    const documents = Array.from({ length: documentCount }, (_, index) =>
      makeDocument(`generated/unit-${index}.c`, `symbol-${index}`));

    const result = mergeScipDocumentsDetailed([makeIndex(documents, workspace)], workspace);

    expect(result.stats).toMatchObject({
      inputDocuments: documentCount,
      uniqueDocuments: documentCount,
      duplicateDocuments: 0,
      fastPath: true,
      provenance: [],
    });
    for (let index = 0; index < documentCount; index += 499) {
      expect(result.documents[index]).toBe(documents[index]);
      expect(result.documents[index]!.occurrences).toBe(documents[index]!.occurrences);
      expect(result.documents[index]!.symbols).toBe(documents[index]!.symbols);
    }
  });

  it('normalizes mixed UTF-8 and UTF-32 duplicate ranges before deduplication', () => {
    const workspace = makeWorkspace();
    const source = 'é🚀 value\n';
    write(workspace, 'src/value.h', source);
    const utf8 = makeDocument('src/value.h', 'value', {
      range: [0, 7, 12],
      encoding: PositionEncoding.UTF8CodeUnitOffsetFromLineStart,
      text: source,
    });
    const utf32 = makeDocument('src/value.h', 'value', {
      range: [0, 3, 8],
      encoding: PositionEncoding.UTF32CodeUnitOffsetFromLineStart,
      text: source,
    });

    const result = mergeScipDocumentsDetailed([makeIndex([utf8, utf32])], workspace);

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.positionEncoding)
      .toBe(PositionEncoding.UTF16CodeUnitOffsetFromLineStart);
    expect(result.documents[0]!.occurrences).toHaveLength(1);
    expect(result.documents[0]!.occurrences[0]!.range).toEqual([0, 4, 9]);
  });

  it('produces deterministic unions and exposes index/configuration provenance', () => {
    const workspace = makeWorkspace();
    write(workspace, 'src/configured.c');
    const alpha = makeIndex(
      [makeDocument('src/configured.c', 'alpha')],
      workspace,
      ['--compdb=debug/compile_commands.json'],
    );
    const beta = makeIndex(
      [makeDocument('src/configured.c', 'beta')],
      workspace,
      ['--compdb=release/compile_commands.json'],
    );

    const forward = mergeScipDocumentsDetailed([alpha, beta], workspace);
    const reverse = mergeScipDocumentsDetailed([beta, alpha], workspace);

    expect(forward.documents[0]!.symbols.map(symbol => symbol.symbol))
      .toEqual(reverse.documents[0]!.symbols.map(symbol => symbol.symbol));
    expect(forward.stats).toMatchObject({
      semantics: 'deterministic-union',
      duplicateDocuments: 1,
      mergedFiles: 1,
    });
    expect(forward.stats.provenance[0]!.origins.map(origin => origin.toolArguments[0]).sort())
      .toEqual([
        '--compdb=debug/compile_commands.json',
        '--compdb=release/compile_commands.json',
      ]);
  });
});
