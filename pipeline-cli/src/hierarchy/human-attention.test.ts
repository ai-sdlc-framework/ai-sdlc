import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  classifyHumanAttention,
  fetchHumanAttentionPrs,
  formatHumanAttentionRow,
  formatHumanAttentionStall,
  type HumanAttentionPr,
} from './human-attention.js';

const NOW = new Date('2026-10-15T12:00:00Z');
const base: HumanAttentionPr = {
  number: 1,
  title: 'feat: x (AISDLC-1)',
  createdAt: '2026-10-15T10:00:00Z',
  isDraft: false,
};

describe('classifyHumanAttention', () => {
  it('flags a title with the marker', () => {
    const rows = classifyHumanAttention(
      [{ ...base, title: 'feat: x [needs-human-attention]', openFindings: 3, isDraft: true }],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: 'title-marker',
      draft: true,
      openFindings: 3,
      stalled: false,
    });
    expect(formatHumanAttentionRow(rows[0]!)).toContain('2h old, draft');
  });

  it('flags an iterate-needed verdict at the cap but not below it', () => {
    const capped = { ...base, verdictOutcome: 'iterate-needed', atReviewCap: true };
    const below = { ...base, number: 2, verdictOutcome: 'iterate-needed', atReviewCap: false };
    const rows = classifyHumanAttention([capped, below], NOW);
    expect(rows.map((r) => r.number)).toEqual([1]);
    expect(rows[0]!.reason).toBe('review-cap');
    expect(formatHumanAttentionRow(rows[0]!)).toContain('(review cap)');
  });

  it('does not flag a plain PR', () => {
    expect(classifyHumanAttention([base], NOW)).toEqual([]);
  });

  it('marks a flagged PR older than 24h as stalled', () => {
    const old = { ...base, title: '[needs-human-attention] y', createdAt: '2026-10-13T12:00:00Z' };
    const fresh = { ...old, number: 2, createdAt: '2026-10-14T13:00:00Z' };
    const rows = classifyHumanAttention([fresh, old], NOW);
    expect(rows.map((r) => [r.number, r.stalled])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(formatHumanAttentionStall(rows[0]!)).toBe('PR #1 needs a human for 48h');
  });

  it('treats an unparseable createdAt as age zero', () => {
    const rows = classifyHumanAttention(
      [{ ...base, title: '[needs-human-attention]', createdAt: '' }],
      NOW,
    );
    expect(rows[0]!.ageMs).toBe(0);
    expect(rows[0]!.mergeState).toBe('UNKNOWN');
  });
});

describe('fetchHumanAttentionPrs', () => {
  const board = mkdtempSync(path.join(tmpdir(), 'ha-'));
  mkdirSync(path.join(board, 'done'), { recursive: true });
  writeFileSync(
    path.join(board, 'done', 'AISDLC-7.verdict.json'),
    JSON.stringify({
      schemaVersion: 'v1',
      taskId: 'AISDLC-7',
      outcome: 'iterate-needed',
      iterationsAttempted: 2,
      completedAt: '2026-10-15T00:00:00Z',
      workerId: 'w',
    }),
  );
  const ok = (stdout: string) => () => ({ status: 0, stdout, stderr: '' });

  it('joins verdicts and parses findings', () => {
    const prs = fetchHumanAttentionPrs(
      ok(
        JSON.stringify([
          {
            number: 9,
            title: 'feat: z (AISDLC-7)',
            body: '2 open findings',
            headRefName: 'ai-sdlc/aisdlc-7-z',
            createdAt: '2026-10-15T00:00:00Z',
            isDraft: false,
            mergeStateStatus: 'CLEAN',
          },
          { number: 10 },
        ]),
      ),
      '.',
      board,
    );
    expect(prs?.[0]).toMatchObject({
      openFindings: 2,
      atReviewCap: true,
      mergeStateStatus: 'CLEAN',
    });
    expect(prs?.[1]).toMatchObject({ number: 10, title: '' });
  });

  it('returns undefined on failure or unreadable output', () => {
    expect(
      fetchHumanAttentionPrs(() => ({ status: 1, stdout: '', stderr: 'x' }), '.', board),
    ).toBeUndefined();
    expect(fetchHumanAttentionPrs(ok('nope'), '.', board)).toBeUndefined();
    expect(fetchHumanAttentionPrs(ok('{}'), '.', board)).toBeUndefined();
  });
});
