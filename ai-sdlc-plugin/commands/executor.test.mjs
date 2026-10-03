/**
 * Body-contract tests for the /ai-sdlc executor slash command.
 *
 * Run with: node --test ai-sdlc-plugin/commands/executor.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('reads the roster for its own name and the dispatch session name', () => {
    assert.match(body, /hierarchy\.json/);
    assert.match(body, /role === 'operator-dispatch'/);
    assert.match(body, /collision suffix/);
  });

  it('claims under the roster name exactly', () => {
    assert.match(body, /cli-dispatch\.mjs" claim[\s\S]*--worker "\$MY_NAME"/);
    assert.match(body, /--worker-kind in-session-agent/);
  });

  it('waits and retries on an interval when nothing is eligible', () => {
    assert.match(body, /"claimed": false/);
    assert.match(body, /ScheduleWakeup/);
    assert.match(body, /emptyQueueHibernateSec/);
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
    assert.match(body, /## Step 6 - Stop and wait/);
    assert.match(body, /clears this session's context/);
  });

  it('states the hard rules', () => {
    assert.match(body, /Never message another executor/);
    assert.match(body, /Never answer a decision/);
    assert.match(body, /Never file a top-level task id/);
    assert.match(body, /next-subid/);
    assert.match(body, /Never edit an RFC's Open Questions/);
    assert.match(body, /cli-decisions\.mjs" escalate/);
  });

  it('carries no internal task ids in adopter-visible text', () => {
    assert.doesNotMatch(raw, /\b[A-Z]{3,}-\d+\b/);
  });

  it('invokes pipeline CLIs through the resolved bin directory only', () => {
    assert.doesNotMatch(body, /^\s*node\s+pipeline-cli\/bin\//m);
  });
});
