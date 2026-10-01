/**
 * Trusted force-push policy resolution, shared by the PreToolUse hook (which
 * ENFORCES it) and the SessionStart / SubagentStart hooks (which RENDER it), so
 * the banner an agent reads can never claim a grant the enforcer would refuse.
 *
 * Trust model:
 *  - The project-dir copy of `.ai-sdlc/agent-role.yaml` may be a PR-tree copy
 *    (project dir inside a worktree). It can only TIGHTEN the lease grant: a
 *    `leaseOnOwnBranch` value there is honored only when the MAIN checkout of
 *    the same repo (parent of the git common dir, independent of the tool's
 *    cwd) says the same. A worktree copy saying `leaseOnOwnBranch` with a
 *    trusted `never` has no effect; the reverse (copy `never`, trusted lease)
 *    deliberately denies too. Both are tested.
 *  - The legacy `blockedActions` / `blockedPaths` lists are still read from the
 *    project dir (a PR-tree copy can clear them): that is the pre-existing
 *    trust model and is unchanged by this feature.
 *  - Any failure (git missing, timeout, odd layout, foreign cwd, unreadable
 *    file) fails closed to `never`.
 */

'use strict';

const { readFileSync, realpathSync } = require('fs');
const { join, resolve, dirname, basename } = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { resolveGovernanceExtrasFromYaml } = require('./governance-resolver');

const GIT_TIMEOUT_MS = 2000;

function gitEnv() {
  return { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
}

/** Runs git, returns trimmed stdout, or null on ANY failure/timeout/empty output. */
function runGit(args, cwd) {
  try {
    return (
      execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_TIMEOUT_MS,
        env: gitEnv(),
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * Probes whether a fully-qualified ref/revision exists.
 * Returns 'found' (exit 0), 'missing' (exit 1 from `--verify -q`), or 'error'
 * (spawn failure, timeout, signal, any other exit status): callers must treat
 * 'error' as UNKNOWN and fail closed, never as "does not exist".
 */
function probeRef(name, cwd) {
  const r = spawnSync('git', ['rev-parse', '-q', '--verify', name], {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: GIT_TIMEOUT_MS,
    env: gitEnv(),
  });
  if (r.error || r.signal) return 'error';
  if (r.status === 0) return 'found';
  if (r.status === 1) return 'missing';
  return 'error';
}

function safeReal(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Main checkout root of the repo `dir` belongs to, from the git COMMON dir.
 * Only a common dir that is literally `<root>/.git` is accepted; anything else
 * (bare repo, failure, odd layout) returns null and the caller fails closed.
 */
function mainCheckoutRoot(dir, run = runGit) {
  const common = run(['rev-parse', '--git-common-dir'], dir);
  if (!common) return null;
  const abs = resolve(dir, common);
  if (basename(abs) !== '.git') return null;
  return dirname(abs);
}

/**
 * Reads the policy from the main checkout of the project dir's repo, after
 * checking the tool's cwd belongs to the same repo. Returns the extras
 * ({forcePushMode, operational, protectedBranches}) or null when the trusted
 * policy cannot be determined.
 */
function loadTrustedExtras(projectDir, cwd, run = runGit) {
  try {
    const mainRoot = mainCheckoutRoot(projectDir, run);
    if (!mainRoot) return null;
    const cwdMain = mainCheckoutRoot(cwd, run);
    if (!cwdMain || safeReal(cwdMain) !== safeReal(mainRoot)) return null;
    const text = readFileSync(join(mainRoot, '.ai-sdlc', 'agent-role.yaml'), 'utf-8');
    return resolveGovernanceExtrasFromYaml(text);
  } catch {
    return null;
  }
}

/**
 * Decides what a SessionStart / SubagentStart banner may claim, using the same
 * trust rules as the enforcer. With no lease and no dispatch-role operational
 * list in the project-dir copy, NO git subprocess runs.
 *
 * @returns {{resolved: object, operational: string[]}}
 */
function bannerGovernance(yamlText, resolved, projectDir, cwd, hierarchyRole, run = runGit) {
  const copy = resolveGovernanceExtrasFromYaml(yamlText);
  const wantsLease = copy.forcePushMode === 'leaseOnOwnBranch';
  const wantsOps = hierarchyRole === 'operator-dispatch' && copy.operational.length > 0;
  if (!wantsLease && !wantsOps) return { resolved, operational: copy.operational };
  const trusted = loadTrustedExtras(projectDir, cwd, run);
  const effective =
    wantsLease && !(trusted && trusted.forcePushMode === 'leaseOnOwnBranch')
      ? { ...resolved, allowForcePush: false }
      : resolved;
  return { resolved: effective, operational: trusted ? trusted.operational : [] };
}

/**
 * Task id (lower-case) from the worktree's `.active-task`, or null when absent,
 * empty or malformed.
 */
function readTaskId(worktreeRoot) {
  try {
    const first = readFileSync(join(worktreeRoot, '.active-task'), 'utf-8').split('\n')[0].trim();
    return /^[A-Za-z][A-Za-z0-9]*-\d+(\.\d+)*$/.test(first) ? first.toLowerCase() : null;
  } catch {
    return null;
  }
}

module.exports = {
  GIT_TIMEOUT_MS,
  runGit,
  probeRef,
  safeReal,
  mainCheckoutRoot,
  loadTrustedExtras,
  bannerGovernance,
  readTaskId,
};
