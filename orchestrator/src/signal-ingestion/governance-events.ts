/**
 * Signal-ingestion governance event logger (RFC-0030 §11 / AISDLC-348).
 *
 * Per the RFC §11 closing note: "Configuration changes require Product
 * Lead approval (logged as governance events; not DID changes but
 * governance-relevant)." This module ships the audit trail.
 *
 * Trigger surface:
 *   - `loadSignalIngestionConfigWithGovernance()` calls
 *     `loadSignalIngestionConfig()` then diffs the result against
 *     `DEFAULT_SIGNAL_INGESTION_CONFIG`. When the diff is non-empty AND
 *     a `previousConfigSnapshot` is supplied (operators tracking version
 *     boundaries), it appends one `SignalIngestionConfigChanged` JSONL
 *     line to the orchestrator events stream.
 *   - Pure callers that just want the diff without the I/O can use
 *     `computeConfigDiff()` directly.
 *
 * Path convention: events land at
 * `<artifactsDir>/_orchestrator/events-YYYY-MM-DD.jsonl`, the same
 * date-rotated file pipeline-cli's orchestrator writes to (RFC-0015
 * Phase 4 / AISDLC-169.4). Keeping one file means
 * `cli-status --orchestrator` + the TUI events tail surface signal-
 * ingestion governance events alongside dispatch / completion events
 * without per-RFC observability silos.
 *
 * Why a separate writer instead of importing pipeline-cli's `writeEvent()`:
 * `orchestrator/` does not depend on `pipeline-cli/` (the dependency
 * graph runs the other way), so a direct import would invert the layer
 * boundary. The writer here is small enough (`appendFileSync` + mkdir +
 * date-suffix) that duplication is the right trade vs. a circular dep.
 *
 * Best-effort like the orchestrator's `writeEvent()`: never throws, returns
 * a boolean for test observability.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  DEFAULT_SIGNAL_INGESTION_CONFIG,
  loadSignalIngestionConfigWithDeprecations,
  type LoadSignalIngestionConfigOptions,
  type SignalIngestionConfig,
  type SignalIngestionConfigDeprecatedFieldDecision,
} from './config.js';

// ── Diff representation ────────────────────────────────────────────────

/**
 * One field that drifted between two `SignalIngestionConfig` snapshots.
 *
 * `path` uses dot notation (e.g. `tierMultipliers.enterprise`,
 * `clustering.algorithm`). `previous` is the value in the baseline /
 * previous snapshot; `current` is the value in the freshly-loaded config.
 *
 * Array fields (`adapters`, `acceptedLanguages`) are compared as ordered
 * lists — order changes count as drift because the registry honours
 * insertion order for tiebreaks.
 */
export interface SignalIngestionConfigChange {
  path: string;
  previous: unknown;
  current: unknown;
}

/**
 * Result of `computeConfigDiff(previous, current)`. `changed` is true when
 * at least one field drifted. `changes` lists every drifted field; empty
 * when `changed === false`.
 */
export interface SignalIngestionConfigDiff {
  changed: boolean;
  changes: SignalIngestionConfigChange[];
}

// ── Diff function ──────────────────────────────────────────────────────

/**
 * Compute the field-level diff between two `SignalIngestionConfig`
 * snapshots. Pure / no I/O; safe to call from any context.
 *
 * The diff is deterministic: changes are sorted by `path` lexicographic
 * so the same drift always produces the same `changes` array (audit
 * stability + diff stability across operators).
 */
export function computeConfigDiff(
  previous: SignalIngestionConfig,
  current: SignalIngestionConfig,
): SignalIngestionConfigDiff {
  const changes: SignalIngestionConfigChange[] = [];
  walkAndCompare('', previous as unknown, current as unknown, changes);
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { changed: changes.length > 0, changes };
}

function walkAndCompare(
  prefix: string,
  prev: unknown,
  curr: unknown,
  out: SignalIngestionConfigChange[],
): void {
  // Array fields — compared as ordered list (insertion order matters).
  if (Array.isArray(prev) || Array.isArray(curr)) {
    if (!arraysEqual(prev, curr)) {
      out.push({ path: prefix || '(root)', previous: prev, current: curr });
    }
    return;
  }

  // Object fields — recurse field-by-field. Take the union of keys so
  // additions + removals both surface as drift.
  if (isPlainObject(prev) && isPlainObject(curr)) {
    const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
    for (const k of keys) {
      const nextPrefix = prefix ? `${prefix}.${k}` : k;
      walkAndCompare(nextPrefix, prev[k], curr[k], out);
    }
    return;
  }

  // Scalar leaf — compare via strict equality (numbers + strings +
  // booleans are the only scalar types in the config). NaN is treated as
  // unequal to itself, matching JavaScript's `!==` semantics; the loader
  // rejects NaN at validation time so this branch should never fire in
  // production but defending against it costs nothing.
  if (prev !== curr) {
    out.push({ path: prefix || '(root)', previous: prev, current: curr });
  }
}

function arraysEqual(a: unknown, b: unknown): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── Event writer ───────────────────────────────────────────────────────

/**
 * One JSONL line on the orchestrator events stream representing a
 * detected configuration change. Mirrors the discriminator pattern from
 * `pipeline-cli/src/orchestrator/events.ts`: every event carries
 * `{ts, type, ...}`. The `type` value `SignalIngestionConfigChanged` is
 * stable; downstream consumers (`cli-status --orchestrator`, the TUI
 * events pane, Slack push) filter on it without coupling to per-field
 * shape.
 */
export interface SignalIngestionConfigChangedEvent {
  /** ISO-8601 timestamp set by the writer at append time. */
  ts: string;
  /** Discriminator — stable across the soak window + post-promotion. */
  type: 'SignalIngestionConfigChanged';
  /** Absolute or repo-relative path to the YAML file loaded. */
  configPath: string;
  /** Field-level changes detected vs the previous snapshot. */
  changes: SignalIngestionConfigChange[];
  /**
   * When the previous snapshot was the framework default vs. an actual
   * previous load. Lets dashboards distinguish "operator opted in" (first
   * non-default load) from "operator tuned the config" (delta between
   * two non-default loads).
   */
  comparedAgainst: 'defaults' | 'previous-load';
}

export interface WriteConfigChangeEventOpts {
  /**
   * Override the artifacts directory. Falls back to env `ARTIFACTS_DIR`
   * then `<cwd>/artifacts`, matching pipeline-cli's `writeEvent()` so
   * both writers land in the same date-rotated file.
   */
  artifactsDir?: string;
  /** Override `Date.now()` for the rotation suffix + the event `ts`. */
  now?: () => Date;
  /**
   * Optional warn-sink for best-effort write failures. The orchestrator
   * passes its CLI logger; tests pass a capturing stub.
   */
  warn?: (msg: string) => void;
}

/**
 * Append a `SignalIngestionConfigChanged` event to the orchestrator's
 * date-rotated events file. Best-effort: returns `false` on write failure
 * (logged via `warn`) instead of throwing.
 */
export function writeSignalIngestionConfigChangedEvent(
  event: SignalIngestionConfigChangedEvent,
  opts: WriteConfigChangeEventOpts = {},
): boolean {
  const artifactsDir = resolveArtifactsDir(opts);
  const now = opts.now ?? ((): Date => new Date());
  const date = now();
  const stamped: SignalIngestionConfigChangedEvent = {
    ...event,
    ts: event.ts || date.toISOString(),
  };
  const path = eventsFilePath(artifactsDir, date);
  const line = JSON.stringify(stamped) + '\n';

  try {
    if (!existsSync(dirname(path))) {
      mkdirSync(dirname(path), { recursive: true });
    }
    appendFileSync(path, line, { encoding: 'utf8' });
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.warn?.(`[signal-ingestion-governance] events write failed (path=${path}): ${reason}`);
    return false;
  }
}

function resolveArtifactsDir(opts: WriteConfigChangeEventOpts): string {
  return opts.artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(process.cwd(), 'artifacts');
}

/**
 * Resolve the on-disk path for the date-rotated events file. Mirrors
 * `pipeline-cli/src/orchestrator/events.ts#eventsFilePath()` so the two
 * writers append to the same file. Exported so tests + cli-status can
 * derive the same path without duplicating the rotation logic.
 */
export function eventsFilePath(artifactsDir: string, date: Date = new Date()): string {
  return join(artifactsDir, '_orchestrator', `events-${formatDate(date)}.jsonl`);
}

function formatDate(d: Date): string {
  // YYYY-MM-DD in UTC — matches `pipeline-cli/src/orchestrator/events.ts`
  // so rotation seams align across writers.
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ── High-level wrapper: load + diff + emit ─────────────────────────────

export interface LoadConfigWithGovernanceOptions extends LoadSignalIngestionConfigOptions {
  /**
   * Previous-load snapshot to compare against. When omitted, the diff is
   * computed against `DEFAULT_SIGNAL_INGESTION_CONFIG` and the event's
   * `comparedAgainst` field is set to `'defaults'`.
   *
   * Operators tracking version-to-version drift (e.g. a long-running
   * orchestrator that reloads the config on a tick) pass the previous
   * resolved config here; the event then carries `comparedAgainst:
   * 'previous-load'` so dashboards can distinguish "first load on this
   * project" from "operator tuned the knobs mid-run".
   */
  previousConfigSnapshot?: SignalIngestionConfig;
  /** Override artifacts dir + clock — passed through to the event writer. */
  artifactsDir?: string;
  now?: () => Date;
  warn?: (msg: string) => void;
  /**
   * When true, suppress the events.jsonl append (still computes the diff
   * and returns it). Tests use this to assert the diff shape without
   * touching the filesystem; production callers leave it false.
   */
  skipEventEmission?: boolean;
}

export interface LoadConfigWithGovernanceResult {
  config: SignalIngestionConfig;
  diff: SignalIngestionConfigDiff;
  /** True when an event was successfully written to events.jsonl. */
  eventWritten: boolean;
  /** Absolute path the loader used (echoed for downstream logging). */
  configPath: string;
  /**
   * Deprecation Decisions emitted during config load — e.g. legacy
   * `sourceBaselineDriftMultiplier` translated to `zScoreThreshold`. Empty
   * array when no legacy keys were present. Callers should pipe each into
   * `cli-decisions add` so the operator sees the soft-deprecation window
   * status. AISDLC-433 follow-up: governance loader now routes through
   * `loadSignalIngestionConfigWithDeprecations` so the audit trail does
   * NOT silently drop legacy YAML keys.
   */
  deprecations: SignalIngestionConfigDeprecatedFieldDecision[];
}

/**
 * Load the signal-ingestion config and emit a `SignalIngestionConfigChanged`
 * event when the loaded config differs from the comparison baseline
 * (defaults, or `previousConfigSnapshot` when supplied).
 *
 * Returns `{config, diff, eventWritten, configPath}`. `eventWritten` is
 * `false` when (a) there was no diff to report, (b) the caller passed
 * `skipEventEmission: true`, or (c) the best-effort write threw.
 *
 * This is the canonical entry point for orchestrator surfaces that want
 * the audit trail. Pure callers that just need the resolved config can
 * keep using `loadSignalIngestionConfig()` directly — they bypass the
 * governance layer entirely.
 */
export function loadSignalIngestionConfigWithGovernance(
  options: LoadConfigWithGovernanceOptions = {},
): LoadConfigWithGovernanceResult {
  // Route through loadSignalIngestionConfigWithDeprecations so the
  // canonical governance-aware loader does NOT silently drop legacy
  // `sourceBaselineDriftMultiplier` keys (codex MAJOR on #752 — the
  // basic loader runs resolveFloodingDetection which ignores unknown
  // keys, breaking the one-release-window soft-translation contract).
  const { config, deprecations } = loadSignalIngestionConfigWithDeprecations({
    projectRoot: options.projectRoot,
    configPath: options.configPath,
  });

  const previous = options.previousConfigSnapshot ?? DEFAULT_SIGNAL_INGESTION_CONFIG;
  const comparedAgainst: SignalIngestionConfigChangedEvent['comparedAgainst'] =
    options.previousConfigSnapshot ? 'previous-load' : 'defaults';
  const diff = computeConfigDiff(previous, config);

  const configPath =
    options.configPath ??
    (options.projectRoot
      ? join(options.projectRoot, '.ai-sdlc', 'signal-ingestion.yaml')
      : join(process.cwd(), '.ai-sdlc', 'signal-ingestion.yaml'));

  let eventWritten = false;
  if (diff.changed && !options.skipEventEmission) {
    eventWritten = writeSignalIngestionConfigChangedEvent(
      {
        ts: '',
        type: 'SignalIngestionConfigChanged',
        configPath,
        changes: diff.changes,
        comparedAgainst,
      },
      {
        artifactsDir: options.artifactsDir,
        now: options.now,
        warn: options.warn,
      },
    );
  }

  return { config, diff, eventWritten, configPath, deprecations };
}
