/**
 * Tests for scripts/install-runtime-deps.sh — AISDLC-441
 *
 * The pre-AISDLC-441 script was a silent no-op: it ran
 * `npm install --prefix "$PLUGIN_DIR"` against a cache directory that has
 * no `package.json` (or has one with empty `dependencies:`), so npm exited
 * 0 without installing anything. The MCP server then failed to start with
 * `Cannot find module .../node_modules/.../dist/bin.js` and operators had to
 * manually run `npm install --omit=dev --no-audit --no-fund --ignore-scripts
 * @ai-sdlc/pipeline-cli@^0.10.0 @ai-sdlc/plugin-mcp-server@0.9.2`.
 *
 * AISDLC-441 fix: the script now PARSES `runtimeDependencies` from
 * `plugin.json` and passes the specs as positional `npm install` args, so
 * it works regardless of whether the cache directory has a `package.json`.
 *
 * These tests verify the contract end-to-end by stubbing `npm` with a fake
 * shell script that records every invocation — we don't actually hit the
 * npm registry. The tests focus on:
 *
 *   1. Idempotence — second run is a no-op when the entry points exist.
 *   2. Plugin.json discovery — refuses when plugin.json is missing.
 *   3. runtimeDependencies parsing — refuses with clear error when missing
 *      or empty (the AISDLC-441 root-cause failure mode).
 *   4. Invocation contract — passes correct positional package specs to
 *      npm with the security flags (--ignore-scripts, --no-save).
 *   5. Fresh-install simulation — full happy path, including sentinel
 *      file creation at node_modules/.ai-sdlc-installed.
 *   6. Post-install verification — fails with actionable error when npm
 *      exits 0 but the expected entry-point files are missing (e.g.
 *      network/registry failure).
 *
 * Run with: node --test ai-sdlc-plugin/scripts/install-runtime-deps.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'install-runtime-deps.sh');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a fake `npm` shell script that:
 *   - Records every invocation (args, cwd) to a log file
 *   - Optionally materialises a fake entry-point file under
 *     <prefix>/node_modules/<pkg>/<entryRel> for each `name@version` spec
 *     so the post-install verification step passes.
 *
 * Returns: { binDir, logFile, npmPath }
 */
function buildFakeNpm({ writeEntryPoints, exitCode = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-441-npm-stub-'));
  const logFile = join(dir, 'npm-invocations.log');
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });

  // The fake npm script writes a JSON line per invocation, then optionally
  // creates entry points for AISDLC's known runtime deps so post-install
  // verification succeeds.
  const writeEntryPointsBash = writeEntryPoints
    ? `
# Pull --prefix value out of args.
prefix=""
specs=()
expecting_prefix=0
for arg in "$@"; do
  if [ "$expecting_prefix" = "1" ]; then
    prefix="$arg"; expecting_prefix=0; continue
  fi
  case "$arg" in
    --prefix) expecting_prefix=1; continue ;;
    --prefix=*) prefix="\${arg#--prefix=}"; continue ;;
    --no-save|--omit=dev|--no-audit|--no-fund|--ignore-scripts|--loglevel|warn|install) continue ;;
    -*) continue ;;
    *) specs+=("$arg") ;;
  esac
done
[ -z "$prefix" ] && prefix="$PWD"
for spec in "\${specs[@]}"; do
  # Strip @version, preserving @scope/name. For @scope/name@version, the
  # rightmost @ separates name from version; bash %@* removes that suffix.
  # For unscoped name@version, %@* also works correctly.
  name="\${spec%@*}"
  case "$name" in
    @ai-sdlc/pipeline-cli)
      mkdir -p "$prefix/node_modules/@ai-sdlc/pipeline-cli/bin"
      echo "#!/usr/bin/env node" > "$prefix/node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs"
      ;;
    @ai-sdlc/plugin-mcp-server)
      mkdir -p "$prefix/node_modules/@ai-sdlc/plugin-mcp-server/dist"
      echo "#!/usr/bin/env node" > "$prefix/node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js"
      ;;
  esac
done
`
    : '';

  const stub = `#!/usr/bin/env bash
# Record args as JSON (one line per invocation).
node -e '
  const fs = require("node:fs");
  const args = process.argv.slice(1);
  fs.appendFileSync(process.env.LOG_FILE, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
' -- "$@"
${writeEntryPointsBash}
exit ${exitCode}
`;
  const npmPath = join(binDir, 'npm');
  writeFileSync(npmPath, stub);
  chmodSync(npmPath, 0o755);

  return { binDir, logFile, npmPath };
}

/**
 * Run install-runtime-deps.sh with stub npm on PATH.
 */
function runScript({ pluginDir, npmBinDir, logFile, extraEnv = {} }) {
  const env = {
    PATH: `${npmBinDir}:${process.env.PATH}`,
    HOME: process.env.HOME,
    LOG_FILE: logFile,
    ...extraEnv,
  };
  const result = spawnSync('bash', [SCRIPT, pluginDir], {
    env,
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exitCode: result.status,
    invocations: existsSync(logFile)
      ? readFileSync(logFile, 'utf-8')
          .trim()
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l))
      : [],
  };
}

function writePluginJson(pluginDir, runtimeDependencies) {
  mkdirSync(pluginDir, { recursive: true });
  const plugin = {
    name: 'ai-sdlc-test',
    version: '0.0.0-test',
    ...(runtimeDependencies !== undefined && { runtimeDependencies }),
  };
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(plugin, null, 2));
}

// ── Test scaffolding ──────────────────────────────────────────────────────────

let workDir;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'aisdlc-441-test-'));
});

after(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('install-runtime-deps.sh — script exists and is executable', () => {
  it('script file exists', () => {
    assert.ok(existsSync(SCRIPT), `${SCRIPT} must exist`);
  });

  it('script is executable', () => {
    const result = spawnSync('test', ['-x', SCRIPT]);
    assert.equal(result.status, 0, `${SCRIPT} must be executable — run: chmod +x ${SCRIPT}`);
  });
});

describe('install-runtime-deps.sh — argument validation', () => {
  it('exits 1 when CLAUDE_PLUGIN_ROOT is unset and no arg is given', () => {
    const result = spawnSync('bash', [SCRIPT], {
      env: { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: '' },
      encoding: 'utf-8',
      timeout: 5_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CLAUDE_PLUGIN_ROOT is unset/);
  });

  it('exits 1 when plugin.json is missing in the target dir', () => {
    const pluginDir = join(workDir, 'no-plugin-json');
    mkdirSync(pluginDir, { recursive: true });
    const { exitCode, stderr } = runScript({
      pluginDir,
      npmBinDir: '/nonexistent',
      logFile: join(workDir, 'no-plugin-json.log'),
    });
    assert.equal(exitCode, 1);
    assert.match(stderr, /plugin\.json not found/);
  });
});

describe('install-runtime-deps.sh — runtimeDependencies parsing (AISDLC-441 root cause)', () => {
  it('exits 1 with actionable error when runtimeDependencies field is missing', () => {
    // This is the pre-AISDLC-441 silent-failure mode: plugin.json exists but
    // has no runtimeDependencies. Old script ran `npm install --prefix` which
    // exited 0. New script must surface the real problem.
    const pluginDir = join(workDir, 'no-runtime-deps');
    writePluginJson(pluginDir, undefined);
    const { binDir, logFile } = buildFakeNpm({ writeEntryPoints: false });
    const { exitCode, stderr, invocations } = runScript({
      pluginDir,
      npmBinDir: binDir,
      logFile,
    });
    assert.equal(exitCode, 1, 'must exit 1 — not silently succeed');
    assert.match(stderr, /no runtimeDependencies/);
    assert.match(stderr, /AISDLC-441/);
    assert.equal(invocations.length, 0, 'must not invoke npm when there is nothing to install');
  });

  it('exits 1 when runtimeDependencies is an empty object', () => {
    const pluginDir = join(workDir, 'empty-runtime-deps');
    writePluginJson(pluginDir, {});
    const { binDir, logFile } = buildFakeNpm({ writeEntryPoints: false });
    const { exitCode, stderr, invocations } = runScript({
      pluginDir,
      npmBinDir: binDir,
      logFile,
    });
    assert.equal(exitCode, 1);
    assert.match(stderr, /empty/);
    assert.equal(invocations.length, 0);
  });

  it('exits 1 when plugin.json is not valid JSON', () => {
    const pluginDir = join(workDir, 'bad-json');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), '{ this is not json');
    const { binDir, logFile } = buildFakeNpm({ writeEntryPoints: false });
    const { exitCode, stderr } = runScript({ pluginDir, npmBinDir: binDir, logFile });
    assert.equal(exitCode, 1);
    assert.match(stderr, /not valid JSON|failed to parse/);
  });
});

describe('install-runtime-deps.sh — npm invocation contract', () => {
  it('passes explicit package specs as positional args (not relying on package.json)', () => {
    const pluginDir = join(workDir, 'invocation-contract');
    writePluginJson(pluginDir, {
      '@ai-sdlc/pipeline-cli': '^0.10.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    const { binDir, logFile } = buildFakeNpm({ writeEntryPoints: true });
    const { exitCode, invocations } = runScript({ pluginDir, npmBinDir: binDir, logFile });

    assert.equal(exitCode, 0, 'must exit 0 when both deps install successfully');
    assert.equal(invocations.length, 1, 'must invoke npm exactly once');
    const { args } = invocations[0];

    // Critical: positional specs are present (the AISDLC-441 load-bearing fix).
    assert.ok(
      args.includes('@ai-sdlc/pipeline-cli@^0.10.0'),
      'must pass pipeline-cli spec as positional arg',
    );
    assert.ok(
      args.includes('@ai-sdlc/plugin-mcp-server@0.9.2'),
      'must pass mcp-server spec as positional arg',
    );

    // Required flags for security + correctness:
    assert.ok(args.includes('install'), 'must invoke `npm install`');
    assert.ok(args.includes('--prefix'), 'must scope install to the plugin dir');
    assert.ok(args.includes(pluginDir), 'must pass plugin dir to --prefix');
    assert.ok(
      args.includes('--no-save'),
      'must use --no-save since the cache dir has no writable package.json',
    );
    assert.ok(
      args.includes('--ignore-scripts'),
      'must use --ignore-scripts to prevent transitive RCE',
    );
    assert.ok(args.includes('--omit=dev'), 'must use --omit=dev for runtime-only install');
  });

  it('writes the .ai-sdlc-installed sentinel after successful install', () => {
    const pluginDir = join(workDir, 'sentinel');
    writePluginJson(pluginDir, {
      '@ai-sdlc/pipeline-cli': '^0.10.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    const { binDir, logFile } = buildFakeNpm({ writeEntryPoints: true });
    const { exitCode } = runScript({ pluginDir, npmBinDir: binDir, logFile });

    assert.equal(exitCode, 0);
    const sentinel = join(pluginDir, 'node_modules', '.ai-sdlc-installed');
    assert.ok(existsSync(sentinel), 'must write sentinel file after install');
    const sentinelBody = readFileSync(sentinel, 'utf-8');
    assert.match(sentinelBody, /installed by ai-sdlc-plugin/);
  });
});

describe('install-runtime-deps.sh — idempotence', () => {
  it('skips npm install when both entry-point files already exist', () => {
    const pluginDir = join(workDir, 'idempotent');
    writePluginJson(pluginDir, {
      '@ai-sdlc/pipeline-cli': '^0.10.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    // Pre-create the entry-point files (simulating a prior successful install).
    mkdirSync(join(pluginDir, 'node_modules/@ai-sdlc/pipeline-cli/bin'), { recursive: true });
    writeFileSync(join(pluginDir, 'node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs'), '');
    mkdirSync(join(pluginDir, 'node_modules/@ai-sdlc/plugin-mcp-server/dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js'), '');

    const { binDir, logFile } = buildFakeNpm({ writeEntryPoints: false });
    const { exitCode, stderr, invocations } = runScript({
      pluginDir,
      npmBinDir: binDir,
      logFile,
    });
    assert.equal(exitCode, 0);
    assert.match(stderr, /already installed/);
    assert.equal(invocations.length, 0, 'idempotence guard must skip npm entirely');
  });
});

describe('install-runtime-deps.sh — fresh-install simulation (AISDLC-441 happy path)', () => {
  it('simulates Claude Code copying plugin cache without npm install + heals successfully', () => {
    // Reproduce the exact failure scenario described in GH issue 713:
    //   1. Claude Code's local marketplace installer creates the cache dir
    //      with plugin files (plugin.json, hooks/, scripts/, etc.) but does
    //      NOT invoke npm install — so node_modules/ does not exist.
    //   2. /ai-sdlc execute or any tool calling pipeline-cli fails because
    //      the bin is missing.
    //
    // The install-runtime-deps.sh script is the operator's recovery path.
    // It must populate node_modules/@ai-sdlc/pipeline-cli and
    // node_modules/@ai-sdlc/plugin-mcp-server from the runtimeDependencies
    // declared in plugin.json.
    const pluginDir = join(workDir, 'fresh-install');
    writePluginJson(pluginDir, {
      '@ai-sdlc/pipeline-cli': '^0.10.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    // CRITICAL: no node_modules pre-exists. This is the fresh-install state.
    assert.ok(
      !existsSync(join(pluginDir, 'node_modules')),
      'fresh-install must have no node_modules',
    );

    const { binDir, logFile } = buildFakeNpm({ writeEntryPoints: true });
    const { exitCode, stderr } = runScript({ pluginDir, npmBinDir: binDir, logFile });

    assert.equal(exitCode, 0, 'must exit 0 after fresh-install heal');
    assert.match(stderr, /installed successfully/);

    // Post-heal: both runtime entry points must resolve.
    assert.ok(
      existsSync(join(pluginDir, 'node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs')),
      'AC-1: @ai-sdlc/pipeline-cli must be resolvable',
    );
    assert.ok(
      existsSync(join(pluginDir, 'node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js')),
      'AC-1: @ai-sdlc/plugin-mcp-server must be resolvable',
    );
    // Sentinel for session-start idempotence.
    assert.ok(
      existsSync(join(pluginDir, 'node_modules/.ai-sdlc-installed')),
      'must write .ai-sdlc-installed sentinel',
    );
  });
});

describe('install-runtime-deps.sh — post-install verification', () => {
  it('exits 1 with actionable error when npm exits 0 but entry points are missing', () => {
    // Network-failure simulation: npm "succeeded" (exit 0) but didn't install
    // the packages (writeEntryPoints: false). The verification step must
    // catch this and surface a helpful error rather than reporting success.
    const pluginDir = join(workDir, 'silent-network-fail');
    writePluginJson(pluginDir, {
      '@ai-sdlc/pipeline-cli': '^0.10.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    const { binDir, logFile } = buildFakeNpm({ writeEntryPoints: false, exitCode: 0 });
    const { exitCode, stderr } = runScript({ pluginDir, npmBinDir: binDir, logFile });
    assert.equal(exitCode, 1, 'must exit 1 when expected files are missing post-install');
    assert.match(stderr, /missing/);
    assert.match(stderr, /@ai-sdlc\/pipeline-cli/);
    assert.match(stderr, /@ai-sdlc\/plugin-mcp-server/);
    assert.match(stderr, /network|registry/i);
  });
});
