/**
 * Own-branch force-with-lease guard (RFC-0051 section 10).
 *
 * Pure decision logic for `allowForcePush: leaseOnOwnBranch`. It is only
 * consulted when the trusted policy resolved to `leaseOnOwnBranch`; under
 * `never` the hook never calls it, so behavior there is unchanged.
 *
 * evaluateLeasePush(command, ctx) returns one of:
 *   { decision: 'none' }            not a force-ish git push — caller proceeds
 *                                   with its normal (unchanged) checks
 *   { decision: 'allow' }           a single, fully-parsed `git push` with a
 *                                   lease whose every target is the worktree's
 *                                   own, non-protected branch
 *   { decision: 'deny', reason }    force-ish push that is not positively
 *                                   allowed — block
 *
 * Posture: positively parse or block. The ALLOW shape is deliberately small:
 *   git push [<configured-remote-name>] [--force-with-lease[=<own>[:<sha>]]]
 *       [--force-if-includes] [-u|--set-upstream] [-q|-v] [<refspec>...]
 * with no quoting, no shell metacharacters, no wrapper/env prefix, no git
 * global options. Accepted refspecs are those whose destination is unambiguously
 * refs/heads/<own>: `HEAD`, `HEAD:refs/heads/<own>`,
 * `<own>:refs/heads/<own>`, `refs/heads/<own>:refs/heads/<own>`. When the remote
 * and/or refspec are omitted the REAL destination is resolved from git config
 * (remote.<name>.push, remote.<name>.mirror, push.default, branch.<own>.merge,
 * branch.<own>.pushRemote, remote.pushDefault) and the push is allowed only when
 * that provably lands on refs/heads/<own> on a configured remote (AISDLC-710).
 * A bare name without a colon (`<own>`, `refs/heads/<own>`) stays refused: git
 * maps it through the config and it can land on main. A short destination
 * (`<own>:<own>`) stays refused too: it is matched against remote refs we cannot
 * see (a tag of that name would win). Anything else that looks like a force-ish
 * push is denied.
 *
 * ctx (all injected so tests never touch git):
 *   ownRef:            string | null  — FULL ref the worktree has checked out
 *                                       (`git symbolic-ref -q HEAD`); must be
 *                                       `refs/heads/<name>`
 *   taskId:            string | null  — lower-case task id from the worktree's
 *                                       `.active-task` (null = absent/malformed)
 *   worktreeName:      string | null  — basename of the worktree root directory
 *   refAliasState:     (name) => 'clear' | 'collides' | 'error'
 *                                     — whether a local ref OTHER than
 *                                       refs/heads/<name> answers to the short
 *                                       name `<name>` (tag, refs/<name>,
 *                                       refs/remotes/<name>...); 'error' = unknown
 *   protectedBranches: string[]       — policy-listed protected names (exact
 *                                       or trailing `*` prefix)
 *   remotes:           string[]       — configured remote NAMES
 *   aliasLookup:       (name) => string | null — git alias value, if any
 *   pushConfig:        (key) => string[] | null — every value of a git config
 *                                       key ([] = unset, null = unknown/error,
 *                                       which fails closed). Only consulted for
 *                                       the implicit-remote / implicit-refspec
 *                                       forms.
 *
 * Like the stash guard, a static matcher cannot defeat a deliberately hostile
 * agent (`X=--force; git push $X` style variable state is treated as
 * unparseable and denied only when the command also mentions a git push); it
 * exists to stop accidental and common-shape force pushes.
 */

'use strict';

// Always protected, merged with the policy's `protectedBranches`. Entries may
// use `*` (matches any run of characters).
const DEFAULT_PROTECTED = [
  'main',
  'master',
  'release-please--branches--*',
  'gh-pages',
  'production',
  'prod',
  'release/*',
  'releases/*',
];
// Pseudo-ref names git resolves from the git dir itself (rule `<name>`).
const PSEUDO_REF_RE = /^[A-Z_]+$/;
const WRAPPERS = new Set(['env', 'command', 'exec', 'sudo', 'nohup', 'time', 'builtin', 'xargs']);
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
// First path segments git's short-name resolution can reinterpret as a
// different ref namespace (`heads/x` -> refs/heads/x, `tags/x`, `remotes/...`).
const AMBIGUOUS_FIRST_SEGMENTS = new Set(['refs', 'heads', 'tags', 'remotes']);
// Long options (after `--`) whose abbreviations must be treated as force-ish.
const FORCEISH_LONG = ['force', 'mirror', 'delete', 'prune', 'all'];
const FORCE_CONFIG_ENV_RE = /^GIT_CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS)/;

/** `refs/heads/<x>` -> `<x>`; otherwise null. */
function branchFromRef(ref) {
  return typeof ref === 'string' && ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : null;
}

/** A branch short name safe to compare textually against refspec text. */
function isPlainBranchName(name) {
  if (typeof name !== 'string' || !BRANCH_RE.test(name) || name.startsWith('-')) return false;
  if (PSEUDO_REF_RE.test(name)) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//') || name.includes('..')) {
    return false;
  }
  return !AMBIGUOUS_FIRST_SEGMENTS.has(name.split('/')[0]);
}
const SAFE_COMPANION_FLAGS = new Set([
  '--force-if-includes',
  '-u',
  '--set-upstream',
  '-q',
  '--quiet',
  '-v',
  '--verbose',
]);
const FALSE_BOOL = new Set(['false', 'no', 'off', '0', '']);

/** Echoes a refused flag, except force/hook-skipping spellings (never repeated back as options). */
function describeFlag(t) {
  if (/^--?[A-Za-z-]+$/.test(t) && !/force(?!-)|verify|^-[^-]*f/.test(t)) return `'${t}'`;
  return '(a plain force or hook-skipping flag)';
}
const META_RE = /[;&|<>`$\\()\n\r*?[\]{}!#~'"]/;

/** Simple `*` glob, case-insensitive; an odd pattern fails closed (matches everything). */
function globMatch(pattern, name) {
  const p = pattern.toLowerCase();
  if (!/^[a-z0-9._/*-]+$/.test(p)) return true;
  const re = new RegExp(
    `^${p
      .split('*')
      .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  return re.test(name.toLowerCase());
}

function isProtectedBranch(name, protectedBranches) {
  const short = name.replace(/^refs\/heads\//, '');
  for (const p of [...DEFAULT_PROTECTED, ...(protectedBranches || [])]) {
    if (globMatch(p, short)) return true;
  }
  return false;
}

/** Strips quotes/backslashes, then splits into shell segments of tokens. */
function toSegments(command) {
  const flat = command.replace(/['"\\]/g, '');
  return flat
    .split(/[;&|\n\r`(){}]|\$\(/)
    .map((seg) => seg.split(/[ \t]+/).filter(Boolean)) // bash word splitting, not JS \s
    .filter((toks) => toks.length > 0);
}

function basename(tok) {
  const i = tok.lastIndexOf('/');
  return i === -1 ? tok : tok.slice(i + 1);
}

/** Index of the `git` token in a segment, allowing only wrapper/assignment prefixes. */
function findGitIndex(toks) {
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (basename(t) === 'git') return i;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || WRAPPERS.has(t) || t.startsWith('-')) continue;
    return -1;
  }
  return -1;
}

function isForceish(tok) {
  if (tok.startsWith('--')) {
    const body = tok.slice(2).split('=')[0];
    if (body === '') return false;
    // Any (abbreviated) prefix of a force-class option; `--follow-tags` is not.
    return FORCEISH_LONG.some((o) => o.startsWith(body) || body.startsWith('force'));
  }
  if (tok.startsWith('-')) return /^-[^-]*[fd]/.test(tok);
  return tok.startsWith('+') || tok.startsWith(':') || /:$/.test(tok);
}

/** True when the segment is (or may be) a `git push`. Returns reason-ish info. */
function classifySegment(toks, aliasLookup) {
  const gi = findGitIndex(toks);
  if (gi === -1) return { push: false };
  const after = toks.slice(gi + 1);
  const envConfig = toks.slice(0, gi).some((t) => FORCE_CONFIG_ENV_RE.test(t));
  const hasDollar = toks.some((t) => t.includes('$'));
  // Skip git global options to find the subcommand.
  let i = 0;
  let aliasOverride = false;
  while (i < after.length && after[i].startsWith('-')) {
    const o = after[i];
    if (o === '-c') {
      if (/^alias\./i.test(after[i + 1] || '')) aliasOverride = true;
      i += 2;
    } else if (['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(o)) {
      i += 2;
    } else {
      i += 1;
    }
  }
  const sub = after[i];
  if (sub === undefined) return { push: false };
  let isPush = sub === 'push';
  if (!isPush && typeof aliasLookup === 'function' && /^[A-Za-z0-9_-]+$/.test(sub)) {
    const a = aliasLookup(sub);
    if (typeof a === 'string' && /push/.test(a)) {
      isPush = true;
      // A force flag baked into the alias body cannot be bounded: treat as force-ish.
      if (a.split(/\s+/).some(isForceish)) aliasOverride = true;
    }
  }
  if (aliasOverride || (hasDollar && after.some((t) => t === 'push' || t.includes('$')))) {
    isPush = isPush || after.some((t) => t === 'push' || t.includes('push'));
  }
  if (envConfig) isPush = true; // injected git config can define any alias
  return {
    push: isPush,
    rest: after.slice(i + 1),
    unparseable: aliasOverride || hasDollar || envConfig,
  };
}

/**
 * Destination check for a lease push with NO refspec: returns a problem string, or
 * null when git provably sends the current branch to refs/heads/<own> on `remote`.
 * Any config lookup that fails (null) is a problem (fail closed).
 */
function implicitDestinationProblem(remote, own, full, cfg) {
  const mirror = cfg(`remote.${remote}.mirror`);
  if (mirror === null) return 'remote.<name>.mirror could not be read from git config';
  if (mirror.some((v) => !FALSE_BOOL.has(v.toLowerCase()))) {
    return `remote '${remote}' is a mirror remote (a push would update every ref)`;
  }
  const pushSpecs = cfg(`remote.${remote}.push`);
  if (pushSpecs === null) return `remote.${remote}.push could not be read from git config`;
  if (pushSpecs.length > 0) {
    const ok = new Set([`HEAD:${full}`, `${own}:${full}`, `${full}:${full}`]);
    const bad = pushSpecs.find((v) => !ok.has(v));
    return bad === undefined
      ? null
      : `remote.${remote}.push maps the push to '${bad}', not only to ${full}`;
  }
  const pd = cfg('push.default');
  if (pd === null) return 'push.default could not be read from git config';
  const mode = pd.length ? pd[pd.length - 1] : 'simple';
  if (mode === 'simple' || mode === 'current') return null;
  if (mode === 'upstream' || mode === 'tracking') {
    const merge = cfg(`branch.${own}.merge`);
    if (merge === null) return `branch.${own}.merge could not be read from git config`;
    return merge.length === 1 && merge[0] === full
      ? null
      : `push.default=${mode} sends the branch to its upstream (branch.${own}.merge), not to ${full}`;
  }
  return `push.default=${mode} could send this push somewhere other than ${full}`;
}

function parseAllowedShape(command, ctx) {
  if (/[^\x20-\x7e\t]/.test(command)) return 'non-printable or non-ASCII characters present';
  if (META_RE.test(command)) return 'shell metacharacters, quoting or expansion present';
  const toks = command.trim().split(/[ \t]+/);
  if (toks[0] !== 'git' || toks[1] !== 'push') {
    return 'must be exactly `git push ...` (no wrapper, env prefix or git global options)';
  }
  const own = branchFromRef(ctx.ownRef);
  if (!own || !isPlainBranchName(own)) {
    return 'current worktree branch cannot be determined or has an ambiguous name';
  }
  if (isProtectedBranch(own, ctx.protectedBranches)) {
    return `own branch '${own}' is protected`;
  }
  // Bind "own" to the dispatched TASK branch: the task id comes from the
  // worktree's .active-task, the worktree directory must be named after it, and
  // the branch must carry the task prefix (pattern `ai-sdlc/{issueIdLower}-{slug}`).
  // All three must agree; any missing piece denies (operator sessions without a
  // sentinel get no lease push).
  if (!ctx.taskId) return 'no valid .active-task sentinel in this worktree';
  if (ctx.worktreeName !== ctx.taskId) {
    return `worktree directory '${ctx.worktreeName}' does not match task '${ctx.taskId}'`;
  }
  if (!own.startsWith(`ai-sdlc/${ctx.taskId}-`)) {
    return `branch '${own}' is not this task's branch (ai-sdlc/${ctx.taskId}-*)`;
  }
  // Short-name aliasing: git resolves a bare name against local refs with every
  // rule (refs/tags/<x>, refs/<x>, refs/remotes/<x>, ...). Refuse unless no
  // other local ref answers to the name (unknown counts as colliding).
  if (typeof ctx.refAliasState !== 'function' || ctx.refAliasState(own) !== 'clear') {
    return `a ref other than refs/heads/${own} answers to the name '${own}' (or this could not be checked)`;
  }
  let lease = false;
  const positionals = [];
  for (const t of toks.slice(2)) {
    if (t === '--force-with-lease') {
      lease = true;
    } else if (t.startsWith('--force-with-lease=')) {
      const val = t.slice('--force-with-lease='.length);
      const m = val.match(/^([A-Za-z0-9._/-]+)(?::[0-9a-fA-F]{7,64})?$/);
      if (!m) return 'malformed --force-with-lease value';
      const leaseRef = m[1].replace(/^refs\/heads\//, '');
      if (leaseRef !== own) return 'lease must name the own branch (or none)';
      lease = true;
    } else if (SAFE_COMPANION_FLAGS.has(t)) {
      // safe companions
    } else if (t.startsWith('-')) {
      return `flag ${describeFlag(t)} is not permitted with a lease push`;
    } else {
      positionals.push(t);
    }
  }
  if (!lease) return 'no --force-with-lease';
  const full = `refs/heads/${own}`;
  const cfg = (key) => (typeof ctx.pushConfig === 'function' ? ctx.pushConfig(key) : null);
  let [remote, ...refspecs] = positionals;
  if (!remote) {
    // No remote given: git picks branch.<own>.pushRemote, then remote.pushDefault,
    // then branch.<own>.remote, then `origin`. Resolve it the same way.
    const found = [`branch.${own}.pushRemote`, 'remote.pushDefault', `branch.${own}.remote`].map(
      cfg,
    );
    if (found.some((v) => v === null)) {
      return 'the push remote could not be resolved from git config';
    }
    const first = found.map((v) => v[v.length - 1]).find((v) => v !== undefined);
    remote = first === undefined ? 'origin' : first;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(remote) || !(ctx.remotes || []).includes(remote)) {
    return `remote '${remote}' is not a configured remote name`;
  }
  if (refspecs.length === 0) {
    const problem = implicitDestinationProblem(remote, own, full, cfg);
    if (problem) return problem;
  }
  for (const spec of refspecs) {
    const parts = spec.split(':');
    if (parts.length > 2) return `refspec '${spec}' is not a simple branch refspec`;
    const [src, dst] = parts;
    if (!src || (parts.length === 2 && !dst)) return `refspec '${spec}' is empty or a delete`;
    if (parts.length === 1) {
      // Only bare `HEAD` is accepted without a colon: git documents it as "push the
      // current branch to the same name on the remote" and it resolves locally to the
      // checked-out branch (verified against real git with push.default=upstream and
      // remote.<name>.push mapped to main). Any OTHER no-colon name (`<own>`,
      // `refs/heads/<own>`) is mapped by git through remote.<name>.push /
      // push.default / branch.<own>.merge, which for a task branch cut from
      // origin/main is refs/heads/main (also verified against real git), so it stays refused.
      if (spec === 'HEAD') continue;
      return (
        `the no-colon refspec '${spec}' is refused (git may map it through remote.<name>.push / ` +
        `push.default / branch.<own>.merge to another ref, not necessarily ${full}); spell it ` +
        `'HEAD' or 'HEAD:${full}'`
      );
    }
    // Colon form: git resolves a destination that is not fully qualified
    // against the REMOTE with every rule (`<x>`, refs/<x>, refs/tags/<x>,
    // refs/heads/<x>, ...), tags before heads, so `<own>` could overwrite a
    // remote tag/notes/meta ref of that name. Only the fully-qualified form is
    // unambiguous, so it is the only one accepted: aliasing is impossible by
    // construction and no remote lookup is needed.
    if (src !== 'HEAD' && src !== own && src !== full) {
      return `refspec source '${src}' is not the own branch`;
    }
    if (dst !== full) {
      return `destination '${dst}' must be spelled refs/heads/${own} (e.g. HEAD:refs/heads/${own})`;
    }
  }
  return null;
}

function evaluateLeasePush(command, ctx) {
  if (typeof command !== 'string' || !command.trim()) return { decision: 'none' };
  const segments = toSegments(command);
  let anyForcePush = false;
  for (const toks of segments) {
    const c = classifySegment(toks, ctx.aliasLookup);
    if (!c.push) continue;
    // `-c alias.*` or `$` expansion on a push is unparseable: treat as force-ish.
    const forceish = c.unparseable || (c.rest || []).some(isForceish);
    if (forceish) anyForcePush = true;
  }
  if (!anyForcePush) return { decision: 'none' };
  const why = parseAllowedShape(command, ctx);
  if (why === null) return { decision: 'allow' };
  const ownName = branchFromRef(ctx.ownRef);
  const shown = ownName && isPlainBranchName(ownName) ? ownName : '<own-branch>';
  return {
    decision: 'deny',
    reason:
      `force-push under spec.governance.allowForcePush=leaseOnOwnBranch (.ai-sdlc/agent-role.yaml) ` +
      `is limited to a 'git push --force-with-lease' on this task's own branch (non-protected) (${why}). ` +
      `Plain force pushes, +refspecs, pushes to main/master or protected branches, and pushes to a ` +
      `branch this task does not own are never permitted. From the task worktree, push with ` +
      `'git push --force-with-lease origin HEAD:refs/heads/${shown}'.`,
  };
}

/**
 * Force-push detection for the DEFAULT (`never`) policy: true when a `git push`
 * segment carries a force option, `--force-with-lease`, or a `+refspec`
 * anywhere in its args. Narrower than the lease-mode force-ish test on purpose
 * (no delete/mirror/all/`:ref`, no `$`/alias/env heuristics) and needs no git.
 */
function hasForcePushOption(command) {
  if (typeof command !== 'string') return false;
  for (const toks of toSegments(command)) {
    const c = classifySegment(toks, undefined);
    if (!c.push) continue;
    for (const t of c.rest || []) {
      if (t.startsWith('--')) {
        const body = t.slice(2).split('=')[0];
        if (body.startsWith('force') || (body.length >= 3 && 'force'.startsWith(body))) return true;
      } else if (t.startsWith('-')) {
        if (/^-[^-]*f/.test(t)) return true;
      } else if (t.startsWith('+')) {
        return true;
      }
    }
  }
  return false;
}

module.exports = { evaluateLeasePush, isProtectedBranch, hasForcePushOption };
