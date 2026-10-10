import { describe, expect, it } from 'vitest';

import {
  announcePromotion,
  answerRefusal,
  callerOf,
  decisionMessage,
  lookupCaller,
  emitRouted,
  findDueDecisions,
  nextTier,
  notifyRaiser,
  notifyTier,
  oneLine,
  tierEnteredAt,
  tierTimeboxMs,
  type ChainDeps,
} from './escalation-chain.js';
import type { Decision, EscalationTier } from './decision-record.js';
import { validateDecisionEvent } from './decision-record.js';
import { makeRoutingChangedEvent } from './event-log.js';
import type { RosterEntry } from '../hierarchy/types.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

function decision(
  tier: EscalationTier | undefined,
  createdMinutesAgo: number,
  extra: Partial<Decision['status']> = {},
  log: Decision['decisionLog'] = [],
): Decision {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'Decision',
    metadata: {
      id: 'DEC-0001',
      source: 'subagent-escalation',
      scope: 'task:T-1',
      created: minutesAgo(createdMinutesAgo),
      updated: minutesAgo(createdMinutesAgo),
    },
    spec: {
      summary: 's',
      options: [{ id: 'a', description: 'a' }],
      ...(tier ? { escalation: { route: 'operational', taskId: 'T-1', parked: false } } : {}),
    },
    status: { lifecycle: 'open', ...(tier ? { escalationTier: tier } : {}), ...extra },
    decisionLog: log,
  };
}

function entry(name: string, role: RosterEntry['role'], status: RosterEntry['status'] = 'running') {
  return { role, name, status } as RosterEntry;
}

function deps(over: Partial<ChainDeps> = {}): ChainDeps & { sent: string[] } {
  const sent: string[] = [];
  return {
    boardDir: '/nonexistent-board',
    identity: { readSessions: () => [], parentPid: () => null, comm: () => '', startPid: 1 },
    sessions: () => [
      entry('planner', 'planner'),
      entry('operator-dispatch', 'operator-dispatch'),
      entry('executor-alpha', 'executor'),
    ],
    send: (e, m) => {
      sent.push(`${e.name}: ${m}`);
    },
    emit: () => {},
    ...over,
    sent,
  };
}

describe('tiers and timeboxes', () => {
  it('moves up one tier and stops at the operator', () => {
    expect(nextTier('operational')).toBe('design');
    expect(nextTier('design')).toBe('operator');
    expect(nextTier('operator')).toBeUndefined();
  });

  it('defaults to 30 minutes and 4 hours, honours config, ignores bad config', () => {
    expect(tierTimeboxMs('operational')).toBe(30 * 60_000);
    expect(tierTimeboxMs('design')).toBe(240 * 60_000);
    expect(tierTimeboxMs('operator')).toBeUndefined();
    expect(tierTimeboxMs('design', { escalationTimeboxMinutes: { design: 10 } })).toBe(600_000);
    expect(tierTimeboxMs('design', { escalationTimeboxMinutes: { design: -3 } })).toBe(
      240 * 60_000,
    );
  });
});

describe('answerRefusal', () => {
  const dispatch = { name: 'operator-dispatch', role: 'operator-dispatch' };
  const planner = { name: 'planner', role: 'planner' };
  const executor = { name: 'executor-alpha', role: 'executor' };

  it('operational: dispatch or planner', () => {
    expect(answerRefusal('operational', dispatch)).toBeUndefined();
    expect(answerRefusal('operational', planner)).toBeUndefined();
    expect(answerRefusal('operational', executor)).toMatch(/operator-dispatch or planner/);
  });

  it('design: planner only, with the next step named', () => {
    expect(answerRefusal('design', planner)).toBeUndefined();
    expect(answerRefusal('design', dispatch)).toMatch(/Forward it to the planner/);
  });

  it('operator tier: no roster session may answer', () => {
    expect(answerRefusal('operator', planner)).toMatch(/raised to the operator/);
  });

  it('fails closed when identity resolution errored', () => {
    for (const t of ['operational', 'design', 'operator'] as const) {
      expect(answerRefusal(t, null, 'roster unreadable')).toMatch(/could not identify/);
    }
  });

  it('a caller outside the roster is the operator and may answer at any tier', () => {
    for (const t of ['operational', 'design', 'operator'] as const) {
      expect(answerRefusal(t, null)).toBeUndefined();
    }
  });
});

describe('findDueDecisions', () => {
  it('is due once the tier timebox has elapsed, not before', () => {
    expect(findDueDecisions([decision('operational', 29)], NOW)).toEqual([]);
    const due = findDueDecisions([decision('operational', 30)], NOW);
    expect(due).toEqual([
      expect.objectContaining({ fromTier: 'operational', toTier: 'design', timeboxMinutes: 30 }),
    ]);
  });

  it('measures from the last tier move, not from creation', () => {
    const moved = makeRoutingChangedEvent({
      decisionId: 'DEC-0001',
      fromTier: 'operational',
      toTier: 'design',
      now: new Date(minutesAgo(10)),
    });
    const d = decision('design', 600, {}, [moved]);
    expect(tierEnteredAt(d)).toBe(moved.ts);
    expect(findDueDecisions([d], NOW)).toEqual([]);
  });

  it('skips operator tier, answered decisions, decisions without routing and bad timestamps', () => {
    const answered = decision('operational', 999, { lifecycle: 'answered' });
    const bad = decision('operational', 999);
    bad.metadata.created = 'not-a-date';
    expect(
      findDueDecisions([decision('operator', 9999), answered, decision(undefined, 999), bad], NOW),
    ).toEqual([]);
  });
});

describe('notifications are best-effort', () => {
  it('sends one message to the running session that owns the tier', () => {
    const d = deps();
    expect(notifyTier(d, 'design', 'DEC-0042')).toEqual({
      sent: true,
      to: 'planner',
    });
    expect(d.sent).toEqual([
      'planner: Decision DEC-0042 (design) needs an answer. Read it with: cli-decisions show DEC-0042',
    ]);
  });

  it('reports instead of throwing when there is no session, the roster is unreadable or the send fails', () => {
    expect(notifyTier(deps({ sessions: () => [] }), 'design', 'DEC-0001').sent).toBe(false);
    expect(
      notifyTier(
        deps({
          sessions: () => {
            throw new Error('bad roster');
          },
        }),
        'design',
        'DEC-0001',
      ).sent,
    ).toBe(false);
    const failing = deps({
      send: () => {
        throw new Error('window closed');
      },
    });
    expect(notifyTier(failing, 'operational', 'DEC-0001')).toEqual({
      sent: false,
      to: 'operator-dispatch',
      reason: 'window closed',
    });
  });

  it('never messages a session that is not running, and has no session for the operator tier', () => {
    const d = deps({ sessions: () => [entry('planner', 'planner', 'starting')] });
    expect(notifyTier(d, 'design', 'DEC-0001').sent).toBe(false);
    expect(notifyTier(deps(), 'operator', 'DEC-0001')).toMatchObject({ sent: false });
  });

  it('notifies the raiser by roster name, and says why when it cannot', () => {
    const d = deps();
    expect(notifyRaiser(d, 'executor-alpha', 'DEC-0001')).toEqual({
      sent: true,
      to: 'executor-alpha',
    });
    expect(notifyRaiser(d, undefined, 'DEC-0001').sent).toBe(false);
    expect(notifyRaiser(d, 'gone', 'DEC-0001').sent).toBe(false);
  });

  it('a throwing event emitter never fails the command', () => {
    const d = deps({
      emit: () => {
        throw new Error('disk full');
      },
    });
    expect(() =>
      emitRouted(d, { decisionId: 'DEC-1', route: 'design', taskId: 'T-1' }),
    ).not.toThrow();
    const due = findDueDecisions([decision('operational', 60)], NOW)[0]!;
    expect(() => announcePromotion(d, due)).not.toThrow();
  });

  it('never types free text: a message carries only the id, tier and fixed command', () => {
    const d = deps();
    notifyRaiser(d, 'executor-alpha', 'DEC-0042');
    expect(d.sent).toEqual([
      'executor-alpha: Decision DEC-0042 was answered. Read it with: cli-decisions show DEC-0042',
    ]);
    for (const m of d.sent) expect(m).toMatch(/^[A-Za-z0-9 ():.-]+$/);
  });

  it('refuses to announce an id that is not DEC-NNNN', () => {
    const d = deps();
    const r = notifyTier(d, 'design', 'DEC-1; rm -rf /');
    expect(r.sent).toBe(false);
    expect(d.sent).toEqual([]);
    expect(notifyRaiser(d, 'executor-alpha', 'x\ny').sent).toBe(false);
    expect(() => decisionMessage('needs-answer', 'DEC-0001')).toThrow(/tier/);
  });

  it('lookupCaller separates no-roster-ancestor from a resolution error', () => {
    expect(lookupCaller(deps())).toEqual({ caller: null });
    const bad = deps({
      identity: {
        readSessions: () => {
          throw new Error('roster unreadable');
        },
        parentPid: () => null,
        comm: () => '',
        startPid: 5,
      },
    });
    expect(lookupCaller(bad)).toEqual({ caller: null, error: 'roster unreadable' });
  });

  it('callerOf is null when identity resolution throws', () => {
    const d = deps({
      identity: {
        readSessions: () => {
          throw new Error('x');
        },
        parentPid: () => null,
        comm: () => '',
        startPid: 5,
      },
    });
    expect(callerOf(d)).toBeNull();
  });

  it('oneLine strips control characters and truncates', () => {
    expect(oneLine('a\u0007b\r\nc')).toBe('a b c');
    expect(oneLine('x'.repeat(300), 20)).toHaveLength(20);
  });
});

describe('routing-changed validation', () => {
  it('accepts a valid tier move and rejects an unknown tier', () => {
    const ok = makeRoutingChangedEvent({
      decisionId: 'DEC-0001',
      fromTier: 'design',
      toTier: 'operator',
    });
    expect(validateDecisionEvent(ok)).toBeNull();
    expect(validateDecisionEvent({ ...ok, toTier: 'sideways' })).toMatch(/toTier/);
    expect(validateDecisionEvent({ ...ok, fromTier: 'x' })).toMatch(/fromTier/);
  });

  it('validates the escalation block on decision-opened', () => {
    const base = {
      eventVersion: 'v1',
      type: 'decision-opened',
      ts: 'now',
      decisionId: 'DEC-0001',
      source: 'subagent-escalation',
      scope: 's',
      summary: 'x',
      options: [{ id: 'a', description: 'd' }],
    };
    expect(
      validateDecisionEvent({
        ...base,
        escalation: { route: 'design', taskId: 'T-1', parked: false },
      }),
    ).toBeNull();
    expect(
      validateDecisionEvent({
        ...base,
        escalation: { route: 'operator', taskId: 'T-1', parked: false },
      }),
    ).toMatch(/escalation/);
    expect(validateDecisionEvent({ ...base, escalation: { route: 'design' } })).toMatch(
      /escalation/,
    );
  });
});
