/**
 * RFC-0009 §13 Rule #3 — CrossSoulProvenanceRule.
 *
 * Implements `TessellationRule` for the Tessellation§13RuleRegistry so Rule #3
 * is dispatchable via `registry.register(rule)` (AISDLC-489, AISDLC-467 AC#3
 * follow-up).
 *
 * Wraps the existing cross-soul provenance audit logic from
 * `tessellation-drift.ts` as a first-class `TessellationRule` instance.
 * The detection semantics are preserved unchanged:
 *
 *   **Detection A** — `cross-boundary-no-amendment`: provenance's `targetedSouls`
 *   spans >=2 souls present in the tessellation without a recorded cross-
 *   tessellation amendment.
 *
 *   **Detection B** — `substrate-divergent-outcomes`: `substrateScoped: true`
 *   provenance where the max-min spread of `outcomeBySoul` values meets or
 *   exceeds `divergenceThreshold`.
 *
 * ### Provenance input via RuleScanTarget
 *
 * `RuleScanTarget.provenance` carries `unknown[]` for forward-compatibility.
 * `CrossSoulProvenanceRule` narrows each entry to `CrossSoulProvenanceEntry`
 * (the shape understood by the rule) using a runtime type-guard. Entries that
 * do not match the expected shape are silently skipped — this preserves
 * backward-compat when callers pass mixed provenance arrays.
 *
 * Callers should pass `ProvenanceAuditEntry[]` from `tessellation-drift.ts`
 * as `target.provenance` — `CrossSoulProvenanceEntry` is structurally
 * compatible with `ProvenanceAuditEntry` (same fields, re-typed to avoid
 * a cross-module import cycle).
 *
 * @see spec/rfcs/RFC-0009-tessellated-design-intent-documents.md §7.2 Rule #3 + §8.3
 * @see orchestrator/src/tessellation-drift.ts (original Rule #3 logic)
 */

import type {
  TessellationRule,
  DriftEvent,
  DriftSeverity,
  RuleScanTarget,
} from './rule-registry.js';

// ── Provenance entry shape ─────────────────────────────────────────────

/**
 * Minimal provenance record shape required by CrossSoulProvenanceRule.
 *
 * Structurally compatible with `ProvenanceRecord` from `@ai-sdlc/reference`
 * (the fields used by the rule). Defined here to avoid a cross-module import
 * cycle between the registry package and the tessellation-drift package.
 */
interface MinimalProvenanceRecord {
  promptHash?: string;
  timestamp: string;
  targetedSouls?: string[];
  substrateScoped?: boolean;
}

/**
 * One provenance record paired with the optional cross-soul amendment ref +
 * the optional downstream soul-outcome readings.
 *
 * Structurally compatible with `ProvenanceAuditEntry` from `tessellation-drift.ts`.
 */
export interface CrossSoulProvenanceEntry {
  record: MinimalProvenanceRecord;
  amendmentRecorded?: boolean;
  outcomeBySoul?: Record<string, number>;
}

// ── Drift details shape ────────────────────────────────────────────────

/**
 * A single cross-soul provenance finding (mirrors `CrossSoulProvenanceFinding`
 * from `tessellation-drift.ts`).
 */
export interface CrossSoulProvenanceFinding {
  kind: 'cross-boundary-no-amendment' | 'substrate-divergent-outcomes';
  workItemRef: string;
  crossedSouls: string[];
  outcomeBySoul?: Record<string, number>;
  note: string;
}

/**
 * Structured details payload for cross-soul-provenance drift events.
 */
export interface CrossSoulProvenanceDetails {
  rule: 'cross-soul-provenance';
  findings: CrossSoulProvenanceFinding[];
}

// ── Configuration ──────────────────────────────────────────────────────

/**
 * Configuration for `CrossSoulProvenanceRule`.
 */
export interface CrossSoulProvenanceConfig {
  /**
   * Spread threshold for substrate-divergent-outcomes detection.
   * Defaults to 0.3 (30-point spread on a 0..1 outcome scale).
   */
  divergenceThreshold?: number;
  /**
   * Severity override. Default `'warning'` (matches the original
   * `TessellationDriftDetectedEvent severity: 'warning'` in `tessellation-drift.ts`).
   */
  severity?: DriftSeverity;
}

export const DEFAULT_DIVERGENCE_THRESHOLD = 0.3;

// ── Internal helpers ───────────────────────────────────────────────────

/**
 * Derive a short stable work-item reference from a provenance record's
 * `promptHash`. Mirrors `deriveWorkItemRef` in `tessellation-drift.ts`.
 */
function deriveWorkItemRef(record: MinimalProvenanceRecord): string {
  if (record.promptHash && record.promptHash.length > 0) {
    return record.promptHash.slice(0, 16);
  }
  return record.timestamp;
}

/** Compute the max-min spread of an outcome map. Returns 0 for <2 souls. */
function outcomeSpread(outcomeBySoul: Record<string, number>): number {
  const values = Object.values(outcomeBySoul).filter((v): v is number => typeof v === 'number');
  if (values.length < 2) return 0;
  return Math.max(...values) - Math.min(...values);
}

/**
 * Type-guard for a `CrossSoulProvenanceEntry`.
 *
 * Accepts any object that has a `record` field with a `timestamp` string —
 * the minimum shape required for the rule to operate safely. Extra fields
 * are tolerated (structural subtyping).
 */
function isCrossSoulProvenanceEntry(v: unknown): v is CrossSoulProvenanceEntry {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj['record'] !== 'object' || obj['record'] === null) return false;
  const rec = obj['record'] as Record<string, unknown>;
  return typeof rec['timestamp'] === 'string';
}

// ── Rule implementation ────────────────────────────────────────────────

/**
 * CrossSoulProvenanceRule — RFC-0009 §13 Rule #3.
 *
 * Audits provenance records for cross-soul boundary violations and
 * substrate-divergent outcomes. Emits a `DriftEvent` when:
 *
 * - A work item targets >=2 tessellation souls without a recorded amendment, OR
 * - A substrate-scoped work item shows divergent soul-distinct outcomes.
 *
 * Provenance entries arrive via `target.provenance` (typed `unknown[]` in
 * `RuleScanTarget`). The rule narrows each entry via `isCrossSoulProvenanceEntry`
 * and skips entries that don't match.
 *
 * Soul slugs for boundary validation arrive via `target.soulSlugs` (forward-
 * compat field on `RuleScanTarget`). When absent, all `targetedSouls` in the
 * provenance records are treated as valid tessellation members (permissive mode).
 *
 * ### Registration
 *
 * ```ts
 * const registry = createTessellation13Registry();
 * registry.register(new CrossSoulProvenanceRule());
 * // With config:
 * registry.register(new CrossSoulProvenanceRule({ divergenceThreshold: 0.5 }));
 * ```
 */
export class CrossSoulProvenanceRule implements TessellationRule {
  readonly name = 'cross-soul-provenance';
  readonly description =
    'Audits provenance records for cross-soul boundary violations and substrate-divergent soul outcomes (RFC-0009 §7.2 Rule #3)';
  readonly severity: DriftSeverity;

  private readonly divergenceThreshold: number;

  /**
   * @param config  Optional configuration overrides.
   */
  constructor(config: CrossSoulProvenanceConfig = {}) {
    this.severity = config.severity ?? 'warning';
    this.divergenceThreshold = config.divergenceThreshold ?? DEFAULT_DIVERGENCE_THRESHOLD;
  }

  scan(target: RuleScanTarget): DriftEvent[] {
    const { tessellatedDid, provenance } = target;

    // No-op when no provenance entries.
    if (!provenance || provenance.length === 0) return [];

    const now = new Date().toISOString();

    // Soul slug set for boundary-filtering. Accept from `target.soulSlugs`
    // (forward-compat field). When absent, treat all souls as valid (permissive).
    const soulSlugsRaw = (target as RuleScanTarget & { soulSlugs?: string[] }).soulSlugs;
    const soulSlugSet: Set<string> | null = soulSlugsRaw ? new Set(soulSlugsRaw) : null;

    const findings: CrossSoulProvenanceFinding[] = [];

    for (const entry of provenance) {
      // Skip entries that don't match the expected shape.
      if (!isCrossSoulProvenanceEntry(entry)) continue;

      const { record, amendmentRecorded, outcomeBySoul } = entry;

      // Filter targetedSouls to souls in the tessellation (when soulSlugSet is known).
      const raw = record.targetedSouls ?? [];
      const valid = soulSlugSet ? raw.filter((s) => soulSlugSet.has(s)) : raw;

      // Detection A: cross-boundary without amendment.
      if (valid.length >= 2 && amendmentRecorded !== true) {
        findings.push({
          kind: 'cross-boundary-no-amendment',
          workItemRef: deriveWorkItemRef(record),
          crossedSouls: [...valid].sort(),
          note: `work item targeted ${valid.length} souls without a recorded cross-tessellation amendment`,
        });
      }

      // Detection B: substrate-scoped with divergent outcomes.
      if (
        record.substrateScoped === true &&
        outcomeBySoul &&
        Object.keys(outcomeBySoul).length >= 2
      ) {
        const spread = outcomeSpread(outcomeBySoul);
        if (spread >= this.divergenceThreshold) {
          findings.push({
            kind: 'substrate-divergent-outcomes',
            workItemRef: deriveWorkItemRef(record),
            crossedSouls: Object.keys(outcomeBySoul).sort(),
            outcomeBySoul: { ...outcomeBySoul },
            note: `substrate provenance shows soul-distinct outcome spread ${spread.toFixed(3)} ≥ threshold ${this.divergenceThreshold}`,
          });
        }
      }
    }

    if (findings.length === 0) return [];

    const involved = new Set(findings.flatMap((f) => f.crossedSouls));

    return [
      {
        rule: this.name,
        timestamp: now,
        message: `Cross-soul provenance: ${findings.length} finding(s) across ${involved.size} soul(s) (tessellation: ${tessellatedDid})`,
        severity: this.severity,
        details: {
          rule: 'cross-soul-provenance',
          findings,
        } satisfies CrossSoulProvenanceDetails,
      },
    ];
  }
}
