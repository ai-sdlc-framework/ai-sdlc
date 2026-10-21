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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('relays the warn message so the session gets a handoff turn', () => {
    writeFileSync(join(board, 'hierarchy.json'), '{}');
    const seen = [];
    const out = JSON.stringify({ action: 'warn', message: 'run your handoff routine' });
    const r = runAutoClear(payload, {
      env: env(),
      cwd: root,
      run: () => ({ status: 0, stdout: `${out}\n` }),
      onWarn: (m) => seen.push(m),
    });
    assert.equal(r, 'warned');
    assert.deepEqual(seen, ['run your handoff routine']);
  });

  it('logs exactly one reason line per exit after the roster check (AISDLC-1007)', () => {
    writeFileSync(join(board, 'hierarchy.json'), '{}');
    const lines = [];
    const log = (l) => lines.push(l);
    const d = (o) => ({ status: 0, stdout: `${JSON.stringify(o)}\n` });
    runAutoClear(payload, {
      env: env(),
      cwd: root,
      log,
      run: () => d({ action: 'clear', code: 'scheduled' }),
    });
    runAutoClear(payload, {
      env: env(),
      cwd: root,
      log,
      run: () => d({ action: 'none', code: 'handoff-stale' }),
    });
    runAutoClear(payload, {
      env: env(),
      cwd: root,
      log,
      run: () => d({ action: 'none', code: 'below-threshold' }),
    });
    runAutoClear(payload, {
      env: env(),
      cwd: root,
      log,
      run: () => d({ action: 'warn', message: 'm', code: 'warned' }),
      onWarn: () => {},
    });
    runAutoClear(payload, {
      env: env(),
      cwd: root,
      log,
      run: () => ({ status: 1, stderr: 'bad thing\nmore' }),
    });
    runAutoClear(payload, {
      env: { PIPELINE_CLI_BIN: join(root, 'missing') },
      cwd: root,
      pluginDir: join(root, 'no-plugin'),
      log,
      run: () => assert.fail('no'),
    });
    assert.deepEqual(lines, [
      'scheduled',
      'handoff-stale',
      'below-threshold',
      'warned',
      'failed:bad thing',
      'no-cli',
    ]);
  });

  it('logReason appends to the board log, else prints', () => {
    const { logReason } = require('./context-auto-clear.js');
    logReason('scheduled', board);
    assert.match(
      readFileSync(join(board, 'log', 'context-auto-clear.log'), 'utf-8'),
      /scheduled\n$/,
    );
    const orig = process.stdout.write;
    let out = '';
    process.stdout.write = (c) => ((out += c), true);
    try {
      logReason('no-cli', join(root, 'absent-board'));
    } finally {
      process.stdout.write = orig;
    }
    assert.match(out, /no-cli/);
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

  describe('last message persistence (AISDLC-914)', () => {
    const line = (type, content) => JSON.stringify({ type, message: { role: type, content } });
    const transcriptOf = (...lines) => {
      const f = join(root, `t-${Math.random().toString(36).slice(2)}.jsonl`);
      writeFileSync(f, lines.join('\n') + '\n');
      return f;
    };
    const lastFile = () => join(root, '.claude', 'memory', 'LAST_MESSAGE.md');
    const roster = (names) =>
      writeFileSync(
        join(board, 'hierarchy.json'),
        JSON.stringify({
          sessions: names.map((n, i) => ({ name: n, paneId: `%${i + 1}`, role: 'planner' })),
        }),
      );
    const stop = (t, pane, extra = {}) =>
      runAutoClear(
        { transcript_path: t },
        { env: { ...env(), TMUX_PANE: pane, ...extra }, cwd: root, run: () => ({ status: 0 }) },
      );

    it('writes text blocks only, and replaces only its own section', () => {
      roster(['planner-a', 'dispatch-b']);
      stop(
        transcriptOf(
          line('user', 'hi'),
          line('assistant', [
            { type: 'thinking', thinking: 'SECRET' },
            { type: 'text', text: 'first A' },
            { type: 'tool_use', name: 'Bash', input: { command: 'TOOLCALL' } },
          ]),
          line('user', [{ type: 'tool_result', content: 'TOOLRESULT' }]),
          line('assistant', [{ type: 'text', text: 'final A' }]),
        ),
        '%1',
      );
      stop(transcriptOf(line('assistant', [{ type: 'text', text: 'final B' }])), '%2');
      stop(transcriptOf(line('assistant', [{ type: 'text', text: 'newer A' }])), '%1');
      const out = readFileSync(lastFile(), 'utf-8');
      assert.match(out, /## planner-a \(\d{4}-/);
      assert.match(out, /newer A/);
      assert.match(out, /## dispatch-b/);
      assert.match(out, /final B/);
      assert.doesNotMatch(out, /final A|SECRET|TOOLCALL|TOOLRESULT/);
    });

    it('excludes non-text blocks from the last turn', () => {
      roster(['planner-a']);
      stop(
        transcriptOf(
          line('assistant', [
            { type: 'thinking', thinking: 'THINK2' },
            { type: 'text', text: 'visible' },
            { type: 'tool_use', name: 'X', input: {} },
          ]),
        ),
        '%1',
      );
      const out = readFileSync(lastFile(), 'utf-8');
      assert.match(out, /visible/);
      assert.doesNotMatch(out, /THINK2|tool_use/);
    });

    const textT = () => transcriptOf(line('assistant', [{ type: 'text', text: 'x' }]));
    const reset = () => rmSync(join(root, '.claude'), { recursive: true, force: true });

    it('positive control: a normal Stop writes the file', () => {
      roster(['planner-a']);
      reset();
      stop(textT(), '%1');
      assert.equal(existsSync(lastFile()), true);
    });

    it('writes nothing off-roster', () => {
      roster(['planner-a']);
      reset();
      stop(textT(), '%9');
      assert.equal(existsSync(lastFile()), false);
    });

    it('writes nothing for a missing transcript', () => {
      roster(['planner-a']);
      reset();
      stop(join(root, 'missing.jsonl'), '%1');
      assert.equal(existsSync(lastFile()), false);
    });

    it('writes nothing when switched off', () => {
      roster(['planner-a']);
      reset();
      stop(textT(), '%1', { AI_SDLC_LAST_MESSAGE: 'off' });
      assert.equal(existsSync(lastFile()), false);
    });

    it('does not let a prefix-sharing session name collide', () => {
      roster(['planner-a', 'planner-ab']);
      reset();
      stop(transcriptOf(line('assistant', [{ type: 'text', text: 'AB one' }])), '%2');
      stop(transcriptOf(line('assistant', [{ type: 'text', text: 'A one' }])), '%1');
      stop(transcriptOf(line('assistant', [{ type: 'text', text: 'A two' }])), '%1');
      const out = readFileSync(lastFile(), 'utf-8');
      assert.match(out, /AB one/);
      assert.match(out, /A two/);
      assert.doesNotMatch(out, /A one/);
    });

    it('a reply with ## lines cannot orphan, truncate or spoof sections', () => {
      roster(['planner-a', 'dispatch-b']);
      reset();
      stop(transcriptOf(line('assistant', [{ type: 'text', text: 'B real' }])), '%2');
      const evil =
        'intro\n## Status\nok\n## dispatch-b (fake)\nforged\n## dispatch-b (2026-01-01T00:00:00.000Z)\nforged2\ntail';
      stop(transcriptOf(line('assistant', [{ type: 'text', text: evil }])), '%1');
      // rewrite by another session: planner-a section must survive intact
      stop(transcriptOf(line('assistant', [{ type: 'text', text: 'B newer' }])), '%2');
      const out = readFileSync(lastFile(), 'utf-8');
      assert.match(
        out,
        /intro\n### Status\nok\n### dispatch-b \(fake\)\nforged\n### dispatch-b \(2026[^\n]*\nforged2\ntail/,
      );
      assert.equal((out.match(/^## dispatch-b /gm) || []).length, 1);
      assert.equal((out.match(/^## planner-a /gm) || []).length, 1);
      assert.doesNotMatch(out, /B real/);
      assert.match(out, /B newer/);
    });
  });
});
