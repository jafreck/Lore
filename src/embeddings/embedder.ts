/**
 * @module indexer/embedder
 *
 * Provides an `EmbeddingProvider` abstraction for generating dense vector
 * embeddings from text. The primary implementation (`TransformersJsProvider`)
 * uses the `@huggingface/transformers` library to run ONNX models natively
 * in Node.js — no Python or external processes required.
 *
 * The model's embedding dimensionality is auto-detected at startup by
 * embedding a probe sentence and inspecting the output shape.
 */

import { createHash } from 'node:crypto';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  /** Embed a batch of texts; returns one float vector per input. */
  embed(texts: string[]): Promise<number[][]>;
  /** Human-readable model identifier. */
  readonly modelName: string;
  /**
   * Dimensionality of the returned vectors.
   * Only valid after `init()` resolves (throws before that).
   */
  readonly dims: number;
  /**
   * Load the model and detect dimensionality.
   * Must be called (and awaited) before the first `embed()` call.
   */
  init(): Promise<void>;
  /** Release the underlying resources. */
  dispose(): Promise<void>;
}

export interface StructuralEmbeddingInput {
  name: string;
  signature: string | null;
  resolvedTypeSignature?: string | null;
  resolvedReturnType?: string | null;
}

export function buildStructuralEmbeddingText(input: StructuralEmbeddingInput): string {
  const parts = [
    input.signature?.trim() ?? '',
    input.resolvedTypeSignature?.trim() ?? '',
    input.resolvedReturnType?.trim() ?? '',
    input.name.trim(),
  ].filter((part) => part.length > 0);
  const uniqueParts = [...new Set(parts)];
  return uniqueParts.join('\n');
}

/** SHA-256 hex hash of an embedding input text (used for skip-unchanged logic). */
export function hashEmbeddingText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ─── Token-aware batching ─────────────────────────────────────────────────────

/**
 * Approximate token count for a text string.
 * Uses the ~4 chars/token heuristic (reasonable for code/English).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Maximum total tokens per embedding batch.  Larger batches amortise
 * call overhead but Transformers.js pads every item to the longest in the
 * batch, so one very long text inflates memory for the whole batch.
 *
 * 32 768 tokens ≈ 128 KB of text — keeps peak memory reasonable while
 * avoiding pathological padding waste.
 */
const MAX_BATCH_TOKENS = 32_768;

/** Absolute cap on items per batch (avoids degenerate cases with many tiny texts). */
const MAX_BATCH_ITEMS = 512;

/**
 * Split `items` into token-budget-aware batches.
 *
 * Each batch stays within `MAX_BATCH_TOKENS` total estimated tokens and
 * `MAX_BATCH_ITEMS` items.  An individual item that exceeds the token
 * budget gets its own single-item batch.
 */
export function tokenAwareBatch<T>(items: T[], getText: (item: T) => string): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;

  for (const item of items) {
    const tokens = estimateTokens(getText(item));
    if (current.length > 0 && (currentTokens + tokens > MAX_BATCH_TOKENS || current.length >= MAX_BATCH_ITEMS)) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ─── Transformers.js implementation ───────────────────────────────────────────

/** Lazy-imported pipeline factory type from @huggingface/transformers. */
type PipelineFn = typeof import('@huggingface/transformers').pipeline;
/** The feature-extraction pipeline returned by `pipeline(...)`. */
type FeatureExtractionPipeline = Awaited<ReturnType<PipelineFn>>;

/** ONNX quantization level for model loading. */
export type OnnxDtype = 'fp32' | 'fp16' | 'q8' | 'q4';

/**
 * Generates embeddings using `@huggingface/transformers` (Transformers.js).
 * Runs ONNX models natively in Node — zero Python dependency.
 *
 * Auto-detects the best available ONNX execution provider:
 *   - `cpu` (always available; only option on macOS with transformers.js v3)
 *   - `cuda` on Linux x64 with NVIDIA GPU (requires transformers.js v4+)
 *   - `dml` (DirectML) on Windows (requires transformers.js v4+)
 *
 * Override via `LORE_EMBED_DEVICE` env var (e.g. `cpu`, `cuda`, `dml`).
 * Override quantization via `LORE_EMBED_DTYPE` env var (e.g. `q8`, `q4`, `fp16`).
 *
 * Call `init()` first to download/load the model and detect its embedding
 * dimensionality. The model is kept in memory for the provider's lifetime.
 */
export class TransformersJsProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dtype: OnnxDtype;
  private _dims: number | null = null;
  private _device: string | null = null;
  private _pipeline: FeatureExtractionPipeline | null = null;
  private initialized = false;

  constructor(modelName: string, dtype?: OnnxDtype) {
    this.modelName = modelName;
    this.dtype = dtype ?? (process.env['LORE_EMBED_DTYPE'] as OnnxDtype | undefined) ?? 'q8';
  }

  /** Embedding dimensionality — available only after `init()`. */
  get dims(): number {
    if (this._dims === null) {
      throw new Error('EmbeddingProvider not initialised — call init() first');
    }
    return this._dims;
  }

  /** ONNX execution provider selected during init. */
  get device(): string {
    return this._device ?? 'unknown';
  }

  /**
   * Load the model via Transformers.js and detect embedding dimensionality
   * by running a single probe sentence.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const preferredDevice = this.detectDevice();
    const { pipeline } = await import('@huggingface/transformers');

    // Try the preferred device, fall back to CPU if unsupported
    let device = preferredDevice;
    try {
      this._pipeline = await (pipeline as PipelineFn)(
        'feature-extraction',
        this.modelName,
        {
          device: device as 'cpu',
          ...(this.dtype !== 'fp32' && { dtype: this.dtype }),
        },
      );
    } catch (err: unknown) {
      if (device !== 'cpu' && err instanceof Error && err.message.includes('Unsupported device')) {
        device = 'cpu';
        this._pipeline = await (pipeline as PipelineFn)(
          'feature-extraction',
          this.modelName,
          {
            device: 'cpu',
            ...(this.dtype !== 'fp32' && { dtype: this.dtype }),
          },
        );
      } else {
        throw err;
      }
    }
    this._device = device;

    // Probe the model to detect dimensionality.
    const probe = await this._pipeline('dimensionality probe', { pooling: 'mean', normalize: true });
    const probeList = (probe as { tolist(): number[][] }).tolist();
    this._dims = probeList[0]!.length;
    this.initialized = true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.initialized || !this._pipeline) {
      throw new Error('EmbeddingProvider not initialised — call init() first');
    }
    const output = await this._pipeline(texts, { pooling: 'mean', normalize: true });
    return (output as { tolist(): number[][] }).tolist();
  }

  async dispose(): Promise<void> {
    if (this._pipeline) {
      try {
        await (this._pipeline as unknown as { dispose?: () => Promise<void> }).dispose?.();
      } catch { /* best-effort cleanup */ }
      this._pipeline = null;
    }
  }

  /**
   * Detect the best available ONNX execution provider.
   * Respects `LORE_EMBED_DEVICE` env var for explicit override.
   *
   * Transformers.js v3 / onnxruntime-node 1.21 only supports CPU on all
   * platforms. GPU providers (CoreML, CUDA, DirectML) require v4+.
   */
  private detectDevice(): string {
    const envDevice = process.env['LORE_EMBED_DEVICE'];
    if (envDevice) return envDevice;
    return 'cpu';
  }
}

// ─── Lazy embedding provider ──────────────────────────────────────────────────

/**
 * Wraps a `TransformersJsProvider` with deferred initialisation.
 *
 * The model is only downloaded and loaded on the first call to `embed()` or
 * an explicit `init()`.  This allows `lore index` to complete faster when
 * embeddings are configured but the user primarily uses structural search.
 *
 * The MCP server can pass a `LazyEmbeddingProvider` so semantic search
 * triggers model loading on-demand rather than at startup.
 */
export class LazyEmbeddingProvider implements EmbeddingProvider {
  private readonly inner: TransformersJsProvider;
  private _initPromise: Promise<void> | null = null;

  constructor(modelName: string, dtype?: OnnxDtype) {
    this.inner = new TransformersJsProvider(modelName, dtype);
  }

  get modelName(): string { return this.inner.modelName; }

  get dims(): number { return this.inner.dims; }

  async init(): Promise<void> {
    if (!this._initPromise) {
      this._initPromise = this.inner.init();
    }
    return this._initPromise;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    await this.init();
    return this.inner.embed(texts);
  }

  async dispose(): Promise<void> {
    if (this._initPromise) {
      try { await this._initPromise; } catch { /* init may have failed */ }
    }
    return this.inner.dispose();
  }
}

// ─── Default model ────────────────────────────────────────────────────────────

/**
 * Default embedding model — the ONNX-community variant of Qwen3-Embedding-0.6B
 * ships pre-converted ONNX weights compatible with all execution providers
 * (cpu, cuda, dml). 1024-dim, strong multilingual and code understanding.
 */
export const DEFAULT_EMBEDDING_MODEL = 'onnx-community/Qwen3-Embedding-0.6B-ONNX';
