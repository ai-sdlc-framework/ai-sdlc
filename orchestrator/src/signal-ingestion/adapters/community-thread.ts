import {
  AdapterCredentialInvalid,
  AdapterCredentialNotConfigured,
  AdapterCredentialRejected,
} from '../errors.js';
import type { RawSignal, SignalSourceAdapter } from '../types.js';

/**
 * Default env var holding either a Discord bot token or a Slack bot token
 * per RFC-0030 OQ-13.1 v0.3 re-walkthrough. Both platforms support bot-token
 * based access without OAuth; the env var name follows the
 * `SIGNAL_<PLATFORM>_BOT_TOKEN` convention.
 *
 * Adapters wired to a single platform set the env var name explicitly via
 * `envVarName`; the default `SIGNAL_COMMUNITY_BOT_TOKEN` is the generic
 * fallback for adopters who alias their secret manager output.
 */
export const DEFAULT_COMMUNITY_THREAD_ENV_VAR = 'SIGNAL_COMMUNITY_BOT_TOKEN';

export interface CommunityThreadAdapterOptions {
  signals?: RawSignal[];
  available?: boolean;
  /** Legacy test override (pre-OQ-13.1 v0.3); emits collapsed Decision. */
  credentialInvalid?: boolean;
  /** RFC-0030 OQ-13.1 v0.3: env-var missing test override. */
  credentialNotConfigured?: boolean;
  /** RFC-0030 OQ-13.1 v0.3: env-var present but upstream rejected. */
  credentialRejected?: boolean;
  /** Override the env var name (e.g. `SIGNAL_DISCORD_BOT_TOKEN`). */
  envVarName?: string;
  /** Optional explicit env accessor (test seam). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * When `true`, the adapter probes its env var. See `SupportTicketAdapter`
   * for backward-compat rationale (`false` default).
   */
  probeEnvVar?: boolean;
}

export class CommunityThreadSignalSourceAdapter implements SignalSourceAdapter {
  readonly name = 'signal-source-community-thread';
  readonly defaultTier = 2;
  /** OAuth NOT required for v1 Discord-bot-token / Slack-bot-token model. */
  readonly requiresOAuth = false;

  constructor(private readonly options: CommunityThreadAdapterOptions = {}) {}

  get envVarName(): string {
    return this.options.envVarName ?? DEFAULT_COMMUNITY_THREAD_ENV_VAR;
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
