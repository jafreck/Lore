import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESPONSE_FILE_LIMITS,
  MAX_RESPONSE_FILE_BYTES,
  compilationIncludePathsForFile,
  detectBuildSystem,
  discoverCompilationDatabase,
  ensureCompilationDatabase,
  findExistingCompdb,
  generateCompdb,
  inferCompilationLanguage,
  loadCompilationDatabase,
  tokenizeCompilerCommand,
  validateCompilationDatabase,
  type CompdbIO,
} from '../../src/scip/compdb.js';

function compilationEntry(rootDir = '/project'): string {
  return JSON.stringify([{
    directory: rootDir,
    file: `${rootDir}/src/main.c`,
    arguments: ['clang', '-c', `${rootDir}/src/main.c`],
  }]);
}

function mockIO(
  contents: Map<string, string> = new Map(),
  existingPaths: Set<string> = new Set(),
): CompdbIO {
  return {
    existsSync: filePath => contents.has(filePath) || existingPaths.has(filePath),
    readFileSync: filePath => {
      const content = contents.get(filePath);
      if (content === undefined) throw new Error(`ENOENT: ${filePath}`);
      return content;
    },
    mkdirSync: () => {},
    execFileAsync: async () => ({ stdout: '', stderr: '' }),
  };
}

function validCandidate(candidate: string): CompdbIO {
  return mockIO(
    new Map([[candidate, compilationEntry()]]),
    new Set(['/project', '/project/src/main.c']),
  );
}

describe('compilation database discovery', () => {
  it.each([
    ['/project/compile_commands.json'],
    ['/project/build/compile_commands.json'],
    ['/project/builddir/compile_commands.json'],
    ['/project/.lore-compdb/compile_commands.json'],
  ])('finds and validates %s', candidate => {
    expect(findExistingCompdb('/project', validCandidate(candidate))).toBe(candidate);
  });

  it('returns null when no compilation database exists', () => {
    expect(findExistingCompdb('/project', mockIO())).toBeNull();
  });

  it('does not accept a candidate when a JavaScript caller omits readFileSync', () => {
    const incompleteIo = {
      existsSync: (filePath: string) => filePath === '/project/compile_commands.json',
    } as any;
    expect(findExistingCompdb('/project', incompleteIo)).toBeNull();
  });

  it('skips a malformed candidate and selects the next valid candidate', () => {
    const contents = new Map([
      ['/project/compile_commands.json', '{bad'],
      ['/project/build/compile_commands.json', compilationEntry()],
    ]);
    const result = discoverCompilationDatabase(
      '/project',
      mockIO(contents, new Set(['/project', '/project/src/main.c'])),
    );

    expect(result.database?.path).toBe('/project/build/compile_commands.json');
    expect(result.candidates.map(candidate => candidate.validation.status)).toEqual([
      'malformed',
      'valid',
    ]);
  });

  it('prefers a fully valid candidate over an earlier partial candidate', () => {
    const contents = new Map([
      ['/project/compile_commands.json', JSON.stringify([{
        directory: '/project',
        file: '/project/generated/missing.c',
        arguments: ['clang', '-c', 'generated/missing.c'],
      }])],
      ['/project/build/compile_commands.json', compilationEntry()],
    ]);
    const result = discoverCompilationDatabase(
      '/project',
      mockIO(contents, new Set(['/project', '/project/src/main.c'])),
    );

    expect(result.candidates[0]?.validation.status).toBe('stale');
    expect(result.database?.path).toBe('/project/build/compile_commands.json');
  });

  it('keeps a zero-viability database for diagnostics but never selects it for scip-clang', () => {
    const candidate = '/project/compile_commands.json';
    const io = mockIO(new Map([[candidate, JSON.stringify([{
      directory: '/project/old-build',
      file: '/project/old-src/main.c',
      arguments: ['clang', '-I/project/old-include', '-c', '/project/old-src/main.c'],
    }])]]));

    const discovered = discoverCompilationDatabase('/project', io);
    expect(discovered.database).toMatchObject({ path: candidate });
    expect(discovered.database?.includePaths.byFile.get('/project/old-src/main.c'))
      .toEqual(['/project/old-include']);
    expect(discovered.database?.validation).toMatchObject({
      valid: false,
      status: 'stale',
      viableEntries: 0,
    });
    expect(discovered.database?.validation.reason).toContain('cannot be passed to scip-clang');
    expect(findExistingCompdb('/project', io)).toBeNull();
  });

  it('prefers a later viable partial candidate over an earlier stale candidate', () => {
    const stale = '/project/compile_commands.json';
    const partial = '/project/build/compile_commands.json';
    const contents = new Map([
      [stale, JSON.stringify([{
        directory: '/project/missing-build',
        file: '/project/missing/a.c',
        arguments: ['clang', '-c', '/project/missing/a.c'],
      }])],
      [partial, JSON.stringify([
        {
          directory: '/project',
          file: '/project/src/main.c',
          arguments: ['clang', '-c', '/project/src/main.c'],
        },
        {
          directory: '/project',
          file: '/project/generated/missing.c',
          arguments: ['clang', '-c', '/project/generated/missing.c'],
        },
      ])],
    ]);
    const io = mockIO(contents, new Set(['/project', '/project/src/main.c']));

    const result = discoverCompilationDatabase('/project', io);
    expect(result.database?.path).toBe(partial);
    expect(result.database?.validation).toMatchObject({
      valid: true,
      status: 'partial',
      viableEntries: 1,
    });
    expect(findExistingCompdb('/project', io)).toBe(partial);
  });
});

describe('compilation database validation', () => {
  it('accepts entries whose source files and working directories exist', () => {
    const result = validateCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => filePath === '/project/build' || filePath === '/project/src/main.c',
      readFileSync: () => JSON.stringify([{
        directory: '/project/build',
        file: '/project/src/main.c',
        command: 'clang -c /project/src/main.c',
      }]),
    }, '/project');

    expect(result).toMatchObject({
      valid: true,
      status: 'valid',
      totalEntries: 1,
      wellFormedEntries: 1,
      existingFiles: 1,
      existingDirectories: 1,
    });
  });

  it('distinguishes malformed JSON, non-array roots, and empty databases', () => {
    const io = (text: string) => ({ existsSync: () => false, readFileSync: () => text });
    expect(validateCompilationDatabase('/project/compile_commands.json', io('{bad')).status).toBe('malformed');
    expect(validateCompilationDatabase('/project/compile_commands.json', io('{}')).status).toBe('malformed');
    expect(validateCompilationDatabase('/project/compile_commands.json', io('[]')).status).toBe('empty');
  });

  it('rejects a wholly relocated database with useful counts', () => {
    const result = validateCompilationDatabase('/new/project/compile_commands.json', {
      existsSync: () => false,
      readFileSync: () => JSON.stringify([{
        directory: '/old/project/build',
        file: '/old/project/src/main.c',
        command: 'clang -c /old/project/src/main.c',
      }]),
    }, '/new/project');

    expect(result).toMatchObject({
      valid: false,
      status: 'relocated',
      wellFormedEntries: 1,
      existingFiles: 0,
      missingFiles: 1,
      existingDirectories: 0,
      missingDirectories: 1,
      entriesWithinRoot: 0,
    });
    expect(result.reason).toContain('wholly relocated');
  });

  it('accepts generated-source-heavy databases as partial instead of using a ratio threshold', () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      directory: '/project/build',
      file: `/project/build/generated-${index}.c`,
      arguments: ['clang', '-c', `generated-${index}.c`],
    }));
    const result = validateCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => filePath === '/project/build' || filePath === '/project/build/generated-0.c',
      readFileSync: () => JSON.stringify(entries),
    }, '/project');

    expect(result).toMatchObject({
      valid: true,
      status: 'partial',
      wellFormedEntries: 10,
      existingFiles: 1,
      missingFiles: 9,
      existingDirectories: 10,
    });
    expect(result.warnings.join(' ')).toContain('may be generated');
  });

  it('retains missing generated sources as diagnostic-only when no live pair exists', () => {
    const result = validateCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => filePath === '/tmp/project-build',
      readFileSync: () => JSON.stringify([{
        directory: '/tmp/project-build',
        file: '/tmp/project-build/generated.c',
        arguments: ['clang', '-c', 'generated.c'],
      }]),
    }, '/project', { approvedExternalRoots: ['/tmp/project-build'] });

    expect(result).toMatchObject({
      valid: false,
      status: 'stale',
      existingFiles: 0,
      existingDirectories: 1,
      viableEntries: 0,
      entriesWithinRoot: 0,
      entriesWithinApprovedRoots: 1,
    });
  });

  it('rejects a sibling-checkout database even when every referenced path exists', () => {
    const result = validateCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => [
        '/sibling/project/build',
        '/sibling/project/src/main.c',
      ].includes(filePath),
      readFileSync: () => JSON.stringify([{
        directory: '/sibling/project/build',
        file: '/sibling/project/src/main.c',
        arguments: ['clang', '-c', '/sibling/project/src/main.c'],
      }]),
    }, '/project');

    expect(result).toMatchObject({
      valid: false,
      status: 'relocated',
      existingFiles: 1,
      existingDirectories: 1,
      entriesWithinRoot: 0,
      entriesWithinApprovedRoots: 0,
      entriesOutsideApprovedRoots: 1,
    });
    expect(result.reason).toContain('approved roots');
  });

  it('keeps valid entries when malformed entries are mixed in', () => {
    const result = validateCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => filePath === '/project' || filePath === '/project/src/main.c',
      readFileSync: () => JSON.stringify([
        { directory: '/project', file: '/project/src/main.c', arguments: ['clang', '-c', 'src/main.c'] },
        { directory: 42, file: 'broken.c' },
      ]),
    }, '/project');

    expect(result).toMatchObject({
      valid: true,
      status: 'partial',
      totalEntries: 2,
      wellFormedEntries: 1,
      malformedEntries: 1,
    });
  });
});

describe('compiler argument and include-path loading', () => {
  it('records C and C++ translation-unit modes from flags, drivers, and suffixes', () => {
    expect(inferCompilationLanguage('/project/src/main.c', ['clang', '-c', 'main.c']))
      .toBe('c');
    expect(inferCompilationLanguage('/project/src/main.c', ['clang', '-x', 'c++', 'main.c']))
      .toBe('cpp');
    expect(inferCompilationLanguage('/project/src/main.h', ['clang++', '-x', 'c++-header', 'main.h']))
      .toBe('cpp');
    expect(inferCompilationLanguage('/project/src/main.h', ['cl.exe', '/TC', 'main.h']))
      .toBe('c');
    expect(inferCompilationLanguage('/project/src/legacy.C', ['clang', '-c', 'legacy.C']))
      .toBe('cpp');
  });

  it('supports arguments-form GCC, Clang, and MSVC include flags', () => {
    const text = JSON.stringify([{
      directory: '/project/build',
      file: '../src/main.cc',
      arguments: [
        'clang++',
        '-I', '../include one',
        '-I../include-two',
        '-iquote', '../quotes',
        '-iquote../quotes-two',
        '-isystem', '/opt/sdk',
        '-isystem../system-two',
        '/I', '../msvc',
        '/I../msvc-two',
      ],
    }]);
    const loaded = loadCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => filePath === '/project/build' || filePath === '/project/src/main.cc',
      readFileSync: () => text,
    }, '/project').database;

    expect(loaded?.includePaths.byFile.get('/project/src/main.cc')).toEqual([
      '/project/include one',
      '/project/include-two',
      '/project/quotes',
      '/project/quotes-two',
      '/opt/sdk',
      '/project/system-two',
      '/project/msvc',
      '/project/msvc-two',
    ]);
    expect(loaded?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(loaded?.entries[0]?.language).toBe('cpp');
  });

  it('safely tokenizes command-form quoting and concatenated quoted operands', () => {
    expect(tokenizeCompilerCommand('clang -I"../space dir" -DNAME="hello world" "src/main c.c"')).toEqual([
      'clang',
      '-I../space dir',
      '-DNAME=hello world',
      'src/main c.c',
    ]);

    const loaded = loadCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => filePath === '/project/build' || filePath === '/project/src/main.c',
      readFileSync: () => JSON.stringify([{
        directory: '/project/build',
        file: '../src/main.c',
        command: 'clang -I"../space dir" -iquote \'../quoted dir\' /I"../msvc dir" -c ../src/main.c',
      }]),
    }, '/project').database;

    expect(loaded?.entries[0]?.includePaths).toEqual([
      '/project/space dir',
      '/project/quoted dir',
      '/project/msvc dir',
    ]);
  });

  it('expands nested response files with bounded reads', () => {
    const contents = new Map([
      ['/project/compile_commands.json', JSON.stringify([{
        directory: '/project/build',
        file: '../src/main.c',
        arguments: ['clang', '@flags.rsp', '-c', '../src/main.c'],
      }])],
      ['/project/build/flags.rsp', '-I../response-include @nested.rsp'],
      ['/project/build/nested.rsp', '/I"../msvc response" -isystem ../response-system'],
    ]);
    const limits: number[] = [];
    const loaded = loadCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => filePath === '/project/build' || filePath === '/project/src/main.c',
      readFileSync: (filePath, maxBytes) => {
        if (maxBytes !== undefined) limits.push(maxBytes);
        const content = contents.get(filePath);
        if (content === undefined) throw new Error('missing');
        return content;
      },
    }, '/project').database;

    expect(loaded?.entries[0]?.includePaths).toEqual([
      '/project/response-include',
      '/project/msvc response',
      '/project/response-system',
    ]);
    expect(limits.slice(1).every(limit => limit <= MAX_RESPONSE_FILE_BYTES)).toBe(true);
  });

  it('retains every oversized response operand even when injected I/O ignores the requested limit', () => {
    const loaded = loadCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => filePath === '/project' || filePath === '/project/src/main.c',
      readFileSync: filePath => filePath.endsWith('.rsp')
        ? `-I${'x'.repeat(MAX_RESPONSE_FILE_BYTES + 1)}`
        : JSON.stringify([{
            directory: '/project',
            file: '/project/src/main.c',
            arguments: ['clang', '@flags.rsp', '@flags.rsp', '-c', 'src/main.c'],
          }]),
    }, '/project');

    expect(loaded.database?.entries[0]?.includePaths).toEqual([]);
    expect(loaded.validation.status).toBe('partial');
    expect(loaded.validation.warnings.join(' ')).toContain('read limit');
    expect(loaded.database?.entries[0]?.arguments.filter((arg) => arg === '@flags.rsp'))
      .toHaveLength(2);
    expect(loaded.database?.entries[0]?.responseFiles.status).toBe('degraded');
    expect(loaded.validation.responseFileDegradedEntries).toBe(1);
  });

  it('applies response-file count and byte budgets independently per entry', () => {
    const contents = new Map([
      ['/project/compile_commands.json', JSON.stringify([
        {
          directory: '/project',
          file: '/project/src/a.c',
          arguments: ['clang', '@a.rsp', '-c', 'src/a.c'],
        },
        {
          directory: '/project',
          file: '/project/src/b.c',
          arguments: ['clang', '@b.rsp', '-c', 'src/b.c'],
        },
      ])],
      ['/project/a.rsp', '-Iinclude-a'],
      ['/project/b.rsp', '-Iinclude-b'],
    ]);
    const loaded = loadCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => ['/project', '/project/src/a.c', '/project/src/b.c'].includes(filePath),
      readFileSync: filePath => contents.get(filePath)!,
    }, '/project', {
      responseFileLimits: {
        maxFilesPerEntry: 1,
        maxBytesPerFile: 64,
        maxTotalBytesPerEntry: 64,
      },
    });

    expect(loaded.database?.entries.map((entry) => entry.includePaths)).toEqual([
      ['/project/include-a'],
      ['/project/include-b'],
    ]);
    expect(loaded.database?.entries.map((entry) => entry.responseFiles.status))
      .toEqual(['complete', 'complete']);
    expect(loaded.validation.responseFileDegradedEntries).toBe(0);
  });

  it('charges cached response-file replays to per-entry file and byte budgets', () => {
    const response = '-Icached';
    const contents = new Map([
      ['/project/compile_commands.json', JSON.stringify([{
        directory: '/project',
        file: '/project/src/main.c',
        arguments: ['clang', '@flags.rsp', '@flags.rsp', '-c', 'src/main.c'],
      }])],
      ['/project/flags.rsp', response],
    ]);
    let responseReads = 0;
    const loaded = loadCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => filePath === '/project' || filePath === '/project/src/main.c',
      readFileSync: filePath => {
        if (filePath.endsWith('.rsp')) responseReads++;
        return contents.get(filePath)!;
      },
    }, '/project', {
      responseFileLimits: {
        maxFilesPerEntry: 2,
        maxTotalBytesPerEntry: Buffer.byteLength(response) * 2,
      },
    }).database;
    const expansion = loaded?.entries[0]?.responseFiles;

    expect(responseReads).toBe(1);
    expect(expansion).toMatchObject({
      status: 'complete',
      filesRead: 2,
      bytesRead: Buffer.byteLength(response) * 2,
      expandedTokens: 2,
    });
    expect(loaded?.entries[0]?.includePaths).toEqual(['/project/cached']);
  });

  it('retains a response operand when expanded token or byte caps would be exceeded', () => {
    const makeDatabase = (response: string, limits: Record<string, number>) =>
      loadCompilationDatabase('/project/compile_commands.json', {
        existsSync: filePath => filePath === '/project' || filePath === '/project/src/main.c',
        readFileSync: filePath => filePath.endsWith('.rsp')
          ? response
          : JSON.stringify([{
              directory: '/project',
              file: '/project/src/main.c',
              arguments: ['clang', '@flags.rsp', '-c', 'src/main.c'],
            }]),
      }, '/project', { responseFileLimits: limits }).database;

    const tokenCapped = makeDatabase('-Ione -Itwo', { maxExpandedTokensPerEntry: 1 });
    expect(tokenCapped?.entries[0]?.arguments).toContain('@flags.rsp');
    expect(tokenCapped?.entries[0]?.includePaths).toEqual([]);
    expect(tokenCapped?.entries[0]?.responseFiles).toMatchObject({
      status: 'degraded',
      expandedTokens: 0,
      expandedBytes: 0,
    });
    expect(tokenCapped?.entries[0]?.responseFiles.diagnostics.join(' ')).toContain('token limit');

    const byteCapped = makeDatabase('-Ioversized', { maxExpandedBytesPerEntry: 4 });
    expect(byteCapped?.entries[0]?.arguments).toContain('@flags.rsp');
    expect(byteCapped?.entries[0]?.includePaths).toEqual([]);
    expect(byteCapped?.entries[0]?.responseFiles).toMatchObject({
      status: 'degraded',
      expandedTokens: 0,
      expandedBytes: 0,
    });
    expect(byteCapped?.entries[0]?.responseFiles.diagnostics.join(' ')).toContain('expanded-output');
  });

  it('retains a nested response operand when a configurable limit is reached', () => {
    const contents = new Map([
      ['/project/compile_commands.json', JSON.stringify([{
        directory: '/project',
        file: '/project/src/main.c',
        arguments: ['clang', '@outer.rsp', '-c', 'src/main.c'],
      }])],
      ['/project/outer.rsp', '-Ivisible @nested.rsp'],
      ['/project/nested.rsp', '-Ihidden'],
    ]);
    const loaded = loadCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => filePath === '/project' || filePath === '/project/src/main.c',
      readFileSync: filePath => contents.get(filePath)!,
    }, '/project', {
      responseFileLimits: { maxFilesPerEntry: 1 },
    });
    const entry = loaded.database?.entries[0];

    expect(DEFAULT_RESPONSE_FILE_LIMITS.maxTotalBytesPerEntry)
      .toBeGreaterThan(DEFAULT_RESPONSE_FILE_LIMITS.maxBytesPerFile);
    expect(entry?.arguments).toContain('@nested.rsp');
    expect(entry?.includePaths).toEqual(['/project/visible']);
    expect(entry?.responseFiles).toMatchObject({
      status: 'degraded',
      filesRead: 1,
    });
    expect(entry?.responseFiles.diagnostics.join(' ')).toContain('per-entry limit');
    expect(loaded.validation.status).toBe('partial');
    expect(loaded.validation.responseFileDegradedEntries).toBe(1);
    expect(loaded.validation.warnings.join(' ')).toContain('retained @nested.rsp unexpanded');
  });

  it('precomputes nearest include paths for a large compilation database', () => {
    const entryCount = 10_000;
    const entries = Array.from({ length: entryCount }, (_, index) => ({
      directory: `/project/package-${index}/build`,
      file: `/project/package-${index}/src/unit.c`,
      arguments: ['clang', `-I/project/package-${index}/include`, '-c', 'unit.c'],
    }));
    const loaded = loadCompilationDatabase('/project/compile_commands.json', {
      existsSync: filePath => filePath === '/project'
        || filePath.endsWith('/build')
        || filePath.endsWith('/src/unit.c'),
      readFileSync: () => JSON.stringify(entries),
    }, '/project').database;

    expect(loaded?.includePaths.directoryIndex?.candidateCount).toBe(entryCount);
    for (let index = 0; index < entryCount; index += 997) {
      expect(compilationIncludePathsForFile(
        loaded!.includePaths,
        `/project/package-${index}/include/public.h`,
      )).toEqual([`/project/package-${index}/include`]);
    }
    expect(compilationIncludePathsForFile(
      loaded!.includePaths,
      '/project/unrelated/public.h',
    )).toBeNull();
  });
});

describe('build-system detection', () => {
  it('detects CMake, Meson, Makefile/configure, and none in priority order', () => {
    expect(detectBuildSystem('/project', { existsSync: path => path.endsWith('CMakeLists.txt') })).toBe('cmake');
    expect(detectBuildSystem('/project', { existsSync: path => path.endsWith('meson.build') })).toBe('meson');
    expect(detectBuildSystem('/project', { existsSync: path => path.endsWith('Makefile') })).toBe('make');
    expect(detectBuildSystem('/project', { existsSync: path => path.endsWith('/configure') })).toBe('make');
    expect(detectBuildSystem('/project', { existsSync: () => false })).toBe('none');
    expect(detectBuildSystem('/project', { existsSync: () => true })).toBe('cmake');
  });
});

describe('build execution policy', () => {
  it('uses an existing valid database without build permission', async () => {
    let executions = 0;
    const io = validCandidate('/project/compile_commands.json');
    io.execFileAsync = async () => {
      executions++;
      return { stdout: '', stderr: '' };
    };

    const result = await ensureCompilationDatabase('/project', 300_000, io);
    expect(result).toMatchObject({
      path: '/project/compile_commands.json',
      preExisting: true,
      generationAttempted: false,
    });
    expect(executions).toBe(0);
  });

  it('does not run cmake by default when no database exists', async () => {
    let executions = 0;
    const io = mockIO(new Map(), new Set(['/project/CMakeLists.txt']));
    io.execFileAsync = async () => {
      executions++;
      return { stdout: '', stderr: '' };
    };

    const result = await ensureCompilationDatabase('/project', 300_000, io);
    expect(result).toMatchObject({
      path: null,
      buildSystem: 'cmake',
      generationAttempted: false,
    });
    expect(executions).toBe(0);
  });

  it('generates and validates a database only after explicit opt-in', async () => {
    const generatedPath = '/project/.lore-compdb/compile_commands.json';
    const contents = new Map<string, string>();
    const existing = new Set(['/project/CMakeLists.txt', '/project', '/project/src/main.c']);
    const io = mockIO(contents, existing);
    io.execFileAsync = async command => {
      expect(command).toBe('cmake');
      contents.set(generatedPath, compilationEntry());
      return { stdout: '', stderr: '' };
    };

    const result = await ensureCompilationDatabase('/project', 300_000, io, {
      allowBuildExecution: true,
    });
    expect(result).toMatchObject({
      path: generatedPath,
      preExisting: false,
      generationAttempted: true,
    });
    expect(result.database?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('regenerates a completely stale existing database when build execution is allowed', async () => {
    const stalePath = '/project/compile_commands.json';
    const generatedPath = '/project/.lore-compdb/compile_commands.json';
    const contents = new Map<string, string>([[stalePath, JSON.stringify([{
      directory: '/project/missing-build',
      file: '/project/missing-src/main.c',
      arguments: ['clang', '-c', '/project/missing-src/main.c'],
    }])]]);
    const existing = new Set(['/project/CMakeLists.txt', '/project', '/project/src/main.c']);
    const io = mockIO(contents, existing);
    io.execFileAsync = async () => {
      contents.set(generatedPath, compilationEntry());
      return { stdout: '', stderr: '' };
    };

    const result = await ensureCompilationDatabase('/project', 12_345, io, {
      allowBuildExecution: true,
    });
    expect(result).toMatchObject({
      path: generatedPath,
      preExisting: false,
      generationAttempted: true,
    });
    expect(result.candidateDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ validation: expect.objectContaining({ status: 'stale' }) }),
      expect.objectContaining({ validation: expect.objectContaining({ status: 'valid' }) }),
    ]));
  });

  it('returns a clear diagnostic-only result for stale data when regeneration is forbidden', async () => {
    const candidate = '/project/compile_commands.json';
    const contents = new Map([[candidate, JSON.stringify([{
      directory: '/project/missing-build',
      file: '/project/missing-src/main.c',
      arguments: ['clang', '-c', '/project/missing-src/main.c'],
    }])]]);
    const result = await ensureCompilationDatabase(
      '/project',
      30_000,
      mockIO(contents, new Set(['/project/CMakeLists.txt'])),
    );
    expect(result.path).toBeNull();
    expect(result.generationAttempted).toBe(false);
    expect(result.database?.validation).toMatchObject({ status: 'stale', viableEntries: 0 });
    expect(result.database?.validation.reason).toContain('zero viable');
  });

  it('returns the build-tool error when allowed regeneration fails', async () => {
    const io = mockIO(new Map(), new Set(['/project/CMakeLists.txt']));
    io.execFileAsync = async () => {
      throw Object.assign(new Error('cmake configuration failed'), { stderr: 'bad cache path' });
    };

    const result = await ensureCompilationDatabase('/project', 1_234, io, {
      allowBuildExecution: true,
    });
    expect(result).toMatchObject({ path: null, generationAttempted: true });
    expect(result.failure).toContain('cmake configuration failed');
    expect(result.failure).toContain('bad cache path');
  });

  it('also gates direct generation and does not impose make -j4', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const output = '/project/.lore-compdb/compile_commands.json';
    const contents = new Map<string, string>();
    const io = mockIO(contents, new Set(['/project/Makefile']));
    io.execFileAsync = async (command, args) => {
      calls.push({ command, args });
      if (command === 'bear' && args.includes('--output')) contents.set(output, compilationEntry());
      return { stdout: '', stderr: '' };
    };

    expect(await generateCompdb('/project', 'make', 300_000, io)).toBeNull();
    expect(calls).toHaveLength(0);

    expect(await generateCompdb('/project', 'make', 300_000, io, {
      allowBuildExecution: true,
    })).toBe(output);
    expect(calls.some(call => call.args.includes('-j4'))).toBe(false);
    expect(calls.at(-1)?.args.slice(-1)).toEqual(['make']);
  });
});
