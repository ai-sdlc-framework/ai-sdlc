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
  /** `$.process.run([command, ...args])`; absent on a host without it, which reads as "the board names nobody". */
  runProcess?: (a: { command: string; args: string[] }) => Promise<Any>;
}

/** Build the phase 0 spike passed on (AISDLC-1033); the module registers nothing below it. */
export const VERSION_FLOOR = '2.1.307';
/** Context size, in tokens, at which an executor rotates (the 120k executor threshold). */
export const ROTATE_AT_TOKENS = 120_000;
/**
 * Prints `{"v":<n>|null}`: `contextThresholds[argv[2]]` of `<argv[1]>/config.json` when it is a positive integer
 * (same rule as `resolveThresholds` in pipeline-cli; AISDLC-1163).
 */
export const THRESHOLD_SCRIPT =
  "const fs=require('fs'),p=require('path');let v=null;try{const t=JSON.parse(fs.readFileSync(p.join(process.argv[1],'config.json'),'utf8')).contextThresholds;const n=t&&typeof t==='object'?t[process.argv[2]]:null;if(typeof n==='number'&&Number.isInteger(n)&&n>0)v=n}catch(e){}console.log(JSON.stringify({v}))";

/**
 * The rotation threshold for a role: the configured `contextThresholds` value, else `fallback` (the role's
 * constant) on a missing file, an invalid value, or a host without `process.run`.
 */
export async function resolveRotateAt(
  run: ((a: { command: string; args: string[] }) => Promise<Any>) | undefined,
  boardDir: string | undefined,
  role: string,
  fallback: number,
): Promise<number> {
  if (!run) return fallback;
  const r = await safe(() =>
    run({
      command: 'node',
      args: ['-e', THRESHOLD_SCRIPT, boardDir ?? '.ai-sdlc/dispatch', role],
    }),
  );
  const out = String(((r.value ?? {}) as Any).stdout ?? '');
  try {
    const v = JSON.parse(out.trim().split('\n').pop() ?? '').v;
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** A slash command is run with `$.command.run` (the host refuses `$.prompt.submit` of a text starting with `/`). */
export const RESUME_COMMAND = 'ai-sdlc:executor';
/** A carried rotation record older than this is stale (a clear that never reached a new session). */
export const ROTATION_TTL_MS = 10 * 60 * 1000;
/** Longest last reply carried into the planner's resume command arguments. */
export const LAST_REPLY_MAX_CHARS = 4000;

export const LOG_KEY = 'hierarchy/log';
/** AISDLC-1464: the rotation log, one JSON line per module rotation attempt, under `<board>/log/`. */
export const ROTATION_LOG_FILE = 'rotations.jsonl';
export const ROTATION_KEY = 'hierarchy/rotation';

/** What differs between the roles' rotations; the function that rotates is shared (RFC-0058 OQ-1). */
export interface RotationPlan {
  role: string;
  /** Slash command run in the new session after the clear. */
  resume: string;
  /**
   * The handoff turn the module submits before any clear (AISDLC-1448); the clear runs only once
   * `cli-hierarchy handoff verify` proves the RESUME block was rewritten.
   */
  prompt: string;
  /** Summary prompt for the compact fallback. */
  summary: string;
  /** Carry the last reply into the resume command's arguments (the planner prints it after a clear). */
  replyAsArgs?: boolean;
}

/** The executor's handoff turn (AISDLC-1448): the same RESUME-block contract as the planner's. */
export const EXECUTOR_HANDOFF_PROMPT =
  'Handoff routine (context rotation; the clear waits until this is proven): run ' +
  '`node "$PIPELINE_CLI_BIN/cli-hierarchy.mjs" handoff write --role executor --board-dir "$BOARD_DIR"`, then ' +
  'rewrite the ONE `## RESUME HERE` block at the end of that file, outside the markers (replace it, never ' +
  'add a second). It must name: the task you hold and its pipeline step, what you were doing, and what ' +
  'you wait on. Reply with the file path only.';

export const EXECUTOR_PLAN: RotationPlan = {
  role: 'executor',
  resume: RESUME_COMMAND,
  prompt: EXECUTOR_HANDOFF_PROMPT,
  summary:
    'Summarise for the hierarchy executor: its role (executor), that it holds no task, the board ' +
    'directory, and that its next step is /ai-sdlc:executor. Drop everything about the finished task.',
};
export const SUMMARY_PROMPT = EXECUTOR_PLAN.summary;

/** The primitives the executor role uses; `session.measure` is an event, so its pull-side twin `usage` stands in. */
export const PRIMITIVES = [
  'prompt.submit',
  'command.run',
  'session.compact',
  'session.measure',
  'session.send',
  'process.run', // AISDLC-1082: the module-health heartbeat is written through it
] as const;

/**
 * The host's `$.session.version()` is a string on some builds and `{ version: { VERSION, BUILD_TIME, ... } }`
 * on others (2.1.309). Read the known fields in order; never stringify the object (the build date matches too).
 */
export function versionString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (!v || typeof v !== 'object') return null;
  const o = v as Any;
  const inner = o.version;
  if (inner && typeof inner === 'object' && typeof inner.VERSION === 'string') return inner.VERSION;
  if (typeof inner === 'string') return inner;
  if (typeof o.VERSION === 'string') return o.VERSION;
  return null;
}

/** What a refusal line prints for the host value: the extracted string, else the object's keys, never `[object Object]`. */
export function describeVersion(v: unknown): string {
  const s = versionString(v);
  if (s) return s;
  if (v && typeof v === 'object') return `{${Object.keys(v).join(',')}}`;
  return v == null ? 'unknown' : String(v);
}

export function parseVersion(v: unknown): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionString(v) ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function atLeast(version: unknown, floor: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(floor)!;
  if (!a) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** AISDLC-1082: where a swallowed failure is reported; set by the module once a store port exists. */
let swallowSink: ((line: string) => Promise<void> | void) | undefined;
let reporting = false;

export function setSwallowSink(sink: ((line: string) => Promise<void> | void) | undefined): void {
  swallowSink = sink;
}

/** The primitive a thunk calls, read from its source (`$.process.run`, `p.send`), for the failure line. */
function primitiveOf(fn: () => unknown): string {
  return /(?:\$|\bp|\bdp)\.[A-Za-z]+(?:\.[A-Za-z]+)?/.exec(String(fn))?.[0] ?? 'unknown';
}

export async function safe<T>(
  fn: () => Promise<T> | T,
  what?: string,
): Promise<{ ok: boolean; value?: T }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (swallowSink && !reporting) {
      reporting = true;
      try {
        const text = err instanceof Error ? err.message : String(err);
        await swallowSink(`swallowed ${what ?? primitiveOf(fn)}: ${text}`);
      } catch {
        // reporting must never fail the caller
      } finally {
        reporting = false;
      }
    }
    return { ok: false };
  }
}

/**
 * False only when the primitive itself is absent: a TypeError "is not a function", or one reading the verb
 * off a missing noun (`reading 'submit'`). The validator refuses `typeof $.noun.verb`, so the probe is a
 * call with an argument of the wrong type (a bare string, never an object with fields); a host that rejects
 * it, by throwing or by `{ drop }`, has the primitive and the probe did nothing.
 */
const PROBE_TIMEOUT_MS = 2_000;

export async function exists(
  call: () => Promise<unknown> | unknown,
  verb: string,
): Promise<boolean> {
  try {
    // AISDLC-1064: a probe that never settles still proves the primitive exists; do not wait on it.
    let timer: any;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PROBE_TIMEOUT_MS);
    });
    await Promise.race([Promise.resolve().then(call), limit]);
    clearTimeout(timer);
    return true;
  } catch (err) {
    const m = err instanceof TypeError ? err.message : '';
    return !(m.includes('is not a function') || m.includes(`reading '${verb}'`));
  }
}

/** A `{ drop }` result means the host refused the call. */
export function ran(r: { ok: boolean; value?: unknown }): boolean {
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
    return `not registering: Claude Code ${describeVersion(version)} is below the floor ${VERSION_FLOOR} (session.version)`;
  }
  for (const name of names) {
    if (!present[name]) {
      return `not registering: primitive ${name} is missing (floor ${VERSION_FLOOR}, running ${describeVersion(version)})`;
    }
  }
  return null;
}

/** Strip the cross-session envelope (and its backslash-escaped subagent form) down to the sender's text. */
export function innerText(raw: string): string {
  return raw.replace(/<\\?\/?(?:cross-session-message|agent-message)\b[^>]*>/g, '').trim();
}

export function senderOf(raw: string): string {
  // The host now sends from="uds:/tmp/cc-socks/<pid>.sock" plus from-name="<session name>": prefer the name.
  const tag = /<cross-session-message\b[^>]*>/.exec(raw)?.[0] ?? '';
  return /\bfrom-name="([^"]*)"/.exec(tag)?.[1] ?? /\bfrom="([^"]*)"/.exec(tag)?.[1] ?? '';
}

/** The raw `from=` address (a `uds:/...sock` path on current hosts), used for reply allowlisting. */
export function senderAddressOf(raw: string): string {
  const tag = /<cross-session-message\b[^>]*>/.exec(raw)?.[0] ?? '';
  return /\bfrom="([^"]*)"/.exec(tag)?.[1] ?? '';
}

export const DISPATCH_NAME = /(?:^|-)operator-dispatch(?:-\d+)?$/;
export const STATUS_NOISE = /^(status|ack|ping)\b/i;
/**
 * AISDLC-1464: the text of a bare rotate control word. With no cross-session sender it never came from
 * dispatch through `$.session.send`, so the module drops it instead of passing it to the model.
 */
export const CONTROL_WORD = /^rotate\s*$/i;

/** Tokens in a `session.measure` payload, or null when no known field carries a number (AISDLC-1100). */
export function recognisedTokens(e: Any): number | null {
  // The host sends `{ context: { tokens, window, percent } }`; the flat fields are older guesses.
  const direct = e?.context?.tokens ?? e?.contextTokens ?? e?.tokens ?? e?.totalTokens;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const u = e?.usage ?? e ?? {};
  const keys = ['input', 'cacheWrite', 'cacheRead', 'output'];
  if (!keys.some((k) => typeof u[k] === 'number')) return null;
  return keys.reduce((n, k) => n + (typeof u[k] === 'number' ? u[k] : 0), 0);
}

/** Tokens in the context from a `session.measure` payload; 0 only for an unrecognised shape. */
export function measuredTokens(e: Any): number {
  return recognisedTokens(e) ?? 0;
}

let shapeLogged = false;

/**
 * Read a measure and record it: the last count goes to `hierarchy/measure/<name>` for `cli-hierarchy status`,
 * and an unrecognised payload is logged once with its keys instead of being read silently as 0.
 */
export async function readMeasure(
  p: Pick<Ports, 'storeGet' | 'storeSet'>,
  name: string | undefined,
  e: Any,
): Promise<number> {
  const t = recognisedTokens(e);
  if (t === null) {
    if (!shapeLogged) {
      shapeLogged = true;
      const keys = e && typeof e === 'object' ? Object.keys(e).join(',') : typeof e;
      await log(
        p,
        `session.measure payload not recognised (keys: ${keys}); reading it as 0 tokens`,
      );
    }
    return 0;
  }
  if (name) {
    await safe(() =>
      p.storeSet(`hierarchy/measure/${name}`, { tokens: t, at: new Date().toISOString() }),
    );
  }
  return t;
}

/** Prints the nearest ancestor of the cwd holding a `.git` entry (empty when none). */
const ROOT_SCRIPT =
  "const fs=require('fs'),p=require('path');let d=process.cwd();for(;;){if(fs.existsSync(p.join(d,'.git'))){process.stdout.write(d);break}const u=p.dirname(d);if(u===d)break;d=u}";

type Run = (a: { command: string; args: string[] }) => Promise<Any>;

/**
 * AISDLC-1181: the one resolver every handoff writer uses, so the board path handed to `process.run` is
 * always absolute. A relative `.ai-sdlc/dispatch` followed the session cwd (for example `.claude/memory`)
 * and left untracked files in the parent checkout. Order: an absolute `boardDir`, `CLAUDE_PROJECT_DIR`
 * (read by the caller through `$.env.get`; a hooks module has no `process` global), the project root found from the cwd. Returns `undefined` (the caller writes nothing) when none resolves.
 * A hooks module may import nothing but local files, so the root lookup runs in a child node process.
 */
export async function resolveBoardDir(
  run: Run,
  boardDir?: string,
  projectDir?: string,
): Promise<string | undefined> {
  if (boardDir)
    return boardDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(boardDir) ? boardDir : undefined;
  const env = projectDir;
  if (env && (env.startsWith('/') || /^[A-Za-z]:[\\/]/.test(env)))
    return `${env}/.ai-sdlc/dispatch`;
  const r = await safe(() => run({ command: 'node', args: ['-e', ROOT_SCRIPT] }));
  const root = String(((r.value ?? {}) as Any).stdout ?? '').trim();
  return root ? `${root}/.ai-sdlc/dispatch` : undefined;
}

/** Writes the file named by argv[1] (creating its directory) with argv[2]. */
export const WRITE_SCRIPT =
  "const fs=require('fs');fs.mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],process.argv[2])";

/** Appends argv[2] and a newline to the file named by argv[1], creating its directory. */
export const APPEND_SCRIPT =
  "const fs=require('fs');fs.mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});fs.appendFileSync(process.argv[1],process.argv[2]+'\\n')";

/**
 * Write (or append to) `<board>/<rel>` through `process.run`. Never throws; nothing is written when the
 * host has no `process.run` or no absolute board directory resolves.
 */
export async function writeBoardFile(
  run: Run | undefined,
  where: { boardDir?: string; projectDir?: string },
  rel: string,
  body: string,
  mode: 'write' | 'append' = 'write',
): Promise<boolean> {
  if (!run) return false;
  const board = await resolveBoardDir(run, where.boardDir, where.projectDir);
  if (!board) return false;
  const script = mode === 'append' ? APPEND_SCRIPT : WRITE_SCRIPT;
  const r = await safe(
    () => run({ command: 'node', args: ['-e', script, `${board}/${rel}`, body] }),
    'process.run',
  );
  return r.ok;
}

/** One line of the rotation log (AISDLC-1464): the evidence of whether a module clear happened. */
export interface RotationLogLine {
  at: string;
  role: string;
  session: string;
  /** Last context size the module measured, null when it never measured. */
  tokens: number | null;
  handoffOk: boolean;
  clearOk: boolean;
  /** The fallback taken when the clear was refused; `none` when the clear ran or nothing was cleared. */
  fallback: 'none' | 'compact' | 'exit';
}

/** Append one {@link RotationLogLine} to `<board>/log/rotations.jsonl` (AISDLC-1464). Never throws. */
export async function recordRotation(
  p: Ports,
  state: ExecutorState,
  role: string,
  handoffOk: boolean,
  clearOk: boolean,
  fallback: RotationLogLine['fallback'],
): Promise<boolean> {
  const line: RotationLogLine = {
    at: new Date().toISOString(),
    role,
    session: state.name ?? role,
    tokens: typeof state.lastTokens === 'number' ? state.lastTokens : null,
    handoffOk,
    clearOk,
    fallback,
  };
  return writeBoardFile(
    p.runProcess,
    state,
    `log/${ROTATION_LOG_FILE}`,
    JSON.stringify(line),
    'append',
  );
}

/**
 * The delivery receipt a receiving module writes for a message from dispatch (AISDLC-1464), in
 * `<board>/handoff/receipt-<name>.json`: who sent it, its first words, and whether the module consumed
 * it or forwarded it to the model. `cli-hierarchy status` compares it with the sender's last send.
 */
export async function writeReceipt(
  run: Run | undefined,
  where: { boardDir?: string; projectDir?: string },
  name: string,
  raw: string,
  result: unknown,
): Promise<void> {
  const from = senderOf(raw);
  // Only dispatch records its sends (`sent-<to>.json`), so only a dispatch message gets a receipt: a peer's
  // message never overwrites it, and an executor's frequent status pings spawn no write.
  if (!DISPATCH_NAME.test(from) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return;
  const consumed =
    result && typeof result === 'object' && typeof (result as Any).consumed === 'string'
      ? String((result as Any).consumed)
      : undefined;
  const body = JSON.stringify({
    session: name,
    from,
    text: innerText(raw).slice(0, 80),
    outcome: consumed ? 'consumed' : 'forwarded',
    ...(consumed ? { consumed } : {}),
    at: new Date().toISOString(),
  });
  await writeBoardFile(run, where, `handoff/receipt-${name}.json`, body);
}

export interface ExecutorState {
  /** Set by the session.start gate once the role, version and probes passed; every handler checks it. */
  enabled?: boolean;
  /** Roster name, keys the stored last measure. */
  name?: string;
  /** A mod-run clear ended the session and the resume command has not run in the new one yet. */
  resumePending?: boolean;
  /** Resolved rotation threshold in tokens (config.json `contextThresholds`); the role constant when unset. */
  rotateAt?: number;
  /** A measure crossed the threshold while a task ran; rotate at the task's last turn. */
  pendingRotate: boolean;
  /** A main-loop turn is running now (turn.start seen, turn.complete not yet); an idle executor has none. */
  turnInFlight?: boolean;
  lastReply: string;
  /** Board directory the busy predicate reads (module option `boardDir`). */
  boardDir?: string;
  /** Path of `cli-hierarchy.mjs` (from `<board>/handoff/cli-bin.json`, else the repo-relative bin). */
  cliBin?: string;
  /** The handoff prompt turn was submitted; its turn.complete checks the proof. */
  handoffTurnPending?: boolean;
  /** Handoff prompts submitted for the current rotation request. */
  handoffAttempts?: number;
  /** ISO time of the current rotation request (`handoff mark`), the proof's `--since`. */
  rotationSince?: string;
  /** No proof after the resubmit: alerted, not cleared; each turn end checks the proof again. */
  rotationBlocked?: boolean;
  /** `CLAUDE_PROJECT_DIR`, read at session.start; resolves the board for the rotation log. */
  projectDir?: string;
  /** Last context size a `session.measure` reported; recorded in the rotation log. */
  lastTokens?: number;
}

/** The repo-relative bin, right in this repository; `up` records the adopter's in `cli-bin.json`. */
export const HIERARCHY_CLI = 'pipeline-cli/bin/cli-hierarchy.mjs';
/** Handoff prompts per rotation request: the first and one resubmit (AISDLC-1448). */
export const MAX_HANDOFF_ATTEMPTS = 2;
export const UNPROVEN_LINE = 'handoff unproven; not clearing';

/** Run `cli-hierarchy handoff <action>` for this session; never throws (a failed run reads as code 1). */
async function handoffCli(
  p: Ports,
  state: ExecutorState,
  role: string,
  args: string[],
): Promise<{ code: number; json: Any }> {
  if (!p.runProcess) return { code: 1, json: null };
  const r = await safe(() =>
    p.runProcess!({
      command: 'node',
      args: [
        state.cliBin ?? HIERARCHY_CLI,
        'handoff',
        ...args,
        '--role',
        role,
        '--name',
        state.name ?? role,
        ...(state.boardDir ? ['--board-dir', state.boardDir] : []),
      ],
    }),
  );
  const v = (r.value ?? {}) as Any;
  const code = v.exitCode ?? v.status ?? v.code;
  let json: Any = null;
  try {
    json = JSON.parse(
      String(v.stdout ?? '')
        .trim()
        .split('\n')
        .pop() ?? '',
    );
  } catch {
    json = null;
  }
  return { code: r.ok && typeof code === 'number' ? code : 1, json };
}

/** True while an AskUserQuestion has no answer (pipeline-cli `handoff asking`); such a session is busy. */
export async function operatorQuestionPending(
  p: Ports,
  state: ExecutorState,
  role: string,
): Promise<boolean> {
  const r = await handoffCli(p, state, role, ['asking']);
  return r.code === 0 && r.json?.pending === true;
}

/** The one proof predicate, `handoffWrittenSince`, through `cli-hierarchy handoff verify`. */
export async function handoffProven(
  p: Ports,
  state: ExecutorState,
  role: string,
): Promise<boolean> {
  if (!state.rotationSince) return false;
  const r = await handoffCli(p, state, role, ['verify', '--since', state.rotationSince]);
  return r.code === 0 && r.json?.proven === true;
}

/** No proof: log to the store and the pane, record it under the board and notify; never clear. */
async function alertUnproven(
  p: Ports,
  state: ExecutorState,
  role: string,
  reason: string,
): Promise<void> {
  state.rotationBlocked = true;
  state.pendingRotate = false;
  state.handoffTurnPending = false;
  await log(p, `${role}: ${UNPROVEN_LINE} (${reason}); the operator is alerted`);
  await handoffCli(p, state, role, ['unproven', '--reason', reason]);
  // AISDLC-1464: an attempt that ends unproven is logged too: no handoff, no clear.
  await recordRotation(p, state, role, false, false, 'none');
}

/** Submit the handoff prompt, once more on a refusal, up to {@link MAX_HANDOFF_ATTEMPTS}; else alert. */
async function submitHandoff(p: Ports, state: ExecutorState, plan: RotationPlan): Promise<void> {
  while ((state.handoffAttempts ?? 0) < MAX_HANDOFF_ATTEMPTS) {
    state.handoffAttempts = (state.handoffAttempts ?? 0) + 1;
    const sent = await safe(() => p.submit({ text: plan.prompt }));
    if (ran(sent)) {
      state.handoffTurnPending = true;
      state.pendingRotate = false;
      await log(
        p,
        `handoff turn submitted (attempt ${state.handoffAttempts}); the clear waits for handoff verify`,
      );
      return;
    }
    await log(p, `handoff turn refused (attempt ${state.handoffAttempts})`);
  }
  await alertUnproven(p, state, plan.role, 'the handoff prompt was refused');
}

/**
 * Begin a rotation (AISDLC-1448): every rotation submits the handoff prompt, idle or not. A pending
 * operator question defers it to the first turn.complete after the answer.
 */
export async function beginRotation(
  p: Ports,
  state: ExecutorState,
  plan: RotationPlan,
): Promise<void> {
  if (state.handoffTurnPending) return;
  // An alerted rotation restarts only on a new "rotate" request; a measure waits for a turn end's proof.
  if (state.rotationBlocked) return;
  if (await operatorQuestionPending(p, state, plan.role)) {
    if (!state.pendingRotate)
      await log(
        p,
        `${plan.role}: rotation deferred, an operator question is pending; the handoff prompt follows the answer`,
      );
    state.pendingRotate = true;
    return;
  }
  if (!state.rotationSince) {
    const mark = await handoffCli(p, state, plan.role, ['mark']);
    state.rotationSince =
      typeof mark.json?.since === 'string' ? mark.json.since : new Date().toISOString();
    state.handoffAttempts = 0;
    state.rotationBlocked = false;
  }
  await submitHandoff(p, state, plan);
}

/**
 * At a main-thread turn end: check the handoff turn's proof and clear only on it; resubmit once
 * without it, then alert. A blocked rotation clears as soon as a later turn proves it. Returns
 * true when this turn end belonged to the rotation (the caller does nothing else with it).
 */
export async function rotationTurnEnd(
  p: Ports,
  state: ExecutorState,
  plan: RotationPlan,
): Promise<boolean> {
  if (state.handoffTurnPending) {
    state.handoffTurnPending = false;
    if (await handoffProven(p, state, plan.role)) {
      await clearProven(p, state, plan);
    } else if ((state.handoffAttempts ?? 0) < MAX_HANDOFF_ATTEMPTS) {
      await log(p, 'handoff turn ended without proof; resubmitting the handoff prompt once');
      await submitHandoff(p, state, plan);
    } else {
      await alertUnproven(
        p,
        state,
        plan.role,
        'the handoff turn ended without a new RESUME HERE block',
      );
    }
    return true;
  }
  if (state.rotationBlocked && (await handoffProven(p, state, plan.role))) {
    await clearProven(p, state, plan);
    return true;
  }
  return false;
}

async function clearProven(p: Ports, state: ExecutorState, plan: RotationPlan): Promise<void> {
  state.rotationSince = undefined;
  state.rotationBlocked = false;
  state.handoffAttempts = 0;
  await rotate(p, state, plan);
}

/**
 * Prints `{"held":"<task>"|null}`: the inflight task whose manifest or heartbeat names argv[2] and whose pipeline
 * phase (written by `next-step`, AISDLC-1226) is not terminal. No heartbeat age is consulted.
 */
export const BUSY_SCRIPT =
  "const fs=require('fs'),p=require('path');const[d,n]=process.argv.slice(1);let h=null;try{const dir=p.join(d,'inflight');for(const f of fs.readdirSync(dir)){if(!f.endsWith('.dispatch.json'))continue;const id=f.slice(0,-14);let mf={},hb={};try{mf=JSON.parse(fs.readFileSync(p.join(dir,f),'utf8'))}catch(e){}try{hb=JSON.parse(fs.readFileSync(p.join(dir,id+'.state.json'),'utf8'))}catch(e){}if(hb.workerId!==n&&mf.workerId!==n)continue;if(hb.phase==='done'||hb.phase==='aborted')continue;h=id;break}}catch(e){}console.log(JSON.stringify({held:h}))";

/**
 * The one busy predicate (AISDLC-1124): the board names this worker as the holder of a task. Turn state is
 * not consulted, because a backgrounded developer ends the main turn at once. Null when nothing is held or
 * the board cannot be read.
 */
export async function heldTask(p: Ports, state: ExecutorState): Promise<string | null> {
  if (!p.runProcess || !state.name) return null;
  const dir = state.boardDir ?? '.ai-sdlc/dispatch';
  const r = await safe(() =>
    p.runProcess!({
      command: 'node',
      args: ['-e', BUSY_SCRIPT, dir, state.name!],
    }),
  );
  const out = String(((r.value ?? {}) as Any).stdout ?? '');
  try {
    const held = JSON.parse(out.trim().split('\n').pop() ?? '').held;
    return typeof held === 'string' && held ? held : null;
  } catch {
    return null;
  }
}

/** One module-store line per wake decision: the worker, the event and the reason. */
export async function logWake(
  p: Pick<Ports, 'storeGet' | 'storeSet'>,
  state: ExecutorState,
  event: string,
  decision: 'run' | 'skip',
  reason: string,
): Promise<void> {
  await log(
    p,
    `wake ${decision}: worker=${state.name ?? 'executor'} event=${event} reason=${reason}`,
  );
}

/**
 * The one rotation (OQ-1), run only once the handoff is proven (AISDLC-1448): `clear` with the role,
 * resume command and last reply in `$.store`; on `{ drop }` or a throw, `compact` with the hierarchy
 * summary prompt; on a second failure, end the session so `cli-hierarchy up` starts a fresh one.
 * Returns the path taken.
 */
export async function rotate(
  p: Ports,
  state: ExecutorState,
  plan: RotationPlan = EXECUTOR_PLAN,
): Promise<'clear' | 'compact' | 'exit'> {
  // AISDLC-1448: rotate runs only once `handoff verify` proved the handoff, so the handoff is ok here.
  const handoffOk = true;
  // AISDLC-1464: one log line per attempt, so whether a module clear happened is on record.
  const record = (clearOk: boolean, fallback: RotationLogLine['fallback']) =>
    recordRotation(p, state, plan.role, handoffOk, clearOk, fallback);
  await p.storeSet(ROTATION_KEY, {
    role: plan.role,
    resume: plan.resume,
    lastReply: state.lastReply,
    replyAsArgs: plan.replyAsArgs === true,
    at: Date.now(),
  });
  state.resumePending = true;
  state.pendingRotate = false;
  if (ran(await safe(() => p.runCommand({ command: 'clear' })))) {
    await log(p, 'rotated with clear');
    await record(true, 'none');
    return 'clear';
  }
  if (ran(await safe(() => p.compact({ instructions: plan.summary })))) {
    await p.storeSet(ROTATION_KEY, null);
    state.resumePending = false;
    await log(p, 'clear refused; rotated with compact');
    await record(false, 'compact');
    return 'compact';
  }
  await p.storeSet(ROTATION_KEY, null);
  state.resumePending = false;
  await log(p, 'clear and compact refused; ending the session for cli-hierarchy up');
  await record(false, 'exit');
  await safe(() => p.runCommand({ command: 'exit' }));
  return 'exit';
}

/** A rotation is a wake of the clear path: it never starts while the board names this worker as holder. */
async function rotateUnlessHeld(p: Ports, state: ExecutorState, event: string): Promise<void> {
  const held = await heldTask(p, state);
  if (held) {
    state.pendingRotate = true;
    await logWake(p, state, `rotate(${event})`, 'skip', `board holds ${held}`);
    return;
  }
  await beginRotation(p, state, EXECUTOR_PLAN);
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
  const resume: { command: string; args?: string } = { command: carried.resume };
  if (carried.replyAsArgs && state.lastReply) {
    resume.args = `last-reply: ${state.lastReply.slice(0, LAST_REPLY_MAX_CHARS)}`;
  }
  const r = await safe(() => p.runCommand(resume));
  if (ran(r)) state.turnInFlight = true;
  else await log(p, `resume after clear refused: ${JSON.stringify(r.value ?? null)}`);
}

/**
 * RFC-0059: a spawned executor has `AI_SDLC_EXECUTOR_TASK` set at launch and serves that one task. Run the
 * executor command at session start instead of waiting for an `enqueue` wake; `executor-start` reads the
 * variable and claims exactly that task.
 */
export async function startPinnedTask(
  p: Ports,
  state: ExecutorState,
  taskId: string,
): Promise<void> {
  const held = await heldTask(p, state);
  if (held) {
    await logWake(p, state, 'session.start', 'skip', `board holds ${held}`);
    return;
  }
  const r = await safe(() => p.runCommand({ command: RESUME_COMMAND }));
  if (ran(r)) {
    await logWake(p, state, 'session.start', 'run', `pinned ${taskId}`);
    state.turnInFlight = true;
  } else await log(p, `start for ${taskId} refused: ${JSON.stringify(r.value ?? null)}`);
}

/** True while a main-loop turn runs (set at a wake or `turn.start`, cleared at `turn.complete`). */
function taskRunning(state: ExecutorState): boolean {
  return state.turnInFlight === true;
}

function portsOf($: Any): Ports {
  return {
    storeGet: (k) => $.store.get(k),
    storeSet: (k, v) => $.store.set(k, v),
    runCommand: (a) => $.command.run(a),
    compact: (a) => $.session.compact(a),
    submit: (a) => $.prompt.submit(a),
    runProcess: (a) => $.process.run([a.command, ...a.args]),
  };
}

/** Event handlers, called by the module's single registration point (register.tsx) for the armed role. */
export async function executorSessionReceive(
  state: ExecutorState,
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
    const text = innerText(raw);
    // AISDLC-1464: a bare control word with no sender is framework text, never an operator answer.
    if (!sender && CONTROL_WORD.test(text)) {
      await log(
        p,
        'executor: a rotate with no dispatch sender was dropped, not shown to the model',
      );
      return { consumed: 'hierarchy:unsent-control' };
    }
    if (!DISPATCH_NAME.test(sender)) return next(e);
    if (/^enqueue\b/i.test(text)) {
      const held = await heldTask(p, state);
      if (held) {
        await logWake(p, state, 'enqueue', 'skip', `board holds ${held}`);
      } else if (!taskRunning(state)) {
        const r = await safe(() => p.runCommand({ command: RESUME_COMMAND }));
        if (ran(r)) {
          await logWake(p, state, 'enqueue', 'run', 'board holds nothing');
          state.turnInFlight = true;
        } else await log(p, `wake refused: ${JSON.stringify(r.value ?? null)}`);
      } else {
        await logWake(p, state, 'enqueue', 'skip', 'turn state says a task runs');
      }
      return { consumed: 'hierarchy:enqueue' };
    }
    if (/^rotate\b/i.test(text)) {
      // AISDLC-1121: a rotate wake is a signal, never a prompt; consume it and act deterministically.
      // AISDLC-1448: a new request re-arms an alerted rotation (a fresh baseline, two more prompts).
      if (state.rotationBlocked) {
        state.rotationBlocked = false;
        state.rotationSince = undefined;
      }
      if (taskRunning(state) || state.handoffTurnPending) {
        state.pendingRotate = true;
        await logWake(p, state, 'rotate', 'skip', 'turn state says a task runs; rotate at its end');
      } else {
        await rotateUnlessHeld(p, state, 'wake');
        await logWake(p, state, 'rotate', 'run', 'no task running');
      }
      return { consumed: 'hierarchy:rotate' };
    }
    if (STATUS_NOISE.test(text)) return { consumed: 'hierarchy:status' };
    return next(e);
  };
  return handle().catch(() => next(e));
}

export async function executorTurnStart(
  state: ExecutorState,
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
    state.turnInFlight = true;
  }
  return next(e);
}

export async function executorTurnComplete(
  state: ExecutorState,
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
  // A subagent's own turn.complete never ends the main thread's turn.
  if (e?.agentId) return next(e);
  state.turnInFlight = false;
  // AISDLC-1448: the handoff turn's end checks the proof; nothing else happens on it.
  if (await rotationTurnEnd(p, state, EXECUTOR_PLAN)) return next(e);
  const reply = String(e?.text ?? e?.reply ?? '');
  if (reply) state.lastReply = reply;
  // The turn boundary ends the task for the wake predicate, so a pending threshold rotation fires here
  // (rotateUnlessHeld still defers while the board holds a claim); an idle executor takes the next wake.
  if (state.pendingRotate) await rotateUnlessHeld(p, state, 'turn.complete');
  return next(e);
}

export async function executorSessionMeasure(
  state: ExecutorState,
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
  if (tokens >= (state.rotateAt ?? ROTATE_AT_TOKENS)) {
    if (taskRunning(state)) state.pendingRotate = true;
    else await rotateUnlessHeld(p, state, 'session.measure');
  }
  return next(e);
}
