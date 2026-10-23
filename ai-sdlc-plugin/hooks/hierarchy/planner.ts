// RFC-0058 phase 3 (AISDLC-1036): the planner role of the hierarchy hooks module.
// Same constraints as executor.ts: `$` is only ever spelled `$.noun.verb(...)` at the call site, so each
// handler builds a `Ports` object of closures and every function here takes the ports, never `$`.
import {
  DISPATCH_NAME,
  STATUS_NOISE,
  innerText,
  log,
  measuredTokens,
  rotate,
  resumeAfterClear,
  safe,
  senderOf,
} from './executor.ts';
import type { ExecutorState, Ports, RotationPlan } from './executor.ts';

type Any = any;

/** Context size, in tokens, at which the planner rotates (OQ-1). */
export const PLANNER_ROTATE_AT_TOKENS = 150_000;
export const PLANNER_RESUME_COMMAND = 'ai-sdlc:planner';
export const PLANNER_PLAN: RotationPlan = {
  role: 'planner',
  resume: PLANNER_RESUME_COMMAND,
  handoff: { command: 'ai-sdlc:hierarchy', args: 'handoff write --role planner' },
  summary:
    'Summarise for the hierarchy planner: its role (planner), the board directory, the open ' +
    'briefs and rulings, and that its next step is /ai-sdlc:planner followed by handoff read.',
  replyAsArgs: true,
};

/** `$.store` key of a session's last reply, under its roster name; replaces LAST_MESSAGE.md (AISDLC-914). */
export const lastReplyKey = (name: string): string => `hierarchy/last-reply/${name}`;

export interface PlannerState extends ExecutorState {
  /** Roster name of this session (the launcher's `AI_SDLC_HIERARCHY_SESSION`), else the role. */
  name: string;
  /** A main-thread turn is running: rotation waits for its `turn.complete`. */
  inTurn: boolean;
}

/** Register the planner hooks. Called from the gate once the role, version and probes passed. */
export function registerPlanner(on: Any, state: PlannerState): void {
  // Planner-addressed rulings and escalations (also the phase 2 escalation-file notices from dispatch)
  // pass through unchanged; only status noise from dispatch is consumed.
  on('session.receive', async ($: Any, e: Any, next: Any) => {
    const p: Ports = {
      storeGet: (k) => $.store.get(k),
      storeSet: (k, v) => $.store.set(k, v),
      runCommand: (a) => $.command.run(a),
      compact: (a) => $.session.compact(a),
      submit: (a) => $.prompt.submit(a),
    };
    // A failure in this gating hook must never swallow a message: fall through to the model.
    const handle = async () => {
      if (!state.enabled) return next(e);
      await resumeAfterClear(p, state);
      const raw = String(e?.text ?? '');
      if (DISPATCH_NAME.test(senderOf(raw)) && STATUS_NOISE.test(innerText(raw))) {
        return { consumed: 'hierarchy:status' };
      }
      return next(e);
    };
    return handle().catch(() => next(e));
  });

  on('turn.start', async ($: Any, e: Any, next: Any) => {
    if (!state.enabled) return next(e);
    const p: Ports = {
      storeGet: (k) => $.store.get(k),
      storeSet: (k, v) => $.store.set(k, v),
      runCommand: (a) => $.command.run(a),
      compact: (a) => $.session.compact(a),
      submit: (a) => $.prompt.submit(a),
    };
    await resumeAfterClear(p, state);
    if (!e?.agentId) state.inTurn = true;
    return next(e);
  });

  on('turn.complete', async ($: Any, e: Any, next: Any) => {
    if (!state.enabled) return next(e);
    const p: Ports = {
      storeGet: (k) => $.store.get(k),
      storeSet: (k, v) => $.store.set(k, v),
      runCommand: (a) => $.command.run(a),
      compact: (a) => $.session.compact(a),
      submit: (a) => $.prompt.submit(a),
    };
    if (e?.agentId) return next(e);
    state.inTurn = false;
    const reply = String(e?.text ?? e?.reply ?? '');
    if (reply) {
      state.lastReply = reply;
      await safe(() => p.storeSet(lastReplyKey(state.name), reply));
    }
    if (state.pendingRotate) await rotatePlanner(p, state);
    return next(e);
  });

  on('session.measure', async ($: Any, e: Any, next: Any) => {
    if (!state.enabled) return next(e);
    const p: Ports = {
      storeGet: (k) => $.store.get(k),
      storeSet: (k, v) => $.store.set(k, v),
      runCommand: (a) => $.command.run(a),
      compact: (a) => $.session.compact(a),
      submit: (a) => $.prompt.submit(a),
    };
    await resumeAfterClear(p, state);
    if (measuredTokens(e) >= PLANNER_ROTATE_AT_TOKENS) {
      // Never mid-turn: a measure that lands while the main thread runs waits for its turn.complete.
      if (state.inTurn) state.pendingRotate = true;
      else await rotatePlanner(p, state);
    }
    return next(e);
  });
}

/** The shared rotation with the planner's plan; the stored last reply is read back if memory lost it. */
export async function rotatePlanner(p: Ports, state: PlannerState): Promise<void> {
  if (!state.lastReply) {
    const stored = (await safe(() => p.storeGet(lastReplyKey(state.name)))).value;
    if (typeof stored === 'string') state.lastReply = stored;
  }
  const path = await rotate(p, state, PLANNER_PLAN);
  if (path === 'exit') await log(p, 'planner rotation ended the session');
}
