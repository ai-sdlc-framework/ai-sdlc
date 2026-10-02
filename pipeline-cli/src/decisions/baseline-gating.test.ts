/**
 * The baseline / judged boundary. The Stage B composite is not monotonic in review
 * (Stage C fires only inside [0.4, 0.7), and either side of the band means less model
 * involvement), so every gate must read the composite computed with NO judged input.
 *
 * The decisions below are built so the judged inputs would cross a band edge, then the
 * tests assert the gating result is identical with and without them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Decision } from './decision-record.js';
import { runBaselineStageA, runStageA, type StageAJudgments } from './stage-a.js';
import {
  runBaselineStageB,
  runStageB,
  runStageBWithJudgment,
  STAGE_B_HIGH_CONFIDENCE_THRESHOLD,
  STAGE_B_LOW_CONFIDENCE_THRESHOLD,
} from './stage-b.js';
import { isStageCAutoApplyEligible, shouldFireStageC } from './stage-c.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'baseline-gating-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const ID = 'DEC-0001';
const DAY = 24 * 60 * 60 * 1000;

function blockTasks(n: number): void {
  const dir = join(tmp, 'backlog', 'tasks');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i += 1) writeFileSync(join(dir, `t-${i}.md`), `blocked on ${ID}\n`);
}

interface Spec {
  summary?: string;
  reversible?: boolean;
  tier?: 'xs' | 's' | 'm' | 'l' | 'xl';
  deadlineDays?: number;
  rfcBody?: boolean;
  depth?: number;
}

function decision(over: Spec = {}): Decision {
  const subDecisions = Array.from({ length: over.depth ?? 0 }, (_, i) => `DEC-9${i}`);
  return {
    metadata: {
      id: ID,
      source: 'ad-hoc',
      scope: 'workspace',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    },
    spec: {
      summary: over.summary ?? 'Settle the matter',
      body: over.rfcBody === false ? undefined : 'Per RFC-0035 the position is stated.',
      options: [
        {
          id: 'opt-a',
          description: 'A',
          consequences: ['x'],
          ...(subDecisions.length ? { subDecisions } : {}),
        },
        { id: 'opt-b', description: 'B', consequences: ['y'] },
      ],
      ...(over.reversible === undefined ? {} : { reversible: over.reversible }),
    },
    status: {
      lifecycle: 'open',
      ...(over.deadlineDays === undefined
        ? {}
        : { deadline: new Date(Date.now() + over.deadlineDays * DAY).toISOString() }),
      ...(over.tier ? { capacity: { tier: over.tier } } : {}),
    },
  } as Decision;
}

function pair(
  d: Decision,
  judgedStageA?: StageAJudgments,
  signals?: { novelty: number; exemplarSimilarity: number },
) {
  return runStageBWithJudgment({
    decision: d,
    stageAInput: { decision: d, openDecisions: [], workDir: tmp },
    ...(judgedStageA ? { judgedStageA } : {}),
    ...(signals ? { signals } : {}),
  });
}

const inBand = (c: number): boolean =>
  c >= STAGE_B_LOW_CONFIDENCE_THRESHOLD && c < STAGE_B_HIGH_CONFIDENCE_THRESHOLD;

const SIGNALS_LOW = { novelty: 0, exemplarSimilarity: 0 };

describe('example 1: judged signals or a judged pillar pull a high-band composite into the band', () => {
  const ex1 = (): Decision =>
    decision({ summary: 'Pick approach with a breaking change', tier: 'm', deadlineDays: 2 });

  it('judged signals: baseline 0.705 stays out of the band, judged 0.683 is inside', () => {
    blockTasks(3);
    const r = pair(ex1(), undefined, SIGNALS_LOW);
    expect(r.gating.compositeScore).toBe(0.705);
    expect(r.judgedCompositeScore).toBe(0.683);
    expect(inBand(r.judgedCompositeScore)).toBe(true);
    expect(shouldFireStageC(r.gating)).toBe(false);
    // Identical with and without the judged signals, field for field.
    expect(r.gating).toEqual(pair(ex1()).gating);
    expect(shouldFireStageC(r.gating)).toBe(shouldFireStageC(pair(ex1()).gating));
  });

  it('a judged extra pillar also lowers the judged composite into the band; the gate does not move', () => {
    blockTasks(3);
    const r = pair(ex1(), { pillars: ['design'] });
    expect(r.gating.compositeScore).toBe(0.705);
    expect(inBand(r.judgedCompositeScore)).toBe(true);
    expect(r.judgedCompositeScore).toBeLessThan(r.gating.compositeScore);
    expect(shouldFireStageC(r.gating)).toBe(false);
    expect(r.gating).toEqual(pair(ex1()).gating);
  });

  it('Stage C does not fire from the judged composite (runStageC skip reason stays high-band)', async () => {
    blockTasks(3);
    const { runStageC } = await import('./stage-c.js');
    const r = pair(ex1(), { pillars: ['design'] }, SIGNALS_LOW);
    const result = await runStageC({ decision: ex1(), stageB: r.gating, workDir: tmp });
    expect(result).toMatchObject({ fired: false, skipReason: 'stage-b-high-band' });
  });
});

describe('example 2: a judged one-way lifts a low-band composite into the band', () => {
  // reversible unset, no phrase-list hit (unknown), one task blocked, tier m, no deadline.
  const ex2 = (): Decision => decision({ tier: 'm', rfcBody: false });

  it('baseline 0.358 is low band; the judged one-way gives 0.411, inside the band', async () => {
    blockTasks(1);
    const r = pair(ex2(), { reversibility: 'one-way' });
    expect(r.gating.compositeScore).toBe(0.358);
    expect(r.judgedCompositeScore).toBe(0.411);
    expect(r.gatingStageA.reversibility).toBe('unknown');
    expect(shouldFireStageC(r.gating)).toBe(false);
    expect(r.gating).toEqual(pair(ex2()).gating);

    const { runStageC } = await import('./stage-c.js');
    const result = await runStageC({ decision: ex2(), stageB: r.gating, workDir: tmp });
    expect(result).toMatchObject({ fired: false, skipReason: 'stage-b-low-band' });
  });

  it('auto-apply eligibility reads only the decision and the Stage C output, not Stage B', () => {
    expect(isStageCAutoApplyEligible.length).toBe(2);
    const stageC = {
      error: undefined,
      llmAnswerEligible: true,
    } as unknown as Parameters<typeof isStageCAutoApplyEligible>[1];
    blockTasks(1);
    const withJudged = pair(ex2(), { reversibility: 'one-way' });
    const without = pair(ex2());
    // The same decision record yields the same eligibility whichever run is consulted.
    expect(isStageCAutoApplyEligible(ex2(), stageC)).toBe(true);
    expect(withJudged.gating).toEqual(without.gating);
  });
});

describe('example 3: the framework route comes from the baseline', () => {
  // reversible, blocked 5, depth 5, overdue, tier xl, RFC body, full consequences.
  const ex3 = (): Decision =>
    decision({ reversible: true, depth: 5, deadlineDays: -1, tier: 'xl' });

  it('baseline 0.745 routes to the framework; the judged run would drop to 0.688 and the operator', () => {
    blockTasks(5);
    const r = pair(ex3(), { pillars: ['design'] }, SIGNALS_LOW);
    expect(r.gating.compositeScore).toBe(0.745);
    expect(r.gating.routing.primaryActor).toBe('framework');
    expect(r.gating.routing.llmEligible).toBe(true);
    expect(r.judgedCompositeScore).toBe(0.688);

    // What an ungated judged run would have routed: confirms the inputs really cross the edge.
    const judgedA = runStageA({
      decision: ex3(),
      openDecisions: [],
      workDir: tmp,
      judged: { pillars: ['design'] },
    });
    const ungated = runStageB({ decision: ex3(), stageA: judgedA, signals: SIGNALS_LOW });
    expect(ungated.routing.primaryActor).not.toBe('framework');

    // The displayed judged result never carries a different route.
    expect(r.judged.routing).toEqual(r.gating.routing);
    expect(r.gating).toEqual(pair(ex3()).gating);
  });

  it('reachability: a judged pillar only ever lowers the composite (keyword pillars are never empty)', () => {
    blockTasks(1);
    const d = decision({ tier: 'm', rfcBody: false });
    const base = runBaselineStageA({ decision: d, openDecisions: [], workDir: tmp });
    expect(base.blastRadius.affectedPillars.length).toBeGreaterThanOrEqual(1);
    const r = pair(d, { pillars: ['design'] });
    expect(r.judgedCompositeScore).toBeLessThan(r.gating.compositeScore);
  });
});

describe('judged composite is for display only', () => {
  it('is exposed next to the baseline, never inside the gating output', () => {
    blockTasks(3);
    const d = decision({
      summary: 'Pick approach with a breaking change',
      tier: 'm',
      deadlineDays: 2,
    });
    const r = pair(d, undefined, SIGNALS_LOW);
    expect(r.judgedCompositeScore).toBe(r.judged.compositeScore);
    expect(r.judgedCompositeScore).not.toBe(r.gating.compositeScore);
    expect(JSON.stringify(r.gating)).not.toContain('judged');
    expect(Object.keys(r.gating)).not.toContain('judgedCompositeScore');
  });

  it('equals the baseline when nothing was judged', () => {
    const r = pair(decision());
    expect(r.judgedCompositeScore).toBe(r.gating.compositeScore);
  });
});

describe('type boundary', () => {
  it('only baseline outputs are accepted by the gates', () => {
    const d = decision();
    const a = runStageA({ decision: d, openDecisions: [], workDir: tmp });
    const plain = runStageB({ decision: d, stageA: a });
    // @ts-expect-error an unbranded Stage B output cannot be handed to a gate
    shouldFireStageC(plain);
    // @ts-expect-error a Stage A that may carry judged input cannot seed the baseline Stage B
    runBaselineStageB({ decision: d, stageA: a });
    const base = runBaselineStageB({
      decision: d,
      stageA: runBaselineStageA({ decision: d, openDecisions: [], workDir: tmp }),
    });
    expect(shouldFireStageC(base)).toBe(inBand(base.compositeScore));
  });
});

describe('runtime strip of judged input carried by a non-literal object', () => {
  it('runBaselineStageA drops a carried `judged`', () => {
    blockTasks(3);
    const d = decision({ summary: 'Pick approach with a breaking change', reversible: true });
    const carrying = {
      decision: d,
      openDecisions: [],
      workDir: tmp,
      judged: { pillars: ['design'], reversibility: 'one-way' },
    };
    const via = runBaselineStageA(carrying as unknown as Parameters<typeof runBaselineStageA>[0]);
    const plain = runBaselineStageA({ decision: d, openDecisions: [], workDir: tmp });
    expect(via).toEqual(plain);
    expect(runStageA(carrying as never)).not.toEqual(plain);
  });

  it('runBaselineStageB drops carried `signals`', () => {
    blockTasks(3);
    const d = decision({
      summary: 'Pick approach with a breaking change',
      tier: 'm',
      deadlineDays: 2,
    });
    const stageA = runBaselineStageA({ decision: d, openDecisions: [], workDir: tmp });
    const carrying = { decision: d, stageA, signals: SIGNALS_LOW };
    const via = runBaselineStageB(carrying as unknown as Parameters<typeof runBaselineStageB>[0]);
    expect(via).toEqual(runBaselineStageB({ decision: d, stageA }));
    expect(runStageB(carrying as never)).not.toEqual(via);
  });

  it('the baseline leg of runStageBWithJudgment ignores a judged input smuggled in stageAInput', () => {
    blockTasks(3);
    const d = decision({
      summary: 'Pick approach with a breaking change',
      tier: 'm',
      deadlineDays: 2,
    });
    const smuggled = {
      decision: d,
      openDecisions: [],
      workDir: tmp,
      judged: { pillars: ['design'] },
    };
    const r = runStageBWithJudgment({
      decision: d,
      stageAInput: smuggled as unknown as Parameters<
        typeof runStageBWithJudgment
      >[0]['stageAInput'],
    });
    expect(r.gatingStageA).toEqual(pair(d).gatingStageA);
    expect(r.gating).toEqual(pair(d).gating);
    expect(r.judgedCompositeScore).toBe(r.gating.compositeScore);
  });
});
