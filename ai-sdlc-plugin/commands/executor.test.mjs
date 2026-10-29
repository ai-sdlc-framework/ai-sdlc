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

  it('tells a resume to push through the pipeline push step from the task worktree (AISDLC-905)', () => {
    assert.ok(
      body.includes(
        "A rebased commit on a resume is pushed through the pipeline's push step from the task worktree, never by a hand-typed push from another directory",
      ),
    );
  });

  it('stays under 165 lines by leaving the deterministic start-up to executor-start', () => {
    assert.ok(raw.split('\n').length < 165, `executor.md has ${raw.split('\n').length} lines`);
  });

  it('starts with one executor-start call that claims once, with no wait, token or sender flag', () => {
    assert.match(body, /cli-hierarchy\.mjs" executor-start --board-dir "\$BOARD_DIR"\n/);
    assert.doesNotMatch(body, /executor-start[^\n]*--wait/);
    assert.doesNotMatch(body, /executor-start[^\n]*--sender/);
    assert.doesNotMatch(body, /start token|unchecked-start/);
    assert.match(body, /collision suffix/);
    assert.doesNotMatch(body, /hierarchy\.json/);
    assert.doesNotMatch(body, /cli-dispatch\.mjs" claim/);
  });

  it('keeps its context and waits for the module wake when nothing is eligible (AISDLC-815, AISDLC-1034)', () => {
    assert.match(body, /"taskId": null/);
    assert.doesNotMatch(body, /clear --self --resume-after/);
    assert.match(body, /Do not clear, poll or wait/);
    assert.match(body, /\[executor\] idle/);
    assert.match(body, /\[executor\] verdict reported/);
    assert.doesNotMatch(body, /idle-backoff/);
    assert.match(body, /RESUMED TASK/);
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
    assert.match(body, /clears this pane from your verdict file/);
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

  it('has no sender check: work comes from the board and the module guards the sender', () => {
    assert.doesNotMatch(body, /check-sender/);
    assert.match(body, /the claim is the authority/);
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
