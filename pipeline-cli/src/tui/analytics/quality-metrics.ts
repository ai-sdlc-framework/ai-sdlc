/**
 * RFC-0025 §8 self-improvement metrics — MTTR + recurrence + coverage rate.
 * Phase 3 (AISDLC-304 / OQ-3 + OQ-8).
 *
 * Reads the `$ARTIFACTS_DIR/_quality/captures.jsonl` corpus alongside the
 * backlog (completed tasks) to compute:
 *
 *   - **MTTR (from first capture)** (OQ-8): average time from the FIRST
 *     capture of a framework-bug subclass (per failure-mode fingerprint)
 *     to the `Done` date of a task tagged `triage: framework-bug` for
 *     that subclass. Output is explicitly labeled "MTTR (from first
 *     capture)" per OQ-8 resolution (2026-05-15). See `mttrLabel` field.
 *
 *   - **Multi-window recurrence** (OQ-3): fraction of fixed framework
 *     bugs that recur within each of the three simultaneous windows
 *     (7d / 30d / 90d). All three windows are computed in a single pass
 *     and surfaced together in `recurrenceByWindow`. Per-org configurable
 *     via `.ai-sdlc/quality-monitoring.yaml` (`quality.recurrence-windows`).
 *
 *   - **Coverage rate**: fraction of failures classified as non-`ambiguous`.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PHASE 3 CHANGES (AISDLC-304)
 * ─────────────────────────────────────────────────────────────────────
 * This file is Phase 3 of the RFC-0025 Refit chain. Changes relative to
 * the Phase 1 substrate (AISDLC-302):
 *
 *   1. `recurrenceWindowDays` (single window) → removed. Replaced by
 *      `recurrenceWindows: string[]` in `ComputeQualityMetricsOpts`.
 *      Config auto-loaded from `.ai-sdlc/quality-monitoring.yaml` when
 *      not supplied (defaults: `['7d', '30d', '90d']`).
 *
 *   2. `QualityMetrics.recurrence` (single `RecurrenceEntry[]`) → removed.
 *      Replaced by `recurrenceByWindow: RecurrenceByWindow[]` — one entry
 *      per configured window, each carrying its own `RecurrenceEntry[]`.
 *
 *   3. `mttrLabel` added to `QualityMetrics` — always `'MTTR (from first
 *      capture)'` per OQ-8 resolution. Callers that surface the MTTR
 *      metric in UIs MUST display this label to avoid misinterpretation.
 *
 *   4. `mttdV2` stub added to `QualityMetrics` — `{ enabled: false }`.
 *      The v2 MTTD (Mean Time to Detection — clock from first occurrence,
 *      inferred via determinism-detection sweep + bisect) is not yet
 *      computable; this stub carries the disabled flag so callers can
 *      conditionally surface the metric when it ships in a later phase.
 *      OQ-8 resolution rationale: "ship the unambiguous version first."
 * ─────────────────────────────────────────────────────────────────────
 *
 * The reader is pure I/O + computation — all date math is done against the
 * `now` override so tests can drive it without touching the wall clock.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { resolveArtifactsDir } from '../sources/types.js';
import { FRAMEWORK_QUALITY_CAPTURES_FILE, FRAMEWORK_QUALITY_DIRNAME } from './quality-reader.js';
import {
  DEFAULT_RECURRENCE_WINDOWS,
  loadQualityMonitoringConfig,
  parseDurationDays,
} from './quality-monitoring-config.js';

// ── Capture record shape (structural, tolerant) ───────────────────────

interface RawCapture {
  ts?: unknown;
  class?: unknown;
  subclass?: unknown;
  severity?: unknown;
  triage?: unknown;
}

// ── MTTR ──────────────────────────────────────────────────────────────

export interface MttrEntry {
  subclass: string;
  /**
   * ISO-8601 timestamp of the FIRST capture seen for this subclass.
   *
   * The MTTR clock starts here — when the framework KNEW about the
   * failure, not when it happened. Labeled "MTTR (from first capture)"
   * per OQ-8 resolution (2026-05-15).
   */
  firstCaptureAt: string;
  /** ISO-8601 timestamp of the remediation (Done date of the fix task), or null if unremediated. */
  remediatedAt: string | null;
  /** MTTR in milliseconds, or null when unremediated. */
  mttrMs: number | null;
}

// ── Recurrence ────────────────────────────────────────────────────────

export interface RecurrenceEntry {
  subclass: string;
  /** How many times this subclass was fixed and then recurred within the window. */
  recurrences: number;
  /** Total times this subclass was fixed. */
  fixes: number;
  /** `recurrences / fixes`. 0 when fixes === 0. */
  recurrenceRate: number;
}

/**
 * Recurrence results for a single window (OQ-3).
 *
 * One `RecurrenceByWindow` entry is produced per configured window.
 * The three-window set (7d / 30d / 90d) answers distinct operational
 * questions:
 *   - 7d   → flap detection: is this bug oscillating rapidly?
 *   - 30d  → standard recurrence: did the fix hold for a month?
 *   - 90d  → legacy regression: did the fix hold for a quarter?
 */
export interface RecurrenceByWindow {
  /** Duration string as configured (e.g. `'7d'`, `'30d'`, `'90d'`). */
  window: string;
  /** Parsed duration in days (e.g. 7, 30, 90). */
  windowDays: number;
  /** Recurrence entries for this window — one per subclass with ≥1 fix. */
  entries: RecurrenceEntry[];
}

// ── v2 MTTD substrate (disabled in Phase 3) ──────────────────────────

/**
 * Stub for the v2 MTTD (Mean Time to Detection) metric.
 *
 * MTTD clocks from FIRST OCCURRENCE (not first capture); it requires
 * reliable first-occurrence inference via the determinism-detection
 * sweep + bisect mechanism. That infrastructure is not yet available
 * in Phase 3.
 *
 * Per OQ-8 resolution (2026-05-15): "ship the unambiguous MTTR (from
 * first capture) first; add MTTD when first-occurrence inference is
 * reliable." This stub carries `enabled: false` so callers can surface
 * the metric conditionally once it ships.
 */
export interface MttdV2Substrate {
  /** Always `false` in Phase 3. Flip to `true` when v2 ships. */
  enabled: false;
}

// ── QualityMetrics ────────────────────────────────────────────────────

export interface QualityMetrics {
  /**
   * MTTR entries — one per subclass seen in the captures corpus.
   * Unremediated subclasses are included with `remediatedAt: null, mttrMs: null`.
   *
   * Clock starts at `firstCaptureAt` (first capture per failure-mode
   * fingerprint) per OQ-8 resolution. Display alongside `mttrLabel`.
   */
  mttr: MttrEntry[];

  /**
   * Human-readable label for the MTTR metric.
   *
   * Always `'MTTR (from first capture)'` — surfaces in TUI, Slack
   * digest, and CLI output to prevent misinterpretation with a
   * future MTTD (from first occurrence) metric.
   */
  mttrLabel: 'MTTR (from first capture)';

  /**
   * Mean MTTR across all remediated subclasses (ms).
   * `null` when nothing has been remediated yet.
   */
  meanMttrMs: number | null;

  /**
   * Multi-window recurrence results (OQ-3).
   *
   * One entry per configured window (default: `['7d', '30d', '90d']`).
   * Each window independently answers its own operational question
   * (flap / standard / legacy). Sorted by ascending `windowDays`.
   *
   * Replaces the Phase 1 single-window `recurrence: RecurrenceEntry[]`.
   */
  recurrenceByWindow: RecurrenceByWindow[];

  /**
   * v2 MTTD substrate (disabled in Phase 3 — OQ-8).
   *
   * Present so callers can conditionally surface the metric once it
   * ships. Check `mttdV2.enabled` before rendering.
   */
  mttdV2: MttdV2Substrate;

  /**
   * Fraction of captures classified as something other than `ambiguous`.
   * 0 when no captures exist.
   */
  coverageRate: number;

  /** Total captures observed. */
  totalCaptures: number;

  /** Total `framework-misbehaved` captures. */
  frameworkBugCaptures: number;

  /** Ambiguous captures (not classified confidently). */
  ambiguousCaptures: number;
}

// ── Options ───────────────────────────────────────────────────────────

export interface ComputeQualityMetricsOpts {
  artifactsDir?: string;
  /** Project root for backlog walk and config file resolution. Defaults `process.cwd()`. */
  workDir?: string;
  /** Wall-clock override for 'now'. Defaults `new Date()`. */
  now?: () => Date;
  /**
   * Recurrence windows to compute (OQ-3).
   *
   * Each entry is a duration string matching `\d+d` (e.g. `'7d'`,
   * `'30d'`, `'90d'`). When omitted, auto-loaded from
   * `.ai-sdlc/quality-monitoring.yaml` → falls back to the §13.1
   * defaults (`['7d', '30d', '90d']`).
   */
  recurrenceWindows?: string[];
  /**
   * Path to the quality-monitoring config file override (useful in tests
   * to avoid loading from cwd's `.ai-sdlc/quality-monitoring.yaml`).
   * Only consulted when `recurrenceWindows` is not explicitly provided.
   */
  qualityMonitoringConfigPath?: string;
}

// ── Completed task reader ─────────────────────────────────────────────

/**
 * Walk `backlog/completed/` and return tasks tagged with
 * `triage: framework-bug` along with their subclass (extracted from the
 * task title) and the file modification time as a proxy for the Done date.
 */
function readCompletedFrameworkBugTasks(
  workDir: string,
): Array<{ subclass: string; doneAt: string }> {
  const completedDir = join(workDir, 'backlog', 'completed');
  if (!existsSync(completedDir)) return [];

  const results: Array<{ subclass: string; doneAt: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(completedDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = join(completedDir, entry);
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    // Check for framework-bug triage label
    if (!/triage:\s*framework-bug/i.test(content)) continue;

    // Extract subclass from title: "chore: investigate framework bug — <subclass>"
    const titleMatch =
      /title:\s*['"]?chore:\s*investigate\s*framework\s*bug\s*[-—]\s*([^'"]+?)['"]?\s*$/im.exec(
        content,
      );
    if (!titleMatch || !titleMatch[1]) continue;
    const subclass = titleMatch[1].trim();

    // Use file mtime as Done date proxy
    let doneAt: string;
    try {
      const s = statSync(filePath);
      doneAt = s.mtime.toISOString();
    } catch {
      continue;
    }
    results.push({ subclass, doneAt });
  }
  return results;
}

// ── Recurrence computation per window ────────────────────────────────

/**
 * Compute recurrence entries for a single window (in ms).
 *
 * For each completed fix task of a given subclass, checks whether a NEW
 * capture of the same subclass appears within `windowMs` after the fix's
 * Done date.
 */
function computeRecurrenceForWindow(
  completedTasks: Array<{ subclass: string; doneAt: string }>,
  capturesBySubclass: Map<string, string[]>,
  windowMs: number,
): RecurrenceEntry[] {
  const recurrenceMap = new Map<string, { fixes: number; recurrences: number }>();

  for (const task of completedTasks) {
    const { subclass, doneAt } = task;
    const entry = recurrenceMap.get(subclass) ?? { fixes: 0, recurrences: 0 };
    entry.fixes += 1;

    const doneMs = new Date(doneAt).getTime();
    const windowEnd = doneMs + windowMs;
    const captures = capturesBySubclass.get(subclass) ?? [];
    // Any capture AFTER the fix and WITHIN the window counts as a recurrence
    const recurred = captures.some((ts) => {
      const tsMs = new Date(ts).getTime();
      return tsMs > doneMs && tsMs <= windowEnd;
    });
    if (recurred) entry.recurrences += 1;

    recurrenceMap.set(subclass, entry);
  }

  return Array.from(recurrenceMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([subclass, { fixes, recurrences }]) => ({
      subclass,
      fixes,
      recurrences,
      recurrenceRate: fixes === 0 ? 0 : recurrences / fixes,
    }));
}

// ── Main computation ─────────────────────────────────────────────────

/**
 * Compute MTTR + multi-window recurrence + coverage metrics from the
 * captures corpus.
 *
 * Phase 3 (AISDLC-304) delivers:
 *   - Multi-window recurrence (OQ-3): simultaneous 7d / 30d / 90d output
 *     in `recurrenceByWindow`.
 *   - Explicit MTTR label (OQ-8): `mttrLabel: 'MTTR (from first capture)'`.
 *   - v2 MTTD substrate (OQ-8): `mttdV2: { enabled: false }`.
 */
export function computeQualityMetrics(opts: ComputeQualityMetricsOpts = {}): QualityMetrics {
  const workDir = opts.workDir ?? process.cwd();
  const artifactsDir = resolveArtifactsDir({ artifactsDir: opts.artifactsDir });
  const capturesPath = join(
    artifactsDir,
    FRAMEWORK_QUALITY_DIRNAME,
    FRAMEWORK_QUALITY_CAPTURES_FILE,
  );

  // Resolve recurrence windows: explicit opt > config file > defaults
  let recurrenceWindows: string[];
  if (opts.recurrenceWindows && opts.recurrenceWindows.length > 0) {
    recurrenceWindows = opts.recurrenceWindows;
  } else {
    const config = loadQualityMonitoringConfig({
      workDir,
      filePath: opts.qualityMonitoringConfigPath,
    });
    recurrenceWindows = config.recurrenceWindows;
  }

  // Fall back to shipping defaults if still empty (defensive)
  if (recurrenceWindows.length === 0) {
    recurrenceWindows = [...DEFAULT_RECURRENCE_WINDOWS];
  }

  // Parse windows to ms (filter out unrecognized formats)
  const parsedWindows = recurrenceWindows
    .map((w) => ({ window: w, windowDays: parseDurationDays(w) }))
    .filter((x): x is { window: string; windowDays: number } => x.windowDays !== null)
    .sort((a, b) => a.windowDays - b.windowDays);

  // Ensure we always have at least the defaults
  if (parsedWindows.length === 0) {
    for (const w of DEFAULT_RECURRENCE_WINDOWS) {
      const days = parseDurationDays(w);
      if (days !== null) parsedWindows.push({ window: w, windowDays: days });
    }
  }

  // ── Read captures ───────────────────────────────────────────────────
  const capturesBySubclass = new Map<string, string[]>(); // subclass → sorted ts list
  let totalCaptures = 0;
  let frameworkBugCaptures = 0;
  let ambiguousCaptures = 0;
  let classifiedCaptures = 0;

  if (existsSync(capturesPath)) {
    let raw: string;
    try {
      raw = readFileSync(capturesPath, 'utf8');
    } catch {
      raw = '';
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = parsed as RawCapture;
      if (!record || typeof record !== 'object') continue;
      if (typeof record.ts !== 'string') continue;

      totalCaptures += 1;

      if (record.class === 'framework-misbehaved' && typeof record.subclass === 'string') {
        frameworkBugCaptures += 1;
        classifiedCaptures += 1;
        const list = capturesBySubclass.get(record.subclass) ?? [];
        list.push(record.ts);
        capturesBySubclass.set(record.subclass, list);
      } else if (record.class === 'ambiguous') {
        ambiguousCaptures += 1;
      } else if (record.class) {
        classifiedCaptures += 1;
      }
    }
  }

  // Sort each subclass's timestamps ascending (ensures firstCaptureAt is correct)
  for (const [subclass, tsList] of capturesBySubclass.entries()) {
    capturesBySubclass.set(subclass, tsList.sort());
  }

  // ── Read completed framework-bug tasks ──────────────────────────────
  const completedTasks = readCompletedFrameworkBugTasks(workDir);

  // ── MTTR entries (OQ-8: clock from FIRST capture) ──────────────────
  const mttrEntries: MttrEntry[] = [];
  for (const [subclass, tsList] of capturesBySubclass.entries()) {
    // First capture = first timestamp (sorted ascending above)
    const firstCaptureAt = tsList[0]!;
    // Find the earliest remediation for this subclass
    const remediations = completedTasks
      .filter((t) => t.subclass === subclass)
      .sort((a, b) => a.doneAt.localeCompare(b.doneAt));

    if (remediations.length === 0) {
      mttrEntries.push({ subclass, firstCaptureAt, remediatedAt: null, mttrMs: null });
    } else {
      const remediatedAt = remediations[0]!.doneAt;
      const firstMs = new Date(firstCaptureAt).getTime();
      const remMs = new Date(remediatedAt).getTime();
      const mttrMs =
        Number.isNaN(firstMs) || Number.isNaN(remMs) ? null : Math.max(0, remMs - firstMs);
      mttrEntries.push({ subclass, firstCaptureAt, remediatedAt, mttrMs });
    }
  }

  // Mean MTTR across remediated subclasses
  const remediatedEntries = mttrEntries.filter((e) => e.mttrMs !== null);
  const meanMttrMs =
    remediatedEntries.length === 0
      ? null
      : Math.round(remediatedEntries.reduce((s, e) => s + e.mttrMs!, 0) / remediatedEntries.length);

  // ── Multi-window recurrence (OQ-3) ─────────────────────────────────
  // Compute all windows simultaneously in a single pass over completedTasks.
  const recurrenceByWindow: RecurrenceByWindow[] = parsedWindows.map(({ window, windowDays }) => ({
    window,
    windowDays,
    entries: computeRecurrenceForWindow(
      completedTasks,
      capturesBySubclass,
      windowDays * 24 * 60 * 60 * 1000,
    ),
  }));

  // ── Coverage rate ───────────────────────────────────────────────────
  const coverageRate = totalCaptures === 0 ? 0 : classifiedCaptures / totalCaptures;

  return {
    mttr: mttrEntries,
    mttrLabel: 'MTTR (from first capture)',
    meanMttrMs,
    recurrenceByWindow,
    mttdV2: { enabled: false },
    coverageRate,
    totalCaptures,
    frameworkBugCaptures,
    ambiguousCaptures,
  };
}

// ── Formatters ────────────────────────────────────────────────────────

import { formatDurationCompact } from './metrics.js';

/**
 * Format MTTR for TUI display, including the OQ-8 label.
 *
 * Output: `MTTR (from first capture) — <subclass>: <duration>`
 * or `MTTR (from first capture) — <subclass>: —` when unremediated.
 */
export function formatMttr(entry: MttrEntry): string {
  const duration = formatDurationCompact(entry.mttrMs);
  return `MTTR (from first capture) — ${entry.subclass}: ${duration}`;
}

/**
 * Format the coverage rate as a percentage string for TUI display.
 */
export function formatCoverageRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Format a single recurrence entry for a given window for TUI display.
 * Output: `[<window>] <subclass>: <recurrences>/<fixes> (<rate>%)`
 */
export function formatRecurrenceEntry(entry: RecurrenceEntry, window: string): string {
  const pct = (entry.recurrenceRate * 100).toFixed(1);
  return `[${window}] ${entry.subclass}: ${entry.recurrences}/${entry.fixes} (${pct}%)`;
}
