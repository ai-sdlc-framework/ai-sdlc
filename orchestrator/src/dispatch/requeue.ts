/**
 * PPA re-scoring on requeue per RFC-0010 §9.4 (Q3 resolution).
 *
 * Hybrid algorithm: re-score IF
 *   - time since last triage > 24h, OR
 *   - failure type signals difficulty miscalibration, OR
 *   - operator-triggered requeue.
 *
 * Otherwise trust the original PPA composite. Failure-type taxonomy from §9.4.1
 * encodes which events are transient (trust score) vs intrinsic (re-score).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type FailureEvent =
  | 'MergeConflict'
  | 'RebaseConflict'
  | 'CIFailure'
  | 'HarnessUnavailable'
  | 'BranchQuotaExceeded'
  | 'PortCollision'
  | 'BudgetExceeded'
  | 'OffPeakDeferralExceeded'
  | 'AgentTimeout'
  | 'MaxRetriesExhausted'
  | 'MigrationConflict'
  | 'MigrationFailed'
  | 'EstimateVariance'
  | 'WorktreeOwnershipMismatch';

export type RequeueTrigger = 'automatic' | 'operator';

export interface FailureClassification {
  /** Trust the score on first occurrence; never re-score. */
  alwaysTransient: boolean;
  /** Re-score after this many failures of this type within 24h. */
  reScoreAfterCount: number;
  /** Re-score on first occurrence regardless. */
  alwaysReScore: boolean;
}

const TAXONOMY: Record<FailureEvent, FailureClassification> = {
  MergeConflict: { alwaysTransient: true, reScoreAfterCount: Infinity, alwaysReScore: false },
  RebaseConflict: { alwaysTransient: true, reScoreAfterCount: Infinity, alwaysReScore: false },
  CIFailure: { alwaysTransient: false, reScoreAfterCount: 3, alwaysReScore: false },
  HarnessUnavailable: { alwaysTransient: true, reScoreAfterCount: Infinity, alwaysReScore: false },
  BranchQuotaExceeded: { alwaysTransient: true, reScoreAfterCount: Infinity, alwaysReScore: false },
  PortCollision: { alwaysTransient: true, reScoreAfterCount: Infinity, alwaysReScore: false },
  BudgetExceeded: { alwaysTransient: false, reScoreAfterCount: 2, alwaysReScore: false },
  OffPeakDeferralExceeded: {
    alwaysTransient: true,
    reScoreAfterCount: Infinity,
    alwaysReScore: false,
  },
  AgentTimeout: { alwaysTransient: false, reScoreAfterCount: 2, alwaysReScore: false },
  MaxRetriesExhausted: { alwaysTransient: false, reScoreAfterCount: 1, alwaysReScore: true },
  MigrationConflict: { alwaysTransient: false, reScoreAfterCount: 1, alwaysReScore: true },
  MigrationFailed: { alwaysTransient: false, reScoreAfterCount: 1, alwaysReScore: true },
  EstimateVariance: { alwaysTransient: false, reScoreAfterCount: 1, alwaysReScore: true },
  WorktreeOwnershipMismatch: {
    alwaysTransient: true,
    reScoreAfterCount: Infinity,
    alwaysReScore: false,
  },
};

export interface TriageHistoryEntry {
  timestamp: string;
  trigger: 'original' | 'time-threshold' | 'failure-type' | 'operator-requeue';
  triggerDetail?: string;
  composite: number;
  costUsd?: number;
}

export interface RequeueDecisionInput {
  /** Most recent triage entry for the issue. */
  lastTriage: TriageHistoryEntry;
  /** History of failures observed for this issue (unsorted). */
  failureHistory: Array<{ at: string; event: FailureEvent }>;
  /** The failure that triggered this requeue (the fresh one). */
  triggeringFailure: FailureEvent;
  /** Whether the operator pressed the requeue button. */
  trigger: RequeueTrigger;
  now?: () => Date;
}

export interface RequeueDecision {
  reScore: boolean;
  reason: 'time-threshold' | 'failure-type' | 'operator-requeue' | 'trust-score';
  detail: string;
}

const TIME_THRESHOLD_HOURS = 24;
const FAILURE_HISTORY_WINDOW_HOURS = 24;
const RETRIAGE_STORM_THRESHOLD = 10;

export function decideRequeue(input: RequeueDecisionInput): RequeueDecision {
  const now = (input.now ?? (() => new Date()))();

  if (input.trigger === 'operator') {
    return { reScore: true, reason: 'operator-requeue', detail: 'operator manually requeued' };
  }

  const lastTriage = new Date(input.lastTriage.timestamp);
  const hoursSinceTriage = (now.getTime() - lastTriage.getTime()) / (60 * 60 * 1000);
  if (hoursSinceTriage > TIME_THRESHOLD_HOURS) {
    return {
      reScore: true,
      reason: 'time-threshold',
      detail: `${hoursSinceTriage.toFixed(1)}h since last triage (>24h)`,
    };
  }

  const taxonomy = TAXONOMY[input.triggeringFailure];
  if (taxonomy.alwaysReScore) {
    return {
      reScore: true,
      reason: 'failure-type',
      detail: `${input.triggeringFailure} signals difficulty miscalibration`,
    };
  }

  if (!taxonomy.alwaysTransient) {
    const recent = input.failureHistory.filter((f) => {
      if (f.event !== input.triggeringFailure) return false;
      const at = new Date(f.at);
      const hours = (now.getTime() - at.getTime()) / (60 * 60 * 1000);
      return hours <= FAILURE_HISTORY_WINDOW_HOURS;
    });
    // The triggering failure is not yet in the history — count includes it.
    if (recent.length + 1 >= taxonomy.reScoreAfterCount) {
      return {
        reScore: true,
        reason: 'failure-type',
        detail: `${input.triggeringFailure} occurred ${recent.length + 1}× in 24h (threshold ${taxonomy.reScoreAfterCount})`,
      };
    }
  }

  return {
    reScore: false,
    reason: 'trust-score',
    detail: taxonomy.alwaysTransient
      ? `${input.triggeringFailure} is transient`
      : `${input.triggeringFailure} below re-score threshold`,
  };
}

/**
 * Append a triage event to the per-issue history file, returning whether this
 * crosses the RetriageStorm threshold (>10 retriage events in 24h).
 */
export async function appendTriageHistory(
  artifactsDir: string,
  issueId: string,
  entry: TriageHistoryEntry,
): Promise<{ stormDetected: boolean; eventsInWindow: number }> {
  const path = join(artifactsDir, issueId, 'triage-history.jsonl');
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8');

  // Count retriage events in the last 24h (excludes 'original').
  const eventsInWindow = await countRetriageInWindow(path, new Date());
  return {
    stormDetected: eventsInWindow > RETRIAGE_STORM_THRESHOLD,
    eventsInWindow,
  };
}

async function countRetriageInWindow(path: string, now: Date): Promise<number> {
  const { readFile } = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return 0;
  }
  let count = 0;
  const cutoff = now.getTime() - FAILURE_HISTORY_WINDOW_HOURS * 60 * 60 * 1000;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TriageHistoryEntry;
      if (e.trigger === 'original') continue;
      const at = new Date(e.timestamp).getTime();
      if (at >= cutoff) count++;
    } catch {
      // Skip malformed lines.
    }
  }
  return count;
}
