/**
 * The one setup question about agent merging (AISDLC-1384, DEC-0424 and DEC-0425).
 *
 * `ai-sdlc init --agent-merge yes|no` decides the merge block of the scaffolded
 * `.ai-sdlc/agent-role.yaml`. Yes writes `allowMerge: onGreenClean` with the
 * authenticated `gh` login as the only merge author and `land-eligible-prs` in
 * `operational`. No, or no answer, writes `never` with empty lists. A yes whose
 * `gh` login cannot be read writes `never` and says why: `onGreenClean` is never
 * written with an empty author list. The scaffolded branch protection's approving
 * review count follows the written value (`requiredApprovingReviewCount`).
 */

import {
  AGENT_MERGE_YES_OPERATIONAL,
  AGENT_ROLE_MERGE_DEFAULTS,
  type AgentRoleMergeSettings,
} from '@ai-sdlc/pipeline-cli/config-manifest';
import {
  reviewCountReason,
  type AllowMerge,
  type RunCommandAdapter,
} from './branch-protection-shared.js';

export type AgentMergeAnswer = 'yes' | 'no';

/** Validate the `--agent-merge` value. Absent is valid (no answer). */
export function parseAgentMergeFlag(
  raw: unknown,
): { ok: true; value?: AgentMergeAnswer } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'yes' || v === 'no') return { ok: true, value: v };
  return { ok: false, error: `--agent-merge: expected yes or no, got '${String(raw)}'` };
}

/** The authenticated `gh` login, or null when it cannot be read. Never throws. */
export function readGhLogin(adapters: RunCommandAdapter): string | null {
  try {
    const r = adapters.runCommand('gh', ['api', 'user', '--jq', '.login']);
    const login = r.stdout.trim();
    if (r.exitCode !== 0 || !/^[A-Za-z0-9][A-Za-z0-9-]*(\[bot\])?$/.test(login)) return null;
    return login;
  } catch {
    return null;
  }
}

export interface AgentMergeChoice {
  merge: AgentRoleMergeSettings;
  /** One line saying what was chosen and why. */
  reason: string;
}

/** Turn the setup answer into the merge settings init writes. */
export function resolveAgentMergeChoice(
  answer: AgentMergeAnswer | undefined,
  adapters: RunCommandAdapter,
): AgentMergeChoice {
  if (answer !== 'yes') {
    return {
      merge: AGENT_ROLE_MERGE_DEFAULTS,
      reason:
        answer === 'no'
          ? 'agent merging off: you answered no (allowMerge: never); a person merges every pull request'
          : 'agent merging off: no answer to --agent-merge (allowMerge: never); a person merges every pull request',
    };
  }
  const login = readGhLogin(adapters);
  if (!login) {
    return {
      merge: AGENT_ROLE_MERGE_DEFAULTS,
      reason:
        'agent merging off: you answered yes, but the gh login could not be read (`gh api user` failed), so allowMerge stays never; run `gh auth login`, then set spec.governance.allowMerge: onGreenClean and mergeAuthors in .ai-sdlc/agent-role.yaml',
    };
  }
  return {
    merge: {
      allowMerge: 'onGreenClean',
      mergeAuthors: [login],
      operational: AGENT_MERGE_YES_OPERATIONAL,
    },
    reason: `agent merging on: you answered yes (allowMerge: onGreenClean, mergeAuthors: ${login})`,
  };
}

/** Scaffold answers that render these merge settings into agent-role.yaml. */
export function agentMergeScaffoldDefaults(merge: AgentRoleMergeSettings): Record<string, string> {
  return {
    allowMerge: merge.allowMerge,
    mergeAuthors: merge.mergeAuthors.join(','),
    operational: merge.operational.join(','),
  };
}

/** The setup summary lines: the merge value and the review count, each with its reason. */
export function agentMergeSummaryLines(
  allowMerge: AllowMerge,
  mergeAuthors: readonly string[],
): string[] {
  const merge =
    allowMerge === 'onGreenClean'
      ? `allowMerge: onGreenClean (agents merge pull requests by ${mergeAuthors.join(', ') || 'nobody'} once every gate passes)`
      : 'allowMerge: never (agents do not merge; a person merges every pull request)';
  return [
    merge,
    `required approving reviews: ${reviewCountReason(allowMerge)}; a team may raise it`,
  ];
}
