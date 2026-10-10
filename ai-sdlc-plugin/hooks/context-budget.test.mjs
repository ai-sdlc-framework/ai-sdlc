/**
 * Tests for the context-budget Stop hook (AISDLC-651.4).
 *
 * Run with: node --test ai-sdlc-plugin/hooks/context-budget.test.mjs
 *
 * Every test builds its transcript, usage directory and roster in a temp
 * directory and clears the session-role environment, so nothing reads the real
 * home directory, process table or ledger.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const HOOK_SH = join(here, 'context-budget.sh');
const { contextBudgetNotice } = require('./context-budget.js');
const {
  DEFAULT_ROLE_BUDGETS,
  analyzeTranscriptLines,
  buildNotice,
  loadRoleBudgets,
  parseRoleBudgets,
  readTailLines,
  roleFromName,
} = require('./lib/context-budget.js');

const pluginJson = JSON.parse(readFileSync(join(here, '..', 'plugin.json'), 'utf-8'));
const marketplaceJson = JSON.parse(
  readFileSync(join(here, '..', '.claude-plugin', 'plugin.json'), 'utf-8'),
);

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'context-budget-hook-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

let seq = 0;
const fresh = (name) => {
  const dir = join(root, `${name}-${seq++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

function assistant(i, { cacheRead = 1000, input = 10, cacheCreate = 100, extra = {} } = {}) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: `msg-${i}`,
      model: 'claude-sonnet',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        output_tokens: 5,
      },
    },
    ...extra,
  });
}

const clearMarker = () =>
  JSON.stringify({
    type: 'attachment',
    attachment: { type: 'hook_success', hookName: 'SessionStart:clear', hookEvent: 'SessionStart' },
  });

function writeTranscript(lines) {
  const file = join(fresh('t'), 'session.jsonl');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/** Env with no usage dir contents, no roster and a fixed session name. */
function envFor(name, extra = {}) {
  const dir = fresh('env');
  return {
    PATH: process.env.PATH,
    HOME: dir,
    AI_SDLC_USAGE_DIR: join(dir, 'usage'),
    AI_SDLC_DISPATCH_BOARD_DIR: join(dir, 'board'),
    CLAUDE_PROJECT_DIR: dir,
    ...(name ? { AI_SDLC_SESSION_NAME: name } : {}),
    ...extra,
  };
}

const run = (transcript, env, input = {}) =>
  contextBudgetNotice({ transcript_path: transcript, ...input }, { env, pids: [] });

describe('notice', () => {
  it('returns the one-line notice when the context is over the role budget', () => {
    const file = writeTranscript([assistant(0), assistant(1, { cacheRead: 160_000 })]);
    const notice = run(file, envFor('planner'));
    assert.match(
      notice,
      /^Context budget exceeded for planner: 160,110 tokens of context \(budget 150,000\)/,
    );
    assert.match(notice, /2 turns since clear \(budget 300\)/);
    assert.match(notice, /Finish this unit and `\/clear`\.$/);
    assert.ok(!notice.includes('\n'));
  });

  it('returns nothing under budget', () => {
    const file = writeTranscript([assistant(0), assistant(1, { cacheRead: 5000 })]);
    assert.equal(run(file, envFor('planner')), null);
  });

  it('returns the notice when only the turn budget is exceeded', () => {
    const file = writeTranscript(Array.from({ length: 4 }, (_, i) => assistant(i)));
    const env = envFor('executor');
    mkdirSync(env.AI_SDLC_USAGE_DIR, { recursive: true });
    writeFileSync(
      join(env.AI_SDLC_USAGE_DIR, 'usage-config.yaml'),
      'apiVersion: ai-sdlc.io/v1alpha1\nkind: UsageConfig\nspec:\n  roles:\n    executor:\n      turnBudget: 3\n',
    );
    assert.match(run(file, env), /4 turns since clear \(budget 3\)/);
  });

  it('counts turns from the last clear, not from session start', () => {
    const lines = [
      ...Array.from({ length: 6 }, (_, i) => assistant(i)),
      clearMarker(),
      ...Array.from({ length: 2 }, (_, i) => assistant(10 + i, { cacheRead: 160_000 })),
    ];
    const stats = analyzeTranscriptLines(lines);
    assert.equal(stats.turnsSinceClear, 2);
    assert.match(run(writeTranscript(lines), envFor('planner')), /2 turns since clear/);
  });

  it('counts a repeated message id once and ignores sidechain and synthetic calls', () => {
    const lines = [
      assistant(0),
      assistant(0),
      assistant(1, { extra: { isSidechain: true } }),
      JSON.stringify({ type: 'assistant', message: { id: 's', model: '<synthetic>', usage: {} } }),
      assistant(2),
    ];
    assert.equal(analyzeTranscriptLines(lines).turnsSinceClear, 2);
  });

  it('returns nothing for a session whose role cannot be resolved', () => {
    const file = writeTranscript([assistant(0, { cacheRead: 900_000 })]);
    assert.equal(run(file, envFor(null)), null);
    assert.equal(run(file, envFor('some-other-session')), null);
  });

  it('resolves the role from the transcript title or the hook input', () => {
    const big = assistant(0, { cacheRead: 900_000 });
    const titled = writeTranscript([
      JSON.stringify({ type: 'custom-title', customTitle: 'planner' }),
      big,
    ]);
    assert.match(run(titled, envFor(null)), /for planner/);
    const plain = writeTranscript([big]);
    assert.match(
      run(plain, envFor(null), { session_name: 'operator-dispatch' }),
      /for operator-dispatch/,
    );
  });

  it('resolves the role from the hierarchy roster before the session name', () => {
    const env = envFor('planner');
    mkdirSync(env.AI_SDLC_DISPATCH_BOARD_DIR, { recursive: true });
    writeFileSync(
      join(env.AI_SDLC_DISPATCH_BOARD_DIR, 'hierarchy.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        sessions: [{ role: 'executor', name: 'executor-1', pid: 4242, status: 'running' }],
      }),
    );
    const file = writeTranscript([assistant(0, { cacheRead: 130_000 })]);
    const notice = contextBudgetNotice(
      { transcript_path: file },
      { env, pids: [4242], commOf: () => 'claude' },
    );
    assert.match(notice, /for executor: .*budget 120,000/);
  });
});

describe('budgets', () => {
  it('applies the documented defaults when no config exists', () => {
    assert.deepEqual(DEFAULT_ROLE_BUDGETS, {
      planner: { contextBudgetTokens: 150000, turnBudget: 300 },
      'operator-dispatch': { contextBudgetTokens: 100000, turnBudget: 200 },
      executor: { contextBudgetTokens: 120000, turnBudget: 150 },
    });
    assert.deepEqual(
      loadRoleBudgets({ env: envFor(null), readBase: () => null }),
      DEFAULT_ROLE_BUDGETS,
    );
  });

  it('reads the machine config first, then the base ref', () => {
    const doc = (n) =>
      `apiVersion: ai-sdlc.io/v1alpha1\nkind: UsageConfig\nspec:\n  plan:\n    name: x # c\n  roles:\n    planner:\n      contextBudgetTokens: ${n} # tokens\n`;
    const env = envFor(null);
    const base = loadRoleBudgets({ env, projectDir: '/p', readBase: () => doc(777) });
    assert.equal(base.planner.contextBudgetTokens, 777);
    assert.equal(base.planner.turnBudget, 300);
    mkdirSync(env.AI_SDLC_USAGE_DIR, { recursive: true });
    writeFileSync(join(env.AI_SDLC_USAGE_DIR, 'usage-config.yaml'), doc(555));
    assert.equal(
      loadRoleBudgets({ env, projectDir: '/p', readBase: () => doc(777) }).planner
        .contextBudgetTokens,
      555,
    );
  });

  it('ignores unknown roles, bad values and keys outside the roles block', () => {
    const b = parseRoleBudgets(
      [
        'spec:',
        '  windows:',
        '    - name: w',
        '  roles:',
        '    reviewer:',
        '      turnBudget: 5',
        '    executor:',
        '      turnBudget: -3',
        '      contextBudgetTokens: abc',
        '      other: 9',
        '    planner:',
        '      turnBudget: 12',
        '  allotmentTolerance: 0.5',
        'roles:',
        '  executor:',
        '    turnBudget: 1',
      ].join('\n'),
    );
    assert.equal(b.executor.turnBudget, 150);
    assert.equal(b.planner.turnBudget, 12);
    assert.deepEqual(parseRoleBudgets(undefined), DEFAULT_ROLE_BUDGETS);
  });

  it('survives an unreadable base-ref reader', () => {
    const b = loadRoleBudgets({
      env: envFor(null),
      projectDir: '/p',
      readBase: () => {
        throw new Error('boom');
      },
    });
    assert.deepEqual(b, DEFAULT_ROLE_BUDGETS);
  });
});

describe('roleFromName and buildNotice', () => {
  it('maps session names to roles', () => {
    assert.equal(roleFromName('planner'), 'planner');
    assert.equal(roleFromName('Executor-aisdlc-3'), 'executor');
    assert.equal(roleFromName('operator-dispatch'), 'operator-dispatch');
    assert.equal(roleFromName('planners'), null);
    assert.equal(roleFromName(7), null);
  });

  it('is silent exactly at the budget', () => {
    const budget = { contextBudgetTokens: 100, turnBudget: 5 };
    assert.equal(buildNotice({ contextTokens: 100, turnsSinceClear: 5 }, budget, 'executor'), null);
    assert.ok(buildNotice({ contextTokens: 101, turnsSinceClear: 5 }, budget, 'executor'));
  });
});

describe('speed and robustness', () => {
  it('handles a 1,000-turn transcript well inside the hook timeout', () => {
    const lines = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(assistant(i, { cacheRead: 50_000 + i }));
      lines.push(JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } }));
    }
    const file = writeTranscript(lines);
    const timeoutMs =
      pluginJson.hooks.Stop.flatMap((g) => g.hooks).find((h) =>
        h.command.includes('context-budget.sh'),
      ).timeout * 1000;
    const start = Date.now();
    const notice = run(file, envFor('planner'));
    assert.ok(Date.now() - start < timeoutMs / 2, 'well under the hook timeout');
    assert.match(notice, /1,000 turns since clear \(budget 300\)/);
  });

  it('reads only the tail of a file larger than the cap and drops the cut first line', () => {
    const file = writeTranscript(Array.from({ length: 200 }, (_, i) => assistant(i)));
    const lines = readTailLines(file, 2000);
    assert.ok(lines.length < 200);
    for (const l of lines.filter(Boolean)) JSON.parse(l);
  });

  it('returns null for a missing transcript or missing path', () => {
    assert.equal(run(join(root, 'nope.jsonl'), envFor('planner')), null);
    assert.equal(contextBudgetNotice({}, { env: envFor('planner'), pids: [] }), null);
    assert.equal(contextBudgetNotice(null, { env: envFor('planner'), pids: [] }), null);
  });

  it('skips unparseable lines', () => {
    const lines = ['{"usage" broken', assistant(0), '"usage"'];
    assert.equal(analyzeTranscriptLines(lines).turnsSinceClear, 1);
  });
});

describe('hook script', () => {
  const exec = (input, env) =>
    spawnSync('bash', [HOOK_SH], { input, env, encoding: 'utf-8', timeout: 10_000 });

  it('prints the notice as a systemMessage and exits 0 over budget', () => {
    const file = writeTranscript([assistant(0, { cacheRead: 900_000 })]);
    const res = exec(JSON.stringify({ transcript_path: file }), envFor('planner'));
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.match(out.systemMessage, /Context budget exceeded for planner/);
    assert.equal(out.decision, undefined, 'never blocks');
  });

  it('prints nothing and exits 0 under budget', () => {
    const file = writeTranscript([assistant(0)]);
    const res = exec(JSON.stringify({ transcript_path: file }), envFor('planner'));
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  });

  it('exits 0 on empty, malformed or hostile input', () => {
    for (const input of [
      '',
      'not json',
      '[]',
      '{"transcript_path": 5}',
      '{"transcript_path": "/nope"}',
    ]) {
      const res = exec(input, envFor('planner'));
      assert.equal(res.status, 0, input);
      assert.equal(res.stdout, '');
    }
  });
});

describe('registration', () => {
  const stopCommands = (manifest) =>
    manifest.hooks.Stop.flatMap((g) => g.hooks).map((h) => h.command);

  it('is registered on Stop beside usage-ingest, synchronously, in both manifests', () => {
    for (const manifest of [pluginJson, marketplaceJson]) {
      const stop = manifest.hooks.Stop.flatMap((g) => g.hooks);
      assert.ok(stopCommands(manifest).some((c) => c.includes('usage-ingest.sh')));
      const entry = stop.find((h) => h.command.includes('context-budget.sh'));
      assert.ok(entry, 'context-budget.sh registered');
      assert.notEqual(entry.async, true);
      assert.ok(entry.timeout > 0 && entry.timeout <= 10);
    }
  });
});
