/**
 * Tests for the developer turn budget (AISDLC-651.3).
 * Run with: node --test ai-sdlc-plugin/hooks/developer-turn-budget.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookScript = join(__dirname, 'collect-tool-sequence.js');
const require = createRequire(import.meta.url);
const lib = require('./lib/developer-turn-budget.js');

const CONFIG = 'developer:\n  turnBudget:\n    budget: 10\n    warnAt: 80\n';

let root;
let home;
let repo;

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dev-turn-budget-'));
  home = join(root, 'home');
  repo = join(root, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, '.ai-sdlc'), { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 't'], repo);
  writeFileSync(join(repo, '.ai-sdlc', 'review-config.yaml'), CONFIG);
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'base'], repo);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], repo);
  // The worktree copy claims a huge budget; it must be ignored.
  writeFileSync(
    join(repo, '.ai-sdlc', 'review-config.yaml'),
    'developer:\n  turnBudget:\n    budget: 9999\n',
  );
  writeFileSync(join(repo, '.active-task'), 'AISDLC-9\n');
});

after(() => rmSync(root, { recursive: true, force: true }));

function call(agentType, agentId) {
  const out = execFileSync('node', [hookScript], {
    input: JSON.stringify({
      tool_name: 'Read',
      tool_input: { file_path: 'a.ts' },
      session_id: 's1',
      cwd: repo,
      agent_type: agentType,
      agent_id: agentId,
    }),
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PROJECT_DIR: repo,
      AI_SDLC_USAGE_DIR: join(home, 'u'),
    },
    timeout: 10000,
  }).trim();
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : null;
}

describe('developer turn budget hook', () => {
  it('warns on call 8 and stops on call 10 (base-ref config, not worktree copy)', () => {
    const notices = [];
    for (let i = 1; i <= 10; i++) notices.push(call('developer', 'agent-a'));
    assert.deepEqual(
      notices.map((n) => n === null),
      [true, true, true, true, true, true, true, false, true, false],
    );
    assert.match(notices[7], /8 of 10/);
    assert.match(notices[7], /park/);
    assert.match(notices[9], /TURN BUDGET REACHED/);
    assert.match(notices[9], /notes\.parked: true/);
  });

  it('leaves other agent types and main sessions unaffected', () => {
    for (let i = 1; i <= 12; i++) {
      assert.equal(call('code-reviewer', 'agent-b'), null);
      assert.equal(call(undefined, undefined), null);
    }
  });

  it('records turns used per run with the task id', () => {
    const lines = readFileSync(join(home, 'u', 'developer-turns.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const last = lines.filter((l) => l.agentId === 'agent-a').pop();
    assert.equal(last.turns, 10);
    assert.equal(last.budget, 10);
    assert.equal(last.taskId, 'AISDLC-9');
  });
});

describe('parseTurnBudget', () => {
  it('defaults when absent or invalid', () => {
    assert.deepEqual(lib.parseTurnBudget(null), { budget: 120, warnAt: 80 });
    assert.deepEqual(lib.parseTurnBudget('reviewerSet: three\n'), { budget: 120, warnAt: 80 });
    assert.deepEqual(lib.parseTurnBudget('developer:\n  turnBudget:\n    budget: 0\n'), {
      budget: 120,
      warnAt: 80,
    });
  });
  it('reads budget and warnAt only under developer.turnBudget', () => {
    assert.deepEqual(lib.parseTurnBudget(CONFIG), { budget: 10, warnAt: 80 });
    assert.deepEqual(
      lib.parseTurnBudget(
        'other:\n  turnBudget:\n    budget: 5\ndeveloper:\n  turnBudget:\n    warnAt: 50\n',
      ),
      { budget: 120, warnAt: 50 },
    );
  });
  it('falls back to defaults when the base ref has no config', () => {
    assert.deepEqual(lib.resolveTurnBudget(tmpdir(), 'origin/nonexistent'), {
      budget: 120,
      warnAt: 80,
    });
  });
});
