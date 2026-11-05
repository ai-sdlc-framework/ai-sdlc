/**
 * RFC-0061 Phase 1 (shadow): the `verdict-check` and `catches` subcommand bodies, with the
 * process boundaries (git, gh) injected so they are testable.
 *
 * @module attestation/verdict-cli
 */

import type { Runner } from '../runtime/exec.js';
import { checkVerdict, compareShadow, type VerdictCheckResult } from './verdict-check.js';
import {
  collectHistory,
  compileCatches,
  formatCatches,
  V6_CONTEXT,
  VERDICT_CONTEXT,
  type GhJson,
} from './verdict-catches.js';
import type { IndependenceTier } from './verdict-record.js';

export interface VerdictCheckRun {
  runner: Runner;
  cwd: string;
  repository: string;
  headSha: string;
  baseSha: string;
  requiredTier?: IndependenceTier;
  /**
   * Post the shadow status (CI only). Always `success` (RFC-0061 Phase 1: the shadow never gates
   * a merge; a failing status makes mergeStateStatus UNSTABLE). The verdict is the reason code
   * leading the description.
   */
  postStatus: boolean;
  /** Appended to the job summary when given. */
  writeSummary?: (markdown: string) => void;
}

/** Run the check, post the shadow status, and summarise agreement with v6. */
export async function runVerdictCheck(run: VerdictCheckRun): Promise<VerdictCheckResult> {
  const diff = await run.runner('git', ['diff', '--name-only', `${run.baseSha}...${run.headSha}`], {
    cwd: run.cwd,
    allowFailure: true,
  });
  const changedPaths = diff.code === 0 ? diff.stdout.split('\n').filter(Boolean) : null;
  const result = await checkVerdict({
    runner: run.runner,
    cwd: run.cwd,
    headSha: run.headSha,
    changedPaths,
    requiredTier: run.requiredTier,
  });

  let v6State: string | null = null;
  const v6 = await run.runner(
    'gh',
    [
      'api',
      `repos/${run.repository}/commits/${run.headSha}/statuses`,
      '--jq',
      `[.[] | select(.context == "${V6_CONTEXT}")][0].state // empty`,
    ],
    { cwd: run.cwd, allowFailure: true },
  );
  if (v6.code === 0 && v6.stdout.trim()) v6State = v6.stdout.trim();
  const shadow = compareShadow(result.ok, v6State);

  if (run.postStatus) {
    await run.runner(
      'gh',
      [
        'api',
        '--method',
        'POST',
        `repos/${run.repository}/statuses/${run.headSha}`,
        '-f',
        'state=success',
        '-f',
        `context=${VERDICT_CONTEXT}`,
        '-f',
        `description=${`${result.code} ${result.detail}`.slice(0, 140)}`,
      ],
      { cwd: run.cwd, allowFailure: true },
    );
  }
  run.writeSummary?.(
    `### ${VERDICT_CONTEXT} (shadow)\n\n- result: \`${result.code}\` (${result.detail})\n- v6 comparison: ${shadow.line}\n`,
  );
  return result;
}

export async function runCatches(
  repository: string,
  since: string | undefined,
  ghJson: GhJson,
): Promise<string> {
  return formatCatches(compileCatches(await collectHistory(repository, since, ghJson)));
}
