/**
 * AISDLC-1156 (DEC-0291): the stuck-PR stall. Regression for #2246 (AISDLC-1136) and #2282 (AISDLC-1153):
 * a signed, reviewed task failed only its push and sat unowned for hours.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  archiveFailedVerdict,
  collectVerdicts,
  writeManifest,
  writeVerdict,
} from '../dispatch/board.js';
import type { DispatchVerdict } from '../dispatch/types.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import {
  checkStuckPrs,
  DEFAULT_STUCK_AFTER_MINUTES,
  DEFAULT_STUCK_TIMEBOX_HOURS,
  formatStuckPr,
  listStuckPrs,
  readOpenStuckPrs,
  resolveStuckAfterMinutes,
  resolveStuckTimeboxHours,
  type StuckPrRecord,
} from './drain-stall.js';
import { runDispatchTick } from './dispatch-loop.js';
import { markPrReady } from './mark-ready.js';
import { listDecisions } from '../decisions/projection.js';
import {
  buildStuckPrDecision,
  fileStuckPrDecision,
  type StuckPrDecisionInput,
} from './stuck-pr-decision.js';
import { formatStatus, hasStuckViolation, type StatusResult } from './status.js';
import type { CommandResult, CommandRunner } from './types.js';

const T0 = Date.parse('2026-11-02T10:00:00Z');
let dir: string;
let nowMs: number;
const now = () => new Date(nowMs);

function failedVerdict(over: Partial<DispatchVerdict> = {}): void {
  writeVerdict(dir, {
    schemaVersion: 'v1',
    taskId: 'AISDLC-1153',
    outcome: 'failed',
    cause: 'push-non-fast-forward',
    completedAt: new Date(T0).toISOString(),
    workerId: 'executor-alpha',
    signedAt: new Date(T0 - 60_000).toISOString(),
    prNumber: 2282,
    commitSha: 'c'.repeat(40),
    ...over,
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'stuck-pr-'));
  nowMs = T0;
});
afterEach(() => removeFixtureDir(dir));

describe('checkStuckPrs', () => {
  it('opens nothing before the threshold, then one stall with PR, head and cause (#2282)', () => {
    failedVerdict();
    expect(checkStuckPrs({ boardDir: dir, now }).opened).toEqual([]);
    nowMs += (DEFAULT_STUCK_AFTER_MINUTES + 1) * 60_000;
    const r = checkStuckPrs({ boardDir: dir, now });
    expect(r.opened).toHaveLength(1);
    expect(r.opened[0]).toMatchObject({
      kind: 'stuck-pr',
      pr: 2282,
      taskId: 'AISDLC-1153',
      headSha: 'c'.repeat(40),
      cause: 'push-non-fast-forward',
    });
    expect(formatStuckPr(r.opened[0]!, 60)).toContain('#2282');
    expect(readOpenStuckPrs(dir)).toHaveLength(1);
    const log = readFileSync(path.join(dir, 'drain-stalls.jsonl'), 'utf-8').trim().split('\n');
    expect(log).toHaveLength(1);
  });

  it('a second open on the same PR and head is a no-op', () => {
    failedVerdict();
    nowMs += 61 * 60_000;
    const decisions: string[] = [];
    const notices: number[] = [];
    const opts = {
      boardDir: dir,
      now,
      fileDecision: (r: StuckPrRecord) => (decisions.push(r.taskId), `DEC-${decisions.length}`),
      notify: (r: StuckPrRecord) => void notices.push(r.pr),
    };
    expect(checkStuckPrs(opts).opened).toHaveLength(1);
    const again = checkStuckPrs(opts);
    expect(again.opened).toEqual([]);
    expect(again.open).toHaveLength(1);
    expect(decisions).toHaveLength(1);
    expect(notices).toEqual([2282]);
    expect(readOpenStuckPrs(dir)[0]).toMatchObject({ decisionId: 'DEC-1' });
    expect(readOpenStuckPrs(dir)[0]?.notifiedAt).toBeDefined();
  });

  it('survives a throwing decision client and notifier', () => {
    failedVerdict();
    nowMs += 61 * 60_000;
    const r = checkStuckPrs({
      boardDir: dir,
      now,
      fileDecision: () => {
        throw new Error('log locked');
      },
      notify: () => {
        throw new Error('no notifier');
      },
    });
    expect(r.opened).toHaveLength(1);
    expect(r.opened[0]?.decisionId).toBeUndefined();
  });

  it('ignores an unsigned failure, a success and a failure with no PR', () => {
    failedVerdict({ signedAt: undefined });
    failedVerdict({ taskId: 'AISDLC-2', prNumber: undefined });
    writeVerdict(dir, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-3',
      outcome: 'success',
      completedAt: new Date(T0).toISOString(),
      workerId: 'w',
      prNumber: 5,
      signedAt: new Date(T0).toISOString(),
    });
    nowMs += 120 * 60_000;
    expect(checkStuckPrs({ boardDir: dir, now }).opened).toEqual([]);
  });

  it('a review record without signedAt also counts', () => {
    failedVerdict({ signedAt: undefined, reviewerCompletedAt: new Date(T0).toISOString() });
    nowMs += 61 * 60_000;
    expect(checkStuckPrs({ boardDir: dir, now }).opened).toHaveLength(1);
  });

  it('closes when the PR is delivered (failed verdict archived, delivered written)', () => {
    failedVerdict();
    nowMs += 61 * 60_000;
    checkStuckPrs({ boardDir: dir, now });
    archiveFailedVerdict(dir, 'AISDLC-1153', now());
    writeVerdict(dir, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-1153',
      outcome: 'success',
      completedAt: now().toISOString(),
      workerId: 'operator-dispatch',
      prNumber: 2282,
      signedAt: new Date(T0).toISOString(),
    });
    const r = checkStuckPrs({ boardDir: dir, now });
    expect(r.closed).toHaveLength(1);
    expect(readOpenStuckPrs(dir)).toEqual([]);
    expect(collectVerdicts(dir).filter((v) => v.outcome === 'failed')).toEqual([]);
  });

  it('closes when the PR landed in a landing record', () => {
    failedVerdict();
    nowMs += 61 * 60_000;
    checkStuckPrs({ boardDir: dir, now });
    mkdirSync(path.join(dir, 'landing'), { recursive: true });
    writeFileSync(
      path.join(dir, 'landing', '2282.json'),
      JSON.stringify({
        pr: 2282,
        kind: 'task',
        owner: 'machine',
        state: 'merged',
        action: 'none',
        headSha: 'c'.repeat(40),
        landed: 'x',
        history: [],
      }),
    );
    expect(checkStuckPrs({ boardDir: dir, now }).closed).toHaveLength(1);
  });

  it('reads the threshold and timebox from config', () => {
    expect(resolveStuckAfterMinutes(dir)).toBe(DEFAULT_STUCK_AFTER_MINUTES);
    expect(resolveStuckTimeboxHours(dir)).toBe(DEFAULT_STUCK_TIMEBOX_HOURS);
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ stuckAfterMinutes: 5, stuckDecisionTimeboxHours: 2 }),
    );
    expect(resolveStuckAfterMinutes(dir)).toBe(5);
    expect(resolveStuckTimeboxHours(dir)).toBe(2);
    writeFileSync(path.join(dir, 'config.json'), '{ not json');
    expect(resolveStuckAfterMinutes(dir)).toBe(DEFAULT_STUCK_AFTER_MINUTES);
  });
});

describe('status stuck section and --check', () => {
  it('lists age and the missing terminal states, and flags a violation past the threshold', () => {
    failedVerdict();
    nowMs += 90 * 60_000;
    const rows = listStuckPrs(dir, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pr: 2282,
      ageMinutes: 90,
      missing: ['repair-or-delivery', 'decision', 'notification'],
    });
    const result = {
      rows: [],
      stuck: rows,
      stuckAfterMinutes: 60,
      webhook: { state: 'down' },
      scheduler: { state: 'down' },
      board: { queued: 0, inflight: 0, done: 0, failed: 1 },
      contextThresholds: {},
      executorCap: {},
    } as unknown as StatusResult;
    expect(hasStuckViolation(result)).toBe(true);
    expect(hasStuckViolation({ ...result, stuckAfterMinutes: 120 })).toBe(false);
    expect(hasStuckViolation({ ...result, stuck: undefined })).toBe(false);
    const text = formatStatus(result, nowMs).join('\n');
    expect(text).toContain('stuck:');
    expect(text.split('PR #2282 (AISDLC-1153)').length - 1).toBe(1);
    expect(text).toContain('PR #2282 (AISDLC-1153): push-non-fast-forward, age 90m');
    expect(text).toContain('missing repair-or-delivery, decision, notification');
  });

  it('drops decision and notification from missing once the stall has them', () => {
    failedVerdict();
    nowMs += 61 * 60_000;
    checkStuckPrs({ boardDir: dir, now, fileDecision: () => 'DEC-9', notify: () => {} });
    expect(listStuckPrs(dir, now)[0]?.missing).toEqual(['repair-or-delivery']);
  });
});

describe('the tick files one timeboxed decision (AC-4)', () => {
  it('records a decision with route operational, a 4 h timebox and the repair as fallback', async () => {
    failedVerdict();
    nowMs += 61 * 60_000;
    const filed: StuckPrDecisionInput[] = [];
    const notices: string[] = [];
    const tickDeps = () => ({
      boardDir: dir,
      workerId: 'operator-dispatch',
      now,
      enqueue: () => [],
      clear: async (o: { executor: string }) => ({ executor: o.executor, ok: true, settleMs: 0 }),
      playbook: (v: DispatchVerdict) => ({
        taskId: v.taskId,
        action: 'escalate' as const,
        result: 'escalated' as const,
        reason: 'n/a',
      }),
      operational: new Set<string>(),
      stuckPr: {
        fileDecision: (r: StuckPrRecord) => {
          filed.push(buildStuckPrDecision(r, DEFAULT_STUCK_TIMEBOX_HOURS));
          return 'DEC-0301';
        },
        notify: (r: StuckPrRecord) => void notices.push(`#${r.pr}`),
      },
    });
    const first = await runDispatchTick(tickDeps());
    expect(first.reports.map((x) => x.text).join('\n')).toContain('stuck-pr: #2282');
    await runDispatchTick(tickDeps());
    expect(filed).toHaveLength(1);
    expect(notices).toEqual(['#2282']);
    expect(filed[0]).toMatchObject({
      route: 'operational',
      timebox: 'PT4H',
      autonomousFallbackOptionId: 'repair',
      taskId: 'AISDLC-1153',
    });
    expect(filed[0]?.body).toContain(
      'cli-hierarchy playbook --task AISDLC-1153 --action rebase-push',
    );
    expect(filed[0]?.options.map((o) => o.id)).toContain('repair');
  });
});

describe('markPrReady', () => {
  const runner = (
    view: Partial<CommandResult> & { json?: unknown },
    readyStatus = 0,
  ): CommandRunner => {
    return (_f, args) => {
      if (args[1] === 'view') {
        return { status: view.status ?? 0, stdout: JSON.stringify(view.json ?? {}), stderr: '' };
      }
      return { status: readyStatus, stdout: '', stderr: '' };
    };
  };
  it('flips a clean draft', () => {
    expect(
      markPrReady(runner({ json: { isDraft: true, mergeStateStatus: 'CLEAN' } }), '/', 5),
    ).toEqual({ ok: true });
  });
  it('is a success for an already-ready PR', () => {
    expect(markPrReady(runner({ json: { isDraft: false } }), '/', 5)).toEqual({ ok: true });
  });
  it('refuses a superseded body, a superseded comment, a DIRTY branch, an unreadable PR and a failed flip', () => {
    expect(
      markPrReady(runner({ json: { isDraft: true, body: 'superseded by #9' } }), '/', 5).ok,
    ).toBe(false);
    expect(
      markPrReady(
        runner({ json: { isDraft: true, comments: [{ body: 'Superseded by #9' }] } }),
        '/',
        5,
      ).ok,
    ).toBe(false);
    expect(
      markPrReady(runner({ json: { isDraft: true, mergeStateStatus: 'DIRTY' } }), '/', 5).reason,
    ).toContain('conflicts');
    expect(markPrReady(runner({ status: 1 }), '/', 5).reason).toContain('could not be read');
    expect(markPrReady(runner({ json: { isDraft: true } }, 1), '/', 5).reason).toContain('failed');
  });
});

describe('archiveFailedVerdict', () => {
  it('moves the failed verdict to history and is a no-op without one', () => {
    archiveFailedVerdict(dir, 'AISDLC-1153', now());
    archiveFailedVerdict(dir, 'not an id', now());
    failedVerdict();
    archiveFailedVerdict(dir, 'AISDLC-1153', now());
    expect(collectVerdicts(dir)).toEqual([]);
  });
});

describe('fileStuckPrDecision', () => {
  it('writes an operational escalation with a timebox and the repair as autonomous fallback', () => {
    const rec: StuckPrRecord = {
      kind: 'stuck-pr',
      pr: 2282,
      taskId: 'AISDLC-1153',
      cause: 'push-non-fast-forward',
      since: new Date(T0).toISOString(),
      openedAt: new Date(T0).toISOString(),
    };
    const id = fileStuckPrDecision(dir, buildStuckPrDecision(rec, 4), now());
    expect(id).toBe('DEC-0001');
    const [d] = listDecisions({ workDir: dir }).decisions;
    expect(d.status.escalationTier ?? 'operational').toBe('operational');
    expect(d.status.timeboxExpiresAt).toBe(new Date(T0 + 4 * 3_600_000).toISOString());
    expect(d.spec.options.map((o) => o.id)).toEqual(['repair', 'manual']);
  });

  it('a queued manifest for the task is a terminal state, so nothing is stuck', () => {
    failedVerdict();
    writeManifest(dir, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-1153',
      branch: 'ai-sdlc/aisdlc-1153',
      baseSha: 'a'.repeat(40),
      dispatchedAt: new Date(T0).toISOString(),
      dispatchedBy: 'test',
    } as never);
    nowMs += 120 * 60_000;
    expect(checkStuckPrs({ boardDir: dir, now }).opened).toEqual([]);
  });
});
