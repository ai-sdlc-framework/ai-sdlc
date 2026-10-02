import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProposeResult, RouteDeps } from '../usage/route-commands.js';
import {
  ROUTING_PROPOSAL_STATE_RELATIVE,
  isoWeekOf,
  runWeeklyRoutingProposal,
} from './routing-proposal.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'routing-weekly-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RESULT: ProposeResult = {
  outcome: 'nothing-qualifies',
  dryRun: false,
  changes: [],
  noLongerCheaper: [],
  notQualifying: [],
  warnings: [],
};
const WED = new Date('2026-09-30T10:00:00Z'); // 2026-W40
const THU = new Date('2026-10-01T10:00:00Z'); // same week
const NEXT_MON = new Date('2026-10-05T00:00:00Z'); // 2026-W41

describe('isoWeekOf', () => {
  it('labels ISO weeks, including year boundaries', () => {
    expect(isoWeekOf(WED)).toBe('2026-W40');
    expect(isoWeekOf(NEXT_MON)).toBe('2026-W41');
    expect(isoWeekOf(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeekOf(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeekOf(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01');
    expect(isoWeekOf(new Date('2026-10-04T23:59:59Z'))).toBe('2026-W40'); // Sunday
  });
});

describe('runWeeklyRoutingProposal', () => {
  const base = () => ({ workDir: dir, artifactsDir: dir, env: {} });

  it('runs once per calendar week and persists the week', async () => {
    const run = vi.fn(async () => RESULT);
    expect(await runWeeklyRoutingProposal({ ...base(), now: () => WED, run })).toBe(RESULT);
    expect(await runWeeklyRoutingProposal({ ...base(), now: () => THU, run })).toBe('skipped');
    expect(run).toHaveBeenCalledTimes(1);
    const state = JSON.parse(readFileSync(join(dir, ROUTING_PROPOSAL_STATE_RELATIVE), 'utf8'));
    expect(state.lastWeek).toBe('2026-W40');
    expect(await runWeeklyRoutingProposal({ ...base(), now: () => NEXT_MON, run })).toBe(RESULT);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('passes the work and artifacts directories and the injected clock to the run', async () => {
    const seen: RouteDeps[] = [];
    const run = async (d: RouteDeps) => {
      seen.push(d);
      return RESULT;
    };
    await runWeeklyRoutingProposal({ ...base(), now: () => WED, run, deps: { usageDir: 'u' } });
    expect(seen[0]).toMatchObject({
      repoRoot: dir,
      workDir: dir,
      artifactsDir: dir,
      usageDir: 'u',
    });
    expect(seen[0].now?.()).toEqual(WED);
  });

  it('never throws, warns, and counts the attempt so a failure is not retried the same week', async () => {
    const warn = vi.fn();
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await runWeeklyRoutingProposal({ ...base(), now: () => WED, run, warn })).toBe('error');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('weekly routing proposal failed: boom'),
    );
    expect(await runWeeklyRoutingProposal({ ...base(), now: () => THU, run, warn })).toBe(
      'skipped',
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing warn sink and non-Error failures', async () => {
    const run = async () => Promise.reject('plain');
    const warn = () => {
      throw new Error('sink');
    };
    expect(await runWeeklyRoutingProposal({ ...base(), now: () => WED, run, warn })).toBe('error');
  });

  it('skips without touching state when the Decision Catalog is off', async () => {
    const run = vi.fn(async () => RESULT);
    const out = await runWeeklyRoutingProposal({
      workDir: dir,
      artifactsDir: dir,
      env: { AI_SDLC_DECISION_CATALOG: 'off' },
      now: () => WED,
      run,
    });
    expect(out).toBe('skipped');
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(dir, ROUTING_PROPOSAL_STATE_RELATIVE))).toBe(false);
  });

  it('treats a damaged state file as never run', async () => {
    const run = vi.fn(async () => RESULT);
    await runWeeklyRoutingProposal({ ...base(), now: () => WED, run });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, ROUTING_PROPOSAL_STATE_RELATIVE), '{broken');
    await runWeeklyRoutingProposal({ ...base(), now: () => WED, run });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('runWeeklyRoutingProposal state file', () => {
  it('does not follow a symlink at the state path', async () => {
    const target = join(dir, 'victim.txt');
    writeFileSync(target, 'keep');
    const statePath = join(dir, ROUTING_PROPOSAL_STATE_RELATIVE);
    mkdirSync(join(dir, '_routing'), { recursive: true });
    symlinkSync(target, statePath);
    const run = vi.fn(async (_d: RouteDeps) => RESULT);
    await runWeeklyRoutingProposal({
      workDir: dir,
      artifactsDir: dir,
      now: () => WED,
      run,
      env: {},
    });
    expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(lstatSync(statePath).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).lastWeek).toBe('2026-W40');
  });
});
