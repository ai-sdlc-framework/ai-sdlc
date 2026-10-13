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

  it('runs on PR, push to main, and a weekly schedule', () => {
    const on = wf.on ?? wf[true];
    assert.ok(on.pull_request);
    assert.deepEqual(on.push.branches, ['main']);
    assert.ok(on.schedule?.[0]?.cron);
  });

  it('filters per language only on pull_request, never on schedule or push', () => {
    const scope = job.steps.find((s) => s.id === 'scope');
    assert.match(scope.run, /\$EVENT" = "pull_request"/);
    assert.match(scope.run, /go\) pattern='\^sdk-go\/'/);
    assert.match(scope.run, /python\) pattern='\\\.py\$'/);
    assert.match(scope.run, /run=true\n/);
  });

  it('gates init and analyze on the scope step', () => {
    for (const step of job.steps.filter((s) =>
      /codeql-action\/(init|analyze)/.test(s.uses ?? ''),
    )) {
      assert.equal(step.if, "steps.scope.outputs.run == 'true'");
    }
  });

  it('pins every action to a commit SHA', () => {
    for (const step of job.steps.filter((s) => s.uses)) {
      assert.match(step.uses, /@[0-9a-f]{40}( |$)/);
    }
  });
});
