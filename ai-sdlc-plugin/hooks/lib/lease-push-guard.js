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
 * Posture: positively parse or block. The ALLOW shape is deliberately tiny:
 *   git push <configured-remote-name> [--force-with-lease[=<own>[:<sha>]]]
 *       [--force-if-includes] [-u|--set-upstream] <refspec>...
 * with no quoting, no shell metacharacters, no wrapper/env prefix, no git
 * global options. Anything else that looks like a force-ish push is denied.
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
    } else if (t === '--force-if-includes' || t === '-u' || t === '--set-upstream') {
      // safe companions
    } else if (t.startsWith('-')) {
      return `flag '${t}' is not permitted with a lease push`;
    } else {
      positionals.push(t);
    }
  }
  if (!lease) return 'no --force-with-lease';
  const [remote, ...refspecs] = positionals;
  if (!remote) return 'no explicit remote (target would be inferred)';
  if (!/^[A-Za-z0-9._-]+$/.test(remote) || !(ctx.remotes || []).includes(remote)) {
    return `remote '${remote}' is not a configured remote name`;
  }
  if (refspecs.length === 0) return 'no explicit refspec (target would be inferred)';
  const full = `refs/heads/${own}`;
  for (const spec of refspecs) {
    const parts = spec.split(':');
    if (parts.length > 2) return `refspec '${spec}' is not a simple branch refspec`;
    const [src, dst] = parts;
    if (!src || (parts.length === 2 && !dst)) return `refspec '${spec}' is empty or a delete`;
    if (parts.length === 1) {
      // The no-colon form is refused in every case. Git does NOT send `<own>` to
      // refs/heads/<own>: it maps a no-colon refspec through `remote.<name>.push`
      // and, under push.default=upstream|tracking, through
      // `branch.<own>.merge`. Task branches are created from origin/main, so
      // that is refs/heads/main. Only an explicit destination is unambiguous.
      return (
        `the no-colon refspec '${spec}' is refused (git maps it through remote.<name>.push / ` +
        `push.default / branch.<own>.merge, not necessarily to refs/heads/${own}); use exactly ` +
        `'git push --force-with-lease origin HEAD:refs/heads/${own}'`
      );
    }
    // Colon form (the only accepted form): git resolves a destination that is not fully qualified
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
  return {
    decision: 'deny',
    reason:
      `force-push under allowForcePush=leaseOnOwnBranch is limited to a single ` +
      `'git push <remote> --force-with-lease <own-branch>' on this worktree's own non-protected ` +
      `branch (${why}).`,
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
