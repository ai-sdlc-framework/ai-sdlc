import { describe, expect, it } from 'vitest';
import type { DecisionEvent } from './decision-record.js';
import {
  buildOperatorDigest,
  classifyDecision,
  renderOperatorDigestMarkdown,
} from './operator-digest.js';

const opened = (id: string, extra: Record<string, unknown> = {}): DecisionEvent =>
  ({
    eventVersion: 'v1',
    type: 'decision-opened',
    ts: '2026-10-04T00:00:00.000Z',
    decisionId: id,
    source: 'ad-hoc',
    scope: 'workspace',
    summary: `summary ${id}`,
    options: [
      { id: 'opt-a', description: 'first' },
      { id: 'opt-b', description: 'second' },
    ],
    ...extra,
  }) as unknown as DecisionEvent;

const answered = (id: string, ts: string, type = 'operator-answered'): DecisionEvent =>
  ({
    eventVersion: 'v1',
    type,
    ts,
    decisionId: id,
    chosenOptionId: 'opt-b',
    rationale: 'because',
    by: 'planner',
  }) as unknown as DecisionEvent;

const NOW = new Date('2026-10-05T00:00:00.000Z');

describe('classifyDecision', () => {
  it('derives (a) without a timebox and (b) with one', () => {
    expect(classifyDecision(opened('DEC-1') as never)).toBe('a');
    expect(classifyDecision(opened('DEC-2', { timebox: 'P1D' }) as never)).toBe('b');
  });
  it('honours an explicit Class line, including (c)', () => {
    expect(classifyDecision(opened('DEC-3', { body: 'x\nClass: (c)\n' }) as never)).toBe('c');
  });
});

describe('buildOperatorDigest', () => {
  it('lists only decisions answered after the cutoff, with reverse hints', () => {
    const d = buildOperatorDigest(
      [
        opened('DEC-1'),
        answered('DEC-1', '2026-10-04T12:00:00.000Z'),
        opened('DEC-2'),
        answered('DEC-2', '2026-10-01T12:00:00.000Z'),
      ],
      '2026-10-03T00:00:00.000Z',
      NOW,
    );
    expect(d.answered.map((a) => a.decisionId)).toEqual(['DEC-1']);
    expect(d.answered[0]!.reverse).toContain('cli-decisions answer DEC-1 opt-a');
  });

  it('marks auto-expired answers and lists unexpired timeboxed decisions', () => {
    const d = buildOperatorDigest(
      [
        opened('DEC-1', { timeboxExpiresAt: '2026-10-04T06:00:00.000Z' }),
        answered('DEC-1', '2026-10-04T06:00:01.000Z', 'auto-expired'),
        opened('DEC-2', {
          timeboxExpiresAt: '2026-10-05T10:00:00.000Z',
          autonomousFallbackOptionId: 'opt-a',
        }),
        opened('DEC-3', { timeboxExpiresAt: '2026-10-04T10:00:00.000Z' }),
      ],
      '2026-10-03T00:00:00.000Z',
      NOW,
    );
    expect(d.answered[0]!.answeredBy).toBe('auto-expired');
    expect(d.pending.map((p) => p.decisionId)).toEqual(['DEC-2']);
    expect(renderOperatorDigestMarkdown(d)).toContain('applies `opt-a` in about 10h');
  });

  it('extends a window via timebox-extended', () => {
    const d = buildOperatorDigest(
      [
        opened('DEC-1', { timeboxExpiresAt: '2026-10-04T10:00:00.000Z' }),
        {
          eventVersion: 'v1',
          type: 'timebox-extended',
          ts: '2026-10-04T09:00:00.000Z',
          decisionId: 'DEC-1',
          newTimebox: 'P2D',
          newTimeboxExpiresAt: '2026-10-06T00:00:00.000Z',
          previousTimeboxExpiresAt: '2026-10-04T10:00:00.000Z',
        } as unknown as DecisionEvent,
      ],
      '2026-10-03T00:00:00.000Z',
      NOW,
    );
    expect(d.pending).toHaveLength(1);
  });

  it('renders empty sections', () => {
    const md = renderOperatorDigestMarkdown(buildOperatorDigest([], '2026-10-03T00:00:00Z', NOW));
    expect(md).toContain('## Decided (0)');
    expect(md).toContain('None.');
  });
});
