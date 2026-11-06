import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  activeClaimFloor,
  budgetStatus,
  fetchUsage,
  formatBudget,
  overrideBudget,
  paceOf,
  readUsage,
  recordUsage,
  resolveMargins,
  sameWindow,
  runBudgetPacer,
  type UsageDeps,
} from './budget.js';
import { pacerAllowance } from './executor-cap.js';
import { readHold, writeHold } from './hold.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const T0 = Date.parse('2026-10-23T18:30:00Z');
const RESET7 = '2026-10-27T18:30:00Z'; // 96 hours after T0
const RESET5 = '2026-10-23T23:30:00Z';

let dir: string;
let clock = T0;
let seven = 91;
let five = 20;
let token: string | undefined = 'sk-secret-token';
let status = 200;

function deps(): UsageDeps {
  return {
    readToken: () => token,
    now: () => new Date(clock),
    fetchImpl: async () => ({
      ok: status === 200,
      status,
      json: async () => ({
        five_hour: { utilization: five, resets_at: RESET5 },
        seven_day: { utilization: seven, resets_at: RESET7 },
      }),
    }),
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'budget-'));
  clock = T0;
  seven = 91;
  five = 20;
  token = 'sk-secret-token';
  status = 200;
});
afterEach(() => removeFixtureDir(dir));

describe('fetchUsage and usage.json', () => {
  it('writes both windows and never stores the token', async () => {
    const r = await fetchUsage(deps());
    const file = recordUsage(dir, r, new Date(clock));
    expect(file.available).toBe(true);
    expect(file.sample?.sevenDay?.utilization).toBe(91);
    expect(file.sample?.fiveHour?.resetsAt).toBe(RESET5);
    expect(readFileSync(path.join(dir, 'usage.json'), 'utf-8')).not.toContain('sk-secret-token');
  });

  it('reports available:false without a credential', async () => {
    token = undefined;
    const r = await fetchUsage(deps());
    expect(r).toEqual({ available: false, reason: expect.stringContaining('credential') });
    expect(recordUsage(dir, r, new Date(clock)).available).toBe(false);
  });

  it('reports available:false on an HTTP error, a bad body and a thrown fetch', async () => {
    status = 401;
    expect((await fetchUsage(deps())).available).toBe(false);
    status = 200;
    const bad = {
      ...deps(),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    };
    expect(await fetchUsage(bad)).toMatchObject({ available: false });
    const boom = {
      ...deps(),
      fetchImpl: async () => {
        throw new Error('down sk-secret-token');
      },
    };
    const r = await fetchUsage(boom);
    expect(JSON.stringify(r)).not.toContain('sk-secret-token');
    expect(r.available).toBe(false);
  });

  it('keeps a 24 hour ring', async () => {
    recordUsage(dir, await fetchUsage(deps()), new Date(clock));
    clock += 25 * 3600_000;
    recordUsage(dir, await fetchUsage(deps()), new Date(clock));
    expect(readUsage(dir).samples).toHaveLength(1);
  });

  it('reads an absent or broken file as empty', () => {
    expect(readUsage(dir).samples).toEqual([]);
    writeFileSync(path.join(dir, 'usage.json'), '{nope');
    expect(readUsage(dir).available).toBe(false);
  });
});

describe('pacer', () => {
  beforeEach(() => {
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ budget: { marginPoints: 0.5 } }));
  });

  it('samples at most once per 5 minutes', async () => {
    expect((await runBudgetPacer(dir, deps())).sampled).toBe(true);
    clock += 60_000;
    expect((await runBudgetPacer(dir, deps())).sampled).toBe(false);
    clock += 5 * 60_000;
    expect((await runBudgetPacer(dir, deps())).sampled).toBe(true);
  });

  it('holds when 44.5 percent an hour after 43 is ahead of the line, then lifts', async () => {
    seven = 43; // the line at T0 is 42.86 (72 of 168 hours elapsed)
    five = 0; // the five-hour window starts at T0
    expect(await runBudgetPacer(dir, deps())).toEqual({ sampled: true });
    clock += 3600_000;
    seven = 44.5;
    const set = await runBudgetPacer(dir, deps());
    expect(set.set).toContain('budget');
    expect(readHold(dir)?.reason).toMatch(/^budget/);
    // the line at +2h is ~44.05; 40 is under line minus margin 0.5
    clock += 3600_000;
    seven = 40;
    const lifted = await runBudgetPacer(dir, deps());
    expect(lifted.lifted).toContain('budget');
    expect(readHold(dir)).toBeNull();
  });

  it('keeps the hold between the margins and uses default margin 2 without config', async () => {
    rmSync(path.join(dir, 'config.json'));
    expect(resolveMargins(dir)).toEqual({ sevenDay: 2, fiveHour: 10 });
    seven = 43;
    await runBudgetPacer(dir, deps());
    clock += 3600_000;
    seven = 44;
    expect((await runBudgetPacer(dir, deps())).set).toBeUndefined();
    clock += 3600_000;
    seven = 47;
    expect((await runBudgetPacer(dir, deps())).set).toBeDefined();
    clock += 3600_000;
    seven = 44.5; // inside the band: hold stays
    const r = await runBudgetPacer(dir, deps());
    expect(r.lifted).toBeUndefined();
    expect(readHold(dir)).not.toBeNull();
  });

  it('never touches a hold it did not set and leaves inflight manifests alone', async () => {
    writeHold(dir, { reason: 'canary', since: 'x', by: 'y' });
    await runBudgetPacer(dir, deps());
    clock += 3600_000;
    seven = 99;
    expect((await runBudgetPacer(dir, deps())).set).toBeUndefined();
    expect(readHold(dir)?.reason).toBe('canary');
    expect(existsSync(path.join(dir, 'inflight'))).toBe(false);
  });

  it('does nothing while unavailable', async () => {
    token = undefined;
    expect(await runBudgetPacer(dir, deps())).toEqual({ sampled: true });
    expect(readHold(dir)).toBeNull();
  });

  it('holds on the five-hour window with its own margin', async () => {
    await runBudgetPacer(dir, deps());
    clock += 3600_000;
    five = 60;
    const r = await runBudgetPacer(dir, deps());
    expect(r.set).toContain('fiveHour');
  });

  it('override exempts the current windows and logs', async () => {
    await runBudgetPacer(dir, deps());
    clock += 3600_000;
    seven = 95;
    await runBudgetPacer(dir, deps());
    expect(readHold(dir)).not.toBeNull();
    overrideBudget(dir, 'planner', new Date(clock).toISOString());
    expect(readHold(dir)).toBeNull();
    clock += 6 * 60_000;
    expect((await runBudgetPacer(dir, deps())).set).toBeUndefined();
    expect(readFileSync(path.join(dir, 'hold-events.jsonl'), 'utf-8')).toContain('budget-override');
    expect(budgetStatus(dir, clock)?.overridden).toBe(true);
  });
});

describe('status BUDGET line', () => {
  it('prints utilizations, line, ahead and the projected exhaustion', async () => {
    expect(budgetStatus(dir, clock)).toBeUndefined();
    seven = 43;
    await runBudgetPacer(dir, deps());
    clock += 3600_000;
    seven = 44;
    await runBudgetPacer(dir, deps());
    const b = budgetStatus(dir, clock);
    const line = formatBudget(b!);
    expect(line).toMatch(/^BUDGET 7d 44% \(line 43\.5%, ahead 0\.5 points\)/);
    expect(line).toContain('projected 100% at');
    expect(b?.sevenDay?.exhaustsAt).toBe(new Date(clock + 56 * 3600_000).toISOString());
  });

  it('says no projection for a flat burn and unknown for a missing window', async () => {
    await runBudgetPacer(dir, deps());
    clock += 6 * 60_000;
    await runBudgetPacer(dir, deps());
    expect(formatBudget(budgetStatus(dir, clock)!)).toContain('no projected exhaustion');
    expect(
      formatBudget({ at: 'x', overridden: false, floor: 'none', floorActive: false }),
    ).toContain('7d unknown');
  });
});

describe('reset-time jitter (AISDLC-1166)', () => {
  const A = '2026-11-03T19:00:00.045334+00:00';
  const B = '2026-11-03T18:59:59.998738+00:00';

  it('sameWindow tolerates under a minute and rejects a new window', () => {
    expect(sameWindow(A, B)).toBe(true);
    expect(sameWindow(A, '2026-11-03T19:02:00+00:00')).toBe(false);
    expect(sameWindow(undefined, A)).toBe(false);
    expect(sameWindow('garbage', 'other')).toBe(false);
  });

  function sampleWith(sevenReset: string, util: number, offsetMs: number) {
    clock = T0 + offsetMs;
    recordUsage(
      dir,
      {
        available: true,
        sample: {
          at: new Date(clock).toISOString(),
          sevenDay: { utilization: util, resetsAt: sevenReset },
        },
      } as never,
      new Date(clock),
    );
  }

  it('keeps the override across jitter and drops it for a new window', () => {
    sampleWith(A, 50, 0);
    overrideBudget(dir, 'planner', new Date(clock).toISOString());
    sampleWith(B, 51, 60_000);
    expect(budgetStatus(dir, clock)?.overridden).toBe(true);
    sampleWith('2026-11-10T19:00:00+00:00', 1, 120_000);
    expect(budgetStatus(dir, clock)?.overridden).toBe(false);
  });

  it('draws the line from reset minus the window length, ignoring a stored anchor (AISDLC-1184)', () => {
    const reset = '2026-11-10T19:00:00Z';
    const now = Date.parse('2026-11-04T21:53:00Z');
    writeFileSync(
      path.join(dir, 'usage.json'),
      JSON.stringify({
        available: true,
        samples: [],
        windows: { sevenDay: { resetsAt: reset, at: '2026-11-04T21:05:00Z', utilization: 6 } },
        sample: {
          at: '2026-11-04T21:53:00Z',
          sevenDay: { utilization: 7, resetsAt: reset },
        },
      }),
    );
    const pace = paceOf('sevenDay', readUsage(dir), 2, now);
    expect(pace?.line).toBeGreaterThan(15.5);
    expect(pace?.line).toBeLessThan(16.5);
    expect(pace && pace.ahead < 0).toBe(true);
    expect(pacerAllowance(budgetStatus(dir, now))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('priority floor (RFC-0062 OQ-1)', () => {
  const setFloor = (f: string | undefined): void =>
    writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ budget: f ? { priorityFloor: f } : {} }),
    );

  /** Two samples one hour apart so the burn projects exhaustion; `now` is the second. */
  async function burn(first: number, second: number): Promise<number> {
    seven = first;
    await runBudgetPacer(dir, deps());
    clock = T0 + 3600_000;
    seven = second;
    await runBudgetPacer(dir, { ...deps(), now: () => new Date(clock + 6 * 60_000) });
    return clock + 6 * 60_000;
  }

  it('defaults to none: the line carries FLOOR none and no claim floor', async () => {
    const now = await burn(50, 60);
    expect(formatBudget(budgetStatus(dir, now)!)).toMatch(/; FLOOR none$/);
    expect(activeClaimFloor(dir, now)).toBeUndefined();
  });

  it('activates when the projection passes 100% before reset and lifts on recovery', async () => {
    setFloor('high');
    const now = await burn(50, 60);
    const b = budgetStatus(dir, now)!;
    expect(b.floorActive).toBe(true);
    expect(formatBudget(b)).toMatch(/; FLOOR high \(active\)$/);
    expect(activeClaimFloor(dir, now)).toBe('high');
    // Utilization falls back under the first sample: no projection, the floor lifts.
    seven = 40;
    clock = now + 3600_000;
    await runBudgetPacer(dir, { ...deps(), now: () => new Date(clock) });
    clock += 6 * 60_000;
    await runBudgetPacer(dir, { ...deps(), now: () => new Date(clock) });
    expect(activeClaimFloor(dir, clock)).toBeUndefined();
  });

  it('stays inactive when the projection resets first, or on an unknown value', async () => {
    setFloor('high');
    const now = await burn(50, 50.1);
    expect(budgetStatus(dir, now)!.floorActive).toBe(false);
    setFloor('bogus');
    expect(budgetStatus(dir, now)!.floor).toBe('none');
    writeFileSync(path.join(dir, 'config.json'), '{bad');
    expect(activeClaimFloor(dir, now)).toBeUndefined();
  });
});
