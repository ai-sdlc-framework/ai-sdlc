import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setClock } from '../clock.js';
import {
  DEFAULT_SPACING_MINUTES,
  SPACING_ENV,
  paceFiling,
  parseRateLimit,
  readLastFiling,
  recordFiling,
  resolveSpacingMinutes,
  type PacingDeps,
} from './file-pacing.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const T0 = new Date('2026-10-20T12:00:00Z');
const RL = JSON.stringify({
  resources: { core: { limit: 5000, remaining: 4200, reset: 1792500000 } },
});

describe('file pacing (AISDLC-986)', () => {
  let repo: string;
  let logs: string[];
  let slept: number[];
  let deps: PacingDeps;
  let restore: () => void;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'pace-'));
    logs = [];
    slept = [];
    restore = setClock(() => T0);
    deps = {
      readRateLimit: () => RL,
      sleep: async (ms) => {
        slept.push(ms);
      },
      log: (l) => logs.push(l),
    };
  });
  afterEach(() => {
    restore();
    removeFixtureDir(repo);
  });

  it('prints remaining calls and reset time', async () => {
    expect(await paceFiling(repo, { id: 'X-1', command: 'c' }, deps)).toBe('proceed');
    expect(logs[0]).toMatch(/4200\/5000 calls remaining, resets 20\d\d-/);
  });

  it('reports an unreadable bucket', async () => {
    deps.readRateLimit = () => null;
    await paceFiling(repo, { id: 'X-1', command: 'c' }, deps);
    expect(logs[0]).toMatch(/unreadable/);
  });

  it('proceeds without waiting when the spacing has elapsed', async () => {
    recordFiling(repo);
    restore();
    restore = setClock(() => new Date(T0.getTime() + 16 * 60_000));
    expect(await paceFiling(repo, { id: 'X-1', command: 'c' }, deps)).toBe('proceed');
    expect(slept).toEqual([]);
  });

  it('waits out the remaining spacing', async () => {
    recordFiling(repo);
    restore();
    restore = setClock(() => new Date(T0.getTime() + 5 * 60_000));
    expect(await paceFiling(repo, { id: 'X-1', command: 'c' }, deps)).toBe('proceed');
    expect(slept).toEqual([10 * 60_000]);
  });

  it('queues a brief with --queue instead of waiting', async () => {
    recordFiling(repo);
    expect(
      await paceFiling(repo, { id: 'X-1', command: 'cli-file task x --pr', queue: true }, deps),
    ).toBe('queued');
    expect(slept).toEqual([]);
    const f = join(repo, '.ai-sdlc/dispatch/queued-filings/filing-x-1.md');
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, 'utf8')).toContain('cli-file task x --pr');
  });

  it('honours a spacing flag', async () => {
    recordFiling(repo);
    restore();
    restore = setClock(() => new Date(T0.getTime() + 2 * 60_000));
    await paceFiling(repo, { id: 'X-1', command: 'c', spacingMinutes: 1 }, deps);
    expect(slept).toEqual([]);
  });

  it('resolves spacing from flag, env, then default', () => {
    expect(resolveSpacingMinutes(3, {})).toBe(3);
    expect(resolveSpacingMinutes(undefined, { [SPACING_ENV]: '7' })).toBe(7);
    expect(resolveSpacingMinutes(undefined, { [SPACING_ENV]: 'x' })).toBe(DEFAULT_SPACING_MINUTES);
    expect(resolveSpacingMinutes(undefined, {})).toBe(DEFAULT_SPACING_MINUTES);
  });

  it('parses rate_limit output and tolerates garbage', () => {
    expect(parseRateLimit(RL)?.remaining).toBe(4200);
    expect(parseRateLimit('nope')).toBeNull();
    expect(parseRateLimit('{}')).toBeNull();
    expect(readLastFiling(repo)).toBeNull();
  });
});
