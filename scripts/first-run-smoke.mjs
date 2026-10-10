#!/usr/bin/env node
/**
 * Fresh-repo first-run smoke test (AISDLC-771).
 *
 * An adopter's first hour is: install the plugin from the marketplace, run
 * `ai-sdlc init`, run `ai-sdlc doctor`, then run one task. Nothing else in CI
 * exercises that path on a clean machine, so first-run regressions (manifest
 * drift, AISDLC-558; misleading session-start claims, AISDLC-561) reached users
 * first. This script plays the adopter against a throwaway git repo with an
 * isolated HOME, fully offline (a stub `npm` and `gh` are first on PATH).
 *
 * The steps it runs are NOT a separate list: they are read from the README
 * "Getting started" code block, and each README command must have a runner here
 * (and vice versa). Editing one without the other fails this script, which is
 * how the README and the smoke test are kept in lockstep (AC 5).
 *
 * Prerequisite: `pnpm build` (uses orchestrator/dist and pipeline-cli/dist).
 *
 * Usage:
 *   node scripts/first-run-smoke.mjs
 *   pnpm smoke:first-run
 *
 * Test seams (used by scripts/first-run-smoke.test.mjs):
 *   SMOKE_PLUGIN_SRC  plugin directory to install (default: ./ai-sdlc-plugin)
 *   SMOKE_README      README to read the step list from (default: ./README.md)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUDGET_MS = 5 * 60 * 1000;

/** Hooks that make the plugin a governance plugin; losing one is the AISDLC-558 class. */
export const REQUIRED_GOVERNANCE_HOOKS = [
  { event: 'SessionStart', script: 'session-start.sh' },
  { event: 'SubagentStart', script: 'subagent-start.sh' },
  { event: 'PreToolUse', matcher: 'Bash', script: 'enforce-blocked-actions.sh' },
  { event: 'PreToolUse', matcher: 'Write|Edit|MultiEdit', script: 'enforce-blocked-actions.sh' },
  { event: 'PreToolUse', script: 'enforce-role-tools.sh' },
];

const TOY_TASK_ID = 'SMOKE-1';

// ── Pure helpers (exported for the hermetic test) ───────────────────────

/** Commands in the first fenced block under the README "Getting started" heading. */
export function readmeSteps(readme) {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => /^##\s+Getting started\s*$/i.test(l));
  if (start < 0) throw new Error('README has no "## Getting started" section');
  const open = lines.findIndex((l, i) => i > start && /^```/.test(l));
  if (open < 0) throw new Error('README "Getting started" has no code block');
  const close = lines.findIndex((l, i) => i > open && /^```/.test(l));
  return lines
    .slice(open + 1, close < 0 ? undefined : close)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** Flatten a plugin manifest's hooks into { event, matcher, script } entries. */
export function manifestHooks(manifest) {
  const out = [];
  for (const [event, groups] of Object.entries(manifest.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        const script = /hooks\/([\w.-]+)/.exec(hook.command ?? '')?.[1];
        if (script) out.push({ event, matcher: group.matcher, script });
      }
    }
  }
  return out;
}

const sameHook = (a, b) =>
  a.event === b.event &&
  a.script === b.script &&
  (b.matcher === undefined || a.matcher === b.matcher);

/**
 * Problems with the manifest Claude Code loads (`.claude-plugin/plugin.json`):
 * a required governance hook absent, a hook the reference manifest declares
 * absent, or a registered hook script missing on disk.
 */
export function manifestProblems(pluginDir) {
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const loaded = manifestHooks(readJson(join(pluginDir, '.claude-plugin', 'plugin.json')));
  const reference = manifestHooks(readJson(join(pluginDir, 'plugin.json')));
  const problems = [];
  const label = (h) => `${h.event}${h.matcher ? `[${h.matcher}]` : ''} -> ${h.script}`;
  for (const req of REQUIRED_GOVERNANCE_HOOKS) {
    if (!loaded.some((h) => sameHook(h, req))) {
      problems.push(`governance hook missing from marketplace manifest: ${label(req)}`);
    }
  }
  for (const ref of reference) {
    if (!loaded.some((h) => sameHook(h, ref))) {
      problems.push(`hook in plugin.json but not in .claude-plugin/plugin.json: ${label(ref)}`);
    }
  }
  for (const h of loaded) {
    if (!existsSync(join(pluginDir, 'hooks', h.script))) {
      problems.push(`hook script not shipped: hooks/${h.script} (${label(h)})`);
    }
  }
  return [...new Set(problems)];
}

// ── Smoke run ───────────────────────────────────────────────────────────

const STEP_TIMEOUT_MS = 120_000;

function fail(msg) {
  throw new Error(msg);
}

function sh(cmd, args, opts) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: STEP_TIMEOUT_MS,
    ...opts,
  });
}

function buildSandbox() {
  const base = mkdtempSync(join(tmpdir(), 'ai-sdlc-first-run-'));
  const home = join(base, 'home');
  const bin = join(base, 'bin');
  const work = join(base, 'work');
  const origin = join(base, 'origin.git');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // Offline: npm reports a network failure (doctor treats that as a warning, not a
  // missing pin) and gh is unavailable (init skips branch protection).
  writeFileSync(
    join(bin, 'npm'),
    '#!/bin/sh\necho "npm ERR! network ENOTFOUND registry.npmjs.org (first-run smoke runs offline)" >&2\nexit 1\n',
  );
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh: offline (first-run smoke)" >&2\nexit 1\n');
  chmodSync(join(bin, 'npm'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    GIT_AUTHOR_NAME: 'smoke',
    GIT_AUTHOR_EMAIL: 'smoke@example.com',
    GIT_COMMITTER_NAME: 'smoke',
    GIT_COMMITTER_EMAIL: 'smoke@example.com',
    AI_SDLC_ORCHESTRATOR_DETECT_SUBPROCESS: '0',
  };
  for (const k of ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DIR', 'AI_SDLC_ACTIVE_TASK_ID'])
    delete env[k];

  sh('git', ['init', '-q', '-b', 'main', work], { env });
  sh('git', ['init', '-q', '--bare', origin], { env });
  writeFileSync(join(work, 'index.js'), 'module.exports = {};\n');
  sh('git', ['-C', work, 'add', '-A'], { env });
  sh('git', ['-C', work, 'commit', '-q', '-m', 'chore: initial commit'], { env });
  // Absolute path: pipeline worktrees run git from a different cwd.
  sh('git', ['-C', work, 'remote', 'add', 'origin', origin], { env });
  sh('git', ['-C', work, 'push', '-q', 'origin', 'main'], { env });
  sh('git', ['-C', work, 'fetch', '-q', 'origin'], { env });
  return { base, home, work, env };
}

function commitAll(sb, message) {
  sh('git', ['-C', sb.work, 'add', '-A'], { env: sb.env });
  sh('git', ['-C', sb.work, 'commit', '-q', '-m', message], { env: sb.env });
  sh('git', ['-C', sb.work, 'push', '-q', 'origin', 'main'], { env: sb.env });
  sh('git', ['-C', sb.work, 'fetch', '-q', 'origin'], { env: sb.env });
}

const TOY_TASK = `---
id: ${TOY_TASK_ID}
title: add greeting
status: To Do
assignee: []
created_date: '2026-10-09'
labels: []
dependencies: []
priority: low
---

## Description

Add a greet function to index.js.

## Acceptance Criteria

- [ ] index.js exports greet()
`;

function requireBuilt(...paths) {
  for (const built of paths) {
    if (!existsSync(join(ROOT, built))) fail(`${built} missing - run \`pnpm build\` first`);
  }
}

function makeRunners(ctx) {
  const { pluginSrc, marketplace, sb } = ctx;
  const aiSdlc = join(ROOT, 'orchestrator', 'dist', 'cli', 'index.js');
  const node = (args, extra = {}) =>
    spawnSync(process.execPath, args, {
      cwd: sb.work,
      env: sb.env,
      encoding: 'utf8',
      timeout: STEP_TIMEOUT_MS,
      ...extra,
    });

  return [
    {
      match: /^\/plugin marketplace add (\S+)$/,
      run() {
        const entry = marketplace.plugins?.[0];
        if (!entry?.name || !entry.source)
          fail('root .claude-plugin/marketplace.json lists no plugin');
        if (!existsSync(join(pluginSrc, '.claude-plugin', 'plugin.json'))) {
          fail(`marketplace source ${entry.source} has no .claude-plugin/plugin.json`);
        }
      },
    },
    {
      match: /^\/plugin install (\S+)@(\S+)$/,
      run([, name, mkt]) {
        const entry = marketplace.plugins[0];
        if (name !== entry.name || mkt !== marketplace.name) {
          fail(
            `README installs ${name}@${mkt} but marketplace.json is ${entry.name}@${marketplace.name}`,
          );
        }
        const problems = manifestProblems(pluginSrc);
        if (problems.length) fail(`plugin manifest is broken:\n  - ${problems.join('\n  - ')}`);
        const version = JSON.parse(readFileSync(join(pluginSrc, 'plugin.json'), 'utf8')).version;
        const dest = join(sb.home, '.claude', 'plugins', 'cache', mkt, name, version);
        cpSync(pluginSrc, dest, {
          recursive: true,
          filter: (p) => !p.split('/').includes('node_modules'),
        });
      },
    },
    {
      match: /^\/reload-plugins$/,
      run() {
        // Claude Code re-reads the installed copy; it must still be a complete plugin.
        const cacheRoot = join(sb.home, '.claude', 'plugins', 'cache');
        if (!existsSync(cacheRoot)) fail('plugin install left no marketplace cache');
      },
    },
    {
      match: /^ai-sdlc init$/,
      run() {
        requireBuilt('orchestrator/dist/cli/index.js');
        // The README form prompts; --yes is the documented non-interactive equivalent.
        const r = node([aiSdlc, 'init', '--yes']);
        // --yes asks for branch protection, which needs an authenticated gh; offline that
        // is the one failure init is documented to report with exit 1, so tolerate only it.
        const offlineOnly =
          r.status === 1 && r.stdout.includes('Branch protection was NOT applied');
        if (r.status !== 0 && !offlineOnly) {
          fail(`ai-sdlc init --yes exited ${r.status}\n${r.stdout}\n${r.stderr}`);
        }
        for (const f of ['.ai-sdlc/agent-role.yaml', '.ai-sdlc/pipeline.yaml']) {
          if (!existsSync(join(sb.work, f))) fail(`init did not scaffold ${f}`);
        }
        commitAll(sb, 'chore: ai-sdlc init');
      },
    },
    {
      match: /^ai-sdlc doctor$/,
      run() {
        const r = node([aiSdlc, '--format', 'json', 'doctor']);
        let report;
        try {
          report = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
        } catch {
          fail(
            `ai-sdlc doctor printed no JSON report (exit ${r.status})\n${r.stdout}\n${r.stderr}`,
          );
        }
        const errors = report.results.filter((x) => x.severity === 'fail');
        if (errors.length || report.summary.fail !== 0 || r.status !== 0) {
          fail(
            `ai-sdlc doctor reported ${errors.length} error(s) (exit ${r.status}):\n` +
              errors.map((e) => `  - ${e.id}: ${e.title}`).join('\n'),
          );
        }
        const warns = report.results.filter((x) => x.severity === 'warn');
        console.log(`    doctor: ${report.summary.pass} pass, ${warns.length} warn, 0 fail`);
      },
    },
    {
      match: /^\/ai-sdlc execute (\S+)$/,
      run() {
        requireBuilt('pipeline-cli/dist/index.js', 'pipeline-cli/dist/cli/orchestrator.js');
        // The README names an example task id; the smoke files its own toy task.
        mkdirSync(join(sb.work, 'backlog', 'tasks'), { recursive: true });
        writeFileSync(
          join(sb.work, 'backlog', 'tasks', `${TOY_TASK_ID.toLowerCase()} - add greeting.md`),
          TOY_TASK,
        );
        commitAll(sb, `chore: file toy task ${TOY_TASK_ID}`);

        const cli = join(ROOT, 'pipeline-cli', 'bin', 'cli-orchestrator.mjs');
        const tick = node([cli, 'tick', '--spawner', 'mock', '--dry-run', '--work-dir', sb.work]);
        let candidates = 0;
        try {
          candidates = JSON.parse(tick.stdout.slice(tick.stdout.indexOf('{'))).tick.candidates;
        } catch {
          // reported below
        }
        if (tick.status !== 0 || candidates < 1) {
          fail(
            `cli-orchestrator tick --spawner mock found no frontier task\n${tick.stdout}\n${tick.stderr}`,
          );
        }
        const run = node([
          join(ROOT, 'scripts', 'first-run-smoke-pipeline.mjs'),
          sb.work,
          TOY_TASK_ID,
          join(ROOT, 'pipeline-cli', 'dist'),
        ]);
        if (run.status !== 0) fail(`offline pipeline run failed\n${run.stdout}\n${run.stderr}`);
        const result = JSON.parse(run.stdout.trim().split('\n').pop());
        if (!result.branch || !result.commit)
          fail(`pipeline produced no committed branch: ${run.stdout}`);
        const remote = sh('git', ['-C', sb.work, 'ls-remote', '--heads', 'origin', result.branch], {
          env: sb.env,
        });
        if (!remote.includes(result.commit))
          fail(`branch ${result.branch} was not pushed to origin`);
        console.log(`    pipeline: ${result.branch} @ ${result.commit.slice(0, 8)}`);
      },
    },
  ];
}

export function runSmoke() {
  const started = Date.now();
  const pluginSrc = resolve(process.env.SMOKE_PLUGIN_SRC ?? join(ROOT, 'ai-sdlc-plugin'));
  const readme = readFileSync(process.env.SMOKE_README ?? join(ROOT, 'README.md'), 'utf8');
  const marketplace = JSON.parse(
    readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'),
  );
  const steps = readmeSteps(readme);
  const sb = buildSandbox();
  const runners = makeRunners({ pluginSrc, marketplace, sb });
  try {
    for (const step of steps) {
      const runner = runners.find((r) => r.match.test(step));
      if (!runner) fail(`README step has no smoke-test runner: ${step}`);
    }
    for (const r of runners) {
      if (!steps.some((s) => r.match.test(s))) {
        fail(`smoke-test runner ${r.match} has no matching README "Getting started" step`);
      }
    }
    for (const step of steps) {
      const runner = runners.find((r) => r.match.test(step));
      console.log(`[first-run-smoke] ${step}`);
      const t0 = Date.now();
      runner.run(runner.match.exec(step));
      console.log(`[first-run-smoke]   (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    }
    const elapsed = Date.now() - started;
    if (elapsed > BUDGET_MS)
      fail(`smoke took ${Math.round(elapsed / 1000)}s, over the 5 minute budget`);
    console.log(`[first-run-smoke] PASS in ${(elapsed / 1000).toFixed(1)}s`);
  } finally {
    rmSync(sb.base, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runSmoke();
  } catch (err) {
    console.error(`[first-run-smoke] FAIL: ${err.message}`);
    process.exit(1);
  }
}
