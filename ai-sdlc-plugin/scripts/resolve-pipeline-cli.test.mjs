/**
 * Tests for scripts/resolve-pipeline-cli.sh — AISDLC-272
 *
 * Simulates four install topologies and asserts the script either resolves
 * to the correct bin path or exits 1 with an actionable error message.
 *
 * Topologies under test:
 *   1. CLAUDE_PLUGIN_DIR set + node_modules present (happy path — marketplace)
 *   2. CLAUDE_PLUGIN_DIR set + node_modules missing (broken install → self-heal)
 *   3. CLAUDE_PLUGIN_DIR unset + CLAUDE_PLUGIN_ROOT set + node_modules present
 *   4. All env vars unset + $(pwd)/pipeline-cli/bin present (dogfood monorepo)
 *   5. All paths broken → exit 1 with actionable error
 *
 * Run with: node --test ai-sdlc-plugin/scripts/resolve-pipeline-cli.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'resolve-pipeline-cli.sh');
const PIPELINE_CLI_REL = 'node_modules/@ai-sdlc/pipeline-cli/bin';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a minimal fake pipeline-cli bin directory with a sentinel file
 * so `_is_usable` (ls cli-*.mjs) passes.
 */
function createFakePipelineBin(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cli-deps.mjs'), '#!/usr/bin/env node\n// fake cli-deps\n');
}

/**
 * Run resolve-pipeline-cli.sh with custom env and optional cwd.
 * Returns { stdout, stderr, exitCode }.
 */
function runScript(env = {}, cwd = tmpdir()) {
  const result = spawnSync('bash', [SCRIPT], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env,
    },
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
  });
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exitCode: result.status,
  };
}

// ── Test scaffolding ──────────────────────────────────────────────────────────

let tmpDir;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aisdlc-272-test-'));
});

after(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('resolve-pipeline-cli.sh script exists and is executable', () => {
  it('script file exists', () => {
    assert.ok(existsSync(SCRIPT), `${SCRIPT} must exist`);
  });

  it('script is executable', () => {
    try {
      execSync(`test -x "${SCRIPT}"`, { stdio: 'pipe' });
    } catch {
      assert.fail(`${SCRIPT} must be executable — run: chmod +x ${SCRIPT}`);
    }
  });
});

/**
 * Normalise path via realpath to handle macOS /var → /private/var symlink.
 * Falls back to the original string if realpath throws (non-existent path in assertions).
 */
function normPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

describe('Topology 1: CLAUDE_PLUGIN_DIR set + node_modules present (happy path)', () => {
  it('resolves to $CLAUDE_PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin', () => {
    const pluginDir = join(tmpDir, 'topology1-plugin');
    const expectedBin = join(pluginDir, PIPELINE_CLI_REL);
    createFakePipelineBin(expectedBin);

    const { stdout, exitCode } = runScript({ CLAUDE_PLUGIN_DIR: pluginDir });

    assert.equal(exitCode, 0, 'must exit 0 when CLAUDE_PLUGIN_DIR has bundled deps');
    assert.equal(normPath(stdout), normPath(expectedBin), 'must return the exact bin path');
  });
});

describe('Topology 2: CLAUDE_PLUGIN_DIR set but node_modules missing (broken install)', () => {
  it('exits 1 with actionable error when self-heal is not available', () => {
    // Create a plugin dir WITHOUT node_modules AND without install-runtime-deps.sh
    // so self-heal cannot fire. This simulates a broken install in a minimal env.
    const pluginDir = join(tmpDir, 'topology2-broken');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), '{}');
    // Ensure HOME doesn't point to a real cache with pipeline-cli.
    const fakeHome = join(tmpDir, 'topology2-home');
    mkdirSync(fakeHome, { recursive: true });
    // Use a non-existent cwd so dogfood fallback also fails.
    const fakeCwd = join(tmpDir, 'topology2-cwd');
    mkdirSync(fakeCwd, { recursive: true });

    const { exitCode, stderr } = runScript(
      {
        CLAUDE_PLUGIN_DIR: pluginDir,
        CLAUDE_PLUGIN_ROOT: '',
        HOME: fakeHome,
      },
      fakeCwd,
    );

    assert.equal(exitCode, 1, 'must exit 1 when all topologies fail');
    assert.match(stderr, /@ai-sdlc\/pipeline-cli/, 'error message must name the missing package');
  });
});

describe('Topology 3: CLAUDE_PLUGIN_DIR unset + CLAUDE_PLUGIN_ROOT set + deps present', () => {
  it('resolves via CLAUDE_PLUGIN_ROOT when CLAUDE_PLUGIN_DIR is unset', () => {
    const pluginRoot = join(tmpDir, 'topology3-plugin-root');
    const expectedBin = join(pluginRoot, PIPELINE_CLI_REL);
    createFakePipelineBin(expectedBin);

    const { stdout, exitCode } = runScript({
      CLAUDE_PLUGIN_DIR: '',
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      HOME: join(tmpDir, 'topology3-home'), // isolate cache probe
    });

    assert.equal(exitCode, 0, 'must exit 0 when CLAUDE_PLUGIN_ROOT has bundled deps');
    assert.equal(
      normPath(stdout),
      normPath(expectedBin),
      'must return path under CLAUDE_PLUGIN_ROOT',
    );
  });
});

describe('Topology 4: Dogfood monorepo — $(pwd)/pipeline-cli/bin present', () => {
  it('resolves via $(pwd)/pipeline-cli/bin when all env vars unset', () => {
    const monorepoRoot = join(tmpDir, 'topology4-monorepo');
    const expectedBin = join(monorepoRoot, 'pipeline-cli', 'bin');
    createFakePipelineBin(expectedBin);
    const fakeHome = join(tmpDir, 'topology4-home');
    mkdirSync(fakeHome, { recursive: true });

    const { stdout, exitCode } = runScript(
      {
        CLAUDE_PLUGIN_DIR: '',
        CLAUDE_PLUGIN_ROOT: '',
        HOME: fakeHome,
      },
      monorepoRoot,
    );

    assert.equal(exitCode, 0, 'must exit 0 when dogfood pipeline-cli/bin exists');
    // Normalise both paths via realpath to handle macOS /var → /private/var symlink.
    assert.equal(normPath(stdout), normPath(expectedBin), 'must return $(pwd)/pipeline-cli/bin');
  });
});

describe('Topology 5: All paths broken — exits 1 with actionable error', () => {
  it('exits 1 and names all fix options when nothing resolves', () => {
    const fakeHome = join(tmpDir, 'topology5-home');
    mkdirSync(fakeHome, { recursive: true });
    const fakeCwd = join(tmpDir, 'topology5-cwd');
    mkdirSync(fakeCwd, { recursive: true });

    const { exitCode, stderr } = runScript(
      {
        CLAUDE_PLUGIN_DIR: '',
        CLAUDE_PLUGIN_ROOT: '',
        HOME: fakeHome,
      },
      fakeCwd,
    );

    assert.equal(exitCode, 1, 'must exit 1 when all topologies fail');
    assert.match(stderr, /@ai-sdlc\/pipeline-cli/, 'must name the missing package');
    assert.match(stderr, /Fix options/, 'must list fix options');
    // The error should mention PIPELINE_CLI_BIN override (topology 6 fallback doc).
    assert.match(stderr, /PIPELINE_CLI_BIN/, 'must mention the PIPELINE_CLI_BIN override option');
  });
});

describe('Plugin cache probe — topology 4b', () => {
  it('resolves from ~/.claude/plugins/cache/<mp>/ai-sdlc/<version> when present', () => {
    const fakeHome = join(tmpDir, 'topology4b-home');
    const cacheDir = join(
      fakeHome,
      '.claude',
      'plugins',
      'cache',
      'test-marketplace',
      'ai-sdlc',
      '1.0.0',
    );
    const expectedBin = join(cacheDir, PIPELINE_CLI_REL);
    createFakePipelineBin(expectedBin);
    const fakeCwd = join(tmpDir, 'topology4b-cwd');
    mkdirSync(fakeCwd, { recursive: true });

    const { stdout, exitCode } = runScript(
      {
        CLAUDE_PLUGIN_DIR: '',
        CLAUDE_PLUGIN_ROOT: '',
        HOME: fakeHome,
      },
      fakeCwd,
    );

    assert.equal(exitCode, 0, 'must exit 0 when plugin cache has pipeline-cli');
    assert.equal(normPath(stdout), normPath(expectedBin), 'must return path from plugin cache');
  });
});
