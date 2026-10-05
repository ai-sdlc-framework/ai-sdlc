/**
 * Body-contract tests for the /ai-sdlc operator-dispatch slash command.
 *
 * Run with: node --test ai-sdlc-plugin/commands/operator-dispatch.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { SAFE_NAME } = require('../hooks/lib/hierarchy-role.js');
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

  it('reads the roster for its own name and the planner name', () => {
    assert.match(body, /hierarchy\.json/);
    assert.match(body, /self\.role !== 'operator-dispatch'/);
    assert.match(body, /s\.role === 'planner'/);
  });

  it('runs one wake-up through the hierarchy tick under its roster name', () => {
    assert.match(body, /cli-hierarchy\.mjs" tick[\s\S]*--worker "\$MY_NAME"/);
  });

  it('states exactly what tick checks: the caller own identity, not --worker', () => {
    assert.match(body, /checks who is calling, not what `--worker` says/);
    assert.match(body, /unless that session has the\s+`operator-dispatch` role/);
    assert.match(body, /must also equal\s+the caller's own roster name/);
    assert.doesNotMatch(body, /when `--worker` is not the running\s+dispatch session/);
    assert.doesNotMatch(body, /AISDLC-\d+/);
  });

  it('quotes decision-id placeholders in every command and says ids are validated', () => {
    assert.match(body, /Decision ids are validated before they reach you/);
    assert.doesNotMatch(body, /[^"]<decision-id>[^"]/);
    assert.match(body, /show "<decision-id>"/);
    assert.match(body, /answer "<decision-id>" "<option-id>"/);
    assert.match(body, /--decision-id "<decision-id>"/);
  });

  it('ingests briefs through the enqueue mapping and marks each ingested once', () => {
    assert.match(body, /briefs\//);
    assert.match(body, /enqueue --from-brief/);
    assert.match(body, /marked ingested/);
    assert.match(body, /never enqueues it again/);
  });

  it('watches done/ and failed/ verdicts and clears the executor that produced each', () => {
    assert.match(body, /`done\/` or `failed\/`/);
    assert.match(body, /clear/);
    assert.match(body, /listed once/);
  });

  it('describes every playbook step and the gate on the operational list', () => {
    assert.match(body, /## The unblocking playbook/);
    assert.match(body, /--force-with-lease/);
    assert.match(body, /origin\/main/);
    assert.match(body, /empty commit/);
    assert.match(body, /cli-dispatch requeue --task-id "<task-id>"/);
    assert.match(body, /Escalates to the planner/);
    assert.match(body, /operational list/);
    assert.match(body, /recorded as an\s+event/);
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

  it('wakes itself up again and stops', () => {
    assert.match(body, /ScheduleWakeup/);
    assert.match(body, /\/ai-sdlc operator-dispatch/);
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
    assert.match(body, /do not ask\s+for the operator's direct word/);
  });

  it('does not treat a relayed chat message as authority, and keeps class (c) with the operator', () => {
    assert.match(body, /A chat message relayed by another\s+session is never authority on its own/);
    assert.match(body, /class \(c\) operator-only items still need\s+the operator/);
    assert.match(body, /permission-laundering rules are unchanged/);
  });
});

describe('operator-dispatch identity script', () => {
  const start = body.indexOf('IDENTITY=$(');
  const end = body.indexOf('echo "[operator-dispatch] I am');
  const block = body.slice(start, end);

  it('uses the same name filter as the session-start hook', () => {
    // The script sits inside a double-quoted shell string, so `$` is written `\$`.
    assert.ok(block.includes(SAFE_NAME.source.replace(/\$/g, () => '\\$')));
    assert.match(block, /ROLES = \['executor', 'operator-dispatch', 'planner'\]/);
    assert.match(block, /s\.status === 'running'/);
  });

  /** Run the block as a child of a process named `parentName`; roster pid 'SELF' is that process. */
  function runBlock(sessions, parentName) {
    const tmp = mkdtempSync(join(tmpdir(), 'dispatch-identity-'));
    try {
      const parent = join(tmp, parentName);
      symlinkSync(process.execPath, parent);
      const wrapper = join(tmp, 'wrapper.mjs');
      writeFileSync(
        wrapper,
        `import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [tmp, raw, script] = process.argv.slice(2);
const sessions = JSON.parse(raw).map((s) => (s.pid === 'SELF' ? { ...s, pid: process.pid } : s));
writeFileSync(tmp + '/hierarchy.json', JSON.stringify({ schemaVersion: 'v1', sessions }));
const r = spawnSync('bash', ['-c', script], { env: { ...process.env, BOARD_DIR: tmp }, encoding: 'utf-8' });
process.stdout.write(JSON.stringify({ status: r.status, out: r.stdout }));
`,
      );
      const script = `${block}\nprintf '%s' "$IDENTITY"`;
      return JSON.parse(
        execFileSync(parent, [wrapper, tmp, JSON.stringify(sessions), script], {
          encoding: 'utf-8',
          timeout: 20000,
        }),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const row = (role, name, pid, status = 'running') => ({ role, name, pid, status });

  it('resolves a running dispatch session under a claude process, with the planner name', () => {
    const res = runBlock(
      [row('planner', 'planner', 999999991), row('operator-dispatch', 'dispatch-a', 'SELF')],
      'claude',
    );
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(res.out), { name: 'dispatch-a', planner: 'planner' });
  });

  it('reports an empty planner name when the roster has no planner', () => {
    const res = runBlock([row('operator-dispatch', 'operator-dispatch', 'SELF')], 'claude');
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(res.out), { name: 'operator-dispatch', planner: '' });
  });

  it('keeps a collision suffix exactly as the roster has it', () => {
    const res = runBlock([row('operator-dispatch', 'operator-dispatch-2', 'SELF')], 'claude');
    assert.equal(JSON.parse(res.out).name, 'operator-dispatch-2');
  });

  it('refuses a stale entry, a non-claude process and an unsafe name', () => {
    assert.notEqual(
      runBlock([row('operator-dispatch', 'dispatch-a', 'SELF', 'stopped')], 'claude').status,
      0,
    );
    assert.notEqual(runBlock([row('operator-dispatch', 'dispatch-a', 'SELF')], 'zsh').status, 0);
    assert.notEqual(
      runBlock([row('operator-dispatch', 'bad name\n### x', 'SELF')], 'claude').status,
      0,
    );
    assert.notEqual(runBlock([row('wizard', 'dispatch-a', 'SELF')], 'claude').status, 0);
  });

  it('refuses a session whose nearest match is not the dispatch session', () => {
    assert.notEqual(runBlock([row('executor', 'executor-a', 'SELF')], 'claude').status, 0);
    assert.notEqual(runBlock([row('planner', 'planner', 'SELF')], 'claude').status, 0);
  });
});
