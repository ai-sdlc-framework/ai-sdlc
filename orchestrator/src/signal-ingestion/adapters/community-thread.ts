import { AdapterCredentialInvalid } from '../errors.js';
import type { RawSignal, SignalSourceAdapter } from '../types.js';

export interface CommunityThreadAdapterOptions {
  signals?: RawSignal[];
  available?: boolean;
  credentialInvalid?: boolean;
}

export class CommunityThreadSignalSourceAdapter implements SignalSourceAdapter {
  readonly name = 'signal-source-community-thread';
  readonly defaultTier = 2;

  constructor(private readonly options: CommunityThreadAdapterOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    return this.options.available ?? true;
  }

  async fetchSignals(since: Date): Promise<RawSignal[]> {
    if (this.options.credentialInvalid) {
      throw new AdapterCredentialInvalid(this.name);
    }
    return (this.options.signals ?? []).filter((signal) => signal.sourceTimestamp >= since);
  }
}
