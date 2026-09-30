/** How a capability ran on a given invocation. */
export type CapabilityOutcome = 'live' | 'shadow' | 'degraded';

/** Current status of a capability: its latest outcome, or `never-observed`. */
export type CapabilityStatus = CapabilityOutcome | 'never-observed';

export interface CapabilityDefinition {
  id: string;
  title: string;
  /** RFC id or source path that specified the capability. */
  specifiedBy: string;
  /** One sentence: what happens when the capability is degraded. */
  fallback: string;
  /** One sentence: how to turn the capability on. */
  enable: string;
}

export interface CapabilityRecord {
  counts: Record<CapabilityOutcome, number>;
  firstLiveAt?: string;
  lastLiveAt?: string;
  lastShadowAt?: string;
  lastDegradedAt?: string;
  lastDegradedReason?: string;
  /** Outcome of the most recent report. */
  lastOutcome?: CapabilityOutcome;
  /** True when the id is not in the registry. */
  unregistered?: boolean;
}

export interface CapabilityStateFile {
  version: 1;
  capabilities: Record<string, CapabilityRecord>;
}

export interface CapabilityStateRow {
  id: string;
  title?: string;
  status: CapabilityStatus;
  counts: Record<CapabilityOutcome, number>;
  firstLiveAt?: string;
  lastLiveAt?: string;
  lastShadowAt?: string;
  lastDegradedAt?: string;
  lastDegradedReason?: string;
  unregistered: boolean;
}
