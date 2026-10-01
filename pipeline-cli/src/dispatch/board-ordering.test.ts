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
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _setMtimeForTest,
  claimNext,
  ensureBoardDirs,
  isOnBoard,
  listBoard,
  readInflightManifest,
  releaseInflight,
  removeVerdict,
  requeueInflight,
  unblockManifest,
  writeHeartbeat,
  writeManifest,
  writeVerdict,
} from './board.js';
import { enqueueTasks, parseBrief } from './enqueue.js';
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

  it('claims six manifests by wave, then priority, then enqueue time', () => {
    const specs: [string, Partial<DispatchManifest>, number][] = [
      ['T-1', { wave: 2 }, 1],
      ['T-2', { wave: 1, priority: 0 }, 2],
      ['T-3', { wave: 1, priority: 5 }, 3],
      ['T-4', { wave: 1, priority: 5 }, 4],
      ['T-5', {}, 5],
      ['T-6', { wave: 1, priority: 9 }, 6],
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
    // wave 0 first (T-5), then wave 1 by priority desc then age, then wave 2.
    expect(order).toEqual(['T-5', 'T-6', 'T-3', 'T-4', 'T-2', 'T-1']);
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
    claimNext(board, 'in-session-agent');
    const r = requeueStaleInflight(board, { now, retryLimit: 2 });
    expect(r.failed).toEqual([expect.objectContaining({ taskId: 'T-1', retryCount: 3 })]);
    expect(existsSync(path.join(board, 'failed', 'T-1.diagnostic.json'))).toBe(true);
    expect(readInflightManifest(board, 'T-1')).toBeUndefined();
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

describe('parseBrief', () => {
  it('reads a YAML list of ids and mappings', () => {
    const entries = parseBrief(
      ['- T-1', '- task: T-2', '  after: [T-1]', '  group: g', '  priority: 2', '  wave: 1'].join(
        '\n',
      ),
    );
    expect(entries).toEqual([
      { taskId: 'T-1' },
      { taskId: 'T-2', after: ['T-1'], sequenceGroup: 'g', priority: 2, wave: 1 },
    ]);
  });

  it('accepts a tasks key and a single after id', () => {
    expect(parseBrief('tasks:\n  - taskId: T-3\n    after: T-1\n    sequenceGroup: s')).toEqual([
      { taskId: 'T-3', after: ['T-1'], sequenceGroup: 's' },
    ]);
  });

  it('rejects malformed briefs', () => {
    expect(() => parseBrief('a: 1')).toThrow(/YAML list/);
    expect(() => parseBrief('- 5')).toThrow(/task id or a mapping/);
    expect(() => parseBrief('- {after: [T-1]}')).toThrow(/no task id/);
    expect(() => parseBrief('- {task: T-1, wave: x}')).toThrow(/integer/);
    expect(() => parseBrief('- {task: T-1, after: [1]}')).toThrow(/task ids/);
    expect(() => parseBrief('- {task: T-1, group: 3}')).toThrow(/text/);
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

describe('requeue and unblock keep FIFO position', () => {
  it('requeueInflight preserves mtime, clears inflight files and refuses a queue clash', () => {
    writeManifest(board, mk('T-1'));
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
