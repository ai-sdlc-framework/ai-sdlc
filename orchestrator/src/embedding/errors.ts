/**
 * Error classes for the embedding adapter framework per RFC-0019 §11.
 *
 * Error hierarchy:
 *   EmbeddingError (base)
 *   ├── UnknownEmbeddingProvider   — registry miss (fail-fast at pipeline-load)
 *   ├── EmbeddingProviderUnavailable — isAvailable() returned false
 *   ├── EmbeddingProviderError     — upstream API error during embed()
 *   ├── EmbeddingDimensionMismatch — vector length != adapter.dimensions
 *   ├── EmbeddingModelDeprecating  — deprecation warning (not fatal)
 *   ├── EmbeddingModelDeprecated   — deprecated error (fatal in strict mode)
 *   └── EmbeddingModelRemoved      — past removedAt (always fatal)
 */

/**
 * Base class for all embedding framework errors.
 */
export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/**
 * Thrown by getEmbeddingAdapter() when the requested adapter name
 * is not present in the registry. Pipeline-load fails with this error
 * so operator typos are caught at load time, not at first embed() call.
 */
export class UnknownEmbeddingProvider extends EmbeddingError {
  constructor(
    public readonly requestedName: string,
    public readonly availableNames: string[],
  ) {
    super(
      `Unknown embedding provider '${requestedName}'. ` +
        `Available providers: [${availableNames.join(', ')}]. ` +
        `Register the adapter in orchestrator/src/embedding/registry.ts or check your spelling.`,
    );
    this.name = 'UnknownEmbeddingProvider';
  }
}

/**
 * Thrown by the orchestrator when adapter.isAvailable() returns { available: false }.
 * Pipeline-load fails with this error naming the reason and detail from the probe.
 */
export class EmbeddingProviderUnavailable extends EmbeddingError {
  constructor(
    public readonly adapterName: string,
    public readonly reason: string,
    public readonly detail?: string,
  ) {
    super(
      `Embedding provider '${adapterName}' is unavailable (reason: ${reason}).` +
        (detail ? ` ${detail}` : ''),
    );
    this.name = 'EmbeddingProviderUnavailable';
  }
}

/**
 * Thrown by adapter.embed() when the upstream API returns an error.
 * Wraps the provider-specific error detail for operator-facing diagnostics.
 */
export class EmbeddingProviderError extends EmbeddingError {
  constructor(
    public readonly adapterName: string,
    public readonly detail: string,
    cause?: unknown,
  ) {
    super(`Embedding provider '${adapterName}' returned an error: ${detail}`);
    this.name = 'EmbeddingProviderError';
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * Thrown when the vector returned by embed() has a different length than
 * adapter.dimensions. Indicates an adapter implementation bug or provider
 * configuration drift.
 */
export class EmbeddingDimensionMismatch extends EmbeddingError {
  constructor(
    public readonly adapterName: string,
    public readonly expectedDimensions: number,
    public readonly actualDimensions: number,
  ) {
    super(
      `Dimension mismatch for adapter '${adapterName}': ` +
        `expected ${expectedDimensions} dimensions but got ${actualDimensions}. ` +
        `This indicates a provider configuration change or adapter implementation bug.`,
    );
    this.name = 'EmbeddingDimensionMismatch';
  }
}

/**
 * Emitted as a warning (not thrown) when today is within 90 days of adapter.deprecatedAt.
 * Adapter still functions normally during the warning period.
 */
export class EmbeddingModelDeprecating extends EmbeddingError {
  constructor(
    public readonly adapterName: string,
    public readonly deprecatedAt: string,
    public readonly replacementAlias?: string,
  ) {
    super(
      `Embedding adapter '${adapterName}' will be deprecated on ${deprecatedAt}. ` +
        (replacementAlias
          ? `Migrate to '${replacementAlias}' using: cli-embedding-bump --to ${replacementAlias}`
          : 'No replacement alias declared — check the adapter documentation.'),
    );
    this.name = 'EmbeddingModelDeprecating';
  }
}

/**
 * Thrown when today >= adapter.deprecatedAt (in strict mode) or emitted as a
 * warning (in default mode). Adapter still functions in non-strict mode.
 */
export class EmbeddingModelDeprecated extends EmbeddingError {
  constructor(
    public readonly adapterName: string,
    public readonly deprecatedAt: string,
    public readonly replacementAlias?: string,
  ) {
    super(
      `Embedding adapter '${adapterName}' was deprecated on ${deprecatedAt}. ` +
        (replacementAlias
          ? `Run: cli-embedding-bump --to ${replacementAlias}`
          : 'No replacement alias declared — check the adapter documentation.'),
    );
    this.name = 'EmbeddingModelDeprecated';
  }
}

/**
 * Always fatal. Thrown when today >= adapter.removedAt.
 * Pipeline-load fails and the operator MUST run cli-embedding-bump to migrate.
 */
export class EmbeddingModelRemoved extends EmbeddingError {
  constructor(
    public readonly adapterName: string,
    public readonly removedAt: string,
    public readonly replacementAlias?: string,
  ) {
    super(
      `Embedding adapter '${adapterName}' was removed on ${removedAt} and can no longer be used. ` +
        (replacementAlias
          ? `Migrate by running: cli-embedding-bump --to ${replacementAlias}`
          : 'No replacement alias declared — check the adapter documentation.'),
    );
    this.name = 'EmbeddingModelRemoved';
  }
}
