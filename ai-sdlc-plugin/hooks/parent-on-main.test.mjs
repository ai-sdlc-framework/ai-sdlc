/**
 * Tests for the parent-on-main hook (AISDLC-764).
 * Run with: node --test ai-sdlc-plugin/hooks/parent-on-main.test.mjs
 * Real temp git repos with a Pattern C layout; no network.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const lib = require('./lib/parent-on-main.js');
const HOOK = join(here, 'parent-on-main.sh');

let root; // the Pattern C parent
let wt; // a task worktree
let plain; // a plain repo with no .worktrees

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const initRepo = (d) => {
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@t');
  git(d, 'config', 'user.name', 't');
  writeFileSync(join(d, 'a.txt'), 'a\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
};

before(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'parent-on-main-')));
  root = join(base, 'parent');
  plain = join(base, 'plain');
  mkdirSync(root);
  mkdirSync(plain);
  initRepo(root);
  initRepo(plain);
  wt = join(root, '.worktrees', 'aisdlc-1');
  git(root, 'worktree', 'add', '-q', '-b', 'ai-sdlc/aisdlc-1', wt);
});
after(() => rmSync(dirname(root), { recursive: true, force: true }));

const pre = (tool_name, tool_input, cwd) => lib.evaluatePreToolUse({ tool_name, tool_input, cwd });

describe('findParentRoot', () => {
  it('resolves the parent from the parent and from a worktree, and null elsewhere', () => {
    assert.equal(lib.findParentRoot(root), root);
    assert.equal(lib.findParentRoot(wt), root);
    assert.equal(lib.findParentRoot(plain), null);
    assert.equal(lib.findParentRoot(join(tmpdir(), 'does-not-exist-xyz')), null);
  });
});

describe('PreToolUse deny', () => {
  it('denies Edit/Write/MultiEdit of a source file in the parent, naming the worktree', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      const r = pre(tool, { file_path: join(root, 'a.txt') }, root);
      assert.match(r, /parent checkout/);
      assert.match(r, /\.worktrees\/<task-id>/);
    }
  });
  it('denies a relative path resolved against the parent cwd, and a parent path from a worktree cwd', () => {
    assert.ok(pre('Write', { file_path: 'new.txt' }, root));
    assert.ok(pre('Edit', { file_path: join(root, 'src', 'x.ts') }, wt));
  });
  it('allows writes in the worktree, the runtime dirs, other repos and non-write tools', () => {
    assert.equal(pre('Edit', { file_path: join(wt, 'a.txt') }, wt), null);
    assert.equal(
      pre('Write', { file_path: join(root, '.ai-sdlc', 'dispatch', 'x.json') }, root),
      null,
    );
    assert.equal(pre('Write', { file_path: join(root, '.claude', 'memory', 'm.md') }, root), null);
    assert.equal(pre('Write', { file_path: join(plain, 'a.txt') }, plain), null);
    assert.equal(pre('Read', { file_path: join(root, 'a.txt') }, root), null);
    assert.equal(pre('Write', {}, root), null);
    assert.equal(pre('Write', { file_path: '/etc/hosts-not-ours' }, root), null);
  });
  it('denies branch creation with the parent as cwd, allows it in a worktree and a plain repo', () => {
    for (const cmd of [
      'git checkout -b feat/x',
      'git switch -c feat/x',
      'cd . && git checkout -B y',
      'git checkout --orphan z',
    ]) {
      assert.match(pre('Bash', { command: cmd }, root), /Creating a branch in the parent/);
    }
    assert.equal(pre('Bash', { command: 'git checkout -b feat/x' }, wt), null);
    assert.equal(pre('Bash', { command: 'git checkout -b feat/x' }, plain), null);
    assert.equal(pre('Bash', { command: 'git checkout main' }, root), null);
    assert.equal(pre('Bash', { command: 'git status' }, root), null);
    assert.ok(pre('Bash', { command: `git -C ${root} switch -c q` }, wt));
    assert.equal(pre('Bash', { command: `git -C ${wt} checkout -b q` }, root), null);
    assert.equal(pre('Bash', {}, root), null);
  });
});

describe('PreToolUse deny: evasion forms (round 2)', () => {
  const denied = (cmd, cwd = root) => {
    const r = pre('Bash', { command: cmd }, cwd);
    assert.ok(r, `expected deny: ${cmd}`);
    return r;
  };
  it('sees through quotes, including a quoted -C path', () => {
    denied('git checkout -b "feat/x"');
    denied("git 'checkout' '-b' x");
    denied(`git -C "${root}" switch -c q`, wt);
    denied(`git -C '${root}' checkout -b q`, wt);
  });
  it('skips arbitrary git global options', () => {
    denied('git -c user.name=x checkout -b y');
    denied('git --no-pager checkout -b y');
    denied('git -c a=b -c c=d --no-pager switch -c y');
    denied(`git --work-tree=${root} checkout -b y`, wt);
    denied('GIT_TRACE=1 git checkout -b y');
  });
  it('allows options between the subcommand and the branch flag', () => {
    denied('git checkout -q -b x');
    denied('git checkout -qb x');
    denied('git checkout --quiet -B x');
    denied('git switch --quiet -c x');
    denied('git switch --discard-changes --create x');
    denied('git checkout --orphan=z');
  });
  it('tracks a leading cd into the parent and ignores a cd into a worktree', () => {
    denied(`cd ${root} && git checkout -b x`, wt);
    denied(`cd "${root}"; git switch -c x`, wt);
    assert.equal(pre('Bash', { command: `cd ${wt} && git checkout -b x` }, root), null);
    assert.equal(pre('Bash', { command: `cd ${plain} && git checkout -b x` }, root), null);
  });
  it('denies a switch to a non-main branch in the parent, allows main, files and worktrees', () => {
    git(root, 'branch', 'stray-existing-branch');
    assert.match(denied('git checkout stray-existing-branch'), /Switching/);
    assert.match(denied('git switch whatever'), /Switching/);
    assert.equal(pre('Bash', { command: 'git checkout stray-existing-branch' }, wt), null);
    assert.equal(pre('Bash', { command: 'git checkout nonexistent-ref-or-file' }, root), null);
  });
  it('does not flag non-branch checkouts', () => {
    assert.equal(pre('Bash', { command: 'git checkout -- a.txt' }, root), null);
    assert.equal(pre('Bash', { command: 'git checkout a.txt' }, root), null);
    assert.equal(pre('Bash', { command: 'git checkout main' }, root), null);
    assert.equal(pre('Bash', { command: 'git switch main' }, root), null);
    assert.equal(pre('Bash', { command: 'git log --oneline | head -3' }, root), null);
    assert.equal(pre('Bash', { command: 'echo "git checkout -b x"' }, root), null);
  });
  it('compares realpaths for Write/Edit: symlink and dot-dot into the parent are denied', () => {
    const link = join(dirname(root), 'link-to-parent');
    symlinkSync(root, link);
    assert.ok(pre('Write', { file_path: join(link, 'a.txt') }, plain));
    assert.ok(pre('Write', { file_path: join(wt, '..', '..', 'a.txt') }, wt));
    const wlink = join(dirname(root), 'link-to-wt');
    symlinkSync(wt, wlink);
    assert.equal(pre('Write', { file_path: join(wlink, 'a.txt') }, wlink), null);
  });
  it('tokenises quoting and separators', () => {
    assert.deepEqual(lib.shellSegments('a "b c" \'d e\'; f && g|h'), [
      ['a', 'b c', 'd e'],
      ['f'],
      ['g'],
      ['h'],
    ]);
  });
});

describe('SessionStart check', () => {
  it('is ok on main, skips a worktree session and a plain repo', () => {
    assert.equal(lib.checkParentOnMain(root).status, 'ok');
    assert.equal(lib.checkParentOnMain(wt).status, 'skip');
    assert.equal(lib.checkParentOnMain(plain).status, 'skip');
  });
  it('recovers a clean parent left on another branch, and leaves a dirty one alone', () => {
    git(root, 'checkout', '-q', '-b', 'stray');
    const r = lib.checkParentOnMain(root);
    assert.equal(r.status, 'recovered');
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'main');
    git(root, 'checkout', '-q', '-b', 'stray2');
    writeFileSync(join(root, 'a.txt'), 'dirty\n');
    const d = lib.checkParentOnMain(root);
    assert.equal(d.status, 'dirty');
    assert.match(d.message, /NOT touched/);
    assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'stray2');
    git(root, 'checkout', '-q', '--', 'a.txt');
    git(root, 'checkout', '-q', 'main');
  });
  it('reports an error when git cannot run the checkout', () => {
    const fake = (cwd, args) => {
      if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return join(root, '.git');
      if (args[0] === 'rev-parse') return root;
      if (args[0] === 'symbolic-ref') return 'stray';
      if (args[0] === 'status') return '';
      throw new Error('boom');
    };
    const r = lib.checkParentOnMain(root, { git: fake });
    assert.equal(r.status, 'error');
    assert.match(r.message, /failed/);
  });
});

describe('hook process', () => {
  const run = (input) =>
    spawnSync('bash', [HOOK], { input: JSON.stringify(input), encoding: 'utf-8' });

  it('emits a deny decision for a parent write and nothing for a worktree write', () => {
    const denied = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(root, 'a.txt') },
      cwd: root,
    });
    assert.equal(denied.status, 0);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const ok = run({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(wt, 'a.txt') },
      cwd: wt,
    });
    assert.equal(ok.stdout, '');
  });
  it('emits SessionStart context for a dirty stray parent and nothing on main', () => {
    assert.equal(run({ hook_event_name: 'SessionStart', cwd: root }).stdout, '');
    git(root, 'checkout', '-q', '-b', 'stray3');
    writeFileSync(join(root, 'a.txt'), 'dirty\n');
    const out = run({ hook_event_name: 'SessionStart', cwd: root });
    assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /not main/);
    git(root, 'checkout', '-q', '--', 'a.txt');
    git(root, 'checkout', '-q', 'main');
  });
  it('exits 0 silently on unreadable input', () => {
    const r = spawnSync('bash', [HOOK], { input: 'not json', encoding: 'utf-8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('registration', () => {
  it('is registered for SessionStart and PreToolUse in both plugin manifests', () => {
    for (const p of ['../plugin.json', '../.claude-plugin/plugin.json']) {
      const m = JSON.parse(readFileSync(join(here, p), 'utf-8'));
      const ss = JSON.stringify(m.hooks.SessionStart);
      assert.match(ss, /parent-on-main\.sh/);
      const pre = m.hooks.PreToolUse.find((e) => JSON.stringify(e).includes('parent-on-main.sh'));
      assert.match(pre.matcher, /Write/);
      assert.match(pre.matcher, /Bash/);
    }
  });
});
