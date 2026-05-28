/**
 * RFC-0030 OQ-13.3 re-walkthrough refinement (v0.3) — per-stage residency
 * enforcement points + multi-posture composition.
 *
 * This module consolidates the post-Phase-4 residency enforcement points that
 * span the clustering, storage, and cost-report layers. The adapter-level
 * `fetchSignals()` check is owned by `checkSignalResidency` /
 * `filterSignalsByResidency` in `./significance.ts` (already shipped via
 * AISDLC-343..348); this module adds the missing per-stage hooks specified by
 * the 2026-05-26 re-walkthrough:
 *
 *   1. **Clustering** — `partitionSignalsByRegion()` segregates signals by
 *      `region` BEFORE similarity computation so cross-region merge is
 *      structurally impossible when the active regime requires it. The
 *      `clusterRequiresSegregation()` helper consults the
 *      `residencyEnforcement.clustering` config + the active regime list.
 *
 *   2. **Storage** — `StoredSignalRecord` is the persistence shape, with a
 *      mandatory `residencyRegion` field derived from the signal's
 *      `region` tag. `readSignalRecordWithAudit()` enforces the
 *      cross-region-read elevated audit-log entry per AC #4.
 *
 *   3. **Unified cost report** — `groupCostByRegion()` partitions cost
 *      attribution rows by `residencyRegion`, breaking out per-region totals
 *      so adopters can audit cross-region cost mingling.
 *
 *   4. **Multi-posture UNION** — when an adopter declares both HIPAA and
 *      GDPR (RFC-0022 OQ-7 forward-compat), `composePostures()` takes the
 *      UNION of constraints — strictest of each constraint applies. Output is
 *      a single `ResidencyRegimeDeclaration` consumable by the existing
 *      `checkSignalResidency` and by the new clustering / storage helpers.
 *
 * **G0 non-blocking pipeline contract** (RFC-0035): residency violations
 * never halt the pipeline. Adapter-level violations surface as
 * `Decision: signal-residency-violation` (already implemented). Storage /
 * clustering / cost-report violations surface as elevated audit-log entries
 * + per-region breakdowns — the pipeline continues to ingest signals from
 * permitted regions in the same batch.
 *
 * @module signal-ingestion/residency
 */

import type { RawSignal } from './types.js';
import type { ResidencyRegimeDeclaration } from './significance.js';

// ── Multi-posture composition (AC #6) ───────────────────────────────────────

/**
 * Per-regime constraint sub-shape consumed by `composePostures()`. Each input
 * regime declaration carries (a) the regime ID, (b) the allowed regions for
 * THAT regime (subset of ISO-3166 alpha-2 codes or compliance region tags).
 *
 * Concrete examples consumed by the composer:
 *   - `{ regime: 'gdpr', allowedRegions: ['eu', 'gb'] }`
 *   - `{ regime: 'hipaa', allowedRegions: ['us', 'us-east'] }`
 *   - `{ regime: 'ccpa', allowedRegions: ['us', 'us-west', 'ca'] }`
 */
export interface PostureRegimeInput {
  regime: string;
  allowedRegions: string[];
}

/**
 * Compose multiple posture regimes into a single `ResidencyRegimeDeclaration`
 * with UNION-of-constraints semantics per the RFC-0030 v0.3 multi-posture
 * forward-compat clause: when an adopter declares both HIPAA AND GDPR, every
 * regime's allowed-region constraint MUST be satisfied (intersection of
 * allowed regions across regimes, NOT union of allowed regions).
 *
 * Worked example: HIPAA allows `['us', 'us-east']`, GDPR allows `['eu', 'gb']`.
 * The composed posture lists BOTH regimes as active, with `allowedRegions`
 * tracked PER REGIME. The existing `checkSignalResidency` then refuses a
 * signal IFF its region fails at least one active regime — which is the
 * correct UNION-of-constraints / strictest-wins behaviour. (For the example
 * above, NO region satisfies both regimes; the adopter must scope their
 * adapter inputs to a single regime per source.)
 *
 * The composed declaration is normalised:
 *   - `regimes` is sorted alphabetically (deterministic event log + audit).
 *   - `allowedRegionsByRegime` lower-cases all region tags and dedupes.
 *   - Empty input → `{ regimes: [], allowedRegionsByRegime: {} }` (no
 *     constraints; matches single-regime empty case).
 */
export function composePostures(postures: PostureRegimeInput[]): ResidencyRegimeDeclaration {
  if (postures.length === 0) {
    return { regimes: [], allowedRegionsByRegime: {} };
  }

  // Merge duplicate regime IDs by intersecting their allowedRegions (rare but
  // possible when an adopter declares the same regime twice — strictest of
  // the two wins, matching the UNION-of-constraints semantics).
  const merged = new Map<string, Set<string>>();
  for (const p of postures) {
    const regime = p.regime.toLowerCase();
    const allowedLower = p.allowedRegions.map((r) => r.toLowerCase());
    const existing = merged.get(regime);
    if (existing === undefined) {
      merged.set(regime, new Set(allowedLower));
    } else {
      // Intersect with the prior declaration.
      const intersection = new Set<string>();
      for (const r of existing) if (allowedLower.includes(r)) intersection.add(r);
      merged.set(regime, intersection);
    }
  }

  const regimes = Array.from(merged.keys()).sort();
  const allowedRegionsByRegime: Record<string, string[]> = {};
  for (const regime of regimes) {
    allowedRegionsByRegime[regime] = Array.from(merged.get(regime)!).sort();
  }

  return { regimes, allowedRegionsByRegime };
}

// ── Clustering enforcement (AC #3) ──────────────────────────────────────────

/**
 * Does the active regime declaration REQUIRE residency segregation at the
 * clustering layer? Returns `true` when at least one active regime is in the
 * known-segregation list (GDPR, HIPAA, PIPEDA — regimes whose data-handling
 * rules forbid cross-region co-mingling of customer records). Returns `false`
 * when no regimes are active OR when only non-segregation regimes are
 * declared (e.g. CCPA which is about consumer rights, not data residency).
 *
 * The segregation list is intentionally conservative — adopters should
 * explicitly enable clustering segregation via the config flag when their
 * regime is not in the default list. Per RFC-0030 v0.3 §11
 * `residencyEnforcement.enforcementPoints.clustering`, the config flag is
 * the source of truth; this helper is the fallback when the flag isn't set.
 */
const KNOWN_SEGREGATION_REGIMES = new Set(['gdpr', 'hipaa', 'pipeda']);

export function clusterRequiresSegregation(declaration: ResidencyRegimeDeclaration): boolean {
  if (declaration.regimes.length === 0) return false;
  for (const regime of declaration.regimes) {
    if (KNOWN_SEGREGATION_REGIMES.has(regime.toLowerCase())) return true;
  }
  return false;
}

/**
 * Partition a batch of signals by `region` so the clustering pass treats
 * each partition as a separate input population. Signals with `region`
 * undefined go into the special `__unspecified` partition — they're not
 * cross-mingled with tagged regions (defensive default; adapters that don't
 * surface region metadata cluster amongst themselves rather than getting
 * silently merged into a region-tagged cluster they shouldn't be part of).
 *
 * Region keys are lower-cased for stable matching. The returned map iterates
 * in deterministic order (Map preserves insertion order; partitioning loops
 * over the input in order).
 *
 * **Usage**: pipeline callers invoke `clusterSignalsWithResidency()` rather
 * than `clusterSignals()` directly when the active regime requires
 * segregation. The wrapper runs `clusterSignals()` once per partition and
 * concatenates the per-partition `ClusteringResult` arrays.
 */
export function partitionSignalsByRegion<T extends { signal: { region?: string } }>(
  signals: T[],
): Map<string, T[]> {
  const partitions = new Map<string, T[]>();
  for (const s of signals) {
    const region = (s.signal.region ?? '__unspecified').toLowerCase();
    let bucket = partitions.get(region);
    if (bucket === undefined) {
      bucket = [];
      partitions.set(region, bucket);
    }
    bucket.push(s);
  }
  return partitions;
}

// ── Storage enforcement (AC #4) ─────────────────────────────────────────────

/**
 * The on-disk / on-database persistence shape for an ingested signal. The
 * `residencyRegion` field is MANDATORY at storage time — adapters that
 * couldn't derive a region tag persist `'unknown'` (visible-gap surface for
 * the operator's compliance-config rollout, NOT a silent omission).
 *
 * `ingestedAt` is the pipeline's timestamp (independent of
 * `sourceTimestamp`), useful for audit (when did THIS pipeline run see
 * THIS signal?).
 *
 * `sourceTimestampIso` / `attestedAtIso` are ISO-8601 strings to keep the
 * record JSON-serialisable without Date-deserialise hazards.
 */
export interface StoredSignalRecord {
  sourceId: string;
  sourceTimestampIso: string;
  ingestedAtIso: string;
  customerId?: string;
  customerTier?: string;
  payload: string;
  metadata?: Record<string, unknown>;
  attestedBy?: string;
  attestedAtIso?: string;
  /**
   * Residency region the signal was tagged with at fetchSignals time. Stored
   * lower-cased for stable matching. `'unknown'` when the adapter didn't
   * surface region metadata.
   */
  residencyRegion: string;
}

/**
 * Build a `StoredSignalRecord` from a `RawSignal`. The `residencyRegion`
 * field is derived from `signal.region` (lower-cased) or `'unknown'` when
 * absent. `ingestedAt` defaults to `new Date()` — callers can pass an
 * explicit clock for deterministic tests.
 */
export function makeStoredSignalRecord(
  signal: RawSignal,
  options: { ingestedAt?: Date } = {},
): StoredSignalRecord {
  const ingestedAt = options.ingestedAt ?? new Date();
  return {
    sourceId: signal.sourceId,
    sourceTimestampIso: signal.sourceTimestamp.toISOString(),
    ingestedAtIso: ingestedAt.toISOString(),
    ...(signal.customerId !== undefined && { customerId: signal.customerId }),
    ...(signal.customerTier !== undefined && { customerTier: signal.customerTier }),
    payload: signal.payload,
    ...(signal.metadata !== undefined && { metadata: signal.metadata }),
    ...(signal.attestedBy !== undefined && { attestedBy: signal.attestedBy }),
    ...(signal.attestedAt !== undefined && { attestedAtIso: signal.attestedAt.toISOString() }),
    residencyRegion: (signal.region ?? 'unknown').toLowerCase(),
  };
}

/**
 * Elevated audit-log entry emitted when a cross-region read occurs. The
 * caller's `residencyRegion` (the region of the agent / surface reading the
 * record) differs from the record's `residencyRegion`. Per RFC-0030 v0.3
 * §11 storage enforcement clause, every such read MUST be logged for
 * SOC2-style audit trails.
 *
 * `severity: 'elevated'` distinguishes this from regular pipeline events —
 * downstream audit consumers (RFC-0022 Compliance Posture audit surface)
 * filter on `severity` to surface only the audit-worthy entries.
 */
export interface CrossRegionReadAuditEntry {
  type: 'AuditEvent';
  event: 'cross-region-signal-read';
  severity: 'elevated';
  sourceId: string;
  recordResidencyRegion: string;
  callerResidencyRegion: string;
  reader: string;
  readAtIso: string;
}

/**
 * Read a stored signal record with cross-region audit enforcement. When the
 * caller's region matches the record's region (or when either is `'unknown'`
 * — a visible-gap state that doesn't trigger audit), returns the record
 * with `auditEntry: null`. When regions differ AND both are known, returns
 * the record with a populated `auditEntry` the caller MUST persist to the
 * audit log.
 *
 * The pipeline does NOT block cross-region reads — the audit entry is the
 * mitigation. RFC-0030 v0.3 explicitly says "cross-region read requires
 * elevated audit log entry", not "is forbidden". Adopters who want to
 * forbid cross-region reads do so via their own surface (the audit log is
 * the input to that policy).
 *
 * **Why not just check at write time?** Storage is the canonical persistence
 * layer — once a record is on disk it's findable. Restricting WRITES
 * doesn't help: the audit obligation is on READ. This matches AWS S3
 * cross-region replication audit semantics (log on read, not on write).
 */
export function readSignalRecordWithAudit(
  record: StoredSignalRecord,
  options: {
    callerRegion: string;
    reader: string;
    readAt?: Date;
  },
): { record: StoredSignalRecord; auditEntry: CrossRegionReadAuditEntry | null } {
  const callerRegion = options.callerRegion.toLowerCase();
  const recordRegion = record.residencyRegion;
  const readAt = options.readAt ?? new Date();

  // Visible-gap: when either side is unknown, no audit fires. Operators get
  // visibility into the gap via the population-level region-breakdown metric
  // (see groupCostByRegion's `__unknown` bucket).
  if (callerRegion === 'unknown' || recordRegion === 'unknown') {
    return { record, auditEntry: null };
  }

  if (callerRegion === recordRegion) {
    return { record, auditEntry: null };
  }

  return {
    record,
    auditEntry: {
      type: 'AuditEvent',
      event: 'cross-region-signal-read',
      severity: 'elevated',
      sourceId: record.sourceId,
      recordResidencyRegion: recordRegion,
      callerResidencyRegion: callerRegion,
      reader: options.reader,
      readAtIso: readAt.toISOString(),
    },
  };
}

// ── Unified cost report enforcement (AC #5) ─────────────────────────────────

/**
 * A single cost-attribution row consumed by `groupCostByRegion()`. Mirrors
 * the cost-row shape the unified cost report would emit per RFC-0019 OQ-7
 * (embedding cost) and downstream signal-pipeline cost extensions.
 *
 * `residencyRegion` is the region the cost was incurred for (e.g. clustering
 * EU-tagged signals via an EU-region embedding provider). When the adapter
 * didn't surface a region, the row carries `'unknown'`.
 */
export interface CostAttributionRow {
  consumerLabel: string;
  costUsd: number;
  residencyRegion: string;
  metadata?: Record<string, unknown>;
}

/**
 * Per-region cost breakdown — output of `groupCostByRegion()`. `__total` is
 * the sum across all regions; per-region entries sum within each region.
 * `__unknown` is the bucket for rows whose `residencyRegion` is `'unknown'`
 * — operators see at a glance how much cost they're attributing to
 * un-region-tagged sources.
 */
export interface CostByRegionBreakdown {
  totalUsd: number;
  perRegion: Record<string, number>;
}

/**
 * Group cost-attribution rows by `residencyRegion` so the unified cost report
 * can break out per-region totals. Pipeline callers feed this with rows from
 * the embedding adapter (`RFC-0019` OQ-7), the LLM classifier (per-signal
 * cost), and any external-API cost (Zendesk / Salesforce). The output is a
 * single normalised breakdown the cost-report surface renders.
 *
 * Rows are summed by region (case-insensitive on the region key). When the
 * input is empty, `totalUsd: 0` and `perRegion: {}`.
 */
export function groupCostByRegion(rows: CostAttributionRow[]): CostByRegionBreakdown {
  const perRegion: Record<string, number> = {};
  let totalUsd = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.costUsd) || r.costUsd < 0) continue; // skip malformed rows
    const region = (r.residencyRegion || 'unknown').toLowerCase();
    perRegion[region] = (perRegion[region] ?? 0) + r.costUsd;
    totalUsd += r.costUsd;
  }
  return { totalUsd, perRegion };
}
