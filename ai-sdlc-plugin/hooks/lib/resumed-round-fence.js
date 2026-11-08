/**
 * AISDLC-1227: a resumed developer round commits only; Step 11 stays the sole pusher.
 *
 * The round's PR is already ready, so a developer push fires CI on a head with no verdict record
 * (RFC-0061 OQ-2). The pipeline marks the round by `resume.developerRound` on the inflight
 * dispatch manifest, cleared once the round has run. evaluateResumedRoundPush(command, ctx)
 * returns { decision: 'none' | 'deny', reason? }: a git push that names no verdict refspec is
 * denied while the mark is set; the verdict refspec stays with verdict-ref-fence.
 */

'use strict';

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GIT_PUSH = /\bgit\b[\s\S]*\bpush\b/i;
const VERDICT_REF = /refs\/ai-sdlc\/verdicts\b/;

function isResumedRound(projectDir, taskId) {
  if (!taskId || !TASK_ID_RE.test(taskId)) return false;
  const p = join(projectDir, '.ai-sdlc', 'dispatch', 'inflight', `${taskId}.dispatch.json`);
  if (!existsSync(p)) return false;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))?.resume?.developerRound === true;
  } catch {
    return false;
  }
}

function evaluateResumedRoundPush(command, ctx) {
  if (typeof command !== 'string' || !GIT_PUSH.test(command.replace(/['"\\]/g, ''))) {
    return { decision: 'none' };
  }
  if (VERDICT_REF.test(command)) return { decision: 'none' };
  if (!isResumedRound(ctx.projectDir, ctx.taskId)) return { decision: 'none' };
  return {
    decision: 'deny',
    reason:
      'a resumed developer round commits only; the orchestrator pushes (AISDLC-1227, RFC-0061 OQ-2: Step 11 is the sole pusher of a ready PR). ' +
      'Next step: commit on top of the existing commits, do not rebase or push, and return the existing PR URL in prUrl.',
  };
}

module.exports = { evaluateResumedRoundPush, isResumedRound };
