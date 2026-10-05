/**
 * AISDLC-710: the widened lease-push spellings. A push with no remote and/or no
 * refspec is accepted only when the REAL destination, resolved from git config,
 * provably lands on refs/heads/<own>; every other force-ish shape stays refused.
 * Also pins the refusal text: it names the config key and the value that allows
 * the push, and never suggests an exit the guard itself forbids.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/lib/lease-push-guard-widened.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateLeasePush } = require('./lease-push-guard.js');

const OWN = 'ai-sdlc/aisdlc-1-thing';
const FULL = `refs/heads/${OWN}`;

/** Fake `git config --get-all`: `table[key]` is the value list; unset keys are []. */
const config =
  (table = {}) =>
  (key) =>
    key in table ? table[key] : [];

const ctx = (over = {}) => ({
  ownRef: FULL,
  taskId: 'aisdlc-1',
  worktreeName: 'aisdlc-1',
  refAliasState: () => 'clear',
  protectedBranches: [],
  remotes: ['origin', 'fork'],
  aliasLookup: () => null,
  pushConfig: config(),
  ...over,
});
const run = (cmd, table, over) =>
  evaluateLeasePush(cmd, ctx({ pushConfig: config(table), ...over }));

describe('implicit destination: allowed only when git provably sends it to the own branch', () => {
  const IMPLICIT = [
    'git push --force-with-lease',
    'git push --force-with-lease origin',
    'git push origin --force-with-lease',
    `git push --force-with-lease=${OWN}:0123abcd`,
    `git push --force-with-lease=refs/heads/${OWN}:0123abcd origin`,
    'git push -u --force-with-lease --force-if-includes',
  ];

  it('allows with no config at all (push.default=simple is the git default)', () => {
    for (const cmd of IMPLICIT) assert.equal(run(cmd).decision, 'allow', cmd);
  });

  it('allows push.default=simple and current, and upstream when it names the own branch', () => {
    for (const cmd of IMPLICIT) {
      assert.equal(run(cmd, { 'push.default': ['simple'] }).decision, 'allow', cmd);
      assert.equal(run(cmd, { 'push.default': ['current'] }).decision, 'allow', cmd);
      assert.equal(
        run(cmd, { 'push.default': ['upstream'], [`branch.${OWN}.merge`]: [FULL] }).decision,
        'allow',
        cmd,
      );
    }
  });

  it('allows when remote.<name>.push maps only to the own branch', () => {
    for (const spec of [`HEAD:${FULL}`, `${OWN}:${FULL}`, `${FULL}:${FULL}`]) {
      assert.equal(
        run('git push --force-with-lease origin', { 'remote.origin.push': [spec] }).decision,
        'allow',
        spec,
      );
    }
  });

  it('refuses when push.default=upstream/tracking maps to main (task branches start from origin/main)', () => {
    for (const mode of ['upstream', 'tracking']) {
      for (const merge of [['refs/heads/main'], [], ['refs/heads/main', FULL]]) {
        const r = run('git push --force-with-lease origin', {
          'push.default': [mode],
          [`branch.${OWN}.merge`]: merge,
        });
        assert.equal(r.decision, 'deny', `${mode} ${merge}`);
      }
    }
  });

  it('refuses push.default=matching, nothing and unknown values (they can touch other refs)', () => {
    for (const mode of ['matching', 'nothing', 'bogus']) {
      assert.equal(
        run('git push --force-with-lease origin', { 'push.default': [mode] }).decision,
        'deny',
        mode,
      );
    }
  });

  it('refuses when remote.<name>.push maps anywhere else, or to anything extra', () => {
    for (const specs of [
      ['refs/heads/main:refs/heads/main'],
      [`HEAD:${FULL}`, 'refs/heads/main:refs/heads/main'],
      ['refs/heads/*:refs/heads/*'],
      ['+HEAD:' + FULL],
      [`${OWN}:${OWN}`],
    ]) {
      assert.equal(
        run('git push --force-with-lease origin', { 'remote.origin.push': specs }).decision,
        'deny',
        specs.join(','),
      );
    }
  });

  it('refuses mirror remotes (a push would update every ref)', () => {
    for (const v of ['true', 'yes', 'on', '1']) {
      assert.equal(
        run('git push --force-with-lease origin', { 'remote.origin.mirror': [v] }).decision,
        'deny',
        v,
      );
    }
    assert.equal(
      run('git push --force-with-lease origin', { 'remote.origin.mirror': ['false'] }).decision,
      'allow',
    );
  });

  it('fails closed when any config lookup is unknown (null)', () => {
    for (const key of [
      'remote.origin.mirror',
      'remote.origin.push',
      'push.default',
      `branch.${OWN}.pushRemote`,
      'remote.pushDefault',
      `branch.${OWN}.remote`,
    ]) {
      const pushConfig = (k) => (k === key ? null : []);
      assert.equal(
        evaluateLeasePush('git push --force-with-lease', ctx({ pushConfig })).decision,
        'deny',
        key,
      );
    }
    // No pushConfig supplied at all: implicit forms cannot be proven, so refused.
    assert.equal(
      evaluateLeasePush('git push --force-with-lease', ctx({ pushConfig: undefined })).decision,
      'deny',
    );
  });

  it('resolves the implicit remote like git: pushRemote > pushDefault > branch remote > origin', () => {
    const base = { remotes: ['origin', 'fork', 'up'] };
    const cmd = 'git push --force-with-lease';
    // fork is mirrored, so it is only reached if it is the resolved remote.
    const mirrorFork = { 'remote.fork.mirror': ['true'] };
    assert.equal(run(cmd, mirrorFork, base).decision, 'allow'); // origin
    assert.equal(
      run(cmd, { ...mirrorFork, [`branch.${OWN}.pushRemote`]: ['fork'] }, base).decision,
      'deny',
    );
    assert.equal(
      run(cmd, { ...mirrorFork, 'remote.pushDefault': ['fork'] }, base).decision,
      'deny',
    );
    assert.equal(
      run(cmd, { ...mirrorFork, [`branch.${OWN}.remote`]: ['fork'] }, base).decision,
      'deny',
    );
    // pushRemote wins over pushDefault.
    assert.equal(
      run(
        cmd,
        {
          ...mirrorFork,
          [`branch.${OWN}.pushRemote`]: ['up'],
          'remote.pushDefault': ['fork'],
        },
        base,
      ).decision,
      'allow',
    );
  });

  it('refuses an implicit remote that is not a configured remote name (e.g. "." or a URL)', () => {
    for (const v of ['.', 'https://evil.example/r.git', 'nope']) {
      assert.equal(
        run('git push --force-with-lease', { [`branch.${OWN}.remote`]: [v] }).decision,
        'deny',
        v,
      );
    }
  });
});

describe('explicit refspec spellings', () => {
  it('accepts bare HEAD, with the flag on either side of the remote', () => {
    for (const cmd of [
      'git push --force-with-lease origin HEAD',
      'git push origin --force-with-lease HEAD',
      `git push --force-with-lease=${OWN}:0123abcd origin HEAD`,
      `git push --force-with-lease origin HEAD:${FULL}`,
    ]) {
      assert.equal(run(cmd).decision, 'allow', cmd);
    }
  });

  it('keeps refusing a refspec whose remote destination is ambiguous or foreign', () => {
    for (const cmd of [
      `git push --force-with-lease origin ${OWN}`,
      `git push --force-with-lease origin ${FULL}`,
      `git push --force-with-lease origin ${OWN}:${OWN}`,
      `git push --force-with-lease origin HEAD:${OWN}`,
      'git push --force-with-lease origin HEAD:refs/heads/main',
      'git push --force-with-lease origin main',
      'git push --force-with-lease origin refs/heads/main',
      `git push --force-with-lease origin +HEAD`,
      `git push --force-with-lease origin +HEAD:${FULL}`,
      `git push --force-with-lease=main:0123abcd origin HEAD`,
      'git push --force-with-lease origin HEAD refs/heads/main',
      'git push --force-with-lease evil HEAD',
      'git push --force-with-lease --mirror origin',
      'git push --force-with-lease --all origin',
      'git push --force-with-lease --delete origin HEAD',
      `git push --force origin HEAD`,
      `git push -f origin HEAD`,
      `git push --force-with-lease --no-verify origin HEAD`,
    ]) {
      assert.equal(run(cmd).decision, 'deny', cmd);
    }
  });

  it('still refuses when the branch is main/protected/not the task branch, even with no refspec', () => {
    assert.equal(
      run('git push --force-with-lease', {}, { ownRef: 'refs/heads/main' }).decision,
      'deny',
    );
    assert.equal(
      run('git push --force-with-lease', {}, { ownRef: 'refs/heads/release/1.0' }).decision,
      'deny',
    );
    assert.equal(
      run('git push --force-with-lease', {}, { ownRef: 'refs/heads/ai-sdlc/aisdlc-2-other' })
        .decision,
      'deny',
    );
    assert.equal(run('git push --force-with-lease', {}, { taskId: null }).decision, 'deny');
    assert.equal(
      run('git push --force-with-lease', {}, { refAliasState: () => 'collides' }).decision,
      'deny',
    );
  });
});

describe('refusal text', () => {
  const REFUSED = [
    `git push --force origin HEAD`,
    `git push -f origin HEAD:refs/heads/main`,
    'git push --force-with-lease origin HEAD:refs/heads/main',
    'git push --force-with-lease origin main',
    'git push --force-with-lease --no-verify origin HEAD',
    'git push --force-with-lease --receive-pack=x origin HEAD',
    `git push origin +HEAD:${FULL}`,
    'git push --force-with-lease evil HEAD',
  ];

  it('names the config key and the value that allows the push', () => {
    for (const cmd of REFUSED) {
      const r = evaluateLeasePush(cmd, ctx());
      assert.equal(r.decision, 'deny', cmd);
      assert.match(r.reason, /spec\.governance\.allowForcePush/, cmd);
      assert.match(r.reason, /\.ai-sdlc\/agent-role\.yaml/, cmd);
      assert.match(r.reason, /leaseOnOwnBranch/, cmd);
    }
  });

  it('never suggests an exit the guard itself forbids', () => {
    for (const cmd of REFUSED) {
      const { reason } = evaluateLeasePush(cmd, ctx());
      assert.doesNotMatch(reason, /SKIP_|AI_SDLC_|bypass|--no-verify/i, cmd);
      // No plain force flag in any suggestion (--force-with-lease is the supported form).
      assert.doesNotMatch(reason, /--force(?![-\w])/, cmd);
      assert.doesNotMatch(reason, /(^|\s)-f(\s|$)/, cmd);
      assert.doesNotMatch(reason, /--mirror|--delete/, cmd);
    }
  });

  it('points at the supported spelling from the task worktree', () => {
    const { reason } = evaluateLeasePush(
      'git push --force-with-lease origin HEAD:refs/heads/main',
      ctx(),
    );
    assert.ok(reason.includes(`git push --force-with-lease origin HEAD:${FULL}`), reason);
  });
});
