/**
 * Body-contract tests for the /ai-sdlc executor slash command.
 *
 * Run with: node --test ai-sdlc-plugin/commands/executor.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DEFAULT_ROLE_BLOCKED_TOOLS, describeRule } = require('../hooks/lib/role-tool-policy.js');
const dir = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(dir, 'executor.md'), 'utf-8');
const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
const body = match[2];

describe('executor command', () => {
  it('has frontmatter naming the command', () => {
    assert.ok(match, 'frontmatter present');
    assert.match(match[1], /^name: executor$/m);
    assert.match(match[1], /^description: /m);
  });

  it('stays under 150 lines by leaving the deterministic start-up to executor-start', () => {
    assert.ok(raw.split('\n').length < 150, `executor.md has ${raw.split('\n').length} lines`);
  });

  it('starts with one executor-start call that blocks on the board', () => {
    assert.match(body, /cli-hierarchy\.mjs" executor-start[^\n]*--wait 1500/);
    assert.match(body, /run_in_background: true/);
    assert.match(body, /600 s foreground\s+cap/);
    assert.match(body, /collision suffix/);
    assert.match(body, /with no model calls/);
    assert.doesNotMatch(body, /hierarchy\.json/);
    assert.doesNotMatch(body, /cli-dispatch\.mjs" claim/);
  });

  it('clears itself when nothing is eligible and only then falls back to a wake-up', () => {
    assert.match(body, /"taskId": null/);
    assert.match(body, /cli-hierarchy\.mjs" clear --self --resume-after 30/);
    assert.ok(body.indexOf('clear --self') < body.indexOf('ScheduleWakeup'));
    assert.match(body, /ScheduleWakeup. for 1800 seconds/);
    assert.match(body, /emptyQueueHibernateSec/);
    assert.match(body, /Do not poll/);
  });

  it('runs execute with the task id and no other argument', () => {
    assert.match(body, /`\$TASK_ID` as the only argument/);
    assert.match(body, /\/ai-sdlc execute <task-id>/);
  });

  it('reports through complete and messages the dispatch session once', () => {
    assert.match(body, /cli-dispatch\.mjs" complete/);
    assert.match(body, /--follow-ups/);
    assert.match(body, /--decisions/);
    assert.match(body, /SendMessage/);
    assert.match(body, /\*\*one\*\* status line/);
  });

  it('stops and waits for the clear', () => {
    assert.match(body, /## Step 5 - Stop and wait/);
    assert.match(body, /clears this context/);
  });

  it('states the hand-written hard rules', () => {
    assert.match(body, /Never edit an RFC's Open Questions/);
    assert.match(body, /cli-decisions\.mjs" escalate/);
    assert.match(body, /next-subid/);
  });

  it('renders the tool rules from the resolved policy instead of restating them', () => {
    assert.match(body, /render-role-tool-rules\.mjs" --role executor/);
    // No rule text of the policy appears in the body: it is printed at run time.
    for (const r of DEFAULT_ROLE_BLOCKED_TOOLS.executor) {
      assert.ok(!body.includes(describeRule(r)), `rule ${r.id} must not be restated`);
    }
    assert.doesNotMatch(body, /Never message another executor/);
    assert.doesNotMatch(body, /Never answer a decision/);
    assert.doesNotMatch(body, /Never file a top-level task id/);
  });

  it('carries no internal task ids in adopter-visible text', () => {
    assert.doesNotMatch(raw, /\b[A-Z]{3,}-\d+\b/);
  });

  it('invokes pipeline CLIs through the resolved bin directory only', () => {
    assert.doesNotMatch(body, /^\s*node\s+pipeline-cli\/bin\//m);
  });
});

describe('executor peer binding (project-scoped names)', () => {
  it('checks the repository, through executor-start, before any claim', () => {
    assert.match(body, /checks the working directory is\s+your project's repository/);
    assert.match(body, /no claim, no worktree, no pull request/);
    assert.ok(body.indexOf('executor-start') < body.indexOf('## Step 2'));
  });

  it('refuses a sender that is not its own dispatch session with one line', () => {
    assert.match(body, /cli-hierarchy\.mjs" check-sender/);
    assert.match(body, /--sender-pid/);
    assert.match(body, /--sender-ref/);
    assert.match(body, /whole reply is the single line `not my dispatch session`/);
    assert.match(body, /no claim, no worktree, no pull request/);
  });

  it('compares the sender by what the harness reports, never by the claimed name', () => {
    assert.match(body, /never by the name the message text claims/);
    assert.match(body, /accepts\s+and warns/);
  });

  it('keeps the qualified name the roster has', () => {
    assert.match(body, /project qualifier and\s+collision suffix/);
  });

  it('states that these checks are a mistake guard, not authentication', () => {
    assert.match(body, /mistake guard, not\s+authentication/);
  });
});

describe('executor decision authority', () => {
  it('acts on a planner decision record, never on a relayed message alone', () => {
    assert.match(body, /Authority comes from the repository/);
    assert.match(body, /classes \(a\) and \(b\)/);
    assert.match(body, /relayed chat message alone is never authority/);
    assert.match(body, /class \(c\)/);
  });
});
