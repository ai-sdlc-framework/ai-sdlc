/**
 * Command, gate and wait timings (AISDLC-1414).
 *
 * One record shape for every timed span: a pipeline-cli command, a pre-push gate, a wait for a
 * verify slot. Spans are appended, one JSON line each, to a single local file
 * (`~/.ai-sdlc/timings.jsonl`; `AI_SDLC_TIMINGS_FILE` names another file, `off` disables it).
 * When the file passes `MAX_FILE_BYTES` it is renamed to `<file>.1` (replacing the previous one)
 * and a new file is started, so it never grows without bound.
 *
 * A span never carries argv beyond the subcommand word, environment values, credentials or file
 * contents: `sanitizeSpan` copies only whitelisted fields and drops any label that is not a short
 * plain word or looks like a secret. Recording never throws; a timing failure must not fail the
 * command it times.
 *
 * A command still running after the slow-span threshold (`AI_SDLC_SLOW_SPAN_SECONDS`, default
 * 120; 0 disables the notice) prints its current span and the elapsed time to stderr, then again
 * every 60 seconds, so a wait is visible in the session that runs it.
 *
 * @module telemetry/timings
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SpanKind = 'command' | 'gate' | 'wait';

export interface TimingSpan {
  v: 1;
  kind: SpanKind;
  /** `cli-file`, `typecheck`, `verify-slot`. */
  name: string;
  /** First positional word of a command (`task`, `status`); never a flag or value. */
  sub?: string;
  /** What a wait span waited on (`a free slot`, `none` when it did not wait). */
  waitedOn?: string;
  startedAt: string;
  durationMs: number;
  /** Exit code; null when unknown. A refused or failed wait records 1. */
  exitCode: number | null;
  /** `SIGINT` / `SIGTERM` when the process was interrupted. */
  signal?: string;
  pid: number;
  taskId?: string;
}

export const TIMINGS_FILE_ENV = 'AI_SDLC_TIMINGS_FILE';
export const SLOW_SPAN_ENV = 'AI_SDLC_SLOW_SPAN_SECONDS';
export const DEFAULT_SLOW_SPAN_MS = 120_000;
/** After the first slow notice, the notice repeats this often. */
export const SLOW_REPEAT_MS = 60_000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const HOUR_MS = 3_600_000;

/**
 * Commands that run until stopped by design (an interactive UI, a supervisor loop, a blocking
 * claim, a server). They get no slow notice and are left out of the status slow list.
 */
export const LONG_RUNNING = new Set([
  'cli-tui',
  'cli-dispatch-supervisor',
  'cli-hierarchy attach',
  'cli-hierarchy executor-start',
  'cli-hierarchy webhook',
]);

const KINDS = new Set<SpanKind>(['command', 'gate', 'wait']);
/** A label is a short plain phrase: letters, digits, space, `.`, `_`, `:`, `-`. */
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,79}$/;
/** Anything that looks like a credential, or a long opaque run, is never written. */
const SECRET_LIKE =
  /(gh[pousr]_|github_pat_|sk-ant-|sk-[A-Za-z0-9]{12}|xox[abprs]-|AKIA[0-9A-Z]{8}|bearer|token|secret|passw|credential|api[-_ ]?key|[A-Za-z0-9_-]{32,})/i;
const TASK_ID = /^[A-Za-z]+-\d+(\.\d+)*$/;

/** The label when it is safe to store, else undefined. */
export function safeLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const s = raw.trim();
  if (!SAFE_LABEL.test(s) || SECRET_LIKE.test(s)) return undefined;
  return s;
}

/**
 * A span holding only whitelisted fields with checked values; null when the kind is unknown.
 * Unknown fields are dropped and an unsafe name becomes `(redacted)`.
 */
export function sanitizeSpan(input: Record<string, unknown>): TimingSpan | null {
  const kind = input.kind as SpanKind;
  if (!KINDS.has(kind)) return null;
  const started =
    typeof input.startedAt === 'number' ? input.startedAt : Date.parse(String(input.startedAt));
  const duration = Number(input.durationMs);
  const span: TimingSpan = {
    v: 1,
    kind,
    name: safeLabel(input.name) ?? '(redacted)',
    startedAt: new Date(Number.isFinite(started) ? started : 0).toISOString(),
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : 0,
    exitCode: Number.isInteger(input.exitCode) ? (input.exitCode as number) : null,
    pid: Number.isInteger(input.pid) ? (input.pid as number) : 0,
  };
  const sub = safeLabel(input.sub);
  if (sub) span.sub = sub;
  const waitedOn = safeLabel(input.waitedOn);
  if (waitedOn) span.waitedOn = waitedOn;
  if (typeof input.signal === 'string' && /^SIG[A-Z]{2,8}$/.test(input.signal)) {
    span.signal = input.signal;
  }
  if (typeof input.taskId === 'string' && TASK_ID.test(input.taskId)) span.taskId = input.taskId;
  return span;
}

/** The timings file, or null when recording is off. */
export function timingsFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[TIMINGS_FILE_ENV]?.trim();
  if (v === 'off') return null;
  if (v) return path.resolve(v);
  return path.join(os.homedir(), '.ai-sdlc', 'timings.jsonl');
}

/** Slow-span threshold in ms; 0 means no slow notice. */
export function slowSpanMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SLOW_SPAN_ENV]?.trim();
  if (!raw) return DEFAULT_SLOW_SPAN_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : DEFAULT_SLOW_SPAN_MS;
}

/** Append one sanitized span. Best effort: never throws. */
export function appendSpan(
  span: Record<string, unknown> | TimingSpan,
  file: string | null = timingsFile(),
): void {
  if (!file) return;
  try {
    const clean = sanitizeSpan(span as Record<string, unknown>);
    if (!clean) return;
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (statSync(file).size > MAX_FILE_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // no file yet
    }
    appendFileSync(file, `${JSON.stringify(clean)}\n`);
  } catch {
    // timing is best effort
  }
}

/** Spans in the given files (missing files and bad lines are skipped). */
export function readSpans(files: readonly (string | null)[]): TimingSpan[] {
  const out: TimingSpan[] = [];
  for (const f of files) {
    if (!f) continue;
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const s = sanitizeSpan(JSON.parse(line) as Record<string, unknown>);
        if (s) out.push(s);
      } catch {
        // skip a torn line
      }
    }
  }
  return out;
}

/** The timings file and its rotated predecessor. */
export function timingsFiles(env: NodeJS.ProcessEnv = process.env): (string | null)[] {
  const f = timingsFile(env);
  return f ? [`${f}.1`, f] : [];
}

/** `2d 3h`, `1h 5m`, `4m 10s`, `12s`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** `command cli-file task`, `wait verify-slot`. */
export function spanKey(s: Pick<TimingSpan, 'kind' | 'name' | 'sub'>): string {
  return `${s.kind} ${s.name}${s.sub ? ` ${s.sub}` : ''}`;
}

function isLongRunning(s: Pick<TimingSpan, 'name' | 'sub'>): boolean {
  return LONG_RUNNING.has(s.name) || LONG_RUNNING.has(`${s.name} ${s.sub ?? ''}`.trim());
}

// --- spans in flight ---------------------------------------------------------------------------

interface Active {
  kind: SpanKind;
  name: string;
  sub?: string;
  detail?: string;
  startMs: number;
}

export interface SpanHandle {
  /** What the span is waiting on now (shown by the slow notice, stored as `waitedOn`). */
  setDetail(detail: string): void;
  /** Close the span and append it. Later calls do nothing. */
  end(exitCode: number | null, extra?: { signal?: string }): void;
}

export interface SpanOptions {
  sub?: string;
  startMs?: number;
  now?: () => number;
  file?: string | null;
  pid?: number;
  env?: NodeJS.ProcessEnv;
}

const active: Active[] = [];

/** The innermost span in flight in this process. */
export function currentSpan(): Readonly<Active> | undefined {
  return active[active.length - 1];
}

function describeActive(a: Active, nowMs: number): string {
  const detail = a.detail ? ` on ${a.detail}` : '';
  return `${spanKey(a)}${detail} (${formatDuration(nowMs - a.startMs)})`;
}

/** Open a span; it is the current span until it ends or a newer one opens. */
export function startSpan(kind: SpanKind, name: string, opts: SpanOptions = {}): SpanHandle {
  const now = opts.now ?? Date.now;
  const a: Active = { kind, name, startMs: opts.startMs ?? now() };
  if (opts.sub) a.sub = opts.sub;
  active.push(a);
  let done = false;
  return {
    setDetail(detail) {
      a.detail = detail;
    },
    end(exitCode, extra = {}) {
      if (done) return;
      done = true;
      const i = active.lastIndexOf(a);
      if (i >= 0) active.splice(i, 1);
      const env = opts.env ?? process.env;
      appendSpan(
        {
          kind,
          name,
          sub: a.sub,
          waitedOn: kind === 'wait' ? (a.detail ?? 'none') : undefined,
          startedAt: a.startMs,
          durationMs: now() - a.startMs,
          exitCode,
          signal: extra.signal,
          pid: opts.pid ?? process.pid,
          taskId: env.AI_SDLC_ACTIVE_TASK_ID || env.AI_SDLC_EXECUTOR_TASK,
        },
        opts.file === undefined ? timingsFile(env) : opts.file,
      );
    },
  };
}

export interface SlowWatchOptions {
  thresholdMs: number;
  repeatMs?: number;
  now?: () => number;
  write?: (line: string) => void;
}

/**
 * Print the outermost and the current span with elapsed times once the outermost span passes
 * the threshold, then every `repeatMs`. Timers are unref'd. Returns a stop function.
 */
export function startSlowWatch(opts: SlowWatchOptions): () => void {
  const now = opts.now ?? Date.now;
  const write = opts.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const repeat = opts.repeatMs ?? SLOW_REPEAT_MS;
  let interval: ReturnType<typeof setInterval> | undefined;
  const notice = () => {
    const root = active[0];
    const cur = currentSpan();
    if (!root || !cur) return;
    const t = now();
    write(
      `[ai-sdlc-timing] ${spanKey(root)} still running after ${formatDuration(t - root.startMs)}; current span: ${describeActive(cur, t)}`,
    );
  };
  const first = setTimeout(() => {
    notice();
    interval = setInterval(notice, repeat);
    interval.unref?.();
  }, opts.thresholdMs);
  first.unref?.();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}

// --- the command span of a bin -----------------------------------------------------------------

/** The parts of `process` the command span uses. */
export interface CommandProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  listenerCount(event: string): number;
  exit(code?: number): unknown;
}

export interface CommandSpanOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  startMs?: number;
  now?: () => number;
  write?: (line: string) => void;
}

/** `cli-file` from `/x/pipeline-cli/bin/cli-file.mjs`; undefined for anything else. */
export function commandName(script: string | undefined): string | undefined {
  if (!script) return undefined;
  return safeLabel(path.basename(script).replace(/\.(mjs|cjs|js)$/, ''));
}

/** The subcommand word: the first argument when it is a lowercase word (never a flag or value). */
export function subcommand(argv: readonly string[]): string | undefined {
  const a = argv[2];
  return a && /^[a-z][a-z0-9-]{0,39}$/.test(a) ? safeLabel(a) : undefined;
}

const SIGNAL_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };

/**
 * Time this process as one `command` span: appended on exit with the exit code, on failure and
 * on SIGINT or SIGTERM. With no other handler for the signal the process exits 128 + signal;
 * when the command has its own handler, that handler decides and the span records the signal.
 */
export function installCommandSpan(proc: CommandProcess, opts: CommandSpanOptions = {}): void {
  const argv = opts.argv ?? process.argv;
  const env = opts.env ?? process.env;
  const name = commandName(argv[1]);
  if (!name) return;
  const sub = subcommand(argv);
  const now = opts.now ?? Date.now;
  const span = startSpan('command', name, {
    ...(sub ? { sub } : {}),
    startMs: opts.startMs ?? now(),
    now,
    env,
  });
  const threshold = slowSpanMs(env);
  const stop =
    threshold > 0 && !isLongRunning({ name, sub })
      ? startSlowWatch({
          thresholdMs: threshold,
          now,
          ...(opts.write ? { write: opts.write } : {}),
        })
      : () => {};
  let signal: string | undefined;
  proc.on('exit', (code) => {
    stop();
    span.end(typeof code === 'number' ? code : null, signal ? { signal } : {});
  });
  for (const sig of Object.keys(SIGNAL_CODES)) {
    proc.on(sig, () => {
      signal = sig;
      if (proc.listenerCount(sig) === 1) proc.exit(SIGNAL_CODES[sig]);
    });
  }
}

// --- report ------------------------------------------------------------------------------------

export interface TimingGroup {
  key: string;
  kind: SpanKind;
  count: number;
  failures: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface TimingsReport {
  since: string;
  until: string;
  groups: TimingGroup[];
  slowest: TimingSpan[];
}

/** Nearest-rank percentile (0 for an empty list). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function inWindow(spans: readonly TimingSpan[], sinceMs: number, untilMs: number): TimingSpan[] {
  return spans.filter((s) => {
    const t = Date.parse(s.startedAt) + s.durationMs;
    return t >= sinceMs && t <= untilMs;
  });
}

/** p50, p95 and max per command, gate and wait, and the `top` slowest spans, over a window. */
export function timingsReport(
  spans: readonly TimingSpan[],
  now: Date,
  windowMs: number,
  top = 10,
): TimingsReport {
  const until = now.getTime();
  const since = until - windowMs;
  const recent = inWindow(spans, since, until);
  const byKey = new Map<string, TimingSpan[]>();
  for (const s of recent) {
    const k = spanKey(s);
    byKey.set(k, [...(byKey.get(k) ?? []), s]);
  }
  const groups: TimingGroup[] = [...byKey.entries()].map(([key, list]) => {
    const d = list.map((s) => s.durationMs);
    return {
      key,
      kind: list[0]!.kind,
      count: list.length,
      failures: list.filter((s) => s.exitCode !== 0).length,
      p50Ms: percentile(d, 50),
      p95Ms: percentile(d, 95),
      maxMs: Math.max(...d),
    };
  });
  const order: SpanKind[] = ['command', 'gate', 'wait'];
  groups.sort(
    (a, b) =>
      order.indexOf(a.kind) - order.indexOf(b.kind) ||
      b.p95Ms - a.p95Ms ||
      a.key.localeCompare(b.key),
  );
  const slowest = [...recent].sort((a, b) => b.durationMs - a.durationMs).slice(0, top);
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    groups,
    slowest,
  };
}

/** Report durations keep sub-second precision: `840ms`, then `formatDuration`. */
function reportDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : formatDuration(ms);
}

function describeSpan(s: TimingSpan): string {
  const parts = [
    `${spanKey(s)}${s.waitedOn ? ` on ${s.waitedOn}` : ''}`,
    reportDuration(s.durationMs),
    s.signal ? s.signal : `exit ${s.exitCode ?? '?'}`,
    `at ${s.startedAt}`,
    ...(s.taskId ? [`task ${s.taskId}`] : []),
  ];
  return parts.join(', ');
}

export function formatTimingsReport(r: TimingsReport): string {
  const lines = [`timings ${r.since} .. ${r.until}`];
  if (r.groups.length === 0) return `${lines[0]}\nno spans recorded in this window\n`;
  const w = Math.max(...r.groups.map((g) => g.key.length), 4);
  lines.push(`${'span'.padEnd(w)}  count  fail       p50       p95       max`);
  for (const g of r.groups) {
    lines.push(
      `${g.key.padEnd(w)}  ${String(g.count).padStart(5)}  ${String(g.failures).padStart(4)}  ${reportDuration(g.p50Ms).padStart(8)}  ${reportDuration(g.p95Ms).padStart(8)}  ${reportDuration(g.maxMs).padStart(8)}`,
    );
  }
  lines.push('', 'slowest spans:');
  for (const s of r.slowest) lines.push(`  ${describeSpan(s)}`);
  return `${lines.join('\n')}\n`;
}

/** Spans over the threshold that ended in the last hour, slowest first (long-running excluded). */
export function recentSlowSpans(
  spans: readonly TimingSpan[],
  now: Date,
  thresholdMs: number,
): TimingSpan[] {
  if (thresholdMs <= 0) return [];
  return inWindow(spans, now.getTime() - HOUR_MS, now.getTime())
    .filter((s) => s.durationMs > thresholdMs && !isLongRunning(s))
    .sort((a, b) => b.durationMs - a.durationMs);
}

/** Status lines for the slow spans; empty when there are none. */
export function formatSlowSpans(slow: readonly TimingSpan[], thresholdMs: number): string[] {
  if (slow.length === 0) return [];
  return [
    `slow spans in the last hour (over ${formatDuration(thresholdMs)}): ${slow.length}`,
    ...slow.slice(0, 10).map((s) => `  ${describeSpan(s)}`),
  ];
}
