/**
 * Signal ingestion source-adapter substrate for RFC-0030 Phase 1.
 *
 * Source adapters fetch raw demand signals from external systems while keeping
 * classification, clustering, and scoring out of this layer.
 */

export type SignalSourceName =
  | 'signal-source-support-ticket'
  | 'signal-source-community-thread'
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
}

export interface SignalSourceAdapter {
  readonly name: SignalSourceName;
  readonly defaultTier: SignalTier;

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

export interface ManualSignalIncompleteDecision {
  type: 'Decision';
  decision: 'manual-signal-incomplete';
  adapter: 'signal-source-manual';
  sourceId?: string;
  message: string;
}

export interface SignalFetchResult {
  signals: RawSignal[];
  decisions: Array<
    | AdapterCredentialInvalidDecision
    | ManualSignalIncompleteDecision
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
