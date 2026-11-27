/**
 * Body-contract tests for the decision-rubric autonomous mode.
 *
 * Run with: node --test ai-sdlc-plugin/commands/decision-rubric-autonomous.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(dir, '..', 'skills', 'decision-rubric', 'SKILL.md'), 'utf-8');

describe('decision-rubric autonomous mode', () => {
  it('has an autonomous section that does not call AskUserQuestion', () => {
    assert.match(raw, /## Autonomous mode \(no operator present\)/);
    assert.match(raw, /\*\*Do not call AskUserQuestion\.\*\*/);
  });

  it('records via add plus answer, with timebox and fallback for class (b)', () => {
    assert.match(raw, /cli-decisions add --summary/);
    assert.match(raw, /cli-decisions answer <id> <option>/);
    assert.match(raw, /--timebox PT10H --autonomous-fallback/);
  });

  it('keeps all six steps and never self-decides class (c)', () => {
    assert.match(raw, /run all six steps/);
    assert.match(raw, /Class \(c\)[^\n]*never self-decided/);
  });
});

describe('decision-rubric evidence ledger (AISDLC-1451, supersedes the AISDLC-1431 Verify step)', () => {
  const step3 = raw.slice(
    raw.indexOf('### 3. Evidence'),
    raw.indexOf('### 4. Three to four options'),
  );

  it('step 3 sends a separate Sonnet research subagent the exact draft', () => {
    assert.ok(step3.length > 0);
    assert.match(step3, /### 3\. Evidence: research subagent and ledger \(required\)/);
    assert.match(step3, /`model: sonnet`, never the author/);
    assert.match(step3, /It gets the exact draft text, not a summary/);
    assert.match(step3, /Pull out EVERY factual claim and EVERY dependency path/);
  });

  it('gives the ledger shape and the schema file', () => {
    assert.match(step3, /spec\/schemas\/decision-evidence-ledger\.v1\.schema\.json/);
    for (const field of [
      'schemaVersion',
      'draftSha256',
      'researchedBy',
      'researchedAt',
      'restsOn',
      'falsifiedBy',
      'prerequisite',
    ]) {
      assert.ok(step3.includes(`"${field}"`), field);
    }
  });

  it('no question goes out until the checker passes', () => {
    assert.match(step3, /cli-decisions\.mjs evidence check/);
    assert.match(
      step3,
      /\*\*No question goes out, and no decision is recorded, until the checker passes\.\*\*/,
    );
  });

  it('removes unchecked and unverifiable as final states', () => {
    assert.match(step3, /There is no unchecked or unverifiable final state/);
    assert.doesNotMatch(raw, /### 3a\. Verify/);
    assert.doesNotMatch(raw, /\*\*unverifiable\*\*: /);
    assert.doesNotMatch(raw, /\*\*unchecked\*\*: /);
    assert.match(raw, /"Industry research" from memory is not evidence/);
  });

  it('points the check and the recording at the weakest assumption', () => {
    assert.match(raw, /The one thing to check\*\*: the weakest \*\*assumption\*\*/);
    assert.match(raw, /`Check:`\*\* the weakest assumption/);
    assert.match(raw, /\.ai-sdlc\/decisions\/evidence\/DEC-NNNN\.json/);
  });

  it('runs the same step in autonomous mode and maps it in the cause table', () => {
    assert.match(raw, /Step 3 runs unchanged: the same research subagent gets the exact draft/);
    assert.match(raw, /\| 3 \(evidence ledger\) \|/);
  });

  it('rfc-oq-walkthrough refers to the same step', () => {
    const oq = readFileSync(join(dir, '..', 'skills', 'rfc-oq-walkthrough', 'SKILL.md'), 'utf-8');
    assert.match(oq, /decision-rubric step 3/);
    assert.match(oq, /cli-decisions evidence check/);
  });
});
