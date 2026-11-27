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

describe('decision-rubric Verify step (AISDLC-1431)', () => {
  it('has a required Verify step between evidence and options', () => {
    const verify = raw.indexOf('### 3a. Verify (required)');
    assert.ok(verify > raw.indexOf('### 3. Evidence'));
    assert.ok(verify < raw.indexOf('### 4. Three to four options'));
    assert.match(raw, /Explore` subagent on Sonnet/);
    assert.match(raw, /web fetch/);
    assert.match(raw, /Batch every item into one research subagent/);
  });

  it('allows unchecked only in a draft and lists it as an anti-pattern', () => {
    assert.match(raw, /\*\*unverifiable\*\*/);
    assert.match(raw, /Allowed only in a draft/);
    assert.match(raw, /Rendering a decision with a claim still unchecked/);
  });

  it('points the check and the recording at the weakest unverifiable item', () => {
    assert.match(raw, /The one thing to check\*\*: the weakest \*\*unverifiable\*\* item/);
    assert.match(raw, /`Check:`\*\* the weakest unverifiable item/);
  });

  it('applies Verify unchanged in autonomous mode and maps it in the cause table', () => {
    assert.match(raw, /The Verify step \(3a\) applies unchanged/);
    assert.match(raw, /3 \(evidence\) and 3a \(Verify\)/);
    assert.match(raw, /from unchecked to checked/);
  });
});

describe('decision-rubric weakening decisions', () => {
  it('tags weakening decisions and requires a non-weakening fallback', () => {
    assert.match(raw, /--governance-change weakening --weakens <option-id>/);
    assert.match(raw, /non-weakening option/);
  });
});
