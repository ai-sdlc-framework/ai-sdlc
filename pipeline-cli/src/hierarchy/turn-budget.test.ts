/**
 * The turns-per-tick budget review (AISDLC-667.1): one Decision per overrun, at
 * most one open at a time, naming the costliest step. Injected collaborators.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendDecisionEvent, makeOperatorAnsweredEvent } from '../decisions/event-log.js';
import { listDecisions } from '../decisions/projection.js';
import type { TickTurns } from '../usage/dispatch-turns.js';
import {
  fileTurnBudgetDecision,
  hasOpenTurnBudgetDecision,
  loadDispatchTicks,
  reviewTurnBudget,
  TURN_BUDGET_DECISION_SCOPE,
  type TurnBudgetDecisionInput,
} from './turn-budget.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const ticks = (n: number, turns: number, byStep: Record<string, number>): TickTurns[] =>
  Array.from({ length: n }, (_, i) => ({
    tickId: `t${i}`,
    startedAt: new Date(Date.parse('2026-10-02T10:00:00Z') + i * 1000).toISOString(),
    turns,
    byStep,
  }));

describe('reviewTurnBudget', () => {
  it('files one Decision naming the costliest step on an overrun', async () => {
    const filed: TurnBudgetDecisionInput[] = [];
    const review = await reviewTurnBudget({
      budget: 5,
      ticks: () => ticks(22, 8, { reports: 6, verdicts: 2 }),
      hasOpenDecision: () => false,
      fileDecision: (d) => {
        filed.push(d);
        return 'DEC-0042';
      },
    });
    expect(review).toMatchObject({
      overBudget: true,
      decisionId: 'DEC-0042',
      costliestStep: 'reports',
      median: 8,
    });
    expect(filed).toHaveLength(1);
    expect(filed[0].scope).toBe(TURN_BUDGET_DECISION_SCOPE);
    expect(filed[0].summary).toContain('costliest step: reports');
    expect(filed[0].options.map((o) => o.id)).toEqual(['move-step', 'raise-budget', 'accept']);
  });

  it('files nothing while a Decision is already open', async () => {
    let filed = 0;
    const review = await reviewTurnBudget({
      budget: 5,
      ticks: () => ticks(22, 8, { reports: 8 }),
      hasOpenDecision: () => true,
      fileDecision: () => {
        filed += 1;
        return 'DEC-1';
      },
    });
    expect(filed).toBe(0);
    expect(review).toMatchObject({ overBudget: true });
    expect(review.decisionId).toBeUndefined();
    expect(review.skipped).toContain('already open');
  });

  it('files nothing at or under the budget, or without a full window', async () => {
    const never = () => {
      throw new Error('must not file');
    };
    for (const t of [ticks(22, 5, { a: 5 }), ticks(10, 50, { a: 50 }), []]) {
      const review = await reviewTurnBudget({
        budget: 5,
        ticks: () => t,
        hasOpenDecision: () => false,
        fileDecision: never,
      });
      expect(review.overBudget).toBe(false);
    }
  });
});

describe('the decision catalog', () => {
  let work: string;
  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'turn-budget-'));
  });
  afterEach(() => removeFixtureDir(work));

  const input: TurnBudgetDecisionInput = {
    scope: TURN_BUDGET_DECISION_SCOPE,
    summary: 'over budget',
    body: 'body',
    options: [
      { id: 'move-step', description: 'move' },
      { id: 'accept', description: 'accept' },
    ],
  };

  it('files an open record, reports it open, and stops reporting once it is answered', () => {
    expect(hasOpenTurnBudgetDecision(work)).toBe(false);
    const id = fileTurnBudgetDecision(work, input);
    expect(id).toBe('DEC-0001');
    expect(hasOpenTurnBudgetDecision(work)).toBe(true);
    const [decision] = listDecisions({ workDir: work }).decisions;
    expect(decision.metadata.scope).toBe(TURN_BUDGET_DECISION_SCOPE);
    expect(decision.spec.options.map((o) => o.id)).toEqual(['move-step', 'accept']);

    appendDecisionEvent(makeOperatorAnsweredEvent({ decisionId: id, chosenOptionId: 'accept' }), {
      workDir: work,
    });
    expect(hasOpenTurnBudgetDecision(work)).toBe(false);
    expect(fileTurnBudgetDecision(work, input)).toBe('DEC-0002');
  });
});

describe('loadDispatchTicks', () => {
  it('returns no ticks when no marker was recorded', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'turn-ticks-'));
    try {
      expect(await loadDispatchTicks({ repoRoot: dir, artifactsDir: dir, usageDir: dir })).toEqual(
        [],
      );
    } finally {
      removeFixtureDir(dir);
    }
  });

  it('joins the markers with the ledger calls of the dispatch role', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'turn-ticks-'));
    try {
      const events = path.join(dir, '_orchestrator');
      mkdirSync(events, { recursive: true });
      const start = '2026-10-02T10:00:00.000Z';
      writeFileSync(
        path.join(events, 'events-2026-10-02.jsonl'),
        JSON.stringify({
          ts: start,
          type: 'DispatchTick',
          tickId: 'operator-dispatch@x',
          startedAt: start,
          endedAt: '2026-10-02T10:00:01.000Z',
          steps: [{ name: 'ingest', startedAt: start }],
          nextWakeSec: 30,
        }) + '\n',
      );
      const result = await loadDispatchTicks({
        repoRoot: dir,
        artifactsDir: dir,
        usageDir: path.join(dir, 'usage'),
      });
      expect(result).toEqual([
        { tickId: 'operator-dispatch@x', startedAt: start, turns: 0, byStep: {} },
      ]);
    } finally {
      removeFixtureDir(dir);
    }
  });
});
