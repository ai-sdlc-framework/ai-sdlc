import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBoardDirs, writeHeartbeat, writeManifest } from '../dispatch/board.js';

import {
  DEFAULT_STALL_GRACE_MS,
  DEFAULT_STALL_STALE_MS,
  findOpenPrNumber,
  endsWithQuestion,
  reapStalledClaims,
  stallResumeNote,
  stallThresholdsFromEnv,
} from './stall.js';
import type { CommandRunner } from './types.js';

describe('stallThresholdsFromEnv', () => {
  it('defaults to 30 and 10 minutes', () => {
    expect(stallThresholdsFromEnv({})).toEqual({
      staleMs: DEFAULT_STALL_STALE_MS,
      graceMs: DEFAULT_STALL_GRACE_MS,
    });
    expect(DEFAULT_STALL_STALE_MS).toBe(30 * 60_000);
    expect(DEFAULT_STALL_GRACE_MS).toBe(10 * 60_000);
  });
  it('uses the supplied defaults when the environment is empty', () => {
    expect(stallThresholdsFromEnv({}, { staleMs: 7, graceMs: 3 })).toEqual({
      staleMs: 7,
      graceMs: 3,
    });
  });
  it('reads positive numbers and ignores junk', () => {
    expect(
      stallThresholdsFromEnv({
        AI_SDLC_DISPATCH_STALE_MS: '1000',
        AI_SDLC_DISPATCH_STALL_GRACE_MS: 'abc',
      }),
    ).toEqual({ staleMs: 1000, graceMs: DEFAULT_STALL_GRACE_MS });
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
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const reap = (ageMin: number, state?: 'busy' | 'idle' | 'gone' | 'unknown') =>
    reapStalledClaims({
      boardDir: dir,
      now: () => new Date(T0 + ageMin * MIN),
      staleMs: 30 * MIN,
      graceMs: 10 * MIN,
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
    'reaps a %s holder after the grace period as holder-not-busy',
    async (state) => {
      const r = await reap(11, state);
      expect(r).toHaveLength(1);
      expect(r[0]?.reason).toBe('holder-not-busy');
    },
  );

  it('reaps any worker as stale-heartbeat after the stale period', async () => {
    const r = await reap(31, 'busy');
    expect(r[0]?.reason).toBe('stale-heartbeat');
  });
});
