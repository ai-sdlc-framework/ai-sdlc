import { ManualSignalIncomplete } from '../errors.js';
import type { RawSignal, SignalSourceAdapter } from '../types.js';

export type ManualSignalInput = Omit<RawSignal, 'attestedAt'> & { attestedAt?: Date };

export class ManualSignalSourceAdapter implements SignalSourceAdapter {
  readonly name = 'signal-source-manual';
  readonly defaultTier = 1;
  private readonly signals: RawSignal[] = [];

  constructor(initialSignals: ManualSignalInput[] = []) {
    for (const signal of initialSignals) this.addSignal(signal);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  addSignal(input: ManualSignalInput, now: Date = new Date()): RawSignal {
    if (!input.attestedBy) {
      throw new ManualSignalIncomplete(input.sourceId);
    }
    const signal: RawSignal = {
      ...input,
      attestedAt: input.attestedAt ?? now,
    };
    this.signals.push(signal);
    return signal;
  }

  async fetchSignals(since: Date): Promise<RawSignal[]> {
    return this.signals.filter((signal) => signal.sourceTimestamp >= since);
  }
}
