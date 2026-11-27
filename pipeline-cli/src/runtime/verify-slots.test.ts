import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PIDLESS_GRACE_MS,
  VERIFY_SLOT_STALE_MS,
  VerifySlotWaitError,
  acquireVerifySlot,
  describeHolder,
  exclusiveHeld,
  formatDuration,
  inspectVerifySlots,
  listVerifySlots,
  processStartTime,
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
        if (t >= 180_000) holder.release();
      },
      pollMs: 1_000,
    });
    // named at the start and every 30 s with the elapsed wait (AISDLC-1413)
    expect(logs).toHaveLength(6);
    expect(logs[0]).toContain('waiting 0s');
    expect(logs[1]).toContain('waiting 30s');
    expect(logs[5]).toContain('waiting 2m 30s');
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
    expect(logs).toHaveLength(3);
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
    expect(logs).toHaveLength(3);
    expect(logs[0]).toContain('pid 41');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('bounded waits that name the holder (AISDLC-1413)', () => {
  function board() {
    return mkdtempSync(join(tmpdir(), 'verify-bounded-'));
  }
  /** Start times by pid: the "process table" of the test. */
  function procs(table: Record<number, string>) {
    return {
      isAlive: (p: number) => p in table,
      startTimeOf: (p: number) => table[p] ?? null,
    };
  }

  it('reclaims a slot whose pid now belongs to a different process (pid reuse)', async () => {
    const dir = board();
    const table: Record<number, string> = { 90586: 'Sat Nov 21 10:00:00 2026', 1: 'boot' };
    const first = await acquireVerifySlot(dir, { pid: 90586, ...procs(table), pollMs: 1 });
    const second = await acquireVerifySlot(dir, { pid: 1, ...procs(table), pollMs: 1 });
    expect(second.index).toBe(1);
    second.release();
    // the original holder died without releasing and its pid was reused by another process
    table[90586] = 'Mon Nov 23 08:00:00 2026';
    const [held] = inspectVerifySlots(dir, procs(table));
    expect(held?.state).toBe('reused');
    expect(describeHolder(held!, Date.now())).toContain('PID REUSED');
    expect(listVerifySlots(dir, procs(table).isAlive, Date.now, procs(table).startTimeOf)).toEqual([
      { index: 0, pid: 90586, alive: false },
    ]);
    const next = await acquireVerifySlot(dir, { pid: 1, ...procs(table), pollMs: 1 });
    expect(next.index).toBe(0);
    expect(readFileSync(join(dir, 'verify-slots', 'slot-0', 'pid'), 'utf8')).toBe('1');
    next.release();
    void first;
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a legacy pid-only holder whose start time is unknown', async () => {
    const dir = board();
    mkdirSync(join(dir, 'verify-slots', 'slot-0'), { recursive: true });
    writeFileSync(join(dir, 'verify-slots', 'slot-0', 'pid'), '5');
    const [h] = inspectVerifySlots(dir, { isAlive: () => true, startTimeOf: () => 'x' });
    expect(h).toMatchObject({ name: 'slot-0', pid: 5, startTime: null, state: 'held' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a live holder past the stale threshold, never reclaims it, and refuses at once', async () => {
    const dir = board();
    let t = 1_000_000;
    const table = { 46461: 'Mon Nov 23 09:51:00 2026', 2: 'b' };
    const holder = await acquireVerifySlot(
      dir,
      { pid: 46461, ...procs(table), now: () => t, taskId: 'AISDLC-1392', command: 'next-step' },
      { exclusive: true },
    );
    t += VERIFY_SLOT_STALE_MS - 1;
    holder.heartbeat(); // progress keeps it fresh
    t += VERIFY_SLOT_STALE_MS - 1;
    expect(inspectVerifySlots(dir, { ...procs(table), now: () => t })[0]?.state).toBe('held');
    t += 2 * VERIFY_SLOT_STALE_MS;
    const [stale] = inspectVerifySlots(dir, { ...procs(table), now: () => t });
    expect(stale?.state).toBe('stale');
    expect(describeHolder(stale!, t)).toContain('STALE (alive, no heartbeat for');
    const sleeps: number[] = [];
    const err = await acquireVerifySlot(dir, {
      pid: 2,
      ...procs(table),
      now: () => t,
      log: () => {},
      sleep: async (ms) => void sleeps.push(ms),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerifySlotWaitError);
    expect(sleeps).toEqual([]); // fails fast, no waiting
    const msg = (err as Error).message;
    expect(msg).toContain('stale holder');
    expect(msg).toContain('exclusive pid 46461');
    expect(msg).toContain('task AISDLC-1392');
    expect(msg).toContain('not killed');
    // not reclaimed: the marker still names the stuck holder
    expect(readFileSync(join(dir, 'verify-slots', 'exclusive', 'pid'), 'utf8')).toBe('46461');
    expect(exclusiveHeld(dir, procs(table).isAlive, () => t, procs(table).startTimeOf)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an exclusive run refuses when a running slot holder is stale, and drops its marker', async () => {
    const dir = board();
    let t = 0;
    const table = { 10: 'a', 11: 'b' };
    await acquireVerifySlot(dir, { pid: 10, ...procs(table), now: () => t });
    t += VERIFY_SLOT_STALE_MS + 1;
    await expect(
      acquireVerifySlot(
        dir,
        { pid: 11, ...procs(table), now: () => t, log: () => {} },
        { exclusive: true },
      ),
    ).rejects.toThrow(/running verifies to finish is blocked by a stale holder/);
    expect(existsSync(join(dir, 'verify-slots', 'exclusive'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses at the wait limit naming slot, pid, command, task id and held-for', async () => {
    const dir = board();
    let t = 0;
    const table = { 7: 'Tue', 8: 'Wed', 9: 'Thu' };
    for (const pid of [7, 8]) {
      const s = await acquireVerifySlot(dir, {
        pid,
        ...procs(table),
        now: () => t,
        command: `verify ${pid}`,
        taskId: `AISDLC-${pid}`,
      });
      void s;
    }
    const logs: string[] = [];
    const err = await acquireVerifySlot(dir, {
      pid: 9,
      ...procs(table),
      now: () => t,
      log: (l) => logs.push(l),
      maxWaitMs: 120_000,
      pollMs: 10_000,
      sleep: async (ms) => {
        t += ms;
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VerifySlotWaitError);
    const msg = (err as Error).message;
    expect(msg).toContain('timed out after 2m 0s (limit 2m 0s) waiting for a free slot');
    expect(msg).toContain('slot-0 pid 7, started Tue, command "verify 7", task AISDLC-7');
    expect(msg).toContain('slot-1 pid 8');
    expect(msg).toContain('held for 2m 0s');
    expect((err as VerifySlotWaitError).holders.map((h) => h.pid)).toEqual([7, 8]);
    // the periodic wait log: start, then every 30 s with the elapsed time
    expect(logs.map((l) => /waiting (\S+(?: \S+s)?) /.exec(l)?.[1])).toEqual([
      '0s',
      '30s',
      '1m 0s',
      '1m 30s',
    ]);
    expect(logs[0]).toContain('slot-0 pid 7');
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes the wait limit from the environment', async () => {
    const dir = board();
    const table = { 3: 'a', 4: 'b' };
    await acquireVerifySlot(dir, { pid: 3, ...procs(table) }, { exclusive: true });
    process.env.AI_SDLC_VERIFY_SLOT_MAX_WAIT_MS = '1';
    try {
      let t = 0;
      await expect(
        acquireVerifySlot(dir, {
          pid: 4,
          ...procs(table),
          now: () => t,
          log: () => {},
          sleep: async () => void (t += 5),
        }),
      ).rejects.toThrow(/limit 0s/);
    } finally {
      delete process.env.AI_SDLC_VERIFY_SLOT_MAX_WAIT_MS;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('heartbeat leaves a slot that is no longer ours alone', async () => {
    const dir = board();
    const table = { 3: 'a', 4: 'b' };
    const mine = await acquireVerifySlot(dir, { pid: 3, ...procs(table) });
    mine.release();
    const theirs = await acquireVerifySlot(dir, { pid: 4, ...procs(table), now: () => 5 });
    mine.heartbeat();
    const rec = JSON.parse(
      readFileSync(join(dir, 'verify-slots', 'slot-0', 'holder.json'), 'utf8'),
    ) as { pid: number; heartbeatAt: number };
    expect(rec).toMatchObject({ pid: 4, heartbeatAt: 5 });
    theirs.release();
    mine.heartbeat(); // directory gone: best effort, no throw
    rmSync(dir, { recursive: true, force: true });
  });

  it('formats durations and reads a real process start time', () => {
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(250_000)).toBe('4m 10s');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h');
    if (process.platform !== 'win32') {
      expect(processStartTime(process.pid)).toEqual(expect.any(String));
      expect(processStartTime(process.pid)).toBe(processStartTime(process.pid));
    }
    expect(processStartTime(2 ** 30)).toBeNull();
  });

  it('describes pending and dead holders', () => {
    const dir = board();
    mkdirSync(join(dir, 'verify-slots', 'slot-0'), { recursive: true });
    mkdirSync(join(dir, 'verify-slots', 'slot-1'), { recursive: true });
    writeFileSync(join(dir, 'verify-slots', 'slot-1', 'pid'), '6');
    const [pending, dead] = inspectVerifySlots(dir, { isAlive: () => false });
    expect(pending?.state).toBe('pending');
    expect(describeHolder(pending!, Date.now())).toContain('slot-0 pid not yet written');
    expect(dead?.state).toBe('dead');
    expect(describeHolder(dead!, Date.now())).toContain('DEAD (reclaimed by the next caller)');
    rmSync(dir, { recursive: true, force: true });
  });
});
