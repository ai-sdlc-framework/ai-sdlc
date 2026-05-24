/**
 * Default embedding adapter: openai-text-embedding-3-small per RFC-0019 §7.
 *
 * Model: text-embedding-3-small (OpenAI, snapshot 2024-01-25)
 * Dimensions: 1536
 * Max input: 8191 tokens
 * Batch: up to 2048 inputs per call
 * Billing: pay-per-token at ~$0.02 / 1M tokens
 *
 * Why text-embedding-3-small over -large:
 * At $0.02/1M tokens, a 10K-token corpus re-embed costs ~$0.0002. The -large
 * variant is 6.5x more expensive for marginal quality improvement on the
 * short-text drift detection use case (RFC-0009 OQ-6). Adopters with
 * quality-sensitive use cases MAY register the -large variant.
 *
 * Why snapshot 2024-01-25:
 * Most recent stable snapshot as of RFC-0019 authoring. Pinning the snapshot
 * date makes adapter upgrades a code change (visible in PR review) rather
 * than a silent provider-side rollout. OpenAI has silently changed
 * text-embedding-ada-002 behavior in the past — explicit pinning prevents that.
 */

import { createHash } from 'node:crypto';
import type {
  EmbeddingAdapter,
  EmbeddingAvailability,
  EmbeddingCapabilities,
  EmbeddingRequires,
} from '../types.js';
import { EmbeddingProviderError, EmbeddingDimensionMismatch } from '../errors.js';
import type { EmbeddingCostRecord } from '../types.js';

/** OpenAI /v1/embeddings response shape (subset used here). */
interface OpenAIEmbeddingsResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/** Cost rate for text-embedding-3-small as of 2024-01-25. */
const COST_PER_TOKEN_USD = 0.02 / 1_000_000; // $0.02 per 1M tokens

/** Maximum inputs per batch call (OpenAI API limit). */
const MAX_BATCH_SIZE = 2048;

/**
 * Callback invoked by the adapter after each embed() / embedBatch() call
 * with cost attribution data. The orchestrator wires this to CostTracker.
 * Decoupled from CostTracker directly so the adapter can be unit-tested
 * without a StateStore dependency.
 */
export type EmbeddingCostCallback = (record: EmbeddingCostRecord) => void;

export class OpenAITextEmbedding3Small implements EmbeddingAdapter {
  readonly name = 'openai-text-embedding-3-small';
  readonly modelId = 'text-embedding-3-small';
  readonly modelVersion = '2024-01-25';
  readonly dimensions = 1536;

  readonly capabilities: EmbeddingCapabilities = {
    dimensions: 1536,
    maxInputTokens: 8191,
    supportsBatching: true,
    selfHosted: false,
    billingModel: 'pay-per-token',
    approxCostPer1MTokens: 0.02,
  };

  readonly requires: EmbeddingRequires = {
    envVar: 'OPENAI_API_KEY',
  };

  /** Optional cost-tracking callback. Set by the orchestrator after adapter instantiation. */
  private costCallback?: EmbeddingCostCallback;

  constructor(costCallback?: EmbeddingCostCallback) {
    this.costCallback = costCallback;
  }

  /**
   * Wire a cost-tracking callback after construction.
   * Called by the orchestrator when it has a CostTracker available.
   */
  setCostCallback(callback: EmbeddingCostCallback): void {
    this.costCallback = callback;
  }

  async isAvailable(): Promise<EmbeddingAvailability> {
    if (!process.env.OPENAI_API_KEY) {
      return {
        available: false,
        reason: 'env-var-missing',
        detail: 'OPENAI_API_KEY not set; openai-text-embedding-3-small requires it.',
      };
    }
    return { available: true };
  }

  async getAccountId(): Promise<string | null> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    // One-way derivation: SHA-256 of '<adapter-name>:<api-key>'.
    // MUST NOT leak the credential.
    return createHash('sha256').update(`${this.name}:${key}`).digest('hex');
  }

  /**
   * Embed a single text string.
   *
   * @param text - Source text. MUST be non-empty.
   * @param consumerLabel - Cost attribution label (default: 'unspecified').
   *   Examples: 'rfc-0009-tessellation-drift', 'rfc-0008-ppa-similarity'.
   */
  async embed(text: string, consumerLabel = 'unspecified'): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      throw new EmbeddingProviderError(
        this.name,
        'embed(): empty input rejected — pass non-empty text.',
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new EmbeddingProviderError(
        this.name,
        'OPENAI_API_KEY is not set. Call isAvailable() before embed().',
      );
    }

    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.modelId,
        input: text,
        encoding_format: 'float',
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      throw new EmbeddingProviderError(
        this.name,
        `OpenAI /v1/embeddings returned HTTP ${response.status}: ${body}`,
      );
    }

    const data = (await response.json()) as OpenAIEmbeddingsResponse;
    const vector = data.data[0]?.embedding;

    if (!vector) {
      throw new EmbeddingProviderError(
        this.name,
        'OpenAI /v1/embeddings response contained no embedding in data[0].',
      );
    }

    if (vector.length !== this.dimensions) {
      throw new EmbeddingDimensionMismatch(this.name, this.dimensions, vector.length);
    }

    await this._recordCost(data.usage.total_tokens, consumerLabel);

    return vector;
  }

  /**
   * Embed a batch of texts.
   * OpenAI accepts up to 2048 inputs per call; this method chunks above that.
   * Input order is preserved in the returned array.
   *
   * @param texts - Array of source texts. Each MUST be non-empty.
   * @param consumerLabel - Cost attribution label (applies to all texts in batch).
   */
  async embedBatch(texts: string[], consumerLabel = 'unspecified'): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    for (const t of texts) {
      if (!t || t.trim().length === 0) {
        throw new EmbeddingProviderError(
          this.name,
          'embedBatch(): empty string in input array rejected — all texts must be non-empty.',
        );
      }
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new EmbeddingProviderError(
        this.name,
        'OPENAI_API_KEY is not set. Call isAvailable() before embedBatch().',
      );
    }

    const results: number[][] = [];

    // Chunk into MAX_BATCH_SIZE slices to respect the OpenAI API limit.
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const chunk = texts.slice(i, i + MAX_BATCH_SIZE);

      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.modelId,
          input: chunk,
          encoding_format: 'float',
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '(unreadable)');
        throw new EmbeddingProviderError(
          this.name,
          `OpenAI /v1/embeddings returned HTTP ${response.status} on batch chunk [${i}, ${i + chunk.length}): ${body}`,
        );
      }

      const data = (await response.json()) as OpenAIEmbeddingsResponse;

      // OpenAI returns data sorted by index — preserve input order.
      const sorted = [...data.data].sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        if (item.embedding.length !== this.dimensions) {
          throw new EmbeddingDimensionMismatch(this.name, this.dimensions, item.embedding.length);
        }
        results.push(item.embedding);
      }

      await this._recordCost(data.usage.total_tokens, consumerLabel);
    }

    return results;
  }

  /**
   * Record a cost event via the cost callback.
   * No-op when no callback is wired (e.g., in unit tests without a CostTracker).
   */
  private async _recordCost(tokens: number, consumerLabel: string): Promise<void> {
    if (!this.costCallback) return;

    const accountId = await this.getAccountId();
    const costRecord: EmbeddingCostRecord = {
      provider: this.name,
      modelVersion: this.modelVersion,
      accountId,
      consumerLabel,
      tokens,
      costUsd: tokens * COST_PER_TOKEN_USD,
      billingModel: 'pay-per-token',
    };

    this.costCallback(costRecord);
  }
}
