/**
 * RFC-0061 OQ-8 fence: agent sessions never write the review verdict.
 *
 * Refuses (a) any `git push` naming `refs/ai-sdlc/verdicts/*` and (b) any `gh api` status or
 * check post whose context is a gate context. The one exception is the Step 11 ship step, which
 * pushes the verdict ref from inside the `next-step` process (the hook never sees that push) and
 * is reached through a plain, un-chained `next-step` invocation. The second sanctioned writer is
 * the trusted `verdict-writer.yml` workflow_run workflow (OQ-7), which runs in CI, not in a session.
 *
 * evaluateVerdictFence(command) returns { decision: 'none' | 'allow' | 'deny', reason? }.
 */

'use strict';

const VERDICT_REF = /refs\/ai-sdlc\/verdicts\b/;
const GATE_CONTEXT = /ai-sdlc\/(?:attestation|pr-ready|review-verdict)\b/;
const GIT_PUSH = /\bgit\b[^\n]*\bpush\b/;
const GH_API = /\bgh\b[^\n]*\bapi\b/;
const STATUS_TARGET = /\b(?:statuses|check-runs)\b/;
const SHELL_SYNTAX = /[;&|`$<>\n\\]/;
// `ai-sdlc-pipeline next-step ...`, `pnpm exec ai-sdlc-pipeline next-step ...`, `node .../cli-next-step.mjs ...`.
const SHIP_STEP =
  /^(?:(?:pnpm\s+exec|npx)\s+)?(?:node\s+\S*cli-next-step\.mjs|ai-sdlc-pipeline\s+next-step)(?:\s|$)/;

function isShipStepInvocation(command) {
  return SHIP_STEP.test(command.trim()) && !SHELL_SYNTAX.test(command);
}

function evaluateVerdictFence(command) {
  if (typeof command !== 'string' || !command) return { decision: 'none' };
  const pushesVerdict = GIT_PUSH.test(command) && VERDICT_REF.test(command);
  const postsGateStatus =
    GH_API.test(command) && STATUS_TARGET.test(command) && GATE_CONTEXT.test(command);
  if (!pushesVerdict && !postsGateStatus) return { decision: 'none' };
  if (isShipStepInvocation(command)) return { decision: 'allow' };
  return {
    decision: 'deny',
    reason:
      (pushesVerdict
        ? 'agent sessions may not push refs/ai-sdlc/verdicts/*'
        : 'agent sessions may not post a status or check with a gate context') +
      ' (RFC-0061 OQ-8: the verdict is issued only by the Step 11 ship step or the CI verdict-writer workflow for untrusted PRs).',
  };
}

module.exports = { evaluateVerdictFence, isShipStepInvocation };
