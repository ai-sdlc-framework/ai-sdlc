/**
 * RFC-0061 Phase 2: the `verdict-check` subcommand body, with the process boundaries (git, gh)
 * injected so it is testable. Posts the kept `ai-sdlc/attestation` context; the check job feeds
 * `ai-sdlc/pr-ready`.
 *
 * @module attestation/verdict-cli
 */

import type { Runner } from '../runtime/exec.js';
import { findCarriedVerdict, type ReplaySubject } from './clean-replay.js';
import { checkVerdict, type VerdictCheckResult } from './verdict-check.js';
import {
  RECORD_FILE,
  VERDICT_REF_PREFIX,
  VerdictRecordSchema,
  type IndependenceTier,
} from './verdict-record.js';

/** The kept status context (RFC-0061 OQ-3: names kept). */
export const ATTESTATION_CONTEXT = 'ai-sdlc/attestation';

/** Records examined when looking for an earlier head to carry forward from. */
const EARLIER_RECORD_LIMIT = 20;

export interface VerdictCheckRun {
  runner: Runner;
  cwd: string;
  repository: string;
  headSha: string;
  baseSha: string;
  /** The PR number; scopes the carry-forward search. Omitted means any PR. */
  pullRequest?: number;
  requiredTier?: IndependenceTier;
  /** Post the `ai-sdlc/attestation` status (CI only): success when ok, failure otherwise. */
  postStatus: boolean;
  /** Appended to the job summary when given. */
  writeSummary?: (markdown: string) => void;
}

/** Approved records for earlier heads of the same PR, newest first (best effort, never throws). */
export async function listEarlierSubjects(
  runner: Runner,
  cwd: string,
  headSha: string,
  pullRequest: number | undefined,
): Promise<ReplaySubject[]> {
  const ls = await runner('git', ['ls-remote', 'origin', `${VERDICT_REF_PREFIX}*`], {
    cwd,
    allowFailure: true,
    timeout: 60_000,
  });
  if (ls.code !== 0) return [];
  const refs = ls.stdout
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((r): r is string => !!r && r !== `${VERDICT_REF_PREFIX}${headSha}`);
  const found: Array<ReplaySubject & { at: string }> = [];
  for (const ref of refs) {
    const fetched = await runner('git', ['fetch', '--no-tags', 'origin', ref], {
      cwd,
      allowFailure: true,
      timeout: 60_000,
    });
    if (fetched.code !== 0) continue;
    const rec = await runner('git', ['show', `FETCH_HEAD:${RECORD_FILE}`], {
      cwd,
      allowFailure: true,
    });
    if (rec.code !== 0) continue;
    try {
      const parsed = VerdictRecordSchema.parse(JSON.parse(rec.stdout));
      if (parsed.verdict !== 'approved' || !parsed.coverage.satisfied) continue;
      const pr = parsed.subject.pullRequest;
      if (pullRequest !== undefined && pr !== pullRequest && pr !== 0) {
        continue;
      }
      found.push({
        headSha: parsed.subject.headSha,
        baseSha: parsed.subject.baseSha,
        at: parsed.issuedBy.at,
      });
    } catch {
      continue;
    }
  }
  return found
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, EARLIER_RECORD_LIMIT)
    .map(({ headSha: h, baseSha: b }) => ({ headSha: h, baseSha: b }));
}

/**
 * The AISDLC-1170 carry-forward callback: the single clean-replay rule decides, never a patch-id
 * comparison. Best effort: any failure (including git older than 2.40) declines to carry.
 */
export function makeCarryForward(
  runner: Runner,
  cwd: string,
  baseSha: string,
  pullRequest: number | undefined,
): (headSha: string) => Promise<{ from: string } | null> {
  return async (headSha) => {
    const earlier = await listEarlierSubjects(runner, cwd, headSha, pullRequest);
    if (earlier.length === 0) return null;
    try {
      const carried = await findCarriedVerdict(runner, cwd, { headSha, baseSha }, earlier);
      return carried.status === 'ok-carried' ? { from: carried.from } : null;
    } catch {
      return null;
    }
  };
}

/** Run the check and post the `ai-sdlc/attestation` status. */
export async function runVerdictCheck(run: VerdictCheckRun): Promise<VerdictCheckResult> {
  const diff = await run.runner('git', ['diff', '--name-only', `${run.baseSha}...${run.headSha}`], {
    cwd: run.cwd,
    allowFailure: true,
  });
  const changedPaths = diff.code === 0 ? diff.stdout.split('\n').filter(Boolean) : null;
  // Records store the merge-base as `baseSha`, so the candidate side of the replay does too.
  const mb = await run.runner('git', ['merge-base', run.baseSha, run.headSha], {
    cwd: run.cwd,
    allowFailure: true,
  });
  const replayBase =
    mb.code === 0 && /^[0-9a-f]{40,64}$/i.test(mb.stdout.trim()) ? mb.stdout.trim() : run.baseSha;
  const result = await checkVerdict({
    runner: run.runner,
    cwd: run.cwd,
    headSha: run.headSha,
    changedPaths,
    requiredTier: run.requiredTier,
    carryForward: makeCarryForward(run.runner, run.cwd, replayBase, run.pullRequest),
  });

  if (run.postStatus) {
    await run.runner(
      'gh',
      [
        'api',
        '--method',
        'POST',
        `repos/${run.repository}/statuses/${run.headSha}`,
        '-f',
        `state=${result.ok ? 'success' : 'failure'}`,
        '-f',
        `context=${ATTESTATION_CONTEXT}`,
        '-f',
        `description=${`${result.code} ${result.detail}`.slice(0, 140)}`,
      ],
      { cwd: run.cwd, allowFailure: true },
    );
  }
  run.writeSummary?.(
    `### ${ATTESTATION_CONTEXT}\n\n- result: \`${result.code}\` (${result.detail})\n`,
  );
  return result;
}
