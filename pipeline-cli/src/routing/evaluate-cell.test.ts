import { describe, expect, it } from 'vitest';
import type { ReplayRow } from '../usage/replay-report.js';
import type { ScorecardRow } from '../usage/scorecard.js';
import { deriveUnitWeights, type UnitWeights } from '../usage/units.js';
import {
  NOT_ATTRIBUTABLE_REASON,
  evaluateCell,
  findNoLongerCheaper,
  type CellRef,
  type EvidenceScorecard,
} from './evaluate-cell.js';

const weights: UnitWeights = {
  ...deriveUnitWeights([], '2026-10-01T00:00:00Z'),
  modelMultipliers: { haiku: 0.3, sonnet: 1, opus: 5 },
};

function row(
  role: string,
  model: string,
  taskClass: string,
  tasks: number,
  approved: number | null,
): ScorecardRow {
  return {
    role,
    model,
    taskClass,
    tasks,
    approved,
    firstPassApprovalRate: approved === null ? null : approved / tasks,
  } as unknown as ScorecardRow;
}

const clean = { legacyRecords: 0, unavailableRecords: 0 };
const cell: CellRef = {
  role: 'developer',
  taskClass: 'chore',
  model: 'sonnet',
  candidates: ['haiku'],
};
const card = (
  rows: ScorecardRow[],
  extra: Partial<EvidenceScorecard> = clean,
): EvidenceScorecard => ({
  rows,
  ...extra,
});

describe('evaluateCell developer bar', () => {
  it('qualifies at 30 tasks and 4 points below', () => {
    const rows = [
      row('developer', 'sonnet', 'chore', 100, 80),
      row('developer', 'haiku', 'chore', 50, 38), // 76%: 4 points below
    ];
    const r = evaluateCell(cell, card(rows), { weights, minTasks: 30 });
    expect(r.proposed?.model).toBe('haiku');
    expect(r.candidates[0].reasons).toEqual([]);
  });

  it('qualifies with exactly 30 tasks', () => {
    const rows = [
      row('developer', 'sonnet', 'chore', 30, 30),
      row('developer', 'haiku', 'chore', 30, 29), // 96.67%: 3.3 below
    ];
    expect(evaluateCell(cell, card(rows), { weights }).proposed?.model).toBe('haiku');
  });

  it('does not qualify with 29 tasks', () => {
    const rows = [
      row('developer', 'sonnet', 'chore', 100, 80),
      row('developer', 'haiku', 'chore', 29, 24),
    ];
    const r = evaluateCell(cell, card(rows), { weights });
    expect(r.proposed).toBeUndefined();
    expect(r.candidates[0].reasons.join()).toContain('29 compared tasks, 30 needed');
  });

  it('does not qualify 6 points below', () => {
    const rows = [
      row('developer', 'sonnet', 'chore', 100, 80),
      row('developer', 'haiku', 'chore', 50, 37), // 74%: 6 below
    ];
    const r = evaluateCell(cell, card(rows), { weights });
    expect(r.proposed).toBeUndefined();
    expect(r.candidates[0].reasons.join()).toContain('6.0 points below');
  });

  it('allows exactly 5 points ("no more than")', () => {
    const rows = [
      row('developer', 'sonnet', 'chore', 100, 80),
      row('developer', 'haiku', 'chore', 40, 30), // 75%: exactly 5 below
    ];
    expect(evaluateCell(cell, card(rows), { weights }).proposed?.model).toBe('haiku');
    // 100% vs 95%: classic float trap
    const rows2 = [
      row('developer', 'sonnet', 'chore', 40, 40),
      row('developer', 'haiku', 'chore', 40, 38),
    ];
    expect(evaluateCell(cell, card(rows2), { weights }).proposed?.model).toBe('haiku');
  });

  it('honours custom minTasks and marginPoints', () => {
    const rows = [
      row('developer', 'sonnet', 'chore', 100, 80),
      row('developer', 'haiku', 'chore', 10, 7),
    ];
    expect(
      evaluateCell(cell, card(rows), { weights, minTasks: 10, marginPoints: 10 }).proposed,
    ).toBeDefined();
    expect(
      evaluateCell(cell, card(rows), { weights, minTasks: 10, marginPoints: 9 }).proposed,
    ).toBeUndefined();
  });

  it('does not qualify without tasks for the current model or the candidate', () => {
    const noCurrent = evaluateCell(cell, card([row('developer', 'haiku', 'chore', 40, 40)]), {
      weights,
    });
    expect(noCurrent.candidates[0].reasons.join()).toContain(
      'no tasks on record for the current model',
    );
    const none = evaluateCell(cell, card([]), { weights });
    expect(none.proposed).toBeUndefined();
  });

  it('ignores rows without an approval signal', () => {
    const rows = [
      row('developer', 'sonnet', 'chore', 100, 80),
      row('developer', 'haiku', 'chore', 50, null),
    ];
    expect(evaluateCell(cell, card(rows), { weights }).proposed).toBeUndefined();
  });

  it('aggregates the wildcard cell over classes the role has no explicit cell for', () => {
    const wild: CellRef = {
      role: 'developer',
      taskClass: '*',
      model: 'sonnet',
      candidates: ['haiku'],
      excludeClasses: ['chore'],
    };
    const rows = [
      row('developer', 'sonnet', 'bug', 20, 16),
      row('developer', 'sonnet', 'feature', 20, 16),
      row('developer', 'sonnet', 'chore', 20, 1), // excluded
      row('developer', 'haiku', 'bug', 20, 16),
      row('developer', 'haiku', 'feature', 20, 16),
    ];
    const r = evaluateCell(wild, card(rows), { weights });
    expect(r.proposed?.model).toBe('haiku');
    expect(r.proposed?.comparison).toMatchObject({
      kind: 'developer',
      candidate: { tasks: 40 },
      current: { tasks: 40, approved: 32 },
    });
  });

  it('picks the cheapest qualifying candidate', () => {
    const two: CellRef = { ...cell, model: 'opus', candidates: ['sonnet', 'haiku'] };
    const rows = [
      row('developer', 'opus', 'chore', 50, 45),
      row('developer', 'sonnet', 'chore', 50, 45),
      row('developer', 'haiku', 'chore', 50, 44),
    ];
    const r = evaluateCell(two, card(rows), { weights });
    expect(r.proposed?.model).toBe('haiku');
    expect(r.candidates.filter((c) => c.qualifies)).toHaveLength(2);
  });
});

describe('evaluateCell price rule', () => {
  const rows = [
    row('developer', 'sonnet', 'chore', 100, 80),
    row('developer', 'opus', 'chore', 50, 50),
    row('developer', 'unpriced', 'chore', 50, 50),
  ];

  it('never qualifies a candidate that is not cheaper', () => {
    const up: CellRef = { ...cell, candidates: ['opus'] };
    const r = evaluateCell(up, card(rows), { weights });
    expect(r.proposed).toBeUndefined();
    expect(r.candidates[0].cheaper).toBe(false);
    expect(r.candidates[0].reasons.join()).toContain('not cheaper');
  });

  it('never qualifies an equally priced candidate', () => {
    const eq: UnitWeights = { ...weights, modelMultipliers: { sonnet: 1, haiku: 1 } };
    const rs = [
      row('developer', 'sonnet', 'chore', 50, 40),
      row('developer', 'haiku', 'chore', 50, 40),
    ];
    expect(evaluateCell(cell, card(rs), { weights: eq }).proposed).toBeUndefined();
  });

  it('never qualifies a candidate with no known price', () => {
    const un: CellRef = { ...cell, candidates: ['unpriced'] };
    expect(evaluateCell(un, card(rows), { weights }).proposed).toBeUndefined();
  });
});

describe('evaluateCell attribution gate (fail closed)', () => {
  const good = [
    row('developer', 'sonnet', 'chore', 100, 80),
    row('developer', 'haiku', 'chore', 50, 40),
  ];

  it('qualifies only with both counts present and 0', () => {
    expect(evaluateCell(cell, card(good, clean), { weights }).proposed).toBeDefined();
  });

  it.each([
    ['legacy records', { legacyRecords: 1, unavailableRecords: 0 }],
    ['unavailable records', { legacyRecords: 0, unavailableRecords: 2 }],
    ['both', { legacyRecords: 3, unavailableRecords: 3 }],
    ['missing counts', {}],
    ['legacy count missing', { unavailableRecords: 0 }],
    ['unavailable count missing', { legacyRecords: 0 }],
    ['non-numeric counts', { legacyRecords: '0', unavailableRecords: '0' }],
    ['null counts', { legacyRecords: null, unavailableRecords: null }],
    ['NaN count', { legacyRecords: Number.NaN, unavailableRecords: 0 }],
  ])('never qualifies with %s', (_n, extra) => {
    const r = evaluateCell(cell, card(good, extra), { weights });
    expect(r.proposed).toBeUndefined();
    expect(r.candidates[0].qualifies).toBe(false);
    expect(r.candidates[0].reasons).toContain(NOT_ATTRIBUTABLE_REASON);
  });

  it('applies to reviewer cells too', () => {
    const rev: CellRef = {
      role: 'code-reviewer',
      taskClass: '*',
      model: 'sonnet',
      candidates: ['haiku'],
    };
    const r = evaluateCell(rev, card([], {}), {
      weights,
      replay: [score('r1', 'sonnet'), score('r1', 'haiku')],
    });
    expect(r.candidates[0].reasons).toContain(NOT_ATTRIBUTABLE_REASON);
  });
});

function score(runId: string, model: string, over: Partial<ReplayRow> = {}): ReplayRow {
  return {
    runId,
    model,
    role: 'code',
    reviews: 40,
    errors: 0,
    knownDefect: { items: 20, blocked: 18 },
    clean: { items: 20, blocked: 2 },
    recall: 0.9,
    falseBlockRate: 0.1,
    unitsTotal: 0,
    meanUnitsPerReview: null,
    usageMissing: 0,
    ...over,
  } as ReplayRow;
}

describe('evaluateCell reviewer bar', () => {
  const rev: CellRef = {
    role: 'code-reviewer',
    taskClass: '*',
    model: 'sonnet',
    candidates: ['haiku'],
  };
  const run = (cand: Partial<ReplayRow>, cur: Partial<ReplayRow> = {}, cfg = {}) =>
    evaluateCell(rev, card([]), {
      weights,
      replay: [score('r1', 'sonnet', cur), score('r1', 'haiku', cand)],
      ...cfg,
    });

  it('qualifies when recall and false-block stay within the margin', () => {
    const r = run({ recall: 0.85, falseBlockRate: 0.15 });
    expect(r.proposed?.model).toBe('haiku');
    expect(r.proposed?.comparison).toMatchObject({ kind: 'reviewer', runId: 'r1', items: 40 });
  });

  it('does not qualify when recall is 6 points lower', () => {
    const r = run({ recall: 0.84 });
    expect(r.proposed).toBeUndefined();
    expect(r.candidates[0].reasons.join()).toContain('recall 6.0 points below');
  });

  it('does not qualify when false-block is 6 points higher', () => {
    const r = run({ falseBlockRate: 0.16 });
    expect(r.candidates[0].reasons.join()).toContain('false-block rate 6.0 points above');
  });

  it('needs at least minTasks replay items', () => {
    const r = run({ reviews: 29 });
    expect(r.proposed).toBeUndefined();
    expect(r.candidates[0].reasons.join()).toContain('29 replay items, 30 needed');
    expect(run({ reviews: 30 }).proposed).toBeDefined();
  });

  it('cannot judge a replay with no known-defect or no clean items', () => {
    const r = run({ recall: null });
    expect(r.proposed).toBeUndefined();
    expect(r.candidates[0].reasons.join()).toContain('no known-defect or no clean items');
  });

  it('needs one run that scored both models', () => {
    const r = evaluateCell(rev, card([]), {
      weights,
      replay: [score('r1', 'haiku'), score('r2', 'sonnet')],
    });
    expect(r.candidates[0].reasons.join()).toContain('no replay run scores both models');
    expect(evaluateCell(rev, card([]), { weights }).candidates[0].qualifies).toBe(false);
  });

  it('uses a qualifying run when an earlier one fails', () => {
    const r = evaluateCell(rev, card([]), {
      weights,
      replay: [
        score('r1', 'sonnet'),
        score('r1', 'haiku', { recall: 0.5 }),
        score('r2', 'sonnet'),
        score('r2', 'haiku'),
      ],
    });
    expect(r.proposed?.comparison).toMatchObject({ runId: 'r2' });
  });

  it('ignores replay rows for other roles and non-reviewer role names', () => {
    const r = evaluateCell(rev, card([]), {
      weights,
      replay: [score('r1', 'sonnet', { role: 'test' }), score('r1', 'haiku', { role: 'test' })],
    });
    expect(r.proposed).toBeUndefined();
    const odd: CellRef = { ...rev, role: 'conductor' };
    expect(evaluateCell(odd, card([]), { weights }).proposed).toBeUndefined();
  });
});

describe('security reviewer', () => {
  it('never gets candidates', () => {
    const sec: CellRef = {
      role: 'security-reviewer',
      taskClass: '*',
      model: 'opus',
      candidates: ['sonnet'],
    };
    const r = evaluateCell(sec, card([]), {
      weights,
      replay: [
        score('r1', 'opus', { role: 'security' }),
        score('r1', 'sonnet', { role: 'security' }),
      ],
    });
    expect(r.candidates).toEqual([]);
    expect(r.proposed).toBeUndefined();
  });
});

describe('findNoLongerCheaper', () => {
  it('lists cells whose previous model is now cheaper or equal', () => {
    const out = findNoLongerCheaper(
      [
        { role: 'developer', taskClass: 'chore', model: 'haiku', previousModel: 'sonnet' }, // still cheaper
        {
          role: 'developer',
          taskClass: 'bug',
          model: 'sonnet',
          previousModel: 'haiku',
          evidence: 'e.json',
        },
        { role: 'developer', taskClass: 'feature', model: 'sonnet', previousModel: 'sonnet' },
        { role: 'developer', taskClass: 'x', model: 'sonnet' },
        { role: 'developer', taskClass: 'y', model: 'sonnet', previousModel: 'unpriced' },
      ],
      weights,
    );
    expect(out).toEqual([
      {
        role: 'developer',
        taskClass: 'bug',
        model: 'sonnet',
        previousModel: 'haiku',
        evidence: 'e.json',
      },
      { role: 'developer', taskClass: 'feature', model: 'sonnet', previousModel: 'sonnet' },
    ]);
  });
});

describe('evaluateCell malformed evidence', () => {
  const rcell: CellRef = {
    role: 'code-reviewer',
    taskClass: '*',
    model: 'sonnet',
    candidates: ['haiku'],
  };
  const good = (model: string, over: Record<string, unknown> = {}): ReplayRow =>
    ({
      model,
      role: 'code',
      runId: 'x',
      reviews: 40,
      recall: 0.9,
      falseBlockRate: 0.1,
      ...over,
    }) as unknown as ReplayRow;

  it('does not qualify a reviewer candidate with missing or non-numeric scores', () => {
    for (const bad of [
      { reviews: undefined },
      { recall: undefined },
      { falseBlockRate: undefined },
      { recall: Number.NaN },
      { recall: 1.5 },
      { reviews: 2.5 },
      { reviews: -1 },
      { falseBlockRate: '0.1' },
    ]) {
      const r = evaluateCell(rcell, card([]), {
        weights,
        replay: [good('sonnet'), good('haiku', bad)],
      });
      expect(r.proposed).toBeUndefined();
      expect(r.candidates[0].reasons.join(' ')).toContain('malformed');
    }
    const r = evaluateCell(rcell, card([]), {
      weights,
      replay: [
        { model: 'sonnet', role: 'code', runId: 'x' } as unknown as ReplayRow,
        { model: 'haiku', role: 'code', runId: 'x' } as unknown as ReplayRow,
      ],
    });
    expect(r.proposed).toBeUndefined();
  });

  it('does not qualify developer rows with non-finite counts', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -3]) {
      const rows = [
        row('developer', 'sonnet', 'chore', 100, 80),
        row('developer', 'haiku', 'chore', bad, 40),
      ];
      expect(evaluateCell(cell, card(rows), { weights }).proposed).toBeUndefined();
    }
    const over = [
      row('developer', 'sonnet', 'chore', 100, 80),
      row('developer', 'haiku', 'chore', 40, 99),
    ];
    expect(evaluateCell(cell, card(over), { weights }).proposed).toBeUndefined();
  });

  it('falls back to the default thresholds when given invalid ones', () => {
    const rows = [
      row('developer', 'sonnet', 'chore', 100, 80),
      row('developer', 'haiku', 'chore', 5, 4),
    ];
    for (const minTasks of [Number.NaN, -1]) {
      expect(evaluateCell(cell, card(rows), { weights, minTasks }).proposed).toBeUndefined();
    }
    const margin = [
      row('developer', 'sonnet', 'chore', 100, 100),
      row('developer', 'haiku', 'chore', 100, 10),
    ];
    expect(
      evaluateCell(cell, card(margin), { weights, marginPoints: Number.NaN }).proposed,
    ).toBeUndefined();
  });
});
