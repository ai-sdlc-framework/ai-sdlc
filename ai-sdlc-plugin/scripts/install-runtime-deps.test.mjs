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
function buildFakeNpm({ writeEntryPoints, exitCode = 0, viewVersions = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-441-npm-stub-'));
  const logFile = join(dir, 'npm-invocations.log');
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });

  // AISDLC-580: `npm view <name>@<pin> version` responses for the
  // version-convergence check. Keyed by the exact "name@pin" spec string;
  // an unmatched spec exits 1 (simulating a registry miss / offline), which
  // the script must fail open on rather than blocking the install.
  const viewHandlerBash =
    Object.keys(viewVersions).length > 0
      ? `
if [ "$1" = "view" ]; then
  spec="$2"
  case "$spec" in
${Object.entries(viewVersions)
  .map(([spec, version]) => `    "${spec}") echo "${version}"; exit 0 ;;`)
  .join('\n')}
    *) exit 1 ;;
  esac
fi
`
      : `
if [ "$1" = "view" ]; then
  exit 1
fi
`;

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
    @ai-sdlc/orchestrator)
      mkdir -p "$prefix/node_modules/@ai-sdlc/orchestrator/dist/runtime"
      echo "export const x = 1;" > "$prefix/node_modules/@ai-sdlc/orchestrator/dist/runtime/attestations.js"
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
${viewHandlerBash}
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

describe('plugin manifests — runtimeDependencies must not drift (AISDLC-554)', () => {
  // The repo ships TWO manifests: ai-sdlc-plugin/plugin.json (which
  // install-runtime-deps.sh itself reads, via "$PLUGIN_DIR/plugin.json") and
  // ai-sdlc-plugin/.claude-plugin/plugin.json (the marketplace-canonical
  // manifest). Nothing enforced that their runtimeDependencies agree, so a bump
  // applied to one could silently never reach a marketplace-installed adopter —
  // which is exactly the production path AISDLC-554 exists to unblock. Whichever
  // file the installer actually reads, this keeps the answer irrelevant.
  const pluginRoot = join(__dirname, '..');
  const topLevel = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf-8'));
  const marketplace = JSON.parse(
    readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8'),
  );

  it('both manifests declare identical runtimeDependencies', () => {
    assert.deepEqual(
      marketplace.runtimeDependencies,
      topLevel.runtimeDependencies,
      'ai-sdlc-plugin/plugin.json and ai-sdlc-plugin/.claude-plugin/plugin.json must declare the same runtimeDependencies',
    );
  });

  it('both declare @ai-sdlc/orchestrator, which carries the attestation signing runtime', () => {
    for (const [label, manifest] of [
      ['plugin.json', topLevel],
      ['.claude-plugin/plugin.json', marketplace],
    ]) {
      assert.ok(
        manifest.runtimeDependencies?.['@ai-sdlc/orchestrator'],
        `${label} must declare @ai-sdlc/orchestrator`,
      );
    }
  });
});

describe('plugin manifests — runtimeDependencies pins must not lag the workspace (AISDLC-574)', () => {
  // AISDLC-574 root cause: runtimeDependencies pinned @ai-sdlc/orchestrator and
  // @ai-sdlc/pipeline-cli at ^0.14.0 — a caret-on-0.x range that resolves ONLY
  // to 0.14.x — while the workspace packages moved to 0.19.0. 0.14.0 has no
  // verdictClass / harnessTranscript modules, so every marketplace-installed
  // adopter's signed leaves silently read self-authored. This test fails
  // whenever the pin's minimum resolvable version falls behind the workspace
  // package's own version, catching the drift class before it ships again.
  const repoRoot = join(__dirname, '..', '..');
  const pluginRoot = join(repoRoot, 'ai-sdlc-plugin');
  const topLevel = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf-8'));
  const marketplace = JSON.parse(
    readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8'),
  );

  /** Parse a bare "x.y.z" (optionally "-prerelease") version into number[3]. */
  function parseVersion(raw) {
    const core = String(raw).split('-')[0];
    const parts = core.split('.').map((n) => Number.parseInt(n, 10));
    if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
      throw new Error(`cannot parse version: ${raw}`);
    }
    return parts;
  }

  /** Strip a leading ^ or >= from a simple single-range pin to its floor version. */
  function pinFloor(pin) {
    const stripped = String(pin)
      .replace(/^[\^~]/, '')
      .replace(/^>=\s*/, '');
    return parseVersion(stripped);
  }

  /** Does `version` satisfy caret-on-0.x semantics (>=floor, <next-minor)? */
  function satisfiesCaretZero(version, floor) {
    if (floor[0] !== 0) {
      // Not the 0.x caret case this repo relies on — compare >= only.
      return compareVersions(version, floor) >= 0;
    }
    if (version[0] !== 0 || version[1] !== floor[1]) return false;
    return version[2] >= floor[2];
  }

  function compareVersions(a, b) {
    for (let i = 0; i < 3; i += 1) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  for (const pkgDir of ['orchestrator', 'pipeline-cli']) {
    const pkgName = `@ai-sdlc/${pkgDir}`;

    it(`${pkgName} runtimeDependencies pin resolves to >= the workspace package version`, () => {
      const workspaceVersion = parseVersion(
        JSON.parse(readFileSync(join(repoRoot, pkgDir, 'package.json'), 'utf-8')).version,
      );

      for (const [label, manifest] of [
        ['plugin.json', topLevel],
        ['.claude-plugin/plugin.json', marketplace],
      ]) {
        const pin = manifest.runtimeDependencies?.[pkgName];
        assert.ok(pin, `${label} must declare ${pkgName} in runtimeDependencies`);
        const floor = pinFloor(pin);
        assert.ok(
          satisfiesCaretZero(workspaceVersion, floor),
          `${label} pins ${pkgName} at "${pin}" (floor ${floor.join('.')}), which does not ` +
            `resolve to the current workspace version ${workspaceVersion.join('.')} — the pin ` +
            `has drifted behind the released runtime (AISDLC-574)`,
        );
      }
    });
  }
});

describe('plugin manifests — hook event registration must not drift (AISDLC-571)', () => {
  // AISDLC-571 root cause: .claude-plugin/plugin.json (the marketplace-canonical
  // manifest) never registered the SubagentStart hook event, even though
  // hooks/subagent-start.sh ships in the plugin and plugin.json (the top-level
  // manifest) DOES register it. That silently broke `verdictClass` for every
  // marketplace-installed adopter — `.ai-sdlc/subagent-sessions/` markers were
  // never written, so `determineVerdictClass()` could never return
  // 'independent'. This test generalizes the AISDLC-554 runtimeDependencies
  // sync check to the `hooks` block: every event name that appears in EITHER
  // manifest's `hooks` object, and whose command references a script that
  // actually ships under ai-sdlc-plugin/hooks/, must be registered in BOTH
  // manifests. It fails on the pre-fix state (SubagentStart present only in
  // plugin.json) and passes once the two manifests are reconciled.
  //
  // AISDLC-571 review follow-up: the event-level check alone would NOT catch
  // a missing MATCHER within an event that's already present via a different
  // matcher — exactly the second drift found in this same task, where
  // .claude-plugin/plugin.json had `PreToolUse` registered (via the `Bash`
  // matcher) but was missing the `Write|Edit` matcher entry entirely. The
  // event-name set stayed equal, so an event-level-only test would go green
  // even with that matcher dropped. `matcherPairsWithShippedScripts` below
  // extends the comparison to (event, matcher, script) triples so removing
  // EITHER the SubagentStart event OR the Write|Edit matcher fails the test.
  const pluginRoot = join(__dirname, '..');
  const hooksDir = join(pluginRoot, 'hooks');
  const topLevel = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf-8'));
  const marketplace = JSON.parse(
    readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8'),
  );

  /**
   * Returns the set of hook event names (top-level keys of the `hooks`
   * object) whose entries reference at least one script that actually
   * exists under ai-sdlc-plugin/hooks/. Filtering by "script actually
   * ships" keeps the assertion honest — we only require agreement on
   * events backed by real, shipped hook scripts, not on any event name
   * that might appear in a manifest for other reasons.
   */
  function eventsWithShippedScripts(manifest) {
    const events = new Set();
    for (const [eventName, matcherEntries] of Object.entries(manifest.hooks ?? {})) {
      for (const matcherEntry of matcherEntries) {
        for (const hook of matcherEntry.hooks ?? []) {
          const match = /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^"]+\.sh)/.exec(hook.command ?? '');
          if (match && existsSync(join(hooksDir, match[1]))) {
            events.add(eventName);
          }
        }
      }
    }
    return events;
  }

  /**
   * Returns the set of (event, matcher, script) triples — finer-grained than
   * `eventsWithShippedScripts`. A matcher entry with no explicit `matcher`
   * field (e.g. PostToolUse's single unconditional entry) is represented
   * with matcher `'<none>'` so events that don't use matchers still compare
   * cleanly. Only pairs backed by a script that actually ships under
   * ai-sdlc-plugin/hooks/ are included, matching the event-level filter.
   */
  function matcherPairsWithShippedScripts(manifest) {
    const pairs = new Set();
    for (const [eventName, matcherEntries] of Object.entries(manifest.hooks ?? {})) {
      for (const matcherEntry of matcherEntries) {
        const matcher = matcherEntry.matcher ?? '<none>';
        for (const hook of matcherEntry.hooks ?? []) {
          const match = /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^"]+\.sh)/.exec(hook.command ?? '');
          if (match && existsSync(join(hooksDir, match[1]))) {
            pairs.add(`${eventName}::${matcher}::${match[1]}`);
          }
        }
      }
    }
    return pairs;
  }

  const topLevelEvents = eventsWithShippedScripts(topLevel);
  const marketplaceEvents = eventsWithShippedScripts(marketplace);
  const topLevelPairs = matcherPairsWithShippedScripts(topLevel);
  const marketplacePairs = matcherPairsWithShippedScripts(marketplace);

  it('every shipped-hook-script event registered in plugin.json is also registered in .claude-plugin/plugin.json', () => {
    for (const eventName of topLevelEvents) {
      assert.ok(
        marketplaceEvents.has(eventName),
        `.claude-plugin/plugin.json is missing the '${eventName}' hook event, ` +
          `which plugin.json registers against a shipped script under ai-sdlc-plugin/hooks/`,
      );
    }
  });

  it('every shipped-hook-script event registered in .claude-plugin/plugin.json is also registered in plugin.json', () => {
    for (const eventName of marketplaceEvents) {
      assert.ok(
        topLevelEvents.has(eventName),
        `plugin.json is missing the '${eventName}' hook event, ` +
          `which .claude-plugin/plugin.json registers against a shipped script under ai-sdlc-plugin/hooks/`,
      );
    }
  });

  it('every shipped-hook-script (event, matcher) pair in plugin.json is also registered in .claude-plugin/plugin.json', () => {
    for (const pair of topLevelPairs) {
      assert.ok(
        marketplacePairs.has(pair),
        `.claude-plugin/plugin.json is missing the '${pair}' (event::matcher::script) ` +
          `registration that plugin.json declares against a shipped script`,
      );
    }
  });

  it('every shipped-hook-script (event, matcher) pair in .claude-plugin/plugin.json is also registered in plugin.json', () => {
    for (const pair of marketplacePairs) {
      assert.ok(
        topLevelPairs.has(pair),
        `plugin.json is missing the '${pair}' (event::matcher::script) ` +
          `registration that .claude-plugin/plugin.json declares against a shipped script`,
      );
    }
  });

  it('SubagentStart is registered in both manifests (AISDLC-571 regression guard)', () => {
    assert.ok(topLevelEvents.has('SubagentStart'), 'plugin.json must register SubagentStart');
    assert.ok(
      marketplaceEvents.has('SubagentStart'),
      '.claude-plugin/plugin.json must register SubagentStart',
    );
  });

  it('PreToolUse Write|Edit matcher is registered in both manifests (AISDLC-571 regression guard)', () => {
    const expected = 'PreToolUse::Write|Edit::enforce-blocked-actions.sh';
    assert.ok(topLevelPairs.has(expected), `plugin.json must register ${expected}`);
    assert.ok(
      marketplacePairs.has(expected),
      `.claude-plugin/plugin.json must register ${expected}`,
    );
  });
});

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
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.14.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    const { binDir, logFile } = buildFakeNpm({ writeEntryPoints: true });
    const { exitCode, invocations } = runScript({ pluginDir, npmBinDir: binDir, logFile });

    assert.equal(exitCode, 0, 'must exit 0 when both deps install successfully');
    assert.equal(invocations.length, 1, 'must invoke npm exactly once');
    const { args } = invocations[0];

    // Critical: positional specs are present (the AISDLC-441 load-bearing fix).
    assert.ok(
      args.includes('@ai-sdlc/pipeline-cli@^0.14.0'),
      'must pass pipeline-cli spec as positional arg',
    );
    assert.ok(
      args.includes('@ai-sdlc/orchestrator@^0.14.0'),
      'must pass orchestrator spec as positional arg (AISDLC-554: carries the signing runtime)',
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
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.14.0',
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
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.14.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    // Pre-create the entry-point files (simulating a prior successful install).
    mkdirSync(join(pluginDir, 'node_modules/@ai-sdlc/pipeline-cli/bin'), { recursive: true });
    writeFileSync(join(pluginDir, 'node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs'), '');
    mkdirSync(join(pluginDir, 'node_modules/@ai-sdlc/plugin-mcp-server/dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js'), '');
    mkdirSync(join(pluginDir, 'node_modules/@ai-sdlc/orchestrator/dist/runtime'), {
      recursive: true,
    });
    writeFileSync(
      join(pluginDir, 'node_modules/@ai-sdlc/orchestrator/dist/runtime/attestations.js'),
      '',
    );

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

  it('does NOT early-exit when only the pre-AISDLC-554 packages are installed', () => {
    // The upgrade path: an adopter whose plugin predates AISDLC-554 already has
    // pipeline-cli + mcp-server. If the idempotence guard ignores the newly
    // declared orchestrator dependency, it early-exits, the signing runtime is
    // never fetched, and attestation stays silently unavailable.
    const pluginDir = join(workDir, 'idempotent-upgrade');
    writePluginJson(pluginDir, {
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.14.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    mkdirSync(join(pluginDir, 'node_modules/@ai-sdlc/pipeline-cli/bin'), { recursive: true });
    writeFileSync(join(pluginDir, 'node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs'), '');
    mkdirSync(join(pluginDir, 'node_modules/@ai-sdlc/plugin-mcp-server/dist'), { recursive: true });
    writeFileSync(join(pluginDir, 'node_modules/@ai-sdlc/plugin-mcp-server/dist/bin.js'), '');
    // orchestrator deliberately absent.

    const { binDir, logFile } = buildFakeNpm({ writeEntryPoints: true });
    const { exitCode, invocations } = runScript({ pluginDir, npmBinDir: binDir, logFile });

    assert.equal(
      exitCode,
      0,
      `must heal the missing dependency; invocations=${invocations.length}`,
    );
    assert.equal(invocations.length, 1, 'must actually run npm rather than early-exit');
    assert.ok(
      existsSync(
        join(pluginDir, 'node_modules/@ai-sdlc/orchestrator/dist/runtime/attestations.js'),
      ),
      'orchestrator runtime must exist after the heal',
    );
  });

  it('fails verification when npm exits 0 without producing the orchestrator runtime', () => {
    // The sentinel below makes future runs skip installing, so a silent
    // half-install must NOT be stamped as complete.
    const pluginDir = join(workDir, 'partial-install');
    writePluginJson(pluginDir, {
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.14.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    // Stub npm creates everything EXCEPT orchestrator.
    const { binDir, logFile } = buildFakeNpm({ writeEntryPoints: true });
    const npmPath = join(binDir, 'npm');
    writeFileSync(
      npmPath,
      readFileSync(npmPath, 'utf-8').replace(
        '    @ai-sdlc/orchestrator)',
        '    @ai-sdlc/orchestrator-disabled)',
      ),
    );
    chmodSync(npmPath, 0o755);

    const { exitCode, stderr } = runScript({ pluginDir, npmBinDir: binDir, logFile });
    assert.notEqual(exitCode, 0, 'must fail rather than stamp a partial install as complete');
    assert.match(stderr, /@ai-sdlc\/orchestrator/);
    assert.ok(
      !existsSync(join(pluginDir, 'node_modules', '.ai-sdlc-installed')),
      'must not write the completion sentinel on a failed verification',
    );
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
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.14.0',
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
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.14.0',
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

describe('install-runtime-deps.sh — version convergence on stale installs (AISDLC-580)', () => {
  // Reproduces the AISDLC-580 incident: pipeline-cli@0.20.0 is already
  // installed and satisfies the pin, but the script's pre-fix idempotence
  // check treats "entry-point file exists" as "install is correct" and never
  // notices a newer version has since become available (or that the pin
  // itself advanced past what's installed). Both scenarios must converge.

  /** Materialise an already-"installed" package with a real package.json. */
  function writeInstalledPackage(pluginDir, name, entryRel, version) {
    const pkgDir = join(pluginDir, 'node_modules', name);
    mkdirSync(join(pkgDir, dirname(entryRel)), { recursive: true });
    writeFileSync(join(pkgDir, entryRel), '');
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }, null, 2));
  }

  it('upgrades an installed version that still satisfies the pin but is behind the registry (AC-1)', () => {
    // installed 0.20.0, pin ^0.20.0 (satisfies), registry resolves ^0.20.0 -> 0.20.1.
    const pluginDir = join(workDir, 'stale-but-satisfying');
    writePluginJson(pluginDir, {
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.20.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    writeInstalledPackage(pluginDir, '@ai-sdlc/pipeline-cli', 'bin/cli-deps.mjs', '0.20.0');
    writeInstalledPackage(pluginDir, '@ai-sdlc/plugin-mcp-server', 'dist/bin.js', '0.9.2');
    writeInstalledPackage(
      pluginDir,
      '@ai-sdlc/orchestrator',
      'dist/runtime/attestations.js',
      '0.14.0',
    );

    const { binDir, logFile } = buildFakeNpm({
      writeEntryPoints: true,
      viewVersions: {
        '@ai-sdlc/pipeline-cli@^0.20.0': '0.20.1',
        '@ai-sdlc/plugin-mcp-server@0.9.2': '0.9.2',
        '@ai-sdlc/orchestrator@^0.14.0': '0.14.0',
      },
    });
    const { exitCode, stderr } = runScript({ pluginDir, npmBinDir: binDir, logFile });

    assert.equal(exitCode, 0, `must converge and exit 0; stderr=${stderr}`);
    assert.match(
      stderr,
      /upgrading @ai-sdlc\/pipeline-cli 0\.20\.0 -> 0\.20\.1 to satisfy pin \^0\.20\.0/,
      'must print a visible upgrade line',
    );
    assert.ok(
      existsSync(join(pluginDir, 'node_modules/@ai-sdlc/pipeline-cli/bin/cli-deps.mjs')),
      'pipeline-cli must be reinstalled at the target version',
    );
  });

  it('upgrades an installed version that no longer satisfies an advanced pin (AC-2)', () => {
    // installed 0.20.0, pin advanced to ^0.20.1 (does NOT satisfy) — must upgrade.
    const pluginDir = join(workDir, 'stale-unsatisfying');
    writePluginJson(pluginDir, {
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.20.1',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    writeInstalledPackage(pluginDir, '@ai-sdlc/pipeline-cli', 'bin/cli-deps.mjs', '0.20.0');
    writeInstalledPackage(pluginDir, '@ai-sdlc/plugin-mcp-server', 'dist/bin.js', '0.9.2');
    writeInstalledPackage(
      pluginDir,
      '@ai-sdlc/orchestrator',
      'dist/runtime/attestations.js',
      '0.14.0',
    );

    const { binDir, logFile } = buildFakeNpm({
      writeEntryPoints: true,
      viewVersions: {
        '@ai-sdlc/pipeline-cli@^0.20.1': '0.20.1',
        '@ai-sdlc/plugin-mcp-server@0.9.2': '0.9.2',
        '@ai-sdlc/orchestrator@^0.14.0': '0.14.0',
      },
    });
    const { exitCode, stderr, invocations } = runScript({ pluginDir, npmBinDir: binDir, logFile });

    assert.equal(exitCode, 0, `must converge and exit 0; stderr=${stderr}`);
    assert.match(
      stderr,
      /upgrading @ai-sdlc\/pipeline-cli 0\.20\.0 -> 0\.20\.1 to satisfy pin \^0\.20\.1/,
    );
    assert.ok(
      invocations.some((inv) => inv.args.includes('@ai-sdlc/pipeline-cli@^0.20.1')),
      'must re-run npm install with the advanced pin spec',
    );
  });

  it('does NOT reinstall when the installed version already matches the registry-resolved target', () => {
    // installed 0.20.1, pin ^0.20.0, registry also resolves to 0.20.1 — no drift.
    const pluginDir = join(workDir, 'already-converged');
    writePluginJson(pluginDir, {
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.20.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    writeInstalledPackage(pluginDir, '@ai-sdlc/pipeline-cli', 'bin/cli-deps.mjs', '0.20.1');
    writeInstalledPackage(pluginDir, '@ai-sdlc/plugin-mcp-server', 'dist/bin.js', '0.9.2');
    writeInstalledPackage(
      pluginDir,
      '@ai-sdlc/orchestrator',
      'dist/runtime/attestations.js',
      '0.14.0',
    );

    const { binDir, logFile } = buildFakeNpm({
      writeEntryPoints: true,
      viewVersions: {
        '@ai-sdlc/pipeline-cli@^0.20.0': '0.20.1',
        '@ai-sdlc/plugin-mcp-server@0.9.2': '0.9.2',
        '@ai-sdlc/orchestrator@^0.14.0': '0.14.0',
      },
    });
    const { exitCode, stderr, invocations } = runScript({ pluginDir, npmBinDir: binDir, logFile });

    assert.equal(exitCode, 0);
    assert.match(stderr, /already installed/);
    assert.doesNotMatch(stderr, /upgrading/);
    // Only the 3 `npm view` calls — no `npm install`.
    assert.equal(invocations.length, 3, 'must not invoke npm install when already converged');
    for (const inv of invocations) {
      assert.equal(inv.args[0], 'view', 'the only npm invocations should be `npm view`');
    }
  });

  it('fails open (does not reinstall) when the registry is unreachable', () => {
    // npm view returns nothing (simulated offline) — must not block/crash and
    // must not force an unnecessary reinstall.
    const pluginDir = join(workDir, 'offline-fail-open');
    writePluginJson(pluginDir, {
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.20.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    writeInstalledPackage(pluginDir, '@ai-sdlc/pipeline-cli', 'bin/cli-deps.mjs', '0.20.0');
    writeInstalledPackage(pluginDir, '@ai-sdlc/plugin-mcp-server', 'dist/bin.js', '0.9.2');
    writeInstalledPackage(
      pluginDir,
      '@ai-sdlc/orchestrator',
      'dist/runtime/attestations.js',
      '0.14.0',
    );

    // No viewVersions configured — the stub's `npm view` always exits 1.
    const { binDir, logFile } = buildFakeNpm({ writeEntryPoints: true });
    const { exitCode, stderr } = runScript({ pluginDir, npmBinDir: binDir, logFile });

    assert.equal(exitCode, 0, `must fail open, not fail closed; stderr=${stderr}`);
    assert.match(stderr, /already installed/);
    assert.doesNotMatch(stderr, /upgrading/);
  });

  it('the AISDLC-441 sentinel does not suppress a needed upgrade', () => {
    // A stale `.ai-sdlc-installed` sentinel from a prior run must not short-
    // circuit the version-convergence check — the sentinel only records that
    // SOME install happened, not that it's still current.
    const pluginDir = join(workDir, 'sentinel-does-not-suppress-upgrade');
    writePluginJson(pluginDir, {
      '@ai-sdlc/orchestrator': '^0.14.0',
      '@ai-sdlc/pipeline-cli': '^0.20.0',
      '@ai-sdlc/plugin-mcp-server': '0.9.2',
    });
    writeInstalledPackage(pluginDir, '@ai-sdlc/pipeline-cli', 'bin/cli-deps.mjs', '0.20.0');
    writeInstalledPackage(pluginDir, '@ai-sdlc/plugin-mcp-server', 'dist/bin.js', '0.9.2');
    writeInstalledPackage(
      pluginDir,
      '@ai-sdlc/orchestrator',
      'dist/runtime/attestations.js',
      '0.14.0',
    );
    mkdirSync(join(pluginDir, 'node_modules'), { recursive: true });
    writeFileSync(
      join(pluginDir, 'node_modules', '.ai-sdlc-installed'),
      'installed by ai-sdlc-plugin install-runtime-deps.sh at 2026-01-01T00:00:00Z\n',
    );

    const { binDir, logFile } = buildFakeNpm({
      writeEntryPoints: true,
      viewVersions: {
        '@ai-sdlc/pipeline-cli@^0.20.0': '0.20.1',
        '@ai-sdlc/plugin-mcp-server@0.9.2': '0.9.2',
        '@ai-sdlc/orchestrator@^0.14.0': '0.14.0',
      },
    });
    const { exitCode, stderr } = runScript({ pluginDir, npmBinDir: binDir, logFile });

    assert.equal(exitCode, 0);
    assert.match(
      stderr,
      /upgrading @ai-sdlc\/pipeline-cli 0\.20\.0 -> 0\.20\.1/,
      'a stale sentinel must not suppress the needed upgrade',
    );
  });
});
