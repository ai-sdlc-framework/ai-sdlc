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

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  appendModelCalls,
  readCursor,
  resolveUsageDir,
  withUsageLock,
  writeCursor,
  type ModelCallRecord,
  type UsageStoreOptions,
} from '@ai-sdlc/reference';
import { attributeCodexSession, type CodexAttribution } from './codex-attribution.js';
import { LIMIT_EVENTS_FILE, LimitEventLog } from './limit-event-log.js';
import { MAX_LINE_BYTES, readLines } from './line-reader.js';

export const CODEX_HOME_ENV = 'CODEX_HOME';
export { LIMIT_EVENTS_FILE };
const CURSOR_PREFIX = 'codex:';
/** A session file larger than this is skipped, not parsed. */
export const MAX_SESSION_FILE_BYTES = 256 * 1024 * 1024;
/**
 * A session that reports only a cumulative total is recorded once its file has
 * been quiet this long, so a mid-session ingest cannot freeze a partial total.
 */
export const TOTAL_ONLY_QUIET_MS = 15 * 60 * 1000;

export interface CodexIngestOptions extends UsageStoreOptions {
  /** Sessions directory. Defaults to `$CODEX_HOME/sessions`, then `~/.codex/sessions`. */
  sessionsDir?: string;
  /** Ignore stored cursors and re-read every file (the store still deduplicates). */
  backfill?: boolean;
  /** Skip `other`-scope sessions entirely. Defaults to `AI_SDLC_USAGE_SCOPE=framework-only`. */
  frameworkOnly?: boolean;
  /** Skip session files larger than this many bytes. Defaults to 256 MiB. */
  maxFileBytes?: number;
  /** Drop lines longer than this many bytes. Defaults to 4 MiB. */
  maxLineBytes?: number;
  /** Quiet period before a total-only session counts as finished. */
  totalOnlyQuietMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export interface CodexIngestResult {
  filesScanned: number;
  written: number;
  skipped: number;
  invalid: number;
  limitEvents: number;
  errors: number;
  /** Session files skipped for exceeding the size cap, and lines dropped for exceeding the line cap. */
  oversized: number;
  /** Total-only sessions held back because they may still be running. */
  deferred: number;
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
 * separated here so each token class is priced once. Codex reports one
 * cache-write figure with no duration, so every cache write is filed under the
 * five-minute cache-write class.
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
  oversizeLines: number;
  /** True when a total-only session was held back because it may still be running. */
  deferred: boolean;
}

interface ProcessOptions {
  frameworkOnly: boolean;
  maxLineBytes: number;
  maxFileBytes: number;
  /** True once the file has been quiet long enough to count a total-only session as finished. */
  settled: boolean;
}

function processFile(
  path: string,
  cursor: number,
  opts: ProcessOptions,
  attrCache: Map<string, CodexAttribution>,
): FileOutcome {
  let sessionId = basename(path, '.jsonl');
  let cwd: string | undefined;
  let branch: string | undefined;
  let model = 'unknown';
  let provider = 'openai';
  const events: TokenEvent[] = [];
  let ordinal = 0;

  // Lines are streamed in bounded chunks; only the small token events are kept.
  const read = readLines(path, {
    start: 0,
    maxBytes: opts.maxFileBytes,
    maxLineBytes: opts.maxLineBytes,
    onLine: (text, offset) => {
      let value: Record<string, unknown>;
      try {
        const v: unknown = JSON.parse(text);
        if (!isObject(v)) return true;
        value = v;
      } catch {
        // A corrupt complete line is skipped and the cursor moves past it, so it
        // is not retried: it cannot become valid later. (A truncated last line has
        // no newline and is never delivered here, so it is retried next run.)
        return true;
      }
      const payload = isObject(value.payload) ? value.payload : undefined;
      if (!payload) return true;
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
      return true;
    },
  });

  const out: FileOutcome = {
    records: [],
    limits: [],
    consumed: read.consumed,
    oversizeLines: read.oversizeLines,
    deferred: false,
  };
  const attr = attributeCodexSession(cwd, branch, attrCache);
  if (attr.scope === 'other' && opts.frameworkOnly) return out;

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
    ...(attr.repoId ? { repoId: attr.repoId } : {}),
    ...(attr.repoIdUnavailable ? { repoIdUnavailable: true as const } : {}),
    ...(attr.taskId ? { taskId: attr.taskId } : {}),
    ...(attr.scope === 'framework' ? { source: { file: path, offset } } : {}),
  });

  // Rate-limit observations. The limit log deduplicates, so re-reading is safe.
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
    if (final?.total && !opts.settled) {
      // The session may still be running and its total still growing; the record
      // is keyed once per session, so recording now would freeze a partial total.
      out.deferred = true;
    } else if (final?.total) {
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

/** Ingest every Codex session file under the sessions directory. Never throws. */
export function ingestCodexSessions(opts: CodexIngestOptions = {}): CodexIngestResult {
  const result: CodexIngestResult = {
    filesScanned: 0,
    written: 0,
    skipped: 0,
    invalid: 0,
    limitEvents: 0,
    errors: 0,
    oversized: 0,
    deferred: 0,
  };
  const frameworkOnly = opts.frameworkOnly ?? process.env.AI_SDLC_USAGE_SCOPE === 'framework-only';
  const sessionsDir = opts.sessionsDir ?? defaultCodexSessionsDir();
  const attrCache = new Map<string, CodexAttribution>();
  const maxFileBytes = opts.maxFileBytes ?? MAX_SESSION_FILE_BYTES;
  const maxLineBytes = opts.maxLineBytes ?? MAX_LINE_BYTES;
  const quietMs = opts.totalOnlyQuietMs ?? TOTAL_ONLY_QUIET_MS;
  const now = opts.now ?? Date.now;
  const limitLog = new LimitEventLog<CodexLimitEvent>(resolveUsageDir(opts), withUsageLock, (e) =>
    e.harness === 'codex' ? `codex|${e.ts}|${e.sessionId}|${e.window}|${e.usedPercent}` : undefined,
  );

  for (const file of listSessionFiles(sessionsDir)) {
    result.filesScanned++;
    try {
      const st = statSync(file);
      if (st.size > maxFileBytes) {
        result.oversized++;
        continue;
      }
      const key = `${CURSOR_PREFIX}${file}`;
      const cursor = opts.backfill ? 0 : readCursor(key, opts);
      if (!opts.backfill && cursor >= st.size) continue;
      const outcome = processFile(
        file,
        cursor,
        {
          frameworkOnly,
          maxLineBytes,
          maxFileBytes,
          settled: now() - st.mtimeMs >= quietMs,
        },
        attrCache,
      );
      result.oversized += outcome.oversizeLines;
      const res = appendModelCalls(outcome.records, opts);
      result.written += res.written;
      result.skipped += res.skipped;
      result.invalid += res.invalid;
      result.limitEvents += limitLog.append(outcome.limits);
      if (outcome.deferred) {
        // Leave the cursor where it was so the next run reads the finished session.
        result.deferred++;
        continue;
      }
      writeCursor(key, outcome.consumed, opts);
    } catch {
      result.errors++;
    }
  }
  return result;
}
