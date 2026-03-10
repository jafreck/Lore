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

// ─── Transformers.js implementation ───────────────────────────────────────────

/** Lazy-imported pipeline factory type from @huggingface/transformers. */
type PipelineFn = typeof import('@huggingface/transformers').pipeline;
/** The feature-extraction pipeline returned by `pipeline(...)`. */
type FeatureExtractionPipeline = Awaited<ReturnType<PipelineFn>>;

/**
 * Generates embeddings using `@huggingface/transformers` (Transformers.js).
 * Runs ONNX models natively in Node — zero Python dependency.
 *
 * Call `init()` first to download/load the model and detect its embedding
 * dimensionality. The model is kept in memory for the provider's lifetime.
 */
export class TransformersJsProvider implements EmbeddingProvider {
  readonly modelName: string;
  private _dims: number | null = null;
  private _pipeline: FeatureExtractionPipeline | null = null;
  private initialized = false;

  constructor(modelName: string) {
    this.modelName = modelName;
  }

  /** Embedding dimensionality — available only after `init()`. */
  get dims(): number {
    if (this._dims === null) {
      throw new Error('EmbeddingProvider not initialised — call init() first');
    }
    return this._dims;
  }

  /**
   * Load the model via Transformers.js and detect embedding dimensionality
   * by running a single probe sentence.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const { pipeline } = await import('@huggingface/transformers');
    this._pipeline = await (pipeline as PipelineFn)('feature-extraction', this.modelName);

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
}

// ─── Default model ────────────────────────────────────────────────────────────

/**
 * Default embedding model — `nomic-ai/nomic-embed-text-v1.5` is a high-quality,
 * 768-dim model with ONNX weights pre-packaged for Transformers.js.
 * Supports Matryoshka dimensions (768, 512, 256, 128, 64).
 */
export const DEFAULT_EMBEDDING_MODEL = 'nomic-ai/nomic-embed-text-v1.5';
