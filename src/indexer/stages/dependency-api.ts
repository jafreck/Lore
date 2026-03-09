/**
 * @module indexer/stages/dependency-api
 *
 * Pipeline stage: index declaration-surface symbols from direct dependencies
 * (.d.ts files for npm, etc.). Populates `external_symbols`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PipelineContext, PipelineStage } from '../pipeline.js';
import type { Database } from '../db.js';
import { ParserPool } from '../parser.js';
import { LspEnrichmentCoordinator } from '../lsp/enrichment.js';
import {
  type ExtractionResult,
  type RawSymbol,
  type SymbolExtractor,
  isPublicDeclarationSurfaceSymbol,
} from '../extractors/types.js';
import { TypeScriptExtractor } from '../extractors/typescript.js';

// ─── Stage ────────────────────────────────────────────────────────────────────

/**
 * Index exported declarations from direct npm dependencies (.d.ts files).
 * Stores results in `external_symbols`.
 */
export class DependencyApiStage implements PipelineStage {
  readonly name = 'dependency-api';

  private pool: ParserPool | null = null;

  async execute(context: PipelineContext, _mode: 'build' | 'update'): Promise<void> {
    const { db, walkerConfig, lsp } = context;

    // Always clear external symbols — when indexDependencies is false, this
    // ensures stale data from a previous deps-enabled build is removed.
    db.prepare('DELETE FROM external_symbols').run();

    if (!context.indexDependencies) return;

    this.pool = new ParserPool();

    const directDependencies = loadDirectDependencies(walkerConfig.rootDir);
    if (directDependencies.size === 0) return;

    const extractor = new TypeScriptExtractor();

    // Optional LSP coordinator for enriching external symbols.
    let lspCoordinator: LspEnrichmentCoordinator | null = null;
    if (lsp?.enabled) {
      lspCoordinator = new LspEnrichmentCoordinator(lsp, walkerConfig.rootDir);
      await lspCoordinator.start(new Set(['typescript']));
    }

    try {
      const insertExternalSymbol = db.prepare(
        `INSERT OR IGNORE INTO external_symbols
           (
             package_name,
             package_version,
             source_ref,
             symbol_name,
             symbol_kind,
             signature,
             doc_comment,
             resolved_type_signature,
             resolved_return_type,
             definition_uri,
             definition_path
           )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      for (const [packageName, declaredVersion] of directDependencies) {
        const packageDir = path.join(walkerConfig.rootDir, 'node_modules', packageName);
        if (!fs.existsSync(packageDir) || !fs.statSync(packageDir).isDirectory()) continue;

        const packageVersion = readInstalledPackageVersion(packageDir) ?? declaredVersion ?? null;
        const declarationFiles = collectDeclarationFiles(packageDir);

        for (const declarationFile of declarationFiles) {
          const source = fs.readFileSync(declarationFile, 'utf8');
          const tree = this.pool.parse('typescript', source);
          if (!tree) continue;

          const result: ExtractionResult = extractor.extract(tree, source, declarationFile);
          const declarationSymbols = result.symbols.filter((symbol) => shouldIndexDependencySymbol(symbol));
          const enrichmentRows = lspCoordinator
            ? await lspCoordinator.enrich({
              filePath: declarationFile,
              language: 'typescript',
              source,
              targets: declarationSymbols.map((symbol) => ({
                line: symbol.startLine,
                character: symbol.startCharacter ?? 0,
              })),
            })
            : declarationSymbols.map(() => null);

          for (let i = 0; i < declarationSymbols.length; i++) {
            const symbol = declarationSymbols[i];
            if (!symbol) continue;
            const metadata = enrichmentRows[i];
            insertExternalSymbol.run(
              packageName,
              packageVersion,
              declarationFile,
              symbol.name,
              symbol.kind,
              symbol.signature,
              symbol.docComment ?? null,
              metadata?.resolvedTypeSignature ?? null,
              metadata?.resolvedReturnType ?? null,
              metadata?.definitionUri ?? null,
              metadata?.definitionPath ?? null,
            );
          }
        }
      }
    } finally {
      if (lspCoordinator) {
        await lspCoordinator.dispose();
      }
    }
  }

  async dispose(): Promise<void> {
    this.pool = null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadDirectDependencies(rootDir: string): Map<string, string | undefined> {
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return new Map();

  const raw = fs.readFileSync(packageJsonPath, 'utf8');
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const deps = new Map<string, string | undefined>();
  for (const section of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
    if (!section) continue;
    for (const [name, version] of Object.entries(section)) {
      if (!deps.has(name)) deps.set(name, version);
    }
  }
  return deps;
}

function readInstalledPackageVersion(packageDir: string): string | undefined {
  const packageJsonPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return undefined;

  const raw = fs.readFileSync(packageJsonPath, 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version;
}

function collectDeclarationFiles(packageDir: string): string[] {
  const declarations: string[] = [];
  const stack: string[] = [packageDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && fullPath.endsWith('.d.ts')) {
        declarations.push(fullPath);
      }
    }
  }

  return declarations;
}

function shouldIndexDependencySymbol(symbol: RawSymbol): boolean {
  if (!isPublicDeclarationSurfaceSymbol(symbol)) return false;
  if (symbol.declarationSurface) return true;
  return !hasImplementationBody(symbol);
}

function hasImplementationBody(symbol: RawSymbol): boolean {
  const node = symbol.astNode;
  if (!node) return false;

  if (
    node.type === 'arrow_function' ||
    node.type === 'function_expression' ||
    node.type === 'generator_function'
  ) {
    return true;
  }

  if (
    node.type === 'class_declaration' ||
    node.type === 'interface_declaration' ||
    node.type === 'type_alias_declaration'
  ) {
    return false;
  }

  const bodyNode = node.childForFieldName('body');
  if (!bodyNode) return false;
  return bodyNode.namedChildCount > 0 || bodyNode.text.trim() !== '';
}
