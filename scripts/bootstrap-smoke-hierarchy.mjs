#!/usr/bin/env node
/**
 * In-process `cli-hierarchy` and landing-pass legs of the bootstrap smoke (AISDLC-1361).
 *
 * Runs from the scratch repository with the sandbox environment (isolated HOME, the fake `gh`
 * first on PATH). Nothing real is started: tmux and the `claude` launcher are injected `run`
 * functions, the reconcile scheduler and webhook receiver are injected spawners.
 *
 * Usage: node bootstrap-smoke-hierarchy.mjs <pipelineCliDist> <up|tick|land> <boardDir> [--policy-root <dir>]
 * Prints, for `up` and `tick`, the CLI's own output lines, then one `RESULT <json>` line.
 * For `land` it prints only `RESULT <json>` with the LandReport.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, mode, boardDir, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const load = (rel) => import(pathToFileURL(join(dist, rel)).href);
const cwd = process.cwd();
const home = process.env.HOME;
const registryDir = join(home, '.claude', 'sessions');
mkdirSync(registryDir, { recursive: true });

const lines = [];
const log = (line) => lines.push(line);

/** tmux answers as a machine with no sessions yet; starting a session registers it with the harness. */
function fakeRun(file, args) {
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  if (file === 'tmux') {
    const store = join(boardDir, 'fake-tmux-sessions.json');
    const sessions = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : [];
    const target = (args[args.indexOf('-t') + 1] ?? '').replace(/^=/, '').split(':')[0];
    if (args[0] === 'has-session') {
      return sessions.includes(target) ? ok() : { status: 1, stdout: '', stderr: 'no session' };
    }
    if (args[0] === 'list-windows') return ok(`${target}\n`);
    if (args[0] === 'new-session') {
      writeFileSync(store, JSON.stringify([...sessions, args[args.indexOf('-s') + 1]]));
      const name = /--name '?([^' ]+)'?/.exec(String(args.at(-1)))?.[1];
      if (name) {
        writeFileSync(
          join(registryDir, `${name}.json`),
          JSON.stringify({
            pid: process.pid,
            name,
            startedAt: Date.now() + 1,
            status: 'idle',
            cwd,
          }),
        );
      }
      return ok();
    }
    if (args[0] === 'display-message') return ok(`%1 ${process.pid}\n`);
    return ok();
  }
  // git, gh and node run for real: the fake `gh` is first on PATH.
  const r = spawnSync(file, args, { cwd, encoding: 'utf8', env: process.env });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

if (mode === 'up' || mode === 'tick') {
  const { runHierarchyCli } = await load('cli/hierarchy.js');
  const overrides = {
    run: fakeRun,
    boardDir,
    cwd,
    registryDir,
    settingsFiles: [join(home, '.claude', 'settings.json')],
    userSettingsFile: join(home, '.claude', 'settings.json'),
    resources: () => ({ cpuIdlePct: 100, freeMemMb: 16000, loadAvg1: 0 }),
    resourceGate: false,
    env: process.env,
    now: () => new Date(),
    sleep: async () => {},
    log,
    claudeBin: 'claude',
    pollAttempts: 2,
    pollIntervalMs: 1,
    spawnScheduler: () => process.pid,
    spawnWebhook: () => {},
    isPortFree: () => true,
    isAlive: () => true,
    nodeInstalled: () => true,
    emit: () => {},
  };
  let code;
  if (mode === 'up') {
    // A refusal (`up` throws) is reported on stderr with exit 1; the smoke asserts its text.
    code = await runHierarchyCli(
      ['up', '--no-module-check', '--no-vscode-tasks', '--project', 'bootstrap'],
      overrides,
    ).catch((err) => {
      process.stderr.write(`${err.message}\n`);
      return 1;
    });
  } else {
    const identity = {
      readSessions: () => [
        {
          name: 'bootstrap-operator-dispatch',
          role: 'operator-dispatch',
          pid: 400,
          status: 'running',
        },
      ],
      parentPid: (pid) => (pid === 500 ? 400 : null),
      comm: (pid) => (pid === 400 ? 'claude' : 'zsh'),
      startPid: 500,
    };
    code = await runHierarchyCli(['tick', '--work-dir', cwd, '--board-dir', boardDir], overrides, {
      identity,
      trustedBoard: { root: cwd, boardDir },
      // An installed CLI lives outside any checkout; the home directory is not a repository.
      installDir: home,
      usageIngest: () => {},
      boardBackup: () => {},
      reconcileNow: () => {},
      parentUpkeep: async () => ({}),
      landEligible: async () => ({ landed: [], refused: [] }),
    });
  }
  for (const l of lines) console.log(l);
  console.log(`RESULT ${JSON.stringify({ code })}`);
  process.exit(0);
} else if (mode === 'land') {
  const { landEligiblePrs, readMergeAuthors, createLander } = await load(
    'hierarchy/land-eligible.js',
  );
  const { resolveGovernanceFromYaml } = await load('governance/merge-if-eligible.js');
  const policyRoot = flag('--policy-root') ?? cwd;
  const run = (file, args, opts) => {
    const r = spawnSync(file, args, { cwd: opts?.cwd ?? cwd, encoding: 'utf8', env: process.env });
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const report = await landEligiblePrs({
    boardDir,
    repoRoot: cwd,
    run,
    mergeAuthors: readMergeAuthors(policyRoot, (y) => resolveGovernanceFromYaml(y).mergeAuthors),
    land: createLander({ repoRoot: cwd }),
  });
  console.log(`RESULT ${JSON.stringify(report)}`);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
