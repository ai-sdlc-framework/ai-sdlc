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
    assert.match(body, /checks who is calling/);
    assert.match(body, /`operator-dispatch`\s+role/);
    assert.doesNotMatch(body, /AISDLC-\d+/);
  });

  it('quotes decision-id placeholders in every command and says ids are validated', () => {
    assert.match(body, /Ids are validated/);
    assert.doesNotMatch(body, /[^"]<decision-id>[^"]/);
    assert.match(body, /show "<decision-id>"/);
    assert.match(body, /answer "<decision-id>" "<option-id>"/);
    assert.match(body, /--decision-id "<decision-id>"/);
  });

  it('ingests briefs through the enqueue mapping and marks each ingested once', () => {
    assert.match(body, /`ingested`/);
    assert.match(body, /each new brief once/);
  });

  it('watches done/ and failed/ verdicts and clears the executor that produced each', () => {
    assert.match(body, /`verdicts`: each new verdict once/);
    assert.match(body, /`clear` result/);
  });

  it('states that the playbook runs inside tick under the operational list', () => {
    assert.match(body, /playbook[\s\S]*already run inside `tick`/);
    assert.match(body, /operational list/);
  });

  it('reports to the planner with SendMessage and never to an executor', () => {
    assert.match(body, /SendMessage/);
    assert.match(body, /progress/);
    assert.match(body, /Never send these, or any message, to an executor/);
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
    assert.match(body, /Without tmux[\s\S]*the command refuses/);
    assert.match(body, /restart with `cli-hierarchy up`/);
    assert.doesNotMatch(body, /falling back to ScheduleWakeup/);
  });

  it('states the hard rules plainly', () => {
    assert.match(body, /## Hard rules/);
    assert.match(body, /Never resolve an RFC Open Question/);
    assert.match(body, /Never edit `\.ai-sdlc\/\*` policy or a task's acceptance criteria/);
    assert.match(body, /Never merge a pull request unless the governance policy permits it/);
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
    assert.match(body, /\*\*Address only sessions in your roster\.\*\*/);
  });

  it('checks the repository before the loop runs', () => {
    assert.match(body, /cli-hierarchy\.mjs" check-repo/);
    assert.ok(body.indexOf('check-repo') < body.indexOf('## Step 2 - Run one wake-up'));
  });

  it('never falls back to a bare planner name when the roster has none', () => {
    assert.doesNotMatch(body, /\$\{PLANNER_NAME:-planner\}/);
    assert.match(body, /--to "\$PLANNER_NAME"/);
    assert.match(body, /leave it open,\s+record no routing/);
  });

  it('treats a decision record on main as sufficient authority for classes (a) and (b)', () => {
    assert.match(
      body,
      /planner-authored\s+decision record on `main` suffices for classes \(a\) and \(b\)/,
    );
  });

  it('does not treat a relayed chat message as authority, and keeps class (c) with the operator', () => {
    assert.match(body, /relayed chat message is never authority/);
    assert.match(body, /class \(c\) operator-only items\s+still need the operator/);
  });
});

describe('operator-dispatch bash blocks assign what they use', () => {
  // Bash tool calls do not share shell variables, so each fenced block must assign every
  // variable it reads (AISDLC-760 round 2).
  const KNOWN = new Set([
    'HOME',
    'PATH',
    'PWD',
    'TMUX_PANE',
    'CLAUDE_PLUGIN_DIR',
    'CLAUDE_PLUGIN_ROOT',
    'AI_SDLC_DISPATCH_BOARD_DIR',
  ]);
  const blocks = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);

  it('has the expected bash blocks', () => {
    assert.ok(blocks.length >= 4, `found ${blocks.length} blocks`);
  });

  for (const [i, block] of blocks.entries()) {
    it(`block ${i + 1} assigns every variable it reads`, () => {
      const assigned = new Set(
        [...block.matchAll(/(?:^|[\s;&|(])([A-Z][A-Z0-9_]*)=/g)].map((m) => m[1]),
      );
      const used = new Set([...block.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
      const missing = [...used].filter((v) => !assigned.has(v) && !KNOWN.has(v));
      assert.deepEqual(missing, [], `block ${i + 1} reads unassigned: ${missing.join(', ')}`);
    });
  }

  it('derives MY_NAME, PLANNER_NAME and NEXT_WAKE_SEC from the saved tick JSON', () => {
    assert.match(body, /MY_NAME=\$\(node -pe[^\n]*identity\.name/);
    assert.match(body, /PLANNER_NAME=\$\(node -pe[^\n]*identity\.planner/);
    assert.match(body, /NEXT_WAKE_SEC=\$\(node -pe[^\n]*nextWakeSec/);
  });
});
