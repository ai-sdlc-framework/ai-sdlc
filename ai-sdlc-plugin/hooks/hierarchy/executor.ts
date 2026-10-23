// RFC-0058 phase 1 (AISDLC-1034): the executor role of the hierarchy hooks module.
// A hooks module may import only relative files and "claude-code", has no process or fs, and `claude plugin
// validate` refuses `$` passed around or reached through an optional chain: `$` is always spelled
// `$.noun.verb(...)` at the call site. So the handlers build a `Ports` object of such closures and every
// function here takes the ports (or plain values), never `$`.
type Any = any;

/** The host calls the executor role makes, each spelled `$.noun.verb(...)` in the handler that builds it. */
export interface Ports {
  storeGet: (key: string) => Promise<Any>;
  storeSet: (key: string, value: unknown) => Promise<unknown>;
  runCommand: (a: { command: string; args?: string }) => Promise<Any>;
  compact: (a: { instructions: string }) => Promise<Any>;
  submit: (a: { text: string }) => Promise<Any>;
}

/** Build the phase 0 spike passed on (AISDLC-1033); the module registers nothing below it. */
export const VERSION_FLOOR = '2.1.307';
/** Context size, in tokens, at which an executor rotates (the 120k executor threshold). */
export const ROTATE_AT_TOKENS = 120_000;
/** A slash command is run with `$.command.run` (the host refuses `$.prompt.submit` of a text starting with `/`). */
export const RESUME_COMMAND = 'ai-sdlc:executor';
/** A carried rotation record older than this is stale (a clear that never reached a new session). */
export const ROTATION_TTL_MS = 10 * 60 * 1000;
/** A task with no turn activity for this long is treated as ended, so a lost verdict cannot mute wakes. */
export const ACTIVE_STALE_MS = 30 * 60 * 1000;
/** Printed as the last line of a reply by the executor command (Step 5 / idle path). */
export const VERDICT_MARKER = '[executor] verdict reported';
export const IDLE_MARKER = '[executor] idle';

export const LOG_KEY = 'hierarchy/log';
export const ROTATION_KEY = 'hierarchy/rotation';

const HANDOFF_COMMAND = { command: 'ai-sdlc:hierarchy', args: 'handoff write --role executor' };
export const SUMMARY_PROMPT =
  'Summarise for the hierarchy executor: its role (executor), that it holds no task, the board ' +
  'directory, and that its next step is /ai-sdlc:executor. Drop everything about the finished task.';

/** The primitives the executor role uses; `session.measure` is an event, so its pull-side twin `usage` stands in. */
export const PRIMITIVES = [
  'prompt.submit',
  'command.run',
  'session.compact',
  'session.measure',
  'session.send',
] as const;

export function parseVersion(v: unknown): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function atLeast(version: unknown, floor: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(floor)!;
  if (!a) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export async function safe<T>(fn: () => Promise<T> | T): Promise<{ ok: boolean; value?: T }> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false };
  }
}

/**
 * False only when the primitive itself is absent: a TypeError "is not a function", or one reading the verb
 * off a missing noun (`reading 'submit'`). The validator refuses `typeof $.noun.verb`, so the probe is a
 * call with an argument of the wrong type (a bare string, never an object with fields); a host that rejects
 * it, by throwing or by `{ drop }`, has the primitive and the probe did nothing.
 */
export async function exists(
  call: () => Promise<unknown> | unknown,
  verb: string,
): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (err) {
    const m = err instanceof TypeError ? err.message : '';
    return !(m.includes('is not a function') || m.includes(`reading '${verb}'`));
  }
}

/** A `{ drop }` result means the host refused the call. */
function ran(r: { ok: boolean; value?: unknown }): boolean {
  const v = r.value as Any;
  return r.ok && !(v && typeof v === 'object' && 'drop' in v);
}

/** Append one line to the module log (`$.store`, since there is no file API) and echo it when possible. */
export async function log(p: Pick<Ports, 'storeGet' | 'storeSet'>, line: string): Promise<void> {
  const msg = `[hierarchy] ${line}`;
  await safe(async () =>
    p.storeSet(LOG_KEY, [...(((await p.storeGet(LOG_KEY)) as string[]) ?? []), msg]),
  );
  if (typeof console !== 'undefined') console.error(msg);
}

const ROLES = ['executor', 'operator-dispatch', 'planner'];

/**
 * The session's hierarchy role: the launch env (`HIERARCHY_ROLE`, or the `AI_SDLC_HIERARCHY_ROLE` the
 * launcher sets), else the module option of the same name, else the role carried across a clear.
 * INTERIM: a hooks module has no process or fs, so the env comes from `$.env.get` when the host offers it.
 */
export function pickRole(candidates: unknown[]): string | null {
  for (const c of candidates) if (typeof c === 'string' && ROLES.includes(c)) return c;
  return null;
}

/**
 * OQ-5 guard. Returns null when the host is new enough and offers every primitive the role uses, else
 * the one log line that names the miss and the floor. `present` maps each primitive to whether it exists.
 */
export function guard(
  version: unknown,
  present: Record<string, boolean>,
  names: readonly string[] = PRIMITIVES,
): string | null {
  if (!atLeast(version, VERSION_FLOOR)) {
    return `not registering: Claude Code ${version ?? 'unknown'} is below the floor ${VERSION_FLOOR} (session.version)`;
  }
  for (const name of names) {
    if (!present[name]) {
      return `not registering: primitive ${name} is missing (floor ${VERSION_FLOOR}, running ${version})`;
    }
  }
  return null;
}

/** Strip the cross-session envelope (and its backslash-escaped subagent form) down to the sender's text. */
export function innerText(raw: string): string {
  return raw.replace(/<\\?\/?(?:cross-session-message|agent-message)\b[^>]*>/g, '').trim();
}

export function senderOf(raw: string): string {
  return /<cross-session-message\b[^>]*\bfrom="([^"]*)"/.exec(raw)?.[1] ?? '';
}

/** True when the reply's last line is the marker (a marker quoted mid-reply must not trigger rotation). */
export function endsWithMarker(reply: string, marker: string): boolean {
  return reply.trimEnd().endsWith(marker);
}

const DISPATCH_NAME = /(?:^|-)operator-dispatch(?:-\d+)?$/;
const STATUS_NOISE = /^(status|ack|ping)\b/i;

/** Tokens in the context from a `session.measure` payload. */
export function measuredTokens(e: Any): number {
  const direct = e?.contextTokens ?? e?.tokens ?? e?.totalTokens;
  if (typeof direct === 'number') return direct;
  const u = e?.usage ?? e ?? {};
  return ['input', 'cacheWrite', 'cacheRead', 'output'].reduce(
    (n, k) => n + (typeof u[k] === 'number' ? u[k] : 0),
    0,
  );
}

export interface ExecutorState {
  /** Set by the session.start gate once the role, version and probes passed; every handler checks it. */
  enabled?: boolean;
  /** A task is in progress: from the first main-loop turn after a wake to its verdict or idle marker. */
  active: boolean;
  /** Epoch ms of the last main-loop turn event while a task runs; a stale task no longer mutes wakes. */
  lastActivity?: number;
  /** A mod-run clear ended the session and the resume command has not run in the new one yet. */
  resumePending?: boolean;
  /** A measure crossed the threshold while a task ran; rotate at the task's last turn. */
  pendingRotate: boolean;
  lastReply: string;
}

/**
 * The one rotation (OQ-1): handoff write, then `clear` with the role, resume command and last reply in
 * `$.store`; on `{ drop }` or a throw, `compact` with the hierarchy summary prompt; on a second failure,
 * end the session so `cli-hierarchy up` starts a fresh one. Returns the path taken.
 */
export async function rotate(
  p: Ports,
  state: ExecutorState,
): Promise<'clear' | 'compact' | 'exit'> {
  const handoff = await safe(() => p.runCommand(HANDOFF_COMMAND));
  if (!ran(handoff))
    await log(p, 'handoff write was refused; the executor wrote its own at the verdict');
  await p.storeSet(ROTATION_KEY, {
    role: 'executor',
    resume: RESUME_COMMAND,
    lastReply: state.lastReply,
    at: Date.now(),
  });
  state.resumePending = true;
  state.pendingRotate = false;
  if (ran(await safe(() => p.runCommand({ command: 'clear' })))) {
    await log(p, 'rotated with clear');
    return 'clear';
  }
  if (ran(await safe(() => p.compact({ instructions: SUMMARY_PROMPT })))) {
    await p.storeSet(ROTATION_KEY, null);
    state.resumePending = false;
    await log(p, 'clear refused; rotated with compact');
    return 'compact';
  }
  await p.storeSet(ROTATION_KEY, null);
  state.resumePending = false;
  await log(p, 'clear and compact refused; ending the session for cli-hierarchy up');
  await safe(() => p.runCommand({ command: 'exit' }));
  return 'exit';
}

/**
 * Run the resume command in the fresh session after a mod-run clear. `session.start` does not fire after
 * that clear (three live runs), so this runs from the first hook of the new session that does fire
 * (`turn.start`, `session.measure`, `session.receive`) and from `session.start` if a host ever fires it.
 */
export async function resumeAfterClear(p: Ports, state: ExecutorState): Promise<void> {
  if (!state.resumePending) return;
  state.resumePending = false;
  const carried = (await safe(() => p.storeGet(ROTATION_KEY))).value as Any;
  await safe(() => p.storeSet(ROTATION_KEY, null));
  if (!carried?.resume || Date.now() - Number(carried.at ?? 0) > ROTATION_TTL_MS) return;
  state.lastReply = String(carried.lastReply ?? '');
  const r = await safe(() => p.runCommand({ command: carried.resume }));
  if (ran(r)) state.active = true;
  else await log(p, `resume after clear refused: ${JSON.stringify(r.value ?? null)}`);
}

/** True while a task is believed to run: set at a wake, cleared at the verdict, stale after ACTIVE_STALE_MS. */
function taskRunning(state: ExecutorState): boolean {
  if (!state.active) return false;
  if (Date.now() - (state.lastActivity ?? 0) > ACTIVE_STALE_MS) state.active = false;
  return state.active;
}

/** Register the executor hooks. Called from the gate once the role, version and probes passed. */
export function registerExecutor(on: Any, state: ExecutorState): void {
  // Each handler builds its own ports: `$` stays spelled `$.noun.verb(...)` at every call site.
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
      const sender = senderOf(raw);
      const text = innerText(raw);
      if (!DISPATCH_NAME.test(sender)) return next(e);
      if (/^enqueue\b/i.test(text)) {
        if (!taskRunning(state)) {
          const r = await safe(() => p.runCommand({ command: RESUME_COMMAND }));
          if (ran(r)) {
            state.active = true;
            state.lastActivity = Date.now();
          } else await log(p, `wake refused: ${JSON.stringify(r.value ?? null)}`);
        }
        return { consumed: 'hierarchy:enqueue' };
      }
      if (STATUS_NOISE.test(text)) return { consumed: 'hierarchy:status' };
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
    if (!e?.agentId) {
      state.active = true;
      state.lastActivity = Date.now();
    }
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
    const reply = String(e?.text ?? e?.reply ?? '');
    if (reply) state.lastReply = reply;
    state.lastActivity = Date.now();
    const verdict = endsWithMarker(reply, VERDICT_MARKER);
    if (verdict || endsWithMarker(reply, IDLE_MARKER)) state.active = false;
    if (verdict || (state.pendingRotate && !taskRunning(state))) await rotate(p, state);
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
    if (measuredTokens(e) >= ROTATE_AT_TOKENS) {
      if (taskRunning(state)) state.pendingRotate = true;
      else await rotate(p, state);
    }
    return next(e);
  });
}
