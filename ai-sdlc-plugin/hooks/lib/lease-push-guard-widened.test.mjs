/**
 * AISDLC-710: lease-push spellings. Only a push with the remote AND a fully qualified
 * `<src>:refs/heads/<own>` refspec is accepted; every no-colon refspec (bare `HEAD`)
 * and every omitted remote/refspec is refused because git maps those through config.
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

const ctx = (over = {}) => ({
  ownRef: FULL,
  taskId: 'aisdlc-1',
  worktreeName: 'aisdlc-1',
  refAliasState: () => 'clear',
  protectedBranches: [],
  remotes: ['origin', 'fork'],
  aliasLookup: () => null,
  ...over,
});
const run = (cmd, over) => evaluateLeasePush(cmd, ctx(over));

describe('explicit refspec spellings', () => {
  const CANON = `git push --force-with-lease origin HEAD:${FULL}`;

  it('accepts the explicit refs/heads destination, flags on either side of the remote', () => {
    for (const cmd of [
      CANON,
      `git push origin --force-with-lease HEAD:${FULL}`,
      `git push --force-with-lease=${OWN}:0123abcd origin HEAD:${FULL}`,
      `git push -u --force-with-lease --force-if-includes origin HEAD:${FULL}`,
      `git push --force-with-lease origin ${OWN}:${FULL}`,
      `git push --force-with-lease origin ${FULL}:${FULL}`,
    ]) {
      assert.equal(run(cmd).decision, 'allow', cmd);
    }
  });

  it('refuses bare HEAD and every other no-colon refspec (config / tag-named-HEAD mapping)', () => {
    for (const cmd of [
      'git push --force-with-lease origin HEAD',
      'git push origin --force-with-lease HEAD',
      `git push --force-with-lease=${OWN}:0123abcd origin HEAD`,
      `git push --force-with-lease origin ${OWN}`,
      `git push --force-with-lease origin ${FULL}`,
    ]) {
      const r = run(cmd);
      assert.equal(r.decision, 'deny', cmd);
      assert.ok(r.reason.includes(CANON), cmd);
    }
  });

  it('refuses the remote and/or refspec omitted (destination resolved through git config)', () => {
    for (const cmd of [
      'git push --force-with-lease',
      'git push --force-with-lease origin',
      'git push origin --force-with-lease',
      `git push --force-with-lease=${OWN}:0123abcd`,
      'git push -u --force-with-lease --force-if-includes',
    ]) {
      const r = run(cmd);
      assert.equal(r.decision, 'deny', cmd);
      assert.ok(r.reason.includes(CANON), cmd);
    }
  });

  it('keeps refusing a refspec whose remote destination is ambiguous or foreign', () => {
    for (const cmd of [
      `git push --force-with-lease origin ${OWN}:${OWN}`,
      `git push --force-with-lease origin HEAD:${OWN}`,
      'git push --force-with-lease origin HEAD:refs/heads/main',
      'git push --force-with-lease origin main',
      'git push --force-with-lease origin refs/heads/main',
      `git push --force-with-lease origin +HEAD`,
      `git push --force-with-lease origin +HEAD:${FULL}`,
      `git push --force-with-lease=main:0123abcd origin HEAD:${FULL}`,
      `git push --force-with-lease origin HEAD:${FULL} refs/heads/main`,
      `git push --force-with-lease evil HEAD:${FULL}`,
      'git push --force-with-lease --mirror origin',
      'git push --force-with-lease --all origin',
      `git push --force-with-lease --delete origin HEAD:${FULL}`,
      `git push --force origin HEAD:${FULL}`,
      `git push -f origin HEAD:${FULL}`,
      `git push --force-with-lease --no-verify origin HEAD:${FULL}`,
    ]) {
      assert.equal(run(cmd).decision, 'deny', cmd);
    }
  });

  it('still refuses when the branch is main/protected/not the task branch', () => {
    assert.equal(run(CANON, { ownRef: 'refs/heads/main' }).decision, 'deny');
    assert.equal(run(CANON, { ownRef: 'refs/heads/release/1.0' }).decision, 'deny');
    assert.equal(run(CANON, { ownRef: 'refs/heads/ai-sdlc/aisdlc-2-other' }).decision, 'deny');
    assert.equal(run(CANON, { taskId: null }).decision, 'deny');
    assert.equal(run(CANON, { refAliasState: () => 'collides' }).decision, 'deny');
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
