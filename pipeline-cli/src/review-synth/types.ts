/**
 * Types for the plan and synthesize stages of the staged review.
 *
 * INPUT CONTRACT: the evidence bundle is the executor stage's own `EvidenceBundle`
 * (see `review-plan/executor.ts`); only a probe with status `ok` AND real evidence is coverage.
 *
 * @module review-synth/types
 */

import type { Severity } from '../types.js';

/** One piece of evidence a finding rests on: a probe id and, optionally, a quoted excerpt. */
export interface FindingEvidenceRef {
  probeId: string;
  excerpt?: string;
}

export interface StagedFinding {
  severity: Severity;
  file?: string | null;
  line?: number | null;
  message: string;
  evidence: FindingEvidenceRef[];
}

export interface StagedVerdict {
  approved: boolean;
  findings: StagedFinding[];
  summary: string;
  promptInjectionDetected: boolean;
  /** Findings removed by grounding before aggregation. Set by `groundFindings`. */
  groundingDropped?: number;
}

export type DropReason =
  | 'no-evidence'
  | 'unknown-probe'
  | 'probe-not-completed'
  /** The probe has status `ok` but holds no evidence (see `entryHasEvidence`). */
  | 'probe-no-evidence'
  | 'excerpt-not-in-bundle';

export interface DroppedFinding {
  finding: StagedFinding;
  reason: DropReason;
  detail: string;
}

export interface GroundingResult {
  /** The verdict with ungrounded findings removed and `groundingDropped` set. */
  verdict: StagedVerdict;
  dropped: DroppedFinding[];
}

/** Record of what a budget left out, written to the stage's transcript. */
export interface TruncationRecord {
  section: string;
  budgetTokens: number;
  usedTokens: number;
  keptCount: number;
  omittedCount: number;
  /** Ids of the omitted items, in rank order. */
  omittedIds: string[];
}
