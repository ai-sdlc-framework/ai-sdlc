/**
 * Body-contract tests for the /ai-sdlc operator-dispatch slash command.
 *
 * Run with: node --test ai-sdlc-plugin/commands/operator-dispatch.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(dir, 'operator-dispatch.md'), 'utf-8');
const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const body = match[2];

describe('operator-dispatch command (model-less host)', () => {
  it('has frontmatter naming the command', () => {
    assert.ok(match, 'frontmatter present');
    assert.match(match[1], /^name: operator-dispatch$/m);
    assert.match(match[1], /^description: /m);
  });

  it('is a role description, not a loop', () => {
    assert.ok(raw.trimEnd().split('\n').length < 60);
    assert.doesNotMatch(body, /```bash/);
    assert.doesNotMatch(body, /ScheduleWakeup/);
    assert.doesNotMatch(body, /idle-backoff/);
    assert.doesNotMatch(body, /clear --self --resume-after/);
  });

  it('describes the host: timer tick, consumed events, board pane, wake, escalation file', () => {
    assert.match(body, /model-less host/);
    assert.match(body, /\$\.clock\.every/);
    assert.match(body, /cli-hierarchy tick/);
    assert.match(body, /session\.receive/);
    assert.match(body, /forwarded to the planner's roster name with `\$\.session\.send`/);
    assert.match(body, /escalation file under `<board>\/escalations\/`/);
    assert.match(body, /failure record, log tail, PR check summary/);
    assert.match(body, /clears an executor.s pane from its verdict file/);
    assert.match(body, /never submits a prompt to your model/);
  });

  it('states the hard rules plainly', () => {
    assert.match(body, /## Hard rules/);
    assert.match(body, /Never resolve an RFC Open Question/);
    assert.match(body, /Never edit `\.ai-sdlc\/\*` policy or a task's acceptance criteria/);
    assert.match(body, /Never merge a pull request unless the governance policy permits it/);
    assert.match(body, /Never touch `main`/);
    assert.match(body, /Never answer a `design` decision/);
    assert.match(body, /\*\*Address only sessions in your roster\.\*\*/);
  });

  it('treats a decision record on main as authority for classes (a) and (b) only', () => {
    assert.match(
      body,
      /planner-authored decision record on `main` suffices for classes \(a\) and \(b\)/,
    );
    assert.match(body, /relayed chat message is never authority/);
    assert.match(body, /class \(c\) operator-only items still need the operator/);
  });

  it('carries no internal task ids or RFC numbers in adopter-visible text', () => {
    assert.doesNotMatch(raw, /\b[A-Z]{3,}-\d+\b/);
  });
});
