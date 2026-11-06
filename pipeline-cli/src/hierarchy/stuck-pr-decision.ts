/**
 * The Decision a `stuck-pr` stall files (AISDLC-1156, DEC-0291): the same record `cli-decisions escalate
 * --route operational` writes, with a timebox and the repair command as the autonomous fallback, so the
 * invariant's second terminal state (a Decision Catalog entry with a timebox) is met without a model.
 */

import type { DecisionOption } from '../decisions/decision-record.js';
import { appendDecisionEvent, makeDecisionOpenedEvent } from '../decisions/event-log.js';
import { nextDecisionIdDurable, persistDecisionLog } from '../decisions/remote-persist.js';
import { computeTimeboxExpiresAt, hoursToIsoDuration, parseTimebox } from '../decisions/timebox.js';
import type { StuckPrRecord } from './drain-stall.js';

/** Everything `cli-decisions escalate --route operational` takes for a stuck PR. */
export interface StuckPrDecisionInput {
  route: 'operational';
  taskId: string;
  scope: string;
  summary: string;
  body: string;
  options: DecisionOption[];
  /** ISO-8601 duration of the timebox. */
  timebox: string;
  autonomousFallbackOptionId: string;
}

/** Build the Decision for a stuck PR. Pure. */
export function buildStuckPrDecision(r: StuckPrRecord, timeboxHours: number): StuckPrDecisionInput {
  const repair = `cli-hierarchy playbook --task ${r.taskId} --action rebase-push`;
  return {
    route: 'operational',
    taskId: r.taskId,
    scope: `pr:${r.pr}`,
    summary: `PR #${r.pr} (${r.taskId}) has a signed failed verdict (${r.cause}) and is not delivered`,
    body:
      `PR #${r.pr}, head ${r.headSha ?? 'unknown'}, failed with '${r.cause}' after review and signing (verdict at ${r.since}) ` +
      `and reached no terminal state: not repaired, not delivered, no decision, no notification. ` +
      `Autonomous fallback after ${timeboxHours} h: run \`${repair}\`.`,
    options: [
      { id: 'repair', description: `run ${repair}, then verify, mark ready and deliver` },
      { id: 'manual', description: 'the operator repairs the PR by hand' },
    ],
    timebox: hoursToIsoDuration(timeboxHours),
    autonomousFallbackOptionId: 'repair',
  };
}

/** Write the Decision to the catalog and persist the log; returns its id. */
export function fileStuckPrDecision(
  workDir: string,
  input: StuckPrDecisionInput,
  now: Date,
): string {
  const decisionId = nextDecisionIdDurable({ workDir });
  appendDecisionEvent(
    makeDecisionOpenedEvent({
      decisionId,
      escalation: { route: input.route, taskId: input.taskId, parked: false },
      source: 'subagent-escalation',
      scope: input.scope,
      summary: input.summary,
      body: input.body,
      reversible: true,
      options: input.options,
      contextRef: input.taskId,
      timebox: input.timebox,
      timeboxExpiresAt: computeTimeboxExpiresAt(parseTimebox(input.timebox).durationMs, now),
      autonomousFallbackOptionId: input.autonomousFallbackOptionId,
      by: `dispatched-session:${input.taskId}`,
    }),
    { workDir },
  );
  persistDecisionLog({ workDir });
  return decisionId;
}
