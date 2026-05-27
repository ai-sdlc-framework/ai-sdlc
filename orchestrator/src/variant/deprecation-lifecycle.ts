/**
 * RFC-0017 Phase 3 — Variant deprecation lifecycle (OQ-3 resolution).
 *
 * Implements the three catalog-routed lifecycle states:
 *
 *   1. **Deprecation declared** → emits `Decision: variant-deprecation-declared`
 *      (log to catalog; no operator interrupt — per RFC-0035 G0 non-blocking contract).
 *
 *   2. **Approaching removal** (default 7d before removalDate; per-org configurable)
 *      → emits `Decision: variant-deprecation-approaching`
 *      → operator batch review surface.
 *
 *   3. **At removal date with consumers still referencing**
 *      → emits `Decision: variant-removal-consumers-pending`
 *      → auto-action: keep variant in degraded mode (don't break consumers)
 *        + emit migration tasks to consumer owners
 *        + surface to operator.
 *
 * All transitions route through RFC-0035 G0 (non-blocking pipeline contract).
 * Pipeline NEVER halts on any lifecycle transition (AC #3).
 *
 * 30-day default deprecation window; per-Soul `deprecationWindowDays` override
 * via `variant-config.yaml` (OQ-3 resolution, RFC-0017 §10.1).
 *
 * @see spec/rfcs/RFC-0017-in-soul-variant-pattern.md §6.3 + OQ-3
 * @see spec/rfcs/RFC-0035-decision-catalog-operator-routing.md G0
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default deprecation window in days (OQ-3 resolution: internal-config cadence). */
export const DEFAULT_DEPRECATION_WINDOW_DAYS = 30;

/**
 * Default approaching-removal window in days. Alerts fire when the remaining
 * time to `removalDate` drops below this threshold (per-org configurable).
 */
export const DEFAULT_APPROACHING_WINDOW_DAYS = 7;

// ── Lifecycle state enum ──────────────────────────────────────────────────────

/**
 * The three deprecation lifecycle states for a declared variant.
 *
 * - `'declared'`         — Deprecation has been declared; pipeline continues unchanged.
 * - `'approaching'`      — Within the approaching-removal window (default 7d).
 * - `'removal-pending'`  — At (or past) removalDate with active consumers still referencing.
 *                          Variant enters degraded mode; migration tasks emitted.
 * - `'removed'`          — No active consumers remain; variant safe to remove.
 */
export type VariantDeprecationState = 'declared' | 'approaching' | 'removal-pending' | 'removed';

// ── Decision kinds ────────────────────────────────────────────────────────────

/**
 * Decision summary keys emitted to the RFC-0035 Decision Catalog.
 * These are the catalog-routed keys per OQ-3 resolution (2026-05-18).
 */
export type VariantDeprecationDecisionKind =
  | 'variant-deprecation-declared'
  | 'variant-deprecation-approaching'
  | 'variant-removal-consumers-pending';

// ── Input shapes ──────────────────────────────────────────────────────────────

/**
 * Per-org / per-Soul lifecycle configuration (RFC-0017 §10.1 `variant.lifecycle`).
 * Loaded from `.ai-sdlc/variant-config.yaml` with per-Soul overrides.
 */
export interface VariantLifecycleConfig {
  /** Default deprecation window in days. Defaults to {@link DEFAULT_DEPRECATION_WINDOW_DAYS}. */
  deprecationWindowDays?: number;
  /** Days before removalDate when approaching-removal Decision fires. Defaults to {@link DEFAULT_APPROACHING_WINDOW_DAYS}. */
  approachingWindowDays?: number;
}

/**
 * A single deprecated-variant declaration as loaded from a Soul DID or
 * deprecation-manifest. Callers populate from the Soul DID's `spec.variants[]`
 * entries whose `cardinality === 'experimental'` or that carry a deprecation
 * annotation, OR from an explicit per-org deprecation manifest.
 */
export interface DeprecatedVariantDeclaration {
  /** Soul identifier (kebab-case). */
  soulId: string;
  /** Variant identifier (kebab-case). */
  variantId: string;
  /**
   * ISO 8601 date the deprecation was declared. Used to compute the default
   * `removalDate` when none is explicit.
   */
  deprecationDeclaredAt: string;
  /**
   * ISO 8601 date at or after which the variant may be removed. Optional —
   * when absent the lifecycle engine computes:
   *   `removalDate = deprecationDeclaredAt + deprecationWindowDays`.
   */
  removalDate?: string;
  /**
   * Work-item IDs (e.g. `AISDLC-313`) or consumer references that still
   * reference this variant. When non-empty and `removalDate` is past, the
   * variant enters `'removal-pending'` state (degraded mode + migration tasks).
   */
  activeConsumers?: string[];
}

// ── Output shapes ─────────────────────────────────────────────────────────────

/**
 * One lifecycle transition event emitted by the deprecation engine.
 * These are logged to the RFC-0035 Decision Catalog via the caller-supplied
 * `emitDecision` callback (catalog write is the caller's responsibility so
 * the engine stays pure/testable).
 */
export interface VariantDeprecationEvent {
  kind: VariantDeprecationDecisionKind;
  soulId: string;
  variantId: string;
  /** The lifecycle state this event transitions the variant into. */
  state: VariantDeprecationState;
  /** RFC-3339 UTC timestamp at transition detection time. */
  timestamp: string;
  /**
   * RFC-0035 Decision Catalog routing metadata per G0.
   * `blocking: false` is the invariant — pipeline NEVER halts on lifecycle transitions.
   */
  routing: {
    blocking: false;
    batchReview: boolean;
    /** Emitted for `removal-pending` transitions. */
    migrationTasksEmitted?: boolean;
    degradedMode?: boolean;
  };
  /** Human-readable summary; safe for operator surfaces (TUI, Slack). */
  message: string;
  /** Active consumers still referencing the variant (for removal-pending). */
  activeConsumers?: string[];
}

/**
 * One migration task emitted for each consumer still referencing a variant
 * past its removal date. Callers surface these to the consumer owners
 * (routing via the RFC-0035 actor model).
 */
export interface VariantMigrationTask {
  soulId: string;
  variantId: string;
  /** Consumer work-item ID that references the deprecated variant. */
  consumerId: string;
  /** Human-readable migration guidance. */
  message: string;
  timestamp: string;
}

/**
 * Full result of one deprecation lifecycle evaluation run.
 */
export interface VariantDeprecationResult {
  /** Lifecycle events emitted (one per transitioned variant). */
  events: VariantDeprecationEvent[];
  /**
   * Migration tasks emitted for consumers blocked on `removal-pending` variants.
   * Non-empty only when at least one variant is in `removal-pending` state.
   */
  migrationTasks: VariantMigrationTask[];
  /**
   * Variants that are now in degraded mode (at or past removal date with
   * active consumers). The pipeline continues operating with these variants
   * in read-only / degraded-service mode — per G0, no halt.
   */
  degradedVariants: Array<{ soulId: string; variantId: string }>;
}

// ── Date arithmetic helpers ───────────────────────────────────────────────────

/**
 * Parse an ISO 8601 date string (YYYY-MM-DD or full ISO 8601) to a Date.
 * Throws if unparseable.
 */
function parseDate(iso: string): Date {
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw new Error(`[variant-deprecation] invalid date: '${iso}'`);
  return d;
}

/**
 * Add `days` to a Date (calendar days; no DST adjustment).
 */
function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Compute the effective `removalDate` for a declaration.
 * When `declaration.removalDate` is explicit, use it; otherwise compute from
 * `deprecationDeclaredAt + deprecationWindowDays`.
 */
function effectiveRemovalDate(
  declaration: DeprecatedVariantDeclaration,
  config: VariantLifecycleConfig,
): Date {
  if (declaration.removalDate) return parseDate(declaration.removalDate);
  const declaredAt = parseDate(declaration.deprecationDeclaredAt);
  const windowDays = config.deprecationWindowDays ?? DEFAULT_DEPRECATION_WINDOW_DAYS;
  return addDays(declaredAt, windowDays);
}

// ── Lifecycle state resolver ──────────────────────────────────────────────────

/**
 * Resolve the current lifecycle state for a deprecated variant given the
 * current wall-clock time.
 *
 * State resolution logic:
 *   - If now ≥ removalDate AND activeConsumers.length > 0 → `'removal-pending'`
 *   - If now ≥ removalDate AND activeConsumers.length === 0 → `'removed'`
 *   - If now ≥ (removalDate − approachingWindowDays) → `'approaching'`
 *   - Otherwise → `'declared'`
 */
export function resolveDeprecationState(
  declaration: DeprecatedVariantDeclaration,
  config: VariantLifecycleConfig,
  now: Date,
): VariantDeprecationState {
  const removalDate = effectiveRemovalDate(declaration, config);
  const approachingWindowDays = config.approachingWindowDays ?? DEFAULT_APPROACHING_WINDOW_DAYS;
  const approachingThreshold = addDays(removalDate, -approachingWindowDays);
  const consumers = declaration.activeConsumers ?? [];

  if (now >= removalDate) {
    return consumers.length > 0 ? 'removal-pending' : 'removed';
  }
  if (now >= approachingThreshold) {
    return 'approaching';
  }
  return 'declared';
}

// ── Event factories ───────────────────────────────────────────────────────────

function makeDeclaredEvent(
  declaration: DeprecatedVariantDeclaration,
  now: string,
): VariantDeprecationEvent {
  return {
    kind: 'variant-deprecation-declared',
    soulId: declaration.soulId,
    variantId: declaration.variantId,
    state: 'declared',
    timestamp: now,
    routing: { blocking: false, batchReview: false },
    message:
      `Variant '${declaration.variantId}' on soul '${declaration.soulId}' has been marked ` +
      `deprecated. Decision: variant-deprecation-declared (catalog log; no operator interrupt ` +
      `per RFC-0035 G0).`,
  };
}

function makeApproachingEvent(
  declaration: DeprecatedVariantDeclaration,
  removalDateStr: string,
  now: string,
): VariantDeprecationEvent {
  return {
    kind: 'variant-deprecation-approaching',
    soulId: declaration.soulId,
    variantId: declaration.variantId,
    state: 'approaching',
    timestamp: now,
    routing: { blocking: false, batchReview: true },
    message:
      `Variant '${declaration.variantId}' on soul '${declaration.soulId}' is approaching ` +
      `removal (scheduled: ${removalDateStr}). Decision: variant-deprecation-approaching ` +
      `→ operator batch review surface (RFC-0035 G0 — non-blocking).`,
    activeConsumers: declaration.activeConsumers,
  };
}

function makeRemovalPendingEvent(
  declaration: DeprecatedVariantDeclaration,
  now: string,
): VariantDeprecationEvent {
  const consumers = declaration.activeConsumers ?? [];
  return {
    kind: 'variant-removal-consumers-pending',
    soulId: declaration.soulId,
    variantId: declaration.variantId,
    state: 'removal-pending',
    timestamp: now,
    routing: {
      blocking: false,
      batchReview: true,
      migrationTasksEmitted: true,
      degradedMode: true,
    },
    message:
      `Variant '${declaration.variantId}' on soul '${declaration.soulId}' is at/past removal ` +
      `date with ${consumers.length} active consumer(s). Auto-action: degraded mode enabled ` +
      `(consumers continue working); migration tasks emitted per consumer. ` +
      `Decision: variant-removal-consumers-pending (RFC-0035 G0 — pipeline continues).`,
    activeConsumers: consumers,
  };
}

function makeMigrationTask(
  soulId: string,
  variantId: string,
  consumerId: string,
  now: string,
): VariantMigrationTask {
  return {
    soulId,
    variantId,
    consumerId,
    message:
      `Consumer '${consumerId}' references deprecated variant '${variantId}' on soul ` +
      `'${soulId}' which is past its removal date. Migrate to a supported variant or ` +
      `soul-scope target before the degraded-mode window closes.`,
    timestamp: now,
  };
}

// ── Main evaluation function ──────────────────────────────────────────────────

/**
 * Evaluate deprecation lifecycle for a set of deprecated variant declarations.
 *
 * Per RFC-0035 G0: this function is ALWAYS non-blocking. It emits Decision
 * Catalog entries via the optional `emitDecision` callback; callers wire this
 * to `appendDecisionEvent()` from `pipeline-cli/src/decisions/event-log.ts`.
 *
 * **Pipeline never halts on lifecycle transitions** (AC #3). Even variants in
 * `removal-pending` state continue operating in degraded mode — the framework
 * emits migration tasks and surfaces to the operator, but does NOT block
 * admission, tick, or dispatch.
 *
 * @param declarations - Deprecated variant declarations to evaluate.
 * @param config       - Per-Soul / per-org lifecycle configuration.
 * @param now          - The current wall-clock instant (injectable for tests).
 * @param emitDecision - Optional callback called once per emitted Decision event.
 *                       Errors from this callback propagate to the caller.
 */
export function evaluateDeprecationLifecycle(
  declarations: DeprecatedVariantDeclaration[],
  config: VariantLifecycleConfig = {},
  now: Date = new Date(),
  emitDecision?: (event: VariantDeprecationEvent) => void,
): VariantDeprecationResult {
  const nowStr = now.toISOString();
  const events: VariantDeprecationEvent[] = [];
  const migrationTasks: VariantMigrationTask[] = [];
  const degradedVariants: Array<{ soulId: string; variantId: string }> = [];

  for (const declaration of declarations) {
    const state = resolveDeprecationState(declaration, config, now);
    const removalDate = effectiveRemovalDate(declaration, config);
    const removalDateStr = removalDate.toISOString().split('T')[0];

    let event: VariantDeprecationEvent;
    switch (state) {
      case 'declared':
        event = makeDeclaredEvent(declaration, nowStr);
        break;
      case 'approaching':
        event = makeApproachingEvent(declaration, removalDateStr, nowStr);
        break;
      case 'removal-pending': {
        event = makeRemovalPendingEvent(declaration, nowStr);
        degradedVariants.push({ soulId: declaration.soulId, variantId: declaration.variantId });
        // Emit one migration task per consumer
        for (const consumerId of declaration.activeConsumers ?? []) {
          migrationTasks.push(
            makeMigrationTask(declaration.soulId, declaration.variantId, consumerId, nowStr),
          );
        }
        break;
      }
      case 'removed':
        // 'removed' state: no active consumers + past removal date — no event emitted.
        // The variant can be safely pruned; this is a clean terminal state.
        continue;
    }

    events.push(event);
    if (emitDecision) {
      emitDecision(event);
    }
  }

  return { events, migrationTasks, degradedVariants };
}
