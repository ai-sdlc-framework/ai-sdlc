import { describe, expect, it } from 'vitest';
import {
  AdapterCredentialInvalid,
  CommunityThreadSignalSourceAdapter,
  ManualSignalIncomplete,
  ManualSignalSourceAdapter,
  SignalSourceUnavailable,
  SignalSourceRegistry,
  SupportTicketSignalSourceAdapter,
  UnknownSignalSource,
  createDefaultSignalSourceRegistry,
  fetchSignalsFromAvailableAdapters,
  getSignalSourceAdapter,
  type RawSignal,
} from './index.js';

const since = new Date('2026-01-01T00:00:00.000Z');

function signal(sourceId: string, sourceTimestamp = '2026-01-02T00:00:00.000Z'): RawSignal {
  return {
    sourceId,
    sourceTimestamp: new Date(sourceTimestamp),
    payload: `payload ${sourceId}`,
  };
}

describe('SignalSourceRegistry', () => {
  it('registers and resolves adapters by name', async () => {
    const registry = new SignalSourceRegistry();
    const support = new SupportTicketSignalSourceAdapter();
    registry.register(support);

    expect(registry.has('signal-source-support-ticket')).toBe(true);
    expect(registry.list()).toEqual(['signal-source-support-ticket']);
    await expect(getSignalSourceAdapter(registry, 'signal-source-support-ticket')).resolves.toBe(
      support,
    );
  });

  it('throws a structured error for unknown adapters', () => {
    const registry = new SignalSourceRegistry();
    expect(() => registry.get('missing')).toThrow(UnknownSignalSource);
  });

  it('rejects unavailable registered adapters', async () => {
    const registry = new SignalSourceRegistry();
    registry.register(new SupportTicketSignalSourceAdapter({ available: false }));

    await expect(getSignalSourceAdapter(registry, 'signal-source-support-ticket')).rejects.toThrow(
      SignalSourceUnavailable,
    );
  });

  it('creates a default registry with all Phase 1 adapters', () => {
    const registry = createDefaultSignalSourceRegistry();

    expect(registry.list().sort()).toEqual([
      'signal-source-community-thread',
      'signal-source-manual',
      'signal-source-support-ticket',
    ]);
  });
});

describe('default signal source adapters', () => {
  it('support-ticket adapter is Tier 1 and filters by since timestamp', async () => {
    const adapter = new SupportTicketSignalSourceAdapter({
      signals: [signal('old', '2025-12-31T00:00:00.000Z'), signal('new')],
    });

    await expect(adapter.isAvailable()).resolves.toBe(true);
    expect(adapter.defaultTier).toBe(1);
    await expect(adapter.fetchSignals(since)).resolves.toEqual([signal('new')]);
  });

  it('community-thread adapter is Tier 2 and filters by since timestamp', async () => {
    const adapter = new CommunityThreadSignalSourceAdapter({
      signals: [signal('old', '2025-12-31T00:00:00.000Z'), signal('new')],
    });

    await expect(adapter.isAvailable()).resolves.toBe(true);
    expect(adapter.defaultTier).toBe(2);
    await expect(adapter.fetchSignals(since)).resolves.toEqual([signal('new')]);
  });

  it('manual adapter requires attestedBy and fills attestedAt', async () => {
    const adapter = new ManualSignalSourceAdapter();
    const now = new Date('2026-05-16T12:00:00.000Z');

    expect(() => adapter.addSignal(signal('manual-missing-attestation'), now)).toThrow(
      ManualSignalIncomplete,
    );

    const added = adapter.addSignal(
      {
        ...signal('manual'),
        attestedBy: 'operator@example.com',
      },
      now,
    );

    expect(added.attestedAt).toEqual(now);
    await expect(adapter.fetchSignals(since)).resolves.toEqual([added]);
  });

  it('credential failures emit non-blocking decisions and remaining adapters continue', async () => {
    const failing = new SupportTicketSignalSourceAdapter({ credentialInvalid: true });
    const succeeding = new CommunityThreadSignalSourceAdapter({ signals: [signal('community')] });

    const result = await fetchSignalsFromAvailableAdapters([failing, succeeding], since);

    expect(result.signals).toEqual([signal('community')]);
    expect(result.decisions).toEqual([
      {
        type: 'Decision',
        decision: 'adapter-credential-invalid',
        adapter: 'signal-source-support-ticket',
        message: 'Signal source adapter credentials invalid: signal-source-support-ticket',
      },
    ]);
  });

  it('sanitizes credential error details in decisions', async () => {
    class SecretLeakingAdapter extends SupportTicketSignalSourceAdapter {
      async fetchSignals(): Promise<RawSignal[]> {
        throw new AdapterCredentialInvalid(
          this.name,
          '401 token=sk-secret Authorization: Bearer abc',
        );
      }
    }

    const result = await fetchSignalsFromAvailableAdapters([new SecretLeakingAdapter()], since);

    expect(result.decisions).toEqual([
      {
        type: 'Decision',
        decision: 'adapter-credential-invalid',
        adapter: 'signal-source-support-ticket',
        message: 'Signal source adapter credentials invalid: signal-source-support-ticket',
      },
    ]);
  });

  it('skips unavailable adapters and continues with available adapters', async () => {
    class ThrowIfFetchedAdapter extends SupportTicketSignalSourceAdapter {
      async fetchSignals(): Promise<RawSignal[]> {
        throw new Error('fetchSignals should not run for unavailable adapters');
      }
    }

    const unavailable = new ThrowIfFetchedAdapter({ available: false });
    const available = new CommunityThreadSignalSourceAdapter({ signals: [signal('community')] });

    const result = await fetchSignalsFromAvailableAdapters([unavailable, available], since);

    expect(result.signals).toEqual([signal('community')]);
    expect(result.decisions).toEqual([]);
  });

  it('manual attestation failures emit manual-signal-incomplete decisions', async () => {
    class InvalidManualAdapter extends ManualSignalSourceAdapter {
      async fetchSignals(): Promise<RawSignal[]> {
        this.addSignal(signal('manual-missing-attestation'));
        return [];
      }
    }

    const result = await fetchSignalsFromAvailableAdapters([new InvalidManualAdapter()], since);

    expect(result.signals).toEqual([]);
    expect(result.decisions).toEqual([
      {
        type: 'Decision',
        decision: 'manual-signal-incomplete',
        adapter: 'signal-source-manual',
        sourceId: 'manual-missing-attestation',
        message: 'Manual signal missing required attestation fields',
      },
    ]);
  });
});
