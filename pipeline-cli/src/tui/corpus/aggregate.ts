/**
 * TUI soak-corpus aggregator (RFC-0023 §13 Phase 7 / AISDLC-178.7).
 *
 * Sister aggregator to `cli-deps-corpus` (AISDLC-167.5),
 * `cli-orchestrator-corpus` (AISDLC-169.5), and `cli-dor-corpus`
 * (AISDLC-161). All four share aesthetic conventions
 * (find-files-recursively, recommendation envelope, JSON-or-table
 * output, `safe-to-promote | continue-soak | insufficient-data`
 * recommendation) but answer different questions:
 *
 *   - `cli-dor-corpus`           → "is the DoR rubric ready for `enforce`?"
 *   - `cli-deps-corpus`          → "is the dep-graph composition ready
 *                                  for default-on?"
 *   - `cli-orchestrator-corpus`  → "is the autonomous orchestrator ready
 *                                  for default-on?"
 *   - `cli-tui-corpus`  (here)   → "is the operator TUI ready for
 *                                  default-on?" (sessions + pane-open
 *                                  distribution + time-to-decision trend
 *                                  + zero TuiCrashed + captures filed
 *                                  during the soak)
 *
 * Per RFC-0023 §13 Phase 7 success criteria + the AISDLC-178.7 ACs:
 *
 *   - **Sessions** ≥ minSessions (default 7) — operator dogfooded for at
 *     least a week's worth of sessions; `TuiStarted` from
 *     `_tui/events.jsonl` is the canonical signal, with the
 *     `pane-opened` events on `_operator/interactions.jsonl` as a
 *     fallback for older corpora that predate the self-events writer.
 *   - **Calendar days with usage** ≥ minDaysWithUsage (default 7) —
 *     RFC-0023 §13 acceptance criterion #4 ("≥ 7 calendar days"); a
 *     single multi-pane session does NOT satisfy soak intent. Computed
 *     from the distinct UTC dates observed across both event streams.
 *   - **Pane-open distribution** covers ≥ minDistinctPanes (default 2)
 *     panes — operator actually exercised the surface, not just opened
 *     overview. A single-pane corpus implies the operator never
 *     mode-switched, which is a usability red flag worth investigating
 *     before promoting.
 *   - **TuiCrashed count = 0** — RFC §13 hard gate. Any non-zero count
 *     forces `continue-soak` regardless of the other metrics.
 *
 * Soft signals surfaced but NOT gate the recommendation:
 *
 *   - **Time-to-decision trend** — split the decision corpus in half by
 *     observation date and compare median resolution time. Surfaced for
 *     operator visibility; trend direction does NOT block promotion (the
 *     interpretation is qualitative — a week of dogfood is too short for
 *     statistical confidence on the median move).
 *   - **Captures filed during the soak** — count of capture records
 *     under `<corpus>/_captures/` whose timestamp falls in the soak
 *     window. Per RFC-0024 emergent capture pattern; this is a
 *     visibility signal (operator pain points captured) rather than a
 *     gate.
 *
 * Hybrid promotion model (mirrors AISDLC-161 / AISDLC-167.5 / AISDLC-169.5):
 *   - `recommendation: 'safe-to-promote'`  → operator can flip the
 *     `AI_SDLC_TUI` default OFF → ON (single PR, runbook in
 *     `docs/operations/operator-tui-promotion.md`).
 *   - `recommendation: 'continue-soak'`     → keep dogfooding; the
 *     `reason` field names the failing metric.
 *   - `recommendation: 'insufficient-data'` → use the operator-override
 *     spot-check path described in the runbook (corpus too sparse for
 *     statistical confidence).
 *
 * **Signal sources**:
 *   - `_tui/events.jsonl` — `TuiStarted` count = sessions, `TuiCrashed`
 *     count = the hard-gate metric.
 *   - `_operator/interactions.jsonl` — `pane-opened` events drive the
 *     pane-open distribution + a sessions fallback when `_tui/events.jsonl`
 *     is missing.
 *   - `_operator/decisions.jsonl` — `Needs Clarification → resolved`
 *     transitions; provides the time-to-decision trend.
 *   - `_captures/<id>.jsonl` — RFC-0024 capture records; counts files
 *     whose `timestamp` falls within the soak window. Defensive on
 *     schema (RFC-0024 is still draft); records that don't parse
 *     contribute to `skippedCaptures` but never fail the run.
 *
 * @module tui/corpus/aggregate
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ── Defaults from RFC-0023 §13 Phase 7 ────────────────────────────────

/**
 * Minimum session count for `safe-to-promote`. Below this, the
 * recommendation is forced to `insufficient-data`. RFC §13 Phase 7
 * acceptance ("operator dogfoods TUI for ≥ 7 calendar days"); we
 * operationalise the calendar floor as a sessions floor + a distinct-day
 * floor. A 14-session burst on day 1 fails the days-floor; a daily
 * one-session cadence over 7 days satisfies both.
 */
const DEFAULT_MIN_SESSIONS = 7;

/**
 * Minimum distinct UTC dates with TUI usage. Tunable via
 * `--min-days-with-usage`. RFC §13 Phase 7 acceptance ("≥ 7 calendar
 * days"). When present alongside `min-sessions` the gate is
 * conservative: both floors must be satisfied. The same distinct-date
 * computation runs over both event streams and the union wins (so
 * older corpora that predate `_tui/events.jsonl` still satisfy the
 * gate via the interactions stream).
 */
const DEFAULT_MIN_DAYS_WITH_USAGE = 7;

/**
 * Minimum distinct panes opened across the corpus. Tunable via
 * `--min-distinct-panes`. A 1-pane corpus implies the operator never
 * mode-switched and the surface isn't being exercised. Default 2 keeps
 * the bar low (any non-overview pane opened at least once) without
 * letting a "watched the overview screen all week" corpus pass.
 */
const DEFAULT_MIN_DISTINCT_PANES = 2;

// ── Public types ──────────────────────────────────────────────────────

export type Recommendation = 'insufficient-data' | 'safe-to-promote' | 'continue-soak';

/**
 * One self-observability event read from `_tui/events.jsonl`. The schema
 * is intentionally narrow on the fields the aggregator uses; additional
 * payload (errorMessage, stack, source, etc.) rides on the same record
 * but the aggregator only consumes `ts` and `type`.
 */
export interface SelfEventRecord {
  ts: string;
  type: string;
  [k: string]: unknown;
}

/**
 * One operator-interaction record from `_operator/interactions.jsonl`.
 * Mirrors the writer's `InteractionRecord` shape; we re-declare the
 * shape here rather than import-cycling through the writer module so the
 * aggregator can be consumed without a TUI/Ink runtime dependency.
 */
export interface InteractionRecord {
  ts: string;
  kind: string;
  pane?: string;
  target?: string;
  detail?: string;
}

/**
 * One decision record from `_operator/decisions.jsonl`. Mirrors
 * `pipeline-cli/src/tui/analytics/decisions-writer.ts`.
 */
export interface DecisionRecord {
  ts: string;
  taskId: string;
  fromStatus: string;
  toStatus: string;
  clarificationPostedAt: string;
  resolvedAt: string;
  durationMs: number;
}

/**
 * One capture record from `_captures/<id>.jsonl`. Per RFC-0024 the schema
 * is still draft; the aggregator only consumes `timestamp` so it stays
 * forward-compatible with the eventual v1 schema.
 */
export interface CaptureRecord {
  timestamp: string;
  [k: string]: unknown;
}

/**
 * Time-to-decision trend snapshot. Splits the decision corpus into two
 * halves by observation date (chronological median), computes the median
 * `durationMs` of each half, and reports the delta. A negative
 * `deltaMs` (second half < first half) means decisions got faster over
 * the soak window — the qualitative success signal RFC-0023 §1 names.
 *
 * The split is by record-index rather than calendar-window-midpoint so
 * a corpus with bursty decision activity still produces two roughly-
 * equal-sized halves. When the corpus is too small (<2 records),
 * `firstHalfMedianMs`/`secondHalfMedianMs`/`deltaMs` are all 0.
 */
export interface DecisionTrend {
  /** Decisions in the first chronological half (older). */
  firstHalfCount: number;
  /** Decisions in the second chronological half (newer). */
  secondHalfCount: number;
  /** Median `durationMs` across the first half. */
  firstHalfMedianMs: number;
  /** Median `durationMs` across the second half. */
  secondHalfMedianMs: number;
  /**
   * `secondHalfMedianMs - firstHalfMedianMs`. Negative = faster decisions
   * in the newer half (good); positive = slower (worth investigation).
   */
  deltaMs: number;
}

export interface CorpusReport {
  /** Number of `TuiStarted` events on `_tui/events.jsonl`, or `_operator/interactions.jsonl` `pane-opened` count when self-events file is empty. */
  sessions: number;
  /**
   * Distinct UTC calendar dates with at least one event across either
   * stream. Drives the AC#4 "≥ 7 calendar days" gate.
   */
  daysWithUsage: number;
  /**
   * `pane → count` map from `_operator/interactions.jsonl` `pane-opened`
   * events. Drives the pane-open-distribution gate.
   */
  paneOpenDistribution: Record<string, number>;
  /** Distinct panes seen on the `pane-opened` stream. */
  distinctPanes: number;
  /** `TuiCrashed` event count from `_tui/events.jsonl`. Hard-gate at 0. */
  tuiCrashedCount: number;
  /** Decision-trend snapshot (NOT a gate; surfaced for operator visibility). */
  decisionTrend: DecisionTrend;
  /** Total decisions resolved in the corpus window. */
  decisionsResolved: number;
  /** Capture files filed during the soak window per RFC-0024. */
  capturesFiled: number;
  /** Capture files that failed to parse (forensic; never fails the run). */
  skippedCaptures: number;
  /** Earliest event timestamp seen across all streams (or null when empty). */
  windowStart: string | null;
  /** Latest event timestamp seen across all streams (or null when empty). */
  windowEnd: string | null;
  /** Operator-facing recommendation. */
  recommendation: Recommendation;
  /** Human-readable rationale (operator log line). */
  reason: string;
  /** Forensic counters — files we couldn't parse + lines we skipped. */
  filesRead: number;
  skippedFiles: number;
  skippedLines: number;
}

export interface AggregateOpts {
  /** Below this session count, recommendation is forced `insufficient-data`. */
  minSessions?: number;
  /** Below this distinct-day count, recommendation is forced `insufficient-data`. */
  minDaysWithUsage?: number;
  /** Below this distinct-pane count, recommendation is forced `continue-soak`. */
  minDistinctPanes?: number;
}

/**
 * In-memory corpus assembled from the three streams + capture files.
 * Exposed for tests so they can construct one directly without touching
 * disk.
 */
export interface LoadedCorpus {
  selfEvents: SelfEventRecord[];
  interactions: InteractionRecord[];
  decisions: DecisionRecord[];
  captures: CaptureRecord[];
  filesRead: number;
  skippedFiles: number;
  skippedLines: number;
  skippedCaptures: number;
}

// ── File walking ──────────────────────────────────────────────────────

/**
 * Locate all corpus files under `rootPath`. The aggregator accepts:
 *
 *   - A workspace `$ARTIFACTS_DIR` (the common path) — walks
 *     `<root>/_tui/`, `<root>/_operator/`, `<root>/_captures/`.
 *   - A `gh run download` layout where each artifact lives in its own
 *     sibling subdirectory — walks recursively, looks for the same
 *     three subdir names anywhere in the tree.
 *   - A single file path — returned as a one-element list of its kind.
 *
 * The kind classification is by parent-directory name + filename,
 * mirroring the writers' on-disk layout. Files outside the recognised
 * subtrees are ignored (so an operator passing the workspace root
 * doesn't accidentally vacuum `backlog/tasks/*.md` into the corpus).
 */
export interface FoundFiles {
  selfEventFiles: string[];
  interactionFiles: string[];
  decisionFiles: string[];
  captureFiles: string[];
}

export function findCorpusFiles(rootPath: string): FoundFiles {
  const out: FoundFiles = {
    selfEventFiles: [],
    interactionFiles: [],
    decisionFiles: [],
    captureFiles: [],
  };

  let rootStat;
  try {
    rootStat = statSync(rootPath);
  } catch {
    return out;
  }

  // Single-file shortcut: classify by name.
  if (rootStat.isFile()) {
    classifyFile(rootPath, out);
    return out;
  }
  if (!rootStat.isDirectory()) return out;

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
      classifyFile(current, out);
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

  out.selfEventFiles.sort();
  out.interactionFiles.sort();
  out.decisionFiles.sort();
  out.captureFiles.sort();
  return out;
}

/**
 * Classify a single file path into one of the three streams (or the
 * captures bucket) based on its parent directory + filename. Exported
 * for unit-test inspection of single-file inputs.
 */
function classifyFile(path: string, out: FoundFiles): void {
  const parts = path.split('/');
  // Walk parents looking for a recognised subdir name. Stops at the
  // first match — the layout never nests these subdirs.
  let parent: string | undefined;
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    if (parts[i] === '_tui' || parts[i] === '_operator' || parts[i] === '_captures') {
      parent = parts[i];
      break;
    }
  }
  const filename = parts[parts.length - 1];
  if (parent === '_tui') {
    if (filename.endsWith('.jsonl')) out.selfEventFiles.push(path);
    return;
  }
  if (parent === '_operator') {
    if (filename === 'interactions.jsonl') out.interactionFiles.push(path);
    else if (filename === 'decisions.jsonl') out.decisionFiles.push(path);
    return;
  }
  if (parent === '_captures') {
    if (filename.endsWith('.jsonl') || filename.endsWith('.json')) out.captureFiles.push(path);
  }
}

// ── Parsing helpers ───────────────────────────────────────────────────

interface ParseResult<T> {
  records: T[];
  skippedFiles: number;
  skippedLines: number;
}

function parseJsonlFiles<T>(files: string[], validate: (raw: unknown) => raw is T): ParseResult<T> {
  const records: T[] = [];
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
    let allBad = true;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skippedLines += 1;
        continue;
      }
      if (!validate(parsed)) {
        skippedLines += 1;
        continue;
      }
      records.push(parsed);
      allBad = false;
    }
    if (allBad) skippedFiles += 1;
  }
  return { records, skippedFiles, skippedLines };
}

export function isSelfEvent(raw: unknown): raw is SelfEventRecord {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.ts === 'string' && e.ts.length > 0 && typeof e.type === 'string' && e.type.length > 0
  );
}

export function isInteraction(raw: unknown): raw is InteractionRecord {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.ts === 'string' && e.ts.length > 0 && typeof e.kind === 'string' && e.kind.length > 0
  );
}

export function isDecision(raw: unknown): raw is DecisionRecord {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.ts === 'string' &&
    e.ts.length > 0 &&
    typeof e.taskId === 'string' &&
    typeof e.durationMs === 'number' &&
    Number.isFinite(e.durationMs)
  );
}

/**
 * Capture record validator. Per RFC-0024 a capture file is one JSON
 * record (NOT JSONL) with a top-level `timestamp` field. We accept both
 * forms: `.jsonl` files that may contain multiple captures (forward-
 * compat), and `.json` single-record files. Every record must carry a
 * `timestamp` string for the soak-window match — records without one
 * fall into `skippedCaptures`.
 */
export function isCapture(raw: unknown): raw is CaptureRecord {
  if (!raw || typeof raw !== 'object') return false;
  const e = raw as Record<string, unknown>;
  return typeof e.timestamp === 'string' && e.timestamp.length > 0;
}

/**
 * Parse capture files. Each file may be a single JSON object (the canonical
 * RFC-0024 form) or a JSONL stream. Robust to both; counts unparseable
 * files in `skippedCaptures` so the corpus aggregator can surface the
 * forensic count without failing the run.
 */
export function loadCaptures(files: string[]): {
  records: CaptureRecord[];
  skippedCaptures: number;
} {
  const records: CaptureRecord[] = [];
  let skippedCaptures = 0;
  for (const f of files) {
    let raw: string;
    try {
      raw = readFileSync(f, 'utf8');
    } catch {
      skippedCaptures += 1;
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      skippedCaptures += 1;
      continue;
    }
    // Try as a single JSON record first (the RFC-0024 canonical form).
    try {
      const parsed = JSON.parse(trimmed);
      if (isCapture(parsed)) {
        records.push(parsed);
        continue;
      }
    } catch {
      // Fall through to JSONL handling.
    }
    // JSONL fallback — multi-record file or unparseable single-record.
    const lines = trimmed.split('\n').filter((l) => l.trim().length > 0);
    let parsedAny = false;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (isCapture(parsed)) {
        records.push(parsed);
        parsedAny = true;
      }
    }
    if (!parsedAny) skippedCaptures += 1;
  }
  return { records, skippedCaptures };
}

/**
 * Read every file in `found` and assemble an in-memory corpus. Pure I/O —
 * the recommendation math lives in `aggregateTuiCorpus()`.
 */
export function loadCorpus(found: FoundFiles): LoadedCorpus {
  const filesRead =
    found.selfEventFiles.length +
    found.interactionFiles.length +
    found.decisionFiles.length +
    found.captureFiles.length;
  const selfEvts = parseJsonlFiles(found.selfEventFiles, isSelfEvent);
  const ints = parseJsonlFiles(found.interactionFiles, isInteraction);
  const decs = parseJsonlFiles(found.decisionFiles, isDecision);
  const caps = loadCaptures(found.captureFiles);
  return {
    selfEvents: selfEvts.records,
    interactions: ints.records,
    decisions: decs.records,
    captures: caps.records,
    filesRead,
    skippedFiles: selfEvts.skippedFiles + ints.skippedFiles + decs.skippedFiles,
    skippedLines: selfEvts.skippedLines + ints.skippedLines + decs.skippedLines,
    skippedCaptures: caps.skippedCaptures,
  };
}

// ── Aggregation ──────────────────────────────────────────────────────

/**
 * Compute the median of a numeric array. Undefined behaviour for an
 * empty array — callers guard with `.length > 0`. Stable sort is fine
 * (we don't carry tie-break semantics for medians).
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Extract the YYYY-MM-DD UTC date prefix from an ISO timestamp. Centralised
 * so the days-with-usage gate is symmetric across all three streams (a
 * record stamped at 23:59 UTC counts on the same day as one at 00:01 UTC
 * the next morning — RFC §13's "calendar day" semantics).
 */
function utcDateOf(iso: string): string {
  // ISO 8601 is YYYY-MM-DDThh:mm:ss... — slice out the date prefix
  // without parsing into a Date so we don't pick up local-timezone drift.
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

/**
 * Compute the time-to-decision trend across a chronologically-sorted
 * slice of decisions. Splits into two halves by index and reports the
 * delta in median `durationMs`.
 */
function computeDecisionTrend(decisions: DecisionRecord[]): DecisionTrend {
  if (decisions.length < 2) {
    return {
      firstHalfCount: decisions.length,
      secondHalfCount: 0,
      firstHalfMedianMs: decisions.length === 0 ? 0 : decisions[0].durationMs,
      secondHalfMedianMs: 0,
      deltaMs: 0,
    };
  }
  const sorted = [...decisions].sort((a, b) => a.ts.localeCompare(b.ts));
  const mid = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, mid);
  const secondHalf = sorted.slice(mid);
  const firstMed = median(firstHalf.map((d) => d.durationMs));
  const secondMed = median(secondHalf.map((d) => d.durationMs));
  return {
    firstHalfCount: firstHalf.length,
    secondHalfCount: secondHalf.length,
    firstHalfMedianMs: firstMed,
    secondHalfMedianMs: secondMed,
    deltaMs: secondMed - firstMed,
  };
}

/**
 * Drive the recommendation envelope from the loaded corpus.
 *
 * Pure function — no I/O — so tests can pass synthetic corpora and
 * snapshot the output. The CLI front-end is a thin shell around
 * `findCorpusFiles()` + `loadCorpus()` + this function + a renderer.
 *
 * Recommendation gating (in priority order):
 *   - `tuiCrashedCount > 0`                        → 'continue-soak' (hard)
 *   - `sessions < minSessions`                     → 'insufficient-data'
 *   - `daysWithUsage < minDaysWithUsage`           → 'insufficient-data'
 *   - `distinctPanes < minDistinctPanes`           → 'continue-soak'
 *   - else                                         → 'safe-to-promote'
 *
 * The `reason` string is shaped so an operator can paste it into the
 * promotion PR body unchanged.
 */
export function aggregateTuiCorpus(corpus: LoadedCorpus, opts: AggregateOpts = {}): CorpusReport {
  const minSessions = opts.minSessions ?? DEFAULT_MIN_SESSIONS;
  const minDaysWithUsage = opts.minDaysWithUsage ?? DEFAULT_MIN_DAYS_WITH_USAGE;
  const minDistinctPanes = opts.minDistinctPanes ?? DEFAULT_MIN_DISTINCT_PANES;

  // Sessions: prefer `_tui/events.jsonl` `TuiStarted` count; fall back to
  // a session approximation from `_operator/interactions.jsonl` when the
  // self-events stream is empty (older corpora that predate AISDLC-178.7
  // — the interactions writer was AC for AISDLC-178.6 but the self-events
  // writer ships in this PR).
  const tuiStartedCount = corpus.selfEvents.filter((e) => e.type === 'TuiStarted').length;
  const interactionPaneOpens = corpus.interactions.filter((i) => i.kind === 'pane-opened').length;
  const sessions = tuiStartedCount > 0 ? tuiStartedCount : interactionPaneOpens;

  const tuiCrashedCount = corpus.selfEvents.filter((e) => e.type === 'TuiCrashed').length;

  // Pane-open distribution: count `pane-opened` interactions by pane.
  const paneOpenDistribution: Record<string, number> = {};
  for (const i of corpus.interactions) {
    if (i.kind !== 'pane-opened') continue;
    const pane = typeof i.pane === 'string' && i.pane.length > 0 ? i.pane : '(unspecified)';
    paneOpenDistribution[pane] = (paneOpenDistribution[pane] ?? 0) + 1;
  }
  const distinctPanes = Object.keys(paneOpenDistribution).length;

  // Days-with-usage: union of distinct UTC dates across both streams.
  const dayBag = new Set<string>();
  for (const e of corpus.selfEvents) dayBag.add(utcDateOf(e.ts));
  for (const i of corpus.interactions) dayBag.add(utcDateOf(i.ts));
  const daysWithUsage = dayBag.size;

  // Window bounds — earliest + latest event seen across all streams.
  let windowStart: string | null = null;
  let windowEnd: string | null = null;
  const updateWindow = (ts: string): void => {
    if (windowStart === null || ts < windowStart) windowStart = ts;
    if (windowEnd === null || ts > windowEnd) windowEnd = ts;
  };
  for (const e of corpus.selfEvents) updateWindow(e.ts);
  for (const i of corpus.interactions) updateWindow(i.ts);
  for (const d of corpus.decisions) updateWindow(d.ts);

  // Captures filed during the soak window: count records whose
  // `timestamp` falls between `windowStart` and `windowEnd`. When the
  // window is empty (corpus has zero events) all captures count — the
  // operator is in the early-collection phase and the visibility signal
  // is still useful.
  const capturesFiled = corpus.captures.filter((c) => {
    if (windowStart === null || windowEnd === null) return true;
    return c.timestamp >= windowStart && c.timestamp <= windowEnd;
  }).length;

  const decisionsResolved = corpus.decisions.length;
  const decisionTrend = computeDecisionTrend(corpus.decisions);

  let recommendation: Recommendation;
  let reason: string;
  if (tuiCrashedCount > 0) {
    recommendation = 'continue-soak';
    reason =
      `tuiCrashedCount=${tuiCrashedCount} > 0` +
      ` — RFC-0023 §13 hard gate: zero TuiCrashed events required for promotion.` +
      ` Investigate the crash payload(s) in _tui/events.jsonl before re-running the aggregator.`;
  } else if (sessions < minSessions) {
    recommendation = 'insufficient-data';
    reason =
      `sessions=${sessions} < minSessions=${minSessions}` +
      ` — operator may use the spot-check promotion path` +
      ` (see docs/operations/operator-tui-promotion.md).`;
  } else if (daysWithUsage < minDaysWithUsage) {
    recommendation = 'insufficient-data';
    reason =
      `daysWithUsage=${daysWithUsage} < minDaysWithUsage=${minDaysWithUsage}` +
      ` — RFC-0023 §13 acceptance #4 requires ≥7 calendar days of dogfood.` +
      ` Operator may use the spot-check promotion path if the corpus is bursty (multi-session days).`;
  } else if (distinctPanes < minDistinctPanes) {
    recommendation = 'continue-soak';
    reason =
      `distinctPanes=${distinctPanes} < minDistinctPanes=${minDistinctPanes}` +
      ` — operator hasn't exercised enough of the surface to validate it; mode-switch coverage is part of the soak intent.`;
  } else {
    recommendation = 'safe-to-promote';
    reason =
      `sessions=${sessions} ≥ ${minSessions},` +
      ` daysWithUsage=${daysWithUsage} ≥ ${minDaysWithUsage},` +
      ` distinctPanes=${distinctPanes} ≥ ${minDistinctPanes},` +
      ` tuiCrashedCount=0` +
      ` — flip AI_SDLC_TUI default OFF → ON.`;
  }

  return {
    sessions,
    daysWithUsage,
    paneOpenDistribution,
    distinctPanes,
    tuiCrashedCount,
    decisionTrend,
    decisionsResolved,
    capturesFiled,
    skippedCaptures: corpus.skippedCaptures,
    windowStart,
    windowEnd,
    recommendation,
    reason,
    filesRead: corpus.filesRead,
    skippedFiles: corpus.skippedFiles,
    skippedLines: corpus.skippedLines,
  };
}
