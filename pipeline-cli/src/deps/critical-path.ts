/**
 * RFC-0014 Phase 4 — critical-path surfacing for Slack digest + dashboard.
 *
 * Reads the latest snapshot artifact from `<artifactsDir>/_deps/`, joins it
 * back to the live dependency graph (built from `backlog/`) so we can recover
 * `title` / `priority` / `status` (which the snapshot intentionally does NOT
 * carry — see RFC-0014 §4.1 + the v1 schema at
 * `spec/schemas/deps-snapshot.v1.schema.json`), computes `effectivePriority`
 * via the Phase 2 composer, and returns the top-N items by dispatch order.
 *
 * Why join at read time instead of widening the snapshot record:
 *   - Phase 1's snapshot schema is sealed (`additionalProperties: false`) and
 *     carries only the topology fields a future composition layer needs.
 *   - Phase 2's `effectivePriority` is **read-only** for PPA — recomputing
 *     against the live `priority:` frontmatter mirrors the dispatcher
 *     behaviour exactly (RFC-0014 §12 Q4 — no cache, recompute each time).
 *   - Per RFC-0014 §12 Q6 the snapshot is best-effort consistent; consumers
 *     are responsible for surfacing dangling data. The join layer here is
 *     where that surfaces — the returned `EnrichedSnapshotRecord.warnings`
 *     array carries any "snapshot row had id X but graph no longer has X"
 *     notices the renderer can show inline.
 *
 * Both surfaces (Slack digest section + dashboard `/deps` page) consume the
 * SAME `selectCriticalPath()` output so the two views never drift.
 *
 * Behind feature flag `AI_SDLC_DEPS_COMPOSITION`. When OFF, the loader still
 * works (so the dashboard / digest can render whatever's on disk for soak
 * comparison) — gating is the caller's job (the Slack section is appended
 * conditionally, the dashboard nav link is always shown but the page renders
 * an empty-state when no snapshot exists).
 *
 * @module deps/critical-path
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  buildDependencyGraph,
  type DependencyGraph,
  type DependencyNode,
} from './dependency-graph.js';
import { computeEffectivePriorities } from './effective-priority.js';
import {
  inspectSnapshots,
  resolveSnapshotDir,
  type InspectEntry,
  type SnapshotRecord,
  type SnapshotTag,
} from './snapshot.js';

/**
 * Default top-N for the critical-path digest. RFC-0014 §11 Phase 4 says
 * "top 3-5"; we render the top 5 by default and let renderers cap further if
 * needed (Slack section caps at 5, dashboard renders all enriched but
 * highlights the top 5).
 */
export const DEFAULT_CRITICAL_PATH_LIMIT = 5;

/** A single enriched record — snapshot topology + live graph metadata. */
export interface EnrichedSnapshotRecord {
  /** Canonical task ID. */
  id: string;
  /** Title from the live graph node (empty string when the node is missing). */
  title: string;
  /**
   * Backlog.md `status:` value as written in the live frontmatter (empty
   * string when the node is missing). Used by the dashboard for color-coding
   * (RFC-0014 §7.2).
   */
  status: string;
  /**
   * `'open' | 'completed'` — effective dispatch status (computed by the live
   * graph builder which already handles stale-status reconciliation per
   * AISDLC-153). Empty string when the node is missing.
   */
  effectiveStatus: '' | 'open' | 'completed';
  /** Numeric base priority weight (1-4, default 2 for unknown). */
  basePriority: number;
  /**
   * `effectivePriority` per RFC-0014 §5.2 (max over downstream closure).
   * Equal to `basePriority` for leaves with no downstream.
   */
  effectivePriority: number;
  /** Longest forward chain length from this task (snapshot value). */
  criticalPathLength: number;
  /** Number of immediate dependents from the snapshot (pre-computed reverse edges). */
  dependentCount: number;
  /** Direct dependencies from the snapshot. */
  dependencies: string[];
  /** Direct dependents from the snapshot. */
  dependents: string[];
  /** ISO-8601 mtime — recency tiebreak. */
  lastModified: string;
  /** Path to the on-disk task file (empty string when the node is missing). */
  filePath: string;
  /** Dangling-edge warnings surfaced by the join (RFC-0014 §12 Q6). */
  warnings: string[];
}

/** Result of locating + parsing the latest snapshot. */
export interface LoadedSnapshot {
  /** Absolute path of the file read. */
  path: string;
  /** ISO timestamp embedded in the filename. */
  isoTimestamp: string;
  /** Tag of the snapshot. */
  tag: SnapshotTag;
  /** Number of records actually parsed (skips silently drop malformed lines). */
  recordCount: number;
  /** Number of malformed lines skipped — surfaced for forensic context. */
  skipped: number;
  /** Parsed records. */
  records: SnapshotRecord[];
}

export interface LoadLatestSnapshotOpts {
  /** Project root (defaults to cwd). Must contain `backlog/`. */
  workDir?: string;
  /**
   * Base artifacts directory. Falls back to `process.env.ARTIFACTS_DIR`
   * (then `<workDir>/artifacts`) — same resolution as `writeSnapshot` so a
   * locally-emitted snapshot is found without extra config.
   */
  artifactsDir?: string;
  /**
   * Optional tag filter. When omitted the loader picks the latest snapshot
   * across ALL tags (matching the digest contract — "the most recent picture
   * of the graph", regardless of which event prompted the snapshot).
   */
  tag?: SnapshotTag;
}

/**
 * Locate + parse the most recent snapshot in `<artifactsDir>/_deps/`. Returns
 * `null` when no snapshot exists — the caller is expected to render an
 * empty-state hint pointing at `cli-deps snapshot`.
 *
 * Pure I/O — no graph reads. The caller composes this with `enrichSnapshot`
 * to get the join with the live `backlog/` graph.
 */
export function loadLatestSnapshot(opts: LoadLatestSnapshotOpts = {}): LoadedSnapshot | null {
  const dir = resolveSnapshotDir({
    ...(opts.workDir !== undefined ? { workDir: opts.workDir } : {}),
    ...(opts.artifactsDir !== undefined ? { artifactsDir: opts.artifactsDir } : {}),
  });
  if (!existsSync(dir)) return null;
  const inspectOpts: { workDir?: string; artifactsDir?: string; tag?: SnapshotTag } = {};
  if (opts.workDir !== undefined) inspectOpts.workDir = opts.workDir;
  if (opts.artifactsDir !== undefined) inspectOpts.artifactsDir = opts.artifactsDir;
  if (opts.tag !== undefined) inspectOpts.tag = opts.tag;
  const entries = inspectSnapshots(inspectOpts);
  if (entries.length === 0) return null;
  // `inspectSnapshots` sorts ascending by ISO timestamp; the last entry is
  // therefore the most recent.
  const latest: InspectEntry = entries[entries.length - 1]!;
  let body: string;
  try {
    body = readFileSync(latest.path, 'utf8');
  } catch {
    // The file vanished between `inspectSnapshots` and `readFileSync` — treat
    // it as "no snapshot" rather than crashing, so the renderer can still show
    // the empty-state hint.
    return null;
  }
  const lines = body.split('\n').filter((l) => l.trim().length > 0);
  const records: SnapshotRecord[] = [];
  let skipped = 0;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isSnapshotRecord(parsed)) {
      skipped += 1;
      continue;
    }
    records.push(parsed);
  }
  return {
    path: latest.path,
    isoTimestamp: latest.isoTimestamp,
    tag: latest.tag,
    recordCount: records.length,
    skipped,
    records,
  };
}

/**
 * Structural duck-typing — same posture as `cli-dor-corpus.isValidEntry`.
 * Tolerates extra fields (forward-compat with future schema additions) but
 * fails closed on missing required fields. Keeps malformed-line skipping
 * honest without coupling to AJV at runtime.
 */
function isSnapshotRecord(raw: unknown): raw is SnapshotRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string') return false;
  if (!Array.isArray(r.dependencies)) return false;
  if (!Array.isArray(r.dependents)) return false;
  if (typeof r.depth !== 'number') return false;
  if (typeof r.criticalPathLength !== 'number') return false;
  if (!Array.isArray(r.externalDependencies)) return false;
  if (typeof r.lastModified !== 'string') return false;
  return true;
}

export interface EnrichSnapshotOpts {
  /**
   * Project root for the live graph rebuild. Defaults to cwd. Must point at
   * the same workspace that produced the snapshot — otherwise the join will
   * surface dangling-edge warnings for every row.
   */
  workDir?: string;
  /**
   * Pre-built dependency graph (for tests + composed callers that already
   * have one).
   */
  graph?: DependencyGraph;
}

/**
 * Join snapshot records with the live dependency graph to produce an
 * enriched view: snapshot supplies topology (`dependencies`, `dependents`,
 * `criticalPathLength`), graph supplies `title` / `status` / `priority`, and
 * the Phase 2 composer supplies `effectivePriority`.
 *
 * Per RFC-0014 §12 Q6 the join is best-effort: a snapshot row whose `id` is
 * no longer in the graph (task deleted between snapshot + read) gets an
 * `EnrichedSnapshotRecord` with empty `title`/`status` and a single warning
 * line so the renderer can show "(missing)" without crashing. A graph node
 * with no snapshot row (task added after snapshot) is NOT surfaced — the
 * snapshot is the source of truth for "what existed at snapshot time".
 */
export function enrichSnapshot(
  records: SnapshotRecord[],
  opts: EnrichSnapshotOpts = {},
): EnrichedSnapshotRecord[] {
  const graph =
    opts.graph ?? buildDependencyGraph({ workDir: opts.workDir ?? process.cwd() }, () => {});
  const priorities = computeEffectivePriorities(graph);

  return records.map((r) => {
    const key = r.id.toLowerCase();
    const node: DependencyNode | undefined = graph.nodes.get(key);
    const pri = priorities.get(key);
    const warnings: string[] = [];
    if (!node) {
      warnings.push(`task ${r.id} present in snapshot but missing from live graph`);
    }
    return {
      id: r.id,
      title: node?.title ?? '',
      status: node?.frontmatterStatus ?? '',
      effectiveStatus: node?.status ?? '',
      basePriority: pri?.basePriority ?? 0,
      effectivePriority: pri?.effectivePriority ?? 0,
      criticalPathLength: r.criticalPathLength,
      dependentCount: r.dependents.length,
      dependencies: r.dependencies,
      dependents: r.dependents,
      lastModified: r.lastModified,
      filePath: node?.filePath ?? '',
      warnings,
    };
  });
}

export interface SelectCriticalPathOpts {
  /** Top-N cap. Defaults to {@link DEFAULT_CRITICAL_PATH_LIMIT}. */
  limit?: number;
  /**
   * When true, only consider records whose `effectiveStatus === 'open'` (i.e.
   * tasks the operator can actually act on). Defaults to true — a critical
   * path made of completed tasks is meaningless for "what to dispatch next".
   */
  openOnly?: boolean;
}

/**
 * Sort enriched records by dispatch order (RFC-0014 §12 Q1):
 *   `effectivePriority DESC → criticalPathLength DESC → recency DESC → id ASC`
 *
 * Then take the top N. Returns `[]` when no records qualify (e.g. flat graph
 * where every leaf has `criticalPathLength === 0` AND `effectivePriority`
 * equals the default — the renderer treats the empty array as "omit the
 * section entirely" per AC #2 of AISDLC-167.4).
 *
 * The "qualifies for the critical path" filter:
 *   - `openOnly` (default true) drops completed tasks.
 *   - We also drop records where `criticalPathLength === 0 && dependentCount
 *     === 0` AND `effectivePriority === basePriority` — a true graph leaf
 *     that doesn't unblock anything; surfacing it as "critical path" would be
 *     misleading. (A leaf WITH downstream still qualifies — its CPL is 0
 *     because nothing depends on IT, but `effectivePriority > basePriority`
 *     captures any inheritance.)
 */
export function selectCriticalPath(
  enriched: EnrichedSnapshotRecord[],
  opts: SelectCriticalPathOpts = {},
): EnrichedSnapshotRecord[] {
  const limit = opts.limit ?? DEFAULT_CRITICAL_PATH_LIMIT;
  const openOnly = opts.openOnly ?? true;
  const filtered = enriched.filter((r) => {
    if (openOnly && r.effectiveStatus !== 'open') return false;
    // True isolated leaf — no chain, no downstream, no inheritance. Skip.
    if (r.criticalPathLength === 0 && r.dependentCount === 0) return false;
    return true;
  });
  filtered.sort((a, b) => {
    if (a.effectivePriority !== b.effectivePriority)
      return b.effectivePriority - a.effectivePriority;
    if (a.criticalPathLength !== b.criticalPathLength)
      return b.criticalPathLength - a.criticalPathLength;
    if (a.lastModified !== b.lastModified) return b.lastModified.localeCompare(a.lastModified);
    return a.id.localeCompare(b.id, 'en', { numeric: true });
  });
  return filtered.slice(0, limit);
}

export interface BuildCriticalPathDigestOpts
  extends LoadLatestSnapshotOpts, SelectCriticalPathOpts {}

/**
 * One-call helper for renderers: load the latest snapshot, enrich it, and
 * return the top-N critical-path items. Returns `null` when no snapshot is
 * available (so the caller knows to render the "insufficient data" hint
 * instead of an empty section).
 */
export function buildCriticalPathDigest(opts: BuildCriticalPathDigestOpts = {}): {
  snapshot: LoadedSnapshot;
  items: EnrichedSnapshotRecord[];
} | null {
  const loadOpts: LoadLatestSnapshotOpts = {};
  if (opts.workDir !== undefined) loadOpts.workDir = opts.workDir;
  if (opts.artifactsDir !== undefined) loadOpts.artifactsDir = opts.artifactsDir;
  if (opts.tag !== undefined) loadOpts.tag = opts.tag;
  const snapshot = loadLatestSnapshot(loadOpts);
  if (!snapshot) return null;
  const enrichOpts: EnrichSnapshotOpts = {};
  if (opts.workDir !== undefined) enrichOpts.workDir = opts.workDir;
  const enriched = enrichSnapshot(snapshot.records, enrichOpts);
  const selectOpts: SelectCriticalPathOpts = {};
  if (opts.limit !== undefined) selectOpts.limit = opts.limit;
  if (opts.openOnly !== undefined) selectOpts.openOnly = opts.openOnly;
  const items = selectCriticalPath(enriched, selectOpts);
  return { snapshot, items };
}

// ── Slack section renderer ─────────────────────────────────────────────

export interface CriticalPathSlackSection {
  /**
   * Slack Block Kit blocks (untyped per the `SlackDigest` convention in
   * `dor/slack-digest.ts`). Empty array when the section was suppressed
   * (digest renderer should NOT splice these in).
   */
  blocks: unknown[];
  /**
   * One-line fallback suffix appended to the digest's overall fallback text.
   * Empty when the section was suppressed.
   */
  fallbackSuffix: string;
  /** Markdown rendering for the markdown digest path. Empty when suppressed. */
  markdown: string;
  /**
   * `'rendered'` — section was rendered with at least one item.
   * `'omitted-empty-graph'` — the graph had no qualifying critical-path items
   *   (per AC #2: "section is omitted entirely rather than rendering an empty
   *   header").
   * `'omitted-no-snapshot'` — no snapshot exists (per task spec Part A.5: the
   *   header line falls back to "insufficient data" so the operator knows to
   *   run `cli-deps snapshot`). Distinguishing this from "empty graph" lets
   *   the digest still tell the operator WHY the section is missing.
   */
  state: 'rendered' | 'omitted-empty-graph' | 'omitted-no-snapshot';
  /** Items rendered (empty when state !== 'rendered'). */
  items: EnrichedSnapshotRecord[];
}

export interface BuildCriticalPathSlackSectionOpts extends BuildCriticalPathDigestOpts {
  /**
   * When false (default true), still emit the "insufficient data" hint blocks
   * for the no-snapshot case rather than suppressing entirely. The Slack
   * digest's `--include-critical-path` flag passes `true` so an operator who
   * explicitly opted in sees the "run cli-deps snapshot" hint instead of
   * silent absence; CI auto-include passes `false` so quiet days don't
   * trigger noisy hints.
   */
  emitInsufficientDataHint?: boolean;
}

/**
 * Format a single critical-path entry. Keeps formatting in one place so the
 * Slack rendering and the markdown rendering can't drift.
 *
 * Format per task spec Part A.3:
 *   `<rank>. AISDLC-N — <title> (chain length: N, gates: M downstream)`
 */
export function formatCriticalPathEntry(rank: number, item: EnrichedSnapshotRecord): string {
  const title = item.title || '(no title)';
  return (
    `${rank}. ${item.id} — ${title} ` +
    `(chain length: ${item.criticalPathLength}, gates: ${item.dependentCount} downstream)`
  );
}

/**
 * Build the Slack section for the critical path. Pure renderer over
 * `buildCriticalPathDigest()` output — separate from `buildWeeklyDigest` so
 * the Slack digest call site can opt in conditionally without forcing a hard
 * dependency on the `dor/` module.
 */
export function buildCriticalPathSlackSection(
  opts: BuildCriticalPathSlackSectionOpts = {},
): CriticalPathSlackSection {
  const emitHint = opts.emitInsufficientDataHint ?? true;
  const result = buildCriticalPathDigest(opts);

  if (!result) {
    if (!emitHint) {
      return {
        blocks: [],
        fallbackSuffix: '',
        markdown: '',
        state: 'omitted-no-snapshot',
        items: [],
      };
    }
    const headerText =
      '*🛤️ Critical Path*: insufficient data ' +
      '(run `cli-deps snapshot` with `AI_SDLC_DEPS_COMPOSITION=1` to populate)';
    const blocks: unknown[] = [
      { type: 'section', text: { type: 'mrkdwn', text: headerText } },
      { type: 'divider' },
    ];
    return {
      blocks,
      fallbackSuffix: ' · critical path: insufficient data',
      markdown:
        '## 🛤️ Critical Path\n\n' +
        '_Insufficient data — run `cli-deps snapshot` with `AI_SDLC_DEPS_COMPOSITION=1` to populate._\n',
      state: 'omitted-no-snapshot',
      items: [],
    };
  }

  if (result.items.length === 0) {
    // Empty graph (or all completed) — section is omitted entirely per AC #2.
    return {
      blocks: [],
      fallbackSuffix: '',
      markdown: '',
      state: 'omitted-empty-graph',
      items: [],
    };
  }

  const lines = result.items.map((it, i) => formatCriticalPathEntry(i + 1, it));
  const sectionText = `*🛤️ Critical Path*\n${lines.join('\n')}`;
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: sectionText } },
    { type: 'divider' },
  ];
  const fallbackSuffix =
    ` · critical path top ${result.items.length}: ` + result.items.map((it) => it.id).join(', ');
  const markdown =
    '## 🛤️ Critical Path\n\n' +
    result.items
      .map(
        (it, i) =>
          `${i + 1}. **${it.id}** — ${it.title || '(no title)'}\n` +
          `   - chain length: ${it.criticalPathLength}\n` +
          `   - gates: ${it.dependentCount} downstream\n` +
          `   - effective priority: ${it.effectivePriority}\n`,
      )
      .join('\n') +
    '\n';

  return {
    blocks,
    fallbackSuffix,
    markdown,
    state: 'rendered',
    items: result.items,
  };
}
