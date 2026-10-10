/**
 * Tests for the context auto-clear Stop hook (AISDLC-766).
 *
 * Run with: node --test ai-sdlc-plugin/hooks/context-auto-clear.test.mjs
 *
 * Temp directories only; the CLI is replaced by an injected runner, so no session,
 * tmux server or real pipeline-cli is touched.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { runAutoClear, boardDirOf } = require('./context-auto-clear.js');
const pluginJson = JSON.parse(readFileSync(join(here, '..', 'plugin.json'), 'utf-8'));

let root;
let board;
let bin;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'ctx-auto-clear-'));
  board = join(root, '.ai-sdlc', 'dispatch');
  mkdirSync(board, { recursive: true });
  bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'cli-hierarchy.mjs'), '// fake\n');
});
after(() => rmSync(root, { recursive: true, force: true }));

const payload = { transcript_path: '/tmp/t.jsonl' };
const env = () => ({ PIPELINE_CLI_BIN: bin });

describe('context-auto-clear hook', () => {
  it('is registered on Stop', () => {
    const stop = pluginJson.hooks.Stop.flatMap((g) => g.hooks);
    assert.ok(stop.some((h) => h.command.includes('context-auto-clear.sh')));
  });

  it('exits quietly outside a hierarchy roster', () => {
    const calls = [];
    const r = runAutoClear(payload, {
      env: env(),
      cwd: root,
      run: (...a) => (calls.push(a), { status: 0 }),
    });
    assert.equal(r, 'no-roster');
    assert.equal(calls.length, 0);
  });

  it('runs cli-hierarchy auto-clear with the transcript and board for a roster session', () => {
    writeFileSync(join(board, 'hierarchy.json'), '{}');
    const calls = [];
    const r = runAutoClear(payload, {
      env: env(),
      cwd: root,
      run: (file, args) => (calls.push({ file, args }), { status: 0 }),
    });
    assert.equal(r, 'ran');
    assert.deepEqual(calls[0].args.slice(1), [
      'auto-clear',
      '--transcript',
      '/tmp/t.jsonl',
      '--board-dir',
      board,
    ]);
  });

  it('skips on a missing transcript, remote sandbox, opt-out and missing CLI', () => {
    const run = () => assert.fail('must not run');
    assert.equal(runAutoClear({}, { env: env(), cwd: root, run }), 'no-transcript');
    assert.equal(
      runAutoClear(payload, { env: { ...env(), CLAUDE_CODE_ENV: 'ccr' }, cwd: root, run }),
      'remote-sandbox',
    );
    assert.equal(
      runAutoClear(payload, { env: { ...env(), AI_SDLC_AUTO_CLEAR: 'off' }, cwd: root, run }),
      'switched-off',
    );
    assert.equal(
      runAutoClear(payload, {
        env: { PIPELINE_CLI_BIN: join(root, 'missing') },
        cwd: root,
        pluginDir: join(root, 'no-plugin'),
        run,
      }),
      'no-cli',
    );
  });

  it('reports a failing CLI without throwing', () => {
    const r = runAutoClear(payload, { env: env(), cwd: root, run: () => ({ status: 1 }) });
    assert.equal(r, 'failed');
    const t = runAutoClear(payload, {
      env: env(),
      cwd: root,
      run: () => {
        throw new Error('boom');
      },
    });
    assert.equal(t, 'failed');
  });

  it('finds the main checkout board from inside a worktree', () => {
    const wt = join(root, 'wt');
    mkdirSync(wt);
    assert.equal(
      boardDirOf({}, wt, () => join(root, '.git')),
      join(root, '.ai-sdlc', 'dispatch'),
    );
    assert.equal(
      boardDirOf({ AI_SDLC_DISPATCH_BOARD_DIR: '/x' }, wt, () => ''),
      '/x',
    );
  });

  it('the shell wrapper always exits 0', () => {
    const res = spawnSync('bash', [join(here, 'context-auto-clear.sh')], {
      input: '{}',
      env: { ...process.env, PIPELINE_CLI_BIN: bin },
      cwd: root,
      encoding: 'utf-8',
    });
    assert.equal(res.status, 0);
  });
});
