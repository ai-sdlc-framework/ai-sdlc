/**
 * AISDLC-840 (DEC-0161): CodeQL advanced setup scope.
 * Run with: node --test .github/workflows/__tests__/codeql.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'codeql.yml');
const text = readFileSync(file, 'utf8');
const wf = yaml.load(text);
const job = wf.jobs.analyze;

describe('codeql.yml', () => {
  it('scans the four languages', () => {
    assert.deepEqual([...job.strategy.matrix.language].sort(), [
      'actions',
      'go',
      'javascript-typescript',
      'python',
    ]);
  });

  it('runs on push to main and a weekly schedule, never on pull_request (AISDLC-934)', () => {
    const on = wf.on ?? wf[true];
    assert.equal(on.pull_request, undefined);
    assert.equal(on.pull_request_target, undefined);
    assert.deepEqual(on.push.branches, ['main']);
    assert.ok(on.schedule?.[0]?.cron);
  });

  it('scans every language unfiltered', () => {
    assert.ok(!job.steps.some((s) => s.id === 'scope'));
    for (const step of job.steps) assert.equal(step.if, undefined);
  });

  it('pins every action to a commit SHA', () => {
    for (const step of job.steps.filter((s) => s.uses)) {
      assert.match(step.uses, /@[0-9a-f]{40}( |$)/);
    }
  });
});
