/**
 * Hermetic tests for the fresh-repo first-run smoke test (AISDLC-771).
 *
 * The headline case is the AISDLC-558 class: a governance hook dropped from the
 * manifest Claude Code actually loads (`.claude-plugin/plugin.json`) must make
 * the smoke fail, even while the reference manifest and every test inside the
 * plugin package stay green. The full end-to-end run is skipped when the
 * workspace is not built (CI runs it as its own job after `pnpm build`).
 *
 * Run with: node --test scripts/first-run-smoke.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REQUIRED_GOVERNANCE_HOOKS,
  manifestHooks,
  manifestProblems,
  readmeSteps,
} from './first-run-smoke.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'first-run-smoke.mjs');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const built =
  existsSync(join(ROOT, 'orchestrator/dist/cli/index.js')) &&
  existsSync(join(ROOT, 'pipeline-cli/dist/index.js')) &&
  existsSync(join(ROOT, 'pipeline-cli/dist/cli/orchestrator.js'));

let scratch;
before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'first-run-smoke-test-'));
});
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A copy of the plugin (hooks + manifests only) whose loaded manifest we can break. */
function pluginCopy(name) {
  const dest = join(scratch, name);
  cpSync(join(ROOT, 'ai-sdlc-plugin'), dest, {
    recursive: true,
    filter: (p) => !/node_modules|mcp-server/.test(p),
  });
  return dest;
}

function withoutHook(manifest, script) {
  const copy = structuredClone(manifest);
  for (const groups of Object.values(copy.hooks)) {
    for (const g of groups) g.hooks = g.hooks.filter((h) => !h.command.includes(`/${script}`));
  }
  return copy;
}

function runSmoke(env) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

describe('manifest governance-hook check (AISDLC-558 class)', () => {
  it('passes for the shipped plugin', () => {
    assert.deepEqual(manifestProblems(join(ROOT, 'ai-sdlc-plugin')), []);
  });

  for (const script of new Set(REQUIRED_GOVERNANCE_HOOKS.map((h) => h.script))) {
    it(`reports ${script} missing from the marketplace manifest`, () => {
      const dir = pluginCopy(`plugin-without-${script}`);
      const file = join(dir, '.claude-plugin', 'plugin.json');
      writeFileSync(
        file,
        JSON.stringify(withoutHook(JSON.parse(readFileSync(file, 'utf8')), script)),
      );
      const problems = manifestProblems(dir);
      assert.ok(
        problems.some((p) => p.includes(script) && p.includes('marketplace manifest')),
        `expected a problem naming ${script}, got ${JSON.stringify(problems)}`,
      );
    });
  }

  it('reports a hook script that the plugin does not ship', () => {
    const dir = pluginCopy('plugin-without-script-file');
    rmSync(join(dir, 'hooks', 'enforce-role-tools.sh'));
    assert.ok(manifestProblems(dir).some((p) => p.includes('hook script not shipped')));
  });

  it('the smoke script exits non-zero when a governance hook is removed from the manifest', () => {
    const dir = pluginCopy('plugin-smoke-fail');
    const file = join(dir, '.claude-plugin', 'plugin.json');
    writeFileSync(
      file,
      JSON.stringify(
        withoutHook(JSON.parse(readFileSync(file, 'utf8')), 'enforce-blocked-actions.sh'),
      ),
    );
    const r = runSmoke({ SMOKE_PLUGIN_SRC: dir });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /enforce-blocked-actions\.sh/);
  });
});

describe('README "Getting started" stays in lockstep with the smoke steps', () => {
  it('lists the install, init, doctor and execute steps', () => {
    const steps = readmeSteps(README);
    assert.ok(steps.some((s) => s.startsWith('/plugin marketplace add ')));
    assert.ok(steps.some((s) => s.startsWith('/plugin install ')));
    assert.ok(steps.includes('ai-sdlc init'));
    assert.ok(steps.includes('ai-sdlc doctor'));
    assert.ok(steps.some((s) => s.startsWith('/ai-sdlc execute ')));
  });

  it('the install step names the plugin and marketplace in .claude-plugin/marketplace.json', () => {
    const mkt = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const install = readmeSteps(README).find((s) => s.startsWith('/plugin install '));
    assert.equal(install, `/plugin install ${mkt.plugins[0].name}@${mkt.name}`);
  });

  it('manifestHooks flattens matchers and scripts', () => {
    const hooks = manifestHooks(
      JSON.parse(readFileSync(join(ROOT, 'ai-sdlc-plugin/.claude-plugin/plugin.json'), 'utf8')),
    );
    assert.ok(hooks.some((h) => h.event === 'PreToolUse' && h.matcher === 'Bash'));
  });

  it('fails when the README drops a step the smoke runs', () => {
    const file = join(scratch, 'README-no-doctor.md');
    writeFileSync(file, README.replace(/# 3\.[^\n]*\nai-sdlc doctor\n\n/, ''));
    const r = runSmoke({ SMOKE_README: file });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ai-sdlc doctor/);
  });

  it('fails when the README adds a step the smoke cannot run', () => {
    const file = join(scratch, 'README-extra.md');
    writeFileSync(file, README.replace('ai-sdlc doctor\n', 'ai-sdlc doctor\nai-sdlc frobnicate\n'));
    const r = runSmoke({ SMOKE_README: file });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /frobnicate/);
  });
});

describe('end to end (requires pnpm build)', { skip: !built && 'workspace not built' }, () => {
  it('exits 0 on the shipped plugin and reports a committed branch', () => {
    const r = runSmoke({});
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /doctor: \d+ pass, \d+ warn, 0 fail/);
    assert.match(r.stdout, /pipeline: ai-sdlc\/smoke-1-add-greeting @ [0-9a-f]{8}/);
    assert.match(r.stdout, /PASS in/);
  });
});
