import { AdapterCredentialNotConfigured, AdapterCredentialRejected } from '../errors.js';
import type { RawSignal, SignalSourceAdapter } from '../types.js';

/**
 * RFC-0030 OQ-13.1 v0.3 re-walkthrough: env-var-based in-app-feedback
 * adapter (e.g. Productboard, Pendo, in-house widget). Reads its API key from
 * `SIGNAL_IN_APP_FEEDBACK_API_KEY`. Phase 1 ships env-var-based adapters
 * ONLY; OAuth-required services defer to the future credential-management RFC.
 *
 * Two distinct failure modes per OQ-13.1 v0.3:
 *  - **Not configured** — env var missing or empty → emit setup task.
 *  - **Rejected** — env var present but upstream auth call failed → emit
 *    rotation task.
 *
 * The Phase 1 adapter is in-memory (test fixture mode) — production wiring
 * to a real upstream service is per-deployment. The env-var probe + dual
 * failure-mode split are the contract this adapter ships.
 */
export interface InAppFeedbackAdapterOptions {
  signals?: RawSignal[];
  /**
   * Test override: when set, bypasses the env-var probe and `isAvailable()`
   * returns this value directly. Useful for fixtures that need to simulate
   * "configured but upstream rejected" without touching `process.env`.
   */
  available?: boolean;
  /**
   * Test override: when `true`, `fetchSignals()` raises
   * `AdapterCredentialNotConfigured` regardless of env probe (test seam for
   * forcing the "not configured" Decision path).
   */
  credentialNotConfigured?: boolean;
  /**
   * Test override: when `true`, `fetchSignals()` raises
   * `AdapterCredentialRejected` (env var was present but upstream said 401/403).
   */
  credentialRejected?: boolean;
  /**
   * Override the env var name (defaults to `SIGNAL_IN_APP_FEEDBACK_API_KEY`).
   * Allows adopters to wire to their existing secret-naming convention.
   */
  envVarName?: string;
  /**
   * Optional explicit env accessor (test seam). Defaults to `process.env`.
   * Allows hermetic tests without mutating the global process env.
   */
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_IN_APP_FEEDBACK_ENV_VAR = 'SIGNAL_IN_APP_FEEDBACK_API_KEY';

export class InAppFeedbackSignalSourceAdapter implements SignalSourceAdapter {
  readonly name = 'signal-source-in-app-feedback';
  readonly defaultTier = 1;
  /** OAuth NOT required — env-var-based API key only. */
  readonly requiresOAuth = false;

  constructor(private readonly options: InAppFeedbackAdapterOptions = {}) {}

  /** Resolve the env var name for this adapter. */
  get envVarName(): string {
    return this.options.envVarName ?? DEFAULT_IN_APP_FEEDBACK_ENV_VAR;
  }

  /**
   * Adapter availability: env-var-probe-based. Returns `true` when the
   * configured env var is present and non-empty, OR when the `available`
   * test override is set. Returns `false` otherwise — the registry will
   * surface `Decision: adapter-credential-not-configured` rather than
   * blocking the pipeline.
   */
  async isAvailable(): Promise<boolean> {
    if (this.options.available !== undefined) return this.options.available;
    const env = this.options.env ?? process.env;
    const v = env[this.envVarName];
    return typeof v === 'string' && v.trim().length > 0;
  }

  async fetchSignals(since: Date): Promise<RawSignal[]> {
    // Test overrides take precedence so fixtures can exercise both failure
    // paths regardless of env state.
    if (this.options.credentialNotConfigured) {
      throw new AdapterCredentialNotConfigured(this.name, this.envVarName);
    }
    if (this.options.credentialRejected) {
      throw new AdapterCredentialRejected(this.name);
    }
    // Production path: re-probe env var (unless `available: true` was set as
    // an explicit bypass for hermetic tests that don't care about env probing).
    if (this.options.available === undefined) {
      const env = this.options.env ?? process.env;
      const v = env[this.envVarName];
      if (!(typeof v === 'string' && v.trim().length > 0)) {
        throw new AdapterCredentialNotConfigured(this.name, this.envVarName);
      }
    }
    return (this.options.signals ?? []).filter((signal) => signal.sourceTimestamp >= since);
  }
}
