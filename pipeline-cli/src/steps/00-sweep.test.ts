/**
 * Tests for Step 0 — sweepMergedWorktrees + lookupPrState.
 *
 * Coverage:
 *   (a) merged-with-deleted-branch case (squash-merged, --state all returns MERGED)
 *   (b) still-open PR case (state=OPEN — must NOT sweep)
 *   (c) no PR exists case (gh returns null — must NOT sweep)
 *   (d) detached HEAD case (branch=HEAD — must NOT sweep)
 *   (e) CLOSED (abandoned) PR — must NOT sweep (only MERGED sweeps)
 *   (f) non-zero git exit — skip silently
 *   (g) no .worktrees directory — return empty
 *   (h) PR lookup network failure (gh exits non-zero) — skip silently
 *
 * AISDLC-204: The sweep now uses `--state all` so squash-merged PRs with
 * deleted source branches (the normal case on this repo) are correctly
 * identified as merged via the `state` field rather than the empty array
 * returned by the old `--state merged` query.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sweepMergedWorktrees, lookupPrState } from './00-sweep.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import { FakeRunner, ok, fail as fakeRunnerFail } from '../__test-helpers/fake-runner.js';

let tmp: string;

beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

// ── lookupPrState unit tests ──────────────────────────────────────────

describe('lookupPrState (AISDLC-204 helper)', () => {
  it('(a) squash-merged with deleted branch: --state all returns MERGED state', async () => {
    // This simulates the root cause: after squash-merge + branch deletion,
    // `gh pr list --head <branch> --state merged` would return [] (the old
    // broken behaviour). The new query uses `--state all` which still finds
    // the PR via its head ref association. The API returns state=MERGED.
    const fake = new FakeRunner().on(
      /^gh pr list --head ai-sdlc\/aisdlc-204-test --state all/,
      ok(JSON.stringify({ number: 328, state: 'MERGED', mergedAt: '2026-05-05T12:00:00Z' })),
    );
    const { state, mergedAt } = await lookupPrState(
      'ai-sdlc/aisdlc-204-test',
      tmp,
      fake.toRunner(),
    );
    expect(state).toBe('MERGED');
    expect(mergedAt).toBe('2026-05-05T12:00:00Z');
  });

  it('(b) still-open PR: state=OPEN — must return OPEN, not MERGED', async () => {
    const fake = new FakeRunner().on(
      /^gh pr list/,
      ok(JSON.stringify({ number: 400, state: 'OPEN', mergedAt: null })),
    );
    const { state, mergedAt } = await lookupPrState(
      'ai-sdlc/aisdlc-in-flight',
      tmp,
      fake.toRunner(),
    );
    expect(state).toBe('OPEN');
    expect(mergedAt).toBeNull();
  });

  it('(c) no PR exists: gh returns null — state is null', async () => {
    const fake = new FakeRunner().on(/^gh pr list/, ok('null'));
    const { state, mergedAt } = await lookupPrState('ai-sdlc/aisdlc-no-pr', tmp, fake.toRunner());
    expect(state).toBeNull();
    expect(mergedAt).toBeNull();
  });

  it('(e) CLOSED (abandoned) PR: state=CLOSED — must return CLOSED, not MERGED', async () => {
    const fake = new FakeRunner().on(
      /^gh pr list/,
      ok(JSON.stringify({ number: 300, state: 'CLOSED', mergedAt: null })),
    );
    const { state } = await lookupPrState('ai-sdlc/abandoned-work', tmp, fake.toRunner());
    expect(state).toBe('CLOSED');
  });

  it('(h) gh exits non-zero: returns null state (network/auth failure)', async () => {
    const fake = new FakeRunner().on(/^gh pr list/, fakeRunnerFail('auth failed', 1));
    const { state } = await lookupPrState('ai-sdlc/any-branch', tmp, fake.toRunner());
    expect(state).toBeNull();
  });

  it('passes --state all so the query works with deleted source branches', async () => {
    const calls: string[][] = [];
    const fake = new FakeRunner().on(/^gh pr list/, (args) => {
      calls.push(args);
      return ok('null');
    });
    await lookupPrState('some/branch', tmp, fake.toRunner());
    expect(calls).toHaveLength(1);
    // Verify --state all is present (not --state merged)
    expect(calls[0]).toContain('all');
    expect(calls[0]).toContain('--state');
    const stateIdx = calls[0].indexOf('--state');
    expect(calls[0][stateIdx + 1]).toBe('all');
  });
});

// ── sweepMergedWorktrees integration tests ────────────────────────────

describe('Step 0 — sweepMergedWorktrees', () => {
  it('(g) returns empty when .worktrees does not exist', async () => {
    const result = await sweepMergedWorktrees({ workDir: '/nonexistent/path/abcdef' });
    expect(result.swept).toEqual([]);
  });

  it('(b) skips worktrees with still-open PR (state=OPEN)', async () => {
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-1'), { recursive: true });
    const fake = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/aisdlc-1-test\n'))
      .on(/^gh pr list/, ok(JSON.stringify({ number: 1, state: 'OPEN', mergedAt: null })));

    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
  });

  it('(c) skips worktrees with no PR (gh returns null)', async () => {
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-2'), { recursive: true });
    const fake = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/aisdlc-2-test\n'))
      .on(/^gh pr list/, ok('null'));

    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
  });

  it('(d) skips detached HEAD worktrees (branch === "HEAD")', async () => {
    mkdirSync(join(tmp, '.worktrees', 'detached'), { recursive: true });
    const fake = new FakeRunner().on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('HEAD\n'));

    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
  });

  it('(a) removes worktrees whose PR is squash-merged (state=MERGED, deleted source branch)', async () => {
    // This is the primary regression test for AISDLC-204. The worktree's
    // branch has been deleted from the remote after squash-merge. The old
    // `--state merged` query would return [] (empty) for this case. The new
    // `--state all` query returns the PR with state=MERGED.
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-204'), { recursive: true });
    const fake = new FakeRunner()
      .on(
        /^git -C .+ rev-parse --abbrev-ref HEAD/,
        ok('ai-sdlc/aisdlc-204-step-0-worktree-sweep\n'),
      )
      .on(
        /^gh pr list/,
        ok(JSON.stringify({ number: 328, state: 'MERGED', mergedAt: '2026-05-05T12:00:00Z' })),
      )
      .on(/^git worktree remove/, ok());

    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0]?.branch).toBe('ai-sdlc/aisdlc-204-step-0-worktree-sweep');
    expect(result.swept[0]?.mergedAt).toBe('2026-05-05T12:00:00Z');
  });

  it('(e) does NOT remove CLOSED (abandoned) worktrees — operator-only cleanup', async () => {
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-abandoned'), { recursive: true });
    const fake = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/aisdlc-abandoned\n'))
      .on(/^gh pr list/, ok(JSON.stringify({ number: 200, state: 'CLOSED', mergedAt: null })));

    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
  });

  it('uses --state all in the gh pr list call (regression guard for AISDLC-204)', async () => {
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-3'), { recursive: true });
    const calls: Array<{ command: string; args: string[] }> = [];
    const fake = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/aisdlc-3-test\n'))
      .on(/^gh/, (args) => {
        calls.push({ command: 'gh', args });
        return ok('null');
      });

    await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });

    const ghCalls = calls.filter((c) => c.command === 'gh');
    expect(ghCalls.length).toBeGreaterThan(0);
    // The --state all arg must be present; --state merged must NOT be present
    const allArgs = ghCalls.flatMap((c) => c.args);
    const stateIdx = allArgs.indexOf('--state');
    expect(stateIdx).toBeGreaterThan(-1);
    expect(allArgs[stateIdx + 1]).toBe('all');
    // Belt-and-braces: never use the old broken value
    expect(allArgs).not.toContain('merged');
  });

  it('(f) handles non-zero git exit by skipping the entry silently', async () => {
    mkdirSync(join(tmp, '.worktrees', 'broken'), { recursive: true });
    const fake = new FakeRunner().on(/^git -C .+ rev-parse --abbrev-ref HEAD/, {
      stdout: '',
      stderr: 'fatal: not a git repository',
      code: 128,
    });
    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]);
  });

  it('sweeps multiple merged worktrees in a single pass', async () => {
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-10'), { recursive: true });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-11'), { recursive: true });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-12'), { recursive: true });

    const fake = new FakeRunner()
      // All three report a branch
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, (args) => {
        // Extract the worktree path from args to return different branch names
        const wt = args[1] ?? '';
        if (wt.endsWith('aisdlc-10')) return ok('ai-sdlc/aisdlc-10-feat\n');
        if (wt.endsWith('aisdlc-11')) return ok('ai-sdlc/aisdlc-11-feat\n');
        return ok('ai-sdlc/aisdlc-12-feat\n');
      })
      // aisdlc-10 and aisdlc-11 are merged; aisdlc-12 is still open
      .on(
        /^gh pr list --head ai-sdlc\/aisdlc-10/,
        ok(JSON.stringify({ number: 10, state: 'MERGED', mergedAt: '2026-05-01T00:00:00Z' })),
      )
      .on(
        /^gh pr list --head ai-sdlc\/aisdlc-11/,
        ok(JSON.stringify({ number: 11, state: 'MERGED', mergedAt: '2026-05-02T00:00:00Z' })),
      )
      .on(
        /^gh pr list --head ai-sdlc\/aisdlc-12/,
        ok(JSON.stringify({ number: 12, state: 'OPEN', mergedAt: null })),
      )
      .on(/^git worktree remove/, ok());

    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toHaveLength(2);
    const branches = result.swept.map((s) => s.branch).sort();
    expect(branches).toEqual(['ai-sdlc/aisdlc-10-feat', 'ai-sdlc/aisdlc-11-feat']);
  });

  // ── AISDLC-256 dirty-worktree guard (security review minor) ────────────
  //
  // The sweep MUST refuse `git worktree remove --force` when the worktree
  // has uncommitted changes. Mirrors the AISDLC-224 hadUncommittedChanges
  // guard. Defends against spurious MERGED states (gh API race, cached
  // stale response, accidental early merge of in-progress work).

  it('AISDLC-256 dirty-worktree guard: skips removal when status --porcelain has changes', async () => {
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-dirty'), { recursive: true });
    let removeCalled = false;
    const fake = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/aisdlc-dirty-feat\n'))
      .on(
        /^gh pr list/,
        ok(JSON.stringify({ number: 999, state: 'MERGED', mergedAt: '2026-05-10T00:00:00Z' })),
      )
      .on(/^git -C .+ status --porcelain/, ok(' M src/file.ts\n?? src/new.ts\n'))
      .on(/^git worktree remove/, () => {
        removeCalled = true;
        return ok();
      });

    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]); // NOT removed
    expect(removeCalled).toBe(false); // remove never invoked
  });

  it('AISDLC-256 dirty-worktree guard: removes when status --porcelain is clean', async () => {
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-clean'), { recursive: true });
    const fake = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/aisdlc-clean-feat\n'))
      .on(
        /^gh pr list/,
        ok(JSON.stringify({ number: 1000, state: 'MERGED', mergedAt: '2026-05-10T00:00:00Z' })),
      )
      .on(/^git -C .+ status --porcelain/, ok('')) // clean
      .on(/^git worktree remove/, ok());

    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toHaveLength(1);
    expect(result.swept[0]?.branch).toBe('ai-sdlc/aisdlc-clean-feat');
  });

  it('AISDLC-256 dirty-worktree guard: skips removal when status check itself fails', async () => {
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-status-err'), { recursive: true });
    let removeCalled = false;
    const fake = new FakeRunner()
      .on(/^git -C .+ rev-parse --abbrev-ref HEAD/, ok('ai-sdlc/aisdlc-status-err-feat\n'))
      .on(
        /^gh pr list/,
        ok(JSON.stringify({ number: 1001, state: 'MERGED', mergedAt: '2026-05-10T00:00:00Z' })),
      )
      .on(/^git -C .+ status --porcelain/, fakeRunnerFail('fatal: not a repo', 128))
      .on(/^git worktree remove/, () => {
        removeCalled = true;
        return ok();
      });

    const result = await sweepMergedWorktrees({ workDir: tmp, runner: fake.toRunner() });
    expect(result.swept).toEqual([]); // conservative: skip on status failure
    expect(removeCalled).toBe(false);
  });
});
