import {
  AdapterCredentialInvalid,
  AdapterCredentialNotConfigured,
  AdapterCredentialRejected,
  ManualSignalIncomplete,
  ManualSignalRateLimitExceeded,
  SignalSourceUnavailable,
  UnknownSignalSource,
} from './errors.js';
import type {
  AdapterCredentialInvalidDecision,
  AdapterCredentialNotConfiguredDecision,
  AdapterCredentialRejectedDecision,
  AdapterRequiresCredentialMgmtRfcDecision,
  ManualSignalIncompleteDecision,
  ManualSignalRateLimitExceededDecision,
  RawSignal,
  SignalFetchResult,
  SignalSourceAdapter,
  SignalSourceName,
} from './types.js';

export class SignalSourceRegistry {
  private readonly adapters = new Map<SignalSourceName, SignalSourceAdapter>();

  /**
   * Register an adapter. Per RFC-0030 OQ-13.1 v0.3 re-walkthrough, adapters
   * that declare `requiresOAuth = true` are REFUSED at registration with a
   * structured `AdapterRequiresCredentialMgmtRfcDecision` returned to the
   * caller. Phase 1 ships env-var-based adapters ONLY; OAuth lifecycle
   * waits for the future credential-management RFC.
   *
   * Returns the `Decision` record when refused; `null` when registered
   * successfully. Caller (typically the pipeline bootstrap) forwards the
   * Decision into the catalog.
   */
  register(adapter: SignalSourceAdapter): AdapterRequiresCredentialMgmtRfcDecision | null {
    if (adapter.requiresOAuth === true) {
      return {
        type: 'Decision',
        decision: 'adapter-requires-credential-mgmt-rfc',
        adapter: adapter.name,
        message:
          `Adapter ${adapter.name} declares requiresOAuth=true; OAuth credential ` +
          `lifecycle (refresh tokens, scopes) is deferred to the future ` +
          `credential-management RFC. Phase 1 ships env-var-based adapters only.`,
      };
    }
    this.adapters.set(adapter.name, adapter);
    return null;
  }

  get(name: string): SignalSourceAdapter {
    const adapter = this.adapters.get(name as SignalSourceName);
    if (!adapter) throw new UnknownSignalSource(name);
    return adapter;
  }

  has(name: string): boolean {
    return this.adapters.has(name as SignalSourceName);
  }

  list(): SignalSourceName[] {
    return Array.from(this.adapters.keys());
  }
}

export async function getSignalSourceAdapter(
  registry: SignalSourceRegistry,
  name: string,
): Promise<SignalSourceAdapter> {
  const adapter = registry.get(name);
  if (!(await adapter.isAvailable())) {
    throw new SignalSourceUnavailable(adapter.name);
  }
  return adapter;
}

/**
 * Fetch from every adapter, converting credential failures into non-blocking
 * Decision records so remaining adapters can continue per RFC-0030 OQ-13.1.
 *
 * **OQ-13.1 v0.3 re-walkthrough — dual Decision routing**:
 *  - `AdapterCredentialNotConfigured` → `Decision: adapter-credential-not-configured`
 *    (env var missing; setup task downstream).
 *  - `AdapterCredentialRejected` → `Decision: adapter-credential-rejected`
 *    (env var present but auth failed; rotation task downstream).
 *  - Legacy `AdapterCredentialInvalid` → `Decision: adapter-credential-invalid`
 *    (preserved for backward-compat; adapters that don't yet probe env vars).
 *
 * **OQ-13.4 v0.3 re-walkthrough — manual rate-limit routing**:
 *  - `ManualSignalRateLimitExceeded` → `Decision: manual-signal-rate-limit-exceeded`
 *    (over the per-operator UTC-day cap; batch-review escalation downstream).
 *
 * Pipeline continues with remaining valid adapters in every case (AC #4).
 */
export async function fetchSignalsFromAvailableAdapters(
  adapters: readonly SignalSourceAdapter[],
  since: Date,
): Promise<SignalFetchResult> {
  const signals: RawSignal[] = [];
  const decisions: Array<
    | AdapterCredentialInvalidDecision
    | AdapterCredentialNotConfiguredDecision
    | AdapterCredentialRejectedDecision
    | ManualSignalIncompleteDecision
    | ManualSignalRateLimitExceededDecision
  > = [];

  for (const adapter of adapters) {
    try {
      if (!(await adapter.isAvailable())) continue;
      signals.push(...(await adapter.fetchSignals(since)));
    } catch (err) {
      if (err instanceof AdapterCredentialNotConfigured) {
        decisions.push({
          type: 'Decision',
          decision: 'adapter-credential-not-configured',
          adapter: adapter.name,
          envVarName: err.envVarName,
          message:
            `Signal source adapter ${adapter.name} is not configured: env var ` +
            `${err.envVarName} is missing or empty. Set the env var to enable this adapter; ` +
            `pipeline continues with remaining valid adapters.`,
        });
        continue;
      }
      if (err instanceof AdapterCredentialRejected) {
        decisions.push({
          type: 'Decision',
          decision: 'adapter-credential-rejected',
          adapter: adapter.name,
          message:
            `Signal source adapter ${adapter.name} credential rejected by upstream service. ` +
            `Rotate / re-generate the credential; pipeline continues with remaining valid adapters.`,
        });
        continue;
      }
      if (err instanceof AdapterCredentialInvalid) {
        decisions.push({
          type: 'Decision',
          decision: 'adapter-credential-invalid',
          adapter: adapter.name,
          message: `Signal source adapter credentials invalid: ${adapter.name}`,
        });
        continue;
      }
      if (err instanceof ManualSignalIncomplete) {
        decisions.push({
          type: 'Decision',
          decision: 'manual-signal-incomplete',
          adapter: 'signal-source-manual',
          ...(err.sourceId ? { sourceId: err.sourceId } : {}),
          message: 'Manual signal missing required attestation fields',
        });
        continue;
      }
      if (err instanceof ManualSignalRateLimitExceeded) {
        decisions.push({
          type: 'Decision',
          decision: 'manual-signal-rate-limit-exceeded',
          adapter: 'signal-source-manual',
          attestedBy: err.attestedBy,
          utcDate: err.utcDate,
          dailyCap: err.dailyCap,
          ...(err.sourceId ? { sourceId: err.sourceId } : {}),
          message:
            `Manual signal rate limit exceeded for ${err.attestedBy} on ${err.utcDate} ` +
            `(cap: ${err.dailyCap}/day). Operator may escalate via batch review.`,
        });
        continue;
      }
      throw err;
    }
  }

  return { signals, decisions };
}
