import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HIERARCHY_SESSION_ENV_VARS } from '../hierarchy/session-env.js';
import { acquireVerifySlot, listVerifySlots } from '../runtime/verify-slots.js';
import { FakeRunner, fail, ok } from '../__test-helpers/fake-runner.js';
import {
  claimedGreenButRed,
  expandVerifyCommands,
  patchGateCommand,
  formatVerifyFeedback,
  recordDeveloperHonestyEvent,
  runVerifyCommands,
  parseTestFailures,
  verifyKeyFor,
  writeVerifyRunState,
} from './verify-commands.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const green = { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' } as const;

describe('runVerifyCommands', () => {
  it('spawns verify commands without the hierarchy session env (AISDLC-1153)', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of HIERARCHY_SESSION_ENV_VARS) {
      saved[k] = process.env[k];
      process.env[k] = 'leak';
    }
    try {
      const names = HIERARCHY_SESSION_ENV_VARS.map((k) => `\${${k}:-unset}`).join(' ');
      const run = await runVerifyCommands({ commands: [`echo ${names}`], cwd: tmpdir() });
      expect(run.ok).toBe(true);
      expect(run.results[0]!.tail.trim()).toBe(
        HIERARCHY_SESSION_ENV_VARS.map(() => 'unset').join(' '),
      );
    } finally {
      for (const k of HIERARCHY_SESSION_ENV_VARS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

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
    expect(fr.calls.filter((c) => c.command === 'sh')).toHaveLength(2);
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
      removeFixtureDir(dir);
    }
  });
});

const VITEST_OUT = [
  ' \u001b[31m FAIL \u001b[39m src/cli/attestation.test.ts > sign-v6 > reads digest',
  ' FAIL  src/cli/attestation.test.ts > sign-v6 > other',
  ' FAIL  [pipeline-cli] src/steps/11-push.test.ts',
  ' \u276f src/hierarchy/lease.test.ts (12 tests | 2 failed) 40ms',
  ' \u00d7 does a thing 3ms',
  ' \u2713 src/ok.test.ts (3 tests) 5ms',
].join('\n');

const NODE_OUT = [
  'TAP version 13',
  'ok 1 - fine',
  'not ok 2 - hook blocks push',
  'not ok 3 - other thing # SKIP',
].join('\n');

describe('parseTestFailures (AISDLC-1155)', () => {
  it('lists unique failing files from vitest output', () => {
    expect(parseTestFailures(VITEST_OUT)).toEqual([
      'src/cli/attestation.test.ts',
      'src/steps/11-push.test.ts',
      'src/hierarchy/lease.test.ts',
    ]);
  });

  it('lists failing test names from node --test output', () => {
    expect(parseTestFailures(NODE_OUT)).toEqual(['hook blocks push', 'other thing']);
  });

  it('is empty when nothing is recognisable', () => {
    expect(parseTestFailures('all good\n')).toEqual([]);
  });

  it('populates failures on a failing run and renders them before the tail', async () => {
    const fr = new FakeRunner().on(/pnpm test/, fail(VITEST_OUT, 1));
    const run = await runVerifyCommands({
      commands: ['pnpm test'],
      cwd: '/x',
      runner: fr.toRunner(),
    });
    expect(run.failing?.failures).toContain('src/cli/attestation.test.ts');
    const fb = formatVerifyFeedback(run);
    expect(fb.indexOf('src/cli/attestation.test.ts')).toBeLessThan(fb.indexOf('Last 60 lines'));
  });

  it('leaves failures empty for a passing run and a non-test command', async () => {
    const fr = new FakeRunner().on(/pnpm build/, fail('FAIL src/a.test.ts\n', 1));
    const run = await runVerifyCommands({
      commands: ['pnpm build'],
      cwd: '/x',
      runner: fr.toRunner(),
    });
    expect(run.failing?.failures).toEqual([]);
    expect(formatVerifyFeedback(run)).not.toContain('Failing tests:');
  });
});

describe('verify slots (AISDLC-1087)', () => {
  it('limits to two concurrent runs and caps workers for the second', async () => {
    const board = mkdtempSync(join(tmpdir(), 'verify-slots-'));
    let active = 0;
    let peak = 0;
    const workers: (string | undefined)[] = [];
    const runner = async (_c: string, _a: string[], o?: { env?: NodeJS.ProcessEnv }) => {
      if (_c !== 'sh') return { stdout: '', stderr: '', code: 0 };
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

describe('verify with coverage (AISDLC-1185)', () => {
  const defaults = ['pnpm build', 'pnpm test', 'pnpm lint', 'pnpm format:check'];
  const base = (fr: FakeRunner, packages: string[], statuses: string[] = ['']) => {
    let n = 0;
    return fr
      .on(/rev-parse HEAD\^\{tree\}/, ok('tree1\n'))
      .on(/rev-parse HEAD/, ok('head1\n'))
      .on(/status --porcelain/, () => ok(statuses[Math.min(n++, statuses.length - 1)]!))
      .on(/list-coverage-packages/, ok(JSON.stringify(packages) + '\n'));
  };
  const shellCmds = (fr: FakeRunner) =>
    fr.calls.filter((c) => c.command === 'sh').map((c) => c.args[1]);

  it('runs a touched package once under test:coverage, then root gates and the patch gate', async () => {
    const fr = base(new FakeRunner(), ['pipeline-cli']);
    const run = await runVerifyCommands({ commands: defaults, cwd: '/x', runner: fr.toRunner() });
    expect(run.ok).toBe(true);
    expect(shellCmds(fr)).toEqual(expandVerifyCommands(defaults, ['pipeline-cli'], 'head1'));
    expect(shellCmds(fr)).toEqual([
      'pnpm build',
      'pnpm --filter ./pipeline-cli test:coverage',
      "pnpm -r --no-bail --filter '!./pipeline-cli' test",
      expect.stringContaining('pnpm test:gates && pnpm rfc:check && pnpm dark-code:check'),
      patchGateCommand('head1'),
      'pnpm lint',
      'pnpm format:check',
    ]);
    expect(run.verifications.test).toBe('passed');
  });

  it('fails verify with the gate output when the patch gate fails', async () => {
    const fr = base(new FakeRunner(), ['pipeline-cli']).on(
      /check-pr-patch-coverage/,
      fail('patch coverage 40% < 90%', 1),
    );
    const run = await runVerifyCommands({ commands: defaults, cwd: '/x', runner: fr.toRunner() });
    expect(run.ok).toBe(false);
    expect(run.failing?.command).toBe(patchGateCommand('head1'));
    expect(formatVerifyFeedback(run)).toContain('patch coverage 40% < 90%');
    expect(shellCmds(fr)).not.toContain('pnpm lint');
  });

  it('keeps the plain commands and skips the gate when no package is touched', async () => {
    const fr = base(new FakeRunner(), []);
    await runVerifyCommands({ commands: defaults, cwd: '/x', runner: fr.toRunner() });
    expect(shellCmds(fr)).toEqual(defaults);
  });

  it('records head, tree, clean and finishedAt', async () => {
    const fr = base(new FakeRunner(), []);
    const run = await runVerifyCommands({
      commands: ['pnpm lint'],
      cwd: '/x',
      runner: fr.toRunner(),
    });
    expect(run).toMatchObject({ headSha: 'head1', treeSha: 'tree1', clean: true });
    expect(typeof run.finishedAt).toBe('string');
  });

  it('marks clean false when the worktree changed during the run', async () => {
    const fr = base(new FakeRunner(), [], ['', ' M a.ts']);
    const run = await runVerifyCommands({
      commands: ['pnpm lint'],
      cwd: '/x',
      runner: fr.toRunner(),
    });
    expect(run.clean).toBe(false);
  });

  it('falls back to unchanged commands when the package list is unreadable', async () => {
    const fr = base(new FakeRunner(), []).on(/list-coverage-packages/, fail('nope', 1));
    await runVerifyCommands({ commands: defaults, cwd: '/x', runner: fr.toRunner() });
    expect(shellCmds(fr)).toEqual(defaults);
  });
});
