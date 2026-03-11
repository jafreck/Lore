import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImportResolver, type ResolvedImport } from '../../src/resolution/resolver.js';

describe('ImportResolver', () => {
  let resolver: ImportResolver;
  let tmpDir: string;

  beforeEach(() => {
    resolver = new ImportResolver();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-test-'));
  });

  // ─── resolve() dispatch ─────────────────────────────────────────────────────

  describe('resolve() dispatch', () => {
    it('should delegate TypeScript imports to resolveJs', () => {
      const result = resolver.resolve(
        { source: 'express', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/app.ts'),
        tmpDir,
        'typescript',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should delegate JavaScript imports to resolveJs', () => {
      const result = resolver.resolve(
        { source: 'lodash', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/app.js'),
        tmpDir,
        'javascript',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should delegate Go imports to resolveGo', () => {
      const result = resolver.resolve(
        { source: 'fmt', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.go'),
        tmpDir,
        'go',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should delegate Python imports to resolvePython', () => {
      const result = resolver.resolve(
        { source: 'os', kind: 'import', line: 1 },
        path.join(tmpDir, 'app.py'),
        tmpDir,
        'python',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should delegate Rust imports to resolveRust', () => {
      const result = resolver.resolve(
        { source: 'serde', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.rs'),
        tmpDir,
        'rust',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should delegate Java imports to resolveJava', () => {
      const result = resolver.resolve(
        { source: 'java.util.List', kind: 'import', line: 1 },
        path.join(tmpDir, 'Main.java'),
        tmpDir,
        'java',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should delegate C# imports to resolveCSharp', () => {
      const result = resolver.resolve(
        { source: 'System.Collections', kind: 'import', line: 1 },
        path.join(tmpDir, 'Program.cs'),
        tmpDir,
        'csharp',
      );
      expect(result.isExternal).toBe(true);
      expect(result.externalName).toBe('System.Collections');
    });

    it('should delegate C imports to resolveC', () => {
      const result = resolver.resolve(
        { source: '<stdio.h>', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.c'),
        tmpDir,
        'c',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should delegate C++ imports to resolveC', () => {
      const result = resolver.resolve(
        { source: '<iostream>', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.cpp'),
        tmpDir,
        'cpp',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should mark unknown languages as external', () => {
      const result = resolver.resolve(
        { source: 'some_module', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.xyz'),
        tmpDir,
        'unknown-lang',
      );
      expect(result.isExternal).toBe(true);
      expect(result.externalName).toBe('some_module');
    });
  });

  // ─── JavaScript/TypeScript resolution ───────────────────────────────────────

  describe('resolveJs', () => {
    it('should resolve relative .ts import to actual file', () => {
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'utils.ts'), 'export const x = 1;');

      const result = resolver.resolve(
        { source: './utils', kind: 'import', line: 1 },
        path.join(srcDir, 'app.ts'),
        tmpDir,
        'typescript',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(srcDir, 'utils.ts'));
    });

    it('should resolve relative import to index.ts', () => {
      const srcDir = path.join(tmpDir, 'src');
      const utilsDir = path.join(srcDir, 'utils');
      fs.mkdirSync(utilsDir, { recursive: true });
      fs.writeFileSync(path.join(utilsDir, 'index.ts'), 'export const x = 1;');

      const result = resolver.resolve(
        { source: './utils', kind: 'import', line: 1 },
        path.join(srcDir, 'app.ts'),
        tmpDir,
        'typescript',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(utilsDir, 'index.ts'));
    });

    it('should mark bare specifiers found in package.json as external', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { express: '4.0.0' },
          devDependencies: { vitest: '1.0.0' },
        }),
      );

      const result = resolver.resolve(
        { source: 'express', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/app.ts'),
        tmpDir,
        'typescript',
      );
      expect(result.isExternal).toBe(true);
      expect(result.externalName).toBe('express');
    });

    it('should mark scoped packages in package.json as external', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ dependencies: { '@scope/pkg': '1.0.0' } }),
      );

      const result = resolver.resolve(
        { source: '@scope/pkg', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/app.ts'),
        tmpDir,
        'typescript',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should keep unresolved relative imports internal when no matching file exists', () => {
      const result = resolver.resolve(
        { source: './nonexistent', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/app.ts'),
        tmpDir,
        'typescript',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBeUndefined();
    });

    it('should resolve .js extension import', () => {
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'helper.js'), 'module.exports = {}');

      const result = resolver.resolve(
        { source: './helper', kind: 'import', line: 1 },
        path.join(srcDir, 'app.js'),
        tmpDir,
        'javascript',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(srcDir, 'helper.js'));
    });

    it('should resolve index.js fallback', () => {
      const srcDir = path.join(tmpDir, 'src');
      const libDir = path.join(srcDir, 'lib');
      fs.mkdirSync(libDir, { recursive: true });
      fs.writeFileSync(path.join(libDir, 'index.js'), 'module.exports = {}');

      const result = resolver.resolve(
        { source: './lib', kind: 'import', line: 1 },
        path.join(srcDir, 'app.js'),
        tmpDir,
        'javascript',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(libDir, 'index.js'));
    });

    it('should cache package.json parsing across calls', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ dependencies: { react: '18.0.0' } }),
      );

      const r1 = resolver.resolve(
        { source: 'react', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/a.ts'),
        tmpDir,
        'typescript',
      );
      const r2 = resolver.resolve(
        { source: 'react', kind: 'import', line: 2 },
        path.join(tmpDir, 'src/b.ts'),
        tmpDir,
        'typescript',
      );
      expect(r1.isExternal).toBe(true);
      expect(r2.isExternal).toBe(true);
    });

    it('should treat bare specifiers as external when no package.json exists', () => {
      const result = resolver.resolve(
        { source: 'lodash', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/app.ts'),
        tmpDir,
        'typescript',
      );
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── Go resolution ─────────────────────────────────────────────────────────

  describe('resolveGo', () => {
    it('should resolve internal package via go.mod module path', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'go.mod'),
        'module github.com/user/project\n\ngo 1.21\n',
      );
      const pkgDir = path.join(tmpDir, 'internal', 'handler');
      fs.mkdirSync(pkgDir, { recursive: true });

      const result = resolver.resolve(
        { source: 'github.com/user/project/internal/handler', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.go'),
        tmpDir,
        'go',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(pkgDir);
    });

    it('should mark standard library imports as external', () => {
      fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module myproject\n');

      const result = resolver.resolve(
        { source: 'fmt', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.go'),
        tmpDir,
        'go',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should mark external dependencies as external', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'go.mod'),
        'module myproject\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
      );

      const result = resolver.resolve(
        { source: 'github.com/gin-gonic/gin', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.go'),
        tmpDir,
        'go',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should mark internal package as external when directory does not exist', () => {
      fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module myproject\n');

      const result = resolver.resolve(
        { source: 'myproject/nonexistent', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.go'),
        tmpDir,
        'go',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should cache go.mod parsing across calls', () => {
      fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module mymod\n');

      resolver.resolve(
        { source: 'fmt', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.go'),
        tmpDir,
        'go',
      );
      const result = resolver.resolve(
        { source: 'fmt', kind: 'import', line: 2 },
        path.join(tmpDir, 'main.go'),
        tmpDir,
        'go',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should handle missing go.mod gracefully', () => {
      const result = resolver.resolve(
        { source: 'fmt', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.go'),
        tmpDir,
        'go',
      );
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── Python resolution ──────────────────────────────────────────────────────

  describe('resolvePython', () => {
    it('should resolve relative import to .py file', () => {
      const pkgDir = path.join(tmpDir, 'mypackage');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'utils.py'), '');

      const result = resolver.resolve(
        { source: '.utils', kind: 'import', line: 1 },
        path.join(pkgDir, 'main.py'),
        tmpDir,
        'python',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(pkgDir, 'utils.py'));
    });

    it('should resolve relative import to __init__.py', () => {
      const pkgDir = path.join(tmpDir, 'mypackage');
      const subDir = path.join(pkgDir, 'sub');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, '__init__.py'), '');

      const result = resolver.resolve(
        { source: '.sub', kind: 'import', line: 1 },
        path.join(pkgDir, 'main.py'),
        tmpDir,
        'python',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(subDir, '__init__.py'));
    });

    it('should resolve double-dot parent relative import', () => {
      const pkgDir = path.join(tmpDir, 'pkg', 'sub');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'pkg', 'helpers.py'), '');

      const result = resolver.resolve(
        { source: '..helpers', kind: 'import', line: 1 },
        path.join(pkgDir, 'main.py'),
        tmpDir,
        'python',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(tmpDir, 'pkg', 'helpers.py'));
    });

    it('should resolve absolute import to file in project root', () => {
      fs.writeFileSync(path.join(tmpDir, 'config.py'), '');

      const result = resolver.resolve(
        { source: 'config', kind: 'import', line: 1 },
        path.join(tmpDir, 'app.py'),
        tmpDir,
        'python',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(tmpDir, 'config.py'));
    });

    it('should resolve dotted absolute import (mypackage.utils)', () => {
      const pkgDir = path.join(tmpDir, 'mypackage');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'utils.py'), '');

      const result = resolver.resolve(
        { source: 'mypackage.utils', kind: 'import', line: 1 },
        path.join(tmpDir, 'app.py'),
        tmpDir,
        'python',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(pkgDir, 'utils.py'));
    });

    it('should mark stdlib imports as external', () => {
      const result = resolver.resolve(
        { source: 'os', kind: 'import', line: 1 },
        path.join(tmpDir, 'app.py'),
        tmpDir,
        'python',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should keep unresolvable relative imports internal', () => {
      const result = resolver.resolve(
        { source: '.nonexistent', kind: 'import', line: 1 },
        path.join(tmpDir, 'app.py'),
        tmpDir,
        'python',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBeUndefined();
    });
  });

  // ─── Rust resolution ────────────────────────────────────────────────────────

  describe('resolveRust', () => {
    it('should mark crate:: imports as internal', () => {
      const result = resolver.resolve(
        { source: 'crate::models::User', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/main.rs'),
        tmpDir,
        'rust',
      );
      expect(result.isExternal).toBe(false);
    });

    it('should mark self:: imports as internal', () => {
      const result = resolver.resolve(
        { source: 'self::handler', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/main.rs'),
        tmpDir,
        'rust',
      );
      expect(result.isExternal).toBe(false);
    });

    it('should mark super:: imports as internal', () => {
      const result = resolver.resolve(
        { source: 'super::config', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/handlers/mod.rs'),
        tmpDir,
        'rust',
      );
      expect(result.isExternal).toBe(false);
    });

    it('should identify Cargo.toml dependencies as external', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'Cargo.toml'),
        '[dependencies]\nserde = "1.0"\ntokio = { version = "1" }\n',
      );

      const result = resolver.resolve(
        { source: 'serde::Deserialize', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/main.rs'),
        tmpDir,
        'rust',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should mark unknown crates as external', () => {
      fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[dependencies]\n');

      const result = resolver.resolve(
        { source: 'std::collections::HashMap', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/main.rs'),
        tmpDir,
        'rust',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should cache Cargo.toml parsing across calls', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'Cargo.toml'),
        '[dependencies]\nreqwest = "0.11"\n',
      );

      resolver.resolve(
        { source: 'reqwest', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/main.rs'),
        tmpDir,
        'rust',
      );
      const result = resolver.resolve(
        { source: 'reqwest', kind: 'import', line: 2 },
        path.join(tmpDir, 'src/main.rs'),
        tmpDir,
        'rust',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should handle missing Cargo.toml gracefully', () => {
      const result = resolver.resolve(
        { source: 'unknown_crate', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/main.rs'),
        tmpDir,
        'rust',
      );
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── Java resolution ────────────────────────────────────────────────────────

  describe('resolveJava', () => {
    it('should resolve Java import to file under src/main/java', () => {
      const javaDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example');
      fs.mkdirSync(javaDir, { recursive: true });
      fs.writeFileSync(path.join(javaDir, 'Model.java'), 'public class Model {}');

      const result = resolver.resolve(
        { source: 'com.example.Model', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/main/java/com/example/App.java'),
        tmpDir,
        'java',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(javaDir, 'Model.java'));
    });

    it('should resolve Java import to file under src/', () => {
      const javaDir = path.join(tmpDir, 'src', 'com', 'example');
      fs.mkdirSync(javaDir, { recursive: true });
      fs.writeFileSync(path.join(javaDir, 'Service.java'), 'public class Service {}');

      const result = resolver.resolve(
        { source: 'com.example.Service', kind: 'import', line: 1 },
        path.join(tmpDir, 'src/App.java'),
        tmpDir,
        'java',
      );
      expect(result.isExternal).toBe(false);
    });

    it('should resolve Java import to file at project root', () => {
      const javaDir = path.join(tmpDir, 'com', 'example');
      fs.mkdirSync(javaDir, { recursive: true });
      fs.writeFileSync(path.join(javaDir, 'Util.java'), 'public class Util {}');

      const result = resolver.resolve(
        { source: 'com.example.Util', kind: 'import', line: 1 },
        path.join(tmpDir, 'Main.java'),
        tmpDir,
        'java',
      );
      expect(result.isExternal).toBe(false);
    });

    it('should mark unresolvable Java imports as external', () => {
      const result = resolver.resolve(
        { source: 'java.util.List', kind: 'import', line: 1 },
        path.join(tmpDir, 'Main.java'),
        tmpDir,
        'java',
      );
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── C/C++ resolution ──────────────────────────────────────────────────────

  describe('resolveC', () => {
    it('should resolve quoted include to relative file', () => {
      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'header.h'), '#pragma once');

      const result = resolver.resolve(
        { source: 'header.h', kind: 'import', line: 1 },
        path.join(srcDir, 'main.c'),
        tmpDir,
        'c',
      );
      expect(result.isExternal).toBe(false);
      expect(result.resolvedPath).toBe(path.join(srcDir, 'header.h'));
    });

    it('should resolve quoted include from project root', () => {
      fs.writeFileSync(path.join(tmpDir, 'global.h'), '#pragma once');

      const srcDir = path.join(tmpDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      const result = resolver.resolve(
        { source: 'global.h', kind: 'import', line: 1 },
        path.join(srcDir, 'main.c'),
        tmpDir,
        'c',
      );
      // Should try relative to file first, then root
      expect(result.resolvedPath).toBe(path.join(tmpDir, 'global.h'));
      expect(result.isExternal).toBe(false);
    });

    it('should mark angle-bracket includes as external', () => {
      const result = resolver.resolve(
        { source: '<stdio.h>', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.c'),
        tmpDir,
        'c',
      );
      expect(result.isExternal).toBe(true);
    });

    it('should mark unresolvable quoted includes as external', () => {
      const result = resolver.resolve(
        { source: 'nonexistent.h', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.c'),
        tmpDir,
        'c',
      );
      expect(result.isExternal).toBe(true);
    });
  });

  // ─── C# resolution ─────────────────────────────────────────────────────────

  describe('resolveCSharp', () => {
    it('should always mark C# using directives as external', () => {
      const result = resolver.resolve(
        { source: 'System.Collections.Generic', kind: 'import', line: 1 },
        path.join(tmpDir, 'Program.cs'),
        tmpDir,
        'csharp',
      );
      expect(result.isExternal).toBe(true);
      expect(result.externalName).toBe('System.Collections.Generic');
    });
  });

  // ─── markExternal ───────────────────────────────────────────────────────────

  describe('markExternal shape', () => {
    it('should include rawSource and externalName', () => {
      const result = resolver.resolve(
        { source: 'some_dep', kind: 'import', line: 1 },
        path.join(tmpDir, 'main.xyz'),
        tmpDir,
        'unknown',
      );
      expect(result).toEqual({
        rawSource: 'some_dep',
        isExternal: true,
        externalName: 'some_dep',
      });
    });
  });
});
