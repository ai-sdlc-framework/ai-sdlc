/**
 * Tests for the RFC-0035 Decision projection (events → materialized Decision).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  makeTimeboxExtendedEvent,
} from './event-log.js';
import {
  filterExpiredDecisions,
  isDecisionTimeboxExpired,
  listDecisions,
  projectAll,
  projectDecision,
  sortDecisionsByTimeboxUrgency,
} from './projection.js';
import { computeTimeboxExpiresAt, parseTimebox } from './timebox.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'decisions-proj-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function openDecision(id: string, summary: string, ts: string): void {
  appendDecisionEvent(
    makeDecisionOpenedEvent({
      decisionId: id,
      source: 'ad-hoc',
      scope: 'workspace',
      summary,
      options: [
        { id: 'opt-a', description: 'A' },
        { id: 'opt-b', description: 'B' },
      ],
      now: new Date(ts),
    }),
    { workDir },
  );
}

describe('projectDecision', () => {
  it('returns null when the id has no decision-opened event', () => {
    expect(projectDecision('DEC-0001', { workDir })).toBeNull();
  });

  it('materializes a Decision from a single decision-opened event', () => {
    openDecision('DEC-0001', 'first decision', '2026-05-15T10:00:00Z');
    const d = projectDecision('DEC-0001', { workDir });
    expect(d).not.toBeNull();
    expect(d!.apiVersion).toBe('ai-sdlc.io/v1alpha1');
    expect(d!.kind).toBe('Decision');
    expect(d!.metadata.id).toBe('DEC-0001');
    expect(d!.metadata.created).toBe('2026-05-15T10:00:00.000Z');
    expect(d!.status.lifecycle).toBe('open');
    expect(d!.spec.options).toHaveLength(2);
    expect(d!.decisionLog).toHaveLength(1);
    expect(d!.decisionLog[0].type).toBe('decision-opened');
  });

  it('appends not-yet-handled forward-compat events into decisionLog without state mutation', () => {
    openDecision('DEC-0001', 'first', '2026-05-15T10:00:00Z');
    // `timebox-fired` is a known event type in the registry but not yet
    // handled by the Phase 2 projection — it should be appended to decisionLog
    // and update metadata.updated without mutating spec/status fields.
    // (Note: `operator-answered` is now handled by Phase 4 logic merged via
    // AISDLC-288/#511, so we use `timebox-fired` as the forward-compat example.)
    appendDecisionEvent(
      {
        eventVersion: 'v1',
        type: 'timebox-fired',
        ts: '2026-05-15T11:00:00.000Z',
        decisionId: 'DEC-0001',
        by: 'framework',
      },
      { workDir },
    );
    const d = projectDecision('DEC-0001', { workDir });
    expect(d!.decisionLog).toHaveLength(2);
    expect(d!.status.lifecycle).toBe('open'); // unchanged by forward-compat path
    expect(d!.metadata.updated).toBe('2026-05-15T11:00:00.000Z');
  });
});

describe('projectAll + listDecisions', () => {
  it('projects every decision in the log', () => {
    openDecision('DEC-0001', 'one', '2026-05-15T10:00:00Z');
    openDecision('DEC-0002', 'two', '2026-05-15T11:00:00Z');
    openDecision('DEC-0003', 'three', '2026-05-15T12:00:00Z');
    const { decisions } = projectAll({ workDir });
    expect(decisions.size).toBe(3);
    expect([...decisions.keys()].sort()).toEqual(['DEC-0001', 'DEC-0002', 'DEC-0003']);
  });

  it('listDecisions returns decisions sorted by created asc', () => {
    openDecision('DEC-0002', 'second-created', '2026-05-15T11:00:00Z');
    openDecision('DEC-0001', 'first-created', '2026-05-15T10:00:00Z');
    const { decisions } = listDecisions({ workDir });
    expect(decisions.map((d) => d.metadata.id)).toEqual(['DEC-0001', 'DEC-0002']);
  });
});

// ── AISDLC-447 timebox folding + sorting + filtering ─────────────────────────

function openTimeboxedDecision(
  id: string,
  summary: string,
  openedAtIso: string,
  timeboxRaw: string,
): void {
  const openedAt = new Date(openedAtIso);
  const parsed = parseTimebox(timeboxRaw);
  appendDecisionEvent(
    makeDecisionOpenedEvent({
      decisionId: id,
      source: 'ad-hoc',
      scope: 'workspace',
      summary,
      options: [{ id: 'opt-a', description: 'A' }],
      timebox: parsed.duration,
      timeboxExpiresAt: computeTimeboxExpiresAt(parsed.durationMs, openedAt),
      now: openedAt,
    }),
    { workDir },
  );
}

describe('AISDLC-447 — decision-opened folds timebox onto spec + status', () => {
  it('persists spec.timebox + status.timeboxExpiresAt from the opened event', () => {
    openTimeboxedDecision('DEC-0001', 'urgent', '2026-05-27T12:00:00Z', 'PT4H');
    const d = projectDecision('DEC-0001', { workDir });
    expect(d).not.toBeNull();
    expect(d!.spec.timebox).toBe('PT4H');
    expect(d!.status.timeboxExpiresAt).toBe('2026-05-27T16:00:00.000Z');
  });

  it('decisions without timebox have neither field set', () => {
    openDecision('DEC-0001', 'no timebox', '2026-05-27T12:00:00Z');
    const d = projectDecision('DEC-0001', { workDir });
    expect(d!.spec.timebox).toBeUndefined();
    expect(d!.status.timeboxExpiresAt).toBeUndefined();
  });
});

describe('AISDLC-447 — timebox-extended event folding', () => {
  it('updates status.timeboxExpiresAt + spec.timebox to the new values', () => {
    openTimeboxedDecision('DEC-0001', 'extend me', '2026-05-27T12:00:00Z', 'PT4H');
    const before = projectDecision('DEC-0001', { workDir })!;
    expect(before.status.timeboxExpiresAt).toBe('2026-05-27T16:00:00.000Z');

    const extendAt = new Date('2026-05-27T15:00:00Z');
    const newParsed = parseTimebox('P1D');
    const newExp = computeTimeboxExpiresAt(newParsed.durationMs, extendAt);
    appendDecisionEvent(
      makeTimeboxExtendedEvent({
        decisionId: 'DEC-0001',
        newTimebox: newParsed.duration,
        newTimeboxExpiresAt: newExp,
        previousTimeboxExpiresAt: before.status.timeboxExpiresAt ?? null,
        rationale: 'operator pulled it back',
        by: 'op@example.com',
        now: extendAt,
      }),
      { workDir },
    );

    const after = projectDecision('DEC-0001', { workDir })!;
    expect(after.spec.timebox).toBe('P1D');
    expect(after.status.timeboxExpiresAt).toBe(newExp);
    // The event landed in decisionLog for audit.
    const types = after.decisionLog.map((e) => e.type);
    expect(types).toContain('timebox-extended');
  });

  it('allows extending a decision that had no prior timebox (previous=null)', () => {
    openDecision('DEC-0001', 'no timebox initially', '2026-05-27T12:00:00Z');
    const extendAt = new Date('2026-05-27T15:00:00Z');
    const parsed = parseTimebox('PT4H');
    const newExp = computeTimeboxExpiresAt(parsed.durationMs, extendAt);
    appendDecisionEvent(
      makeTimeboxExtendedEvent({
        decisionId: 'DEC-0001',
        newTimebox: parsed.duration,
        newTimeboxExpiresAt: newExp,
        previousTimeboxExpiresAt: null,
        now: extendAt,
      }),
      { workDir },
    );
    const after = projectDecision('DEC-0001', { workDir })!;
    expect(after.spec.timebox).toBe('PT4H');
    expect(after.status.timeboxExpiresAt).toBe(newExp);
  });
});

describe('AISDLC-447 — sortDecisionsByTimeboxUrgency', () => {
  it('orders timeboxed decisions by earliest expiry, untimeboxed last', () => {
    openTimeboxedDecision('DEC-0001', 'long', '2026-05-27T12:00:00Z', 'P7D');
    openDecision('DEC-0002', 'no timebox', '2026-05-27T12:01:00Z');
    openTimeboxedDecision('DEC-0003', 'urgent', '2026-05-27T12:02:00Z', 'PT4H');
    openTimeboxedDecision('DEC-0004', 'medium', '2026-05-27T12:03:00Z', 'P1D');

    const { decisions } = listDecisions({ workDir });
    const sorted = sortDecisionsByTimeboxUrgency(decisions);
    expect(sorted.map((d) => d.metadata.id)).toEqual([
      'DEC-0003', // PT4H → soonest expiry
      'DEC-0004', // P1D
      'DEC-0001', // P7D
      'DEC-0002', // no timebox → last
    ]);
  });

  it('breaks ties on equal expiry by creation order', () => {
    openTimeboxedDecision('DEC-0002', 'b', '2026-05-27T13:00:00Z', 'PT4H');
    openTimeboxedDecision('DEC-0001', 'a', '2026-05-27T12:00:00Z', 'PT5H');
    // DEC-0002 opens 1h later but with PT4H, DEC-0001 opens earlier with PT5H — both expire at 17:00.
    const { decisions } = listDecisions({ workDir });
    const sorted = sortDecisionsByTimeboxUrgency(decisions);
    // Equal expiry → creation-asc tiebreak.
    expect(sorted.map((d) => d.metadata.id)).toEqual(['DEC-0001', 'DEC-0002']);
  });

  it('does not mutate the input array', () => {
    openTimeboxedDecision('DEC-0001', 'a', '2026-05-27T12:00:00Z', 'P1D');
    openTimeboxedDecision('DEC-0002', 'b', '2026-05-27T12:00:00Z', 'PT4H');
    const { decisions } = listDecisions({ workDir });
    const before = decisions.map((d) => d.metadata.id);
    sortDecisionsByTimeboxUrgency(decisions);
    expect(decisions.map((d) => d.metadata.id)).toEqual(before);
  });
});

describe('AISDLC-447 — isDecisionTimeboxExpired + filterExpiredDecisions', () => {
  it('returns true when timebox is in the past', () => {
    openTimeboxedDecision('DEC-0001', 'expired', '2026-05-27T08:00:00Z', 'PT2H');
    const d = projectDecision('DEC-0001', { workDir })!;
    expect(isDecisionTimeboxExpired(d, new Date('2026-05-27T15:00:00Z'))).toBe(true);
  });

  it('returns false when timebox is in the future', () => {
    openTimeboxedDecision('DEC-0001', 'fresh', '2026-05-27T12:00:00Z', 'P7D');
    const d = projectDecision('DEC-0001', { workDir })!;
    expect(isDecisionTimeboxExpired(d, new Date('2026-05-27T15:00:00Z'))).toBe(false);
  });

  it('returns false for untimeboxed decisions', () => {
    openDecision('DEC-0001', 'no timebox', '2026-05-27T12:00:00Z');
    const d = projectDecision('DEC-0001', { workDir })!;
    expect(isDecisionTimeboxExpired(d, new Date('2026-05-30T15:00:00Z'))).toBe(false);
  });

  it('filterExpiredDecisions returns only expired AND unresolved', () => {
    openTimeboxedDecision('DEC-0001', 'expired-open', '2026-05-27T08:00:00Z', 'PT2H');
    openTimeboxedDecision('DEC-0002', 'expired-but-answered', '2026-05-27T08:00:00Z', 'PT2H');
    openTimeboxedDecision('DEC-0003', 'fresh', '2026-05-27T12:00:00Z', 'P7D');
    openDecision('DEC-0004', 'no-timebox', '2026-05-27T08:00:00Z');

    // Answer DEC-0002 so it's resolved.
    appendDecisionEvent(
      {
        eventVersion: 'v1',
        type: 'operator-answered',
        ts: '2026-05-27T13:00:00.000Z',
        decisionId: 'DEC-0002',
        chosenOptionId: 'opt-a',
      },
      { workDir },
    );

    const { decisions } = listDecisions({ workDir });
    const expired = filterExpiredDecisions(decisions, new Date('2026-05-27T15:00:00Z'));
    expect(expired.map((d) => d.metadata.id)).toEqual(['DEC-0001']);
  });
});
