/**
 * Tests for the session-role resolution helpers in hierarchy-role.js.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/lib/hierarchy-role.test.mjs
 *
 * Everything is injected: no real process table and no real roster are read.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('./hierarchy-role.js');
const { ancestorPids, resolveSessionRole, resolveSessionSelf } = lib;

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function entry(role, name, pid, status = 'running') {
  return { role, name, pid, status };
}

function boardWith(sessions) {
  const dir = mkdtempSync(join(tmpdir(), 'hier-role-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'hierarchy.json'), JSON.stringify({ schemaVersion: 'v1', sessions }));
  return dir;
}

const claude = () => 'claude';

describe('ancestorPids', () => {
  it('walks outward through the injected parent lookup, nearest first', () => {
    const parents = { 40: 30, 30: 20, 20: 10 };
    assert.deepEqual(
      ancestorPids({ pid: 50, ppid: 40, parentOf: (p) => parents[p] ?? null }),
      [50, 40, 30, 20, 10],
    );
  });

  it('stops at an unreadable parent, a cycle, init and the depth bound', () => {
    assert.deepEqual(ancestorPids({ pid: 5, ppid: 4, parentOf: () => null }), [5, 4]);
    assert.deepEqual(
      ancestorPids({ pid: 5, ppid: 4, parentOf: (p) => (p === 4 ? 3 : 4) }),
      [5, 4, 3],
    );
    assert.deepEqual(ancestorPids({ pid: 5, ppid: 1, parentOf: () => 9 }), [5]);
    const deep = ancestorPids({ pid: 1000, ppid: 999, parentOf: (p) => p - 1 });
    assert.ok(deep.length <= 17);
  });
});

describe('resolveSessionRole', () => {
  it('resolves role, name and the dispatch session for the nearest running entry', () => {
    const boardDir = boardWith([
      entry('operator-dispatch', 'operator-dispatch', 11),
      entry('executor', 'executor-alpha-2', 50),
    ]);
    assert.deepEqual(resolveSessionRole({ boardDir, pids: [60, 50, 11], commOf: claude }), {
      role: 'executor',
      name: 'executor-alpha-2',
      dispatchName: 'operator-dispatch',
    });
  });

  it('reports a null dispatch name when the roster has none', () => {
    const boardDir = boardWith([entry('planner', 'planner', 50)]);
    assert.deepEqual(resolveSessionRole({ boardDir, pids: [50], commOf: claude }), {
      role: 'planner',
      name: 'planner',
      dispatchName: null,
    });
  });

  it('resolves nothing for a missing roster, a stale entry or a foreign pid', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hier-role-'));
    dirs.push(empty);
    assert.equal(resolveSessionRole({ boardDir: empty, pids: [50], commOf: claude }), null);
    const stale = boardWith([entry('executor', 'executor-a', 50, 'stopped')]);
    assert.equal(resolveSessionRole({ boardDir: stale, pids: [50], commOf: claude }), null);
    const other = boardWith([entry('executor', 'executor-a', 51)]);
    assert.equal(resolveSessionRole({ boardDir: other, pids: [50, 49], commOf: claude }), null);
  });

  it('resolves nothing when the matched pid is not a claude process or cannot be read', () => {
    const boardDir = boardWith([entry('executor', 'executor-a', 50)]);
    for (const commOf of [
      () => 'zsh',
      () => '',
      () => '/usr/bin/tmux',
      () => {
        throw new Error('ps failed');
      },
    ]) {
      assert.equal(resolveSessionRole({ boardDir, pids: [50], commOf }), null);
    }
  });

  it('lets the nearest match decide: a non-claude near pid is not replaced by a farther one', () => {
    const boardDir = boardWith([
      entry('executor', 'executor-near', 50),
      entry('planner', 'planner-far', 20),
    ]);
    const commOf = (pid) => (pid === 50 ? 'zsh' : 'claude');
    assert.equal(resolveSessionRole({ boardDir, pids: [50, 20], commOf }), null);
  });

  it('exposes the raw entry and the running roster through resolveSessionSelf', () => {
    const boardDir = boardWith([
      entry('operator-dispatch', 'operator-dispatch', 11),
      entry('executor', 'executor-a', 50),
    ]);
    const found = resolveSessionSelf({ boardDir, pids: [50], commOf: claude });
    assert.equal(found.self.name, 'executor-a');
    assert.equal(found.sessions.length, 2);
  });
});

describe('onMismatch', () => {
  it('reports a running entry whose matched pid is not claude, without changing the result', () => {
    const boardDir = boardWith([entry('executor', 'executor-a', 50)]);
    const seen = [];
    const res = resolveSessionRole({
      boardDir,
      pids: [60, 50],
      commOf: () => '/bin/zsh',
      onMismatch: (info) => seen.push(info),
    });
    assert.equal(res, null);
    assert.deepEqual(seen, [{ pid: 50, role: 'executor', name: 'executor-a', comm: '/bin/zsh' }]);
  });

  it('stays silent for a claude pid, a stale entry or no match, and survives a throwing callback', () => {
    const seen = [];
    const onMismatch = (info) => seen.push(info);
    const running = boardWith([entry('executor', 'executor-a', 50)]);
    resolveSessionRole({ boardDir: running, pids: [50], commOf: claude, onMismatch });
    resolveSessionRole({ boardDir: running, pids: [49], commOf: () => 'zsh', onMismatch });
    const stale = boardWith([entry('executor', 'executor-a', 50, 'stopped')]);
    resolveSessionRole({ boardDir: stale, pids: [50], commOf: () => 'zsh', onMismatch });
    assert.deepEqual(seen, []);
    const res = resolveSessionRole({
      boardDir: running,
      pids: [50],
      commOf: () => 'zsh',
      onMismatch: () => {
        throw new Error('boom');
      },
    });
    assert.equal(res, null);
  });
});

describe('handoff reload after clear or compact (AISDLC-728)', () => {
  const roster = (role) => {
    const d = mkdtempSync(join(tmpdir(), 'hr-handoff-'));
    writeFileSync(
      join(d, 'hierarchy.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        sessions: [{ role, name: `${role}-x`, pid: 4242, status: 'running' }],
      }),
    );
    return d;
  };
  const claude = () => 'claude';

  it('injects handoff text and the scheduled-jobs line for the planner on compact', () => {
    const boardDir = roster('planner');
    const out = lib.buildHierarchyRoleBlock({
      source: 'compact',
      boardDir,
      pids: [4242],
      commOf: claude,
      readHandoff: () => 'HANDOFF BODY',
    });
    rmSync(boardDir, { recursive: true, force: true });
    assert.match(out, /Handoff \(reloaded after compact\)/);
    assert.match(out, /HANDOFF BODY/);
    assert.match(out, /Scheduled jobs: list them now and recreate/);
  });

  it('omits the scheduled-jobs line for an executor and works with no handoff', () => {
    const boardDir = roster('executor');
    const out = lib.buildHierarchyRoleBlock({
      source: 'clear',
      boardDir,
      pids: [4242],
      commOf: claude,
      readHandoff: () => null,
    });
    rmSync(boardDir, { recursive: true, force: true });
    assert.doesNotMatch(out, /Scheduled jobs/);
    assert.doesNotMatch(out, /Handoff \(/);
  });

  it('readHandoffText keeps the state-hash line and the last line of a 200 KB handoff', () => {
    const big = [
      '<!-- state-hash: ' + 'a'.repeat(64) + ' -->',
      ...Array.from({ length: 6000 }, (_, i) => `note line ${i} ${'y'.repeat(30)}`),
      'LAST LINE WRITTEN',
    ].join('\n');
    assert.ok(big.length > 200000);
    const text = lib.readHandoffText(
      { role: 'planner', name: 'planner' },
      { bin: '/bin/cli.mjs', boardDir: '/b', run: () => ({ status: 0, stdout: big }) },
    );
    assert.match(text, /state-hash: a{64}/);
    assert.ok(text.includes('LAST LINE WRITTEN'));
    assert.ok(!text.includes('[handoff truncated]'));
    assert.ok(text.length <= lib.HANDOFF_MAX_CHARS + 100);
  });

  it('readHandoffText runs handoff read, truncates, and fails soft', () => {
    const self = { role: 'planner', name: 'planner' };
    let argv;
    const run = (_node, args) => {
      argv = args;
      return { status: 0, stdout: 'x'.repeat(lib.HANDOFF_MAX_CHARS + 50) };
    };
    const text = lib.readHandoffText(self, { bin: '/bin/cli.mjs', boardDir: '/b', run });
    assert.ok(text.includes('[handoff middle omitted]'));
    assert.doesNotMatch(text, /\[handoff truncated\]/);
    assert.deepEqual(argv.slice(1, 6), ['handoff', 'read', '--role', 'planner', '--name']);
    assert.equal(lib.readHandoffText(self, { bin: '', boardDir: '/b', run }), null);
    assert.equal(
      lib.readHandoffText({ role: 'planner', name: '../x' }, { bin: '/b', boardDir: '/b', run }),
      null,
    );
    assert.equal(
      lib.readHandoffText(self, { bin: '/b', boardDir: '/b', run: () => ({ status: 1 }) }),
      null,
    );
    assert.equal(
      lib.readHandoffText(self, {
        bin: '/b',
        boardDir: '/b',
        run: () => {
          throw new Error('x');
        },
      }),
      null,
    );
  });
});
