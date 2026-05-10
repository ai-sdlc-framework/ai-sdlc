/**
 * `cli-tui-corpus` — aggregate TUI usage events from
 * `$ARTIFACTS_DIR/_tui/events.jsonl` into a soak-window report that
 * drives the RFC-0023 §13 Phase 7 promotion decision.
 *
 * Sister CLI to `cli-orchestrator-corpus` (AISDLC-169.5) and
 * `cli-deps-corpus` (AISDLC-167.5). The three share aesthetic
 * conventions (find-files-recursively, recommendation envelope,
 * JSON-or-table output, `safe-to-promote | continue-soak |
 * insufficient-data` recommendation) but answer different questions:
 *
 *   - `cli-dor-corpus`           → "is the DoR rubric ready for `enforce`?"
 *   - `cli-deps-corpus`          → "is the dependency-graph composition
 *                                  layer ready for default-on?"
 *   - `cli-orchestrator-corpus`  → "is the autonomous orchestrator ready
 *                                  for default-on?"
 *   - `cli-tui-corpus`           → "is the operator TUI ready to flip
 *                                  AI_SDLC_TUI from experimental to
 *                                  default-on?" (session-frequency +
 *                                  pane-open distribution + time-to-
 *                                  decision trend + zero-crash gate)
 *
 * Per RFC-0023 §13 Phase 7 acceptance criteria (corpus-driven, NOT
 * calendar-gated per maintainer directive 2026-05-01):
 *
 *   - TuiCrashed count MUST be 0 (hard gate — any crash blocks promotion)
 *   - ≥ 100 sessions over ≥ 7 distinct calendar days (soak window)
 *   - At least one pane other than overview opened in ≥ 50% of sessions
 *     (confirms operators are navigating, not just glancing)
 *   - captures-filed-during-soak ≥ 0 (informational; does not gate)
 *
 * Hybrid promotion model (mirrors AISDLC-161 / AISDLC-167.5 / AISDLC-169.5):
 *   - `recommendation: 'safe-to-promote'`  → operator can flip the
 *     `AI_SDLC_TUI` default OFF → ON (single PR, runbook in
 *     `docs/operations/operator-tui-promotion.md`).
 *   - `recommendation: 'continue-soak'`     → keep gathering data; the
 *     `reason` field names the failing metric.
 *   - `recommendation: 'insufficient-data'` → use the operator-override
 *     spot-check path described in the runbook (corpus too sparse for
 *     statistical confidence).
 *
 * **Signal source**: `events.jsonl` artifacts written to
 * `$ARTIFACTS_DIR/_tui/events.jsonl`. Each line is one `TuiEvent`.
 * The aggregator groups sessions by `sessionId` stamped on every event
 * so multi-day sessions are counted once rather than once-per-day.
 *
 * **TuiEvent shape** (discriminated union keyed on `type`):
 *
 *   - `TuiSessionStarted`  { ts, type, sessionId, date }
 *   - `TuiSessionEnded`    { ts, type, sessionId, durationMs }
 *   - `TuiPaneOpened`      { ts, type, sessionId, pane }
 *   - `TuiCrashed`         { ts, type, sessionId, error }
 *   - `TuiCaptureFiled`    { ts, type, sessionId, captureId, pane? }
 *
 * Usage:
 *   $ cli-tui-corpus aggregate $ARTIFACTS_DIR/_tui/events.jsonl
 *   $ cli-tui-corpus aggregate ./tui-corpus --format table
 *   $ cli-tui-corpus aggregate ./tui-corpus --min-samples 50 --since 2026-05-01
 *
 * @module tui/corpus/aggregate
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

// ── Defaults from RFC-0023 §13 Phase 7 ──────────────────────────────────

/**
 * Minimum session count for `safe-to-promote` (RFC-0023 §13 Phase 7:
 * "≥ 100 sessions"). Tunable via `--min-samples`.
 */
const DEFAULT_MIN_SAMPLES = 100;

/**
 * Minimum distinct calendar days for `safe-to-promote` (RFC-0023 §13
 * Phase 7: "≥ 7 calendar days"). Tunable via `--min-days`.
 */
const DEFAULT_MIN_DAYS = 7;

/**
 * Minimum fraction of sessions that opened at least one non-overview
 * pane (confirms navigational engagement). Tunable via
 * `--pane-open-threshold`.
 */
const DEFAULT_PANE_OPEN_THRESHOLD = 0.5;

// ── Public types ────────────────────────────────────────────────────────

export type Recommendation = 'insufficient-data' | 'safe-to-promote' | 'continue-soak';

/**
 * Discriminated TUI event — each line in `events.jsonl` is one of
 * these. The aggregator validates `ts` + `type` as the minimal
 * envelope; extra fields are per-type.
 */
export interface TuiEvent {
  /** ISO-8601 wall-clock. */
  ts: string;
  /** Event type discriminator. */
  type: string;
  /** Session UUID — groups all events in one TUI launch. */
  sessionId?: string;
  /** TuiSessionEnded only: wall-clock duration of the session in ms. */
  durationMs?: number;
  /** TuiPaneOpened only: which pane was opened (e.g. `blockers`, `prs`). */
  pane?: string;
  /** TuiCrashed only: error message. */
  error?: string;
  /** TuiCaptureFiled only: an RFC-0024 capture ID or similar reference. */
  captureId?: string;
  /** Catch-all for future fields. */
  [key: string]: unknown;
}

/**
 * One row in the per-session breakdown — derived from all events sharing
 * a single `sessionId`. Sessions without a `sessionId` are bucketed into
 * the synthetic `'(unknown-session)'` group.
 */
export interface SessionSummary {
  /** Session UUID (or `'(unknown-session)'` for envelope-less events). */
  sessionId: string;
  /** Earliest `ts` observed in the session. */
  firstSeen: string;
  /** Latest `ts` observed in the session. */
  lastSeen: string;
  /** Calendar date derived from `firstSeen` (`YYYY-MM-DD`). */
  date: string;
  /** True when a `TuiSessionEnded` event was observed. */
  ended: boolean;
  /** Wall-clock duration in ms from `TuiSessionEnded`, or 0 when absent. */
  durationMs: number;
  /** Panes opened in this session (deduplicated). */
  panesOpened: string[];
  /** Whether any pane OTHER than overview was opened. */
  navigated: boolean;
  /** Count of `TuiCrashed` events in this session. */
  crashCount: number;
  /** Count of `TuiCaptureFiled` events in this session. */
  capturesFiled: number;
}

export interface AggregateMetrics {
  /** Total sessions in the corpus. */
  sessionCount: number;
  /** Number of files we attempted to read. */
  filesRead: number;
  /** Number of files we couldn't parse. */
  skippedFiles: number;
  /** Number of malformed JSONL lines skipped across all files. */
  skippedLines: number;
  /** Number of distinct calendar days in the corpus. */
  distinctDays: number;
  /** Total `TuiCrashed` events across the corpus (MUST be 0 for promotion). */
  crashCount: number;
  /** Total `TuiCaptureFiled` events across the corpus (informational). */
  capturesFiled: number;
  /**
   * Fraction of sessions in which at least one non-overview pane was
   * opened (`navigated=true`). 0 when sessionCount=0.
   */
  paneEngagementRate: number;
  /**
   * Pane-open distribution: for each pane, the fraction of sessions that
   * opened it at least once.
   */
  paneOpenDistribution: Record<string, number>;
  /**
   * Time-to-decision trend: average session duration in ms across the
   * corpus. Only sessions with a `TuiSessionEnded` event contribute to
   * this average. Null when no ended sessions.
   */
  avgSessionDurationMs: number | null;
  /** Operator-facing recommendation. */
  recommendation: Recommendation;
  /** Human-readable rationale (operator log line). */
  reason: string;
}

export interface CorpusReport {
  perSession: SessionSummary[];
  aggregate: AggregateMetrics;
}

export interface AggregateOpts {
  /** Below this session count, recommendation is forced `insufficient-data`. */
  minSamples?: number;
  /** Below this distinct-day count, recommendation is forced `insufficient-data`. */
  minDays?: number;
  /** Minimum pane-engagement rate for `safe-to-promote`. */
  paneOpenThreshold?: number;
  /** Filter: only include sessions whose `date` is >= this ISO date (YYYY-MM-DD). */
  since?: string;
  /** Filter: only include sessions whose `date` is <= this ISO date (YYYY-MM-DD). */
  until?: string;
}

// ── File walking ─────────────────────────────────────────────────────────

/**
 * Recursively walk a directory and return every `.jsonl` file. Mirrors
 * `cli-orchestrator-corpus#findEventsFiles` so operator workflows are
 * symmetric.
 *
 * Single-file inputs are also supported — a path that is itself a JSONL
 * file is returned as a single-element array.
 */
export function findTuiEventsFiles(rootPath: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let s;
    try {
      s = statSync(current);
    } catch {
      continue;
    }
    if (s.isFile()) {
      if (current.endsWith('.jsonl')) out.push(current);
      continue;
    }
    if (!s.isDirectory()) continue;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const e of entries) stack.push(join(current, e));
  }
  return out.sort();
}

/**
 * Validate that an arbitrary parsed JSONL line is shape-compatible with
 * a `TuiEvent`. Structural duck-typing on the fields the aggregator
 * actually consumes — extra fields are fine, missing fields aren't.
 */
export function isValidTuiEvent(raw: unknown): raw is TuiEvent {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  if (typeof e.ts !== 'string' || e.ts.length === 0) return false;
  if (typeof e.type !== 'string' || e.type.length === 0) return false;
  return true;
}

export interface LoadedEventsFile {
  path: string;
  events: TuiEvent[];
}

/**
 * Load + parse every events file from a list. Malformed lines are
 * silently skipped (counted), files that fail to parse entirely are
 * reported via `skippedFiles`. Matches the
 * `cli-orchestrator-corpus#loadEventsCorpus` shape so the call sites
 * read identically.
 */
export function loadTuiEventsCorpus(files: string[]): {
  files: LoadedEventsFile[];
  skippedFiles: number;
  skippedLines: number;
} {
  const loaded: LoadedEventsFile[] = [];
  let skippedFiles = 0;
  let skippedLines = 0;

  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(f, 'utf8');
    } catch {
      skippedFiles += 1;
      continue;
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      skippedFiles += 1;
      continue;
    }
    const events: TuiEvent[] = [];
    let allMalformed = true;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skippedLines += 1;
        continue;
      }
      if (!isValidTuiEvent(parsed)) {
        skippedLines += 1;
        continue;
      }
      events.push(parsed);
      allMalformed = false;
    }
    if (allMalformed) {
      skippedFiles += 1;
      continue;
    }
    loaded.push({ path: f, events });
  }

  return { files: loaded, skippedFiles, skippedLines };
}

// ── Aggregation ──────────────────────────────────────────────────────────

/**
 * Extract a `YYYY-MM-DD` date from an ISO-8601 timestamp. Falls back to
 * the empty string on any parse failure so callers don't have to guard.
 */
function isoDate(ts: string): string {
  return ts.slice(0, 10);
}

/**
 * Summarise a single session from its events.
 */
function summariseSession(sessionId: string, events: TuiEvent[]): SessionSummary {
  let firstSeen = events[0]?.ts ?? '';
  let lastSeen = events[0]?.ts ?? '';
  let ended = false;
  let durationMs = 0;
  let crashCount = 0;
  let capturesFiled = 0;
  const panesSet = new Set<string>();

  for (const e of events) {
    if (e.ts < firstSeen) firstSeen = e.ts;
    if (e.ts > lastSeen) lastSeen = e.ts;

    switch (e.type) {
      case 'TuiSessionEnded':
        ended = true;
        if (typeof e.durationMs === 'number' && e.durationMs >= 0) {
          durationMs = e.durationMs;
        }
        break;
      case 'TuiPaneOpened':
        if (typeof e.pane === 'string' && e.pane.length > 0) {
          panesSet.add(e.pane);
        }
        break;
      case 'TuiCrashed':
        crashCount += 1;
        break;
      case 'TuiCaptureFiled':
        capturesFiled += 1;
        break;
      default:
        break;
    }
  }

  const panesOpened = [...panesSet].sort();
  // "navigated" = opened any pane other than overview; the overview is the
  // default landing and doesn't demonstrate active navigation.
  const navigated = panesOpened.some((p) => p !== 'overview');
  const date = isoDate(firstSeen);

  return {
    sessionId,
    firstSeen,
    lastSeen,
    date,
    ended,
    durationMs,
    panesOpened,
    navigated,
    crashCount,
    capturesFiled,
  };
}

/**
 * Bucket events by `sessionId` and derive the per-session + corpus-wide
 * metrics the recommendation envelope needs.
 *
 * Pure function — no I/O — so tests can pass synthetic event arrays and
 * snapshot the output. The CLI front-end is a thin shell around
 * `loadTuiEventsCorpus()` + this function + a renderer.
 *
 * Recommendation gating (in priority order):
 *   - `TuiCrashed > 0`                              → 'continue-soak'
 *     (hard gate — any crash blocks promotion)
 *   - `sessionCount < minSamples` OR
 *     `distinctDays < minDays`                       → 'insufficient-data'
 *   - `paneEngagementRate < paneOpenThreshold`       → 'continue-soak'
 *   - else                                           → 'safe-to-promote'
 *
 * The `reason` string is shaped so an operator can paste it into the
 * promotion PR body unchanged.
 */
export function aggregateTuiCorpus(
  files: LoadedEventsFile[],
  opts: AggregateOpts = {},
  meta: { skippedFiles?: number; skippedLines?: number; filesRead?: number } = {},
): CorpusReport {
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  const minDays = opts.minDays ?? DEFAULT_MIN_DAYS;
  const paneOpenThreshold = opts.paneOpenThreshold ?? DEFAULT_PANE_OPEN_THRESHOLD;

  // Bucket by sessionId — each TUI launch stamps a sessionId on every event.
  // Events without sessionId are bucketed into a synthetic group.
  const bySession = new Map<string, TuiEvent[]>();
  for (const f of files) {
    for (const e of f.events) {
      const key =
        typeof e.sessionId === 'string' && e.sessionId.length > 0
          ? e.sessionId
          : '(unknown-session)';
      const bucket = bySession.get(key);
      if (bucket) bucket.push(e);
      else bySession.set(key, [e]);
    }
  }

  let perSession: SessionSummary[] = [];
  for (const [sessionId, events] of bySession.entries()) {
    perSession.push(summariseSession(sessionId, events));
  }
  // Sort by firstSeen ascending so per-session rows render in calendar order.
  perSession.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));

  // Apply date filters when specified.
  if (opts.since) {
    const since = opts.since;
    perSession = perSession.filter((s) => s.date >= since);
  }
  if (opts.until) {
    const until = opts.until;
    perSession = perSession.filter((s) => s.date <= until);
  }

  const sessionCount = perSession.length;
  const distinctDays = new Set(perSession.map((s) => s.date).filter((d) => d.length === 10)).size;
  const crashCount = perSession.reduce((acc, s) => acc + s.crashCount, 0);
  const capturesFiled = perSession.reduce((acc, s) => acc + s.capturesFiled, 0);

  const navigatedCount = perSession.filter((s) => s.navigated).length;
  const paneEngagementRate = sessionCount === 0 ? 0 : navigatedCount / sessionCount;

  // Pane-open distribution: fraction of sessions that opened each pane.
  const paneCounts: Record<string, number> = {};
  for (const s of perSession) {
    for (const pane of s.panesOpened) {
      paneCounts[pane] = (paneCounts[pane] ?? 0) + 1;
    }
  }
  const paneOpenDistribution: Record<string, number> = {};
  for (const [pane, count] of Object.entries(paneCounts)) {
    paneOpenDistribution[pane] = sessionCount === 0 ? 0 : count / sessionCount;
  }

  // Average session duration (only for sessions with a TuiSessionEnded event).
  const endedSessions = perSession.filter((s) => s.ended);
  const avgSessionDurationMs =
    endedSessions.length === 0
      ? null
      : Math.round(endedSessions.reduce((acc, s) => acc + s.durationMs, 0) / endedSessions.length);

  // Recommendation — TuiCrashed is a hard gate checked BEFORE the data-
  // sufficiency gate so that even a sparse corpus with crashes returns
  // `continue-soak` rather than `insufficient-data`.
  let recommendation: Recommendation;
  let reason: string;

  if (crashCount > 0) {
    recommendation = 'continue-soak';
    reason =
      `TuiCrashed=${crashCount} — hard gate failed (must be 0 for promotion).` +
      ` Investigate crash reports before considering promotion.`;
  } else if (sessionCount < minSamples || distinctDays < minDays) {
    recommendation = 'insufficient-data';
    reason =
      `sessionCount=${sessionCount} < minSamples=${minSamples}` +
      ` OR distinctDays=${distinctDays} < minDays=${minDays}` +
      ` — operator may use the spot-check promotion path` +
      ` (see docs/operations/operator-tui-promotion.md)`;
  } else if (paneEngagementRate < paneOpenThreshold) {
    recommendation = 'continue-soak';
    reason =
      `paneEngagementRate=${(paneEngagementRate * 100).toFixed(1)}%` +
      ` below threshold=${(paneOpenThreshold * 100).toFixed(1)}%` +
      ` — operators are not yet navigating into non-overview panes;` +
      ` the TUI may not be part of the daily workflow yet`;
  } else {
    recommendation = 'safe-to-promote';
    reason =
      `TuiCrashed=0,` +
      ` sessionCount=${sessionCount} >= ${minSamples},` +
      ` distinctDays=${distinctDays} >= ${minDays},` +
      ` paneEngagementRate=${(paneEngagementRate * 100).toFixed(1)}% >= ${(paneOpenThreshold * 100).toFixed(1)}%` +
      ` — flip AI_SDLC_TUI default OFF -> ON per docs/operations/operator-tui-promotion.md`;
  }

  return {
    perSession,
    aggregate: {
      sessionCount,
      filesRead: meta.filesRead ?? files.length,
      skippedFiles: meta.skippedFiles ?? 0,
      skippedLines: meta.skippedLines ?? 0,
      distinctDays,
      crashCount,
      capturesFiled,
      paneEngagementRate,
      paneOpenDistribution,
      avgSessionDurationMs,
      recommendation,
      reason,
    },
  };
}

// ── CLI shell ────────────────────────────────────────────────────────────

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

/**
 * Render an ASCII summary table — same conventions as `cli-orchestrator-corpus`
 * so the operator's eye doesn't have to retrain.
 */
function renderTable(report: CorpusReport): string {
  const headers = ['sessionId', 'date', 'durationMs', 'navigated', 'panes', 'crashes', 'captures'];
  const rows = report.perSession.map((s) => [
    shortSession(s.sessionId),
    s.date || '-',
    s.ended ? String(s.durationMs) : '-',
    s.navigated ? 'yes' : 'no',
    s.panesOpened.join(',') || '-',
    String(s.crashCount),
    String(s.capturesFiled),
  ]);
  if (rows.length === 0) rows.push(['(none)', '-', '-', '-', '-', '0', '0']);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const tbl = [fmt(headers), sep, ...rows.map(fmt)].join('\n');

  const a = report.aggregate;
  const paneLines = Object.entries(a.paneOpenDistribution)
    .sort(([, n1], [, n2]) => n2 - n1)
    .map(([pane, rate]) => `  ${pane}: ${(rate * 100).toFixed(1)}%`)
    .join('\n');

  const summary =
    `\nCorpus: sessions=${a.sessionCount}  files=${a.filesRead}` +
    `  skippedFiles=${a.skippedFiles}  skippedLines=${a.skippedLines}` +
    `\nDistinct days: ${a.distinctDays}` +
    `\nCrashes: ${a.crashCount}  Captures filed: ${a.capturesFiled}` +
    `\nPane engagement rate: ${(a.paneEngagementRate * 100).toFixed(1)}%` +
    `\nPane-open distribution:\n${paneLines || '  (none)'}` +
    `\nAvg session duration: ${a.avgSessionDurationMs !== null ? `${a.avgSessionDurationMs}ms` : '-'}` +
    `\nRecommendation: ${a.recommendation}` +
    `\nReason: ${a.reason}\n`;

  return tbl + '\n' + summary;
}

/** Trim a UUID to the first 8 chars for table rendering. */
function shortSession(sessionId: string): string {
  if (sessionId === '(unknown-session)') return sessionId;
  return sessionId.length > 12 ? sessionId.slice(0, 8) : sessionId;
}

export function buildTuiCorpusCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-tui-corpus')
    .usage('Usage: $0 <command> [options]')
    .command(
      'aggregate <input>',
      'Aggregate TUI usage events.jsonl files into a soak-window report and promotion recommendation envelope.',
      (y) =>
        y
          .positional('input', {
            type: 'string',
            demandOption: true,
            describe:
              'Path to a directory of TUI events artifacts (recurses into subdirs) or a single events.jsonl file. Default location is $ARTIFACTS_DIR/_tui/events.jsonl.',
          })
          .option('min-samples', {
            type: 'number',
            default: DEFAULT_MIN_SAMPLES,
            describe:
              'Minimum session count for safe-to-promote (RFC-0023 §13 Phase 7: ≥ 100 sessions).',
          })
          .option('min-days', {
            type: 'number',
            default: DEFAULT_MIN_DAYS,
            describe:
              'Minimum distinct-calendar-day count for safe-to-promote (RFC-0023 §13 Phase 7: ≥ 7 days).',
          })
          .option('pane-open-threshold', {
            type: 'number',
            default: DEFAULT_PANE_OPEN_THRESHOLD,
            describe:
              'Minimum pane-engagement rate (fraction of sessions that opened a non-overview pane) for safe-to-promote. Default 0.50.',
          })
          .option('since', {
            type: 'string',
            describe: 'Only include sessions on or after this date (YYYY-MM-DD).',
          })
          .option('until', {
            type: 'string',
            describe: 'Only include sessions on or before this date (YYYY-MM-DD).',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
          }),
      async (argv) => {
        const input = String(argv.input);
        const files = findTuiEventsFiles(input);
        const { files: loaded, skippedFiles, skippedLines } = loadTuiEventsCorpus(files);
        const report = aggregateTuiCorpus(
          loaded,
          {
            minSamples: argv['min-samples'] as number,
            minDays: argv['min-days'] as number,
            paneOpenThreshold: argv['pane-open-threshold'] as number,
            since: argv.since as string | undefined,
            until: argv.until as string | undefined,
          },
          { skippedFiles, skippedLines, filesRead: files.length },
        );
        if (String(argv.format) === 'table') emitText(renderTable(report));
        else emit(report);
      },
    )
    .demandCommand(
      1,
      'A subcommand is required (currently: aggregate). Run with --help for the list.',
    )
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runTuiCorpusCli(): Promise<void> {
  await buildTuiCorpusCli().parseAsync();
}
