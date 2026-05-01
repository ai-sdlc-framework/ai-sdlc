/**
 * Tests for `scripts/check-backlog-drift.sh` — AISDLC-119.
 *
 * The script is invoked from `.husky/pre-commit` and rejects commits
 * that stage a backlog task (`backlog/tasks/*.md`, Added or Modified)
 * with drift errors as reported by `npx backlog-drift check --task <id>`.
 *
 * We can't run the real `backlog-drift` CLI inside a synthetic temp
 * repo (it expects a working backlog config + git history rooted at
 * the project), so the tests stub `npx` via a fake on `PATH` whose exit
 * code mirrors the case under test. That keeps these tests hermetic +
 * fast (no network, no real CLI install) while still exercising the
 * full bash control flow: staging detection, ID extraction, env-var
 * short-circuit, exit-code aggregation, error-message rendering.
 *
 * Run with: node --test scripts/check-backlog-drift.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-backlog-drift.sh');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf-8' });
}

/**
 * Build a fake `npx` shim that records its arguments and exits with a
 * caller-supplied code. The shim lives in `<root>/bin/npx`; the test
 * prepends that directory to PATH so the script under test resolves
 * our shim instead of the real one. We intentionally use a shell
 * script rather than a Node script so the shim itself doesn't depend
 * on a working node-on-PATH (which the real npx does).
 *
 * @param {string} root  temp repo root
 * @param {object} opts
 * @param {Record<string, number>} opts.exitByTaskId  map of TASK-ID → exit code
 * @param {number} [opts.defaultExit=0]               exit code for unmapped IDs
 */
function installFakeNpx(root, { exitByTaskId, defaultExit = 0 }) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, 'npx.log');
  // Build a case statement that picks the right exit code per --task arg.
  // Bash arg parsing in shim: we expect args like
  //   --no-install backlog-drift check --task AISDLC-119
  // The task id is whichever arg follows `--task`.
  const cases = Object.entries(exitByTaskId)
    .map(([id, code]) => `    ${id}) printf 'fake drift error for ${id}\\n' >&2; exit ${code} ;;`)
    .join('\n');
  const shim = `#!/usr/bin/env bash
echo "npx $*" >> "${logPath}"
task=""
while [ $# -gt 0 ]; do
  case "$1" in
    --task) task="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$task" in
${cases}
    *) exit ${defaultExit} ;;
esac
`;
  const shimPath = join(binDir, 'npx');
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
  return { binDir, logPath };
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ai-sdlc-drift-check-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  mkdirSync(join(root, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(root, 'backlog', 'completed'), { recursive: true });
  writeFileSync(join(root, '.gitkeep'), '');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'baseline'], root);
  return root;
}

function runCheck(cwd, env = {}) {
  return spawnSync('bash', [SCRIPT], {
    cwd,
    env: cleanEnv({
      // Prepend our shim dir so the script resolves OUR npx, not the real one.
      PATH: `${join(cwd, 'bin')}:${process.env.PATH}`,
      ...env,
    }),
    encoding: 'utf-8',
  });
}

describe('check-backlog-drift.sh (AISDLC-119)', () => {
  let root;

  beforeEach(() => {
    root = setupRepo();
    chmodSync(SCRIPT, 0o755);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('exits 0 when nothing is staged', () => {
    installFakeNpx(root, { exitByTaskId: {} });
    const r = runCheck(root);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
  });

  it('exits 0 when only NON-backlog files are staged (does not invoke npx)', () => {
    installFakeNpx(root, { exitByTaskId: { 'AISDLC-1': 1 } });
    writeFileSync(join(root, 'README.md'), 'unrelated\n');
    git(['add', 'README.md'], root);
    const r = runCheck(root);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
  });

  it('exits 0 when staged backlog task has no drift (npx shim returns 0)', () => {
    installFakeNpx(root, { exitByTaskId: {}, defaultExit: 0 });
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-200 - clean-task.md'),
      '---\nid: AISDLC-200\nstatus: To Do\n---\n',
    );
    git(['add', 'backlog/tasks/aisdlc-200 - clean-task.md'], root);
    const r = runCheck(root);
    assert.equal(r.status, 0, `expected 0, got ${r.status}: ${r.stderr}`);
  });

  it('exits 1 when a staged task has drift errors', () => {
    installFakeNpx(root, { exitByTaskId: { 'AISDLC-201': 1 } });
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-201 - bad-task.md'),
      '---\nid: AISDLC-201\nreferences:\n  - missing.md\n---\n',
    );
    git(['add', 'backlog/tasks/aisdlc-201 - bad-task.md'], root);
    const r = runCheck(root);
    assert.equal(r.status, 1, `expected 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /AISDLC-201 has drift errors/);
    assert.match(r.stderr, /backlog-drift fix --task AISDLC-201/);
    assert.match(r.stderr, /AI_SDLC_SKIP_DRIFT_GATE=1/);
    assert.match(r.stderr, /--no-verify/);
  });

  it('uppercases the task ID extracted from a lowercase filename', () => {
    // The filename is lowercased (`aisdlc-202`) but the CLI expects the
    // canonical uppercase form (`AISDLC-202`).
    const { logPath } = installFakeNpx(root, { exitByTaskId: {}, defaultExit: 0 });
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-202 - mixed.md'),
      '---\nid: AISDLC-202\n---\n',
    );
    git(['add', 'backlog/tasks/aisdlc-202 - mixed.md'], root);
    runCheck(root);
    const log = execFileSync('cat', [logPath], { encoding: 'utf-8' });
    assert.match(log, /--task AISDLC-202/);
    assert.doesNotMatch(log, /--task aisdlc-202/);
  });

  it('aggregates failures across MULTIPLE staged tasks (one bad, one good)', () => {
    installFakeNpx(root, { exitByTaskId: { 'AISDLC-203': 1, 'AISDLC-204': 0 } });
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-203 - bad.md'),
      '---\nid: AISDLC-203\n---\n',
    );
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-204 - good.md'),
      '---\nid: AISDLC-204\n---\n',
    );
    git(['add', 'backlog/tasks/aisdlc-203 - bad.md'], root);
    git(['add', 'backlog/tasks/aisdlc-204 - good.md'], root);
    const r = runCheck(root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /1 staged task\(s\) have drift errors/);
    assert.match(r.stderr, /AISDLC-203/);
    // The good task should NOT appear in the failure list.
    assert.doesNotMatch(r.stderr, /AISDLC-204 has drift errors/);
  });

  it('AI_SDLC_SKIP_DRIFT_GATE=1 short-circuits with exit 0 even when drift exists', () => {
    installFakeNpx(root, { exitByTaskId: { 'AISDLC-205': 1 } });
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-205 - bad.md'),
      '---\nid: AISDLC-205\n---\n',
    );
    git(['add', 'backlog/tasks/aisdlc-205 - bad.md'], root);
    const r = runCheck(root, { AI_SDLC_SKIP_DRIFT_GATE: '1' });
    assert.equal(r.status, 0, `expected 0 with skip-env, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /skipping strict drift gate/);
  });

  it('does NOT block when a task is RENAMED into backlog/completed/ (task_complete archive)', () => {
    // `task_complete` moves a file from tasks/ → completed/. That shows
    // up as a Rename in `git diff --cached`, and the source-side path
    // would falsely look "deleted" if we widened the diff filter to
    // include renames. Confirm the AM filter excludes the rename here.
    writeFileSync(
      join(root, 'backlog', 'tasks', 'aisdlc-206 - to-archive.md'),
      '---\nid: AISDLC-206\n---\n',
    );
    git(['add', 'backlog/tasks/aisdlc-206 - to-archive.md'], root);
    git(['commit', '-q', '-m', 'create task'], root);
    git(
      [
        'mv',
        'backlog/tasks/aisdlc-206 - to-archive.md',
        'backlog/completed/aisdlc-206 - to-archive.md',
      ],
      root,
    );
    // Even with a "fail-everything" shim, the rename should NOT trigger a check.
    installFakeNpx(root, { exitByTaskId: {}, defaultExit: 1 });
    const r = runCheck(root);
    assert.equal(r.status, 0, `archive rename must not invoke check: ${r.stderr}`);
  });
});
