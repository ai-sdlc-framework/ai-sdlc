/**
 * Signal ingestion source-adapter substrate for RFC-0030 Phase 1.
 *
 * Source adapters fetch raw demand signals from external systems while keeping
 * classification, clustering, and scoring out of this layer.
 */

export type SignalSourceName =
  | 'signal-source-support-ticket'
  | 'signal-source-community-thread'
  | 'signal-source-in-app-feedback'
  | 'signal-source-manual'
  | (string & {});

export type SignalTier = 1 | 2;

export type CustomerTier = 'enterprise' | 'mid' | 'smb' | 'free' | 'churned';

export interface RawSignal {
  /** Stable identifier in the source system, e.g. zendesk-ticket-12345. */
  sourceId: string;
  /** Original source timestamp. */
  sourceTimestamp: Date;
  /** Optional customer/account identifier supplied by the source. */
  customerId?: string;
  /** Optional structured tier supplied by the source. */
  customerTier?: CustomerTier;
  /** Free-text signal body. */
  payload: string;
  /** Source-specific structured metadata. */
  metadata?: Record<string, unknown>;
  /** Required for manual signals per RFC-0030 OQ-13.4. */
  attestedBy?: string;
  /** Auto-filled for manual signals when omitted. */
  attestedAt?: Date;
  /**
   * Optional ISO-3166 country code or compliance region tag for the signal's
   * origin (e.g. 'eu', 'us-east', 'gb', 'apac', 'us'). Consumed by the
   * Phase 4 residency-violation gate per RFC-0030 OQ-13.3: when the adopter
   * has a declared regime constraint (via RFC-0022 compliance posture) that
   * requires data residency in a specific region, signals from outside the
   * allowed region(s) are refused and emitted as
   * `Decision: signal-residency-violation`. When undefined, the residency
   * gate skips this signal (no false positives on adapters that don't surface
   * region metadata).
   */
  region?: string;
  /**
   * Optional evidence link for manual signals per RFC-0030 OQ-13.4 v0.3
   * re-walkthrough. When present (call recording URL, ticket URL, transcript
   * link), the audit trail is materially stronger. When absent, the attested
   * observation stands but is flagged in the manual-share quality metric.
   *
   * The pipeline preserves this field through classification + clustering +
   * D1 aggregation so it remains visible in the audit export.
   */
  evidenceUrl?: string;
}

export interface SignalSourceAdapter {
  readonly name: SignalSourceName;
  readonly defaultTier: SignalTier;

  /**
   * RFC-0030 OQ-13.1 v0.3 re-walkthrough: when `true`, this adapter requires
   * OAuth credential management (refresh tokens, scopes) which is deferred to
   * a future credential-management RFC. The Phase 1 registry refuses to fetch
   * from such adapters and emits `Decision: adapter-requires-credential-mgmt-rfc`.
   *
   * Defaults to `false` (undefined → false) — all v1-shipped adapters MUST be
   * env-var-based.
   */
  readonly requiresOAuth?: boolean;

  /**
   * Adapter self-validation. Credential lifecycle is intentionally deferred to
   * a future RFC; Phase 1 only reports whether this adapter can be used.
   */
  isAvailable(): Promise<boolean>;

  /** Fetch immutable signals from the source since the provided timestamp. */
  fetchSignals(since: Date): Promise<RawSignal[]>;
}

export interface AdapterCredentialInvalidDecision {
  type: 'Decision';
  decision: 'adapter-credential-invalid';
  adapter: SignalSourceName;
  message: string;
}

/**
 * RFC-0030 OQ-13.1 v0.3 re-walkthrough: emitted when an adapter's required
 * credential env var is missing or empty. Downstream auto-action: emit a
 * SETUP task asking the operator to set the env var. Pipeline continues with
 * remaining valid adapters.
 *
 * Distinct from `AdapterCredentialRejectedDecision` (env var present but
 * upstream auth call failed). Two distinct operator actions: SETUP vs.
 * ROTATION. v0.2's collapsed `adapter-credential-invalid` is preserved for
 * backward compat — adapters that don't yet probe env vars surface the
 * legacy Decision.
 */
export interface AdapterCredentialNotConfiguredDecision {
  type: 'Decision';
  decision: 'adapter-credential-not-configured';
  adapter: SignalSourceName;
  envVarName: string;
  message: string;
}

/**
 * RFC-0030 OQ-13.1 v0.3 re-walkthrough: emitted when an adapter has the
 * credential env var present BUT the upstream service rejected the auth call
 * (401 / 403). Downstream auto-action: emit a ROTATION task asking the
 * operator to rotate / re-generate the credential. Pipeline continues with
 * remaining valid adapters.
 */
export interface AdapterCredentialRejectedDecision {
  type: 'Decision';
  decision: 'adapter-credential-rejected';
  adapter: SignalSourceName;
  message: string;
}

/**
 * RFC-0030 OQ-13.1 v0.3 re-walkthrough: emitted when an adapter declares
 * `requiresOAuth = true`. Phase 1 ships ENV-VAR-ONLY adapters; OAuth lifecycle
 * (refresh tokens, scopes) is a substantial separate concern deferred to a
 * future credential-management RFC. The registry refuses such adapters and
 * surfaces this Decision; pipeline continues with the env-var-based adapters.
 */
export interface AdapterRequiresCredentialMgmtRfcDecision {
  type: 'Decision';
  decision: 'adapter-requires-credential-mgmt-rfc';
  adapter: SignalSourceName;
  message: string;
}

export interface ManualSignalIncompleteDecision {
  type: 'Decision';
  decision: 'manual-signal-incomplete';
  adapter: 'signal-source-manual';
  sourceId?: string;
  message: string;
}

/**
 * RFC-0030 OQ-13.4 v0.3 re-walkthrough: emitted when a manual signal entry
 * would exceed the per-operator daily cap (default 10/day, configurable via
 * `manualEntry.dailyCapPerOperator`). Downstream auto-action: surface a
 * batch-review escalation task. The signal is REFUSED (not silently dropped)
 * so the operator sees the rejection and can escalate legitimately.
 */
export interface ManualSignalRateLimitExceededDecision {
  type: 'Decision';
  decision: 'manual-signal-rate-limit-exceeded';
  adapter: 'signal-source-manual';
  attestedBy: string;
  /** UTC ISO date (YYYY-MM-DD) of the bucket that overflowed. */
  utcDate: string;
  dailyCap: number;
  sourceId?: string;
  message: string;
}

/**
 * RFC-0030 OQ-13.4 v0.3 re-walkthrough: emitted when the rolling
 * manual/total share metric exceeds the configured threshold (default 30%
 * over a 7-day window). Architectural anti-pattern warning, NOT a block —
 * surfaces that the pipeline is acting as a data-entry tool rather than
 * automated demand-detection. Pipeline continues normally.
 */
export interface ManualSignalShareElevatedDecision {
  type: 'Decision';
  decision: 'manual-signal-share-elevated';
  /** Computed manual/total ratio over the window. */
  manualShare: number;
  /** Threshold that was exceeded (config: `manualEntry.qualityMetric.shareWarningThreshold`). */
  threshold: number;
  windowDays: number;
  manualSignals: number;
  totalSignals: number;
  message: string;
}

export interface SignalFetchResult {
  signals: RawSignal[];
  decisions: Array<
    | AdapterCredentialInvalidDecision
    | AdapterCredentialNotConfiguredDecision
    | AdapterCredentialRejectedDecision
    | AdapterRequiresCredentialMgmtRfcDecision
    | ManualSignalIncompleteDecision
    | ManualSignalRateLimitExceededDecision
    | SignalResidencyViolationDecision
  >;
}

/**
 * Emitted at adapter level when a signal's `region` doesn't match the adopter's
 * declared regime constraints per RFC-0030 OQ-13.3 (composes with RFC-0022
 * Compliance Posture). Adapter response: refuse the signal + log the Decision +
 * emit a `compliance.yaml regimeOverrides` clarification task. Pipeline does
 * NOT halt — the catalog absorbs the violation (G0 non-blocking pipeline contract
 * per RFC-0035).
 */
export interface SignalResidencyViolationDecision {
  type: 'Decision';
  decision: 'signal-residency-violation';
  adapter: SignalSourceName;
  sourceId: string;
  /** The region the signal claimed (or 'unknown' when region metadata absent). */
  signalRegion: string;
  /** Regime IDs (e.g. 'gdpr', 'hipaa') whose residency constraints were violated. */
  violatedRegimes: string[];
  /** Allowed regions per the adopter's regime declaration. */
  allowedRegions: string[];
  message: string;
}
