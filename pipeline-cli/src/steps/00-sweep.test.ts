/**
 * Tests for Step 0 — sweepMergedWorktrees + listPrStatesByBranch.
 *
 * AISDLC-204: `--state all` so squash-merged PRs with deleted source branches
 * are found. AISDLC-958: one batched `gh pr list` per sweep (never one per
 * worktree) plus an on-disk cache of landed/closed branches.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sweepMergedWorktrees,
  lookupPrForBranch,
  sweepDue,
  SWEEP_CACHE_FILE,
  SWEEP_STATUS_FILE,
} from './00-sweep.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, ok, fail as fakeRunnerFail } from '../__test-helpers/fake-runner.js';

let tmp: string;

beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

type Pr = { number: number; state: string; headRefName: string; mergedAt: string | null };
const pr = (number: number, state: string, headRefName: string, mergedAt: string | null = null) =>
  ({ number, state, headRefName, mergedAt }) as Pr;
const list = (...prs: Pr[]) => ok(JSON.stringify(prs));

/** Runner where worktree dir `<name>` has branch `ai-sdlc/<name>` and sha `sha-<name>`. */
function wtRunner(prs: Pr[], ghCalls?: string[][], pre?: (f: FakeRunner) => void) {
  const fake = new FakeRunner();
  pre?.(fake);
  return fake
    .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, (args) =>
      ok(`ai-sdlc/${(args[1] ?? '').split('/').pop()}\n`),
    )
    .on(/^git -C .+ rev-parse HEAD/, (args) => ok(`sha-${(args[1] ?? '').split('/').pop()}\n`))
    .on(/^git -C .+ status --porcelain/, ok(''))
    .on(/^git -C .+ log -1/, ok(`${Math.floor(Date.now() / 1000)}\n`))
    .on(/^git worktree remove/, ok())
    .on(/^gh pr list/, (args) => {
      ghCalls?.push(args);
      const head = args[args.indexOf('--head') + 1];
      return list(...prs.filter((p) => p.headRefName === head));
    })
    .on(/^gh run list/, ok('[]'));
}

/** Backdate a directory so the no-PR grace window has passed. */
const age = (name: string, hours: number) => {
  const t = new Date(Date.now() - hours * 3_600_000);
  utimesSync(join(tmp, '.worktrees', name), t, t);
};

const mk = (name: string) => mkdirSync(join(tmp, '.worktrees', name), { recursive: true });
const cachePath = () => join(tmp, SWEEP_CACHE_FILE);

describe('lookupPrForBranch', () => {
  it('queries one branch with --head and --state all', async () => {
    const calls: string[][] = [];
    const fake = new FakeRunner().on(/^gh pr list/, (args) => {
      calls.push(args);
      return list(pr(1, 'MERGED', 'a', '2026-05-05T12:00:00Z'));
    });
    const m = await lookupPrForBranch(tmp, 'a', fake.toRunner());
    expect(calls[0]![calls[0]!.indexOf('--head') + 1]).toBe('a');
    expect(calls[0]![calls[0]!.indexOf('--state') + 1]).toBe('all');
    expect(m).toEqual({ state: 'MERGED', mergedAt: '2026-05-05T12:00:00Z' });
  });

  it('prefers an OPEN PR, else the newest, for a branch with several PRs', async () => {
    const open = new FakeRunner().on(
      /^gh pr list/,
      list(pr(5, 'MERGED', 'x', 't'), pr(9, 'OPEN', 'x'), pr(7, 'CLOSED', 'x')),
    );
    expect((await lookupPrForBranch(tmp, 'x', open.toRunner()))?.state).toBe('OPEN');
    const newest = new FakeRunner().on(
      /^gh pr list/,
      list(pr(3, 'CLOSED', 'y'), pr(4, 'MERGED', 'y', 't'), pr(2, 'CLOSED', 'y')),
    );
    expect((await lookupPrForBranch(tmp, 'y', newest.toRunner()))?.state).toBe('MERGED');
  });

  it('returns null on gh failure or bad json, no-PR on empty output', async () => {
    const run = (r: ReturnType<typeof ok>) =>
      lookupPrForBranch(tmp, 'b', new FakeRunner().on(/^gh pr list/, r).toRunner());
    expect(await run(fakeRunnerFail('auth', 1))).toBeNull();
    expect(await run(ok('{bad'))).toBeNull();
    expect(await run(ok('null'))).toEqual({ state: null, mergedAt: null });
    expect(await run(ok('[]'))).toEqual({ state: null, mergedAt: null });
  });
});

describe('Step 0 — sweepMergedWorktrees', () => {
  it('returns empty when .worktrees does not exist', async () => {
    const result = await sweepMergedWorktrees({ workDir: '/nonexistent/path/abcdef' });
    expect(result.swept).toEqual([]);
  });

  it('keeps OPEN-PR worktrees and no-PR worktrees inside the grace window', async () => {
    mk('wt-open');
    mk('wt-none');
    const fake = wtRunner([pr(1, 'OPEN', 'ai-sdlc/wt-open')]);
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
  });

  it('removes a CLOSED-unmerged worktree and a no-PR worktree past the grace window', async () => {
    mk('wt-closed');
    mk('wt-none');
    mk('wt-fresh');
    age('wt-none', 7);
    const fake = wtRunner([pr(2, 'CLOSED', 'ai-sdlc/wt-closed')]);
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept.map((s) => [s.taskId, s.disposition]).sort()).toEqual([
      ['wt-closed', 'remove-closed'],
      ['wt-none', 'remove-no-pr'],
    ]);
  });

  it('removes an OPEN-PR worktree whose head is older than the stale window', async () => {
    mk('wt-old');
    const old = Math.floor(Date.now() / 1000) - 15 * 86400;
    const fake = wtRunner([pr(3, 'OPEN', 'ai-sdlc/wt-old')], undefined, (f) =>
      f.on(/^git -C .+ log -1/, ok(`${old}\n`)),
    );
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept[0]?.disposition).toBe('remove-stale');
  });

  it('never removes inflight or fresh-sentinel worktrees, even when merged or closed', async () => {
    mk('aisdlc-5');
    mk('wt-sentinel');
    mk('wt-old-sentinel');
    mkdirSync(join(tmp, '.ai-sdlc', 'dispatch', 'inflight'), { recursive: true });
    writeFileSync(join(tmp, '.ai-sdlc', 'dispatch', 'inflight', 'AISDLC-5.dispatch.json'), '{}');
    writeFileSync(join(tmp, '.worktrees', 'wt-sentinel', '.active-task'), 'x');
    writeFileSync(join(tmp, '.worktrees', 'wt-old-sentinel', '.active-task'), 'x');
    const t = new Date(Date.now() - 30 * 3_600_000);
    utimesSync(join(tmp, '.worktrees', 'wt-old-sentinel', '.active-task'), t, t);
    const ghCalls: string[][] = [];
    const fake = wtRunner(
      [
        pr(1, 'MERGED', 'ai-sdlc/aisdlc-5', 't'),
        pr(2, 'CLOSED', 'ai-sdlc/wt-sentinel'),
        pr(3, 'CLOSED', 'ai-sdlc/wt-old-sentinel'),
      ],
      ghCalls,
    );
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept.map((s) => s.taskId)).toEqual(['wt-old-sentinel']);
    expect(ghCalls).toHaveLength(1);
  });

  it('classifies a PR older than the 200 most recent by a per-branch lookup', async () => {
    mk('ancient');
    const calls: string[][] = [];
    const fake = wtRunner([pr(7, 'MERGED', 'ai-sdlc/ancient', '2024-01-01T00:00:00Z')], calls);
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept[0]?.disposition).toBe('remove-merged');
    expect(calls[0]).toContain('--head');
    expect(calls[0]).not.toContain('200');
  });

  it('a failed PR lookup keeps the worktree (never read as no PR)', async () => {
    mk('flaky');
    age('flaky', 100);
    const fake = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/flaky\n'))
      .on(/^gh pr list/, fakeRunnerFail('rate limited', 1));
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
  });

  it('skips detached HEAD worktrees', async () => {
    mk('detached');
    const fake = new FakeRunner().on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('HEAD\n'));
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
    expect(fake.calls.some((c) => c.command === 'gh')).toBe(false);
  });

  it('removes squash-merged worktrees (AISDLC-204)', async () => {
    mk('aisdlc-204');
    const fake = wtRunner([pr(328, 'MERGED', 'ai-sdlc/aisdlc-204', '2026-05-05T12:00:00Z')]);
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0]?.branch).toBe('ai-sdlc/aisdlc-204');
    expect(result.swept[0]?.mergedAt).toBe('2026-05-05T12:00:00Z');
  });

  it('handles non-zero git exit by skipping the entry silently', async () => {
    mk('broken');
    const fake = new FakeRunner().on(/^git -C .+ rev-parse --abbrev-ref HEAD/, {
      stdout: '',
      stderr: 'fatal: not a git repository',
      code: 128,
    });
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
  });

  it('gh failure: nothing swept, nothing cached', async () => {
    mk('a');
    const failing = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/a\n'))
      .on(/^gh pr list/, fakeRunnerFail('boom', 1));
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: failing.toRunner() });
    expect(result.swept).toEqual([]);
    expect(existsSync(cachePath())).toBe(false);
  });

  it('sweeps multiple merged worktrees in a single pass', async () => {
    mk('aisdlc-10');
    mk('aisdlc-11');
    mk('aisdlc-12');
    const fake = wtRunner([
      pr(10, 'MERGED', 'ai-sdlc/aisdlc-10', '2026-05-01T00:00:00Z'),
      pr(11, 'MERGED', 'ai-sdlc/aisdlc-11', '2026-05-02T00:00:00Z'),
      pr(12, 'OPEN', 'ai-sdlc/aisdlc-12'),
    ]);
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept.map((s) => s.branch).sort()).toEqual([
      'ai-sdlc/aisdlc-10',
      'ai-sdlc/aisdlc-11',
    ]);
  });

  it('dirty merged worktree: logs the untracked paths and removes with --force', async () => {
    mk('dirty');
    const removeCalls: string[][] = [];
    const fake = wtRunner([pr(9, 'MERGED', 'ai-sdlc/dirty', 't')], undefined, (f) =>
      f
        .on(/^git -C .+ status --porcelain/, ok(' M src/file.ts\n?? out/build.js\n'))
        .on(/^git worktree remove/, (a) => {
          removeCalls.push(a);
          return ok();
        }),
    );
    const info: string[] = [];
    const result = await sweepMergedWorktrees({
      workDir: tmp,
      runner: fake.toRunner(),
      logger: { info: (m) => info.push(m), warn: () => undefined },
    });
    expect(result.swept).toHaveLength(1);
    expect(removeCalls[0]).toContain('--force');
    expect(info.join('\n')).toContain('?? out/build.js');
  });

  it('refused removal falls back to rm -rf + prune and is reported', async () => {
    mk('stuck');
    const fake = wtRunner([pr(9, 'MERGED', 'ai-sdlc/stuck', 't')], undefined, (f) =>
      f.on(/^git worktree remove/, fakeRunnerFail('fatal: cannot remove', 128)),
    );
    const warns: string[] = [];
    const result = await sweepMergedWorktrees({
      workDir: tmp,
      runner: fake.toRunner(),
      logger: { info: () => undefined, warn: (m) => warns.push(m) },
    });
    expect(result.swept).toHaveLength(1);
    expect(existsSync(join(tmp, '.worktrees', 'stuck'))).toBe(false);
    expect(fake.calls.some((c) => c.args.join(' ') === 'worktree prune')).toBe(true);
    expect(warns.join('\n')).toContain('fell back to rm -rf');
  });

  it('a removal that fails both ways is reported and not counted as swept', async () => {
    mkdirSync(join(tmp, '.git'));
    mk('doomed');
    const fake = wtRunner([pr(9, 'CLOSED', 'ai-sdlc/doomed')], undefined, (f) =>
      f.on(/^git worktree remove/, fakeRunnerFail('fatal', 128)).on(/^git worktree prune/, () => {
        mk('doomed'); // the directory reappears after rm -rf
        return ok();
      }),
    );
    const result = await sweepMergedWorktrees({
      workDir: tmp,
      runner: fake.toRunner(),
      logger: { info: () => undefined, warn: () => undefined },
    });
    expect(result.swept).toEqual([]);
    expect(result.failed).toHaveLength(1);
    const rec = JSON.parse(readFileSync(join(tmp, SWEEP_STATUS_FILE), 'utf8'));
    expect(rec).toMatchObject({ count: 1, removable: 1 });
  });

  it('dry run classifies without removing or writing a status file', async () => {
    mk('dry');
    const fake = wtRunner([pr(9, 'MERGED', 'ai-sdlc/dry', 't')]);
    const result = await sweepMergedWorktrees({
      workDir: tmp,
      runner: fake.toRunner(),
      dryRun: true,
    });
    expect(result.swept).toHaveLength(1);
    expect(fake.calls.some((c) => c.args.join(' ').startsWith('worktree remove'))).toBe(false);
    expect(existsSync(join(tmp, SWEEP_STATUS_FILE))).toBe(false);
  });
});

describe('sweepDue', () => {
  it('is always true for every tick, else the first of every N', () => {
    expect(sweepDue(tmp, 1)).toBe(true);
    expect(sweepDue(tmp, 2)).toBe(true); // no .git: cannot count, sweeps every tick
    mkdirSync(join(tmp, '.git'));
    expect([1, 2, 3, 4].map(() => sweepDue(tmp, 2))).toEqual([true, false, true, false]);
  });
});

describe('Step 0 — per-branch lookup and landed cache (AISDLC-958, AISDLC-1108)', () => {
  it('one gh pr list call per uninflight worktree branch, none for known-open branches', async () => {
    for (let i = 0; i < 6; i++) mk(`wt-${i}`);
    const ghCalls: string[][] = [];
    const fake = wtRunner([], ghCalls);
    await sweepMergedWorktrees({
      workDir: tmp,
      runner: fake.toRunner(),
      knownOpenBranches: new Set(['ai-sdlc/wt-0', 'ai-sdlc/wt-1']),
    });
    expect(ghCalls).toHaveLength(4);
  });

  it('a landed branch whose removal failed is served from the cache on the next run', async () => {
    mk('c1');
    const ghCalls: string[][] = [];
    const prs = [pr(1, 'CLOSED', 'ai-sdlc/c1')];
    const stuck = () =>
      wtRunner(prs, ghCalls, (f) =>
        f.on(/^git worktree remove/, fakeRunnerFail('busy', 1)).on(/^git worktree prune/, () => {
          mk('c1');
          return ok();
        }),
      );
    const quiet = { info: () => undefined, warn: () => undefined };
    await sweepMergedWorktrees({ workDir: tmp, runner: stuck().toRunner(), logger: quiet });
    expect(ghCalls).toHaveLength(1);
    expect(Object.keys(JSON.parse(readFileSync(cachePath(), 'utf8')))).toEqual(['ai-sdlc/c1']);
    await sweepMergedWorktrees({ workDir: tmp, runner: stuck().toRunner(), logger: quiet });
    expect(ghCalls).toHaveLength(1);
  });

  it('removed worktrees leave no cache entry; OPEN branches are never cached', async () => {
    mk('m');
    mk('o');
    await sweepMergedWorktrees({
      workDir: tmp,
      runner: wtRunner([pr(1, 'MERGED', 'ai-sdlc/m', 't'), pr(2, 'OPEN', 'ai-sdlc/o')]).toRunner(),
    });
    expect(existsSync(cachePath())).toBe(false);
  });

  it('a branch whose HEAD moved is re-queried despite a cache entry', async () => {
    mk('r');
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(
      cachePath(),
      JSON.stringify({ 'ai-sdlc/r': { state: 'CLOSED', mergedAt: null, headSha: 'old-sha' } }),
    );
    const ghCalls: string[][] = [];
    const result = await sweepMergedWorktrees({
      workDir: tmp,
      runner: wtRunner([pr(2, 'OPEN', 'ai-sdlc/r')], ghCalls).toRunner(),
    });
    expect(ghCalls).toHaveLength(1);
    expect(result.swept).toEqual([]);
    expect(JSON.parse(readFileSync(cachePath(), 'utf8'))).toEqual({});
  });

  it('a corrupt cache file is ignored', async () => {
    mk('c');
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    writeFileSync(cachePath(), '{not json');
    const ghCalls: string[][] = [];
    await sweepMergedWorktrees({
      workDir: tmp,
      runner: wtRunner([pr(1, 'CLOSED', 'ai-sdlc/c')], ghCalls).toRunner(),
    });
    expect(ghCalls).toHaveLength(1);
  });
});
