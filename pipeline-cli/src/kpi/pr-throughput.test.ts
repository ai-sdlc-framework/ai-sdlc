import { describe, expect, it } from 'vitest';
import {
  classifyPr,
  computeThroughput,
  latencyOf,
  refreshPage,
  renderMarkdownTable,
  summaryLine,
  SECTION_BEGIN,
  type PrRecord,
} from './pr-throughput.js';

const H = 3_600_000;
const base = Date.parse('2026-10-11T00:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

function pr(branch: string, openMs: number, landHours?: number, closedHours?: number): PrRecord {
  return {
    headRefName: branch,
    createdAt: iso(openMs),
    mergedAt: landHours === undefined ? null : iso(openMs + landHours * H),
    closedAt: closedHours === undefined ? null : iso(openMs + closedHours * H),
  };
}

describe('classifyPr', () => {
  it.each([
    ['ai-sdlc/aisdlc-877-feat-x', 'task'],
    ['ai-sdlc/file-foo', 'record'],
    ['ai-sdlc/decisions-sync', 'record'],
    ['chore/sync-tasks-1', 'record'],
    ['release-please--branches--main', 'record'],
    ['rfc-0054', 'record'],
    ['audit-q3', 'record'],
    ['dependabot/npm_and_yarn/x', 'dependency'],
    ['feat/whatever', 'other'],
  ])('%s -> %s', (b, c) => expect(classifyPr(b)).toBe(c));
});

describe('computeThroughput', () => {
  it('computes ratios, closed-unmerged and latency', () => {
    const prs = [
      pr('ai-sdlc/aisdlc-1', base, 2),
      pr('ai-sdlc/aisdlc-2', base, 6),
      pr('ai-sdlc/aisdlc-3', base + H, undefined, 3),
      pr('ai-sdlc/aisdlc-4', base + H),
      pr('ai-sdlc/file-x', base, 1),
      pr('dependabot/a', base),
      pr('feat/z', base, 1),
    ];
    const r = computeThroughput(prs, '2026-10-11', '2026-10-11');
    const d = r.days[0];
    expect(d.task).toEqual({ opened: 4, landed: 2, closedUnmerged: 1 });
    expect(d.record.landed).toBe(1);
    expect(d.dependency.opened).toBe(1);
    expect(d.other.landed).toBe(1);
    expect(d.ratioTask).toBe(0.5);
    expect(d.ratioAll).toBeCloseTo(4 / 7);
    expect(d.latencyTask).toEqual({ count: 2, medianHours: 4, p90Hours: 6, maxHours: 6 });
  });

  it('ratio is null when nothing opened and window ignores outside days', () => {
    const r = computeThroughput([pr('feat/z', base - 5 * 24 * H, 1)], '2026-10-11', '2026-10-12');
    expect(r.days).toHaveLength(2);
    expect(r.days[0].ratioAll).toBeNull();
    expect(r.total.latencyTask).toBeNull();
  });

  it('matches the 10-11..10-14 drain-review numbers', () => {
    const prs: PrRecord[] = [];
    // 52 landed task PRs: 30x4h, 16x10h, 5x21h, 1x67h => median 4, p90 21, max 67.
    const lat = [...Array(30).fill(4), ...Array(16).fill(10), ...Array(5).fill(21), 67] as number[];
    lat.forEach((h, i) => prs.push(pr(`ai-sdlc/aisdlc-${i}`, base + (i % 3) * 24 * H, h)));
    for (let i = 0; i < 7; i++) prs.push(pr(`ai-sdlc/aisdlc-9${i}`, base + 24 * H));
    for (let i = 0; i < 84; i++)
      prs.push(pr(`ai-sdlc/file-${i}`, base + (i % 4) * 24 * H, i < 77 ? 1 : undefined));
    const r = computeThroughput(prs, '2026-10-11', '2026-10-15');
    expect(r.total.task.opened).toBe(59);
    expect(r.total.task.landed).toBe(52);
    expect(r.total.record.opened).toBe(84);
    expect(r.total.record.landed).toBe(77);
    expect(r.total.latencyTask).toMatchObject({ medianHours: 4, p90Hours: 21, maxHours: 67 });
    expect(summaryLine(r)).toContain('task 59 opened / 52 landed (ratio 0.88)');
  });
});

describe('rendering', () => {
  const report = computeThroughput([pr('ai-sdlc/aisdlc-1', base, 2)], '2026-10-11', '2026-10-11');

  it('latencyOf empty is null', () => expect(latencyOf([])).toBeNull());

  it('renders a table and replaces the marked section idempotently', () => {
    expect(renderMarkdownTable(report)).toContain('| 2026-10-11 | 1/1 |');
    const once = refreshPage('# KPIs\n', report);
    expect(once).toContain('## PR throughput');
    expect(once).toContain(SECTION_BEGIN);
    expect(refreshPage(once, report)).toBe(once);
  });
});
