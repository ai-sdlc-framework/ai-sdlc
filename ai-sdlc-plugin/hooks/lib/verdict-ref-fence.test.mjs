/**
 * RFC-0061 OQ-8 fence. Run with: node --test ai-sdlc-plugin/hooks/lib/verdict-ref-fence.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { evaluateVerdictFence } = require('./verdict-ref-fence.js');
const hook = join(dirname(fileURLToPath(import.meta.url)), '..', 'enforce-blocked-actions.js');

describe('verdict ref fence', () => {
  it('denies an agent push to refs/ai-sdlc/verdicts/x', () => {
    const r = evaluateVerdictFence('git push origin abc123:refs/ai-sdlc/verdicts/x');
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /RFC-0061/);
  });
  it('denies an atomic push naming the verdict ref beside the branch', () => {
    const r = evaluateVerdictFence(
      'git push --atomic origin HEAD:refs/heads/b HEAD:refs/ai-sdlc/verdicts/abc',
    );
    assert.equal(r.decision, 'deny');
  });
  it('denies a status post with the gate context', () => {
    const r = evaluateVerdictFence(
      'gh api repos/o/r/statuses/abc -f state=success -f context=ai-sdlc/attestation',
    );
    assert.equal(r.decision, 'deny');
  });
  it('ignores an unrelated push and an unrelated status post', () => {
    assert.equal(evaluateVerdictFence('git push -u origin feat/x').decision, 'none');
    assert.equal(
      evaluateVerdictFence('gh api repos/o/r/statuses/abc -f context=ci/lint').decision,
      'none',
    );
  });
  it('allows the ship step and refuses a chained command', () => {
    assert.equal(
      evaluateVerdictFence('ai-sdlc-pipeline next-step ship refs/ai-sdlc/verdicts/x git push')
        .decision,
      'allow',
    );
    assert.equal(
      evaluateVerdictFence('ai-sdlc-pipeline next-step; git push origin x:refs/ai-sdlc/verdicts/y')
        .decision,
      'deny',
    );
  });
  it('the PreToolUse hook denies the push end to end', () => {
    const out = execFileSync('node', [hook], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push origin HEAD:refs/ai-sdlc/verdicts/x' },
      }),
      encoding: 'utf-8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: process.cwd() },
    });
    assert.match(out, /"permissionDecision": "deny"/);
  });
});
