import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireVerifySlot } from './verify-slots.js';

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
