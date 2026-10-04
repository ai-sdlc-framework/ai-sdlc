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
    assert.match(raw, /--timebox P1D --autonomous-fallback/);
  });

  it('keeps the five parts and never self-decides class (c)', () => {
    assert.match(raw, /same five parts/);
    assert.match(raw, /Class \(c\)[^\n]*never self-decided/);
  });
});
