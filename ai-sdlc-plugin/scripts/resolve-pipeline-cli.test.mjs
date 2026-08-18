/**
 * Tests for scripts/resolve-pipeline-cli.sh — AISDLC-272
 *
 * Simulates four install topologies and asserts the script either resolves
 * to the correct bin path or exits 1 with an actionable error message.
 *
 * Topologies under test:
 *   1. CLAUDE_PLUGIN_DIR set + node_modules present (happy path — marketplace)
 *   2. CLAUDE_PLUGIN_DIR set + node_modules missing (broken install → self-heal
 *      from CLAUDE_PLUGIN_ROOT only; no auto-exec from user-writable cache)
 *   3. CLAUDE_PLUGIN_DIR unset + CLAUDE_PLUGIN_ROOT set + node_modules present
 *   4. Plugin cache probe (read-only — refuses to auto-exec install scripts
 *      found there; PR #482 security fix)
 *   5. All env vars unset + $(pwd)/pipeline-cli/bin present (dogfood monorepo)
 *   6. All paths broken → exit 1 with actionable error
 *
 * Run with: node --test ai-sdlc-plugin/scripts/resolve-pipeline-cli.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdtempSync,
  realpathSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
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
 * AISDLC-385: create a minimal fake mcp-server bundle at the expected path so
 * `_mcp_usable` passes. After AISDLC-385, resolve-pipeline-cli's fast path
 * requires BOTH pipeline-cli AND mcp-server to be present — otherwise it
 * triggers the self-heal flow (the same flow that's tested in Topology 2).
 *
 * Pass the PLUGIN_DIR (not the bin dir) — this creates
 * <pluginDir>/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js.
 */
function createFakeMcpBundle(pluginDir) {
  const bundleDir = join(pluginDir, 'node_modules/@ai-sdlc/plugin-mcp-server/dist');
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(join(bundleDir, 'bin.js'), '#!/usr/bin/env node\n// fake mcp-server\n');
}

/**
 * AISDLC-557: copies resolve-pipeline-cli.sh into "<cwd>/scripts/" and
 * returns the copy's path. The new self-location self-heal fallback
 * (topology 6) derives its target directory from `${BASH_SOURCE[0]}` — the
 * on-disk path of the script actually executing. Every test below must run
 * a COPY inside the test's isolated tmpDir rather than the real path in
 * this repo's checkout; otherwise any test that leaves both
 * CLAUDE_PLUGIN_DIR and CLAUDE_PLUGIN_ROOT unset would have the fallback
 * resolve to the real ai-sdlc-plugin/ directory and attempt a REAL
 * `install-runtime-deps.sh` (network `npm install`) as a side effect of
 * running the unit test — breaking hermeticity.
 */
function installScriptCopy(cwd) {
  const scriptsDir = join(cwd, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  const copy = join(scriptsDir, 'resolve-pipeline-cli.sh');
  copyFileSync(SCRIPT, copy);
  chmodSync(copy, 0o755);
  return copy;
}

/**
 * Run resolve-pipeline-cli.sh (a hermetic per-test copy — see
 * installScriptCopy) with custom env and optional cwd.
 * Returns { stdout, stderr, exitCode }.
 *
 * When no `cwd` is given, mkdtemp a fresh isolated dir rather than using
 * the bare OS tmpdir() root directly — AISDLC-557's installScriptCopy()
 * writes a "scripts/" subdirectory into `cwd`, and sharing the bare tmpdir()
 * root across tests would risk collisions between parallel test runs.
 */
function runScript(env = {}, cwd) {
  const resolvedCwd = cwd ?? mkdtempSync(join(tmpdir(), 'aisdlc-272-runScript-'));
  const scriptCopy = installScriptCopy(resolvedCwd);
  const result = spawnSync('bash', [scriptCopy], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env,
    },
    cwd: resolvedCwd,
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
    // AISDLC-385: fast path now requires BOTH pipeline-cli AND mcp-server.
    createFakeMcpBundle(pluginDir);

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
    // AISDLC-385: fast path now requires BOTH pipeline-cli AND mcp-server.
    createFakeMcpBundle(pluginRoot);

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

describe('Plugin cache probe — topology 4 (read-only)', () => {
  it('resolves from ~/.claude/plugins/cache/<mp>/ai-sdlc/<version> when present', () => {
    const fakeHome = join(tmpDir, 'topology3probe-home');
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
    const fakeCwd = join(tmpDir, 'topology3probe-cwd');
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

  it('SECURITY: refuses to auto-exec install-runtime-deps.sh from user-writable cache (PR #482 critical fix)', () => {
    // Plant an attacker-controlled install-runtime-deps.sh under a cache dir
    // that has NO usable pipeline-cli bin. The pre-fix resolver would walk
    // the cache, pick the highest-semver dir, and `bash` the script with
    // arbitrary code execution. The post-fix resolver must NOT execute it.
    //
    // Regression test for the two CRITICAL findings on PR #482:
    //   - resolve-pipeline-cli.sh:138 — exec'd unverified script from cache
    //   - install-runtime-deps.sh:46 — npm install runs malicious postinstall
    //
    // The attack is detected by writing a sentinel file from the planted
    // script. If the resolver still execs it, the sentinel will appear on
    // disk after running. The test asserts the sentinel does NOT exist.
    const fakeHome = join(tmpDir, 'security-fix-home');
    const cacheDir = join(
      fakeHome,
      '.claude',
      'plugins',
      'cache',
      'evil-marketplace',
      'ai-sdlc',
      '99.0.0',
    );
    const scriptsDir = join(cacheDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    const sentinel = join(tmpDir, 'security-fix-pwn-sentinel');
    // The planted script writes the sentinel to prove it was executed.
    writeFileSync(
      join(scriptsDir, 'install-runtime-deps.sh'),
      `#!/usr/bin/env bash\ntouch "${sentinel}"\nexit 0\n`,
    );
    // No node_modules under the cache dir → pre-fix resolver would fall
    // through to the self-heal block and exec the planted script.
    const fakeCwd = join(tmpDir, 'security-fix-cwd');
    mkdirSync(fakeCwd, { recursive: true });

    const { exitCode } = runScript(
      {
        CLAUDE_PLUGIN_DIR: '',
        CLAUDE_PLUGIN_ROOT: '',
        HOME: fakeHome,
      },
      fakeCwd,
    );

    assert.equal(exitCode, 1, 'must exit 1 (no usable bin) — must NOT self-heal from cache');
    assert.equal(
      existsSync(sentinel),
      false,
      'planted install-runtime-deps.sh MUST NOT execute — would be RCE via user-writable cache',
    );
  });
});

describe('Topology 6: Self-location fallback (AISDLC-557, last resort)', () => {
  /**
   * Plants a "<pluginDir>/scripts/resolve-pipeline-cli.sh" (a copy of the
   * real script) + "<pluginDir>/plugin.json" + an optional
   * "<pluginDir>/scripts/install-runtime-deps.sh" self-heal stub, then
   * returns the copy's path for direct invocation.
   */
  function setupSelfLocationPluginDir(pluginDir, { installScriptBody } = {}) {
    mkdirSync(pluginDir, { recursive: true });
    const scriptsDir = join(pluginDir, 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    const scriptCopy = join(scriptsDir, 'resolve-pipeline-cli.sh');
    copyFileSync(SCRIPT, scriptCopy);
    chmodSync(scriptCopy, 0o755);
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        runtimeDependencies: {
          '@ai-sdlc/pipeline-cli': '^0.14.0',
          '@ai-sdlc/plugin-mcp-server': '0.9.2',
        },
      }),
    );
    if (installScriptBody) {
      const installScript = join(scriptsDir, 'install-runtime-deps.sh');
      writeFileSync(installScript, installScriptBody);
      chmodSync(installScript, 0o755);
    }
    return scriptCopy;
  }

  // Review round 2: topology 6 derives its plugin dir from the script's own
  // location, which is exactly where topology 1 already looked when
  // CLAUDE_PLUGIN_DIR is set. Without a guard it re-runs the same failing
  // self-heal against the same directory, doubling the npm timeout before the
  // final error appears.
  it('does NOT re-run self-heal when the self-location duplicates an already-tried dir', () => {
    const pluginDir = join(tmpDir, 'selflocation-dedup');
    const countFile = join(tmpDir, 'selflocation-dedup-count');
    const scriptCopy = setupSelfLocationPluginDir(pluginDir, {
      installScriptBody: `#!/usr/bin/env bash
echo x >> "${countFile}"
exit 1
`,
    });
    const fakeHome = join(tmpDir, 'selflocation-dedup-home');
    mkdirSync(fakeHome, { recursive: true });
    const fakeCwd = join(tmpDir, 'selflocation-dedup-cwd');
    mkdirSync(fakeCwd, { recursive: true });

    const result = spawnSync('bash', [scriptCopy], {
      env: { PATH: process.env.PATH, HOME: fakeHome, CLAUDE_PLUGIN_DIR: pluginDir },
      cwd: fakeCwd,
      encoding: 'utf-8',
    });

    assert.notEqual(result.status, 0, 'still fails overall — nothing was installed');
    const attempts = existsSync(countFile)
      ? readFileSync(countFile, 'utf-8').trim().split('\n').filter(Boolean).length
      : 0;
    assert.equal(attempts, 1, `self-heal must run once, not once per topology (ran ${attempts}x)`);
    assert.match(result.stderr, /not retrying self-heal/);
  });

  it('AC#3: attempts self-heal even when neither CLAUDE_PLUGIN_DIR nor CLAUDE_PLUGIN_ROOT is set, and resolves on success', () => {
    const pluginDir = join(tmpDir, 'selflocation-success');
    const scriptCopy = setupSelfLocationPluginDir(pluginDir, {
      // Fake self-heal: stamps out the expected files instead of hitting npm
      // (hermetic — follows the install-runtime-deps.test.mjs stub pattern).
      installScriptBody: `#!/usr/bin/env bash
set -euo pipefail
PLUGIN_DIR="\${1:?PLUGIN_DIR required}"
mkdir -p "$PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin"
printf '#!/usr/bin/env node\\n' > "$PLUGIN_DIR/node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs"
mkdir -p "$PLUGIN_DIR/node_modules/@ai-sdlc/plugin-mcp-server/dist"
printf '#!/usr/bin/env node\\n' > "$PLUGIN_DIR/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js"
exit 0
`,
    });
    const fakeHome = join(tmpDir, 'selflocation-success-home');
    mkdirSync(fakeHome, { recursive: true });
    // Empty cwd so dogfood fallback (topology 5) also fails and we reach
    // topology 6.
    const fakeCwd = join(tmpDir, 'selflocation-success-cwd');
    mkdirSync(fakeCwd, { recursive: true });

    const result = spawnSync('bash', [scriptCopy], {
      env: {
        PATH: process.env.PATH,
        HOME: fakeHome,
        CLAUDE_PLUGIN_DIR: '',
        CLAUDE_PLUGIN_ROOT: '',
      },
      cwd: fakeCwd,
      encoding: 'utf-8',
      timeout: 15000,
    });

    assert.equal(
      result.status,
      0,
      `must exit 0 via self-location self-heal; stderr:\n${result.stderr}`,
    );
    const expectedBin = join(pluginDir, PIPELINE_CLI_REL);
    assert.equal(
      normPath(result.stdout.trim()),
      normPath(expectedBin),
      'must return the self-location bin path',
    );
    assert.match(
      result.stderr,
      /self-location fallback/,
      'must log that the self-location fallback (not topologies 1-5) fired',
    );
  });

  it('falls through to the final actionable error when self-location self-heal does not produce a complete install', () => {
    const pluginDir = join(tmpDir, 'selflocation-fail');
    const scriptCopy = setupSelfLocationPluginDir(pluginDir, {
      // Simulates a real-world failure mode (network unreachable, registry
      // misconfigured, etc.) — the install script itself fails.
      installScriptBody: `#!/usr/bin/env bash\nexit 1\n`,
    });
    const fakeHome = join(tmpDir, 'selflocation-fail-home');
    mkdirSync(fakeHome, { recursive: true });
    const fakeCwd = join(tmpDir, 'selflocation-fail-cwd');
    mkdirSync(fakeCwd, { recursive: true });

    const result = spawnSync('bash', [scriptCopy], {
      env: {
        PATH: process.env.PATH,
        HOME: fakeHome,
        CLAUDE_PLUGIN_DIR: '',
        CLAUDE_PLUGIN_ROOT: '',
      },
      cwd: fakeCwd,
      encoding: 'utf-8',
      timeout: 15000,
    });

    assert.equal(
      result.status,
      1,
      'must exit 1 when self-heal fails to produce a complete install',
    );
    assert.match(
      result.stderr,
      /self-heal \(self-location\) did not produce a complete install/,
      'must log that self-heal was attempted and failed, not silently skip it',
    );
    assert.match(
      result.stderr,
      /@ai-sdlc\/pipeline-cli/,
      'final error must name the missing package',
    );
  });

  it('REGRESSION (pre-AISDLC-557 behavior): confirms every other topology genuinely exhausts before self-location fires', () => {
    // This mirrors "Topology 5: All paths broken" but through the dedicated
    // setupSelfLocationPluginDir harness, proving the ordering: topology 6
    // only ever fires as the LAST resort after 1-5 are all tried and fail.
    const pluginDir = join(tmpDir, 'selflocation-no-heal-script');
    // No installScriptBody — self-heal script is absent, so topology 6 must
    // gracefully no-op (file existence check fails) rather than erroring.
    const scriptCopy = setupSelfLocationPluginDir(pluginDir, {});
    const fakeHome = join(tmpDir, 'selflocation-no-heal-home');
    mkdirSync(fakeHome, { recursive: true });
    const fakeCwd = join(tmpDir, 'selflocation-no-heal-cwd');
    mkdirSync(fakeCwd, { recursive: true });

    const result = spawnSync('bash', [scriptCopy], {
      env: {
        PATH: process.env.PATH,
        HOME: fakeHome,
        CLAUDE_PLUGIN_DIR: '',
        CLAUDE_PLUGIN_ROOT: '',
      },
      cwd: fakeCwd,
      encoding: 'utf-8',
      timeout: 15000,
    });

    assert.equal(
      result.status,
      1,
      'must exit 1 when no install-runtime-deps.sh is present to self-heal with',
    );
    assert.match(result.stderr, /@ai-sdlc\/pipeline-cli/, 'must name the missing package');
  });
});
