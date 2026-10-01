/**
 * Usage ledger record types. One record per model call.
 *
 * The ledger stores counts, identifiers and attribution only. It never holds
 * prompt, response, file content or tool output.
 */

export type ModelCallHarness = 'claude-code' | 'codex' | 'opencode' | 'direct';

export type BillingPool =
  | 'subscription-interactive'
  | 'agent-sdk-credit'
  | 'api-key'
  | 'codex-plan'
  | 'pay-per-token'
  | 'unknown';

export type UsageScope = 'framework' | 'other';

export interface ModelCallTokens {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  /** Subset of `output` spent on reasoning, where reported. */
  reasoning?: number;
}

export interface ModelCallRecord {
  schemaVersion: 'v1';
  /** Provider message id; the deduplication key. */
  callId: string;
  requestId?: string;
  /** ISO timestamp of the call. */
  ts: string;
  harness: ModelCallHarness;
  provider: string;
  /** Exact model id as reported by the call. */
  model: string;
  tokens: ModelCallTokens;
  billingPool: BillingPool;
  sessionId: string;
  agentId?: string;
  /** For example 'main-session' or 'ai-sdlc:developer'. */
  agentRole: string;
  scope: UsageScope;
  /** Framework scope only. */
  repo?: string;
  /** Framework scope only. */
  taskId?: string;
  /**
   * True when the harness reported only a session total: the whole total is in
   * `tokens.input` and the split between token classes is unknown.
   */
  breakdownMissing?: boolean;
  /** Omitted for scope 'other'. */
  source?: { file: string; offset: number };
}

/** Options shared by every function that touches the usage directory. */
export interface UsageStoreOptions {
  /** Explicit usage directory. Wins over `AI_SDLC_USAGE_DIR` and the home default. */
  dir?: string;
}

export interface AppendResult {
  written: number;
  skipped: number;
  /** Records rejected because they do not match the record schema. */
  invalid: number;
}

export interface ModelCallFilter {
  /** Inclusive lower bound on `ts` (ISO string or Date). */
  from?: string | Date;
  /** Exclusive upper bound on `ts` (ISO string or Date). */
  to?: string | Date;
  model?: string;
  agentRole?: string;
  scope?: UsageScope;
  repo?: string;
  taskId?: string;
  billingPool?: BillingPool;
}

export type PriceStatus = 'active' | 'held' | 'manual';

/** Per-million-token prices in USD for each token class. */
export interface PriceRow {
  model: string;
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWrite5mPer1M: number;
  cacheWrite1hPer1M: number;
  source: string;
  url: string;
  /** ISO time the price was observed. */
  fetchedAt: string;
  /** Date (YYYY-MM-DD or ISO) from which the row applies. */
  effectiveFrom: string;
  status: PriceStatus;
}

export interface CallCostBreakdown {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  total: number;
}

export const UNPRICED = 'unpriced' as const;
export type Unpriced = typeof UNPRICED;
