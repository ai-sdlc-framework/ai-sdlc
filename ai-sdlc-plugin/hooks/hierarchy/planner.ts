// RFC-0058 phase 3 (AISDLC-1036): the planner role of the hierarchy hooks module.
// Same constraints as executor.ts: `$` is only ever spelled `$.noun.verb(...)` at the call site, so each
// handler builds a `Ports` object of closures and every function here takes the ports, never `$`.
import {
  ACTIVE_STALE_MS,
  DISPATCH_NAME,
  STATUS_NOISE,
  innerText,
  log,
  readMeasure,
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
  /** Epoch ms of the last main-thread turn.start; a turn older than ACTIVE_STALE_MS no longer defers rotation. */
  turnStartedAt?: number;
}

/** True while a main-thread turn is believed to run; stale after ACTIVE_STALE_MS so a lost turn.complete cannot block rotation. */
function turnRunning(state: PlannerState): boolean {
  if (!state.inTurn) return false;
  if (Date.now() - (state.turnStartedAt ?? 0) > ACTIVE_STALE_MS) state.inTurn = false;
  return state.inTurn;
}

/** The shared rotation with the planner's plan; the stored last reply is read back if memory lost it. */
export async function rotatePlanner(
  p: Ports,
  state: PlannerState,
  plan: RotationPlan = PLANNER_PLAN,
): Promise<void> {
  if (!state.lastReply) {
    const stored = (await safe(() => p.storeGet(lastReplyKey(state.name)))).value;
    if (typeof stored === 'string') state.lastReply = stored;
  }
  const path = await rotate(p, state, plan);
  if (path === 'exit') await log(p, `${plan.role} rotation ended the session`);
}

/** Event handlers, called by the module's single registration point (register.tsx) for the armed role. */
export async function plannerSessionReceive(
  state: PlannerState,
  $: Any,
  e: Any,
  next: Any,
): Promise<Any> {
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
    if (DISPATCH_NAME.test(senderOf(raw))) {
      const text = innerText(raw);
      // `cli-hierarchy clear planner` (RFC-0058 phase 4): rotate now, or at the end of the turn.
      if (/^rotate\b/i.test(text)) {
        if (turnRunning(state)) state.pendingRotate = true;
        else await rotatePlanner(p, state, PLANNER_PLAN);
        return { consumed: 'hierarchy:rotate' };
      }
      if (STATUS_NOISE.test(text)) return { consumed: 'hierarchy:status' };
    }
    return next(e);
  };
  return handle().catch(() => next(e));
}

export async function plannerTurnStart(
  state: PlannerState,
  $: Any,
  e: Any,
  next: Any,
): Promise<Any> {
  if (!state.enabled) return next(e);
  const p: Ports = {
    storeGet: (k) => $.store.get(k),
    storeSet: (k, v) => $.store.set(k, v),
    runCommand: (a) => $.command.run(a),
    compact: (a) => $.session.compact(a),
    submit: (a) => $.prompt.submit(a),
  };
  await resumeAfterClear(p, state);
  if (!e?.agentId) {
    state.inTurn = true;
    state.turnStartedAt = Date.now();
  }
  return next(e);
}

export async function plannerTurnComplete(
  state: PlannerState,
  $: Any,
  e: Any,
  next: Any,
): Promise<Any> {
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
  if (state.pendingRotate) await rotatePlanner(p, state, PLANNER_PLAN);
  return next(e);
}

export async function plannerSessionMeasure(
  state: PlannerState,
  $: Any,
  e: Any,
  next: Any,
): Promise<Any> {
  if (!state.enabled) return next(e);
  const p: Ports = {
    storeGet: (k) => $.store.get(k),
    storeSet: (k, v) => $.store.set(k, v),
    runCommand: (a) => $.command.run(a),
    compact: (a) => $.session.compact(a),
    submit: (a) => $.prompt.submit(a),
  };
  await resumeAfterClear(p, state);
  if ((await readMeasure(p, state.name, e)) >= PLANNER_ROTATE_AT_TOKENS) {
    // Never mid-turn: a measure that lands while the main thread runs waits for its turn.complete.
    if (turnRunning(state)) state.pendingRotate = true;
    else await rotatePlanner(p, state, PLANNER_PLAN);
  }
  return next(e);
}
