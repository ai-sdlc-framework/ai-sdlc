/**
 * DesignIntentDocument reconciler (RFC-0008 §4.4 + Addendum B §B.9.1).
 *
 * Continuously compares the current DID spec against a previous
 * snapshot (by `source_hash`), and against the resolved
 * DesignSystemBinding, emitting events for:
 *
 *   - CoreIdentityChanged        (identityClass: 'core' field mutated)
 *   - EvolvingIdentityChanged    (identityClass: 'evolving' / default mutated)
 *   - DesignIntentDrift          (principle has no matching DSB compliance rule)
 *   - ReviewOverdue              (status.lastReviewed + cadence in the past)
 *   - SoulGraphStale             (core identity changed while items are in-flight)
 *
 * The factory signature mirrors `createDesignSystemReconciler` —
 * dependency-injected event handler + snapshot I/O, returning a
 * `ReconcilerFn<DesignIntentDocument>`.
 */

import type {
  DesignIntentDocument,
  DesignSystemBinding,
  IdentityClass,
  PlannedChange,
  PlannedChangeType,
  ReviewCadence,
} from '../core/types.js';
import type { ReconcileResult } from './types.js';

// ── Event shapes ─────────────────────────────────────────────────────

export type DesignIntentEventType =
  | 'CoreIdentityChanged'
  | 'EvolvingIdentityChanged'
  | 'DesignIntentDrift'
  | 'ReviewOverdue'
  | 'SoulGraphStale'
  | 'DesignChangePlanned';

/**
 * Structured `DesignChangePlanned` payload per RFC-0008 §A.9. Consumers
 * persist this to `design_change_events` via `StateStore.recordDesignChange`
 * and subscribe via the orchestrator event bus.
 */
export interface DesignChangePlannedDetails {
  changeId: string;
  changeType: PlannedChangeType;
  description?: string;
  estimatedTimeline?: string;
  affectedTokenPaths?: string[];
  estimatedComponentImpact?: number;
  plannedBy?: string;
  /**
   * Structured engineering recommendations emitted alongside the event.
   * Execution deferred — these are informational strings for reviewers
   * and downstream tooling.
   */
  engineeringActions: string[];
}

export interface DesignIntentEvent {
  type: DesignIntentEventType;
  didName: string;
  timestamp: string;
  details: Record<string, unknown>;
}

export type DesignIntentEventHandler = (event: DesignIntentEvent) => void;

// ── Snapshot shape ───────────────────────────────────────────────────

export interface DesignIntentSnapshot {
  /** sha256 of canonical DID spec at the time of snapshot. */
  sourceHash: string;
  /** Flat field map: path → { class, valueHash }. */
  fields: Record<string, { identityClass: IdentityClass; valueHash: string }>;
  /** `status.lastReviewed` at snapshot time. */
  lastReviewed?: string;
  /**
   * IDs of `spec.plannedChanges[]` entries seen at snapshot time. Used
   * to detect *newly added* planned changes (status transitions on
   * existing IDs do not re-emit `DesignChangePlanned`).
   */
  plannedChangeIds?: string[];
}

// ── Dependencies ─────────────────────────────────────────────────────

export interface DesignIntentReconcilerDeps {
  /** Resolve the DSB referenced by `did.spec.designSystemRef`. */
  getDesignSystemBinding: (did: DesignIntentDocument) => DesignSystemBinding | undefined;
  /** Load the previous snapshot for this DID, if any. */
  getLastSnapshot: (didName: string) => Promise<DesignIntentSnapshot | undefined>;
  /** Persist the current snapshot for next run. */
  saveSnapshot: (didName: string, snapshot: DesignIntentSnapshot) => Promise<void>;
  /** Count issues currently in-flight (admitted, not completed) for the team. */
  countInFlightItems?: (didName: string) => Promise<number>;
  /** Emit a reconciliation event. */
  onEvent?: DesignIntentEventHandler;
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Hash function (stable output). Defaults to a simple FNV-1a string hash. */
  hash?: (value: string) => string;
}

function emit(deps: DesignIntentReconcilerDeps, event: DesignIntentEvent): void {
  deps.onEvent?.(event);
}

function nowMs(deps: DesignIntentReconcilerDeps): number {
  return (deps.now ?? (() => Date.now()))();
}

function nowIso(deps: DesignIntentReconcilerDeps): string {
  return new Date(nowMs(deps)).toISOString();
}

// ── Review cadence ───────────────────────────────────────────────────

const CADENCE_DAYS: Record<ReviewCadence, number> = {
  monthly: 30,
  quarterly: 90,
  biannual: 180,
  annual: 365,
};

export function computeNextReviewDueMs(
  lastReviewedIso: string | undefined,
  cadence: ReviewCadence | undefined,
): number | undefined {
  if (!lastReviewedIso || !cadence) return undefined;
  const last = Date.parse(lastReviewedIso);
  if (Number.isNaN(last)) return undefined;
  return last + CADENCE_DAYS[cadence] * 24 * 60 * 60 * 1000;
}

// ── Field flattening ─────────────────────────────────────────────────

type FieldEntry = { path: string; identityClass: IdentityClass; valueHash: string };

/**
 * Walk the DID spec and return every leaf whose parent carries (or
 * inherits) an `identityClass`. Unmarked siblings default to
 * `evolving` so all fields contribute to drift detection without
 * requiring exhaustive annotation.
 */
export function flattenIdentityFields(
  did: DesignIntentDocument,
  hash: (value: string) => string = fnv1aHex,
): FieldEntry[] {
  const entries: FieldEntry[] = [];
  const spec = did.spec;

  // Mission (single field)
  if (spec.soulPurpose.mission) {
    entries.push({
      path: 'spec.soulPurpose.mission.value',
      identityClass: spec.soulPurpose.mission.identityClass ?? 'evolving',
      valueHash: hash(spec.soulPurpose.mission.value),
    });
  }

  // Constraints
  for (const c of spec.soulPurpose.constraints ?? []) {
    entries.push({
      path: `spec.soulPurpose.constraints[${c.id}]`,
      identityClass: c.identityClass ?? 'evolving',
      valueHash: hash(
        JSON.stringify({
          concept: c.concept,
          relationship: c.relationship,
          detectionPatterns: c.detectionPatterns,
        }),
      ),
    });
  }

  // Scope boundaries
  for (const s of spec.soulPurpose.scopeBoundaries?.inScope ?? []) {
    entries.push({
      path: `spec.soulPurpose.scopeBoundaries.inScope[${s.label}]`,
      identityClass: s.identityClass ?? 'evolving',
      valueHash: hash(JSON.stringify(s)),
    });
  }
  for (const s of spec.soulPurpose.scopeBoundaries?.outOfScope ?? []) {
    entries.push({
      path: `spec.soulPurpose.scopeBoundaries.outOfScope[${s.label}]`,
      identityClass: s.identityClass ?? 'evolving',
      valueHash: hash(JSON.stringify(s)),
    });
  }

  // Anti-patterns (soul-level)
  for (const a of spec.soulPurpose.antiPatterns ?? []) {
    entries.push({
      path: `spec.soulPurpose.antiPatterns[${a.id}]`,
      identityClass: a.identityClass ?? 'evolving',
      valueHash: hash(JSON.stringify({ label: a.label, patterns: a.detectionPatterns })),
    });
  }

  // Design principles (+ nested anti-patterns)
  for (const p of spec.soulPurpose.designPrinciples) {
    entries.push({
      path: `spec.soulPurpose.designPrinciples[${p.id}]`,
      identityClass: p.identityClass ?? 'evolving',
      valueHash: hash(
        JSON.stringify({
          name: p.name,
          description: p.description,
          signals: p.measurableSignals,
        }),
      ),
    });
    for (const a of p.antiPatterns ?? []) {
      entries.push({
        path: `spec.soulPurpose.designPrinciples[${p.id}].antiPatterns[${a.id}]`,
        identityClass: a.identityClass ?? p.identityClass ?? 'evolving',
        valueHash: hash(JSON.stringify({ label: a.label, patterns: a.detectionPatterns })),
      });
    }
  }

  // Brand identity
  const brand = spec.brandIdentity;
  if (brand) {
    for (const a of brand.voiceAntiPatterns ?? []) {
      entries.push({
        path: `spec.brandIdentity.voiceAntiPatterns[${a.id}]`,
        identityClass: a.identityClass ?? 'evolving',
        valueHash: hash(JSON.stringify(a)),
      });
    }
    const visual = brand.visualIdentity;
    if (visual) {
      for (const c of visual.visualConstraints ?? []) {
        entries.push({
          path: `spec.brandIdentity.visualIdentity.visualConstraints[${c.id}]`,
          identityClass: c.identityClass ?? 'evolving',
          valueHash: hash(JSON.stringify(c)),
        });
      }
      for (const a of visual.visualAntiPatterns ?? []) {
        entries.push({
          path: `spec.brandIdentity.visualIdentity.visualAntiPatterns[${a.id}]`,
          identityClass: a.identityClass ?? 'evolving',
          valueHash: hash(JSON.stringify(a)),
        });
      }
    }
  }

  // Experiential targets
  const ets = spec.experientialTargets ?? {};
  for (const [name, target] of Object.entries(ets)) {
    if (!target) continue;
    entries.push({
      path: `spec.experientialTargets.${name}`,
      identityClass: target.identityClass ?? 'evolving',
      valueHash: hash(JSON.stringify(target)),
    });
  }

  return entries;
}

// ── DID → DSB drift detection ────────────────────────────────────────

/**
 * BM25-lite term match: a principle's description keyword appears in at
 * least one DSB compliance rule (hardcoded-disallow category/pattern/
 * message, or review scope entry). Principles with zero matches emit
 * `DesignIntentDrift`.
 */
export function findPrinciplesWithoutDsbCoverage(
  did: DesignIntentDocument,
  dsb: DesignSystemBinding | undefined,
): string[] {
  if (!dsb) return did.spec.soulPurpose.designPrinciples.map((p) => p.id);

  const ruleCorpus = buildDsbRuleCorpus(dsb).toLowerCase();
  const uncovered: string[] = [];

  for (const principle of did.spec.soulPurpose.designPrinciples) {
    const terms = extractKeywords(principle.description);
    const covered = terms.some((t) => ruleCorpus.includes(t));
    if (!covered) uncovered.push(principle.id);
  }
  return uncovered;
}

function buildDsbRuleCorpus(dsb: DesignSystemBinding): string {
  const parts: string[] = [];
  for (const rule of dsb.spec.compliance.disallowHardcoded ?? []) {
    parts.push(rule.category, rule.pattern, rule.message);
  }
  for (const scope of dsb.spec.designReview?.scope ?? []) {
    parts.push(scope);
  }
  return parts.join(' ');
}

/** Extract lowercased keyword stems ≥ 4 chars, stripping common stopwords. */
export function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    'that',
    'with',
    'from',
    'this',
    'into',
    'onto',
    'they',
    'their',
    'have',
    'will',
    'been',
    'were',
    'must',
    'should',
    'your',
    'ours',
    'them',
  ]);
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !stopwords.has(w)),
    ),
  );
}

// ── Hash helper (stable, non-crypto — FNV-1a 32-bit hex) ─────────────

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned 32-bit then hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function computeSourceHash(
  did: DesignIntentDocument,
  hash: (value: string) => string = fnv1aHex,
): string {
  return hash(JSON.stringify(did.spec));
}

// ── DesignChangePlanned payload ──────────────────────────────────────

/**
 * Build the structured event payload per §A.9. `engineeringActions` is
 * a fixed-per-changeType list of recommended follow-ups; execution is
 * out of scope for the reconciler.
 */
export function buildDesignChangePlannedDetails(change: PlannedChange): DesignChangePlannedDetails {
  return {
    changeId: change.id,
    changeType: change.changeType,
    description: change.description,
    estimatedTimeline: change.estimatedTimeline,
    affectedTokenPaths: change.affectedTokenPaths,
    estimatedComponentImpact: change.estimatedComponentImpact,
    plannedBy: change.addedBy,
    engineeringActions: recommendEngineeringActions(change),
  };
}

function recommendEngineeringActions(change: PlannedChange): string[] {
  const base = [
    'flag affected components in the catalog for pre-migration review',
    'warn in-flight PRs that touch the affected token paths',
    'open a design-change epic issue linking this DID and DSB',
    'update the design-change timeline on the governance dashboard',
  ];
  if (
    change.changeType === 'token-removal' ||
    change.changeType === 'token-restructure' ||
    change.changeType === 'brand-revision'
  ) {
    base.push('schedule a visual-regression snapshot against current baselines');
  }
  return base;
}

// ── Reconciler factory ───────────────────────────────────────────────

export function createDesignIntentReconciler(
  deps: DesignIntentReconcilerDeps,
): (did: DesignIntentDocument) => Promise<ReconcileResult> {
  const hash = deps.hash ?? fnv1aHex;

  return async (did: DesignIntentDocument): Promise<ReconcileResult> => {
    try {
      const didName = did.metadata.name;
      const currentFields = flattenIdentityFields(did, hash);
      const currentFieldMap: DesignIntentSnapshot['fields'] = {};
      for (const entry of currentFields) {
        currentFieldMap[entry.path] = {
          identityClass: entry.identityClass,
          valueHash: entry.valueHash,
        };
      }
      const currentHash = computeSourceHash(did, hash);

      const previous = await deps.getLastSnapshot(didName);

      // ── 1. Review cadence check ─────────────────────────────
      const cadence = did.spec.stewardship.reviewCadence;
      const lastReviewed = did.status?.lastReviewed;
      const nextDueMs = computeNextReviewDueMs(lastReviewed, cadence);
      if (nextDueMs !== undefined && nowMs(deps) > nextDueMs) {
        emit(deps, {
          type: 'ReviewOverdue',
          didName,
          timestamp: nowIso(deps),
          details: {
            cadence,
            lastReviewed,
            nextDueAt: new Date(nextDueMs).toISOString(),
          },
        });
      }

      // ── 2. Identity-class diff vs previous snapshot ─────────
      let coreChanged = false;
      const coreChangedFields: string[] = [];
      const evolvingChangedFields: string[] = [];

      if (previous) {
        for (const [path, curr] of Object.entries(currentFieldMap)) {
          const prev = previous.fields[path];
          if (!prev || prev.valueHash !== curr.valueHash) {
            if (curr.identityClass === 'core') {
              coreChanged = true;
              coreChangedFields.push(path);
            } else {
              evolvingChangedFields.push(path);
            }
          }
        }
        // Removed paths
        for (const [path, prev] of Object.entries(previous.fields)) {
          if (!(path in currentFieldMap)) {
            if (prev.identityClass === 'core') {
              coreChanged = true;
              coreChangedFields.push(`${path} (removed)`);
            } else {
              evolvingChangedFields.push(`${path} (removed)`);
            }
          }
        }

        if (coreChangedFields.length > 0) {
          emit(deps, {
            type: 'CoreIdentityChanged',
            didName,
            timestamp: nowIso(deps),
            details: { changedFields: coreChangedFields },
          });
        }
        if (evolvingChangedFields.length > 0) {
          emit(deps, {
            type: 'EvolvingIdentityChanged',
            didName,
            timestamp: nowIso(deps),
            details: { changedFields: evolvingChangedFields },
          });
        }
      }

      // ── 3. SoulGraphStale on core change with in-flight work ─
      if (coreChanged && deps.countInFlightItems) {
        const inFlight = await deps.countInFlightItems(didName);
        if (inFlight > 0) {
          emit(deps, {
            type: 'SoulGraphStale',
            didName,
            timestamp: nowIso(deps),
            details: { inFlightCount: inFlight, changedFields: coreChangedFields },
          });
        }
      }

      // ── 4. DID ↔ DSB drift (principles without DSB coverage) ─
      const dsb = deps.getDesignSystemBinding(did);
      const uncoveredPrinciples = findPrinciplesWithoutDsbCoverage(did, dsb);
      if (uncoveredPrinciples.length > 0) {
        emit(deps, {
          type: 'DesignIntentDrift',
          didName,
          timestamp: nowIso(deps),
          details: {
            uncoveredPrinciples,
            dsbResolved: Boolean(dsb),
          },
        });
      }

      // ── 5. design-change.planned on newly-added plannedChanges ─
      // First-run (no previous snapshot) captures the baseline without
      // emitting; otherwise every existing plannedChanges[] entry would
      // flood the event bus on initial deployment.
      const currentPlanned = did.spec.plannedChanges ?? [];
      if (previous) {
        const previousIds = new Set(previous.plannedChangeIds ?? []);
        for (const change of currentPlanned) {
          if (previousIds.has(change.id)) continue;
          if (change.status !== 'planned') continue;
          emit(deps, {
            type: 'DesignChangePlanned',
            didName,
            timestamp: nowIso(deps),
            details: { ...buildDesignChangePlannedDetails(change) },
          });
        }
      }

      // ── 6. Persist snapshot for next run ─────────────────────
      await deps.saveSnapshot(didName, {
        sourceHash: currentHash,
        fields: currentFieldMap,
        lastReviewed,
        plannedChangeIds: currentPlanned.map((c) => c.id),
      });

      return { type: 'success' };
    } catch (err) {
      return {
        type: 'error',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  };
}
