import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelCallRecord } from '@ai-sdlc/reference';
import type { LedgerRow } from '../knowledge/retrieval/ledger.js';
import {
  buildJitReport,
  readSessionLedgers,
  renderJitJson,
  renderJitText,
  WEEK_MS,
  type SessionLedger,
} from './jit-report.js';

const row = (id: string, tokens: number, moment: string, at: string): LedgerRow => ({
  kind: 'load',
  id,
  contentHash: 'h',
  tokens,
  at,
  moment,
});

function call(sessionId: string, role: string, ts: string, cacheRead: number): ModelCallRecord {
  return {
    sessionId,
    agentRole: role,
    ts,
    model: 'm',
    callId: `${sessionId}-${ts}`,
    tokens: { input: 1, output: 1, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0 },
  } as unknown as ModelCallRecord;
}

const T = '2026-09-01T00:00:00.000Z';
const LATER = '2026-09-01T01:00:00.000Z';
const ledgers: SessionLedger[] = [
  {
    sessionId: 's1',
    rows: [
      { ...row('CLAUDE.md', 0, 'premark', T), kind: 'premark' },
      row('a', 100, 'session-start', T),
      row('b', 300, 'prompt', T),
    ],
  },
  { sessionId: 's2', rows: [row('c', 50, 'prompt', T)] },
];
const records = [
  call('s1', 'executor', T, 1000),
  call('s1', 'executor', LATER, 500),
  call('s2', 'planner', T, 70),
];

describe('buildJitReport', () => {
  it('reports injected tokens by role and moment from the ledger', () => {
    const r = buildJitReport({ ledgers, records });
    expect(r.byMoment.map((m) => [m.role, m.moment, m.injectedTokens])).toEqual([
      ['executor', 'prompt', 300],
      ['executor', 'session-start', 100],
      ['planner', 'prompt', 50],
    ]);
  });

  it('computes cited share from later references only', () => {
    const r = buildJitReport({
      ledgers,
      records,
      references: [
        { sessionId: 's1', id: 'a', at: LATER },
        { sessionId: 's1', id: 'b', at: '2025-01-01T00:00:00Z' }, // before the load
        { sessionId: 's2', id: 'a', at: LATER }, // other session
      ],
    });
    const s1 = r.sessions.find((s) => s.sessionId === 's1');
    expect(s1?.injections).toBe(2);
    expect(s1?.cited).toBe(1);
    expect(s1?.citedShare).toBe(0.5);
    expect(r.sessions.find((s) => s.sessionId === 's2')?.citedShare).toBe(0);
    expect(r.byMoment.find((m) => m.moment === 'session-start')?.citedShare).toBe(1);
  });

  it('shows cache-read tokens of the same sessions beside injected tokens', () => {
    const r = buildJitReport({ ledgers, records });
    expect(r.sessions.map((s) => [s.sessionId, s.injectedTokens, s.cacheReadTokens])).toEqual([
      ['s1', 400, 1500],
      ['s2', 50, 70],
    ]);
    const text = renderJitText(r);
    expect(text).toContain('cache_read');
    expect(text).toContain('1,500');
    expect(JSON.parse(renderJitJson(r)).sessions).toHaveLength(2);
  });

  it('uses (unknown) role for a ledger without model calls', () => {
    const r = buildJitReport({ ledgers: [ledgers[1]], records: [] });
    expect(r.sessions[0].role).toBe('(unknown)');
  });

  it('renders an empty report', () => {
    expect(renderJitText(buildJitReport({ ledgers: [], records: [] }))).toContain(
      'No load ledgers',
    );
  });
});

describe('weekly net-token flag', () => {
  const change = Date.parse('2026-09-10T00:00:00Z');
  const at = (offsetMs: number): string => new Date(change + offsetMs).toISOString();
  function scenario(afterTokens: number) {
    const ls: SessionLedger[] = [
      { sessionId: 'old', rows: [row('x', 100, 'prompt', at(-WEEK_MS / 2))] },
      { sessionId: 'new', rows: [row('x', afterTokens, 'prompt', at(1000))] },
    ];
    const rs = [
      call('old', 'executor', at(-WEEK_MS / 2), 1000),
      call('new', 'executor', at(1000), 1000),
    ];
    return buildJitReport({
      ledgers: ls,
      records: rs,
      profiles: {
        changes: [{ profile: 'jit', at: at(0) }],
        sessions: { old: 'jit', new: 'jit' },
      },
    });
  }

  it('fires when the change raised net tokens', () => {
    const r = scenario(900);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].raised).toBe(true);
    expect(renderJitText(r)).toContain('RAISED NET TOKENS');
  });

  it('stays quiet when net tokens fell or held', () => {
    expect(scenario(100).flags[0].raised).toBe(false);
    expect(scenario(10).flags[0].raised).toBe(false);
  });

  it('stays quiet without sessions on both sides', () => {
    const r = buildJitReport({
      ledgers: [{ sessionId: 'new', rows: [row('x', 900, 'prompt', at(1000))] }],
      records: [call('new', 'executor', at(1000), 1000)],
      profiles: {
        changes: [
          { profile: 'jit', at: at(0) },
          { profile: 'bad', at: 'nope' },
        ],
        sessions: { new: 'jit' },
      },
    });
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0].raised).toBe(false);
  });
});

describe('readSessionLedgers', () => {
  it('reads every session ledger and tolerates a missing directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'jit-'));
    expect(readSessionLedgers(root)).toEqual([]);
    const dir = join(root, '.ai-sdlc', 'context', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's1.jsonl'), `${JSON.stringify(row('a', 5, 'prompt', T))}\n`);
    writeFileSync(join(dir, 'bad name.jsonl'), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    const out = readSessionLedgers(root);
    expect(out.map((l) => l.sessionId)).toEqual(['s1']);
    expect(out[0].rows[0].tokens).toBe(5);
  });
});
