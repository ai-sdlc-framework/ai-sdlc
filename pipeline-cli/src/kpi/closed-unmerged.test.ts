import { describe, expect, it } from 'vitest';
import {
  classifyClosedUnmerged,
  fetchClosedUnmergedPrs,
  type ListedClosedPr,
} from './closed-unmerged.js';

const closed = (n: number, extra: Partial<ListedClosedPr> = {}): ListedClosedPr => ({
  number: n,
  state: 'CLOSED',
  mergedAt: null,
  createdAt: '2026-10-12T00:00:00Z',
  closedAt: '2026-10-13T00:00:00Z',
  ...extra,
});

describe('classifyClosedUnmerged', () => {
  const since = new Date('2026-10-10T00:00:00Z');
  const prs: ListedClosedPr[] = [
    closed(1434, { headRefName: 'ai-sdlc/aisdlc-823-a' }),
    closed(1437, { headRefName: 'ai-sdlc/aisdlc-823-b', createdAt: '2026-10-12T05:00:00Z' }),
    {
      number: 1440,
      state: 'MERGED',
      mergedAt: '2026-10-14T00:00:00Z',
      createdAt: '2026-10-13T00:00:00Z',
      headRefName: 'ai-sdlc/aisdlc-823-c',
    },
    closed(1500, { title: 'x (AISDLC-9)', labels: [{ name: 'superseded' }] }),
    closed(1501, { title: 'withdrawn thing' }),
    closed(1502, { title: 'nothing' }),
    closed(1503, { closedAt: '2026-09-01T00:00:00Z' }),
    {
      number: 1504,
      state: 'MERGED',
      mergedAt: '2026-10-13T00:00:00Z',
      closedAt: '2026-10-13T00:00:00Z',
    },
  ];

  it('counts per cause with numbers and task ids', () => {
    const r = classifyClosedUnmerged(prs, since);
    expect(r.total).toBe(5);
    expect(r.byCause).toEqual({ 're-filed': 2, superseded: 1, withdrawn: 1, unknown: 1 });
    expect(r.prs.map((p) => [p.number, p.taskId])).toContainEqual([1434, 'AISDLC-823']);
    expect(r.byWeek['2026-W42']).toBe(5);
  });

  it('classifies a close followed by a merged or open PR for the same task as re-filed', () => {
    const r = classifyClosedUnmerged(prs, since);
    expect(r.prs.find((p) => p.number === 1434)?.cause).toBe('re-filed');
    expect(r.prs.find((p) => p.number === 1437)?.cause).toBe('re-filed');
  });
});

describe('fetchClosedUnmergedPrs', () => {
  const res = (status: number, stdout: string) => () => ({ status, stdout, stderr: '' });
  it('parses the list', () => {
    expect(fetchClosedUnmergedPrs(res(0, '[{"number":1}]'), '.')).toEqual([{ number: 1 }]);
  });
  it('is undefined on failure or bad output', () => {
    expect(fetchClosedUnmergedPrs(res(1, ''), '.')).toBeUndefined();
    expect(fetchClosedUnmergedPrs(res(0, 'nope'), '.')).toBeUndefined();
    expect(fetchClosedUnmergedPrs(res(0, '{}'), '.')).toBeUndefined();
  });
});
