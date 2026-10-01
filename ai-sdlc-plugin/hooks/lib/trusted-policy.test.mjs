/**
 * Unit tests for the shared trusted-policy helpers (injected runners, no network).
 * Run with: node --test ai-sdlc-plugin/hooks/lib/trusted-policy.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  probeRef,
  runGit,
  mainCheckoutRoot,
  verifiedMainRoot,
  loadTrustedExtras,
  bannerGovernance,
  readTaskId,
} = require('./trusted-policy.js');
const { resolveGovernanceFromYaml } = require('./governance-resolver.js');

const LEASE_YAML =
  'spec:\n  governance:\n    allowForcePush: leaseOnOwnBranch\n    operational: [requeue]\n';

function tmp(fn) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'trusted-policy-')));
  try {
    return fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

describe('probeRef distinguishes found / missing / error', () => {
  it('reports found and missing in a real repo, error outside one', () =>
    tmp((d) => {
      const env = {
        PATH: process.env.PATH,
        HOME: d,
        GIT_CONFIG_GLOBAL: join(d, 'c'),
        GIT_CONFIG_NOSYSTEM: '1',
      };
      writeFileSync(join(d, 'c'), '');
      const repo = join(d, 'r');
      mkdirSync(repo);
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.invalid',
          'commit',
          '-q',
          '--allow-empty',
          '-m',
          'i',
        ],
        { cwd: repo, env },
      );
      execFileSync('git', ['tag', 'v1'], { cwd: repo, env });
      const saved = { ...process.env };
      Object.assign(process.env, env);
      try {
        assert.equal(probeRef('refs/tags/v1', repo), 'found');
        assert.equal(probeRef('refs/tags/nope', repo), 'missing');
        assert.equal(probeRef('refs/tags/v1', join(d, 'does-not-exist')), 'error');
        const plain = join(d, 'plain');
        mkdirSync(plain);
        assert.equal(probeRef('refs/tags/v1', plain), 'error');
        assert.equal(runGit(['rev-parse', '--git-common-dir'], plain), null);
      } finally {
        process.env.PATH = saved.PATH;
        process.env.HOME = saved.HOME;
        delete process.env.GIT_CONFIG_GLOBAL;
        delete process.env.GIT_CONFIG_NOSYSTEM;
      }
    }));
});

describe('mainCheckoutRoot / loadTrustedExtras with an injected runner', () => {
  it('accepts only <root>/.git common dirs', () => {
    assert.equal(
      mainCheckoutRoot('/x/wt', () => '/x/main/.git'),
      '/x/main',
    );
    assert.equal(
      mainCheckoutRoot('/x/main', () => '.git'),
      '/x/main',
    );
    assert.equal(
      mainCheckoutRoot('/x', () => '/x/repo.git'),
      null,
    );
    assert.equal(
      mainCheckoutRoot('/x', () => null),
      null,
    );
  });

  it('fails closed (null) when the runner fails or the cwd is in another repo', () => {
    assert.equal(
      loadTrustedExtras('/p', '/c', () => null),
      null,
    );
    const run = (args, dir) => (dir === '/p' ? '/p/.git' : '/other/.git');
    assert.equal(loadTrustedExtras('/p', '/c', run), null);
  });

  it('reads the policy from the main checkout of the same repo', () =>
    tmp((d) => {
      mkdirSync(join(d, '.ai-sdlc'));
      mkdirSync(join(d, '.git'));
      writeFileSync(join(d, '.ai-sdlc', 'agent-role.yaml'), LEASE_YAML);
      const run = () => join(d, '.git');
      const e = loadTrustedExtras(d, d, run);
      assert.equal(e.forcePushMode, 'leaseOnOwnBranch');
      assert.deepEqual(e.operational, ['requeue']);
      rmSync(join(d, '.ai-sdlc', 'agent-role.yaml'));
      assert.equal(loadTrustedExtras(d, d, run), null);
    }));
});

describe('bannerGovernance', () => {
  const strict = resolveGovernanceFromYaml('');
  it('runs no git for a never copy with no dispatch operational list', () => {
    let calls = 0;
    const out = bannerGovernance('spec:\n  role: x\n', strict, '/p', '/c', undefined, () => {
      calls += 1;
      return null;
    });
    assert.equal(calls, 0);
    assert.equal(out.resolved, strict);
  });

  it('a lease copy with a failing runner renders never and no operational grants', () => {
    const resolved = resolveGovernanceFromYaml(LEASE_YAML);
    assert.equal(resolved.allowForcePush, true);
    const out = bannerGovernance(LEASE_YAML, resolved, '/p', '/c', 'operator-dispatch', () => null);
    assert.equal(out.resolved.allowForcePush, false);
    assert.deepEqual(out.operational, []);
  });

  it('a lease copy confirmed by the trusted main checkout keeps the lease', () =>
    tmp((d) => {
      mkdirSync(join(d, '.ai-sdlc'));
      mkdirSync(join(d, '.git'));
      writeFileSync(join(d, '.ai-sdlc', 'agent-role.yaml'), LEASE_YAML);
      const resolved = resolveGovernanceFromYaml(LEASE_YAML);
      const out = bannerGovernance(LEASE_YAML, resolved, d, d, 'operator-dispatch', () =>
        join(d, '.git'),
      );
      assert.equal(out.resolved.allowForcePush, true);
      assert.deepEqual(out.operational, ['requeue']);
    }));
});

describe('readTaskId', () => {
  it('reads a valid id (lower-cased), rejects absent / empty / malformed', () =>
    tmp((d) => {
      assert.equal(readTaskId(d), null);
      for (const [content, want] of [
        ['AISDLC-663\n', 'aisdlc-663'],
        ['AISDLC-100.5', 'aisdlc-100.5'],
        ['AISDLC-663.2\n', 'aisdlc-663.2'],
        ['gh-issue-123\n', 'gh-issue-123'],
        ['GH-ISSUE-9', 'gh-issue-9'],
        ['gh-issue-', null],
        ['gh-issue', null],
        ['-1', null],
        ['gh--issue-1', null],
        ['', null],
        ['\n', null],
        ['junk', null],
        ['../x-1', null],
      ]) {
        writeFileSync(join(d, '.active-task'), content);
        assert.equal(readTaskId(d), want, JSON.stringify(content));
      }
    }));
});

describe('verifiedMainRoot cross-checks the agent-writable gitdir chain', () => {
  it('rejects a .git FILE, a symlinked .git, or a .git that is not the reported common dir', () =>
    tmp((d) => {
      const root = join(d, 'main');
      mkdirSync(root);
      const run = () => join(root, '.git');
      // missing .git
      assert.equal(verifiedMainRoot(root, run), null);
      // .git is a file
      writeFileSync(join(root, '.git'), 'gitdir: /tmp/evil\n');
      assert.equal(verifiedMainRoot(root, run), null);
      rmSync(join(root, '.git'));
      // real directory
      mkdirSync(join(root, '.git'));
      assert.equal(verifiedMainRoot(root, run), root);
      // reported common dir points at a different .git
      const other = join(d, 'evil', '.git');
      mkdirSync(other, { recursive: true });
      let n = 0;
      const lying = () => (n++ === 0 ? join(root, '.git') : other);
      assert.equal(verifiedMainRoot(root, lying), null);
    }));
});
