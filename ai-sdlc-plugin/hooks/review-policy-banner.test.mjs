/**
 * Tests for the SessionStart review-policy banner (AISDLC-561).
 * Run with: node --test ai-sdlc-plugin/hooks/review-policy-banner.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = join(__dirname, 'session-start.js');
const { classifyDoctorOutput, renderReviewPolicyBanner } = require('./lib/review-policy-banner.js');

const doctorJson = (severity, extra = {}) =>
  JSON.stringify({
    results: [{ id: 'attestation-governance', severity, title: 'T-' + severity, ...extra }],
  });

describe('classifyDoctorOutput', () => {
  it('pass -> enforced', () => {
    assert.equal(classifyDoctorOutput(doctorJson('pass')).state, 'enforced');
  });
  it('warn -> not-enforced with remediation', () => {
    const r = classifyDoctorOutput(doctorJson('warn', { remediation: 'ai-sdlc init --add x' }));
    assert.equal(r.state, 'not-enforced');
    assert.equal(r.remediation, 'ai-sdlc init --add x');
  });
  it('fail -> not-enforced', () => {
    assert.equal(classifyDoctorOutput(doctorJson('fail')).state, 'not-enforced');
  });
  it('garbage / missing check -> unknown', () => {
    assert.equal(classifyDoctorOutput('not json').state, 'unknown');
    assert.equal(classifyDoctorOutput('{"results":[]}').state, 'unknown');
  });
});

describe('renderReviewPolicyBanner', () => {
  it('renders nothing when no policy file', () => {
    assert.equal(renderReviewPolicyBanner(false, { state: 'enforced' }), '');
  });
  it('enforced: says ENFORCED and never "NOT ENFORCED"', () => {
    const b = renderReviewPolicyBanner(true, { state: 'enforced', title: 'ok' });
    assert.match(b, /Review policy is ENFORCED/);
    assert.doesNotMatch(b, /NOT ENFORCED/);
    assert.doesNotMatch(b, /Review policy is active/);
  });
  it('not-enforced: says AVAILABLE, names the gap and fix, never claims active/enforced', () => {
    const b = renderReviewPolicyBanner(true, {
      state: 'not-enforced',
      title: 'artifacts present but not enforced',
      remediation: 'ai-sdlc init --add branch-protection',
    });
    assert.match(b, /AVAILABLE but NOT ENFORCED/);
    assert.match(b, /artifacts present but not enforced/);
    assert.match(b, /ai-sdlc init --add branch-protection/);
    assert.doesNotMatch(b, /Review policy is ENFORCED/);
    assert.doesNotMatch(b, /Review policy is active/);
  });
  it('unknown: does not claim active or enforced', () => {
    const b = renderReviewPolicyBanner(true, { state: 'unknown' });
    assert.match(b, /could NOT be confirmed/);
    assert.doesNotMatch(b, /Review policy is ENFORCED/);
    assert.doesNotMatch(b, /Review policy is active/);
  });
  it('the enforced and not-enforced banners differ', () => {
    assert.notEqual(
      renderReviewPolicyBanner(true, { state: 'enforced' }),
      renderReviewPolicyBanner(true, { state: 'not-enforced' }),
    );
  });
  it('states the reviewer set and how to opt in, in every state', () => {
    for (const state of ['enforced', 'not-enforced', 'unknown']) {
      const b = renderReviewPolicyBanner(true, { state });
      for (const s of [
        'code-reviewer',
        'test-reviewer',
        'security-reviewer',
        '-codex',
        'AI_SDLC_REVIEWER_HARNESS=claude',
        'code-test-merged',
        'AI_SDLC_REVIEWER_SET',
        '.ai-sdlc/review-config.yaml',
      ]) {
        assert.ok(b.includes(s), `${state} banner should mention ${s}`);
      }
    }
  });
});

describe('session-start hook end to end (fake ai-sdlc doctor)', () => {
  let root;
  let project;
  const fakeBin = (name, body) => {
    const p = join(root, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'review-banner-'));
    project = join(root, 'proj');
    mkdirSync(join(project, '.ai-sdlc'), { recursive: true });
    writeFileSync(join(project, '.ai-sdlc', 'agent-role.yaml'), 'role: coding-agent\ngoal: x\n');
    writeFileSync(join(project, '.ai-sdlc', 'review-policy.md'), '# policy\n');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  function ctxFor(bin) {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: project, AI_SDLC_DOCTOR_BIN: bin };
    delete env.CLAUDE_PLUGIN_ROOT;
    delete env.CLAUDE_PLUGIN_DIR;
    const out = execFileSync('node', [hookScript], {
      input: JSON.stringify({ session_id: 's' }),
      encoding: 'utf-8',
      env,
      timeout: 20000,
    });
    return JSON.parse(out).hookSpecificOutput.additionalContext;
  }

  it('enforcement absent -> AVAILABLE but NOT ENFORCED', () => {
    const bin = fakeBin(
      'doctor-warn',
      `echo '${doctorJson('warn', { remediation: 'ai-sdlc init --add branch-protection' })}'`,
    );
    const ctx = ctxFor(bin);
    assert.match(ctx, /AVAILABLE but NOT ENFORCED/);
    assert.doesNotMatch(ctx, /Review policy is active/);
  });

  it('enforcement present -> ENFORCED', () => {
    const bin = fakeBin('doctor-pass', `echo '${doctorJson('pass')}'`);
    const ctx = ctxFor(bin);
    assert.match(ctx, /Review policy is ENFORCED/);
    assert.doesNotMatch(ctx, /NOT ENFORCED/);
  });

  it('doctor unavailable -> could not confirm, never active', () => {
    const ctx = ctxFor(join(root, 'does-not-exist'));
    assert.match(ctx, /could NOT be confirmed/);
    assert.doesNotMatch(ctx, /Review policy is active/);
  });
});
