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

describe('operator-dispatch command', () => {
  it('has frontmatter naming the command', () => {
    assert.ok(match, 'frontmatter present');
    assert.match(match[1], /^name: operator-dispatch$/m);
    assert.match(match[1], /^description: /m);
  });

  it('is shorter than 120 lines (the identity, handoff and mark-ready work lives in tick)', () => {
    assert.ok(
      raw.trimEnd().split('\n').length < 120,
      `operator-dispatch.md has ${raw.trimEnd().split('\n').length} lines`,
    );
    assert.doesNotMatch(body, /hierarchy\.json/);
  });

  it('takes its name and the planner name from the tick output, not a roster script', () => {
    assert.match(body, /`identity\.name`/);
    assert.match(body, /`identity\.planner`/);
    assert.match(body, /`handoff`/);
    assert.match(body, /`markReady`/);
  });

  it('runs one wake-up through the hierarchy tick', () => {
    assert.match(body, /cli-hierarchy\.mjs" tick --board-dir "\$BOARD_DIR"/);
  });

  it('states exactly what tick checks: the caller own identity, not --worker', () => {
    assert.match(body, /checks who is calling, not what `--worker` says/);
    assert.match(body, /has\s+the `operator-dispatch` role/);
    assert.match(body, /must equal the\s+caller's own roster name/);
    assert.doesNotMatch(body, /AISDLC-\d+/);
  });

  it('quotes decision-id placeholders in every command and says ids are validated', () => {
    assert.match(body, /Ids are validated before they reach you/);
    assert.doesNotMatch(body, /[^"]<decision-id>[^"]/);
    assert.match(body, /show "<decision-id>"/);
    assert.match(body, /answer "<decision-id>" "<option-id>"/);
    assert.match(body, /--decision-id "<decision-id>"/);
  });

  it('ingests briefs through the enqueue mapping and marks each ingested once', () => {
    assert.match(body, /`ingested`/);
    assert.match(body, /marked ingested|marked\s+ingested/);
    assert.match(body, /never enqueues it again/);
  });

  it('watches done/ and failed/ verdicts and clears the executor that produced each', () => {
    assert.match(body, /`done\/` or `failed\/`/);
    assert.match(body, /`clear` result/);
    assert.match(body, /listed once/);
  });

  it('states that the playbook runs inside tick under the operational list', () => {
    assert.match(body, /playbook[\s\S]*already\s+ran inside `tick`/);
    assert.match(body, /operational list/);
    assert.match(body, /recorded as an event/);
  });

  it('reports to the planner with SendMessage and never to an executor', () => {
    assert.match(body, /SendMessage/);
    assert.match(body, /progress/);
    assert.match(body, /Never send these, or any other message, to an executor/);
  });

  it('routes decisions without answering design ones', () => {
    assert.match(body, /cli-decisions\.mjs" show/);
    assert.match(body, /route-decision/);
    assert.match(body, /Route `design`/);
  });

  it('self-clears after every wake-up with the resume delay the tick chose', () => {
    assert.match(body, /## Step 5 - Self-clear and sleep/);
    assert.match(body, /nextWakeSec/);
    assert.match(body, /clear --self --resume-after "\$NEXT_WAKE_SEC"/);
    assert.match(body, /Never `ScheduleWakeup`/);
  });

  it('refuses to loop without tmux instead of falling back to ScheduleWakeup', () => {
    assert.match(body, /Without tmux the command refuses/);
    assert.match(body, /do not loop/);
    assert.doesNotMatch(body, /falling back to ScheduleWakeup/);
  });

  it('states the hard rules plainly', () => {
    assert.match(body, /## Hard rules/);
    assert.match(body, /Never resolve an RFC Open Question/);
    assert.match(
      body,
      /Never edit `\.ai-sdlc\/\*` policy, and never edit a task's acceptance criteria/,
    );
    assert.match(
      body,
      /Never merge a pull request unless the governance policy already permits it/,
    );
    assert.match(body, /Never touch `main`/);
    assert.match(body, /Never answer a `design` decision/);
    assert.match(body, /Use your roster name for every board write/);
  });

  it('carries no internal task ids or RFC numbers in adopter-visible text', () => {
    assert.doesNotMatch(raw, /\b[A-Z]{3,}-\d+\b/);
  });

  it('invokes pipeline CLIs through the resolved bin directory only', () => {
    assert.doesNotMatch(body, /^\s*node\s+pipeline-cli\/bin\//m);
  });

  it('never tells the dispatch session to push, force-push or merge anything itself', () => {
    const fenced = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
    assert.doesNotMatch(fenced, /git push/);
    assert.doesNotMatch(fenced, /gh pr merge/);
    assert.doesNotMatch(fenced, /git (reset|checkout|rebase)/);
  });
});

describe('operator-dispatch peer binding and decision authority', () => {
  it('addresses only sessions in its own roster', () => {
    assert.match(body, /\*\*Address only sessions in your own roster\.\*\*/);
    assert.match(body, /mistake guard, not authentication/);
  });

  it('checks the repository before the loop runs', () => {
    assert.match(body, /cli-hierarchy\.mjs" check-repo/);
    assert.ok(body.indexOf('check-repo') < body.indexOf('## Step 2 - Run one wake-up'));
  });

  it('never falls back to a bare planner name when the roster has none', () => {
    assert.doesNotMatch(body, /\$\{PLANNER_NAME:-planner\}/);
    assert.match(body, /--to "\$PLANNER_NAME"/);
    assert.match(body, /leave the decision open,\s+record no routing/);
  });

  it('treats a decision record on main as sufficient authority for classes (a) and (b)', () => {
    assert.match(body, /decision record on `main`/);
    assert.match(body, /authored by the planner role, is sufficient authority/);
    assert.match(body, /decide-and-proceed and \(b\) timeboxed/);
    assert.match(body, /do not ask for the operator's direct\s+word/);
  });

  it('does not treat a relayed chat message as authority, and keeps class (c) with the operator', () => {
    assert.match(body, /A chat message relayed by another\s+session is never authority on its own/);
    assert.match(body, /class \(c\)\s+operator-only items still need the operator/);
    assert.match(body, /permission-laundering\s+rules\s+are\s+unchanged/);
  });
});
