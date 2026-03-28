import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ImportResolver } from '../../src/resolution/resolver.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-resolver-test-'));
}

function writeFile(dir: string, relPath: string, content = ''): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// ─── ImportResolver.resolve() ─────────────────────────────────────────────────

describe('ImportResolver', () => {
  let resolver: ImportResolver;
  let tmpDir: string;

  beforeEach(() => {
    resolver = new ImportResolver();
    tmpDir = mkTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── TypeScript / JavaScript ────────────────────────────────────────────

  describe('TypeScript/JavaScript', () => {
    it('resolves relative .ts import', () => {
      const fromFile = writeFile(tmpDir, 'src/main.ts');
      writeFile(tmpDir, 'src/utils.ts');

      const result = resolver.resolve(
        { source: './utils', importedNames: [] },
        fromFile, tmpDir, 'typescript',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toContain('utils.ts');
    });

    it('resolves relative import with .js extension to .ts file', () => {
      const fromFile = writeFile(tmpDir, 'src/main.ts');
      writeFile(tmpDir, 'src/helper.ts');

      const result = resolver.resolve(
        { source: './helper.js', importedNames: [] },
        fromFile, tmpDir, 'typescript',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toContain('helper.ts');
    });

    it('resolves relative import to index.ts', () => {
      const fromFile = writeFile(tmpDir, 'src/main.ts');
      writeFile(tmpDir, 'src/lib/index.ts');

      const result = resolver.resolve(
        { source: './lib', importedNames: [] },
        fromFile, tmpDir, 'typescript',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toContain('index.ts');
    });

    it('marks unresolved relative import as internal', () => {
      const fromFile = writeFile(tmpDir, 'src/main.ts');

      const result = resolver.resolve(
        { source: './nonexistent', importedNames: [] },
        fromFile, tmpDir, 'typescript',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBeUndefined();
    });

    it('marks bare specifier as external when in package.json', () => {
      writeFile(tmpDir, 'package.json', JSON.stringify({
        dependencies: { lodash: '^4.0.0' },
      }));
      const fromFile = writeFile(tmpDir, 'src/main.ts');

      const result = resolver.resolve(
        { source: 'lodash', importedNames: [] },
        fromFile, tmpDir, 'typescript',
      );
      expect(result.isExternal).toBe(true);
      expect(result.externalName).toBe('lodash');
    });

    it('marks scoped package as external', () => {
      writeFile(tmpDir, 'package.json', JSON.stringify({
        devDependencies: { '@types/node': '*' },
      }));
      const fromFile = writeFile(tmpDir, 'src/main.ts');

      const result = resolver.resolve(
        { source: '@types/node', importedNames: [] },
        fromFile, tmpDir, 'typescript',
      );
      expect(result.isExternal).toBe(true);
    });

    it('marks unknown bare specifier as external', () => {
      writeFile(tmpDir, 'package.json', '{}');
      const fromFile = writeFile(tmpDir, 'src/main.ts');

      const result = resolver.resolve(
        { source: 'some-unknown-pkg', importedNames: [] },
        fromFile, tmpDir, 'typescript',
      );
      expect(result.isExternal).toBe(true);
    });

    it('works for javascript language too', () => {
      const fromFile = writeFile(tmpDir, 'src/main.js');
      writeFile(tmpDir, 'src/utils.js');

      const result = resolver.resolve(
        { source: './utils', importedNames: [] },
        fromFile, tmpDir, 'javascript',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toContain('utils.js');
    });
  });

  // ─── Python ─────────────────────────────────────────────────────────────

  describe('Python', () => {
    it('resolves relative Python import', () => {
      const fromFile = writeFile(tmpDir, 'pkg/main.py');
      writeFile(tmpDir, 'pkg/utils.py');

      const result = resolver.resolve(
        { source: '.utils', importedNames: [] },
        fromFile, tmpDir, 'python',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toContain('utils.py');
    });

    it('resolves relative import with double-dot', () => {
      const fromFile = writeFile(tmpDir, 'pkg/sub/main.py');
      writeFile(tmpDir, 'pkg/models.py');

      const result = resolver.resolve(
        { source: '..models', importedNames: [] },
        fromFile, tmpDir, 'python',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toContain('models.py');
    });

    it('resolves absolute Python import to project file', () => {
      const fromFile = writeFile(tmpDir, 'src/main.py');
      writeFile(tmpDir, 'mypackage/utils.py');

      const result = resolver.resolve(
        { source: 'mypackage.utils', importedNames: [] },
        fromFile, tmpDir, 'python',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toContain('utils.py');
    });

    it('resolves absolute Python import to __init__.py', () => {
      const fromFile = writeFile(tmpDir, 'src/main.py');
      writeFile(tmpDir, 'mypackage/__init__.py');

      const result = resolver.resolve(
        { source: 'mypackage', importedNames: [] },
        fromFile, tmpDir, 'python',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toContain('__init__.py');
    });

    it('marks unresolvable Python import as external', () => {
      const fromFile = writeFile(tmpDir, 'src/main.py');

      const result = resolver.resolve(
        { source: 'numpy', importedNames: [] },
        fromFile, tmpDir, 'python',
      );
      expect(result.isExternal).toBe(true);
    });

    it('marks unresolved relative Python import as internal', () => {
      const fromFile = writeFile(tmpDir, 'pkg/main.py');

      const result = resolver.resolve(
        { source: '.nonexistent', importedNames: [] },
        fromFile, tmpDir, 'python',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBeUndefined();
    });
  });

  // ─── Go ─────────────────────────────────────────────────────────────────

  describe('Go', () => {
    it('resolves internal Go package', () => {
      writeFile(tmpDir, 'go.mod', 'module github.com/user/repo\n\ngo 1.21\n');
      writeFile(tmpDir, 'pkg/utils/utils.go', 'package utils');
      const fromFile = writeFile(tmpDir, 'cmd/main.go', 'package main');

      const result = resolver.resolve(
        { source: 'github.com/user/repo/pkg/utils', importedNames: [] },
        fromFile, tmpDir, 'go',
      );
      expect(result.isExternal).toBe(false);
    });

    it('marks external Go package', () => {
      writeFile(tmpDir, 'go.mod', 'module github.com/user/repo\n');
      const fromFile = writeFile(tmpDir, 'main.go');

      const result = resolver.resolve(
        { source: 'fmt', importedNames: [] },
        fromFile, tmpDir, 'go',
      );
      expect(result.isExternal).toBe(true);
    });

    it('marks third-party Go import as external', () => {
      writeFile(tmpDir, 'go.mod', 'module github.com/user/repo\n');
      const fromFile = writeFile(tmpDir, 'main.go');

      const result = resolver.resolve(
        { source: 'github.com/other/lib', importedNames: [] },
        fromFile, tmpDir, 'go',
      );
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── Rust ───────────────────────────────────────────────────────────────

  describe('Rust', () => {
    it('marks crate:: as internal', () => {
      const fromFile = writeFile(tmpDir, 'src/main.rs');

      const result = resolver.resolve(
        { source: 'crate::utils', importedNames: [] },
        fromFile, tmpDir, 'rust',
      );
      expect(result.isExternal).toBe(false);
    });

    it('marks self:: as internal', () => {
      const fromFile = writeFile(tmpDir, 'src/lib.rs');

      const result = resolver.resolve(
        { source: 'self::module', importedNames: [] },
        fromFile, tmpDir, 'rust',
      );
      expect(result.isExternal).toBe(false);
    });

    it('marks super:: as internal', () => {
      const fromFile = writeFile(tmpDir, 'src/sub/mod.rs');

      const result = resolver.resolve(
        { source: 'super::other', importedNames: [] },
        fromFile, tmpDir, 'rust',
      );
      expect(result.isExternal).toBe(false);
    });

    it('marks Cargo.toml dependency as external', () => {
      writeFile(tmpDir, 'Cargo.toml', `
[dependencies]
serde = "1.0"
tokio = { version = "1" }
`);
      const fromFile = writeFile(tmpDir, 'src/main.rs');

      const result = resolver.resolve(
        { source: 'serde::Deserialize', importedNames: [] },
        fromFile, tmpDir, 'rust',
      );
      expect(result.isExternal).toBe(true);
    });

    it('marks path dependency as internal', () => {
      writeFile(tmpDir, 'Cargo.toml', `
[dependencies]
my_lib = { path = "../my-lib" }
`);
      const fromFile = writeFile(tmpDir, 'src/main.rs');

      const result = resolver.resolve(
        { source: 'my_lib::something', importedNames: [] },
        fromFile, tmpDir, 'rust',
      );
      expect(result.isExternal).toBe(false);
    });

    it('marks workspace member as internal', () => {
      writeFile(tmpDir, 'Cargo.toml', `
[workspace]
members = [
  "crates/my-core"
]
`);
      const fromFile = writeFile(tmpDir, 'src/main.rs');

      const result = resolver.resolve(
        { source: 'my_core::types', importedNames: [] },
        fromFile, tmpDir, 'rust',
      );
      expect(result.isExternal).toBe(false);
    });

    it('marks unknown crate as external', () => {
      writeFile(tmpDir, 'Cargo.toml', '[dependencies]\n');
      const fromFile = writeFile(tmpDir, 'src/main.rs');

      const result = resolver.resolve(
        { source: 'rand::Rng', importedNames: [] },
        fromFile, tmpDir, 'rust',
      );
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── Java ───────────────────────────────────────────────────────────────

  describe('Java', () => {
    it('resolves Java import to src/main/java file', () => {
      writeFile(tmpDir, 'src/main/java/com/example/MyClass.java', 'class MyClass {}');
      const fromFile = writeFile(tmpDir, 'src/main/java/com/example/Main.java');

      const result = resolver.resolve(
        { source: 'com.example.MyClass', importedNames: [] },
        fromFile, tmpDir, 'java',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toContain('MyClass.java');
    });

    it('resolves Java import from src root', () => {
      writeFile(tmpDir, 'src/com/example/Util.java', 'class Util {}');
      const fromFile = writeFile(tmpDir, 'src/com/example/Main.java');

      const result = resolver.resolve(
        { source: 'com.example.Util', importedNames: [] },
        fromFile, tmpDir, 'java',
      );
      expect(result.isExternal).toBe(false);
    });

    it('marks unresolvable Java import as external', () => {
      const fromFile = writeFile(tmpDir, 'src/Main.java');

      const result = resolver.resolve(
        { source: 'java.util.List', importedNames: [] },
        fromFile, tmpDir, 'java',
      );
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── C# ─────────────────────────────────────────────────────────────────

  describe('C#', () => {
    it('marks C# using as external (namespace, not file)', () => {
      const fromFile = writeFile(tmpDir, 'Program.cs');

      const result = resolver.resolve(
        { source: 'System.Collections.Generic', importedNames: [] },
        fromFile, tmpDir, 'csharp',
      );
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── C/C++ ──────────────────────────────────────────────────────────────

  describe('C/C++', () => {
    it('resolves quoted include as relative', () => {
      const fromFile = writeFile(tmpDir, 'src/main.c');
      writeFile(tmpDir, 'src/header.h');

      const result = resolver.resolve(
        { source: 'header.h', importedNames: [] },
        fromFile, tmpDir, 'c',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toContain('header.h');
    });

    it('marks angle-bracket include as external', () => {
      const fromFile = writeFile(tmpDir, 'src/main.c');

      const result = resolver.resolve(
        { source: '<stdio.h>', importedNames: [] },
        fromFile, tmpDir, 'c',
      );
      expect(result.isExternal).toBe(true);
    });

    it('resolves C++ include from rootDir', () => {
      writeFile(tmpDir, 'include/config.h');
      const fromFile = writeFile(tmpDir, 'src/main.cpp');

      // Quoted include not found relative → tries rootDir
      const result = resolver.resolve(
        { source: 'include/config.h', importedNames: [] },
        fromFile, tmpDir, 'cpp',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toContain('config.h');
    });
  });

  // ─── Unknown language ──────────────────────────────────────────────────

  describe('Unknown language', () => {
    it('marks everything as external for unknown languages', () => {
      const fromFile = writeFile(tmpDir, 'src/main.xyz');

      const result = resolver.resolve(
        { source: 'some-import', importedNames: [] },
        fromFile, tmpDir, 'xyz-lang',
      );
      expect(result.isExternal).toBe(true);
      expect(result.externalName).toBe('some-import');
    });
  });

  // ─── Manifest caching ──────────────────────────────────────────────────

  describe('manifest caching', () => {
    it('caches package.json parsing across calls', () => {
      writeFile(tmpDir, 'package.json', JSON.stringify({
        dependencies: { express: '*' },
      }));
      const fromFile = writeFile(tmpDir, 'src/main.ts');

      const r1 = resolver.resolve({ source: 'express', importedNames: [] }, fromFile, tmpDir, 'typescript');
      const r2 = resolver.resolve({ source: 'express', importedNames: [] }, fromFile, tmpDir, 'typescript');
      expect(r1.isExternal).toBe(true);
      expect(r2.isExternal).toBe(true);
    });
  });
});
