import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const OPENED = new Date('2026-10-07T00:00:00.000Z');
const LATER = new Date('2026-10-29T07:00:00.000Z');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'promote-'));
});
afterEach(() => removeFixtureDir(dir));

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

  it('sends no notice when the answer sits in the legacy log and the opening in events/', () => {
    // Regression for AISDLC-1109: the reader returns events.jsonl first, so this answer folded
    // before its decision existed, was dropped, and the decision stayed open and was re-announced.
    open('operational');
    mkdirSync(join(dir, '.ai-sdlc', '_decisions'), { recursive: true });
    appendFileSync(
      join(dir, '.ai-sdlc', '_decisions', 'events.jsonl'),
      JSON.stringify(
        makeOperatorAnsweredEvent({
          decisionId: 'DEC-0003',
          chosenOptionId: 'exempt',
          now: new Date('2026-10-07T01:00:00.000Z'),
        }),
      ) + '\n',
    );
    const sent: string[] = [];
    expect(promoteExpiredDecisions(chain(sent), { workDir: dir, now: LATER })).toEqual([]);
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

describe('promoteExpiredDecisions repeat guard (AISDLC-1343)', () => {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const eventsDir = (): string => join(dir, '.ai-sdlc', '_decisions', 'events');
  const routing = (): string[] =>
    readdirSync(eventsDir()).filter((n) => n.includes('__routing-changed__'));
  function initRepo(): void {
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('commit', '-q', '--allow-empty', '-m', 'base');
  }
  const later = new Date(LATER.getTime() + 60_000);

  it('does not move again when the merged event file is gone and HEAD is stale', () => {
    initRepo();
    open('operational');
    expect(promoteExpiredDecisions(chain([]), { workDir: dir, now: LATER })).toHaveLength(1);
    git('add', '-A');
    git('commit', '-q', '-m', 'event');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('reset', '-q', '--soft', 'HEAD~1');
    git('reset', '-q');
    for (const n of routing()) rmSync(join(eventsDir(), n));
    expect(promoteExpiredDecisions(chain([]), { workDir: dir, now: later })).toEqual([]);
    expect(routing()).toHaveLength(0);
  });

  it('counts a routing-changed event that exists only on the sync branch', () => {
    initRepo();
    open('operational');
    promoteExpiredDecisions(chain([]), { workDir: dir, now: LATER });
    git('add', '-A');
    git('commit', '-q', '-m', 'event');
    git('update-ref', 'refs/remotes/origin/ai-sdlc/decisions-sync', 'HEAD');
    git('reset', '-q', '--soft', 'HEAD~1');
    git('reset', '-q');
    for (const n of routing()) rmSync(join(eventsDir(), n));
    expect(promoteExpiredDecisions(chain([]), { workDir: dir, now: later })).toEqual([]);
  });

  it('still promotes when no remote holds the move', () => {
    initRepo();
    open('operational');
    expect(promoteExpiredDecisions(chain([]), { workDir: dir, now: LATER })).toHaveLength(1);
  });
});
