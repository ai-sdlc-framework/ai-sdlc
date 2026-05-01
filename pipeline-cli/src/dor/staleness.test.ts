/**
 * Staleness decider tests.
 */

import { describe, expect, it } from 'vitest';
import {
  decideStaleness,
  decideStalenessBatch,
  renderStalenessCloseNote,
  renderStalenessWarning,
} from './staleness.js';

const NOW = new Date('2026-05-15T12:00:00.000Z');

function daysAgo(d: number): string {
  const ms = NOW.getTime() - d * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

describe('decideStaleness', () => {
  it('returns "none" when within warnAfterDays', () => {
    const result = decideStaleness(
      { issueId: 'AISDLC-1', lastAuthorActivityAt: daysAgo(5) },
      { now: NOW },
    );
    expect(result.action).toBe('none');
    expect(result.daysInactive).toBe(5);
  });

  it('returns "warn" when between warnAfterDays and closeAfterDays', () => {
    const result = decideStaleness(
      { issueId: 'AISDLC-1', lastAuthorActivityAt: daysAgo(15) },
      { now: NOW },
    );
    expect(result.action).toBe('warn');
    expect(result.reason).toContain('warnAfterDays');
  });

  it('returns "close" when >= closeAfterDays', () => {
    const result = decideStaleness(
      { issueId: 'AISDLC-1', lastAuthorActivityAt: daysAgo(28) },
      { now: NOW },
    );
    expect(result.action).toBe('close');
    expect(result.reason).toContain('closeAfterDays');
  });

  it('does not re-warn an already-warned candidate', () => {
    const result = decideStaleness(
      { issueId: 'AISDLC-1', lastAuthorActivityAt: daysAgo(20), warnedAt: daysAgo(6) },
      { now: NOW },
    );
    expect(result.action).toBe('none');
  });

  it('still closes a previously-warned candidate when threshold trips', () => {
    const result = decideStaleness(
      { issueId: 'AISDLC-1', lastAuthorActivityAt: daysAgo(30), warnedAt: daysAgo(16) },
      { now: NOW },
    );
    expect(result.action).toBe('close');
  });

  it('honors per-project config overrides', () => {
    const result = decideStaleness(
      { issueId: 'AISDLC-1', lastAuthorActivityAt: daysAgo(8) },
      { now: NOW, config: { warnAfterDays: 7, closeAfterDays: 21, closedLabel: 'x' } },
    );
    expect(result.action).toBe('warn');
  });

  it('returns daysInactive=0 for future activity (clock skew defense)', () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    const result = decideStaleness(
      { issueId: 'AISDLC-1', lastAuthorActivityAt: future },
      { now: NOW },
    );
    expect(result.daysInactive).toBe(0);
    expect(result.action).toBe('none');
  });
});

describe('decideStalenessBatch', () => {
  it('preserves order and decides per-candidate', () => {
    const decisions = decideStalenessBatch(
      [
        { issueId: 'A', lastAuthorActivityAt: daysAgo(2) },
        { issueId: 'B', lastAuthorActivityAt: daysAgo(15) },
        { issueId: 'C', lastAuthorActivityAt: daysAgo(40) },
      ],
      { now: NOW },
    );
    expect(decisions.map((d) => `${d.issueId}:${d.action}`)).toEqual([
      'A:none',
      'B:warn',
      'C:close',
    ]);
  });
});

describe('renderStalenessWarning', () => {
  it('includes the marker and the remaining days math', () => {
    const body = renderStalenessWarning(
      { issueId: 'AISDLC-1', lastAuthorActivityAt: daysAgo(15) },
      28,
      14,
    );
    expect(body).toContain('<!-- ai-sdlc:dor-stale-warning -->');
    expect(body).toContain('14 days');
    expect(body).toContain('next 14 days');
  });

  it('floors the remaining days at 1 even when warn≈close', () => {
    const body = renderStalenessWarning(
      { issueId: 'AISDLC-1', lastAuthorActivityAt: daysAgo(15) },
      14,
      14,
    );
    expect(body).toContain('next 1 days');
  });
});

describe('renderStalenessCloseNote', () => {
  it('embeds the label and the inactivity span', () => {
    const body = renderStalenessCloseNote('closed-as-stale-dor', 42);
    expect(body).toContain('closed-as-stale-dor');
    expect(body).toContain('42 days');
    expect(body).toContain('<!-- ai-sdlc:dor-stale-close -->');
  });
});
