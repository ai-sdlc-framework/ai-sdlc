/**
 * Tests for the usage-ingest hook (Stop + SessionStart).
 *
 * Run with: node --test ai-sdlc-plugin/hooks/usage-ingest.test.mjs
 *
 * Every test uses temp directories for HOME, the usage dir and the Claude config
 * dir, so nothing reads or writes the real home directory.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  cpSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK_JS = join(here, 'usage-ingest.js');
const HOOK_SH = join(here, 'usage-ingest.sh');
const PLUGIN_JSON = join(here, '..', 'plugin.json');
const REAL_BIN_DIR = join(here, '..', '..', 'pipeline-cli', 'bin');
const REAL_DIST = join(here, '..', '..', 'pipeline-cli', 'dist', 'cli', 'usage.js');

const pluginJson = JSON.parse(readFileSync(PLUGIN_JSON, 'utf-8'));
const hookTimeoutMs = () => {
  const entry = pluginJson.hooks.Stop.flatMap((g) => g.hooks).find((h) =>
    h.command.includes('usage-ingest.sh'),
  );
  return entry.timeout * 1000;
};

let root;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'usage-ingest-hook-'));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
});

function sandbox(name) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'home'), { recursive: true });
  mkdirSync(join(dir, 'usage'), { recursive: true });
  return {
    dir,
    env: {
      PATH: process.env.PATH,
      HOME: join(dir, 'home'),
      AI_SDLC_USAGE_DIR: join(dir, 'usage'),
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    },
  };
}

/** A fake pipeline-cli bin dir whose cli-usage.mjs runs `body`. */
function fakeBin(dir, body) {
  const bin = join(dir, 'fakebin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'cli-usage.mjs'), body);
  return bin;
}

function runHook(script, env) {
  const started = Date.now();
  const res = spawnSync(script === HOOK_SH ? 'bash' : process.execPath, [script], {
    env,
    input: '{"hook_event_name":"Stop"}',
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return { status: res.status, ms: Date.now() - started, stdout: res.stdout, stderr: res.stderr };
}

async function waitFor(path, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('plugin.json registration', () => {
  it('registers the hook, non-blocking with a short timeout, for Stop and SessionStart', () => {
    for (const event of ['Stop', 'SessionStart']) {
      const entries = pluginJson.hooks[event].flatMap((g) => g.hooks);
      const entry = entries.find((h) => h.command.includes('usage-ingest.sh'));
      assert.ok(entry, `${event} has the hook`);
      assert.equal(entry.async, true);
      assert.ok(entry.timeout > 0 && entry.timeout <= 5);
      assert.ok(existsSync(HOOK_SH));
    }
  });
});

describe('usage-ingest hook', () => {
  it('launches the ingester detached with a time limit and returns without waiting', async () => {
    const { dir, env } = sandbox('detached');
    const marker = join(dir, 'ran.txt');
    const bin = fakeBin(
      dir,
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' '));
await new Promise((r) => setTimeout(r, 4000));`,
    );
    const res = runHook(HOOK_JS, { ...env, PIPELINE_CLI_BIN: bin });
    assert.equal(res.status, 0);
    assert.ok(res.ms < 2500, `hook took ${res.ms}ms`);
    assert.equal(res.stdout, '');
    assert.ok(await waitFor(marker), 'ingester was launched');
    assert.match(readFileSync(marker, 'utf-8'), /^ingest --max-seconds \d+$/);
  });

  it('works through the shell wrapper too', async () => {
    const { dir, env } = sandbox('wrapper');
    const marker = join(dir, 'ran.txt');
    const bin = fakeBin(
      dir,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');`,
    );
    const res = runHook(HOOK_SH, { ...env, PIPELINE_CLI_BIN: bin });
    assert.equal(res.status, 0);
    assert.ok(await waitFor(marker));
  });

  it('exits 0 and starts nothing when no ingester is installed', () => {
    const { env } = sandbox('missing');
    const res = runHook(HOOK_JS, { ...env, CLAUDE_PLUGIN_ROOT: join(root, 'no-such-plugin') });
    assert.equal(res.status, 0);
  });

  it('exits 0 when the ingester fails', async () => {
    const { dir, env } = sandbox('failing');
    const marker = join(dir, 'ran.txt');
    const bin = fakeBin(
      dir,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); throw new Error('boom');`,
    );
    const res = runHook(HOOK_JS, { ...env, PIPELINE_CLI_BIN: bin });
    assert.equal(res.status, 0);
    assert.equal(res.stderr, '');
    assert.ok(await waitFor(marker));
  });

  it('exits 0 when the launch itself cannot happen (bin path is a directory)', () => {
    const { dir, env } = sandbox('unlaunchable');
    const bin = join(dir, 'dirbin');
    mkdirSync(join(bin, 'cli-usage.mjs'), { recursive: true });
    const res = runHook(HOOK_JS, { ...env, PIPELINE_CLI_BIN: bin });
    assert.equal(res.status, 0);
  });

  for (const [label, extra] of [
    ['CLAUDE_CODE_ENV=ccr', { CLAUDE_CODE_ENV: 'ccr' }],
    ['CLAUDE_REMOTE_EXECUTION=1', { CLAUDE_REMOTE_EXECUTION: '1' }],
    ['AI_SDLC_USAGE_INGEST=off', { AI_SDLC_USAGE_INGEST: 'off' }],
  ]) {
    it(`does not launch when ${label}`, async () => {
      const { dir, env } = sandbox(`skip-${label.replace(/\W/g, '')}`);
      const marker = join(dir, 'ran.txt');
      const bin = fakeBin(
        dir,
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');`,
      );
      const res = runHook(HOOK_JS, { ...env, ...extra, PIPELINE_CLI_BIN: bin });
      assert.equal(res.status, 0);
      assert.equal(await waitFor(marker, 800), false);
    });
  }

  it('launches at most once per debounce window', async () => {
    const { dir, env } = sandbox('debounce');
    const marker = join(dir, 'count.txt');
    const bin = fakeBin(
      dir,
      `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'x');`,
    );
    runHook(HOOK_JS, { ...env, PIPELINE_CLI_BIN: bin });
    assert.ok(await waitFor(marker));
    runHook(HOOK_JS, { ...env, PIPELINE_CLI_BIN: bin });
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(readFileSync(marker, 'utf-8'), 'x');
  });

  it(
    'returns within the hook time limit on 500 synthetic transcripts and the real ingester then fills the ledger',
    { skip: !existsSync(REAL_DIST) && 'pipeline-cli is not built' },
    async () => {
      const { dir, env } = sandbox('five-hundred');
      const projects = join(dir, 'claude', 'projects');
      for (let i = 0; i < 500; i++) {
        const p = join(projects, `proj${i % 20}`);
        mkdirSync(p, { recursive: true });
        writeFileSync(
          join(p, `sess${i}.jsonl`),
          `${JSON.stringify({
            type: 'assistant',
            timestamp: '2026-09-02T10:00:00Z',
            sessionId: `sess${i}`,
            cwd: join(dir, 'elsewhere'),
            message: {
              id: `msg-${i}`,
              model: 'claude-x',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          })}\n`,
        );
      }
      const res = runHook(HOOK_JS, { ...env, PIPELINE_CLI_BIN: REAL_BIN_DIR });
      assert.equal(res.status, 0);
      assert.ok(res.ms < hookTimeoutMs(), `hook took ${res.ms}ms, limit ${hookTimeoutMs()}ms`);
      const ledgerDir = env.AI_SDLC_USAGE_DIR;
      const end = Date.now() + 20_000;
      let lines = 0;
      while (Date.now() < end && lines < 500) {
        await new Promise((r) => setTimeout(r, 200));
        const f =
          existsSync(ledgerDir) && readdirSync(ledgerDir).find((n) => n.startsWith('ledger-'));
        lines = f
          ? readFileSync(join(ledgerDir, f), 'utf-8').split('\n').filter(Boolean).length
          : 0;
      }
      assert.equal(lines, 500);
    },
  );
});

const CANARY = 'SENTINEL-CANARY-BODY-TEXT';

function plantTranscripts(dir, n) {
  const projects = join(dir, 'claude', 'projects');
  for (let i = 0; i < n; i++) {
    const p = join(projects, `proj${i % 20}`);
    mkdirSync(p, { recursive: true });
    writeFileSync(
      join(p, `sess${i}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-02T10:00:00Z',
        sessionId: `sess${i}`,
        cwd: join(dir, 'elsewhere'),
        message: {
          id: `msg-${i}`,
          model: 'claude-x',
          content: [{ type: 'text', text: CANARY }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n`,
    );
  }
}

describe('hook time limit on 500 synthetic transcripts (stub ingester, always runs)', () => {
  it('returns promptly without waiting for a slow ingester', async () => {
    const { dir, env } = sandbox('stub-slow');
    plantTranscripts(dir, 500);
    const marker = join(dir, 'ran.txt');
    const bin = fakeBin(
      dir,
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'x');
await new Promise((r) => setTimeout(r, 6000));`,
    );
    const res = runHook(HOOK_JS, { ...env, PIPELINE_CLI_BIN: bin });
    assert.equal(res.status, 0);
    assert.ok(res.ms < hookTimeoutMs(), `hook took ${res.ms}ms, limit ${hookTimeoutMs()}ms`);
    assert.ok(res.ms < 2500, `hook waited for the ingester: ${res.ms}ms`);
    assert.equal(res.stdout + res.stderr, '');
    assert.ok(await waitFor(marker), 'ingester was started');
  });

  it('exits 0 when the stub ingester fails, and when none is installed', () => {
    const { dir, env } = sandbox('stub-failing');
    plantTranscripts(dir, 500);
    const bin = fakeBin(dir, `process.exit(3);`);
    const failing = runHook(HOOK_JS, { ...env, PIPELINE_CLI_BIN: bin });
    assert.equal(failing.status, 0);
    assert.equal(failing.stdout + failing.stderr, '');
    const missing = sandbox('stub-missing');
    plantTranscripts(missing.dir, 500);
    const none = runHook(HOOK_SH, { ...missing.env, PIPELINE_CLI_BIN: join(missing.dir, 'nope') });
    assert.equal(none.status, 0);
    assert.ok(none.ms < hookTimeoutMs());
    assert.equal(none.stdout + none.stderr, '');
  });
});

describe('hook never runs code from the project being worked on', () => {
  /** A copy of the hook in a temp plugin dir with no trusted ingester beside it. */
  function isolatedPlugin(dir) {
    const hooks = join(dir, 'plugin', 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const f of ['usage-ingest.js', 'usage-ingest.sh']) cpSync(join(here, f), join(hooks, f));
    return hooks;
  }

  function plantInProject(dir, marker) {
    const project = join(dir, 'project');
    mkdirSync(join(project, 'pipeline-cli', 'bin'), { recursive: true });
    writeFileSync(
      join(project, 'pipeline-cli', 'bin', 'cli-usage.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, process.cwd());`,
    );
    return project;
  }

  for (const script of ['usage-ingest.js', 'usage-ingest.sh']) {
    const runner = script.endsWith('.sh') ? 'bash' : process.execPath;

    it(`never launches a cwd-planted cli-usage.mjs (${script}) when no trusted candidate exists`, async () => {
      const { dir, env } = sandbox(`planted-${script}`);
      const marker = join(dir, 'planted-ran.txt');
      const project = plantInProject(dir, marker);
      const hooks = isolatedPlugin(dir);
      const res = spawnSync(runner, [join(hooks, script)], {
        cwd: project,
        env: { ...env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: join(dir, 'plugin') },
        input: '{}',
        encoding: 'utf-8',
        timeout: 15_000,
      });
      assert.equal(res.status, 0);
      assert.equal(await waitFor(marker, 1200), false, 'planted ingester must never run');
    });

    it(`launches a trusted candidate (${script}) with a neutral working directory`, async () => {
      const { dir, env } = sandbox(`trusted-${script}`);
      const marker = join(dir, 'trusted-ran.txt');
      const project = plantInProject(dir, join(dir, 'planted-ran.txt'));
      const hooks = isolatedPlugin(dir);
      const bin = fakeBin(
        dir,
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, process.cwd());`,
      );
      const res = spawnSync(runner, [join(hooks, script)], {
        cwd: project,
        env: { ...env, PIPELINE_CLI_BIN: bin },
        input: '{}',
        encoding: 'utf-8',
        timeout: 15_000,
      });
      assert.equal(res.status, 0);
      assert.ok(await waitFor(marker), 'trusted ingester launched');
      assert.notEqual(readFileSync(marker, 'utf-8'), project);
      assert.equal(existsSync(join(dir, 'planted-ran.txt')), false);
    });
  }

  it('launches the plugin-local node_modules candidate', async () => {
    const { dir, env } = sandbox('plugin-local');
    const marker = join(dir, 'local-ran.txt');
    const hooks = isolatedPlugin(dir);
    const binDir = join(dir, 'plugin', 'node_modules', '@ai-sdlc', 'pipeline-cli', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'cli-usage.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x');`,
    );
    const res = spawnSync(process.execPath, [join(hooks, 'usage-ingest.js')], {
      env,
      input: '{}',
      encoding: 'utf-8',
    });
    assert.equal(res.status, 0);
    assert.ok(await waitFor(marker));
  });
});
