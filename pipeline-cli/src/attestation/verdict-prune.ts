/**
 * RFC-0061 Phase 1: prune `refs/ai-sdlc/verdicts/*`. Deletes the verdict refs whose PR is closed
 * or merged and whose verdict commit is older than the cutoff (default 30 days). A ref with an
 * open PR, or with no PR found, is kept. Not scheduled by this task.
 *
 * @module attestation/verdict-prune
 */

import { now as clockNow } from '../clock.js';
import type { Runner } from '../runtime/exec.js';
import { VERDICT_REF_PREFIX } from './verdict-record.js';

export type PrState = 'open' | 'closed' | 'merged' | 'none';

export const DEFAULT_PRUNE_AGE_DAYS = 30;

export interface PruneOpts {
  runner: Runner;
  cwd: string;
  remote?: string;
  maxAgeDays?: number;
  now?: Date;
  dryRun?: boolean;
  /** State of the PR whose head is `headSha`. */
  prStateFor: (headSha: string) => Promise<PrState>;
}

export interface PruneResult {
  deleted: string[];
  kept: Array<{ ref: string; reason: string }>;
}

export async function pruneVerdictRefs(opts: PruneOpts): Promise<PruneResult> {
  const remote = opts.remote ?? 'origin';
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_PRUNE_AGE_DAYS) * 86_400_000;
  const nowMs = (opts.now ?? clockNow()).getTime();
  const result: PruneResult = { deleted: [], kept: [] };
  const run = (args: string[]) =>
    opts.runner('git', args, { cwd: opts.cwd, allowFailure: true, timeout: 120_000 });

  // Mirror the namespace locally to read each verdict commit's date.
  const fetched = await run([
    'fetch',
    '--no-tags',
    remote,
    `+${VERDICT_REF_PREFIX}*:${VERDICT_REF_PREFIX}*`,
  ]);
  if (fetched.code !== 0) throw new Error(`fetch of verdict refs failed: ${fetched.stderr.trim()}`);
  const listing = await run([
    'for-each-ref',
    '--format=%(refname) %(committerdate:unix)',
    VERDICT_REF_PREFIX,
  ]);
  for (const line of listing.stdout.split('\n').filter(Boolean)) {
    const [ref, unix] = line.split(' ') as [string, string];
    const headSha = ref.slice(VERDICT_REF_PREFIX.length);
    if (nowMs - Number(unix) * 1000 < maxAgeMs) {
      result.kept.push({ ref, reason: 'younger than the age cutoff' });
      continue;
    }
    const state = await opts.prStateFor(headSha);
    if (state !== 'closed' && state !== 'merged') {
      result.kept.push({ ref, reason: state === 'open' ? 'PR is open' : 'no PR found' });
      continue;
    }
    if (!opts.dryRun) {
      const del = await run(['push', remote, '--delete', ref]);
      if (del.code !== 0) {
        result.kept.push({ ref, reason: `delete failed: ${del.stderr.trim()}` });
        continue;
      }
      await run(['update-ref', '-d', ref]);
    }
    result.deleted.push(ref);
  }
  return result;
}

/** PR state for a head sha through `gh api repos/<repo>/commits/<sha>/pulls`. */
export function ghPrStateFor(runner: Runner, cwd: string, repository: string) {
  return async (headSha: string): Promise<PrState> => {
    const r = await runner(
      'gh',
      [
        'api',
        `repos/${repository}/commits/${headSha}/pulls`,
        '--jq',
        '.[] | [.state, .merged_at] | @tsv',
      ],
      { cwd, allowFailure: true },
    );
    if (r.code !== 0) return 'open'; // unknown: keep
    const rows = r.stdout.split('\n').filter(Boolean);
    if (rows.length === 0) return 'none';
    if (rows.some((row) => row.startsWith('open'))) return 'open';
    return rows.some((row) => !/\tnull$|\t$/.test(row)) ? 'merged' : 'closed';
  };
}
