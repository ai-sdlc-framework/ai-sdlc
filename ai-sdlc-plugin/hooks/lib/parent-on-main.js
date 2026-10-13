/**
 * Parent-on-main guard (AISDLC-764). Pure decision logic for two hooks:
 *
 *  - SessionStart: the Pattern C parent checkout must be on `main`. A clean
 *    parent on another branch is switched back with a plain `git checkout main`
 *    (non-destructive: it refuses on its own when it would lose work); a dirty
 *    parent is reported and never touched.
 *  - PreToolUse: no Edit/Write/MultiEdit into the parent working tree (outside
 *    `.worktrees/` and a short list of runtime directories; paths compared by
 *    realpath), and no branch creation or switch to a non-main branch
 *    (`git checkout -b`, `git switch -c`, `git checkout <branch>`) with the
 *    parent as the working directory. The command is tokenised (quotes
 *    stripped, git global options skipped, `cd <dir> &&` tracked). This is a
 *    guard against accidents, not a shell sandbox: eval, scripts and variable
 *    expansion are out of reach. Edits belong in `.worktrees/<task-id>/`.
 *
 * "Parent" means a Pattern C parent: the main checkout whose `.worktrees/`
 * directory holds at least one worktree. Any other repository (an adopter
 * project, a plain clone) is outside this guard and always allowed. Resolution
 * is by `git rev-parse --git-common-dir`, so a task worktree resolves to its
 * parent and a path inside the worktree is never "the parent".
 *
 * No environment bypass exists: the next step on a refusal is the worktree.
 */

const { readdirSync, realpathSync, statSync } = require('fs');
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

const REFUSAL_NEXT =
  'Work in a task worktree under .worktrees/<task-id>/ (the /ai-sdlc execute flow creates one).';

/** realpath of `p`, or of its nearest existing ancestor plus the remainder (new files). */
function realish(p) {
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.push(basename(cur));
      cur = up;
    }
  }
}

/**
 * Split a shell command into segments of unquoted words. Quotes and
 * backslashes are removed; `;`, `&`, `|`, newlines and parentheses outside
 * quotes separate segments. Approximate on purpose: it must see through the
 * quoting and option tricks that defeat a regex, not execute a shell.
 */
function shellSegments(cmd) {
  const segments = [];
  let words = [];
  let cur = '';
  let inWord = false;
  let quote = null;
  const endWord = () => {
    if (inWord) words.push(cur);
    cur = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      inWord = true;
    } else if (/\s/.test(c) && c !== '\n') {
      endWord();
    } else if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      endSegment();
    } else {
      cur += c;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

const GLOBAL_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const WRAPPERS = new Set(['env', 'command', 'exec', 'time', 'nohup', 'sudo']);

/**
 * Parse one segment into `{ dir, sub, args }` when it is a `git` call, applying
 * global options (`-C <path>`, `--work-tree`). Returns null otherwise.
 */
function parseGitCall(words, dir) {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(words[i])))
    i++;
  if (words[i] !== 'git') return null;
  i++;
  let d = dir;
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i];
    const eq = w.indexOf('=');
    const name = eq === -1 ? w : w.slice(0, eq);
    if (GLOBAL_OPTS_WITH_VALUE.has(name)) {
      const value = eq === -1 ? words[++i] : w.slice(eq + 1);
      if (name === '-C' && value) d = resolve(d, value);
      else if (name === '--work-tree' && value) d = resolve(d, value);
    }
    i++;
  }
  if (i >= words.length) return null;
  return { dir: d, sub: words[i], args: words.slice(i + 1) };
}

const CHECKOUT_CREATE = /^-[A-Za-z]*[bB]/;
const SWITCH_CREATE = /^-[A-Za-z]*[cC]/;

/** Whether a git checkout/switch call creates a branch. */
function createsBranch(sub, args) {
  for (const a of args) {
    if (a === '--') return false;
    if (a === '--orphan' || a.startsWith('--orphan=')) return true;
    if (sub === 'switch' && (a === '--create' || a === '--force-create')) return true;
    if (a.startsWith('--')) continue;
    if (sub === 'checkout' && CHECKOUT_CREATE.test(a)) return true;
    if (sub === 'switch' && SWITCH_CREATE.test(a)) return true;
  }
  return false;
}

/** The first positional (non-option) argument before `--`, or null. */
function firstPositional(args) {
  for (const a of args) {
    if (a === '--') return null;
    if (!a.startsWith('-')) return a;
  }
  return null;
}

/** True when `name` is an existing local branch of the repo at `dir`. */
function isLocalBranch(dir, name, git) {
  try {
    git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect a Bash command for a branch create or a switch to a non-main branch
 * whose working directory is the parent checkout. Returns a reason or null.
 */
function evaluateBashCommand(cmd, cwd, git) {
  let dir = cwd;
  for (const words of shellSegments(cmd)) {
    const head = words.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (head !== -1 && (words[head] === 'cd' || words[head] === 'pushd')) {
      const target = words.slice(head + 1).find((w) => !w.startsWith('-'));
      if (target) dir = resolve(dir, target);
      continue;
    }
    const call = parseGitCall(words, dir);
    if (!call || (call.sub !== 'checkout' && call.sub !== 'switch')) continue;
    const creating = createsBranch(call.sub, call.args);
    const target = creating ? null : firstPositional(call.args);
    if (!creating && !target) continue;
    if (!creating && (target === 'main' || target === '-')) continue;
    const root = findParentRoot(call.dir, git);
    if (!root) continue;
    let top = '';
    try {
      top = git(call.dir, ['rev-parse', '--show-toplevel']);
    } catch {
      top = '';
    }
    // A worktree's toplevel is the worktree itself; only the parent's own is the root.
    if (!top || realish(top) !== realish(root)) continue;
    if (creating) {
      return `Creating a branch in the parent checkout (${root}) is refused: it must stay on main. ${REFUSAL_NEXT}`;
    }
    if (call.sub === 'switch' || isLocalBranch(call.dir, target, git)) {
      return `Switching the parent checkout (${root}) to '${target}' is refused: it must stay on main. ${REFUSAL_NEXT}`;
    }
  }
  return null;
}

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
    // Compare real paths so a symlink or `..` cannot dodge the guard.
    const abs = realish(isAbsolute(fp) ? fp : resolve(cwd, fp));
    const root = findParentRoot(dirname(abs), git) ?? findParentRoot(cwd, git);
    if (!root) return null;
    if (isGuardedParentPath(abs, realish(root))) {
      return `${tool} into the parent checkout (${abs}) is refused: the parent working tree is read-only and stays on main. ${REFUSAL_NEXT}`;
    }
    return null;
  }
  if (tool === 'Bash') {
    const cmd = ti.command;
    if (typeof cmd !== 'string') return null;
    return evaluateBashCommand(cmd, cwd, git);
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
  shellSegments,
  findParentRoot,
  isGuardedParentPath,
  evaluatePreToolUse,
  checkParentOnMain,
};
