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
 *   ownBranch:         string | null  — current worktree's checked-out branch
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

const ALWAYS_PROTECTED = ['main', 'master'];
const WRAPPERS = new Set(['env', 'command', 'exec', 'sudo', 'nohup', 'time', 'builtin', 'xargs']);
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const META_RE = /[;&|<>`$\\()\n\r*?[\]{}!#~'"]/;

function isProtectedBranch(name, protectedBranches) {
  const short = name.replace(/^refs\/heads\//, '');
  if (ALWAYS_PROTECTED.includes(short)) return true;
  for (const p of protectedBranches || []) {
    if (p.endsWith('*') ? short.startsWith(p.slice(0, -1)) : short === p) return true;
  }
  return false;
}

/** Strips quotes/backslashes, then splits into shell segments of tokens. */
function toSegments(command) {
  const flat = command.replace(/['"\\]/g, '');
  return flat
    .split(/[;&|\n\r`(){}]|\$\(/)
    .map((seg) => seg.trim().split(/\s+/).filter(Boolean))
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
    return (
      tok.startsWith('--f') ||
      tok === '--mirror' ||
      tok.startsWith('--delete') ||
      tok.startsWith('--prune')
    );
  }
  if (tok.startsWith('-')) return /^-[^-]*[fd]/.test(tok);
  return tok.startsWith('+') || tok.startsWith(':') || /:$/.test(tok);
}

/** True when the segment is (or may be) a `git push`. Returns reason-ish info. */
function classifySegment(toks, aliasLookup) {
  const gi = findGitIndex(toks);
  if (gi === -1) return { push: false };
  const after = toks.slice(gi + 1);
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
  return { push: isPush, rest: after.slice(i + 1), unparseable: aliasOverride || hasDollar };
}

function parseAllowedShape(command, ctx) {
  if (META_RE.test(command)) return 'shell metacharacters, quoting or expansion present';
  const toks = command.trim().split(/\s+/);
  if (toks[0] !== 'git' || toks[1] !== 'push') {
    return 'must be exactly `git push ...` (no wrapper, env prefix or git global options)';
  }
  const own = ctx.ownBranch;
  if (!own || !BRANCH_RE.test(own)) return 'current worktree branch cannot be determined';
  if (isProtectedBranch(own, ctx.protectedBranches)) {
    return `own branch '${own}' is protected`;
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
  for (const spec of refspecs) {
    const parts = spec.split(':');
    if (parts.length > 2) return `refspec '${spec}' is not a simple branch refspec`;
    const [src, dstRaw] = parts;
    const dst = dstRaw === undefined ? src : dstRaw;
    if (!src || !dst) return `refspec '${spec}' is empty or a delete`;
    const srcShort = src.replace(/^refs\/heads\//, '');
    if (src !== 'HEAD' && srcShort !== own) {
      return `refspec source '${src}' is not the own branch`;
    }
    const dstShort = dst.replace(/^refs\/heads\//, '');
    if (dstShort !== own) return `target '${dst}' is not the own branch '${own}'`;
    if (isProtectedBranch(dst, ctx.protectedBranches)) return `target '${dst}' is protected`;
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

module.exports = { evaluateLeasePush, isProtectedBranch };
