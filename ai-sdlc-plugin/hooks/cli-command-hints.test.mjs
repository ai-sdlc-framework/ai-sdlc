/**
 * AISDLC-1359: hook messages name the installed pipeline-cli bin, not a path inside this repo.
 * Run with: node --test ai-sdlc-plugin/hooks/cli-command-hints.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const LITERAL = 'node pipeline-cli/bin/';
const SENTENCE = 'in the pipeline-cli bin directory, $PIPELINE_CLI_BIN';

let root;
let binDir;
let project;
let isolatedHooks; // a copy of hooks/ with no monorepo pipeline-cli beside it

before(() => {
  root = mkdtempSync(join(tmpdir(), 'cli-hints-'));
  binDir = join(root, 'elsewhere', 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const n of ['cli-decisions.mjs', 'cli-merge-if-eligible.mjs'])
    writeFileSync(join(binDir, n), '');
  project = join(root, 'project');
  mkdirSync(join(project, '.ai-sdlc'), { recursive: true });
  writeFileSync(
    join(project, '.ai-sdlc', 'agent-role.yaml'),
    `role: coding-agent\ngoal: t\nblockedActions:\n  - 'gh pr close*'\n`,
  );
  mkdirSync(join(root, 'iso', 'ai-sdlc-plugin'), { recursive: true });
  isolatedHooks = join(root, 'iso', 'ai-sdlc-plugin', 'hooks');
  cpSync(here, isolatedHooks, { recursive: true });
});

after(() => rmSync(root, { recursive: true, force: true }));

const baseEnv = (extra) => {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: project, ...extra };
  delete env.PIPELINE_CLI_BIN;
  delete env.CLAUDE_PLUGIN_ROOT;
  return { ...env, ...extra };
};

function permission(hooksDir, env) {
  const r = spawnSync('node', [join(hooksDir, 'permission-check.js')], {
    input: JSON.stringify({ tool_input: { command: 'gh pr close 1' } }),
    encoding: 'utf-8',
    env: baseEnv(env),
  });
  return r.stdout;
}

function enforce(hooksDir, env) {
  // Untrusted run + unparseable input: the fail-closed message names escalate.
  const r = spawnSync('node', [join(hooksDir, 'enforce-blocked-actions.js')], {
    input: 'not json',
    encoding: 'utf-8',
    env: baseEnv({ GITHUB_ACTIONS: '', AI_SDLC_UNTRUSTED_RUN: '1', ...env }),
  });
  return r.stderr;
}

function mergeText(hooksDir, env) {
  const script = `const g=require(${JSON.stringify(join(hooksDir, 'lib', 'governance-resolver.js'))});
process.stdout.write(g.renderSessionStartHardRules({allowMerge:'onGreenClean',allowForcePush:'lease'}));`;
  return spawnSync('node', ['-e', script], { encoding: 'utf-8', env: baseEnv(env) }).stdout;
}

const cases = { permission, enforce, governanceResolver: mergeText };

describe('hook messages name the resolved bin (AISDLC-1359)', () => {
  for (const [name, fn] of Object.entries(cases)) {
    it(`${name}: contains the resolved path when PIPELINE_CLI_BIN is set`, () => {
      const out = fn(here, { PIPELINE_CLI_BIN: binDir });
      assert.ok(out.includes(binDir), out);
      assert.ok(!out.includes(LITERAL), out);
    });
    it(`${name}: names the bin directory when no candidate exists`, () => {
      const out = fn(isolatedHooks, {});
      assert.ok(out.includes(SENTENCE), out);
      assert.ok(!out.includes(LITERAL), out);
    });
  }

  it('cli-command resolves in order and falls back to the sentence', () => {
    const { cliCommand, resolveCliBin } = require('./lib/cli-command.js');
    const lonely = join(root, 'lonely');
    assert.equal(resolveCliBin('cli-decisions.mjs', {}, lonely), undefined);
    assert.equal(
      cliCommand('cli-decisions.mjs', { PIPELINE_CLI_BIN: binDir }, lonely),
      `node ${join(binDir, 'cli-decisions.mjs')}`,
    );
    assert.match(
      cliCommand('cli-decisions.mjs', {}, lonely),
      /^cli-decisions\.mjs \(in the pipeline-cli bin/,
    );
    const plugin = join(root, 'plug');
    const nm = join(plugin, 'node_modules', '@ai-sdlc', 'pipeline-cli', 'bin');
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, 'x.mjs'), '');
    assert.equal(resolveCliBin('x.mjs', { CLAUDE_PLUGIN_ROOT: plugin }, lonely), join(nm, 'x.mjs'));
  });

  it('no hook source holds the literal path, and prompt-rules holds no path', () => {
    for (const f of [
      'permission-check.js',
      'enforce-blocked-actions.js',
      'lib/governance-resolver.js',
    ]) {
      assert.ok(!readFileSync(join(here, f), 'utf-8').includes(LITERAL), f);
    }
    const { PROMPT_RULES } = require('./lib/prompt-rules.js');
    const text = JSON.stringify(PROMPT_RULES);
    assert.ok(text.length > 10);
    assert.ok(!text.includes('pipeline-cli/bin'));
  });
});
