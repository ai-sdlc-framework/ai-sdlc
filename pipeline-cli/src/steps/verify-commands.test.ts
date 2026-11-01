import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireVerifySlot, listVerifySlots } from '../runtime/verify-slots.js';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import {
  claimedGreenButRed,
  formatVerifyFeedback,
  recordDeveloperHonestyEvent,
  runVerifyCommands,
  verifyKeyFor,
  writeVerifyRunState,
} from './verify-commands.js';

const green = { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' } as const;

describe('runVerifyCommands', () => {
  it('records a red test with tail and keeps the developer claim', async () => {
    const fr = new FakeRunner().on(/pnpm test/, fail('boom\n'.repeat(100), 1));
    const run = await runVerifyCommands({
      commands: ['pnpm build', 'pnpm test', 'pnpm lint'],
      cwd: '/x',
      runner: fr.toRunner(),
      developerClaimed: green,
    });
    expect(run.ok).toBe(false);
    expect(run.failing?.command).toBe('pnpm test');
    expect(run.failing?.tail.split('\n')).toHaveLength(60);
    expect(run.verifications).toMatchObject({ build: 'passed', test: 'failed', lint: 'skipped' });
    expect(run.developerClaimed).toEqual(green);
    expect(claimedGreenButRed(run)).toBe(true);
    expect(formatVerifyFeedback(run)).toContain('pnpm test');
    expect(fr.calls).toHaveLength(2);
  });

  it('passes when all exit 0', async () => {
    const run = await runVerifyCommands({
      commands: ['pnpm build', 'pnpm format:check'],
      cwd: '/x',
      runner: new FakeRunner().on(/./, ok('fine')).toRunner(),
    });
    expect(run.ok).toBe(true);
    expect(run.verifications.format).toBe('passed');
    expect(claimedGreenButRed(run)).toBe(false);
    expect(formatVerifyFeedback(run)).toBe('');
  });

  it('skips docs-only', async () => {
    const run = await runVerifyCommands({ commands: [], cwd: '/x' });
    expect(run).toMatchObject({ ok: true, skipped: 'docs-only' });
  });

  it('enforces the per-command timeout', async () => {
    const run = await runVerifyCommands({
      commands: ['exec sleep 30'],
      cwd: tmpdir(),
      timeoutMs: 300,
    });
    expect(run.ok).toBe(false);
    expect(run.failing?.timedOut).toBe(true);
    expect(formatVerifyFeedback(run)).toContain('timed out');
  });

  it('maps commands to keys', () => {
    expect(verifyKeyFor('pnpm format:check')).toBe('format');
    expect(verifyKeyFor('echo hi')).toBeUndefined();
  });

  it('persists run state and honesty events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'));
    try {
      const run = await runVerifyCommands({
        commands: ['pnpm test'],
        cwd: '/x',
        runner: new FakeRunner().on(/./, fail('x')).toRunner(),
        developerClaimed: green,
      });
      writeVerifyRunState(dir, 'T-1', run);
      recordDeveloperHonestyEvent(dir, 'T-1', run);
      expect(JSON.parse(readFileSync(join(dir, 'verify-runs', 'T-1.json'), 'utf8')).ok).toBe(false);
      expect(
        readFileSync(join(dir, '.ai-sdlc', 'usage', 'developer-honesty.jsonl'), 'utf8'),
      ).toContain('developer-honesty');
      // unwritable target is swallowed
      writeVerifyRunState('/dev/null/x', 'T-1', run);
      recordDeveloperHonestyEvent('/dev/null/x', 'T-1', run);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verify slots (AISDLC-1087)', () => {
  it('limits to two concurrent runs and caps workers for the second', async () => {
    const board = mkdtempSync(join(tmpdir(), 'verify-slots-'));
    let active = 0;
    let peak = 0;
    const workers: (string | undefined)[] = [];
    const runner = async (_c: string, _a: string[], o?: { env?: NodeJS.ProcessEnv }) => {
      active++;
      peak = Math.max(peak, active);
      workers.push(o?.env?.AI_SDLC_VITEST_MAX_WORKERS);
      await new Promise((r) => setTimeout(r, 40));
      active--;
      return { stdout: 'ok', stderr: '', code: 0 };
    };
    const call = () =>
      runVerifyCommands({
        commands: ['pnpm test'],
        cwd: '/x',
        runner,
        boardDir: board,
        slotDeps: { pollMs: 5 },
      });
    const runs = await Promise.all([call(), call(), call()]);
    expect(runs.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(2);
    expect(workers.slice(0, 2)).toEqual(['4', '2']);
    expect(listVerifySlots(board)).toEqual([]);
    rmSync(board, { recursive: true, force: true });
  });

  it('reclaims a dead holder and leaves a live one', async () => {
    const board = mkdtempSync(join(tmpdir(), 'verify-slots-'));
    const dir = join(board, 'verify-slots');
    for (const [i, pid] of [
      [0, 111],
      [1, 222],
    ] as const) {
      mkdirSync(join(dir, `slot-${i}`), { recursive: true });
      writeFileSync(join(dir, `slot-${i}`, 'pid'), String(pid));
    }
    const slot = await acquireVerifySlot(board, {
      pid: 333,
      isAlive: (p) => p === 222 || p === 333,
      pollMs: 1,
    });
    expect(slot.index).toBe(0);
    expect(readFileSync(join(dir, 'slot-0', 'pid'), 'utf8')).toBe('333');
    expect(readFileSync(join(dir, 'slot-1', 'pid'), 'utf8')).toBe('222');
    expect(slot.workers).toBe(2);
    slot.release();
    expect(listVerifySlots(board, () => true).map((s) => s.index)).toEqual([1]);
    rmSync(board, { recursive: true, force: true });
  });
});
