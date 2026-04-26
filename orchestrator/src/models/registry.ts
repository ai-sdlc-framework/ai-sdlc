/**
 * Model alias registry per RFC-0010 §11. Maps short aliases (haiku, sonnet, opus, opus[1m])
 * to physical model IDs and tracks deprecation lifecycle (deprecatedAt / removedAt /
 * replacementAlias). Resolution is performed once at pipeline-load and pinned per run
 * (RFC §11.1) so model swaps cannot occur underneath an in-flight pipeline.
 */

export interface ModelEntry {
  /** Short alias used in pipeline YAML (e.g., 'haiku'). */
  alias: string;
  /** Physical model ID dispatched to the harness (e.g., 'claude-haiku-4-5-20251001'). */
  modelId: string;
  /** ISO 8601 date when the vendor announced deprecation; null if active. */
  deprecatedAt: string | null;
  /** ISO 8601 date when the vendor will (or did) remove the model; null if not scheduled. */
  removedAt: string | null;
  /** Alias to migrate to when this entry is deprecated; required when deprecatedAt is set. */
  replacementAlias: string | null;
  /** Documentation hint, surfaced by cli-model-bump. */
  use?: string;
}

export interface ResolutionContext {
  /** Source of `now` for deprecation comparisons; defaults to system clock. */
  now?: () => Date;
}

export type ResolutionEvent =
  | { type: 'ok'; alias: string; modelId: string }
  | {
      type: 'ModelDeprecated';
      alias: string;
      modelId: string;
      removedAt: string | null;
      replacementAlias: string | null;
    }
  | { type: 'ModelDeprecationGracePeriod'; alias: string; removedAt: string };

export interface ResolutionResult {
  modelId: string;
  events: ResolutionEvent[];
}

export class ModelRemovedError extends Error {
  constructor(
    public readonly alias: string,
    public readonly modelId: string,
    public readonly removedAt: string,
  ) {
    super(`Model alias '${alias}' resolves to '${modelId}', which was removed at ${removedAt}`);
    this.name = 'ModelRemovedError';
  }
}

export class UnknownAliasError extends Error {
  constructor(public readonly alias: string) {
    super(`Unknown model alias: ${alias}`);
    this.name = 'UnknownAliasError';
  }
}

const GRACE_PERIOD_DAYS = 30;

/**
 * Default registry shipped with the orchestrator. Maintainers update deprecatedAt /
 * removedAt / replacementAlias from public vendor announcements (see operator-runbook).
 */
export const DEFAULT_REGISTRY: readonly ModelEntry[] = [
  {
    alias: 'haiku',
    modelId: 'claude-haiku-4-5-20251001',
    deprecatedAt: null,
    removedAt: null,
    replacementAlias: null,
    use: 'Classification, routing, formatting, structured-output extraction',
  },
  {
    alias: 'sonnet',
    modelId: 'claude-sonnet-4-6',
    deprecatedAt: null,
    removedAt: null,
    replacementAlias: null,
    use: 'Code review, refactoring, validation, default for everything else',
  },
  {
    alias: 'opus',
    modelId: 'claude-opus-4-7',
    deprecatedAt: null,
    removedAt: null,
    replacementAlias: null,
    use: 'Complex implementation, multi-file refactors, design work',
  },
  {
    alias: 'opus[1m]',
    modelId: 'claude-opus-4-7[1m]',
    deprecatedAt: null,
    removedAt: null,
    replacementAlias: null,
    use: 'Implementation against a large codebase context (>200K tokens)',
  },
];

export class ModelRegistry {
  private readonly entries: Map<string, ModelEntry>;

  constructor(entries: readonly ModelEntry[] = DEFAULT_REGISTRY) {
    this.entries = new Map(entries.map((e) => [e.alias, { ...e }]));
  }

  list(): ModelEntry[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e }));
  }

  get(alias: string): ModelEntry | undefined {
    const e = this.entries.get(alias);
    return e ? { ...e } : undefined;
  }

  /**
   * Resolve an alias to a physical model ID at pipeline-load. Throws ModelRemovedError
   * if the model has been removed; emits ModelDeprecated event otherwise (informational).
   * Within `GRACE_PERIOD_DAYS` of the removal date, additionally emits
   * ModelDeprecationGracePeriod for escalated operator notification.
   */
  resolve(alias: string, ctx: ResolutionContext = {}): ResolutionResult {
    const entry = this.entries.get(alias);
    if (!entry) throw new UnknownAliasError(alias);

    const now = (ctx.now ?? (() => new Date()))();
    const events: ResolutionEvent[] = [];

    if (entry.removedAt) {
      const removedAt = new Date(entry.removedAt);
      if (now.getTime() >= removedAt.getTime()) {
        throw new ModelRemovedError(alias, entry.modelId, entry.removedAt);
      }
    }

    if (entry.deprecatedAt) {
      const deprecatedAt = new Date(entry.deprecatedAt);
      if (now.getTime() >= deprecatedAt.getTime()) {
        events.push({
          type: 'ModelDeprecated',
          alias,
          modelId: entry.modelId,
          removedAt: entry.removedAt,
          replacementAlias: entry.replacementAlias,
        });
        if (entry.removedAt) {
          const removedAt = new Date(entry.removedAt);
          const graceCutoff = removedAt.getTime() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
          if (now.getTime() >= graceCutoff) {
            events.push({
              type: 'ModelDeprecationGracePeriod',
              alias,
              removedAt: entry.removedAt,
            });
          }
        }
      }
    }

    if (events.length === 0) {
      events.push({ type: 'ok', alias, modelId: entry.modelId });
    }

    return { modelId: entry.modelId, events };
  }

  /**
   * Bulk-resolve a set of stage aliases. Emits one ResolutionResult per (stage, alias).
   * Used at pipeline-load to pin model resolution for the whole pipeline run.
   */
  resolveAll(
    stageAliases: ReadonlyArray<{ stage: string; alias: string }>,
    ctx: ResolutionContext = {},
  ): Map<string, ResolutionResult> {
    const out = new Map<string, ResolutionResult>();
    for (const { stage, alias } of stageAliases) {
      out.set(stage, this.resolve(alias, ctx));
    }
    return out;
  }

  /**
   * Operator-facing dry-run helper: for each currently deprecated alias, report what
   * would happen if a pipeline started today. Used by cli-model-bump --dry-run.
   */
  bumpPlan(
    stageAliases: ReadonlyArray<{ stage: string; alias: string }>,
    ctx: ResolutionContext = {},
  ): Array<{
    stage: string;
    alias: string;
    currentModelId: string;
    deprecatedAt: string | null;
    removedAt: string | null;
    replacementAlias: string | null;
    replacementModelId: string | null;
    inGracePeriod: boolean;
  }> {
    const now = (ctx.now ?? (() => new Date()))();
    const result = [];
    for (const { stage, alias } of stageAliases) {
      const entry = this.entries.get(alias);
      if (!entry || !entry.deprecatedAt) continue;
      if (new Date(entry.deprecatedAt).getTime() > now.getTime()) continue;
      let replacementModelId: string | null = null;
      if (entry.replacementAlias) {
        const replacement = this.entries.get(entry.replacementAlias);
        replacementModelId = replacement?.modelId ?? null;
      }
      let inGracePeriod = false;
      if (entry.removedAt) {
        const removedAt = new Date(entry.removedAt);
        const graceCutoff = removedAt.getTime() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
        inGracePeriod = now.getTime() >= graceCutoff;
      }
      result.push({
        stage,
        alias,
        currentModelId: entry.modelId,
        deprecatedAt: entry.deprecatedAt,
        removedAt: entry.removedAt,
        replacementAlias: entry.replacementAlias,
        replacementModelId,
        inGracePeriod,
      });
    }
    return result;
  }
}
