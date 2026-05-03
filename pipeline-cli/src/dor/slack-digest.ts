/**
 * Weekly DoR digest (RFC-0011 Phase 5 + §8).
 *
 * Builds a Slack Block Kit-shaped payload summarising the last N days of
 * calibration log entries:
 *   - Pass rate (admit / (admit + nc)) over the window
 *   - Top 3 failing gates by entry count
 *   - Override rate + count
 *   - False-positive trend: Δ(override count) vs the immediately-prior
 *     window of the same length, formatted as `+N` / `-N` / `→ 0`
 *
 * The contract is "emit JSON suitable for piping to
 * `curl -X POST $SLACK_WEBHOOK_URL`" — we don't actually POST to Slack.
 * The operator wires curl + cron; this module is the renderer.
 *
 * The markdown renderer (`renderMarkdownDigest`) lives here too because
 * it consumes the same intermediate aggregate. The CLI's
 * `--render-markdown` flag and Slack output share that aggregate so
 * "what the dashboard shows" and "what Slack shows" never drift.
 */

import {
  aggregateByGate,
  filterByWindow,
  loadEntries,
  overrideRate,
  passRate,
  type GroupedStats,
  type StatsBucket,
} from './stats.js';
import type { CalibrationEntry } from './calibration-log.js';
import {
  buildCriticalPathSlackSection,
  type BuildCriticalPathSlackSectionOpts,
  type CriticalPathSlackSection,
} from '../deps/critical-path.js';
import { isCompositionEnabled } from '../deps/snapshot.js';

export interface BuildDigestOpts {
  /** Calibration log path. Defaults to the conventional artifactsDir path. */
  logPath?: string;
  /** Window length in days. Defaults to 7. */
  sinceDays?: number;
  /**
   * "Now" anchor for the window math. Tests inject a deterministic Date
   * so window/prior-window arithmetic is reproducible. Defaults to
   * `new Date()`.
   */
  now?: Date;
  /**
   * RFC-0014 Phase 4 — when true, append the "🛤️ Critical Path" section
   * (top 3-5 by `effectivePriority`) at the end of the digest. Defaults to
   * the `AI_SDLC_DEPS_COMPOSITION` feature flag — ON when the composition
   * layer is enabled, OFF otherwise. Tests pass an explicit boolean to drive
   * both branches without env mutation.
   */
  includeCriticalPath?: boolean;
  /**
   * Critical-path section options forwarded to `buildCriticalPathSlackSection`
   * (workDir, artifactsDir, tag, limit, openOnly, emitInsufficientDataHint).
   * Tests use this to point the loader at a fixture artifacts dir.
   */
  criticalPathOpts?: BuildCriticalPathSlackSectionOpts;
}

export interface DigestAggregate {
  /** ISO-8601 lower bound of the current window (inclusive). */
  windowStart: string;
  /** ISO-8601 upper bound of the current window (inclusive). */
  windowEnd: string;
  /** ISO-8601 lower bound of the prior window (used for Δ trend). */
  priorWindowStart: string;
  /** ISO-8601 upper bound of the prior window. */
  priorWindowEnd: string;
  /** Total counts in the current window. */
  totals: StatsBucket;
  /** Per-gate breakdown over the current window. */
  byGate: GroupedStats;
  /** Top 3 failing gates by entry count, descending. */
  topGates: Array<{ key: string; bucket: StatsBucket }>;
  /** Override count in the prior window (used to compute the Δ). */
  priorOverrideCount: number;
  /** Δ override count: current - prior. */
  overrideDelta: number;
  /** Pre-formatted trend string (e.g. "+2 vs prior week"). */
  trend: string;
}

/**
 * Slack Block Kit-shaped output. The `blocks` array is intentionally
 * untyped (Slack's API tolerates extra/missing fields and modeling the
 * full Block Kit type system is out of scope). The `fallbackText` is
 * what narrow clients (mobile notifications, no-Block-Kit clients) show.
 */
export interface SlackDigest {
  blocks: unknown[];
  fallbackText: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Format the Δ trend string for the digest. Convention:
 *   +N  → trend got worse (more overrides)
 *   -N  → trend got better
 *   → 0 → no change
 */
export function formatTrend(delta: number): string {
  if (delta > 0) return `+${delta} vs prior window`;
  if (delta < 0) return `${delta} vs prior window`;
  return '→ 0 vs prior window';
}

/**
 * Build the intermediate aggregate object — shared by both the Slack
 * renderer and the markdown renderer so the two outputs cannot drift.
 *
 * Window math:
 *   - Current window: [now - sinceDays, now]
 *   - Prior window:   [now - 2*sinceDays, now - sinceDays]
 *
 * Both windows use the SAME length so the override delta is apples-to-
 * apples. Bounds are ISO-8601 strings — `filterByWindow` parses them via
 * Date.parse internally.
 */
export function buildDigestAggregate(opts: BuildDigestOpts = {}): DigestAggregate {
  const now = opts.now ?? new Date();
  const sinceDays = opts.sinceDays ?? 7;
  const windowMs = sinceDays * MS_PER_DAY;

  const windowEndMs = now.getTime();
  const windowStartMs = windowEndMs - windowMs;
  const priorEndMs = windowStartMs;
  const priorStartMs = priorEndMs - windowMs;

  const windowStart = new Date(windowStartMs).toISOString();
  const windowEnd = new Date(windowEndMs).toISOString();
  const priorWindowStart = new Date(priorStartMs).toISOString();
  const priorWindowEnd = new Date(priorEndMs).toISOString();

  const all = loadEntries(opts.logPath);

  const current = filterByWindow(all, { since: windowStart, until: windowEnd });
  const prior = filterByWindow(all, { since: priorWindowStart, until: priorWindowEnd });

  const byGate = aggregateByGate(current);
  const totals = byGate.totals;

  // Top 3 failing gates — only `gate-N` keys, NOT `(none)`. Sort
  // descending by `total` (= count of entries that touched the gate).
  const topGates = Object.entries(byGate.groups)
    .filter(([k]) => k.startsWith('gate-'))
    .map(([key, bucket]) => ({ key, bucket }))
    .sort((a, b) => b.bucket.total - a.bucket.total)
    .slice(0, 3);

  const priorOverrideCount = countOverrides(prior);
  const overrideDelta = totals.override - priorOverrideCount;
  const trend = formatTrend(overrideDelta);

  return {
    windowStart,
    windowEnd,
    priorWindowStart,
    priorWindowEnd,
    totals,
    byGate,
    topGates,
    priorOverrideCount,
    overrideDelta,
    trend,
  };
}

function countOverrides(entries: CalibrationEntry[]): number {
  let n = 0;
  for (const e of entries) if (e.outcome === 'override') n += 1;
  return n;
}

/**
 * Resolve whether to include the critical-path section.
 *
 * Precedence:
 *   1. Explicit `opts.includeCriticalPath` boolean if provided.
 *   2. `AI_SDLC_DEPS_COMPOSITION` env flag (truthy = include, else skip).
 *
 * Pure function — exposed for tests + the CLI's `--include-critical-path`
 * flag handler so the precedence is documented in one place.
 */
export function shouldIncludeCriticalPath(opts: BuildDigestOpts = {}): boolean {
  if (opts.includeCriticalPath !== undefined) return opts.includeCriticalPath;
  return isCompositionEnabled();
}

/**
 * Render the digest as a Slack Block Kit payload. Three section blocks:
 *   1. Header — window dates + pass rate
 *   2. Metrics — top 3 gates as a numbered list, override count + Δ
 *   3. Divider
 * Plus a `fallbackText` for narrow clients.
 *
 * RFC-0014 Phase 4 — when `includeCriticalPath` resolves to true (see
 * {@link shouldIncludeCriticalPath}), the digest appends a "🛤️ Critical Path"
 * section after the divider. Per AC #2 the section is omitted entirely when
 * the graph has no qualifying items (flat / all-leaves); per task spec Part
 * A.5 the no-snapshot case shows an "insufficient data" hint instead.
 */
export function buildWeeklyDigest(opts: BuildDigestOpts = {}): SlackDigest {
  const agg = buildDigestAggregate(opts);
  const { windowStart, windowEnd, totals, topGates, trend } = agg;

  const passPct = (passRate(totals) * 100).toFixed(1);
  const overridePct = (overrideRate(totals) * 100).toFixed(1);

  const startLabel = windowStart.slice(0, 10);
  const endLabel = windowEnd.slice(0, 10);

  const headerText =
    `*DoR weekly digest* · ${startLabel} → ${endLabel}\n` +
    `Pass rate: *${passPct}%* (${totals.admit} admit / ${totals.nc} needs-clarification / ${totals.override} override · ${totals.total} total)`;

  const topGatesLines =
    topGates.length === 0
      ? '_No failing gates in this window._'
      : topGates.map((g, i) => `${i + 1}. \`${g.key}\` — ${g.bucket.total} entries`).join('\n');

  const metricsText =
    `*Top failing gates*\n${topGatesLines}\n\n` +
    `*Override rate*: ${overridePct}% (${totals.override} / ${totals.total})\n` +
    `*False-positive trend*: ${trend}`;

  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: headerText } },
    { type: 'section', text: { type: 'mrkdwn', text: metricsText } },
    { type: 'divider' },
  ];

  let fallbackText =
    `DoR digest ${startLabel}→${endLabel}: ` +
    `${passPct}% pass, ${totals.override} overrides (${trend}), ` +
    `top gates: ${topGates.map((g) => g.key).join(', ') || 'none'}`;

  if (shouldIncludeCriticalPath(opts)) {
    const cp = buildCriticalPathSlackSection(opts.criticalPathOpts ?? {});
    if (cp.blocks.length > 0) {
      // Append the critical-path blocks AFTER the existing divider so the
      // section reads as its own coherent block group.
      blocks.push(...cp.blocks);
      fallbackText += cp.fallbackSuffix;
    }
  }

  return { blocks, fallbackText };
}

/**
 * Convenience export — same shape as `buildCriticalPathSlackSection` but
 * lives on the digest module so callers (CLI, tests) only need one import
 * path for "everything weekly digest".
 */
export function buildCriticalPathSection(
  opts: BuildCriticalPathSlackSectionOpts = {},
): CriticalPathSlackSection {
  return buildCriticalPathSlackSection(opts);
}

/**
 * Render the digest as a markdown table dump suitable for committing to
 * `docs/operations/dor-weekly-digest.md` or pasting into a wiki.
 *
 * Snapshot-friendly: deterministic ordering, no timestamps beyond the
 * window bounds, no platform-specific paths.
 */
export function renderMarkdownDigest(opts: BuildDigestOpts = {}): string {
  const agg = buildDigestAggregate(opts);
  const { windowStart, windowEnd, totals, topGates, trend, priorOverrideCount, overrideDelta } =
    agg;

  const passPct = (passRate(totals) * 100).toFixed(1);
  const overridePct = (overrideRate(totals) * 100).toFixed(1);

  const startLabel = windowStart.slice(0, 10);
  const endLabel = windowEnd.slice(0, 10);

  const lines: string[] = [];
  lines.push(`# DoR weekly digest`);
  lines.push('');
  lines.push(`**Window**: ${startLabel} → ${endLabel}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Total issues evaluated | ${totals.total} |`);
  lines.push(`| Admit | ${totals.admit} |`);
  lines.push(`| Needs-clarification | ${totals.nc} |`);
  lines.push(`| Override | ${totals.override} |`);
  lines.push(`| Pass rate | ${passPct}% |`);
  lines.push(`| Override rate | ${overridePct}% |`);
  lines.push('');
  lines.push(`## Top failing gates`);
  lines.push('');
  if (topGates.length === 0) {
    lines.push(`_No failing gates in this window._`);
  } else {
    lines.push(`| Rank | Gate | Entries |`);
    lines.push(`| --- | --- | --- |`);
    topGates.forEach((g, i) => {
      lines.push(`| ${i + 1} | \`${g.key}\` | ${g.bucket.total} |`);
    });
  }
  lines.push('');
  lines.push(`## False-positive trend`);
  lines.push('');
  lines.push(`| Window | Override count |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Current | ${totals.override} |`);
  lines.push(`| Prior | ${priorOverrideCount} |`);
  lines.push(`| Δ | ${overrideDelta >= 0 ? `+${overrideDelta}` : overrideDelta} |`);
  lines.push('');
  lines.push(`Trend: ${trend}`);
  lines.push('');

  if (shouldIncludeCriticalPath(opts)) {
    const cp = buildCriticalPathSlackSection(opts.criticalPathOpts ?? {});
    if (cp.markdown.length > 0) {
      lines.push(cp.markdown);
    }
  }

  return lines.join('\n');
}
