/**
 * Integration tests: own-branch force-with-lease enforcement in the real
 * PreToolUse hook, against real throwaway git repos (no network, no real home).
 *
 * Run with: node --test ai-sdlc-plugin/hooks/enforce-lease-push.test.mjs
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
    blockedPaths:
      - '.github/workflows/**'
      - '.ai-sdlc/**'
    blockedActions:
      - 'gh pr merge*'
      - 'git merge*'
      - 'git push --force*'
      - 'git push -f*'
      - 'git reset --hard*'
      - 'git checkout -- .'
      - 'git restore .'
`;
const roleYaml = (governance) =>
  `apiVersion: ai-sdlc.io/v1alpha1\nkind: AgentRole\nspec:\n  role: coding-agent\n  goal: test\n${governance}${BLOCKED}`;

const LEASE = `  governance:\n    allowForcePush: leaseOnOwnBranch\n    protectedBranches:\n      - release/*\n`;

let base;
let gitEnv;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf-8' }).trim();
}

/** Builds main repo (+ bare origin) with the given policy; returns paths. */
function makeRepo(name, policyYaml, worktreeYaml) {
  const root = join(base, name);
  const bare = join(base, `${name}-origin.git`);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  writeFileSync(join(root, '.ai-sdlc', 'agent-role.yaml'), policyYaml);
  writeFileSync(join(root, 'f.txt'), 'x');
  git(root, 'add', '-A');
  git(
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-q',
    '-m',
    'init',
  );
  git(base, 'init', '-q', '--bare', bare);
  git(root, 'remote', 'add', 'origin', bare);
  const wt = join(root, '.worktrees', 'task');
  git(root, 'worktree', 'add', '-q', '-b', 'feat/own', wt);
  if (worktreeYaml !== undefined) {
    writeFileSync(join(wt, '.ai-sdlc', 'agent-role.yaml'), worktreeYaml);
  }
  return { root: realpathSync(root), wt: realpathSync(wt) };
}

function invoke(payload, { cwd, projectDir, unsetProject = false }) {
  const env = { ...gitEnv };
  if (!unsetProject) env.CLAUDE_PROJECT_DIR = projectDir;
  try {
    return execFileSync('node', [hookScript], {
      input: JSON.stringify({ ...payload, cwd }),
      cwd,
      env,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
  } catch (err) {
    return err.stdout?.trim() || '';
  }
}
const run = (command, opts) => invoke({ tool_name: 'Bash', tool_input: { command } }, opts);
const runWrite = (file_path, opts) =>
  invoke({ tool_name: 'Write', tool_input: { file_path } }, opts);
const denied = (out) => {
  try {
    return JSON.parse(out).hookSpecificOutput?.permissionDecision === 'deny';
  } catch {
    return false;
  }
};

let leaseRepo;
let neverRepo;
let wtCopyRepo;
let inverseRepo;

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'lease-push-')));
  const cfg = join(base, 'gitconfig');
  writeFileSync(cfg, '');
  gitEnv = {
    PATH: process.env.PATH,
    HOME: base,
    GIT_CONFIG_GLOBAL: cfg,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  leaseRepo = makeRepo('lease', roleYaml(LEASE));
  neverRepo = makeRepo('never', roleYaml(''));
  // Trusted (main checkout) policy = never; PR-tree copy in the worktree = lease.
  wtCopyRepo = makeRepo('wtcopy', roleYaml(''), roleYaml(LEASE));
  // Trusted policy = lease; worktree copy tries to turn it off -> still lease.
  inverseRepo = makeRepo('inverse', roleYaml(LEASE), roleYaml(''));
});

after(() => rmSync(base, { recursive: true, force: true }));

const OWN = 'feat/own';
const L = () => `git push --force-with-lease origin ${OWN}`;

describe('leaseOnOwnBranch - allowed', () => {
  it('allows lease push of the worktree own branch (project dir = main checkout)', () => {
    const out = run(L(), { cwd: leaseRepo.wt, projectDir: leaseRepo.root });
    assert.ok(!denied(out), out);
  });

  it('allows when CLAUDE_PROJECT_DIR is the worktree itself (policy read from main checkout)', () => {
    const out = run(L(), { cwd: leaseRepo.wt, projectDir: leaseRepo.wt });
    assert.ok(!denied(out), out);
  });

  it('allows when CLAUDE_PROJECT_DIR is unset', () => {
    const out = run(L(), { cwd: leaseRepo.wt, unsetProject: true });
    assert.ok(!denied(out), out);
  });

  it('allows HEAD:<own> form', () => {
    const out = run(`git push --force-with-lease origin HEAD:${OWN}`, {
      cwd: leaseRepo.wt,
      projectDir: leaseRepo.root,
    });
    assert.ok(!denied(out), out);
  });

  it('a worktree copy that disables the policy has no effect on the trusted lease policy', () => {
    const out = run(L(), { cwd: inverseRepo.wt, projectDir: inverseRepo.wt });
    assert.ok(!denied(out), out);
  });

  it('plain non-force push of own branch is unaffected', () => {
    const out = run(`git push origin ${OWN}`, { cwd: leaseRepo.wt, projectDir: leaseRepo.root });
    assert.ok(!denied(out), out);
  });
});

describe('leaseOnOwnBranch - blocked', () => {
  const cases = [
    ['lease to another branch', 'git push --force-with-lease origin other'],
    ['refspec own:other', `git push --force-with-lease origin ${OWN}:other`],
    ['HEAD:other', 'git push --force-with-lease origin HEAD:other'],
    ['HEAD:main', 'git push --force-with-lease origin HEAD:main'],
    ['lease to main', 'git push --force-with-lease origin main'],
    ['lease to master', 'git push --force-with-lease origin master'],
    ['refs/heads/main', 'git push --force-with-lease origin refs/heads/main'],
    ['delete :main', 'git push --force-with-lease origin :main'],
    ['--delete own', `git push --force-with-lease --delete origin ${OWN}`],
    ['--mirror', 'git push --force-with-lease --mirror origin'],
    ['plain --force own branch', `git push --force origin ${OWN}`],
    ['-f own branch', `git push -f origin ${OWN}`],
    ['--force after args (no blockedAction prefix match)', `git push origin ${OWN} --force`],
    ['+refspec', `git push origin +${OWN}`],
    ['--force-if-includes alone', `git push --force-if-includes origin ${OWN}`],
    ['no refspec', 'git push --force-with-lease origin'],
    ['raw URL remote', `git push --force-with-lease https://evil.example/x.git ${OWN}`],
    ['unconfigured remote', `git push --force-with-lease evil ${OWN}`],
    ['chained', `${L()} && echo done`],
    ['cd elsewhere', `cd /tmp && ${L()}`],
    ['git -C', `git -C /tmp push --force-with-lease origin ${OWN}`],
    ['GIT_DIR prefix', `GIT_DIR=/tmp/x ${L()}`],
    ['--no-verify', `git push --no-verify --force-with-lease origin ${OWN}`],
    ['abbreviated flag', `git push --force-w origin ${OWN}`],
  ];
  for (const [name, cmd] of cases) {
    it(`blocks ${name}`, () => {
      const out = run(cmd, { cwd: leaseRepo.wt, projectDir: leaseRepo.root });
      assert.ok(denied(out), `${cmd} -> ${out}`);
    });
  }

  it('blocks a lease push from the main checkout on main (own branch is protected)', () => {
    const out = run('git push --force-with-lease origin main', {
      cwd: leaseRepo.root,
      projectDir: leaseRepo.root,
    });
    assert.ok(denied(out), out);
  });

  it('blocks a lease push of a policy-protected own branch', () => {
    git(leaseRepo.wt, 'checkout', '-q', '-b', 'release/1.0');
    const out = run('git push --force-with-lease origin release/1.0', {
      cwd: leaseRepo.wt,
      projectDir: leaseRepo.root,
    });
    git(leaseRepo.wt, 'checkout', '-q', OWN);
    assert.ok(denied(out), out);
  });

  it('blocks on a detached HEAD', () => {
    git(leaseRepo.wt, 'checkout', '-q', '--detach');
    const out = run(L(), { cwd: leaseRepo.wt, projectDir: leaseRepo.root });
    git(leaseRepo.wt, 'checkout', '-q', OWN);
    assert.ok(denied(out), out);
  });
});

describe('never / unset / malformed - behaves exactly as before', () => {
  it('blocks lease push under never (generic blockedActions pattern)', () => {
    assert.ok(denied(run(L(), { cwd: neverRepo.wt, projectDir: neverRepo.root })));
  });

  it('plain force push stays blocked under never', () => {
    assert.ok(
      denied(
        run(`git push --force origin ${OWN}`, { cwd: neverRepo.wt, projectDir: neverRepo.root }),
      ),
    );
  });

  it('adds no new enforcement when there is no agent-role.yaml (fail-closed, unchanged legacy path)', () => {
    const r = makeRepo('nopolicy', roleYaml(''));
    rmSync(join(r.root, '.ai-sdlc', 'agent-role.yaml'));
    const out = run(`git push origin ${OWN} --force`, { cwd: r.wt, projectDir: r.root });
    assert.ok(!denied(out), 'no policy file: hook behaves as it did before this change');
  });

  for (const v of ['yes', 'always', 'LEASEONOWNBRANCH', '1']) {
    it(`malformed allowForcePush=${v} stays blocked`, () => {
      const r = makeRepo(
        `bad-${v}`.replace(/\W/g, ''),
        roleYaml(`  governance:\n    allowForcePush: ${v}\n`),
      );
      assert.ok(denied(run(L(), { cwd: r.wt, projectDir: r.root })));
    });
  }

  it('boolean false stays blocked', () => {
    const f = makeRepo('boolfalse', roleYaml(`  governance:\n    allowForcePush: false\n`));
    assert.ok(denied(run(L(), { cwd: f.wt, projectDir: f.root })));
  });

  it('boolean true is read as leaseOnOwnBranch (own branch only)', () => {
    const t = makeRepo('booltrue', roleYaml(`  governance:\n    allowForcePush: true\n`));
    assert.ok(!denied(run(L(), { cwd: t.wt, projectDir: t.root })));
    assert.ok(
      denied(run('git push --force-with-lease origin other', { cwd: t.wt, projectDir: t.root })),
    );
  });
});

describe('policy comes from the trusted checkout, never the PR tree', () => {
  it('worktree copy setting leaseOnOwnBranch has NO effect (project dir = worktree)', () => {
    assert.ok(denied(run(L(), { cwd: wtCopyRepo.wt, projectDir: wtCopyRepo.wt })));
  });

  it('same with CLAUDE_PROJECT_DIR unset', () => {
    assert.ok(denied(run(L(), { cwd: wtCopyRepo.wt, unsetProject: true })));
  });

  it('same with CLAUDE_PROJECT_DIR = main checkout', () => {
    assert.ok(denied(run(L(), { cwd: wtCopyRepo.wt, projectDir: wtCopyRepo.root })));
  });
});

describe('fixed integrity rules stay blocked under leaseOnOwnBranch', () => {
  const ctx = () => ({ cwd: leaseRepo.wt, projectDir: leaseRepo.root });

  it('blocks Write/Edit under .ai-sdlc/** (agent-role, attestations, verdicts)', () => {
    for (const rel of [
      '.ai-sdlc/agent-role.yaml',
      '.ai-sdlc/attestations/abc.v6.dsse.json',
      '.ai-sdlc/verdicts/some-task.json',
    ]) {
      assert.ok(denied(runWrite(join(leaseRepo.wt, rel), ctx())), rel);
    }
  });

  it('blocks governance relaxation from the PR tree (editing the worktree agent-role.yaml)', () => {
    assert.ok(
      denied(
        runWrite(join(wtCopyRepo.wt, '.ai-sdlc', 'agent-role.yaml'), {
          cwd: wtCopyRepo.wt,
          projectDir: wtCopyRepo.root,
        }),
      ),
    );
  });

  for (const cmd of [
    'git reset --hard HEAD~1',
    'git checkout -- .',
    'git restore .',
    ['gh', 'pr', 'merge', '5', '--squash'].join(' '),
    'git stash pop',
    'git stash clear',
  ]) {
    it(`blocks ${cmd}`, () => {
      assert.ok(denied(run(cmd, ctx())), cmd);
    });
  }

  it('the lease allowance does not exempt other blockedActions (chained reset)', () => {
    assert.ok(denied(run(`${L()}; git reset --hard`, ctx())));
  });
});
