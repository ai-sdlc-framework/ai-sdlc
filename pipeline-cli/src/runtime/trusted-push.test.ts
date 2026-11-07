import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultRunner } from './exec.js';
import { buildTrustedPush, resolveTrustedPushInputs, runTrustedPush } from './trusted-push.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'trusted-push-'));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function script(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function fixture() {
  const root = tmp();
  const main = join(root, 'main');
  const wt = join(root, 'wt');
  const remote = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', remote);
  git(root, 'init', '-q', wt);
  git(wt, 'config', 'user.email', 't@t');
  git(wt, 'config', 'user.name', 't');
  git(wt, 'commit', '-q', '--allow-empty', '-m', 'a');
  git(wt, 'remote', 'add', 'origin', remote);
  // trusted hooks live in the main checkout's .husky/_
  mkdirSync(join(main, '.husky', '_'), { recursive: true });
  script(join(main, '.husky', '_', 'pre-push'), `echo trusted > "${root}/trusted.marker"`);
  // planted hooks in the worktree
  script(join(wt, '.husky', 'pre-push'), `echo planted > "${root}/husky.marker"`);
  script(join(wt, '.git', 'hooks', 'pre-push'), `echo planted > "${root}/githook.marker"`);
  git(wt, 'config', 'core.hooksPath', '.husky');
  return { root, main, wt, remote };
}

describe('trusted pipeline push (AISDLC-731)', () => {
  it('builds explicit -c overrides and unsets the GIT_* location variables', () => {
    const t = buildTrustedPush({ mainCheckout: '/m', remoteUrl: 'u' }, ['push', 'origin']);
    expect(t.args.slice(0, 2)).toEqual(['-c', 'core.hooksPath=/m/.husky/_']);
    expect(t.args).toContain('core.sshCommand=ssh');
    expect(t.args.slice(-2)).toEqual(['push', 'origin']);
    expect(Object.keys(t.env).sort()).toEqual([
      'GIT_DIR',
      'GIT_INDEX_FILE',
      'GIT_PREFIX',
      'GIT_WORK_TREE',
    ]);
    expect(Object.values(t.env).every((v) => v === undefined)).toBe(true);
  });

  it('runs trusted hooks only: planted .husky and .git/hooks pre-push never run', async () => {
    const f = fixture();
    const r = await runTrustedPush(
      defaultRunner,
      { mainCheckout: f.main, worktree: f.wt },
      ['push', '-u', 'origin', 'HEAD:refs/heads/x'],
      { allowFailure: true },
    );
    expect(r.code).toBe(0);
    expect(existsSync(join(f.root, 'trusted.marker'))).toBe(true);
    expect(existsSync(join(f.root, 'husky.marker'))).toBe(false);
    expect(existsSync(join(f.root, 'githook.marker'))).toBe(false);
  });

  it('ignores a planted core.sshCommand and url.*.insteadOf', async () => {
    const f = fixture();
    git(f.wt, 'config', 'url.file:///nonexistent/.insteadOf', f.root + '/');
    git(f.wt, 'config', 'url.file:///nonexistent/.pushInsteadOf', f.root + '/');
    git(f.wt, 'config', 'core.sshCommand', `${f.root}/planted-ssh`);
    // sanity: unprotected push is redirected by the planted rewrite
    expect(() => git(f.wt, 'push', '--no-verify', 'origin', 'HEAD:refs/heads/y')).toThrow();
    const r = await runTrustedPush(
      defaultRunner,
      { mainCheckout: f.main, worktree: f.wt },
      ['push', 'origin', 'HEAD:refs/heads/x'],
      { allowFailure: true },
    );
    expect(r.code).toBe(0);
    expect(git(f.remote, 'rev-parse', 'refs/heads/x')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('pins the operator ssh command over a planted core.sshCommand', () => {
    const f = fixture();
    git(f.wt, 'config', 'core.sshCommand', `${f.root}/planted-ssh`);
    script(join(f.root, 'planted-ssh'), `echo planted > "${f.root}/ssh.marker"; exit 1`);
    git(f.wt, 'remote', 'set-url', 'origin', 'ssh://example.invalid/r.git');
    const inputs = resolveTrustedPushInputs(f.main, f.wt);
    const built = buildTrustedPush({ ...inputs, sshCommand: 'true' }, ['push', 'origin', 'HEAD:x']);
    try {
      git(f.wt, ...built.args);
    } catch {
      /* ssh stub `true` yields a protocol error; only the marker matters */
    }
    expect(existsSync(join(f.root, 'ssh.marker'))).toBe(false);
  });

  it('refuses when a rewrite ties with the pinned URL and still redirects origin', async () => {
    const f = fixture();
    git(f.wt, 'config', `url.file:///nonexistent/.pushInsteadOf`, f.remote);
    const inputs = resolveTrustedPushInputs(f.main, f.wt);
    expect(inputs.refusal).toMatch(/redirects origin/);
    const r = await runTrustedPush(
      defaultRunner,
      { mainCheckout: f.main, worktree: f.wt },
      ['push', 'origin', 'HEAD:refs/heads/z'],
      { allowFailure: true },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/push refused/);
  });

  it('works with no remote url readable (falls back to hooks and ssh pinning only)', () => {
    const inputs = resolveTrustedPushInputs('/m', tmp());
    expect(inputs.remoteUrl).toBeNull();
  });
});
