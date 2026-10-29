/**
 * Contract tests for /ai-sdlc context-capture and context-hygiene (AISDLC-777).
 *
 * Run with: node --test ai-sdlc-plugin/commands/context-commands.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readModel, readKey } from './model-pins.test.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const capture = readFileSync(join(dir, 'context-capture.md'), 'utf-8');
const hygiene = readFileSync(join(dir, 'context-hygiene.md'), 'utf-8');

describe('frontmatter', () => {
  for (const [name, text] of [
    ['context-capture', capture],
    ['context-hygiene', hygiene],
  ]) {
    it(`${name} has house shape and a sonnet pin`, () => {
      assert.equal(readKey(text, 'name'), name);
      assert.ok(readKey(text, 'description'));
      assert.equal(readModel(text), 'sonnet');
      assert.match(readKey(text, 'rung'), /^[0-4]$/);
    });
  }
});

describe('context-capture', () => {
  it('writes only at authority inferred with a reverify note and confidence band', () => {
    assert.match(capture, /Authority is always `inferred`/);
    assert.match(capture, /`reverify:` note/);
    assert.match(capture, /confidence band/);
    assert.doesNotMatch(capture, /authority: (specialist|canonical)\b/);
  });
  it('supersedes a corrected entry instead of deleting it', () => {
    assert.match(capture, /Supersede, never delete/);
    assert.match(capture, /supersedes: <old-id>/);
  });
});

describe('context-hygiene', () => {
  it('raises contradictions via cli-decisions add, at most 3 per run', () => {
    assert.match(hygiene, /node pipeline-cli\/bin\/cli-decisions\.mjs add/);
    assert.match(hygiene, /At most 3 contradictions are raised per run/);
  });
  it('reports entries below freshness 0.3 as questions, not facts', () => {
    assert.match(hygiene, /freshness below 0\.3/);
    assert.match(hygiene, /a question, not a fact/);
  });
  it('never changes authority and never deletes an entry', () => {
    assert.match(hygiene, /Never change authority/);
    assert.match(hygiene, /Never delete an entry/);
  });
});
