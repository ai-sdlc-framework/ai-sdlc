import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promoteExpiredDecisions, type ChainDeps } from './escalation-chain.js';
import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
} from './event-log.js';
import type { RosterEntry } from '../hierarchy/types.js';

const OPENED = new Date('2026-10-07T00:00:00.000Z');
const LATER = new Date('2026-10-29T07:00:00.000Z');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'promote-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function chain(sent: string[]): () => ChainDeps {
  return () => ({
    boardDir: '/nonexistent-board',
    identity: { readSessions: () => [], parentPid: () => null, comm: () => '', startPid: 1 },
    sessions: () => [{ role: 'planner', name: 'planner', status: 'running' } as RosterEntry],
    send: (e, m) => {
      sent.push(`${e.name}: ${m}`);
    },
    emit: () => {},
  });
}

function open(route: 'operational' | 'design'): void {
  appendDecisionEvent(
    makeDecisionOpenedEvent({
      decisionId: 'DEC-0003',
      source: 'subagent-escalation',
      scope: 'task:T-1',
      summary: 's',
      options: [{ id: 'exempt', description: 'e' }],
      escalation: { route, taskId: 'T-1', parked: false },
      now: OPENED,
    }),
    { workDir: dir },
  );
}

describe('promoteExpiredDecisions notices', () => {
  it('sends no notice for a decision whose log shows it answered', () => {
    open('operational');
    appendDecisionEvent(
      makeOperatorAnsweredEvent({
        decisionId: 'DEC-0003',
        chosenOptionId: 'exempt',
        now: new Date('2026-10-07T01:00:00.000Z'),
      }),
      { workDir: dir },
    );
    const sent: string[] = [];
    const out = promoteExpiredDecisions(chain(sent), { workDir: dir, now: LATER });
    expect(out).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('announces a due open decision once and nothing on the next tick', () => {
    open('operational');
    const sent: string[] = [];
    const first = promoteExpiredDecisions(chain(sent), { workDir: dir, now: LATER });
    expect(first).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('DEC-0003 (design) needs an answer');
    const second = promoteExpiredDecisions(chain(sent), {
      workDir: dir,
      now: new Date(LATER.getTime() + 60_000),
    });
    expect(second).toEqual([]);
    expect(sent).toHaveLength(1);
  });
});
