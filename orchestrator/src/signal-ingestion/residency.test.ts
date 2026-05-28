/**
 * Hermetic tests for RFC-0030 OQ-13.3 re-walkthrough refinements:
 * per-stage residency enforcement points + multi-posture composition
 * (AISDLC-432).
 *
 * AC mapping (task body):
 *   AC #1: residencyRegion tag derived per signal at fetchSignals + persisted
 *          on storage records → `makeStoredSignalRecord`.
 *   AC #2: derivedGates allowedRegions consulted, out-of-policy → Decision →
 *          already covered by `significance.test.ts` (kept here for the
 *          composition-with-composePostures path).
 *   AC #3: clustering partitions by residencyRegion → `partitionSignalsByRegion`
 *          + `clusterSignalsWithResidency`.
 *   AC #4: storage records persist residencyRegion + cross-region read logs
 *          elevated audit → `makeStoredSignalRecord` + `readSignalRecordWithAudit`.
 *   AC #5: unified cost report rows tagged with residencyRegion + break out
 *          by region → `groupCostByRegion`.
 *   AC #6: multi-posture UNION composition → `composePostures` +
 *          `checkSignalResidency` on the composed declaration.
 *   AC #8: hermetic tests on signal-tag derivation, cross-region cluster
 *          prevention, audit-export contents, multi-posture composition.
 */

import { describe, expect, it } from 'vitest';
import {
  clusterRequiresSegregation,
  composePostures,
  groupCostByRegion,
  makeStoredSignalRecord,
  partitionSignalsByRegion,
  readSignalRecordWithAudit,
  type PostureRegimeInput,
} from './residency.js';
import { clusterSignalsWithResidency } from './clustering.js';
import { checkSignalResidency } from './significance.js';
import type { ClusteredSignalInput } from './clustering-types.js';
import type { RawSignal } from './types.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

function rawSignal(overrides: Partial<RawSignal> = {}): RawSignal {
  return {
    sourceId: 'src-1',
    sourceTimestamp: new Date('2026-05-15T12:00:00.000Z'),
    payload: 'test signal payload',
    ...overrides,
  };
}

function classifiedSignal(
  overrides: {
    signal?: Partial<RawSignal>;
    customerTier?: ClusteredSignalInput['customerTier'];
    icpResonance?: ClusteredSignalInput['icpResonance'];
    recencyDecay?: number;
    adapterTier?: ClusteredSignalInput['adapterTier'];
  } = {},
): ClusteredSignalInput {
  const { signal: signalOverrides, ...rest } = overrides;
  return {
    signal: rawSignal(signalOverrides),
    customerTier: 'enterprise',
    icpResonance: 'strong',
    recencyDecay: 1.0,
    adapterTier: 1,
    ...rest,
  };
}

// ── AC #6: multi-posture composition (composePostures) ──────────────────────

describe('composePostures — AC #6 multi-posture UNION composition', () => {
  it('returns empty declaration for zero inputs', () => {
    const out = composePostures([]);
    expect(out).toEqual({ regimes: [], allowedRegionsByRegime: {} });
  });

  it('composes a single regime declaration unchanged (modulo case/sort)', () => {
    const out = composePostures([{ regime: 'GDPR', allowedRegions: ['EU', 'GB'] }]);
    expect(out.regimes).toEqual(['gdpr']);
    expect(out.allowedRegionsByRegime).toEqual({ gdpr: ['eu', 'gb'] });
  });

  it('composes HIPAA + GDPR as two active regimes with per-regime allowedRegions', () => {
    const postures: PostureRegimeInput[] = [
      { regime: 'hipaa', allowedRegions: ['us', 'us-east'] },
      { regime: 'gdpr', allowedRegions: ['eu', 'gb'] },
    ];
    const out = composePostures(postures);
    expect(out.regimes).toEqual(['gdpr', 'hipaa']);
    expect(out.allowedRegionsByRegime).toEqual({
      gdpr: ['eu', 'gb'],
      hipaa: ['us', 'us-east'],
    });
  });

  it('intersects allowedRegions when the same regime is declared twice (strictest wins)', () => {
    const out = composePostures([
      { regime: 'gdpr', allowedRegions: ['eu', 'gb', 'fr'] },
      { regime: 'gdpr', allowedRegions: ['eu', 'fr'] },
    ]);
    expect(out.allowedRegionsByRegime['gdpr']).toEqual(['eu', 'fr']);
  });

  it('lower-cases and dedupes region tags', () => {
    const out = composePostures([{ regime: 'GDPR', allowedRegions: ['EU', 'eu', 'Gb'] }]);
    expect(out.allowedRegionsByRegime['gdpr']).toEqual(['eu', 'gb']);
  });

  it('composed declaration → checkSignalResidency refuses signals from out-of-policy regions', () => {
    const declaration = composePostures([
      { regime: 'gdpr', allowedRegions: ['eu', 'gb'] },
      { regime: 'hipaa', allowedRegions: ['us'] },
    ]);
    // 'eu' satisfies GDPR but NOT HIPAA → refused (UNION-of-constraints).
    const euSignal = rawSignal({ region: 'eu' });
    const result = checkSignalResidency(euSignal, declaration, 'signal-source-support-ticket');
    expect(result.permitted).toBe(false);
    if (!result.permitted) {
      expect(result.decision.violatedRegimes).toEqual(['hipaa']);
    }
  });

  it('composed declaration → permits when signal satisfies ALL active regimes', () => {
    // Edge case: a regime that allows BOTH EU and US (e.g. a single regime
    // whose mapping covers both). A signal in 'us' must satisfy both.
    const declaration = composePostures([
      { regime: 'regime-a', allowedRegions: ['us', 'eu'] },
      { regime: 'regime-b', allowedRegions: ['us'] },
    ]);
    const usSignal = rawSignal({ region: 'us' });
    const result = checkSignalResidency(usSignal, declaration, 'signal-source-support-ticket');
    expect(result.permitted).toBe(true);
  });
});

// ── AC #3: clustering partitions by region (partitionSignalsByRegion) ──────

describe('partitionSignalsByRegion — AC #3 cross-region cluster prevention', () => {
  it('returns empty Map for empty input', () => {
    expect(partitionSignalsByRegion([])).toEqual(new Map());
  });

  it('partitions signals by region with lower-casing', () => {
    const signals = [
      classifiedSignal({ signal: { sourceId: 'a', region: 'EU' } }),
      classifiedSignal({ signal: { sourceId: 'b', region: 'us' } }),
      classifiedSignal({ signal: { sourceId: 'c', region: 'eu' } }),
    ];
    const partitions = partitionSignalsByRegion(signals);
    expect(partitions.size).toBe(2);
    expect(partitions.get('eu')!.length).toBe(2);
    expect(partitions.get('us')!.length).toBe(1);
  });

  it('routes signals without region to the __unspecified bucket (not silently merged)', () => {
    const signals = [
      classifiedSignal({ signal: { sourceId: 'a', region: 'eu' } }),
      classifiedSignal({ signal: { sourceId: 'b', region: undefined } }),
    ];
    const partitions = partitionSignalsByRegion(signals);
    expect(partitions.has('__unspecified')).toBe(true);
    expect(partitions.get('__unspecified')!.length).toBe(1);
  });
});

describe('clusterSignalsWithResidency — AC #3 cross-region merge structurally blocked', () => {
  it('falls through to clusterSignals when partitionByRegion: false', async () => {
    const signals = [
      classifiedSignal({ signal: { sourceId: 'a', region: 'eu', payload: 'login button broken' } }),
      classifiedSignal({ signal: { sourceId: 'b', region: 'us', payload: 'login button broken' } }),
    ];
    const result = await clusterSignalsWithResidency(signals, { partitionByRegion: false });
    // Identical payload → BM25 says merge → 1 cluster across both regions.
    expect(result.clusters.length).toBe(1);
    expect(result.clusters[0]!.signalCount).toBe(2);
    expect(result.regionPartitions).toBeUndefined();
  });

  it('prevents cross-region merge when partitionByRegion: true', async () => {
    const signals = [
      classifiedSignal({ signal: { sourceId: 'a', region: 'eu', payload: 'login button broken' } }),
      classifiedSignal({ signal: { sourceId: 'b', region: 'us', payload: 'login button broken' } }),
    ];
    const result = await clusterSignalsWithResidency(signals, { partitionByRegion: true });
    // Even though payloads are identical, the partition by region prevents
    // cross-region cluster merge — must produce 2 separate clusters.
    expect(result.clusters.length).toBe(2);
    for (const c of result.clusters) expect(c.signalCount).toBe(1);
    expect(result.regionPartitions).toEqual({ eu: 1, us: 1 });
  });

  it('still merges within a single region when payloads match', async () => {
    const signals = [
      classifiedSignal({ signal: { sourceId: 'a', region: 'eu', payload: 'login button broken' } }),
      classifiedSignal({ signal: { sourceId: 'b', region: 'eu', payload: 'login button broken' } }),
      classifiedSignal({ signal: { sourceId: 'c', region: 'us', payload: 'login button broken' } }),
    ];
    const result = await clusterSignalsWithResidency(signals, { partitionByRegion: true });
    expect(result.clusters.length).toBe(2);
    const sortedBySize = [...result.clusters].sort((a, b) => b.signalCount - a.signalCount);
    expect(sortedBySize[0]!.signalCount).toBe(2);
    expect(sortedBySize[1]!.signalCount).toBe(1);
  });

  it('returns deterministic cluster ordering across partitions', async () => {
    const signals = [
      classifiedSignal({ signal: { sourceId: 'a', region: 'eu', payload: 'alpha' } }),
      classifiedSignal({ signal: { sourceId: 'b', region: 'us', payload: 'beta' } }),
    ];
    const r1 = await clusterSignalsWithResidency(signals, { partitionByRegion: true });
    const r2 = await clusterSignalsWithResidency(signals, { partitionByRegion: true });
    expect(r1.clusters.map((c) => c.clusterId)).toEqual(r2.clusters.map((c) => c.clusterId));
  });

  it('empty input returns empty result with regionPartitions {}', async () => {
    const result = await clusterSignalsWithResidency([], { partitionByRegion: true });
    expect(result.clusters).toEqual([]);
    expect(result.regionPartitions).toEqual({});
  });
});

describe('clusterRequiresSegregation', () => {
  it('returns false when no regimes active', () => {
    expect(clusterRequiresSegregation({ regimes: [], allowedRegionsByRegime: {} })).toBe(false);
  });

  it('returns true when GDPR active', () => {
    expect(
      clusterRequiresSegregation({ regimes: ['gdpr'], allowedRegionsByRegime: { gdpr: ['eu'] } }),
    ).toBe(true);
  });

  it('returns true when HIPAA active (case-insensitive)', () => {
    expect(
      clusterRequiresSegregation({ regimes: ['HIPAA'], allowedRegionsByRegime: { HIPAA: ['us'] } }),
    ).toBe(true);
  });

  it('returns false when only non-segregation regimes (e.g. CCPA)', () => {
    expect(
      clusterRequiresSegregation({ regimes: ['ccpa'], allowedRegionsByRegime: { ccpa: ['us'] } }),
    ).toBe(false);
  });

  it('returns true when at least one regime requires segregation in a multi-regime declaration', () => {
    expect(
      clusterRequiresSegregation({
        regimes: ['ccpa', 'gdpr'],
        allowedRegionsByRegime: { ccpa: ['us'], gdpr: ['eu'] },
      }),
    ).toBe(true);
  });
});

// ── AC #1 + #4: storage record + cross-region read audit ────────────────────

describe('makeStoredSignalRecord — AC #1, #4 persist residencyRegion on storage', () => {
  const FIXED_INGESTED_AT = new Date('2026-05-26T10:00:00.000Z');

  it('persists residencyRegion (lower-cased) from signal.region', () => {
    const signal = rawSignal({ region: 'EU', sourceId: 'zendesk-12345' });
    const record = makeStoredSignalRecord(signal, { ingestedAt: FIXED_INGESTED_AT });
    expect(record.residencyRegion).toBe('eu');
    expect(record.sourceId).toBe('zendesk-12345');
    expect(record.sourceTimestampIso).toBe('2026-05-15T12:00:00.000Z');
    expect(record.ingestedAtIso).toBe('2026-05-26T10:00:00.000Z');
  });

  it('persists `unknown` when signal.region is undefined (visible-gap, not omission)', () => {
    const signal = rawSignal({ region: undefined });
    const record = makeStoredSignalRecord(signal, { ingestedAt: FIXED_INGESTED_AT });
    expect(record.residencyRegion).toBe('unknown');
  });

  it('omits undefined optional fields from the record (clean JSON)', () => {
    const signal = rawSignal({ region: 'us' });
    const record = makeStoredSignalRecord(signal, { ingestedAt: FIXED_INGESTED_AT });
    expect('customerId' in record).toBe(false);
    expect('attestedBy' in record).toBe(false);
    expect('attestedAtIso' in record).toBe(false);
  });

  it('preserves manual-entry audit-trail fields', () => {
    const signal = rawSignal({
      region: 'us',
      attestedBy: 'operator@example.com',
      attestedAt: new Date('2026-05-26T09:00:00.000Z'),
    });
    const record = makeStoredSignalRecord(signal, { ingestedAt: FIXED_INGESTED_AT });
    expect(record.attestedBy).toBe('operator@example.com');
    expect(record.attestedAtIso).toBe('2026-05-26T09:00:00.000Z');
  });

  it('record is JSON-serialisable (no Date objects leak)', () => {
    const signal = rawSignal({
      region: 'eu',
      customerId: 'cust-1',
      attestedAt: new Date('2026-05-26T09:00:00.000Z'),
    });
    const record = makeStoredSignalRecord(signal, { ingestedAt: FIXED_INGESTED_AT });
    const json = JSON.stringify(record);
    const parsed = JSON.parse(json);
    expect(parsed.residencyRegion).toBe('eu');
    expect(parsed.sourceTimestampIso).toBe('2026-05-15T12:00:00.000Z');
  });
});

describe('readSignalRecordWithAudit — AC #4 cross-region elevated audit', () => {
  const FIXED_INGESTED_AT = new Date('2026-05-26T10:00:00.000Z');
  const FIXED_READ_AT = new Date('2026-05-26T11:30:00.000Z');

  it('no audit entry when caller and record share the same region', () => {
    const record = makeStoredSignalRecord(rawSignal({ region: 'eu' }), {
      ingestedAt: FIXED_INGESTED_AT,
    });
    const { auditEntry } = readSignalRecordWithAudit(record, {
      callerRegion: 'eu',
      reader: 'ppa-d1-aggregator',
      readAt: FIXED_READ_AT,
    });
    expect(auditEntry).toBeNull();
  });

  it('emits elevated audit entry on cross-region read', () => {
    const record = makeStoredSignalRecord(rawSignal({ region: 'eu', sourceId: 'zd-99' }), {
      ingestedAt: FIXED_INGESTED_AT,
    });
    const { auditEntry } = readSignalRecordWithAudit(record, {
      callerRegion: 'us',
      reader: 'ppa-d1-aggregator',
      readAt: FIXED_READ_AT,
    });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry).toEqual({
      type: 'AuditEvent',
      event: 'cross-region-signal-read',
      severity: 'elevated',
      sourceId: 'zd-99',
      recordResidencyRegion: 'eu',
      callerResidencyRegion: 'us',
      reader: 'ppa-d1-aggregator',
      readAtIso: '2026-05-26T11:30:00.000Z',
    });
  });

  it('no audit entry when EITHER side is unknown (visible-gap)', () => {
    const recordUnknown = makeStoredSignalRecord(rawSignal({ region: undefined }), {
      ingestedAt: FIXED_INGESTED_AT,
    });
    expect(
      readSignalRecordWithAudit(recordUnknown, { callerRegion: 'us', reader: 'r1' }).auditEntry,
    ).toBeNull();

    const recordEu = makeStoredSignalRecord(rawSignal({ region: 'eu' }), {
      ingestedAt: FIXED_INGESTED_AT,
    });
    expect(
      readSignalRecordWithAudit(recordEu, { callerRegion: 'unknown', reader: 'r1' }).auditEntry,
    ).toBeNull();
  });

  it('cross-region read does NOT block — record is returned regardless', () => {
    const record = makeStoredSignalRecord(rawSignal({ region: 'eu' }), {
      ingestedAt: FIXED_INGESTED_AT,
    });
    const { record: returned } = readSignalRecordWithAudit(record, {
      callerRegion: 'us',
      reader: 'r1',
    });
    expect(returned).toBe(record);
  });

  it('case-insensitive region comparison on both sides', () => {
    const record = makeStoredSignalRecord(rawSignal({ region: 'EU' }), {
      ingestedAt: FIXED_INGESTED_AT,
    });
    const { auditEntry } = readSignalRecordWithAudit(record, {
      callerRegion: 'eu',
      reader: 'r1',
    });
    expect(auditEntry).toBeNull();
  });
});

// ── AC #5: unified cost report breakdown by region ─────────────────────────

describe('groupCostByRegion — AC #5 cost report tagged + per-region breakout', () => {
  it('returns zeroes on empty input', () => {
    expect(groupCostByRegion([])).toEqual({ totalUsd: 0, perRegion: {} });
  });

  it('groups single-region rows', () => {
    const result = groupCostByRegion([
      { consumerLabel: 'rfc-0030-clustering', costUsd: 0.05, residencyRegion: 'eu' },
      { consumerLabel: 'rfc-0030-classifier', costUsd: 0.01, residencyRegion: 'eu' },
    ]);
    expect(result.totalUsd).toBeCloseTo(0.06);
    expect(Object.keys(result.perRegion)).toEqual(['eu']);
    expect(result.perRegion['eu']).toBeCloseTo(0.06);
  });

  it('groups multi-region rows with separate per-region totals', () => {
    const result = groupCostByRegion([
      { consumerLabel: 'rfc-0030-clustering', costUsd: 0.05, residencyRegion: 'eu' },
      { consumerLabel: 'rfc-0030-clustering', costUsd: 0.03, residencyRegion: 'us' },
      { consumerLabel: 'rfc-0030-classifier', costUsd: 0.02, residencyRegion: 'us' },
    ]);
    expect(result.totalUsd).toBeCloseTo(0.1);
    expect(result.perRegion['eu']).toBeCloseTo(0.05);
    expect(result.perRegion['us']).toBeCloseTo(0.05);
  });

  it('lower-cases region keys for stable matching', () => {
    const result = groupCostByRegion([
      { consumerLabel: 'a', costUsd: 0.01, residencyRegion: 'EU' },
      { consumerLabel: 'b', costUsd: 0.02, residencyRegion: 'eu' },
    ]);
    expect(Object.keys(result.perRegion)).toEqual(['eu']);
    expect(result.perRegion['eu']).toBeCloseTo(0.03);
  });

  it('routes empty / falsy region to `unknown` bucket', () => {
    const result = groupCostByRegion([{ consumerLabel: 'a', costUsd: 0.01, residencyRegion: '' }]);
    expect(result.perRegion).toEqual({ unknown: 0.01 });
  });

  it('skips malformed rows (negative or non-finite cost)', () => {
    const result = groupCostByRegion([
      { consumerLabel: 'a', costUsd: 0.01, residencyRegion: 'eu' },
      { consumerLabel: 'b', costUsd: -1, residencyRegion: 'eu' },
      { consumerLabel: 'c', costUsd: Number.NaN, residencyRegion: 'eu' },
    ]);
    expect(result.perRegion['eu']).toBeCloseTo(0.01);
    expect(result.totalUsd).toBeCloseTo(0.01);
  });
});

// ── AC #8: never-throws contract ────────────────────────────────────────────

describe('residency helpers never throw on edge-case inputs', () => {
  it('composePostures: empty + duplicate-regime cases handled', () => {
    expect(() => composePostures([])).not.toThrow();
    expect(() =>
      composePostures([
        { regime: 'gdpr', allowedRegions: [] },
        { regime: 'gdpr', allowedRegions: ['eu'] },
      ]),
    ).not.toThrow();
  });

  it('partitionSignalsByRegion: input with all-undefined regions', () => {
    const signals = [
      classifiedSignal({ signal: { sourceId: 'a', region: undefined } }),
      classifiedSignal({ signal: { sourceId: 'b', region: undefined } }),
    ];
    const partitions = partitionSignalsByRegion(signals);
    expect(partitions.get('__unspecified')!.length).toBe(2);
  });

  it('makeStoredSignalRecord: empty payload + no metadata + no customer', () => {
    const signal = rawSignal({ payload: '', region: undefined });
    expect(() => makeStoredSignalRecord(signal)).not.toThrow();
  });

  it('readSignalRecordWithAudit: malformed caller region defaults sensibly', () => {
    const record = makeStoredSignalRecord(rawSignal({ region: 'eu' }));
    expect(() =>
      readSignalRecordWithAudit(record, { callerRegion: '', reader: 'r1' }),
    ).not.toThrow();
  });

  it('groupCostByRegion: empty consumerLabels + zero costs', () => {
    expect(() =>
      groupCostByRegion([{ consumerLabel: '', costUsd: 0, residencyRegion: 'eu' }]),
    ).not.toThrow();
  });
});
