import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatJudgmentLiveness, judgmentLiveness } from './judgment-liveness.js';
import { formatStatus, type StatusResult } from './status.js';

const NOW = new Date('2026-11-26T12:00:00Z');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judgment-liveness-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rec = (over: Record<string, unknown>) => ({
  judgmentId: 'review.routing',
  version: 1,
  provider: 'jev',
  configuredMode: 'shadow',
  effectiveMode: 'shadow',
  latencyMs: null,
  cacheHit: false,
  outcome: { kind: 'abstain', reason: 'disabled' },
  ...over,
});

const configAct = (ts: string) =>
  rec({
    ts,
    judgmentId: 'review.reviewer-set.selection',
    configuredMode: 'off',
    effectiveMode: 'off',
    // a config record never counts, even with a latency recorded
    latencyMs: 3,
    outcome: { kind: 'act', decision: { set: 'staged', decidedBy: 'config:explicit-staged' } },
  });

function writeLog(day: string, records: Record<string, unknown>[]): void {
  mkdirSync(join(dir, '_judgment'), { recursive: true });
  writeFileSync(
    join(dir, '_judgment', `log-${day}.jsonl`),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

describe('judgmentLiveness (AISDLC-1442)', () => {
  it('is DOWN with no log', () => {
    expect(judgmentLiveness(dir, NOW)).toEqual({
      state: 'down',
      since: null,
      reason: 'no judgment records',
    });
  });

  it('is DOWN when the log holds only config act records', () => {
    writeLog('2026-11-26', [configAct('2026-11-26T01:00:00Z'), configAct('2026-11-26T02:00:00Z')]);
    const j = judgmentLiveness(dir, NOW);
    expect(j).toEqual({
      state: 'down',
      since: '2026-11-26T01:00:00Z',
      reason: 'config decisions only',
    });
    expect(formatJudgmentLiveness(j, NOW.getTime())).toBe(
      'judgment: DOWN since 2026-11-26T01:00:00Z (config decisions only)',
    );
  });

  it('is live when the newest non-config record is a provider call', () => {
    writeLog('2026-11-26', [
      rec({ ts: '2026-11-26T10:00:00Z' }),
      rec({
        ts: '2026-11-26T11:00:00Z',
        latencyMs: 105,
        outcome: { kind: 'abstain', reason: 'shadow' },
      }),
      configAct('2026-11-26T11:30:00Z'),
    ]);
    const j = judgmentLiveness(dir, NOW);
    expect(j).toEqual({ state: 'live', lastCallAt: '2026-11-26T11:00:00Z' });
    expect(formatJudgmentLiveness(j, NOW.getTime())).toBe(
      'judgment: live (last provider call 1h0m ago)',
    );
  });

  it('is DOWN since the first record after the last provider call, with the newest reason', () => {
    writeLog('2026-11-21', [
      rec({ ts: '2026-11-21T20:34:26Z', latencyMs: 105, outcome: { kind: 'act', decision: {} } }),
      rec({ ts: '2026-11-21T21:00:00Z', latencyMs: 0 }),
    ]);
    writeLog('2026-11-26', [
      rec({
        ts: '2026-11-26T09:00:00Z',
        latencyMs: 40,
        outcome: { kind: 'abstain', reason: 'provider-error' },
      }),
      rec({ ts: '2026-11-26T10:00:00Z', latencyMs: 50, cacheHit: true }),
      rec({ ts: '2026-11-26T11:00:00Z' }),
    ]);
    expect(judgmentLiveness(dir, NOW)).toEqual({
      state: 'down',
      since: '2026-11-21T21:00:00Z',
      reason: 'disabled',
    });
  });

  it('names cache hits and missing reasons', () => {
    writeLog('2026-11-26', [rec({ ts: '2026-11-26T10:00:00Z', latencyMs: 9, cacheHit: true })]);
    expect(judgmentLiveness(dir, NOW)).toMatchObject({ reason: 'cache hits only' });
    writeLog('2026-11-26', [rec({ ts: '2026-11-26T10:00:00Z', outcome: { kind: 'act' } })]);
    expect(judgmentLiveness(dir, NOW)).toMatchObject({ reason: 'no provider call' });
  });

  it('formats a long age in days and an unparseable one as ?', () => {
    expect(
      formatJudgmentLiveness({ state: 'live', lastCallAt: '2026-11-21T12:00:00Z' }, NOW.getTime()),
    ).toBe('judgment: live (last provider call 5d ago)');
    expect(formatJudgmentLiveness({ state: 'live', lastCallAt: 'x' }, NOW.getTime())).toBe(
      'judgment: live (last provider call ?)',
    );
    expect(
      formatJudgmentLiveness({ state: 'live', lastCallAt: '2026-11-26T11:55:00Z' }, NOW.getTime()),
    ).toBe('judgment: live (last provider call 5m ago)');
    expect(formatJudgmentLiveness({ state: 'down', since: null, reason: 'r' }, 0)).toBe(
      'judgment: DOWN since unknown (r)',
    );
  });

  it('formatStatus prints the judgment line', () => {
    const result = {
      rows: [],
      board: { queued: 0, inflight: 0, done: 0, failed: 0 },
      webhook: { state: 'absent' },
      scheduler: { state: 'absent' },
      judgment: { state: 'down', since: null, reason: 'no judgment records' },
    } as unknown as StatusResult;
    expect(formatStatus(result, NOW.getTime())).toContain(
      'judgment: DOWN since unknown (no judgment records)',
    );
  });
});
