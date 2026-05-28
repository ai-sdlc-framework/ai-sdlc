import type { SignalSourceName } from './types.js';

export class UnknownSignalSource extends Error {
  constructor(public readonly source: string) {
    super(`Unknown signal source adapter: ${source}`);
    this.name = 'UnknownSignalSource';
  }
}

export class SignalSourceUnavailable extends Error {
  constructor(
    public readonly source: SignalSourceName,
    message = `Signal source adapter unavailable: ${source}`,
  ) {
    super(message);
    this.name = 'SignalSourceUnavailable';
  }
}

export class AdapterCredentialInvalid extends Error {
  constructor(
    public readonly source: SignalSourceName,
    message = `Signal source adapter credentials invalid: ${source}`,
  ) {
    super(message);
    this.name = 'AdapterCredentialInvalid';
  }
}

/**
 * RFC-0030 OQ-13.1 v0.3 re-walkthrough: distinct from `AdapterCredentialInvalid`.
 *
 * Raised when an adapter probes its environment for the required credential
 * env var (e.g. `SIGNAL_ZENDESK_PAT`) and the var is missing or empty.
 * Downstream: emit `Decision: adapter-credential-not-configured` and surface
 * an operator SETUP task ("create + set this env var"). Pipeline continues
 * with the remaining valid adapters (AC #4).
 */
export class AdapterCredentialNotConfigured extends Error {
  constructor(
    public readonly source: SignalSourceName,
    public readonly envVarName: string,
    message = `Signal source adapter credential not configured: ${source} (missing env var ${envVarName})`,
  ) {
    super(message);
    this.name = 'AdapterCredentialNotConfigured';
  }
}

/**
 * RFC-0030 OQ-13.1 v0.3 re-walkthrough: distinct from `AdapterCredentialInvalid`.
 *
 * Raised when an adapter has the credential env var present BUT the auth call
 * against the upstream service is rejected (401 / 403). Downstream: emit
 * `Decision: adapter-credential-rejected` and surface an operator ROTATION
 * task ("rotate / re-generate this credential"). Pipeline continues with the
 * remaining valid adapters (AC #4).
 */
export class AdapterCredentialRejected extends Error {
  constructor(
    public readonly source: SignalSourceName,
    message = `Signal source adapter credentials rejected by upstream: ${source}`,
  ) {
    super(message);
    this.name = 'AdapterCredentialRejected';
  }
}

/**
 * RFC-0030 OQ-13.1 v0.3 re-walkthrough: refuse OAuth-required adapters at
 * registration. Phase 1 ships ENV-VAR-ONLY adapters; OAuth-required adapters
 * (full Salesforce / HubSpot integrations, Zendesk-with-OAuth-scopes) wait
 * for the future credential-management RFC. Adapters that declare
 * `requiresOAuth = true` cannot register; the registry returns a Decision
 * pointing the operator at the pending RFC.
 */
export class AdapterRequiresCredentialMgmtRfc extends Error {
  constructor(
    public readonly source: SignalSourceName,
    message = `Adapter ${source} requires OAuth credential management; deferred to future RFC`,
  ) {
    super(message);
    this.name = 'AdapterRequiresCredentialMgmtRfc';
  }
}

export class ManualSignalIncomplete extends Error {
  readonly source = 'signal-source-manual' as const;

  constructor(
    public readonly sourceId?: string,
    message = 'manual signal missing required attestation fields',
  ) {
    super(message);
    this.name = 'ManualSignalIncomplete';
  }
}

/**
 * RFC-0030 OQ-13.4 v0.3 re-walkthrough: per-operator rate-limit at signal
 * entry. When a manual signal would exceed `manualEntry.dailyCapPerOperator`
 * for the attested operator (in UTC-day buckets), the adapter raises this
 * error. Downstream: emit `Decision: manual-signal-rate-limit-exceeded` and
 * surface an operator BATCH-REVIEW escalation path.
 */
export class ManualSignalRateLimitExceeded extends Error {
  readonly source = 'signal-source-manual' as const;

  constructor(
    public readonly attestedBy: string,
    public readonly dailyCap: number,
    public readonly utcDate: string,
    public readonly sourceId?: string,
    message = `Manual signal rate limit exceeded for ${attestedBy} on ${utcDate} (cap: ${dailyCap}/day)`,
  ) {
    super(message);
    this.name = 'ManualSignalRateLimitExceeded';
  }
}
