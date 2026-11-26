import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runHierarchyCli } from '../cli/hierarchy.js';
import {
  callShape,
  formatGhUsageReport,
  ghUsageReport,
  parseSince,
  readLedgers,
} from './gh-usage.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gh-usage');
const LEDGER = path.join(FIXTURES, 'gh-calls.jsonl');
const CI_DIR = path.join(FIXTURES, 'ci');
const NOW = new Date('2026-11-26T12:00:00.000Z');
const WEEK = 7 * 24 * 3_600_000;

describe('gh-usage report (AISDLC-1439)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports per-token figures from the fixture ledger and a CI snapshot directory', () => {
    const r = ghUsageReport(readLedgers([LEDGER, CI_DIR]), NOW, WEEK);
    expect(r.since).toBe('2026-11-19T12:00:00.000Z');
    expect(r.tokens.map((t) => t.token)).toEqual(['actions', 'user']);
    const [ci, user] = r.tokens;
    // rate_limit reads are unmetered and not counted; the 2026-11-10 line is outside the window.
    expect(user!.calls).toBe(6);
    expect(user!.callsPerHour).toEqual({ mean: 0, p95: 0, max: 3 });
    expect(user!.lowestRemaining).toEqual({
      core: { remaining: 3000, at: '2026-11-25T08:02:00.000Z' },
      graphql: { remaining: 0, at: '2026-11-25T08:02:00.000Z' },
    });
    expect(user!.rateLimitErrors).toEqual({
      count: 2,
      at: ['2026-11-25T08:00:00.000Z', '2026-11-25T08:01:00.000Z'],
    });
    expect(user!.topShapes).toEqual([
      { shape: 'api repos/o/r/pulls/:n/reviews', count: 2 },
      { shape: 'pr view', count: 2 },
      { shape: 'issue view', count: 1 },
      { shape: 'pr list', count: 1 },
    ]);
    expect(ci!.calls).toBe(0);
    expect(ci!.lowestRemaining.core).toEqual({ remaining: 120, at: '2026-11-24T12:00:00.000Z' });
    expect(ci!.rateLimitErrors).toEqual({ count: 1, at: ['2026-11-24T12:00:00.000Z'] });

    const text = formatGhUsageReport(r);
    expect(text).toContain('token user: 6 calls');
    expect(text).toContain('calls/h: mean 0, p95 0, max 3');
    expect(text).toContain('lowest remaining: core 3000 at 2026-11-25T08:02:00.000Z, graphql 0');
    expect(text).toContain(
      'rate-limit errors: 2 (2026-11-25T08:00:00.000Z, 2026-11-25T08:01:00.000Z)',
    );
    expect(text).toContain('token actions: 0 calls');
    expect(text).toMatch(/ {5}2 {2}api repos\/o\/r\/pulls\/:n\/reviews/);
  });

  it('an empty window and a missing ledger print a placeholder', () => {
    const r = ghUsageReport(readLedgers(['/nonexistent/gh-calls.jsonl']), NOW, WEEK);
    expect(r.tokens).toEqual([]);
    expect(formatGhUsageReport(r)).toContain('no gh calls recorded in the window');
    const one = ghUsageReport(
      [{ at: '2026-11-26T11:30:00.000Z', session: 's', argv: ['pr', 'list'], exit: 0 }],
      NOW,
      3_600_000,
    );
    expect(formatGhUsageReport(one)).toContain('lowest remaining: none recorded');
    expect(one.tokens[0]!.callsPerHour).toEqual({ mean: 1, p95: 1, max: 1 });
  });

  it('parses --since and call shapes', () => {
    expect(parseSince(undefined)).toBe(WEEK);
    expect(parseSince('36h')).toBe(36 * 3_600_000);
    expect(parseSince('90m')).toBe(90 * 60_000);
    expect(parseSince('0d')).toBeUndefined();
    expect(parseSince('week')).toBeUndefined();
    expect(callShape(['api', '/repos/o/r/commits/' + 'a'.repeat(40) + '/status'])).toBe(
      'api repos/o/r/commits/:sha/status',
    );
    expect(callShape(['--version'])).toBe('(none)');
    expect(callShape(['api'])).toBe('api');
  });

  it('cli-hierarchy gh-usage report prints the report from the board ledger plus --ledger', async () => {
    const board = mkdtempSync(path.join(tmpdir(), 'gh-usage-'));
    mkdirSync(board, { recursive: true });
    copyFileSync(LEDGER, path.join(board, 'gh-calls.jsonl'));
    const logs: string[] = [];
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    });
    const over = {
      boardDir: board,
      cwd: FIXTURES,
      now: () => NOW,
      log: (l: string) => logs.push(l),
    };
    expect(
      await runHierarchyCli(['gh-usage', 'report', '--since', '7d', '--ledger', 'ci'], over),
    ).toBe(0);
    expect(out.join('')).toContain('token actions: 0 calls');
    expect(out.join('')).toContain('token user: 6 calls');
    expect(await runHierarchyCli(['gh-usage', 'report', '--json'], over)).toBe(0);
    expect(JSON.parse(logs[0]!).tokens[0].token).toBe('user');
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runHierarchyCli(['gh-usage', 'report', '--since', 'soon'], over)).toBe(2);
    expect(await runHierarchyCli(['gh-usage'], over)).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toContain('gh-usage report');
  });
});
