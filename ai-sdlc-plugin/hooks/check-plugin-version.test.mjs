/**
 * Tests for ai-sdlc plugin version-check hook (AISDLC-89).
 *
 * Run with: node --test ai-sdlc-plugin/hooks/check-plugin-version.test.mjs
 *
 * Each test points the hook at a temp `CLAUDE_PLUGIN_ROOT` (so we control the
 * "installed" version) and a local http test server (via
 * `AI_SDLC_PLUGIN_MARKETPLACE_URL`) so the hook never touches the network.
 * `XDG_CACHE_HOME` is overridden per-test so cache state never leaks across
 * cases — the hook reads `~/.cache/...` via `os.homedir()`, so we override
 * `HOME` to our temp dir.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, 'check-plugin-version.js');

let server;
let serverUrl;
let serverHandler = () => ({ status: 200, body: '{"plugins":[{"version":"0.8.1"}]}' });

before(async () => {
  server = createServer((req, res) => {
    const result = serverHandler(req);
    res.statusCode = result.status;
    res.setHeader('content-type', 'application/json');
    res.end(result.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  serverUrl = `http://127.0.0.1:${addr.port}/marketplace.json`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

let tempRoot;
let tempHome;
beforeEach(() => {
  // Fresh CLAUDE_PLUGIN_ROOT (controls installed version) per test.
  tempRoot = join(tmpdir(), `aisdlc-89-root-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempRoot, '.claude-plugin'), { recursive: true });
  // Default: installed = 0.7.0 (older than test server's 0.8.1).
  writeFileSync(
    join(tempRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'ai-sdlc', version: '0.7.0' }, null, 2),
  );
  // Fresh HOME so cache state is isolated.
  tempHome = join(tmpdir(), `aisdlc-89-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempHome, { recursive: true });
  // Default: every test gets a healthy 0.8.1 server response.
  serverHandler = () => ({ status: 200, body: '{"plugins":[{"version":"0.8.1"}]}' });
});

function cleanup() {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  if (tempHome && existsSync(tempHome)) rmSync(tempHome, { recursive: true, force: true });
}

async function runHook({ env = {}, args = [], input = '{}' } = {}) {
  const child = execFile('node', [HOOK, ...args], {
    env: {
      // Inherit PATH but isolate cache + plugin root + marketplace URL.
      PATH: process.env.PATH,
      HOME: tempHome,
      CLAUDE_PLUGIN_ROOT: tempRoot,
      AI_SDLC_PLUGIN_MARKETPLACE_URL: serverUrl,
      ...env,
    },
    timeout: 5000,
  });
  if (input !== null) {
    child.stdin.end(input);
  } else {
    child.stdin.end();
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('check-plugin-version hook (AISDLC-89)', () => {
  it('AC#2: prints yellow banner on stderr when latest > installed', async () => {
    try {
      const { code, stderr, stdout } = await runHook();
      assert.equal(code, 0, 'hook must exit 0 even when stale');
      assert.match(stderr, /v0\.7\.0 installed, v0\.8\.1 available/);
      assert.match(stderr, /\/plugin update ai-sdlc/);
      // stdout must stay clean — Claude Code's hook protocol reserves stdout.
      assert.equal(stdout, '');
    } finally {
      cleanup();
    }
  });

  it('AC#1+staleness check: silent when installed >= latest (fresh)', async () => {
    try {
      // Bump installed to match latest.
      writeFileSync(
        join(tempRoot, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'ai-sdlc', version: '0.8.1' }, null, 2),
      );
      const { code, stderr, stdout } = await runHook();
      assert.equal(code, 0);
      assert.equal(stderr, '', 'no banner when up to date');
      assert.equal(stdout, '');
    } finally {
      cleanup();
    }
  });

  it('AC#3: cache hit skips network call (fresh cache, server set to 500)', async () => {
    try {
      // Pre-populate cache with a fresh entry pointing at 0.8.1.
      const cacheDir = join(tempHome, '.cache', 'ai-sdlc-plugin');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, 'version-check.json'),
        JSON.stringify({ checkedAt: new Date().toISOString(), latestVersion: '0.8.1' }),
      );
      // Server now errors — if the hook calls it, the test would still pass
      // (silent on failure) but we verify no error log was written, which
      // proves the cache short-circuited the fetch path.
      let serverHits = 0;
      serverHandler = () => {
        serverHits++;
        return { status: 500, body: '{}' };
      };
      const { code, stderr } = await runHook();
      assert.equal(code, 0);
      // Banner still fires from cached value (0.8.1 > 0.7.0).
      assert.match(stderr, /v0\.7\.0 installed, v0\.8\.1 available/);
      assert.equal(serverHits, 0, 'cache hit must not hit the network');
    } finally {
      cleanup();
    }
  });

  it('AC#4: silent on fetch failure (server returns 500)', async () => {
    try {
      serverHandler = () => ({ status: 500, body: 'gateway timeout' });
      const { code, stderr, stdout } = await runHook();
      assert.equal(code, 0, 'must not block SessionStart on fetch failure');
      assert.equal(stderr, '', 'must NOT spam stderr on fetch failure');
      assert.equal(stdout, '');
    } finally {
      cleanup();
    }
  });

  it('AC#4: silent on malformed marketplace JSON', async () => {
    try {
      serverHandler = () => ({ status: 200, body: '{not valid json' });
      const { code, stderr } = await runHook();
      assert.equal(code, 0);
      assert.equal(stderr, '');
    } finally {
      cleanup();
    }
  });

  it('AC#5: AI_SDLC_DISABLE_VERSION_CHECK=1 short-circuits, no fetch', async () => {
    try {
      let serverHits = 0;
      serverHandler = () => {
        serverHits++;
        return { status: 200, body: '{"plugins":[{"version":"99.0.0"}]}' };
      };
      const { code, stderr, stdout } = await runHook({
        env: { AI_SDLC_DISABLE_VERSION_CHECK: '1' },
      });
      assert.equal(code, 0);
      assert.equal(stderr, '', 'opt-out must not nag even when massively stale');
      assert.equal(stdout, '');
      assert.equal(serverHits, 0, 'opt-out must not hit the network');
    } finally {
      cleanup();
    }
  });

  it('AC#6: --print mode bypasses cache + emits structured status to stdout', async () => {
    try {
      // Stuff cache with a STALE-marked entry (latestVersion: 0.7.0). If
      // --print honors cache, we'd see "up to date". Instead it should
      // re-fetch and report 0.8.1 stale.
      const cacheDir = join(tempHome, '.cache', 'ai-sdlc-plugin');
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        join(cacheDir, 'version-check.json'),
        JSON.stringify({ checkedAt: new Date().toISOString(), latestVersion: '0.7.0' }),
      );
      const { code, stdout, stderr } = await runHook({ args: ['--print'] });
      assert.equal(code, 0);
      assert.equal(stderr, '', 'print mode must not write to stderr');
      assert.match(stdout, /Installed: v0\.7\.0/);
      assert.match(stdout, /Latest: v0\.8\.1/);
      assert.match(stdout, /Status: ⚠ stale/);
      // And the cache should have been refreshed to 0.8.1.
      const refreshed = JSON.parse(readFileSync(join(cacheDir, 'version-check.json'), 'utf-8'));
      assert.equal(refreshed.latestVersion, '0.8.1');
    } finally {
      cleanup();
    }
  });

  it('--print: opt-out env var prints disabled message + does not fetch', async () => {
    try {
      let serverHits = 0;
      serverHandler = () => {
        serverHits++;
        return { status: 200, body: '{"plugins":[{"version":"0.8.1"}]}' };
      };
      const { code, stdout } = await runHook({
        args: ['--print'],
        env: { AI_SDLC_DISABLE_VERSION_CHECK: '1' },
      });
      assert.equal(code, 0);
      assert.match(stdout, /disabled/);
      assert.equal(serverHits, 0);
    } finally {
      cleanup();
    }
  });

  it('cache write: fetch refreshes the cache file with checkedAt + latestVersion', async () => {
    try {
      const { code } = await runHook();
      assert.equal(code, 0);
      const cacheFile = join(tempHome, '.cache', 'ai-sdlc-plugin', 'version-check.json');
      assert.ok(existsSync(cacheFile), 'cache file should exist after fetch');
      const parsed = JSON.parse(readFileSync(cacheFile, 'utf-8'));
      assert.equal(parsed.latestVersion, '0.8.1');
      assert.match(parsed.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      cleanup();
    }
  });

  it('stale cache (>24h) triggers re-fetch', async () => {
    try {
      // Cache 25h old pointing at outdated value.
      const cacheDir = join(tempHome, '.cache', 'ai-sdlc-plugin');
      mkdirSync(cacheDir, { recursive: true });
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        join(cacheDir, 'version-check.json'),
        JSON.stringify({ checkedAt: stale, latestVersion: '0.6.0' }),
      );
      let serverHits = 0;
      serverHandler = () => {
        serverHits++;
        return { status: 200, body: '{"plugins":[{"version":"0.8.1"}]}' };
      };
      const { code, stderr } = await runHook();
      assert.equal(code, 0);
      assert.equal(serverHits, 1, 'stale cache must trigger one fetch');
      assert.match(stderr, /v0\.8\.1 available/);
    } finally {
      cleanup();
    }
  });
});
