/**
 * Hermetic skip resolvers — AISDLC-621.
 *
 * Hermetic mode (`evaluateGate3Hermetic` in `../evaluate.ts`) intentionally
 * excludes the network-touching resolvers (`urlHeadResolver`,
 * `githubIssueResolver`) so gate 3 never makes a network call offline. The
 * ORIGINAL implementation dropped those resolvers from the registry
 * entirely, which meant a `kind: 'url'` or `kind: 'github-issue'` reference
 * matched no resolver's `supports()` and `resolveReference()` returned
 * `{resolved: false, reason: 'no resolver registered for reference shape'}`
 * — converting "can't check offline" into "reference is broken" and
 * false-failing gate 3 for any issue/task that cited a documentation URL or
 * a `closes #N` / `gh#N` reference.
 *
 * These resolvers close that gap: in hermetic mode they stand in for the
 * real network resolvers and unconditionally report `resolved: true` (with
 * a `reason` documenting the hermetic skip for audit purposes), so gate 3
 * treats network refs as vacuously satisfied offline while still routing
 * `file-existence` refs to the real `fileExistenceResolver` for an actual
 * on-disk check.
 *
 * Do NOT wire these into `DEFAULT_RESOLVERS` — they exist ONLY for the
 * hermetic resolver set built in `evaluateGate3Hermetic`.
 */

import type { Reference, ResolveResult, Resolver, ResolverOpts } from '../types.js';

function makeHermeticSkipResolver(kind: 'url' | 'github-issue'): Resolver {
  return {
    name: kind,
    supports(ref: Reference): boolean {
      return ref.kind === kind;
    },
    async resolve(ref: Reference, _opts: ResolverOpts): Promise<ResolveResult> {
      return {
        ref,
        resolved: true,
        reason: 'skipped in hermetic mode — network-touching reference cannot be verified offline',
      };
    },
  };
}

/** Stands in for `urlHeadResolver` in the hermetic resolver set. */
export const hermeticUrlSkipResolver: Resolver = makeHermeticSkipResolver('url');

/** Stands in for `githubIssueResolver` in the hermetic resolver set. */
export const hermeticGithubIssueSkipResolver: Resolver = makeHermeticSkipResolver('github-issue');
