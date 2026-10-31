import { describe, expect, it } from 'vitest';
import type { ModelCallRecord, PriceRow } from '@ai-sdlc/reference';
import { buildSplitReport, isPollingCall, renderSplitText } from './split-views.js';

const price: PriceRow = {
  model: 'm',
  inputPer1M: 1_000_000,
  outputPer1M: 0,
  cacheReadPer1M: 0,
  cacheWrite5mPer1M: 0,
  cacheWrite1hPer1M: 0,
  source: 't',
  url: 'https://example.invalid',
  fetchedAt: '2026-01-01T00:00:00.000Z',
  effectiveFrom: '2026-01-01',
  status: 'active',
};

function rec(id: string, over: Partial<ModelCallRecord> = {}): ModelCallRecord {
  return {
    schemaVersion: 'v1',
    callId: id,
    ts: '2026-10-29T10:00:00.000Z',
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'm',
    tokens: { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
    billingPool: 'subscription',
    sessionId: 's',
    agentRole: 'executor',
    scope: 'framework',
    ...over,
  } as ModelCallRecord;
}

describe('split views', () => {
  const records = [
    rec('a', { taskId: 'T-1' }),
    rec('b', { taskId: 'T-1', toolNames: ['ScheduleWakeup'] }),
    rec('c', { taskId: 'T-1', toolNames: ['ScheduleWakeup', 'Bash'] }),
    rec('d', { agentRole: 'planner', ts: '2026-10-30T10:00:00.000Z' }),
    rec('e', { model: 'unknown-model' }),
  ];

  it('classifies polling calls', () => {
    expect(isPollingCall({ toolNames: ['Monitor'] })).toBe(true);
    expect(isPollingCall({ toolNames: ['Monitor', 'Edit'] })).toBe(false);
    expect(isPollingCall({ toolNames: [] })).toBe(false);
    expect(isPollingCall({})).toBe(false);
  });

  it('splits work and polling per task', () => {
    const rows = buildSplitReport(records, 'task', [price]);
    const t1 = rows.find((r) => r.key === 'T-1')!;
    expect(t1).toMatchObject({ calls: 3, workCalls: 2, pollingCalls: 1 });
    expect(t1.workUsd).toBeCloseTo(2);
    expect(t1.pollingUsd).toBeCloseTo(1);
    expect(rows.some((r) => r.key === '(none)')).toBe(true);
  });

  it('groups by role and by day', () => {
    expect(buildSplitReport(records, 'role', [price]).map((r) => r.key)).toContain('planner');
    expect(buildSplitReport(records, 'day', [price]).map((r) => r.key)).toEqual([
      '2026-10-29',
      '2026-10-30',
    ]);
    expect(buildSplitReport([rec('x', { ts: 'bad' })], 'day', [price])[0].key).toBe('unknown');
  });

  it('renders a table and an empty message', () => {
    expect(renderSplitText('task', buildSplitReport(records, 'task', [price]))).toContain(
      'polling_usd',
    );
    expect(renderSplitText('task', [])).toContain('No usage recorded');
  });
});
