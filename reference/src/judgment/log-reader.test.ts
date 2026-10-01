import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJudgmentLog } from './log-reader.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judgment-log-reader-'));
  mkdirSync(join(dir, '_judgment'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ts: '2026-10-02T10:00:00.000Z',
    judgmentId: 'a.b',
    version: 1,
    provider: 'jev',
    modelVersion: 'jev-1',
    configuredMode: 'shadow',
    effectiveMode: 'shadow',
    answers: { q: { type: 'noul', probability: 0.9 } },
    thresholds: { pass: 0.5 },
    outcome: { kind: 'abstain', reason: 'shadow' },
    incumbent: true,
    latencyMs: 12,
    cacheHit: true,
    ...over,
  });

describe('readJudgmentLog', () => {
  it('returns nothing when the directory is missing', () => {
    expect(readJudgmentLog(join(dir, 'nope'))).toEqual({
      entries: [],
      malformedLines: 0,
      skippedFiles: [],
    });
  });

  it('parses records and counts malformed lines', () => {
    writeFileSync(
      join(dir, '_judgment', 'log-2026-10-02.jsonl'),
      [
        line(),
        '',
        'not json',
        '[1]',
        line({ ts: 'bad' }),
        line({ judgmentId: '' }),
        line({ answers: null, outcome: 5, incumbent: undefined }),
      ].join('\n'),
    );
    const r = readJudgmentLog(dir);
    expect(r.entries).toHaveLength(2);
    expect(r.malformedLines).toBe(4);
    expect(r.entries[0]).toMatchObject({
      judgmentId: 'a.b',
      provider: 'jev',
      incumbent: true,
      cacheHit: true,
      latencyMs: 12,
    });
    expect(r.entries[1]).toMatchObject({ answers: null, outcome: null, incumbent: null });
  });

  it('filters by date, judgment id and ignores unrelated files', () => {
    writeFileSync(
      join(dir, '_judgment', 'log-2026-10-01.jsonl'),
      line({ ts: '2026-10-01T23:00:00Z' }),
    );
    writeFileSync(
      join(dir, '_judgment', 'log-2026-10-02.jsonl'),
      `${line()}\n${line({ judgmentId: 'z' })}\n${line({ ts: '2026-10-02T01:00:00Z' })}`,
    );
    writeFileSync(join(dir, '_judgment', 'notes.txt'), 'x');
    const since = new Date('2026-10-02T05:00:00Z');
    expect(readJudgmentLog(dir, { since }).entries).toHaveLength(2);
    expect(readJudgmentLog(dir, { since, judgmentId: 'z' }).entries).toHaveLength(1);
    expect(readJudgmentLog(dir, { since: new Date('x') }).entries).toHaveLength(4);
  });

  it('skips symlinked and oversized files', () => {
    writeFileSync(join(dir, 'real.jsonl'), line());
    symlinkSync(join(dir, 'real.jsonl'), join(dir, '_judgment', 'log-2026-10-03.jsonl'));
    writeFileSync(join(dir, '_judgment', 'log-2026-10-04.jsonl'), line());
    const r = readJudgmentLog(dir, { maxFileBytes: 10 });
    expect(r.entries).toHaveLength(0);
    expect(r.skippedFiles.sort()).toEqual(['log-2026-10-03.jsonl', 'log-2026-10-04.jsonl']);
  });
});
