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

const { readFileSync, readdirSync, realpathSync, lstatSync } = require('fs');
const { join, resolve, dirname, basename, sep } = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { resolveGovernanceExtrasFromYaml } = require('./governance-resolver');
const { taskBindingProblem } = require('./lease-push-guard');

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
 * Like mainCheckoutRoot, but cross-checks the candidate against the filesystem
 * because the common-dir chain (`.git` file -> gitdir -> commondir) is writable
 * by the governed agent: `<root>/.git` must be a real DIRECTORY (not a file or
 * symlink) whose realpath equals the reported common dir.
 */
function verifiedMainRoot(dir, run = runGit) {
  const root = mainCheckoutRoot(dir, run);
  if (!root) return null;
  try {
    const dotGit = join(root, '.git');
    const st = lstatSync(dotGit);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    const common = run(['rev-parse', '--git-common-dir'], dir);
    if (!common || safeReal(dotGit) !== safeReal(resolve(dir, common))) return null;
    return root;
  } catch {
    return null;
  }
}

/**
 * Policy file text; '' when the file does not exist (a repo that sets nothing
 * gets the resolver defaults, AISDLC-710). Any OTHER read failure throws so the
 * caller fails closed.
 */
function readPolicyText(path) {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Reads the policy from the main checkout of the project dir's repo, after
 * checking the tool's cwd belongs to the same repo. Returns the extras
 * ({forcePushMode, operational, protectedBranches}) or null when the trusted
 * policy cannot be determined.
 */
function loadTrustedExtras(projectDir, cwd, run = runGit) {
  try {
    const mainRoot = verifiedMainRoot(projectDir, run);
    if (!mainRoot) return null;
    const cwdMain = verifiedMainRoot(cwd, run);
    if (!cwdMain || safeReal(cwdMain) !== safeReal(mainRoot)) return null;
    return resolveGovernanceExtrasFromYaml(
      readPolicyText(join(mainRoot, '.ai-sdlc', 'agent-role.yaml')),
    );
  } catch {
    return null;
  }
}

function isUnder(child, parent) {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Inspects the dispatch board for the claim an executor session holds on `taskId`
 * (lower-case). The ONLY accepted shape: the hook's own env names a hierarchy
 * EXECUTOR session (set by `cli-hierarchy up`; the agent's Bash commands cannot
 * change it) and <board>/inflight/ holds EXACTLY ONE manifest claimed by that
 * session, for `taskId`. The claimer is the heartbeat `<task>.state.json` workerId
 * (unqualified role name such as `executor-alpha`); the session name may carry a
 * `<project>-` prefix. Every manifest must be a real file directly under inflight/
 * (no symlinks, nothing resolving elsewhere). Any error fails closed.
 *
 * @returns {{ held: boolean, failing: Array<object> }} `failing` names each unmet
 *   condition (empty when held).
 */
function inspectInflightClaim(boardDir, taskId, env) {
  const failing = [];
  const session = env.AI_SDLC_HIERARCHY_SESSION || '';
  if (!session || env.AI_SDLC_HIERARCHY_ROLE !== 'executor') {
    failing.push({
      condition: 'hierarchy-env',
      found: `AI_SDLC_HIERARCHY_SESSION=${session || '(unset)'}, AI_SDLC_HIERARCHY_ROLE=${env.AI_SDLC_HIERARCHY_ROLE || '(unset)'}`,
      expected:
        'AI_SDLC_HIERARCHY_SESSION=<session name> and AI_SDLC_HIERARCHY_ROLE=executor in the session launch env',
      fix: 'relaunch this executor with `cli-hierarchy down --role executor` then `cli-hierarchy up` from the main checkout; `cli-hierarchy clear` never relaunches a process',
    });
    return { held: false, failing };
  }
  const inflight = join(boardDir, 'inflight');
  const claimProblem = (found, fix) =>
    failing.push({
      condition: 'board-claim',
      found,
      expected: `exactly one inflight claim held by '${session}', for ${taskId}`,
      fix,
    });
  try {
    const realInflight = safeReal(inflight);
    if (realInflight !== inflight) {
      claimProblem(
        `${inflight} resolves elsewhere (${realInflight})`,
        'restore inflight/ as a real directory of the main checkout',
      );
      return { held: false, failing };
    }
    const MANIFEST_SUFFIX = '.dispatch.json';
    const mine = [];
    let taskManifest = false;
    let taskHeartbeat = false;
    let taskWorker = null;
    for (const file of readdirSync(inflight)) {
      if (!file.endsWith(MANIFEST_SUFFIX)) continue;
      const manifest = join(inflight, file);
      const st = lstatSync(manifest);
      if (!st.isFile() || st.isSymbolicLink() || dirname(safeReal(manifest)) !== realInflight) {
        claimProblem(
          `manifest ${file} is not a plain file directly under inflight/`,
          'remove the odd manifest through the dispatch CLI, or ask the dispatch session',
        );
        return { held: false, failing };
      }
      const claimed = file.slice(0, -MANIFEST_SUFFIX.length);
      const isTask = claimed.toLowerCase() === taskId;
      if (isTask) taskManifest = true;
      const stateFile = join(inflight, `${claimed}.state.json`);
      let sst;
      try {
        sst = lstatSync(stateFile);
      } catch (err) {
        if (err && err.code === 'ENOENT') continue; // no heartbeat yet: held by nobody we can name
        throw err;
      }
      if (!sst.isFile() || sst.isSymbolicLink() || dirname(safeReal(stateFile)) !== realInflight) {
        claimProblem(
          `heartbeat ${claimed}.state.json is not a plain file directly under inflight/`,
          'remove it and rewrite it with `cli-dispatch heartbeat`',
        );
        return { held: false, failing };
      }
      if (isTask) taskHeartbeat = true;
      const workerId = JSON.parse(readFileSync(stateFile, 'utf-8')).workerId;
      if (isTask) taskWorker = typeof workerId === 'string' ? workerId : null;
      if (typeof workerId !== 'string' || !workerId) continue;
      if (session === workerId || session.endsWith(`-${workerId}`)) {
        mine.push(claimed.toLowerCase());
      }
    }
    if (mine.length === 1 && mine[0] === taskId) return { held: true, failing };
    if (!taskManifest) {
      claimProblem(
        `no inflight manifest for ${taskId} (claims held by this session: ${mine.join(', ') || 'none'})`,
        'claim the task: `cli-hierarchy executor-start` from this session (it claims and writes the heartbeat)',
      );
    } else if (!taskHeartbeat) {
      failing.push({
        condition: 'heartbeat',
        found: `inflight/${taskId}.dispatch.json exists but inflight/${taskId}.state.json does not`,
        expected: `a heartbeat file naming '${session}' as workerId`,
        fix: `write it: cli-dispatch heartbeat --task-id ${taskId.toUpperCase()} --worker-id <your roster name> --worker-kind in-session-agent`,
      });
    } else if (
      taskWorker === null ||
      !(session === taskWorker || session.endsWith(`-${taskWorker}`))
    ) {
      claimProblem(
        `${taskId} is claimed by worker '${taskWorker ?? '(none)'}', not by session '${session}'`,
        'push from the executor that holds the claim, or ask the dispatch session to re-assign the task',
      );
    }
    if (mine.length > 1 || (mine.length === 1 && mine[0] !== taskId)) {
      claimProblem(
        `this session holds ${mine.length} claim(s): ${mine.join(', ')}`,
        'finish or release the other claim(s) so the session holds only this task (one task per executor context)',
      );
    }
    if (failing.length === 0) {
      claimProblem(
        `claims held by this session: ${mine.join(', ') || 'none'}`,
        'claim the task with `cli-hierarchy executor-start`',
      );
    }
    return { held: false, failing };
  } catch (err) {
    claimProblem(
      `the board could not be read (${err && err.message ? err.message : 'error'})`,
      'check .ai-sdlc/dispatch/inflight/ is readable',
    );
    return { held: false, failing };
  }
}

/** One line per failing condition: what was found, what is expected, the sanctioned fix. */
function renderLeaseFailing(failing) {
  return failing
    .map((f) => `  - ${f.condition}: found ${f.found}; expected ${f.expected}; fix: ${f.fix}`)
    .join('\n');
}

/**
 * The lease-push decision for a tool cwd, as ONE pure function (AISDLC-798). The
 * PreToolUse hook, the pipeline preflight (`next-step` ship, Step 11,
 * `cli-hierarchy executor-start`) and `ai-sdlc doctor lease-push-preflight` all
 * call it, so the refusal an executor meets at push time is the one it was
 * told about up front.
 *
 * The cwd must be a genuine dispatched worktree of the repo the policy was
 * loaded for. All of these must hold, else `allowed` is false and `failing`
 * lists each unmet condition as `{ condition, found, expected, fix }`:
 *  - `main-checkout`: the main checkout is verifiable (a real `.git` directory);
 *  - `project-dir`: the project dir is the main checkout or a worktree under it;
 *  - `worktree-location`: the worktree top (realpath, symlinks resolved) is a
 *    direct child of realpath(<mainRoot>)/.worktrees/;
 *  - `own-session`: a worktree-rooted session may only push from that worktree;
 *  - for a session rooted at the main checkout, either `AI_SDLC_ACTIVE_TASK_ID`
 *    equals the worktree's `.active-task`, or the worktree's `.active-task` (when
 *    present) agrees with its directory name AND the hierarchy executor holds
 *    exactly one board claim for it: `hierarchy-env`, `board-claim`, `heartbeat`,
 *    `sentinel-agreement`;
 *  - `worktree-registration`: the worktree's own git dir lives under
 *    <mainRoot>/.git/worktrees/ and its `gitdir` back-pointer leads to <top>/.git;
 *  - when `branch` is given: `active-task-sentinel`, `worktree-name`, `branch`
 *    (the same predicate `lease-push-guard` applies to the command).
 *
 * @param {object} args
 * @param {string} args.projectDir  the session's project dir (CLAUDE_PROJECT_DIR)
 * @param {string} args.cwd         the directory the push runs from
 * @param {object} [args.env]       the session env (default process.env)
 * @param {string} [args.branch]    the branch being pushed; omit to skip branch checks
 * @param {string} [args.boardDir]  dispatch board dir (default <main>/.ai-sdlc/dispatch)
 * @param {Function} [args.run]     git runner (tests)
 * @returns {{ allowed: boolean, failing: object[], mainRoot?: string, top?: string, claimTaskId?: string|null, taskId?: string|null }}
 */
function evaluateLeasePush({ projectDir, cwd, env = process.env, branch, boardDir, run = runGit }) {
  const failing = [];
  const fail = (condition, found, expected, fix) =>
    failing.push({ condition, found, expected, fix });
  const done = (extra = {}) => ({ allowed: failing.length === 0, failing, ...extra });
  try {
    // AISDLC-1005 (DEC-0264): under `allowForcePush: lease` (project copy AND trusted
    // main-checkout policy agree) no task binding applies, so nothing can be unmet.
    const trustedPolicy = loadTrustedExtras(projectDir, cwd, run);
    if (trustedPolicy && trustedPolicy.forcePushMode === 'lease') {
      const local = resolveGovernanceExtrasFromYaml(
        readPolicyText(join(projectDir, '.ai-sdlc', 'agent-role.yaml')),
      );
      if (local.forcePushMode === 'lease') return done();
    }
    const mainRoot = verifiedMainRoot(projectDir, run);
    if (!mainRoot) {
      fail(
        'main-checkout',
        `${projectDir} is not in a repository whose main checkout is a real .git directory`,
        'a normal (non-bare) clone with its task worktrees under .worktrees/',
        'run the push from a task worktree of the project clone',
      );
      return done();
    }
    const realMain = safeReal(mainRoot);
    const worktreesDir = join(realMain, '.worktrees');
    const realProj = safeReal(projectDir);
    if (realProj !== realMain && !isUnder(realProj, worktreesDir)) {
      fail(
        'project-dir',
        `session project dir ${realProj}`,
        `the main checkout ${realMain} or a worktree under ${worktreesDir}`,
        'launch the session from the project clone (CLAUDE_PROJECT_DIR must be absolute and explicit)',
      );
      return done();
    }
    const topRaw = run(['rev-parse', '--show-toplevel'], cwd);
    const top = topRaw ? safeReal(topRaw) : null;
    if (!top || !isUnder(top, worktreesDir) || dirname(top) !== worktreesDir) {
      fail(
        'worktree-location',
        `working directory resolves to ${top || '(not a git worktree)'}`,
        `a direct child of ${worktreesDir}`,
        'cd into the task worktree (.worktrees/<task-id>) before pushing',
      );
      return done();
    }
    const dirTask = basename(top).toLowerCase();
    const taskId = readTaskId(top);
    let claimTaskId = null;
    if (realProj !== realMain) {
      if (realProj !== top) {
        fail(
          'own-session',
          `session is rooted in ${realProj}, working directory is ${top}`,
          'the session project dir to be this very worktree',
          'push from the worktree the session was launched in, not a sibling it cd-ed into',
        );
      }
    } else {
      // A session rooted at the main checkout has no worktree of its own. It is
      // bound to ONE task by AI_SDLC_ACTIVE_TASK_ID (hook env), or, for a hierarchy
      // executor that claims its task only after launch, by the board claim it
      // holds. The claim path takes the task id from the worktree directory name:
      // a finished attempt's Step 13 removes the sentinel, which must not strand a
      // resumed executor. A sentinel that is present must agree with it.
      const bound = (env.AI_SDLC_ACTIVE_TASK_ID || '').toLowerCase();
      const envBound = !!bound && taskId === bound;
      if (!envBound) {
        const claim = inspectInflightClaim(
          boardDir || join(realMain, '.ai-sdlc', 'dispatch'),
          dirTask,
          env,
        );
        const sentinelOk = !taskId || taskId === dirTask;
        if (!(sentinelOk && claim.held)) {
          if (!sentinelOk) {
            fail(
              'sentinel-agreement',
              `.active-task names ${taskId}, the worktree directory is ${dirTask}`,
              'the sentinel to name the same task as the directory',
              `fix or delete ${join(top, '.active-task')} (resume rewrites it; Step 13 removes it)`,
            );
          }
          failing.push(...claim.failing);
        }
        // Only a claim-verified grant with NO sentinel supplies the guard's task id.
        if (!taskId && failing.length === 0) claimTaskId = dirTask;
      }
    }
    const gitDirRaw = run(['rev-parse', '--git-dir'], cwd);
    let registered = false;
    if (gitDirRaw) {
      try {
        const gitDir = safeReal(resolve(cwd, gitDirRaw));
        registered =
          isUnder(gitDir, join(realMain, '.git', 'worktrees')) &&
          safeReal(readFileSync(join(gitDir, 'gitdir'), 'utf-8').trim()) === join(top, '.git');
      } catch {
        registered = false;
      }
    }
    if (!registered) {
      fail(
        'worktree-registration',
        `${top} is not registered as a worktree of ${realMain}`,
        'a worktree created by `git worktree add` from the main checkout',
        'recreate the worktree with /ai-sdlc execute (Step 3) instead of copying a directory',
      );
    }
    const effectiveTask = taskId || claimTaskId;
    if (branch !== undefined && failing.length === 0) {
      const own = String(branch).replace(/^refs\/heads\//, '');
      const problem = taskBindingProblem(own, effectiveTask, basename(top));
      if (problem) {
        fail(problem.condition, problem.found, problem.expected, branchFix(problem.condition, top));
      }
    }
    return done({ mainRoot, top, claimTaskId, taskId: effectiveTask });
  } catch (err) {
    fail(
      'evaluation-error',
      String(err && err.message ? err.message : err),
      'the lease policy to be evaluable',
      'check the repository is readable',
    );
    return done();
  }
}

function branchFix(condition, top) {
  if (condition === 'branch') {
    return 'check out the task branch (ai-sdlc/<task-id> or ai-sdlc/<task-id>-<slug>) in this worktree';
  }
  if (condition === 'worktree-name')
    return 'run from the worktree directory named after the task id';
  return `write the task id into ${join(top, '.active-task')} (Step 4) or claim the task so the board names it`;
}

/**
 * Validates that the tool's cwd is a genuine dispatched worktree of the repo the
 * policy was loaded for, and returns its real root, or null when it is not (the
 * caller fails closed). The decision is {@link evaluateLeasePush}; this keeps the
 * hook's `{ mainRoot, top, claimTaskId }` shape.
 */
function resolveLeaseWorktree(projectDir, cwd, run = runGit) {
  const r = evaluateLeasePush({ projectDir, cwd, env: process.env, run });
  return r.allowed ? { mainRoot: r.mainRoot, top: r.top, claimTaskId: r.claimTaskId } : null;
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
  const wantsLease = copy.forcePushMode !== 'never';
  const wantsOps = hierarchyRole === 'operator-dispatch' && copy.operational.length > 0;
  if (!wantsLease && !wantsOps) return { resolved, operational: copy.operational };
  const trusted = loadTrustedExtras(projectDir, cwd, run);
  const mode = trusted ? minForcePushMode(copy.forcePushMode, trusted.forcePushMode) : 'never';
  const effective =
    wantsLease && mode === 'never'
      ? { ...resolved, allowForcePush: false }
      : wantsLease && mode !== copy.forcePushMode
        ? { ...resolved, forcePushMode: mode }
        : resolved;
  return { resolved: effective, operational: trusted ? trusted.operational : [] };
}

const FORCE_PUSH_RANK = { never: 0, leaseOnOwnBranch: 1, lease: 2 };

/** The stricter of two force-push modes: a PR-tree copy can only tighten the trusted grant. */
function minForcePushMode(a, b) {
  return (FORCE_PUSH_RANK[a] ?? 0) <= (FORCE_PUSH_RANK[b] ?? 0) ? a : b;
}

/**
 * Task id (lower-case) from the worktree's `.active-task`, or null when absent,
 * empty or malformed.
 */
function readTaskId(worktreeRoot) {
  try {
    const first = readFileSync(join(worktreeRoot, '.active-task'), 'utf-8').split('\n')[0].trim();
    // `AISDLC-663`, `AISDLC-100.5`, and the GH-issue form `gh-issue-123`.
    return /^[A-Za-z][A-Za-z0-9]*(-[A-Za-z][A-Za-z0-9]*)*-\d+(\.\d+)*$/.test(first)
      ? first.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

module.exports = {
  GIT_TIMEOUT_MS,
  minForcePushMode,
  runGit,
  probeRef,
  readPolicyText,
  safeReal,
  mainCheckoutRoot,
  verifiedMainRoot,
  resolveLeaseWorktree,
  evaluateLeasePush,
  renderLeaseFailing,
  inspectInflightClaim,
  loadTrustedExtras,
  bannerGovernance,
  readTaskId,
};
