/**
 * Integration tests: `allowForcePush: lease` (AISDLC-1005, DEC-0264) in the real
 * PreToolUse hook, against real throwaway git repos. A lease push to a
 * non-protected branch is allowed from any cwd and any hierarchy role; main,
 * protected branches and every plain-force shape stay refused.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/enforce-lease-any-branch.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = join(__dirname, 'enforce-blocked-actions.js');

const BLOCKED = `  constraints:
    blockedActions:
      - 'git push --force*'
      - 'git push -f*'
`;
const roleYaml = (mode) =>
  `apiVersion: ai-sdlc.io/v1alpha1\nkind: AgentRole\nspec:\n  role: coding-agent\n  goal: test\n  governance:\n    allowForcePush: ${mode}\n    protectedBranches:\n      - keep/*\n${BLOCKED}`;

let base;
let gitEnv;
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf-8' }).trim();

function makeRepo(name, mode, worktreeMode) {
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  writeFileSync(join(root, '.ai-sdlc', 'agent-role.yaml'), roleYaml(mode));
  writeFileSync(join(root, 'f.txt'), 'x');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'i');
  const bare = join(base, `${name}-origin.git`);
  git(base, 'init', '-q', '--bare', bare);
  git(root, 'remote', 'add', 'origin', bare);
  // A docs-style worktree: not under a task id, no sentinel, no ai-sdlc/ branch.
  const wt = join(root, '.worktrees', 'file-docs');
  git(root, 'worktree', 'add', '-q', '-b', 'docs/some-filing', wt);
  if (worktreeMode) writeFileSync(join(wt, '.ai-sdlc', 'agent-role.yaml'), roleYaml(worktreeMode));
  return { root: realpathSync(root), wt: realpathSync(wt) };
}

function run(command, { cwd, projectDir, env: extra = {} }) {
  const env = { ...gitEnv, CLAUDE_PROJECT_DIR: projectDir, ...extra };
  try {
    return execFileSync('node', [hookScript], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
      cwd,
      env,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
  } catch (err) {
    return err.stdout?.trim() || '';
  }
}
const denied = (out) => {
  try {
    return JSON.parse(out).hookSpecificOutput?.permissionDecision === 'deny';
  } catch {
    return false;
  }
};

let lease;
let own;
let tighten;
before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'lease-any-')));
  const cfg = join(base, 'gitconfig');
  writeFileSync(cfg, '');
  gitEnv = {
    PATH: process.env.PATH,
    HOME: base,
    GIT_CONFIG_GLOBAL: cfg,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  lease = makeRepo('lease', 'lease');
  own = makeRepo('own', 'leaseOnOwnBranch');
  // Trusted = leaseOnOwnBranch, worktree copy = lease: a copy can only tighten.
  tighten = makeRepo('tighten', 'leaseOnOwnBranch', 'lease');
});
after(() => rmSync(base, { recursive: true, force: true }));

const P = 'git push --force-with-lease origin';

describe('allowForcePush: lease - allowed', () => {
  it('from the main checkout', () => {
    const o = run(`${P} HEAD:refs/heads/docs/some-filing`, {
      cwd: lease.root,
      projectDir: lease.root,
    });
    assert.ok(!denied(o), o);
  });

  it('from a .worktrees/file-* worktree with no sentinel, any hierarchy role', () => {
    for (const role of [undefined, 'planner', 'operator-dispatch', 'executor']) {
      const env = role ? { AI_SDLC_HIERARCHY_ROLE: role } : {};
      const o = run(`${P} HEAD:refs/heads/docs/some-filing`, {
        cwd: lease.wt,
        projectDir: lease.root,
        env,
      });
      assert.ok(!denied(o), `${role}: ${o}`);
    }
  });

  it('accepts a named source, a lease with an explicit ref, and companion flags', () => {
    for (const cmd of [
      `${P} some-branch:refs/heads/other`,
      `git push --force-with-lease=other:abcdef1 -u origin HEAD:refs/heads/other`,
    ]) {
      const o = run(cmd, { cwd: lease.wt, projectDir: lease.root });
      assert.ok(!denied(o), `${cmd}: ${o}`);
    }
  });
});

describe('allowForcePush: lease - still refused, naming the mode', () => {
  const cases = {
    'push to main': `${P} HEAD:refs/heads/main`,
    'push to master (short)': `${P} HEAD:master`,
    'bare main': `${P} main`,
    'no-colon branch (remote.push remap)': `${P} docs/x`,
    'no-colon HEAD': `${P} HEAD`,
    'no-colon with -u': `git push --force-with-lease=other:abcdef1 -u origin HEAD`,
    'unqualified destination (tag ambiguity)': `${P} HEAD:v0.26.0`,
    'tag destination': `${P} HEAD:refs/tags/v0.26.0`,
    'configured protected branch': `${P} HEAD:refs/heads/keep/x`,
    'default protected glob': `${P} HEAD:refs/heads/release/1.0`,
    'plain --force': 'git push --force origin docs/x',
    '-f': 'git push -f origin docs/x',
    '+refspec': `${P} +HEAD:refs/heads/docs/x`,
    '--mirror': `${P} --mirror`,
    '--delete': `${P} --delete docs/x`,
    'colon delete': `${P} :docs/x`,
    'dollar expansion': 'B=main; git push --force-with-lease origin $B',
    'omitted refspec': 'git push --force-with-lease origin',
    'unknown remote': `git push --force-with-lease evil HEAD:refs/heads/docs/x`,
    'force plus lease': `${P} --force docs/x`,
  };
  for (const [name, cmd] of Object.entries(cases)) {
    it(name, () => {
      const o = run(cmd, { cwd: lease.wt, projectDir: lease.root });
      assert.ok(denied(o), `${cmd}: ${o}`);
    });
  }

  it('the refusal names the mode', () => {
    const o = run(`${P} HEAD:refs/heads/main`, { cwd: lease.wt, projectDir: lease.root });
    assert.match(o, /allowForcePush=lease/);
  });

  it('a remote.origin.push remap to main cannot be reached via a no-colon refspec', () => {
    git(lease.root, 'config', 'remote.origin.push', 'refs/heads/docs/x:refs/heads/main');
    try {
      const o = run(`${P} docs/x`, { cwd: lease.root, projectDir: lease.root });
      assert.ok(denied(o), o);
    } finally {
      git(lease.root, 'config', '--unset', 'remote.origin.push');
    }
  });
});

describe('trust: a worktree copy can only tighten', () => {
  it('copy says lease while trusted says leaseOnOwnBranch: no any-branch grant', () => {
    const o = run(`${P} HEAD:refs/heads/docs/some-filing`, {
      cwd: tighten.wt,
      projectDir: tighten.wt,
    });
    assert.ok(denied(o), o);
  });

  it('leaseOnOwnBranch keeps requiring the task worktree', () => {
    const o = run(`${P} HEAD:refs/heads/docs/some-filing`, { cwd: own.wt, projectDir: own.root });
    assert.ok(denied(o), o);
  });
});
