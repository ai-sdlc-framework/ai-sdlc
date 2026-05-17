import { AdapterCredentialInvalid } from '../errors.js';
import type { RawSignal, SignalSourceAdapter } from '../types.js';

export interface SupportTicketAdapterOptions {
  signals?: RawSignal[];
  available?: boolean;
  credentialInvalid?: boolean;
}

export class SupportTicketSignalSourceAdapter implements SignalSourceAdapter {
  readonly name = 'signal-source-support-ticket';
  readonly defaultTier = 1;

  constructor(private readonly options: SupportTicketAdapterOptions = {}) {}

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
