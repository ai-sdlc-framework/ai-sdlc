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
  decisions: Array<AdapterCredentialInvalidDecision | ManualSignalIncompleteDecision>;
}
