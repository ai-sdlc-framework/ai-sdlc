/**
 * Body-contract tests for the /ai-sdlc planner slash command.
 *
 * Run with: node --test ai-sdlc-plugin/commands/planner.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(dir, 'planner.md'), 'utf-8');
const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

describe('planner command', () => {
  it('has frontmatter naming the command', () => {
    assert.ok(match, 'frontmatter present');
    assert.match(match[1], /^name: planner$/m);
    assert.match(match[1], /^description: /m);
  });

  it('prints the roster, briefs and pending decisions', () => {
    assert.match(match[2], /cli-hierarchy\.mjs" status/);
    assert.match(match[2], /briefs/);
    assert.match(match[2], /cli-decisions\.mjs" list/);
  });

  it('describes the hand-off flow', () => {
    assert.match(match[2], /cli-hierarchy\.mjs" brief --tasks/);
    assert.match(match[2], /--notify/);
  });

  it('states the Open Questions hard rule', () => {
    assert.match(match[2], /Open Questions/);
    assert.match(match[2], /only with the operator/);
    assert.match(match[2], /decision rubric/);
  });

  it('is an orientation, not a loop, and never writes under .ai-sdlc', () => {
    assert.match(match[2], /not a loop/);
    assert.doesNotMatch(match[2], /ScheduleWakeup/);
    assert.match(match[2], /never edits `\.ai-sdlc\/` configuration/);
    assert.match(
      match[2],
      /only files it touches\s+there are briefs under `\.ai-sdlc\/dispatch\/briefs\/`/,
    );
  });

  it('reads brief task ids safely, skipping anything that is not a task id', () => {
    assert.match(match[2], /set -f/);
    assert.match(match[2], /while IFS= read -r id/);
    assert.match(match[2], /\^\[A-Z\]\[A-Z0-9\]\+-\[0-9\]\+/);
    assert.doesNotMatch(match[2], /for id in \$\(/);
  });

  it('carries no internal task ids', () => {
    assert.doesNotMatch(raw, /AISDLC-\d+/);
  });
});
