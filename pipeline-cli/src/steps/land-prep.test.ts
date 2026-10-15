import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecResult, Runner } from '../runtime/exec.js';
import { runLandPrep } from '../cli/pr.js';
import { flipReady, hookSkipVars, landPrep } from './land-prep.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'land-prep-'));
  const origin = join(root, 'origin.git');
  const wt = join(root, 'wt');
  const other = join(root, 'other');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, wt);
  for (const d of [wt]) {
    git(d, 'config', 'user.email', 't@t');
    git(d, 'config', 'user.name', 't');
  }
  writeFileSync(join(wt, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- base\n');
  writeFileSync(join(wt, 'a.txt'), 'one\n');
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', 'base');
  git(wt, 'push', '-q', 'origin', 'HEAD:main');
  git(wt, 'checkout', '-q', '-b', 'feat/x');
  git(root, 'clone', '-q', origin, other);
  git(other, 'config', 'user.email', 't@t');
  git(other, 'config', 'user.name', 't');
  return { root, origin, wt, other };
}

describe('hookSkipVars', () => {
  it('names skip and bypass variables only', () => {
    expect(
      hookSkipVars({
        AI_SDLC_SKIP_X: '1',
        AI_SDLC_BYPASS_ALL_GATES: '1',
        AI_SDLC_OTHER: '1',
        A: '',
      }),
    ).toEqual(['AI_SDLC_SKIP_X', 'AI_SDLC_BYPASS_ALL_GATES']);
  });
});

describe('landPrep (real git)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.length = 0;
  });

  it('rebases a mechanical conflict, lease pushes with the hook running and no skip vars', async () => {
    const { root, origin, wt, other } = setup();
    dirs.push(root);
    // branch: add a CHANGELOG bullet and push
    writeFileSync(join(wt, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- base\n- mine\n');
    git(wt, 'commit', '-q', '-am', 'mine');
    git(wt, 'push', '-q', '-u', 'origin', 'feat/x');
    // main moves with a conflicting CHANGELOG bullet
    writeFileSync(
      join(other, 'CHANGELOG.md'),
      '# Changelog\n\n## Unreleased\n\n- base\n- theirs\n',
    );
    git(other, 'commit', '-q', '-am', 'theirs');
    git(other, 'push', '-q', 'origin', 'HEAD:main');
    // pre-push hook records the env and acts as the signer: first push adds a chore commit and fails
    const hook = join(wt, '.git', 'hooks', 'pre-push');
    mkdirSync(join(wt, '.git', 'hooks'), { recursive: true });
    const log = join(root, 'hook.log');
    writeFileSync(
      hook,
      `#!/bin/sh\nenv | grep '^AI_SDLC_SKIP_\\|^AI_SDLC_BYPASS' >> ${log}\necho ran >> ${log}\n` +
        `if [ ! -f .signed ]; then touch .signed; git add .signed; git commit -q -m 'chore: sign'; exit 1; fi\nexit 0\n`,
    );
    chmodSync(hook, 0o755);
    const res = await landPrep({ worktreePath: wt, branch: 'feat/x', env: {} });
    expect(res.ok).toBe(true);
    expect(res.pushed).toBe(true);
    expect(res.rebased).toBe(true);
    expect(res.resolvedFiles).toContain('CHANGELOG.md');
    const hookLog = readFileSync(log, 'utf8');
    expect(hookLog).not.toMatch(/AI_SDLC_SKIP|AI_SDLC_BYPASS/);
    expect(hookLog.match(/ran/g)).toHaveLength(2);
    expect(git(origin, 'rev-parse', 'feat/x')).toBe(git(wt, 'rev-parse', 'HEAD'));
    const merged = git(origin, 'show', 'feat/x:CHANGELOG.md');
    expect(merged).toContain('- theirs');
    expect(merged).toContain('- mine');
  });

  it('refuses with a hook-skip variable set', async () => {
    const res = await landPrep({
      worktreePath: '/nope',
      branch: 'feat/x',
      env: { AI_SDLC_SKIP_X: '1' },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/AI_SDLC_SKIP_X/);
  });

  it('rejects a malformed branch', async () => {
    const res = await landPrep({ worktreePath: '/nope', branch: '--evil', env: {} });
    expect(res.ok).toBe(false);
  });

  it('exits non-zero on a semantic conflict, naming paths, branch unchanged', async () => {
    const { root, wt, other } = setup();
    dirs.push(root);
    writeFileSync(join(wt, 'a.txt'), 'mine\n');
    git(wt, 'commit', '-q', '-am', 'mine');
    git(wt, 'push', '-q', '-u', 'origin', 'feat/x');
    writeFileSync(join(other, 'a.txt'), 'theirs\n');
    git(other, 'commit', '-q', '-am', 'theirs');
    git(other, 'push', '-q', 'origin', 'HEAD:main');
    const before = git(wt, 'rev-parse', 'HEAD');
    const lines: string[] = [];
    const code = await runLandPrep({
      pr: 7,
      flip: false,
      worktree: wt,
      env: {},
      out: (l) => lines.push(l),
      runner: async (cmd, args, o) =>
        cmd === 'gh'
          ? { stdout: 'feat/x\n', stderr: '', code: 0 }
          : (await import('../runtime/exec.js')).defaultRunner(cmd, args, o),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/a\.txt/);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(wt, 'status', '--porcelain')).toBe('');
  });
});

describe('runLandPrep CLI guards', () => {
  const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0 });

  it('fails when the PR head differs from the worktree branch', async () => {
    const runner: Runner = async (cmd) => (cmd === 'git' ? ok('feat/x\n') : ok('other\n'));
    const lines: string[] = [];
    expect(
      await runLandPrep({ pr: 1, flip: false, worktree: '/w', runner, out: (l) => lines.push(l) }),
    ).toBe(1);
    expect(lines[0]).toMatch(/head is 'other'/);
  });

  it('fails when not on a branch', async () => {
    const runner: Runner = async () => ok('');
    expect(await runLandPrep({ pr: 1, flip: false, worktree: '/w', runner, out: () => {} })).toBe(
      1,
    );
  });
});

describe('flipReady', () => {
  function fixture(verdict: object | null) {
    const dir = mkdtempSync(join(tmpdir(), 'flip-'));
    if (verdict) {
      mkdirSync(join(dir, '.ai-sdlc', 'verdicts'), { recursive: true });
      writeFileSync(join(dir, '.ai-sdlc', 'verdicts', 'aisdlc-1.json'), JSON.stringify(verdict));
    }
    return dir;
  }
  function runnerFor(o: {
    codeql?: string | null;
    reviews?: object[];
    draft?: boolean;
    patchDraft?: boolean;
  }) {
    const calls: string[][] = [];
    const runner: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const a = args.join(' ');
      if (cmd === 'gh' && args[0] === 'pr') return { stdout: '', stderr: '', code: 0 };
      if (a.includes('check-runs')) {
        const runs = o.codeql === undefined ? [] : [{ name: 'CodeQL', conclusion: o.codeql }];
        return { stdout: JSON.stringify({ check_runs: runs }), stderr: '', code: 0 };
      }
      if (a.includes('/reviews'))
        return { stdout: JSON.stringify(o.reviews ?? []), stderr: '', code: 0 };
      if (a.includes('PATCH')) {
        return { stdout: JSON.stringify({ draft: o.patchDraft ?? false }), stderr: '', code: 0 };
      }
      return {
        stdout: JSON.stringify({ draft: o.draft ?? true, head: { sha: 'abcdef123' } }),
        stderr: '',
        code: 0,
      };
    };
    return { runner, calls };
  }
  const approved = { approved: true, decision: 'APPROVED' };

  it('refuses when CodeQL is not green', async () => {
    const r = await flipReady({
      prNumber: 1,
      taskId: 'AISDLC-1',
      worktreePath: fixture(approved),
      runner: runnerFor({ codeql: 'failure' }).runner,
    });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/CodeQL is not green/) });
  });

  it('refuses when CodeQL has not reported', async () => {
    const r = await flipReady({
      prNumber: 1,
      taskId: 'AISDLC-1',
      worktreePath: fixture(approved),
      runner: runnerFor({}).runner,
    });
    expect(r.ok).toBe(false);
  });

  it('refuses when the verdict is not approved or missing', async () => {
    for (const v of [{ approved: false }, null]) {
      const r = await flipReady({
        prNumber: 1,
        taskId: 'AISDLC-1',
        worktreePath: fixture(v),
        runner: runnerFor({ codeql: 'success' }).runner,
      });
      expect(r.reason).toMatch(/verdict not approved/);
    }
  });

  it('refuses with an outstanding CHANGES_REQUESTED review, honouring later approvals', async () => {
    const bad = await flipReady({
      prNumber: 1,
      taskId: 'AISDLC-1',
      worktreePath: fixture(approved),
      runner: runnerFor({
        codeql: 'success',
        reviews: [{ user: { login: 'a' }, state: 'CHANGES_REQUESTED' }],
      }).runner,
    });
    expect(bad.reason).toMatch(/CHANGES_REQUESTED/);
    const good = await flipReady({
      prNumber: 1,
      taskId: 'AISDLC-1',
      worktreePath: fixture(approved),
      runner: runnerFor({
        codeql: 'success',
        reviews: [
          { user: { login: 'a' }, state: 'CHANGES_REQUESTED' },
          { user: { login: 'a' }, state: 'APPROVED' },
        ],
      }).runner,
    });
    expect(good.ok).toBe(true);
  });

  it('flips via REST PATCH when all conditions hold', async () => {
    const { runner, calls } = runnerFor({ codeql: 'success' });
    const r = await flipReady({
      prNumber: 1,
      taskId: 'AISDLC-1',
      worktreePath: fixture(approved),
      runner,
    });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c.includes('PATCH') && c.includes('draft=false'))).toBe(true);
  });

  it('falls back to the ready command when REST leaves the draft', async () => {
    const { runner, calls } = runnerFor({ codeql: 'success', patchDraft: true });
    const r = await flipReady({
      prNumber: 1,
      taskId: 'AISDLC-1',
      worktreePath: fixture(approved),
      runner,
    });
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c[1] === 'pr' && c[2] === 'ready')).toBe(true);
  });

  it('is a no-op for a PR already ready', async () => {
    const { runner } = runnerFor({ codeql: 'success', draft: false });
    expect(
      (
        await flipReady({
          prNumber: 1,
          taskId: 'AISDLC-1',
          worktreePath: fixture(approved),
          runner,
        })
      ).ok,
    ).toBe(true);
  });
});
