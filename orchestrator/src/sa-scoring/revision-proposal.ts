/**
 * DIDRevisionProposal mechanism (RFC-0031).
 *
 * Implements the calibration-driven proposal mechanism that fires when the
 * PPA flywheel accumulates sufficient evidence that a DID field has drifted
 * from observed reality.
 *
 * What ships here:
 *   - DIDRevisionProposal event shape + classification logic (§3, §5)
 *   - SoulHealthDiagnostic event for unhealthy-drift path (§7)
 *   - Approval routing by identityClass (§8)
 *   - 14-day expiry + DIDRevisionProposalExpired event (§9)
 *   - lockNoProposal opt-out per field from calibration config (OQ-12.3)
 *   - Rejection learnings flowing back into the calibration log (OQ-12.5)
 *   - Multi-field bundling explicitly deferred to v2 (OQ-12.2)
 *   - Confidence derived from sample size + classification clarity + identityClass (OQ-12.1)
 *   - PPA generates proposal regardless of pillar; pillar lead approves (OQ-12.4)
 *
 * Trigger entry point: `evaluateRevisionProposal()` — called after drift
 * is detected (i.e., a `SoulDriftDetected` event fires). One call per
 * field; bundling is v2.
 *
 * Scope: Shard-DID only. Platform-level DID changes are human-initiated.
 */

import { randomUUID } from 'crypto';

// ── Constants ────────────────────────────────────────────────────────

/** Default trigger thresholds (§6). Configurable per deployment. */
export const DEFAULT_DISMISS_THRESHOLD = 10;
export const DEFAULT_DEMAND_MISALIGNMENT_THRESHOLD = 0.3;
export const DEFAULT_DRIFT_EVENTS_THRESHOLD = 3;
export const DEFAULT_TRIGGER_WINDOW_DAYS = 60;
export const DEFAULT_PROPOSAL_EXPIRY_DAYS = 14;

/** Classification thresholds per §7. */
export const HEALTHY_ICP_MATCH_MIN = 0.6;
export const UNHEALTHY_ICP_MATCH_MAX = 0.3;

// ── Core event shapes ────────────────────────────────────────────────

export type DriftClassification = 'healthy' | 'unhealthy' | 'ambiguous';
export type IdentityClass = 'core' | 'evolving';
export type ApprovalPath = 'triad' | 'pillarLead';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ProposalConfidence = 'high' | 'medium' | 'low';

export interface ClassificationEvidence {
  /** [0,1]; high = healthy signal source (ICP-matched demand clusters). */
  demandClusterICPMatchRate: number;
  /** [0,1]; high = validated loss signal (churn-correlated demand). */
  demandClusterChurnCorrelation: number;
  /** High dismiss + low escalate = DID is stale (healthy evolution). */
  dismissToEscalateRatio: number;
  /** True = core identity field affected; more caution warranted. */
  coreDIDFieldsAffected: boolean;
}

export interface TriggerEvidence {
  /** Dismiss-signal count over the trigger window. */
  dismissSignals: number;
  escalateSignals: number;
  /** SA gap between demand clusters and DID field (0=aligned, 1=fully misaligned). */
  demandMisalignment: number;
  /** SoulDriftDetected events attributable to this field. */
  driftEvents: number;
  /** ISO-8601 duration string for the evaluation window, e.g. "P60D". */
  triggerWindow: string;
}

export interface DIDRevisionProposalEvent {
  type: 'DIDRevisionProposal';
  proposalId: string;
  /** MUST be 'shard' — platform proposals are not generated. */
  scope: 'shard';
  shardId: string;
  field: string;
  currentValue: unknown;
  proposedValue: unknown;
  identityClass: IdentityClass | undefined;
  classification: DriftClassification;
  classificationEvidence: ClassificationEvidence;
  triggerEvidence: TriggerEvidence;
  confidence: ProposalConfidence;
  approvalPath: ApprovalPath;
  expiresAt: string;
  createdAt: string;
  /** Current lifecycle status. */
  status: ProposalStatus;
}

/** Emitted on unhealthy drift (§7) instead of a DIDRevisionProposalEvent. */
export interface SoulHealthDiagnosticEvent {
  type: 'SoulHealthDiagnostic';
  proposalId: string;
  shardId: string;
  field: string;
  classification: 'unhealthy';
  classificationEvidence: ClassificationEvidence;
  triggerEvidence: TriggerEvidence;
  /** Recommendation for unhealthy drift — tighten admission or review demand source. */
  recommendation: 'tighten-admission-threshold' | 'review-demand-source';
  createdAt: string;
}

/** Emitted by `archiveExpiredProposals()` for each expired proposal. */
export interface DIDRevisionProposalExpiredEvent {
  type: 'DIDRevisionProposalExpired';
  proposalId: string;
  shardId: string;
  field: string;
  classification: DriftClassification;
  createdAt: string;
  expiredAt: string;
}

/** Emitted when a proposal is rejected; flows back into the calibration log. */
export interface ProposalRejectionRecord {
  proposalId: string;
  shardId: string;
  field: string;
  rejectedBy: string;
  rationale: string;
  rejectedAt: string;
  classification: DriftClassification;
  /** Confidence weight carried forward into future trigger evaluations. */
  rejectionPrecedentWeight: number;
}

// ── Classification logic (§7) ────────────────────────────────────────

/**
 * Classify drift as healthy / unhealthy / ambiguous per RFC-0031 §7.
 *
 * ```
 * healthy:    icpMatchRate > 0.6  AND NOT coreDIDFieldsAffected
 * unhealthy:  icpMatchRate < 0.3  OR (coreDIDFieldsAffected AND dismissToEscalateRatio < 1.0)
 * ambiguous:  everything else
 * ```
 */
export function classifyDrift(evidence: ClassificationEvidence): DriftClassification {
  const { demandClusterICPMatchRate, coreDIDFieldsAffected, dismissToEscalateRatio } = evidence;

  if (demandClusterICPMatchRate > HEALTHY_ICP_MATCH_MIN && !coreDIDFieldsAffected) {
    return 'healthy';
  }
  if (
    demandClusterICPMatchRate < UNHEALTHY_ICP_MATCH_MAX ||
    (coreDIDFieldsAffected && dismissToEscalateRatio < 1.0)
  ) {
    return 'unhealthy';
  }
  return 'ambiguous';
}

// ── Approval routing (§8) ────────────────────────────────────────────

/**
 * Derive approval path from identityClass per RFC-0031 §8.
 *
 * - `core` → `triad` (all three pillar leads required)
 * - `evolving` → `pillarLead` (owning lead + one other)
 * - `undefined` → `triad` (default-tighten when class is undeclared)
 * - ambiguous classification always → `triad` (§7 override)
 */
export function deriveApprovalPath(
  identityClass: IdentityClass | undefined,
  classification: DriftClassification,
): ApprovalPath {
  // Ambiguous drift always requires triad review regardless of identityClass (§7).
  if (classification === 'ambiguous') return 'triad';
  if (identityClass === 'evolving') return 'pillarLead';
  // 'core' or unset → triad (safer default per §8)
  return 'triad';
}

// ── Confidence calculation (OQ-12.1) ────────────────────────────────

/**
 * Compute proposal confidence from trigger evidence + classification clarity
 * + identityClass (OQ-12.1 resolved position: confidence = f(sample size,
 * classification clarity, identityClass)).
 *
 * - high:   sampleSize ≥ 20 AND classification != 'ambiguous' AND identityClass = 'evolving'
 * - low:    sampleSize < 5  OR classification = 'ambiguous'   OR identityClass = 'core'
 * - medium: everything else
 */
export function computeConfidence(
  triggerEvidence: TriggerEvidence,
  classification: DriftClassification,
  identityClass: IdentityClass | undefined,
): ProposalConfidence {
  const sampleSize =
    triggerEvidence.dismissSignals + triggerEvidence.escalateSignals + triggerEvidence.driftEvents;

  if (sampleSize >= 20 && classification !== 'ambiguous' && identityClass === 'evolving') {
    return 'high';
  }
  if (sampleSize < 5 || classification === 'ambiguous' || identityClass === 'core') {
    return 'low';
  }
  return 'medium';
}

// ── Trigger evaluation ────────────────────────────────────────────────

export interface TriggerConditions {
  /** Dismiss-signal count over the last `triggerWindowDays`. */
  dismissSignals: number;
  escalateSignals: number;
  /** SA gap between demand clusters and DID field — sustained over 3 sprints. */
  demandMisalignment: number;
  /** SoulDriftDetected events attributable to this field (indefinite window). */
  driftEvents: number;
}

export interface TriggerConfig {
  dismissThreshold?: number;
  demandMisalignmentThreshold?: number;
  driftEventsThreshold?: number;
  triggerWindowDays?: number;
}

/**
 * Returns true if ANY trigger condition fires per RFC-0031 §6.
 */
export function triggerConditionMet(
  conditions: TriggerConditions,
  config: TriggerConfig = {},
): boolean {
  const dismissThreshold = config.dismissThreshold ?? DEFAULT_DISMISS_THRESHOLD;
  const demandThreshold =
    config.demandMisalignmentThreshold ?? DEFAULT_DEMAND_MISALIGNMENT_THRESHOLD;
  const driftThreshold = config.driftEventsThreshold ?? DEFAULT_DRIFT_EVENTS_THRESHOLD;

  return (
    conditions.dismissSignals >= dismissThreshold ||
    conditions.demandMisalignment > demandThreshold ||
    conditions.driftEvents >= driftThreshold
  );
}

// ── lockNoProposal opt-out (OQ-12.3) ────────────────────────────────

export interface CalibrationLockConfig {
  /** List of JSON-path field identifiers that should never receive auto-proposals. */
  lockNoProposal?: string[];
}

/**
 * Returns true if the given field is locked from auto-proposals per OQ-12.3.
 *
 * Proposal generation SKIPS locked fields. Operators remove entries from
 * `lockNoProposal` to opt back in.
 */
export function isFieldLocked(field: string, lockConfig: CalibrationLockConfig): boolean {
  return lockConfig.lockNoProposal?.includes(field) ?? false;
}

// ── Proposal generation ───────────────────────────────────────────────

export interface EvaluateRevisionProposalInput {
  shardId: string;
  /** JSON path for the DID field being evaluated, e.g. "soulPurpose.mission". */
  field: string;
  currentValue: unknown;
  /** PPA's best inferred proposed value based on flywheel evidence. */
  proposedValue: unknown;
  identityClass: IdentityClass | undefined;
  triggerConditions: TriggerConditions;
  classificationEvidence: ClassificationEvidence;
  lockConfig?: CalibrationLockConfig;
  config?: TriggerConfig & { expiryDays?: number };
  /** Clock injection for tests. */
  now?: () => number;
}

export type EvaluateRevisionProposalResult =
  | { kind: 'proposal'; event: DIDRevisionProposalEvent }
  | { kind: 'diagnostic'; event: SoulHealthDiagnosticEvent }
  | { kind: 'ambiguous'; proposal: DIDRevisionProposalEvent; diagnostic: SoulHealthDiagnosticEvent }
  | { kind: 'skipped'; reason: 'locked' | 'no-trigger' };

/**
 * Evaluate whether a DIDRevisionProposal should be generated for a given
 * DID field. Entry point called once per field (one-field-per-proposal in
 * v1 per OQ-12.2).
 *
 * Returns a discriminated union describing what was produced:
 * - `proposal`   — healthy drift; one DIDRevisionProposalEvent
 * - `diagnostic` — unhealthy drift; one SoulHealthDiagnosticEvent
 * - `ambiguous`  — both events produced, both flagged for triad review
 * - `skipped`    — field is locked or trigger conditions not met
 */
export function evaluateRevisionProposal(
  input: EvaluateRevisionProposalInput,
): EvaluateRevisionProposalResult {
  // Opt-out check (OQ-12.3)
  if (input.lockConfig && isFieldLocked(input.field, input.lockConfig)) {
    return { kind: 'skipped', reason: 'locked' };
  }

  // Trigger condition check (§6)
  if (!triggerConditionMet(input.triggerConditions, input.config)) {
    return { kind: 'skipped', reason: 'no-trigger' };
  }

  const nowMs = (input.now ?? (() => Date.now()))();
  const expiryDays = input.config?.expiryDays ?? DEFAULT_PROPOSAL_EXPIRY_DAYS;
  const triggerWindowDays = input.config?.triggerWindowDays ?? DEFAULT_TRIGGER_WINDOW_DAYS;
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + expiryDays * 24 * 60 * 60 * 1000).toISOString();

  const triggerEvidence: TriggerEvidence = {
    dismissSignals: input.triggerConditions.dismissSignals,
    escalateSignals: input.triggerConditions.escalateSignals,
    demandMisalignment: input.triggerConditions.demandMisalignment,
    driftEvents: input.triggerConditions.driftEvents,
    triggerWindow: `P${triggerWindowDays}D`,
  };

  const classification = classifyDrift(input.classificationEvidence);
  const approvalPath = deriveApprovalPath(input.identityClass, classification);
  const confidence = computeConfidence(triggerEvidence, classification, input.identityClass);

  if (classification === 'healthy') {
    const event: DIDRevisionProposalEvent = {
      type: 'DIDRevisionProposal',
      proposalId: randomUUID(),
      scope: 'shard',
      shardId: input.shardId,
      field: input.field,
      currentValue: input.currentValue,
      proposedValue: input.proposedValue,
      identityClass: input.identityClass,
      classification,
      classificationEvidence: input.classificationEvidence,
      triggerEvidence,
      confidence,
      approvalPath,
      expiresAt,
      createdAt,
      status: 'pending',
    };
    return { kind: 'proposal', event };
  }

  if (classification === 'unhealthy') {
    const diagnostic = buildDiagnosticEvent(
      input.shardId,
      input.field,
      input.classificationEvidence,
      triggerEvidence,
      createdAt,
    );
    return { kind: 'diagnostic', event: diagnostic };
  }

  // Ambiguous — emit both (§7): proposal flagged for triad review + diagnostic
  const proposal: DIDRevisionProposalEvent = {
    type: 'DIDRevisionProposal',
    proposalId: randomUUID(),
    scope: 'shard',
    shardId: input.shardId,
    field: input.field,
    currentValue: input.currentValue,
    proposedValue: input.proposedValue,
    identityClass: input.identityClass,
    classification: 'ambiguous',
    classificationEvidence: input.classificationEvidence,
    triggerEvidence,
    confidence,
    approvalPath: 'triad', // Always triad for ambiguous (§7 + §8)
    expiresAt,
    createdAt,
    status: 'pending',
  };

  const diagnostic = buildDiagnosticEvent(
    input.shardId,
    input.field,
    input.classificationEvidence,
    triggerEvidence,
    createdAt,
  );

  return { kind: 'ambiguous', proposal, diagnostic };
}

function buildDiagnosticEvent(
  shardId: string,
  field: string,
  classificationEvidence: ClassificationEvidence,
  triggerEvidence: TriggerEvidence,
  createdAt: string,
): SoulHealthDiagnosticEvent {
  const recommendation: SoulHealthDiagnosticEvent['recommendation'] =
    classificationEvidence.demandClusterICPMatchRate < UNHEALTHY_ICP_MATCH_MAX
      ? 'review-demand-source'
      : 'tighten-admission-threshold';

  return {
    type: 'SoulHealthDiagnostic',
    proposalId: randomUUID(),
    shardId,
    field,
    classification: 'unhealthy',
    classificationEvidence,
    triggerEvidence,
    recommendation,
    createdAt,
  };
}

// ── Proposal expiry (§9) ─────────────────────────────────────────────

/**
 * Check whether a proposal has passed its `expiresAt` timestamp.
 */
export function isProposalExpired(proposal: DIDRevisionProposalEvent, nowMs?: number): boolean {
  const now = nowMs ?? Date.now();
  return Date.parse(proposal.expiresAt) <= now;
}

/**
 * Archive expired proposals and emit `DIDRevisionProposalExpired` events.
 * Returns the list of expiry events for caller to process (persist / alert).
 *
 * Per §9: expiry without resolution emits the event — operator alert, not
 * silent dismissal. Auto-archives by setting status to 'expired'.
 */
export function archiveExpiredProposals(
  proposals: DIDRevisionProposalEvent[],
  nowMs?: number,
): {
  expired: DIDRevisionProposalExpiredEvent[];
  remaining: DIDRevisionProposalEvent[];
} {
  const now = nowMs ?? Date.now();
  const expired: DIDRevisionProposalExpiredEvent[] = [];
  const remaining: DIDRevisionProposalEvent[] = [];

  for (const p of proposals) {
    if (p.status !== 'pending') {
      remaining.push(p);
      continue;
    }
    if (isProposalExpired(p, now)) {
      expired.push({
        type: 'DIDRevisionProposalExpired',
        proposalId: p.proposalId,
        shardId: p.shardId,
        field: p.field,
        classification: p.classification,
        createdAt: p.createdAt,
        expiredAt: new Date(now).toISOString(),
      });
      remaining.push({ ...p, status: 'expired' });
    } else {
      remaining.push(p);
    }
  }

  return { expired, remaining };
}

// ── Rejection learnings (OQ-12.5) ────────────────────────────────────

/**
 * Record a proposal rejection and compute the `rejectionPrecedentWeight`
 * to feed back into future trigger evaluations (OQ-12.5 resolved position:
 * rejection rationale captured in calibration log; future trigger evaluations
 * weight rejection-precedent into confidence).
 *
 * Weight formula:
 *   - high-confidence proposals that were rejected signal strong disagreement → 0.8
 *   - medium-confidence → 0.5
 *   - low-confidence → 0.2 (expected noise level, lower weight)
 *
 * Callers persist this record to their calibration log; the next trigger
 * evaluation should factor it in by reducing effective confidence.
 */
export function recordRejection(
  proposal: DIDRevisionProposalEvent,
  rejectedBy: string,
  rationale: string,
  now?: () => number,
): ProposalRejectionRecord {
  const nowMs = (now ?? (() => Date.now()))();

  const weightByConfidence: Record<ProposalConfidence, number> = {
    high: 0.8,
    medium: 0.5,
    low: 0.2,
  };

  return {
    proposalId: proposal.proposalId,
    shardId: proposal.shardId,
    field: proposal.field,
    rejectedBy,
    rationale,
    rejectedAt: new Date(nowMs).toISOString(),
    classification: proposal.classification,
    rejectionPrecedentWeight: weightByConfidence[proposal.confidence],
  };
}

/**
 * Apply rejection precedent to reduce effective trigger confidence.
 * When a field has prior rejection records, the aggregated precedent
 * weight penalises future proposals for the same field.
 *
 * Returns a factor in [0.2, 1.0] to multiply against any computed
 * confidence score. Callers decide how to interpret.
 */
export function computeRejectionPrecedentFactor(
  field: string,
  rejections: readonly ProposalRejectionRecord[],
): number {
  const fieldRejections = rejections.filter((r) => r.field === field);
  if (fieldRejections.length === 0) return 1.0;

  // Average rejection precedent weight across all prior rejections for this field.
  const avgWeight =
    fieldRejections.reduce((acc, r) => acc + r.rejectionPrecedentWeight, 0) /
    fieldRejections.length;

  // The precedent factor reduces future proposal confidence:
  // higher avg rejection weight → lower factor (penalty)
  const rawFactor = 1.0 - avgWeight * 0.5;
  return Math.max(0.2, rawFactor);
}
