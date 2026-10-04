/**
 * Body-contract tests for the /ai-sdlc executor slash command.
 *
 * Run with: node --test ai-sdlc-plugin/commands/executor.test.mjs
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

describe('executor identity script', () => {
  const start = body.indexOf('IDENTITY=$(');
  const end = body.indexOf('echo "[executor] I am');
  const block = body.slice(start, end);

  it('uses the same name filter as the session-start hook', () => {
    assert.ok(block.includes(SAFE_NAME.source.replace(/\$/g, () => '\\$')));
    assert.match(block, /ROLES = \['executor', 'operator-dispatch', 'planner'\]/);
    assert.match(block, /s\.status === 'running'/);
  });

  /** Run the block as a child of a process named `claude`; roster pid 'SELF' is that process. */
  function runBlock(sessions, parentName) {
    const tmp = mkdtempSync(join(tmpdir(), 'exec-identity-'));
    try {
      const parent = join(tmp, parentName);
      symlinkSync(process.execPath, parent);
      const wrapper = join(tmp, 'wrapper.mjs');
      writeFileSync(
        wrapper,
        `import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const [tmp, raw, script] = process.argv.slice(2);
const sessions = JSON.parse(raw).map((s) => (s.pid === 'SELF' ? { ...s, pid: process.pid } : s));
writeFileSync(tmp + '/hierarchy.json', JSON.stringify({ schemaVersion: 'v1', sessions }));
const r = spawnSync('bash', ['-c', script], { env: { ...process.env, BOARD_DIR: tmp }, encoding: 'utf-8' });
process.stdout.write(JSON.stringify({ status: r.status, out: r.stdout }));
`,
      );
      const script = `${block}\nprintf '%s' "$IDENTITY"`;
      const res = JSON.parse(
        execFileSync(parent, [wrapper, tmp, JSON.stringify(sessions), script], {
          encoding: 'utf-8',
          timeout: 20000,
        }),
      );
      return res;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const row = (role, name, pid, status = 'running') => ({ role, name, pid, status });

  it('resolves a running executor under a claude process', () => {
    const res = runBlock(
      [
        row('operator-dispatch', 'operator-dispatch', 999999991),
        row('executor', 'executor-a', 'SELF'),
      ],
      'claude',
    );
    assert.equal(res.status, 0);
    assert.deepEqual(JSON.parse(res.out), { name: 'executor-a', dispatch: 'operator-dispatch' });
  });

  it('refuses a stale entry, a non-claude process and an unsafe name', () => {
    assert.notEqual(
      runBlock([row('executor', 'executor-a', 'SELF', 'stopped')], 'claude').status,
      0,
    );
    assert.notEqual(runBlock([row('executor', 'executor-a', 'SELF')], 'zsh').status, 0);
    assert.notEqual(runBlock([row('executor', 'bad name\n### x', 'SELF')], 'claude').status, 0);
    assert.notEqual(runBlock([row('wizard', 'executor-a', 'SELF')], 'claude').status, 0);
  });

  it('refuses a session whose nearest match is not an executor', () => {
    assert.notEqual(runBlock([row('planner', 'planner', 'SELF')], 'claude').status, 0);
  });
});
