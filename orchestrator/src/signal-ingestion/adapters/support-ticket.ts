import {
  AdapterCredentialInvalid,
  AdapterCredentialNotConfigured,
  AdapterCredentialRejected,
} from '../errors.js';
import type { RawSignal, SignalSourceAdapter } from '../types.js';

/**
 * Default env var holding the Zendesk personal access token (PAT) per
 * RFC-0030 OQ-13.1 v0.3 re-walkthrough. Env-var-based credential model;
 * OAuth-scoped Zendesk integration deferred to the credential-management RFC.
 */
export const DEFAULT_SUPPORT_TICKET_ENV_VAR = 'SIGNAL_ZENDESK_PAT';

export interface SupportTicketAdapterOptions {
  signals?: RawSignal[];
  available?: boolean;
  /**
   * Legacy test override (pre-OQ-13.1 v0.3): emits the collapsed
   * `adapter-credential-invalid` Decision. Preserved for backward-compat.
   * New tests should use `credentialNotConfigured` or `credentialRejected`.
   */
  credentialInvalid?: boolean;
  /** RFC-0030 OQ-13.1 v0.3: env-var missing test override. */
  credentialNotConfigured?: boolean;
  /** RFC-0030 OQ-13.1 v0.3: env-var present but upstream rejected test override. */
  credentialRejected?: boolean;
  /** Override the env var name (defaults to `SIGNAL_ZENDESK_PAT`). */
  envVarName?: string;
  /** Optional explicit env accessor (test seam). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * When `true`, the adapter probes its env var as part of availability /
   * fetchSignals. Defaults to `false` so the legacy in-memory test usage
   * (passing `signals: [...]` without env-var setup) continues to work.
   *
   * v1-shipping deployments should set `probeEnvVar: true` to opt in to the
   * OQ-13.1 v0.3 dual-Decision routing.
   */
  probeEnvVar?: boolean;
}

export class SupportTicketSignalSourceAdapter implements SignalSourceAdapter {
  readonly name = 'signal-source-support-ticket';
  readonly defaultTier = 1;
  /** OAuth NOT required for the v1 Zendesk PAT credential model. */
  readonly requiresOAuth = false;

  constructor(private readonly options: SupportTicketAdapterOptions = {}) {}

  /** Resolve the env var name for this adapter. */
  get envVarName(): string {
    return this.options.envVarName ?? DEFAULT_SUPPORT_TICKET_ENV_VAR;
  }

  async isAvailable(): Promise<boolean> {
    if (this.options.available !== undefined) return this.options.available;
    if (this.options.probeEnvVar) {
      const env = this.options.env ?? process.env;
      const v = env[this.envVarName];
      return typeof v === 'string' && v.trim().length > 0;
    }
    return true;
  }

  async fetchSignals(since: Date): Promise<RawSignal[]> {
    if (this.options.credentialNotConfigured) {
      throw new AdapterCredentialNotConfigured(this.name, this.envVarName);
    }
    if (this.options.credentialRejected) {
      throw new AdapterCredentialRejected(this.name);
    }
    if (this.options.credentialInvalid) {
      throw new AdapterCredentialInvalid(this.name);
    }
    if (this.options.probeEnvVar && this.options.available === undefined) {
      const env = this.options.env ?? process.env;
      const v = env[this.envVarName];
      if (!(typeof v === 'string' && v.trim().length > 0)) {
        throw new AdapterCredentialNotConfigured(this.name, this.envVarName);
      }
    }
    return (this.options.signals ?? []).filter((signal) => signal.sourceTimestamp >= since);
  }
}
