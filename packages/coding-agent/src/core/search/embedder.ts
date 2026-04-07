/**
 * Embedding pipeline using all-MiniLM-L6-v2 via @huggingface/transformers.
 *
 * Generates 384-dimensional normalized embeddings for semantic search.
 * First use downloads the model (~23MB) to the configured cache directory.
 */

import type { IndexProgressCallback } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface EmbedderOptions {
	/** Absolute path to the model cache directory (e.g. ~/.dreb/agent/models/). */
	modelCacheDir: string;
	/** HuggingFace model name. Default: 'Xenova/all-MiniLM-L6-v2'. */
	modelName?: string;
	/** Number of texts to embed per batch. Default: 32. */
	batchSize?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_BATCH_SIZE = 32;
const EMBEDDING_DIMENSION = 384;

/**
 * Model-specific prefixes for document vs query embeddings.
 * nomic-embed-text-v1.5 requires these; most other models don't.
 */
const MODEL_PREFIXES: Record<string, { document: string; query: string }> = {
	"nomic-ai/nomic-embed-text-v1.5": { document: "search_document: ", query: "search_query: " },
};

// ============================================================================
// Embedder
// ============================================================================

export class Embedder {
	private readonly modelCacheDir: string;
	private readonly modelName: string;
	private readonly batchSize: number;
	private extractor: any | null = null;

	constructor(options: EmbedderOptions) {
		this.modelCacheDir = options.modelCacheDir;
		this.modelName = options.modelName ?? DEFAULT_MODEL_NAME;
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
	}

	/**
	 * Initialize the model pipeline. Must be called before embedding.
	 *
	 * On first use this downloads the ONNX model to `modelCacheDir`.
	 * Subsequent calls reuse the cached model.
	 */
	async initialize(): Promise<void> {
		if (this.extractor) return;

		// Dynamic import — @huggingface/transformers is a heavy dependency
		const { pipeline, env } = await import("@huggingface/transformers");

		// Direct the model cache to our managed directory
		env.cacheDir = this.modelCacheDir;

		// Suppress the onnxruntime native addon warning — WASM fallback is fine
		// The library tries to load native onnxruntime first and logs a warning
		// when it falls back to WASM. We suppress this to avoid confusing users.
		const originalWarn = console.warn;
		console.warn = (...args: any[]) => {
			const msg = typeof args[0] === "string" ? args[0] : "";
			if (msg.includes("onnxruntime") || msg.includes("ONNX")) return;
			originalWarn.apply(console, args);
		};

		try {
			this.extractor = await pipeline("feature-extraction", this.modelName, {
				dtype: "q8" as any,
				device: "cpu" as any,
			});
		} finally {
			console.warn = originalWarn;
		}
	}

	/**
	 * Embed documents for indexing.
	 *
	 * Applies model-specific prefixes if required, then processes texts
	 * in batches of `batchSize` for memory efficiency.
	 */
	async embedDocuments(texts: string[], onProgress?: IndexProgressCallback): Promise<Float32Array[]> {
		this.ensureInitialized();

		const results: Float32Array[] = [];
		const total = texts.length;
		const prefix = MODEL_PREFIXES[this.modelName]?.document ?? "";

		for (let i = 0; i < total; i += this.batchSize) {
			const batch = texts.slice(i, i + this.batchSize);
			const prefixed = prefix ? batch.map((t) => prefix + t) : batch;

			const output = await this.extractor!(prefixed, {
				pooling: "mean",
				normalize: true,
			});

			// output.data is a flat Float32Array of shape [batchLen, EMBEDDING_DIMENSION]
			const data: Float32Array = output.data;
			for (let j = 0; j < batch.length; j++) {
				const start = j * EMBEDDING_DIMENSION;
				results.push(data.slice(start, start + EMBEDDING_DIMENSION));
			}

			if (onProgress) {
				onProgress("embedding", Math.min(i + batch.length, total), total);
			}
		}

		return results;
	}

	/**
	 * Embed a query for search.
	 *
	 * Applies model-specific query prefix if required.
	 */
	async embedQuery(query: string): Promise<Float32Array> {
		this.ensureInitialized();

		const prefix = MODEL_PREFIXES[this.modelName]?.query ?? "";
		const output = await this.extractor!(prefix + query, {
			pooling: "mean",
			normalize: true,
		});

		// Single input — output.data is Float32Array of shape [1, EMBEDDING_DIMENSION]
		return new Float32Array(output.data);
	}

	/** Get the embedding dimension (384 for all-MiniLM-L6-v2, 768 for nomic). */
	get dimension(): number {
		return EMBEDDING_DIMENSION;
	}

	/** Dispose the pipeline to free memory. */
	dispose(): void {
		if (this.extractor) {
			// The pipeline object may have a dispose method depending on the version
			if (typeof this.extractor.dispose === "function") {
				this.extractor.dispose();
			}
			this.extractor = null;
		}
	}

	/** Throw if initialize() hasn't been called yet. */
	private ensureInitialized(): void {
		if (!this.extractor) {
			throw new Error("Embedder not initialized. Call initialize() first.");
		}
	}
}
