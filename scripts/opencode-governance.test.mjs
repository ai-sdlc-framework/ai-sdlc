/**
 * Tests for the opencode v2 governance plugin
 * (.opencode/plugins/ai-sdlc-governance.js), driven black-box through the
 * plugin's real `setup(ctx)` entry point with a fake v2 plugin context — the
 * exact seam opencode uses. No named exports are added to the plugin just for
 * testing (an opencode plugin module's exports are part of its contract).
 *
 * Also carries a parity table against the legacy Claude hook
 * (ai-sdlc-plugin/hooks/enforce-blocked-actions.js): where the two engines
 * are meant to agree they are asserted to agree; the DELIBERATE divergences
 * (lease carve-out, harness-config floor, force flag after the remote) are
 * listed explicitly so a future drift is a conscious decision.
 *
 * Run: node --test scripts/opencode-governance.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const PLUGIN = join(REPO, '.opencode', 'plugins', 'ai-sdlc-governance.js');
const LEGACY_HOOK = join(REPO, 'ai-sdlc-plugin', 'hooks', 'enforce-blocked-actions.js');
const REAL_AGENT_ROLE = readFileSync(join(REPO, '.ai-sdlc', 'agent-role.yaml'), 'utf-8');

const plugin = (await import(pathToFileURL(PLUGIN).href)).default;

// Assembled at runtime so this file's own source never contains the literal
// phrase that the repo's shell governance scans for in command text.
const GH_PR = ['gh', 'pr'].join(' ');
const PR_MERGE = `${GH_PR} merge`;

let root; // fake project root
let worktree; // <root>/.worktrees/aisdlc-99
let sibling; // permitted external dir
let telemetryDir;
const savedEnv = {};

function setEnv(k, v) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-gov-'));
  sibling = mkdtempSync(join(tmpdir(), 'oc-gov-sibling-'));
  telemetryDir = mkdtempSync(join(tmpdir(), 'oc-gov-telemetry-'));
  worktree = join(root, '.worktrees', 'aisdlc-99');
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(root, '.ai-sdlc', 'agent-role.yaml'), REAL_AGENT_ROLE);
  writeFileSync(
    join(root, 'backlog', 'tasks', 'aisdlc-99 - test-task.md'),
    `---\nid: AISDLC-99\ntitle: t\npermittedExternalPaths:\n  - '${sibling}'\n---\n\nBody.\n`,
  );
  // The session dir is a real git checkout on a feature branch: bare pushes
  // and `HEAD`/`@` refspecs resolve the current branch from it.
  execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: worktree });
  setEnv('AI_SDLC_PROJECT_ROOT', root);
  setEnv('AI_SDLC_TELEMETRY_DIR', telemetryDir);
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(sibling, { recursive: true, force: true });
  rmSync(telemetryDir, { recursive: true, force: true });
});

beforeEach(() => {
  setEnv('AI_SDLC_ACTIVE_TASK_ID', undefined);
});

/** Fake v2 plugin ctx; captures the hooks the plugin registers. */
function makeCtx({ directory = worktree } = {}) {
  const hooks = {};
  const disposed = [];
  const reg = (kind) => (name, fn) => {
    hooks[`${kind}.${name}`] = fn;
    return { dispose: () => disposed.push(`${kind}.${name}`) };
  };
  return {
    hooks,
    disposed,
    permission: { hook: reg('permission') },
    tool: { hook: reg('tool') },
    session: { hook: reg('session'), get: async () => ({ location: { directory } }) },
  };
}

async function loadHooks(opts) {
  const ctx = makeCtx(opts);
  const dispose = await plugin.setup(ctx);
  return { ctx, dispose };
}

/** Run permission.evaluate and report whether governance denied. */
async function evaluate(hooks, action, resources) {
  const input = {
    action,
    resources: Array.isArray(resources) ? resources : [resources],
    sessionID: 's1',
  };
  await hooks['permission.evaluate'](input);
  return { denied: input.effect === 'deny', message: input.message, input };
}

describe('plugin shape', () => {
  it('has the v2 id and registers the three hooks; dispose unregisters them', async () => {
    assert.equal(plugin.id, 'ai-sdlc.governance');
    const { ctx, dispose } = await loadHooks();
    assert.deepEqual(Object.keys(ctx.hooks).sort(), [
      'permission.evaluate',
      'session.context',
      'tool.execute.after',
    ]);
    await dispose();
    assert.equal(ctx.disposed.length, 3);
  });

  it('a hook-registration failure is fail-open (other hooks still register)', async () => {
    const ctx = makeCtx();
    ctx.permission.hook = () => {
      throw new Error('registration boom');
    };
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = (chunk) => {
      captured += String(chunk);
      return true;
    };
    try {
      await plugin.setup(ctx);
    } finally {
      process.stderr.write = origWrite;
    }
    assert.ok(ctx.hooks['tool.execute.after']);
    assert.ok(ctx.hooks['session.context']);
    assert.match(captured, /failed to register permission\.evaluate hook: registration boom/);
  });
});

describe('shell governance', () => {
  const cases = [
    // [command, expectedDenied]
    [`${PR_MERGE} 42`, true],
    // A clean auto-arm passes the merge-governance floor, but this repo's
    // agent-role.yaml blockedActions pattern for the merge command still denies it.
    [`${PR_MERGE} 42 --auto --squash`, true],
    ['git merge feature', true],
    [`${GH_PR} close 7`, true],
    ['gh issue close 7', true],
    ['git branch -D old', true],
    ['git branch -d old', true],
    ['git reset --hard HEAD~1', true],
    ['git checkout -- .', true],
    ['git restore .', true],
    ['git stash pop', true],
    ['git stash clear', true],
    ['git stash drop', true],
    ['git stash drop stash@{1}', false],
    ['git stash push -u -m my-tag', false],
    ['git push origin feature', false],
    ['git status', false],
    ['cd x && git merge feature', true],
    ['ls && git push --force origin feature', true],
    ['git push --force origin main', true],
    ['git push -f origin main', true],
    ['git push origin main --force', true], // flag AFTER the remote (prefix glob alone misses it)
    ['git -C /tmp/x push --force origin feature', true],
    ['', false],
  ];
  for (const [command, expected] of cases) {
    it(`${expected ? 'denies' : 'allows'}: ${command || '(empty)'}`, async () => {
      const { ctx } = await loadHooks();
      assert.equal((await evaluate(ctx.hooks, 'shell', command)).denied, expected);
    });
  }

  it('also handles the `bash` action name', async () => {
    const { ctx } = await loadHooks();
    assert.equal((await evaluate(ctx.hooks, 'bash', 'git merge x')).denied, true);
  });

  it('the deny message names the governance layer', async () => {
    const { ctx } = await loadHooks();
    const r = await evaluate(ctx.hooks, 'shell', 'git merge x');
    assert.match(r.message, /Blocked by AI-SDLC governance policy/);
  });
});

describe('force-with-lease carve-out (strict)', () => {
  const allowed = [
    'git push --force-with-lease --set-upstream origin HEAD',
    'git push --force-with-lease origin feat/x',
    'git push origin feat/x --force-with-lease',
    'git push --force-with-lease=feat/x:abc123 origin feat/x',
    'git push --force-with-lease --force-if-includes origin feat/x',
    'git push --force-with-lease origin HEAD:refs/heads/feat/x',
    'git push --force-with-lease origin feat/main-menu',
    // bare / HEAD / @ resolve to the current branch (feat/x in the session dir)
    'git push --force-with-lease origin',
    'git push --force-with-lease',
    'git push --force-with-lease origin HEAD',
    'git push --force-with-lease origin @',
    'git push --force-with-lease origin HEAD:feat/x',
    'git push --force-with-lease origin HEAD:heads/feat/x',
    'git push --force-with-lease origin feat/x:feat/x',
    'git push --force-with-lease origin HEAD:refs/heads/feat/x',
    'env GIT_TRACE=0 git push --force-with-lease origin feat/x',
    'git push --force-w origin feat/x', // unambiguous abbreviation of the lease flag
  ];
  const denied = [
    // The reported bypass: the prefix glob let a second force flag ride along.
    'git push --force-with-lease --force origin main',
    'git push --force-with-lease --force origin feat/x',
    'git push --force --force-with-lease origin feat/x',
    'git push --force-with-lease -f origin feat/x',
    'git push --force-with-lease -fu origin feat/x',
    'git push --force-with-lease origin +feat/x',
    'git push --force-with-lease origin feat/x:+main',
    // main/master targets are denied even with a lease.
    'git push --force-with-lease origin main',
    'git push --force-with-lease origin master',
    'git push --force-with-lease origin HEAD:main',
    'git push --force-with-lease origin HEAD:refs/heads/master',
    'git push --force-with-lease=main:abc123 origin main',
    'git push --force-with-lease --mirror origin',
    'git push --force-with-lease --delete origin feat/x',
    'git push --force-with-lease -d origin feat/x',
    // Re-review MAJOR A: widening flags with a lease (no refspec => no target check)
    'git push --force-with-lease --all origin',
    'git push --force-with-lease --branches origin',
    'git push --force-with-lease --tags origin',
    'git push --force-with-lease --prune origin',
    'git push --force-with-lease --mirr origin', // abbreviation of --mirror
    'git push --force-with-lease --dele origin feat/x', // abbreviation of --delete
    'git push --force-with-lease --al origin', // abbreviation of --all
    'git push --force-with-lease --forc origin feat/x', // ambiguous abbreviation: fail closed
    // glob destinations
    "git push --force-with-lease origin 'refs/heads/*:refs/heads/*'",
    'git push --force-with-lease origin refs/heads/*:refs/heads/*',
    'git push --force-with-lease origin HEAD:refs/heads/feat/*',
    // git expands heads/main -> refs/heads/main
    'git push --force-with-lease origin HEAD:heads/main',
    'git push --force-with-lease origin HEAD:heads/master',
    'git push --force-with-lease origin HEAD:refs/heads/main',
    'git push --force-with-lease origin HEAD:refs/heads//main',
    'git push --force-with-lease origin HEAD:refs/heads/./main',
    'git push --force-with-lease origin HEAD:refs/heads/release/main',
    'git push --force-with-lease origin HEAD:MAIN',
    // non-branch destinations / deletes
    'git push --force-with-lease origin HEAD:refs/tags/v1',
    'git push --force-with-lease origin :feat/x',
    'git push --force-with-lease origin feat/x:',
    // wrapper prefixes, continuations, alias/config tricks, obfuscation
    'env git push --force-with-lease --force origin feat/x',
    'command git push --force-with-lease --all origin',
    'nice -n 5 git push --force-with-lease --force origin feat/x',
    'git push --force-with-lease \\\n  --force origin feat/x',
    'git -c alias.p=push p --force origin feat/x',
    'git -c remote.origin.mirror=true push --force-with-lease origin feat/x',
    "git 'push' --force-with-lease --force origin feat/x",
    'git push --force-with-lease ${EMPTY}--force origin feat/x',
    "bash -c 'git push --force-with-lease --force origin feat/x'",
    'echo $(git push --force-with-lease --all origin)',
    'true `git push --force origin feat/x`',
    // chained / global-flag forms
    'git status && git push --force-with-lease --force origin feat/x',
    'git -C /tmp/x push --force-with-lease --force origin feat/x',
    'GIT_TRACE=1 git push --force-with-lease --force origin feat/x',
  ];
  for (const cmd of allowed) {
    it(`allows: ${cmd}`, async () => {
      const { ctx } = await loadHooks();
      assert.equal((await evaluate(ctx.hooks, 'shell', cmd)).denied, false);
    });
  }
  for (const cmd of denied) {
    it(`denies: ${cmd}`, async () => {
      const { ctx } = await loadHooks();
      assert.equal((await evaluate(ctx.hooks, 'shell', cmd)).denied, true);
    });
  }
});

describe('lease push: current-branch resolution (fail closed)', () => {
  const dirs = [];
  function repoOn(branch, { commit = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'oc-gov-br-'));
    dirs.push(dir);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'commit.gpgsign',
      GIT_CONFIG_VALUE_0: 'false',
    };
    execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, env });
    if (commit) {
      writeFileSync(join(dir, 'f'), 'x');
      execFileSync('git', ['add', 'f'], { cwd: dir, env });
      execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env });
    }
    return { dir, env };
  }
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  for (const cmd of [
    'git push --force-with-lease origin',
    'git push --force-with-lease',
    'git push --force-with-lease origin HEAD',
    'git push --force-with-lease origin @',
  ]) {
    it(`denies on a main checkout: ${cmd}`, async () => {
      const { dir } = repoOn('main');
      const { ctx } = await loadHooks({ directory: dir });
      assert.equal((await evaluate(ctx.hooks, 'shell', cmd)).denied, true);
    });
  }

  it('denies on a master checkout (bare lease)', async () => {
    const { dir } = repoOn('master');
    const { ctx } = await loadHooks({ directory: dir });
    assert.equal(
      (await evaluate(ctx.hooks, 'shell', 'git push --force-with-lease origin')).denied,
      true,
    );
  });

  it('denies when the session dir is not a git repo (cannot resolve => fail closed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-gov-norepo-'));
    dirs.push(dir);
    const { ctx } = await loadHooks({ directory: dir });
    assert.equal(
      (await evaluate(ctx.hooks, 'shell', 'git push --force-with-lease origin')).denied,
      true,
    );
    // ...but an explicit, safe refspec needs no resolution
    assert.equal(
      (await evaluate(ctx.hooks, 'shell', 'git push --force-with-lease origin feat/x')).denied,
      false,
    );
  });

  it('denies on a detached HEAD (bare lease)', async () => {
    const { dir, env } = repoOn('feat/y', { commit: true });
    execFileSync('git', ['checkout', '-q', '--detach'], { cwd: dir, env });
    const { ctx } = await loadHooks({ directory: dir });
    assert.equal(
      (await evaluate(ctx.hooks, 'shell', 'git push --force-with-lease origin HEAD')).denied,
      true,
    );
  });

  it('honors git -C <dir> when resolving the current branch', async () => {
    const { dir: mainDir } = repoOn('main');
    const { ctx } = await loadHooks(); // session dir = feat/x worktree
    assert.equal(
      (await evaluate(ctx.hooks, 'shell', `git -C ${mainDir} push --force-with-lease origin`))
        .denied,
      true,
    );
  });
});

describe('round-3 hardening (best effort; see runbook for what is NOT handled)', () => {
  const denied = [
    // --signed takes no separate value token
    'git push --force-with-lease --signed origin main',
    'git push --force-with-lease --signed origin HEAD:main',
    // shell expansion in any refspec fails closed
    'BR=main; git push --force-with-lease origin $BR',
    'BR=main; git push --force-with-lease origin ${BR}',
    "git push --force-with-lease origin $'\\x6dain'",
    'git push --force-with-lease origin "$(git rev-parse --abbrev-ref HEAD)"',
    // repository / environment redirection
    'GIT_DIR=/tmp/x git push --force-with-lease origin feat/x',
    'GIT_WORK_TREE=/tmp/x git push --force-with-lease origin feat/x',
    'git --git-dir=/tmp/x push --force-with-lease origin feat/x',
    'git --git-dir /tmp/x push --force-with-lease origin feat/x',
    'git --work-tree=/tmp/x push --force-with-lease origin feat/x',
    'git push --force-with-lease --git-dir=/tmp/x origin feat/x',
    'git -C a -C b push --force-with-lease origin feat/x',
    'git -C /etc push --force-with-lease origin feat/x',
    'git -C ../.. push --force-with-lease origin feat/x',
    'git -c push.default=matching push --force-with-lease origin feat/x',
    'git -c branch.feat/x.merge=refs/heads/main push --force-with-lease origin',
    'GIT_CONFIG_COUNT=1 git push --force-with-lease origin feat/x',
    'GIT_CONFIG_KEY_0=push.default git push --force-with-lease origin feat/x',
    'GIT_CONFIG_PARAMETERS="\'push.default=x\'" git push --force-with-lease origin feat/x',
    // a preceding cd / GIT_* export in the same compound command
    'cd /tmp/other && git push --force-with-lease origin feat/x',
    'pushd /tmp/other; git push --force-with-lease origin feat/x',
    'export GIT_DIR=/tmp/x && git push --force-with-lease origin feat/x',
    // push / ref mutation commands
    'git config remote.origin.push refs/heads/feat:refs/heads/main',
    'git config push.default matching',
    'git config alias.p push',
    'git symbolic-ref HEAD refs/heads/main',
    'git branch -f main HEAD',
    'git branch -M main',
    'git checkout -B main',
    'git switch -C master',
    // taint must also apply when the lease flag comes AFTER the remote/refspec
    'cd ../.. && git push origin HEAD --force-with-lease',
    'export GIT_DIR=/tmp/x && git push origin HEAD --force-with-lease',
    'command cd /tmp/other && git push origin feat/x --force-with-lease',
    'builtin cd /tmp/other; git push origin feat/x --force-with-lease',
    'typeset -x GIT_DIR=/tmp/x; git push origin feat/x --force-with-lease',
    'export FOO=1 GIT_DIR=/tmp/x && git push origin feat/x --force-with-lease',
    // raw expansion in any push is denied, even when normalisation would delete it
    'git push ${F:---force} origin ${M:-main}',
    'F=--force; M=main; git push $F origin $M',
    'F=--force; git push origin feat/x $F',
    'git push origin feat/x $(echo --force)',
    // wrapper prefixes
    'timeout 30 git push --force-with-lease --all origin',
    'timeout -s KILL 30 git push --force-with-lease --force origin feat/x',
    '/usr/bin/env git push --force-with-lease --all origin',
    'env -u FOO git push --force-with-lease --all origin',
    'env -i git push --force-with-lease --all origin',
    'env A=1 B=2 git push --force-with-lease --all origin',
    'stdbuf -oL git push --force-with-lease --all origin',
    'caffeinate -i git push --force-with-lease --all origin',
    'xcrun git push --force-with-lease --all origin',
    'sudo -u bob git push --force-with-lease --all origin',
    // wrapped / dynamic invocations
    "bash -lc 'git push --force origin feat/x'",
    'sh -e -c "git push --force-with-lease origin feat/x"',
    "zsh -c 'git push --force origin feat/x'",
    "ksh -c 'git push --force origin feat/x'",
    "dash -c 'git push --force origin feat/x'",
    'echo "git push --force origin main" | bash',
    'echo "git push --force origin main" | /bin/sh',
    "python3 -c \"import subprocess; subprocess.run(['git','push','--force','origin','main'])\"",
    "node -e \"require('child_process').execSync('git push --force origin main')\"",
  ];
  const allowed = [
    'git push --force-with-lease --signed origin feat/x',
    'timeout 30 git push --force-with-lease origin feat/x',
    '/usr/bin/env git push --force-with-lease origin feat/x',
    'env -u FOO git push --force-with-lease origin feat/x',
    'sudo -u bob git push --force-with-lease origin feat/x',
    'stdbuf -oL git push --force-with-lease origin feat/x',
    'git -C ./sub push --force-with-lease origin feat/x',
    'git push origin feature-x', // control: a plain push with no expansion
    'git push --force-with-lease origin feat/x 2>&1', // redirection tokens are ignored
    'git push --force-with-lease origin feat/x > /tmp/out.txt',
    'git push --force-with-lease origin feat/x # note: mid-comment --force is just a comment',
    'git config --get remote.origin.url',
    'git config user.name someone',
    'git symbolic-ref --short HEAD',
    'git branch -f feat/x HEAD',
    "bash -c 'echo hello'",
    'echo push | bash',
  ];
  for (const cmd of denied) {
    it(`denies: ${cmd}`, async () => {
      const { ctx } = await loadHooks();
      assert.equal((await evaluate(ctx.hooks, 'shell', cmd)).denied, true);
    });
  }
  for (const cmd of allowed) {
    it(`allows: ${cmd}`, async () => {
      const { ctx } = await loadHooks();
      assert.equal((await evaluate(ctx.hooks, 'shell', cmd)).denied, false);
    });
  }
});

describe('round-4 hardening (redirection spelling, expansion, generic fallback)', () => {
  const denied = [
    // MAJOR X: quoted/escaped angle brackets are legal ref-name characters, not redirections
    "git branch '>x' && git push --force-with-lease origin '>x:ma''in'",
    'git push --force-with-lease origin \\>x:main',
    "git push --force-with-lease origin '>x:main'",
    'git push --force-with-lease origin "<x:main"',
    // a redirection whose target looks like a refspec
    'git push --force-with-lease origin >x:main',
    // MAJOR Y: expansion hiding the subcommand / flags
    'P=push; git $P --force origin main',
    'G=git; $G push --force origin main',
    'P=push F=--force; git $P $F origin main',
    'git `echo push` --force origin main',
    // generic fail-closed fallback: forms parseGit cannot evaluate as a push
    "env -S 'git push --force origin main'",
    'env -S "git push --force-with-lease origin feat/x"',
    'exec -a name git push --force origin main',
    'env -P /usr/bin git push --force origin main',
    'stdbuf -o L git push --force origin main',
    "git -c 'a.b= #' push --force origin main",
    "git -c 'a.b= #' push --force-with-lease --all origin",
    // env/sudo chdir behave like git -C
    'env -C /etc git push --force-with-lease origin feat/x',
    'env --chdir=/etc git push --force-with-lease origin feat/x',
    'sudo -D /etc git push --force-with-lease origin feat/x',
    'env -C a git -C b push --force-with-lease origin feat/x',
    // '&' forms of redirection must not swallow (or split off) the refspec that follows
    'git push --force-with-lease origin 2>&1 HEAD:main',
    'git push --force-with-lease origin &>/dev/null main',
    'git push --force-with-lease origin >&1 main',
    'git push --force-with-lease origin >&- HEAD:main',
    'git push --force-with-lease origin 2>&1 main',
    // looser export/declare/local spellings taint the following push
    'export -- GIT_DIR=/tmp/x && git push --force-with-lease origin feat/x',
    'declare -gx GIT_DIR=/tmp/x; git push --force-with-lease origin feat/x',
    'local -x GIT_DIR=/tmp/x; git push --force-with-lease origin feat/x',
  ];
  const allowed = [
    // glued / spaced REAL redirections on a legit lease push
    'git push --force-with-lease origin feat/x 2>&1',
    'git push --force-with-lease origin feat/x > /tmp/out.txt',
    'git push --force-with-lease origin feat/x >out',
    'git push --force-with-lease origin feat/x 2>/dev/null',
    'git push --force-with-lease origin feat/x >>/tmp/log 2>&1',
    'git push --force-with-lease origin feat/x </dev/null',
    'git push --force-with-lease origin feat/x &>/dev/null',
    'git push --force-with-lease origin feat/x &>>/tmp/log',
    'git push --force-with-lease origin feat/x >&2',
    'git push origin feature-x 2>&1 | tail',
    'git status && git push --force-with-lease origin feat/x',
    'sleep 1 & git push --force-with-lease origin feat/x', // a genuine background '&' still splits
    // controls
    'echo $HOME',
    'git commit -m "cost $5" && git push origin feature-x',
    'git log --oneline',
    'git push origin feature-x',
    'env -C ./sub git push --force-with-lease origin feat/x',
  ];
  for (const cmd of denied) {
    it(`denies: ${cmd}`, async () => {
      const { ctx } = await loadHooks();
      assert.equal((await evaluate(ctx.hooks, 'shell', cmd)).denied, true);
    });
  }
  for (const cmd of allowed) {
    it(`allows: ${cmd}`, async () => {
      const { ctx } = await loadHooks();
      assert.equal((await evaluate(ctx.hooks, 'shell', cmd)).denied, false);
    });
  }

  // Judgement call, documented in the runbook: text that merely MENTIONS a force push is
  // denied too (fail closed) — we do not try to tell prose from commands.
  it('denies (documented false positive): echo "git push --force" > notes.txt', async () => {
    const { ctx } = await loadHooks();
    assert.equal(
      (await evaluate(ctx.hooks, 'shell', 'echo "git push --force" > notes.txt')).denied,
      true,
    );
  });
});

describe('multi-resource evaluation', () => {
  it('denies when ANY shell resource is blocked (not just the first)', async () => {
    const { ctx } = await loadHooks();
    assert.equal(
      (await evaluate(ctx.hooks, 'shell', ['ls -la', 'git merge feature'])).denied,
      true,
    );
  });

  it('denies when ANY edit resource is blocked', async () => {
    const { ctx } = await loadHooks();
    const r = await evaluate(ctx.hooks, 'edit', [
      join(worktree, 'src/ok.ts'),
      join(worktree, '.ai-sdlc/x.yaml'),
    ]);
    assert.equal(r.denied, true);
  });

  it('denies when ANY edit resource is outside the worktree', async () => {
    const { ctx } = await loadHooks();
    const r = await evaluate(ctx.hooks, 'patch', [join(worktree, 'src/ok.ts'), '/etc/passwd']);
    assert.equal(r.denied, true);
  });

  it('allows when every resource is fine', async () => {
    const { ctx } = await loadHooks();
    const r = await evaluate(ctx.hooks, 'edit', [
      join(worktree, 'src/a.ts'),
      join(worktree, 'src/b.ts'),
    ]);
    assert.equal(r.denied, false);
  });

  it('accepts a bare (non-array) resource', async () => {
    const { ctx } = await loadHooks();
    const input = { action: 'edit', resources: join(worktree, '.ai-sdlc/x'), sessionID: 's' };
    await ctx.hooks['permission.evaluate'](input);
    assert.equal(input.effect, 'deny');
  });
});

describe('path governance', () => {
  const rel = [
    ['.ai-sdlc/agent-role.yaml', true],
    ['.github/workflows/ci.yml', true],
    ['scripts/verify-attestation.mjs', true],
    ['opencode.json', true],
    ['opencode.jsonc', true],
    ['.opencode/plugins/ai-sdlc-governance.js', true],
    ['.opencode/agents/developer.md', true],
    ['src/feature.ts', false],
    ['docs/readme.md', false],
    ['opencode.json.md', false],
  ];
  for (const [p, expected] of rel) {
    it(`${expected ? 'denies' : 'allows'} edit of ${p} (relative to the session dir)`, async () => {
      const { ctx } = await loadHooks();
      assert.equal((await evaluate(ctx.hooks, 'edit', p)).denied, expected);
    });
  }

  it('write action is governed the same as edit', async () => {
    const { ctx } = await loadHooks();
    assert.equal((await evaluate(ctx.hooks, 'write', join(worktree, '.ai-sdlc/x'))).denied, true);
  });

  it('denies writes outside the active worktree with no permittedExternalPaths', async () => {
    const { ctx } = await loadHooks();
    const r = await evaluate(ctx.hooks, 'edit', join(sibling, 'file.txt'));
    assert.equal(r.denied, true);
    assert.match(r.message, /outside the agent's active worktree/);
  });

  it('AI_SDLC_ACTIVE_TASK_ID unlocks the task permittedExternalPaths allowance', async () => {
    setEnv('AI_SDLC_ACTIVE_TASK_ID', 'AISDLC-99');
    const { ctx } = await loadHooks();
    assert.equal((await evaluate(ctx.hooks, 'edit', join(sibling, 'file.txt'))).denied, false);
    // ...but only that path: other outside paths stay denied.
    const other = await evaluate(ctx.hooks, 'edit', '/etc/hosts');
    assert.equal(other.denied, true);
    assert.match(other.message, /permittedExternalPaths/);
  });

  it('the .ai-sdlc floor still holds inside the worktree when a task is active', async () => {
    setEnv('AI_SDLC_ACTIVE_TASK_ID', 'AISDLC-99');
    const { ctx } = await loadHooks();
    assert.equal((await evaluate(ctx.hooks, 'edit', join(worktree, '.ai-sdlc/x'))).denied, true);
  });

  it('symlinks are resolved: a link out of the worktree cannot smuggle a write outside', async () => {
    symlinkSync(sibling, join(worktree, 'link-out'));
    const { ctx } = await loadHooks();
    const r = await evaluate(ctx.hooks, 'edit', 'link-out/new-file.txt');
    assert.equal(r.denied, true);
    assert.match(r.message, /outside the agent's active worktree/);
  });

  it('symlinks are resolved: a link into .ai-sdlc is still under the floor', async () => {
    mkdirSync(join(worktree, '.ai-sdlc'), { recursive: true });
    symlinkSync(join(worktree, '.ai-sdlc'), join(worktree, 'innocent-docs'));
    const { ctx } = await loadHooks();
    assert.equal((await evaluate(ctx.hooks, 'edit', 'innocent-docs/agent-role.yaml')).denied, true);
    // ...and a link to an ordinary in-worktree dir stays allowed
    mkdirSync(join(worktree, 'real-src'), { recursive: true });
    symlinkSync(join(worktree, 'real-src'), join(worktree, 'src-link'));
    assert.equal((await evaluate(ctx.hooks, 'edit', 'src-link/a.ts')).denied, false);
  });

  it('a permitted external dir reached through a symlink to elsewhere is still denied', async () => {
    setEnv('AI_SDLC_ACTIVE_TASK_ID', 'AISDLC-99');
    const elsewhere = mkdtempSync(join(tmpdir(), 'oc-gov-else-'));
    try {
      const { ctx } = await loadHooks();
      const viaLink = join(sibling, 'sneaky');
      symlinkSync(elsewhere, viaLink);
      assert.equal((await evaluate(ctx.hooks, 'edit', join(viaLink, 'f.txt'))).denied, true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
      rmSync(join(sibling, 'sneaky'), { force: true });
    }
  });

  it('policy is snapshotted at setup: a later rewrite of agent-role.yaml cannot weaken it', async () => {
    const { ctx } = await loadHooks();
    const yamlPath = join(root, '.ai-sdlc', 'agent-role.yaml');
    writeFileSync(
      yamlPath,
      'blockedActions:\n  - "nothing-matches-this*"\nblockedPaths:\n  - "nothing/**"\n',
    );
    try {
      assert.equal((await evaluate(ctx.hooks, 'shell', 'git merge x')).denied, true);
      assert.equal(
        (await evaluate(ctx.hooks, 'edit', join(worktree, '.github/workflows/ci.yml'))).denied,
        true,
      );
    } finally {
      writeFileSync(yamlPath, REAL_AGENT_ROLE);
    }
  });

  it('permittedExternalPaths is snapshotted at setup: editing the task file or switching ids cannot widen it', async () => {
    setEnv('AI_SDLC_ACTIVE_TASK_ID', 'AISDLC-99');
    const { ctx } = await loadHooks();
    const taskPath = join(root, 'backlog', 'tasks', 'aisdlc-99 - test-task.md');
    const original = readFileSync(taskPath, 'utf-8');
    const other = mkdtempSync(join(tmpdir(), 'oc-gov-widen-'));
    try {
      writeFileSync(taskPath, original.replace(sibling, other));
      setEnv('AI_SDLC_ACTIVE_TASK_ID', 'AISDLC-1');
      assert.equal((await evaluate(ctx.hooks, 'edit', join(other, 'f.txt'))).denied, true);
      assert.equal((await evaluate(ctx.hooks, 'edit', join(sibling, 'f.txt'))).denied, false);
    } finally {
      writeFileSync(taskPath, original);
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('non-shell, non-edit actions (read, mcp) get no opinion', async () => {
    const { ctx } = await loadHooks();
    assert.equal((await evaluate(ctx.hooks, 'read', '/etc/passwd')).denied, false);
    assert.equal((await evaluate(ctx.hooks, 'ai-sdlc_task_list', '{}')).denied, false);
  });

  it('the hardcoded floors apply even when agent-role.yaml is absent', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'oc-gov-bare-'));
    try {
      setEnv('AI_SDLC_PROJECT_ROOT', bare);
      const { ctx } = await loadHooks({ directory: bare });
      assert.equal((await evaluate(ctx.hooks, 'edit', join(bare, '.ai-sdlc/x'))).denied, true);
      assert.equal((await evaluate(ctx.hooks, 'shell', `${PR_MERGE} 5`)).denied, true); // merge floor
      assert.equal((await evaluate(ctx.hooks, 'edit', join(bare, 'src/a.ts'))).denied, false);
    } finally {
      setEnv('AI_SDLC_PROJECT_ROOT', root);
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('fail-open on internal error', () => {
  it('a throwing input never propagates and never denies', async () => {
    const { ctx } = await loadHooks();
    const input = {
      get action() {
        throw new Error('boom');
      },
    };
    await assert.doesNotReject(ctx.hooks['permission.evaluate'](input));
    assert.equal(input.effect, undefined);
  });

  it('a failing session lookup falls back instead of breaking the evaluation', async () => {
    const ctx = makeCtx();
    ctx.session.get = async () => {
      throw new Error('no session');
    };
    await plugin.setup(ctx);
    const input = { action: 'edit', resources: ['/etc/passwd'], sessionID: 'x' };
    await assert.doesNotReject(ctx.hooks['permission.evaluate'](input));
  });

  it('telemetry failure never throws', async () => {
    const { ctx } = await loadHooks();
    writeFileSync(join(telemetryDir, 'file-not-dir'), 'blocker');
    setEnv('AI_SDLC_TELEMETRY_DIR', join(telemetryDir, 'file-not-dir', 'x'));
    try {
      await assert.doesNotReject(
        ctx.hooks['tool.execute.after']({ sessionID: 's', tool: 'read', input: {} }),
      );
    } finally {
      setEnv('AI_SDLC_TELEMETRY_DIR', telemetryDir);
    }
  });
});

describe('tool.execute.after telemetry (JSONL shape)', () => {
  it('appends {ts,sid,tool,action,project} lines, canonicalizing the action', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-gov-tel-'));
    setEnv('AI_SDLC_TELEMETRY_DIR', dir);
    try {
      const { ctx } = await loadHooks();
      const afterHook = ctx.hooks['tool.execute.after'];
      await afterHook({
        sessionID: 'ses_1',
        tool: 'shell',
        input: { command: 'git status && pnpm test -- x' },
      });
      await afterHook({ sessionID: 'ses_1', tool: 'read', input: { path: 'src/a.ts' } });
      await afterHook({ sessionID: 'ses_1', tool: 'grep', input: { pattern: 'needle' } });
      await afterHook({
        sessionID: 'ses_1',
        tool: 'webfetch',
        input: { url: 'https://example.com' },
      });
      await afterHook({ sessionID: 'ses_2', tool: 'Custom', input: null });

      const lines = readFileSync(join(dir, 'tool-sequences.jsonl'), 'utf-8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(lines.length, 5);
      for (const l of lines) {
        assert.deepEqual(Object.keys(l).sort(), ['action', 'project', 'sid', 'tool', 'ts']);
        assert.ok(!Number.isNaN(Date.parse(l.ts)));
        assert.equal(l.project, root);
      }
      assert.deepEqual(
        lines.map((l) => [l.sid, l.tool, l.action]),
        [
          ['ses_1', 'shell', 'pnpm test --'],
          ['ses_1', 'read', 'read:.ts'],
          ['ses_1', 'grep', 'grep:needle'],
          ['ses_1', 'webfetch', 'webfetch:https://example.com'],
          ['ses_2', 'Custom', 'custom'],
        ],
      );
    } finally {
      setEnv('AI_SDLC_TELEMETRY_DIR', telemetryDir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('session.context banner', () => {
  it('pushes the hard-rules banner once (marker-guarded, idempotent)', async () => {
    const { ctx } = await loadHooks();
    const req = { system: [{ type: 'text', text: 'base prompt' }] };
    await ctx.hooks['session.context'](req);
    assert.equal(req.system.length, 2);
    assert.match(req.system[1].text, /AI-SDLC GOVERNANCE/);
    assert.match(req.system[1].text, /Never merge PRs/);
    await ctx.hooks['session.context'](req);
    assert.equal(req.system.length, 2, 'second call must not double-inject');
  });

  it('ignores a request without a system array', async () => {
    const { ctx } = await loadHooks();
    await assert.doesNotReject(ctx.hooks['session.context']({}));
    await assert.doesNotReject(ctx.hooks['session.context'](undefined));
  });
});

/* ── Parity with the legacy Claude hook ────────────────────────────── */

function legacyDenied(toolName, toolInput) {
  const parse = (out) => {
    if (!out || !out.toString().trim()) return false;
    return JSON.parse(out.toString()).hookSpecificOutput?.permissionDecision === 'deny';
  };
  try {
    const out = execFileSync('node', [LEGACY_HOOK], {
      input: JSON.stringify({ tool_name: toolName, tool_input: toolInput }),
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      timeout: 10_000,
    });
    return parse(out);
  } catch (err) {
    return parse(err.stdout);
  }
}

describe('parity with the legacy ai-sdlc-plugin enforce-blocked-actions hook', () => {
  before(() => {
    assert.ok(existsSync(LEGACY_HOOK));
  });

  const commands = [
    `${PR_MERGE} 42`,
    `${PR_MERGE} 42 --auto --squash`,
    'git merge feature',
    'git push --force origin main',
    'git push -f origin main',
    'git push origin feature',
    `${GH_PR} close 7`,
    'gh issue close 7',
    'git branch -D old',
    'git reset --hard HEAD',
    'git checkout -- .',
    'git restore .',
    'git stash pop',
    'git stash clear',
    'git stash drop',
    'git stash drop stash@{0}',
    'git stash push -u -m tag',
    'echo hello',
    'git status',
  ];
  for (const command of commands) {
    it(`shell agrees: ${command}`, async () => {
      const { ctx } = await loadHooks({ directory: root });
      const ours = (await evaluate(ctx.hooks, 'shell', command)).denied;
      assert.equal(
        ours,
        legacyDenied('Bash', { command }),
        `plugin vs legacy disagree on: ${command}`,
      );
    });
  }

  const paths = [
    ['.ai-sdlc', 'agent-role.yaml'],
    ['.github', 'workflows', 'ci.yml'],
    ['scripts', 'verify-attestation.mjs'],
    ['src', 'ok.ts'],
  ];
  const absPaths = () => [...paths.map((p) => join(root, ...p)), '/etc/passwd'];
  for (let i = 0; i <= paths.length; i++) {
    it(`path agrees: ${i < paths.length ? paths[i].join('/') : '/etc/passwd'}`, async () => {
      const file_path = absPaths()[i];
      const { ctx } = await loadHooks({ directory: root });
      const ours = (await evaluate(ctx.hooks, 'edit', file_path)).denied;
      assert.equal(
        ours,
        legacyDenied('Edit', { file_path }),
        `plugin vs legacy disagree on: ${file_path}`,
      );
    });
  }

  // DELIBERATE divergences (documented, asserted so drift is a conscious act).
  describe('deliberate divergences', () => {
    it('strict force-with-lease: legacy denies it, the plugin allows it (DoD requires it)', async () => {
      const command = 'git push --force-with-lease origin feat/x';
      const { ctx } = await loadHooks({ directory: root });
      assert.equal((await evaluate(ctx.hooks, 'shell', command)).denied, false);
      assert.equal(legacyDenied('Bash', { command }), true);
    });

    it('harness config (opencode.json, .opencode/**) is a plugin-only floor', async () => {
      const file_path = join(root, 'opencode.json');
      const { ctx } = await loadHooks({ directory: root });
      assert.equal((await evaluate(ctx.hooks, 'edit', file_path)).denied, true);
      assert.equal(legacyDenied('Edit', { file_path }), false);
    });

    it('chained commands: the plugin is segment-aware, the legacy glob only anchors at the start', async () => {
      const command = 'cd x && git merge y';
      const { ctx } = await loadHooks({ directory: root });
      assert.equal((await evaluate(ctx.hooks, 'shell', command)).denied, true);
      assert.equal(legacyDenied('Bash', { command }), false);
    });

    it('a force flag AFTER the remote: the plugin is stricter than the legacy prefix glob', async () => {
      const command = 'git push origin feat/x --force';
      const { ctx } = await loadHooks({ directory: root });
      assert.equal((await evaluate(ctx.hooks, 'shell', command)).denied, true);
      assert.equal(legacyDenied('Bash', { command }), false);
    });
  });
});
