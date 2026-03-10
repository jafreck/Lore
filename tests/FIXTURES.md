# Fixture and Snapshot Tests

This document explains how the fixture-based snapshot tests work and how to add support for a new language extractor.

## Directory Layout

```
tests/
├── FIXTURES.md                   # this file
├── extractors/
│   ├── core.test.ts              # snapshot tests for Tier 1 languages (TS, JS, Python, Go, Rust, Java)
│   ├── tier2.test.ts             # snapshot tests for Tier 2 languages (C, C++, C#, …)
│   ├── tier3.test.ts             # snapshot tests for remaining languages
│   └── __snapshots__/            # auto-generated vitest snapshot files
├── fixtures/
│   ├── typescript/
│   │   └── sample.ts             # representative TypeScript source file
│   ├── javascript/
│   │   └── sample.js
│   ├── python/
│   │   └── sample.py
│   └── <lang>/
│       └── sample.<ext>          # one sample source file per language
└── helpers/
    └── extractorHelper.ts        # shared parseAndExtract() utility
```

Each `tests/fixtures/<lang>/sample.<ext>` file is a small but representative source file that exercises the symbols, imports, and call references the extractor is expected to detect.

## Running Tests

```bash
# Run all tests once
npx vitest run

# Re-run in watch mode during development
npx vitest

# Update stored snapshots after intentional extractor changes
npx vitest run --update-snapshots
```

Snapshots are stored in `tests/extractors/__snapshots__/` and should be committed to source control.

## How Tests Skip Gracefully

Some tree-sitter grammar packages (e.g. `tree-sitter-ocaml`, `tree-sitter-php`) may not be installed in all environments. The shared helper `parseAndExtract()` returns `null` when the grammar cannot be loaded:

```ts
// tests/helpers/extractorHelper.ts
export function parseAndExtract(
  language: string,
  fixturePath: string,
  extractor: SymbolExtractor,
): ExtractionResult | null {
  const source = fs.readFileSync(fixturePath, 'utf8');
  const tree = pool.parse(language, source);
  if (!tree) return null;          // grammar not installed — caller should skip
  return extractor.extract(tree, source, fixturePath);
}
```

Each test uses `test.skipIf(result === null)(...)` so the suite exits cleanly without failures when a grammar package is absent.

## Adding a Fixture for a New Language

1. **Create the fixture file.**  
   Add `tests/fixtures/<lang>/sample.<ext>` containing a short, idiomatic source file that includes at least one of each construct the extractor targets (functions, classes, imports, calls).

2. **Create the extractor module** (if it doesn't exist yet) at:
   ```
   src/indexer/extractors/<lang>.ts
   ```
   Export a class named `<Language>Extractor` that implements `SymbolExtractor` (from `src/indexer/extractors/types.ts`).  
   Example import path pattern:
   ```ts
   import { KotlinExtractor } from '../../src/indexer/extractors/kotlin.js';
   ```

3. **Add a test block** to the appropriate test file (`core.test.ts`, `tier2.test.ts`, or `tier3.test.ts`).  
   Follow the existing pattern — pre-extract at module load time, then use `test.skipIf`:
   ```ts
   const myResult = parseAndExtract(
     '<lang>',
     path.join(fixtureDir, '<lang>/sample.<ext>'),
     new MyExtractor(),
   );

   describe('<Language> extractor', () => {
     test.skipIf(myResult === null)('symbols', () => {
       expect(myResult!.symbols).toMatchSnapshot();
     });
     test.skipIf(myResult === null)('imports', () => {
       expect(myResult!.imports).toMatchSnapshot();
     });
     test.skipIf(myResult === null)('callRefs', () => {
       expect(myResult!.callRefs).toMatchSnapshot();
     });
   });
   ```

4. **Generate the initial snapshots** by running:
   ```bash
   npx vitest run --update-snapshots
   ```
   Review the generated snapshot in `tests/extractors/__snapshots__/` before committing.

5. **Register the extractor** in `src/indexer/index.ts` so it is used during indexing.
