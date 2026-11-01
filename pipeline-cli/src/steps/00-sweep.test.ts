/**
 * Tests for Step 0 — sweepMergedWorktrees + listPrStatesByBranch.
 *
 * AISDLC-204: `--state all` so squash-merged PRs with deleted source branches
 * are found. AISDLC-958: one batched `gh pr list` per sweep (never one per
 * worktree) plus an on-disk cache of landed/closed branches.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sweepMergedWorktrees, listPrStatesByBranch, SWEEP_CACHE_FILE } from './00-sweep.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, ok, fail as fakeRunnerFail } from '../__test-helpers/fake-runner.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

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

/** Runner where worktree dir `<name>` has branch `branch-of(name)` and sha `sha-<name>`. */
function wtRunner(prs: Pr[], ghCalls?: string[][]) {
  return new FakeRunner()
    .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, (args) =>
      ok(`ai-sdlc/${(args[1] ?? '').split('/').pop()}\n`),
    )
    .on(/^git -C .+ rev-parse HEAD/, (args) => ok(`sha-${(args[1] ?? '').split('/').pop()}\n`))
    .on(/^git -C .+ status --porcelain/, ok(''))
    .on(/^git worktree remove/, ok())
    .on(/^gh pr list/, (args) => {
      ghCalls?.push(args);
      return list(...prs);
    })
    .on(/^gh run list/, ok('[]'));
}

const mk = (name: string) => mkdirSync(join(tmp, '.worktrees', name), { recursive: true });
const cachePath = () => join(tmp, SWEEP_CACHE_FILE);

describe('listPrStatesByBranch', () => {
  it('one batched call with --state all, matched by headRefName', async () => {
    const calls: string[][] = [];
    const fake = new FakeRunner().on(/^gh pr list/, (args) => {
      calls.push(args);
      return list(pr(1, 'MERGED', 'a', '2026-05-05T12:00:00Z'), pr(2, 'OPEN', 'b'));
    });
    const m = await listPrStatesByBranch(tmp, fake.toRunner());
    expect(calls).toHaveLength(1);
    expect(calls[0]![calls[0]!.indexOf('--state') + 1]).toBe('all');
    expect(calls[0]).not.toContain('--head');
    expect(m?.get('a')).toEqual({ state: 'MERGED', mergedAt: '2026-05-05T12:00:00Z' });
    expect(m?.get('b')?.state).toBe('OPEN');
    expect(m?.get('c')).toBeUndefined();
  });

  it('prefers an OPEN PR, else the newest, for a branch with several PRs', async () => {
    const fake = new FakeRunner().on(
      /^gh pr list/,
      list(
        pr(5, 'MERGED', 'x', 't'),
        pr(9, 'OPEN', 'x'),
        pr(7, 'CLOSED', 'x'),
        pr(3, 'CLOSED', 'y'),
        pr(4, 'MERGED', 'y', 't'),
        pr(2, 'CLOSED', 'y'),
      ),
    );
    const m = await listPrStatesByBranch(tmp, fake.toRunner());
    expect(m?.get('x')?.state).toBe('OPEN');
    expect(m?.get('y')?.state).toBe('MERGED');
  });

  it('returns null on gh failure, empty map on empty output', async () => {
    expect(
      await listPrStatesByBranch(
        tmp,
        new FakeRunner().on(/^gh pr list/, fakeRunnerFail('auth', 1)).toRunner(),
      ),
    ).toBeNull();
    expect(
      (await listPrStatesByBranch(tmp, new FakeRunner().on(/^gh pr list/, ok('null')).toRunner()))
        ?.size,
    ).toBe(0);
    expect(
      await listPrStatesByBranch(tmp, new FakeRunner().on(/^gh pr list/, ok('{bad')).toRunner()),
    ).toBeNull();
  });
});

describe('Step 0 — sweepMergedWorktrees', () => {
  it('returns empty when .worktrees does not exist', async () => {
    const result = await sweepMergedWorktrees({ workDir: '/nonexistent/path/abcdef' });
    expect(result.swept).toEqual([]);
  });

  it('skips OPEN, no-PR and CLOSED worktrees', async () => {
    mk('wt-open');
    mk('wt-none');
    mk('wt-closed');
    const fake = wtRunner([pr(1, 'OPEN', 'ai-sdlc/wt-open'), pr(2, 'CLOSED', 'ai-sdlc/wt-closed')]);
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

  // AISDLC-256 dirty-worktree guard
  it('dirty worktree: skips removal when status --porcelain has changes', async () => {
    mk('dirty');
    let removed = false;
    const dedicated = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/dirty\n'))
      .on(/^git -C .+ rev-parse HEAD/, ok('sha\n'))
      .on(/^gh pr list/, list(pr(9, 'MERGED', 'ai-sdlc/dirty', 't')))
      .on(/^git -C .+ status --porcelain/, ok(' M src/file.ts\n'))
      .on(/^git worktree remove/, () => {
        removed = true;
        return ok();
      });
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: dedicated.toRunner() });
    expect(result.swept).toEqual([]);
    expect(removed).toBe(false);
  });

  it('status check failure: skips removal conservatively', async () => {
    mk('status-err');
    let removed = false;
    const fake = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/status-err\n'))
      .on(/^gh pr list/, list(pr(9, 'MERGED', 'ai-sdlc/status-err', 't')))
      .on(/^git -C .+ status --porcelain/, fakeRunnerFail('fatal', 128))
      .on(/^git worktree remove/, () => {
        removed = true;
        return ok();
      });
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
    expect(removed).toBe(false);
  });
});

describe('Step 0 — batched query and landed cache (AISDLC-958)', () => {
  it('80 worktrees cost at most one gh pr list call', async () => {
    const prs: Pr[] = [];
    for (let i = 0; i < 80; i++) {
      mk(`wt-${i}`);
      prs.push(pr(i + 1, i % 2 ? 'OPEN' : 'MERGED', `ai-sdlc/wt-${i}`, i % 2 ? null : 't'));
    }
    const ghCalls: string[][] = [];
    const fake = wtRunner(prs, ghCalls);
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(ghCalls).toHaveLength(1);
    expect(result.swept).toHaveLength(40);
  });

  it('a second run with every worktree cached as closed makes zero gh pr list calls', async () => {
    for (let i = 0; i < 80; i++) mk(`wt-${i}`);
    const prs = Array.from({ length: 80 }, (_, i) => pr(i + 1, 'CLOSED', `ai-sdlc/wt-${i}`));
    const ghCalls: string[][] = [];
    await sweepMergedWorktrees({ workDir: tmp, runner: wtRunner(prs, ghCalls).toRunner() });
    expect(ghCalls).toHaveLength(1);
    expect(Object.keys(JSON.parse(readFileSync(cachePath(), 'utf8')))).toHaveLength(80);

    await sweepMergedWorktrees({ workDir: tmp, runner: wtRunner(prs, ghCalls).toRunner() });
    expect(ghCalls).toHaveLength(1); // no second call
  });

  it('OPEN and no-PR branches are never cached and are re-queried', async () => {
    mk('o');
    const ghCalls: string[][] = [];
    const prs = [pr(1, 'OPEN', 'ai-sdlc/o')];
    await sweepMergedWorktrees({ workDir: tmp, runner: wtRunner(prs, ghCalls).toRunner() });
    await sweepMergedWorktrees({ workDir: tmp, runner: wtRunner(prs, ghCalls).toRunner() });
    expect(ghCalls).toHaveLength(2);
    expect(existsSync(cachePath())).toBe(false);
  });

  it('removed worktrees drop out of the cache', async () => {
    mk('keep');
    mk('gone');
    const prs = [pr(1, 'CLOSED', 'ai-sdlc/keep'), pr(2, 'CLOSED', 'ai-sdlc/gone')];
    await sweepMergedWorktrees({ workDir: tmp, runner: wtRunner(prs).toRunner() });
    expect(Object.keys(JSON.parse(readFileSync(cachePath(), 'utf8'))).sort()).toEqual([
      'ai-sdlc/gone',
      'ai-sdlc/keep',
    ]);
    // Operator removes the 'gone' worktree directory.
    removeFixtureDir(join(tmp, '.worktrees', 'gone'));
    await sweepMergedWorktrees({ workDir: tmp, runner: wtRunner(prs).toRunner() });
    expect(Object.keys(JSON.parse(readFileSync(cachePath(), 'utf8')))).toEqual(['ai-sdlc/keep']);
  });

  it('merged branches swept this run are removed from the cache', async () => {
    mk('m');
    const prs = [pr(1, 'MERGED', 'ai-sdlc/m', 't')];
    await sweepMergedWorktrees({ workDir: tmp, runner: wtRunner(prs).toRunner() });
    expect(existsSync(cachePath())).toBe(false);
  });

  it('a branch whose HEAD moved (new PR) is re-queried despite a cache entry', async () => {
    mk('r');
    const ghCalls: string[][] = [];
    await sweepMergedWorktrees({
      workDir: tmp,
      runner: wtRunner([pr(1, 'CLOSED', 'ai-sdlc/r')], ghCalls).toRunner(),
    });
    // New commit on the branch and a new OPEN PR.
    const moved = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/r\n'))
      .on(/^git -C .+ rev-parse HEAD/, ok('new-sha\n'))
      .on(/^gh pr list/, (a) => {
        ghCalls.push(a);
        return list(pr(1, 'CLOSED', 'ai-sdlc/r'), pr(2, 'OPEN', 'ai-sdlc/r'));
      });
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: moved.toRunner() });
    expect(ghCalls).toHaveLength(2);
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
