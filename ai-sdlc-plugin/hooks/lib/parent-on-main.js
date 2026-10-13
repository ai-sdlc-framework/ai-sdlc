/**
 * Parent-on-main guard (AISDLC-764). Pure decision logic for two hooks:
 *
 *  - SessionStart: the Pattern C parent checkout must be on `main`. A clean
 *    parent on another branch is switched back with a plain `git checkout main`
 *    (non-destructive: it refuses on its own when it would lose work); a dirty
 *    parent is reported and never touched.
 *  - PreToolUse: no Edit/Write/MultiEdit into the parent working tree (outside
 *    `.worktrees/` and a short list of runtime directories), and no branch
 *    creation (`git checkout -b`, `git switch -c`) with the parent as the
 *    working directory. Edits belong in `.worktrees/<task-id>/`.
 *
 * "Parent" means a Pattern C parent: the main checkout whose `.worktrees/`
 * directory holds at least one worktree. Any other repository (an adopter
 * project, a plain clone) is outside this guard and always allowed. Resolution
 * is by `git rev-parse --git-common-dir`, so a task worktree resolves to its
 * parent and a path inside the worktree is never "the parent".
 *
 * No environment bypass exists: the next step on a refusal is the worktree.
 */

const { readdirSync, statSync } = require('fs');
const { basename, dirname, isAbsolute, join, resolve, sep } = require('path');
const { execFileSync } = require('child_process');

/** Runtime directories under the parent that tools legitimately write (never source). */
const PARENT_WRITE_ALLOWLIST = [
  '.worktrees',
  '.claude',
  '.ai-sdlc/dispatch',
  '.ai-sdlc/_audit',
  '.ai-sdlc/reviews',
  '.ai-sdlc/transcript-leaves',
];

function defaultGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  }).trim();
}

/** The Pattern C parent root for `cwd`, or null when `cwd` is not in one. */
function findParentRoot(cwd, git = defaultGit) {
  let common;
  try {
    common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  } catch {
    return null;
  }
  if (!common || basename(common) !== '.git') return null;
  const root = dirname(common);
  try {
    const wt = join(root, '.worktrees');
    const hasWorktree = readdirSync(wt).some((e) => {
      try {
        return statSync(join(wt, e)).isDirectory();
      } catch {
        return false;
      }
    });
    return hasWorktree ? root : null;
  } catch {
    return null;
  }
}

const within = (child, parent) => child === parent || child.startsWith(parent + sep);

/** True when `absPath` is inside the parent working tree and not in an allowed runtime dir. */
function isGuardedParentPath(absPath, parentRoot) {
  const p = resolve(absPath);
  if (!within(p, parentRoot)) return false;
  return !PARENT_WRITE_ALLOWLIST.some((d) => within(p, join(parentRoot, d)));
}

const BRANCH_CREATE =
  /(?:^|[\s;&|(])git\s+(?:-C\s+(\S+)\s+)?(?:checkout\s+(?:-[bB]\b|--orphan\b)|switch\s+(?:-[cC]\b|--create\b|--force-create\b|--orphan\b))/;

const REFUSAL_NEXT =
  'Work in a task worktree under .worktrees/<task-id>/ (the /ai-sdlc execute flow creates one).';

/**
 * PreToolUse decision. Returns a reason string to deny, or null to allow.
 * @param {{tool_name?: string, tool_input?: object, cwd?: string}} input
 */
function evaluatePreToolUse(input, { git = defaultGit, fallbackCwd = process.cwd() } = {}) {
  const tool = input && input.tool_name;
  const ti = (input && input.tool_input) || {};
  const cwd = (input && input.cwd) || fallbackCwd;
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') {
    const fp = ti.file_path;
    if (typeof fp !== 'string' || fp === '') return null;
    const abs = isAbsolute(fp) ? fp : resolve(cwd, fp);
    const root = findParentRoot(dirname(abs), git) ?? findParentRoot(cwd, git);
    if (!root) return null;
    if (isGuardedParentPath(abs, root)) {
      return `${tool} into the parent checkout (${abs}) is refused: the parent working tree is read-only and stays on main. ${REFUSAL_NEXT}`;
    }
    return null;
  }
  if (tool === 'Bash') {
    const cmd = ti.command;
    if (typeof cmd !== 'string') return null;
    const m = BRANCH_CREATE.exec(cmd);
    if (!m) return null;
    const dir = m[1] ? (isAbsolute(m[1]) ? m[1] : resolve(cwd, m[1])) : cwd;
    const root = findParentRoot(dir, git);
    if (!root) return null;
    const top = (() => {
      try {
        return git(dir, ['rev-parse', '--show-toplevel']);
      } catch {
        return '';
      }
    })();
    // A worktree's toplevel is the worktree itself; only the parent's own is the root.
    if (top && resolve(top) === resolve(root)) {
      return `Creating a branch in the parent checkout (${root}) is refused: it must stay on main. ${REFUSAL_NEXT}`;
    }
    return null;
  }
  return null;
}

/**
 * SessionStart check. Returns `{status, message?}`; status is one of
 * `skip` (not a Pattern C parent session), `ok`, `recovered`, `dirty`, `error`.
 */
function checkParentOnMain(cwd, { git = defaultGit } = {}) {
  const root = findParentRoot(cwd, git);
  if (!root) return { status: 'skip' };
  let top;
  try {
    top = git(cwd, ['rev-parse', '--show-toplevel']);
  } catch (err) {
    return {
      status: 'error',
      message: `parent-on-main: cannot resolve the checkout: ${err.message}`,
    };
  }
  if (resolve(top) !== resolve(root)) return { status: 'skip' }; // a task worktree session
  let branch;
  try {
    branch = git(root, ['symbolic-ref', '--short', 'HEAD']);
  } catch {
    branch = '(detached)';
  }
  if (branch === 'main' || branch.startsWith('gh-readonly-queue/')) return { status: 'ok', branch };
  let dirty;
  try {
    dirty = git(root, ['status', '--porcelain', '--untracked-files=no']);
  } catch (err) {
    return {
      status: 'error',
      message: `parent-on-main: cannot read the parent status: ${err.message}`,
    };
  }
  if (dirty) {
    const paths = dirty.split('\n').slice(0, 10).join(', ');
    return {
      status: 'dirty',
      branch,
      message: `parent-on-main: the parent checkout ${root} is on '${branch}', not main, and has uncommitted changes (${paths}). It was NOT touched. Commit or move those changes into a worktree, then run: git -C ${root} checkout main`,
    };
  }
  try {
    git(root, ['checkout', 'main']);
  } catch (err) {
    return {
      status: 'error',
      branch,
      message: `parent-on-main: the parent checkout ${root} is on '${branch}' and 'git checkout main' failed: ${err.message}. Run it by hand.`,
    };
  }
  return {
    status: 'recovered',
    branch,
    message: `parent-on-main: the parent checkout ${root} was on '${branch}'; switched it back to main (clean tree).`,
  };
}

module.exports = {
  PARENT_WRITE_ALLOWLIST,
  findParentRoot,
  isGuardedParentPath,
  evaluatePreToolUse,
  checkParentOnMain,
};
