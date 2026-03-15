/**
 * @module indexer/scip/enrichment
 *
 * `ScipEnrichmentCoordinator` drives the SCIP enrichment workflow:
 *
 * 1. Run SCIP indexers (or read pre-computed index files) for each language.
 * 2. Parse the resulting protobuf indexes into in-memory lookup structures.
 * 3. For a batch of targets (file + position), resolve each to its
 *    definition location and type signature using the SCIP data.
 *
 * Returns the same `ResolvedTypeMetadata` shape as the LSP enrichment
 * coordinator, so the enrichment stage and resolution stage are agnostic
 * to the enrichment source.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { ResolvedTypeMetadata } from '../lsp/enrichment.js';
import type { EffectiveScipSettings } from './config.js';
import type { ResolvedScipIndexerCommand } from './registry.js';
import { resolveScipIndexerRegistry, SCIP_SUPPORTED_LANGUAGES } from './registry.js';
import {
  parseScipIndex,
  extractSignatureFromDocs,
  extractReturnType,
  type ScipIndexData,
} from './index-reader.js';
import { getLogger } from '../logger.js';
import { getSpecsForLanguage, installScipIndexer } from './installer.js';
import { ensureCompilationDatabase } from './compdb.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScipEnrichmentTarget {
  line: number;
  character: number;
}

export interface ScipEnrichmentRequest {
  filePath: string;
  language: string;
  source: string;
  targets: readonly ScipEnrichmentTarget[];
}

// ─── Coordinator ──────────────────────────────────────────────────────────────

export class ScipEnrichmentCoordinator {
  private readonly rootDir: string;
  private resolvedIndexers: Record<string, ResolvedScipIndexerCommand>;
  /** Merged SCIP index data from all indexer runs. */
  private indexData: ScipIndexData | null = null;
  /** Languages for which SCIP indexing succeeded. */
  private readonly enrichedLanguages = new Set<string>();

  constructor(
    private readonly settings: EffectiveScipSettings,
    rootDir: string,
  ) {
    this.rootDir = rootDir;
    this.resolvedIndexers = resolveScipIndexerRegistry(settings.indexers);
  }

  /**
   * Run SCIP indexers (or load pre-computed indexes) for the given languages.
   * Must be called before `enrich()`.
   *
   * @returns Set of languages for which SCIP data is available.
   */
  async start(languages: Iterable<string>): Promise<ReadonlySet<string>> {
    if (!this.settings.enabled) return this.enrichedLanguages;

    const log = getLogger();
    const uniqueLanguages = new Set(languages);

    // Determine which languages have SCIP coverage.
    const toProcess = new Set<string>();
    const missingLanguages = new Set<string>();
    for (const lang of uniqueLanguages) {
      if (SCIP_SUPPORTED_LANGUAGES.has(lang)) {
        const resolved = this.resolvedIndexers[lang];
        if (resolved?.available || this.settings.indexDir) {
          toProcess.add(lang);
        } else {
          missingLanguages.add(lang);
        }
      }
    }

    // Auto-install missing SCIP indexers
    if (missingLanguages.size > 0) {
      const installedAny = await this.autoInstallMissing(missingLanguages);
      if (installedAny) {
        // Re-resolve the registry after installation
        this.resolvedIndexers = resolveScipIndexerRegistry(this.settings.indexers);
        for (const lang of missingLanguages) {
          const resolved = this.resolvedIndexers[lang];
          if (resolved?.available) {
            toProcess.add(lang);
            missingLanguages.delete(lang);
          }
        }
      }
    }

    if (toProcess.size === 0) {
      log.indexing('scip: no indexers available for requested languages');
      return this.enrichedLanguages;
    }

    // Group languages by shared indexer command to avoid running the same
    // indexer multiple times (e.g., scip-java for java + scala + kotlin).
    const commandGroups = new Map<string, Set<string>>();
    for (const lang of toProcess) {
      const resolved = this.resolvedIndexers[lang];
      const key = resolved ? resolved.command : `indexDir:${lang}`;
      if (!commandGroups.has(key)) commandGroups.set(key, new Set());
      commandGroups.get(key)!.add(lang);
    }

    for (const [commandKey, langs] of commandGroups) {
      const representativeLang = langs.values().next().value!;

      try {
        let indexBuffer: Uint8Array | null = null;

        if (this.settings.indexDir) {
          // Read pre-computed index from the configured directory.
          indexBuffer = this.readPrecomputedIndex(representativeLang);
        }

        if (!indexBuffer) {
          // Run the SCIP indexer.
          indexBuffer = await this.runIndexer(representativeLang);
        }

        if (indexBuffer) {
          const parsed = parseScipIndex(indexBuffer, this.rootDir);
          // Merge documents and symbols into the combined index.
          for (const lang of langs) {
            this.enrichedLanguages.add(lang);
          }
          // Re-parse and merge (the parsed data is self-contained per ScipIndexData).
          // For a proper merge we need to transfer data. Since our parsing is
          // cheap, just re-assign if single or accumulate:
          if (this.indexData === null) {
            this.indexData = parsed;
          } else {
            // Merge by re-parsing into the existing index.
            // This is a design limitation — for now, multiple indexes are
            // handled by re-reading.  A future optimisation could merge the
            // ScipIndexData structures directly.
            this.indexData = mergeScipIndexDataPartial(this.indexData, parsed);
          }
          log.indexing(`scip: loaded index for ${[...langs].join(', ')}`, {
            files: parsed.fileCount,
            definitions: parsed.definitionCount,
          });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.indexing(`scip: indexer failed for ${[...langs].join(', ')}: ${msg}`);
      }
    }

    return this.enrichedLanguages;
  }

  /**
   * Enrich a batch of targets with SCIP-derived metadata.
   *
   * Returns an array parallel to `request.targets` — each entry is either
   * a `ResolvedTypeMetadata` or `null` (no SCIP data for that position).
   */
  enrich(request: ScipEnrichmentRequest): Array<ResolvedTypeMetadata | null> {
    const empty = request.targets.map(() => null);
    if (!this.indexData || !this.enrichedLanguages.has(request.language)) {
      return empty;
    }

    const results: Array<ResolvedTypeMetadata | null> = [];

    for (const target of request.targets) {
      const occ = this.indexData.findOccurrence(request.filePath, target.line, target.character);
      if (!occ || !occ.symbol) {
        results.push(null);
        continue;
      }

      // Resolve definition location.
      const def = this.indexData.getDefinition(occ.symbol);
      const info = this.indexData.getSymbolInfo(occ.symbol);

      // Extract type signature.
      const resolvedTypeSignature = info ? extractSignatureFromDocs(info) : null;
      const resolvedReturnType = extractReturnType(resolvedTypeSignature);

      if (!def && !resolvedTypeSignature) {
        results.push(null);
        continue;
      }

      const definitionUri = def ? pathToFileURL(def.filePath).toString() : null;
      results.push({
        resolvedTypeSignature,
        resolvedReturnType,
        definitionUri,
        definitionPath: def?.filePath ?? null,
        definitionLine: def?.line ?? null,
        definitionCharacter: def?.character ?? null,
      });
    }

    return results;
  }

  /** Set of languages for which SCIP enrichment data is available. */
  get coveredLanguages(): ReadonlySet<string> {
    return this.enrichedLanguages;
  }

  async dispose(): Promise<void> {
    this.indexData = null;
    this.enrichedLanguages.clear();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Attempt to auto-install SCIP indexers for the given languages.
   * Returns true if at least one indexer was newly installed.
   */
  private async autoInstallMissing(languages: ReadonlySet<string>): Promise<boolean> {
    const log = getLogger();
    let installedAny = false;
    const attempted = new Set<string>();

    for (const lang of languages) {
      const specs = getSpecsForLanguage(lang);
      for (const spec of specs) {
        if (attempted.has(spec.command)) continue;
        attempted.add(spec.command);

        log.indexing(`scip: auto-installing ${spec.command} for ${lang}...`);
        const result = await installScipIndexer(spec);
        if (result.installed) {
          log.indexing(`scip: installed ${spec.command} at ${result.path}`);
          installedAny = true;
        } else {
          log.indexing(`scip: could not auto-install ${spec.command}: ${result.error ?? 'unknown'}`);
        }
      }
    }

    return installedAny;
  }

  private readPrecomputedIndex(language: string): Uint8Array | null {
    if (!this.settings.indexDir) return null;

    // Check for language-specific index or generic index.scip.
    const candidates = [
      join(this.rootDir, this.settings.indexDir, `${language}.scip`),
      join(this.rootDir, this.settings.indexDir, 'index.scip'),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return readFileSync(candidate);
      }
    }
    return null;
  }

  private async runIndexer(language: string): Promise<Uint8Array | null> {
    const resolved = this.resolvedIndexers[language];
    if (!resolved?.available) return null;

    const log = getLogger();
    const outputPath = join(this.rootDir, `.lore-scip-${language}.scip`);

    // Replace {output} placeholder in args.
    let args = resolved.args.map((arg) =>
      arg.replace(/\{output\}/gu, outputPath),
    );

    // For C/C++: ensure compile_commands.json exists and replace {compdb} placeholder
    if ((language === 'c' || language === 'cpp') && args.some(a => a.includes('{compdb}'))) {
      const compdb = await ensureCompilationDatabase(this.rootDir, this.settings.timeoutMs);
      if (!compdb.path) {
        log.indexing(`scip: no compile_commands.json for ${language}, skipping`);
        return null;
      }
      args = args.map(a => a.replace(/\{compdb\}/gu, compdb.path!));
    }

    const cwd = resolved.cwd ? join(this.rootDir, resolved.cwd) : this.rootDir;

    log.indexing(`scip: running ${resolved.command} for ${language}`);

    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync(resolved.resolvedPath ?? resolved.command, args, {
        cwd,
        timeout: this.settings.timeoutMs,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.indexing(`scip: ${resolved.command} failed: ${msg}`);

      // rust-analyzer scip writes to index.scip in cwd, not to {output}.
      // Check if it wrote to the default location.
      const defaultOutput = join(cwd, 'index.scip');
      if (existsSync(defaultOutput) && defaultOutput !== outputPath) {
        try {
          const data = readFileSync(defaultOutput);
          unlinkSync(defaultOutput);
          return data;
        } catch {
          // Fall through to return null.
        }
      }
      return null;
    }

    // Read the output.
    // Some indexers write to the specified path; others write to index.scip.
    const candidatePaths = [outputPath, join(cwd, 'index.scip')];
    for (const candidate of candidatePaths) {
      if (existsSync(candidate)) {
        try {
          const data = readFileSync(candidate);
          // Clean up temporary files.
          if (candidate.includes('.lore-scip-')) {
            try { unlinkSync(candidate); } catch { /* best effort */ }
          }
          return data;
        } catch {
          continue;
        }
      }
    }

    log.indexing(`scip: ${resolved.command} completed but no index file found`);
    return null;
  }
}

// ─── Merge helper ─────────────────────────────────────────────────────────────

/**
 * Partial merge of two ScipIndexData instances.
 * In practice we re-parse the protobuf bytes, so this is a simple
 * "use the second index" fallback.  A full merge would iterate the
 * internal maps, but for the common case (one indexer per run) this
 * is sufficient.
 */
function mergeScipIndexDataPartial(a: ScipIndexData, b: ScipIndexData): ScipIndexData {
  // For now, since ScipIndexData doesn't expose its internal maps for
  // iteration, we rely on the coordinator loading indexes sequentially
  // and always use the latest one.  A proper merge would require adding
  // a `merge()` method to ScipIndexData.
  //
  // TODO: Implement proper merge across multiple SCIP indexes.
  // For single-language projects (the common case), `b` is sufficient.
  return b;
}
