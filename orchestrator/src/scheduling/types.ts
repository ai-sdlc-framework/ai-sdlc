/**
 * Subscription-aware scheduling types per RFC-0010 §14. The dispatcher consults a
 * SubscriptionLedger keyed by (harness, accountId, tenant) on every admission decision
 * so parallel agents on the same vendor account correctly share quota.
 */

export type BillingMode = 'session-window' | 'monthly-cap' | 'pay-per-token';

export type QuotaSource = 'self-tracked' | 'authoritative-api' | 'authoritative-with-fallback';

export interface OffPeakSchedule {
  enabled: boolean;
  multiplier: number;
  schedule: Array<{
    /** IANA timezone (e.g., 'America/Los_Angeles'). */
    tz: string;
    /** Hour range like '22-06' (wraps midnight). */
    hours: string;
    /** Optional comma-separated days like 'Sat,Sun'. */
    daysOfWeek?: string;
  }>;
  /** ISO 8601 date the operator last verified the schedule against vendor docs. */
  lastVerified?: string;
}

export interface SubscriptionPlan {
  /** Resource metadata.name. */
  name: string;
  /** Harness this plan applies to. */
  harness: string;
  billingMode: BillingMode;
  /** Required when billingMode is session-window. ISO 8601 duration (e.g., 'PT5H'). */
  windowDuration?: string;
  /** Required when billingMode is session-window or monthly-cap. */
  windowQuotaTokens?: number;
  offPeak?: OffPeakSchedule;
  pacingTarget: number;
  hardCap: number;
  quotaSource: QuotaSource;
}

export type Schedule = 'now' | 'off-peak' | 'quota-permitting' | 'defer-if-low-priority';

export interface TokenEstimate {
  input: number;
  output: number;
  /** When true, rolling updates do NOT supersede the operator-declared values. */
  frozen?: boolean;
}

export interface LedgerKey {
  harness: string;
  accountId: string;
  tenant: string;
}

export const DEFAULT_TENANT = '__default__';
export const COLD_START_DEFAULT_INPUT = 50_000;
export const COLD_START_DEFAULT_OUTPUT = 10_000;
export const ESTIMATE_VARIANCE_THRESHOLD = 0.5;
export const ROLLING_WINDOW_SIZE = 20;

export interface WindowState {
  windowStart: Date;
  windowEnd: Date;
  consumedTokens: number;
  quotaTokens: number;
  multiplier: number;
  utilizationFraction: number;
  pacingTarget: number;
  hardCap: number;
}

export type AdmissionDecision =
  | { kind: 'yes'; reason: string }
  | { kind: 'wait-until'; until: Date; reason: string }
  | { kind: 'no'; reason: string; blockedBy: 'hardCap' | 'cost-budget' | 'maxBudgetUsd' };

export interface BurnDownReport {
  harness: string;
  ledgerKey: LedgerKey;
  windowEnd: string;
  subscriptionTokensConsumed: number;
  quotaTokens: number;
  subscriptionUtilizationFraction: number;
  dollarsSpent: number;
  shadowCostUsd: number;
  pacingTarget: number;
  projectedUtilization: number;
  queueDepth: number;
  recommendation: 'under-pacing' | 'on-pace' | 'over-pacing';
}

export type LedgerEvent =
  | { type: 'AdmissionDenied'; ledgerKey: LedgerKey; blockedBy: string; detail: string }
  | { type: 'OffPeakDeferralExceeded'; ledgerKey: LedgerKey; stage: string }
  | { type: 'BurnDownReport'; report: BurnDownReport }
  | {
      type: 'EstimateBootstrapped';
      stage: string;
      coldStartDefault: TokenEstimate;
      firstRunActual: TokenEstimate;
      newRollingEstimate: TokenEstimate;
    }
  | {
      type: 'EstimateVariance';
      stage: string;
      declared: TokenEstimate;
      observed: TokenEstimate;
      ratio: number;
    }
  | { type: 'MissingEstimate'; stage: string }
  | {
      type: 'LedgerReconciliation';
      ledgerKey: LedgerKey;
      previousSource: QuotaSource;
      newSource: QuotaSource;
      selfTracked: number;
      authoritative: number;
      absoluteDivergence: number;
      relativeDivergence: number;
    }
  | { type: 'LedgerPooled'; ledgerKey: LedgerKey; pipelines: string[] }
  | { type: 'LedgerKeyAmbiguous'; harness: string; pipeline: string }
  | { type: 'TenantShareInvalid'; harness: string; accountId: string; sumOfShares: number };
