/**
 * AISDLC-929: a red main is surfaced by the dispatch tick, not a GitHub issue.
 * The monitor fails the run and writes the step summary; it never files an
 * issue or creates a label.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(__dirname, '..', 'main-health-monitor.yml');
const MANIFEST = resolve(__dirname, '..', 'label-manifest.json');

describe('main-health-monitor workflow', () => {
  const text = readFileSync(WORKFLOW, 'utf8');

  it('does not create issues', () => {
    assert.doesNotMatch(text, /gh issue create/);
    assert.doesNotMatch(text, /issues:\s*write/);
  });

  it('does not use the main-red label', () => {
    assert.doesNotMatch(text, /main-red/);
    assert.doesNotMatch(text, /gh label create/);
    if (existsSync(MANIFEST)) assert.ok(!readFileSync(MANIFEST, 'utf8').includes('main-red'));
  });

  it('a failed run still fails and writes the step summary', () => {
    assert.match(text, /Fail on test failure[\s\S]*GITHUB_STEP_SUMMARY[\s\S]*exit 1/);
  });

  it('runs daily on a schedule as well as on push to main', () => {
    assert.match(text, /^\s*schedule:\s*\n\s*- cron: '0 6 \* \* \*'/m);
    assert.match(text, /push:\s*\n\s*branches: \[main\]/);
  });
});
