/**
 * Operator-override + silence-as-positive capture logic for the shared
 * classifier substrate (AISDLC-321 / RFC-0024 Refit Phase 2).
 *
 * Implements AC-6 + AC-7:
 *   - AC-6: when the operator overrides an auto-classification within the
 *           override window, the corpus entry's polarity flips to
 *           `negative`, recording both the operator's chosen
 *           classification + a reason string.
 *   - AC-7: when the override window expires without an operator
 *           override, the entry's polarity flips to `positive`.
 *
 * The two functions are designed to be called independently:
 *   - Surfaces that integrate the substrate (TUI triage, decision-
 *     resolution flow, DoR ingress) call `recordOperatorOverride()`
 *     when the operator changes the classification.
 *   - A scheduled sweeper (or the aggregator CLI when no sweeper is
 *     wired up) calls `resolveSilenceAsPositive()` periodically — it
 *     scans the corpus for `pending` entries older than the window and
 *     flips them to `positive`.
 *
 * **Override window**: default 24 hours, matching RFC-0035's
 * `overrideWindowHours` semantic. Per-org configurable. Per-task-type
 * override is intentionally NOT supported in v1 — the window is a
 * substrate-wide concept and per-task differentiation would multiply
 * config surface for marginal payoff. We can add it if/when corpus data
 * shows a per-task need.
 *
 * @module classifier/substrate/override
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';

import { readCorpus, resolveCorpusDir, setCorpusEntryPolarity } from './corpus.js';
import type { CalibrationCorpusEntry, ClassifierTaskType } from './types.js';
import { ALL_TASK_TYPES } from './types.js';

// ── Override window ──────────────────────────────────────────────────────────

/**
 * Default override window in hours. Matches RFC-0035's
 * `overrideWindowHours` default — both surfaces (decisions + captures)
 * use the same window so operators don't memorise two timeouts.
 */
export const DEFAULT_OVERRIDE_WINDOW_HOURS = 24;

interface OverrideWindowConfigBlock {
  classifier?: {
    overrideWindowHours?: number;
  };
}

/**
 * Resolve the override window in hours. Reads
 * `<repoRoot>/.ai-sdlc/capture-config.yaml`'s
 * `classifier.overrideWindowHours` field; falls back to default. Never
 * throws — schema drift falls through to the default.
 */
export function resolveOverrideWindowHours(repoRoot: string): number {
  const path = join(repoRoot, '.ai-sdlc', 'capture-config.yaml');
  if (!existsSync(path)) return DEFAULT_OVERRIDE_WINDOW_HOURS;
  let parsed: unknown;
  try {
    parsed = yamlLoad(readFileSync(path, 'utf8'));
  } catch {
    return DEFAULT_OVERRIDE_WINDOW_HOURS;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return DEFAULT_OVERRIDE_WINDOW_HOURS;
  }
  const v = (parsed as OverrideWindowConfigBlock).classifier?.overrideWindowHours;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    return DEFAULT_OVERRIDE_WINDOW_HOURS;
  }
  return v;
}

// ── AC-6: operator override ──────────────────────────────────────────────────

export interface RecordOperatorOverrideOpts {
  repoRoot: string;
  taskType: ClassifierTaskType;
  /** The corpus-entry id returned by `classify()` (or `null` → no-op). */
  corpusEntryId: string | null;
  /** What the operator picked instead. */
  newClassification: string;
  /** Free-form operator-supplied reason. */
  reason?: string;
  /** ISO-8601 override timestamp. Default: `new Date().toISOString()`. */
  now?: string;
  /** Corpus directory override (tests). */
  corpusDir?: string;
}

export interface RecordOperatorOverrideResult {
  /** True when an entry was flipped to `negative`. False when no-op. */
  flipped: boolean;
  /** Reason for no-op: 'no-corpus-entry-id' | 'entry-not-found' | 'window-expired' | 'already-resolved'. */
  reason?: 'no-corpus-entry-id' | 'entry-not-found' | 'window-expired' | 'already-resolved';
  /** The updated entry, when `flipped: true`. */
  entry?: CalibrationCorpusEntry;
}

/**
 * Record an operator override (AC-6). Flips the corresponding corpus
 * entry's polarity from `pending` to `negative`, attaches the
 * operator's chosen classification + reason. No-op when:
 *   - The original `classify()` was called with `skipCorpus: true` (no id).
 *   - The entry doesn't exist (id mismatch / corpus file rotated).
 *   - The override window has already expired (silence was promoted to
 *     positive). The caller can still surface the override to operators
 *     manually, but the corpus is sealed.
 *   - The entry was already resolved (idempotency — repeated overrides
 *     no-op rather than re-flipping).
 */
export function recordOperatorOverride(
  opts: RecordOperatorOverrideOpts,
): RecordOperatorOverrideResult {
  if (!opts.corpusEntryId) return { flipped: false, reason: 'no-corpus-entry-id' };
  const entries = readCorpus(opts.repoRoot, opts.taskType, opts.corpusDir);
  const entry = entries.find((e) => e.id === opts.corpusEntryId);
  if (!entry) return { flipped: false, reason: 'entry-not-found' };
  if (entry.polarity !== 'pending') {
    return { flipped: false, reason: 'already-resolved' };
  }
  const windowHours = resolveOverrideWindowHours(opts.repoRoot);
  const now = opts.now ?? new Date().toISOString();
  if (isOutsideWindow(entry.timestamp, now, windowHours)) {
    return { flipped: false, reason: 'window-expired' };
  }
  const updated = setCorpusEntryPolarity(
    opts.repoRoot,
    opts.taskType,
    opts.corpusEntryId,
    {
      polarity: 'negative',
      operatorOverrideClassification: opts.newClassification,
      operatorOverrideReason: opts.reason,
      operatorOverrideTimestamp: now,
    },
    opts.corpusDir,
  );
  if (!updated) return { flipped: false, reason: 'entry-not-found' };
  return { flipped: true, entry: updated };
}

// ── AC-7: silence-as-positive sweeper ────────────────────────────────────────

export interface ResolveSilenceAsPositiveOpts {
  repoRoot: string;
  /** Optional task-type filter. Default: all task types. */
  taskTypes?: readonly ClassifierTaskType[];
  /** ISO-8601 reference time. Default: `new Date().toISOString()`. */
  now?: string;
  /** Corpus directory override (tests). */
  corpusDir?: string;
}

export interface ResolveSilenceAsPositiveResult {
  /** Number of entries flipped to `positive`. */
  promotedCount: number;
  /** Per-task-type breakdown for the sweeper's audit log. */
  perTaskType: Record<string, number>;
  /** Window in hours that was applied. */
  windowHours: number;
}

/**
 * Scan the corpus for `pending` entries older than the override window
 * and flip them to `positive` (AC-7). Runs across all task types unless
 * `taskTypes` is supplied. Pure of business logic apart from the
 * polarity-flip semantics — safe to call from a sweeper, a CLI, or
 * inline at substrate boot time.
 *
 * Returns the promoted-count + a per-task-type breakdown for the
 * sweeper's log.
 */
export function resolveSilenceAsPositive(
  opts: ResolveSilenceAsPositiveOpts,
): ResolveSilenceAsPositiveResult {
  const windowHours = resolveOverrideWindowHours(opts.repoRoot);
  const now = opts.now ?? new Date().toISOString();
  const taskTypes = opts.taskTypes ?? ALL_TASK_TYPES;
  const perTaskType: Record<string, number> = {};
  let promotedCount = 0;

  for (const taskType of taskTypes) {
    const entries = readCorpus(opts.repoRoot, taskType, opts.corpusDir);
    const toPromote = entries.filter(
      (e) => e.polarity === 'pending' && isOutsideWindow(e.timestamp, now, windowHours),
    );
    for (const e of toPromote) {
      const updated = setCorpusEntryPolarity(
        opts.repoRoot,
        taskType,
        e.id,
        { polarity: 'positive', operatorOverrideTimestamp: now },
        opts.corpusDir,
      );
      if (updated) promotedCount++;
    }
    if (toPromote.length > 0) perTaskType[taskType] = toPromote.length;
  }

  // Touch the resolveCorpusDir to ensure import isn't tree-shaken when a
  // future caller wants a path it expects (kept for forward-compat with
  // sweeper tooling that may need the dir resolver alongside the
  // promoter). Cheap no-op.
  void resolveCorpusDir(opts.repoRoot, opts.corpusDir);

  return { promotedCount, perTaskType, windowHours };
}

// ── Time-window helper ───────────────────────────────────────────────────────

function isOutsideWindow(entryIso: string, nowIso: string, windowHours: number): boolean {
  const entryMs = Date.parse(entryIso);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(entryMs) || !Number.isFinite(nowMs)) return false;
  const elapsedHours = (nowMs - entryMs) / 3_600_000;
  return elapsedHours >= windowHours;
}
