/**
 * RFC-0051 escalation chain for dispatched-session decisions.
 *
 * A question goes to the lowest tier able to answer it: `operational` (the
 * dispatch session or the planner), then `design` (the planner), then the
 * `operator`. Every tier has a timebox; an unanswered decision moves up one tier
 * when it lapses. Silence never resolves a decision, and nothing moves down.
 *
 * This module holds the rules (who may answer, when a decision is due to move)
 * and the best-effort side effects (events, one message to the receiving
 * session). Every collaborator is injected through {@link ChainDeps}, so tests
 * never read a real roster, process table or tmux server.
 *
 * @module decisions/escalation-chain
 */

import path from 'node:path';

import { now } from '../clock.js';
import { unblockManifest } from '../dispatch/board.js';
import { createTmuxBriefSender, type BriefSender } from '../hierarchy/brief-notify.js';
import {
  createSystemIdentity,
  resolveCaller,
  type IdentityDeps,
} from '../hierarchy/caller-identity.js';
import { createStreamEmitter, type EventEmitter } from '../hierarchy/emit.js';
import { readRosterChecked } from '../hierarchy/roster.js';
import { createSystemRunner } from '../hierarchy/system-runner.js';
import { resolveTrustedBoard } from '../hierarchy/trusted-root.js';
import type { HierarchyRole, RosterEntry } from '../hierarchy/types.js';
import {
  ESCALATION_TIERS,
  type Decision,
  type EscalationRoute,
  type EscalationTier,
} from './decision-record.js';
import { loadDecisionsConfig, type DecisionsConfig } from './decisions-config.js';
import { appendDecisionEvent, makeRoutingChangedEvent } from './event-log.js';
import { listDecisions } from './projection.js';

/** Default minutes an escalated decision may wait at a tier. */
export const DEFAULT_ESCALATION_TIMEBOX_MINUTES = { operational: 30, design: 240 } as const;

/** Roles that may answer a decision at each tier. The operator tier has no session role. */
const ANSWER_ROLES: Record<EscalationTier, readonly HierarchyRole[]> = {
  operational: ['operator-dispatch', 'planner'],
  design: ['planner'],
  operator: [],
};

/** Roster role that receives the notification for each tier. */
const TIER_RECEIVER: Record<EscalationTier, HierarchyRole | undefined> = {
  operational: 'operator-dispatch',
  design: 'planner',
  operator: undefined,
};

/** The tier a decision moves to when its timebox lapses; the operator tier is terminal. */
export function nextTier(tier: EscalationTier): EscalationTier | undefined {
  const i = ESCALATION_TIERS.indexOf(tier);
  return i >= 0 && i < ESCALATION_TIERS.length - 1 ? ESCALATION_TIERS[i + 1] : undefined;
}

/** Timebox of a tier in milliseconds, from config with the defaults applied. */
export function tierTimeboxMs(
  tier: EscalationTier,
  config: DecisionsConfig = {},
): number | undefined {
  if (tier === 'operator') return undefined;
  const configured = config.escalationTimeboxMinutes?.[tier];
  const minutes =
    typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_ESCALATION_TIMEBOX_MINUTES[tier];
  return minutes * 60_000;
}

/**
 * Why `caller` may not answer a decision at `tier`, or undefined when it may.
 * A caller that is not a running roster session (null) is the operator at a
 * terminal: it may answer at any tier. A roster session is held to its role.
 * `resolutionError` means identity could not be determined at all (roster
 * unreadable, process table failure): that is refused, never treated as the
 * operator. This is a mistake guard against a session answering the wrong
 * tier, not authentication.
 */
export function answerRefusal(
  tier: EscalationTier,
  caller: { name: string; role: string } | null,
  resolutionError?: string,
): string | undefined {
  if (resolutionError !== undefined) {
    return `could not identify the calling session (${oneLine(resolutionError, 100)}), so the ${tier} tier cannot be checked. Fix the roster (cli-hierarchy status) or answer from a plain terminal outside the session roster.`;
  }
  if (caller === null) return undefined;
  const allowed = ANSWER_ROLES[tier];
  if (allowed.includes(caller.role as HierarchyRole)) return undefined;
  if (tier === 'operator') {
    return `this decision is raised to the operator; ${caller.name} (${caller.role}) cannot answer it. The operator answers it from a terminal outside the session roster.`;
  }
  const who = allowed.join(' or ');
  const next =
    tier === 'design'
      ? 'Forward it to the planner.'
      : 'Ask the dispatch session or the planner to answer it.';
  return `a ${tier} decision is answered by ${who}; ${caller.name} has the role ${caller.role}. ${next}`;
}

/** Collaborators of the chain; every one is injected in tests. */
export interface ChainDeps {
  boardDir: string;
  /** Resolves the calling session from the roster and the process tree. */
  identity: IdentityDeps;
  /** Roster entries; may throw when the roster cannot be read. */
  sessions: () => RosterEntry[];
  /** Types one message into a roster session. */
  send: BriefSender;
  emit: EventEmitter;
}

/** Production collaborators: the main checkout's board, `ps`, tmux and the events stream. */
export function createSystemChainDeps(workDir: string): ChainDeps {
  const boardDir =
    resolveTrustedBoard(process.cwd())?.boardDir ?? path.join(workDir, '.ai-sdlc', 'dispatch');
  return {
    boardDir,
    identity: createSystemIdentity(boardDir),
    sessions: () => readRosterChecked(boardDir).roster.sessions,
    send: createTmuxBriefSender(createSystemRunner()),
    emit: createStreamEmitter(),
  };
}

/** The calling session, or null when it is not a running roster session. */
export function callerOf(deps: ChainDeps): { name: string; role: string } | null {
  try {
    return resolveCaller(deps.identity);
  } catch {
    return null;
  }
}

/**
 * Like {@link callerOf} but tells "no ancestor is a roster session" (caller null,
 * the operator at a terminal) apart from "identity resolution failed" (error set).
 */
export function lookupCaller(deps: ChainDeps): {
  caller: { name: string; role: string } | null;
  error?: string;
} {
  try {
    // resolveCaller maps an unreadable roster to "no caller"; probe it first so an
    // unreadable roster is refused instead of read as the operator.
    deps.identity.readSessions();
    return { caller: resolveCaller(deps.identity) };
  } catch (err) {
    return { caller: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function runningSessions(deps: ChainDeps): RosterEntry[] {
  try {
    return deps.sessions().filter((s) => s.status === 'running');
  } catch {
    return [];
  }
}

/** One line of plain text, safe to type into a terminal. */
export function oneLine(text: string, max = 160): string {
  const flat = text
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Outcome of one best-effort notification. */
export interface NotifyResult {
  sent: boolean;
  to?: string;
  reason?: string;
}

function sendTo(deps: ChainDeps, entry: RosterEntry | undefined, message: string): NotifyResult {
  if (!entry) return { sent: false, reason: 'no running session in the roster' };
  try {
    deps.send(entry, message);
    return { sent: true, to: entry.name };
  } catch (err) {
    return {
      sent: false,
      to: entry.name,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Receiving session of a tier from the roster, when one is running. */
export function tierSession(deps: ChainDeps, tier: EscalationTier): RosterEntry | undefined {
  const role = TIER_RECEIVER[tier];
  return role ? runningSessions(deps).find((s) => s.role === role) : undefined;
}

/**
 * The one-line text typed into a session. It carries only the decision id, the
 * tier and a fixed command: the raiser's free text is never typed into another
 * session (it would be an instruction-injection channel); the receiver reads it
 * as data through `cli-decisions show`.
 * @throws when the id or tier is not in the allowed shape.
 */
export function decisionMessage(
  kind: 'needs-answer' | 'answered',
  decisionId: string,
  tier?: EscalationTier,
): string {
  if (!/^DEC-\d{4,}$/.test(decisionId)) {
    throw new Error(`refusing to announce decision id '${oneLine(decisionId, 40)}'`);
  }
  if (kind === 'answered') {
    return `Decision ${decisionId} was answered. Read it with: cli-decisions show ${decisionId}`;
  }
  if (tier === undefined || !ESCALATION_TIERS.includes(tier)) {
    throw new Error('refusing to announce a decision without a known tier');
  }
  return `Decision ${decisionId} (${tier}) needs an answer. Read it with: cli-decisions show ${decisionId}`;
}

/** Tell the session that owns `tier` about a decision (id and tier only). Never throws. */
export function notifyTier(
  deps: ChainDeps,
  tier: EscalationTier,
  decisionId: string,
): NotifyResult {
  if (tier === 'operator') return { sent: false, reason: 'the operator has no session' };
  try {
    return sendTo(deps, tierSession(deps, tier), decisionMessage('needs-answer', decisionId, tier));
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Tell the session that raised a decision that it was answered. Never throws. */
export function notifyRaiser(
  deps: ChainDeps,
  raisedBy: string | undefined,
  decisionId: string,
): NotifyResult {
  if (!raisedBy) return { sent: false, reason: 'the raising session is unknown' };
  const entry = runningSessions(deps).find((s) => s.name === raisedBy);
  try {
    return sendTo(deps, entry, decisionMessage('answered', decisionId));
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Record that a decision was raised to its first tier. Never throws. */
export function emitRouted(
  deps: ChainDeps,
  input: { decisionId: string; route: EscalationRoute; taskId: string; routedTo?: string },
): void {
  try {
    deps.emit({
      type: 'DecisionRouted',
      taskId: input.taskId,
      decisionId: input.decisionId,
      route: input.route,
      routedTo: input.routedTo ?? input.route,
      fromTier: 'executor',
      toTier: input.route,
    });
  } catch {
    /* events are best-effort */
  }
}

/** When the decision reached its current tier: the last tier move, else its creation. */
export function tierEnteredAt(decision: Decision): string {
  for (let i = decision.decisionLog.length - 1; i >= 0; i--) {
    const e = decision.decisionLog[i]!;
    if (e.type === 'routing-changed') return e.ts;
  }
  return decision.metadata.created;
}

/** A decision whose tier timebox has lapsed, and where it moves. */
export interface DueDecision {
  decision: Decision;
  fromTier: EscalationTier;
  toTier: EscalationTier;
  timeboxMinutes: number;
}

/**
 * Open escalated decisions whose current tier has been waiting at least its
 * timebox. Answered decisions, decisions without escalation routing and the
 * terminal operator tier are never due.
 */
export function findDueDecisions(
  decisions: readonly Decision[],
  now: Date,
  config: DecisionsConfig = {},
): DueDecision[] {
  const due: DueDecision[] = [];
  for (const decision of decisions) {
    const fromTier = decision.status.escalationTier;
    if (!fromTier || decision.status.lifecycle !== 'open') continue;
    const toTier = nextTier(fromTier);
    const timeboxMs = tierTimeboxMs(fromTier, config);
    if (!toTier || timeboxMs === undefined) continue;
    const entered = Date.parse(tierEnteredAt(decision));
    if (!Number.isFinite(entered) || now.getTime() - entered < timeboxMs) continue;
    due.push({ decision, fromTier, toTier, timeboxMinutes: timeboxMs / 60_000 });
  }
  return due;
}

/** Record a tier move on the events stream and tell the new tier. Never throws. */
export function announcePromotion(deps: ChainDeps, due: DueDecision): NotifyResult {
  const { decision } = due;
  try {
    deps.emit({
      type: 'DecisionEscalated',
      ...(decision.spec.escalation?.taskId ? { taskId: decision.spec.escalation.taskId } : {}),
      decisionId: decision.metadata.id,
      fromTier: due.fromTier,
      toTier: due.toTier,
    });
  } catch {
    /* events are best-effort */
  }
  return notifyTier(deps, due.toTier, decision.metadata.id);
}

/**
 * After an answer: return the parked manifest to `queue/` (only when it still
 * waits on this decision) and tell the raising session. Never throws.
 */
export function afterAnswer(
  deps: ChainDeps,
  decision: Decision,
): { unblocked: boolean; notify: NotifyResult } {
  const esc = decision.spec.escalation;
  let unblocked = false;
  if (esc?.parked) {
    try {
      unblocked = unblockManifest(deps.boardDir, esc.taskId, decision.metadata.id);
    } catch {
      unblocked = false;
    }
  }
  return {
    unblocked,
    notify: notifyRaiser(deps, esc?.raisedBy, decision.metadata.id),
  };
}

/** One decision moved up a tier by {@link promoteExpiredDecisions}. */
export interface PromotedDecision {
  decisionId: string;
  fromTier: EscalationTier;
  toTier: EscalationTier;
  notified?: NotifyResult;
}

/**
 * Move every escalated decision whose tier timebox has lapsed up one tier,
 * record the move, emit `DecisionEscalated` and tell the new tier. With
 * `dryRun` it only reports. `persist` runs once after the last write.
 */
export function promoteExpiredDecisions(
  deps: () => ChainDeps,
  opts: { workDir: string; now?: Date; dryRun?: boolean; persist?: () => void },
): PromotedDecision[] {
  const { decisions } = listDecisions({ workDir: opts.workDir });
  const due = findDueDecisions(
    decisions,
    opts.now ?? now(),
    loadDecisionsConfig({ workDir: opts.workDir }),
  );
  if (due.length === 0) return [];
  const chain = opts.dryRun ? undefined : deps();
  const promoted: PromotedDecision[] = [];
  for (const d of due) {
    const row: PromotedDecision = {
      decisionId: d.decision.metadata.id,
      fromTier: d.fromTier,
      toTier: d.toTier,
    };
    if (chain) {
      appendDecisionEvent(
        makeRoutingChangedEvent({
          decisionId: row.decisionId,
          fromTier: d.fromTier,
          toTier: d.toTier,
          reason: `${d.fromTier} timebox of ${d.timeboxMinutes} minutes lapsed unanswered`,
          by: 'framework',
        }),
        { workDir: opts.workDir },
      );
      row.notified = announcePromotion(chain, d);
    }
    promoted.push(row);
  }
  if (chain) opts.persist?.();
  return promoted;
}
