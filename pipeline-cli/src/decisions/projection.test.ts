/**
 * Tests for the RFC-0035 Decision projection (events → materialized Decision).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendDecisionEvent, makeDecisionOpenedEvent } from './event-log.js';
import { listDecisions, projectAll, projectDecision } from './projection.js';

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
    // `operator-answered` is a known event type in the registry but not yet
    // handled by the Phase 2 projection — it should be appended to decisionLog
    // and update metadata.updated without mutating spec/status fields.
    appendDecisionEvent(
      {
        eventVersion: 'v1',
        type: 'operator-answered',
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
