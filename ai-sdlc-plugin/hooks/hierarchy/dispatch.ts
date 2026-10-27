// RFC-0058 phase 2 (AISDLC-1035): the dispatch role of the hierarchy hooks module, a model-less host (OQ-6).
// It runs today's `cli-hierarchy tick` on `$.clock.every`, consumes verdict, PR-landed and status messages in
// `session.receive`, renders the board pane and wakes executors with `$.session.send`. It NEVER submits a
// prompt to its model: there is no `prompt.submit` port here, so no code path can. Same call-site rule as
// executor.ts: `$` is only spelled `$.noun.verb(...)` in the handler that builds the ports.
import { innerText, log, measuredTokens, safe, senderOf } from './executor.ts';
import type { Ports } from './executor.ts';

type Any = any;

/** The primitives the dispatch role uses (the executor role's `prompt.submit` is deliberately absent). */
export const DISPATCH_PRIMITIVES = [
  'clock.every',
  'process.run',
  'session.send',
  'ui.open',
  'session.measure',
] as const;

/** Default interval of the tick timer, the current `nextWakeSec` floor of the dispatch loop. */
export const DEFAULT_TICK_MS = 30_000;
/** Context size, in tokens, at which the host rotates (120k, OQ-1); rarely reached because it has no model turns. */
export const DISPATCH_ROTATE_AT_TOKENS = 120_000;

const NODE = 'node';
const HIERARCHY_BIN = 'pipeline-cli/bin/cli-hierarchy.mjs';
const CI_BIN = 'pipeline-cli/bin/cli-ci.mjs';
const DISPATCH_BIN = 'pipeline-cli/bin/cli-dispatch.mjs';
const TASK_ID = /\b[A-Z][A-Z0-9]*-\d+(?:\.\d+)*\b/;
const PLANNER_ADDRESSED = /^(?:to\s+planner|planner)\s*[:,-]\s*/i;

export const BOARD_KEY = 'hierarchy/dispatch-board';

/** The host calls the dispatch role makes, each spelled `$.noun.verb(...)` in the handler that builds it. */
export interface DispatchPorts extends Omit<Ports, 'compact' | 'submit'> {
  runProcess: (a: { command: string; args: string[] }) => Promise<Any>;
  send: (a: { to: string; text: string }) => Promise<Any>;
  uiOpen: (a: { id: string; title: string }) => Promise<Any>;
}

export interface DispatchOptions {
  tickMs?: number;
  plannerName?: string;
  boardDir?: string;
}

export interface DispatchState {
  enabled?: boolean;
  /** The pane text `ui.render` returns; rebuilt on every tick and consumed event. */
  pane: string[];
  /** Recent event lines shown under the board summary (replaces the model-written tick notes). */
  events: string[];
  /** Blockers of the last tick, shown in the pane. */
  blockers: string[];
  plannerName: string;
  boardDir?: string;
  /** Roster name of this session; keys the module heartbeat file. */
  sessionName?: string;
  /** Host version recorded in the heartbeat. */
  hostVersion?: string;
  uiOpened?: boolean;
  /** Last blockers text sent to the planner; a changed list is announced once. */
  lastBlockers: string;
  /** Text of the last tick failure escalated; the same failure is escalated once, not on every timer fire. */
  lastTickFailure: string;
  /** Number of in-flight ticks: a slow tick must not overlap the next. */
  ticking: boolean;
}

export function newDispatchState(options?: DispatchOptions): DispatchState {
  return {
    pane: ['board: waiting for the first tick'],
    events: [],
    blockers: [],
    plannerName: options?.plannerName ?? 'planner',
    ...(options?.boardDir ? { boardDir: options.boardDir } : {}),
    lastBlockers: '',
    lastTickFailure: '',
    ticking: false,
  };
}

/** Writes the file named by argv[1] (creating its directory) with argv[2]. */
const WRITE_SCRIPT =
  "const fs=require('fs');fs.mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],process.argv[2])";

/**
 * AISDLC-1061: record whether the module loaded in `<board-dir>/handoff/module-<name>.json`, which
 * `cli-hierarchy status`, `up` and `doctor` read. Never throws: a host without `process.run` just leaves
 * the file absent, which those commands report as `absent`.
 */
export async function writeModuleHealth(
  run: (a: { command: string; args: string[] }) => Promise<Any>,
  boardDir: string | undefined,
  name: string,
  health: { state: 'loaded' | 'refused'; reason?: string; version?: string },
  storeSet?: (k: string, v: unknown) => Promise<Any>,
): Promise<void> {
  const file = `${boardDir ?? '.ai-sdlc/dispatch'}/handoff/module-${name}.json`;
  const record = { ...health, at: new Date().toISOString() };
  const body = JSON.stringify(record);
  // AISDLC-1082: the plugin store copy survives a host whose `process.run` cannot write the board file.
  // `readModuleHealth` falls back to this store key when the board file is absent.
  if (storeSet) await safe(() => storeSet(`hierarchy/health/${name}`, record));
  const r = await safe(() => run({ command: NODE, args: ['-e', WRITE_SCRIPT, file, body] }));
  const v = (r.value ?? {}) as Any;
  const code = v.exitCode ?? v.status ?? v.code;
  if (r.ok && typeof code === 'number' && code !== 0) {
    const msg = `process.run node -e health write exited ${code}: ${String(v.stderr ?? '').slice(0, 200)}`;
    await safe(() => Promise.reject(new Error(msg)), 'process.run');
  }
}

const EVENT_LIMIT = 10;

function note(state: DispatchState, line: string): void {
  state.events = [...state.events, line].slice(-EVENT_LIMIT);
}

function boardArgs(state: DispatchState): string[] {
  return state.boardDir ? ['--board-dir', state.boardDir] : [];
}

/** Run a pipeline-cli bin through `$.process.run`; never throws. stdout is returned verbatim. */
export async function runCli(
  p: DispatchPorts,
  bin: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const r = await safe(() => p.runProcess({ command: NODE, args: [bin, ...args] }));
  const v = (r.value ?? {}) as Any;
  const code = v.exitCode ?? v.status ?? v.code ?? (r.ok ? 0 : 1);
  return { ok: r.ok && code === 0, stdout: String(v.stdout ?? ''), stderr: String(v.stderr ?? '') };
}

function parseJson(text: string): Any {
  try {
    return JSON.parse(text.trim().split('\n').filter(Boolean).pop() ?? '');
  } catch {
    return null;
  }
}

/** Build the pane from `cli-hierarchy status --json` (roster, queue, inflight, done, failed) and the blockers. */
export function renderBoard(status: Any, blockers: string[], events: string[]): string[] {
  const out: string[] = ['== roster =='];
  const rows: Any[] = Array.isArray(status?.rows) ? status.rows : [];
  if (rows.length === 0) out.push('(no sessions)');
  for (const r of rows) {
    out.push(
      `${r.entry?.role ?? '?'} ${r.entry?.name ?? '?'} ${r.state ?? '?'}` +
        (r.inflightTask ? ` inflight ${r.inflightTask}` : ''),
    );
  }
  const b = status?.board ?? {};
  out.push('== queue ==', `queued ${b.queued ?? 0}`);
  out.push('== inflight ==', `inflight ${b.inflight ?? 0}`);
  for (const r of rows) if (r.inflightTask) out.push(`${r.entry?.name}: ${r.inflightTask}`);
  out.push('== done ==', `done ${b.done ?? 0}`);
  out.push('== failed ==', `failed ${b.failed ?? 0}`);
  out.push('== blockers ==');
  const all = [
    ...blockers,
    ...((status?.blocked ?? []) as Any[]).map((x) => `${x.taskId}: ${x.reason}`),
  ];
  if (all.length === 0) out.push('none');
  else out.push(...all);
  if (events.length) out.push('== events ==', ...events);
  return out;
}

async function currentStatus(p: DispatchPorts, state: DispatchState): Promise<Any> {
  const r = await runCli(p, HIERARCHY_BIN, ['status', '--json', ...boardArgs(state)]);
  return r.ok ? parseJson(r.stdout) : null;
}

/** Rebuild the pane from the board and persist it in `$.store` so a rotation keeps it. */
export async function refreshPane(p: DispatchPorts, state: DispatchState): Promise<Any> {
  const status = await currentStatus(p, state);
  state.pane = renderBoard(status, state.blockers, state.events);
  await safe(() => p.storeSet(BOARD_KEY, state.pane));
  return status;
}

export const REFRESH_TIMEOUT_MS = 20_000;

/** Run `fn`; resolve `ok` or the failure reason. Never throws. */
export async function attempt(fn: () => Promise<Any> | Any): Promise<string> {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return String((err as Any)?.message ?? err ?? 'rejected');
  }
}

/** `refreshPane` bounded by a timeout so a hung `cli-hierarchy status` cannot wedge the pane. */
export async function refreshPaneBounded(
  p: DispatchPorts,
  state: DispatchState,
  ms: number = REFRESH_TIMEOUT_MS,
): Promise<string> {
  let timer: Any;
  const limit = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(`timed out after ${ms} ms`), ms);
  });
  const work = attempt(async () => {
    const status = await refreshPane(p, state);
    if (status == null) throw new Error('status unavailable');
  });
  const r = await Promise.race([work, limit]);
  clearTimeout(timer);
  return r;
}

/** Wake one executor by roster name. The executor module consumes `enqueue ...` from the dispatch session. */
export async function wake(p: DispatchPorts, name: string, taskId: string): Promise<boolean> {
  const r = await safe(() => p.send({ to: name, text: `enqueue ${taskId}` }));
  const v = r.value as Any;
  return r.ok && !(v && typeof v === 'object' && 'drop' in v);
}

async function wakeIdleExecutors(
  p: DispatchPorts,
  state: DispatchState,
  status: Any,
  taskIds: string[],
): Promise<void> {
  const idle: string[] = ((status?.rows ?? []) as Any[])
    .filter((r) => r.entry?.role === 'executor' && r.state === 'idle' && !r.inflightTask)
    .map((r) => String(r.entry.name));
  for (let i = 0; i < Math.min(idle.length, taskIds.length); i++) {
    const ok = await wake(p, idle[i], taskIds[i]);
    note(state, ok ? `woke ${idle[i]} for ${taskIds[i]}` : `wake of ${idle[i]} refused`);
  }
}

/** Tell the planner something, by roster name. The dispatch model is never prompted. */
export async function tellPlanner(p: DispatchPorts, state: DispatchState, text: string) {
  const r = await safe(() => p.send({ to: state.plannerName, text }));
  if (!r.ok) await log(p, `send to ${state.plannerName} failed`);
}

/** Write a board escalation file for a result the policy tables cannot classify; announce it once. */
export async function escalate(
  p: DispatchPorts,
  state: DispatchState,
  taskId: string,
  message: string,
): Promise<void> {
  const r = await runCli(p, HIERARCHY_BIN, [
    'escalation-file',
    '--task-id',
    taskId,
    '--message',
    message,
    ...boardArgs(state),
  ]);
  const file = (parseJson(r.stdout) as Any)?.file ?? '(not written)';
  note(state, `escalated ${taskId} to ${state.plannerName}`);
  await tellPlanner(
    p,
    state,
    `escalation for ${taskId}: ${message}. Failure record, log tail and PR check summary: ${file}`,
  );
}

/** One tick: run `cli-hierarchy tick`, wake executors for ingested work, escalate, refresh the pane. */
export async function tick(p: DispatchPorts, state: DispatchState): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    if (state.sessionName) {
      await writeModuleHealth(
        p.runProcess,
        state.boardDir,
        state.sessionName,
        { state: 'loaded', ...(state.hostVersion ? { version: state.hostVersion } : {}) },
        p.storeSet,
      );
    }
    const rotation = await rotateRequested(p, state);
    for (const name of rotation.forward) {
      const sent = await safe(() => p.send({ to: name, text: 'rotate' }));
      note(state, sent.ok ? `asked ${name} to rotate` : `rotate request to ${name} failed`);
    }
    if (rotation.self) {
      await rotateHost(p, state);
      return;
    }
    const r = await runCli(p, HIERARCHY_BIN, ['tick', ...boardArgs(state)]);
    const result = parseJson(r.stdout) as Any;
    if (!r.ok || !result || typeof result !== 'object') {
      note(state, `tick failed: ${(r.stderr || r.stdout).split('\n')[0] || 'no output'}`);
      const failure = `cli-hierarchy tick did not return a result: ${r.stderr || r.stdout}`.slice(
        0,
        500,
      );
      if (failure !== state.lastTickFailure) {
        state.lastTickFailure = failure;
        await escalate(p, state, 'TICK', failure);
      }
      await refreshPane(p, state);
      return;
    }
    state.lastTickFailure = '';
    state.blockers = Array.isArray(result.blockers) ? result.blockers.map(String) : [];
    const ingested: string[] = ((result.ingested ?? []) as Any[]).flatMap((x) => x.tasks ?? []);
    note(
      state,
      `tick: ${ingested.length} ingested, ${(result.verdicts ?? []).length} verdicts, ${result.wakeReason ?? ''}`.trim(),
    );
    for (const e of (result.escalations ?? []) as Any[]) {
      await escalate(p, state, String(e.taskId ?? 'UNKNOWN'), String(e.message ?? ''));
    }
    for (const rep of (result.reports ?? []) as Any[]) {
      await tellPlanner(
        p,
        state,
        typeof rep === 'string' ? rep : String(rep.text ?? rep.message ?? JSON.stringify(rep)),
      );
    }
    const blockersText = state.blockers.join('\n');
    if (blockersText !== state.lastBlockers) {
      state.lastBlockers = blockersText;
      if (blockersText) await tellPlanner(p, state, `blockers changed:\n${blockersText}`);
    }
    // The old loop ran the PR reconciler and the CI sweep after every tick; `cli-ci sweep` throttles itself to 15 minutes.
    const rec = await runCli(p, DISPATCH_BIN, ['reconcile', ...boardArgs(state)]);
    if (!rec.ok) note(state, 'reconcile failed');
    else if (rec.stdout.includes('route-to-planner')) {
      await tellPlanner(p, state, `reconciler routed a PR to you:\n${rec.stdout.slice(0, 1500)}`);
    }
    const sweep = await runCli(p, CI_BIN, ['sweep', ...boardArgs(state)]);
    if (!sweep.ok) note(state, 'cli-ci sweep failed');
    const status = await refreshPane(p, state);
    if (ingested.length) {
      await wakeIdleExecutors(p, state, status, ingested);
      await refreshPane(p, state);
    }
  } finally {
    state.ticking = false;
  }
}

/**
 * Rotate requests that `cli-hierarchy clear` wrote; the CLI deletes them as it answers (the deletion is the
 * acknowledgement). `self` is a request for this host; `forward` names the sessions to tell with `$.session.send`.
 */
export async function rotateRequested(
  p: DispatchPorts,
  state: DispatchState,
): Promise<{ self: boolean; forward: string[] }> {
  const r = await runCli(p, HIERARCHY_BIN, ['rotate-pending', ...boardArgs(state)]);
  const out = r.ok ? (parseJson(r.stdout) as Any) : null;
  const forward = Array.isArray(out?.forward)
    ? (out.forward as unknown[]).filter((n): n is string => typeof n === 'string')
    : [];
  return { self: out?.pending === true, forward };
}

export type Classified =
  | { kind: 'verdict'; taskId: string; text: string }
  | { kind: 'landed'; pr: string; text: string }
  | { kind: 'status'; text: string }
  | { kind: 'planner'; text: string }
  | { kind: 'unknown'; text: string };

/** Classify a message by its text; the sender is recorded for the pane but never trusted for authority. */
export function classify(text: string): Classified {
  const planner = PLANNER_ADDRESSED.exec(text);
  if (planner) return { kind: 'planner', text: text.slice(planner[0].length) };
  if (/^verdict\b/i.test(text)) {
    const id = TASK_ID.exec(text)?.[0];
    if (id) return { kind: 'verdict', taskId: id, text };
  }
  if (/^(?:pr[- ]?landed|landed)\b/i.test(text)) {
    const pr = /#?(\d+)/.exec(text)?.[1];
    if (pr) return { kind: 'landed', pr, text };
  }
  if (/^(status|ack|ping|idle)\b/i.test(text)) return { kind: 'status', text };
  return { kind: 'unknown', text };
}

/** Consume one message. Returns the label the hook reports as consumed; never prompts the model. */
export async function handleMessage(
  p: DispatchPorts,
  state: DispatchState,
  raw: string,
): Promise<string> {
  const sender = senderOf(raw) || 'unknown';
  const text = innerText(raw);
  const c = classify(text);
  switch (c.kind) {
    case 'planner':
      await tellPlanner(p, state, `from ${sender}: ${c.text}`);
      note(state, `forwarded ${sender} message to ${state.plannerName}`);
      break;
    case 'verdict': {
      const r = await runCli(p, DISPATCH_BIN, [
        'collect-verdicts',
        '--include-failed',
        'true',
        ...boardArgs(state),
      ]);
      note(state, `verdict ${c.taskId} from ${sender}${r.ok ? '' : ' (collect failed)'}`);
      // The tick is the policy applier for verdicts (clear, unblocking playbook); run it now, not at the next timer.
      await tick(p, state);
      return 'hierarchy:verdict';
    }
    case 'landed': {
      const r = await runCli(p, DISPATCH_BIN, ['reconcile', '--pr', c.pr, ...boardArgs(state)]);
      note(state, `PR #${c.pr} landed${r.ok ? '' : ' (reconcile failed)'}`);
      break;
    }
    case 'status':
      note(state, `status from ${sender}: ${c.text.slice(0, 80)}`);
      break;
    default: {
      // Not a shape the tables know: write it for the planner instead of prompting the model.
      const id = TASK_ID.exec(text)?.[0] ?? 'UNKNOWN';
      await escalate(p, state, id, `unclassified message from ${sender}: ${text.slice(0, 300)}`);
    }
  }
  await refreshPane(p, state);
  return `hierarchy:${c.kind}`;
}

/** Rotate the host: handoff write, then clear. The host has no summary to lose, so there is no compact fallback. */
export async function rotateHost(p: DispatchPorts, state: DispatchState): Promise<void> {
  await safe(() =>
    p.runCommand({ command: 'ai-sdlc:hierarchy', args: 'handoff write --role operator-dispatch' }),
  );
  await p.storeSet(BOARD_KEY, state.pane);
  note(state, 'rotating');
  await safe(() => p.runCommand({ command: 'clear' }));
}

/** Event handlers, called by the module's single registration point (register.tsx) for the armed role. */
export async function dispatchSessionReceive(
  state: DispatchState,
  $: Any,
  e: Any,
  next: Any,
): Promise<Any> {
  const p: DispatchPorts = {
    storeGet: (k) => $.store.get(k),
    storeSet: (k, v) => $.store.set(k, v),
    runCommand: (a) => $.command.run(a),
    runProcess: (a) => $.process.run([a.command, ...a.args]),
    send: (a) => $.session.send(a),
    uiOpen: (a) => $.ui.open(a),
  };
  if (!state.enabled) return next(e);
  // A failure here must never prompt the model: consume the message and let the next tick show the state.
  return handleMessage(p, state, String(e?.text ?? '')).then(
    (consumed) => ({ consumed }),
    () => ({ consumed: 'hierarchy:error' }),
  );
}

export async function dispatchUiRender(
  state: DispatchState,
  _$: Any,
  e: Any,
  next: Any,
): Promise<Any> {
  if (!state.enabled) return next(e);
  return { lines: state.pane, text: state.pane.join('\n') };
}

export async function dispatchSessionMeasure(
  state: DispatchState,
  $: Any,
  e: Any,
  next: Any,
): Promise<Any> {
  if (!state.enabled) return next(e);
  const p: DispatchPorts = {
    storeGet: (k) => $.store.get(k),
    storeSet: (k, v) => $.store.set(k, v),
    runCommand: (a) => $.command.run(a),
    runProcess: (a) => $.process.run([a.command, ...a.args]),
    send: (a) => $.session.send(a),
    uiOpen: (a) => $.ui.open(a),
  };
  if (measuredTokens(e) >= DISPATCH_ROTATE_AT_TOKENS) await rotateHost(p, state);
  return next(e);
}
