/**
 * Hermetic tests for contrib/runners/opencode/runner.mjs.
 *
 * A fake `opencode` executable (a node script in a temp dir, pointed at via
 * OPENCODE_BIN) stands in for the real binary — no network, no model. The
 * runner is exercised as a real subprocess against a throwaway git repo, so
 * the assertions cover the actual CLI contract: argv shape, `--session`
 * resume on retry, constraint enforcement, and the result JSON on stdout.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'runner.mjs');

const FAKE_OPENCODE = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const st = process.env.FAKE_STATE;
const calls = path.join(st, 'calls.jsonl');
fs.appendFileSync(calls, JSON.stringify({ argv, cwd: process.cwd(), cfg: process.env.OPENCODE_CONFIG_CONTENT }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (argv[0] === 'session') {
  out({ info: { tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2 } } } });
  process.exit(0);
}
const runs = fs.readFileSync(calls, 'utf-8').split('\\n').filter(Boolean).map(JSON.parse).filter((c) => c.argv[0] === 'run').length;
const mode = process.env.FAKE_MODE || 'ok';
const write = (rel) => {
  fs.mkdirSync(path.dirname(path.join(process.cwd(), rel)), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), rel), 'x\\n');
};
const finish = (text) => {
  out({ type: 'text', sessionID: 'ses_1', part: { text } });
  out({ type: 'step_finish', sessionID: 'ses_1', part: { tokens: { input: 1, output: 1 } } });
};
if (mode === 'ok') { write('src/a.txt'); finish('all done'); process.exit(0); }
if (mode === 'retry') {
  if (runs === 1) { out({ type: 'step_start', sessionID: 'ses_1' }); process.stderr.write('socket dropped'); process.exit(1); }
  write('src/a.txt'); finish('recovered'); process.exit(0);
}
if (mode === 'always-fail') { out({ type: 'step_start', sessionID: 'ses_1' }); process.stderr.write('boom'); process.exit(1); }
if (mode === 'stream-error') { out({ type: 'error', sessionID: 'ses_1', error: { message: 'LM Studio socket drop' } }); process.exit(0); }
if (mode === 'blocked') { write('.github/workflows/x.yml'); finish('done'); process.exit(0); }
if (mode === 'many') { write('a.txt'); write('b.txt'); write('c.txt'); finish('done'); process.exit(0); }
if (mode === 'noop') { finish('nothing to do'); process.exit(0); }
process.exit(2);
`;

let root;
let binPath;
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
};

before(() => {
  root = mkdtempSync(join(tmpdir(), 'opencode-runner-test-'));
  binPath = join(root, 'bin', 'opencode');
  mkdirSync(dirname(binPath), { recursive: true });
  writeFileSync(binPath, FAKE_OPENCODE);
  chmodSync(binPath, 0o755);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRepo(name, projectConfig) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: repo, env: { ...process.env, ...GIT_ENV } });
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  if (projectConfig) writeFileSync(join(repo, 'opencode.json'), JSON.stringify(projectConfig));
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const state = join(root, `${name}-state`);
  mkdirSync(state, { recursive: true });
  return { repo, state, git };
}

function runRunner({ repo, state }, extraArgs, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        RUNNER,
        '--workdir',
        repo,
        '--issue',
        '42',
        '--title',
        'Add search',
        '--body',
        'body text',
        ...extraArgs,
      ],
      {
        env: {
          ...process.env,
          ...GIT_ENV,
          OPENCODE_BIN: binPath,
          OPENCODE_MODEL: undefined,
          AI_SDLC_MODEL: undefined,
          FAKE_STATE: state,
          ...env,
        },
      },
      (err, stdout, stderr) => {
        let result;
        try {
          result = JSON.parse(stdout.trim().split('\n').pop());
        } catch {
          result = undefined;
        }
        resolve({ code: err ? err.code : 0, result, stdout, stderr });
      },
    );
  });
}

function readCalls(state) {
  return readFileSync(join(state, 'calls.jsonl'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

const MODEL = ['--model', 'lmstudio/qwen/qwen3.8-27b'];

test('success: result JSON, argv contract, commit, export tokens', async () => {
  const ctx = makeRepo('ok');
  const { code, result } = await runRunner(ctx, MODEL, { FAKE_MODE: 'ok' });
  assert.equal(code, 0);
  assert.equal(result.success, true);
  assert.equal(result.sessionID, 'ses_1');
  assert.deepEqual(result.filesChanged, ['src/a.txt']);
  assert.equal(result.attempts, 1);
  assert.equal(result.summary, 'all done');
  assert.deepEqual(result.tokenUsage, { inputTokens: 10, outputTokens: 6, cacheReadTokens: 2 });

  const head = ctx.git('rev-parse', 'HEAD').toString().trim();
  assert.equal(result.commitSha, head);
  const msg = ctx.git('log', '-1', '--format=%B').toString();
  assert.match(msg, /Co-Authored-By: ai-sdlc/);

  const run = readCalls(ctx.state).find((c) => c.argv[0] === 'run');
  assert.deepEqual(run.argv.slice(0, 7), [
    'run',
    '--standalone',
    '--auto',
    '--format',
    'json',
    '--model',
    'lmstudio/qwen/qwen3.8-27b',
  ]);
  // `--` precedes the positional prompt, which is the LAST argv entry.
  assert.equal(run.argv[run.argv.length - 2], '--');
  assert.match(run.argv[run.argv.length - 1], /You are fixing issue #42: Add search/);
  assert.ok(!run.argv.includes('--session'));
});

test('retry: second attempt resumes the captured session with --session', async () => {
  const ctx = makeRepo('retry');
  const { code, result } = await runRunner(ctx, [...MODEL, '--retries', '1'], {
    FAKE_MODE: 'retry',
  });
  assert.equal(code, 0);
  assert.equal(result.success, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.summary, 'recovered');
  const runs = readCalls(ctx.state).filter((c) => c.argv[0] === 'run');
  assert.equal(runs.length, 2);
  assert.ok(!runs[0].argv.includes('--session'));
  const i = runs[1].argv.indexOf('--session');
  assert.ok(i > -1, 'retry must pass --session');
  assert.equal(runs[1].argv[i + 1], 'ses_1');
  assert.match(
    runs[1].argv[runs[1].argv.length - 1],
    /previous attempt ended in a transport failure/,
  );
});

test('retries exhausted: exit 1, success false, attempts counted', async () => {
  const ctx = makeRepo('exhausted');
  const { code, result } = await runRunner(ctx, [...MODEL, '--retries', '1'], {
    FAKE_MODE: 'always-fail',
  });
  assert.equal(code, 1);
  assert.equal(result.success, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.sessionID, 'ses_1');
  assert.deepEqual(result.filesChanged, []);
  assert.match(result.error, /opencode exited with code 1/);
});

test('no retries configured: a failing run fails after one attempt', async () => {
  const ctx = makeRepo('noretry');
  const { code, result } = await runRunner(ctx, MODEL, { FAKE_MODE: 'always-fail' });
  assert.equal(code, 1);
  assert.equal(result.attempts, 1);
});

test('exit 0 + stream error + no text is a failure (and a retry trigger)', async () => {
  const ctx = makeRepo('streamerr');
  const { code, result } = await runRunner(ctx, [...MODEL, '--retries', '1'], {
    FAKE_MODE: 'stream-error',
  });
  assert.equal(code, 1);
  assert.equal(result.success, false);
  assert.equal(result.attempts, 2);
  assert.match(result.error, /stream error: LM Studio socket drop/);
});

test('fails loudly when no model is resolvable', async () => {
  const ctx = makeRepo('nomodel');
  const { code, result } = await runRunner(ctx, [], { FAKE_MODE: 'ok' });
  assert.equal(code, 1);
  assert.equal(result.success, false);
  assert.equal(result.attempts, 0);
  assert.match(result.error, /No model/);
});

test('model from OPENCODE_MODEL; bare id gets an anthropic/ prefix', async () => {
  const ctx = makeRepo('envmodel');
  const { result } = await runRunner(ctx, [], { FAKE_MODE: 'ok', OPENCODE_MODEL: 'claude-x' });
  assert.equal(result.success, true);
  const run = readCalls(ctx.state).find((c) => c.argv[0] === 'run');
  assert.equal(run.argv[run.argv.indexOf('--model') + 1], 'anthropic/claude-x');
});

test('no changes: reported as failure without a commit', async () => {
  const ctx = makeRepo('noop');
  const before = ctx.git('rev-parse', 'HEAD').toString().trim();
  const { code, result } = await runRunner(ctx, MODEL, { FAKE_MODE: 'noop' });
  assert.equal(code, 1);
  assert.equal(result.summary, 'Agent made no changes');
  assert.equal(ctx.git('rev-parse', 'HEAD').toString().trim(), before);
});

test('--blocked-paths is ENFORCED before commit', async () => {
  const ctx = makeRepo('blocked');
  const before = ctx.git('rev-parse', 'HEAD').toString().trim();
  const { code, result } = await runRunner(
    ctx,
    [...MODEL, '--blocked-paths', '.github/workflows/**,.ai-sdlc/**'],
    {
      FAKE_MODE: 'blocked',
    },
  );
  assert.equal(code, 1);
  assert.equal(result.success, false);
  assert.match(result.error, /blocked paths modified/);
  assert.match(result.error, /\.github\/workflows\/x\.yml/);
  assert.equal(ctx.git('rev-parse', 'HEAD').toString().trim(), before, 'nothing committed');
  assert.ok(existsSync(join(ctx.repo, '.github/workflows/x.yml')), 'changes left for the operator');
});

test('--max-files is ENFORCED before commit', async () => {
  const ctx = makeRepo('maxfiles');
  const before = ctx.git('rev-parse', 'HEAD').toString().trim();
  const { code, result } = await runRunner(ctx, [...MODEL, '--max-files', '2'], {
    FAKE_MODE: 'many',
  });
  assert.equal(code, 1);
  assert.match(result.error, /3 files changed, exceeding --max-files 2/);
  assert.equal(ctx.git('rev-parse', 'HEAD').toString().trim(), before);
});

test('dispatch config: non-script MCP servers survive untouched; existing scripts re-anchor', async () => {
  const ctx = makeRepo('mcp', {
    mcp: {
      npx: { type: 'local', command: ['npx', 'some-pkg'] },
      scoped: { type: 'local', command: ['npx', '-y', '@scope/pkg', '--flag=a/b', 'owner/repo'] },
      uvx: { type: 'local', command: ['uvx', 'server'] },
      ghost: { type: 'local', command: ['node', 'nope/dist/bin.js'] },
    },
  });
  const { result } = await runRunner(ctx, MODEL, { FAKE_MODE: 'ok' });
  assert.equal(result.success, true);
  const cfg = JSON.parse(readCalls(ctx.state).find((c) => c.argv[0] === 'run').cfg);
  assert.equal(cfg.autoupdate, false);
  assert.equal(cfg.snapshot, false);
  assert.deepEqual(cfg.mcp.npx.command, ['npx', 'some-pkg']);
  assert.deepEqual(cfg.mcp.scoped.command, ['npx', '-y', '@scope/pkg', '--flag=a/b', 'owner/repo']);
  assert.deepEqual(cfg.mcp.uvx.command, ['uvx', 'server']);
  assert.ok(!('ghost' in cfg.mcp), 'unbuilt script entry dropped');
});
