import { mkdtempSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBoardDirs, writeHeartbeat, writeManifest } from '../dispatch/board.js';

import {
  DEFAULT_STALL_STALE_MS,
  findOpenPrNumber,
  paneHasLiveNextStep,
  endsWithQuestion,
  reapStalledClaims,
  stallResumeNote,
  stallThresholdsFromEnv,
} from './stall.js';
import type { CommandRunner } from './types.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

describe('stallThresholdsFromEnv', () => {
  it('defaults to 30 minutes', () => {
    expect(stallThresholdsFromEnv({})).toEqual({ staleMs: DEFAULT_STALL_STALE_MS });
    expect(DEFAULT_STALL_STALE_MS).toBe(30 * 60_000);
  });
  it('uses the supplied defaults when the environment is empty', () => {
    expect(stallThresholdsFromEnv({}, { staleMs: 7 })).toEqual({ staleMs: 7 });
  });
  it('reads positive numbers and ignores junk', () => {
    expect(
      stallThresholdsFromEnv({
        AI_SDLC_DISPATCH_STALE_MS: '1000',
      }),
    ).toEqual({ staleMs: 1000 });
    expect(stallThresholdsFromEnv({ AI_SDLC_DISPATCH_STALE_MS: 'abc' })).toEqual({
      staleMs: DEFAULT_STALL_STALE_MS,
    });
  });
});

describe('stallResumeNote', () => {
  it('names the step and the pull request', () => {
    expect(stallResumeNote('ship', 9)).toContain('step ship');
    expect(stallResumeNote('ship', 9)).toContain('#9');
    expect(stallResumeNote('ship')).toContain('No pull request');
  });
});

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

describe('endsWithQuestion', () => {
  it('is true when the last real line is a question, ignoring chrome', () => {
    expect(endsWithQuestion('done\nShall I push or release?\n╭────╮\n│ > │\n╰────╯\n')).toBe(true);
  });
  it('is false for a statement or empty output', () => {
    expect(endsWithQuestion('Pushed the branch.\n❯ \n')).toBe(false);
    expect(endsWithQuestion('')).toBe(false);
  });
});

describe('reapStalledClaims thresholds (AISDLC-1103)', () => {
  const T0 = Date.parse('2026-10-28T10:00:00Z');
  const MIN = 60000;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'stall-reap-'));
    ensureBoardDirs(dir);
    writeManifest(dir, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-9',
      taskFile: 'x',
      branch: 'b',
      baseSha: 'a'.repeat(40),
      dispatchedAt: new Date(T0).toISOString(),
      dispatchedBy: 't',
    } as never);
    renameSync(
      path.join(dir, 'queue', 'AISDLC-9.dispatch.json'),
      path.join(dir, 'inflight', 'AISDLC-9.dispatch.json'),
    );
    writeHeartbeat(dir, {
      taskId: 'AISDLC-9',
      workerId: 'eph-1',
      workerKind: 'any',
      startedAt: new Date(T0).toISOString(),
      lastHeartbeat: new Date(T0).toISOString(),
      currentStep: '05-dev-running',
    } as never);
  });
  afterEach(() => removeFixtureDir(dir));

  const reap = (ageMin: number, state?: 'busy' | 'idle' | 'gone' | 'unknown') =>
    reapStalledClaims({
      boardDir: dir,
      now: () => new Date(T0 + ageMin * MIN),
      staleMs: 30 * MIN,
      liveness: state ? () => new Map([['eph-1', state]]) : undefined,
    });

  it('keeps a busy worker past the grace period but inside the stale period', async () => {
    expect(await reap(11, 'busy')).toEqual([]);
  });

  it('refuses an idle holder named by the inflight manifest with a heartbeat under 30 minutes (AISDLC-1124)', async () => {
    expect(await reap(11, 'idle')).toEqual([]);
    expect(await reap(29, 'idle')).toEqual([]);
    expect((await reap(31, 'idle'))[0]?.reason).toBe('stale-heartbeat');
  });

  it.each(['gone', 'unknown'] as const)(
    'leaves a %s holder to pane-exited inside the stale period (AISDLC-1217)',
    async (state) => {
      expect(await reap(11, state)).toEqual([]);
    },
  );

  it('reaps any worker as stale-heartbeat after the stale period', async () => {
    const r = await reap(31, 'busy');
    expect(r[0]?.reason).toBe('stale-heartbeat');
  });
});

describe('reapStalledClaims live next-step (AISDLC-1198)', () => {
  const T0 = Date.parse('2026-11-06T10:00:00Z');
  const MIN = 60000;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'stall-ns-'));
    ensureBoardDirs(dir);
    writeManifest(dir, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-9',
      taskFile: 'x',
      branch: 'b',
      baseSha: 'a'.repeat(40),
      dispatchedAt: new Date(T0).toISOString(),
      dispatchedBy: 't',
    } as never);
    renameSync(
      path.join(dir, 'queue', 'AISDLC-9.dispatch.json'),
      path.join(dir, 'inflight', 'AISDLC-9.dispatch.json'),
    );
    writeHeartbeat(dir, {
      taskId: 'AISDLC-9',
      workerId: 'eph-1',
      workerKind: 'any',
      startedAt: new Date(T0).toISOString(),
      lastHeartbeat: new Date(T0).toISOString(),
      currentStep: '06-dev-done',
    } as never);
  });
  afterEach(() => removeFixtureDir(dir));

  const reap = (live: () => boolean, spared: unknown[] = []) =>
    reapStalledClaims({
      boardDir: dir,
      now: () => new Date(T0 + 40 * MIN),
      staleMs: 30 * MIN,
      hasLiveNextStep: live,
      onSpared: (o) => spared.push(o),
    });

  it('spares an aged executor with a live next-step and records why', async () => {
    const spared: { reason: string }[] = [];
    expect(await reap(() => true, spared)).toEqual([]);
    expect(spared).toHaveLength(1);
    expect(spared[0]?.reason).toContain('live next-step');
  });

  it('reaps an aged executor with no live work', async () => {
    const r = await reap(() => false);
    expect(r[0]?.reason).toBe('stale-heartbeat');
  });

  it('reaps when the probe throws', async () => {
    const r = await reap(() => {
      throw new Error('ps failed');
    });
    expect(r).toHaveLength(1);
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
