// RFC-0058 phase 3 (AISDLC-1036): the planner role of the hierarchy hooks module.
// Same constraints as executor.ts: `$` is only ever spelled `$.noun.verb(...)` at the call site, so each
// handler builds a `Ports` object of closures and every function here takes the ports, never `$`.
import {
  CONTROL_WORD,
  DISPATCH_NAME,
  STATUS_NOISE,
  beginRotation,
  innerText,
  log,
  operatorQuestionPending,
  readMeasure,
  recognisedTokens,
  rotationTurnEnd,
  resumeAfterClear,
  safe,
  senderOf,
} from './executor.ts';
import type { ExecutorState, Ports, RotationPlan } from './executor.ts';

type Any = any;

/** Context size, in tokens, at which the planner rotates (OQ-1). */
export const PLANNER_ROTATE_AT_TOKENS = 150_000;
export const PLANNER_RESUME_COMMAND = 'ai-sdlc:planner';
/**
 * The handoff turn the module submits before a rotation clear (AISDLC-1159). It mirrors steps 1-2 of the
 * Handoff routine in `ai-sdlc-plugin/commands/planner.md`; the text lives here only. The clear runs only
 * once `cli-hierarchy handoff verify` proves the block was rewritten (AISDLC-1448).
 */
export const HANDOFF_PROMPT =
  'Handoff routine (context rotation; the clear waits until this is proven): run ' +
  '`node "$PIPELINE_CLI_BIN/cli-hierarchy.mjs" handoff write --role planner --board-dir "$BOARD_DIR"`, then ' +
  'rewrite the ONE `## RESUME HERE` block at the end of that file, outside the markers (replace it, never ' +
  'add a second). It must name: open ' +
  'rulings; owed items; pending operator asks, with the absolute path of every draft in the scratchpad; the ' +
  'next free task id and decision id; scheduled jobs; and what each peer waits on. Reply with the file ' +
  'path only.';

export const PLANNER_PLAN: RotationPlan = {
  role: 'planner',
  resume: PLANNER_RESUME_COMMAND,
  prompt: HANDOFF_PROMPT,
  summary:
    'Summarise for the hierarchy planner: its role (planner), the board directory, the open ' +
    'briefs and rulings, and that its next step is /ai-sdlc:planner followed by handoff read.',
  replyAsArgs: true,
};

/** `$.store` key of a session's last reply, under its roster name; replaces LAST_MESSAGE.md (AISDLC-914). */
export const lastReplyKey = (name: string): string => `hierarchy/last-reply/${name}`;

/** `$.store` key of a session's rotate-pending flag, read by `cli-hierarchy status`. */
export const rotatePendingKey = (name: string): string => `hierarchy/rotate-pending/${name}`;

/**
 * Prints `{"reply":"<text>"}`: the text blocks of the newest assistant record in the session transcript
 * (`<config dir>/projects/<cwd with non-alphanumerics as "-">/<sessionId>.jsonl`, the layout
 * `pipeline-cli/src/hierarchy/context-size.ts` reads), seeking from the file end. argv: sessionId or "".
 * A module has no fs, so this runs through `process.run`; it falls back to the newest transcript.
 */
export const TRANSCRIPT_REPLY_SCRIPT =
  "const fs=require('fs'),p=require('path'),os=require('os');let reply='';try{const base=process.env.CLAUDE_CONFIG_DIR||p.join(os.homedir(),'.claude');const dir=p.join(base,'projects',process.cwd().replace(/[^A-Za-z0-9]/g,'-'));let f=process.argv[1]?p.join(dir,process.argv[1]+'.jsonl'):'';if(!f||!fs.existsSync(f)){let best=0;for(const n of fs.readdirSync(dir)){if(!n.endsWith('.jsonl'))continue;const m=fs.statSync(p.join(dir,n)).mtimeMs;if(m>best){best=m;f=p.join(dir,n)}}}const fd=fs.openSync(f,'r');const size=fs.fstatSync(fd).size;const len=Math.min(size,1048576);const buf=Buffer.alloc(len);fs.readSync(fd,buf,0,len,size-len);const lines=buf.toString('utf8').split('\\n');for(let i=lines.length-1;i>=0&&!reply;i--){if(!lines[i].includes('\"assistant\"'))continue;try{const r=JSON.parse(lines[i]);const c=r.message&&r.message.content;if(r.type!=='assistant'&&!(r.message&&r.message.role==='assistant'))continue;const t=Array.isArray(c)?c.filter(b=>b&&b.type==='text').map(b=>b.text).join('\\n'):(typeof c==='string'?c:'');if(t.trim())reply=t}catch(e){}}}catch(e){}console.log(JSON.stringify({reply}))";

/** The last assistant text of the live transcript, '' when it cannot be read (AISDLC-1159). */
export async function readTranscriptReply(p: Ports, e: Any): Promise<string> {
  if (!p.runProcess) return '';
  const id = typeof e?.sessionId === 'string' ? e.sessionId : '';
  const r = await safe(() =>
    p.runProcess!({ command: 'node', args: ['-e', TRANSCRIPT_REPLY_SCRIPT, id] }),
  );
  const out = String(((r.value ?? {}) as Any).stdout ?? '');
  try {
    const reply = JSON.parse(out.trim().split('\n').pop() ?? '').reply;
    return typeof reply === 'string' ? reply : '';
  } catch {
    return '';
  }
}

/**
 * A planner turn with no turn.complete for this long is presumed lost, unless an operator question is
 * pending; either way the rotation still submits the handoff prompt and never clears without proof.
 */
export const PLANNER_TURN_STALE_MS = 30 * 60 * 1000;

export interface PlannerState extends ExecutorState {
  /** Roster name of this session (the launcher's `AI_SDLC_HIERARCHY_SESSION`), else the role. */
  name: string;
  /** A main-thread turn is running: rotation waits for its `turn.complete`. */
  inTurn: boolean;
  /** Epoch ms of the last main-thread turn.start; a turn older than PLANNER_TURN_STALE_MS no longer defers rotation. */
  turnStartedAt?: number;
}

/**
 * True while a main-thread turn is believed to run. Past PLANNER_TURN_STALE_MS a lost turn.complete is
 * presumed, unless an operator question is still unanswered (AISDLC-1448): that turn is waiting, not lost.
 */
async function turnRunning(p: Ports, state: PlannerState): Promise<boolean> {
  if (!state.inTurn) return false;
  if (Date.now() - (state.turnStartedAt ?? 0) <= PLANNER_TURN_STALE_MS) return true;
  if (await operatorQuestionPending(p, state, 'planner')) return true;
  state.inTurn = false;
  return false;
}

/** Defer the rotation to the turn end: print and log one operator line, flag it for `cli-hierarchy status`. */
async function scheduleRotation(p: Ports, state: PlannerState, line: string): Promise<void> {
  if (state.pendingRotate) return;
  state.pendingRotate = true;
  await log(p, line);
  await safe(() =>
    p.storeSet(rotatePendingKey(state.name), { pending: true, at: new Date().toISOString() }),
  );
}

/** Read back the stored last reply if memory lost it, so the gated clear carries it. */
async function restoreLastReply(p: Ports, state: PlannerState): Promise<void> {
  if (state.lastReply) return;
  const stored = (await safe(() => p.storeGet(lastReplyKey(state.name)))).value;
  if (typeof stored === 'string') state.lastReply = stored;
}

/**
 * Start the planner's rotation (AISDLC-1448): always the handoff prompt first, idle or not; the clear
 * waits for `handoff verify`.
 */
export async function rotatePlanner(
  p: Ports,
  state: PlannerState,
  plan: RotationPlan = PLANNER_PLAN,
): Promise<void> {
  await restoreLastReply(p, state);
  await beginRotation(p, state, plan);
  if (!state.pendingRotate && !state.handoffTurnPending)
    await safe(() => p.storeSet(rotatePendingKey(state.name), null));
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
    runProcess: (a) => $.process.run([a.command, ...a.args]),
  };
  // A failure in this gating hook must never swallow a message: fall through to the model.
  const handle = async () => {
    if (!state.enabled) return next(e);
    await resumeAfterClear(p, state);
    const raw = String(e?.text ?? '');
    const sender = senderOf(raw);
    // AISDLC-1464: a bare control word with no sender is framework text, never an operator answer.
    if (!sender && CONTROL_WORD.test(innerText(raw))) {
      await log(p, 'planner: a rotate with no dispatch sender was dropped, not shown to the model');
      return { consumed: 'hierarchy:unsent-control' };
    }
    if (DISPATCH_NAME.test(sender)) {
      const text = innerText(raw);
      // `cli-hierarchy clear planner` (RFC-0058 phase 4): rotate now, or at the end of the turn.
      if (/^rotate\b/i.test(text)) {
        // A new request re-arms an alerted rotation: a fresh baseline and two more prompts.
        if (state.rotationBlocked) {
          state.rotationBlocked = false;
          state.rotationSince = undefined;
        }
        if ((await turnRunning(p, state)) || state.handoffTurnPending)
          await scheduleRotation(
            p,
            state,
            'planner: rotate requested, rotating at end of this turn; handoff routine runs first',
          );
        else {
          await scheduleRotation(p, state, 'planner: rotate requested; handoff routine runs first');
          await rotatePlanner(p, state, PLANNER_PLAN);
        }
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
    runProcess: (a) => $.process.run([a.command, ...a.args]),
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
    runProcess: (a) => $.process.run([a.command, ...a.args]),
  };
  if (e?.agentId) return next(e);
  state.inTurn = false;
  // The handoff turn replies with a file path only: it must not replace the operator-facing last reply.
  if (state.handoffTurnPending !== true) {
    // The host's turn.complete carries no reply text (AISDLC-1100): read it from the transcript.
    const reply = await readTranscriptReply(p, e);
    if (reply) {
      state.lastReply = reply;
      await safe(() => p.storeSet(lastReplyKey(state.name), reply));
    }
  }
  // AISDLC-1448: the clear runs only on proof; without it the prompt is resubmitted once, then alerted.
  await restoreLastReply(p, state);
  if (await rotationTurnEnd(p, state, PLANNER_PLAN)) {
    if (!state.pendingRotate && !state.handoffTurnPending)
      await safe(() => p.storeSet(rotatePendingKey(state.name), null));
  } else if (state.pendingRotate) {
    await rotatePlanner(p, state, PLANNER_PLAN);
  }
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
    runProcess: (a) => $.process.run([a.command, ...a.args]),
  };
  await resumeAfterClear(p, state);
  const tokens = await readMeasure(p, state.name, e);
  if (recognisedTokens(e) !== null) state.lastTokens = tokens;
  if (tokens >= (state.rotateAt ?? PLANNER_ROTATE_AT_TOKENS)) {
    // Never mid-turn: a measure that lands while the main thread runs waits for its turn.complete.
    if (state.handoffTurnPending || state.rotationBlocked) {
      // a handoff turn runs, or the operator was alerted: the turn end checks the proof
    } else if (await turnRunning(p, state)) {
      await scheduleRotation(
        p,
        state,
        `planner: context ${Math.round(tokens / 1000)}k, rotating at end of this turn; handoff routine runs first`,
      );
    } else await rotatePlanner(p, state, PLANNER_PLAN);
  }
  return next(e);
}
