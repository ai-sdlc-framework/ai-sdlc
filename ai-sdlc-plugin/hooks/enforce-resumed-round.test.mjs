/**
 * AISDLC-1227: the PreToolUse guard denies a push while the task's inflight manifest marks a
 * resumed developer round; a first run and the verdict-refspec push are not affected by it.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/enforce-resumed-round.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { evaluateResumedRoundPush } from './lib/resumed-round-fence.js';

const hookScript = join(dirname(fileURLToPath(import.meta.url)), 'enforce-blocked-actions.js');
const TASK = 'AISDLC-1227';
const PUSH = 'git push --force-with-lease origin HEAD:refs/heads/docs/some-filing';
const VERDICT_PUSH = `git push origin HEAD:refs/heads/x HEAD:refs/ai-sdlc/${'verdicts'}/abc`;

let base;
let root;
const git = (cwd, env, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf-8' });

function run(command) {
  try {
    return execFileSync('node', [hookScript], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: root }),
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: base,
        GIT_CONFIG_NOSYSTEM: '1',
        CLAUDE_PROJECT_DIR: root,
        AI_SDLC_ACTIVE_TASK_ID: TASK,
      },
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
  } catch (err) {
    return err.stdout?.trim() || '';
  }
}
const reason = (out) => {
  try {
    const h = JSON.parse(out).hookSpecificOutput;
    return h?.permissionDecision === 'deny' ? h.permissionDecisionReason : null;
  } catch {
    return null;
  }
};
const mark = (resume) => {
  const dir = join(root, '.ai-sdlc', 'dispatch', 'inflight');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${TASK}.dispatch.json`), JSON.stringify({ taskId: TASK, resume }));
};

before(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'resumed-round-')));
  const env = { PATH: process.env.PATH, HOME: base, GIT_CONFIG_NOSYSTEM: '1' };
  root = join(base, 'repo');
  mkdirSync(join(root, '.ai-sdlc'), { recursive: true });
  git(root, env, 'init', '-q', '-b', 'main');
  writeFileSync(
    join(root, '.ai-sdlc', 'agent-role.yaml'),
    'apiVersion: ai-sdlc.io/v1alpha1\nkind: AgentRole\nspec:\n  role: coding-agent\n  goal: test\n  governance:\n    allowForcePush: lease\n',
  );
  writeFileSync(join(root, 'f.txt'), 'x');
  git(root, env, 'add', '-A');
  git(root, env, '-c', 'user.name=t', '-c', 'user.email=t@e.invalid', 'commit', '-q', '-m', 'i');
  git(base, env, 'init', '-q', '--bare', join(base, 'origin.git'));
  git(root, env, 'remote', 'add', 'origin', join(base, 'origin.git'));
});
after(() => rmSync(base, { recursive: true, force: true }));

describe('resumed developer round push guard (AISDLC-1227)', () => {
  it('allows a lease push in a first run (no manifest)', () => {
    assert.equal(reason(run(PUSH)), null);
  });
  it('denies a lease push while the round is marked, naming AISDLC-1227', () => {
    mark({ developerRound: true });
    assert.match(reason(run(PUSH)) ?? '', /AISDLC-1227/);
  });
  it('does not apply the resumed-round rule to a verdict refspec push', () => {
    const ctx = { projectDir: root, taskId: TASK };
    assert.equal(evaluateResumedRoundPush(VERDICT_PUSH, ctx).decision, 'none');
    assert.doesNotMatch(reason(run(VERDICT_PUSH)) ?? '', /AISDLC-1227/);
  });
  it('ignores non-push commands and invalid task ids', () => {
    assert.equal(
      evaluateResumedRoundPush('git status', { projectDir: root, taskId: TASK }).decision,
      'none',
    );
    assert.equal(
      evaluateResumedRoundPush(PUSH, { projectDir: root, taskId: '../x' }).decision,
      'none',
    );
    assert.equal(
      evaluateResumedRoundPush(PUSH, { projectDir: root, taskId: null }).decision,
      'none',
    );
    assert.equal(
      evaluateResumedRoundPush(undefined, { projectDir: root, taskId: TASK }).decision,
      'none',
    );
  });
  it('allows the push again once the mark is cleared', () => {
    mark({});
    assert.equal(reason(run(PUSH)), null);
  });
  it('ignores a corrupt manifest', () => {
    const dir = join(root, '.ai-sdlc', 'dispatch', 'inflight');
    writeFileSync(join(dir, `${TASK}.dispatch.json`), '{nope');
    assert.equal(reason(run(PUSH)), null);
  });
});
