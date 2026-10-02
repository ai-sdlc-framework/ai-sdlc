/**
 * Ordering rules, blocked/ parking, requeue reaper, enqueue and board listing.
 */

import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
  renameSync,
  readdirSync,
  chmodSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getCapability, readCapabilityState } from '@ai-sdlc/reference';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _setMtimeForTest,
  claimNext,
  ensureBoardDirs,
  isOnBoard,
  listBoard,
  patchDoneVerdict,
  readInflightManifest,
  readResumeSignal,
  removeResumeSignal,
  writeDiagnostic,
  writeResumeSignal,
  releaseInflight,
  removeVerdict,
  requeueInflight,
  unblockManifest,
  writeHeartbeat,
  writeManifest,
  writeVerdict,
} from './board.js';
import { enqueueTasks } from './enqueue.js';
import { requeueStaleInflight } from './session-reaper.js';
import type { DispatchManifest } from './types.js';

function mk(taskId: string, extra: Partial<DispatchManifest> = {}): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'any',
    dispatchedAt: '2026-05-20T10:00:00.000Z',
    dispatchedBy: 'test',
    spec: { taskFile: 'x.md', verifyCommands: ['pnpm build'] },
    ...extra,
  };
}

function succeed(board: string, taskId: string): void {
  writeVerdict(board, {
    schemaVersion: 'v1',
    taskId,
    outcome: 'success',
    completedAt: '2026-05-20T11:00:00.000Z',
    workerId: 'w',
  });
}

let board: string;
beforeEach(() => {
  board = path.join(mkdtempSync(path.join(tmpdir(), 'board-order-')), 'dispatch');
  ensureBoardDirs(board);
});
afterEach(() => rmSync(path.dirname(board), { recursive: true, force: true }));

describe('claim rules', () => {
  it('holds a manifest until every after id has a success verdict in done/', () => {
    writeManifest(board, mk('T-2', { after: ['T-1'] }));
    expect(claimNext(board, 'in-session-agent').claimed).toBe(false);
    succeed(board, 'T-1');
    const r = claimNext(board, 'in-session-agent');
    expect(r.claimed && r.manifest?.taskId).toBe('T-2');
  });

  it('does not treat an iterate-needed verdict as finished', () => {
    writeManifest(board, mk('T-2', { after: ['T-1'] }));
    writeVerdict(board, {
      schemaVersion: 'v1',
      taskId: 'T-1',
      outcome: 'iterate-needed',
      completedAt: '2026-05-20T11:00:00.000Z',
      workerId: 'w',
    });
    expect(claimNext(board, 'in-session-agent').claimed).toBe(false);
  });

  it('never runs two manifests of one sequence group together', () => {
    writeManifest(board, mk('T-1', { sequenceGroup: 'g' }));
    writeManifest(board, mk('T-2', { sequenceGroup: 'g' }));
    const first = claimNext(board, 'in-session-agent');
    expect(first.claimed).toBe(true);
    expect(claimNext(board, 'in-session-agent').claimed).toBe(false);
    succeed(board, 'T-1');
    const second = claimNext(board, 'in-session-agent');
    expect(second.claimed && second.manifest?.taskId).toBe('T-2');
  });

  it('frees the group when the first manifest fails', () => {
    writeManifest(board, mk('T-1', { sequenceGroup: 'g' }));
    writeManifest(board, mk('T-2', { sequenceGroup: 'g' }));
    claimNext(board, 'in-session-agent');
    writeVerdict(board, {
      schemaVersion: 'v1',
      taskId: 'T-1',
      outcome: 'failed',
      completedAt: '2026-05-20T11:00:00.000Z',
      workerId: 'w',
    });
    expect(claimNext(board, 'in-session-agent').claimed).toBe(true);
  });

  it('claims by wave, then priority (lower first, absent last), then enqueue time', () => {
    const specs: [string, Partial<DispatchManifest>, number][] = [
      ['T-1', { wave: 2 }, 1],
      ['T-2', { wave: 1, priority: 3 }, 2],
      ['T-3', { wave: 1, priority: 2 }, 3],
      ['T-4', { wave: 1, priority: 2 }, 4],
      ['T-5', {}, 5],
      ['T-6', { wave: 1, priority: 1 }, 6],
      ['T-7', { wave: 1 }, 7],
      ['T-8', { wave: 2, priority: 1 }, 8],
      ['T-9', { priority: 2 }, 9],
    ];
    for (const [id, extra, t] of specs) {
      const p = writeManifest(board, mk(id, extra));
      _setMtimeForTest(p, 1_000_000 + t * 1000);
    }
    const order: (string | undefined)[] = [];
    for (;;) {
      const r = claimNext(board, 'in-session-agent');
      if (!r.claimed) break;
      order.push(r.manifest?.taskId ?? '');
    }
    // wave 0: T-9 (priority 2) before T-5 (none); wave 1: priority 1, the 2 tie by age, 3, then none;
    // wave 2: priority 1 before none.
    expect(order).toEqual(['T-9', 'T-5', 'T-6', 'T-3', 'T-4', 'T-2', 'T-7', 'T-8', 'T-1']);
  });

  it('treats a malformed priority as absent so the order stays total', () => {
    for (const [id, raw, t] of [
      ['T-1', '"abc"', 1],
      ['T-2', '2', 2],
      ['T-3', 'null', 3],
      ['T-4', '1', 4],
    ] as [string, string, number][]) {
      const file = path.join(board, 'queue', `${id}.dispatch.json`);
      writeFileSync(file, JSON.stringify(mk(id)).replace(/}$/, `,"priority":${raw}}`));
      _setMtimeForTest(file, 1_000_000 + t * 1000);
    }
    const order: string[] = [];
    for (;;) {
      const r = claimNext(board, 'in-session-agent');
      if (!r.claimed) break;
      order.push(r.manifest?.taskId ?? '');
    }
    expect(order).toEqual(['T-4', 'T-2', 'T-1', 'T-3']);
  });

  it('lists the queue in the same order it is claimed', () => {
    for (const [id, extra, t] of [
      ['T-1', {}, 1],
      ['T-2', { priority: 3 }, 2],
      ['T-3', { priority: 1 }, 3],
    ] as [string, Partial<DispatchManifest>, number][]) {
      _setMtimeForTest(writeManifest(board, mk(id, extra)), 1_000_000 + t * 1000);
    }
    expect(listBoard(board).map((e) => e.taskId)).toEqual(['T-3', 'T-2', 'T-1']);
  });

  it('skips a blockedBy manifest and ignores blocked/, until unblocked', () => {
    writeManifest(board, mk('T-1', { blockedBy: 'DEC-1' }));
    writeFileSync(
      path.join(board, 'blocked', 'T-2.dispatch.json'),
      JSON.stringify(mk('T-2', { blockedBy: 'DEC-2' })),
    );
    expect(claimNext(board, 'in-session-agent').claimed).toBe(false);
    expect(unblockManifest(board, 'T-2')).toBe(true);
    const r = claimNext(board, 'in-session-agent');
    expect(r.claimed && r.manifest?.taskId).toBe('T-2');
    expect(r.claimed && r.manifest?.blockedBy).toBeUndefined();
    expect(unblockManifest(board, 'T-9')).toBe(false);
  });

  it('refuses to unblock into an occupied queue slot', () => {
    writeFileSync(path.join(board, 'blocked', 'T-2.dispatch.json'), JSON.stringify(mk('T-2')));
    writeManifest(board, mk('T-2'));
    expect(() => unblockManifest(board, 'T-2')).toThrow(/already exists/);
  });
});

describe('listBoard', () => {
  it('reports state, eligibility and the holding rule', () => {
    writeManifest(board, mk('T-1', { sequenceGroup: 'g' }));
    claimNext(board, 'in-session-agent');
    writeManifest(board, mk('T-2', { sequenceGroup: 'g' }));
    writeManifest(board, mk('T-3', { after: ['T-9'] }));
    writeManifest(board, mk('T-4', { blockedBy: 'DEC-1' }));
    writeManifest(board, mk('T-5', { noClaimBefore: '2999-01-01T00:00:00.000Z', wave: 1 }));
    writeManifest(board, mk('T-6'));
    writeFileSync(
      path.join(board, 'blocked', 'T-7.dispatch.json'),
      JSON.stringify(mk('T-7', { blockedBy: 'DEC-7' })),
    );
    succeed(board, 'T-8');
    writeFileSync(path.join(board, 'failed', 'T-10.diagnostic.json'), '{}');
    const by = Object.fromEntries(listBoard(board).map((e) => [e.taskId, e]));
    expect(by['T-1']?.state).toBe('inflight');
    expect(by['T-2']?.reason).toContain("sequence group 'g' is busy");
    expect(by['T-3']?.reason).toContain('task T-9 is not on the board');
    expect(by['T-4']?.reason).toContain('DEC-1');
    expect(by['T-5']?.reason).toContain('cool-down');
    expect(by['T-6']).toMatchObject({ state: 'queue', eligible: true });
    expect(by['T-7']).toMatchObject({ state: 'blocked', reason: 'blocked by decision DEC-7' });
    expect(by['T-8']?.state).toBe('done');
    expect(by['T-10']?.state).toBe('failed');
    expect(listBoard(board)[0]?.taskId).toBe('T-6');
  });
});

describe('requeueStaleInflight', () => {
  const now = () => new Date('2026-05-20T12:00:00.000Z');
  const heartbeat = (id: string, iso: string, workerId = 'w1') =>
    writeHeartbeat(board, {
      schemaVersion: 'v1',
      taskId: id,
      workerId,
      workerKind: 'in-session-agent',
      lastHeartbeat: iso,
      startedAt: iso,
    } as never);

  it('requeues a stale manifest with the retry count incremented', () => {
    writeManifest(board, mk('T-1'));
    claimNext(board, 'in-session-agent');
    heartbeat('T-1', '2026-05-20T10:00:00.000Z');
    const r = requeueStaleInflight(board, { now });
    expect(r.requeued).toEqual([expect.objectContaining({ taskId: 'T-1', retryCount: 1 })]);
    expect(existsSync(path.join(board, 'queue', 'T-1.dispatch.json'))).toBe(true);
    expect(existsSync(path.join(board, 'inflight', 'T-1.state.json'))).toBe(false);
  });

  it('fails a manifest past the retry limit', () => {
    writeManifest(board, mk('T-1', { retryCount: 2 }));
    const claim = claimNext(board, 'in-session-agent');
    _setMtimeForTest(claim.manifestPath ?? '', now().getTime() - 3_600_000);
    const r = requeueStaleInflight(board, { now, retryLimit: 2 });
    expect(r.failed).toEqual([expect.objectContaining({ taskId: 'T-1', retryCount: 3 })]);
    expect(existsSync(path.join(board, 'failed', 'T-1.diagnostic.json'))).toBe(true);
    expect(readInflightManifest(board, 'T-1')).toBeUndefined();
  });

  it('measures a claim with no heartbeat from the claim, not from enqueue', () => {
    writeManifest(board, mk('T-1', { dispatchedAt: '2020-01-01T00:00:00.000Z' }));
    claimNext(board, 'in-session-agent');
    const justClaimed = requeueStaleInflight(board, { now: () => new Date() });
    expect(justClaimed.requeued).toHaveLength(0);
    expect(readInflightManifest(board, 'T-1')).toBeDefined();
  });

  it('puts a requeued task back at its enqueue position, not its claim time', () => {
    const enqueued = Date.parse('2026-05-20T09:00:00.000Z');
    writeManifest(board, mk('T-1', { dispatchedAt: new Date(enqueued).toISOString() }));
    writeManifest(board, mk('T-2'));
    const t1 = path.join(board, 'queue', 'T-1.dispatch.json');
    _setMtimeForTest(t1, enqueued);
    _setMtimeForTest(path.join(board, 'queue', 'T-2.dispatch.json'), enqueued + 60_000);
    const claim = claimNext(board, 'in-session-agent');
    expect(claim.manifest?.taskId).toBe('T-1');
    _setMtimeForTest(claim.manifestPath ?? '', now().getTime() - 3_600_000);
    expect(requeueStaleInflight(board, { now, staleMs: 1000 }).requeued).toHaveLength(1);
    const queueFile = path.join(board, 'queue', 'T-1.dispatch.json');
    expect(statSync(queueFile).mtimeMs).toBe(enqueued);
    expect(readdirSync(path.join(board, 'queue')).sort()).toEqual([
      'T-1.dispatch.json',
      'T-2.dispatch.json',
    ]);
    expect(readdirSync(path.join(board, 'inflight'))).toEqual([]);
    expect(claimNext(board, 'in-session-agent').manifest?.taskId).toBe('T-1');
  });

  it('leaves a re-claimed task and its state files alone when the claim changed mid-requeue', () => {
    writeManifest(board, mk('T-1'));
    claimNext(board, 'in-session-agent');
    const inflight = path.join(board, 'inflight', 'T-1.dispatch.json');
    const state = path.join(board, 'inflight', 'T-1.state.json');
    const resume = path.join(board, 'inflight', 'T-1.resume.json');
    const swapped = requeueInflight(board, 'T-1', 1, {
      afterRead: () => {
        // A second reaper requeued the task and a Worker claimed it afresh.
        rmSync(inflight);
        writeFileSync(inflight, JSON.stringify(mk('T-1', { workerId: 'fresh' })));
        writeFileSync(state, '{"fresh":true}');
        writeFileSync(resume, '{"fresh":true}');
      },
    });
    expect(swapped).toBe(false);
    expect(readFileSync(state, 'utf-8')).toBe('{"fresh":true}');
    expect(readFileSync(resume, 'utf-8')).toBe('{"fresh":true}');
    expect(readInflightManifest(board, 'T-1')?.workerId).toBe('fresh');
    expect(readInflightManifest(board, 'T-1')?.retryCount).toBeUndefined();
    expect(existsSync(path.join(board, 'queue', 'T-1.dispatch.json'))).toBe(false);
  });

  it('returns false when the inflight manifest vanishes before the requeue', () => {
    writeManifest(board, mk('T-1'));
    claimNext(board, 'in-session-agent');
    expect(
      requeueInflight(board, 'T-1', 1, {
        afterRead: () => rmSync(path.join(board, 'inflight', 'T-1.dispatch.json')),
      }),
    ).toBe(false);
  });

  it('falls back to the observed mtime when dispatchedAt is not a date', () => {
    writeManifest(board, mk('T-1', { dispatchedAt: 'not-a-date' }));
    const claim = claimNext(board, 'in-session-agent');
    _setMtimeForTest(claim.manifestPath ?? '', 5_000_000);
    expect(requeueInflight(board, 'T-1', 1)).toBe(true);
    expect(statSync(path.join(board, 'queue', 'T-1.dispatch.json')).mtimeMs).toBe(5_000_000);
  });

  it('returns a claim to the queue at its enqueue time when recording the worker fails', () => {
    const enqueued = Date.parse('2026-05-20T09:00:00.000Z');
    writeManifest(board, mk('T-1', { dispatchedAt: new Date(enqueued).toISOString() }));
    expect(() =>
      claimNext(board, 'in-session-agent', undefined, {
        // Serialising the worker record throws, after the claim rename succeeded.
        workerId: {
          toJSON() {
            throw new Error('cannot serialise');
          },
        } as unknown as string,
      }),
    ).toThrow(/cannot serialise/);
    const queued = path.join(board, 'queue', 'T-1.dispatch.json');
    expect(existsSync(queued)).toBe(true);
    expect(statSync(queued).mtimeMs).toBe(enqueued);
    expect(readdirSync(path.join(board, 'inflight'))).toEqual([]);
  });

  it('stamps the claim time so an old queued task is not reaped at once', () => {
    writeManifest(board, mk('T-1'));
    const queued = path.join(board, 'queue', 'T-1.dispatch.json');
    _setMtimeForTest(queued, Date.now() - 7 * 24 * 3_600_000);
    const claim = claimNext(board, 'in-session-agent');
    expect(Date.now() - statSync(claim.manifestPath ?? '').mtimeMs).toBeLessThan(60_000);
  });

  it('leaves a live manifest alone', () => {
    writeManifest(board, mk('T-1'));
    claimNext(board, 'in-session-agent');
    heartbeat('T-1', '2026-05-20T11:59:00.000Z');
    const r = requeueStaleInflight(board, { now });
    expect(r.requeued).toHaveLength(0);
    expect(r.failed).toHaveLength(0);
  });

  it('requeues when the claiming session is absent from the roster', () => {
    writeManifest(board, mk('T-1'));
    writeManifest(board, mk('T-2'));
    claimNext(board, 'in-session-agent');
    claimNext(board, 'in-session-agent');
    heartbeat('T-1', '2026-05-20T11:59:00.000Z', 'gone');
    heartbeat('T-2', '2026-05-20T11:59:00.000Z', 'alive');
    const r = requeueStaleInflight(board, { now, roster: new Set(['alive']) });
    expect(r.requeued.map((x) => x.taskId)).toEqual(['T-1']);
    expect(r.requeued[0]?.reason).toContain('roster');
  });
});

describe('enqueue', () => {
  const defaults = {
    baseSha: 'abc1234',
    dispatchedBy: 'op',
    resolveTaskFile: (id: string) => `backlog/tasks/${id.toLowerCase()} - x.md`,
  };

  it('writes one manifest per task with the ordering fields', () => {
    enqueueTasks(
      board,
      [
        { taskId: 'T-1', wave: 1 },
        { taskId: 'T-2', after: ['T-1'], sequenceGroup: 'g', priority: 3 },
      ],
      defaults,
    );
    const m = JSON.parse(readFileSync(path.join(board, 'queue', 'T-2.dispatch.json'), 'utf-8'));
    expect(m).toMatchObject({ after: ['T-1'], sequenceGroup: 'g', priority: 3, workerKind: 'any' });
    expect(isOnBoard(board, 'T-1')).toBe(true);
  });

  it('refuses a task already on the board in any state, writing nothing', () => {
    writeFileSync(path.join(board, 'failed', 'T-1.diagnostic.json'), '{}');
    expect(() => enqueueTasks(board, [{ taskId: 'T-2' }, { taskId: 'T-1' }], defaults)).toThrow(
      /T-1 is already on the board/,
    );
    expect(isOnBoard(board, 'T-2')).toBe(false);
  });

  it('refuses duplicates, bad ids and missing task files', () => {
    expect(() => enqueueTasks(board, [{ taskId: 'T-1' }, { taskId: 'T-1' }], defaults)).toThrow(
      /more than once/,
    );
    expect(() => enqueueTasks(board, [{ taskId: 'nope' }], defaults)).toThrow(/valid task id/);
    expect(() => enqueueTasks(board, [{ taskId: 'T-1', after: ['x'] }], defaults)).toThrow(
      /valid task id/,
    );
    expect(() =>
      enqueueTasks(board, [{ taskId: 'T-1' }], { ...defaults, resolveTaskFile: () => undefined }),
    ).toThrow(/no backlog task file/);
  });
});

describe('completion marker', () => {
  it('keeps a finished task recognised after its verdict is removed', () => {
    writeManifest(board, mk('T-1'));
    claimNext(board, 'in-session-agent');
    succeed(board, 'T-1');
    writeManifest(board, mk('T-2', { after: ['T-1'] }));
    removeVerdict(board, 'T-1', 'done');
    expect(isOnBoard(board, 'T-1')).toBe(true);
    const claim = claimNext(board, 'in-session-agent');
    expect(claim.claimed && claim.manifest?.taskId).toBe('T-2');
    expect(() =>
      enqueueTasks(board, [{ taskId: 'T-1' }], {
        baseSha: 'abc',
        dispatchedBy: 't',
        resolveTaskFile: () => 'x.md',
      }),
    ).toThrow(/already on the board/);
  });

  it('does not let a failed or iterate-needed task satisfy after', () => {
    writeManifest(board, mk('T-1'));
    claimNext(board, 'in-session-agent');
    writeVerdict(board, {
      schemaVersion: 'v1',
      taskId: 'T-1',
      outcome: 'iterate-needed',
      completedAt: '2026-05-20T11:00:00.000Z',
      workerId: 'w',
    });
    removeVerdict(board, 'T-1', 'done');
    writeManifest(board, mk('T-2', { after: ['T-1'] }));
    expect(claimNext(board, 'in-session-agent').claimed).toBe(false);

    writeManifest(board, mk('T-3'));
    writeManifest(board, mk('T-4', { after: ['T-3'] }));
    writeVerdict(board, {
      schemaVersion: 'v1',
      taskId: 'T-3',
      outcome: 'failed',
      completedAt: '2026-05-20T11:00:00.000Z',
      workerId: 'w',
    });
    removeVerdict(board, 'T-3', 'failed');
    const held = listBoard(board).find((e) => e.taskId === 'T-4');
    expect(held?.eligible).toBe(false);
  });
});

describe('ineligibility reasons', () => {
  it('tells failed, missing and pending dependencies apart', () => {
    writeVerdictFile('failed', 'T-1');
    writeManifest(board, mk('T-3'));
    writeManifest(board, mk('T-4', { after: ['T-1'] }));
    writeManifest(board, mk('T-5', { after: ['T-2'] }));
    writeManifest(board, mk('T-6', { after: ['T-3'] }));
    const reason = (id: string) => listBoard(board).find((e) => e.taskId === id)?.reason;
    expect(reason('T-4')).toBe('task T-1 failed');
    expect(reason('T-5')).toBe('task T-2 is not on the board');
    expect(reason('T-6')).toBe('waiting for T-3 to finish');
  });

  function writeVerdictFile(sub: 'failed', id: string): void {
    writeFileSync(
      path.join(board, sub, `${id}.verdict.json`),
      JSON.stringify({ schemaVersion: 'v1', taskId: id, outcome: 'failed', workerId: 'w' }),
    );
  }
});

describe('sequence group race', () => {
  it('rolls a claim back when another manifest of the group was claimed in between', () => {
    writeManifest(board, mk('T-1', { sequenceGroup: 'g' }));
    writeManifest(board, mk('T-2', { sequenceGroup: 'g' }));
    const queued = path.join(board, 'queue', 'T-1.dispatch.json');
    const before = statSync(queued).mtimeMs;
    const first = claimNext(board, 'in-session-agent', undefined, {
      groupSettleMs: 0,
      beforeClaimRename: (m) => {
        // A rival Worker claims the other manifest of the group right now.
        if (m.taskId === 'T-1') {
          renameSync(
            path.join(board, 'queue', 'T-2.dispatch.json'),
            path.join(board, 'inflight', 'T-2.dispatch.json'),
          );
        }
      },
    });
    expect(first.claimed).toBe(false);
    expect(readdirSync(path.join(board, 'inflight'))).toEqual(['T-2.dispatch.json']);
    expect(existsSync(queued)).toBe(true);
    expect(statSync(queued).mtimeMs).toBe(before);
  });
});

describe('symmetric group claim tie-break', () => {
  it('lets the lowest task id keep its claim when the rival hands its own back', () => {
    writeManifest(board, mk('T-1', { sequenceGroup: 'g' }));
    writeManifest(board, mk('T-2', { sequenceGroup: 'g' }));
    const result = claimNext(board, 'in-session-agent', undefined, {
      beforeClaimRename: (m) => {
        // The rival claims T-2 at the same moment as we claim T-1.
        if (m.taskId === 'T-1') {
          renameSync(
            path.join(board, 'queue', 'T-2.dispatch.json'),
            path.join(board, 'inflight', 'T-2.dispatch.json'),
          );
        }
      },
      sleep: () => {
        // While we wait, the rival (higher id) sees us and hands its claim back.
        const held = path.join(board, 'inflight', 'T-2.dispatch.json');
        if (existsSync(held)) renameSync(held, path.join(board, 'queue', 'T-2.dispatch.json'));
      },
    });
    expect(result.claimed).toBe(true);
    expect(readdirSync(path.join(board, 'inflight'))).toEqual(['T-1.dispatch.json']);
  });

  it('hands a claim back at once when a rival holds a lower id', () => {
    writeManifest(board, mk('T-1', { sequenceGroup: 'g' }));
    writeManifest(board, mk('T-2', { sequenceGroup: 'g' }));
    let slept = 0;
    const result = claimNext(board, 'in-session-agent', undefined, {
      sleep: () => {
        slept++;
      },
      beforeClaimRename: (m) => {
        if (m.taskId === 'T-1') {
          // T-2 is tried first only if T-1 is ineligible; here the rival holds T-0.
          writeFileSync(
            path.join(board, 'inflight', 'T-0.dispatch.json'),
            JSON.stringify(mk('T-0', { sequenceGroup: 'g' })),
          );
        }
      },
    });
    expect(result.claimed).toBe(false);
    expect(slept).toBe(0);
    expect(existsSync(path.join(board, 'queue', 'T-1.dispatch.json'))).toBe(true);
  });
});

describe('malformed ids', () => {
  it('claimNext skips a queued manifest with a bad id and claims the rest', () => {
    writeManifest(board, mk('T-1'));
    writeFileSync(
      path.join(board, 'queue', 'bad.dispatch.json'),
      JSON.stringify({ ...mk('T-9'), taskId: '../../escape' }),
    );
    const result = claimNext(board, 'in-session-agent');
    expect(result.claimed && result.manifest?.taskId).toBe('T-1');
    expect(existsSync(path.join(board, 'queue', 'bad.dispatch.json'))).toBe(true);
  });

  it('every task-id path helper rejects a traversal id before writing anything', () => {
    ensureBoardDirs(board);
    const evil = '../../escape';
    const verdict = {
      schemaVersion: 'v1',
      taskId: evil,
      outcome: 'success',
      completedAt: '2026-01-01T00:00:00Z',
      workerId: 'w',
    } as const;
    const calls: (() => unknown)[] = [
      () => writeVerdict(board, verdict),
      () => writeVerdict(board, { ...verdict, outcome: 'failed' }),
      () => writeDiagnostic(board, verdict),
      () =>
        writeHeartbeat(board, {
          taskId: evil,
          workerId: 'w',
          workerKind: 'in-session-agent',
          startedAt: 'x',
          lastHeartbeat: 'x',
        }),
      () => writeResumeSignal(board, { taskId: evil } as never),
      () => readResumeSignal(board, evil),
      () => removeResumeSignal(board, evil),
    ];
    for (const call of calls) expect(call).toThrow(/not a valid task id/);
    // These two ignore a malformed id instead of throwing; neither touches disk.
    expect(patchDoneVerdict(board, evil, { signedAt: 'x' })).toBe(false);
    expect(() => removeVerdict(board, evil)).not.toThrow();
    const parent = path.dirname(board);
    expect(readdirSync(parent)).toEqual([path.basename(board)]);
    for (const sub of ['queue', 'inflight', 'done', 'failed']) {
      expect(readdirSync(path.join(board, sub))).toEqual([]);
    }
  });
});

describe('worker identity and hierarchy.board capability', () => {
  let artifacts: string;
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.ARTIFACTS_DIR;
    artifacts = mkdtempSync(path.join(tmpdir(), 'board-artifacts-'));
    process.env.ARTIFACTS_DIR = artifacts;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = prev;
    rmSync(artifacts, { recursive: true, force: true });
  });
  const state = () => readCapabilityState(artifacts).find((r) => r.id === 'hierarchy.board');

  it('records the worker name verbatim on the claimed manifest', () => {
    writeManifest(board, mk('T-1'));
    const result = claimNext(board, 'in-session-agent', undefined, { workerId: 'Executor-beta_2' });
    expect(result.claimed && result.manifest?.workerId).toBe('Executor-beta_2');
    expect(readInflightManifest(board, 'T-1')?.workerId).toBe('Executor-beta_2');
  });

  it('reports live after a claim', () => {
    expect(getCapability('hierarchy.board')).toBeDefined();
    writeManifest(board, mk('T-1'));
    claimNext(board, 'in-session-agent');
    expect(state()?.status).toBe('live');
  });

  it('reports degraded with a reason when the board directory is unreadable', () => {
    const notADir = path.join(artifacts, 'file');
    writeFileSync(notADir, 'x');
    expect(() => claimNext(notADir, 'in-session-agent')).toThrow();
    const row = state();
    expect(row?.status).toBe('degraded');
    expect(row?.lastDegradedReason).toContain('board directory unreadable');
  });

  it('reports degraded with a reason when the claim rename fails', () => {
    writeManifest(board, mk('T-1'));
    const inflight = path.join(board, 'inflight');
    chmodSync(inflight, 0o500);
    try {
      expect(() => claimNext(board, 'in-session-agent')).toThrow();
    } finally {
      chmodSync(inflight, 0o700);
    }
    const row = state();
    expect(row?.status).toBe('degraded');
    expect(row?.lastDegradedReason).toContain('claim rename failed');
  });
});

describe('requeue and unblock keep FIFO position', () => {
  it('requeueInflight restores the enqueue time, clears inflight files and refuses a queue clash', () => {
    writeManifest(board, mk('T-1', { dispatchedAt: new Date(1_000_000).toISOString() }));
    claimNext(board, 'in-session-agent');
    const inflight = path.join(board, 'inflight', 'T-1.dispatch.json');
    _setMtimeForTest(inflight, 1_000_000);
    writeFileSync(path.join(board, 'inflight', 'T-1.state.json'), '{}');
    writeFileSync(path.join(board, 'inflight', 'T-1.resume.json'), '{}');
    expect(requeueInflight(board, 'T-1', 2)).toBe(true);
    expect(readdirSync(path.join(board, 'inflight'))).toEqual([]);
    const queued = path.join(board, 'queue', 'T-1.dispatch.json');
    expect(statSync(queued).mtimeMs).toBe(1_000_000);
    expect(JSON.parse(readFileSync(queued, 'utf-8')).retryCount).toBe(2);

    writeManifest(board, mk('T-2'));
    writeFileSync(path.join(board, 'inflight', 'T-2.dispatch.json'), JSON.stringify(mk('T-2')));
    expect(() => requeueInflight(board, 'T-2', 1)).toThrow(/already exists/);
    expect(releaseInflight(board, 'T-9')).toBe(false);
  });

  it('unblockManifest preserves the parked mtime', () => {
    writeFileSync(
      path.join(board, 'blocked', 'T-1.dispatch.json'),
      JSON.stringify(mk('T-1', { blockedBy: 'D-1' })),
    );
    _setMtimeForTest(path.join(board, 'blocked', 'T-1.dispatch.json'), 2_000_000);
    expect(unblockManifest(board, 'T-1')).toBe(true);
    expect(statSync(path.join(board, 'queue', 'T-1.dispatch.json')).mtimeMs).toBe(2_000_000);
  });
});

describe('task id validation', () => {
  it('rejects path traversal in any path builder', () => {
    expect(() => unblockManifest(board, '../../x')).toThrow(/not a valid task id/);
    expect(() => releaseInflight(board, '../../x')).toThrow(/not a valid task id/);
    expect(() => writeManifest(board, mk('../../x'))).toThrow(/not a valid task id/);
  });
});

describe('legacy manifests', () => {
  it('claim in FIFO order and validate against the schema', () => {
    const schemaPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'spec',
      'schemas',
      'dispatch-manifest.v1.schema.json',
    );
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(
      JSON.parse(readFileSync(schemaPath, 'utf-8')),
    );
    for (const [i, id] of ['T-1', 'T-2', 'T-3'].entries()) {
      const m = mk(id);
      expect(validate(m)).toBe(true);
      const file = writeManifest(board, m);
      _setMtimeForTest(file, (3 - i) * 1_000_000);
    }
    const order: (string | undefined)[] = [];
    for (;;) {
      const r = claimNext(board, 'in-session-agent');
      if (!r.claimed) break;
      order.push(r.manifest?.taskId);
    }
    expect(order).toEqual(['T-3', 'T-2', 'T-1']);
  });
});
