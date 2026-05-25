/**
 * Tests for the Eτ_tessellation_drift consumer spec stub (AISDLC-340 AC#3).
 *
 * The consumer is the first downstream wiring for RFC-0019 Phase 4.
 * Runtime usage activates when RFC-0009 Phase 4.2 ships (AISDLC-317).
 * These tests pin the load-bearing CONTRACT — the canonical consumer label
 * + the pinned fail-loud policy — so changes to either surface as test
 * failures rather than silent regressions of historical-trajectory fidelity.
 */

import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingAdapter, EmbeddingAvailability } from '../types.js';
import {
  TESSELLATION_DRIFT_CONSUMER_LABEL,
  TESSELLATION_DRIFT_STALE_VECTOR_POLICY,
  TESSELLATION_DRIFT_CONSUMER,
  embedDriftSignal,
} from './tessellation-drift.js';

class StubAdapter implements EmbeddingAdapter {
  readonly name = 'stub-drift';
  readonly modelId = 'stub';
  readonly modelVersion = '2026-05-23';
  readonly dimensions = 4;
  readonly capabilities = {
    dimensions: 4,
    maxInputTokens: 1000,
    supportsBatching: false,
    selfHosted: false,
    billingModel: 'pay-per-token' as const,
  };
  readonly requires = {};

  embed = vi.fn(async (_text: string, _label?: string) => [0.1, 0.2, 0.3, 0.4]);

  async isAvailable(): Promise<EmbeddingAvailability> {
    return { available: true };
  }
  async getAccountId(): Promise<string | null> {
    return null;
  }
}

describe('TESSELLATION_DRIFT_CONSUMER_LABEL', () => {
  it('is the canonical RFC-0009 drift label', () => {
    // Hard-coded check. Changing this constant breaks cost-attribution
    // reports finance has already queried; treat it as load-bearing.
    expect(TESSELLATION_DRIFT_CONSUMER_LABEL).toBe('rfc-0009-tessellation-drift');
  });
});

describe('TESSELLATION_DRIFT_STALE_VECTOR_POLICY', () => {
  it('pins fail-loud (RFC-0019 OQ-2 re-walkthrough)', () => {
    // Per OQ-2 re-walkthrough: drift reads historical trajectory across
    // successive doc revisions; lazy-re-embed destroys time-series signal.
    // The consumer pins fail-loud regardless of org default.
    expect(TESSELLATION_DRIFT_STALE_VECTOR_POLICY).toBe('fail-loud');
  });
});

describe('embedDriftSignal', () => {
  it('forwards the consumer label so cost-tracker records the drift dimension', async () => {
    const adapter = new StubAdapter();
    await embedDriftSignal(adapter, 'shard text');

    expect(adapter.embed).toHaveBeenCalledTimes(1);
    expect(adapter.embed).toHaveBeenCalledWith('shard text', 'rfc-0009-tessellation-drift');
  });

  it('returns the vector from the adapter unchanged', async () => {
    const adapter = new StubAdapter();
    const vec = await embedDriftSignal(adapter, 'shard');
    expect(vec).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

describe('TESSELLATION_DRIFT_CONSUMER descriptor', () => {
  it('exposes the canonical label, pinned policy, and rationale', () => {
    expect(TESSELLATION_DRIFT_CONSUMER).toMatchObject({
      label: 'rfc-0009-tessellation-drift',
      staleVectorPolicy: 'fail-loud',
      rfc: 'RFC-0009',
      task: 'AISDLC-340',
    });
    expect(TESSELLATION_DRIFT_CONSUMER.rationale).toMatch(/historical trajectory/);
  });
});
