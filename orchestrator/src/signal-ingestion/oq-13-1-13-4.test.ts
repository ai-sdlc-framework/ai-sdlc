/**
 * RFC-0030 OQ-13.1 + OQ-13.4 v0.3 re-walkthrough tests.
 *
 * Covers AISDLC-430 acceptance criteria:
 *  AC#1 — v1 adapter list enumerated; OAuth-required adapters refused at registration.
 *  AC#2 — `adapter-credential-not-configured` Decision when env var missing.
 *  AC#3 — `adapter-credential-rejected` Decision when env var present but auth fails.
 *  AC#4 — pipeline continues with remaining valid adapters in both failure modes.
 *  AC#5 — manual rate-limit (default 10/day) enforced; per-org override respected.
 *  AC#6 — `manual-signal-rate-limit-exceeded` Decision emitted above cap.
 *  AC#7 — optional `evidenceUrl` field preserved through pipeline.
 *  AC#8 — manual-share quality metric + `manual-signal-share-elevated` Decision.
 *  AC#9 — unit + integration coverage across all paths.
 */

import { describe, expect, it } from 'vitest';
import {
  AdapterCredentialNotConfigured,
  AdapterCredentialRejected,
  AdapterRequiresCredentialMgmtRfc,
  CommunityThreadSignalSourceAdapter,
  computeManualShareMetric,
  DEFAULT_COMMUNITY_THREAD_ENV_VAR,
  DEFAULT_IN_APP_FEEDBACK_ENV_VAR,
  DEFAULT_MANUAL_DAILY_CAP_PER_OPERATOR,
  DEFAULT_MANUAL_SHARE_WARNING_THRESHOLD,
  DEFAULT_MANUAL_SHARE_WINDOW_DAYS,
  DEFAULT_SUPPORT_TICKET_ENV_VAR,
  fetchSignalsFromAvailableAdapters,
  InAppFeedbackSignalSourceAdapter,
  ManualSignalIncomplete,
  ManualSignalRateLimitExceeded,
  ManualSignalSourceAdapter,
  SignalSourceRegistry,
  SupportTicketSignalSourceAdapter,
  utcDateKey,
  type RawSignal,
  type SignalSourceAdapter,
} from './index.js';

const since = new Date('2026-01-01T00:00:00.000Z');

function signal(
  sourceId: string,
  sourceTimestamp = '2026-01-02T00:00:00.000Z',
  overrides: Partial<RawSignal> = {},
): RawSignal {
  return {
    sourceId,
    sourceTimestamp: new Date(sourceTimestamp),
    payload: `payload ${sourceId}`,
    ...overrides,
  };
}

// ── AC #1: v1 adapter list + OAuth-required refusal ────────────────────────

describe('OQ-13.1 — v1 adapter list (env-var-based only)', () => {
  it('exports the env-var name constants for each v1 adapter', () => {
    expect(DEFAULT_SUPPORT_TICKET_ENV_VAR).toBe('SIGNAL_ZENDESK_PAT');
    expect(DEFAULT_COMMUNITY_THREAD_ENV_VAR).toBe('SIGNAL_COMMUNITY_BOT_TOKEN');
    expect(DEFAULT_IN_APP_FEEDBACK_ENV_VAR).toBe('SIGNAL_IN_APP_FEEDBACK_API_KEY');
  });

  it('every v1 adapter declares requiresOAuth = false', () => {
    expect(new SupportTicketSignalSourceAdapter().requiresOAuth).toBe(false);
    expect(new CommunityThreadSignalSourceAdapter().requiresOAuth).toBe(false);
    expect(new InAppFeedbackSignalSourceAdapter().requiresOAuth).toBe(false);
    expect(new ManualSignalSourceAdapter().requiresOAuth).toBe(false);
  });

  it('registry refuses adapters with requiresOAuth=true and returns documented Decision', () => {
    const oauthAdapter: SignalSourceAdapter = {
      name: 'signal-source-salesforce-oauth',
      defaultTier: 1,
      requiresOAuth: true,
      async isAvailable() {
        return true;
      },
      async fetchSignals() {
        return [];
      },
    };
    const registry = new SignalSourceRegistry();
    const decision = registry.register(oauthAdapter);

    expect(decision).toEqual({
      type: 'Decision',
      decision: 'adapter-requires-credential-mgmt-rfc',
      adapter: 'signal-source-salesforce-oauth',
      message: expect.stringContaining('credential-management RFC'),
    });
    expect(registry.has('signal-source-salesforce-oauth')).toBe(false);
  });

  it('registry registers env-var adapters successfully (returns null)', () => {
    const registry = new SignalSourceRegistry();
    const result = registry.register(new SupportTicketSignalSourceAdapter());
    expect(result).toBeNull();
    expect(registry.has('signal-source-support-ticket')).toBe(true);
  });

  it('AdapterRequiresCredentialMgmtRfc error class carries adapter name', () => {
    const err = new AdapterRequiresCredentialMgmtRfc('signal-source-hubspot-oauth');
    expect(err.source).toBe('signal-source-hubspot-oauth');
    expect(err.name).toBe('AdapterRequiresCredentialMgmtRfc');
  });
});

// ── AC #2: adapter-credential-not-configured Decision ──────────────────────

describe('OQ-13.1 AC#2 — adapter-credential-not-configured Decision', () => {
  it('isAvailable returns false when env var missing (adapter skipped silently)', async () => {
    const adapter = new InAppFeedbackSignalSourceAdapter({
      env: {}, // No env vars; available not overridden so probe runs
    });
    const result = await fetchSignalsFromAvailableAdapters([adapter], since);

    // SOFT path: isAvailable() returns false because env var missing → adapter
    // skipped entirely (no fetchSignals call, no Decision). To exercise the
    // hard-fail "configured-then-failed" path use `credentialNotConfigured: true`.
    expect(result.signals).toEqual([]);
    expect(result.decisions).toEqual([]);
  });

  it('emits Decision when adapter throws AdapterCredentialNotConfigured at fetch', async () => {
    const adapter = new SupportTicketSignalSourceAdapter({
      credentialNotConfigured: true,
    });
    const result = await fetchSignalsFromAvailableAdapters([adapter], since);

    expect(result.signals).toEqual([]);
    expect(result.decisions).toEqual([
      {
        type: 'Decision',
        decision: 'adapter-credential-not-configured',
        adapter: 'signal-source-support-ticket',
        envVarName: 'SIGNAL_ZENDESK_PAT',
        message: expect.stringContaining('SIGNAL_ZENDESK_PAT'),
      },
    ]);
  });

  it('AdapterCredentialNotConfigured carries the env var name', () => {
    const err = new AdapterCredentialNotConfigured('signal-source-support-ticket', 'MY_ENV');
    expect(err.source).toBe('signal-source-support-ticket');
    expect(err.envVarName).toBe('MY_ENV');
    expect(err.name).toBe('AdapterCredentialNotConfigured');
  });

  it('respects custom envVarName override', async () => {
    const adapter = new SupportTicketSignalSourceAdapter({
      envVarName: 'CUSTOM_TOKEN_NAME',
      credentialNotConfigured: true,
    });
    const result = await fetchSignalsFromAvailableAdapters([adapter], since);

    expect(result.decisions[0]).toMatchObject({
      decision: 'adapter-credential-not-configured',
      envVarName: 'CUSTOM_TOKEN_NAME',
    });
  });

  it('in-app-feedback probeEnvVar mode: env var present allows fetch', async () => {
    const adapter = new InAppFeedbackSignalSourceAdapter({
      env: { SIGNAL_IN_APP_FEEDBACK_API_KEY: 'test-key' },
      signals: [signal('feedback-1')],
    });
    await expect(adapter.isAvailable()).resolves.toBe(true);
    await expect(adapter.fetchSignals(since)).resolves.toEqual([signal('feedback-1')]);
  });

  it('in-app-feedback probeEnvVar mode: empty env var = unavailable', async () => {
    const adapter = new InAppFeedbackSignalSourceAdapter({
      env: { SIGNAL_IN_APP_FEEDBACK_API_KEY: '   ' }, // whitespace only
    });
    await expect(adapter.isAvailable()).resolves.toBe(false);
  });

  it('in-app-feedback fetchSignals throws AdapterCredentialNotConfigured when env missing', async () => {
    const adapter = new InAppFeedbackSignalSourceAdapter({
      env: {},
      // available is not set: fetchSignals will re-probe and throw
    });
    await expect(adapter.fetchSignals(since)).rejects.toBeInstanceOf(
      AdapterCredentialNotConfigured,
    );
  });
});

// ── AC #3: adapter-credential-rejected Decision ────────────────────────────

describe('OQ-13.1 AC#3 — adapter-credential-rejected Decision', () => {
  it('emits Decision when upstream auth rejects', async () => {
    const adapter = new CommunityThreadSignalSourceAdapter({
      credentialRejected: true,
    });
    const result = await fetchSignalsFromAvailableAdapters([adapter], since);

    expect(result.signals).toEqual([]);
    expect(result.decisions).toEqual([
      {
        type: 'Decision',
        decision: 'adapter-credential-rejected',
        adapter: 'signal-source-community-thread',
        message: expect.stringContaining('Rotate'),
      },
    ]);
  });

  it('AdapterCredentialRejected error class has correct shape', () => {
    const err = new AdapterCredentialRejected('signal-source-in-app-feedback');
    expect(err.source).toBe('signal-source-in-app-feedback');
    expect(err.name).toBe('AdapterCredentialRejected');
  });

  it('in-app-feedback adapter with credentialRejected option throws AdapterCredentialRejected', async () => {
    const adapter = new InAppFeedbackSignalSourceAdapter({
      available: true,
      credentialRejected: true,
    });
    await expect(adapter.fetchSignals(since)).rejects.toBeInstanceOf(AdapterCredentialRejected);
  });
});

// ── AC #4: pipeline continues with remaining valid adapters ────────────────

describe('OQ-13.1 AC#4 — pipeline continues on credential failures', () => {
  it('continues fetching from healthy adapters when one is not-configured', async () => {
    const broken = new SupportTicketSignalSourceAdapter({ credentialNotConfigured: true });
    const healthy = new CommunityThreadSignalSourceAdapter({ signals: [signal('c1')] });

    const result = await fetchSignalsFromAvailableAdapters([broken, healthy], since);

    expect(result.signals).toEqual([signal('c1')]);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.decision).toBe('adapter-credential-not-configured');
  });

  it('continues fetching from healthy adapters when one is rejected', async () => {
    const broken = new InAppFeedbackSignalSourceAdapter({
      available: true,
      credentialRejected: true,
    });
    const healthy = new SupportTicketSignalSourceAdapter({ signals: [signal('s1')] });

    const result = await fetchSignalsFromAvailableAdapters([broken, healthy], since);

    expect(result.signals).toEqual([signal('s1')]);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.decision).toBe('adapter-credential-rejected');
  });

  it('accumulates multiple Decisions when multiple adapters fail', async () => {
    const notConfigured = new SupportTicketSignalSourceAdapter({
      credentialNotConfigured: true,
    });
    const rejected = new CommunityThreadSignalSourceAdapter({ credentialRejected: true });
    const healthy = new InAppFeedbackSignalSourceAdapter({
      available: true,
      signals: [signal('f1')],
    });

    const result = await fetchSignalsFromAvailableAdapters(
      [notConfigured, rejected, healthy],
      since,
    );

    expect(result.signals).toEqual([signal('f1')]);
    expect(result.decisions.map((d) => d.decision).sort()).toEqual([
      'adapter-credential-not-configured',
      'adapter-credential-rejected',
    ]);
  });
});

// ── AC #5 + AC #6: manual rate-limit + Decision ─────────────────────────────

describe('OQ-13.4 AC#5/6 — manual rate-limit per operator', () => {
  it('default cap is 10/day per operator (DEFAULT_MANUAL_DAILY_CAP_PER_OPERATOR)', () => {
    expect(DEFAULT_MANUAL_DAILY_CAP_PER_OPERATOR).toBe(10);
    const adapter = new ManualSignalSourceAdapter();
    expect(adapter.effectiveDailyCap).toBe(10);
  });

  it('per-org override respected via dailyCapPerOperator option', () => {
    const adapter = new ManualSignalSourceAdapter({ dailyCapPerOperator: 3 });
    expect(adapter.effectiveDailyCap).toBe(3);
  });

  it('legacy ctor signature (array) keeps default cap', () => {
    const adapter = new ManualSignalSourceAdapter([]);
    expect(adapter.effectiveDailyCap).toBe(DEFAULT_MANUAL_DAILY_CAP_PER_OPERATOR);
  });

  it('accepts up to the cap and then raises ManualSignalRateLimitExceeded', () => {
    const adapter = new ManualSignalSourceAdapter({ dailyCapPerOperator: 3 });
    const now = new Date('2026-05-26T10:00:00.000Z');

    for (let i = 0; i < 3; i++) {
      adapter.addSignal({ ...signal(`m${i}`), attestedBy: 'op@example.com' }, now);
    }
    expect(adapter.countForOperatorOnDate('op@example.com', '2026-05-26')).toBe(3);

    expect(() =>
      adapter.addSignal({ ...signal('m-over'), attestedBy: 'op@example.com' }, now),
    ).toThrow(ManualSignalRateLimitExceeded);
  });

  it('rate-limit counts are per-operator (different operators independent)', () => {
    const adapter = new ManualSignalSourceAdapter({ dailyCapPerOperator: 2 });
    const now = new Date('2026-05-26T10:00:00.000Z');

    adapter.addSignal({ ...signal('a1'), attestedBy: 'alice@example.com' }, now);
    adapter.addSignal({ ...signal('a2'), attestedBy: 'alice@example.com' }, now);
    // Bob still fresh — should not be blocked
    expect(() =>
      adapter.addSignal({ ...signal('b1'), attestedBy: 'bob@example.com' }, now),
    ).not.toThrow();
  });

  it('rate-limit counts are per-UTC-day (new day resets)', () => {
    const adapter = new ManualSignalSourceAdapter({ dailyCapPerOperator: 2 });

    adapter.addSignal(
      { ...signal('d1-a'), attestedBy: 'op@example.com' },
      new Date('2026-05-26T10:00:00.000Z'),
    );
    adapter.addSignal(
      { ...signal('d1-b'), attestedBy: 'op@example.com' },
      new Date('2026-05-26T20:00:00.000Z'),
    );
    // 3rd on same UTC day → blocked
    expect(() =>
      adapter.addSignal(
        { ...signal('d1-c'), attestedBy: 'op@example.com' },
        new Date('2026-05-26T22:00:00.000Z'),
      ),
    ).toThrow(ManualSignalRateLimitExceeded);
    // Next UTC day → fresh
    expect(() =>
      adapter.addSignal(
        { ...signal('d2-a'), attestedBy: 'op@example.com' },
        new Date('2026-05-27T01:00:00.000Z'),
      ),
    ).not.toThrow();
  });

  it('dailyCapPerOperator: 0 disables rate limiting entirely', () => {
    const adapter = new ManualSignalSourceAdapter({ dailyCapPerOperator: 0 });
    const now = new Date('2026-05-26T10:00:00.000Z');
    for (let i = 0; i < 100; i++) {
      expect(() =>
        adapter.addSignal({ ...signal(`m${i}`), attestedBy: 'op@example.com' }, now),
      ).not.toThrow();
    }
  });

  it('attestation check fires BEFORE rate-limit (missing attestedBy is ManualSignalIncomplete)', () => {
    const adapter = new ManualSignalSourceAdapter({ dailyCapPerOperator: 0 });
    expect(() => adapter.addSignal(signal('missing'))).toThrow(ManualSignalIncomplete);
  });

  it('registry emits manual-signal-rate-limit-exceeded Decision when adapter throws', async () => {
    class CapReachedAdapter extends ManualSignalSourceAdapter {
      async fetchSignals(): Promise<RawSignal[]> {
        throw new ManualSignalRateLimitExceeded(
          'attested@example.com',
          10,
          '2026-05-26',
          'manual-x',
        );
      }
    }

    const result = await fetchSignalsFromAvailableAdapters([new CapReachedAdapter()], since);

    expect(result.signals).toEqual([]);
    expect(result.decisions).toEqual([
      {
        type: 'Decision',
        decision: 'manual-signal-rate-limit-exceeded',
        adapter: 'signal-source-manual',
        attestedBy: 'attested@example.com',
        utcDate: '2026-05-26',
        dailyCap: 10,
        sourceId: 'manual-x',
        message: expect.stringContaining('rate limit exceeded'),
      },
    ]);
  });

  it('utcDateKey helper produces YYYY-MM-DD UTC date', () => {
    expect(utcDateKey(new Date('2026-05-26T23:59:59.999Z'))).toBe('2026-05-26');
    expect(utcDateKey(new Date('2026-05-27T00:00:00.000Z'))).toBe('2026-05-27');
    // Local-time midnight in UTC-7 is still previous UTC day
    expect(utcDateKey(new Date('2026-05-27T03:00:00.000Z'))).toBe('2026-05-27');
  });
});

// ── AC #7: evidenceUrl preservation ────────────────────────────────────────

describe('OQ-13.4 AC#7 — evidenceUrl field preservation', () => {
  it('preserves evidenceUrl verbatim through addSignal/fetchSignals', async () => {
    const adapter = new ManualSignalSourceAdapter();
    adapter.addSignal({
      ...signal('manual-with-evidence'),
      attestedBy: 'op@example.com',
      evidenceUrl: 'https://example.com/recording/abc123',
    });

    const fetched = await adapter.fetchSignals(since);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.evidenceUrl).toBe('https://example.com/recording/abc123');
  });

  it('signals without evidenceUrl are accepted (field is optional)', async () => {
    const adapter = new ManualSignalSourceAdapter();
    adapter.addSignal({
      ...signal('manual-no-evidence'),
      attestedBy: 'op@example.com',
    });

    const fetched = await adapter.fetchSignals(since);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.evidenceUrl).toBeUndefined();
  });

  it('evidenceUrl propagates through fetchSignalsFromAvailableAdapters', async () => {
    const adapter = new ManualSignalSourceAdapter();
    adapter.addSignal({
      ...signal('m1'),
      attestedBy: 'op@example.com',
      evidenceUrl: 'https://example.com/ticket/42',
    });

    const result = await fetchSignalsFromAvailableAdapters([adapter], since);
    expect(result.signals[0]?.evidenceUrl).toBe('https://example.com/ticket/42');
  });
});

// ── AC #8: manual-share quality metric ─────────────────────────────────────

describe('OQ-13.4 AC#8 — manual-share quality metric', () => {
  it('defaults are exported (window 7d, threshold 0.30)', () => {
    expect(DEFAULT_MANUAL_SHARE_WINDOW_DAYS).toBe(7);
    expect(DEFAULT_MANUAL_SHARE_WARNING_THRESHOLD).toBe(0.3);
  });

  it('returns 0 share when no signals in window', () => {
    const result = computeManualShareMetric([], {
      asOf: new Date('2026-05-26T00:00:00.000Z'),
    });
    expect(result).toMatchObject({
      manualShare: 0,
      manualSignals: 0,
      totalSignals: 0,
      elevated: false,
    });
    expect(result.decision).toBeUndefined();
  });

  it('computes share over rolling 7-day window', () => {
    const asOf = new Date('2026-05-26T12:00:00.000Z');
    const signals: RawSignal[] = [
      // Out of window (>7d old) → ignored
      {
        ...signal('old-1', '2026-05-15T00:00:00.000Z'),
        attestedBy: 'op@example.com', // manual
      },
      // In window — 6 total, 2 manual = 33%
      {
        ...signal('manual-1', '2026-05-21T00:00:00.000Z'),
        attestedBy: 'op@example.com',
        metadata: { adapterName: 'signal-source-manual' },
      },
      {
        ...signal('manual-2', '2026-05-25T00:00:00.000Z'),
        attestedBy: 'op@example.com',
        metadata: { adapterName: 'signal-source-manual' },
      },
      { ...signal('auto-1', '2026-05-22T00:00:00.000Z') },
      { ...signal('auto-2', '2026-05-23T00:00:00.000Z') },
      { ...signal('auto-3', '2026-05-24T00:00:00.000Z') },
      { ...signal('auto-4', '2026-05-26T00:00:00.000Z') },
    ];
    const result = computeManualShareMetric(signals, { asOf });
    expect(result.totalSignals).toBe(6);
    expect(result.manualSignals).toBe(2);
    expect(result.manualShare).toBeCloseTo(2 / 6, 5);
    // 2/6 = 0.333... > threshold 0.30 AND total ≥ minPopulation (5) → elevated
    expect(result.elevated).toBe(true);
    expect(result.decision).toMatchObject({
      type: 'Decision',
      decision: 'manual-signal-share-elevated',
      manualSignals: 2,
      totalSignals: 6,
      threshold: 0.3,
      windowDays: 7,
    });
  });

  it('does NOT fire below threshold', () => {
    const asOf = new Date('2026-05-26T00:00:00.000Z');
    const signals: RawSignal[] = [
      ...Array.from({ length: 10 }, (_, i) =>
        signal(`auto-${i}`, `2026-05-${20 + (i % 6)}T00:00:00.000Z`),
      ),
      {
        ...signal('manual-1', '2026-05-22T00:00:00.000Z'),
        attestedBy: 'op@example.com',
      },
    ];
    const result = computeManualShareMetric(signals, { asOf });
    expect(result.elevated).toBe(false);
    expect(result.decision).toBeUndefined();
    // 1/11 ≈ 9% → below 30%
    expect(result.manualShare).toBeCloseTo(1 / 11, 5);
  });

  it('does NOT fire on tiny populations (below minPopulation default 5)', () => {
    const asOf = new Date('2026-05-26T00:00:00.000Z');
    const signals: RawSignal[] = [
      {
        ...signal('m1', '2026-05-25T00:00:00.000Z'),
        attestedBy: 'op@example.com',
      },
      { ...signal('a1', '2026-05-25T00:00:00.000Z') },
    ];
    const result = computeManualShareMetric(signals, { asOf });
    expect(result.manualShare).toBeCloseTo(0.5, 5);
    expect(result.elevated).toBe(false); // tiny population suppresses
  });

  it('respects custom window/threshold/minPopulation', () => {
    const asOf = new Date('2026-05-26T00:00:00.000Z');
    const signals: RawSignal[] = [
      {
        ...signal('m1', '2026-05-25T00:00:00.000Z'),
        attestedBy: 'op@example.com',
      },
      {
        ...signal('m2', '2026-05-25T00:00:00.000Z'),
        attestedBy: 'op@example.com',
      },
      { ...signal('a1', '2026-05-25T00:00:00.000Z') },
    ];
    // 2/3 = 67% over a 1-day window with threshold 0.5 and min pop 3 → elevated
    const result = computeManualShareMetric(signals, {
      asOf,
      windowDays: 1,
      shareWarningThreshold: 0.5,
      minPopulation: 3,
    });
    expect(result.elevated).toBe(true);
    expect(result.decision?.threshold).toBe(0.5);
    expect(result.decision?.windowDays).toBe(1);
  });

  it('uses attestedBy heuristic when metadata.adapterName is missing', () => {
    const asOf = new Date('2026-05-26T00:00:00.000Z');
    const signals: RawSignal[] = [
      // No metadata but attestedBy is set → treated as manual
      ...Array.from({ length: 4 }, (_, i) => ({
        ...signal(`m${i}`, '2026-05-25T00:00:00.000Z'),
        attestedBy: 'op@example.com',
      })),
      ...Array.from({ length: 4 }, (_, i) => signal(`a${i}`, '2026-05-25T00:00:00.000Z')),
    ];
    const result = computeManualShareMetric(signals, { asOf, minPopulation: 5 });
    expect(result.manualSignals).toBe(4);
    expect(result.totalSignals).toBe(8);
    expect(result.elevated).toBe(true); // 50% > 30%
  });

  it('custom isManual predicate is honored', () => {
    const asOf = new Date('2026-05-26T00:00:00.000Z');
    const signals: RawSignal[] = Array.from({ length: 10 }, (_, i) =>
      signal(`s${i}`, '2026-05-25T00:00:00.000Z'),
    );
    // Custom predicate: first half is manual
    const result = computeManualShareMetric(signals, {
      asOf,
      isManual: (s) => Number(s.sourceId.replace('s', '')) < 5,
    });
    expect(result.manualSignals).toBe(5);
    expect(result.totalSignals).toBe(10);
  });
});

// ── AC #9: integration coverage ────────────────────────────────────────────

describe('OQ-13.1 + OQ-13.4 integration', () => {
  it('full pipeline: in-app-feedback + manual + rate-limited operator + share metric', async () => {
    // (a) Adapter set: env-var-based in-app-feedback (configured) + manual.
    const inApp = new InAppFeedbackSignalSourceAdapter({
      env: { SIGNAL_IN_APP_FEEDBACK_API_KEY: 'test-key' },
      signals: [
        signal('feedback-1', '2026-05-23T00:00:00.000Z'),
        signal('feedback-2', '2026-05-24T00:00:00.000Z'),
        signal('feedback-3', '2026-05-25T00:00:00.000Z'),
      ],
    });

    // (b) Manual adapter with cap of 2. Operator submits 2 OK signals.
    const manual = new ManualSignalSourceAdapter({ dailyCapPerOperator: 2 });
    manual.addSignal(
      {
        ...signal('manual-a', '2026-05-25T08:00:00.000Z'),
        attestedBy: 'op@example.com',
        evidenceUrl: 'https://example.com/call/a',
      },
      new Date('2026-05-25T08:00:00.000Z'),
    );
    manual.addSignal(
      {
        ...signal('manual-b', '2026-05-25T10:00:00.000Z'),
        attestedBy: 'op@example.com',
      },
      new Date('2026-05-25T10:00:00.000Z'),
    );

    // (c) Fetch — both adapters yield signals; no Decisions yet.
    const fetched = await fetchSignalsFromAvailableAdapters(
      [inApp, manual],
      new Date('2026-05-20T00:00:00.000Z'),
    );
    expect(fetched.signals).toHaveLength(5);
    expect(fetched.decisions).toEqual([]);

    // (d) The 2 manual signals appear with attestation; one carries evidenceUrl.
    const manualSignals = fetched.signals.filter((s) => s.attestedBy === 'op@example.com');
    expect(manualSignals).toHaveLength(2);
    expect(manualSignals.find((s) => s.sourceId === 'manual-a')?.evidenceUrl).toBe(
      'https://example.com/call/a',
    );

    // (e) Share metric: 2 manual / 5 total = 40% over 7d window → elevated.
    const metric = computeManualShareMetric(fetched.signals, {
      asOf: new Date('2026-05-26T00:00:00.000Z'),
    });
    expect(metric.elevated).toBe(true);
    expect(metric.decision?.decision).toBe('manual-signal-share-elevated');
    expect(metric.manualShare).toBeCloseTo(2 / 5, 5);

    // (f) Operator over-cap: adding a 3rd manual on same day raises the error.
    expect(() =>
      manual.addSignal(
        { ...signal('manual-c'), attestedBy: 'op@example.com' },
        new Date('2026-05-25T12:00:00.000Z'),
      ),
    ).toThrow(ManualSignalRateLimitExceeded);
  });

  it('mixed credential failures + healthy adapters all produce the right Decisions', async () => {
    const notConfigured = new InAppFeedbackSignalSourceAdapter({
      available: true, // bypass isAvailable; force fetch path
      credentialNotConfigured: true, // and force the NotConfigured throw at fetch
    });
    const rejected = new SupportTicketSignalSourceAdapter({
      credentialRejected: true,
    });
    const healthy = new CommunityThreadSignalSourceAdapter({
      signals: [signal('community-1', '2026-05-25T00:00:00.000Z')],
    });
    const manualAdapter = new ManualSignalSourceAdapter();
    manualAdapter.addSignal({
      ...signal('manual-1', '2026-05-25T08:00:00.000Z'),
      attestedBy: 'op@example.com',
    });

    const result = await fetchSignalsFromAvailableAdapters(
      [notConfigured, rejected, healthy, manualAdapter],
      since,
    );

    expect(result.signals.map((s) => s.sourceId).sort()).toEqual(['community-1', 'manual-1']);
    expect(result.decisions.map((d) => d.decision).sort()).toEqual([
      'adapter-credential-not-configured',
      'adapter-credential-rejected',
    ]);
  });
});
