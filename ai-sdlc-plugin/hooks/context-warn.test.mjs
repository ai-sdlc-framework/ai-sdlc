/**
 * Tests for the context warning (AISDLC-728): lib, status line command and Stop hook.
 *
 * Run with: node --test ai-sdlc-plugin/hooks/context-warn.test.mjs
 * Temp directories only; no real session state is touched.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const lib = require('./lib/context-warn.js');
const { runContextWarn } = require('./context-warn.js');
const readPlugin = (p) => JSON.parse(readFileSync(join(here, '..', p), 'utf-8'));

let dir;
let env;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctx-warn-'));
  env = { AI_SDLC_CONTEXT_STATE_DIR: dir, NO_COLOR: '1' };
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe('thresholds', () => {
  it('defaults to 30 and 40', () => {
    assert.deepEqual(lib.thresholds({}), { warn: 30, crit: 40 });
  });
  it('reads env overrides', () => {
    assert.deepEqual(
      lib.thresholds({ AI_SDLC_CONTEXT_WARN_PCT: '20', AI_SDLC_CONTEXT_CRIT_PCT: '50' }),
      { warn: 20, crit: 50 },
    );
  });
  it('falls back when misordered or invalid', () => {
    assert.deepEqual(
      lib.thresholds({ AI_SDLC_CONTEXT_WARN_PCT: '60', AI_SDLC_CONTEXT_CRIT_PCT: '50' }),
      { warn: 30, crit: 40 },
    );
    assert.deepEqual(lib.thresholds({ AI_SDLC_CONTEXT_WARN_PCT: 'abc' }), { warn: 30, crit: 40 });
  });
});

describe('status line rendering', () => {
  it('reads the percentage from the payload', () => {
    assert.equal(lib.percentageOf({ context_window: { used_percentage: 42.4 } }), 42.4);
    assert.equal(lib.percentageOf({ context_window: { used_percentage: '12' } }), 12);
    assert.equal(lib.percentageOf({}), null);
    assert.equal(lib.percentageOf(null), null);
  });
  it('colours green, yellow, red at the thresholds', () => {
    assert.match(lib.renderStatusLine(10, {}), /\u001b\[32mctx 10%/);
    assert.match(lib.renderStatusLine(30, {}), /\u001b\[33mctx 30%/);
    assert.match(lib.renderStatusLine(40, {}), /\u001b\[31mctx 40%/);
  });
  it('prints plain text under NO_COLOR and a placeholder with no data', () => {
    assert.equal(lib.renderStatusLine(41.6, { NO_COLOR: '1' }), 'ctx 42%');
    assert.equal(lib.renderStatusLine(null, {}), 'ctx --');
  });
  it('the command records the percentage and prints the line', () => {
    const script = join(here, '..', 'scripts', 'context-statusline.mjs');
    const res = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ session_id: 'sess-cmd', context_window: { used_percentage: 33 } }),
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), 'ctx 33%');
    assert.equal(lib.readState('sess-cmd', env).pct, 33);
  });
  it('the command survives empty input', () => {
    const script = join(here, '..', 'scripts', 'context-statusline.mjs');
    const res = spawnSync(process.execPath, [script], {
      input: '',
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    });
    assert.equal(res.stdout.trim(), 'ctx --');
  });
});

describe('warning once per crossing', () => {
  it('stays quiet below the upper threshold', () => {
    lib.recordPercentage('s1', 35, env);
    assert.equal(runContextWarn({ session_id: 's1' }, env), null);
  });
  it('warns once at the upper threshold, with a compact line', () => {
    lib.recordPercentage('s2', 41, env);
    const first = runContextWarn({ session_id: 's2' }, env);
    assert.match(first.systemMessage, /Context is at 41%/);
    assert.match(first.systemMessage, /\/compact Keep:/);
    assert.match(first.systemMessage, /handoff/);
    assert.equal(runContextWarn({ session_id: 's2' }, env), null);
    lib.recordPercentage('s2', 55, env);
    assert.equal(runContextWarn({ session_id: 's2' }, env), null);
  });
  it('re-arms after the percentage drops below the lower threshold', () => {
    lib.recordPercentage('s3', 45, env);
    assert.ok(runContextWarn({ session_id: 's3' }, env));
    lib.recordPercentage('s3', 5, env);
    assert.equal(runContextWarn({ session_id: 's3' }, env), null);
    lib.recordPercentage('s3', 44, env);
    assert.ok(runContextWarn({ session_id: 's3' }, env));
  });
  it('ignores unknown or unsafe session ids and a missing state', () => {
    assert.equal(runContextWarn({ session_id: 'nope' }, env), null);
    assert.equal(runContextWarn({ session_id: '../etc' }, env), null);
    assert.equal(runContextWarn({}, env), null);
    assert.equal(runContextWarn(null, env), null);
    assert.equal(lib.recordPercentage('../x', 50, env), false);
    assert.equal(lib.recordPercentage('s4', null, env), false);
  });
  it('tolerates a corrupt state file', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(lib.stateFile('bad', env), '{not json');
    assert.equal(runContextWarn({ session_id: 'bad' }, env), null);
  });
  it('can be switched off', () => {
    lib.recordPercentage('s5', 90, env);
    assert.equal(
      runContextWarn({ session_id: 's5' }, { ...env, AI_SDLC_CONTEXT_WARN: 'off' }),
      null,
    );
  });
});

describe('Stop hook process', () => {
  it('prints a systemMessage JSON once and exits 0', () => {
    lib.recordPercentage('s6', 80, env);
    const script = join(here, 'context-warn.js');
    const run = () =>
      spawnSync(process.execPath, [script], {
        input: JSON.stringify({ session_id: 's6' }),
        env: { ...process.env, ...env },
        encoding: 'utf-8',
      });
    const a = run();
    assert.equal(a.status, 0);
    assert.match(JSON.parse(a.stdout).systemMessage, /Context is at 80%/);
    assert.equal(run().stdout, '');
  });
  it('exits 0 on garbage stdin', () => {
    const res = spawnSync(process.execPath, [join(here, 'context-warn.js')], {
      input: 'garbage',
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    });
    assert.equal(res.status, 0);
  });
  it('is registered on Stop in both plugin manifests', () => {
    for (const p of ['plugin.json', '.claude-plugin/plugin.json']) {
      const stop = readPlugin(p).hooks.Stop.flatMap((g) => g.hooks);
      assert.ok(
        stop.some((h) => h.command.includes('context-warn.sh')),
        p,
      );
    }
  });
});
