/**
 * GitHub issue resolver. Handles `#NN`, `gh#NN`, `owner/repo#NN`, and
 * absolute `https://github.com/<owner>/<repo>/issues/<NN>` references.
 *
 * Resolution: shells out to `gh issue view <ref> --json number` and
 * checks for a non-empty stdout / zero exit code. Tests inject a fake
 * runner; production uses the shared `defaultRunner`.
 *
 * RFC-0011 §13 Q2 — pluggable resolver registry. This is the
 * github-issue resolver; sister resolvers handle file existence and
 * URL HEAD.
 */

import { defaultRunner } from '../../runtime/exec.js';
import type { Reference, ResolveResult, Resolver, ResolverOpts } from '../types.js';

const GH_REF_PATTERNS: RegExp[] = [
  /^#\d+$/,
  /^gh#\d+$/i,
  /^[\w.-]+\/[\w.-]+#\d+$/,
  /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+(?:[?#].*)?$/i,
  /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?:[?#].*)?$/i,
];

export const githubIssueResolver: Resolver = {
  name: 'github-issue',
  supports(ref: Reference): boolean {
    if (ref.kind === 'github-issue') return true;
    if (ref.kind !== 'url' && ref.kind !== 'unknown') return false;
    const raw = ref.raw.trim();
    return GH_REF_PATTERNS.some((re) => re.test(raw));
  },
  async resolve(ref: Reference, opts: ResolverOpts): Promise<ResolveResult> {
    const runner = opts.runner ?? defaultRunner;
    const timeout = opts.timeoutMs ?? 5_000;
    const result = await runner('gh', ['issue', 'view', ref.raw, '--json', 'number'], {
      cwd: opts.workDir,
      timeout,
      allowFailure: true,
    });
    if (result.code === 0 && result.stdout.trim().length > 0) {
      return { ref, resolved: true };
    }
    // Try `gh pr view` for PR links — `gh issue view` rejects those.
    const prResult = await runner('gh', ['pr', 'view', ref.raw, '--json', 'number'], {
      cwd: opts.workDir,
      timeout,
      allowFailure: true,
    });
    if (prResult.code === 0 && prResult.stdout.trim().length > 0) {
      return { ref, resolved: true };
    }
    const reason = (
      result.stderr ||
      result.stdout ||
      prResult.stderr ||
      prResult.stdout ||
      'gh returned non-zero exit'
    )
      .trim()
      .slice(0, 200);
    return { ref, resolved: false, reason };
  },
};
