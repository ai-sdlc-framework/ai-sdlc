/**
 * Codex session ingester (RFC-0050 A2).
 *
 * Reads Codex session files (one JSONL per session under the Codex home's
 * `sessions` directory) and appends one ledger record per turn, taken from the
 * `last_token_usage` of each `token_count` event. A session that only reports a
 * cumulative total yields one record flagged `breakdownMissing`.
 *
 * Only counts, ids and attribution are read into records: message text, tool
 * output and file content in the session file are never inspected or stored.
 *
 * Incremental (a byte offset per file in `cursors.json`) and idempotent (the
 * store skips a `callId` it already holds). Every failure is contained per file.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  appendModelCalls,
  readCursor,
  resolveUsageDir,
  writeCursor,
  type ModelCallRecord,
  type UsageStoreOptions,
} from '@ai-sdlc/reference';
import { attributeCodexSession, type CodexAttribution } from './codex-attribution.js';

export const CODEX_HOME_ENV = 'CODEX_HOME';
export const LIMIT_EVENTS_FILE = 'limit-events.jsonl';
const CURSOR_PREFIX = 'codex:';

export interface CodexIngestOptions extends UsageStoreOptions {
  /** Sessions directory. Defaults to `$CODEX_HOME/sessions`, then `~/.codex/sessions`. */
  sessionsDir?: string;
  /** Ignore stored cursors and re-read every file (the store still deduplicates). */
  backfill?: boolean;
  /** Skip `other`-scope sessions entirely. Defaults to `AI_SDLC_USAGE_SCOPE=framework-only`. */
  frameworkOnly?: boolean;
}

export interface CodexIngestResult {
  filesScanned: number;
  written: number;
  skipped: number;
  invalid: number;
  limitEvents: number;
  errors: number;
}

/** A window observation taken from a `rate_limits` object. */
export interface CodexLimitEvent {
  ts: string;
  harness: 'codex';
  sessionId: string;
  window: string;
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
}

export function defaultCodexSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env[CODEX_HOME_ENV];
  return join(home || join(homedir(), '.codex'), 'sessions');
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function listSessionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

interface ParsedLine {
  offset: number;
  value: Record<string, unknown>;
}

/** Complete lines of the file with their byte offsets, and the offset consumed. */
function readLines(path: string): { lines: ParsedLine[]; consumed: number } {
  const buf = readFileSync(path);
  const lines: ParsedLine[] = [];
  let start = 0;
  let consumed = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    const end = nl === -1 ? buf.length : nl;
    const text = buf.subarray(start, end).toString('utf-8').trim();
    let ok = true;
    if (text) {
      try {
        const v: unknown = JSON.parse(text);
        if (isObject(v)) lines.push({ offset: start, value: v });
      } catch {
        // A truncated last line is retried next run; a corrupt complete line is skipped.
        ok = nl !== -1;
      }
    }
    if (!ok) break;
    consumed = nl === -1 ? buf.length : nl + 1;
    start = consumed;
  }
  return { lines, consumed };
}

interface TokenEvent {
  offset: number;
  ordinal: number;
  ts: string;
  model: string;
  last?: Record<string, unknown>;
  total?: Record<string, unknown>;
  rateLimits?: Record<string, unknown>;
}

function observationsOf(
  rl: Record<string, unknown>,
  ts: string,
  sessionId: string,
): CodexLimitEvent[] {
  const out: CodexLimitEvent[] = [];
  for (const [window, raw] of Object.entries(rl)) {
    if (!isObject(raw)) continue;
    const used = raw.used_percent;
    if (typeof used !== 'number' || !Number.isFinite(used)) continue;
    const ev: CodexLimitEvent = { ts, harness: 'codex', sessionId, window, usedPercent: used };
    if (typeof raw.window_minutes === 'number') ev.windowMinutes = raw.window_minutes;
    const resets = raw.resets_at;
    if (typeof resets === 'number' && Number.isFinite(resets)) {
      const d = new Date(resets < 1e12 ? resets * 1000 : resets);
      if (!Number.isNaN(d.getTime())) ev.resetsAt = d.toISOString();
    } else if (typeof resets === 'string' && !Number.isNaN(new Date(resets).getTime())) {
      ev.resetsAt = new Date(resets).toISOString();
    }
    out.push(ev);
  }
  return out;
}

/**
 * Codex counts cached and cache-write tokens inside `input_tokens`. They are
 * separated here so each token class is priced once.
 */
function turnTokens(u: Record<string, unknown>): ModelCallRecord['tokens'] {
  const cached = num(u.cached_input_tokens);
  const write = num(u.cache_write_input_tokens);
  const reasoning = num(u.reasoning_output_tokens);
  const hasReasoning = u.reasoning_output_tokens !== undefined;
  return {
    input: Math.max(0, num(u.input_tokens) - cached - write),
    cacheWrite5m: write,
    cacheWrite1h: 0,
    cacheRead: cached,
    output: num(u.output_tokens),
    ...(hasReasoning ? { reasoning } : {}),
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface FileOutcome {
  records: ModelCallRecord[];
  limits: CodexLimitEvent[];
  consumed: number;
}

function processFile(
  path: string,
  cursor: number,
  frameworkOnly: boolean,
  attrCache: Map<string, CodexAttribution>,
): FileOutcome {
  const { lines, consumed } = readLines(path);
  let sessionId = basename(path, '.jsonl');
  let cwd: string | undefined;
  let branch: string | undefined;
  let model = 'unknown';
  let provider = 'openai';
  const events: TokenEvent[] = [];
  let ordinal = 0;

  for (const { offset, value } of lines) {
    const payload = isObject(value.payload) ? value.payload : undefined;
    if (!payload) continue;
    if (value.type === 'session_meta') {
      sessionId = str(payload.id) ?? sessionId;
      cwd = str(payload.cwd) ?? cwd;
      model = str(payload.model) ?? model;
      provider = str(payload.model_provider) ?? provider;
      if (isObject(payload.git)) branch = str(payload.git.branch) ?? branch;
    } else if (value.type === 'turn_context') {
      cwd = cwd ?? str(payload.cwd);
      model = str(payload.model) ?? model;
    } else if (value.type === 'event_msg' && payload.type === 'token_count') {
      const info = isObject(payload.info) ? payload.info : payload;
      const ts = str(value.timestamp);
      if (ts && !Number.isNaN(new Date(ts).getTime())) {
        events.push({
          offset,
          ordinal,
          ts,
          model,
          last: isObject(info.last_token_usage) ? info.last_token_usage : undefined,
          total: isObject(info.total_token_usage) ? info.total_token_usage : undefined,
          rateLimits:
            isObject(payload.rate_limits) && Object.keys(payload.rate_limits).length > 0
              ? payload.rate_limits
              : undefined,
        });
      }
      ordinal++;
    }
  }

  const attr = attributeCodexSession(cwd, branch, attrCache);
  const out: FileOutcome = { records: [], limits: [], consumed };
  if (attr.scope === 'other' && frameworkOnly) return out;

  const base = (callId: string, ev: TokenEvent, offset: number) => ({
    schemaVersion: 'v1' as const,
    callId,
    ts: new Date(ev.ts).toISOString(),
    harness: 'codex' as const,
    provider,
    model: ev.model,
    billingPool: 'codex-plan' as const,
    sessionId,
    agentRole: 'main-session',
    scope: attr.scope,
    ...(attr.repo ? { repo: attr.repo } : {}),
    ...(attr.taskId ? { taskId: attr.taskId } : {}),
    ...(attr.scope === 'framework' ? { source: { file: path, offset } } : {}),
  });

  // Rate-limit observations (only lines not yet consumed by an earlier run).
  let prevRl: unknown;
  for (const ev of events) {
    if (!ev.rateLimits) continue;
    if (ev.offset >= cursor && !sameJson(prevRl, ev.rateLimits)) {
      out.limits.push(...observationsOf(ev.rateLimits, new Date(ev.ts).toISOString(), sessionId));
    }
    prevRl = ev.rateLimits;
  }

  const perTurn = events.some((e) => e.last);
  if (perTurn) {
    let prevTotal: unknown;
    for (const ev of events) {
      const isRepeat = ev.total !== undefined && sameJson(ev.total, prevTotal);
      if (ev.total) prevTotal = ev.total;
      if (!ev.last || isRepeat || ev.offset < cursor) continue;
      out.records.push({
        ...base(`codex:${sessionId}:${ev.ordinal}`, ev, ev.offset),
        tokens: turnTokens(ev.last),
      });
    }
  } else {
    const withTotal = events.filter((e) => e.total);
    const final = withTotal[withTotal.length - 1];
    if (final?.total) {
      const total =
        num(final.total.total_tokens) ||
        num(final.total.input_tokens) + num(final.total.output_tokens);
      out.records.push({
        ...base(`codex:${sessionId}:total`, final, final.offset),
        tokens: { input: total, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
        breakdownMissing: true,
      });
    }
  }
  return out;
}

function appendLimitEvents(events: CodexLimitEvent[], opts: UsageStoreOptions): void {
  if (events.length === 0) return;
  const dir = resolveUsageDir(opts);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(
    join(dir, LIMIT_EVENTS_FILE),
    events.map((e) => `${JSON.stringify(e)}\n`).join(''),
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  );
}

/** Ingest every Codex session file under the sessions directory. Never throws. */
export function ingestCodexSessions(opts: CodexIngestOptions = {}): CodexIngestResult {
  const result: CodexIngestResult = {
    filesScanned: 0,
    written: 0,
    skipped: 0,
    invalid: 0,
    limitEvents: 0,
    errors: 0,
  };
  const frameworkOnly = opts.frameworkOnly ?? process.env.AI_SDLC_USAGE_SCOPE === 'framework-only';
  const sessionsDir = opts.sessionsDir ?? defaultCodexSessionsDir();
  const attrCache = new Map<string, CodexAttribution>();

  for (const file of listSessionFiles(sessionsDir)) {
    result.filesScanned++;
    try {
      const key = `${CURSOR_PREFIX}${file}`;
      const cursor = opts.backfill ? 0 : readCursor(key, opts);
      if (!opts.backfill && cursor >= statSync(file).size) continue;
      const outcome = processFile(file, cursor, frameworkOnly, attrCache);
      const res = appendModelCalls(outcome.records, opts);
      appendLimitEvents(outcome.limits, opts);
      result.written += res.written;
      result.skipped += res.skipped;
      result.invalid += res.invalid;
      result.limitEvents += outcome.limits.length;
      writeCursor(key, outcome.consumed, opts);
    } catch {
      result.errors++;
    }
  }
  return result;
}
