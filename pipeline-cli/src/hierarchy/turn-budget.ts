/**
 * The dispatch loop's turns-per-tick budget (RFC-0051, AISDLC-667.1).
 *
 * RFC-0051 says the dispatch loop is mostly mechanical. When the rolling median of
 * model turns per tick, over the last 20 completed ticks, exceeds the budget
 * (`dispatch.turnsPerTickBudget` in the usage config, default 5), the loop files one
 * operational Decision that names the step which used the most turns. At most one such
 * Decision is open at a time: a further overrun while it is open files nothing.
 *
 * Everything that touches the world (ledger, events, decision log) is injected into
 * {@link reviewTurnBudget}; {@link loadDispatchTicks} is the production source of ticks.
 */

import { readModelCalls, type ModelCallRecord } from '@ai-sdlc/reference';

import { appendDecisionEvent, makeDecisionOpenedEvent } from '../decisions/event-log.js';
import { nextDecisionIdDurable, persistDecisionLog } from '../decisions/remote-persist.js';
import { listDecisions } from '../decisions/projection.js';
import type { DecisionOption } from '../decisions/decision-record.js';
import { readRecentEvents } from '../orchestrator/events.js';
import { repoNameFor } from '../usage/attribution.js';
import {
  evaluateTurnBudget,
  isDispatchCall,
  parseTickMarkers,
  turnsPerTick,
  type TickTurns,
} from '../usage/dispatch-turns.js';
import { repoIdFor, selectByRepo } from '../usage/repo-id.js';
import type { TurnBudgetReview } from './dispatch-loop.js';

/** Scope of the Decision, and the key that makes "one open at a time" checkable. */
export const TURN_BUDGET_DECISION_SCOPE = 'dispatch-turns-per-tick';

/** Lifecycles in which the Decision still awaits an answer. */
const OPEN_LIFECYCLES: readonly string[] = ['proposed', 'open', 'deferred'];

/** The options the Decision offers. */
export const TURN_BUDGET_OPTIONS: readonly DecisionOption[] = [
  {
    id: 'move-step',
    description:
      'Move the costliest step into a cli-dispatch or cli-hierarchy subcommand so the model no longer spends turns on it',
  },
  {
    id: 'raise-budget',
    description:
      'Raise dispatch.turnsPerTickBudget in the usage config to the observed median, because the turns are judgment calls',
  },
  { id: 'accept', description: 'Accept the current cost and change nothing' },
];

/** What the Decision is filed with. */
export interface TurnBudgetDecisionInput {
  scope: string;
  summary: string;
  body: string;
  options: DecisionOption[];
}

/** Collaborators of {@link reviewTurnBudget}. */
export interface TurnBudgetDeps {
  /** `dispatch.turnsPerTickBudget`. */
  budget: number;
  /** Ticks with their turns, oldest first. */
  ticks: () => TickTurns[] | Promise<TickTurns[]>;
  /** True when a Decision with {@link TURN_BUDGET_DECISION_SCOPE} is still unanswered. */
  hasOpenDecision: () => boolean;
  /** Files the Decision and returns its id. */
  fileDecision: (input: TurnBudgetDecisionInput) => string;
}

/** Check the budget; on an overrun with no Decision open, file one. */
export async function reviewTurnBudget(deps: TurnBudgetDeps): Promise<TurnBudgetReview> {
  const finding = evaluateTurnBudget(await deps.ticks(), deps.budget);
  const review: TurnBudgetReview = {
    median: finding.median,
    budget: deps.budget,
    overBudget: finding.overBudget,
    ...(finding.overBudget && finding.costliestStep
      ? { costliestStep: finding.costliestStep.step }
      : {}),
  };
  if (!finding.overBudget) return review;
  if (deps.hasOpenDecision()) {
    return { ...review, skipped: 'a turns-per-tick Decision is already open' };
  }
  const step = finding.costliestStep?.step ?? 'unknown';
  const turns = finding.costliestStep?.turns ?? 0;
  const decisionId = deps.fileDecision({
    scope: TURN_BUDGET_DECISION_SCOPE,
    summary:
      `Dispatch session used a median of ${finding.median} model turns per tick over the last ` +
      `${finding.window} ticks (budget ${deps.budget}); costliest step: ${step}`,
    body:
      `RFC-0051 section 6 says the dispatch loop is mostly mechanical. The rolling median of turns per tick ` +
      `is ${finding.median} (p90 ${finding.p90}) against a budget of ${deps.budget} ` +
      `(dispatch.turnsPerTickBudget). The step that used the most turns was '${step}' with ${turns} ` +
      `turns across the window. A call is attributed to the latest step of its tick that had started ` +
      `at or before it. See \`cli-usage scorecard\` for the current figures.`,
    options: TURN_BUDGET_OPTIONS.map((o) => ({ ...o })),
  });
  return { ...review, decisionId };
}

/** True when an unanswered Decision with the turn-budget scope exists in the catalog. */
export function hasOpenTurnBudgetDecision(workDir: string): boolean {
  return listDecisions({ workDir }).decisions.some(
    (d) =>
      d.metadata.scope === TURN_BUDGET_DECISION_SCOPE &&
      OPEN_LIFECYCLES.includes(d.status.lifecycle),
  );
}

/** File the Decision in the catalog (the same record `cli-decisions add` writes) and persist the log. */
export function fileTurnBudgetDecision(workDir: string, input: TurnBudgetDecisionInput): string {
  const decisionId = nextDecisionIdDurable({ workDir });
  appendDecisionEvent(
    makeDecisionOpenedEvent({
      decisionId,
      source: 'ad-hoc',
      scope: input.scope,
      summary: input.summary,
      body: input.body,
      reversible: true,
      options: input.options,
      by: 'operator-dispatch',
    }),
    { workDir },
  );
  persistDecisionLog({ workDir });
  return decisionId;
}

/** Inputs of {@link loadDispatchTicks}. */
export interface LoadTicksOptions {
  repoRoot: string;
  artifactsDir: string;
  usageDir?: string;
  /** Calls to read from the ledger: how many recent markers to bucket. Default 40. */
  markerLimit?: number;
}

/**
 * Production source of ticks: the `DispatchTick` markers on the events stream joined with
 * this repository's dispatch-session calls in the usage ledger.
 */
export async function loadDispatchTicks(opts: LoadTicksOptions): Promise<TickTurns[]> {
  const markers = parseTickMarkers(
    readRecentEvents({ artifactsDir: opts.artifactsDir, limit: 20_000 }),
  ).slice(-(opts.markerLimit ?? 40));
  if (markers.length === 0) return [];
  const from = new Date(markers[0].startedAt);
  const candidates: ModelCallRecord[] = [];
  for await (const r of readModelCalls(
    { scope: 'framework', from },
    opts.usageDir === undefined ? {} : { dir: opts.usageDir },
  )) {
    if (isDispatchCall(r)) candidates.push(r);
  }
  const calls = selectByRepo(candidates, {
    repoId: repoIdFor(opts.repoRoot),
    repoName: repoNameFor(opts.repoRoot),
  }).records;
  return turnsPerTick(calls, markers);
}
