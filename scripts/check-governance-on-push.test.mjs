/**
 * AISDLC-1123: hermetic tests for `scripts/check-governance-on-push.sh`.
 * Each case builds a throwaway repo with real copies of the governance scripts.
 *
 * Run with: node --test scripts/check-governance-on-push.test.mjs
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();

function put(path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function fixture() {
  root = mkdtempSync(join(tmpdir(), 'ai-sdlc-gov-gate-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 't']);
  mkdirSync(join(root, 'scripts'));
  for (const f of [
    'check-governance-on-push.sh',
    'check-pr-governance.mjs',
    'is-docs-only-changeset.mjs',
  ]) {
    copyFileSync(join(HERE, f), join(root, 'scripts', f));
  }
  cpSync(
    join(REPO, 'pipeline-cli', 'attestation-core'),
    join(root, 'pipeline-cli', 'attestation-core'),
    {
      recursive: true,
    },
  );
  put('README.md', 'x\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
}

function commit(files, remove = []) {
  for (const [p, t] of Object.entries(files)) put(p, t);
  for (const p of remove) git(['rm', '-q', p]);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'work']);
}

function push(remoteSha = '0'.repeat(40), pathPrefix = '') {
  const head = git(['rev-parse', 'HEAD']);
  return spawnSync('bash', [join(root, 'scripts', 'check-governance-on-push.sh')], {
    cwd: root,
    input: `refs/heads/b ${head} refs/heads/b ${remoteSha}\n`,
    encoding: 'utf-8',
    env: { ...process.env, PATH: pathPrefix + process.env.PATH },
    timeout: 60000,
  });
}

const WAIVED = '- `pnpm test` - waived\n';

describe('check-governance-on-push.sh', () => {
  it('refuses a waived-tests marker with pipeline code, passes once removed', () => {
    fixture();
    commit({
      'pipeline-cli/src/a.ts': 'export const a = 1;\n',
      'backlog/completed/AISDLC-9 - t.md': WAIVED,
    });
    const r = push();
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /waived-tests/);
    commit({ 'backlog/completed/AISDLC-9 - t.md': '- `pnpm test` - 12 passed\n' });
    assert.equal(push().status, 0);
  });

  it('ranges a rebased lease push from the origin/main merge-base (AISDLC-1143)', () => {
    fixture();
    const fork = git(['rev-parse', 'HEAD']);
    commit({ 'src/own.txt': 'own\n' });
    const staleRemote = git(['rev-parse', 'HEAD']);
    // main moves on: a landed commit adds a waived-tests task file next to pipeline code.
    git(['checkout', '-q', '-b', 'newmain', fork]);
    commit({
      'pipeline-cli/src/m.ts': 'export const m = 1;\n',
      'backlog/completed/AISDLC-8 - m.md': WAIVED,
    });
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    // the branch is rebased onto the new main; the remote still has the old head.
    git(['checkout', '-q', '-b', 'rebased']);
    commit({ 'src/own.txt': 'own2\n' });
    assert.equal(push(staleRemote).status, 0);
    commit({
      'pipeline-cli/src/b.ts': 'export const b = 1;\n',
      'backlog/completed/AISDLC-7 - b.md': WAIVED,
    });
    const r = push(staleRemote);
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /waived-tests/);
  });

  it('refuses a conflict marker in any file', () => {
    fixture();
    commit({ 'src/x.txt': 'a\n<<<<<<< HEAD\nb\n' });
    const r = push();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /conflict marker/);
  });

  it('passes a docs-only push and runs no reviewers check', () => {
    fixture();
    commit({ 'docs/a.md': 'hello\n' });
    const r = push();
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /reviewers/);
  });

  it('does not run drift when no referenced file is removed', () => {
    fixture();
    commit({ 'docs/a.md': 'hello\n' });
    assert.doesNotMatch(push().stderr, /backlog-drift/);
  });

  it('runs drift when a removed file is referenced from backlog/', () => {
    fixture();
    commit({ 'docs/gone.md': 'x\n', 'backlog/tasks/t.md': 'see docs/gone.md\n' });
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    commit({}, ['docs/gone.md']);
    assert.match(push().stderr, /referenced from backlog\//);
  });

  describe('drift severity gate (AISDLC-1146)', () => {
    // Stub `npx`: `check --json` prints the report and both calls exit 1.
    function driftPush(report) {
      fixture();
      commit({ 'docs/gone.md': 'x\n', 'backlog/tasks/t.md': 'see docs/gone.md\n' });
      git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
      commit({}, ['docs/gone.md']);
      const bin = join(root, 'stub-bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'report.txt'), report);
      writeFileSync(
        join(bin, 'npx'),
        `#!/bin/sh\ncase "$*" in *--json*) cat "${join(bin, 'report.txt')}";; esac\nexit 1\n`,
        { mode: 0o755 },
      );
      return push(undefined, `${bin}:`);
    }

    it('passes with only info/warning findings', () => {
      const r = driftPush('[{"severity":"warning"},{"severity":"info"}]');
      assert.doesNotMatch(r.stderr, /push blocked/);
      assert.match(r.stderr, /gate passed \(info\/warning issues are informational/);
      assert.equal(r.status, 0);
    });

    it('blocks on an error finding and names the fix command', () => {
      const r = driftPush('[{"severity":"error"},{"severity":"info"}]');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /1 error-severity issue\(s\); fix with npx backlog-drift fix --task/);
    });

    it('blocks on an unreadable report and prints the exit code', () => {
      const r = driftPush('not json');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /not valid JSON \(backlog-drift exit code 1\)/);
    });
  });

  it('is skippable and the hook wires it in', () => {
    fixture();
    commit({ 'src/x.txt': '<<<<<<< HEAD\n' });
    const head = git(['rev-parse', 'HEAD']);
    const r = spawnSync('bash', [join(root, 'scripts', 'check-governance-on-push.sh')], {
      cwd: root,
      input: `refs/heads/b ${head} refs/heads/b ${'0'.repeat(40)}\n`,
      encoding: 'utf-8',
      env: { ...process.env, AI_SDLC_SKIP_GOVERNANCE_GATE: '1' },
    });
    assert.equal(r.status, 0);
    const hook = readFileSync(join(REPO, '.husky', 'pre-push'), 'utf-8');
    assert.match(hook, /check-governance-on-push\.sh/);
    assert.match(hook, /AI_SDLC_SKIP_GOVERNANCE_GATE=1/);
  });
});
