/**
 * Tests for scripts/check-stale-runtime-deps.mjs — AISDLC-580 review follow-up
 *
 * This script is the SINGLE SOURCE for "is an installed @ai-sdlc/* runtime
 * package stale relative to its plugin.json pin", shared by
 * install-runtime-deps.sh, hooks/session-start.js's automatic self-heal
 * gate, and resolve-pipeline-cli.sh's `_deps_complete` gate. These tests
 * exercise it directly, independent of any caller.
 *
 * Run with: node --test ai-sdlc-plugin/scripts/check-stale-runtime-deps.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-stale-runtime-deps.mjs');

let workDir;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'aisdlc-580-stale-check-'));
});

after(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function writePluginJson(pluginDir, runtimeDependencies) {
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ name: 'ai-sdlc-test', version: '0.0.0-test', runtimeDependencies }, null, 2),
  );
}

function writeInstalledPackage(pluginDir, name, version) {
  const pkgDir = join(pluginDir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }, null, 2));
}

/** Build a fake `npm` that responds to `npm view <spec> version`. */
function buildFakeNpm(viewVersions) {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-580-npm-stub-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const cases = Object.entries(viewVersions)
    .map(([spec, version]) => `    "${spec}") echo "${version}"; exit 0 ;;`)
    .join('\n');
  const stub = `#!/usr/bin/env bash
if [ "$1" = "view" ]; then
  spec="$2"
  case "$spec" in
${cases}
    *) exit 1 ;;
  esac
fi
exit 1
`;
  const npmPath = join(binDir, 'npm');
  writeFileSync(npmPath, stub);
  chmodSync(npmPath, 0o755);
  return binDir;
}

function run(pluginDir, npmBinDir) {
  const result = spawnSync('node', [SCRIPT, pluginDir], {
    env: { PATH: `${npmBinDir}:${process.env.PATH}`, HOME: process.env.HOME },
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

describe('check-stale-runtime-deps.mjs — exists and always exits 0', () => {
  it('script file exists', () => {
    assert.ok(existsSync(SCRIPT), `${SCRIPT} must exist`);
  });

  it('exits 0 with no output when the plugin dir has no plugin.json', () => {
    const pluginDir = join(workDir, 'no-plugin-json');
    mkdirSync(pluginDir, { recursive: true });
    const { exitCode, stdout } = run(pluginDir, buildFakeNpm({}));
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), '');
  });

  it('exits 0 with no output when plugin.json has no runtimeDependencies', () => {
    const pluginDir = join(workDir, 'no-runtime-deps');
    writePluginJson(pluginDir, undefined);
    const { exitCode, stdout } = run(pluginDir, buildFakeNpm({}));
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), '');
  });
});

describe('check-stale-runtime-deps.mjs — detects drift', () => {
  it('reports a package whose installed version is behind the registry-resolved target', () => {
    const pluginDir = join(workDir, 'stale-behind-registry');
    writePluginJson(pluginDir, { '@ai-sdlc/pipeline-cli': '^0.20.0' });
    writeInstalledPackage(pluginDir, '@ai-sdlc/pipeline-cli', '0.20.0');
    const npmBinDir = buildFakeNpm({ '@ai-sdlc/pipeline-cli@^0.20.0': '0.20.1' });

    const { exitCode, stdout } = run(pluginDir, npmBinDir);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), '@ai-sdlc/pipeline-cli\t0.20.0\t0.20.1\t^0.20.0');
  });

  it('reports a package whose installed version no longer satisfies an advanced pin', () => {
    const pluginDir = join(workDir, 'stale-advanced-pin');
    writePluginJson(pluginDir, { '@ai-sdlc/pipeline-cli': '^0.20.1' });
    writeInstalledPackage(pluginDir, '@ai-sdlc/pipeline-cli', '0.20.0');
    const npmBinDir = buildFakeNpm({ '@ai-sdlc/pipeline-cli@^0.20.1': '0.20.1' });

    const { exitCode, stdout } = run(pluginDir, npmBinDir);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), '@ai-sdlc/pipeline-cli\t0.20.0\t0.20.1\t^0.20.1');
  });

  it('reports nothing when the installed version already matches the registry-resolved target', () => {
    const pluginDir = join(workDir, 'already-converged');
    writePluginJson(pluginDir, { '@ai-sdlc/pipeline-cli': '^0.20.0' });
    writeInstalledPackage(pluginDir, '@ai-sdlc/pipeline-cli', '0.20.1');
    const npmBinDir = buildFakeNpm({ '@ai-sdlc/pipeline-cli@^0.20.0': '0.20.1' });

    const { exitCode, stdout } = run(pluginDir, npmBinDir);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), '');
  });

  it('reports multiple stale packages, one line each', () => {
    const pluginDir = join(workDir, 'multi-stale');
    writePluginJson(pluginDir, {
      '@ai-sdlc/pipeline-cli': '^0.20.0',
      '@ai-sdlc/orchestrator': '^0.14.0',
    });
    writeInstalledPackage(pluginDir, '@ai-sdlc/pipeline-cli', '0.20.0');
    writeInstalledPackage(pluginDir, '@ai-sdlc/orchestrator', '0.14.0');
    const npmBinDir = buildFakeNpm({
      '@ai-sdlc/pipeline-cli@^0.20.0': '0.20.1',
      '@ai-sdlc/orchestrator@^0.14.0': '0.15.0',
    });

    const { exitCode, stdout } = run(pluginDir, npmBinDir);
    assert.equal(exitCode, 0);
    const lines = stdout.trim().split('\n').sort();
    assert.deepEqual(lines, [
      '@ai-sdlc/orchestrator\t0.14.0\t0.15.0\t^0.14.0',
      '@ai-sdlc/pipeline-cli\t0.20.0\t0.20.1\t^0.20.0',
    ]);
  });

  it('does not misparse a compound-range pin containing a space (review round-2 hardening)', () => {
    // A semver range pin can legally contain a space (e.g. a compound range
    // like ">=0.20.0 <0.21.0"). Output is tab-delimited specifically so a
    // space embedded in the trailing `pin` field never corrupts the fixed
    // 4-field split a bash consumer performs — this test proves the pin
    // survives INTACT (not truncated at the first space) in the output.
    const pluginDir = join(workDir, 'compound-range-pin');
    const compoundPin = '>=0.20.0 <0.21.0';
    writePluginJson(pluginDir, { '@ai-sdlc/pipeline-cli': compoundPin });
    writeInstalledPackage(pluginDir, '@ai-sdlc/pipeline-cli', '0.20.0');
    const npmBinDir = buildFakeNpm({
      [`@ai-sdlc/pipeline-cli@${compoundPin}`]: '0.20.1',
    });

    const { exitCode, stdout } = run(pluginDir, npmBinDir);
    assert.equal(exitCode, 0);
    const fields = stdout.trim().split('\t');
    assert.deepEqual(fields, ['@ai-sdlc/pipeline-cli', '0.20.0', '0.20.1', compoundPin]);
  });
});

describe('check-stale-runtime-deps.mjs — fails open', () => {
  it('reports nothing when there is no local package.json to compare against', () => {
    const pluginDir = join(workDir, 'no-local-package-json');
    writePluginJson(pluginDir, { '@ai-sdlc/pipeline-cli': '^0.20.0' });
    // No node_modules/@ai-sdlc/pipeline-cli/package.json written.
    const npmBinDir = buildFakeNpm({ '@ai-sdlc/pipeline-cli@^0.20.0': '0.20.1' });

    const { exitCode, stdout } = run(pluginDir, npmBinDir);
    assert.equal(exitCode, 0, 'must never fail hard');
    assert.equal(stdout.trim(), '');
  });

  it('reports nothing when the registry is unreachable (npm view fails)', () => {
    const pluginDir = join(workDir, 'registry-unreachable');
    writePluginJson(pluginDir, { '@ai-sdlc/pipeline-cli': '^0.20.0' });
    writeInstalledPackage(pluginDir, '@ai-sdlc/pipeline-cli', '0.20.0');
    const npmBinDir = buildFakeNpm({}); // no matching spec -> npm view exits 1

    const { exitCode, stdout } = run(pluginDir, npmBinDir);
    assert.equal(exitCode, 0, 'must fail open, not fail closed');
    assert.equal(stdout.trim(), '');
  });

  it('reports nothing when npm is missing from PATH entirely', () => {
    const pluginDir = join(workDir, 'no-npm-on-path');
    writePluginJson(pluginDir, { '@ai-sdlc/pipeline-cli': '^0.20.0' });
    writeInstalledPackage(pluginDir, '@ai-sdlc/pipeline-cli', '0.20.0');
    const emptyBinDir = mkdtempSync(join(tmpdir(), 'aisdlc-580-empty-bin-'));

    // Invoke node by its absolute path (process.execPath) so the test
    // harness itself can still launch the subprocess, while PATH inside
    // that subprocess contains no `npm` for the script's own spawnSync to
    // find — this is the "npm entirely absent" scenario under test.
    const result = spawnSync(process.execPath, [SCRIPT, pluginDir], {
      env: { PATH: emptyBinDir, HOME: process.env.HOME },
      encoding: 'utf-8',
      timeout: 15_000,
    });
    assert.equal(result.status, 0, 'must exit 0 even when npm is entirely absent');
    assert.equal(result.stdout.trim(), '');
  });
});
