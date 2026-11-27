import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PIDLESS_GRACE_MS,
  acquireVerifySlot,
  exclusiveHeld,
  listVerifySlots,
} from './verify-slots.js';

const alive = () => true;
const tick = () => new Promise<void>((r) => setTimeout(r, 15));

describe('exclusive full-scope verify slot (AISDLC-1378)', () => {
  function board() {
    return mkdtempSync(join(tmpdir(), 'verify-excl-'));
  }

  it('waits while another verify holds any slot, and starts once it releases', async () => {
    const dir = board();
    const other = await acquireVerifySlot(dir, { pid: 1, isAlive: alive, pollMs: 1 });
    let got = false;
    const p = acquireVerifySlot(
      dir,
      { pid: 2, isAlive: alive, pollMs: 1 },
      { exclusive: true },
    ).then((s) => ((got = true), s));
    await tick();
    expect(got).toBe(false);
    other.release();
    const full = await p;
    expect(got).toBe(true);
    full.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it('blocks new acquirers while it runs', async () => {
    const dir = board();
    const full = await acquireVerifySlot(
      dir,
      { pid: 2, isAlive: alive, pollMs: 1 },
      { exclusive: true },
    );
    let got = false;
    const p = acquireVerifySlot(dir, { pid: 3, isAlive: alive, pollMs: 1 }).then(
      (s) => ((got = true), s),
    );
    await tick();
    expect(got).toBe(false);
    full.release();
    (await p).release();
    expect(got).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('serialises two full-scope runs and reclaims a dead exclusive holder', async () => {
    const dir = board();
    const a = await acquireVerifySlot(
      dir,
      { pid: 2, isAlive: alive, pollMs: 1 },
      { exclusive: true },
    );
    let got = false;
    const p = acquireVerifySlot(
      dir,
      { pid: 4, isAlive: alive, pollMs: 1 },
      { exclusive: true },
    ).then((s) => ((got = true), s));
    await tick();
    expect(got).toBe(false);
    a.release();
    (await p).release();
    // dead holder: marker left behind by pid 9 is reclaimed
    await acquireVerifySlot(dir, { pid: 9, isAlive: alive, pollMs: 1 }, { exclusive: true });
    const b = await acquireVerifySlot(
      dir,
      { pid: 5, isAlive: (p2) => p2 !== 9, pollMs: 1 },
      { exclusive: true },
    );
    b.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it('releases the marker when the wait for other slots throws', async () => {
    const dir = board();
    await acquireVerifySlot(dir, { pid: 1, isAlive: alive, pollMs: 1 });
    await expect(
      acquireVerifySlot(
        dir,
        {
          pid: 2,
          isAlive: alive,
          sleep: async () => {
            throw new Error('boom');
          },
        },
        { exclusive: true },
      ),
    ).rejects.toThrow('boom');
    const next = await acquireVerifySlot(dir, { pid: 3, isAlive: alive, pollMs: 1 });
    next.release();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('pid-less slot and marker directories (AISDLC-1383)', () => {
  function board() {
    return mkdtempSync(join(tmpdir(), 'verify-pidless-'));
  }
  /** A directory left by a process killed between mkdir and the pid write. */
  function orphan(dir: string, ageMs: number) {
    mkdirSync(dir, { recursive: true });
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(dir, t, t);
  }
  const stale = PIDLESS_GRACE_MS + 5_000;

  it('reclaims a stale pid-less exclusive marker for shared and exclusive acquirers', async () => {
    const dir = board();
    const marker = join(dir, 'verify-slots', 'exclusive');
    orphan(marker, stale);
    expect(exclusiveHeld(dir, alive)).toBe(false);
    const shared = await acquireVerifySlot(dir, { pid: 3, isAlive: alive, pollMs: 1 });
    expect(shared.index).toBe(0);
    shared.release();
    const full = await acquireVerifySlot(
      dir,
      { pid: 4, isAlive: alive, pollMs: 1 },
      { exclusive: true },
    );
    expect(readFileSync(join(marker, 'pid'), 'utf8')).toBe('4');
    full.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reclaims a stale pid-less slot directory', async () => {
    const dir = board();
    orphan(join(dir, 'verify-slots', 'slot-0'), stale);
    orphan(join(dir, 'verify-slots', 'slot-1'), stale);
    expect(listVerifySlots(dir, alive).map((s) => s.alive)).toEqual([false, false]);
    const slot = await acquireVerifySlot(dir, { pid: 5, isAlive: alive, pollMs: 1 });
    expect(slot.index).toBe(0);
    expect(readFileSync(join(dir, 'verify-slots', 'slot-0', 'pid'), 'utf8')).toBe('5');
    slot.release();
    // an exclusive run does not wait on the stale slot-1 either
    const full = await acquireVerifySlot(
      dir,
      { pid: 6, isAlive: alive, pollMs: 1 },
      { exclusive: true },
    );
    full.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts a pid-less directory inside the grace period as held', async () => {
    const dir = board();
    const marker = join(dir, 'verify-slots', 'exclusive');
    orphan(marker, 1_000);
    orphan(join(dir, 'verify-slots', 'slot-0'), 1_000);
    expect(exclusiveHeld(dir, alive)).toBe(true);
    expect(listVerifySlots(dir, alive)).toEqual([{ index: 0, pid: null, alive: true }]);
    let got = false;
    const p = acquireVerifySlot(dir, { pid: 7, isAlive: alive, pollMs: 1, log: () => {} }).then(
      (s) => ((got = true), s),
    );
    await tick();
    expect(got).toBe(false);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker, { recursive: true, force: true }); // the writer finished and released
    const slot = await p;
    expect(slot.index).toBe(1); // slot-0 is still held inside its grace period
    slot.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never reclaims a live holder and names it once after 60 s of waiting', async () => {
    const dir = board();
    const holder = await acquireVerifySlot(
      dir,
      { pid: 77, isAlive: alive, pollMs: 1 },
      { exclusive: true },
    );
    const marker = join(dir, 'verify-slots', 'exclusive');
    let t = 0;
    const logs: string[] = [];
    const slot = await acquireVerifySlot(dir, {
      pid: 8,
      isAlive: alive,
      now: () => t,
      log: (l) => logs.push(l),
      sleep: async (ms) => {
        t += ms;
        expect(readFileSync(join(marker, 'pid'), 'utf8')).toBe('77');
        if (t === 59_000) expect(logs).toEqual([]);
        if (t >= 180_000) holder.release();
      },
      pollMs: 1_000,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('pid 77');
    expect(logs[0]).toContain(marker);
    expect(t).toBe(180_000);

    // an exclusive run waiting on a live shared slot names that slot
    t = 0;
    logs.length = 0;
    const full = acquireVerifySlot(
      dir,
      {
        pid: 9,
        isAlive: alive,
        now: () => t,
        log: (l) => logs.push(l),
        sleep: async (ms) => {
          t += ms;
          if (t >= 90_000) slot.release();
        },
        pollMs: 1_000,
      },
      { exclusive: true },
    );
    (await full).release();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('pid 8');
    expect(logs[0]).toContain(join(dir, 'verify-slots', 'slot-0'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('names an exclusive holder to a second exclusive acquirer', async () => {
    const dir = board();
    const holder = await acquireVerifySlot(
      dir,
      { pid: 41, isAlive: alive, pollMs: 1 },
      { exclusive: true },
    );
    let t = 0;
    const logs: string[] = [];
    const next = await acquireVerifySlot(
      dir,
      {
        pid: 42,
        isAlive: alive,
        now: () => t,
        log: (l) => logs.push(l),
        sleep: async (ms) => {
          t += ms;
          if (t >= 61_000) holder.release();
        },
        pollMs: 1_000,
      },
      { exclusive: true },
    );
    next.release();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('pid 41');
    rmSync(dir, { recursive: true, force: true });
  });
});
