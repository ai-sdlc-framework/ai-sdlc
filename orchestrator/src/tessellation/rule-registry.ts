/**
 * RFC-0009 §13 + RFC-0018 OQ-10 — Tessellation§13RuleRegistry.
 *
 * Provides a concrete registration mechanism for §13 drift-detection rules,
 * resolving RFC-0018 OQ-10 (2026-05-28, full rubric):
 *
 *   "4th rule in same §13 engine + concrete registration mechanism spec'd:
 *    Tessellation§13RuleRegistry.register(rule).  Industry research:
 *    unified-engine-with-plugin-rules (Sonar, Semgrep, CodeQL, Snyk,
 *    Dependabot, Renovate) is the modern de-facto pattern."
 *
 * Standard rule interface: `{ name, description, scan(target): DriftEvent[], severity }`
 * §13 dispatcher fans out all registered rules in parallel; aggregates Decisions
 * for catalog routing.
 *
 * ### Composition with RFC-0028 OQ-7.2
 *
 * RFC-0028 OQ-7.2 (2026-05-27 resolution) establishes the structural-vs-statistical
 * drift detection pairing:
 *
 * - **Structural drift** (this registry, CI authoring-time): BLOCKS PR via
 *   `Decision: <rule-specific-name>` when `severity === 'high'`.
 * - **Statistical drift** (runtime PPA `SoulDriftDetected`): SURFACES via
 *   RFC-0035 G0 non-blocking pipeline contract.
 *
 * Rules register their `severity` to indicate which path applies:
 * `'high'` = structural-blocking; `'medium'` | `'warning'` = surfaces non-blocking.
 *
 * @see spec/rfcs/RFC-0009-tessellated-design-intent-documents.md §13
 * @see spec/rfcs/RFC-0018-in-soul-journey-pattern.md §10.1 OQ-8 + OQ-10
 * @see spec/rfcs/RFC-0028-engineering-axis-substrate-enforcement.md OQ-7.2
 */

// ── Drift severity ─────────────────────────────────────────────────────

/**
 * Severity level for a drift event / rule.
 *
 * Per RFC-0028 OQ-7.2:
 * - `'high'`    — structural drift; BLOCKS PR at CI authoring-time when configured.
 * - `'medium'`  — surfaces non-blocking via RFC-0035 G0 catalog route.
 * - `'warning'` — informational; surfaces for operator batch review.
 */
export type DriftSeverity = 'high' | 'medium' | 'warning';

// ── Drift event ────────────────────────────────────────────────────────

/**
 * A single drift event emitted by a registered §13 rule.
 *
 * All rules emit events of this shape. The `rule` field discriminates
 * the originating rule; consumers narrow on it before reading `details`.
 *
 * Events are aggregated by the §13 dispatcher and forwarded to the
 * RFC-0035 Decision Catalog for routing.
 */
export interface DriftEvent {
  /**
   * Canonical rule name — matches the `name` field of the `TessellationRule`
   * that emitted this event. Used for Decision Catalog routing and operator
   * attribution.
   */
  rule: string;
  /**
   * RFC-3339 UTC timestamp at detection time.
   */
  timestamp: string;
  /**
   * Human-readable one-line summary; safe for operator surfaces (TUI, Slack).
   */
  message: string;
  /**
   * Effective severity for this event instance. Rules may downgrade from
   * their registered `severity` based on per-org configuration (e.g. default
   * `medium` can be escalated to `high` via journey-config.yaml
   * `driftDetection.severityOverride`).
   */
  severity: DriftSeverity;
  /**
   * Free-form structured payload; rule-specific. Consumers narrow via `rule`.
   */
  details: unknown;
}

// ── Standard rule interface ────────────────────────────────────────────

/**
 * Standard interface for §13 tessellation drift-detection rules.
 *
 * RFC-0018 OQ-10 resolution specifies this shape:
 *   `{ name, description, scan(target): DriftEvent[], severity }`
 *
 * Rules MUST be stateless — all context is passed through `target`.
 * The registry fans out `scan(target)` calls in parallel; the order of
 * rule registration does not affect dispatch order (all fire concurrently).
 */
export interface TessellationRule<TTarget = RuleScanTarget> {
  /**
   * Canonical stable rule name. Used as the `rule` field on emitted events
   * and as the Decision Catalog routing key. SHOULD be kebab-case.
   *
   * Examples: `'soul-slug-ast-scan'`, `'cross-soul-provenance'`,
   * `'journey-state-id-drift'`.
   */
  readonly name: string;
  /**
   * Human-readable description of what this rule detects. Shown in
   * operator TUI and Slack notifications.
   */
  readonly description: string;
  /**
   * Default severity level for events emitted by this rule.
   *
   * Per RFC-0028 OQ-7.2:
   * - `'high'`    → structural blocking (BLOCKS PR)
   * - `'medium'`  → non-blocking, surfaces via RFC-0035 G0 catalog
   * - `'warning'` → informational batch-review queue
   */
  readonly severity: DriftSeverity;
  /**
   * Scan the supplied target for drift.
   *
   * Called once per tick by the §13 dispatcher. MUST be synchronous or
   * return a Promise. Stateless — all state must be captured in closure
   * at construction time. MUST NOT throw; surface errors as `DriftEvent`
   * with an `error` details payload and `severity: 'warning'`.
   *
   * @param target  All inputs available to rules in this dispatch cycle.
   * @returns       Zero or more `DriftEvent` objects. Empty array = no drift.
   */
  scan(target: TTarget): DriftEvent[] | Promise<DriftEvent[]>;
}

// ── Rule scan target ───────────────────────────────────────────────────

/**
 * The shared scan-target passed to every registered rule during a §13
 * dispatch cycle.
 *
 * Rules destructure only the fields they need. Optional fields are absent
 * when the caller did not provide them (no-op for rules that depend on them).
 *
 * This is the context object that evolves across RFC phases:
 * - Phase 4.2 (AISDLC-317): `substrateFiles`, `tessellation`, `tessellatedDid`
 * - Phase 4.2 (AISDLC-317): `provenance`
 * - Phase 3 (AISDLC-467): `journeysBySoul`, `journeyStatus`
 *
 * New rule families add fields here as phases land. Existing rules
 * destructure only what they need; unknown fields are ignored — forward-
 * compatible with zero changes to existing rule implementations.
 */
export interface RuleScanTarget {
  /** DID URI of the parent Tessellation being scanned. */
  tessellatedDid: string;
  /** Substrate files to scan (for AST-scan based rules). */
  substrateFiles?: SubstrateFileEntry[];
  /** Provenance entries to audit (for cross-soul provenance rule). */
  provenance?: unknown[];
  /**
   * Journey declarations keyed by soulId — the in-memory representation
   * of all active journeys across the tessellation.
   *
   * Shape matches `JourneyContext.journeysBySoul` from `journey-sa2-router.ts`
   * (RFC-0018 Phase 2). Rules read state IDs from `journey.states[]`.
   */
  journeysBySoul?: Record<string, ActiveJourneyDeclaration[]>;
  /**
   * Journey lifecycle status keyed by soulId+journeyId. Used by the
   * JourneyStateIdDriftRule to detect removed journeys.
   *
   * Key format: `<soul-id>/<journey-id>`. Missing entry = assume active.
   */
  journeyStatus?: Record<string, JourneyLifecycleStatus>;
}

/** A substrate file entry for AST-scan based rules. */
export interface SubstrateFileEntry {
  /** Workspace-relative path (forward slashes). */
  path: string;
  /** Full file contents as UTF-8. */
  contents: string;
}

/**
 * Minimal journey declaration shape for rule consumption.
 * Mirrors `JourneyDeclaration` from `journey-sa2-router.ts` but
 * is defined here to avoid a circular import across RFC phase packages.
 * The drift registry ships in AISDLC-467 (Phase 3); the SA2 router
 * ships in AISDLC-466 (Phase 2) — they must not create import cycles.
 */
export interface ActiveJourneyDeclaration {
  /** Journey identifier (kebab-case, unique within parent scope). */
  id: string;
  /**
   * Declared state identifiers for this journey. Rules scan substrate
   * code for references to these IDs.
   *
   * Each state has an `id` (kebab-case, unique within the journey) plus
   * optional metadata. The drift rule only cares about `id`.
   */
  states: Array<{ id: string; [key: string]: unknown }>;
}

/**
 * Journey lifecycle status — whether a journey is currently active or
 * has been removed (deprecated / archived).
 *
 * Per RFC-0018 §6.2 and OQ-8 resolution: application code referencing
 * a state in a removed journey is a drift signal.
 */
export type JourneyLifecycleStatus = 'active' | 'removed';

// ── Registry ───────────────────────────────────────────────────────────

/**
 * Tessellation§13RuleRegistry — the registration + parallel dispatch
 * mechanism for RFC-0009 §13 drift-detection rules.
 *
 * RFC-0018 OQ-10 resolution (2026-05-28) specifies:
 *   "concrete registration mechanism: Tessellation§13RuleRegistry.register(rule)
 *    … §13 dispatcher fans out all registered rules in parallel; aggregates
 *    Decisions for catalog routing."
 *
 * ### Usage
 *
 * ```ts
 * import { createTessellation13Registry } from './tessellation/rule-registry.js';
 * import { SoulSlugAstScanRule } from './tessellation/soul-slug-ast-scan-rule.js';
 *
 * const registry = createTessellation13Registry();
 * registry.register(new SoulSlugAstScanRule());
 * const events = await registry.dispatch(target);
 * ```
 *
 * ### Parallelism
 *
 * `dispatch()` fans out `scan(target)` calls via `Promise.allSettled` so
 * that a slow or failing rule does not block others. Settled rejections
 * are converted to `DriftEvent` with `severity: 'warning'` so they surface
 * as operator-visible noise rather than silently dropping.
 */
export interface Tessellation13Registry {
  /**
   * Register a rule with the §13 dispatcher.
   *
   * Rules are registered once at startup and remain for the lifetime of
   * the registry. Duplicate names are allowed (the registry does not
   * de-duplicate); the second `register()` call adds a second instance,
   * which is intentional for testing / override scenarios.
   *
   * @param rule  A `TessellationRule` implementation.
   */
  register(rule: TessellationRule): void;

  /**
   * Return all currently registered rules, in registration order.
   *
   * Useful for operator-facing diagnostics (TUI rule list, Slack digest)
   * and for test assertions that verify which rules are wired up.
   */
  getRegisteredRules(): ReadonlyArray<TessellationRule>;

  /**
   * Fan out all registered rules in parallel and aggregate the results.
   *
   * Returns the union of all `DriftEvent[]` arrays emitted by registered
   * rules. Rules that throw are caught; their error is surfaced as a
   * `DriftEvent` with `severity: 'warning'` so operators can investigate
   * without silently dropping findings.
   *
   * When no rules are registered, returns an empty array immediately.
   *
   * @param target  The shared scan-target for this dispatch cycle.
   * @returns       Aggregated drift events from all registered rules.
   */
  dispatch(target: RuleScanTarget): Promise<DriftEvent[]>;
}

/**
 * Create a new `Tessellation13Registry` instance.
 *
 * Each call returns an independent registry. The typical pattern is to
 * create ONE registry per orchestrator startup and register all §13
 * rules into it.
 */
export function createTessellation13Registry(): Tessellation13Registry {
  const rules: TessellationRule[] = [];

  return {
    register(rule: TessellationRule): void {
      rules.push(rule);
    },

    getRegisteredRules(): ReadonlyArray<TessellationRule> {
      return rules;
    },

    async dispatch(target: RuleScanTarget): Promise<DriftEvent[]> {
      if (rules.length === 0) return [];

      const now = new Date().toISOString();

      // Fan out in parallel — all rules execute concurrently.
      // Wrap each scan() call in a new Promise so synchronous throws are
      // caught by Promise.allSettled just as async rejections are.
      const settled = await Promise.allSettled(
        rules.map(
          (rule) =>
            new Promise<DriftEvent[]>((resolve, reject) => {
              try {
                const result = rule.scan(target);
                if (result instanceof Promise) {
                  result.then(resolve, reject);
                } else {
                  resolve(result);
                }
              } catch (err) {
                reject(err);
              }
            }),
        ),
      );

      const events: DriftEvent[] = [];
      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        const rule = rules[i];
        if (result.status === 'fulfilled') {
          events.push(...result.value);
        } else {
          // Rule threw — surface as a warning so operators can investigate.
          events.push({
            rule: rule.name,
            timestamp: now,
            message: `§13 rule '${rule.name}' threw during scan: ${String(result.reason)}`,
            severity: 'warning',
            details: { error: String(result.reason) },
          });
        }
      }

      return events;
    },
  };
}
