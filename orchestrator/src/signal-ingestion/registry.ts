import {
  AdapterCredentialInvalid,
  ManualSignalIncomplete,
  SignalSourceUnavailable,
  UnknownSignalSource,
} from './errors.js';
import type {
  AdapterCredentialInvalidDecision,
  ManualSignalIncompleteDecision,
  RawSignal,
  SignalFetchResult,
  SignalSourceAdapter,
  SignalSourceName,
} from './types.js';

export class SignalSourceRegistry {
  private readonly adapters = new Map<SignalSourceName, SignalSourceAdapter>();

  register(adapter: SignalSourceAdapter): void {
    this.adapters.set(adapter.name, adapter);
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
 */
export async function fetchSignalsFromAvailableAdapters(
  adapters: readonly SignalSourceAdapter[],
  since: Date,
): Promise<SignalFetchResult> {
  const signals: RawSignal[] = [];
  const decisions: Array<AdapterCredentialInvalidDecision | ManualSignalIncompleteDecision> = [];

  for (const adapter of adapters) {
    try {
      if (!(await adapter.isAvailable())) continue;
      signals.push(...(await adapter.fetchSignals(since)));
    } catch (err) {
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
      throw err;
    }
  }

  return { signals, decisions };
}
