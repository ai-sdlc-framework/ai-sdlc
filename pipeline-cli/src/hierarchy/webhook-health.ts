/**
 * Webhook health on the dispatch tick (AISDLC-1157). The tick reads {@link WebhookHealth} once,
 * reports a class change to the planner (never every tick), and files one operational
 * escalation per episode that names the fix. The fix is the operator's: it touches their
 * account and network. Returning to healthy closes the episode.
 *
 * State is `<board-dir>/webhook-health.json`.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
  withEventLogLock,
} from '../decisions/event-log.js';
import { listDecisions } from '../decisions/projection.js';
import { nextDecisionIdDurable, persistDecisionLog } from '../decisions/remote-persist.js';
import { desktopNotice } from './stall-notice.js';
import type { CommandRunner } from './types.js';
import type { WebhookClass, WebhookHealth } from './webhook.js';

const STATE_FILE = 'webhook-health.json';

/** The command that restarts the feed, as documented in docs/operations/cli-hierarchy.md. */
export const WEBHOOK_FIX_COMMAND =
  'gh webhook forward --repo <owner>/<repo> --events pull_request,check_suite,check_run,workflow_run,status,pull_request_review --url http://127.0.0.1:8765/webhooks/github';

export interface WebhookEscalationInput {
  /** Episode key. */
  since: string;
  class: WebhookClass;
  summary: string;
  body: string;
}

/** Everything that touches the world, injected. */
export interface WebhookHealthTickDeps {
  boardDir: string;
  now: () => Date;
  /** The current reading; undefined when no webhook is expected (no secret). */
  health: () => WebhookHealth | undefined;
  /** Files the escalation and returns its decision id. */
  escalate?: (input: WebhookEscalationInput) => string | undefined;
  /** Answers the open webhook-health decisions (the remembered id, if any, is a hint only). */
  closeEpisode?: (decisionId: string | undefined, note: string) => void;
  /** The stall-notice channel (desktop notification and digest line). */
  notify?: (message: string) => void;
}

interface State {
  class: WebhookClass;
  /** Start of the open episode (class other than healthy). */
  since?: string;
  decisionId?: string;
}

export interface WebhookHealthTickResult {
  /** Present on a class change only. */
  report?: { text: string };
  health?: WebhookHealth;
}

function readState(boardDir: string): State {
  try {
    return JSON.parse(readFileSync(path.join(boardDir, STATE_FILE), 'utf-8')) as State;
  } catch {
    return { class: 'healthy' };
  }
}

/** The escalation body: the cause, the fix and who runs it. */
export function formatWebhookEscalationBody(h: WebhookHealth): string {
  return [
    `Webhook health is ${h.class}: ${h.reasons.join('; ') || 'see signals'}.`,
    `Signals: ${JSON.stringify(h.signals)}.`,
    'Dispatch keeps working by polling gh (about 2,700 calls an hour), which is the rate-limit pressure.',
    `Fix (operator only; it touches your GitHub account and network): restart the feed with \`${WEBHOOK_FIX_COMMAND}\` ` +
      'and record it with `cli-hierarchy webhook up --feed gh-forward`, or re-register the repository hook ' +
      '(secret equal to AI_SDLC_WEBHOOK_SECRET). If the receiver itself is down run `cli-hierarchy webhook up`.',
  ].join(' ');
}

/** Run once per tick. Its failure must not stop the loop; the caller wraps it. */
export function runWebhookHealthTick(deps: WebhookHealthTickDeps): WebhookHealthTickResult {
  const h = deps.health();
  if (!h) return {};
  const state = readState(deps.boardDir);
  if (h.class === state.class) return { health: h };

  const next: State = { class: h.class };
  const nowIso = deps.now().toISOString();
  let text: string;
  if (h.class === 'healthy') {
    // Every open webhook-health record is answered, not only the one this file remembers.
    deps.closeEpisode?.(state.decisionId, `webhook health recovered at ${nowIso}`);
    text = `webhook health: healthy again (was ${state.class} since ${state.since ?? 'unknown'})`;
  } else {
    next.since = state.since ?? nowIso;
    if (state.decisionId) next.decisionId = state.decisionId;
    const reason = h.reasons.join('; ');
    text = `webhook health: ${state.class} to ${h.class}: ${reason}`;
    if (state.class === 'healthy') {
      const id = deps.escalate?.({
        since: next.since,
        class: h.class,
        summary: `Webhook health ${h.class}: ${reason}`,
        body: formatWebhookEscalationBody(h),
      });
      if (id) next.decisionId = id;
      deps.notify?.(`Webhook ${h.class}: ${reason}`);
    }
  }
  mkdirSync(deps.boardDir, { recursive: true });
  writeFileSync(path.join(deps.boardDir, STATE_FILE), JSON.stringify(next) + '\n');
  return { health: h, report: { text } };
}

/** Scope of the escalation; one open record at a time, the episode start lives in the body. */
export const WEBHOOK_HEALTH_SCOPE = 'webhook-health';

/** Open webhook-health decisions in the store (older records carry `webhook-health:<since>`). */
function openWebhookDecisionIds(workDir: string): string[] {
  const out: string[] = [];
  for (const d of listDecisions({ workDir }).decisions) {
    const scope = d.metadata.scope ?? '';
    if (scope !== WEBHOOK_HEALTH_SCOPE && !scope.startsWith(`${WEBHOOK_HEALTH_SCOPE}:`)) continue;
    if (['answered', 'superseded', 'archived'].includes(d.status.lifecycle)) continue;
    out.push(d.metadata.id);
  }
  return out;
}

/** File and close the operational escalation in the decision catalog (the `cli-decisions escalate --route operational` record). */
export function catalogWebhookEscalation(
  workDir: string,
): Pick<WebhookHealthTickDeps, 'escalate' | 'closeEpisode'> {
  return {
    escalate: (input) => {
      const existing = openWebhookDecisionIds(workDir);
      if (existing.length > 0) return existing[0];
      // Allocate and append under one lock so two ticks cannot take the same id.
      const decisionId = withEventLogLock({ workDir }, () => {
        const id = nextDecisionIdDurable({ workDir });
        appendDecisionEvent(
          makeDecisionOpenedEvent({
            decisionId: id,
            source: 'ad-hoc',
            scope: WEBHOOK_HEALTH_SCOPE,
            summary: input.summary,
            body: `${input.body} Episode since ${input.since}.`,
            reversible: true,
            options: [
              {
                id: 'restart-feed',
                description: 'Operator restarts the forwarder or re-registers the hook',
              },
              { id: 'accept-poll-only', description: 'Stay poll-only and accept the gh call rate' },
            ],
            escalation: { route: 'operational', taskId: WEBHOOK_HEALTH_SCOPE, parked: false },
            by: 'operator-dispatch',
          }),
          { workDir },
        );
        return id;
      });
      persistDecisionLog({ workDir });
      return decisionId;
    },
    closeEpisode: (_decisionId, note) => {
      for (const decisionId of openWebhookDecisionIds(workDir)) {
        appendDecisionEvent(
          makeOperatorAnsweredEvent({
            decisionId,
            chosenOptionId: 'restart-feed',
            rationale: note,
            by: 'operator-dispatch',
          }),
          { workDir },
        );
      }
      persistDecisionLog({ workDir });
    },
  };
}

/** The stall-notice channel: a desktop notification and one digest line. */
export function stallChannelNotifier(
  boardDir: string,
  run: CommandRunner,
  now: () => Date,
): (message: string) => void {
  return (message) => {
    desktopNotice(run, message);
    mkdirSync(boardDir, { recursive: true });
    appendFileSync(path.join(boardDir, 'stall-digest.log'), `${now().toISOString()} ${message}\n`);
  };
}
