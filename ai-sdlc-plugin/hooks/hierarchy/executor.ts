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
export const RESUME_COMMAND = '/ai-sdlc:executor';
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

/** False only when calling the primitive failed because it does not exist (a TypeError "not a function"). */
export async function exists(call: () => Promise<unknown> | unknown): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (err) {
    return !(err instanceof TypeError && /not a function|undefined|not defined/.test(err.message));
  }
}

/** A `{ drop }` result means the host refused the call. */
function ran(r: { ok: boolean; value?: unknown }): boolean {
  const v = r.value as Any;
  return r.ok && !(v && typeof v === 'object' && 'drop' in v);
}

/** Append one line to the module log (`$.store`, since there is no file API) and echo it when possible. */
export async function log(p: Ports, line: string): Promise<void> {
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
export function guard(version: unknown, present: Record<string, boolean>): string | null {
  if (!atLeast(version, VERSION_FLOOR)) {
    return `not registering: Claude Code ${version ?? 'unknown'} is below the floor ${VERSION_FLOOR} (session.version)`;
  }
  for (const name of PRIMITIVES) {
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
  /** A task is in progress: from the first main-loop turn after a wake to its verdict or idle marker. */
  active: boolean;
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
  });
  state.pendingRotate = false;
  if (ran(await safe(() => p.runCommand({ command: 'clear' })))) {
    await log(p, 'rotated with clear');
    return 'clear';
  }
  if (ran(await safe(() => p.compact({ instructions: SUMMARY_PROMPT })))) {
    await p.storeSet(ROTATION_KEY, null);
    await log(p, 'clear refused; rotated with compact');
    return 'compact';
  }
  await p.storeSet(ROTATION_KEY, null);
  await log(p, 'clear and compact refused; ending the session for cli-hierarchy up');
  await safe(() => p.runCommand({ command: 'exit' }));
  return 'exit';
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
      const raw = String(e?.text ?? '');
      const sender = senderOf(raw);
      const text = innerText(raw);
      if (!DISPATCH_NAME.test(sender)) return next(e);
      if (/^enqueue\b/i.test(text)) {
        if (!state.active) {
          const r = await safe(() => p.submit({ text: RESUME_COMMAND }));
          if (ran(r)) state.active = true;
          else await log(p, `wake refused: ${JSON.stringify(r.value ?? null)}`);
        }
        return { consumed: 'hierarchy:enqueue' };
      }
      if (STATUS_NOISE.test(text)) return { consumed: 'hierarchy:status' };
      return next(e);
    };
    return handle().catch(() => next(e));
  });

  on('turn.start', async ($: Any, e: Any, next: Any) => {
    if (!e?.agentId) state.active = true;
    return next(e);
  });

  on('turn.complete', async ($: Any, e: Any, next: Any) => {
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
    const verdict = reply.includes(VERDICT_MARKER);
    if (verdict || reply.includes(IDLE_MARKER)) state.active = false;
    if (verdict || (state.pendingRotate && !state.active)) await rotate(p, state);
    return next(e);
  });

  on('session.measure', async ($: Any, e: Any, next: Any) => {
    const p: Ports = {
      storeGet: (k) => $.store.get(k),
      storeSet: (k, v) => $.store.set(k, v),
      runCommand: (a) => $.command.run(a),
      compact: (a) => $.session.compact(a),
      submit: (a) => $.prompt.submit(a),
    };
    if (measuredTokens(e) >= ROTATE_AT_TOKENS) {
      if (state.active) state.pendingRotate = true;
      else await rotate(p, state);
    }
    return next(e);
  });
}
