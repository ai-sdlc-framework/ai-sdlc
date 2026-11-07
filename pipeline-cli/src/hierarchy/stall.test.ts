import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBoardDirs, writeHeartbeat, writeManifest } from '../dispatch/board.js';

import { findOpenPrNumber, paneHasLiveNextStep, reapStalledClaims } from './stall.js';
import type { CommandRunner } from './types.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

describe('findOpenPrNumber', () => {
  const run =
    (status: number, stdout: string): CommandRunner =>
    () => ({
      status,
      stdout,
      stderr: '',
    });
  const list = JSON.stringify([
    { number: 1, headRefName: 'ai-sdlc/aisdlc-9-other' },
    { number: 2, headRefName: 'ai-sdlc/aisdlc-8-slug' },
  ]);
  it('finds the task branch', () => {
    expect(findOpenPrNumber(run(0, list), '/r', 'AISDLC-8')).toBe(2);
    expect(findOpenPrNumber(run(0, list), '/r', 'AISDLC-7')).toBeUndefined();
  });
  it('is undefined when gh fails or prints junk', () => {
    expect(findOpenPrNumber(run(1, ''), '/r', 'AISDLC-8')).toBeUndefined();
    expect(findOpenPrNumber(run(0, 'nope'), '/r', 'AISDLC-8')).toBeUndefined();
  });
});

const T0 = Date.parse('2026-11-06T10:00:00Z');
const HOUR = 3_600_000;
type ExecState = 'turn-running' | 'idle-awaiting-clear' | 'background-agent-running';

describe('reapStalledClaims on executor state (AISDLC-1218)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'stall-reap-'));
    ensureBoardDirs(dir);
    writeManifest(dir, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-9',
      taskFile: 'x',
      spec: { taskFile: 'backlog/tasks/aisdlc-9.md' },
      branch: 'b',
      baseSha: 'a'.repeat(40),
      dispatchedAt: new Date(T0).toISOString(),
      dispatchedBy: 't',
    } as never);
    renameSync(
      path.join(dir, 'queue', 'AISDLC-9.dispatch.json'),
      path.join(dir, 'inflight', 'AISDLC-9.dispatch.json'),
    );
  });
  afterEach(() => removeFixtureDir(dir));

  const hold = (executorState?: ExecState) =>
    writeHeartbeat(dir, {
      taskId: 'AISDLC-9',
      workerId: 'eph-1',
      workerKind: 'any',
      startedAt: new Date(T0).toISOString(),
      lastHeartbeat: new Date(T0).toISOString(),
      currentStep: '05-dev-running',
      ...(executorState ? { executorState } : {}),
    } as never);

  const reap = (
    extra: Partial<Parameters<typeof reapStalledClaims>[0]> = {},
    onReaped?: Parameters<typeof reapStalledClaims>[1],
  ) => reapStalledClaims({ boardDir: dir, now: () => new Date(T0 + 3 * HOUR), ...extra }, onReaped);

  it('does not reap a background-agent-running claim with a 3 hour old heartbeat', async () => {
    hold('background-agent-running');
    expect(await reap()).toEqual([]);
  });

  it('does not reap a turn-running claim or one with no published state', async () => {
    hold('turn-running');
    expect(await reap()).toEqual([]);
    hold();
    expect(await reap()).toEqual([]);
  });

  it('reaps an idle-awaiting-clear claim with cause idle-with-claim', async () => {
    hold('idle-awaiting-clear');
    const reaped: { cause?: string; lastStep?: string; heartbeatAgeMs?: number }[] = [];
    const r = await reap({}, (v) => reaped.push(v));
    expect(r[0]).toMatchObject({ reason: 'idle-with-claim', requeue: { status: 'requeued' } });
    expect(reaped[0]).toMatchObject({
      cause: 'idle-with-claim',
      lastStep: '05-dev-running',
      heartbeatAgeMs: 3 * HOUR,
    });
    expect(existsSync(path.join(dir, 'queue', 'AISDLC-9.dispatch.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'inflight', 'AISDLC-9.dispatch.json'))).toBe(false);
  });

  it('spares an idle claim whose state publish is younger than the floor (AISDLC-1225)', async () => {
    hold('idle-awaiting-clear');
    const spared: { reason: string }[] = [];
    const fresh = {
      now: () => new Date(T0 + 5_000),
      onSpared: (o: { reason: string }) => spared.push(o),
    };
    expect(await reap(fresh)).toEqual([]);
    expect(spared[0]?.reason).toContain('less than one tick');
    // the same claim, once past the floor, is reaped (AISDLC-1218 AC-2 still holds)
    expect(await reap({ now: () => new Date(T0 + 60_000) })).toHaveLength(1);
  });

  it('swallows a throwing onSpared on the floor path', async () => {
    hold('idle-awaiting-clear');
    const r = await reap({
      now: () => new Date(T0 + 1_000),
      onSpared: () => {
        throw new Error('x');
      },
    });
    expect(r).toEqual([]);
  });

  it('skips an idle claim whose verdict is in done/', async () => {
    hold('idle-awaiting-clear');
    mkdirSync(path.join(dir, 'done'), { recursive: true });
    writeFileSync(path.join(dir, 'done', 'AISDLC-9.verdict.json'), '{}');
    expect(await reap()).toEqual([]);
  });

  it('spares an idle executor with a live next-step and records why', async () => {
    hold('idle-awaiting-clear');
    const spared: { reason: string }[] = [];
    expect(await reap({ hasLiveNextStep: () => true, onSpared: (o) => spared.push(o) })).toEqual(
      [],
    );
    expect(spared[0]?.reason).toContain('live next-step');
  });

  it.each([
    ['says no', () => false],
    [
      'throws',
      () => {
        throw new Error('ps failed');
      },
    ],
  ])('reaps when the live next-step probe %s', async (_n, probe) => {
    hold('idle-awaiting-clear');
    expect(await reap({ hasLiveNextStep: probe })).toHaveLength(1);
  });
});

describe('paneHasLiveNextStep', () => {
  const ps =
    (stdout: string, status = 0): CommandRunner =>
    () => ({ status, stdout, stderr: '' });
  const table = [
    '  10     1 zsh',
    '  20    10 claude',
    '  30    20 node pipeline-cli/bin/cli-next-step.mjs --task X',
    '  99     1 node next-step unrelated',
  ].join('\n');
  it('finds a next-step descendant of the pane', () => {
    expect(paneHasLiveNextStep(ps(table), 10)).toBe(true);
  });
  it('ignores next-step outside the pane tree', () => {
    expect(paneHasLiveNextStep(ps(table), 20 + 1000)).toBe(false);
    expect(paneHasLiveNextStep(ps('  10 1 zsh\n  99 1 node next-step'), 10)).toBe(false);
  });
  it('is false for no pane pid or ps failure', () => {
    expect(paneHasLiveNextStep(ps(table), 0)).toBe(false);
    expect(paneHasLiveNextStep(ps('', 1), 10)).toBe(false);
  });
});
